'use strict';

/*
 * Metadaten je ISO als Sidecar-JSON in uploads/.meta/<name>.iso.json.
 *
 * Warum Sidecars und keine Datenbank: das Dateisystem bleibt die Quelle der
 * Wahrheit. Ein per rsync eingeworfenes Image ist sofort sichtbar (die
 * Metadaten werden dann nachgezogen), und ein Backup von uploads/ enthaelt
 * Images und Metadaten in einem Stueck. Der Ordner liegt bewusst *innerhalb*
 * von uploads/, damit der Docker-Bind-Mount beides mitnimmt; listFiles()
 * filtert auf .iso und uebersieht ihn deshalb.
 *
 * Gespeichert wird:
 *   sha256/hashedAt   Checksumme, plus size/mtime zum Zeitpunkt der Berechnung
 *   iso               Volume-Infos aus lib/iso9660.js
 *   downloads         Zaehler
 *
 * size/mtime sind der Gueltigkeitsstempel: weicht die Datei davon ab, gilt die
 * Checksumme als veraltet und wird neu berechnet, statt eine falsche
 * anzuzeigen.
 */

const fsp = require('fs/promises');
const path = require('path');

const FLUSH_DELAY_MS = 5000;

function createMetadataStore({ dir, flushDelayMs = FLUSH_DELAY_MS } = {}) {
    if (!dir) throw new Error('metadata store braucht ein dir');

    // Schreibvorgaenge pro Name serialisieren. Ohne das koennten sich ein
    // Checksummen-Update und ein Zaehler-Flush gegenseitig ueberschreiben,
    // weil beide lesen-aendern-schreiben machen.
    const writeChains = new Map();
    // Noch nicht persistierte Downloads, damit ein Download nicht jedes Mal
    // eine Schreiboperation auf einer heissen Datei ausloest.
    const pendingDownloads = new Map();
    let flushTimer = null;

    const filePath = name => path.join(dir, `${name}.json`);

    async function ensureDir() {
        await fsp.mkdir(dir, { recursive: true });
    }

    async function readRaw(name) {
        try {
            const text = await fsp.readFile(filePath(name), 'utf8');
            const parsed = JSON.parse(text);
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch {
            // Nicht vorhanden oder unlesbar/kaputt — beides bedeutet
            // "keine Metadaten", nie einen harten Fehler.
            return null;
        }
    }

    /* Persistierter Stand plus die noch nicht geschriebenen Downloads */
    async function read(name) {
        const stored = await readRaw(name);
        const pending = pendingDownloads.get(name) ?? 0;
        if (!stored) {
            return pending > 0 ? { name, downloads: pending } : null;
        }
        return { ...stored, downloads: (stored.downloads ?? 0) + pending };
    }

    /* Atomar: erst in eine temporaere Datei, dann rename — ein Absturz
       mitten im Schreiben hinterlaesst so kein halbes JSON. */
    async function writeRaw(name, data) {
        await ensureDir();
        const target = filePath(name);
        const tmp = `${target}.${process.pid}.tmp`;
        await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
        try {
            await fsp.rename(tmp, target);
        } catch (err) {
            await fsp.rm(tmp, { force: true });
            throw err;
        }
    }

    function serialize(name, task) {
        const previous = writeChains.get(name) ?? Promise.resolve();
        // catch vor dem Anhaengen, damit ein Fehler die Kette nicht abreisst
        const next = previous.catch(() => {}).then(task);
        writeChains.set(name, next);
        next.catch(() => {}).finally(() => {
            if (writeChains.get(name) === next) writeChains.delete(name);
        });
        return next;
    }

    /* Merge-Update; nur die uebergebenen Felder werden ersetzt. */
    function update(name, patch) {
        return serialize(name, async () => {
            const stored = (await readRaw(name)) ?? { name };
            const merged = { ...stored, ...patch, name };
            await writeRaw(name, merged);
            return merged;
        });
    }

    async function remove(name) {
        pendingDownloads.delete(name);
        await serialize(name, () => fsp.rm(filePath(name), { force: true }));
    }

    /* Alle offenen Zaehler wegschreiben. */
    async function flush() {
        if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
        }
        const entries = [...pendingDownloads.entries()];
        pendingDownloads.clear();

        await Promise.all(entries.map(([name, count]) =>
            serialize(name, async () => {
                const stored = (await readRaw(name)) ?? { name };
                await writeRaw(name, {
                    ...stored,
                    name,
                    downloads: (stored.downloads ?? 0) + count,
                });
            }).catch(err => {
                // Beim Scheitern nicht verlieren, sondern zurueck in die Queue
                pendingDownloads.set(
                    name, (pendingDownloads.get(name) ?? 0) + count
                );
                console.error('Zaehler-Flush fehlgeschlagen:', err.message);
            })
        ));
    }

    /*
     * Zaehlt einen Download. Bewusst synchron und ohne await in der Route:
     * ein Zaehler darf einen 8-GB-Download nicht verzoegern und erst recht
     * nicht scheitern lassen.
     */
    function recordDownload(name) {
        pendingDownloads.set(name, (pendingDownloads.get(name) ?? 0) + 1);
        if (!flushTimer) {
            flushTimer = setTimeout(() => {
                flushTimer = null;
                flush().catch(() => {});
            }, flushDelayMs);
            // unref: ein offener Timer darf den Prozess nicht am Leben halten
            if (typeof flushTimer.unref === 'function') flushTimer.unref();
        }
    }

    /*
     * Gilt die gespeicherte Checksumme noch fuer die Datei auf der Platte?
     * Groesse und mtime muessen exakt zu dem passen, was beim Hashen galt.
     */
    function hasCurrentChecksum(meta, stats) {
        return Boolean(
            meta &&
            meta.sha256 &&
            meta.size === stats.size &&
            meta.mtime === stats.mtimeMs
        );
    }

    return {
        dir,
        read,
        update,
        remove,
        flush,
        recordDownload,
        hasCurrentChecksum,
    };
}

module.exports = { createMetadataStore };
