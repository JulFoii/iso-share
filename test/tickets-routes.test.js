'use strict';

/* Integrationstests des Ticketsystems gegen eine echte Instanz: Kundenkonto,
   Kunden- und Admin-Sicht, Anhaenge, Mails (Fake-Transport). */

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('fs/promises');

const { startTestApp } = require('./helpers/app');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const PASSWORD = 'ein-sehr-langes-passwort';

/* Instanz mit Fake-SMTP; alle verschickten Mails landen in app.sent. */
async function startTicketApp(overrides = {}) {
    const sent = [];
    const app = await startTestApp({
        mailTransport: { sendMail: async mail => { sent.push(mail); } },
        publicUrl: 'http://support.test',
        ticketNotifyEmail: 'admin@example.com',
        startMailWorkers: false,
        ...overrides,
    });
    app.sent = sent;
    app.mails = async () => {
        await app.services.outbox.whenIdle();
        return sent;
    };
    return app;
}

function formPost(body, cookie) {
    return {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) },
        body: new URLSearchParams(body).toString(),
    };
}

function cookieOf(res) {
    return (res.headers.getSetCookie() || []).map(value => value.split(';')[0]).join('; ');
}

function linkFrom(mail, pathPrefix) {
    const match = mail.text.match(new RegExp(`http://support\\.test(${pathPrefix}[^\\s]*)`));
    return match ? match[1] : null;
}

/* Registriert, bestaetigt per Mail-Link und meldet an — gibt den Cookie zurueck. */
async function registerCustomer(app, email = 'kunde@example.com', name = 'Kim Kunde') {
    const res = await fetch(app.url('/account/register'), formPost({
        name, email, password: PASSWORD, passwordConfirm: PASSWORD, privacy: '1',
    }));
    assert.equal(res.status, 200);
    const verifyMail = (await app.mails()).findLast(mail => mail.to === email.toLowerCase() && /bestätige/.test(mail.subject));
    assert.ok(verifyMail, 'Bestaetigungsmail fehlt');
    const verify = await fetch(app.url(linkFrom(verifyMail, '/account/verify')));
    assert.equal(verify.status, 200);
    const login = await fetch(app.url('/account/login'), formPost({ email, password: PASSWORD }));
    assert.equal(login.status, 302);
    return cookieOf(login);
}

async function createTicket(app, cookie, { subject = 'Download bricht ab', message = 'Hilfe!', files = [] } = {}) {
    const form = new FormData();
    form.set('subject', subject);
    form.set('message', message);
    form.set('priority', 'normal');
    for (const [name, content] of files) form.append('attachments', new Blob([content]), name);
    return fetch(app.url('/account/tickets'), { method: 'POST', body: form, headers: { Cookie: cookie }, redirect: 'manual' });
}

async function adminReply(app, adminCookie, number, fields, files = []) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    for (const [name, content] of files) form.append('attachments', new Blob([content]), name);
    return fetch(app.url(`/admin/tickets/${number}/reply`), {
        method: 'POST', body: form, headers: { Cookie: adminCookie }, redirect: 'manual',
    });
}

/* ================================================================ Konto */

test('Registrierung -> Bestaetigungsmail -> Login -> Ticket mit Anhang -> Mails an Kunde und Admin', async t => {
    const app = await startTicketApp();
    t.after(() => app.close());

    const cookie = await registerCustomer(app);
    const created = await createTicket(app, cookie, { files: [['screen.png', PNG], ['fehler.log', 'Zeile 1']] });
    assert.equal(created.status, 303);
    assert.equal(created.headers.get('location'), '/account/tickets/1001?created=1');

    const detail = await (await fetch(app.url('/account/tickets/1001'), { headers: { Cookie: cookie } })).text();
    assert.match(detail, /Download bricht ab/);
    assert.match(detail, /screen\.png/);
    assert.match(detail, /fehler\.log/);

    const list = await (await fetch(app.url('/account/tickets'), { headers: { Cookie: cookie } })).text();
    assert.match(list, /#1001/);

    const mails = await app.mails();
    const confirmation = mails.find(m => m.to === 'kunde@example.com' && m.subject === '[#1001] Download bricht ab');
    assert.ok(confirmation, 'Eingangsbestaetigung fehlt');
    assert.match(confirmation.text, /http:\/\/support\.test\/account\/tickets\/1001/);
    assert.ok(mails.some(m => m.to === 'admin@example.com' && /Neues Ticket \[#1001\]/.test(m.subject)));
});

test('Anhang mit Umlauten im Dateinamen kommt unveraendert an', async t => {
    const app = await startTicketApp();
    t.after(() => app.close());
    const cookie = await registerCustomer(app);
    await createTicket(app, cookie, { files: [['Größe_ß.png', PNG]] });

    const { ticketStore } = app.services;
    const [attachment] = ticketStore.listMessages(ticketStore.getByNumber(1001).id)[0].attachments;
    assert.equal(attachment.filename, 'Größe_ß.png');
    const res = await fetch(app.url(`/attachments/${attachment.id}`), { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /filename\*=UTF-8''Gr%C3%B6%C3%9Fe_%C3%9F\.png/);
});

test('Registrierung verraet nicht, ob eine Adresse schon existiert; Passwort vergessen genauso', async t => {
    const app = await startTicketApp();
    t.after(() => app.close());
    await registerCustomer(app);

    const again = await fetch(app.url('/account/register'), formPost({
        name: 'Jemand', email: 'KUNDE@example.com', password: PASSWORD, passwordConfirm: PASSWORD, privacy: '1',
    }));
    const fresh = await fetch(app.url('/account/register'), formPost({
        name: 'Neu', email: 'neu@example.com', password: PASSWORD, passwordConfirm: PASSWORD, privacy: '1',
    }));
    assert.equal(again.status, fresh.status);
    assert.equal(await again.text(), await fresh.text());
    assert.ok((await app.mails()).some(m => m.to === 'kunde@example.com' && /Registrierungsversuch/.test(m.subject)));

    const known = await (await fetch(app.url('/account/forgot'), formPost({ email: 'kunde@example.com' }))).text();
    const unknown = await (await fetch(app.url('/account/forgot'), formPost({ email: 'nobody@example.com' }))).text();
    assert.equal(known, unknown);
});

test('Login ohne bestaetigte Adresse wird abgelehnt, Admin kann manuell freischalten', async t => {
    const app = await startTicketApp();
    t.after(() => app.close());
    await fetch(app.url('/account/register'), formPost({
        name: 'Kim', email: 'kim@example.com', password: PASSWORD, passwordConfirm: PASSWORD, privacy: '1',
    }));
    const denied = await fetch(app.url('/account/login'), formPost({ email: 'kim@example.com', password: PASSWORD }));
    assert.equal(denied.status, 401);
    assert.match(await denied.text(), /bestätige zuerst/);

    const { cookie: admin } = await app.login();
    const customer = app.services.customerStore.findByEmail('kim@example.com');
    const verify = await fetch(app.url(`/admin/customers/${customer.id}/verify`), formPost({}, admin));
    assert.equal(verify.status, 303);
    const ok = await fetch(app.url('/account/login'), formPost({ email: 'kim@example.com', password: PASSWORD }));
    assert.equal(ok.status, 302);
});

test('Passwort zuruecksetzen: Link aus der Mail, einmalig gueltig, meldet andere Sitzungen ab', async t => {
    const app = await startTicketApp();
    t.after(() => app.close());
    const oldCookie = await registerCustomer(app);

    await fetch(app.url('/account/forgot'), formPost({ email: 'kunde@example.com' }));
    const resetMail = (await app.mails()).findLast(m => /Passwort zurücksetzen/.test(m.subject));
    const link = linkFrom(resetMail, '/account/reset');
    const token = new URL(link, 'http://x').searchParams.get('token');

    assert.equal((await fetch(app.url(link))).status, 200);
    const done = await fetch(app.url('/account/reset'), formPost({
        token, password: 'ganz-neues-passwort', passwordConfirm: 'ganz-neues-passwort',
    }));
    assert.equal(done.status, 302);
    assert.equal(done.headers.get('location'), '/account/login?reset=1');

    const reused = await fetch(app.url('/account/reset'), formPost({
        token, password: 'noch-ein-passwort', passwordConfirm: 'noch-ein-passwort',
    }));
    assert.equal(reused.status, 400);

    const stale = await fetch(app.url('/account/tickets'), { headers: { Cookie: oldCookie }, redirect: 'manual' });
    assert.equal(stale.status, 302, 'alte Sitzung muss abgemeldet sein');
    const login = await fetch(app.url('/account/login'), formPost({ email: 'kunde@example.com', password: 'ganz-neues-passwort' }));
    assert.equal(login.status, 302);
});

test('Login-Weiterleitung akzeptiert nur relative Ziele', async t => {
    const app = await startTicketApp();
    t.after(() => app.close());
    await registerCustomer(app);
    const evil = await fetch(app.url('/account/login'), formPost({
        email: 'kunde@example.com', password: PASSWORD, next: '//evil.example/phish',
    }));
    assert.equal(evil.headers.get('location'), '/account/tickets');
});

/* ======================================================== Berechtigungen */

test('Kunden sehen weder fremde Tickets noch deren Anhaenge', async t => {
    const app = await startTicketApp();
    t.after(() => app.close());
    const owner = await registerCustomer(app, 'owner@example.com');
    const other = await registerCustomer(app, 'other@example.com');
    await createTicket(app, owner, { files: [['geheim.png', PNG]] });

    const foreign = await fetch(app.url('/account/tickets/1001'), { headers: { Cookie: other } });
    assert.equal(foreign.status, 404);
    const missing = await fetch(app.url('/account/tickets/4242'), { headers: { Cookie: other } });
    assert.equal(missing.status, 404);
    assert.equal(await foreign.text(), await missing.text(), 'fremd und nicht vorhanden sind nicht unterscheidbar');

    const [attachment] = app.services.ticketStore.listMessages(app.services.ticketStore.getByNumber(1001).id)[0].attachments;
    assert.equal((await fetch(app.url(`/attachments/${attachment.id}`), { headers: { Cookie: other } })).status, 404);
    assert.equal((await fetch(app.url(`/attachments/${attachment.id}`))).status, 404);
    const own = await fetch(app.url(`/attachments/${attachment.id}`), { headers: { Cookie: owner } });
    assert.equal(own.status, 200);
    assert.equal(own.headers.get('content-type'), 'image/png');
    assert.equal(own.headers.get('x-content-type-options'), 'nosniff');
    assert.match(own.headers.get('content-security-policy'), /sandbox/);
});

test('Kunden-Sitzung gibt keinen Zugriff auf den Admin-Bereich', async t => {
    const app = await startTicketApp();
    t.after(() => app.close());
    const cookie = await registerCustomer(app);
    for (const path of ['/admin/tickets', '/admin/customers', '/admin/ticket-settings', '/admin-upload']) {
        const res = await fetch(app.url(path), { headers: { Cookie: cookie }, redirect: 'manual' });
        assert.equal(res.status, 302, path);
        assert.equal(res.headers.get('location'), '/login', path);
    }
    const anonymous = await fetch(app.url('/account/tickets'), { redirect: 'manual' });
    assert.equal(anonymous.headers.get('location'), '/account/login?next=%2Faccount%2Ftickets');
});

test('Getarnte Datei (HTML als .png) wird abgelehnt, es entsteht kein Ticket', async t => {
    const app = await startTicketApp();
    t.after(() => app.close());
    const cookie = await registerCustomer(app);
    const res = await createTicket(app, cookie, { files: [['bild.png', '<html><script>alert(1)</script>']] });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /nicht erlaubten Dateityp/);
    assert.equal(app.services.ticketStore.countViews().all, 0);
});

/* ============================================================ Admin-Sicht */

test('Admin antwortet mit Anhang, schreibt interne Notiz; Kunde sieht nur die Antwort und bekommt eine Mail', async t => {
    const app = await startTicketApp();
    t.after(() => app.close());
    const cookie = await registerCustomer(app);
    await createTicket(app, cookie);
    const { cookie: admin } = await app.login();

    const inbox = await (await fetch(app.url('/admin/tickets'), { headers: { Cookie: admin } })).text();
    assert.match(inbox, /Download bricht ab/);

    assert.equal((await adminReply(app, admin, 1001, { mode: 'reply', message: 'Bitte Mirror wechseln.' }, [['anleitung.pdf', '%PDF-1.4']])).status, 303);
    assert.equal((await adminReply(app, admin, 1001, { mode: 'note', message: 'Intern: Mirror 3 ist kaputt' }, [['intern.png', PNG]])).status, 303);

    const ticket = app.services.ticketStore.getByNumber(1001);
    assert.equal(ticket.status, 'pending', 'Notiz aendert den Status nach der Antwort nicht');

    const customerView = await (await fetch(app.url('/account/tickets/1001'), { headers: { Cookie: cookie } })).text();
    assert.match(customerView, /Bitte Mirror wechseln/);
    assert.match(customerView, /anleitung\.pdf/);
    assert.doesNotMatch(customerView, /Mirror 3 ist kaputt/);
    assert.doesNotMatch(customerView, /intern\.png/);
    assert.match(customerView, /Wartet auf dich/);

    const note = app.services.ticketStore.listMessages(ticket.id).find(m => m.kind === 'note');
    assert.equal((await fetch(app.url(`/attachments/${note.attachments[0].id}`), { headers: { Cookie: cookie } })).status, 404);
    assert.equal((await fetch(app.url(`/attachments/${note.attachments[0].id}`), { headers: { Cookie: admin } })).status, 200);

    const replyMail = (await app.mails()).find(m => m.subject === 'Re: [#1001] Download bricht ab');
    assert.ok(replyMail);
    assert.match(replyMail.text, /Bitte Mirror wechseln/);
    assert.match(replyMail.text, /anleitung\.pdf/);
    assert.doesNotMatch(replyMail.text, /Mirror 3/);

    const updates = await fetch(app.url('/account/tickets/1001/updates?since=0'), {
        headers: { Cookie: cookie, Accept: 'application/json' },
    });
    const data = await updates.json();
    assert.equal(data.changed, true);
    assert.doesNotMatch(data.threadHtml, /Mirror 3/);
    const unchanged = await (await fetch(app.url(`/account/tickets/1001/updates?since=${data.updatedAt}`), {
        headers: { Cookie: cookie, Accept: 'application/json' },
    })).json();
    assert.equal(unchanged.changed, false);
});

test('Antwortfeld ist mit bearbeitbarer Anrede/Grussformel vorbelegt; Server fuegt nichts hinzu', async t => {
    const app = await startTicketApp();
    t.after(() => app.close());
    const cookie = await registerCustomer(app);
    await createTicket(app, cookie);
    const { cookie: admin } = await app.login();

    const draft = 'Hallo Kim Kunde,\n\n\n\nMit freundlichen Grüßen\nadmin\nISO Share Support';
    const page = await (await fetch(app.url('/admin/tickets/1001'), { headers: { Cookie: admin } })).text();
    const textarea = page.match(/<textarea[^>]*id="message"[^>]*>\n([\s\S]*?)<\/textarea>/);
    assert.ok(textarea, 'Antwortfeld fehlt');
    assert.equal(textarea[1], draft, 'Vorbelegung steht im Feld');
    assert.match(textarea[0], /data-reply-caret="18"/);

    // Unveraenderte Vorbelegung ohne eigenen Text wird abgelehnt.
    const empty = await adminReply(app, admin, 1001, { mode: 'reply', message: draft });
    assert.equal(empty.status, 400);
    assert.match(await empty.text(), /Bitte eine Nachricht eingeben/);

    // Der Admin hat die Grussformel selbst umgeschrieben — gespeichert wird exakt sein Text.
    const own = 'Hi Kim,\n\nBitte Mirror wechseln.\n\nGruß, Julia';
    assert.equal((await adminReply(app, admin, 1001, { mode: 'reply', message: own })).status, 303);
    await adminReply(app, admin, 1001, { mode: 'note', message: 'Intern.' });
    const ticket = app.services.ticketStore.getByNumber(1001);
    const bodies = app.services.ticketStore.listMessages(ticket.id).filter(m => m.author === 'admin').map(m => m.body);
    assert.deepEqual(bodies, [own, 'Intern.']);

    const mail = (await app.mails()).find(m => m.subject === 'Re: [#1001] Download bricht ab');
    assert.equal((mail.text.match(/Hi Kim,/g) || []).length, 1);
    assert.doesNotMatch(mail.text, /Hallo Kim Kunde,/, 'keine zweite Anrede, wenn die Antwort schon eine hat');

    const saved = await fetch(app.url('/admin/ticket-settings/reply-template'), formPost({
        greeting: 'Guten Tag {name},', signature: 'Viele Grüße\n{agent}', agentName: 'Julia vom Support',
    }, admin));
    assert.equal(saved.status, 303);
    const updated = await (await fetch(app.url('/admin/tickets/1001'), { headers: { Cookie: admin } })).text();
    assert.match(updated, /Guten Tag Kim Kunde,\n\n\n\nViele Grüße\nJulia vom Support<\/textarea>/);

    const tooLong = await fetch(app.url('/admin/ticket-settings/reply-template'), formPost({
        greeting: 'x'.repeat(500), signature: '', agentName: '',
    }, admin));
    assert.equal(tooLong.status, 400);
    const settings = await (await fetch(app.url('/admin/ticket-settings'), { headers: { Cookie: admin } })).text();
    assert.match(settings, /Anrede &amp; Grußformel/);
});

test('Antworten per fetch (Accept: application/json) liefern JSON statt Redirect — Admin und Kunde', async t => {
    const app = await startTicketApp();
    t.after(() => app.close());
    const cookie = await registerCustomer(app);
    await createTicket(app, cookie);
    const { cookie: admin } = await app.login();

    const send = (url, fields, who) => {
        const form = new FormData();
        for (const [key, value] of Object.entries(fields)) form.set(key, value);
        return fetch(app.url(url), {
            method: 'POST', body: form, redirect: 'manual', headers: { Cookie: who, Accept: 'application/json' },
        });
    };

    const adminOk = await send('/admin/tickets/1001/reply', { mode: 'reply', message: 'Bitte Mirror wechseln.' }, admin);
    assert.equal(adminOk.status, 200);
    const adminData = await adminOk.json();
    assert.equal(adminData.ok, true);
    assert.ok(adminData.messageId);

    const adminEmpty = await send('/admin/tickets/1001/reply', { mode: 'reply', message: '' }, admin);
    assert.equal(adminEmpty.status, 400);
    assert.match((await adminEmpty.json()).error, /Bitte eine Nachricht eingeben/);

    const customerOk = await send('/account/tickets/1001/reply', { message: 'Danke, klappt!' }, cookie);
    assert.equal(customerOk.status, 200);
    assert.equal((await customerOk.json()).ok, true);
    assert.equal(app.services.ticketStore.getByNumber(1001).status, 'open');

    const customerEmpty = await send('/account/tickets/1001/reply', { message: '' }, cookie);
    assert.equal(customerEmpty.status, 400);
    assert.match((await customerEmpty.json()).error, /Bitte schreibe eine Nachricht/);

    // Ohne Accept: application/json (kein JS) bleibt es beim Redirect.
    assert.equal((await adminReply(app, admin, 1001, { mode: 'note', message: 'Intern.' })).status, 303);

    const page = await (await fetch(app.url('/account/tickets/1001'), { headers: { Cookie: cookie } })).text();
    assert.match(page, /data-composer data-async/);
    assert.match(page, /data-live-show="pending" hidden/, 'Hinweis "wartet auf dich" ist bei offenem Ticket ausgeblendet');
});

test('Geschlossenes Ticket nimmt keine Kundenantwort an; geloestes wird durch Antwort wieder geoeffnet', async t => {
    const app = await startTicketApp();
    t.after(() => app.close());
    const cookie = await registerCustomer(app);
    await createTicket(app, cookie);
    const { cookie: admin } = await app.login();

    await adminReply(app, admin, 1001, { mode: 'reply', message: 'Erledigt.', statusAfter: 'resolved' });
    const reply = new FormData();
    reply.set('message', 'Doch noch ein Problem');
    const reopened = await fetch(app.url('/account/tickets/1001/reply'), {
        method: 'POST', body: reply, headers: { Cookie: cookie }, redirect: 'manual',
    });
    assert.equal(reopened.status, 303);
    assert.equal(app.services.ticketStore.getByNumber(1001).status, 'open');

    await fetch(app.url('/admin/tickets/1001/properties'), formPost({ status: 'closed' }, admin));
    const rejected = await fetch(app.url('/account/tickets/1001/reply'), {
        method: 'POST', body: reply, headers: { Cookie: cookie }, redirect: 'manual',
    });
    assert.equal(rejected.status, 400);
    assert.match(await rejected.text(), /geschlossen/);
});

test('Kunde markiert als geloest und bewertet; Admin sieht die Bewertung', async t => {
    const app = await startTicketApp();
    t.after(() => app.close());
    const cookie = await registerCustomer(app);
    await createTicket(app, cookie);

    await fetch(app.url('/account/tickets/1001/resolve'), formPost({}, cookie));
    await fetch(app.url('/account/tickets/1001/rate'), formPost({ rating: '5', comment: 'Top' }, cookie));
    const ticket = app.services.ticketStore.getByNumber(1001);
    assert.equal(ticket.status, 'resolved');
    assert.equal(ticket.rating, 5);

    const { cookie: admin } = await app.login();
    const detail = await (await fetch(app.url('/admin/tickets/1001'), { headers: { Cookie: admin } })).text();
    assert.match(detail, /★★★★★/);
    assert.match(detail, /Top/);
});

test('Sammelaktion im Posteingang setzt den Status mehrerer Tickets', async t => {
    const app = await startTicketApp();
    t.after(() => app.close());
    const cookie = await registerCustomer(app);
    await createTicket(app, cookie, { subject: 'Eins' });
    await createTicket(app, cookie, { subject: 'Zwei' });
    const { cookie: admin } = await app.login();

    const body = new URLSearchParams();
    body.append('numbers', '1001');
    body.append('numbers', '1002');
    body.append('action', 'status:resolved');
    body.append('returnTo', 'https://evil.example/');
    const res = await fetch(app.url('/admin/tickets/bulk'), {
        method: 'POST', redirect: 'manual',
        headers: { Cookie: admin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
    });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/admin/tickets?bulk=2', 'kein offener Redirect');
    assert.equal(app.services.ticketStore.countViews().resolved, 2);
});

test('Admin-Einstellungen: Kategorie, Textbaustein, Automatik und Testmail', async t => {
    const app = await startTicketApp();
    t.after(() => app.close());
    const { cookie: admin } = await app.login();

    assert.equal((await fetch(app.url('/admin/ticket-settings/categories'), formPost({ name: 'Lizenzen' }, admin))).status, 303);
    assert.ok(app.services.configStore.listCategories().some(c => c.name === 'Lizenzen'));
    assert.equal((await fetch(app.url('/admin/ticket-settings/canned'), formPost({ title: 'Gruß', body: 'Viele Grüße' }, admin))).status, 303);
    assert.equal(app.services.configStore.listCanned().length, 1);
    const bad = await fetch(app.url('/admin/ticket-settings/automation'), formPost({
        pendingReminderDays: '0', pendingAutoResolveDays: '7', autoCloseDays: '7',
    }, admin));
    assert.equal(bad.status, 400);
    await fetch(app.url('/admin/mail/test'), formPost({ to: 'ops@example.com' }, admin));
    assert.ok((await app.mails()).some(m => m.to === 'ops@example.com' && /Testmail/.test(m.subject)));

    const page = await (await fetch(app.url('/admin/ticket-settings'), { headers: { Cookie: admin } })).text();
    assert.match(page, /Lizenzen/);
    assert.match(page, /Testmail/);
});

/* =============================================================== DSGVO */

test('Datenexport enthaelt Tickets ohne interne Notizen; Kontoloeschung entfernt alles', async t => {
    const app = await startTicketApp();
    t.after(() => app.close());
    const cookie = await registerCustomer(app);
    await createTicket(app, cookie, { files: [['screen.png', PNG]] });
    const { cookie: admin } = await app.login();
    await adminReply(app, admin, 1001, { mode: 'note', message: 'streng intern' });

    const exported = await fetch(app.url('/account/export'), { headers: { Cookie: cookie } });
    assert.match(exported.headers.get('content-disposition'), /attachment/);
    const data = await exported.json();
    assert.equal(data.account.email, 'kunde@example.com');
    assert.equal(data.tickets[0].number, 1001);
    assert.doesNotMatch(JSON.stringify(data), /streng intern/);

    const ticketId = app.services.ticketStore.getByNumber(1001).id;
    const [attachment] = app.services.ticketStore.listMessages(ticketId)[0].attachments;
    const filePath = app.services.attachmentStore.filePath(attachment.id);
    await fsp.access(filePath);

    const wrong = await fetch(app.url('/account/delete'), formPost({ confirm: 'LÖSCHEN', currentPassword: 'falsch' }, cookie));
    assert.equal(wrong.status, 401);
    const deleted = await fetch(app.url('/account/delete'), formPost({ confirm: 'LÖSCHEN', currentPassword: PASSWORD }, cookie));
    assert.equal(deleted.status, 200);
    assert.equal(app.services.customerStore.findByEmail('kunde@example.com'), null);
    assert.equal(app.services.ticketStore.getByNumber(1001), null);
    await assert.rejects(fsp.access(filePath));
});

/* ======================================================= Weiterleitungen */

test('Alte Kontakt-URL fuehrt zum Support-Portal', async t => {
    const app = await startTicketApp();
    t.after(() => app.close());
    const res = await fetch(app.url('/contact'), { redirect: 'manual' });
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('location'), '/support');
    assert.equal((await fetch(app.url('/support'))).status, 200);
});

test('Ohne SMTP laeuft alles weiter, Registrierung verweist auf manuelle Freischaltung', async t => {
    const app = await startTestApp({ startMailWorkers: false });
    t.after(() => app.close());
    const res = await fetch(app.url('/account/register'), formPost({
        name: 'Kim', email: 'kim@example.com', password: PASSWORD, passwordConfirm: PASSWORD, privacy: '1',
    }));
    assert.equal(res.status, 200);
    assert.match(await res.text(), /von Hand freischalten/);
    assert.deepEqual(app.services.outbox.counts(), { pending: 0, sent: 0, failed: 0 });
});

/* ======================================================== Regressionen */

test('Registrierung lehnt Adressen ab, die nodemailer als Anzeigename/Liste lesen wuerde', async t => {
    const app = await startTicketApp();
    t.after(() => app.close());
    for (const email of ['x<opfer@example.com>', 'a@example.com,opfer@example.com']) {
        const res = await fetch(app.url('/account/register'), formPost({
            name: 'Mallory', email, password: PASSWORD, passwordConfirm: PASSWORD, privacy: '1',
        }));
        assert.equal(res.status, 400, email);
    }
    assert.equal((await app.mails()).length, 0);
});

test('Erneute Registrierung eines unbestaetigten Kontos schickt einen frischen Bestaetigungslink', async t => {
    const app = await startTicketApp();
    t.after(() => app.close());
    const body = { name: 'Kim', email: 'kim@example.com', password: PASSWORD, passwordConfirm: PASSWORD, privacy: '1' };
    await fetch(app.url('/account/register'), formPost(body));
    await fetch(app.url('/account/register'), formPost(body));
    const mails = (await app.mails()).filter(m => m.to === 'kim@example.com');
    assert.equal(mails.filter(m => /bestätige/.test(m.subject)).length, 2);
    assert.ok(!mails.some(m => /Registrierungsversuch/.test(m.subject)));
    // Der zweite Link gilt (der erste wurde verworfen)
    const verify = await fetch(app.url(linkFrom(mails.at(-1), '/account/verify')));
    assert.equal(verify.status, 200);
});

test('Betreff wird einzeilig gespeichert; "Status danach: Neu" wird ignoriert; Tags ohne Aenderung bleiben still', async t => {
    const app = await startTicketApp();
    t.after(() => app.close());
    const cookie = await registerCustomer(app);
    await createTicket(app, cookie, { subject: 'Zeile 1\r\nBcc: boese@example.com' });
    const { ticketStore } = app.services;
    assert.equal(ticketStore.getByNumber(1001).subject, 'Zeile 1 Bcc: boese@example.com');

    const { cookie: admin } = await app.login();
    assert.equal((await adminReply(app, admin, 1001, { mode: 'reply', message: 'Antwort', statusAfter: 'new' })).status, 303);
    assert.equal(ticketStore.getByNumber(1001).status, 'pending');

    ticketStore.db.prepare('UPDATE tickets SET updated_at = 1 WHERE number = 1001').run();
    await fetch(app.url('/admin/tickets/1001/properties'), formPost({ status: 'pending', priority: 'normal', categoryId: '', tags: '' }, admin));
    assert.equal(ticketStore.getByNumber(1001).updatedAt, 1, 'unveraenderte Eigenschaften aendern updated_at nicht');
});

test('Anhaenge: abgelaufene Admin-Sitzung (Idle-Timeout) zaehlt nicht mehr als Admin', async t => {
    const app = await startTicketApp({ adminIdleTimeoutMs: 1000 });
    t.after(() => app.close());
    const cookie = await registerCustomer(app);
    await createTicket(app, cookie, { files: [['screen.png', PNG]] });
    const [attachment] = app.services.ticketStore.listMessages(app.services.ticketStore.getByNumber(1001).id)[0].attachments;

    const { cookie: admin } = await app.login();
    const fresh = await fetch(app.url(`/attachments/${attachment.id}`), { headers: { Cookie: admin } });
    assert.equal(fresh.status, 200);
    assert.match(fresh.headers.get('content-disposition'), /^inline; filename="screen\.png"; filename\*=UTF-8''screen\.png$/);
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal((await fetch(app.url(`/attachments/${attachment.id}`), { headers: { Cookie: admin } })).status, 404);
});

test('Ungelesen-Zaehler: Navigation zaehlt das gerade geoeffnete Ticket nicht mehr; Admin-Live-Update markiert gelesen', async t => {
    const app = await startTicketApp();
    t.after(() => app.close());
    const cookie = await registerCustomer(app);
    await createTicket(app, cookie);
    const { cookie: admin } = await app.login();
    await adminReply(app, admin, 1001, { mode: 'reply', message: 'Antwort' });

    const detail = await (await fetch(app.url('/account/tickets/1001'), { headers: { Cookie: cookie } })).text();
    assert.doesNotMatch(detail, /title="Neue Antworten"/, 'kein Zaehler fuer das gerade gelesene Ticket');

    await fetch(app.url('/account/tickets/1001/reply'), formPost({ message: 'Rueckfrage' }, cookie));
    const { ticketStore } = app.services;
    assert.equal(ticketStore.getByNumber(1001).adminUnread, true);
    const res = await fetch(app.url('/admin/tickets/1001/updates?since=0'), {
        headers: { Cookie: admin, Accept: 'application/json', 'X-Idle-Background': '1' },
    });
    assert.equal((await res.json()).changed, true);
    assert.equal(ticketStore.getByNumber(1001).adminUnread, false);
});

test('Falsche Ticketnummer beim Loeschen: Fehler steht am Loeschfeld, Ticket bleibt', async t => {
    const app = await startTicketApp();
    t.after(() => app.close());
    const cookie = await registerCustomer(app);
    await createTicket(app, cookie);
    const { cookie: admin } = await app.login();
    const res = await fetch(app.url('/admin/tickets/1001/delete'), formPost({ confirm: '9999' }, admin));
    assert.equal(res.status, 400);
    assert.match(await res.text(), /id="delete" open[\s\S]*Zum Löschen bitte die Ticketnummer/);
    assert.ok(app.services.ticketStore.getByNumber(1001));
    const ok = await fetch(app.url('/admin/tickets/1001/delete'), formPost({ confirm: '#1001' }, admin));
    assert.equal(ok.status, 303);
    assert.equal(app.services.ticketStore.getByNumber(1001), null);

    // Ein alter Link (Admin-Mail) auf das geloeschte Ticket: gestaltete Seite mit Navigation statt Klartext
    const gone = await fetch(app.url('/admin/tickets/1001'), { headers: { Cookie: admin } });
    assert.equal(gone.status, 404);
    assert.match(await gone.text(), /<nav[\s\S]*Ticket nicht gefunden[\s\S]*href="\/admin\/tickets"/);
});

/* ============================================================ Live-Bereiche */

test('Ticket-Seiten tragen Live-Bereiche; die Warteschlange zeigt neue Mails beim naechsten Abruf', async t => {
    const app = await startTicketApp();
    t.after(() => app.close());
    const cookie = await registerCustomer(app);
    const { cookie: admin } = await app.login();

    const outboxRegion = html => html.match(/data-live-region="outbox">([\s\S]*?)<section/)[1];
    const settings = async () => (await fetch(app.url('/admin/ticket-settings'), { headers: { Cookie: admin } })).text();

    const first = await settings();
    assert.match(first, /<body data-live-page data-live-url="\/admin\/ticket-settings">/);
    for (const key of ['mail-status', 'outbox', 'automation', 'reply-template', 'categories', 'canned', 'attachments']) {
        assert.match(first, new RegExp(`data-live-region="${key}"`), key);
    }
    const before = (outboxRegion(first).match(/data-live-key="mail-/g) || []).length;

    await createTicket(app, cookie);
    const after = (outboxRegion(await settings()).match(/data-live-key="mail-/g) || []).length;
    assert.ok(after > before, 'neue Mails erscheinen in der Warteschlange');

    const inbox = await (await fetch(app.url('/admin/tickets'), { headers: { Cookie: admin } })).text();
    assert.match(inbox, /data-live-region="inbox-list" data-live-guard-hover/);
    assert.match(inbox, /data-live-key="ticket-1001"/);
    assert.match(inbox, /data-live-region="nav-count">\s*<span class="nav__count"/);

    const customerList = await (await fetch(app.url('/account/tickets'), { headers: { Cookie: cookie } })).text();
    assert.match(customerList, /data-live-region="tickets-list"/);
    assert.match(customerList, /data-live-key="ticket-1001"/);

    // Das Polling schickt X-Idle-Background — der Admin-Idle-Timeout
    // verlaengert sich dadurch nicht, die Seite kommt trotzdem normal zurueck.
    const polled = await fetch(app.url('/admin/ticket-settings'), { headers: { Cookie: admin, 'X-Idle-Background': '1' } });
    assert.equal(polled.status, 200);
});

test('Ticket-Detail: ISO-Karte, Kunde und Eigenschaften sind Live-Bereiche, auch bevor es sie gibt', async t => {
    const app = await startTicketApp();
    t.after(() => app.close());
    const cookie = await registerCustomer(app);
    await createTicket(app, cookie);
    const { cookie: admin } = await app.login();
    const page = async (url, c) => (await fetch(app.url(url), { headers: { Cookie: c, 'X-Idle-Background': '1' } })).text();

    // Noch keine Datei zugeordnet: der Bereich existiert trotzdem (leer), sonst
    // koennte die Karte nach einer Zuordnung nie live erscheinen.
    for (const [url, c] of [['/admin/tickets/1001', admin], ['/account/tickets/1001', cookie]]) {
        const html = await page(url, c);
        assert.match(html, /<div class="live-slot" data-live-region="ticket-iso">\s*<\/div>/, url);
        assert.equal((html.match(/data-live-region="ticket-iso"/g) || []).length, 1, `${url}: genau ein Bereich`);
    }
    const adminHtml = await page('/admin/tickets/1001', admin);
    for (const key of ['ticket-properties', 'ticket-requester', 'ticket-customer', 'ticket-timeline', 'ticket-priority', 'ticket-sla']) {
        assert.match(adminHtml, new RegExp(`data-live-region="${key}"`), key);
    }

    const { ticketStore } = app.services;
    ticketStore.setIsoFile(ticketStore.getByNumber(1001).id, 'weg.iso');
    for (const [url, c] of [['/admin/tickets/1001', admin], ['/account/tickets/1001', cookie]]) {
        assert.match(await page(url, c), /data-live-region="ticket-iso">\s*<section class="card">[\s\S]*weg\.iso/, url);
    }
});

test('/partials/nav zaehlt neue Antworten fuer Kunden; Live-Polling eines Hilfeartikels zaehlt keinen Aufruf', async t => {
    const app = await startTicketApp();
    t.after(() => app.close());
    const cookie = await registerCustomer(app);
    await createTicket(app, cookie);
    const { cookie: admin } = await app.login();
    await adminReply(app, admin, 1001, { message: 'Antwort', mode: 'reply' });

    const nav = await (await fetch(app.url('/partials/nav'), {
        headers: { Cookie: cookie, Accept: 'application/json', 'X-Idle-Background': '1' },
    })).json();
    assert.match(nav.regions['nav-count'], /title="Neue Antworten">\s*1\s*</);

    const { kbStore } = app.services;
    const { article } = kbStore.create({ title: 'Checksumme pruefen', body: 'So geht es.', published: true });
    const support = await (await fetch(app.url('/support'))).text();
    assert.match(support, /<body data-live-page>/);
    assert.match(support, /data-live-region="kb-articles">[\s\S]*Checksumme pruefen/);

    const url = app.url(`/support/articles/${article.slug}`);
    const first = await (await fetch(url)).text();
    assert.match(first, /data-live-page data-live-url="\/support\/articles\/checksumme-pruefen"/);
    assert.match(first, /data-live-region="kb-article"/);
    await fetch(url, { headers: { 'X-Idle-Background': '1' } });
    await fetch(url, { headers: { 'X-Idle-Background': '1' } });
    assert.equal(kbStore.get(article.id).views, 1, 'nur der echte Aufruf zaehlt');
});

/* ===================================================== Erweiterungen 2026-09 */

async function adminNewTicket(app, adminCookie, fields) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    return fetch(app.url('/admin/tickets/new'), { method: 'POST', body: form, headers: { Cookie: adminCookie }, redirect: 'manual' });
}

test('Admin legt ein Ticket fuer einen Kunden an: Status "wartet", erste Nachricht vom Support, Mail an den Kunden', async t => {
    const app = await startTicketApp();
    t.after(() => app.close());
    await registerCustomer(app);
    const { cookie: admin } = await app.login();
    const customer = app.services.customerStore.findByEmail('kunde@example.com');

    const form = await fetch(app.url(`/admin/tickets/new?customer=${customer.id}`), { headers: { Cookie: admin } });
    assert.equal(form.status, 200);
    const formHtml = await form.text();
    assert.match(formHtml, /kunde@example\.com/);
    // Anrede/Grussformel vorbelegt wie im Antwortfeld — unveraendert zaehlt sie nicht als Nachricht
    assert.match(formHtml, /Hallo Kim Kunde,/);
    const onlyTemplate = await adminNewTicket(app, admin, {
        customerId: customer.id, subject: 'Leer', message: 'Hallo Kim Kunde,\n\n\n\nMit freundlichen Grüßen\nadmin\nISO Share Support',
    });
    assert.equal(onlyTemplate.status, 400);
    assert.match(await onlyTemplate.text(), /Bitte eine Nachricht/);

    const res = await adminNewTicket(app, admin, {
        customerId: customer.id, subject: 'Rückruf zu deinem Download', message: 'Hallo Kim, wie besprochen …',
        note: 'Anruf 10:15', priority: 'urgent', statusAfter: 'pending',
    });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/admin/tickets/1001?created=1');

    const ticket = app.services.ticketStore.getByNumber(1001);
    assert.equal(ticket.status, 'pending');
    assert.equal(ticket.priority, 'urgent');
    assert.equal(ticket.source, 'admin');
    assert.ok(ticket.firstResponseAt);
    const messages = app.services.ticketStore.listMessages(ticket.id);
    assert.equal(messages[0].author, 'admin');
    assert.ok(messages.some(m => m.kind === 'note' && m.body === 'Anruf 10:15'));
    // Die Notiz ist fuer den Kunden unsichtbar
    const customerView = app.services.ticketStore.listMessages(ticket.id, { includeInternal: false });
    assert.ok(!customerView.some(m => m.body === 'Anruf 10:15'));

    const mails = await app.mails();
    assert.ok(mails.some(m => m.to === 'kunde@example.com' && m.subject === '[#1001] Rückruf zu deinem Download'));
    assert.ok(!mails.some(m => m.to === 'admin@example.com' && /Neues Ticket \[#1001\]/.test(m.subject)), 'keine Admin-Benachrichtigung');

    // Unbekannte Adresse: Formular mit Fehler
    const unknown = await adminNewTicket(app, admin, { customerEmail: 'nobody@example.com', subject: 'X', message: 'Y' });
    assert.equal(unknown.status, 400);
    assert.match(await unknown.text(), /kein Kundenkonto/);

    // Ohne Admin-Sitzung: Login
    const anonymous = await fetch(app.url('/admin/tickets/new'), { redirect: 'manual' });
    assert.equal(anonymous.status, 302);
});

test('ISO-Bezug: ?file= belegt vor, nur vorhandene Dateien, Admin-Filter und Dateiliste zeigen offene Tickets', async t => {
    const app = await startTicketApp();
    t.after(() => app.close());
    await fsp.mkdir(app.uploadsDir, { recursive: true });
    await fsp.writeFile(`${app.uploadsDir}/debian-12.iso`, 'kein echtes iso');
    const cookie = await registerCustomer(app);
    const { cookie: admin } = await app.login();

    const form = await (await fetch(app.url('/account/tickets/new?file=debian-12.iso'), { headers: { Cookie: cookie } })).text();
    assert.match(form, /<option value="debian-12\.iso" selected>/);

    const post = async isoFile => {
        const body = new FormData();
        body.set('subject', 'Bootet nicht');
        body.set('message', 'UEFI zeigt nichts');
        body.set('isoFile', isoFile);
        return fetch(app.url('/account/tickets'), { method: 'POST', body, headers: { Cookie: cookie }, redirect: 'manual' });
    };
    assert.equal((await post('gibtsnicht.iso')).status, 400);
    assert.equal((await post('../../etc/passwd')).status, 400);
    assert.equal((await post('debian-12.iso')).status, 303);
    assert.equal(app.services.ticketStore.getByNumber(1001).isoFile, 'debian-12.iso');

    const detail = await (await fetch(app.url('/account/tickets/1001'), { headers: { Cookie: cookie } })).text();
    assert.match(detail, /Betroffene Datei/);
    assert.match(detail, /debian-12\.iso/);

    const filtered = await (await fetch(app.url('/admin/tickets?view=all&file=debian-12.iso'), { headers: { Cookie: admin } })).text();
    assert.match(filtered, /data-live-key="ticket-1001"/);
    const other = await (await fetch(app.url('/admin/tickets?view=all&file=anderes.iso'), { headers: { Cookie: admin } })).text();
    assert.doesNotMatch(other, /data-live-key="ticket-1001"/);

    const listing = await (await fetch(app.url('/admin-upload'), { headers: { Cookie: admin } })).text();
    assert.match(listing, /1 offenes Ticket/);
    const publicListing = await (await fetch(app.url('/'))).text();
    assert.match(publicListing, /\/account\/tickets\/new\?file=debian-12\.iso/);
});

test('Eigenschaften: Aenderungen landen mit Vorher/Nachher im Audit-Log, Tags erzeugen ein internes Ereignis', async t => {
    const app = await startTicketApp();
    t.after(() => app.close());
    const cookie = await registerCustomer(app);
    const { cookie: admin } = await app.login();
    await createTicket(app, cookie);

    const res = await fetch(app.url('/admin/tickets/1001/properties'), formPost({
        status: 'open', priority: 'high', tags: 'uefi, download', isoFile: 'arch.iso',
    }, admin));
    assert.equal(res.status, 303);

    const [entry] = (await app.services.auditLog.read({ limit: 20 })).filter(e => e.event === 'ticket_updated');
    assert.ok(entry, 'ticket_updated fehlt');
    assert.deepEqual(entry.changes.priority, { from: 'normal', to: 'high' });
    assert.deepEqual(entry.changes.tags, { from: [], to: ['uefi', 'download'] });
    assert.deepEqual(entry.changes.isoFile, { from: null, to: 'arch.iso' });

    const ticket = app.services.ticketStore.getByNumber(1001);
    const events = app.services.ticketStore.listMessages(ticket.id).filter(m => m.kind === 'event');
    assert.ok(events.some(m => m.internal && /^Tags: — → uefi, download$/.test(m.body)));
    assert.ok(events.some(m => m.internal && /^ISO-Datei: — → arch\.iso$/.test(m.body)));

    // Ungueltiger Dateiname wird ignoriert, nicht gespeichert
    await fetch(app.url('/admin/tickets/1001/properties'), formPost({ isoFile: '../x.iso' }, admin));
    assert.equal(app.services.ticketStore.getByNumber(1001).isoFile, 'arch.iso');
});

test('Zusammenfuehren: Nachrichten wandern ins Ziel, alte URL leitet um, fremde Kunden werden abgelehnt', async t => {
    const app = await startTicketApp();
    t.after(() => app.close());
    const cookie = await registerCustomer(app);
    const otherCookie = await registerCustomer(app, 'zweiter@example.com', 'Zora Zweit');
    const { cookie: admin } = await app.login();
    await createTicket(app, cookie, { subject: 'Erstes', message: 'Nachricht A' });
    await createTicket(app, cookie, { subject: 'Doppelt', message: 'Nachricht B' });
    await createTicket(app, otherCookie, { subject: 'Fremd', message: 'Nachricht C' });

    const detail = await (await fetch(app.url('/admin/tickets/1002'), { headers: { Cookie: admin } })).text();
    assert.match(detail, /Zusammenführen in/);
    assert.match(detail, /<option value="1001">/);
    assert.doesNotMatch(detail, /<option value="1003">/, 'Tickets anderer Kunden stehen nicht zur Auswahl');

    const withoutConfirm = await fetch(app.url('/admin/tickets/1002/merge'), formPost({ target: '1001' }, admin));
    assert.equal(withoutConfirm.status, 400);
    const foreign = await fetch(app.url('/admin/tickets/1002/merge'), formPost({ target: '1003', confirm: '1' }, admin));
    assert.equal(foreign.status, 400);
    assert.match(await foreign.text(), /desselben Kundenkontos/);

    const merged = await fetch(app.url('/admin/tickets/1002/merge'), formPost({ target: '1001', confirm: '1' }, admin));
    assert.equal(merged.status, 303);
    assert.equal(merged.headers.get('location'), '/admin/tickets/1001?merged=1002');

    const { ticketStore } = app.services;
    const source = ticketStore.getByNumber(1002);
    const target = ticketStore.getByNumber(1001);
    assert.equal(source.status, 'closed');
    assert.equal(source.mergedIntoId, target.id);
    const bodies = ticketStore.listMessages(target.id).map(m => m.body);
    assert.ok(bodies.includes('Nachricht A') && bodies.includes('Nachricht B'));

    const oldAdmin = await fetch(app.url('/admin/tickets/1002'), { headers: { Cookie: admin }, redirect: 'manual' });
    assert.equal(oldAdmin.status, 301);
    assert.equal(oldAdmin.headers.get('location'), '/admin/tickets/1001');
    const oldCustomer = await fetch(app.url('/account/tickets/1002'), { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(oldCustomer.status, 301);
    assert.equal(oldCustomer.headers.get('location'), '/account/tickets/1001');
    // Der andere Kunde sieht das Ticket weiterhin nicht
    const snoop = await fetch(app.url('/account/tickets/1002'), { headers: { Cookie: otherCookie }, redirect: 'manual' });
    assert.equal(snoop.status, 404);

    assert.ok((await app.mails()).some(m => m.to === 'kunde@example.com' && /zusammengeführt/.test(m.subject)));
    assert.ok((await app.services.auditLog.read({ limit: 20 })).some(e => e.event === 'ticket_merged'));

    // Die Quelle bleibt zu: weder Sammelaktion noch Antwort oeffnen sie wieder
    await fetch(app.url('/admin/tickets/bulk'), formPost({ numbers: '1002', action: 'status:open', returnTo: '/admin/tickets' }, admin));
    assert.equal(ticketStore.getByNumber(1002).status, 'closed');
    const form = new FormData();
    form.set('mode', 'reply');
    form.set('message', 'An die alte Nummer');
    const reply = await fetch(app.url('/admin/tickets/1002/reply'), {
        method: 'POST', body: form, headers: { Cookie: admin, Accept: 'application/json' },
    });
    assert.equal(reply.status, 400);
    assert.match((await reply.json()).error, /in #1001 zusammengeführt/);
    assert.equal(ticketStore.getByNumber(1002).status, 'closed');
    assert.ok(!ticketStore.listMessages(source.id).some(m => m.body === 'An die alte Nummer'));
});

test('Aufteilen: ausgewaehlte Nachrichten wandern in ein neues Ticket, beide verweisen aufeinander', async t => {
    const app = await startTicketApp();
    t.after(() => app.close());
    const cookie = await registerCustomer(app);
    const otherCookie = await registerCustomer(app, 'zweiter@example.com', 'Zora Zweit');
    const { cookie: admin } = await app.login();
    await createTicket(app, cookie, { subject: 'Download bricht ab', message: 'Nachricht A' });
    await adminReply(app, admin, 1001, { mode: 'reply', message: 'Bitte nochmal versuchen' });
    const form = new FormData();
    form.set('message', 'Und außerdem bootet UEFI nicht');
    await fetch(app.url('/account/tickets/1001/reply'), { method: 'POST', body: form, headers: { Cookie: cookie }, redirect: 'manual' });

    const { ticketStore } = app.services;
    const source = ticketStore.getByNumber(1001);
    const second = ticketStore.listMessages(source.id).find(m => m.body === 'Und außerdem bootet UEFI nicht');
    assert.ok(second, 'Kundenantwort fehlt');

    const detail = await (await fetch(app.url('/admin/tickets/1001'), { headers: { Cookie: admin } })).text();
    assert.match(detail, new RegExp(`name="messageIds" value="${second.id}"`));

    const split = (fields, cookieValue = admin) => fetch(app.url('/admin/tickets/1001/split'), formPost(fields, cookieValue));
    const withoutConfirm = await split([['messageIds', String(second.id)], ['subject', 'UEFI']]);
    assert.equal(withoutConfirm.status, 400);
    const nothing = await split([['subject', 'UEFI'], ['confirm', '1']]);
    assert.equal(nothing.status, 400);
    assert.match(await nothing.text(), /mindestens eine Nachricht/);
    // Nur eine interne Notiz: der Kunde saehe ein leeres Ticket
    await adminReply(app, admin, 1001, { mode: 'note', message: 'Intern: eigenes Thema?' });
    const note = ticketStore.listMessages(source.id).find(m => m.kind === 'note');
    const notesOnly = await split([['messageIds', String(note.id)], ['subject', 'Intern'], ['confirm', '1']]);
    assert.equal(notesOnly.status, 400);
    assert.match(await notesOnly.text(), /nur interne Notizen/);
    assert.equal(ticketStore.getByNumber(1002), null);

    const res = await split([['messageIds', String(second.id)], ['subject', 'UEFI bootet nicht'], ['confirm', '1']]);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/admin/tickets/1002?split=1001');

    const target = ticketStore.getByNumber(1002);
    assert.equal(target.customerId, source.customerId);
    assert.equal(target.splitFromId, source.id);
    assert.equal(target.subject, 'UEFI bootet nicht');
    assert.equal(target.status, 'new');
    assert.ok(ticketStore.listMessages(target.id).some(m => m.id === second.id));
    assert.ok(!ticketStore.listMessages(source.id).some(m => m.id === second.id));

    const targetPage = await (await fetch(app.url('/admin/tickets/1002'), { headers: { Cookie: admin } })).text();
    assert.match(targetPage, /Aufgeteilt aus Ticket #1001/);
    assert.match(targetPage, /href="\/admin\/tickets\/1001"/);
    const sourcePage = await (await fetch(app.url('/admin/tickets/1001'), { headers: { Cookie: admin } })).text();
    assert.match(sourcePage, /1 Nachricht in Ticket #1002/);
    assert.match(sourcePage, /Aufgeteilt in/);

    // Der Kunde sieht das neue Ticket samt Verweis, ein fremder Kunde nicht
    const customerPage = await fetch(app.url('/account/tickets/1002'), { headers: { Cookie: cookie } });
    assert.equal(customerPage.status, 200);
    assert.match(await customerPage.text(), /href="\/account\/tickets\/1001"/);
    const snoop = await fetch(app.url('/account/tickets/1002'), { headers: { Cookie: otherCookie }, redirect: 'manual' });
    assert.equal(snoop.status, 404);

    assert.ok((await app.mails()).some(m => m.to === 'kunde@example.com' && /\[#1002\]/.test(m.subject)
        && /#1001/.test(m.text)));
    const entry = (await app.services.auditLog.read({ limit: 20 })).find(e => e.event === 'ticket_split');
    assert.ok(entry, 'ticket_split fehlt');
    assert.equal(entry.into, 1002);
    assert.equal(entry.messages, 1);
});

test('Wissensdatenbank: Admin pflegt Artikel, oeffentlich nur Veroeffentlichtes, Suche und Vorschlaege', async t => {
    const app = await startTicketApp();
    t.after(() => app.close());
    const { cookie: admin } = await app.login();

    assert.equal((await fetch(app.url('/admin/kb'), { redirect: 'manual' })).status, 302);

    const fence = '`'.repeat(3);
    const preview = await fetch(app.url('/admin/kb'), formPost({
        title: 'Checksumme prüfen', body: `## So geht es\n\n${fence}\nsha256sum -c SHA256SUMS\n${fence}`, action: 'preview',
    }, admin));
    assert.equal(preview.status, 200);
    assert.match(await preview.text(), /<pre><code>sha256sum -c SHA256SUMS<\/code><\/pre>/);
    assert.equal(app.services.kbStore.list().length, 0, 'Vorschau speichert nicht');

    const created = await fetch(app.url('/admin/kb'), formPost({
        title: 'Checksumme prüfen', body: 'Lade **SHA256SUMS** herunter. <script>alert(1)</script>', published: '1',
    }, admin));
    assert.equal(created.status, 303);
    const draft = await fetch(app.url('/admin/kb'), formPost({ title: 'Entwurf', body: 'geheim' }, admin));
    assert.equal(draft.status, 303);

    const page = await fetch(app.url('/support/articles/checksumme-pruefen'));
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<strong>SHA256SUMS<\/strong>/);
    assert.doesNotMatch(html, /<script>alert/);
    assert.equal(app.services.kbStore.getBySlug('checksumme-pruefen').views, 1);

    assert.equal((await fetch(app.url('/support/articles/entwurf'))).status, 404);
    const adminPreview = await fetch(app.url('/support/articles/entwurf'), { headers: { Cookie: admin } });
    assert.equal(adminPreview.status, 200, 'der Admin sieht Entwuerfe');

    const support = await (await fetch(app.url('/support'))).text();
    assert.match(support, /Checksumme prüfen/);
    assert.doesNotMatch(support, /Entwurf/);
    const search = await (await fetch(app.url('/support?q=sha256sums'))).text();
    assert.match(search, /1 Treffer/);

    const suggest = await (await fetch(app.url('/support/articles.json?q=Checksumme%20falsch'))).json();
    assert.deepEqual(suggest.data.map(item => item.url), ['/support/articles/checksumme-pruefen']);
    const none = await (await fetch(app.url('/support/articles.json?q=geheim'))).json();
    assert.deepEqual(none.data, [], 'Entwuerfe tauchen nicht in Vorschlaegen auf');

    // Kategorie inzwischen geloescht (Formular war noch offen): kein 500
    const { configStore } = app.services;
    const categoryId = configStore.addCategory('Kurzlebig');
    configStore.deleteCategory(categoryId);
    const orphan = await fetch(app.url('/admin/kb'), formPost({
        title: 'Ohne Kategorie', body: 'Text', categoryId: String(categoryId),
    }, admin));
    assert.equal(orphan.status, 303);
    assert.equal(app.services.kbStore.getBySlug('ohne-kategorie').categoryId, null);
});

test('Berichte und Antwortfristen: Seite nur fuer den Admin, SLA-Einstellungen werden gespeichert und validiert', async t => {
    const app = await startTicketApp();
    t.after(() => app.close());
    const cookie = await registerCustomer(app);
    const { cookie: admin } = await app.login();
    await createTicket(app, cookie);

    assert.equal((await fetch(app.url('/admin/reports'), { redirect: 'manual' })).status, 302);
    for (const query of ['', '?range=90', '?range=365', '?from=2026-01-01&to=2026-12-31', '?from=kaputt&to=2026-01-01']) {
        const res = await fetch(app.url(`/admin/reports${query}`), { headers: { Cookie: admin } });
        assert.equal(res.status, 200, query);
    }
    const report = await (await fetch(app.url('/admin/reports'), { headers: { Cookie: admin } })).text();
    assert.match(report, /Neue Tickets/);

    const saved = await fetch(app.url('/admin/ticket-settings/sla'), formPost({
        urgent_first: '1', urgent_next: '2', high_first: '4', high_next: '4', normal_first: '0.5', normal_next: '8',
        low_first: '0', low_next: '0',
    }, admin));
    assert.equal(saved.status, 303);
    assert.deepEqual(app.services.configStore.readSla().normal, { firstResponseHours: 0.5, nextResponseHours: 8 });
    const invalid = await fetch(app.url('/admin/ticket-settings/sla'), formPost({ urgent_first: '-3' }, admin));
    assert.equal(invalid.status, 400);

    // Ticket 1001 ist "new", Prioritaet normal: Frist 30 Min. ab Eingang
    const ticket = app.services.ticketStore.getByNumber(1001);
    assert.equal(ticket.slaMinutes, 30);
    assert.equal(ticket.slaDueAt, ticket.createdAt + 30 * 60e3);
    app.services.db.prepare('UPDATE tickets SET created_at = ? WHERE id = ?').run(Date.now() - 60 * 60e3, ticket.id);
    const overdue = await (await fetch(app.url('/admin/tickets?view=overdue'), { headers: { Cookie: admin } })).text();
    assert.match(overdue, /data-live-key="ticket-1001"/);
    assert.match(overdue, /überfällig seit/);
});

/* ========================================================== Wiedervorlage */

test('Wiedervorlage: setzen per Vorgabe und eigenem Zeitpunkt, aufheben, Sammelaktion, Kunde sieht nichts', async t => {
    const app = await startTicketApp();
    t.after(() => app.close());
    const cookie = await registerCustomer(app);
    await createTicket(app, cookie, { subject: 'Eins' });
    await createTicket(app, cookie, { subject: 'Zwei' });
    const { cookie: admin } = await app.login();
    const store = app.services.ticketStore;

    const set = await fetch(app.url('/admin/tickets/1001/snooze'), formPost({ preset: 'tomorrow', note: 'Hersteller fragen' }, admin));
    assert.equal(set.status, 303);
    assert.equal(set.headers.get('location'), '/admin/tickets/1001?snooze=set');
    assert.ok(store.getByNumber(1001).snoozedUntil > Date.now());

    const inbox = await (await fetch(app.url('/admin/tickets'), { headers: { Cookie: admin } })).text();
    assert.doesNotMatch(inbox, /data-live-key="ticket-1001"/, 'aus dem Posteingang ausgeblendet');
    const snoozedView = await (await fetch(app.url('/admin/tickets?view=snoozed'), { headers: { Cookie: admin } })).text();
    assert.match(snoozedView, /data-live-key="ticket-1001"/);
    assert.match(snoozedView, /snooze-chip/);

    const detail = await (await fetch(app.url('/admin/tickets/1001?snooze=set'), { headers: { Cookie: admin } })).text();
    assert.match(detail, /Zurückgestellt bis/);
    assert.match(detail, /Hersteller fragen/);

    // Kunde: weder Hinweis noch interne Notiz
    const customerView = await (await fetch(app.url('/account/tickets/1001'), { headers: { Cookie: cookie } })).text();
    assert.doesNotMatch(customerView, /Wiedervorlage|Hersteller fragen/);

    // Ungueltiger Zeitpunkt: 400 mit Meldung, nichts geaendert
    const past = await fetch(app.url('/admin/tickets/1002/snooze'), formPost({ until: '2020-01-01T09:00' }, admin));
    assert.equal(past.status, 400);
    assert.match(await past.text(), /in der Zukunft/);
    assert.equal(store.getByNumber(1002).snoozedUntil, null);

    const custom = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    // Die Testinstanz laeuft mit der Default-Zeitzone (Europe/Berlin)
    const local = require('../lib/time').createClock().toLocalInput(custom.getTime());
    const own = await fetch(app.url('/admin/tickets/1002/snooze'), formPost({ until: local }, admin));
    assert.equal(own.status, 303);
    assert.ok(Math.abs(store.getByNumber(1002).snoozedUntil - custom.getTime()) < 60 * 1000);

    const clear = await fetch(app.url('/admin/tickets/1001/unsnooze'), formPost({}, admin));
    assert.equal(clear.status, 303);
    assert.equal(store.getByNumber(1001).snoozedUntil, null);

    const body = new URLSearchParams();
    body.append('numbers', '1001');
    body.append('action', 'snooze:week');
    body.append('returnTo', '/admin/tickets');
    const bulk = await fetch(app.url('/admin/tickets/bulk'), {
        method: 'POST', redirect: 'manual',
        headers: { Cookie: admin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
    });
    assert.equal(bulk.headers.get('location'), '/admin/tickets?bulk=1');
    assert.equal(store.countViews().snoozed, 2);

    // Loesen hebt die Wiedervorlage auf; ein geloestes Ticket laesst sich nicht zurueckstellen
    await fetch(app.url('/admin/tickets/1002/properties'), formPost({ status: 'resolved' }, admin));
    assert.equal(store.getByNumber(1002).snoozedUntil, null);
    const resolved = await fetch(app.url('/admin/tickets/1002/snooze'), formPost({ preset: 'tomorrow' }, admin));
    assert.equal(resolved.status, 400);
});
