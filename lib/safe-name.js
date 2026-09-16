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

/*
 * Base64url-Credential-ID, wie sie ein Authenticator liefert und wir sie
 * speichern. Kommt bei DELETE /webauthn/credentials/:id als Pfadsegment aus
 * der Anfrage zurueck — validiert wird deshalb, was ankommt.
 */
function safeCredentialId(input) {
    const raw = String(input ?? '');
    if (raw.length === 0 || raw.length > 512) return null;
    return /^[A-Za-z0-9_-]+$/.test(raw) ? raw : null;
}

/*
 * Selbstvergebener Anzeigename eines Passkeys ("Windows Hello", "YubiKey
 * Buero"). Bewusst grosszuegiger als die Dateiname-Allowlist, aber weiterhin
 * ohne Kontrollzeichen.
 */
function safePasskeyLabel(input) {
    const raw = String(input ?? '').trim();
    if (raw.length === 0 || raw.length > 64) return null;
    return /^[\p{L}\p{N} .,'()_-]+$/u.test(raw) ? raw : null;
}

/*
 * Admin-Benutzername. Anders als safePasskeyLabel (freier Anzeigetext) ohne
 * Leerzeichen — ein Benutzername ist ein Identifier, kein Freitext.
 */
function safeUsername(input) {
    const raw = String(input ?? '').trim();
    if (raw.length === 0 || raw.length > 64) return null;
    return /^[\p{L}\p{N}_.@-]+$/u.test(raw) ? raw : null;
}

module.exports = {
    safeIsoName, safeUploadId, safeCredentialId, safePasskeyLabel, safeUsername,
};
