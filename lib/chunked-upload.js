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
const JSON_SUFFIX = '.json';
const PART_SUFFIX = '.part';

class UploadError extends Error {
    constructor(status, message, extra = {}) {
        super(message);
        this.status = status;
        this.extra = extra;
    }
}

function createUploadSessions({
    tmpDir: rawTmpDir,
    uploadsDir: rawUploadsDir,
    maxBytes,
    ttlMs = DEFAULT_TTL_MS,
    maxSessions = DEFAULT_MAX_SESSIONS,
}) {
    // Absolut und normalisiert, sonst vergleicht der dirname-Check in finish()
    // "uploads/x" gegen "uploads\x" und schlaegt auf Windows immer fehl.
    const tmpDir = path.resolve(rawTmpDir);
    const uploadsDir = path.resolve(rawUploadsDir);

    // Ein PATCH je Sitzung. Zwei gleichzeitige Appends wuerden sich sonst in
    // derselben Datei ueberschreiben, und der Offset waere danach geraten.
    const busy = new Set();

    const partPath = id => path.join(tmpDir, id + PART_SUFFIX);
    const metaPath = id => path.join(tmpDir, id + JSON_SUFFIX);

    async function ensureDir() {
        await fsp.mkdir(tmpDir, { recursive: true });
    }

    async function readMeta(id) {
        try {
            const parsed = JSON.parse(await fsp.readFile(metaPath(id), 'utf8'));
            if (!parsed || typeof parsed !== 'object') return null;
            if (!safeIsoName(parsed.name)) return null;
            if (!Number.isInteger(parsed.size) || parsed.size < 0) return null;
            return parsed;
        } catch {
            return null;
        }
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
        let entries;
        try {
            entries = await fsp.readdir(tmpDir);
        } catch {
            return [];
        }
        const ids = entries
            .filter(name => name.endsWith(JSON_SUFFIX))
            .map(name => name.slice(0, -JSON_SUFFIX.length));

        const sessions = await Promise.all(ids.map(async id => {
            const meta = await readMeta(id);
            return meta ? { ...meta, id, offset: await currentOffset(id) } : null;
        }));
        return sessions.filter(Boolean);
    }

    async function get(id) {
        const meta = await readMeta(id);
        if (!meta) throw new UploadError(404, 'Upload-Sitzung nicht gefunden.');
        return { ...meta, id, offset: await currentOffset(id) };
    }

    async function abort(id) {
        await Promise.all([
            fsp.rm(partPath(id), { force: true }),
            fsp.rm(metaPath(id), { force: true }),
        ]);
    }

    /*
     * Neue Sitzung — oder die bestehende zu derselben Datei. Zweiteres macht
     * "gleiche Datei nochmal auswaehlen" automatisch zum Fortsetzen, ohne dass
     * der Client eine ID gespeichert haben muss.
     */
    async function create({ name, size }) {
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
            };
        }

        if (sessions.length >= maxSessions) {
            // Aelteste zuerst — sonst blockiert eine vergessene Sitzung den
            // Platz dauerhaft.
            const oldest = sessions.sort((a, b) => a.createdAt - b.createdAt)[0];
            await abort(oldest.id);
        }

        const id = crypto.randomUUID();
        await fsp.writeFile(metaPath(id), JSON.stringify({
            name: filename,
            size: total,
            createdAt: Date.now(),
        }), 'utf8');
        await fsp.writeFile(partPath(id), '');
        return { id, name: filename, size: total, offset: 0, resumed: false };
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
                            yield chunk.subarray(0, fits);
                        }
                        return;
                    }
                    written += chunk.length;
                    yield chunk;
                }
            }
            await pipeline(limited(), sink);
        } catch (err) {
            // Abbruch mitten im Chunk ist kein Datenverlust: der Offset steht
            // danach einfach niedriger, der Client setzt dort fort.
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

    /* Verschiebt die fertige Datei nach uploads/ und raeumt die Sitzung ab. */
    async function finish(id) {
        const session = await get(id);
        if (session.offset !== session.size) {
            throw new UploadError(409, 'Upload ist unvollstaendig.', {
                offset: session.offset,
                size: session.size,
            });
        }
        // Der Name lag die ganze Zeit auf der Platte — vor dem Verschieben
        // noch einmal validieren, nicht dem Sitzungs-JSON vertrauen.
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

        await moveFile(partPath(id), target);
        await fsp.rm(metaPath(id), { force: true });
        return { filename };
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

        // Eine .part ohne zugehoerige .json ist ebenfalls Muell
        const entries = await fsp.readdir(tmpDir).catch(() => []);
        for (const entry of entries) {
            if (!entry.endsWith(PART_SUFFIX)) continue;
            const id = entry.slice(0, -PART_SUFFIX.length);
            if (!(await readMeta(id))) {
                await fsp.rm(path.join(tmpDir, entry), { force: true });
                removed++;
            }
        }
        return removed;
    }

    return { create, get, append, finish, abort, cleanupStale, listSessions };
}

module.exports = { createUploadSessions, UploadError };
