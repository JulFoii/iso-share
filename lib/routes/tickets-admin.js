'use strict';

/*
 * Admin-Seite des Ticketsystems (alles checkAuth-gated):
 *
 *   /admin/tickets               Posteingang mit Ansichten, Suche, Filtern,
 *                                Sortierung, Seiten und Sammelaktionen
 *   /admin/tickets/new           Ticket fuer einen Kunden anlegen (Anruf,
 *                                Rueckfrage) — die erste Nachricht ist vom Support
 *   /admin/tickets/:number       Verlauf inkl. interner Notizen, Antwort/Notiz
 *                                mit Anhaengen und Textbausteinen,
 *                                Eigenschaften (Status/Prioritaet/Kategorie/
 *                                Tags/ISO-Datei), Wiedervorlage,
 *                                Zusammenfuehren, Aufteilen
 *   /admin/customers[/:id]       Kundenkonten (freischalten, sperren, loeschen)
 *   /admin/ticket-settings       Kategorien, Textbausteine, Automatik-Fristen,
 *                                Mail-Outbox und IMAP-Status
 *
 * Die automatischen Abfragen der Seiten (Live-Updates, "neue Aktivitaet"-
 * Hinweis im Posteingang) schicken X-Idle-Background: 1 und verlaengern damit
 * den Admin-Idle-Timeout nicht — dieselbe Regel wie beim Heartbeat.
 */

const {
    safeTicketNumber, safeTicketStatus, safeTicketPriority, safeCustomerId, safeEmail, safeIsoName,
} = require('../safe-name');
const { diff } = require('../event-store');
const { AttachmentError } = require('../attachment-store');
const { ADMIN_VIEWS, SORTS, PRIORITIES, STATUS_LABELS } = require('../ticket-store');
const { SETTINGS_LIMITS, SLA_MAX_HOURS } = require('../ticket-config-store');
const { REPLY_TEMPLATE_LIMITS, buildReplyDraft, isOnlyTemplate } = require('../reply-template');
const { snoozePresets, presetUntil, parseSnoozeInput } = require('../snooze');
const {
    MAX_MESSAGE_LENGTH, MAX_SUBJECT_LENGTH, attachmentsMiddleware, textField, lineField, wantsJson,
} = require('./helpers');

const MAX_BULK_TICKETS = 100;
const MAX_SNOOZE_NOTE = 2000;
const REPLY_STATUSES_AFTER = ['pending', 'open', 'resolved', 'closed'];
// Status nach einem vom Support angelegten Ticket (lib/ticket-store.js createTicket())
const NEW_TICKET_STATUSES = ['pending', 'open', 'resolved'];

const MERGE_ERRORS = {
    not_found: 'Das Ziel-Ticket gibt es nicht.',
    same_ticket: 'Ein Ticket lässt sich nicht mit sich selbst zusammenführen.',
    different_customer: 'Zusammenführen geht nur bei Tickets desselben Kundenkontos.',
    already_merged: 'Dieses Ticket wurde bereits zusammengeführt.',
    target_closed: 'Das Ziel-Ticket ist geschlossen.',
};

const SPLIT_ERRORS = {
    not_found: 'Das Ticket gibt es nicht.',
    closed: 'Geschlossene oder zusammengeführte Tickets lassen sich nicht aufteilen.',
    no_customer: 'Aufteilen geht nur bei Tickets mit Kundenkonto.',
    no_messages: 'Bitte mindestens eine Nachricht auswählen.',
    all_messages: 'Mindestens eine Antwort muss im ursprünglichen Ticket bleiben.',
    no_replies: 'Bitte mindestens eine Antwort auswählen — nur interne Notizen ergeben kein eigenes Ticket.',
};
const MAX_SPLIT_MESSAGES = 500;
const SPLIT_EXCERPT_LENGTH = 90;

function registerAdminTicketRoutes(ctx) {
    const {
        app, checkAuth, ticketStore, customerStore, configStore, attachmentStore, ticketMail, outbox, mailer,
        imapPoller, auditLog, limiters, attachmentUpload, renderPartial, notifyEmail, publicUrl,
        deleteCustomerCompletely, claimTickets, verifyTtlMs, sessionStore, inboundEnabled, adminUsername,
        listIsoFileNames, describeIsoFile, kbStore, inboundNewTickets, clock,
    } = ctx;

    const withAttachments = attachmentsMiddleware(attachmentUpload, {
        maxFiles: attachmentStore.maxFiles, maxBytes: attachmentStore.maxBytes, hasSpaceFor: attachmentStore.hasSpaceFor,
    });

    /* Gestaltete Hinweisseite statt nacktem Text — ein Link aus einer
       Admin-Mail auf ein inzwischen geloeschtes Ticket landet sonst auf
       einer leeren weissen Seite ohne Navigation. */
    function notFound(res, title, text, action) {
        return res.status(404).render('account/notice', {
            title, text, action, variant: 'danger', loggedIn: true, page: 'admin-tickets',
        });
    }

    function loadTicket(req, res, next) {
        const number = safeTicketNumber(req.params.number);
        const ticket = number ? ticketStore.getByNumber(number) : null;
        if (!ticket) {
            if (req.files?.length) attachmentStore.discardUploads(req.files);
            // Formular-Posts (Antwort, Eigenschaften …) wie bisher knapp
            if (req.method !== 'GET') return res.status(404).send('Ticket nicht gefunden');
            return notFound(res, 'Ticket nicht gefunden', 'Dieses Ticket gibt es nicht (mehr) — vielleicht wurde es gelöscht.',
                { href: '/admin/tickets', label: 'Zum Posteingang' });
        }
        req.ticket = ticket;
        next();
    }

    /* Was im Audit-Log als Vorher/Nachher eines Tickets auftaucht. */
    function snapshot(ticket) {
        return {
            status: ticket.status, priority: ticket.priority, category: ticket.categoryName ?? null,
            tags: ticket.tags, isoFile: ticket.isoFile ?? null,
            snoozedUntil: ticket.snoozedUntil ? new Date(ticket.snoozedUntil).toISOString() : null,
        };
    }

    /* Ein Audit-Eintrag je geaendertem Ticket, mit den geaenderten Feldern
       (lib/event-store.js diff()) — nichts, wenn sich nichts geaendert hat. */
    function logTicketChange(req, before, extra = {}) {
        const after = ticketStore.getTicket(before.id);
        const changes = after && diff(snapshot(before), snapshot(after));
        if (changes) auditLog.log('ticket_updated', { ip: req.ip, ticket: before.number, changes, ...extra });
        return changes;
    }

    function listQuery(query) {
        const view = Object.hasOwn(ADMIN_VIEWS, query.view) ? query.view : 'active';
        return {
            view,
            q: textField(query.q, 200),
            categoryId: Number(query.category) || null,
            priority: PRIORITIES.includes(query.priority) ? query.priority : null,
            // Wiedervorlagen standardmaessig nach Faelligkeit
            sort: Object.hasOwn(SORTS, query.sort) ? query.sort : (view === 'snoozed' ? 'snooze' : 'updated'),
            page: Math.max(1, Number(query.page) || 1),
            isoFile: safeIsoName(query.file),
        };
    }

    /* Alte Prototyp-URLs (Mails, Lesezeichen) weiterleiten. */
    app.get('/admin-tickets', checkAuth, (req, res) => res.redirect(301, '/admin/tickets'));
    app.get('/admin-tickets/:id', checkAuth, (req, res) => res.redirect(301, '/admin/tickets'));

    /* ----------------------------------------------------- Posteingang -- */

    app.get('/admin/tickets', checkAuth, (req, res) => {
        const filters = listQuery(req.query);
        const result = ticketStore.listTickets({ ...filters, perPage: 25 });
        res.render('admin/tickets', {
            ...result, filters,
            counts: ticketStore.countViews(),
            categories: configStore.listCategories(),
            stats: ticketStore.stats(),
            bulkDone: Number(req.query.bulk) || 0,
            snoozePresets: snoozePresets(clock),
            latestActivity: ticketStore.latestActivity(),
        });
    });

    /* Kleiner Puls fuer den "Neue Aktivitaet"-Hinweis im Posteingang. */
    app.get('/admin/tickets/pulse', checkAuth, limiters.poll, (req, res) => {
        res.json({ latest: ticketStore.latestActivity(), counts: ticketStore.countViews() });
    });

    app.post('/admin/tickets/bulk', checkAuth, (req, res) => {
        const raw = [].concat(req.body.numbers ?? []);
        const numbers = [...new Set(raw.map(safeTicketNumber).filter(Boolean))].slice(0, MAX_BULK_TICKETS);
        const action = String(req.body.action ?? '');
        const back = safeReturn(req.body.returnTo);
        if (numbers.length === 0) return res.redirect(303, back);

        let done = 0;
        for (const number of numbers) {
            const ticket = ticketStore.getByNumber(number);
            if (!ticket) continue;
            if (action.startsWith('status:')) {
                const status = safeTicketStatus(action.slice(7));
                const change = status && ticketStore.setStatus(ticket.id, status, { actor: 'admin' });
                if (change?.changed) {
                    ticketMail.statusChanged(change.ticket, change.from, change.to, 'admin');
                    done += 1;
                }
            } else if (action.startsWith('priority:')) {
                const priority = safeTicketPriority(action.slice(9));
                if (priority && ticketStore.setPriority(ticket.id, priority)) done += 1;
            } else if (action === 'read') {
                ticketStore.markRead(ticket.id, 'admin');
                done += 1;
            } else if (action.startsWith('snooze:')) {
                // Nur die festen Vorgaben — ein eigener Zeitpunkt gehoert in
                // die Einzelansicht.
                const until = presetUntil(action.slice(7), clock);
                if (until && ticketStore.snooze(ticket.id, until, { label: clock.formatDateTime(until) })) done += 1;
            } else if (action === 'unsnooze') {
                if (ticketStore.unsnooze(ticket.id, { reason: 'admin' })) done += 1;
            }
            logTicketChange(req, ticket, { bulk: true });
        }
        auditLog.log('ticket_bulk', { ip: req.ip, action, count: done });
        res.redirect(303, `${back}${back.includes('?') ? '&' : '?'}bulk=${done}`);
    });

    // Nur zurueck in den Posteingang, nie eine beliebige URL.
    function safeReturn(value) {
        const raw = String(value ?? '');
        return /^\/admin\/tickets(\?[\w\-=&%.+*]*)?$/.test(raw) ? raw.replace(/([?&])bulk=\d+&?/, '$1').replace(/[?&]$/, '') : '/admin/tickets';
    }

    /* ------------------------------------- Ticket fuer Kunden anlegen --
       Vor /admin/tickets/:number registriert, sonst griffe die dortige
       Nummernpruefung "new" ab (404). */

    function findTargetCustomer(input) {
        const id = safeCustomerId(input.customerId);
        if (id) return customerStore.getCustomer(id);
        const email = safeEmail(input.customerEmail);
        return email ? customerStore.findByEmail(email) : null;
    }

    async function renderNewTicket(req, res, { status = 200, error = null, values = {} } = {}) {
        try {
            const customer = findTargetCustomer({ customerId: values.customerId ?? req.query.customer });
            // Wie im Antwortfeld eines Tickets: Anrede + Grussformel vorbelegt.
            const replyDraft = await replyDraftFor({ requesterName: '' }, customer);
            res.status(status).render('admin/ticket-new', {
                error,
                customer,
                replyDraft,
                values: {
                    customerEmail: customer?.email ?? '',
                    subject: '', message: replyDraft.value, note: '', priority: 'normal', categoryId: null,
                    isoFile: safeIsoName(req.query.file) ?? '', statusAfter: 'pending',
                    ...values,
                },
                categories: configStore.listCategories(),
                isoFiles: await listIsoFileNames(),
                maxFiles: attachmentStore.maxFiles,
                maxMb: Math.round(attachmentStore.maxBytes / 1024 / 1024),
                mailEnabled: outbox.enabled,
                statusOptions: NEW_TICKET_STATUSES.map(key => [key, STATUS_LABELS[key]]),
            });
        } catch (err) {
            req.next(err);
        }
    }

    app.get('/admin/tickets/new', checkAuth, (req, res) => renderNewTicket(req, res));

    app.post('/admin/tickets/new', checkAuth, withAttachments, async (req, res, next) => {
        const files = req.files || [];
        const values = {
            customerId: safeCustomerId(req.body.customerId) ?? '',
            customerEmail: lineField(req.body.customerEmail, 254),
            subject: lineField(req.body.subject, MAX_SUBJECT_LENGTH),
            message: textField(req.body.message, MAX_MESSAGE_LENGTH),
            note: textField(req.body.note, MAX_MESSAGE_LENGTH),
            priority: safeTicketPriority(req.body.priority) ?? 'normal',
            categoryId: Number(req.body.categoryId) || null,
            isoFile: String(req.body.isoFile ?? '').trim(),
            statusAfter: NEW_TICKET_STATUSES.includes(req.body.statusAfter) ? req.body.statusAfter : 'pending',
        };
        const fail = async error => {
            await attachmentStore.discardUploads(files);
            renderNewTicket(req, res, { status: 400, error, values });
        };
        if (req.attachmentError) return fail(req.attachmentError);
        const customer = findTargetCustomer(values);
        if (!customer) return fail('Zu dieser E-Mail-Adresse gibt es kein Kundenkonto.');
        if (!customer.emailVerified || customer.disabled) {
            return fail('Tickets lassen sich nur für bestätigte, nicht gesperrte Kundenkonten anlegen.');
        }
        if (!values.subject) return fail('Bitte einen Betreff angeben.');
        // Nur die unveraenderte Vorbelegung zaehlt nicht als Nachricht — mit
        // dem Namen des Kontos oder ohne (Kunde erst per E-Mail-Feld gewaehlt).
        const drafts = await Promise.all([customer, null].map(c => replyDraftFor({ requesterName: '' }, c)));
        if (drafts.some(draft => isOnlyTemplate(values.message, draft.value))) {
            return fail('Bitte eine Nachricht an den Kunden eingeben.');
        }
        const category = values.categoryId ? configStore.getCategory(values.categoryId) : null;
        if (values.categoryId && !category) return fail('Bitte eine gültige Kategorie wählen.');
        const isoFile = values.isoFile ? safeIsoName(values.isoFile) : null;
        if (values.isoFile && !isoFile) return fail('Ungültiger Dateiname.');

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
                committed = await attachmentStore.commit(inspected, () => ticketStore.createTicket({
                    customer, subject: values.subject, body: values.message, priority: values.priority,
                    categoryId: category?.id ?? null, author: 'admin', source: 'admin', isoFile,
                    statusAfter: values.statusAfter,
                }));
            } catch (err) {
                if (err instanceof AttachmentError) return fail(err.message);
                throw err;
            }
            const { result: { ticket, message }, stored } = committed;
            if (values.note) ticketStore.addNote(ticket.id, { body: values.note });
            auditLog.log('ticket_created_by_admin', {
                ip: req.ip, ticket: ticket.number, customerId: customer.id, status: ticket.status,
            });
            ticketMail.ticketOpenedBySupport(ticketStore.getTicket(ticket.id), message, stored);
            res.redirect(303, `/admin/tickets/${ticket.number}?created=1`);
        } catch (err) {
            await attachmentStore.discardUploads(files);
            next(err);
        }
    });

    /* ---------------------------------------------------------- Detail -- */

    /* Vorbelegung des Antwortfelds mit Anrede/Grussformel: der aktuelle
       Kontoname (falls der Kunde ihn geaendert hat), sonst der Name vom
       Ticket-Eingang. */
    async function replyDraftFor(ticket, customer) {
        const template = configStore.readReplyTemplate();
        return buildReplyDraft({
            ...template,
            name: customer?.name || ticket.requesterName || '',
            agent: template.agentName || await adminUsername(),
        });
    }

    async function detailData(ticket, extra = {}) {
        const customer = ticket.customerId ? customerStore.getCustomer(ticket.customerId) : null;
        const replyDraft = await replyDraftFor(ticket, customer);
        const otherTickets = customer
            ? ticketStore.listTickets({ view: 'all', customerId: customer.id, perPage: 25 }).tickets
                .filter(other => other.id !== ticket.id)
            : [];
        // Zusammenfuehren: nur in ein anderes, noch nicht geschlossenes
        // Ticket desselben Kontos (lib/ticket-store.js mergeTickets()).
        const mergeTargets = ticket.mergedIntoId || ticket.status === 'closed'
            ? []
            : otherTickets.filter(other => other.status !== 'closed' && !other.mergedIntoId);
        const mergedInto = ticket.mergedIntoId ? ticketStore.getTicket(ticket.mergedIntoId) : null;
        const messages = ticketStore.listMessages(ticket.id, { includeInternal: true });
        // Aufteilen (lib/ticket-store.js splitTicket()): nur offene Tickets mit
        // Konto und mindestens zwei Antworten — eine muss ja bleiben.
        const canSplit = Boolean(customer) && ticket.status !== 'closed' && !ticket.mergedIntoId
            && messages.filter(message => message.kind === 'reply').length >= 2;
        const splitCandidates = canSplit
            ? messages.filter(message => message.kind !== 'event').map(message => {
                const text = message.body.replace(/\s+/g, ' ').trim();
                return {
                    id: message.id, author: message.author, kind: message.kind, createdAt: message.createdAt,
                    excerpt: text.length > SPLIT_EXCERPT_LENGTH ? `${text.slice(0, SPLIT_EXCERPT_LENGTH)}…` : text,
                    attachmentCount: message.attachments.length,
                };
            })
            : [];
        const [isoInfo, isoFiles] = await Promise.all([
            ticket.isoFile ? describeIsoFile(ticket.isoFile) : null,
            listIsoFileNames(),
        ]);
        return {
            ticket,
            customer,
            otherTickets,
            mergeTargets,
            mergedInto,
            isoInfo,
            isoFiles,
            kbArticles: kbStore.list({ publishedOnly: true, limit: 100 }),
            publicUrl,
            created: false,
            merged: null,
            mergeError: null,
            canSplit,
            splitCandidates,
            splitFrom: ticket.splitFromId ? ticketStore.getTicket(ticket.splitFromId) : null,
            splitChildren: ticketStore.listSplitChildren(ticket.id),
            split: null,
            splitError: null,
            splitValues: {
                messageIds: [], subject: ticket.subject, priority: ticket.priority, categoryId: ticket.categoryId,
            },
            messages,
            categories: configStore.listCategories(),
            canned: configStore.listCanned(),
            maxFiles: attachmentStore.maxFiles,
            maxMb: Math.round(attachmentStore.maxBytes / 1024 / 1024),
            replyError: null,
            deleteError: null,
            propertiesSaved: false,
            snoozePresets: snoozePresets(clock),
            snoozeError: null,
            snoozeValues: { until: clock.toLocalInput(ticket.snoozedUntil ?? presetUntil('tomorrow', clock)), note: '' },
            draft: replyDraft.value,
            replyDraft,
            mailEnabled: outbox.enabled,
            ...extra,
        };
    }

    app.get('/admin/tickets/:number', checkAuth, loadTicket, async (req, res, next) => {
        // Zusammengefuehrt: die alte Nummer (Lesezeichen, Mails) fuehrt ins Ziel
        if (req.ticket.mergedIntoId) {
            const target = ticketStore.getTicket(req.ticket.mergedIntoId);
            if (target) return res.redirect(301, `/admin/tickets/${target.number}`);
        }
        try {
            if (req.ticket.adminUnread) {
                ticketStore.markRead(req.ticket.id, 'admin');
                // Wie beim Kunden: der Navigations-Zaehler stammt von vor dem Lesen.
                res.locals.adminTicketBadge = ticketStore.countViews().unread;
            }
            res.render('admin/ticket', await detailData(req.ticket, {
                propertiesSaved: req.query.saved === '1', created: req.query.created === '1',
                snoozeNotice: ['set', 'cleared'].includes(req.query.snooze) ? req.query.snooze : null,
                merged: safeTicketNumber(req.query.merged),
                split: safeTicketNumber(req.query.split),
            }));
        } catch (err) {
            next(err);
        }
    });

    app.get('/admin/tickets/:number/updates', checkAuth, limiters.poll, loadTicket, async (req, res, next) => {
        const since = Number(req.query.since) || 0;
        if (req.ticket.updatedAt <= since) return res.json({ changed: false, updatedAt: req.ticket.updatedAt });
        try {
            // Wie auf der Kundenseite: was live im offenen Ticket erscheint,
            // hat der Admin gesehen — sonst bliebe es im Posteingang "ungelesen".
            // (ticket-live.js fragt nur bei sichtbarem Tab.)
            if (req.ticket.adminUnread) ticketStore.markRead(req.ticket.id, 'admin');
            const data = await detailData(req.ticket);
            const [threadHtml, statusHtml] = await Promise.all([
                renderPartial('partials/ticket-thread', { ...data, viewer: 'admin' }),
                renderPartial('partials/ticket-status-badge', { ticket: req.ticket, viewer: 'admin' }),
            ]);
            res.json({ changed: true, updatedAt: req.ticket.updatedAt, status: req.ticket.status, threadHtml, statusHtml });
        } catch (err) {
            next(err);
        }
    });

    app.post('/admin/tickets/:number/reply', checkAuth, withAttachments, loadTicket, async (req, res, next) => {
        const { ticket } = req;
        const files = req.files || [];
        const mode = req.body.mode === 'note' ? 'note' : 'reply';
        const body = textField(req.body.message, MAX_MESSAGE_LENGTH);
        // Nur was der Composer anbietet: "Neu" heisst "noch keine Antwort
        // vom Support" und passt nach einer Antwort/Notiz nie.
        const statusAfter = REPLY_STATUSES_AFTER.includes(req.body.statusAfter) ? req.body.statusAfter : null;
        // composer.js schickt per fetch mit Accept: application/json und
        // aktualisiert den Verlauf selbst — ohne Seitenwechsel und ohne
        // Sprung. Ohne JS bleibt es beim Redirect.
        const json = wantsJson(req);
        const fail = async error => {
            try {
                await attachmentStore.discardUploads(files);
                if (json) return res.status(400).json({ error });
                res.status(400).render('admin/ticket', await detailData(ticket, { replyError: error, ...(body ? { draft: body } : {}) }));
            } catch (err) {
                next(err);
            }
        };
        if (req.attachmentError) return fail(req.attachmentError);
        if (ticket.mergedIntoId) {
            const target = ticketStore.getTicket(ticket.mergedIntoId);
            return fail(target
                ? `Dieses Ticket wurde in #${target.number} zusammengeführt — bitte dort antworten.`
                : 'Dieses Ticket wurde zusammengeführt und nimmt keine Nachrichten mehr an.');
        }
        try {
            // Nur die unveraenderte Vorbelegung (Anrede + Grussformel) zaehlt
            // nicht als Nachricht — ausser es haengen Dateien dran (wie auf
            // der Kundenseite: ein Anhang allein ist eine Nachricht).
            const customer = ticket.customerId ? customerStore.getCustomer(ticket.customerId) : null;
            if (files.length === 0 && isOnlyTemplate(body, (await replyDraftFor(ticket, customer)).value)) {
                return fail('Bitte eine Nachricht eingeben.');
            }
            const text = body || '(Anhang)';
            let inspected;
            try {
                inspected = await attachmentStore.inspectUploads(files);
            } catch (err) {
                if (err instanceof AttachmentError) return fail(err.message);
                throw err;
            }

            let committed;
            try {
                committed = await attachmentStore.commit(inspected, () => (mode === 'note'
                    ? ticketStore.addNote(ticket.id, { body: text })
                    : ticketStore.addReply(ticket.id, { author: 'admin', body: text, statusAfter: statusAfter ?? 'pending' })));
            } catch (err) {
                if (err instanceof AttachmentError) return fail(err.message);
                throw err;
            }
            if (!committed.result) return fail('Dieses Ticket nimmt keine Nachrichten mehr an.');
            const { result, stored } = committed;
            const { message } = result;
            if (mode === 'note') {
                auditLog.log('ticket_note_added', { ip: req.ip, ticket: ticket.number, attachments: stored.length });
                if (statusAfter && statusAfter !== ticket.status) {
                    const change = ticketStore.setStatus(ticket.id, statusAfter, { actor: 'admin' });
                    if (change?.changed) ticketMail.statusChanged(change.ticket, change.from, change.to, 'admin');
                }
            } else {
                auditLog.log('ticket_replied', { ip: req.ip, ticket: ticket.number, via: 'admin' });
                // Eine Mail, nicht zwei: adminReplied() nennt den neuen Status
                // (inkl. Bewertungs-Link bei "geloest") bereits selbst.
                ticketMail.adminReplied(result.ticket, message, stored);
            }
            if (json) return res.json({ ok: true, messageId: message.id });
            res.redirect(303, `/admin/tickets/${ticket.number}#message-${message.id}`);
        } catch (err) {
            await attachmentStore.discardUploads(files);
            next(err);
        }
    });

    app.post('/admin/tickets/:number/properties', checkAuth, loadTicket, (req, res) => {
        const { ticket } = req;
        const status = safeTicketStatus(req.body.status);
        const priority = safeTicketPriority(req.body.priority);
        if (status && status !== ticket.status) {
            const change = ticketStore.setStatus(ticket.id, status, { actor: 'admin' });
            if (change?.changed) ticketMail.statusChanged(change.ticket, change.from, change.to, 'admin');
        }
        if (priority) ticketStore.setPriority(ticket.id, priority);
        if (req.body.categoryId !== undefined) {
            const category = configStore.getCategory(req.body.categoryId);
            ticketStore.setCategory(ticket.id, category?.id ?? null, category?.name ?? null);
        }
        if (req.body.tags !== undefined) {
            ticketStore.setTags(ticket.id, String(req.body.tags).split(',').map(tag => tag.slice(0, 30)));
        }
        if (req.body.isoFile !== undefined) {
            // Nur Namen, die das Dateinamen-Schema erfuellen; ob die Datei
            // (noch) existiert, spielt hier keine Rolle — ein Ticket darf
            // sich auf eine inzwischen geloeschte Datei beziehen.
            const raw = String(req.body.isoFile).trim();
            const isoFile = raw ? safeIsoName(raw) : null;
            if (!raw || isoFile) ticketStore.setIsoFile(ticket.id, isoFile);
        }
        logTicketChange(req, ticket);
        res.redirect(303, `/admin/tickets/${ticket.number}?saved=1`);
    });

    /* Wiedervorlage setzen (Vorgabe oder eigener Zeitpunkt in APP_TIMEZONE,
       siehe lib/snooze.js) bzw. aufheben. Nur fuer aktive Tickets — ein
       geloestes/geschlossenes Ticket hat nichts, woran es erinnern koennte. */
    app.post('/admin/tickets/:number/snooze', checkAuth, loadTicket, async (req, res, next) => {
        const { ticket } = req;
        const note = textField(req.body.note, MAX_SNOOZE_NOTE);
        const fail = async error => {
            try {
                res.status(400).render('admin/ticket', await detailData(ticket, {
                    snoozeError: error,
                    snoozeValues: { until: String(req.body.until ?? ''), note },
                }));
            } catch (err) {
                next(err);
            }
        };
        if (ticket.mergedIntoId || !['new', 'open', 'pending'].includes(ticket.status)) {
            return fail('Nur offene Tickets lassen sich auf Wiedervorlage legen.');
        }
        const parsed = parseSnoozeInput({ preset: req.body.preset, until: req.body.until }, clock);
        if (parsed.error) return fail(parsed.error);
        const updated = ticketStore.snooze(ticket.id, parsed.until, { label: clock.formatDateTime(parsed.until), note });
        if (!updated) return fail('Die Wiedervorlage ließ sich nicht setzen.');
        auditLog.log('ticket_snoozed', {
            ip: req.ip, ticket: ticket.number, until: new Date(parsed.until).toISOString(), note: Boolean(note),
        });
        res.redirect(303, `/admin/tickets/${ticket.number}?snooze=set`);
    });

    app.post('/admin/tickets/:number/unsnooze', checkAuth, loadTicket, (req, res) => {
        if (ticketStore.unsnooze(req.ticket.id, { reason: 'admin' })) {
            auditLog.log('ticket_unsnoozed', { ip: req.ip, ticket: req.ticket.number });
        }
        res.redirect(303, `/admin/tickets/${req.ticket.number}?snooze=cleared`);
    });

    /* Dieses Ticket (Quelle) in ein anderes desselben Kunden zusammenfuehren.
       Die Bestaetigungs-Checkbox ersetzt einen JS-Dialog — geht auch ohne JS. */
    app.post('/admin/tickets/:number/merge', checkAuth, loadTicket, async (req, res, next) => {
        const source = req.ticket;
        try {
            const target = ticketStore.getByNumber(safeTicketNumber(req.body.target));
            const fail = async error => res.status(400).render('admin/ticket', await detailData(source, { mergeError: error }));
            if (req.body.confirm !== '1') return fail('Bitte das Zusammenführen bestätigen.');
            if (!target) return fail(MERGE_ERRORS.not_found);
            const result = ticketStore.mergeTickets(source.id, target.id);
            if (result.error) return fail(MERGE_ERRORS[result.error] ?? 'Zusammenführen nicht möglich.');
            auditLog.log('ticket_merged', { ip: req.ip, ticket: source.number, into: target.number });
            ticketMail.ticketMerged(result.source, result.target);
            res.redirect(303, `/admin/tickets/${target.number}?merged=${source.number}`);
        } catch (err) {
            next(err);
        }
    });

    /* Ausgewaehlte Nachrichten dieses Tickets in ein neues Ticket desselben
       Kunden verschieben — das Gegenstueck zum Zusammenfuehren. Auch hier
       ersetzt die Bestaetigungs-Checkbox einen JS-Dialog. */
    app.post('/admin/tickets/:number/split', checkAuth, loadTicket, async (req, res, next) => {
        const source = req.ticket;
        try {
            const messageIds = [...new Set([].concat(req.body.messageIds ?? [])
                .map(Number).filter(id => Number.isInteger(id) && id > 0))].slice(0, MAX_SPLIT_MESSAGES);
            const category = req.body.categoryId ? configStore.getCategory(req.body.categoryId) : null;
            const values = {
                messageIds,
                subject: lineField(req.body.subject, MAX_SUBJECT_LENGTH),
                priority: safeTicketPriority(req.body.priority) ?? source.priority,
                categoryId: category?.id ?? null,
            };
            const fail = async error => res.status(400)
                .render('admin/ticket', await detailData(source, { splitError: error, splitValues: values }));
            if (!values.subject) return fail('Bitte einen Betreff für das neue Ticket angeben.');
            if (req.body.confirm !== '1') return fail('Bitte das Aufteilen bestätigen.');
            const result = ticketStore.splitTicket(source.id, values);
            if (result.error) return fail(SPLIT_ERRORS[result.error] ?? 'Aufteilen nicht möglich.');
            auditLog.log('ticket_split', {
                ip: req.ip, ticket: source.number, into: result.target.number, messages: result.moved,
            });
            ticketMail.ticketSplit(result.source, result.target);
            res.redirect(303, `/admin/tickets/${result.target.number}?split=${source.number}`);
        } catch (err) {
            next(err);
        }
    });

    app.post('/admin/tickets/:number/delete', checkAuth, loadTicket, async (req, res, next) => {
        try {
            if (safeTicketNumber(req.body.confirm) !== req.ticket.number) {
                return res.status(400).render('admin/ticket', await detailData(req.ticket, {
                    deleteError: 'Zum Löschen bitte die Ticketnummer zur Bestätigung eingeben.',
                }));
            }
            const attachmentIds = ticketStore.deleteTicket(req.ticket.id) ?? [];
            await attachmentStore.removeFiles(attachmentIds);
            outbox.forgetTicket(req.ticket.id);
            auditLog.log('ticket_deleted', { ip: req.ip, ticket: req.ticket.number });
            res.redirect(303, '/admin/tickets');
        } catch (err) {
            next(err);
        }
    });

    /* ------------------------------------------------------------ Kunden -- */

    app.get('/admin/customers', checkAuth, (req, res) => {
        const q = textField(req.query.q, 200);
        const page = Math.max(1, Number(req.query.page) || 1);
        const perPage = 50;
        const { customers, total, page: current } = customerStore.listCustomers({ q, page, perPage });
        res.render('admin/customers', {
            customers, total, q, page: current, pages: Math.max(1, Math.ceil(total / perPage)), mailEnabled: outbox.enabled,
            done: String(req.query.done ?? ''),
        });
    });

    function loadCustomer(req, res, next) {
        const id = safeCustomerId(req.params.id);
        const customer = id ? customerStore.getCustomer(id) : null;
        if (!customer) {
            if (req.method !== 'GET') return res.status(404).send('Kunde nicht gefunden');
            return notFound(res, 'Kunde nicht gefunden', 'Dieses Kundenkonto gibt es nicht (mehr).',
                { href: '/admin/customers', label: 'Zur Kundenliste' });
        }
        req.targetCustomer = customer;
        next();
    }

    app.get('/admin/customers/:id', checkAuth, loadCustomer, (req, res) => {
        const customer = req.targetCustomer;
        res.render('admin/customer', {
            customer,
            tickets: ticketStore.listTickets({ view: 'all', customerId: customer.id, perPage: 100 }).tickets,
            mailEnabled: outbox.enabled,
            done: String(req.query.done ?? ''),
            error: null,
        });
    });

    app.post('/admin/customers/:id/:action', checkAuth, loadCustomer, async (req, res, next) => {
        const customer = req.targetCustomer;
        const back = `/admin/customers/${customer.id}`;
        try {
            switch (req.params.action) {
            case 'verify':
                customerStore.markVerified(customer.id);
                claimTickets(customer);
                break;
            case 'disable':
                customerStore.setDisabled(customer.id, true);
                sessionStore.destroyForCustomer(customer.id);
                break;
            case 'enable':
                customerStore.setDisabled(customer.id, false);
                break;
            case 'resend':
                if (!customer.emailVerified) {
                    ticketMail.verifyEmail(customer, customerStore.issueToken(customer.id, 'verify', { ttlMs: verifyTtlMs }));
                }
                break;
            case 'delete':
                if (String(req.body.confirm ?? '').trim().toLowerCase() !== customer.email) {
                    return res.status(400).render('admin/customer', {
                        customer,
                        tickets: ticketStore.listTickets({ view: 'all', customerId: customer.id, perPage: 100 }).tickets,
                        mailEnabled: outbox.enabled, done: '',
                        error: 'Zum Löschen bitte die E-Mail-Adresse des Kontos zur Bestätigung eingeben.',
                    });
                }
                await deleteCustomerCompletely(customer);
                auditLog.log('customer_deleted', { ip: req.ip, customerId: customer.id, by: 'admin' });
                return res.redirect(303, '/admin/customers?done=deleted');
            default:
                return res.status(404).send('Unbekannte Aktion');
            }
            auditLog.log(`customer_${req.params.action}`, { ip: req.ip, customerId: customer.id, by: 'admin' });
            res.redirect(303, `${back}?done=${req.params.action}`);
        } catch (err) {
            next(err);
        }
    });

    /* ---------------------------------------------------- Einstellungen -- */

    /* Async wegen des Admin-Benutzernamens (Fallback fuer {agent}); Fehler
       gehen selbst an next(), damit die vielen Aufrufer unten nichts
       awaiten muessen. */
    async function renderSettings(req, res, {
        status = 200, error = null, success = null, replyTemplate = null, slaValues = null,
    } = {}) {
        let fallbackAgent;
        try {
            fallbackAgent = await adminUsername();
        } catch (err) {
            return req.next(err);
        }
        const template = replyTemplate ?? configStore.readReplyTemplate();
        const preview = buildReplyDraft({ ...template, name: 'Max Mustermann', agent: template.agentName || fallbackAgent });
        res.status(status).render('admin/ticket-settings', {
            replyTemplate: template,
            replyTemplateLimits: REPLY_TEMPLATE_LIMITS,
            replyTemplatePreview: preview.value.slice(0, preview.caret) + '…' + preview.value.slice(preview.caret),
            fallbackAgent,
            categories: configStore.listCategories(),
            canned: configStore.listCanned(),
            settings: configStore.readSettings(),
            limits: SETTINGS_LIMITS,
            sla: slaValues ?? configStore.readSla(),
            slaMaxHours: SLA_MAX_HOURS,
            inboundNewTickets,
            outboxCounts: outbox.counts(),
            outboxMails: outbox.list({ limit: 30 }),
            mailEnabled: outbox.enabled,
            mailFrom: mailer.from,
            mailSecurity: mailer.security,
            notifyEmail,
            publicUrl,
            imap: { enabled: inboundEnabled, mailbox: imapPoller.mailbox, ...imapPoller.status },
            attachmentTotals: attachmentStore.totals(),
            error,
            success: success ?? ({
                automation: 'Automatik gespeichert.', category: 'Kategorien aktualisiert.', sla: 'Antwortfristen gespeichert.',
                canned: 'Textbausteine aktualisiert.', template: 'Anrede & Grußformel gespeichert.',
                test: 'Testmail wurde in die Warteschlange gelegt.',
                retry: 'Mail wird erneut versucht.', imap: 'Postfach wurde abgerufen.',
            }[req.query.saved] ?? null),
        });
    }

    app.get('/admin/ticket-settings', checkAuth, (req, res) => renderSettings(req, res));

    app.post('/admin/ticket-settings/reply-template', checkAuth, (req, res) => {
        const result = configStore.updateReplyTemplate(req.body);
        if (result.error) {
            return renderSettings(req, res, { status: 400, error: result.error, replyTemplate: {
                greeting: String(req.body.greeting ?? ''), signature: String(req.body.signature ?? ''),
                agentName: String(req.body.agentName ?? ''),
            } });
        }
        auditLog.log('ticket_reply_template_changed', { ip: req.ip });
        res.redirect(303, '/admin/ticket-settings?saved=template#reply-template');
    });

    app.post('/admin/ticket-settings/automation', checkAuth, (req, res) => {
        const result = configStore.updateSettings(req.body);
        if (result.error) return renderSettings(req, res, { status: 400, error: result.error });
        auditLog.log('ticket_settings_changed', { ip: req.ip, ...result.settings });
        res.redirect(303, '/admin/ticket-settings?saved=automation#automation');
    });

    app.post('/admin/ticket-settings/sla', checkAuth, (req, res) => {
        const before = configStore.readSla();
        const result = configStore.updateSla(req.body);
        if (result.error) return renderSettings(req, res, { status: 400, error: result.error });
        auditLog.log('ticket_sla_changed', { ip: req.ip, changes: diff(before, result.sla) });
        res.redirect(303, '/admin/ticket-settings?saved=sla#sla');
    });

    app.post('/admin/ticket-settings/categories', checkAuth, (req, res) => {
        const name = textField(req.body.name, 60);
        if (!name) return renderSettings(req, res, { status: 400, error: 'Bitte einen Kategorienamen angeben.' });
        if (!configStore.addCategory(name)) {
            return renderSettings(req, res, { status: 400, error: 'Diese Kategorie gibt es schon.' });
        }
        res.redirect(303, '/admin/ticket-settings?saved=category#categories');
    });

    app.post('/admin/ticket-settings/categories/:id', checkAuth, (req, res) => {
        if (req.body.delete === '1') {
            configStore.deleteCategory(req.params.id);
        } else {
            const name = textField(req.body.name, 60);
            if (!name || !configStore.renameCategory(req.params.id, name)) {
                return renderSettings(req, res, { status: 400, error: 'Kategorie konnte nicht umbenannt werden (leer oder doppelt).' });
            }
        }
        res.redirect(303, '/admin/ticket-settings?saved=category#categories');
    });

    app.post('/admin/ticket-settings/canned', checkAuth, (req, res) => {
        const title = textField(req.body.title, 80);
        const body = textField(req.body.body, MAX_MESSAGE_LENGTH);
        if (!title || !body) return renderSettings(req, res, { status: 400, error: 'Textbaustein braucht Titel und Text.' });
        configStore.addCanned({ title, body });
        res.redirect(303, '/admin/ticket-settings?saved=canned#canned');
    });

    app.post('/admin/ticket-settings/canned/:id', checkAuth, (req, res) => {
        if (req.body.delete === '1') {
            configStore.deleteCanned(req.params.id);
        } else {
            const title = textField(req.body.title, 80);
            const body = textField(req.body.body, MAX_MESSAGE_LENGTH);
            if (!title || !body) return renderSettings(req, res, { status: 400, error: 'Textbaustein braucht Titel und Text.' });
            configStore.updateCanned(req.params.id, { title, body });
        }
        res.redirect(303, '/admin/ticket-settings?saved=canned#canned');
    });

    app.post('/admin/mail/test', checkAuth, (req, res) => {
        const to = safeEmail(req.body.to) ?? notifyEmail;
        if (!outbox.enabled) return renderSettings(req, res, { status: 400, error: 'Mailversand ist nicht konfiguriert (SMTP_HOST fehlt).' });
        if (!to) return renderSettings(req, res, { status: 400, error: 'Bitte eine Empfängeradresse angeben.' });
        ticketMail.testMail(to);
        auditLog.log('mail_test', { ip: req.ip });
        res.redirect(303, '/admin/ticket-settings?saved=test#mail');
    });

    app.post('/admin/mail/outbox/:id/retry', checkAuth, (req, res) => {
        outbox.retry(req.params.id);
        res.redirect(303, '/admin/ticket-settings?saved=retry#mail');
    });

    app.post('/admin/mail/imap/poll', checkAuth, async (req, res, next) => {
        try {
            await imapPoller.pollOnce();
            res.redirect(303, '/admin/ticket-settings?saved=imap#mail');
        } catch (err) {
            next(err);
        }
    });
}

module.exports = { registerAdminTicketRoutes };
