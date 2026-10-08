'use strict';

/*
 * Anhaenge an Ticket-Nachrichten. Metadaten in `ticket_attachments` (siehe
 * lib/db.js), die Bytes selbst als Datei unter DATA_DIR/ticket-attachments/
 * <id> — ausserhalb des Web-Roots, nie statisch ausgeliefert, sondern nur
 * ueber GET /attachments/:id mit Berechtigungspruefung (Eigentuemer oder
 * Admin, siehe lib/routes/tickets-customer.js).
 *
 * Der Dateityp kommt aus den Magic-Bytes der Datei, nie aus dem vom Client
 * gemeldeten Content-Type oder der Endung allein: eine als "bild.png"
 * hochgeladene HTML-Datei wird abgelehnt statt spaeter als text/html
 * ausgeliefert. Erlaubt ist bewusst nur, was im Support-Alltag gebraucht
 * wird (Screenshots, PDFs, Logs, Archive) — kein SVG (kann Skript
 * enthalten), kein HTML, keine ausfuehrbaren Dateien.
 *
 * Zweistufig, damit eine abgelehnte Datei nie eine halb angelegte Nachricht
 * hinterlaesst: inspect*() prueft alles vorher, commit() legt erst danach
 * Nachricht, Zeilen und Dateien an. commit() schreibt zuerst die Dateien
 * (unter einer frischen UUID) und fasst dann das Anlegen der Nachricht (der
 * uebergebene Callback) und die Anhang-Zeilen in *eine* Transaktion
 * (lib/db-tx.js): scheitert irgendetwas, gibt es weder ein Ticket ohne seine
 * Anhaenge noch eine Zeile ohne Datei, und die schon geschriebenen Dateien
 * werden wieder entfernt. Was ein Absturz genau dazwischen doch
 * zuruecklaesst (Datei ohne Zeile), raeumt sweepOrphans() stuendlich weg.
 *
 * Vor dem Schreiben prueft commit() den freien Speicher (dieselbe Reserve
 * MIN_FREE_DISK_MB wie lib/chunked-upload.js): ein von Anhaengen volles
 * Volume legte sonst auch die SQLite-Schreibzugriffe lahm. Fuer Browser-
 * Uploads prueft attachmentsMiddleware() (lib/routes/helpers.js) mit
 * hasSpaceFor() schon vor multer anhand von Content-Length.
 *
 * Nicht Teil der Datenbank-Backups (lib/backup-store.js sichert nur die
 * SQLite-Datei) — liegt aber im selben DATA_DIR-Volume.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { moveFile } = require('./move-file');
const { transaction } = require('./db-tx');
const { defaultDiskInfo } = require('./chunked-upload');

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;
const ORPHAN_GRACE_MS = 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TEXT_EXTENSIONS = new Set(['txt', 'log', 'csv', 'md', 'json', 'conf', 'cfg', 'ini', 'yaml', 'yml']);

class AttachmentError extends Error {
    constructor(message, code) {
        super(message);
        this.code = code;
    }
}

function startsWith(buffer, bytes, offset = 0) {
    if (buffer.length < offset + bytes.length) return false;
    return bytes.every((byte, i) => buffer[offset + i] === byte);
}

function extensionOf(filename) {
    const match = /\.([a-z0-9]{1,8})$/i.exec(filename);
    return match ? match[1].toLowerCase() : '';
}

/* Erkennt den Typ anhand der ersten Bytes; null = nicht erlaubt. */
function detectType(head, filename) {
    if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
    if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg';
    if (startsWith(head, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
    if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)) {
        return 'image/webp';
    }
    if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
    if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])) {
        return 'application/zip';
    }
    if (startsWith(head, [0x1f, 0x8b])) return 'application/gzip';

    // Textdateien haben keine Signatur: nur bei passender Endung, ohne
    // NUL-Bytes und mit gueltigem UTF-8 im Kopf. {stream:true} toleriert
    // eine am Pufferende abgeschnittene Mehrbyte-Sequenz.
    if (TEXT_EXTENSIONS.has(extensionOf(filename)) && !head.includes(0)) {
        try {
            new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true });
            return 'text/plain';
        } catch {
            return null;
        }
    }
    return null;
}

/* Nur der Basisname, ohne Steuer-/Pfadzeichen, gekuerzt — landet nur in
   Content-Disposition und in der Anzeige, nie in einem Dateipfad. */
function sanitizeFilename(input) {
    const base = path.basename(String(input ?? '').replace(/\\/g, '/'));
    // eslint-disable-next-line no-control-regex
    const clean = base.replace(/[\u0000-\u001f\u007f"<>|:*?/\\]/g, '_').replace(/^\.+/, '').trim();
    if (!clean) return 'anhang';
    if (clean.length <= 120) return clean;
    const ext = extensionOf(clean);
    return ext ? `${clean.slice(0, 110)}.${ext}` : clean.slice(0, 120);
}

async function readHead(filePath, bytes = 4096) {
    const handle = await fsp.open(filePath, 'r');
    try {
        const buffer = Buffer.alloc(bytes);
        const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
        return buffer.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
}

function sha256OfFile(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        fs.createReadStream(filePath)
            .on('data', chunk => hash.update(chunk))
            .on('error', reject)
            .on('end', () => resolve(hash.digest('hex')));
    });
}

function createAttachmentStore({
    db, dir, maxBytes = DEFAULT_MAX_BYTES, maxFiles = DEFAULT_MAX_FILES,
    // Reserve, die frei bleiben muss (< 0 schaltet die Pruefung ab), und wo
    // multer die Uploads zwischenlagert (kann ein eigenes Volume sein).
    minFreeBytes = -1, tmpDir = null, diskInfo = defaultDiskInfo,
}) {
    if (!db) throw new Error('attachment store braucht eine db');
    const DIR = path.resolve(dir);

    const insertStmt = db.prepare(`
        INSERT INTO ticket_attachments (id, ticket_id, message_id, filename, mime, size, sha256, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const getStmt = db.prepare(`
        SELECT a.*, m.internal AS message_internal
        FROM ticket_attachments a LEFT JOIN ticket_messages m ON m.id = a.message_id
        WHERE a.id = ?
    `);
    const totalStmt = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM ticket_attachments');
    const existsStmt = db.prepare('SELECT 1 FROM ticket_attachments WHERE id = ?');

    function filePath(id) {
        return path.join(DIR, id);
    }

    function checkCount(count) {
        if (count > maxFiles) {
            throw new AttachmentError(`Höchstens ${maxFiles} Anhänge pro Nachricht.`, 'too_many_files');
        }
    }

    function checkSize(size, filename) {
        if (size <= 0) throw new AttachmentError(`„${filename}“ ist leer.`, 'empty_file');
        if (size > maxBytes) {
            throw new AttachmentError(
                `„${filename}“ ist zu groß (max. ${Math.round(maxBytes / 1024 / 1024)} MB).`, 'file_too_large'
            );
        }
    }

    function checkType(head, filename) {
        const mime = detectType(head, filename);
        if (!mime) {
            throw new AttachmentError(
                `„${filename}“ hat einen nicht erlaubten Dateityp. Erlaubt: Bilder (PNG, JPG, GIF, WebP), ` +
                'PDF, ZIP/GZIP und Textdateien (txt, log, csv, json …).',
                'file_type'
            );
        }
        return mime;
    }

    /* files: multer-Dateiobjekte ({path, originalname, size}). Wirft
       AttachmentError beim ersten Problem, sonst [{tmpPath, filename, mime, size}]. */
    async function inspectUploads(files = []) {
        checkCount(files.length);
        const result = [];
        for (const file of files) {
            const filename = sanitizeFilename(file.originalname);
            checkSize(file.size, filename);
            const mime = checkType(await readHead(file.path), filename);
            result.push({ tmpPath: file.path, filename, mime, size: file.size });
        }
        return result;
    }

    /* Fuer eingehende Mails (lib/mail-inbound.js): [{filename, content: Buffer}]. */
    function inspectBuffers(parts = []) {
        checkCount(parts.length);
        return parts.map(part => {
            const filename = sanitizeFilename(part.filename);
            checkSize(part.content.length, filename);
            const mime = checkType(part.content.subarray(0, 4096), filename);
            return { buffer: part.content, filename, mime, size: part.content.length };
        });
    }

    /* true, wenn `bytes` plus Reserve auf jedes beteiligte Volume passen
       (Anhang-Verzeichnis und multer-Temp, dasselbe Dateisystem nur
       einmal). Ohne statfs (diskInfo liefert null) wird nicht blockiert. */
    async function hasSpaceFor(bytes) {
        if (!(minFreeBytes >= 0)) return true;
        await fsp.mkdir(DIR, { recursive: true });
        const checked = new Set();
        for (const target of [DIR, tmpDir].filter(Boolean)) {
            const info = await diskInfo(target);
            if (!info || checked.has(info.device)) continue;
            checked.add(info.device);
            if (info.free < Number(bytes || 0) + minFreeBytes) return false;
        }
        return true;
    }

    async function assertSpace(items) {
        const bytes = items.reduce((sum, item) => sum + (item.size || 0), 0);
        if (items.length > 0 && !(await hasSpaceFor(bytes))) {
            throw new AttachmentError(
                'Auf dem Server ist gerade nicht genug Speicherplatz für Anhänge frei. Bitte später erneut versuchen.',
                'insufficient_storage'
            );
        }
    }

    /* Schreibt die Bytes an ihren endgueltigen Platz — noch ohne DB-Zeile. */
    async function stageOne(item) {
        await fsp.mkdir(DIR, { recursive: true });
        const id = crypto.randomUUID();
        const target = filePath(id);
        let sha256;
        if (item.buffer) {
            await fsp.writeFile(target, item.buffer, { flag: 'wx' });
            sha256 = crypto.createHash('sha256').update(item.buffer).digest('hex');
        } else {
            sha256 = await sha256OfFile(item.tmpPath);
            await moveFile(item.tmpPath, target);
        }
        return { id, filename: item.filename, mime: item.mime, size: item.size, sha256 };
    }

    function insertRow(staged, { ticketId, messageId }) {
        const createdAt = Date.now();
        insertStmt.run(staged.id, ticketId, messageId, staged.filename, staged.mime, staged.size, staged.sha256, createdAt);
        return { ...staged, ticketId, messageId, createdAt };
    }

    async function stageAll(items) {
        await assertSpace(items);
        const staged = [];
        try {
            for (const item of items) staged.push(await stageOne(item));
        } catch (err) {
            await removeFiles(staged.map(entry => entry.id));
            throw err;
        }
        return staged;
    }

    /*
     * items: Ergebnis von inspect*(). write: synchroner Callback, der die
     * Nachricht anlegt und ein Objekt mit `message` ({id, ticketId}) liefert,
     * z. B. () => ticketStore.addReply(...). Ergebnis: { result, stored }.
     * Liefert write null (Ticket inzwischen zusammengefuehrt …), wird nichts
     * gespeichert: { result: null, stored: [] }.
     */
    async function commit(items, write) {
        const staged = await stageAll(items);
        let outcome;
        try {
            outcome = transaction(db, () => {
                const result = write();
                if (!result?.message) return { result: result ?? null, stored: [] };
                const target = { ticketId: result.message.ticketId, messageId: result.message.id };
                return { result, stored: staged.map(entry => insertRow(entry, target)) };
            });
        } catch (err) {
            await removeFiles(staged.map(entry => entry.id));
            throw err;
        }
        // write() hat nichts angelegt: nichts verweist auf die Dateien
        if (outcome.stored.length < staged.length) await removeFiles(staged.map(entry => entry.id));
        return outcome;
    }

    /* An eine schon bestehende Nachricht haengen. */
    async function storeAll(items, target) {
        const staged = await stageAll(items);
        try {
            return transaction(db, () => staged.map(entry => insertRow(entry, target)));
        } catch (err) {
            await removeFiles(staged.map(entry => entry.id));
            throw err;
        }
    }

    /*
     * Dateien im Anhang-Verzeichnis ohne DB-Zeile (Absturz zwischen
     * stageOne() und dem Commit, oder eine von Hand geloeschte Zeile). Nur
     * Dateien, die aelter als graceMs sind — eine juengere kann gerade mitten
     * in einem commit() stecken. Liefert die Anzahl entfernter Dateien.
     */
    async function sweepOrphans({ graceMs = ORPHAN_GRACE_MS, now = Date.now() } = {}) {
        let names;
        try {
            names = await fsp.readdir(DIR);
        } catch (err) {
            if (err.code === 'ENOENT') return 0;
            throw err;
        }
        let removed = 0;
        for (const name of names) {
            if (!UUID_RE.test(name) || existsStmt.get(name)) continue;
            try {
                const stats = await fsp.stat(filePath(name));
                if (!stats.isFile() || now - stats.mtimeMs < graceMs) continue;
                await fsp.rm(filePath(name), { force: true });
                removed += 1;
            } catch {
                // inzwischen verschwunden oder nicht lesbar — naechster Lauf
            }
        }
        return removed;
    }

    function getAttachment(id) {
        const row = getStmt.get(String(id ?? ''));
        if (!row) return null;
        return {
            id: row.id,
            ticketId: row.ticket_id,
            messageId: row.message_id,
            filename: row.filename,
            mime: row.mime,
            size: row.size,
            sha256: row.sha256,
            internal: row.message_internal === 1,
            isImage: /^image\//.test(row.mime),
        };
    }

    /* Entfernt die Dateien zu bereits aus der DB geloeschten Zeilen (siehe
       deleteTicket() in lib/ticket-store.js). Fehlende Dateien sind kein
       Fehler. */
    async function removeFiles(ids = []) {
        await Promise.all(ids.map(id => fsp.rm(filePath(id), { force: true }).catch(() => {})));
    }

    /* Temp-Dateien eines abgelehnten Uploads wegraeumen. */
    async function discardUploads(files = []) {
        await Promise.all(files.map(file => fsp.rm(file.path, { force: true }).catch(() => {})));
    }

    function totals() {
        const row = totalStmt.get();
        return { count: row.n, bytes: row.bytes };
    }

    return {
        dir: DIR, maxBytes, maxFiles, inspectUploads, inspectBuffers, commit, storeAll, getAttachment, filePath,
        removeFiles, discardUploads, totals, hasSpaceFor, sweepOrphans, minFreeBytes,
    };
}

module.exports = { createAttachmentStore, AttachmentError, detectType, sanitizeFilename };
