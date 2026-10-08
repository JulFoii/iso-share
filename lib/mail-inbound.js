'use strict';

/*
 * Verarbeitet eine eingehende Mail ans Support-Postfach — unabhaengig davon,
 * woher sie kommt. Der IMAP-Abruf selbst (lib/imap-poller.js) liefert nur ein
 * bereits zerlegtes Objekt {from, subject, messageId, dedupKey, inReplyTo,
 * references, text, html, attachments, attachmentCount, autoSubmitted,
 * suppressAutoResponse, authResults}; so bleibt die ganze Zuordnungs- und
 * Sicherheitslogik hier ohne Mailserver testbar.
 *
 * Antwort auf ein bestehendes Ticket — nur wenn ALLE Bedingungen gelten:
 *   1. keine automatische Antwort (Abwesenheitsnotiz, Bounce …) — sonst
 *      koennten sich zwei Autoresponder endlos gegenseitig beantworten
 *   2. In-Reply-To/References enthaelt eine gueltig signierte Ticket-ID
 *      (siehe ticketIdFromReferences() in lib/ticket-mail.js) — der Betreff
 *      allein ("[#1042]") zaehlt bewusst nicht, der ist trivial faelschbar.
 *      Wurde das Ticket inzwischen zusammengefuehrt, landet die Antwort im
 *      Ziel-Ticket (merged_into_id).
 *   3. der Absender ist genau die E-Mail-Adresse des Ticket-Kontos, und das
 *      Konto ist nicht gesperrt
 *   4. mit authservId (IMAP_AUTHSERV_ID): DKIM/DMARC fuer die Absenderdomain
 *      bestaetigt, wie bei neuen Tickets. Die signierte Referenz allein kennt
 *      jeder, der eine Ticket-Mail weitergeleitet oder in CC bekommen hat —
 *      mit gefaelschtem From koennte er sonst im Namen des Kunden antworten
 *   5. das Ticket ist nicht geschlossen (sonst bekommt der Kunde eine kurze
 *      Mail mit dem Hinweis, ein neues Ticket anzulegen — hoechstens einmal
 *      je Ticket und CLOSED_NOTICE_WINDOW_MS, und nie auf eine Mail, die
 *      ausdruecklich keine Auto-Antwort will: sonst Schleife mit
 *      Autorespondern, die kein Auto-Submitted setzen)
 *
 * Neues Ticket (keine signierte Referenz) — nur wenn authservId gesetzt ist
 * (IMAP_AUTHSERV_ID) und:
 *   1. keine automatische Antwort
 *   2. der Absender hat ein verifiziertes, nicht gesperrtes Konto
 *   3. der Authentication-Results-Header des eigenen Mailservers bestaetigt
 *      DKIM/DMARC fuer die Absenderdomain (lib/mail-auth.js) — sonst koennte
 *      jeder mit gefaelschtem Absender Tickets im Namen eines Kunden anlegen
 *   4. hoechstens NEW_TICKET_LIMIT neue Tickets je Konto und Stunde
 *      (Schutz vor Mail-Schleifen)
 *
 * Alles andere wird still verworfen (nur Audit-Log) — eine automatische
 * Antwort auf unbekannte Absender waere eine Backscatter-/Spam-Quelle.
 *
 * Jede Mail wird hoechstens einmal verarbeitet (inboundStore.claim() auf
 * Absender + Message-ID, siehe lib/inbound-mail-store.js) — auch wenn der
 * Poller sie nach einem Absturz noch einmal liefert. Anhaenge landen mit der
 * Nachricht in einer Transaktion (lib/attachment-store.js commit()); passen
 * sie nicht (Speicher voll), kommt die Nachricht ohne sie und mit Hinweis an.
 */

const { stripQuotedReply } = require('./mail-templates');
const { normalizeEmail } = require('./customer-store');
const { authenticatedSender } = require('./mail-auth');

const MAX_BODY_LENGTH = 10000;
const MAX_SUBJECT_LENGTH = 150;
const NEW_TICKET_LIMIT = 5;
const NEW_TICKET_WINDOW_MS = 60 * 60 * 1000;
const CLOSED_NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000;

const NAMED_ENTITIES = { nbsp: ' ', lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };

/* Benannte (die ueblichen) und numerische Entities, dezimal wie hex. Ein
   einziger Durchlauf, damit "&amp;lt;" als "&lt;" stehen bleibt. */
function decodeEntities(text) {
    return String(text ?? '').replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]+);/gi, (match, name) => {
        if (name[0] === '#') {
            const hex = name[1] === 'x' || name[1] === 'X';
            const code = hex ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
            // Ungueltige Codepoints und Surrogates bleiben stehen
            if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
                return match;
            }
            return String.fromCodePoint(code);
        }
        return NAMED_ENTITIES[name.toLowerCase()] ?? match;
    });
}

/* Sehr einfache HTML->Text-Wandlung fuer Mails ohne text/plain-Teil. Der
   zitierte Verlauf (blockquote, Gmail/Outlook-Container) wird vorher
   abgeschnitten. */
function htmlToText(html) {
    let source = String(html ?? '');
    const quoteStart = source.search(/<blockquote|class="gmail_quote"|id="divRplyFwdMsg"|id="appendonsend"/i);
    if (quoteStart >= 0) source = source.slice(0, quoteStart);
    const text = source
        .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
        .replace(/<[^>]+>/g, '');
    return decodeEntities(text)
        .replace(/ /g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/* Betreff einer neuen Mail als Ticket-Betreff: ohne Re:/AW:/Fwd:/WG:-
   Praefixe (auch mehrfach), Leerraum zusammengefasst, gekuerzt. */
function ticketSubject(subject) {
    let value = String(subject ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    while (/^(re|aw|fw|fwd|wg|antw)\s*(\[\d+\])?\s*:\s*/i.test(value)) {
        value = value.replace(/^(re|aw|fw|fwd|wg|antw)\s*(\[\d+\])?\s*:\s*/i, '');
    }
    value = value.trim().slice(0, MAX_SUBJECT_LENGTH);
    return value || '(ohne Betreff)';
}

function createInboundProcessor({
    ticketStore, customerStore, attachmentStore, ticketMail, auditLog, log = console, authservId = null,
    inboundStore = null, now = () => Date.now(),
}) {
    // Zaehler je Ergebnis fuer /metrics (iso_share_mail_inbound_total)
    const counters = new Map();
    function count(result) {
        counters.set(result, (counters.get(result) ?? 0) + 1);
    }

    function reject(reason, detail = {}) {
        count(reason);
        auditLog?.log('mail_inbound_rejected', { reason, ...detail });
        return { result: reason };
    }

    function withNote(body, notes) {
        return notes.length ? `${body}\n\n[Nicht übernommen: ${notes.join(' ')}]`.trim() : body;
    }

    /* Text + Anhaenge wie im Portal aufbereiten. Ungueltige Anhaenge werden
       einzeln uebersprungen statt die ganze Mail zu verwerfen — der Kunde
       sieht im Ticket, was nicht ankam. Der Poller liefert schon hoechstens
       maxFiles Teile (zu grosse nur als {tooLarge: true}, ohne Inhalt) und
       nennt die Gesamtzahl in attachmentCount. */
    function prepareContent(mail) {
        const rawText = mail.text ? String(mail.text) : htmlToText(mail.html);
        const body = stripQuotedReply(rawText).slice(0, MAX_BODY_LENGTH);
        const accepted = [];
        const skipped = [];
        const parts = mail.attachments || [];
        const total = Math.max(Number(mail.attachmentCount) || 0, parts.length);
        const maxMb = Math.round(attachmentStore.maxBytes / 1024 / 1024);
        for (const part of parts.slice(0, attachmentStore.maxFiles)) {
            if (part.tooLarge || !part.content) {
                skipped.push(`„${part.filename || 'anhang'}“ ist zu groß (max. ${maxMb} MB).`);
                continue;
            }
            try {
                accepted.push(...attachmentStore.inspectBuffers([part]));
            } catch (err) {
                skipped.push(err.message);
            }
        }
        if (total > attachmentStore.maxFiles) {
            skipped.push(`Nur die ersten ${attachmentStore.maxFiles} Anhänge wurden übernommen.`);
        }
        return { body, accepted, skipped };
    }

    /* Nachricht samt Anhaengen atomar anlegen; write(text) legt sie an.
       Passen die Anhaenge nicht (Speicher voll, Schreibfehler), kommt die
       Nachricht ohne sie und mit Hinweis — die Mail waere sonst verloren. */
    async function commitWithAttachments({ body, accepted, skipped }, write) {
        const fallback = '(Anhang per E-Mail)';
        try {
            return await attachmentStore.commit(accepted, () => write(withNote(body || fallback, skipped)));
        } catch (err) {
            if (accepted.length === 0) throw err;
            log.error?.('Anhang aus E-Mail konnte nicht gespeichert werden:', err.message);
            const note = err.code === 'insufficient_storage'
                ? 'Anhänge (zu wenig Speicherplatz auf dem Server).'
                : 'Anhänge (Speicherfehler).';
            return attachmentStore.commit([], () => write(withNote(body || fallback, [...skipped, note])));
        }
    }

    function senderAuthenticated(mail, from) {
        if (!authservId) return { ok: true, method: null };
        return authenticatedSender(mail.authResults, { authservId, fromAddress: from });
    }

    /* Folgt merged_into_id bis zum Ticket, das es noch gibt (Kette hoechstens
       ein paar Glieder lang, begrenzt gegen einen — eigentlich unmoeglichen —
       Zyklus). */
    function resolveMerged(ticket) {
        let current = ticket;
        for (let i = 0; i < 10 && current?.mergedIntoId; i += 1) {
            current = ticketStore.getTicket(current.mergedIntoId) ?? current;
            if (!current.mergedIntoId) break;
        }
        return current;
    }

    async function replyToTicket(mail, from, found) {
        const ticket = resolveMerged(found);
        const customer = ticket.customerId ? customerStore.getCustomer(ticket.customerId) : null;
        if (!customer || customer.disabled || customer.email !== from) {
            return reject('sender_mismatch', { from, ticket: ticket.number });
        }
        const auth = senderAuthenticated(mail, from);
        if (!auth.ok) return reject('auth_failed', { from, ticket: ticket.number, detail: auth.reason });

        if (ticket.status === 'closed') {
            // Hinweis hoechstens einmal je Ticket und Fenster, und nie an
            // eine Mail, die ausdruecklich keine Auto-Antwort will
            const notified = !mail.suppressAutoResponse
                && (inboundStore ? inboundStore.notifyOnce(`closed:${ticket.id}`, CLOSED_NOTICE_WINDOW_MS) : true);
            if (notified) ticketMail.replyRejectedClosed(ticket);
            return reject('ticket_closed', { from, ticket: ticket.number, notified });
        }

        const content = prepareContent(mail);
        if (!content.body && content.accepted.length === 0) return reject('empty', { from, ticket: ticket.number });

        const { result, stored } = await commitWithAttachments(content, text => (
            ticketStore.addReply(ticket.id, { author: 'customer', body: text, via: 'email' })
        ));
        if (!result) return reject('ticket_merged', { from, ticket: ticket.number });
        const { message, ticket: updated } = result;
        count('added');
        auditLog?.log('ticket_replied', { ticket: ticket.number, via: 'email', customerId: customer.id });
        ticketMail.customerReplied(updated, message, stored);
        return { result: 'added', ticketId: ticket.id, messageId: message.id };
    }

    async function createFromMail(mail, from) {
        if (!authservId) return reject('unmatched', { from });
        const customer = customerStore.findByEmail(from);
        if (!customer) return reject('no_account', { from });
        if (!customer.emailVerified) return reject('unverified', { from, customerId: customer.id });
        if (customer.disabled) return reject('account_disabled', { from, customerId: customer.id });

        const auth = senderAuthenticated(mail, from);
        if (!auth.ok) return reject('auth_failed', { from, customerId: customer.id, detail: auth.reason });

        const recent = ticketStore.countRecentBySource(customer.id, 'email', now() - NEW_TICKET_WINDOW_MS);
        if (recent >= NEW_TICKET_LIMIT) return reject('rate_limited', { from, customerId: customer.id });

        const content = prepareContent(mail);
        if (!content.body && content.accepted.length === 0) return reject('empty', { from, customerId: customer.id });

        const { result: { ticket, message }, stored } = await commitWithAttachments(content, text => (
            ticketStore.createTicket({
                customer, subject: ticketSubject(mail.subject), body: text, via: 'email', source: 'email',
            })
        ));
        count('created');
        auditLog?.log('ticket_created_via_mail', {
            ticket: ticket.number, customerId: customer.id, auth: auth.method,
        });
        ticketMail.ticketCreated(ticket, message, stored);
        return { result: 'created', ticketId: ticket.id, messageId: message.id };
    }

    async function process(mail) {
        const from = normalizeEmail(mail.from);
        // Absender + Message-ID: eine fremde Mail mit kopierter Message-ID
        // kann so keine echte Mail eines Kunden "vorab verbrauchen".
        const messageId = String(mail.messageId ?? '').trim().toLowerCase();
        const key = messageId ? `mid:${from}:${messageId}` : mail.dedupKey;
        if (inboundStore && key && !inboundStore.claim(key)) {
            count('duplicate');
            return { result: 'duplicate' };
        }
        if (mail.autoSubmitted) return reject('auto_submitted', { from });

        const ticketId = ticketMail.ticketIdFromReferences(mail.inReplyTo, mail.references);
        const ticket = ticketId ? ticketStore.getTicket(ticketId) : null;
        if (ticket) return replyToTicket(mail, from, ticket);
        // Signierte Referenz auf ein inzwischen geloeschtes Ticket: keine
        // stille Neuanlage aus einer Antwort auf einen alten Thread.
        if (ticketId) return reject('unmatched', { from });
        return createFromMail(mail, from);
    }

    function stats() {
        return Object.fromEntries(counters);
    }

    return { process, stats, newTicketsEnabled: Boolean(authservId) };
}

module.exports = {
    createInboundProcessor, htmlToText, decodeEntities, ticketSubject, NEW_TICKET_LIMIT, CLOSED_NOTICE_WINDOW_MS,
};
