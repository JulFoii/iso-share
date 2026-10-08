'use strict';

/*
 * Kundenseite des Ticketsystems: /account/tickets* (Liste, neues Ticket,
 * Verlauf, Antworten, als geloest markieren, Bewertung, Live-Updates) und
 * /attachments/:id (Anhaenge — geteilt mit der Admin-Sicht, Berechtigung je
 * nach Rolle). Die Einstiegsseite /support mit der Wissensdatenbank steht in
 * lib/routes/kb.js.
 *
 * Ein Kunde sieht ausschliesslich Tickets seines eigenen Kontos:
 * getForCustomer() behandelt ein fremdes Ticket exakt wie ein nicht
 * existierendes (identische 404), die fortlaufende Ticketnummer in der URL
 * verraet also nichts ueber fremde Tickets. Interne Notizen, interne
 * Ereignisse und deren Anhaenge sind fuer den Kunden unsichtbar
 * (listMessages({includeInternal:false}), und /attachments prueft das
 * zusaetzlich pro Datei).
 */

const { safeTicketNumber, safeTicketPriority, safeAttachmentId, safeIsoName } = require('../safe-name');
const { AttachmentError } = require('../attachment-store');
const {
    MAX_SUBJECT_LENGTH, MAX_MESSAGE_LENGTH, attachmentsMiddleware, textField, lineField, contentDisposition, wantsJson,
} = require('./helpers');

function registerCustomerTicketRoutes(ctx) {
    const {
        app, ticketStore, configStore, attachmentStore, ticketMail, auditLog, limiters, attachmentUpload,
        renderPartial, checkCustomer, inboundEnabled, isActiveAdmin, listIsoFileNames, describeIsoFile,
        inboundNewTickets, supportAddress,
    } = ctx;

    const withAttachments = attachmentsMiddleware(attachmentUpload, {
        maxFiles: attachmentStore.maxFiles, maxBytes: attachmentStore.maxBytes, hasSpaceFor: attachmentStore.hasSpaceFor,
    });

    const NOT_FOUND = 'Ticket nicht gefunden.';
    // Zusaetzlich zum stuendlichen Limiter je Konto: mehr neue Tickets pro
    // Tag legt kein echter Kunde an — ein Skript mit gestohlener Session
    // soll den Posteingang nicht fluten koennen.
    const MAX_WEB_TICKETS_PER_DAY = 20;

    function loadOwnTicket(req, res, next) {
        const number = safeTicketNumber(req.params.number);
        const ticket = number ? ticketStore.getForCustomer(number, req.customer.id) : null;
        if (!ticket) {
            if (req.files?.length) attachmentStore.discardUploads(req.files);
            return res.status(404).render('account/notice', {
                title: NOT_FOUND, text: 'Dieses Ticket gibt es nicht oder es gehört nicht zu deinem Konto.',
                action: { href: '/account/tickets', label: 'Zu meinen Tickets' }, variant: 'danger',
            });
        }
        req.ticket = ticket;
        next();
    }

    /* ---------------------------------------------------------- Liste -- */

    app.get('/account/tickets', checkCustomer, (req, res) => {
        // Die Seite hat nur die Reiter "Offen" und "Erledigt" — andere
        // Ansichten per URL wuerden unter dem Reiter "Offen" eine andere
        // Liste zeigen, als der Reiter verspricht.
        const view = req.query.view === 'done' ? 'done' : 'active';
        const q = textField(req.query.q, 200);
        const result = ticketStore.listTickets({
            view, q, customerId: req.customer.id, page: req.query.page, perPage: 20, sort: 'attention',
        });
        res.render('account/tickets', {
            ...result, view, q, counts: ticketStore.countViews({ customerId: req.customer.id }),
            created: safeTicketNumber(req.query.created),
        });
    });

    /* --------------------------------------------------- Neues Ticket -- */

    async function renderNew(req, res, { status = 200, error = null, values = {} } = {}) {
        try {
            const isoFiles = await listIsoFileNames();
            // ?file=… aus der Dateiliste ("Problem mit dieser Datei melden")
            const preset = safeIsoName(req.query.file);
            res.status(status).render('account/ticket-new', {
                error,
                values: { isoFile: preset && isoFiles.includes(preset) ? preset : '', ...values },
                categories: configStore.listCategories(),
                isoFiles,
                maxFiles: attachmentStore.maxFiles, maxMb: Math.round(attachmentStore.maxBytes / 1024 / 1024),
                mailTicketAddress: inboundNewTickets ? supportAddress : null,
            });
        } catch (err) {
            req.next(err);
        }
    }

    app.get('/account/tickets/new', checkCustomer, (req, res) => renderNew(req, res));

    app.post('/account/tickets', checkCustomer, limiters.ticketWriteGlobal, limiters.ticketWritePerIp, limiters.ticketWritePerCustomer, withAttachments,
        async (req, res, next) => {
            const values = {
                subject: lineField(req.body.subject, MAX_SUBJECT_LENGTH),
                message: textField(req.body.message, MAX_MESSAGE_LENGTH),
                categoryId: Number(req.body.categoryId) || null,
                priority: safeTicketPriority(req.body.priority) ?? 'normal',
                isoFile: String(req.body.isoFile ?? '').trim(),
            };
            const files = req.files || [];
            const fail = async error => {
                await attachmentStore.discardUploads(files);
                renderNew(req, res, { status: 400, error, values });
            };
            if (req.attachmentError) return fail(req.attachmentError);
            if (ticketStore.countRecentBySource(req.customer.id, 'web', Date.now() - 24 * 60 * 60 * 1000)
                >= MAX_WEB_TICKETS_PER_DAY) {
                return fail('Du hast heute bereits sehr viele Tickets angelegt. Bitte antworte in einem bestehenden Ticket oder versuche es morgen erneut.');
            }
            if (!values.subject) return fail('Bitte gib einen Betreff an.');
            if (!values.message) return fail('Bitte beschreibe dein Anliegen.');
            const category = values.categoryId ? configStore.getCategory(values.categoryId) : null;
            if (values.categoryId && !category) return fail('Bitte wähle eine gültige Kategorie.');
            // Nur Dateien, die es tatsaechlich gibt — ein Kunde soll keinen
            // beliebigen Text in dieses Feld schreiben koennen.
            const isoFile = values.isoFile ? safeIsoName(values.isoFile) : null;
            if (values.isoFile && (!isoFile || !(await listIsoFileNames()).includes(isoFile))) {
                return fail('Bitte wähle eine Datei aus der Liste.');
            }
            // "Dringend" darf der Support vergeben, Kunden bis "Hoch".
            if (values.priority === 'urgent') values.priority = 'high';

            try {
                let inspected;
                try {
                    inspected = await attachmentStore.inspectUploads(files);
                } catch (err) {
                    if (err instanceof AttachmentError) return fail(err.message);
                    throw err;
                }
                // Ticket, Nachricht und Anhaenge atomar — nie ein Ticket, das
                // es trotz Fehlermeldung gibt (und beim Wiederholen doppelt)
                let committed;
                try {
                    committed = await attachmentStore.commit(inspected, () => ticketStore.createTicket({
                        customer: req.customer, subject: values.subject, body: values.message,
                        priority: values.priority, categoryId: category?.id ?? null, isoFile,
                    }));
                } catch (err) {
                    if (err instanceof AttachmentError) return fail(err.message);
                    throw err;
                }
                const { result: { ticket, message }, stored } = committed;
                auditLog.log('ticket_created', { ip: req.ip, ticket: ticket.number, customerId: req.customer.id });
                ticketMail.ticketCreated(ticket, message, stored);
                res.redirect(303, `/account/tickets/${ticket.number}?created=1`);
            } catch (err) {
                await attachmentStore.discardUploads(files);
                next(err);
            }
        });

    /* -------------------------------------------------------- Verlauf -- */

    function detailData(ticket, extra = {}) {
        // Abgeteilt (splitTicket()): Link aufs Ursprungsticket — nur wenn es
        // noch existiert und demselben Konto gehoert.
        const splitFrom = ticket.splitFromId ? ticketStore.getTicket(ticket.splitFromId) : null;
        return {
            ticket,
            splitFrom: splitFrom && splitFrom.customerId === ticket.customerId ? splitFrom : null,
            messages: ticketStore.listMessages(ticket.id, { includeInternal: false }),
            maxFiles: attachmentStore.maxFiles,
            maxMb: Math.round(attachmentStore.maxBytes / 1024 / 1024),
            replyError: null,
            created: false,
            inboundEnabled,
            ...extra,
        };
    }

    app.get('/account/tickets/:number', checkCustomer, loadOwnTicket, async (req, res, next) => {
        // Zusammengefuehrt: die alte Nummer fuehrt ins Ziel-Ticket (gehoert
        // demselben Konto, siehe mergeTickets())
        if (req.ticket.mergedIntoId) {
            const target = ticketStore.getTicket(req.ticket.mergedIntoId);
            if (target && target.customerId === req.customer.id) {
                return res.redirect(301, `/account/tickets/${target.number}`);
            }
        }
        if (req.ticket.customerUnread) {
            ticketStore.markRead(req.ticket.id, 'customer');
            // loadCustomer hat den Zaehler in der Navigation schon vor dem
            // Lesen berechnet — sonst zaehlte er genau dieses Ticket noch mit.
            res.locals.customerUnread = ticketStore.countUnreadForCustomer(req.customer.id);
        }
        try {
            const isoInfo = req.ticket.isoFile ? await describeIsoFile(req.ticket.isoFile) : null;
            res.render('account/ticket', detailData(req.ticket, { created: req.query.created === '1', isoInfo }));
        } catch (err) {
            next(err);
        }
    });

    /* Live-Update: liefert den fertig gerenderten Verlauf, sobald sich das
       Ticket seit `since` geaendert hat — sonst nur {changed:false}. Gleiches
       Muster wie die Heartbeat-Fragmente in server.js. */
    app.get('/account/tickets/:number/updates', checkCustomer, limiters.poll, loadOwnTicket, async (req, res, next) => {
        const since = Number(req.query.since) || 0;
        if (req.ticket.updatedAt <= since) return res.json({ changed: false, updatedAt: req.ticket.updatedAt });
        try {
            if (req.ticket.customerUnread) ticketStore.markRead(req.ticket.id, 'customer');
            const data = detailData(req.ticket);
            const [threadHtml, statusHtml] = await Promise.all([
                renderPartial('partials/ticket-thread', { ...data, viewer: 'customer' }),
                renderPartial('partials/ticket-status-badge', { ticket: req.ticket, viewer: 'customer' }),
            ]);
            res.json({ changed: true, updatedAt: req.ticket.updatedAt, status: req.ticket.status, threadHtml, statusHtml });
        } catch (err) {
            next(err);
        }
    });

    app.post('/account/tickets/:number/reply', checkCustomer, limiters.ticketWriteGlobal, limiters.ticketWritePerIp, limiters.ticketWritePerCustomer,
        withAttachments, loadOwnTicket, async (req, res, next) => {
            const { ticket } = req;
            const files = req.files || [];
            const body = textField(req.body.message, MAX_MESSAGE_LENGTH);
            // Wie im Admin-Bereich: composer.js sendet per fetch und bleibt
            // an Ort und Stelle, ohne JS gibt es den Redirect.
            const json = wantsJson(req);
            const fail = async (error, status = 400) => {
                await attachmentStore.discardUploads(files);
                if (json) return res.status(status).json({ error });
                try {
                    // Wie die GET-Seite, sonst fehlte hier die Datei-Karte.
                    const isoInfo = ticket.isoFile ? await describeIsoFile(ticket.isoFile) : null;
                    res.status(status).render('account/ticket', detailData(ticket, { replyError: error, draft: body, isoInfo }));
                } catch (err) {
                    next(err);
                }
            };
            if (ticket.status === 'closed') {
                return fail('Dieses Ticket ist geschlossen. Bitte lege für ein neues Anliegen ein neues Ticket an.');
            }
            if (req.attachmentError) return fail(req.attachmentError);
            if (!body && files.length === 0) return fail('Bitte schreibe eine Nachricht.');
            try {
                let inspected;
                try {
                    inspected = await attachmentStore.inspectUploads(files);
                } catch (err) {
                    if (err instanceof AttachmentError) return fail(err.message);
                    throw err;
                }
                let committed;
                try {
                    committed = await attachmentStore.commit(inspected, () => ticketStore.addReply(ticket.id, {
                        author: 'customer', body: body || '(Anhang)',
                    }));
                } catch (err) {
                    if (err instanceof AttachmentError) return fail(err.message);
                    throw err;
                }
                if (!committed.result) return fail('Dieses Ticket nimmt keine Nachrichten mehr an.');
                const { result: { message, ticket: updated }, stored } = committed;
                auditLog.log('ticket_replied', { ip: req.ip, ticket: ticket.number, via: 'customer' });
                ticketMail.customerReplied(updated, message, stored);
                if (json) return res.json({ ok: true, messageId: message.id });
                res.redirect(303, `/account/tickets/${ticket.number}#message-${message.id}`);
            } catch (err) {
                await attachmentStore.discardUploads(files);
                next(err);
            }
        });

    app.post('/account/tickets/:number/resolve', checkCustomer, limiters.ticketWriteGlobal, limiters.ticketWritePerIp, limiters.ticketWritePerCustomer,
        loadOwnTicket, (req, res) => {
            if (['new', 'open', 'pending'].includes(req.ticket.status)) {
                ticketStore.setStatus(req.ticket.id, 'resolved', { actor: 'customer' });
                auditLog.log('ticket_status_changed', {
                    ip: req.ip, ticket: req.ticket.number, status: 'resolved', by: 'customer',
                });
            }
            res.redirect(303, `/account/tickets/${req.ticket.number}#rating`);
        });

    app.post('/account/tickets/:number/rate', checkCustomer, limiters.ticketWriteGlobal, limiters.ticketWritePerIp, limiters.ticketWritePerCustomer,
        loadOwnTicket, (req, res) => {
            const comment = textField(req.body.comment, 1000);
            if (ticketStore.rate(req.ticket.id, req.body.rating, comment)) {
                auditLog.log('ticket_rated', { ip: req.ip, ticket: req.ticket.number, rating: Number(req.body.rating) });
            }
            res.redirect(303, `/account/tickets/${req.ticket.number}#rating`);
        });

    /* -------------------------------------------------------- Anhaenge -- */

    /*
     * Fuer Admin und Kunde. Ausgeliefert wird nie inline als HTML: Bilder
     * (per Magic-Bytes verifiziert, siehe lib/attachment-store.js) inline fuer
     * die Vorschau, alles andere als Download. nosniff + eine eigene,
     * maximal restriktive CSP mit sandbox verhindern zusaetzlich, dass ein
     * Browser eine Datei doch als Dokument mit Skriptrechten oeffnet.
     */
    app.get('/attachments/:id', (req, res, next) => {
        const id = safeAttachmentId(req.params.id);
        const attachment = id ? attachmentStore.getAttachment(id) : null;
        const isAdmin = isActiveAdmin(req);
        let allowed = false;
        if (attachment && isAdmin) {
            allowed = true;
        } else if (attachment && req.customer && !attachment.internal) {
            const ticket = ticketStore.getTicket(attachment.ticketId);
            allowed = Boolean(ticket && ticket.customerId === req.customer.id);
        }
        if (!allowed) return res.status(404).send('Nicht gefunden');

        res.set({
            'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'private, max-age=3600',
        });
        const inline = attachment.isImage && req.query.download !== '1';
        res.set('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', attachment.filename));
        // Massgeblich ist allein der beim Upload per Magic-Bytes erkannte
        // Typ, nie die (vom Nutzer stammende) Dateiendung.
        res.type(attachment.mime);
        res.sendFile(attachmentStore.filePath(attachment.id), err => {
            if (err && !res.headersSent) next(err);
        });
    });
}

module.exports = { registerCustomerTicketRoutes };
