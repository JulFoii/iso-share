'use strict';

/*
 * Fortsetzbare Uploads.
 *
 * Das Problem: MAX_FILE_SIZE_MB steht auf 8192. Ein 8-GB-Upload als ein
 * einziger Request faengt nach jedem WLAN-Aussetzer und jedem Proxy-Timeout
 * komplett von vorne an.
 *
 * Das Protokoll ist absichtlich klein gehalten (kein tus, keine Dependency)
 * und stuetzt sich darauf, dass ein Append-Only-Puffer seinen Fortschritt
 * selbst kennt — die Groesse der .part-Datei *ist* der Offset:
 *
 *   POST   /upload/init      {name,size}         -> {id, offset}
 *   PATCH  /upload/:id       Upload-Offset: <n>  -> {offset}
 *   GET    /upload/:id                           -> {offset}
 *   POST   /upload/:id/finish                    -> {filename}
 *   DELETE /upload/:id
 *
 * Bricht ein PATCH mitten im Chunk ab, sind die bereits geschriebenen Bytes
 * gueltig; der Client fragt den Offset ab und macht dort weiter. Genau deshalb
 * wird der mitgeschickte Offset gegen die echte Dateigroesse geprueft und bei
 * Abweichung mit 409 plus dem korrekten Wert geantwortet, statt ein Loch in
 * die Datei zu schreiben.
 *
 * Die Sitzungs-Buchhaltung (Name, angekuendigte Groesse, Erstellzeit) liegt in
 * der Tabelle `upload_sessions` — nur die tatsaechlichen Chunk-Bytes bleiben
 * als .part-Datei in tmp-uploads/ auf der Platte, weil eine mehrere GB grosse
 * Binaerdatei nicht sinnvoll in eine SQLite-Zeile gehoert (keine
 * Streaming-faehigkeit, keine Range-Writes). Der Offset selbst bleibt bewusst
 * die tatsaechliche Dateigroesse (fs.stat), nie ein in der DB mitgefuehrter
 * Zaehler: die Datei auf der Platte ist die einzige Quelle der Wahrheit
 * dafuer, wie viele Bytes wirklich angekommen sind.
 *
 * Waehrend die Chunks reinkommen, laeuft nebenbei eine SHA-256-Berechnung mit
 * (siehe `hashers` unten) — dieselben Bytes werden ohnehin schon einmal
 * gelesen/geschrieben, ein zweiter Lesedurchlauf fuer den Hash waere bei
 * einem mehrere GB grossen Image unnoetig teuer. Das ergibt die Pruefsumme
 * bereits VOR dem Verschieben nach uploads/, rechtzeitig fuer den
 * Dedup-Check in server.js. Der Hasher lebt nur im Prozessspeicher: ueberlebt
 * er einen Neustart nicht (Sitzung wurde vor dem Neustart begonnen), bleibt
 * `pendingHash()`/das `sha256` in finish() einfach `null` — der Dedup-Check
 * greift dann fuer diesen einen Upload nicht, die eigentliche Pruefsumme
 * berechnet wie immer der Hintergrund-Hash-Queue nach dem Verschieben.
 *
 * "replaces": ein Upload kann optional den Namen einer bereits vorhandenen
 * Datei mitgeben, die er ersetzen soll (vom Admin explizit im Formular
 * ausgewaehlt, siehe server.js — bewusst keine automatische Erkennung per
 * Volume-Label o.ae., um nicht versehentlich die falsche Datei zu loeschen).
 * Das Feld reist nur mit, das eigentliche Loeschen der alten Datei passiert
 * in server.js nach einem erfolgreichen finish().
 */

const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const { safeIsoName } = require('./safe-name');
const { moveFile } = require('./move-file');

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 8;
const PART_SUFFIX = '.part';

class UploadError extends Error {
    constructor(status, message, extra = {}) {
        super(message);
        this.status = status;
        this.extra = extra;
    }
}

function createUploadSessions({
    db,
    tmpDir: rawTmpDir,
    uploadsDir: rawUploadsDir,
    maxBytes,
    ttlMs = DEFAULT_TTL_MS,
    maxSessions = DEFAULT_MAX_SESSIONS,
}) {
    if (!db) throw new Error('upload sessions brauchen eine db');
    // Absolut und normalisiert, sonst vergleicht der dirname-Check in finish()
    // "uploads/x" gegen "uploads\x" und schlaegt auf Windows immer fehl.
    const tmpDir = path.resolve(rawTmpDir);
    const uploadsDir = path.resolve(rawUploadsDir);

    // Ein PATCH je Sitzung. Zwei gleichzeitige Appends wuerden sich sonst in
    // derselben Datei ueberschreiben, und der Offset waere danach geraten.
    const busy = new Set();

    // Laufender SHA-256 je Sitzung, id -> crypto.Hash. Siehe Kommentar oben.
    const hashers = new Map();

    const partPath = id => path.join(tmpDir, id + PART_SUFFIX);

    const selectStmt = db.prepare('SELECT id, name, size, created_at AS createdAt, replaces FROM upload_sessions WHERE id = ?');
    const selectAllStmt = db.prepare('SELECT id, name, size, created_at AS createdAt, replaces FROM upload_sessions');
    const insertStmt = db.prepare(
        'INSERT INTO upload_sessions (id, name, size, created_at, replaces) VALUES (?, ?, ?, ?, ?)'
    );
    const deleteStmt = db.prepare('DELETE FROM upload_sessions WHERE id = ?');

    async function ensureDir() {
        await fsp.mkdir(tmpDir, { recursive: true });
    }

    function readMeta(id) {
        return selectStmt.get(id) ?? null;
    }

    async function currentOffset(id) {
        try {
            return (await fsp.stat(partPath(id))).size;
        } catch {
            return 0;
        }
    }

    async function listSessions() {
        await ensureDir();
        const sessions = await Promise.all(
            selectAllStmt.all().map(async meta => ({ ...meta, offset: await currentOffset(meta.id) }))
        );
        return sessions;
    }

    async function get(id) {
        const meta = readMeta(id);
        if (!meta) throw new UploadError(404, 'Upload-Sitzung nicht gefunden.');
        return { ...meta, offset: await currentOffset(id) };
    }

    async function abort(id) {
        deleteStmt.run(id);
        hashers.delete(id);
        await fsp.rm(partPath(id), { force: true });
    }

    /*
     * Neue Sitzung — oder die bestehende zu derselben Datei. Zweiteres macht
     * "gleiche Datei nochmal auswaehlen" automatisch zum Fortsetzen, ohne dass
     * der Client eine ID gespeichert haben muss.
     *
     * `replaces` (optional): Name einer bestehenden Datei, die nach einem
     * erfolgreichen Upload geloescht werden soll (siehe Kommentar oben). Nur
     * validiert, nicht auf Existenz geprueft — verschwindet die Zieldatei
     * bis zum finish() ohnehin, wird das Loeschen dort einfach uebersprungen.
     */
    async function create({ name, size, replaces }) {
        const filename = safeIsoName(name);
        if (!filename) {
            throw new UploadError(
                400, 'Ungueltiger Name — nur .iso-Dateien sind erlaubt.'
            );
        }
        const total = Number(size);
        if (!Number.isInteger(total) || total <= 0) {
            throw new UploadError(400, 'Ungueltige Dateigroesse.');
        }
        if (total > maxBytes) {
            const limit = Math.floor(maxBytes / 1024 / 1024);
            throw new UploadError(413, 'Datei ueberschreitet ' + limit + ' MB.');
        }
        const replacesName = replaces ? safeIsoName(replaces) : null;
        // Sich selbst "ersetzen" ist nur der normale Ueberschreib-Fall.
        const effectiveReplaces = replacesName && replacesName !== filename ? replacesName : null;

        await ensureDir();
        const sessions = await listSessions();

        const existing = sessions.find(
            session => session.name === filename && session.size === total
        );
        if (existing) {
            return {
                id: existing.id,
                name: filename,
                size: total,
                offset: existing.offset,
                resumed: existing.offset > 0,
                replaces: existing.replaces ?? null,
            };
        }

        if (sessions.length >= maxSessions) {
            // Aelteste zuerst — sonst blockiert eine vergessene Sitzung den
            // Platz dauerhaft.
            const oldest = sessions.sort((a, b) => a.createdAt - b.createdAt)[0];
            await abort(oldest.id);
        }

        const id = crypto.randomUUID();
        insertStmt.run(id, filename, total, Date.now(), effectiveReplaces);
        await fsp.writeFile(partPath(id), '');
        hashers.set(id, crypto.createHash('sha256'));
        return {
            id, name: filename, size: total, offset: 0, resumed: false, replaces: effectiveReplaces,
        };
    }

    /*
     * Haengt den Request-Body an. `claimedOffset` muss dem tatsaechlichen
     * Stand entsprechen; sonst 409 mit dem echten Offset, damit der Client
     * resynchronisieren kann, statt Muell zu schreiben.
     */
    async function append(id, claimedOffset, source) {
        const session = await get(id);

        if (busy.has(id)) {
            throw new UploadError(
                409, 'Fuer diesen Upload laeuft bereits ein Chunk.',
                { offset: session.offset }
            );
        }
        if (!Number.isInteger(claimedOffset) || claimedOffset < 0) {
            throw new UploadError(400, 'Upload-Offset fehlt oder ist ungueltig.');
        }
        if (claimedOffset !== session.offset) {
            throw new UploadError(
                409, 'Upload-Offset passt nicht zum Serverstand.',
                { offset: session.offset }
            );
        }
        if (session.offset >= session.size) {
            throw new UploadError(
                409, 'Upload ist bereits vollstaendig.',
                { offset: session.offset }
            );
        }

        busy.add(id);
        const remaining = session.size - session.offset;
        let written = 0;
        let overflow = false;
        const hasher = hashers.get(id);

        try {
            const sink = fs.createWriteStream(partPath(id), { flags: 'a' });
            // Mehr als angekuendigt wird nicht angenommen: sonst koennte ein
            // Client das Groessenlimit umgehen, indem er klein anmeldet und
            // dann endlos anhaengt.
            async function* limited() {
                for await (const chunk of source) {
                    if (written + chunk.length > remaining) {
                        overflow = true;
                        const fits = remaining - written;
                        if (fits > 0) {
                            written += fits;
                            const piece = chunk.subarray(0, fits);
                            if (hasher) hasher.update(piece);
                            yield piece;
                        }
                        return;
                    }
                    written += chunk.length;
                    if (hasher) hasher.update(chunk);
                    yield chunk;
                }
            }
            await pipeline(limited(), sink);
        } catch (err) {
            // Abbruch mitten im Chunk ist kein Datenverlust: der Offset steht
            // danach einfach niedriger, der Client setzt dort fort. Der
            // Hasher hat aber moeglicherweise schon Bytes verarbeitet, die
            // es nicht (vollstaendig) auf die Platte geschafft haben — ab
            // hier gilt er als unzuverlaessig und wird verworfen; die echte
            // Pruefsumme liefert dann wie eh und je der Hintergrund-Hash-Queue.
            hashers.delete(id);
            const offset = await currentOffset(id);
            throw new UploadError(
                500, 'Chunk konnte nicht geschrieben werden.',
                { offset, cause: err.message }
            );
        } finally {
            busy.delete(id);
        }

        const offset = await currentOffset(id);
        if (overflow) {
            throw new UploadError(
                413, 'Es wurden mehr Bytes gesendet als angekuendigt.', { offset }
            );
        }
        return { ...session, offset, complete: offset >= session.size };
    }

    /*
     * Die bislang mitgelaufene Pruefsumme, ohne die Sitzung zu beenden —
     * server.js nutzt das, um VOR dem Verschieben nach uploads/ auf ein
     * Duplikat zu pruefen. hash.copy() (Node >=20.12) dupliziert den
     * internen Zustand, damit der eigentliche Hasher in finish() noch ein
     * zweites Mal digest()en kann; digest() selbst ist destruktiv.
     * null, wenn kein Hasher (mehr) vorhanden ist — siehe Kommentar oben.
     */
    function pendingHash(id) {
        const hasher = hashers.get(id);
        return hasher ? hasher.copy().digest('hex') : null;
    }

    /* Verschiebt die fertige Datei nach uploads/ und raeumt die Sitzung ab. */
    async function finish(id) {
        const session = await get(id);
        if (session.offset !== session.size) {
            throw new UploadError(409, 'Upload ist unvollstaendig.', {
                offset: session.offset,
                size: session.size,
            });
        }
        // Der Name lag die ganze Zeit in der DB — vor dem Verschieben noch
        // einmal validieren, nicht dem Sitzungs-Datensatz blind vertrauen.
        const filename = safeIsoName(session.name);
        if (!filename) {
            await abort(id);
            throw new UploadError(400, 'Ungueltiger Dateiname.');
        }

        await fsp.mkdir(uploadsDir, { recursive: true });
        const target = path.join(uploadsDir, filename);
        if (path.dirname(target) !== uploadsDir) {
            await abort(id);
            throw new UploadError(400, 'Ungueltiger Dateiname.');
        }

        const hasher = hashers.get(id);
        const sha256 = hasher ? hasher.digest('hex') : null;
        hashers.delete(id);

        await moveFile(partPath(id), target);
        deleteStmt.run(id);
        return { filename, sha256, replaces: session.replaces ?? null };
    }

    /* Liegengebliebene Sitzungen entsorgen (Browser zu, Rechner aus, ...). */
    async function cleanupStale(now = Date.now()) {
        const sessions = await listSessions();
        let removed = 0;

        for (const session of sessions) {
            if (now - session.createdAt > ttlMs) {
                await abort(session.id);
                removed++;
            }
        }

        // Eine .part ohne zugehoerige Sitzung in der DB ist ebenfalls Muell
        const entries = await fsp.readdir(tmpDir).catch(() => []);
        for (const entry of entries) {
            if (!entry.endsWith(PART_SUFFIX)) continue;
            const id = entry.slice(0, -PART_SUFFIX.length);
            if (!readMeta(id)) {
                await fsp.rm(path.join(tmpDir, entry), { force: true });
                removed++;
            }
        }
        return removed;
    }

    return {
        create, get, append, finish, abort, cleanupStale, listSessions, pendingHash,
    };
}

module.exports = { createUploadSessions, UploadError };
