'use strict';

/* Haertung des Ticketsystems: atomares Speichern von Anhaengen
   (lib/db-tx.js, lib/attachment-store.js commit()), Speicherreserve,
   verwaiste Dateien, Mail-Eingang (Duplikate, Schleifenschutz, DKIM fuer
   Antworten, Anhang-Grenzen) und der IMAP-Poller (UID-Stand, begrenzter
   Download, Verschieben) — plus die Limiter/Tagesgrenze der Kundenrouten. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

const { openDatabase } = require('../lib/db');
const { transaction } = require('../lib/db-tx');
const { createCustomerStore } = require('../lib/customer-store');
const { createTicketStore } = require('../lib/ticket-store');
const { createAttachmentStore, AttachmentError } = require('../lib/attachment-store');
const { createMailer } = require('../lib/mailer');
const { createMailOutbox } = require('../lib/mail-outbox');
const { createTicketMail } = require('../lib/ticket-mail');
const { createInboundProcessor, htmlToText, decodeEntities } = require('../lib/mail-inbound');
const { createInboundMailStore } = require('../lib/inbound-mail-store');
const {
    createImapPoller, isAutoSubmitted, suppressesAutoResponse, streamToBuffer,
} = require('../lib/imap-poller');
const { startTestApp } = require('./helpers/app');

const QUIET = { log() {}, info() {}, debug() {}, warn() {}, error() {} };
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const HOUR = 60 * 60 * 1000;

async function tempDir() {
    return fsp.mkdtemp(path.join(os.tmpdir(), 'iso-share-hardening-'));
}

async function setup(t, { attachmentOptions = {}, authservId = null } = {}) {
    const db = openDatabase(':memory:');
    const dir = await tempDir();
    t.after(() => fsp.rm(dir, { recursive: true, force: true }));
    const sent = [];
    const mailer = createMailer({ transport: { sendMail: async mail => { sent.push(mail); } }, from: 'support@iso.test', log: QUIET });
    const customerStore = createCustomerStore({ db });
    const ticketStore = createTicketStore({ db });
    const outbox = createMailOutbox({ db, mailer, log: QUIET });
    const ticketMail = createTicketMail({
        outbox, customerStore, publicUrl: 'https://support.test/', notifyEmail: 'admin@example.com',
        replyTo: 'support@iso.test', threadSecret: 'geheim', domain: 'iso.test', inboundEnabled: true,
    });
    const attachmentStore = createAttachmentStore({ db, dir, ...attachmentOptions });
    let clock = Date.now();
    const inboundStore = createInboundMailStore({ db, now: () => clock });
    const processor = createInboundProcessor({
        ticketStore, customerStore, attachmentStore, ticketMail, auditLog: null, log: QUIET, inboundStore, authservId,
        now: () => clock,
    });
    const customer = await customerStore.createCustomer({ email: 'kunde@example.com', name: 'Kim', password: 'x'.repeat(12) });
    customerStore.markVerified(customer.id);
    return {
        db, dir, sent, outbox, customerStore, ticketStore, ticketMail, attachmentStore, inboundStore, processor,
        customer: customerStore.getCustomer(customer.id),
        advance: ms => { clock += ms; },
    };
}

async function filesIn(dir) {
    try {
        return await fsp.readdir(dir);
    } catch {
        return [];
    }
}

/* ================================================================ db-tx */

test('db-tx: innere Ebene als SAVEPOINT, Fehler innen rollt nur innen zurueck', () => {
    const db = openDatabase(':memory:');
    db.exec('CREATE TABLE t (v INTEGER)');
    transaction(db, () => {
        db.prepare('INSERT INTO t VALUES (1)').run();
        assert.throws(() => transaction(db, () => {
            db.prepare('INSERT INTO t VALUES (2)').run();
            throw new Error('innen');
        }), /innen/);
        transaction(db, () => db.prepare('INSERT INTO t VALUES (3)').run());
    });
    assert.deepEqual(db.prepare('SELECT v FROM t ORDER BY v').all().map(r => r.v), [1, 3]);

    assert.throws(() => transaction(db, () => {
        transaction(db, () => db.prepare('INSERT INTO t VALUES (4)').run());
        throw new Error('aussen');
    }), /aussen/);
    assert.deepEqual(db.prepare('SELECT v FROM t ORDER BY v').all().map(r => r.v), [1, 3], 'aussen rollt alles zurueck');

    assert.throws(() => transaction(db, async () => {}), /Promise/);
    // Danach wieder normal nutzbar (Tiefe korrekt zurueckgesetzt)
    transaction(db, () => db.prepare('INSERT INTO t VALUES (5)').run());
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM t').get().n, 3);
});

/* ===================================================== attachment-store */

test('attachment-store commit: Ticket, Nachricht und Anhaenge gemeinsam — oder gar nicht', async t => {
    const { ticketStore, attachmentStore, customer, dir, db } = await setup(t);
    const count = () => db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n;

    const ok = await attachmentStore.commit(attachmentStore.inspectBuffers([{ filename: 'a.png', content: PNG }]),
        () => ticketStore.createTicket({ customer, subject: 'A', body: 'x' }));
    assert.equal(ok.stored.length, 1);
    assert.equal(ok.stored[0].messageId, ok.result.message.id);
    assert.equal(count(), 1);
    assert.equal((await filesIn(dir)).length, 1);

    // Anhang-Zeile scheitert NACH createTicket (filename NOT NULL): alles zurueck
    await assert.rejects(attachmentStore.commit(
        [{ buffer: PNG, filename: null, mime: 'image/png', size: PNG.length }],
        () => ticketStore.createTicket({ customer, subject: 'B', body: 'y' })
    ));
    assert.equal(count(), 1, 'kein halbes Ticket');
    assert.equal((await filesIn(dir)).length, 1, 'geschriebene Datei wieder entfernt');

    // Callback wirft
    await assert.rejects(attachmentStore.commit(attachmentStore.inspectBuffers([{ filename: 'c.png', content: PNG }]),
        () => { throw new Error('kaputt'); }), /kaputt/);
    assert.equal((await filesIn(dir)).length, 1);

    // Callback legt nichts an (Ticket zusammengefuehrt …)
    const none = await attachmentStore.commit(attachmentStore.inspectBuffers([{ filename: 'd.png', content: PNG }]), () => null);
    assert.deepEqual(none, { result: null, stored: [] });
    assert.equal((await filesIn(dir)).length, 1);
});

test('attachment-store: zu wenig Speicher -> AttachmentError, bevor irgendetwas angelegt wird', async t => {
    let free = 10 * 1024 * 1024;
    const { ticketStore, attachmentStore, customer, db } = await setup(t, {
        attachmentOptions: { minFreeBytes: 5 * 1024 * 1024, diskInfo: async () => ({ free, device: 1 }) },
    });
    assert.equal(await attachmentStore.hasSpaceFor(1024), true);
    free = 5 * 1024 * 1024 + 10;
    assert.equal(await attachmentStore.hasSpaceFor(1024), false);

    await assert.rejects(
        attachmentStore.commit(attachmentStore.inspectBuffers([{ filename: 'a.png', content: PNG }]),
            () => ticketStore.createTicket({ customer, subject: 'A', body: 'x' })),
        err => err instanceof AttachmentError && err.code === 'insufficient_storage'
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n, 0);
    // Ohne Anhaenge blockiert die Pruefung nicht
    const plain = await attachmentStore.commit([], () => ticketStore.createTicket({ customer, subject: 'B', body: 'y' }));
    assert.ok(plain.result.ticket);
});

test('attachment-store: sweepOrphans entfernt nur alte Dateien ohne DB-Zeile', async t => {
    const { ticketStore, attachmentStore, customer, dir } = await setup(t);
    const { stored } = await attachmentStore.commit(attachmentStore.inspectBuffers([{ filename: 'a.png', content: PNG }]),
        () => ticketStore.createTicket({ customer, subject: 'A', body: 'x' }));
    const old = new Date(Date.now() - 2 * HOUR);
    const orphan = crypto.randomUUID();
    const young = crypto.randomUUID();
    await fsp.writeFile(path.join(dir, orphan), 'x');
    await fsp.utimes(path.join(dir, orphan), old, old);
    await fsp.writeFile(path.join(dir, young), 'x');
    await fsp.writeFile(path.join(dir, 'README'), 'x');
    await fsp.utimes(path.join(dir, 'README'), old, old);
    await fsp.utimes(attachmentStore.filePath(stored[0].id), old, old);

    assert.equal(await attachmentStore.sweepOrphans(), 1);
    assert.deepEqual((await filesIn(dir)).sort(), [stored[0].id, young, 'README'].sort());
});

/* ========================================================= mail-inbound */

async function replySetup(t, options) {
    const ctx = await setup(t, options);
    const { ticket } = ctx.ticketStore.createTicket({ customer: ctx.customer, subject: 'A', body: 'x' });
    ctx.ticketStore.addReply(ticket.id, { author: 'admin', body: 'Frage' });
    return { ...ctx, ticket, root: ctx.ticketMail.rootId(ticket.id) };
}

test('mail-inbound: dieselbe Mail (Message-ID) wird nur einmal verarbeitet', async t => {
    const { processor, ticketStore, ticket, root } = await replySetup(t);
    const mail = { from: 'kunde@example.com', references: root, messageId: '<Abc@Mail.Example>', text: 'Hallo' };
    assert.equal((await processor.process(mail)).result, 'added');
    assert.equal((await processor.process({ ...mail, messageId: '<abc@mail.example>' })).result, 'duplicate');
    // Andere Absender-Adresse mit derselben Message-ID "verbraucht" nichts
    assert.equal((await processor.process({ ...mail, from: 'fremd@example.com' })).result, 'sender_mismatch');
    // Ohne Message-ID greift der Ersatzschluessel des Pollers
    assert.equal((await processor.process({ ...mail, messageId: '', dedupKey: 'uid:INBOX:1:7' })).result, 'added');
    assert.equal((await processor.process({ ...mail, messageId: '', dedupKey: 'uid:INBOX:1:7' })).result, 'duplicate');
    assert.equal(ticketStore.listMessages(ticket.id).filter(m => m.via === 'email').length, 2);
    assert.equal(processor.stats().duplicate, 2);
});

test('mail-inbound: Hinweis auf geschlossenes Ticket hoechstens einmal je 24 h, nie bei Auto-Response-Suppress', async t => {
    const { processor, ticketStore, ticket, root, outbox, sent, advance } = await replySetup(t);
    ticketStore.setStatus(ticket.id, 'closed');
    const notices = async () => {
        await outbox.whenIdle();
        return sent.filter(m => /geschlossen/.test(m.subject)).length;
    };
    const mail = n => ({ from: 'kunde@example.com', references: root, messageId: `<m${n}@x>`, text: 'Hallo?' });

    assert.equal((await processor.process(mail(1))).result, 'ticket_closed');
    assert.equal((await processor.process(mail(2))).result, 'ticket_closed');
    assert.equal(await notices(), 1, 'kein Ping-Pong mit einem Autoresponder');
    advance(25 * HOUR);
    await processor.process({ ...mail(3), suppressAutoResponse: true });
    assert.equal(await notices(), 1);
    await processor.process(mail(4));
    assert.equal(await notices(), 2);
});

test('mail-inbound: mit authserv-id brauchen auch Antworten DKIM/DMARC', async t => {
    const { processor, ticketStore, ticket, root } = await replySetup(t, { authservId: 'mx.test' });
    const mail = extra => ({ from: 'kunde@example.com', references: root, text: 'Antwort', ...extra });
    assert.equal((await processor.process(mail({ messageId: '<1@x>' }))).result, 'auth_failed');
    assert.equal((await processor.process(mail({
        messageId: '<2@x>', authResults: ['mx.test; dmarc=fail header.from=example.com'],
    }))).result, 'auth_failed');
    assert.equal((await processor.process(mail({
        messageId: '<3@x>', authResults: ['mx.test; dkim=pass header.d=example.com'],
    }))).result, 'added');
    assert.equal(ticketStore.listMessages(ticket.id).filter(m => m.via === 'email').length, 1);
});

test('mail-inbound: zu grosse/zu viele Anhaenge als Hinweis, voller Speicher -> Nachricht ohne Anhaenge', async t => {
    let free = 1e12;
    const { processor, ticketStore, ticket, root } = await replySetup(t, {
        attachmentOptions: { minFreeBytes: 1024, diskInfo: async () => ({ free, device: 1 }) },
    });
    const result = await processor.process({
        from: 'kunde@example.com', references: root, messageId: '<a@x>', text: 'Anbei',
        attachments: [{ filename: 'gross.iso', tooLarge: true }, { filename: 'ok.png', content: PNG }],
        attachmentCount: 9,
    });
    assert.equal(result.result, 'added');
    let last = ticketStore.listMessages(ticket.id).at(-1);
    assert.deepEqual(last.attachments.map(a => a.filename), ['ok.png']);
    assert.match(last.body, /gross\.iso.*zu groß/);
    assert.match(last.body, /Nur die ersten 5 Anhänge/);

    free = 10;
    const full = await processor.process({
        from: 'kunde@example.com', references: root, messageId: '<b@x>', text: 'Noch eins',
        attachments: [{ filename: 'ok.png', content: PNG }],
    });
    assert.equal(full.result, 'added');
    last = ticketStore.listMessages(ticket.id).at(-1);
    assert.equal(last.attachments.length, 0);
    assert.match(last.body, /^Noch eins/);
    assert.match(last.body, /zu wenig Speicherplatz/);
});

test('mail-inbound: htmlToText dekodiert numerische Entities, laesst Doppelt-Kodiertes stehen', () => {
    assert.equal(htmlToText('<p>Preis: 5&#8364; &#x2013; &amp;lt;ok&amp;gt; &uuml;</p>'), 'Preis: 5€ – &lt;ok&gt; &uuml;');
    assert.equal(decodeEntities('&#0; &#xD800; &#1114112;'), '&#0; &#xD800; &#1114112;');
    assert.equal(htmlToText('a&nbsp;b'), 'a b');
});

/* =========================================================== imap-poller */

test('imap-poller: erkennt Bounces/Listen als automatisch, Suppress-Header nur als "keine Auto-Antwort"', () => {
    assert.equal(isAutoSubmitted({ 'list-id': '<x.lists.example>' }), true);
    assert.equal(isAutoSubmitted({ 'return-path': '<>' }), true);
    assert.equal(isAutoSubmitted({}, 'MAILER-DAEMON@mx.example'), true);
    assert.equal(isAutoSubmitted({ 'return-path': '<kunde@example.com>' }, 'kunde@example.com'), false);
    assert.equal(suppressesAutoResponse({ 'x-auto-response-suppress': 'DR, OOF, AutoReply' }), true);
    assert.equal(suppressesAutoResponse({ 'x-loop': 'support' }), true);
    assert.equal(suppressesAutoResponse({}), false);
});

test('imap-poller: streamToBuffer liest nie mehr als maxBytes + 1', async () => {
    const big = Readable.from([Buffer.alloc(600), Buffer.alloc(600), Buffer.alloc(600)]);
    assert.equal((await streamToBuffer(big, 1000)).length, 1001);
    assert.equal((await streamToBuffer(Readable.from([Buffer.from('abc')]), 1000)).toString(), 'abc');
});

/* Minimaler imapflow-Ersatz: UIDs mit Flags, Suche nach seen:false bzw.
   UID-Bereich "n:*" (inkl. RFC-Eigenheit: immer auch die hoechste UID). */
function fakeImap({ messages, uidValidity = 1n, structure = null }) {
    const calls = { download: [], moved: [], created: 0, searches: [] };
    const client = {
        mailbox: null,
        async connect() {},
        async getMailboxLock() {
            const uids = [...messages.keys()];
            client.mailbox = { uidValidity, uidNext: Math.max(0, ...uids) + 1 };
            return { release() {} };
        },
        async search(query) {
            calls.searches.push(query);
            const uids = [...messages.keys()].sort((a, b) => a - b);
            if (query.seen === false) return uids.filter(uid => !messages.get(uid).seen);
            const from = Number(String(query.uid).split(':')[0]);
            const hits = uids.filter(uid => uid >= from);
            return hits.length ? hits : uids.slice(-1);
        },
        async fetchOne(uid) {
            return {
                envelope: { from: [{ address: 'kunde@example.com' }], subject: 'x', messageId: `<${uid}@x>` },
                bodyStructure: structure ?? { type: 'text/plain' },
                headers: Buffer.from(''),
            };
        },
        async download(uid, part) {
            calls.download.push(part);
            return { content: Readable.from([part === '1' ? Buffer.from('Text') : PNG]) };
        },
        async messageFlagsAdd(uid) { messages.get(Number(uid)).seen = true; },
        async messageMove(uid, target) { calls.moved.push([Number(uid), target]); messages.delete(Number(uid)); },
        async mailboxCreate() { calls.created += 1; return { created: true }; },
        async logout() {},
    };
    return { client, calls };
}

test('imap-poller: laedt hoechstens maxAttachmentFiles Anhaenge, zu grosse gar nicht', async () => {
    const attachments = Array.from({ length: 50 }, (_, i) => ({
        type: 'image/png', part: String(i + 2), disposition: 'attachment',
        dispositionParameters: { filename: `a${i}.png` }, size: i === 0 ? 50 * 1024 * 1024 : 100,
    }));
    const { client, calls } = fakeImap({
        messages: new Map([[1, { seen: false }]]),
        structure: { type: 'multipart/mixed', childNodes: [{ type: 'text/plain', part: '1' }, ...attachments] },
    });
    const processed = [];
    const poller = createImapPoller({
        host: 'imap.test', user: 'u', log: QUIET, clientFactory: () => client, maxAttachmentFiles: 3,
        maxAttachmentBytes: 1024 * 1024, processor: { process: async mail => { processed.push(mail); } },
    });
    assert.equal(await poller.pollOnce(), 1);
    assert.deepEqual(calls.download, ['1', '3', '4'], 'Text + 2 Anhaenge, der 50-MB-Anhang wird nicht geladen');
    const [mail] = processed;
    assert.equal(mail.attachmentCount, 50);
    assert.equal(mail.attachments.length, 3);
    assert.deepEqual(mail.attachments[0], { filename: 'a0.png', tooLarge: true });
    assert.equal(mail.dedupKey, 'uid:INBOX:1:1');
});

test('imap-poller: merkt sich die UID statt \\Seen, erster Lauf nur ungelesene, optional verschieben', async t => {
    const db = openDatabase(':memory:');
    const stateStore = createInboundMailStore({ db });
    const messages = new Map([[3, { seen: true }], [5, { seen: false }]]);
    const { client, calls } = fakeImap({ messages });
    const processed = [];
    const poller = createImapPoller({
        host: 'imap.test', user: 'u', log: QUIET, clientFactory: () => client, stateStore,
        processor: { process: async mail => { processed.push(mail.messageId); } },
    });

    assert.equal(await poller.pollOnce(), 1, 'erster Lauf: nur die ungelesene');
    assert.deepEqual(processed, ['<5@x>']);
    assert.deepEqual(stateStore.getImapState('INBOX'), { uidValidity: '1', lastUid: 5 });

    assert.equal(await poller.pollOnce(), 0, '"6:*" liefert UID 5 zurueck — wird ausgefiltert');

    // Neue Mail, die ein Mensch schon im Mailprogramm gelesen hat
    messages.set(6, { seen: true });
    messages.set(7, { seen: false });
    assert.equal(await poller.pollOnce(), 2);
    assert.deepEqual(processed, ['<5@x>', '<6@x>', '<7@x>']);
    assert.equal(stateStore.getImapState('INBOX').lastUid, 7);
    assert.deepEqual(calls.searches.at(-1), { uid: '6:*' });

    // Neue UIDVALIDITY (Postfach neu angelegt): wieder nur ungelesene
    client.mailbox = null;
    const other = fakeImap({ messages: new Map([[1, { seen: true }], [2, { seen: false }]]), uidValidity: 9n });
    const poller2 = createImapPoller({
        host: 'imap.test', user: 'u', log: QUIET, clientFactory: () => other.client, stateStore,
        processedMailbox: 'Verarbeitet', processor: { process: async () => {} },
    });
    assert.equal(await poller2.pollOnce(), 1);
    assert.deepEqual(other.calls.moved, [[2, 'Verarbeitet']]);
    assert.equal(other.calls.created, 1);
    other.client.mailbox = null;
    await poller2.pollOnce();
    assert.equal(other.calls.created, 1, 'Ordner nur einmal anlegen');
    assert.deepEqual(stateStore.getImapState('INBOX'), { uidValidity: '9', lastUid: 2 });
});

test('inbound-mail-store: prune entfernt alte Eintraege', () => {
    const db = openDatabase(':memory:');
    let now = 1_000_000_000_000;
    const store = createInboundMailStore({ db, now: () => now });
    assert.equal(store.claim('a'), true);
    assert.equal(store.claim('a'), false);
    assert.equal(store.claim(''), true, 'leerer Schluessel wird nie blockiert');
    assert.equal(store.notifyOnce('k', HOUR), true);
    now += 100 * 24 * HOUR;
    assert.equal(store.prune(), 2);
    assert.equal(store.claim('a'), true);
});

/* ================================================================ Routen */

const PASSWORD = 'ein-sehr-langes-passwort';

async function customerApp(t, overrides = {}) {
    const sent = [];
    const app = await startTestApp({
        mailTransport: { sendMail: async mail => { sent.push(mail); } }, publicUrl: 'http://support.test',
        startMailWorkers: false, ...overrides,
    });
    t.after(() => app.close());
    const { customerStore } = app.services;
    const customer = await customerStore.createCustomer({ email: 'kunde@example.com', name: 'Kim', password: PASSWORD });
    customerStore.markVerified(customer.id);
    const login = await fetch(app.url('/account/login'), {
        method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ email: 'kunde@example.com', password: PASSWORD }).toString(),
    });
    assert.equal(login.status, 302);
    const cookie = (login.headers.getSetCookie() || []).map(value => value.split(';')[0]).join('; ');
    return { app, cookie, customer };
}

function ticketForm(cookie, app, { subject = 'Hilfe', files = [] } = {}) {
    const form = new FormData();
    form.set('subject', subject);
    form.set('message', 'Bitte helfen');
    form.set('priority', 'normal');
    for (const [name, content] of files) form.append('attachments', new Blob([content]), name);
    return fetch(app.url('/account/tickets'), { method: 'POST', body: form, headers: { Cookie: cookie }, redirect: 'manual' });
}

test('Kundenroute: voller Datentraeger -> Formularmeldung statt 500, kein Ticket', async t => {
    let free = 1e12;
    const { app, cookie } = await customerApp(t, { diskInfo: async () => ({ free, device: 1 }) });
    free = 10;
    const res = await ticketForm(cookie, app, { files: [['a.png', PNG]] });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /nicht genug Speicherplatz/);
    assert.equal(app.services.ticketStore.db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n, 0);
    free = 1e12;
    assert.equal((await ticketForm(cookie, app, { files: [['a.png', PNG]] })).status, 303);
});

test('Kundenroute: hoechstens 20 neue Web-Tickets pro Tag und Konto', async t => {
    const { app, cookie, customer } = await customerApp(t);
    const { ticketStore } = app.services;
    for (let i = 0; i < 20; i += 1) ticketStore.createTicket({ customer, subject: `T${i}`, body: 'x' });
    const res = await ticketForm(cookie, app);
    assert.equal(res.status, 400);
    assert.match(await res.text(), /heute bereits sehr viele Tickets/);
});
