'use strict';

/*
 * Dateibasierter Store fuer express-session.
 *
 * Vorher lief die App im MemoryStore: jeder Neustart hat alle Anmeldungen
 * verworfen, und docker-compose hat ein Volume gemountet, das nie beschrieben
 * wurde. Dabei ist der Store fuer einen Single-Admin-Dienst so klein, dass
 * eine Dependency mehr Angriffsflaeche als Nutzen brachte — das Projekt haelt
 * seine Abhaengigkeitsliste bewusst kurz.
 *
 * Eine Datei je Sitzung: <dir>/<sid>.json mit { expires, session }.
 *
 * Write-Through-Cache: express-session schreibt den Antwortkopf raus, *bevor*
 * store.set() zurueckgemeldet hat. Bei einem reinen Plattenstore heisst das,
 * dass ein Client, der dem Login-Redirect sofort folgt, die Sitzung noch nicht
 * findet und wieder auf /login landet. Deshalb liegt jede Sitzung sofort im
 * Speicher und wandert parallel auf die Platte; die Datei ist nur fuer den
 * Neustart da. Weil saveUninitialized:false gilt, landen ausschliesslich
 * angemeldete Sitzungen im Cache — er kann also nicht durch Besucher wachsen.
 */

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const { Store } = require('express-session');

const DAY_MS = 24 * 60 * 60 * 1000;
// Die sid kommt aus uid-safe (base64url). Trotzdem geprueft, bevor sie in
// einen Pfad wandert: express-session verifiziert zwar die Cookie-Signatur,
// aber ein Store, der ungeprueft joint, ist eine Traversal-Falle fuer den
// naechsten, der ihn woanders einsetzt.
const SID_PATTERN = /^[\w-]{1,128}$/;

class FileSessionStore extends Store {
    constructor({ dir, ttlMs = DAY_MS, pruneIntervalMs = 60 * 60 * 1000 } = {}) {
        super();
        if (!dir) throw new Error('FileSessionStore braucht ein dir');
        this.dir = dir;
        this.ttlMs = ttlMs;
        this.ready = fsp.mkdir(dir, { recursive: true }).then(() => {});

        // sid -> { expires, session }
        this.cache = new Map();

        // Schreibvorgaenge je Sitzung serialisieren. Ohne das ueberholen sich
        // das set() des Logins und das touch() des Folge-Requests: beide
        // rename()n auf dieselbe Zieldatei, und Windows quittiert das zweite
        // mit EPERM (unter Linux gewinnt stillschweigend das letzte).
        this.writeChains = new Map();

        this.pruneTimer = setInterval(() => {
            this.prune().catch(() => {});
        }, pruneIntervalMs);
        // Ein Aufraeum-Timer darf den Prozess nicht am Leben halten
        if (typeof this.pruneTimer.unref === 'function') this.pruneTimer.unref();
    }

    _path(sid) {
        if (!SID_PATTERN.test(String(sid ?? ''))) return null;
        return path.join(this.dir, `${sid}.json`);
    }

    _expiryOf(session) {
        const expires = session && session.cookie && session.cookie.expires;
        const parsed = expires ? new Date(expires).getTime() : NaN;
        return Number.isFinite(parsed) ? parsed : Date.now() + this.ttlMs;
    }

    /* Haengt eine Aufgabe an die Schreibkette dieser Sitzung. */
    _serialize(sid, task) {
        const previous = this.writeChains.get(sid) ?? Promise.resolve();
        // catch vor dem Anhaengen, damit ein Fehler die Kette nicht abreisst
        const next = previous.catch(() => {}).then(task);
        this.writeChains.set(sid, next);
        next.catch(() => {}).finally(() => {
            if (this.writeChains.get(sid) === next) this.writeChains.delete(sid);
        });
        return next;
    }

    _persist(sid, record) {
        const target = this._path(sid);
        if (!target) return Promise.reject(new Error('ungueltige Session-ID'));

        return this._serialize(sid, async () => {
            await this.ready;
            // Eindeutig je Schreibvorgang, nicht nur je Prozess: zwei
            // Instanzen duerfen sich denselben Sitzungsordner teilen.
            const tmp = `${target}.${crypto.randomBytes(6).toString('hex')}.tmp`;
            await fsp.writeFile(tmp, JSON.stringify(record), 'utf8');
            try {
                await fsp.rename(tmp, target);
            } catch (err) {
                await fsp.rm(tmp, { force: true });
                throw err;
            }
        });
    }

    get(sid, callback) {
        const file = this._path(sid);
        // Kein Fehler, sondern "keine Sitzung" — sonst wuerde eine kaputte
        // Cookie-ID einen 500er statt eines Redirects auf /login ausloesen.
        if (!file) return void callback(null, null);

        const cached = this.cache.get(sid);
        if (cached) {
            if (cached.expires > Date.now()) {
                return void callback(null, cached.session);
            }
            this.cache.delete(sid);
            return this.destroy(sid, () => callback(null, null));
        }

        fsp.readFile(file, 'utf8').then(
            text => {
                let record;
                try {
                    record = JSON.parse(text);
                } catch {
                    return this.destroy(sid, () => callback(null, null));
                }
                if (!record || typeof record.expires !== 'number') {
                    return this.destroy(sid, () => callback(null, null));
                }
                if (record.expires <= Date.now()) {
                    return this.destroy(sid, () => callback(null, null));
                }
                // Nach einem Neustart hier einmal in den Cache heben
                this.cache.set(sid, record);
                callback(null, record.session);
            },
            err => {
                if (err.code === 'ENOENT') return callback(null, null);
                callback(err);
            }
        );
    }

    set(sid, session, callback = () => {}) {
        if (!this._path(sid)) return void callback(null);

        const record = { expires: this._expiryOf(session), session };
        // Erst in den Cache, dann auf die Platte: ab hier ist die Sitzung
        // gueltig, egal wie lange das Schreiben dauert.
        this.cache.set(sid, record);
        this._persist(sid, record).then(() => callback(null), callback);
    }

    /*
     * touch schreibt nur das Ablaufdatum fort. Der Sitzungsinhalt bleibt der
     * bekannte, damit ein paralleler set() nicht ueberholt wird.
     */
    touch(sid, session, callback = () => {}) {
        if (!this._path(sid)) return void callback(null);

        const known = this.cache.get(sid);
        const record = {
            expires: this._expiryOf(session),
            session: known ? known.session : session,
        };
        this.cache.set(sid, record);
        this._persist(sid, record).then(() => callback(null), callback);
    }

    destroy(sid, callback = () => {}) {
        const file = this._path(sid);
        if (!file) return void callback(null);

        this.cache.delete(sid);
        // In derselben Kette wie die Schreibvorgaenge: sonst koennte ein noch
        // laufendes touch() die Datei nach dem Logout neu anlegen.
        this._serialize(sid, () => fsp.rm(file, { force: true }))
            .then(() => callback(null), callback);
    }

    async _files() {
        await this.ready;
        try {
            return (await fsp.readdir(this.dir)).filter(n => n.endsWith('.json'));
        } catch {
            return [];
        }
    }

    length(callback = () => {}) {
        this._files().then(files => callback(null, files.length), callback);
    }

    clear(callback = () => {}) {
        this.cache.clear();
        this._files()
            .then(files => Promise.all(
                files.map(name => fsp.rm(path.join(this.dir, name), { force: true }))
            ))
            .then(() => callback(null), callback);
    }

    /* Abgelaufene Sitzungen entfernen — ohne das waechst der Ordner endlos. */
    async prune() {
        const now = Date.now();
        let removed = 0;

        for (const [sid, record] of this.cache) {
            if (record.expires <= now) this.cache.delete(sid);
        }

        await this.ready;
        const all = await fsp.readdir(this.dir).catch(() => []);

        for (const name of all) {
            const file = path.join(this.dir, name);

            // Liegengebliebene .tmp aus einem abgebrochenen Schreibvorgang.
            // Die sind nur fuer Millisekunden gueltig, alles andere ist Muell.
            if (name.endsWith('.tmp')) {
                await fsp.rm(file, { force: true }).catch(() => {});
                continue;
            }
            if (!name.endsWith('.json')) continue;

            try {
                const record = JSON.parse(await fsp.readFile(file, 'utf8'));
                if (typeof record.expires !== 'number' || record.expires <= now) {
                    await fsp.rm(file, { force: true });
                    removed++;
                }
            } catch {
                await fsp.rm(file, { force: true });   // unlesbar -> weg
                removed++;
            }
        }
        return removed;
    }

    /*
     * Wartet, bis alle angestossenen Schreibvorgaenge durch sind. Beim
     * Herunterfahren wichtig: der Cache haelt die Sitzung sofort, die Datei
     * entsteht aber erst kurz danach — ohne dieses Warten waere eine gerade
     * angelegte Sitzung nach einem Neustart weg.
     */
    async settled() {
        await Promise.allSettled([...this.writeChains.values()]);
    }

    close() {
        clearInterval(this.pruneTimer);
    }
}

module.exports = { FileSessionStore };
