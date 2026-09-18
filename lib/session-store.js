'use strict';

/*
 * SQLite-basierter Store fuer express-session (Tabelle `sessions` in
 * lib/db.js) — vorher eine Datei je Sitzung unter data/sessions/.
 *
 * Der fruehere Store brauchte einen Write-Through-Cache und eine
 * Schreibkette je Sitzung, weil ein async fs.writeFile+rename mitten in der
 * Ausfuehrung unterbrochen werden konnte (ein Client, der dem Login-Redirect
 * sofort folgt, haette die noch nicht fertig geschriebene Datei verpasst;
 * ein set() und ein touch() haetten sich ueberholen koennen). Ein
 * DatabaseSync-Aufruf ist synchron: bis set()/touch() ihren Callback rufen,
 * ist die Zeile bereits committet, und kein anderer JS-Code kann dazwischen
 * laufen. Damit entfallen Cache und Schreibkette ersatzlos.
 */

const { Store } = require('express-session');

const DAY_MS = 24 * 60 * 60 * 1000;

class SqliteSessionStore extends Store {
    constructor({ db, ttlMs = DAY_MS, pruneIntervalMs = 60 * 60 * 1000 } = {}) {
        super();
        if (!db) throw new Error('SqliteSessionStore braucht eine db');
        this.db = db;
        this.ttlMs = ttlMs;

        this.getStmt = db.prepare('SELECT expires, data_json FROM sessions WHERE sid = ?');
        this.setStmt = db.prepare(`
            INSERT INTO sessions (sid, expires, data_json) VALUES (?, ?, ?)
            ON CONFLICT(sid) DO UPDATE SET expires = excluded.expires, data_json = excluded.data_json
        `);
        // touch() aendert bewusst nur die Ablauffrist, nie data_json — der
        // Sitzungsinhalt bleibt der zuletzt per set() gespeicherte.
        this.touchStmt = db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?');
        this.deleteStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
        this.countStmt = db.prepare('SELECT COUNT(*) AS n FROM sessions');
        this.clearStmt = db.prepare('DELETE FROM sessions');
        this.pruneStmt = db.prepare('DELETE FROM sessions WHERE expires <= ?');

        this.pruneTimer = setInterval(() => this.prune(), pruneIntervalMs);
        if (typeof this.pruneTimer.unref === 'function') this.pruneTimer.unref();
    }

    _expiryOf(session) {
        const expires = session && session.cookie && session.cookie.expires;
        const parsed = expires ? new Date(expires).getTime() : NaN;
        return Number.isFinite(parsed) ? parsed : Date.now() + this.ttlMs;
    }

    get(sid, callback = () => {}) {
        try {
            const row = this.getStmt.get(sid);
            if (!row) return void callback(null, null);
            if (row.expires <= Date.now()) {
                return this.destroy(sid, () => callback(null, null));
            }
            let session;
            try {
                session = JSON.parse(row.data_json);
            } catch {
                return this.destroy(sid, () => callback(null, null));
            }
            callback(null, session);
        } catch (err) {
            callback(err);
        }
    }

    set(sid, session, callback = () => {}) {
        try {
            this.setStmt.run(sid, this._expiryOf(session), JSON.stringify(session));
            callback(null);
        } catch (err) {
            callback(err);
        }
    }

    touch(sid, session, callback = () => {}) {
        try {
            this.touchStmt.run(this._expiryOf(session), sid);
            callback(null);
        } catch (err) {
            callback(err);
        }
    }

    destroy(sid, callback = () => {}) {
        try {
            this.deleteStmt.run(sid);
            callback(null);
        } catch (err) {
            callback(err);
        }
    }

    length(callback = () => {}) {
        try {
            callback(null, this.countStmt.get().n);
        } catch (err) {
            callback(err);
        }
    }

    clear(callback = () => {}) {
        try {
            this.clearStmt.run();
            callback(null);
        } catch (err) {
            callback(err);
        }
    }

    /* Abgelaufene Sitzungen entfernen — ohne das waechst die Tabelle endlos. */
    prune() {
        try {
            return this.pruneStmt.run(Date.now()).changes;
        } catch {
            return 0;
        }
    }

    close() {
        clearInterval(this.pruneTimer);
    }
}

module.exports = { SqliteSessionStore };
