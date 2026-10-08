'use strict';

/*
 * Prueft die Deployment-Konfiguration beim Start, bevor der erste Request
 * angenommen wird. Im Produktivbetrieb (NODE_ENV=production) sind Fehler
 * fatal — createApp() wirft dann, der Prozess startet nicht. Das ist
 * Absicht: eine App, die scheinbar laeuft, aber Passwort-Reset-Links auf
 * http://localhost verschickt oder nie ein Session-Cookie setzt, faellt
 * erst dem ersten Kunden auf; ein Startabbruch mit klarer Meldung dagegen
 * sofort dem Betreiber.
 *
 * Ausserhalb von production werden dieselben Befunde nur als Warnungen
 * geloggt, damit lokales Entwickeln ohne Proxy/Mailserver weiter geht.
 *
 * Rein funktional (keine Seiteneffekte), damit es ohne App testbar ist.
 */

function parseUrl(value) {
    try {
        const url = new URL(String(value));
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        return url;
    } catch {
        return null;
    }
}

/*
 * Liefert { errors, warnings } — je eine Liste deutscher Klartextmeldungen.
 * `errors` bricht im Produktivbetrieb den Start ab, `warnings` nie.
 */
function checkConfig({
    isProd = false,
    publicUrl = null,
    mailEnabled = false,
    inboundEnabled = false,
    trustProxy = null,
    maxFileSizeMb = null,
    attachmentMaxMb = null,
    mailAttachmentMaxMb = null,
    imapAuthservId = null,
    metricsToken = null,
} = {}) {
    const errors = [];
    const warnings = [];
    // Im Produktivbetrieb fatal, sonst nur Hinweis
    const prodError = message => (isProd ? errors : warnings).push(message);

    if (publicUrl) {
        const url = parseUrl(publicUrl);
        if (!url) {
            errors.push(`PUBLIC_URL „${publicUrl}“ ist keine gültige http(s)-Adresse.`);
        } else {
            if (url.protocol !== 'https:') {
                prodError('PUBLIC_URL muss im Produktivbetrieb mit https:// beginnen — '
                    + 'sonst gehen Passwort-Reset- und Bestätigungslinks unverschlüsselt raus.');
            }
            if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
                prodError(`PUBLIC_URL zeigt auf ${url.hostname} — Links in Mails wären für Kunden nicht erreichbar.`);
            }
            if (url.search || url.hash) {
                errors.push('PUBLIC_URL darf weder Query-String noch Fragment enthalten.');
            }
        }
    } else if (mailEnabled) {
        prodError('PUBLIC_URL ist nicht gesetzt, SMTP aber aktiv — Links in Mails würden auf '
            + 'http://localhost zeigen. PUBLIC_URL auf die öffentliche https-Adresse setzen.');
    }

    if (inboundEnabled && !mailEnabled) {
        warnings.push('IMAP ist konfiguriert, SMTP aber nicht — eingehende Antworten werden '
            + 'verarbeitet, Kunden erhalten aber keine Mails.');
    }
    // Neue Tickets per Mail brauchen die authserv-id des eigenen Mailservers
    // (siehe lib/mail-auth.js) — ohne sie werden nur Antworten angenommen.
    if (inboundEnabled && !imapAuthservId) {
        warnings.push('IMAP_AUTHSERV_ID ist nicht gesetzt — Kunden können per E-Mail nur auf bestehende '
            + 'Tickets antworten, aber keine neuen eröffnen.');
    }
    if (imapAuthservId && !/^[a-z0-9.-]+$/i.test(String(imapAuthservId))) {
        errors.push('IMAP_AUTHSERV_ID muss ein Hostname sein (z. B. mx.gmx.net).');
    }

    /*
     * Node selbst terminiert kein TLS. Im Produktivbetrieb ist das Session-
     * Cookie `secure`, Express setzt es aber nur, wenn es die Verbindung als
     * https erkennt — und das geht hinter einem Reverse Proxy nur mit
     * `trust proxy`. Ohne TRUST_PROXY ist der Login daher stillschweigend
     * unmoeglich (Cookie wird nie gesetzt).
     */
    // TRUST_PROXY=0/false schaltet `trust proxy` genauso ab wie gar kein Wert
    const proxyTrusted = Boolean(trustProxy) && !/^(0|false)$/i.test(String(trustProxy).trim());
    if (isProd && !proxyTrusted) {
        errors.push('TRUST_PROXY ist nicht gesetzt (oder 0/false). Im Produktivbetrieb muss die App hinter einem '
            + 'TLS-terminierenden Reverse Proxy laufen (z. B. TRUST_PROXY=1 für einen Proxy davor), '
            + 'sonst wird das Session-Cookie nie gesetzt und kein Login funktioniert.');
    }

    if (isProd && !metricsToken) {
        warnings.push('METRICS_TOKEN ist nicht gesetzt — /metrics (freier Speicher, Mail-Fehler, '
            + 'Backup-Alter) ist öffentlich abrufbar.');
    }

    if (maxFileSizeMb !== null && !(Number.isFinite(maxFileSizeMb) && maxFileSizeMb > 0)) {
        errors.push('MAX_FILE_SIZE_MB muss eine positive Zahl sein.');
    }
    if (attachmentMaxMb !== null && !(Number.isFinite(attachmentMaxMb) && attachmentMaxMb > 0)) {
        errors.push('TICKET_ATTACHMENT_MAX_MB muss eine positive Zahl sein.');
    }
    if (mailAttachmentMaxMb !== null && !(Number.isFinite(mailAttachmentMaxMb) && mailAttachmentMaxMb >= 0)) {
        errors.push('MAIL_ATTACHMENT_MAX_MB muss 0 (keine Anhänge in Mails) oder eine positive Zahl sein.');
    }

    return { errors, warnings };
}

/* Wirft mit allen Fehlern auf einmal — nicht nur dem ersten, damit der
   Betreiber nicht Neustart fuer Neustart einzeln nachbessern muss. */
function assertConfig(options, log = console) {
    const { errors, warnings } = checkConfig(options);
    for (const warning of warnings) log.warn(`⚠️  ${warning}`);
    if (errors.length > 0) {
        const err = new Error(
            'Ungültige Konfiguration:\n' + errors.map(message => `  - ${message}`).join('\n')
        );
        err.code = 'invalid_config';
        err.configErrors = errors;
        throw err;
    }
    return { warnings };
}

module.exports = { checkConfig, assertConfig };
