'use strict';

/*
 * Anzeige-Zeitzone der App (APP_TIMEZONE, Default Europe/Berlin).
 *
 * Gespeichert wird ueberall weiter UTC (Millisekunden seit 1970) — eindeutig,
 * auch ueber die Zeitumstellung hinweg, und Fristen bleiben simple
 * Subtraktionen. Diese Datei ist die EINZIGE Stelle, die aus einem
 * Zeitstempel eine Wanduhrzeit macht (und zurueck): Views, Logs, ZIP-
 * Zeitstempel und die Browser-Skripte (ueber <meta name="app-time-zone">)
 * haengen damit weder von der Zeitzone des Servers (im Container UTC) noch
 * von der des Browsers ab. Maschinenlesbare Ausgaben (API, Exporte,
 * Dateinamen, JSON-Logs) bleiben bewusst ISO-8601 in UTC.
 *
 * Node bringt die Zeitzonendaten ueber ICU selbst mit — kein tzdata-Paket
 * im Image noetig.
 */

const DEFAULT_TIME_ZONE = 'Europe/Berlin';
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

function toDate(value) {
    if (value instanceof Date) return value;
    return new Date(typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value);
}

function pad(n, width = 2) {
    return String(n).padStart(width, '0');
}

/*
 * Liefert die Formatierer fuer eine Zeitzone. Wirft mit
 * code 'invalid_config' bei einem unbekannten Zeitzonennamen — lieber gar
 * nicht starten als stillschweigend falsche Uhrzeiten anzeigen.
 */
function createClock(timeZone = DEFAULT_TIME_ZONE) {
    let partsFormat;
    try {
        partsFormat = new Intl.DateTimeFormat('en-US', {
            timeZone, hourCycle: 'h23',
            year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
        });
    } catch {
        const err = new Error(`APP_TIMEZONE „${timeZone}“ ist keine gültige Zeitzone (z. B. Europe/Berlin).`);
        err.code = 'invalid_config';
        throw err;
    }
    const zone = partsFormat.resolvedOptions().timeZone;

    const dateFormat = new Intl.DateTimeFormat('de-DE', { timeZone: zone, day: '2-digit', month: 'short', year: 'numeric' });
    const dateTimeFormat = new Intl.DateTimeFormat('de-DE', {
        timeZone: zone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    const timeFormat = new Intl.DateTimeFormat('de-DE', { timeZone: zone, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const shortTimeFormat = new Intl.DateTimeFormat('de-DE', { timeZone: zone, hour: '2-digit', minute: '2-digit' });
    const zoneNameFormat = new Intl.DateTimeFormat('de-DE', { timeZone: zone, timeZoneName: 'short' });

    /* Wanduhr-Bestandteile in der Zeitzone */
    function parts(value) {
        const out = {};
        for (const part of partsFormat.formatToParts(toDate(value))) {
            if (part.type !== 'literal') out[part.type] = Number(part.value);
        }
        return {
            year: out.year, month: out.month, day: out.day,
            hour: out.hour === 24 ? 0 : out.hour, minute: out.minute, second: out.second,
        };
    }

    /* Versatz der Zeitzone gegenueber UTC zum Zeitpunkt ts (ms, z. B. +2 h) */
    function offsetAt(ts) {
        const p = parts(ts);
        const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
        return wall - Math.floor(ts / 1000) * 1000;
    }

    /*
     * Wanduhrzeit (als "UTC-Zahl" kodiert, d. h. Date.UTC(...) der lokalen
     * Felder) -> echter Zeitpunkt. Mehrdeutig (Oktober, 02:00–03:00 gibt es
     * zweimal): der fruehere. Nicht existent (Maerz, 02:00–03:00 fehlt): um
     * die Luecke nach vorn verschoben, 02:30 -> 03:30 Sommerzeit.
     */
    function wallToUtc(wall) {
        const offsets = [...new Set([offsetAt(wall - 12 * HOUR_MS), offsetAt(wall + 12 * HOUR_MS)])];
        const matches = offsets
            .map(offset => wall - offset)
            .filter(candidate => candidate + offsetAt(candidate) === wall)
            .sort((a, b) => a - b);
        if (matches.length > 0) return matches[0];
        return wall - Math.min(...offsets);
    }

    /* 'YYYY-MM-DDTHH:MM' (datetime-local) als Wanduhrzeit der Zeitzone -> ms */
    function parseLocal(value) {
        const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(value ?? ''));
        if (!match) return null;
        const [, y, mo, d, h, mi] = match.map(Number);
        if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
        const wall = Date.UTC(y, mo - 1, d, h, mi);
        if (!Number.isFinite(wall) || new Date(wall).getUTCDate() !== d) return null;
        return wallToUtc(wall);
    }

    /* ms -> 'YYYY-MM-DDTHH:MM' fuer <input type="datetime-local"> */
    function toLocalInput(ts) {
        if (!ts) return '';
        const p = parts(ts);
        return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
    }

    /*
     * Beginn des Abschnitts, in den ts faellt — ausgerichtet an der
     * Wanduhr (Tagesbalken beginnen um Mitternacht Ortszeit, 6-h-Balken um
     * 0/6/12/18 Uhr), auch ueber die Zeitumstellung hinweg.
     */
    function floorLocal(ts, bucketMs) {
        if (bucketMs < HOUR_MS) return Math.floor(ts / bucketMs) * bucketMs;
        const wall = ts + offsetAt(ts);
        const floored = Math.floor(wall / bucketMs) * bucketMs;
        // Doppelte Stunde im Oktober: der spaetere Zeitpunkt, der noch <= ts
        // liegt — sonst landet 02:30 MEZ im Abschnitt ab 02:00 MESZ, und eine
        // Balkenfolge (floor(t + 1,5 Abschnitte)) kaeme nie ueber 02:00 hinaus
        const candidates = [...new Set([offsetAt(floored - 12 * HOUR_MS), offsetAt(floored + 12 * HOUR_MS)])]
            .map(offset => floored - offset)
            .filter(candidate => candidate <= ts && candidate + offsetAt(candidate) === floored);
        return candidates.length > 0 ? Math.max(...candidates) : wallToUtc(floored);
    }

    function zoneName(value) {
        return zoneNameFormat.formatToParts(toDate(value)).find(part => part.type === 'timeZoneName')?.value ?? zone;
    }

    function valid(value) {
        return value !== null && value !== undefined && value !== '' && Number.isFinite(toDate(value).getTime());
    }

    return {
        timeZone: zone,
        parts,
        offsetAt,
        parseLocal,
        toLocalInput,
        floorLocal,
        zoneName,
        /* 23. Sept. 2026 */
        formatDate: value => (valid(value) ? dateFormat.format(toDate(value)) : '—'),
        /* 23.09.2026, 14:03 */
        formatDateTime: value => (valid(value) ? dateTimeFormat.format(toDate(value)) : '—'),
        /* 14:03:05 */
        formatTime: value => (valid(value) ? timeFormat.format(toDate(value)) : '—'),
        /* 14:03 */
        formatTimeShort: value => (valid(value) ? shortTimeFormat.format(toDate(value)) : '—'),
        /* 2026-09-23 14:03:05 — sortierbar, fuer Tabellen mit vielen Zeilen (Logs) */
        formatStamp(value) {
            if (!valid(value)) return '—';
            const p = parts(value);
            return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
        },
        /* 2026-09-23T14:03:05.123+02:00 — ISO 8601 mit Versatz, eindeutig und lesbar (Exporte) */
        formatIsoLocal(value) {
            if (!valid(value)) return '';
            const ts = toDate(value).getTime();
            const p = parts(ts);
            const offset = offsetAt(ts) / MINUTE_MS;
            const sign = offset < 0 ? '-' : '+';
            const abs = Math.abs(offset);
            return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`
                + `.${pad(ts % 1000 < 0 ? 0 : ts % 1000, 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
        },
    };
}

module.exports = { createClock, DEFAULT_TIME_ZONE };
