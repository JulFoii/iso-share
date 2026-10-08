'use strict';

/* Einheitentests des Ticketsystems (lib/customer-store.js, ticket-store.js,
   attachment-store.js, mail-*.js, imap-poller.js, ticket-automation.js) —
   kein Server, kein Netz, kein echter Mailserver. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const { openDatabase } = require('../lib/db');
const { createCustomerStore } = require('../lib/customer-store');
const { createTicketStore } = require('../lib/ticket-store');
const { createTicketConfigStore } = require('../lib/ticket-config-store');
const { createAttachmentStore, AttachmentError, detectType, sanitizeFilename } = require('../lib/attachment-store');
const { createMailer } = require('../lib/mailer');
const { createMailOutbox, classifyError, MAX_ATTEMPTS } = require('../lib/mail-outbox');
const { compose, stripQuotedReply } = require('../lib/mail-templates');
const { createTicketMail } = require('../lib/ticket-mail');
const { createInboundProcessor, htmlToText } = require('../lib/mail-inbound');
const { createImapPoller, parseHeaders, isAutoSubmitted, walkStructure } = require('../lib/imap-poller');
const { createTicketAutomation, DAY_MS } = require('../lib/ticket-automation');
const {
    formatMessage, safeNextPath, checkPasswordStrength, lineField, contentDisposition, relativeTime,
} = require('../lib/routes/helpers');
const { REPLY_TEMPLATE_DEFAULTS, buildReplyDraft, isOnlyTemplate } = require('../lib/reply-template');
const {
    safeTicketNumber, safeTicketStatus, safeTicketPriority, safeCustomerToken, safeDisplayName, safeEmail,
    safeAttachmentId,
} = require('../lib/safe-name');

const QUIET = { log() {}, warn() {}, error() {} };
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

async function tempDir() {
    return fsp.mkdtemp(path.join(os.tmpdir(), 'iso-share-tickets-'));
}

/* Alle Stores auf einer In-Memory-DB, Mails landen in `sent`. */
function setup({ mailEnabled = true, notifyEmail = 'admin@example.com', inboundEnabled = true } = {}) {
    const db = openDatabase(':memory:');
    const sent = [];
    const mailer = mailEnabled
        ? createMailer({ transport: { sendMail: async mail => { sent.push(mail); } }, from: 'support@iso.test', log: QUIET })
        : createMailer({ log: QUIET });
    const customerStore = createCustomerStore({ db });
    const ticketStore = createTicketStore({ db });
    const configStore = createTicketConfigStore({ db });
    const outbox = createMailOutbox({ db, mailer, log: QUIET });
    const ticketMail = createTicketMail({
        outbox, customerStore, publicUrl: 'https://support.test/', notifyEmail, replyTo: 'support@iso.test',
        threadSecret: 'geheim', domain: 'iso.test', inboundEnabled,
    });
    return { db, sent, mailer, customerStore, ticketStore, configStore, outbox, ticketMail };
}

async function makeCustomer(customerStore, email = 'kunde@example.com', { verified = true } = {}) {
    const customer = await customerStore.createCustomer({ email, name: 'Kim Kunde', password: 'ein-langes-passwort' });
    if (verified) customerStore.markVerified(customer.id);
    return customerStore.getCustomer(customer.id);
}

/* ======================================================= customer-store */

test('customer-store: Adresse wird normalisiert, doppelte Registrierung abgelehnt', async () => {
    const { customerStore } = setup();
    const customer = await customerStore.createCustomer({ email: '  Kim@Example.COM ', name: ' Kim ', password: 'x'.repeat(12) });
    assert.equal(customer.email, 'kim@example.com');
    assert.equal(customer.name, 'Kim');
    assert.equal(customer.emailVerified, false);
    assert.deepEqual(customer.notify, { replies: true, status: true, reminders: true });

    await assert.rejects(
        customerStore.createCustomer({ email: 'KIM@example.com', name: 'X', password: 'x'.repeat(12) }),
        err => err.code === 'email_taken'
    );
});

test('customer-store: authenticate prueft Passwort, unbekannte Adresse liefert null', async () => {
    const { customerStore } = setup();
    await makeCustomer(customerStore);
    assert.ok(await customerStore.authenticate('KUNDE@example.com', 'ein-langes-passwort'));
    assert.equal(await customerStore.authenticate('kunde@example.com', 'falsch'), null);
    assert.equal(await customerStore.authenticate('niemand@example.com', 'ein-langes-passwort'), null);
});

test('customer-store: Einmal-Token funktioniert genau einmal, nur fuer seinen Zweck, nicht abgelaufen', async () => {
    const { customerStore } = setup();
    const customer = await makeCustomer(customerStore);

    const token = customerStore.issueToken(customer.id, 'reset', { ttlMs: 60_000 });
    assert.ok(safeCustomerToken(token));
    assert.equal(customerStore.consumeToken(token, 'verify'), null, 'falscher Zweck');
    assert.equal(customerStore.peekToken(token, 'reset').id, customer.id, 'peek verbraucht nicht');
    assert.equal(customerStore.consumeToken(token, 'reset').customer.id, customer.id);
    assert.equal(customerStore.consumeToken(token, 'reset'), null, 'zweites Einloesen scheitert');

    const expired = customerStore.issueToken(customer.id, 'verify', { ttlMs: -1 });
    assert.equal(customerStore.consumeToken(expired, 'verify'), null);

    const first = customerStore.issueToken(customer.id, 'verify', { ttlMs: 60_000 });
    const second = customerStore.issueToken(customer.id, 'verify', { ttlMs: 60_000 });
    assert.equal(customerStore.consumeToken(first, 'verify'), null, 'neuer Link macht den alten ungueltig');
    assert.ok(customerStore.consumeToken(second, 'verify'));
});

test('customer-store: setEmail lehnt vergebene Adressen ab, setNotify speichert nur bekannte Schalter', async () => {
    const { customerStore } = setup();
    const a = await makeCustomer(customerStore, 'a@example.com');
    await makeCustomer(customerStore, 'b@example.com');
    assert.equal(customerStore.setEmail(a.id, 'B@example.com'), false);
    assert.equal(customerStore.setEmail(a.id, 'neu@example.com'), true);
    customerStore.setNotify(a.id, { replies: false, status: true, extra: true });
    assert.deepEqual(customerStore.getCustomer(a.id).notify, { replies: false, status: true, reminders: false });
});

/* ========================================================= ticket-store */

test('ticket-store: fortlaufende Nummern ab 1001, erste Nachricht gehoert dem Kunden', async () => {
    const { customerStore, ticketStore } = setup();
    const customer = await makeCustomer(customerStore);
    const a = ticketStore.createTicket({ customer, subject: 'A', body: 'Hallo' });
    const b = ticketStore.createTicket({ customer, subject: 'B', body: 'Hallo', priority: 'quatsch' });
    assert.equal(a.ticket.number, 1001);
    assert.equal(b.ticket.number, 1002);
    assert.equal(b.ticket.priority, 'normal');
    assert.equal(a.ticket.status, 'new');
    assert.equal(a.ticket.adminUnread, true);
    assert.equal(a.message.author, 'customer');
    assert.equal(a.ticket.requesterEmail, customer.email);
});

test('ticket-store: Statusautomat new -> pending -> open -> resolved -> (Kunde) open', async () => {
    const { customerStore, ticketStore } = setup();
    const customer = await makeCustomer(customerStore);
    const { ticket } = ticketStore.createTicket({ customer, subject: 'A', body: 'x' });

    let result = ticketStore.addReply(ticket.id, { author: 'admin', body: 'Antwort' });
    assert.equal(result.ticket.status, 'pending');
    assert.ok(result.ticket.firstResponseAt);
    assert.equal(result.ticket.customerUnread, true);
    assert.equal(result.ticket.adminUnread, false);

    result = ticketStore.addReply(ticket.id, { author: 'customer', body: 'Danke, aber …' });
    assert.equal(result.ticket.status, 'open');
    assert.equal(result.ticket.adminUnread, true);

    result = ticketStore.addReply(ticket.id, { author: 'admin', body: 'Erledigt', statusAfter: 'resolved' });
    assert.equal(result.ticket.status, 'resolved');
    assert.ok(result.ticket.resolvedAt);

    result = ticketStore.addReply(ticket.id, { author: 'customer', body: 'Doch nicht' });
    assert.equal(result.ticket.status, 'open');
    assert.equal(result.ticket.resolvedAt, null);

    const events = ticketStore.listMessages(ticket.id).filter(m => m.kind === 'event');
    assert.equal(events.length, 2, 'nur "geloest" und "wiedereroeffnet" erzeugen ein Ereignis');
});

test('ticket-store: eine Kundenantwort auf ein neues Ticket laesst es "neu"', async () => {
    const { customerStore, ticketStore } = setup();
    const customer = await makeCustomer(customerStore);
    const { ticket } = ticketStore.createTicket({ customer, subject: 'A', body: 'x' });
    assert.equal(ticketStore.addReply(ticket.id, { author: 'customer', body: 'Nachtrag' }).ticket.status, 'new');
});

test('ticket-store: interne Notizen und interne Ereignisse sind fuer den Kunden unsichtbar', async () => {
    const { customerStore, ticketStore } = setup();
    const customer = await makeCustomer(customerStore);
    const { ticket } = ticketStore.createTicket({ customer, subject: 'A', body: 'x' });
    ticketStore.addNote(ticket.id, { body: 'geheime Notiz' });
    ticketStore.setPriority(ticket.id, 'urgent');

    const all = ticketStore.listMessages(ticket.id);
    const visible = ticketStore.listMessages(ticket.id, { includeInternal: false });
    assert.equal(all.length, 3);
    assert.deepEqual(visible.map(m => m.body), ['x']);
    assert.equal(ticketStore.getTicket(ticket.id).status, 'new', 'Notiz aendert keinen Status');

    // Suche des Kunden findet den Notiztext nicht, die des Admins schon
    assert.equal(ticketStore.listTickets({ view: 'all', q: 'geheime', customerId: customer.id }).total, 0);
    assert.equal(ticketStore.listTickets({ view: 'all', q: 'geheime' }).total, 1);
});

test('ticket-store: getForCustomer liefert fremde Tickets nicht aus', async () => {
    const { customerStore, ticketStore } = setup();
    const owner = await makeCustomer(customerStore, 'owner@example.com');
    const other = await makeCustomer(customerStore, 'other@example.com');
    const { ticket } = ticketStore.createTicket({ customer: owner, subject: 'A', body: 'x' });
    assert.equal(ticketStore.getForCustomer(ticket.number, owner.id).id, ticket.id);
    assert.equal(ticketStore.getForCustomer(ticket.number, other.id), null);
    assert.equal(ticketStore.getForCustomer(9999, owner.id), null);
});

test('ticket-store: Ansichten, Zaehler, Suche nach Nummer und Paginierung', async () => {
    const { customerStore, ticketStore } = setup();
    const customer = await makeCustomer(customerStore);
    const created = [];
    for (let i = 0; i < 5; i += 1) {
        created.push(ticketStore.createTicket({ customer, subject: `Ticket ${i}`, body: `Text ${i}` }).ticket);
    }
    ticketStore.addReply(created[0].id, { author: 'admin', body: 'a' });
    ticketStore.setStatus(created[1].id, 'closed');
    ticketStore.setPriority(created[2].id, 'high');

    const counts = ticketStore.countViews();
    assert.equal(counts.all, 5);
    assert.equal(counts.active, 4);
    assert.equal(counts.pending, 1);
    assert.equal(counts.closed, 1);
    assert.equal(counts.urgent, 1);

    assert.deepEqual(ticketStore.listTickets({ view: 'all', q: `#${created[3].number}` }).tickets.map(t => t.id), [created[3].id]);
    const page = ticketStore.listTickets({ view: 'all', perPage: 2, page: 2 });
    assert.equal(page.tickets.length, 2);
    assert.equal(page.pages, 3);

    const customerCounts = ticketStore.countViews({ customerId: customer.id });
    assert.equal(customerCounts.waiting, 1);
    assert.equal(customerCounts.done, 1);
    assert.equal(ticketStore.countUnreadForCustomer(customer.id), 1, 'Antwort zaehlt, das geschlossene Ticket nicht');
});

test('ticket-store: Seite hinter dem Ende zeigt die letzte, gleiche Zeitstempel sortieren stabil', async () => {
    const { customerStore, ticketStore, db } = setup();
    const customer = await makeCustomer(customerStore);
    for (let i = 0; i < 5; i += 1) ticketStore.createTicket({ customer, subject: `Ticket ${i}`, body: 'x' });
    db.prepare('UPDATE tickets SET updated_at = 1000, created_at = 1000').run();

    const beyond = ticketStore.listTickets({ view: 'all', perPage: 2, page: 9 });
    assert.equal(beyond.page, 3);
    assert.equal(beyond.tickets.length, 1);

    const seen = [1, 2, 3].flatMap(page => ticketStore.listTickets({ view: 'all', perPage: 2, page }).tickets)
        .map(ticket => ticket.number);
    assert.deepEqual(seen, [1005, 1004, 1003, 1002, 1001]);
});

test('ticket-store: Suche nimmt % und _ woertlich und findet den Dateinamen', async () => {
    const { customerStore, ticketStore } = setup();
    const customer = await makeCustomer(customerStore);
    const underscore = ticketStore.createTicket({ customer, subject: 'debian_12 bootet nicht', body: 'x' }).ticket;
    ticketStore.createTicket({ customer, subject: 'debian 12 und 100 %', body: 'x' });
    const withFile = ticketStore.createTicket({ customer, subject: 'Frage', body: 'x', isoFile: 'arch-2026.iso' }).ticket;

    assert.deepEqual(ticketStore.listTickets({ view: 'all', q: 'debian_12' }).tickets.map(t => t.id), [underscore.id]);
    assert.equal(ticketStore.listTickets({ view: 'all', q: '100 %' }).total, 1);
    assert.equal(ticketStore.listTickets({ view: 'all', q: '%' }).total, 1, '% ist kein Platzhalter fuer alles');
    assert.deepEqual(ticketStore.listTickets({ view: 'all', q: 'arch-2026' }).tickets.map(t => t.id), [withFile.id]);
});

test('ticket-store: Durchschnitt der Erstreaktion ohne vom Support angelegte Tickets', async () => {
    const { customerStore, ticketStore, db } = setup();
    const customer = await makeCustomer(customerStore);
    const own = ticketStore.createTicket({ customer, subject: 'Kunde', body: 'x' }).ticket;
    ticketStore.addReply(own.id, { author: 'admin', body: 'y' });
    db.prepare('UPDATE tickets SET first_response_at = created_at + 3600000 WHERE id = ?').run(own.id);
    ticketStore.createTicket({ customer, subject: 'Support', body: 'x', author: 'admin' });
    assert.equal(ticketStore.stats().avgFirstResponseMs, 3600000);
});

test('customer-store: Suche nimmt _ und % woertlich, Seite hinter dem Ende zeigt die letzte', async () => {
    const { customerStore } = setup();
    await makeCustomer(customerStore, 'vor_nach@example.com');
    await makeCustomer(customerStore, 'vorxnach@example.com');
    assert.deepEqual(customerStore.listCustomers({ q: 'vor_nach' }).customers.map(c => c.email), ['vor_nach@example.com']);
    assert.equal(customerStore.listCustomers({ q: '%' }).total, 0);
    const beyond = customerStore.listCustomers({ page: 9, perPage: 1 });
    assert.equal(beyond.page, 2);
    assert.equal(beyond.customers.length, 1);
});

test('ticket-mail: Erinnerung nennt "einem Tag" statt "1 Tagen"', async () => {
    const { customerStore, ticketStore, ticketMail, outbox, sent } = setup();
    const customer = await makeCustomer(customerStore);
    const { ticket } = ticketStore.createTicket({ customer, subject: 'Frage', body: 'x' });
    ticketMail.pendingReminder(ticketStore.getTicket(ticket.id), 1);
    ticketMail.pendingReminder(ticketStore.getTicket(ticket.id), 7);
    await outbox.processDue();
    assert.match(sent[0].text, /innerhalb von einem Tag nichts/);
    assert.match(sent[1].text, /innerhalb von 7 Tagen nichts/);
});

test('customerEventText: Statusereignisse in den Kundenbezeichnungen', () => {
    const { customerEventText } = require('../lib/ticket-store');
    assert.equal(customerEventText('Status: Neu → Gelöst (Support)'), 'Status: Eingegangen → Gelöst (Support)');
    assert.equal(customerEventText('Status: Wartet auf Antwort → Offen (Kunde)'), 'Status: Wartet auf dich → In Bearbeitung (du)');
    assert.equal(customerEventText('Status: Gelöst → Geschlossen (Automatik)'), 'Status: Gelöst → Geschlossen (automatisch)');
    assert.equal(customerEventText('Zusammengeführt in Ticket #1002'), 'Zusammengeführt in Ticket #1002');
});

test('ticket-store: Bewertung nur fuer geloeste Tickets und nur einmal', async () => {
    const { customerStore, ticketStore } = setup();
    const customer = await makeCustomer(customerStore);
    const { ticket } = ticketStore.createTicket({ customer, subject: 'A', body: 'x' });
    assert.equal(ticketStore.rate(ticket.id, 5), false);
    ticketStore.setStatus(ticket.id, 'resolved', { actor: 'customer' });
    assert.equal(ticketStore.rate(ticket.id, 9), false);
    assert.equal(ticketStore.rate(ticket.id, 4, 'Schnell!'), true);
    assert.equal(ticketStore.rate(ticket.id, 1), false);
    assert.equal(ticketStore.getTicket(ticket.id).rating, 4);
    assert.equal(ticketStore.stats().avgRating, 4);
});

test('ticket-store: claimTicketsByEmail ordnet Tickets ohne Konto zu, deleteTicketsOfCustomer raeumt auf', async () => {
    const { db, customerStore, ticketStore } = setup();
    db.prepare(`
        INSERT INTO tickets (id, number, requester_email, subject, created_at, updated_at)
        VALUES (?, 1500, 'alt@example.com', 'Altes Ticket', 1, 1)
    `).run(crypto.randomUUID());
    const customer = await makeCustomer(customerStore, 'alt@example.com');
    assert.equal(ticketStore.claimTicketsByEmail(customer), 1);
    assert.equal(ticketStore.getByNumber(1500).customerId, customer.id);

    ticketStore.deleteTicketsOfCustomer(customer.id);
    assert.equal(ticketStore.getByNumber(1500), null);
});

/* ================================================== Prototyp-Migration */

test('openDatabase uebernimmt Gast-Tickets aus dem Prototyp-Schema einmalig', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'proto.db');
    const proto = new DatabaseSync(file);
    proto.exec(`
        CREATE TABLE tickets (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, email TEXT NOT NULL, subject TEXT NOT NULL,
                              status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE UNIQUE INDEX tickets_token_hash ON tickets(token_hash);
        CREATE INDEX tickets_status ON tickets(status);
        CREATE TABLE ticket_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT NOT NULL,
                                      sender TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
    `);
    const id = crypto.randomUUID();
    proto.prepare("INSERT INTO tickets VALUES (?, 'h', 'Gast@Example.com', 'Alt', 'answered', 1, 2)").run(id);
    proto.prepare("INSERT INTO ticket_messages (ticket_id, sender, body, created_at) VALUES (?, 'requester', 'Frage', 1)").run(id);
    proto.prepare("INSERT INTO ticket_messages (ticket_id, sender, body, created_at) VALUES (?, 'admin', 'Antwort', 2)").run(id);
    proto.close();

    const db = openDatabase(file);
    const ticketStore = createTicketStore({ db });
    const migrated = ticketStore.getTicket(id);
    assert.equal(migrated.number, 1001);
    assert.equal(migrated.status, 'pending');
    assert.equal(migrated.requesterEmail, 'gast@example.com');
    assert.deepEqual(ticketStore.listMessages(id).map(m => m.author), ['customer', 'admin']);
    db.close();

    // Zweites Oeffnen: No-op, nichts doppelt
    const again = openDatabase(file);
    assert.equal(again.prepare('SELECT COUNT(*) AS n FROM ticket_messages').get().n, 2);
    again.close();
    await fsp.rm(dir, { recursive: true, force: true });
});

/* ===================================================== ticket-config-store */

test('ticket-config-store: Default-Kategorien nur beim ersten Start, Einstellungen mit Grenzen', () => {
    const { configStore } = setup();
    configStore.seedDefaults();
    const initial = configStore.listCategories();
    assert.ok(initial.length >= 3);
    initial.forEach(category => configStore.deleteCategory(category.id));
    configStore.seedDefaults();
    assert.equal(configStore.listCategories().length, 0, 'bewusst geleerte Liste bleibt leer');

    assert.ok(configStore.updateSettings({ pendingReminderDays: 0, pendingAutoResolveDays: 7, autoCloseDays: 7 }).error);
    assert.deepEqual(
        configStore.updateSettings({ pendingReminderDays: '2', pendingAutoResolveDays: 5, autoCloseDays: 10 }).settings,
        { pendingReminderDays: 2, pendingAutoResolveDays: 5, autoCloseDays: 10 }
    );
    assert.equal(configStore.addCategory('Doppelt') > 0, true);
    assert.equal(configStore.addCategory('Doppelt'), null);
});

test('ticket-config-store: Anrede/Grussformel mit Defaults, leere Werte erlaubt, zu lange abgelehnt', () => {
    const { configStore } = setup();
    assert.deepEqual(configStore.readReplyTemplate(), REPLY_TEMPLATE_DEFAULTS);
    assert.ok(configStore.updateReplyTemplate({ greeting: 'x'.repeat(201), signature: '', agentName: '' }).error);
    assert.deepEqual(
        configStore.updateReplyTemplate({ greeting: '', signature: 'Gruß\r\n{agent}', agentName: '  Julia   S. ' }).template,
        { greeting: '', signature: 'Gruß\n{agent}', agentName: 'Julia S.' }
    );
    assert.deepEqual(configStore.readReplyTemplate(), { greeting: '', signature: 'Gruß\n{agent}', agentName: 'Julia S.' });
});

test('reply-template: Vorbelegung mit Cursorposition, ohne Namen/Agent sauber, leere Vorlage erkannt', () => {
    const values = { ...REPLY_TEMPLATE_DEFAULTS, name: 'Max', agent: 'Julia' };
    const draft = buildReplyDraft(values);
    assert.equal(draft.value, 'Hallo Max,\n\n\n\nMit freundlichen Grüßen\nJulia\nISO Share Support');
    assert.equal(draft.value.slice(0, draft.caret), 'Hallo Max,\n\n');
    assert.equal(buildReplyDraft({ ...values, name: '', agent: '' }).value,
        'Hallo,\n\n\n\nMit freundlichen Grüßen\nISO Share Support');
    assert.equal(buildReplyDraft({ ...values, greeting: 'Guten Tag {name}!', name: '' }).value.split('\n')[0], 'Guten Tag!');
    // Leere Vorlagen schalten den jeweiligen Teil ab.
    assert.deepEqual(buildReplyDraft({ ...values, greeting: '', signature: '' }), { value: '', caret: 0 });
    assert.deepEqual(buildReplyDraft({ ...values, greeting: '' }), { value: '\n\nMit freundlichen Grüßen\nJulia\nISO Share Support', caret: 0 });

    assert.equal(isOnlyTemplate('', draft.value), true);
    assert.equal(isOnlyTemplate(draft.value.replace(/\n/g, '\r\n') + '  ', draft.value), true);
    assert.equal(isOnlyTemplate('Hallo Max,\n\nText\n\nMit freundlichen Grüßen', draft.value), false);
    assert.equal(isOnlyTemplate('Text', ''), false);
});

/* ======================================================= attachment-store */

test('attachment-store: Dateityp kommt aus den Magic-Bytes, nicht aus der Endung', () => {
    assert.equal(detectType(PNG, 'bild.png'), 'image/png');
    assert.equal(detectType(PNG, 'getarnt.txt'), 'image/png');
    assert.equal(detectType(Buffer.from('<html><script>alert(1)</script>'), 'bild.png'), null);
    assert.equal(detectType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'x.svg'), null);
    assert.equal(detectType(Buffer.from('Zeile 1\nZeile 2 äöü'), 'fehler.log'), 'text/plain');
    assert.equal(detectType(Buffer.from([0x00, 0x01, 0x02]), 'binär.txt'), null);
    assert.equal(detectType(Buffer.from('%PDF-1.7'), 'a.pdf'), 'application/pdf');
    assert.equal(sanitizeFilename('../../etc/pass"wd.txt'), 'pass_wd.txt');
    assert.equal(sanitizeFilename(''), 'anhang');
});

test('attachment-store: Grenzen fuer Anzahl/Groesse, speichern, lesen, loeschen', async () => {
    const { db, customerStore, ticketStore } = setup();
    const dir = await tempDir();
    const store = createAttachmentStore({ db, dir, maxBytes: 64, maxFiles: 2 });

    assert.throws(() => store.inspectBuffers([
        { filename: 'a.png', content: PNG }, { filename: 'b.png', content: PNG }, { filename: 'c.png', content: PNG },
    ]), err => err instanceof AttachmentError && err.code === 'too_many_files');
    assert.throws(() => store.inspectBuffers([{ filename: 'gross.log', content: Buffer.alloc(65, 'a') }]),
        err => err.code === 'file_too_large');
    assert.throws(() => store.inspectBuffers([{ filename: 'x.exe', content: Buffer.from('MZ') }]),
        err => err.code === 'file_type');

    const customer = await makeCustomer(customerStore);
    const { ticket, message } = ticketStore.createTicket({ customer, subject: 'A', body: 'x' });
    const [saved] = await store.storeAll(store.inspectBuffers([{ filename: 'shot.png', content: PNG }]), {
        ticketId: ticket.id, messageId: message.id,
    });
    const loaded = store.getAttachment(saved.id);
    assert.equal(loaded.mime, 'image/png');
    assert.equal(loaded.internal, false);
    assert.deepEqual(await fsp.readFile(store.filePath(saved.id)), PNG);
    assert.equal(ticketStore.listMessages(ticket.id)[0].attachments[0].filename, 'shot.png');

    const ids = ticketStore.deleteTicket(ticket.id);
    await store.removeFiles(ids);
    await assert.rejects(fsp.access(store.filePath(saved.id)));
    await fsp.rm(dir, { recursive: true, force: true });
});

/* ============================================================ mail-outbox */

test('mail-outbox: ohne SMTP wird nichts gespeichert', () => {
    const { outbox } = setup({ mailEnabled: false });
    assert.equal(outbox.enqueue({ kind: 'test', to: 'a@b.de', subject: 'x', text: 'x' }), null);
    assert.deepEqual(outbox.counts(), { pending: 0, sent: 0, failed: 0 });
});

test('mail-outbox: Erfolg markiert als gesendet, Fehler wird mit Backoff wiederholt und endet in failed', async () => {
    const db = openDatabase(':memory:');
    let fail = true;
    const delivered = [];
    const mailer = createMailer({
        transport: { sendMail: async mail => { if (fail) throw new Error('SMTP down'); delivered.push(mail); } },
        log: QUIET,
    });
    const outbox = createMailOutbox({ db, mailer, log: QUIET });

    const id = outbox.enqueue({ kind: 'test', to: 'a@b.de', subject: 'Hallo', text: 'x', headers: { messageId: '<m@x>' } });
    await outbox.whenIdle();
    let [mail] = outbox.list();
    assert.equal(mail.status, 'pending');
    assert.equal(mail.attempts, 1);
    assert.match(mail.lastError, /SMTP down/);
    assert.ok(mail.nextAttemptAt > Date.now(), 'naechster Versuch liegt in der Zukunft');

    // Alle weiteren Versuche sofort faellig machen
    for (let i = 1; i < MAX_ATTEMPTS; i += 1) {
        db.prepare('UPDATE mail_outbox SET next_attempt_at = 0 WHERE id = ?').run(id);
        await outbox.processDue();
    }
    [mail] = outbox.list();
    assert.equal(mail.status, 'failed');
    assert.equal(mail.attempts, MAX_ATTEMPTS);

    fail = false;
    assert.equal(outbox.retry(id), true);
    await outbox.whenIdle();
    [mail] = outbox.list();
    assert.equal(mail.status, 'sent');
    assert.equal(delivered[0].messageId, '<m@x>');
});

/* Fehler, wie nodemailer sie bei abgelehnten Empfaengern liefert */
function smtpError(responseCode) {
    const err = new Error(`Can't send mail - all recipients were rejected: ${responseCode} Test`);
    err.code = 'EENVELOPE';
    err.rejectedErrors = [{ responseCode }];
    return err;
}

test('mail-outbox: classifyError trennt endgueltig, Empfaenger-voruebergehend und Serverproblem', () => {
    assert.equal(classifyError(smtpError(550)), 'permanent');
    assert.equal(classifyError(smtpError(554)), 'permanent');
    assert.equal(classifyError(smtpError(450)), 'recipient');
    assert.equal(classifyError(new Error('irgendwas')), 'recipient');
    assert.equal(classifyError(Object.assign(new Error('auth'), { code: 'EAUTH', responseCode: 535 })), 'server');
    assert.equal(classifyError(Object.assign(new Error('conn'), { code: 'ECONNECTION' })), 'server');
    assert.equal(classifyError(Object.assign(new Error('busy'), { responseCode: 421 })), 'server');
});

test('mail-outbox: 5xx endet sofort in failed, 450 stellt weitere Mails an dieselbe Adresse ohne Versuch zurueck', async () => {
    const db = openDatabase(':memory:');
    const attemptsTo = [];
    const mailer = createMailer({
        transport: {
            sendMail: async mail => {
                attemptsTo.push(mail.to);
                if (mail.to === 'weg@x.de') throw smtpError(550);
                if (mail.to === 'gedrosselt@x.de') throw smtpError(450);
            },
        },
        log: QUIET,
    });
    const outbox = createMailOutbox({ db, mailer, log: QUIET });
    const ids = {
        gone: outbox.enqueue({ kind: 'test', to: 'weg@x.de', subject: 'a', text: 'a' }),
        t1: outbox.enqueue({ kind: 'test', to: 'gedrosselt@x.de', subject: 'b', text: 'b' }),
        t2: outbox.enqueue({ kind: 'test', to: 'gedrosselt@x.de', subject: 'c', text: 'c' }),
        t3: outbox.enqueue({ kind: 'test', to: 'gedrosselt@x.de', subject: 'd', text: 'd' }),
        ok: outbox.enqueue({ kind: 'test', to: 'ok@x.de', subject: 'e', text: 'e' }),
    };
    await outbox.whenIdle();

    const byId = Object.fromEntries(outbox.list().map(mail => [mail.id, mail]));
    assert.equal(byId[ids.gone].status, 'failed', '550 wird nicht wiederholt');
    assert.equal(byId[ids.gone].attempts, 1);
    assert.equal(byId[ids.t1].status, 'pending');
    assert.equal(byId[ids.t1].attempts, 1);
    for (const id of [ids.t2, ids.t3]) {
        assert.equal(byId[id].attempts, 0, 'zurueckgestellt, ohne einen Versuch zu verbrauchen');
        assert.ok(byId[id].nextAttemptAt >= byId[ids.t1].nextAttemptAt);
    }
    assert.equal(byId[ids.ok].status, 'sent', 'andere Empfaenger laufen weiter');
    assert.equal(attemptsTo.filter(to => to === 'gedrosselt@x.de').length, 1, 'nur ein Versuch an die gedrosselte Adresse');
});

test('mail-outbox: Anmelde-/Verbindungsfehler pausiert die ganze Warteschlange', async () => {
    const db = openDatabase(':memory:');
    let calls = 0;
    const mailer = createMailer({
        transport: {
            sendMail: async () => {
                calls += 1;
                throw Object.assign(new Error('Invalid login'), { code: 'EAUTH', responseCode: 535 });
            },
        },
        log: QUIET,
    });
    const outbox = createMailOutbox({ db, mailer, log: QUIET });
    for (const to of ['a@x.de', 'b@x.de', 'c@x.de']) outbox.enqueue({ kind: 'test', to, subject: 's', text: 't' });
    await outbox.whenIdle();
    assert.equal(calls, 1, 'nach dem ersten Anmeldefehler keine weiteren Versuche');
    const mails = outbox.list();
    assert.deepEqual(mails.map(m => m.attempts).sort(), [0, 0, 1]);
    assert.ok(mails.every(m => m.status === 'pending' && m.nextAttemptAt > Date.now()));
});

test('mail-outbox: sendIntervalMs haelt Abstand zwischen zwei Mails', async () => {
    const db = openDatabase(':memory:');
    const times = [];
    const mailer = createMailer({ transport: { sendMail: async () => { times.push(Date.now()); } }, log: QUIET });
    const outbox = createMailOutbox({ db, mailer, log: QUIET, sendIntervalMs: 120 });
    outbox.enqueue({ kind: 'test', to: 'a@x.de', subject: 's', text: 't' });
    outbox.enqueue({ kind: 'test', to: 'b@x.de', subject: 's', text: 't' });
    await outbox.whenIdle();
    assert.equal(times.length, 2);
    assert.ok(times[1] - times[0] >= 110, `Abstand ${times[1] - times[0]} ms`);
});

/* ========================================================= mail-templates */

test('compose escaped Nutzereingaben im HTML-Teil und erzeugt einen passenden Textteil', () => {
    const { text, html } = compose({
        appName: 'ISO Share', subject: 'x', heading: 'Hallo <b>', paragraphs: ['a & b'],
        quote: { label: 'Kunde', body: '<script>alert(1)</script>' }, button: { label: 'Los', url: 'https://x.test/?a=1&b=2' },
    });
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /Hallo &lt;b&gt;/);
    assert.match(html, /href="https:\/\/x\.test\/\?a=1&amp;b=2"/);
    assert.match(text, /<script>alert\(1\)<\/script>/, 'Klartext bleibt unveraendert');
    assert.match(text, /Los: https:\/\/x\.test/);
});

test('compose: HTML haelt auch in Outlook (Word-Engine) — feste Breite, <br> statt pre-wrap, VML-Button', () => {
    const { html } = compose({
        appName: 'ISO Share', heading: 'H', paragraphs: ['Zeile 1\nZeile 2'],
        quote: { label: 'Support', author: 'admin', body: 'Hallo Kim,\n\nText  mit zwei Leerzeichen' },
        button: { label: 'Ticket ansehen', url: 'https://x.test/t/1' },
    });
    assert.doesNotMatch(html, /pre-wrap/, 'Word kennt white-space:pre-wrap nicht');
    assert.match(html, /Hallo Kim,<br><br>Text &nbsp;mit zwei Leerzeichen/);
    assert.match(html, /Zeile 1<br>Zeile 2/);
    assert.match(html, /<!--\[if mso\]><table [^>]*width="580"/, 'Ghost-Table statt max-width');
    assert.match(html, /<v:roundrect href="https:\/\/x\.test\/t\/1"/, 'Button fuer Outlook als VML');
    assert.match(html, /<!--\[if !mso\]><!--><a class="m-btn" href="https:\/\/x\.test\/t\/1"/);
    assert.match(html, /font-family:'Segoe UI',Arial,sans-serif !important/, 'kein Times-New-Roman-Fallback');
    assert.match(html, /\[data-ogsc\] \.m-text\{/, 'Darkmode fuer Outlook.com');
    // Kein Abstand/Hintergrund an div/span/a-Containern ausser dem Button-Link fuer Nicht-Outlook.
    assert.doesNotMatch(html, /<(div|span)[^>]*style="[^"]*padding/);
});

test('stripQuotedReply schneidet Zitat, Markierung und Signatur ab', () => {
    assert.equal(stripQuotedReply('Danke!\n\nAm 01.01.2026 um 10:00 schrieb Support <s@x.de>:\n> alt'), 'Danke!');
    assert.equal(stripQuotedReply('Thanks\nOn Mon, Jan 1, 2026 at 10:00 Support wrote:\n> old'), 'Thanks');
    assert.equal(stripQuotedReply('Oben\n## Bitte oberhalb dieser Zeile antworten ##\nunten'), 'Oben');
    assert.equal(stripQuotedReply('Text\n-- \nMax Mustermann'), 'Text');
    assert.equal(stripQuotedReply('Zeile\n\n> zitat\n> zitat'), 'Zeile');
    assert.equal(htmlToText('<p>Hallo<br>Welt</p><blockquote>alt</blockquote>'), 'Hallo\nWelt');
});

/* ============================================================ ticket-mail */

test('ticket-mail: signierte Referenzen werden erkannt, gefaelschte nicht', async () => {
    const { customerStore, ticketStore, ticketMail } = setup();
    const customer = await makeCustomer(customerStore);
    const { ticket } = ticketStore.createTicket({ customer, subject: 'A', body: 'x' });

    const root = ticketMail.rootId(ticket.id);
    assert.equal(ticketMail.ticketIdFromReferences(`<a@b> ${root}`), ticket.id);
    const forged = root.replace(/-([0-9a-f]{16})@/, '-0000000000000000@');
    assert.equal(ticketMail.ticketIdFromReferences(forged), null);
    assert.equal(ticketMail.ticketIdFromReferences('', undefined), null);
});

test('ticket-mail: Eingangsbestaetigung + Admin-Info, Antwort-Mail respektiert Kunden-Einstellung', async () => {
    const { customerStore, ticketStore, ticketMail, outbox, sent } = setup();
    const customer = await makeCustomer(customerStore);
    const { ticket, message } = ticketStore.createTicket({ customer, subject: 'Hilfe', body: 'Text' });

    ticketMail.ticketCreated(ticket, message, [{ filename: 'log.txt' }]);
    await outbox.whenIdle();
    assert.deepEqual(sent.map(m => m.to), ['kunde@example.com', 'admin@example.com']);
    assert.match(sent[0].subject, /\[#1001\] Hilfe/);
    assert.match(sent[0].text, /https:\/\/support\.test\/account\/tickets\/1001/);
    assert.match(sent[0].text, /log\.txt/);
    assert.equal(sent[0].replyTo, 'support@iso.test');
    assert.equal(sent[0].inReplyTo, ticketMail.rootId(ticket.id));
    assert.equal(sent[0].headers['Auto-Submitted'], 'auto-generated');
    assert.ok(sent[0].html.includes('Ticket ansehen'));

    customerStore.setNotify(customer.id, { replies: false, status: true, reminders: true });
    const reply = ticketStore.addReply(ticket.id, { author: 'admin', body: 'Antwort' });
    assert.equal(ticketMail.adminReplied(reply.ticket, reply.message), null);
});

/* ============================================================ mail-inbound */

async function inboundSetup() {
    const ctx = setup();
    const dir = await tempDir();
    const attachmentStore = createAttachmentStore({ db: ctx.db, dir });
    const processor = createInboundProcessor({
        ticketStore: ctx.ticketStore, customerStore: ctx.customerStore, attachmentStore,
        ticketMail: ctx.ticketMail, auditLog: null, log: QUIET,
    });
    const customer = await makeCustomer(ctx.customerStore);
    const { ticket } = ctx.ticketStore.createTicket({ customer, subject: 'A', body: 'x' });
    ctx.ticketStore.addReply(ticket.id, { author: 'admin', body: 'Frage zurück' });
    return { ...ctx, processor, customer, ticket, dir, root: ctx.ticketMail.rootId(ticket.id) };
}

test('mail-inbound: gueltige Antwort landet ohne Zitat samt Anhang im Ticket', async () => {
    const { processor, ticketStore, ticket, root, dir, outbox, sent } = await inboundSetup();
    const result = await processor.process({
        from: 'Kunde@Example.com', inReplyTo: root, references: root,
        text: 'Hier die Infos.\n\nAm Mo., 1. Jan. schrieb Support:\n> Frage zurück',
        attachments: [{ filename: 'screen.png', content: PNG }, { filename: 'boese.html', content: Buffer.from('<html>') }],
    });
    assert.equal(result.result, 'added');
    const updated = ticketStore.getTicket(ticket.id);
    assert.equal(updated.status, 'open');
    const last = ticketStore.listMessages(ticket.id).at(-1);
    assert.equal(last.via, 'email');
    assert.match(last.body, /^Hier die Infos\./);
    assert.doesNotMatch(last.body, /Frage zurück/);
    assert.match(last.body, /Nicht übernommen/);
    assert.deepEqual(last.attachments.map(a => a.filename), ['screen.png']);
    await outbox.whenIdle();
    assert.ok(sent.some(m => m.to === 'admin@example.com' && /Neue Antwort/.test(m.subject)));
    await fsp.rm(dir, { recursive: true, force: true });
});

test('mail-inbound: falscher Absender, Autoresponder und gefaelschte Referenz werden verworfen', async () => {
    const { processor, ticketStore, ticket, root, dir } = await inboundSetup();
    const before = ticketStore.listMessages(ticket.id).length;
    assert.equal((await processor.process({ from: 'fremd@example.com', inReplyTo: root, text: 'x' })).result, 'sender_mismatch');
    assert.equal((await processor.process({ from: 'kunde@example.com', inReplyTo: root, text: 'x', autoSubmitted: true })).result, 'auto_submitted');
    assert.equal((await processor.process({ from: 'kunde@example.com', inReplyTo: '<ticket-x@iso.test>', text: 'x' })).result, 'unmatched');
    assert.equal(ticketStore.listMessages(ticket.id).length, before);
    await fsp.rm(dir, { recursive: true, force: true });
});

test('mail-inbound: Antwort auf ein geschlossenes Ticket wird abgelehnt und dem Kunden erklaert', async () => {
    const { processor, ticketStore, ticket, root, dir, outbox, sent } = await inboundSetup();
    ticketStore.setStatus(ticket.id, 'closed');
    assert.equal((await processor.process({ from: 'kunde@example.com', references: root, text: 'Hallo?' })).result, 'ticket_closed');
    await outbox.whenIdle();
    assert.ok(sent.some(m => /geschlossen/.test(m.subject)));
    await fsp.rm(dir, { recursive: true, force: true });
});

/* ============================================================ imap-poller */

test('imap-poller: Header entfalten, Autoresponder erkennen, BODYSTRUCTURE zerlegen', () => {
    const headers = parseHeaders(Buffer.from('References: <a@x>\r\n <b@x>\r\nAuto-Submitted: no\r\n'));
    assert.equal(headers.references, '<a@x> <b@x>');
    assert.equal(isAutoSubmitted(headers), false);
    assert.equal(isAutoSubmitted({ 'auto-submitted': 'auto-replied' }), true);
    assert.equal(isAutoSubmitted({ precedence: 'bulk' }), true);

    const found = walkStructure({
        type: 'multipart/mixed',
        childNodes: [
            { type: 'multipart/alternative', childNodes: [{ type: 'text/plain', part: '1.1' }, { type: 'text/html', part: '1.2' }] },
            { type: 'image/png', part: '2', disposition: 'attachment', dispositionParameters: { filename: 'a.png' }, size: 10 },
        ],
    });
    assert.equal(found.text, '1.1');
    assert.equal(found.html, '1.2');
    assert.deepEqual(found.attachments, [{ part: '2', filename: 'a.png', size: 10 }]);
});

test('imap-poller: holt ungelesene Mails, reicht sie weiter und markiert sie als gelesen', async () => {
    const processed = [];
    const flagged = [];
    const { Readable } = require('stream');
    const fakeClient = {
        async connect() {},
        async getMailboxLock() { return { release() {} }; },
        async search() { return [7]; },
        async fetchOne() {
            return {
                envelope: { from: [{ address: 'kunde@example.com' }], subject: 'Re: [#1001] A', inReplyTo: '<r@x>' },
                bodyStructure: { type: 'text/plain' },
                headers: Buffer.from('References: <r@x>\r\n'),
            };
        },
        async download() { return { content: Readable.from([Buffer.from('Antwort per Mail')]) }; },
        async messageFlagsAdd(uid, flags) { flagged.push([uid, flags]); },
        async logout() {},
    };
    const poller = createImapPoller({
        host: 'imap.test', user: 'support@iso.test', log: QUIET, clientFactory: () => fakeClient,
        processor: { process: async mail => { processed.push(mail); } },
    });
    assert.equal(await poller.pollOnce(), 1);
    assert.equal(processed[0].text, 'Antwort per Mail');
    assert.equal(processed[0].references, '<r@x>');
    assert.deepEqual(flagged, [['7', ['\\Seen']]]);
    assert.equal(poller.status.lastError, null);

    const disabled = createImapPoller({ processor: { process() {} }, log: QUIET });
    assert.equal(disabled.enabled, false);
    assert.equal(await disabled.pollOnce(), 0);
});

/* ====================================================== ticket-automation */

test('ticket-automation: Erinnerung, danach automatisch geloest, danach geschlossen', async () => {
    const { customerStore, ticketStore, configStore, ticketMail, outbox, sent } = setup();
    configStore.updateSettings({ pendingReminderDays: 3, pendingAutoResolveDays: 7, autoCloseDays: 7 });
    const automation = createTicketAutomation({ ticketStore, configStore, ticketMail, auditLog: null, log: QUIET });
    const customer = await makeCustomer(customerStore);
    const { ticket } = ticketStore.createTicket({ customer, subject: 'A', body: 'x' });
    ticketStore.addReply(ticket.id, { author: 'admin', body: 'Antwort' });

    const now = Date.now();
    assert.deepEqual(automation.runOnce(now + 1 * DAY_MS), { reminded: 0, resolved: 0, closed: 0, slaBreached: 0, woken: 0 });
    assert.deepEqual(automation.runOnce(now + 4 * DAY_MS), { reminded: 1, resolved: 0, closed: 0, slaBreached: 0, woken: 0 });
    assert.deepEqual(automation.runOnce(now + 5 * DAY_MS), { reminded: 0, resolved: 0, closed: 0, slaBreached: 0, woken: 0 }, 'nur eine Erinnerung');
    // reminder_sent_at ist "jetzt" — fuer den Test in die Vergangenheit schieben
    ticketStore.db.prepare('UPDATE tickets SET reminder_sent_at = ? WHERE id = ?').run(now - 8 * DAY_MS, ticket.id);
    assert.deepEqual(automation.runOnce(now), { reminded: 0, resolved: 1, closed: 0, slaBreached: 0, woken: 0 });
    assert.equal(ticketStore.getTicket(ticket.id).status, 'resolved');
    ticketStore.db.prepare('UPDATE tickets SET resolved_at = ? WHERE id = ?').run(now - 8 * DAY_MS, ticket.id);
    assert.deepEqual(automation.runOnce(now), { reminded: 0, resolved: 0, closed: 1, slaBreached: 0, woken: 0 });
    assert.equal(ticketStore.getTicket(ticket.id).status, 'closed');

    await outbox.whenIdle();
    const kinds = sent.filter(m => m.to === customer.email).map(m => m.subject);
    assert.ok(kinds.some(s => /^Erinnerung/.test(s)));
    assert.ok(kinds.some(s => /Gelöst/.test(s)));
    assert.ok(kinds.some(s => /Geschlossen/.test(s)));
});

test('ticket-automation: eine Kundenantwort setzt die Erinnerungs-Uhr zurueck', async () => {
    const { customerStore, ticketStore, configStore, ticketMail } = setup();
    const automation = createTicketAutomation({ ticketStore, configStore, ticketMail, auditLog: null, log: QUIET });
    const customer = await makeCustomer(customerStore);
    const { ticket } = ticketStore.createTicket({ customer, subject: 'A', body: 'x' });
    ticketStore.addReply(ticket.id, { author: 'admin', body: 'Antwort' });
    automation.runOnce(Date.now() + 4 * DAY_MS);
    assert.ok(ticketStore.getTicket(ticket.id).reminderSentAt);
    ticketStore.addReply(ticket.id, { author: 'customer', body: 'Da bin ich' });
    assert.equal(ticketStore.getTicket(ticket.id).reminderSentAt, null);
    assert.equal(ticketStore.getTicket(ticket.id).status, 'open');
});

test('ticket-automation: eine neue Support-Antwort nach der Erinnerung startet die Frist neu', async () => {
    const { customerStore, ticketStore, configStore, ticketMail } = setup();
    configStore.updateSettings({ pendingReminderDays: 3, pendingAutoResolveDays: 7, autoCloseDays: 7 });
    const automation = createTicketAutomation({ ticketStore, configStore, ticketMail, auditLog: null, log: QUIET });
    const customer = await makeCustomer(customerStore);
    const { ticket } = ticketStore.createTicket({ customer, subject: 'A', body: 'x' });
    ticketStore.addReply(ticket.id, { author: 'admin', body: 'Antwort' });
    const now = Date.now();
    automation.runOnce(now + 4 * DAY_MS);
    // Erinnerung liegt lange zurueck, dann antwortet der Support erneut
    ticketStore.db.prepare('UPDATE tickets SET reminder_sent_at = ? WHERE id = ?').run(now - 8 * DAY_MS, ticket.id);
    ticketStore.addReply(ticket.id, { author: 'admin', body: 'Noch ein Hinweis' });
    assert.equal(ticketStore.getTicket(ticket.id).reminderSentAt, null);
    assert.deepEqual(automation.runOnce(now), { reminded: 0, resolved: 0, closed: 0, slaBreached: 0, woken: 0 });
    assert.equal(ticketStore.getTicket(ticket.id).status, 'pending');
});

test('ticket-store: setTags ohne Aenderung laesst updated_at stehen', async () => {
    const { customerStore, ticketStore } = setup();
    const customer = await makeCustomer(customerStore);
    const { ticket } = ticketStore.createTicket({ customer, subject: 'A', body: 'x' });
    ticketStore.setTags(ticket.id, ['UEFI', ' download ', 'uefi']);
    const tagged = ticketStore.getTicket(ticket.id);
    assert.deepEqual(tagged.tags, ['uefi', 'download']);
    ticketStore.db.prepare('UPDATE tickets SET updated_at = 1 WHERE id = ?').run(ticket.id);
    ticketStore.setTags(ticket.id, ['uefi', 'download']);
    assert.equal(ticketStore.getTicket(ticket.id).updatedAt, 1);
});

/* ============================================================== Helfer */

test('lineField, contentDisposition und relativeTime', () => {
    assert.equal(lineField('Betreff\r\nBcc: x@y.de\t ok ', 200), 'Betreff Bcc: x@y.de ok');
    assert.equal(
        contentDisposition('inline', "it's (1).png"),
        `inline; filename="it's (1).png"; filename*=UTF-8''it%27s%20%281%29.png`
    );
    assert.equal(contentDisposition('attachment', 'Übersicht.pdf'), `attachment; filename="_bersicht.pdf"; filename*=UTF-8''%C3%9Cbersicht.pdf`);
    const now = Date.now();
    assert.equal(relativeTime(now - 59.6 * 60e3, now), 'vor 59 Min.');
});

test('formatMessage escaped HTML und verlinkt nur http(s)-URLs', () => {
    assert.equal(formatMessage('<b>x</b>'), '&lt;b&gt;x&lt;/b&gt;');
    assert.equal(
        formatMessage('Siehe https://example.com/a?b=1.'),
        'Siehe <a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer nofollow">https://example.com/a?b=1</a>.'
    );
    assert.doesNotMatch(formatMessage('javascript:alert(1)'), /<a /);
    assert.doesNotMatch(formatMessage('https://x.test/"onmouseover="alert(1)'), /onmouseover="/);
    // Umschliessende Anfuehrungszeichen/spitze Klammern gehoeren nicht zum Link.
    assert.equal(
        formatMessage('"https://example.com" <https://example.org/?a=1&b=2>'),
        '&quot;<a href="https://example.com" target="_blank" rel="noopener noreferrer nofollow">https://example.com</a>&quot; ' +
        '&lt;<a href="https://example.org/?a=1&amp;b=2" target="_blank" rel="noopener noreferrer nofollow">https://example.org/?a=1&amp;b=2</a>&gt;'
    );
});

test('safeNextPath erlaubt nur relative Pfade, checkPasswordStrength prueft Laenge', () => {
    assert.equal(safeNextPath('/account/tickets/1001', '/'), '/account/tickets/1001');
    assert.equal(safeNextPath('//evil.example', '/x'), '/x');
    assert.equal(safeNextPath('https://evil.example', '/x'), '/x');
    assert.equal(safeNextPath('/\\evil.example', '/x'), '/x');
    assert.ok(checkPasswordStrength('kurz'));
    assert.ok(checkPasswordStrength('kunde@example.com', { email: 'kunde@example.com' }));
    assert.equal(checkPasswordStrength('ein-langes-passwort'), null);
});

test('safe-name: Ticket-Validatoren', () => {
    assert.equal(safeTicketNumber('#1042'), 1042);
    assert.equal(safeTicketNumber('1042abc'), null);
    assert.equal(safeTicketNumber('0'), null);
    assert.equal(safeTicketStatus('pending'), 'pending');
    assert.equal(safeTicketStatus('answered'), null);
    assert.equal(safeTicketPriority('urgent'), 'urgent');
    assert.equal(safeTicketPriority('mega'), null);
    assert.equal(safeCustomerToken('ctk_' + 'a'.repeat(43)), 'ctk_' + 'a'.repeat(43));
    assert.equal(safeCustomerToken('tkt_' + 'a'.repeat(43)), null);
    assert.equal(safeDisplayName('  Kim\u0000 '), 'Kim');
    assert.equal(safeDisplayName(''), null);
    assert.equal(safeAttachmentId(crypto.randomUUID().toUpperCase()).length, 36);
    assert.equal(safeAttachmentId('../x'), null);
    assert.equal(safeEmail('a@b.de'), 'a@b.de');
    assert.equal(safeEmail('keine-adresse'), null);
    assert.equal(safeEmail(' kim.kunde+ticket@müller-it.de '), 'kim.kunde+ticket@müller-it.de');
    // Alles, was nodemailer als Anzeigename/Adressliste lesen wuerde
    assert.equal(safeEmail('x<opfer@example.com>'), null);
    assert.equal(safeEmail('a@b.de,c@d.de'), null);
    assert.equal(safeEmail('"a b"@example.com'), null);
    assert.equal(safeEmail('a@b.de;c@d.de'), null);
    assert.equal(safeEmail('a@localhost'), null);
});

/* ===================================================== Erweiterungen 2026-09 */

const { authenticatedSender, parseAuthResults, headerValues } = require('../lib/mail-auth');
const { renderMarkdown, plainExcerpt } = require('../lib/markdown');
const { createKbStore, slugify } = require('../lib/kb-store');
const { createTicketReports, buckets, median } = require('../lib/ticket-reports');
const { slaState } = require('../lib/routes/helpers');
const { ticketSubject } = require('../lib/mail-inbound');
const { createClock } = require('../lib/time');
const { safeKbSlug } = require('../lib/safe-name');

test('ticket-store: der Support legt ein Ticket an — Status, Erstantwort und Ungelesen-Markierung stimmen', async () => {
    const { customerStore, ticketStore } = setup();
    const customer = await makeCustomer(customerStore);
    const { ticket, message } = ticketStore.createTicket({
        customer, subject: 'Rueckruf', body: 'Hallo', author: 'admin', isoFile: 'a.iso',
    });
    assert.equal(ticket.status, 'pending');
    assert.equal(ticket.source, 'admin');
    assert.equal(ticket.isoFile, 'a.iso');
    assert.equal(ticket.firstResponseAt, ticket.createdAt);
    assert.equal(ticket.customerUnread, true);
    assert.equal(ticket.adminUnread, false);
    assert.equal(message.author, 'admin');

    const resolved = ticketStore.createTicket({ customer, subject: 'x', body: 'y', author: 'admin', statusAfter: 'resolved' }).ticket;
    assert.equal(resolved.status, 'resolved');
    assert.ok(resolved.resolvedAt);
    // "new" ist fuer ein vom Support angelegtes Ticket nie sinnvoll
    assert.equal(ticketStore.createTicket({ customer, subject: 'x', body: 'y', author: 'admin', statusAfter: 'new' }).ticket.status, 'pending');

    const viaMail = ticketStore.createTicket({ customer, subject: 'x', body: 'y', via: 'email' }).ticket;
    assert.equal(viaMail.source, 'email');
    assert.equal(ticketStore.countRecentBySource(customer.id, 'email', Date.now() - 1000), 1);
});

test('ticket-store: Tags und ISO-Datei erzeugen interne Ereignisse, nur bei echter Aenderung', async () => {
    const { customerStore, ticketStore } = setup();
    const customer = await makeCustomer(customerStore);
    const { ticket } = ticketStore.createTicket({ customer, subject: 'A', body: 'x' });
    ticketStore.setTags(ticket.id, ['UEFI', 'download']);
    ticketStore.setTags(ticket.id, ['uefi', 'download']);
    assert.equal(ticketStore.setIsoFile(ticket.id, 'debian.iso'), true);
    assert.equal(ticketStore.setIsoFile(ticket.id, 'debian.iso'), false);
    const events = ticketStore.listMessages(ticket.id).filter(m => m.kind === 'event').map(m => m.body);
    assert.deepEqual(events, ['Tags: — → uefi, download', 'ISO-Datei: — → debian.iso']);
    assert.ok(ticketStore.listMessages(ticket.id, { includeInternal: false }).every(m => m.kind !== 'event'));
    assert.equal(ticketStore.countActiveForIsoFile('debian.iso'), 1);
    assert.equal(ticketStore.countActiveByIsoFile().get('debian.iso'), 1);
});

test('ticket-store: Zusammenfuehren verschiebt Verlauf und Anhaenge, uebernimmt Tags/Prioritaet und prueft die Regeln', async () => {
    const { db, customerStore, ticketStore } = setup();
    const customer = await makeCustomer(customerStore);
    const stranger = await makeCustomer(customerStore, 'fremd@example.com');
    const target = ticketStore.createTicket({ customer, subject: 'Ziel', body: 'A' }).ticket;
    ticketStore.addReply(target.id, { author: 'admin', body: 'Antwort' });
    const source = ticketStore.createTicket({ customer, subject: 'Doppelt', body: 'B', priority: 'high' }).ticket;
    ticketStore.setTags(source.id, ['uefi']);
    db.prepare(`INSERT INTO ticket_attachments (id, ticket_id, message_id, filename, mime, size, sha256, created_at)
                VALUES ('att-1', ?, NULL, 'x.png', 'image/png', 1, 'h', 1)`).run(source.id);
    const foreign = ticketStore.createTicket({ customer: stranger, subject: 'Fremd', body: 'C' }).ticket;

    assert.deepEqual(ticketStore.mergeTickets(source.id, source.id), { error: 'same_ticket' });
    assert.deepEqual(ticketStore.mergeTickets(source.id, foreign.id), { error: 'different_customer' });

    const result = ticketStore.mergeTickets(source.id, target.id);
    assert.equal(result.source.status, 'closed');
    assert.equal(result.source.mergedIntoId, target.id);
    assert.equal(result.target.priority, 'high');
    assert.deepEqual(result.target.tags, ['uefi']);
    // In der Quelle wartete eine unbeantwortete Kundennachricht -> Ziel wieder "open"
    assert.equal(result.target.status, 'open');
    const bodies = ticketStore.listMessages(target.id).map(m => m.body);
    assert.ok(bodies.includes('A') && bodies.includes('B'));
    assert.ok(bodies.some(body => /Ticket #\d+ \(„Doppelt“\) wurde hier zusammengeführt/.test(body)));
    assert.equal(db.prepare('SELECT ticket_id FROM ticket_attachments WHERE id = ?').get('att-1').ticket_id, target.id);
    assert.deepEqual(ticketStore.listMessages(source.id).map(m => m.kind), ['event']);

    assert.deepEqual(ticketStore.mergeTickets(source.id, target.id), { error: 'already_merged' });
    ticketStore.setStatus(target.id, 'closed');
    const third = ticketStore.createTicket({ customer, subject: 'Drei', body: 'D' }).ticket;
    assert.deepEqual(ticketStore.mergeTickets(third.id, target.id), { error: 'target_closed' });
});

test('ticket-store: Aufteilen verschiebt Auswahl samt Anhang, leitet Status ab und prueft die Regeln', async () => {
    const { db, customerStore, ticketStore } = setup();
    const customer = await makeCustomer(customerStore);
    const source = ticketStore.createTicket({ customer, subject: 'Download', body: 'A', priority: 'high' }).ticket;
    ticketStore.setTags(source.id, ['download']);
    ticketStore.addReply(source.id, { author: 'admin', body: 'Antwort' });
    const second = ticketStore.addReply(source.id, { author: 'customer', body: 'Zweites Problem' }).message;
    const note = ticketStore.addNote(source.id, { body: 'Notiz dazu' }).message;
    db.prepare(`INSERT INTO ticket_attachments (id, ticket_id, message_id, filename, mime, size, sha256, created_at)
                VALUES ('att-s', ?, ?, 'x.png', 'image/png', 1, 'h', 1)`).run(source.id, second.id);
    const all = ticketStore.listMessages(source.id);
    const event = ticketStore.setStatus(source.id, 'pending') && ticketStore.listMessages(source.id).find(m => m.kind === 'event');
    const opts = ids => ({ messageIds: ids, subject: 'Neu' });

    assert.deepEqual(ticketStore.splitTicket(source.id, opts([])), { error: 'no_messages' });
    assert.deepEqual(ticketStore.splitTicket(source.id, opts([event.id, 999999])), { error: 'no_messages' });
    const replies = all.filter(m => m.kind === 'reply').map(m => m.id);
    assert.deepEqual(ticketStore.splitTicket(source.id, opts(replies)), { error: 'all_messages' });

    const result = ticketStore.splitTicket(source.id, opts([second.id, note.id]));
    assert.equal(result.moved, 2);
    const { target } = result;
    assert.equal(target.splitFromId, source.id);
    assert.equal(target.customerId, customer.id);
    assert.equal(target.priority, 'high');
    assert.deepEqual(target.tags, ['download']);
    assert.equal(target.status, 'new');
    assert.equal(target.createdAt, second.createdAt);
    assert.equal(target.lastCustomerActivityAt, second.createdAt);
    assert.equal(target.firstResponseAt, null);
    assert.equal(db.prepare('SELECT ticket_id FROM ticket_attachments WHERE id = ?').get('att-s').ticket_id, target.id);
    assert.deepEqual(ticketStore.listMessages(target.id).map(m => m.body),
        ['Zweites Problem', 'Notiz dazu', 'Aufgeteilt aus Ticket #1001 („Download“)']);

    // Ursprung: Status bleibt, Kundenaktivitaet zeigt wieder auf "A"
    assert.equal(result.source.status, 'pending');
    assert.equal(result.source.lastCustomerActivityAt, all[0].createdAt);
    assert.ok(ticketStore.listMessages(source.id, { includeInternal: false })
        .some(m => m.body === '2 Nachrichten in Ticket #1002 („Neu“) verschoben'));
    assert.deepEqual(ticketStore.listSplitChildren(source.id).map(t => t.number), [target.number]);

    // Nachrichten eines anderen Tickets lassen sich nicht herueberziehen
    assert.deepEqual(ticketStore.splitTicket(source.id, opts([second.id])), { error: 'no_messages' });
    ticketStore.setStatus(source.id, 'closed');
    assert.deepEqual(ticketStore.splitTicket(source.id, opts([all[0].id])), { error: 'closed' });
});

test('SLA: Faelligkeit nach Status, Ansicht "ueberfaellig", Meldung genau einmal, Antwort setzt zurueck', async () => {
    const { db, customerStore, ticketStore, configStore, ticketMail, outbox, sent } = setup();
    configStore.updateSla({
        urgent_first: 1, urgent_next: 1, high_first: 2, high_next: 2, normal_first: 4, normal_next: 8, low_first: 0, low_next: 0,
    });
    const customer = await makeCustomer(customerStore);
    const { ticket } = ticketStore.createTicket({ customer, subject: 'A', body: 'x' });
    assert.equal(ticket.slaMinutes, 240);
    assert.equal(ticket.slaDueAt, ticket.createdAt + 4 * 3600e3);
    const low = ticketStore.createTicket({ customer, subject: 'B', body: 'y', priority: 'low' }).ticket;
    assert.equal(low.slaDueAt, null, '0 = keine Frist');

    db.prepare('UPDATE tickets SET created_at = ?, last_customer_activity_at = ? WHERE id = ?')
        .run(Date.now() - 5 * 3600e3, Date.now() - 5 * 3600e3, ticket.id);
    assert.deepEqual(ticketStore.listTickets({ view: 'overdue' }).tickets.map(t => t.id), [ticket.id]);
    assert.equal(ticketStore.countViews().overdue, 1);
    assert.equal(ticketStore.listTickets({ view: 'all', sort: 'due' }).tickets[0].id, ticket.id);

    const automation = createTicketAutomation({ ticketStore, configStore, ticketMail, auditLog: null, log: QUIET });
    assert.equal(automation.runOnce().slaBreached, 1);
    assert.equal(automation.runOnce().slaBreached, 0, 'nur eine Meldung je Frist');
    await outbox.whenIdle();
    assert.ok(sent.some(m => m.to === 'admin@example.com' && /^Frist überschritten/.test(m.subject)));

    // Support antwortet: pending -> keine Frist; Kunde antwortet -> Folgefrist (8 h) ab jetzt
    ticketStore.addReply(ticket.id, { author: 'admin', body: 'Antwort' });
    assert.equal(ticketStore.getTicket(ticket.id).slaDueAt, null);
    ticketStore.addReply(ticket.id, { author: 'customer', body: 'Danke, noch was' });
    const reopened = ticketStore.getTicket(ticket.id);
    assert.equal(reopened.status, 'open');
    assert.equal(reopened.slaNotifiedAt, null);
    assert.equal(reopened.slaDueAt, reopened.lastCustomerActivityAt + 8 * 3600e3);

    const now = Date.now();
    assert.equal(slaState({ slaDueAt: now + 7 * 3600e3, slaMinutes: 480 }, now).state, 'ok');
    assert.equal(slaState({ slaDueAt: now + 3600e3, slaMinutes: 480 }, now).state, 'warn');
    const late = slaState({ slaDueAt: now - 30 * 60e3, slaMinutes: 480 }, now);
    assert.equal(late.state, 'overdue');
    assert.match(late.label, /^überfällig seit 30 Min\.$/);
    assert.equal(slaState({ slaDueAt: null }), null);
});

test('ticket-config-store: Antwortfristen haben Defaults, lehnen Unsinn ab und erlauben 0', () => {
    const { configStore } = setup();
    assert.deepEqual(configStore.readSla().urgent, { firstResponseHours: 4, nextResponseHours: 4 });
    assert.ok(configStore.updateSla({ urgent_first: '-1' }).error);
    assert.ok(configStore.updateSla({ urgent_first: '0.1' }).error, 'nur Viertelstunden');
    assert.ok(configStore.updateSla({ urgent_first: '9999' }).error);
    const ok = configStore.updateSla({ urgent_first: '0,5', high_first: '' });
    assert.equal(ok.sla.urgent.firstResponseHours, 0.5);
    assert.equal(configStore.readSla().high.firstResponseHours, 0);
});

test('mail-auth: nur der Header der eigenen authserv-id zaehlt, DKIM mit Ausrichtung oder DMARC', () => {
    const own = 'mx.gmx.net';
    const from = 'kim@mail.example.com';
    const ok = header => authenticatedSender([header], { authservId: own, fromAddress: from });

    assert.equal(ok('mx.gmx.net; dmarc=pass (p=reject) header.from=mail.example.com').ok, true);
    assert.equal(ok('mx.gmx.net; dkim=pass header.d=example.com header.s=s1').method, 'dkim');
    assert.equal(ok('MX.GMX.NET 1; dkim=pass header.i=@mail.example.com').ok, true);
    assert.equal(ok('mx.gmx.net; dkim=pass header.d=other.org').reason, 'not_aligned');
    assert.equal(ok('mx.gmx.net; dkim=pass header.d=com').ok, false, 'nackte TLD zaehlt nie');
    assert.equal(ok('mx.gmx.net; dkim=fail header.d=example.com; spf=pass smtp.mailfrom=example.com').ok, false);
    assert.equal(ok('evil.example; dmarc=pass header.from=mail.example.com').reason, 'no_auth_results');

    // Mitgeschickter, gefaelschter Header mit derselben ID weiter unten
    const forged = authenticatedSender([
        'mx.gmx.net; dkim=fail header.d=example.com; dmarc=fail header.from=mail.example.com',
        'mx.gmx.net; dmarc=pass header.from=mail.example.com',
    ], { authservId: own, fromAddress: from });
    assert.equal(forged.ok, false);

    assert.equal(authenticatedSender([], { authservId: '', fromAddress: from }).reason, 'not_configured');
    assert.deepEqual(parseAuthResults('mx; dkim=pass (gut (sehr)) header.d=A.de').results[0].props, { 'header.d': 'a.de' });
    assert.deepEqual(
        headerValues('Authentication-Results: a; none\r\nX-Other: 1\r\nAuthentication-Results: b;\r\n dkim=pass', 'authentication-results'),
        ['a; none', 'b; dkim=pass']
    );
});

test('mail-inbound: neues Ticket per Mail nur fuer verifizierte Konten mit DKIM/DMARC, mit Schleifenschutz', async () => {
    const { db, customerStore, ticketStore, ticketMail, outbox, sent } = setup();
    const root = await tempDir();
    try {
        const attachmentStore = createAttachmentStore({ db, dir: root });
        const audit = [];
        const auditLog = { log: (event, detail) => audit.push({ event, ...detail }) };
        const processor = createInboundProcessor({
            ticketStore, customerStore, attachmentStore, ticketMail, auditLog, log: QUIET, authservId: 'mx.test',
        });
        const customer = await makeCustomer(customerStore);
        await makeCustomer(customerStore, 'offen@example.com', { verified: false });
        const mail = (overrides = {}) => ({
            from: 'kunde@example.com', subject: 'AW: Re: ISO bootet nicht', text: 'Hilfe', attachments: [],
            authResults: ['mx.test; dmarc=pass header.from=example.com'], ...overrides,
        });

        assert.equal((await processor.process(mail({ from: 'unbekannt@example.com' }))).result, 'no_account');
        assert.equal((await processor.process(mail({ from: 'offen@example.com' }))).result, 'unverified');
        assert.equal((await processor.process(mail({ authResults: ['mx.test; dmarc=fail header.from=example.com'] }))).result, 'auth_failed');
        assert.equal((await processor.process(mail({ autoSubmitted: true }))).result, 'auto_submitted');

        const created = await processor.process(mail({ attachments: [{ filename: 'bild.png', content: PNG }] }));
        assert.equal(created.result, 'created');
        const ticket = ticketStore.getTicket(created.ticketId);
        assert.equal(ticket.subject, 'ISO bootet nicht');
        assert.equal(ticket.source, 'email');
        assert.equal(ticket.customerId, customer.id);
        assert.equal(ticketStore.listMessages(ticket.id)[0].attachments.length, 1);
        await outbox.whenIdle();
        assert.ok(sent.some(m => m.to === 'kunde@example.com' && m.subject === `[#${ticket.number}] ISO bootet nicht`));
        assert.ok(audit.some(e => e.event === 'ticket_created_via_mail' && e.auth === 'dmarc'));

        for (let i = 0; i < 4; i += 1) await processor.process(mail());
        assert.equal((await processor.process(mail())).result, 'rate_limited');

        // Ohne authserv-id bleibt es beim alten Verhalten
        const replyOnly = createInboundProcessor({ ticketStore, customerStore, attachmentStore, ticketMail, auditLog, log: QUIET });
        assert.equal(replyOnly.newTicketsEnabled, false);
        assert.equal((await replyOnly.process(mail())).result, 'unmatched');
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test('mail-inbound: eine Antwort auf den Thread eines zusammengefuehrten Tickets landet im Ziel', async () => {
    const { db, customerStore, ticketStore, ticketMail } = setup();
    const attachmentStore = createAttachmentStore({ db, dir: os.tmpdir() });
    const processor = createInboundProcessor({ ticketStore, customerStore, attachmentStore, ticketMail, auditLog: null, log: QUIET });
    const customer = await makeCustomer(customerStore);
    const target = ticketStore.createTicket({ customer, subject: 'Ziel', body: 'A' }).ticket;
    const source = ticketStore.createTicket({ customer, subject: 'Quelle', body: 'B' }).ticket;
    ticketStore.mergeTickets(source.id, target.id);

    const result = await processor.process({
        from: customer.email, subject: 'Re: Quelle', inReplyTo: ticketMail.rootId(source.id), text: 'Nachtrag',
    });
    assert.equal(result.result, 'added');
    assert.equal(result.ticketId, target.id);
    assert.ok(ticketStore.listMessages(target.id).some(m => m.body === 'Nachtrag'));
});

test('mail-inbound: Betreff einer neuen Mail ohne Antwort-/Weiterleitungs-Praefixe', () => {
    assert.equal(ticketSubject('Re: AW: Fwd: WG:  Download   kaputt'), 'Download kaputt');
    assert.equal(ticketSubject('RE[2]: Test'), 'Test');
    assert.equal(ticketSubject('   '), '(ohne Betreff)');
    assert.equal(ticketSubject('x'.repeat(300)).length, 150);
});

test('mail-outbox + ticket-mail: Anhaenge gehen bis zum Limit mit, der Rest nur als Name; geloeschte fehlen einfach', async () => {
    const db = openDatabase(':memory:');
    const sent = [];
    const mailer = createMailer({ transport: { sendMail: async mail => { sent.push(mail); } }, from: 'support@iso.test', log: QUIET });
    const files = { a1: { filename: 'klein.png', path: '/tmp/klein.png', contentType: 'image/png' } };
    const outbox = createMailOutbox({
        db, mailer, log: QUIET, resolveAttachments: async ids => ids.map(id => files[id]).filter(Boolean),
    });
    const customerStore = createCustomerStore({ db });
    const ticketStore = createTicketStore({ db });
    const ticketMail = createTicketMail({
        outbox, customerStore, publicUrl: 'https://support.test', threadSecret: 'x', domain: 'iso.test',
        attachmentMaxBytes: 100,
    });
    const customer = await makeCustomer(customerStore);
    const { ticket } = ticketStore.createTicket({ customer, subject: 'A', body: 'x' });
    const { message, ticket: updated } = ticketStore.addReply(ticket.id, { author: 'admin', body: 'Anbei' });
    ticketMail.adminReplied(updated, message, [
        { id: 'a1', filename: 'klein.png', size: 60 },
        { id: 'a2', filename: 'gross.pdf', size: 60 },
        { id: 'gone', filename: 'weg.txt', size: 10 },
    ]);
    await outbox.whenIdle();
    const [mail] = sent;
    assert.deepEqual(mail.attachments.map(a => a.filename), ['klein.png'], 'weg.txt ist geloescht, gross.pdf zu gross');
    assert.match(mail.text, /gross\.pdf \(im Portal\)/);
    const row = db.prepare('SELECT attachments_json FROM mail_outbox').get();
    assert.deepEqual(JSON.parse(row.attachments_json), ['a1', 'gone']);
});

test('markdown: Grundformate, Code bleibt woertlich, kein HTML und keine gefaehrlichen Links', () => {
    const fence = '`'.repeat(3);
    const html = renderMarkdown([
        '# Titel', '', 'Text mit **fett**, *kursiv* und `a*b*c`.', '',
        '- eins', '- zwei', '', '1. erst', '2. dann', '',
        fence, '<b>nicht fett</b> **auch nicht**', fence,
    ].join('\n'));
    assert.match(html, /^<h2>Titel<\/h2>/);
    assert.match(html, /<strong>fett<\/strong>, <em>kursiv<\/em> und <code>a\*b\*c<\/code>/);
    assert.match(html, /<ul><li>eins<\/li><li>zwei<\/li><\/ul>/);
    assert.match(html, /<ol><li>erst<\/li><li>dann<\/li><\/ol>/);
    assert.match(html, /<pre><code>&lt;b&gt;nicht fett&lt;\/b&gt; \*\*auch nicht\*\*<\/code><\/pre>/);

    const attacks = renderMarkdown([
        '<script>alert(1)</script>', '[a](javascript:alert(1))', '[b](//evil.example)', '[c](/\\evil.example)',
        '[d](data:text/html,x)', '[e](https://ok.example/?a="b")', '<img src=x onerror=alert(1)>',
    ].join('\n\n'));
    assert.doesNotMatch(attacks, /<script|<img|href="javascript|href="\/\/|href="\/\\|href="data/);
    assert.match(attacks, /href="https:\/\/ok\.example\/\?a=&quot;b&quot;" rel="noopener noreferrer"/);
    assert.match(renderMarkdown('[Hilfe](/support)'), /<a href="\/support">Hilfe<\/a>/);
    assert.match(renderMarkdown('Siehe https://iso.test/x.'), /<a href="https:\/\/iso\.test\/x" [^>]*>https:\/\/iso\.test\/x<\/a>\./);
    assert.equal(plainExcerpt('## Titel\n\n**Text** mit [Link](https://x)', 100), 'Titel Text mit Link');
});

test('markdown/formatMessage: Klammern und Anfuehrungszeichen um URLs, Kursiv in Fett, Listenstart', () => {
    const link = url => new RegExp(`<a href="${url.replace(/[.?()/]/g, '\\$&')}"`);
    assert.match(renderMarkdown('(siehe https://x.test/a)'), link('https://x.test/a'));
    assert.match(renderMarkdown('(siehe https://x.test/a)'), /<\/a>\)<\/p>/);
    assert.match(renderMarkdown('https://x.test/wiki/A_(B)'), link('https://x.test/wiki/A_(B)'));
    const quoted = renderMarkdown('Link: "https://x.test/q" und <https://x.test/r>');
    assert.match(quoted, link('https://x.test/q'));
    assert.match(quoted, link('https://x.test/r'));
    assert.doesNotMatch(quoted, /&quot"|&gt"|href="[^"]*&(quot|gt)/);
    assert.match(renderMarkdown('**fett *kursiv* fett**'), /<strong>fett <em>kursiv<\/em> fett<\/strong>/);
    assert.match(renderMarkdown('3. drei\n4. vier'), /<ol start="3"><li>drei<\/li><li>vier<\/li><\/ol>/);
    // "##" als groesste Ebene (Editor-Hinweis) wird h2, keine Luecke nach dem h1-Titel
    assert.equal(renderMarkdown('## A\n\n### B'), '<h2>A</h2>\n<h3>B</h3>');
    assert.equal(renderMarkdown('# A\n\n## B'), '<h2>A</h2>\n<h3>B</h3>');
    assert.equal(renderMarkdown('```\n# kein Titel\n```\n\n## A'), '<pre><code># kein Titel</code></pre>\n<h2>A</h2>');

    assert.match(formatMessage('https://x.test/wiki/A_(B)'), link('https://x.test/wiki/A_(B)'));
    assert.match(formatMessage('(siehe https://x.test/a)'), /x\.test\/a<\/a>\)$/);
});

test('kb-store: Suche ab zwei Buchstaben, ohne verwertbares Wort keine Treffer statt aller', () => {
    const kb = createKbStore({ db: openDatabase(':memory:') });
    kb.create({ title: 'Welches OS?', body: 'Linux', published: true });
    kb.create({ title: 'Download', body: 'Mirror', published: true });
    assert.deepEqual(kb.list({ publishedOnly: true, q: 'OS' }).map(x => x.title), ['Welches OS?']);
    assert.deepEqual(kb.list({ publishedOnly: true, q: '!!' }), []);
    assert.deepEqual(kb.suggest('OS'), [], 'Vorschlaege erst ab drei Zeichen');
});

test('kb-store: Slug einmalig und stabil, Suche und Vorschlaege nur veroeffentlicht', () => {
    const db = openDatabase(':memory:');
    const kb = createKbStore({ db });
    assert.equal(slugify('Wie prüfe ich die Checksumme?'), 'wie-pruefe-ich-die-checksumme');
    assert.equal(safeKbSlug('wie-pruefe-ich'), 'wie-pruefe-ich');
    assert.equal(safeKbSlug('../x'), null);

    const a = kb.create({ title: 'Checksumme prüfen', body: 'sha256sum nutzen', published: true }).article;
    const b = kb.create({ title: 'Checksumme prüfen', body: 'zweiter', published: false }).article;
    assert.equal(a.slug, 'checksumme-pruefen');
    assert.equal(b.slug, 'checksumme-pruefen-2');
    assert.ok(kb.create({ title: '', body: 'x' }).error);

    const renamed = kb.update(a.id, { title: 'Prüfsumme kontrollieren', body: 'sha256sum nutzen', published: true }).article;
    assert.equal(renamed.slug, 'checksumme-pruefen', 'Slug bleibt beim Umbenennen');

    assert.deepEqual(kb.list({ publishedOnly: true }).map(x => x.id), [a.id]);
    assert.deepEqual(kb.list({ q: 'sha256sum' }).map(x => x.id), [a.id]);
    assert.deepEqual(kb.suggest('Prüfsumme falsch').map(x => x.id), [a.id]);
    assert.deepEqual(kb.suggest('zweiter').map(x => x.id), [], 'Entwurf taucht nicht auf');
    assert.deepEqual(kb.suggest('ab'), [], 'zu kurze Woerter');

    kb.recordView(a.id);
    assert.equal(kb.topViewed()[0].views, 1);
    kb.setPublished(a.id, false);
    assert.deepEqual(kb.suggest('sha256sum'), []);
    assert.ok(kb.remove(b.id));
    assert.equal(kb.get(b.id), null);
});

test('ticket-reports: Kennzahlen, SLA-Quote ohne Support-Tickets, Buckets an der Wanduhr', async () => {
    const { db, customerStore, ticketStore, configStore } = setup();
    configStore.updateSla({ normal_first: 1 });
    const clock = createClock('Europe/Berlin');
    const customer = await makeCustomer(customerStore);
    const now = Date.now();
    const quick = ticketStore.createTicket({ customer, subject: 'schnell', body: 'x' }).ticket;
    const slow = ticketStore.createTicket({ customer, subject: 'langsam', body: 'x', isoFile: 'a.iso' }).ticket;
    ticketStore.createTicket({ customer, subject: 'vom Support', body: 'x', author: 'admin' });
    const set = db.prepare('UPDATE tickets SET created_at = ?, first_response_at = ?, resolved_at = ?, rating = ?, rating_comment = ?, rated_at = ? WHERE id = ?');
    set.run(now - 3 * 3600e3, now - 3 * 3600e3 + 30 * 60e3, now - 3600e3, 5, 'super', now - 3600e3, quick.id);
    set.run(now - 3 * 3600e3, now - 3600e3, null, null, null, null, slow.id);

    const report = createTicketReports({ db, clock }).report({ from: now - 7 * 24 * 3600e3, to: now + 1000 });
    assert.equal(report.createdCount, 3);
    assert.equal(report.resolvedCount, 1);
    assert.deepEqual(report.sla, { hit: 1, missed: 1, rate: 0.5 });
    assert.equal(report.firstResponse.n, 2, 'vom Support angelegte Tickets zaehlen nicht');
    assert.equal(report.csat.average, 5);
    assert.deepEqual(report.comments.map(c => c.comment), ['super']);
    assert.deepEqual(report.bySource.map(e => [e.key, e.n]), [['web', 2], ['admin', 1]]);
    assert.deepEqual(report.byIsoFile.map(e => e.key), ['a.iso']);
    assert.equal(report.series.reduce((sum, b) => sum + b.created, 0), 3);

    // Wochen beginnen montags um Mitternacht Ortszeit, auch ueber die Zeitumstellung
    const { weekly, list } = buckets(Date.UTC(2026, 8, 1), Date.UTC(2026, 11, 1), clock);
    assert.equal(weekly, true);
    for (const bucket of list) {
        const p = clock.parts(bucket.start);
        assert.equal(new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay(), 1);
        assert.equal(p.hour, 0);
    }
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([]), null);
});

/* ============================================================ Wiedervorlage */

const { snoozePresets, parseSnoozeInput } = require('../lib/snooze');

test('snooze: Vorgaben um 9 Uhr Ortszeit, auch ueber die Zeitumstellung', () => {
    const clock = createClock('Europe/Berlin');
    // Freitag, 23.10.2026, 15:00 MESZ — "In 3 Tagen" liegt nach der Umstellung
    const now = Date.UTC(2026, 9, 23, 13, 0);
    const byKey = Object.fromEntries(snoozePresets(clock, now).map(p => [p.key, p.until]));
    assert.equal(byKey.tomorrow, Date.UTC(2026, 9, 24, 7, 0), 'Samstag 09:00 MESZ');
    assert.equal(byKey['3d'], Date.UTC(2026, 9, 26, 8, 0), 'Montag 09:00 MEZ');
    assert.equal(byKey.monday, Date.UTC(2026, 9, 26, 8, 0));
    assert.equal(byKey.week, Date.UTC(2026, 9, 30, 8, 0));
    // An einem Montag ist "naechster Montag" eine Woche spaeter, nicht heute
    const monday = Date.UTC(2026, 8, 21, 6, 0);
    assert.equal(snoozePresets(clock, monday).find(p => p.key === 'monday').until, Date.UTC(2026, 8, 28, 7, 0));
});

test('snooze: Eingabe pruefen — Zukunft, hoechstens ein Jahr, gueltiges Format', () => {
    const clock = createClock('Europe/Berlin');
    const now = Date.UTC(2026, 8, 24, 10, 0);
    assert.equal(parseSnoozeInput({ until: '2026-09-25T08:30' }, clock, now).until, Date.UTC(2026, 8, 25, 6, 30));
    assert.ok(parseSnoozeInput({ until: '2026-09-24T11:00' }, clock, now).error, 'Vergangenheit');
    assert.ok(parseSnoozeInput({ until: '2028-01-01T09:00' }, clock, now).error, 'mehr als ein Jahr');
    assert.ok(parseSnoozeInput({ until: 'morgen' }, clock, now).error);
    assert.ok(parseSnoozeInput({ preset: 'nie' }, clock, now).error);
    assert.equal(parseSnoozeInput({ preset: 'tomorrow', until: 'Unsinn' }, clock, now).until, Date.UTC(2026, 8, 25, 7, 0),
        'eine Vorgabe hat Vorrang vor dem eigenen Zeitpunkt');
});

test('ticket-store: Wiedervorlage blendet aus den Arbeitsansichten aus, nicht aus overdue', async () => {
    const { customerStore, ticketStore } = setup();
    const customer = await makeCustomer(customerStore);
    const { ticket } = ticketStore.createTicket({ customer, subject: 'A', body: 'x' });
    const other = ticketStore.createTicket({ customer, subject: 'B', body: 'y' }).ticket;

    const snoozed = ticketStore.snooze(ticket.id, Date.now() + DAY_MS, { label: 'morgen', note: 'Hersteller fragen' });
    assert.ok(snoozed.snoozedUntil > Date.now());
    assert.equal(snoozed.adminUnread, false);
    let counts = ticketStore.countViews();
    assert.equal(counts.active, 1);
    assert.equal(counts.new, 1);
    assert.equal(counts.snoozed, 1);
    assert.deepEqual(ticketStore.listTickets({ view: 'snoozed' }).tickets.map(t => t.id), [ticket.id]);
    assert.deepEqual(ticketStore.listTickets({ view: 'active' }).tickets.map(t => t.id), [other.id]);
    const messages = ticketStore.listMessages(ticket.id);
    assert.ok(messages.some(m => m.kind === 'event' && m.internal && m.body === 'Wiedervorlage bis morgen'));
    assert.ok(messages.some(m => m.kind === 'note' && m.body === 'Hersteller fragen'));

    // Die Frist laeuft weiter: ueberfaellig bleibt sichtbar
    ticketStore.db.prepare('UPDATE ticket_sla SET first_response_minutes = 1 WHERE priority = ?').run('normal');
    ticketStore.db.prepare('UPDATE tickets SET created_at = ? WHERE id = ?').run(Date.now() - 10 * 60000, ticket.id);
    assert.ok(ticketStore.listTickets({ view: 'overdue' }).tickets.some(t => t.id === ticket.id));

    // Ein abgelaufener Zeitpunkt zeigt das Ticket sofort wieder — ohne Automatik-Lauf
    ticketStore.db.prepare('UPDATE tickets SET snoozed_until = ? WHERE id = ?').run(Date.now() - 1000, ticket.id);
    counts = ticketStore.countViews();
    assert.equal(counts.active, 2);
    assert.equal(counts.snoozed, 0);
});

test('ticket-store: Kundenantwort und Loesen heben die Wiedervorlage auf, Support-Antwort nicht', async () => {
    const { customerStore, ticketStore } = setup();
    const customer = await makeCustomer(customerStore);
    const { ticket } = ticketStore.createTicket({ customer, subject: 'A', body: 'x' });
    const later = Date.now() + DAY_MS;

    ticketStore.snooze(ticket.id, later);
    ticketStore.addReply(ticket.id, { author: 'admin', body: 'Wir melden uns' });
    assert.equal(ticketStore.getTicket(ticket.id).snoozedUntil, later);

    ticketStore.addReply(ticket.id, { author: 'customer', body: 'Noch eine Frage' });
    assert.equal(ticketStore.getTicket(ticket.id).snoozedUntil, null);

    ticketStore.snooze(ticket.id, later);
    ticketStore.setStatus(ticket.id, 'resolved');
    assert.equal(ticketStore.getTicket(ticket.id).snoozedUntil, null);
    assert.equal(ticketStore.snooze(ticket.id, later), null, 'geloeste Tickets lassen sich nicht zurueckstellen');

    ticketStore.setStatus(ticket.id, 'open');
    ticketStore.snooze(ticket.id, later);
    assert.equal(ticketStore.unsnooze(ticket.id), true);
    assert.equal(ticketStore.unsnooze(ticket.id), false, 'nichts mehr aufzuheben');
    assert.ok(ticketStore.listMessages(ticket.id).some(m => m.body === 'Wiedervorlage aufgehoben'));
});

test('ticket-automation: Wiedervorlage wird faellig, keine Erinnerung waehrend der Wiedervorlage', async () => {
    const { customerStore, ticketStore, configStore, ticketMail } = setup();
    configStore.updateSettings({ pendingReminderDays: 3, pendingAutoResolveDays: 7, autoCloseDays: 7 });
    const automation = createTicketAutomation({ ticketStore, configStore, ticketMail, auditLog: null, log: QUIET });
    const customer = await makeCustomer(customerStore);
    const { ticket } = ticketStore.createTicket({ customer, subject: 'A', body: 'x' });
    ticketStore.addReply(ticket.id, { author: 'admin', body: 'Antwort' });
    const now = Date.now();
    ticketStore.snooze(ticket.id, now + 10 * DAY_MS);

    // Erinnerung waere nach 3 Tagen faellig — waehrend der Wiedervorlage nicht
    const quiet = automation.runOnce(now + 4 * DAY_MS);
    assert.equal(quiet.reminded, 0);
    assert.equal(quiet.woken, 0);

    ticketStore.db.prepare('UPDATE tickets SET snoozed_until = ? WHERE id = ?').run(now - 1000, ticket.id);
    assert.equal(automation.runOnce(now).woken, 1);
    const woken = ticketStore.getTicket(ticket.id);
    assert.equal(woken.snoozedUntil, null);
    assert.equal(woken.adminUnread, true, 'faellige Wiedervorlage erscheint als ungelesen');
    assert.ok(ticketStore.listMessages(ticket.id).some(m => m.body === 'Wiedervorlage fällig' && m.internal));
    assert.equal(automation.runOnce(now).woken, 0, 'nur einmal');
});

test('ticket-store: Wiedervorlage taucht im Kundenexport nicht auf', async () => {
    const { customerStore, ticketStore } = setup();
    const customer = await makeCustomer(customerStore);
    const { ticket } = ticketStore.createTicket({ customer, subject: 'A', body: 'x' });
    ticketStore.snooze(ticket.id, Date.now() + DAY_MS, { label: 'morgen', note: 'nur fuer den Support' });
    const exported = JSON.stringify(ticketStore.exportForCustomer(customer.id));
    assert.ok(!/snooze|Wiedervorlage|nur fuer den Support/i.test(exported));
});
