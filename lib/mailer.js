'use strict';

/*
 * Duenner Wrapper um nodemailer (SMTP) — der eigentliche Versand laeuft
 * immer ueber die Warteschlange in lib/mail-outbox.js, nie direkt aus einem
 * Request-Handler. nodemailer ist eine bewusste Ausnahme von der kurz
 * gehaltenen Abhaengigkeitsliste des Projekts (neben @simplewebauthn/server
 * und imapflow): SMTP korrekt von Hand zu implementieren waere genauso wenig
 * sinnvoll wie WebAuthn-Krypto von Hand.
 *
 * Anders als frueher wirft send() bei einem Fehler: die Outbox braucht die
 * Fehlermeldung fuer Wiederholungsversuche und die Anzeige im Admin-Bereich.
 * "Best effort" gegenueber der eigentlichen Aktion (Ticket anlegen,
 * antworten) bleibt trotzdem gewahrt, weil der Handler nur in die Outbox
 * schreibt und nie auf den Versand wartet.
 *
 * Ohne SMTP_HOST (und ohne injizierten Transport, siehe Tests) bleibt der
 * Mailversand deaktiviert: enabled=false, die Outbox legt dann gar nichts an.
 * Das Ticketsystem funktioniert weiter; neue Kundenkonten kann der Admin in
 * dem Fall unter /admin/customers von Hand bestaetigen.
 */

function createMailer({ host, port, secure, user, pass, from, transport, log = console } = {}) {
    const fromAddress = from || user || 'iso-share@localhost';
    const domain = (/@([^>\s]+)>?\s*$/.exec(fromAddress)?.[1] || 'localhost').toLowerCase();

    if (!host && !transport) {
        log.warn?.(
            '⚠️  Mailversand deaktiviert — SMTP_HOST nicht gesetzt. Benachrichtigungen und\n' +
            '    Bestätigungsmails entfallen; neue Kundenkonten lassen sich unter\n' +
            '    /admin/customers von Hand bestätigen.\n'
        );
        return {
            enabled: false,
            security: null,
            from: fromAddress,
            domain,
            async send() {
                throw new Error('Mailversand ist nicht konfiguriert (SMTP_HOST fehlt).');
            },
            async verify() {
                return { ok: false, error: 'SMTP_HOST ist nicht gesetzt.' };
            },
        };
    }

    /*
     * Verschluesselung: secure=true ist SMTPS (TLS ab dem ersten Byte, Port
     * 465, empfohlen). Ohne secure wird STARTTLS benutzt — aber mit
     * requireTLS, also niemals ein Rueckfall auf eine unverschluesselte
     * Verbindung, falls der Server STARTTLS nicht anbietet (oder ein
     * Angreifer es aus der Antwort streicht). In beiden Faellen mindestens
     * TLS 1.2 und eine gueltige Zertifikatskette.
     */
    const isSmtps = Boolean(secure);
    const effectivePort = port || (isSmtps ? 465 : 587);
    const security = isSmtps ? `SMTPS (TLS, Port ${effectivePort})` : `STARTTLS erzwungen (Port ${effectivePort})`;

    // Lazy require: nodemailer wird nur beruehrt, wenn tatsaechlich SMTP
    // konfiguriert ist.
    const smtp = transport || require('nodemailer').createTransport({
        host,
        port: effectivePort,
        secure: isSmtps,
        requireTLS: !isSmtps,
        tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true, servername: host },
        auth: user ? { user, pass } : undefined,
    });

    /* attachments: [{ filename, path, contentType }] (nodemailer-Format). */
    async function send({ to, subject, text, html, headers = {}, attachments = [] }) {
        const { messageId, inReplyTo, references, replyTo, ...extra } = headers;
        return smtp.sendMail({
            from: fromAddress,
            to,
            subject,
            text,
            html: html || undefined,
            messageId,
            inReplyTo,
            references,
            replyTo,
            headers: extra,
            attachments: attachments.length ? attachments : undefined,
        });
    }

    async function verify() {
        if (typeof smtp.verify !== 'function') return { ok: true };
        try {
            await smtp.verify();
            return { ok: true };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    }

    return { enabled: true, security, from: fromAddress, domain, send, verify };
}

module.exports = { createMailer };
