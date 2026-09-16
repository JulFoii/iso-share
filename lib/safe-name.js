'use strict';

/*
 * Genau ein Dateiname-Segment, nur erlaubte Zeichen, muss auf .iso enden.
 * Zentrale Stelle fuer Upload, Delete und Download — jede Route, die einen
 * Namen aus einer Anfrage nimmt, schickt ihn zuerst hier durch.
 */
function safeIsoName(input) {
    const raw = String(input ?? '');
    // Laenge zuerst kappen: begrenzt den Backtracking-Aufwand des Regex und
    // deckt das uebliche Dateisystem-Limit ab (betrifft auch das
    // unauthentifizierte /download).
    if (raw.length === 0 || raw.length > 255) return null;
    if (raw.includes('\0')) return null;
    const base = require('path').basename(raw);
    if (base !== raw) return null;                 // enthielt Pfadanteile
    if (!/^[\w.\- ()]+\.iso$/i.test(base)) return null;
    return base;
}

/*
 * Dieselbe Haerte fuer die IDs der Upload-Sessions. Die IDs stammen aus
 * randomUUID(), aber sie kommen als Pfadsegment aus der Anfrage zurueck —
 * validiert wird deshalb, was ankommt, nicht was wir vergeben haben.
 */
function safeUploadId(input) {
    const raw = String(input ?? '');
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(raw)
        ? raw
        : null;
}

module.exports = { safeIsoName, safeUploadId };
