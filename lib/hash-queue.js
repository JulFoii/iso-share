'use strict';

/*
 * Berechnet SHA-256-Checksummen im Hintergrund, eine Datei zur Zeit.
 *
 * Warum nicht im Upload-Stream mitrechnen: so wird jedes Image erfasst, auch
 * eines, das per rsync oder direkt im Bind-Mount in uploads/ gelandet ist —
 * bei einem Mirror der Normalfall. Es gibt genau einen Codepfad fuer die
 * Checksumme statt einen pro Upload-Variante.
 *
 * Der Preis ist ein zusaetzlicher Lesedurchlauf. Deshalb laeuft es entkoppelt
 * von der Anfrage: die Route stellt nur in die Queue, die Views zeigen
 * "wird berechnet" und beim naechsten Laden steht der Hash da.
 *
 * Derselbe Lauf vergibt auch die Auto-Tags aus lib/auto-tags.js, weil die
 * dafuer noetigen ISO-Infos hier ohnehin schon einmal gelesen werden.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { readIsoInfo } = require('./iso9660');
const { deriveAutoTags, applyAutoTags } = require('./auto-tags');

const DEFAULT_MAX_AUTO_TAGS = 15;

async function sha256OfFile(filePath) {
    const hash = crypto.createHash('sha256');
    // Grosszuegige Chunks: bei mehreren GB spart das einen Haufen
    // Stream-Overhead gegenueber dem 64-KB-Default.
    const stream = fs.createReadStream(filePath, { highWaterMark: 1 << 20 });
    for await (const chunk of stream) {
        hash.update(chunk);
    }
    return hash.digest('hex');
}

function createHashQueue({
    uploadsDir, metadata, log = console, maxAutoTags = DEFAULT_MAX_AUTO_TAGS,
}) {
    const queue = [];
    const queued = new Set();
    let current = null;
    let running = false;

    function enqueue(name) {
        if (queued.has(name) || current === name) return;
        queued.add(name);
        queue.push(name);
        if (!running) {
            running = true;
            // Erst nach dem aktuellen Tick starten, damit enqueue() in einer
            // Route nie synchron Datei-I/O anstoesst.
            setImmediate(() => { drain().catch(() => {}); });
        }
    }

    async function processOne(name) {
        const filePath = path.join(uploadsDir, name);

        let before;
        try {
            before = await fsp.stat(filePath);
        } catch {
            return;                       // inzwischen geloescht
        }
        if (!before.isFile()) return;

        const sha256 = await sha256OfFile(filePath);

        // Waehrend des Lesens veraendert? Dann passt der Hash nicht zum
        // jetzigen Inhalt — nichts speichern, sondern neu einreihen.
        const after = await fsp.stat(filePath);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
            enqueue(name);
            return;
        }

        const iso = await readIsoInfo(filePath);

        const existing = await metadata.read(name);
        const { tags, autoTags } = applyAutoTags(existing, deriveAutoTags(iso), maxAutoTags);

        await metadata.update(name, {
            size: after.size,
            mtime: after.mtimeMs,
            sha256,
            hashedAt: Date.now(),
            iso,
            tags,
            autoTags,
        });
    }

    async function drain() {
        try {
            while (queue.length > 0) {
                current = queue.shift();
                queued.delete(current);
                try {
                    await processOne(current);
                } catch (err) {
                    log.error(`Checksumme fuer ${current} fehlgeschlagen:`, err.message);
                }
                current = null;
            }
        } finally {
            current = null;
            running = false;
        }
    }

    /*
     * Alles einreihen, was noch keine gueltige Checksumme hat. Laeuft beim
     * Start und holt damit auch Images ein, die ausserhalb der App in
     * uploads/ gelegt wurden.
     *
     * Fuer Dateien, deren Checksumme schon aktuell ist, aber deren Sidecar
     * noch kein autoTags-Feld hat (gehasht, bevor es Auto-Tags gab), werden
     * die Tags direkt aus dem bereits gespeicherten iso-Info nachgetragen —
     * ohne die Datei erneut zu lesen/hashen, das ISO-Info liegt ja schon vor.
     */
    async function scanAll() {
        let names;
        try {
            names = (await fsp.readdir(uploadsDir))
                .filter(name => name.toLowerCase().endsWith('.iso'));
        } catch {
            return 0;
        }

        let missing = 0;
        for (const name of names) {
            try {
                const stats = await fsp.stat(path.join(uploadsDir, name));
                const meta = await metadata.read(name);
                if (!metadata.hasCurrentChecksum(meta, stats)) {
                    enqueue(name);
                    missing++;
                } else if (meta.autoTags === undefined) {
                    const { tags, autoTags } =
                        applyAutoTags(meta, deriveAutoTags(meta.iso), maxAutoTags);
                    await metadata.update(name, { tags, autoTags });
                }
            } catch {
                // einzelne Datei nicht lesbar — der Rest laeuft weiter
            }
        }
        return missing;
    }

    /* 'hashing' fuer die laufende Datei, 'queued' fuer wartende. */
    function statusOf(name) {
        if (current === name) return 'hashing';
        if (queued.has(name)) return 'queued';
        return null;
    }

    function isIdle() {
        return !running && queue.length === 0 && current === null;
    }

    /* Fuer Tests: wartet, bis die Queue leer ist. */
    async function whenIdle() {
        while (!isIdle()) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }

    return { enqueue, scanAll, statusOf, isIdle, whenIdle };
}

module.exports = { createHashQueue, sha256OfFile };
