'use strict';

/*
 * Audit-Log in der Tabelle `audit_log` (eine Zeile = ein Ereignis) — vorher
 * Zeilen-JSON in data/audit.log.
 *
 * Nach jedem Schreiben wird die Zeilenzahl geprueft und bei Ueberschreiten
 * auf die juengsten Zeilen gekuerzt, damit die Tabelle nicht unbegrenzt
 * waechst — analog zur frueheren, byte-basierten Kuerzung, nur anhand der
 * Zeilenzahl statt der Dateigroesse, die es als Konzept nicht mehr gibt.
 */

const MAX_ROWS = 20_000;
const KEEP_ROWS_ON_TRIM = 15_000;

function createAuditLog({ db, maxRows = MAX_ROWS, keepRowsOnTrim = KEEP_ROWS_ON_TRIM }) {
    if (!db) throw new Error('audit log braucht eine db');

    const insertStmt = db.prepare('INSERT INTO audit_log (ts, event, detail_json) VALUES (?, ?, ?)');
    const countStmt = db.prepare('SELECT COUNT(*) AS n FROM audit_log');
    const trimStmt = db.prepare(`
        DELETE FROM audit_log WHERE id NOT IN (
            SELECT id FROM audit_log ORDER BY id DESC LIMIT ?
        )
    `);
    const readStmt = db.prepare('SELECT id, ts, event, detail_json FROM audit_log ORDER BY id DESC LIMIT ?');

    /*
     * Bewusst ohne await/.catch beim Aufrufer gedacht: ein Audit-Log-Fehler
     * darf niemals die eigentliche Aktion (Login, Upload, Loeschen) scheitern
     * lassen.
     */
    async function log(event, detail = {}) {
        try {
            insertStmt.run(Date.now(), event, JSON.stringify(detail));
            if (countStmt.get().n > maxRows) {
                trimStmt.run(keepRowsOnTrim);
            }
        } catch (err) {
            console.error('Audit-Log-Schreibvorgang fehlgeschlagen:', err.message);
        }
    }

    /* Neueste zuerst. `id` (autoincrement, aufsteigend vergeben) laesst den
       Heartbeat-Client neue Eintraege erkennen, ohne die ganze Liste erneut
       zu rendern — siehe public/js/heartbeat.js. */
    async function read({ limit = 200 } = {}) {
        const n = Number.isFinite(limit) ? limit : -1; // SQLite: negatives LIMIT = kein Limit
        return readStmt.all(n).map(row => ({
            id: row.id,
            ts: row.ts,
            event: row.event,
            ...JSON.parse(row.detail_json),
        }));
    }

    return { db, log, read };
}

module.exports = { createAuditLog };
