'use strict';

/*
 * Audit-Log als Zeilen-JSON (eine Zeile = ein Ereignis) in data/audit.log —
 * liegt im selben, per Docker-Volume persistierten data/-Ordner wie
 * data/sessions/ und data/admin-password.json.
 *
 * Anhaengen statt Datenbank: ein Single-Admin-Account erzeugt wenige
 * Ereignisse pro Tag, ein Zeilenformat laesst sich mit jedem Texttool lesen
 * und braucht keine Schreib-Transaktion. Nach jedem Schreiben wird die
 * Dateigroesse geprueft und bei Ueberschreiten auf die juengsten Zeilen
 * gekuerzt, damit die Datei nicht unbegrenzt waechst — bei dieser Ereignisrate
 * faellt die zusaetzliche stat()-Anfrage pro Schreibvorgang nicht ins Gewicht.
 */

const fsp = require('fs/promises');
const path = require('path');

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const KEEP_LINES_ON_TRIM = 3000;

function createAuditLog({ file }) {
    if (!file) throw new Error('audit log braucht eine file');

    let writeChain = Promise.resolve();
    function serialize(task) {
        const next = writeChain.catch(() => {}).then(task);
        writeChain = next;
        return next;
    }

    async function trimIfNeeded() {
        let stats;
        try {
            stats = await fsp.stat(file);
        } catch {
            return;
        }
        if (stats.size <= MAX_BYTES) return;
        const text = await fsp.readFile(file, 'utf8').catch(() => '');
        const kept = text.split('\n').filter(Boolean).slice(-KEEP_LINES_ON_TRIM);
        await fsp.writeFile(file, kept.length > 0 ? `${kept.join('\n')}\n` : '', 'utf8');
    }

    /*
     * Bewusst ohne await/.catch beim Aufrufer gedacht: ein Audit-Log-Fehler
     * (volle Platte, kaputtes Volume) darf niemals die eigentliche Aktion
     * (Login, Upload, Loeschen) scheitern lassen.
     */
    function log(event, detail = {}) {
        const entry = { ts: Date.now(), event, ...detail };
        return serialize(async () => {
            await fsp.mkdir(path.dirname(file), { recursive: true });
            await fsp.appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8');
            await trimIfNeeded();
        }).catch(() => {});
    }

    /* Neueste zuerst. Eine kaputte einzelne Zeile wird uebersprungen statt
       die ganze Liste zu verwerfen — dieselbe Haltung wie ueberall sonst bei
       persistiertem JSON in diesem Projekt. */
    async function read({ limit = 200 } = {}) {
        let text;
        try {
            text = await fsp.readFile(file, 'utf8');
        } catch {
            return [];
        }
        const entries = [];
        for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            try {
                entries.push(JSON.parse(line));
            } catch {
                // Beschaedigte Zeile ueberspringen
            }
        }
        return entries.slice(-limit).reverse();
    }

    function flush() {
        return writeChain.catch(() => {});
    }

    return { file, log, read, flush };
}

module.exports = { createAuditLog };
