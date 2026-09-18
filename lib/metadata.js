'use strict';

/*
 * Metadaten je ISO in der Tabelle `files` von lib/db.js — vorher ein Sidecar
 * je Datei unter uploads/.meta/<name>.iso.json.
 *
 * Gespeichert wird:
 *   sha256/hashedAt   Checksumme, plus size/mtime zum Zeitpunkt der Berechnung
 *   iso               Volume-Infos aus lib/iso9660.js (als JSON-Spalte)
 *   downloads         Zaehler
 *   tags/autoTags/removedAutoTags  siehe lib/auto-tags.js
 *
 * size/mtime sind der Gueltigkeitsstempel: weicht die Datei davon ab, gilt die
 * Checksumme als veraltet und wird neu berechnet, statt eine falsche
 * anzuzeigen.
 *
 * Kein Schreib-Puffer, keine Schreibkette mehr: anders als bei async-fs-
 * Schreibvorgaengen kann zwischen "lesen" und "schreiben" in derselben
 * synchronen DB-Operation kein anderer Code mehr laufen, ein Update ist damit
 * von Natur aus atomar. recordDownload() ist ein einzelnes atomares
 * UPDATE ... SET downloads = downloads + 1 statt eines im Speicher
 * gepufferten Zaehlers.
 */

function rowToMeta(row) {
    if (!row) return null;
    return {
        name: row.name,
        sha256: row.sha256 ?? undefined,
        hashedAt: row.hashed_at ?? undefined,
        size: row.size ?? undefined,
        mtime: row.mtime ?? undefined,
        iso: row.iso_json !== null ? JSON.parse(row.iso_json) : undefined,
        downloads: row.downloads,
        tags: JSON.parse(row.tags_json),
        // undefined (nicht []) heisst "noch nie Auto-Tags vergeben" — siehe
        // hash-queue.js scanAll(), das daran ein Backfill fuer alte Sidecars
        // erkennt.
        autoTags: row.auto_tags_json !== null ? JSON.parse(row.auto_tags_json) : undefined,
        removedAutoTags: JSON.parse(row.removed_auto_tags_json),
    };
}

function createMetadataStore({ db }) {
    if (!db) throw new Error('metadata store braucht eine db');

    const selectStmt = db.prepare('SELECT * FROM files WHERE name = ?');
    const upsertStmt = db.prepare(`
        INSERT INTO files
            (name, sha256, hashed_at, size, mtime, iso_json, downloads, tags_json, auto_tags_json, removed_auto_tags_json)
        VALUES
            (@name, @sha256, @hashedAt, @size, @mtime, @isoJson, @downloads, @tagsJson, @autoTagsJson, @removedAutoTagsJson)
        ON CONFLICT(name) DO UPDATE SET
            sha256 = excluded.sha256,
            hashed_at = excluded.hashed_at,
            size = excluded.size,
            mtime = excluded.mtime,
            iso_json = excluded.iso_json,
            downloads = excluded.downloads,
            tags_json = excluded.tags_json,
            auto_tags_json = excluded.auto_tags_json,
            removed_auto_tags_json = excluded.removed_auto_tags_json
    `);
    const deleteStmt = db.prepare('DELETE FROM files WHERE name = ?');
    const incrementDownloadStmt = db.prepare(`
        INSERT INTO files (name, downloads) VALUES (?, 1)
        ON CONFLICT(name) DO UPDATE SET downloads = downloads + 1
    `);
    const findByChecksumStmt = db.prepare('SELECT name FROM files WHERE sha256 = ?');

    async function read(name) {
        return rowToMeta(selectStmt.get(name));
    }

    /* Merge-Update; nur die uebergebenen Felder werden ersetzt. */
    async function update(name, patch) {
        const existing = rowToMeta(selectStmt.get(name)) ?? {
            name, downloads: 0, tags: [], removedAutoTags: [],
        };
        const merged = { ...existing, ...patch, name };
        upsertStmt.run({
            name,
            sha256: merged.sha256 ?? null,
            hashedAt: merged.hashedAt ?? null,
            size: merged.size ?? null,
            mtime: merged.mtime ?? null,
            isoJson: merged.iso !== undefined ? JSON.stringify(merged.iso) : null,
            downloads: merged.downloads ?? 0,
            tagsJson: JSON.stringify(merged.tags ?? []),
            autoTagsJson: merged.autoTags !== undefined ? JSON.stringify(merged.autoTags) : null,
            removedAutoTagsJson: JSON.stringify(merged.removedAutoTags ?? []),
        });
        return merged;
    }

    async function remove(name) {
        deleteStmt.run(name);
    }

    /*
     * Alle Dateinamen mit exakt dieser Pruefsumme — Grundlage fuer die
     * Dedup-Pruefung beim Upload (server.js). Vergleicht bewusst nur die
     * gespeicherte Spalte, ohne hasCurrentChecksum(): selbst ein inzwischen
     * leicht veralteter Eintrag bedeutet noch immer "dieser Inhalt lag hier
     * schon einmal".
     */
    async function findByChecksum(sha256) {
        return findByChecksumStmt.all(sha256).map(row => row.name);
    }

    /*
     * Zaehlt einen Download. Bewusst ohne await in der Route: ein Zaehler
     * darf einen 8-GB-Download nicht verzoegern — das UPDATE selbst ist aber
     * schon eine einzelne, indizierte, synchrone Operation.
     */
    function recordDownload(name) {
        incrementDownloadStmt.run(name);
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
        db,
        read,
        update,
        remove,
        recordDownload,
        hasCurrentChecksum,
        findByChecksum,
    };
}

module.exports = { createMetadataStore };
