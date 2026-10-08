'use strict';

/*
 * Alle Mail-Anlaesse des Ticketsystems an einer Stelle: Konto (Bestaetigung,
 * Passwort-Reset, Adresswechsel …), Tickets (Eingangsbestaetigung, neue
 * Antwort, Statuswechsel, Erinnerung) und die Benachrichtigungen an den
 * Admin. Jede Funktion baut die Mail (lib/mail-templates.js) und legt sie in
 * die Outbox (lib/mail-outbox.js) — verschickt wird asynchron.
 *
 * Threading: jede Mail zu einem Ticket bekommt eine eigene Message-ID und
 * verweist per In-Reply-To/References auf eine feste "Wurzel"-ID des Tickets,
 * sodass Mailprogramme den ganzen Verlauf als einen Thread zeigen. Die IDs
 * tragen eine HMAC-Signatur ueber die Ticket-ID (threadSecret). Antwortet
 * ein Kunde per Mail (IMAP, siehe lib/mail-inbound.js), findet
 * ticketIdFromReferences() das Ticket ausschliesslich ueber eine gueltig
 * signierte Referenz — eine gefaelschte Absenderadresse plus "[#1042]" im
 * Betreff reicht also nicht, um eine Nachricht in ein fremdes Ticket zu
 * schmuggeln.
 *
 * Kunden-Einstellungen (customer.notify, siehe lib/customer-store.js) werden
 * hier beachtet; sicherheitsrelevante Mails ignorieren sie bewusst.
 *
 * Anhaenge einer Nachricht gehen als echte Mail-Anhaenge mit, solange ihre
 * Summe attachmentMaxBytes (MAIL_ATTACHMENT_MAX_MB) nicht uebersteigt — in
 * Reihenfolge, bis das Limit erreicht ist; der Rest steht nur als Name mit
 * "(im Portal)" in der Mail. Die Outbox speichert dafuer nur die IDs
 * (lib/mail-outbox.js). Die Eingangsbestaetigung an den Kunden schickt ihm
 * seine eigenen Dateien bewusst nicht zurueck.
 */

const crypto = require('crypto');
const { compose } = require('./mail-templates');
const { STATUS_LABELS, CUSTOMER_STATUS_LABELS, PRIORITY_LABELS, SOURCE_LABELS } = require('./ticket-store');

const REF_PATTERN = /ticket-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([0-9a-f]{16})(?:-[0-9a-z]+)?@/gi;

function createTicketMail({
    outbox, customerStore, publicUrl, appName = 'ISO Share', notifyEmail = null, replyTo = null,
    threadSecret, domain = 'localhost', inboundEnabled = false, attachmentMaxBytes = 10 * 1024 * 1024,
    formatDateTime = ms => new Date(ms).toISOString(),
}) {
    const BASE = String(publicUrl || '').replace(/\/+$/, '');

    function sign(ticketId) {
        return crypto.createHmac('sha256', String(threadSecret)).update(`thread:${ticketId}`).digest('hex').slice(0, 16);
    }

    function rootId(ticketId) {
        return `<ticket-${ticketId}-${sign(ticketId)}@${domain}>`;
    }

    function newMessageId(ticketId) {
        return `<ticket-${ticketId}-${sign(ticketId)}-${crypto.randomBytes(6).toString('hex')}@${domain}>`;
    }

    /* Sucht in In-Reply-To/References die erste gueltig signierte
       Ticket-Referenz. */
    function ticketIdFromReferences(...headerValues) {
        const haystack = headerValues.flat().filter(Boolean).join(' ');
        for (const match of haystack.matchAll(REF_PATTERN)) {
            const [, ticketId, signature] = match;
            const expected = Buffer.from(sign(ticketId.toLowerCase()));
            const given = Buffer.from(signature.toLowerCase());
            if (expected.length === given.length && crypto.timingSafeEqual(expected, given)) {
                return ticketId.toLowerCase();
            }
        }
        return null;
    }

    function threadHeaders(ticket, { replyable = false } = {}) {
        const root = rootId(ticket.id);
        const headers = {
            messageId: newMessageId(ticket.id),
            inReplyTo: root,
            references: root,
            'Auto-Submitted': 'auto-generated',
        };
        if (replyable && replyTo) headers.replyTo = replyTo;
        return headers;
    }

    const customerTicketUrl = ticket => `${BASE}/account/tickets/${ticket.number}`;
    const adminTicketUrl = ticket => `${BASE}/admin/tickets/${ticket.number}`;
    const tag = ticket => `[#${ticket.number}]`;

    function recipientFor(ticket) {
        const customer = ticket.customerId ? customerStore.getCustomer(ticket.customerId) : null;
        if (customer?.disabled) return null;
        return {
            email: customer?.email ?? ticket.requesterEmail,
            name: customer?.name ?? ticket.requesterName ?? '',
            notify: customer?.notify ?? { replies: true, status: true, reminders: true },
        };
    }

    function greeting(name) {
        return name ? `Hallo ${name},` : 'Hallo,';
    }

    /* Kurze erste Zeile, die auf Komma/Ausrufezeichen endet ("Hallo Max,"). */
    function startsWithSalutation(body) {
        return /^[^\n]{1,60}[,!][ \t]*(\r?\n|$)/.test(String(body ?? '').trimStart());
    }

    /* Fusszeile je nach Empfaenger: Admin-Mails verlinken den Posteingang,
       Kunden-Mails das Portal und die Benachrichtigungs-Einstellungen. */
    function defaultFooter(kind) {
        if (kind.startsWith('admin_') || kind === 'test') {
            return {
                footer: `${appName} · Benachrichtigung für den Support`,
                footerLinks: [
                    { label: 'Posteingang', url: `${BASE}/admin/tickets` },
                    { label: 'Einstellungen', url: `${BASE}/admin/ticket-settings` },
                ],
            };
        }
        if (kind.startsWith('ticket_')) {
            return {
                footer: `Du erhältst diese E-Mail, weil du ein Ticket bei ${appName} hast.`,
                footerLinks: [
                    { label: 'Meine Tickets', url: `${BASE}/account/tickets` },
                    { label: 'Benachrichtigungen verwalten', url: `${BASE}/account/settings#notifications` },
                    { label: 'Datenschutz', url: `${BASE}/privacy` },
                ],
            };
        }
        return {
            footer: `Diese E-Mail wurde automatisch von ${appName} verschickt.`,
            footerLinks: [
                { label: 'Support', url: `${BASE}/support` },
                { label: 'Datenschutz', url: `${BASE}/privacy` },
            ],
        };
    }

    /* Kopfzeile "#1042 · Betreff · Status" fuer alle Mails zu einem Ticket. */
    function ticketInfo(ticket, viewer = 'customer') {
        const labels = viewer === 'admin' ? STATUS_LABELS : CUSTOMER_STATUS_LABELS;
        return { number: ticket.number, subject: ticket.subject, status: ticket.status, statusLabel: labels[ticket.status] };
    }

    /* Vorschautext in der Postfach-Liste: erste Zeile der Nachricht. */
    function preview(body) {
        const line = String(body ?? '').split('\n').map(l => l.trim()).find(Boolean) ?? '';
        return line.length > 110 ? `${line.slice(0, 107)}…` : line;
    }

    function send(kind, to, content, { ticket = null, headers = {}, attachments = [] } = {}) {
        const { text, html } = compose({ appName, ...defaultFooter(kind), ...content });
        return outbox.enqueue({
            kind, to, subject: content.subject, text, html, headers, ticketId: ticket?.id ?? null, attachments,
        });
    }

    // Kunden koennen per Mail antworten, sobald IMAP konfiguriert ist — dann
    // steht das auch so in der Mail.
    const replyHint = inboundEnabled
        ? 'Du kannst direkt auf diese E-Mail antworten oder im Kundenportal schreiben.'
        : 'Bitte antworte über das Kundenportal — Antworten auf diese E-Mail kommen nicht an.';

    /* ------------------------------------------------------------ Konto */

    function verifyEmail(customer, token) {
        const url = `${BASE}/account/verify?token=${encodeURIComponent(token)}`;
        return send('account_verify', customer.email, {
            subject: `${appName}: Bitte bestätige deine E-Mail-Adresse`,
            heading: 'Willkommen! Bitte E-Mail-Adresse bestätigen',
            preheader: 'Ein Klick, und dein Konto ist aktiv.',
            paragraphs: [
                greeting(customer.name),
                'danke für deine Registrierung im Support-Portal. Bestätige bitte deine E-Mail-Adresse, ' +
                'damit du Tickets anlegen kannst. Der Link ist 24 Stunden gültig.',
            ],
            button: { label: 'E-Mail-Adresse bestätigen', url },
            after: ['Du hast dich nicht registriert? Dann kannst du diese E-Mail einfach ignorieren.'],
        });
    }

    /* Registrierungsversuch mit einer schon vergebenen Adresse — die
       Webseite antwortet dabei identisch wie bei einer neuen Adresse
       (keine Enumeration), nur der Postfachinhaber erfaehrt davon. */
    function accountExists(customer) {
        return send('account_exists', customer.email, {
            subject: `${appName}: Registrierungsversuch mit deiner Adresse`,
            heading: 'Du hast bereits ein Konto',
            preheader: 'Jemand wollte mit deiner Adresse ein neues Konto anlegen.',
            paragraphs: [
                greeting(customer.name),
                'gerade wurde versucht, mit dieser E-Mail-Adresse ein neues Konto anzulegen. Du hast bereits eines — ' +
                'melde dich einfach an. Falls du dein Passwort vergessen hast, kannst du es zurücksetzen.',
            ],
            button: { label: 'Passwort zurücksetzen', url: `${BASE}/account/forgot` },
            after: ['Warst du das nicht, musst du nichts tun — dein Konto bleibt unverändert.'],
        });
    }

    function passwordReset(customer, token) {
        const url = `${BASE}/account/reset?token=${encodeURIComponent(token)}`;
        return send('password_reset', customer.email, {
            subject: `${appName}: Passwort zurücksetzen`,
            heading: 'Passwort zurücksetzen',
            preheader: 'Der Link ist eine Stunde gültig.',
            paragraphs: [
                greeting(customer.name),
                'über den folgenden Link kannst du ein neues Passwort festlegen. Er ist eine Stunde gültig und ' +
                'funktioniert nur einmal.',
            ],
            button: { label: 'Neues Passwort festlegen', url },
            after: ['Du hast das nicht angefordert? Dann ignoriere diese E-Mail — dein Passwort bleibt unverändert.'],
        });
    }

    function passwordChanged(customer) {
        return send('password_changed', customer.email, {
            subject: `${appName}: Dein Passwort wurde geändert`,
            heading: 'Passwort geändert',
            preheader: 'Das Passwort deines Support-Kontos wurde geändert.',
            paragraphs: [
                greeting(customer.name),
                'das Passwort deines Support-Kontos wurde soeben geändert. Alle anderen Sitzungen wurden abgemeldet.',
                'Warst du das nicht? Setze dein Passwort sofort zurück und kontaktiere den Betreiber.',
            ],
            button: { label: 'Passwort zurücksetzen', url: `${BASE}/account/forgot` },
        });
    }

    function emailChange(customer, newEmail, token) {
        const url = `${BASE}/account/confirm-email?token=${encodeURIComponent(token)}`;
        return send('email_change', newEmail, {
            subject: `${appName}: Neue E-Mail-Adresse bestätigen`,
            heading: 'Neue E-Mail-Adresse bestätigen',
            preheader: 'Bestätige den Wechsel deiner E-Mail-Adresse.',
            paragraphs: [
                greeting(customer.name),
                `für dein Support-Konto wurde diese Adresse als neue E-Mail-Adresse angegeben (bisher: ${customer.email}). ` +
                'Bestätige den Wechsel über den folgenden Link (24 Stunden gültig).',
            ],
            button: { label: 'Adresse bestätigen', url },
        });
    }

    function accountDeleted(customer) {
        return send('account_deleted', customer.email, {
            subject: `${appName}: Dein Konto wurde gelöscht`,
            heading: 'Konto gelöscht',
            preheader: 'Dein Support-Konto wurde gelöscht.',
            paragraphs: [
                greeting(customer.name),
                'dein Support-Konto und alle zugehörigen Tickets, Nachrichten und Anhänge wurden gelöscht.',
            ],
        });
    }

    /* ---------------------------------------------------------- Tickets */

    function attachmentNames(attachments) {
        return (attachments || []).map(a => a.filename);
    }

    /* Welche Anhaenge tatsaechlich mitgehen: { ids, names }. names nennt
       alle, die nicht mitgeschickten mit Hinweis. */
    function pickAttachments(attachments) {
        const ids = [];
        const names = [];
        let total = 0;
        for (const a of attachments || []) {
            if (attachmentMaxBytes > 0 && a.id && total + a.size <= attachmentMaxBytes) {
                total += a.size;
                ids.push(a.id);
                names.push(a.filename);
            } else {
                names.push(`${a.filename} (im Portal)`);
            }
        }
        return { ids, names };
    }

    /* "Datei: debian-12.iso" fuer Admin-Mails, wenn das Ticket sich auf eine
       ISO-Datei bezieht. */
    function isoLine(ticket) {
        return ticket.isoFile ? [`ISO-Datei: ${ticket.isoFile}`] : [];
    }

    function ticketCreated(ticket, message, attachments = []) {
        const recipient = recipientFor(ticket);
        if (recipient) {
            send('ticket_created', recipient.email, {
                subject: `${tag(ticket)} ${ticket.subject}`,
                heading: 'Deine Anfrage ist eingegangen',
                preheader: `Ticket #${ticket.number} — wir melden uns so schnell wie möglich.`,
                ticket: ticketInfo(ticket),
                paragraphs: [
                    greeting(recipient.name),
                    'danke für deine Anfrage — wir melden uns so schnell wie möglich. Den Verlauf siehst du jederzeit ' +
                    'in deinem Kundenkonto.',
                ],
                quote: { label: 'Deine Nachricht', body: message.body, author: 'customer', name: recipient.name },
                attachments: attachmentNames(attachments),
                button: { label: 'Ticket ansehen', url: customerTicketUrl(ticket) },
                after: [replyHint],
                replyable: inboundEnabled,
            }, { ticket, headers: threadHeaders(ticket, { replyable: true }) });
        }
        const picked = pickAttachments(attachments);
        notifyAdmin('admin_ticket_new', ticket, {
            subject: `Neues Ticket ${tag(ticket)} ${ticket.subject}`,
            heading: 'Neues Ticket eingegangen',
            preheader: `${ticket.requesterName || ticket.requesterEmail}: ${preview(message.body)}`,
            ticket: ticketInfo(ticket, 'admin'),
            paragraphs: [`Priorität: ${PRIORITY_LABELS[ticket.priority]}` +
                (ticket.categoryName ? ` · Kategorie: ${ticket.categoryName}` : '') +
                (ticket.source && ticket.source !== 'web' ? ` · Eingang: ${SOURCE_LABELS[ticket.source]}` : ''),
            ...isoLine(ticket)],
            quote: {
                label: `${ticket.requesterName || ''} <${ticket.requesterEmail}>`.trim(), body: message.body,
                author: 'customer', name: ticket.requesterName || ticket.requesterEmail,
            },
            attachments: picked.names,
            button: { label: 'Im Admin-Bereich öffnen', url: adminTicketUrl(ticket) },
        }, picked.ids);
    }

    function adminReplied(ticket, message, attachments = []) {
        const recipient = recipientFor(ticket);
        if (!recipient || !recipient.notify.replies) return null;
        const picked = pickAttachments(attachments);
        return send('ticket_reply', recipient.email, {
            subject: `Re: ${tag(ticket)} ${ticket.subject}`,
            heading: 'Neue Antwort vom Support',
            preheader: preview(message.body),
            ticket: ticketInfo(ticket),
            // Beginnt die Antwort schon mit einer Anrede (lib/reply-template.js),
            // keine zweite davor.
            paragraphs: [startsWithSalutation(message.body)
                ? 'Es gibt eine neue Antwort auf dein Ticket:'
                : greeting(recipient.name) + ' es gibt eine neue Antwort auf dein Ticket:'],
            quote: { label: 'Support', body: message.body, author: 'admin' },
            attachments: picked.names,
            button: { label: 'Ticket ansehen & antworten', url: customerTicketUrl(ticket) },
            after: [
                ticket.status === 'resolved'
                    ? 'Wir haben das Ticket als gelöst markiert. Ist noch etwas offen, antworte einfach — sonst freuen wir uns über eine kurze Bewertung im Ticket.'
                    : ticket.status === 'closed' ? 'Das Ticket ist damit geschlossen.' : replyHint,
            ],
            replyable: inboundEnabled,
        }, { ticket, headers: threadHeaders(ticket, { replyable: true }), attachments: picked.ids });
    }

    /* Der Support hat ein Ticket fuer den Kunden angelegt (Anruf, Rueckfrage)
       — die erste Nachricht ist schon seine. */
    function ticketOpenedBySupport(ticket, message, attachments = []) {
        const recipient = recipientFor(ticket);
        if (!recipient || !recipient.notify.replies) return null;
        const picked = pickAttachments(attachments);
        return send('ticket_opened', recipient.email, {
            subject: `${tag(ticket)} ${ticket.subject}`,
            heading: 'Neue Nachricht vom Support',
            preheader: preview(message.body),
            ticket: ticketInfo(ticket),
            paragraphs: [startsWithSalutation(message.body)
                ? 'Wir haben für dein Anliegen ein Ticket angelegt:'
                : greeting(recipient.name) + ' wir haben für dein Anliegen ein Ticket angelegt:'],
            quote: { label: 'Support', body: message.body, author: 'admin' },
            attachments: picked.names,
            button: { label: 'Ticket ansehen & antworten', url: customerTicketUrl(ticket) },
            after: [replyHint],
            replyable: inboundEnabled,
        }, { ticket, headers: threadHeaders(ticket, { replyable: true }), attachments: picked.ids });
    }

    /* Zwei Tickets desselben Kunden wurden zusammengefuehrt. Der Thread des
       Ziels, damit Antworten dort landen. */
    function ticketMerged(source, target) {
        const recipient = recipientFor(target);
        if (!recipient || !recipient.notify.status) return null;
        return send('ticket_merged', recipient.email, {
            subject: `${tag(target)} ${target.subject} — Ticket #${source.number} zusammengeführt`,
            heading: 'Deine Tickets wurden zusammengeführt',
            preheader: `Ticket #${source.number} geht in Ticket #${target.number} weiter.`,
            ticket: ticketInfo(target),
            paragraphs: [
                greeting(recipient.name),
                `dein Ticket #${source.number} („${source.subject}“) betrifft dasselbe Anliegen wie Ticket ` +
                `#${target.number}. Wir haben beide zusammengeführt — alle Nachrichten findest du jetzt dort.`,
            ],
            button: { label: 'Ticket ansehen', url: customerTicketUrl(target) },
            after: [replyHint],
            replyable: inboundEnabled,
        }, { ticket: target, headers: threadHeaders(target, { replyable: true }) });
    }

    /* Ein Teil eines Tickets wurde in ein eigenes Ticket verschoben. Der
       Thread des neuen Tickets, damit Antworten zum abgeteilten Anliegen
       gleich dort landen. */
    function ticketSplit(source, target) {
        const recipient = recipientFor(target);
        if (!recipient || !recipient.notify.status) return null;
        return send('ticket_split', recipient.email, {
            subject: `${tag(target)} ${target.subject}`,
            heading: 'Dein Anliegen hat ein eigenes Ticket',
            preheader: `Aus Ticket #${source.number} wurde Ticket #${target.number}.`,
            ticket: ticketInfo(target),
            paragraphs: [
                greeting(recipient.name),
                `wir haben einen Teil deines Tickets #${source.number} („${source.subject}“) in ein eigenes ` +
                `Ticket #${target.number} verschoben, damit wir beide Anliegen getrennt bearbeiten können. ` +
                `Das ursprüngliche Ticket läuft ganz normal weiter.`,
            ],
            button: { label: 'Neues Ticket ansehen', url: customerTicketUrl(target) },
            after: [replyHint],
            replyable: inboundEnabled,
        }, { ticket: target, headers: threadHeaders(target, { replyable: true }) });
    }

    /* Antwortfrist ueberschritten — einmal je Frist (sla_notified_at). */
    function slaBreached(ticket) {
        return notifyAdmin('admin_sla_breach', ticket, {
            subject: `Frist überschritten ${tag(ticket)} ${ticket.subject}`,
            heading: 'Antwortfrist überschritten',
            preheader: `Ticket #${ticket.number} wartet auf eine Antwort.`,
            ticket: ticketInfo(ticket, 'admin'),
            paragraphs: [
                `Die ${ticket.status === 'new' ? 'Erstantwort' : 'Antwort'} war fällig am ${formatDateTime(ticket.slaDueAt)}.`,
                `Priorität: ${PRIORITY_LABELS[ticket.priority]}`,
                ...isoLine(ticket),
            ],
            button: { label: 'Im Admin-Bereich öffnen', url: adminTicketUrl(ticket) },
        });
    }

    function customerReplied(ticket, message, attachments = []) {
        const picked = pickAttachments(attachments);
        notifyAdmin('admin_ticket_reply', ticket, {
            subject: `Neue Antwort ${tag(ticket)} ${ticket.subject}`,
            heading: 'Der Kunde hat geantwortet',
            preheader: `${ticket.requesterName || ticket.requesterEmail}: ${preview(message.body)}`,
            ticket: ticketInfo(ticket, 'admin'),
            paragraphs: message.via === 'email' ? ['Die Antwort kam per E-Mail und wurde automatisch ins Ticket übernommen.'] : [],
            quote: {
                label: `${ticket.requesterName || ''} <${ticket.requesterEmail}>`.trim(), body: message.body,
                author: 'customer', name: ticket.requesterName || ticket.requesterEmail,
            },
            attachments: picked.names,
            button: { label: 'Im Admin-Bereich öffnen', url: adminTicketUrl(ticket) },
        }, picked.ids);
    }

    /* Nur die fuer den Kunden relevanten Wechsel (geloest, geschlossen,
       wiedereroeffnet durch den Support) — und nie der, den er selbst
       ausgeloest hat. */
    function statusChanged(ticket, from, to, actor) {
        if (actor === 'customer') return null;
        if (!['resolved', 'closed'].includes(to) && !['resolved', 'closed'].includes(from)) return null;
        const recipient = recipientFor(ticket);
        if (!recipient || !recipient.notify.status) return null;

        const content = {
            subject: `${tag(ticket)} ${ticket.subject} — ${CUSTOMER_STATUS_LABELS[to]}`,
            heading: to === 'resolved' ? 'Dein Ticket ist gelöst' : to === 'closed' ? 'Dein Ticket wurde geschlossen' : 'Dein Ticket wurde wieder geöffnet',
            preheader: `Ticket #${ticket.number}: ${CUSTOMER_STATUS_LABELS[to]}`,
            ticket: ticketInfo(ticket),
            paragraphs: [greeting(recipient.name)],
            button: { label: 'Ticket ansehen', url: customerTicketUrl(ticket) },
            after: [],
        };
        if (to === 'resolved') {
            content.paragraphs.push(
                actor === 'system'
                    ? 'da wir länger nichts von dir gehört haben, haben wir dein Ticket als gelöst markiert.'
                    : 'dein Ticket wurde als gelöst markiert.',
                'Ist doch noch etwas offen? Antworte einfach im Ticket, dann öffnen wir es wieder. ' +
                'Wir freuen uns außerdem über eine kurze Bewertung.'
            );
            content.button = { label: 'Ticket bewerten', url: `${customerTicketUrl(ticket)}#rating` };
        } else if (to === 'closed') {
            content.paragraphs.push(
                'dein Ticket wurde geschlossen. Bei einem neuen Anliegen lege bitte einfach ein neues Ticket an.'
            );
        } else {
            content.paragraphs.push(`dein Ticket wurde wieder geöffnet (Status: ${CUSTOMER_STATUS_LABELS[to]}).`);
        }
        return send('ticket_status', recipient.email, content, { ticket, headers: threadHeaders(ticket) });
    }

    function pendingReminder(ticket, autoResolveDays) {
        const recipient = recipientFor(ticket);
        if (!recipient || !recipient.notify.reminders) return null;
        return send('ticket_reminder', recipient.email, {
            subject: `Erinnerung: ${tag(ticket)} ${ticket.subject}`,
            heading: 'Wir warten auf deine Antwort',
            preheader: `Ticket #${ticket.number} — kurze Rückmeldung genügt.`,
            ticket: ticketInfo(ticket),
            paragraphs: [
                greeting(recipient.name),
                'wir haben dir zu diesem Ticket geantwortet und warten noch auf deine Rückmeldung. Falls wir ' +
                `innerhalb von ${autoResolveDays === 1 ? 'einem Tag' : `${autoResolveDays} Tagen`} nichts von dir hören, markieren wir das Ticket als gelöst ` +
                '— du kannst es danach aber jederzeit durch eine Antwort wieder öffnen.',
            ],
            button: { label: 'Ticket ansehen & antworten', url: customerTicketUrl(ticket) },
            after: [replyHint],
            replyable: inboundEnabled,
        }, { ticket, headers: threadHeaders(ticket, { replyable: true }) });
    }

    /* Antwort per Mail auf ein bereits geschlossenes Ticket. */
    function replyRejectedClosed(ticket) {
        const recipient = recipientFor(ticket);
        if (!recipient) return null;
        return send('ticket_reply_rejected', recipient.email, {
            subject: `Re: ${tag(ticket)} ${ticket.subject} — Ticket ist geschlossen`,
            heading: 'Dieses Ticket ist bereits geschlossen',
            ticket: ticketInfo(ticket),
            paragraphs: [
                greeting(recipient.name),
                'deine Antwort per E-Mail konnte nicht zugeordnet werden, weil dieses Ticket bereits geschlossen ist. ' +
                'Bitte lege für dein Anliegen ein neues Ticket an.',
            ],
            button: { label: 'Neues Ticket anlegen', url: `${BASE}/account/tickets/new` },
        }, { ticket, headers: threadHeaders(ticket) });
    }

    function notifyAdmin(kind, ticket, content, attachments = []) {
        if (!notifyEmail) return null;
        return send(kind, notifyEmail, content, {
            ticket, headers: threadHeaders(ticket), attachments,
        });
    }

    function testMail(to) {
        return send('test', to, {
            subject: `${appName}: Testmail`,
            heading: 'Der Mailversand funktioniert',
            preheader: 'Testmail aus dem Admin-Bereich.',
            paragraphs: [
                'Diese Testmail wurde aus dem Admin-Bereich verschickt. Wenn du sie liest, ist der SMTP-Versand ' +
                'korrekt eingerichtet.',
                `Absender: ${outbox.enabled ? 'konfiguriert' : '—'} · Antworten per E-Mail: ${inboundEnabled ? 'aktiv (IMAP)' : 'deaktiviert'}`,
            ],
            button: { label: 'Zum Admin-Bereich', url: `${BASE}/admin/tickets` },
        });
    }

    return {
        rootId, ticketIdFromReferences, customerTicketUrl, adminTicketUrl,
        verifyEmail, accountExists, passwordReset, passwordChanged, emailChange, accountDeleted,
        ticketCreated, adminReplied, customerReplied, statusChanged, pendingReminder, replyRejectedClosed,
        ticketOpenedBySupport, ticketMerged, ticketSplit, slaBreached, testMail, STATUS_LABELS,
    };
}

module.exports = { createTicketMail };
