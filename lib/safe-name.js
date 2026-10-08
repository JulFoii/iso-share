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

/*
 * Ein Tag/eine Kategorie fuer die Dateiliste. Derselbe Zeichensatz wie
 * safePasskeyLabel (freier, aber kontrollzeichenfreier Anzeigetext), nur
 * kuerzer begrenzt — Tags werden als Badge/Chip angezeigt, nicht als Text.
 * Mehrfache Leerzeichen werden zu einem zusammengefasst, damit "  x   y  "
 * und "x y" als derselbe Tag gelten (Vergleich passiert ohnehin
 * case-insensitiv, siehe server.js).
 */
function safeTag(input) {
    const raw = String(input ?? '').trim().replace(/\s+/g, ' ');
    if (raw.length === 0 || raw.length > 32) return null;
    return /^[\p{L}\p{N} .,'()_-]+$/u.test(raw) ? raw : null;
}

/*
 * Selbstvergebener Anzeigename eines API-Tokens ("CI-Pipeline", "Backup-
 * Skript"). Gleicher Zeichensatz/gleiche Laenge wie safePasskeyLabel, aber
 * eigene Funktion — ein Token-Label ist konzeptionell ein anderes Ding als
 * ein Passkey-Label, auch wenn die Validierung identisch ist.
 */
function safeApiTokenLabel(input) {
    const raw = String(input ?? '').trim();
    if (raw.length === 0 || raw.length > 64) return null;
    return /^[\p{L}\p{N} .,'()_-]+$/u.test(raw) ? raw : null;
}

/*
 * ID eines API-Tokens (crypto.randomUUID(), wie die Upload-Session-ID).
 * Kommt bei DELETE /admin/api-tokens/:id als Pfadsegment aus der Anfrage
 * zurueck — eigener Name statt Wiederverwendung von safeUploadId, damit ein
 * Aufrufer nicht versehentlich eine Upload-Session-ID als Token-ID (oder
 * umgekehrt) durchwinkt, obwohl das Format zufaellig identisch ist.
 */
function safeApiTokenId(input) {
    const raw = String(input ?? '');
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(raw)
        ? raw
        : null;
}

/*
 * Dateiname einer DB-Sicherung (lib/backup-store.js). Anders als
 * safeIsoName keine Allowlist fuer Freitext, sondern ein festes,
 * ausschliesslich serverseitig erzeugtes Format (Zeitstempel) — kein
 * Backup-Dateiname stammt je aus einer Nutzereingabe. Schuetzt trotzdem den
 * :filename-Pfadparameter auf den Backup-Routen, aus demselben Grund wie
 * safeUploadId: validiert wird, was als Anfrage ankommt, nicht was die App
 * selbst vergeben hat.
 */
function safeBackupName(input) {
    const raw = String(input ?? '');
    return /^(pre-restore-)?iso-share-\d{8}T\d{6}Z-[0-9a-f]{6}\.db$/.test(raw) ? raw : null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/*
 * Interne IDs (crypto.randomUUID()) von Tickets, Kundenkonten und
 * Ticket-Anhaengen — kommen als Pfadsegment bzw. Formularfeld aus der
 * Anfrage zurueck. Eigene Namen statt Wiederverwendung von safeUploadId,
 * aus demselben Grund wie bei safeApiTokenId.
 */
function safeUuid(input) {
    const raw = String(input ?? '').toLowerCase();
    return UUID_PATTERN.test(raw) ? raw : null;
}

const safeTicketId = safeUuid;
const safeCustomerId = safeUuid;
const safeAttachmentId = safeUuid;

/*
 * Oeffentliche, fortlaufende Ticketnummer (#1001, #1002 …) aus der URL
 * (/account/tickets/:number, /admin/tickets/:number). Ein "#" davor wird
 * toleriert, damit eine aus einer Mail kopierte Nummer auch in der Suche
 * funktioniert.
 */
function safeTicketNumber(input) {
    const match = /^#?(\d{1,9})$/.exec(String(input ?? '').trim());
    if (!match) return null;
    const n = Number(match[1]);
    return n > 0 ? n : null;
}

/* Enum-Checks gegen die Listen in lib/ticket-store.js. */
function safeTicketStatus(input) {
    const raw = String(input ?? '');
    return ['new', 'open', 'pending', 'resolved', 'closed'].includes(raw) ? raw : null;
}

function safeTicketPriority(input) {
    const raw = String(input ?? '');
    return ['low', 'normal', 'high', 'urgent'].includes(raw) ? raw : null;
}

/*
 * Einmal-Token aus Bestaetigungs-/Reset-Mails (lib/customer-store.js:
 * TOKEN_PREFIX + 32 Zufallsbytes base64url = 43 Zeichen nach dem Praefix).
 */
function safeCustomerToken(input) {
    const raw = String(input ?? '');
    return /^ctk_[A-Za-z0-9_-]{43}$/.test(raw) ? raw : null;
}

/* Anzeigename eines Kundenkontos: 1–80 Zeichen ohne Steuerzeichen. */
function safeDisplayName(input) {
    // eslint-disable-next-line no-control-regex
    const raw = String(input ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
    return raw.length >= 1 && raw.length <= 80 ? raw : null;
}

/*
 * Keine vollstaendige RFC-5322-Validierung, aber bewusst nur eine *nackte*
 * Adresse: ohne Anzeigenamen, spitze Klammern, Kommas, Anfuehrungszeichen
 * oder Kommentare. Die Adresse geht als Empfaenger an nodemailer — der
 * parst "x<opfer@example.com>" oder "a@b.de,c@d.de" als Adressliste, eine
 * lockere Pruefung liesse also ein Konto unter einer Adresse anlegen, deren
 * Bestaetigungsmail an ein ganz anderes Postfach geht. Umlaute in Local-Part
 * und Domain (IDN) bleiben erlaubt; ob das Postfach wirklich existiert,
 * zeigt ohnehin erst der Mailversand (siehe lib/mail-outbox.js).
 */
const EMAIL_PATTERN = /^[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+[\p{L}\p{N}]{2,63}$/u;

function safeEmail(input) {
    const raw = String(input ?? '').trim();
    if (raw.length === 0 || raw.length > 254) return null;
    return EMAIL_PATTERN.test(raw) ? raw : null;
}

/* Slug eines Wissensdatenbank-Artikels (lib/kb-store.js slugify()). */
function safeKbSlug(input) {
    const raw = String(input ?? '');
    return raw.length <= 80 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw) ? raw : null;
}

module.exports = {
    safeKbSlug,
    safeIsoName, safeUploadId, safeCredentialId, safePasskeyLabel, safeUsername, safeTag,
    safeApiTokenId, safeApiTokenLabel, safeBackupName,
    safeTicketId, safeCustomerId, safeAttachmentId, safeTicketNumber, safeTicketStatus,
    safeTicketPriority, safeCustomerToken, safeDisplayName, safeEmail,
};
