'use strict';

/*
 * Kleine, von lib/routes/account.js, tickets-customer.js und tickets-admin.js
 * gemeinsam genutzte Helfer: Multipart-Anhaenge ohne Absturz bei zu grossen
 * Dateien, Formular-Feldlaengen, View-Helfer fuer Zeitangaben und das
 * sichere Rendern von Nachrichtentext.
 */

const MAX_SUBJECT_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 10000;
const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 200;

/*
 * multer wirft bei zu grossen/zu vielen Dateien einen Fehler, der sonst im
 * generischen 500er-Handler landen wuerde. Hier wird er zu
 * req.attachmentError (Klartext fuer das Formular), die Route entscheidet
 * dann selbst, wie sie ihn anzeigt.
 */
function attachmentsMiddleware(upload, { field = 'attachments', maxFiles, maxBytes, hasSpaceFor = null }) {
    const handler = upload.array(field, maxFiles);
    return async (req, res, next) => {
        // Vor multer: passt der angekuendigte Body nicht mehr auf das Volume
        // (Reserve MIN_FREE_DISK_MB), gar nicht erst in tmp-uploads/
        // schreiben. Der Body bleibt ungelesen, die Route zeigt die Meldung.
        const length = Number(req.get('content-length'));
        if (hasSpaceFor && Number.isFinite(length) && length > 0) {
            let fits = true;
            try {
                fits = await hasSpaceFor(length);
            } catch {
                // statfs-Fehler blockieren nicht — commit() prueft erneut
            }
            if (!fits) {
                req.attachmentError = 'Auf dem Server ist gerade nicht genug Speicherplatz frei. Bitte später erneut versuchen.';
                req.body = {};
                req.files = [];
                return next();
            }
        }
        handler(req, res, err => {
            if (!err) return next();
            const messages = {
                LIMIT_FILE_SIZE: `Eine Datei ist zu groß (max. ${Math.round(maxBytes / 1024 / 1024)} MB).`,
                LIMIT_FILE_COUNT: `Höchstens ${maxFiles} Anhänge pro Nachricht.`,
                LIMIT_UNEXPECTED_FILE: `Höchstens ${maxFiles} Anhänge pro Nachricht.`,
            };
            if (err.code && messages[err.code]) {
                req.attachmentError = messages[err.code];
                req.body = req.body || {};
                req.files = [];
                return next();
            }
            next(err);
        });
    };
}

function textField(value, maxLength) {
    return String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, maxLength);
}

/* Einzeiliges Feld (Betreff): Zeilenumbrueche und andere Steuerzeichen
   werden zu Leerzeichen. Ein <input> schickt zwar nie einen Umbruch, ein
   handgebauter Request aber schon — und der Betreff landet in Mail-
   Headern, Seitentiteln und Listen. */
function lineField(value, maxLength) {
    // eslint-disable-next-line no-control-regex
    return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/ {2,}/g, ' ').trim()
        .slice(0, maxLength);
}

/* Content-Disposition mit RFC-5987-Dateinamen fuer Browser plus ASCII-
   Fallback. encodeURIComponent allein laesst ' ( ) * stehen — ein
   Apostroph im Dateinamen ("it's.png") ergaebe sonst einen kaputten
   filename*-Parameter. */
function contentDisposition(type, filename) {
    const name = String(filename ?? '');
    const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
    const encoded = encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function checkPasswordStrength(password, { email, name } = {}) {
    const value = String(password ?? '');
    if (value.length < MIN_PASSWORD_LENGTH) {
        return `Das Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen lang sein.`;
    }
    if (value.length > MAX_PASSWORD_LENGTH) return 'Das Passwort ist zu lang.';
    const lower = value.toLowerCase();
    if ((email && lower === String(email).toLowerCase()) || (name && lower === String(name).toLowerCase())) {
        return 'Das Passwort darf nicht deiner E-Mail-Adresse oder deinem Namen entsprechen.';
    }
    return null;
}

/* Nur relative Ziele innerhalb der App — verhindert einen offenen Redirect
   ueber ?next=https://evil.example nach dem Login. */
function safeNextPath(value, fallback) {
    const raw = String(value ?? '');
    return /^\/(?![/\\])[\w\-./?=&%#]*$/.test(raw) ? raw : fallback;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/*
 * Nachrichtentext fuer die Anzeige: erst komplett escapen, dann im bereits
 * escapten Text http(s)-URLs verlinken (rel=noopener, neuer Tab). Da das
 * Linkify auf escaptem Text arbeitet und nur [^\s<]+ als URL erkennt, kann
 * dabei kein Markup entstehen. Zeilenumbrueche bleiben ueber CSS
 * (white-space: pre-wrap) erhalten.
 */
function formatMessage(body) {
    // URLs im Rohtext suchen (nicht im escapten — dort wuerden &quot;/&gt;
    // eines umschliessenden "…" oder <…> mit in den Link rutschen), dann
    // Text und URL getrennt escapen. Anfuehrungszeichen und spitze Klammern
    // beenden eine URL.
    const text = String(body ?? '');
    const pattern = /\bhttps?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)\]]/g;
    let html = '';
    let last = 0;
    for (const match of text.matchAll(pattern)) {
        let raw = match[0];
        // Eine schliessende Klammer, die in der URL geoeffnet wurde, gehoert
        // dazu (Wikipedia: ".../ISO_9660_(Dateisystem)") — das Muster oben
        // schneidet sie ab, sie steht dann direkt dahinter.
        const after = text[match.index + raw.length];
        if (after === ')' && raw.split('(').length > raw.split(')').length) raw += ')';
        const url = escapeHtml(raw);
        html += escapeHtml(text.slice(last, match.index));
        html += `<a href="${url}" target="_blank" rel="noopener noreferrer nofollow">${url}</a>`;
        last = match.index + raw.length;
    }
    return html + escapeHtml(text.slice(last));
}

const rtf = new Intl.RelativeTimeFormat('de-DE', { numeric: 'auto', style: 'short' });

function relativeTime(timestamp, now = Date.now()) {
    if (!timestamp) return '—';
    const diff = timestamp - now;
    const abs = Math.abs(diff);
    const units = [
        ['year', 365 * 24 * 3600e3], ['month', 30 * 24 * 3600e3], ['week', 7 * 24 * 3600e3],
        ['day', 24 * 3600e3], ['hour', 3600e3], ['minute', 60e3],
    ];
    // Abrunden statt runden: sonst hiesse es bei 59,5 Minuten "vor 60 Min."
    // statt "vor 59 Min." (bzw. "vor 24 Std.", "vor 7 Tagen" …).
    for (const [unit, ms] of units) {
        if (abs >= ms) return rtf.format(Math.trunc(diff / ms), unit);
    }
    return 'gerade eben';
}

function formatDuration(ms) {
    if (ms == null || !Number.isFinite(ms)) return '—';
    const minutes = Math.round(ms / 60e3);
    if (minutes < 60) return `${Math.max(1, minutes)} Min.`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours} Std. ${minutes % 60 ? `${minutes % 60} Min.` : ''}`.trim();
    return `${Math.round(hours / 24)} Tage`;
}

function initials(name) {
    const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

/*
 * Anzeige der Antwortfrist (SLA) eines Tickets fuer Posteingang und
 * Ticket-Kopf: null ohne Frist, sonst { state, label, dueAt } mit state
 * 'ok' | 'warn' (ab 80 % der Frist verbraucht) | 'overdue'. slaDueAt und
 * slaMinutes berechnet lib/ticket-store.js (SLA_DUE_SQL).
 */
function slaState(ticket, now = Date.now()) {
    if (!ticket?.slaDueAt || !ticket.slaMinutes) return null;
    const remaining = ticket.slaDueAt - now;
    if (remaining < 0) {
        return { state: 'overdue', label: `überfällig seit ${formatDuration(-remaining)}`, dueAt: ticket.slaDueAt };
    }
    const total = ticket.slaMinutes * 60e3;
    return {
        state: remaining <= total * 0.2 ? 'warn' : 'ok',
        label: `fällig in ${formatDuration(remaining)}`,
        dueAt: ticket.slaDueAt,
    };
}

function wantsJson(req) {
    return req.accepts(['html', 'json']) === 'json';
}

module.exports = {
    slaState,
    MAX_SUBJECT_LENGTH, MAX_MESSAGE_LENGTH, MIN_PASSWORD_LENGTH,
    attachmentsMiddleware, textField, lineField, contentDisposition, checkPasswordStrength, safeNextPath, escapeHtml, formatMessage,
    relativeTime, formatDuration, initials, wantsJson,
};
