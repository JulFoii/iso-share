'use strict';

/* Integrationstests gegen eine echte Instanz auf einem freien Port. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { once } = require('events');

const { startTestApp } = require('./helpers/app');
const { makeIso } = require('./helpers/make-iso');
const { createApp } = require('../server');
const { totpAt } = require('../lib/totp');

/* Legt eine Datei direkt in uploads/ ab und laesst sie hashen. */
async function seedIso(app, name, options = {}) {
    const content = makeIso(options);
    await fsp.mkdir(app.uploadsDir, { recursive: true });
    await fsp.writeFile(path.join(app.uploadsDir, name), content);
    await app.services.hashQueue.scanAll();
    await app.services.hashQueue.whenIdle();
    return content;
}

/* ============================================================ Oeffentlich */

test('Startseite listet Dateien mit Volume-Label und Checksumme', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const content = await seedIso(app, 'ubuntu.iso', { volumeId: 'UBUNTU_24_04' });
    const expected = crypto.createHash('sha256').update(content).digest('hex');

    const html = await (await fetch(app.url('/'))).text();
    assert.match(html, /ubuntu\.iso/);
    assert.match(html, /UBUNTU_24_04/, 'Volume-Label muss in der Liste stehen');
    assert.ok(html.includes(expected), 'Checksumme muss in der Detailzeile stehen');
    assert.match(html, /BIOS/);
    assert.match(html, /UEFI/);
});

test('/checksums liefert eine SHA256SUMS-Datei im coreutils-Format', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const content = await seedIso(app, 'debian.iso');
    const expected = crypto.createHash('sha256').update(content).digest('hex');

    const res = await fetch(app.url('/checksums'));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/plain/);
    assert.match(res.headers.get('content-disposition'), /SHA256SUMS/);

    const body = await res.text();
    assert.equal(body, `${expected}  debian.iso\n`);
});

test('/api/files.json liefert dieselben Felder wie die Startseite, gefiltert per ?q=', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const content = await seedIso(app, 'fedora.iso', { volumeId: 'FEDORA_40' });
    await seedIso(app, 'debian.iso', { volumeId: 'DEBIAN_12' });
    const expected = crypto.createHash('sha256').update(content).digest('hex');

    const res = await fetch(app.url('/api/files.json'));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    const files = await res.json();
    assert.equal(files.length, 2);
    const fedora = files.find(f => f.name === 'fedora.iso');
    assert.equal(fedora.sha256, expected);
    assert.equal(fedora.iso.volumeId, 'FEDORA_40');
    assert.equal(fedora.hashStatus, 'done');

    const filtered = await (await fetch(app.url('/api/files.json?q=fedora'))).json();
    assert.deepEqual(filtered.map(f => f.name), ['fedora.iso']);
});

test('/api/tags.json liefert dieselben Tags wie die Tag-Filterleiste, unabhaengig von der Suche', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    await seedIso(app, 'uefi.iso', { volumeId: 'UEFI_ONLY', platformIds: [0xef] });
    await seedIso(app, 'bios.iso', { volumeId: 'BIOS_ONLY', platformIds: [0x00] });

    const tags = await (await fetch(app.url('/api/tags.json'))).json();
    assert.ok(Array.isArray(tags));
    assert.ok(tags.length > 0);

    const scoped = await (await fetch(app.url('/api/tags.json?q=uefi'))).json();
    assert.deepEqual(scoped, tags, '/api/tags.json ignoriert q wie listAllTags()');
});

test('/partials/listing liefert gerenderte Dateizeilen und Tag-Filter fuer den Heartbeat', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    await seedIso(app, 'heartbeat.iso', { volumeId: 'HEARTBEAT', platformIds: [0xef] });

    const res = await fetch(app.url('/partials/listing'), { headers: { Accept: 'application/json' } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    const body = await res.json();
    assert.equal(body.visibleCount, 1);
    assert.match(body.filesHtml, /heartbeat\.iso/);
    assert.match(body.filesHtml, /data-row=/);
    assert.match(body.tagsHtml, /uefi/i);
});

test('/admin/partials/listing: nur mit Sitzung erreichbar, liefert Dateien/Tags/Audit-Log/Passkeys/Tokens', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const noSession = await fetch(app.url('/admin/partials/listing'), { headers: { Accept: 'application/json' } });
    assert.equal(noSession.status, 401);

    const { cookie } = await app.login();
    await seedIso(app, 'admin-heartbeat.iso');

    const res = await fetch(app.url('/admin/partials/listing'), {
        headers: { Cookie: cookie, Accept: 'application/json' },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.filesHtml, /admin-heartbeat\.iso/);
    assert.equal(typeof body.tagsHtml, 'string');
    assert.equal(typeof body.passkeysHtml, 'string');
    assert.equal(typeof body.apiTokensHtml, 'string');
    assert.ok(Array.isArray(body.auditEntries));
    assert.ok(body.auditEntries.some(entry => entry.event === 'login_success'));
    assert.ok(body.auditEntries.every(entry => typeof entry.id === 'number'));
});

test('/checksums laesst noch nicht gehashte Dateien weg', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    // Ohne scanAll bleibt die Datei ohne Checksumme
    await fsp.mkdir(app.uploadsDir, { recursive: true });
    await fsp.writeFile(path.join(app.uploadsDir, 'ungehasht.iso'), makeIso());

    assert.equal(await (await fetch(app.url('/checksums'))).text(), '');

    const html = await (await fetch(app.url('/'))).text();
    assert.match(html, /noch nicht berechnet/,
        'die Ansicht muss den offenen Zustand benennen statt nichts zu zeigen');
});

test('/healthz antwortet ohne Verzeichnis-Listing', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const res = await fetch(app.url('/healthz'));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.uptime, 'number');
});

/* ============================================================== Download */

test('Download liefert die Datei und zaehlt sie', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const content = await seedIso(app, 'zaehl.iso');

    const res = await fetch(app.url('/download/zaehl.iso'));
    assert.equal(res.status, 200);
    const received = Buffer.from(await res.arrayBuffer());
    assert.ok(received.equals(content));

    await fetch(app.url('/download/zaehl.iso'));

    assert.equal((await app.services.metadata.read('zaehl.iso')).downloads, 2);
});

test('Range-Requests werden nicht als eigener Download gezaehlt', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    await seedIso(app, 'range.iso');

    for (let i = 0; i < 3; i++) {
        const res = await fetch(app.url('/download/range.iso'), {
            headers: { Range: 'bytes=0-99' },
        });
        assert.equal(res.status, 206);
    }

    const meta = await app.services.metadata.read('range.iso');
    assert.equal(meta?.downloads ?? 0, 0,
        'ein Download-Manager mit acht Verbindungen ist ein Download, nicht acht');
});

test('Download weist Traversal und fremde Endungen ab', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    // Kodiertes ../ — nach dem Dekodieren muss safeIsoName greifen
    assert.equal((await fetch(app.url('/download/..%2F..%2Fserver.js'))).status, 400);
    assert.equal((await fetch(app.url('/download/%2E%2E%2Fpackage.json'))).status, 400);
    assert.equal((await fetch(app.url('/download/notizen.txt'))).status, 400);
    assert.equal((await fetch(app.url('/download/fehlt.iso'))).status, 404);
});

test('Sidecar-Metadaten sind nicht ueber /download erreichbar', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    await seedIso(app, 'privat.iso');
    // .meta liegt in uploads/, darf aber nicht ausgeliefert werden
    assert.equal((await fetch(app.url('/download/.meta'))).status, 400);
    assert.equal((await fetch(app.url('/uploads/privat.iso'))).status, 404);
});

/* ================================================================= Login */

test('Login: falsches Passwort 401, richtiges setzt eine Sitzung', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const bad = await app.login('falsch');
    assert.equal(bad.res.status, 401);

    const good = await app.login();
    assert.equal(good.res.status, 302);
    assert.equal(good.res.headers.get('location'), '/admin-upload');
    assert.match(good.cookie, /iso\.sid=/);

    const admin = await fetch(app.url('/admin-upload'), {
        headers: { Cookie: good.cookie },
    });
    assert.equal(admin.status, 200);
    assert.match(await admin.text(), /Verwaltung/);
});

test('Admin-Idle-Timeout: Sitzung wird nach Inaktivitaet verworfen und muss sich neu anmelden', async t => {
    const app = await startTestApp({ adminIdleTimeoutMs: 500 });
    t.after(() => app.close());

    const { cookie } = await app.login();

    const stillActive = await fetch(app.url('/admin-upload'), {
        headers: { Cookie: cookie },
    });
    assert.equal(stillActive.status, 200, 'innerhalb des Idle-Fensters bleibt die Sitzung gueltig');

    await new Promise(resolve => setTimeout(resolve, 700));

    const idled = await fetch(app.url('/admin-upload'), {
        headers: { Cookie: cookie },
        redirect: 'manual',
    });
    assert.equal(idled.status, 302);
    assert.equal(idled.headers.get('location'), '/login?idle=1');

    // Die verworfene Sitzung darf auch nach einer erneuten Anmeldung nicht
    // wieder gueltig werden.
    const stale = await fetch(app.url('/admin-upload'), {
        headers: { Cookie: cookie },
        redirect: 'manual',
    });
    assert.equal(stale.status, 302);

    const { cookie: freshCookie } = await app.login();
    assert.notEqual(freshCookie, cookie, 'Neuanmeldung muss eine neue Session-ID vergeben');
    const reAuthed = await fetch(app.url('/admin-upload'), {
        headers: { Cookie: freshCookie },
    });
    assert.equal(reAuthed.status, 200);
});

test('/logout?idle=1 (clientseitig durch idle-timer.js erkannter Ablauf) landet auf /login?idle=1 mit Meldung', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const { cookie } = await app.login();

    const loggedOut = await fetch(app.url('/logout?idle=1'), {
        headers: { Cookie: cookie },
        redirect: 'manual',
    });
    assert.equal(loggedOut.status, 302);
    assert.equal(loggedOut.headers.get('location'), '/login?idle=1');

    const loginPage = await fetch(app.url('/login?idle=1'));
    assert.match(await loginPage.text(), /Wegen Inaktivität abgemeldet/);

    // Die Sitzung ist tatsaechlich verworfen, nicht nur weitergeleitet.
    const afterLogout = await fetch(app.url('/admin-upload'), {
        headers: { Cookie: cookie },
        redirect: 'manual',
    });
    assert.equal(afterLogout.status, 302);
    assert.equal(afterLogout.headers.get('location'), '/login');
});

test('Normales /logout (ohne idle=1) landet weiterhin auf der oeffentlichen Startseite', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const { cookie } = await app.login();

    const loggedOut = await fetch(app.url('/logout'), {
        headers: { Cookie: cookie },
        redirect: 'manual',
    });
    assert.equal(loggedOut.status, 302);
    assert.equal(loggedOut.headers.get('location'), '/');
});

test('/admin/ping verlaengert den Idle-Timeout, /admin/partials/listing mit X-Idle-Background nicht', async t => {
    const app = await startTestApp({ adminIdleTimeoutMs: 500 });
    t.after(() => app.close());

    const { cookie } = await app.login();

    // Ein als Hintergrund markierter Poll (wie ihn heartbeat.js schickt)
    // darf die Sitzung nicht ueber das Idle-Fenster hinaus retten.
    await new Promise(resolve => setTimeout(resolve, 300));
    const heartbeatPoll = await fetch(app.url('/admin/partials/listing'), {
        headers: { Cookie: cookie, Accept: 'application/json', 'X-Idle-Background': '1' },
    });
    assert.equal(heartbeatPoll.status, 200);

    await new Promise(resolve => setTimeout(resolve, 300));
    const idledDespitePolling = await fetch(app.url('/admin-upload'), {
        headers: { Cookie: cookie },
        redirect: 'manual',
    });
    assert.equal(idledDespitePolling.status, 302,
        'Hintergrund-Polling ohne echte Nutzeraktivitaet darf den Idle-Timeout nicht aushebeln');

    // Ein echter Keepalive-Ping (wie ihn idle-timer.js bei Aktivitaet
    // schickt) verlaengert die Sitzung dagegen wirklich.
    const { cookie: freshCookie } = await app.login();
    await new Promise(resolve => setTimeout(resolve, 300));
    const ping = await fetch(app.url('/admin/ping'), {
        headers: { Cookie: freshCookie },
    });
    assert.equal(ping.status, 204);

    await new Promise(resolve => setTimeout(resolve, 300));
    const stillAliveAfterPing = await fetch(app.url('/admin-upload'), {
        headers: { Cookie: freshCookie },
        redirect: 'manual',
    });
    assert.equal(stillAliveAfterPing.status, 200,
        'ein echter Ping muss lastActivity erneuern und die Sitzung ueber das urspruengliche Fenster hinaus verlaengern');
});

test('Sitzung ueberlebt einen Neustart des Servers', async t => {
    const app = await startTestApp();
    const { cookie } = await app.login();
    const root = app.root;

    // Gleiche Verzeichnisse, neue Instanz — wie ein `docker restart`.
    // shutdown() statt close(), sonst raeumt der Test den Sitzungsordner weg,
    // den er gleich noch braucht.
    await app.shutdown();
    const restarted = await startTestApp({
        uploadsDir: path.join(root, 'uploads'),
        tmpDir: path.join(root, 'tmp-uploads'),
        dataDir: path.join(root, 'data'),
    });
    t.after(() => restarted.close());

    const res = await fetch(restarted.url('/admin-upload'), {
        headers: { Cookie: cookie },
        redirect: 'manual',
    });
    assert.equal(res.status, 200, 'Cookie muss nach dem Neustart noch gelten');
});

test('Sitzung ueberlebt einen Neustart auch ohne gesetztes SESSION_SECRET (DB-Bootstrap statt fluechtigem Zufallswert)', async t => {
    const app = await startTestApp({ sessionSecret: undefined });
    const { cookie } = await app.login();
    const root = app.root;

    await app.shutdown();
    const restarted = await startTestApp({
        uploadsDir: path.join(root, 'uploads'),
        tmpDir: path.join(root, 'tmp-uploads'),
        dataDir: path.join(root, 'data'),
        sessionSecret: undefined,
    });
    t.after(() => restarted.close());

    const res = await fetch(restarted.url('/admin-upload'), {
        headers: { Cookie: cookie },
        redirect: 'manual',
    });
    assert.equal(res.status, 200,
        'ohne persistierten Session-Secret wuerde die neue Instanz mit einem anderen Zufallswert signieren und das Cookie waere ungueltig');
});

test('geschuetzte Routen ohne Sitzung: Redirect bzw. 401 fuer JSON', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const html = await fetch(app.url('/admin-upload'), { redirect: 'manual' });
    assert.equal(html.status, 302);
    assert.equal(html.headers.get('location'), '/login');

    const json = await fetch(app.url('/upload/init'), {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ name: 'x.iso', size: 10 }),
    });
    assert.equal(json.status, 401);
    assert.equal((await json.json()).error, 'Nicht angemeldet.');
});

test('Cross-Origin-POST wird abgelehnt', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const res = await fetch(app.url('/login'), {
        method: 'POST',
        redirect: 'manual',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Origin: 'http://angreifer.example',
        },
        body: new URLSearchParams({ password: 'korrekt-horse-battery' }).toString(),
    });
    assert.equal(res.status, 403);
});

test('Login-Versuche werden pro IP gedrosselt', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    let last = 0;
    // Limit ist 10 Fehlversuche je 15 Minuten
    for (let i = 0; i < 12; i++) {
        const res = await app.login('falsch');
        last = res.res.status;
    }
    assert.equal(last, 429);

    // Auch das richtige Passwort kommt jetzt nicht mehr durch
    assert.equal((await app.login()).res.status, 429);
});

/* ======================================================= Admin-Passwort */

test('POST /admin-password ohne Sitzung wird abgewiesen', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const res = await fetch(app.url('/admin-password'), {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ password: 'neues-passwort', confirmPassword: 'neues-passwort' }).toString(),
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/login');
});

test('zu kurzes Passwort wird abgelehnt, altes bleibt gueltig', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    const res = await fetch(app.url('/admin-password'), {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ password: 'kurz', confirmPassword: 'kurz' }).toString(),
    });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /mindestens 8 Zeichen/);

    assert.equal((await app.login()).res.status, 302, 'altes Passwort muss weiterhin gelten');
});

test('abweichende Passwortbestaetigung wird abgelehnt, altes bleibt gueltig', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    const res = await fetch(app.url('/admin-password'), {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ password: 'neues-passwort-1', confirmPassword: 'neues-passwort-2' }).toString(),
    });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /stimmen nicht überein/);

    assert.equal((await app.login()).res.status, 302, 'altes Passwort muss weiterhin gelten');
});

test('/admin-password mit Accept: application/json liefert JSON statt Redirect/Render', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    const tooShort = await fetch(app.url('/admin-password'), {
        method: 'POST',
        headers: {
            Cookie: cookie,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
        },
        body: new URLSearchParams({ password: 'kurz', confirmPassword: 'kurz' }).toString(),
    });
    assert.equal(tooShort.status, 400);
    assert.match((await tooShort.json()).error, /mindestens 8 Zeichen/);

    const success = await fetch(app.url('/admin-password'), {
        method: 'POST',
        headers: {
            Cookie: cookie,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
        },
        body: new URLSearchParams({ password: 'per-json-gesetzt', confirmPassword: 'per-json-gesetzt' }).toString(),
    });
    assert.equal(success.status, 200);
    assert.deepEqual(await success.json(), { ok: true });

    assert.equal((await app.login('per-json-gesetzt')).res.status, 302);
});

test('erfolgreiche Passwortaenderung: altes schlaegt fehl, neues funktioniert', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    const res = await fetch(app.url('/admin-password'), {
        method: 'POST',
        redirect: 'manual',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ password: 'ganz-neues-passwort', confirmPassword: 'ganz-neues-passwort' }).toString(),
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/admin-upload');

    assert.equal((await app.login()).res.status, 401, 'altes Passwort darf nicht mehr gelten');
    assert.equal((await app.login('ganz-neues-passwort')).res.status, 302);
});

test('geaendertes Passwort ueberlebt einen Neustart, ADMIN_PASSWORD der alten Instanz nicht mehr', async t => {
    const app = await startTestApp();
    const { cookie } = await app.login();
    const root = app.root;

    await fetch(app.url('/admin-password'), {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ password: 'persistiertes-passwort', confirmPassword: 'persistiertes-passwort' }).toString(),
    });

    await app.shutdown();
    const restarted = await startTestApp({
        uploadsDir: path.join(root, 'uploads'),
        tmpDir: path.join(root, 'tmp-uploads'),
        dataDir: path.join(root, 'data'),
        // andere adminPassword-Option als beim ersten Start — darf keine
        // Rolle mehr spielen, sobald einmal ueber die UI geaendert wurde
        adminPassword: 'ignoriert-weil-persistiert',
    });
    t.after(() => restarted.close());

    assert.equal((await restarted.login('ignoriert-weil-persistiert')).res.status, 401);
    assert.equal((await restarted.login('persistiertes-passwort')).res.status, 302);
});

test('gesetztes ADMIN_PASSWORD wird schon beim ersten Start persistiert, eine spaeter geaenderte Env-Var wirkt nicht mehr', async t => {
    const app = await startTestApp({ adminPassword: 'erster-start-passwort' });
    const root = app.root;

    // Schon nach dem ersten Start liegt ein Hash in der DB — nicht erst nach
    // einer expliziten Aenderung ueber /admin-password.
    assert.ok(await app.services.passwordStore.read());
    await app.shutdown();

    const restarted = await startTestApp({
        uploadsDir: path.join(root, 'uploads'),
        tmpDir: path.join(root, 'tmp-uploads'),
        dataDir: path.join(root, 'data'),
        adminPassword: 'andere-env-var-danach',
    });
    t.after(() => restarted.close());

    assert.equal((await restarted.login('andere-env-var-danach')).res.status, 401,
        'die beim zweiten Start abweichende Env-Var darf nicht mehr gelten');
    assert.equal((await restarted.login('erster-start-passwort')).res.status, 302,
        'das beim ersten Start bootstrappede Passwort muss weiter gelten');
});

/* ======================================================= Admin-Benutzername */

test('falscher Benutzername mit richtigem Passwort wird generisch abgelehnt', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const res = await app.login('korrekt-horse-battery', 'jemand-anderes');
    assert.equal(res.res.status, 401);
    const body = await res.res.text();
    assert.match(body, /Benutzername oder Passwort falsch/);
    assert.doesNotMatch(body, /Falsches Passwort/);
});

test('richtiger Benutzername mit falschem Passwort wird generisch abgelehnt', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const res = await app.login('falsch', 'admin');
    assert.equal(res.res.status, 401);
    assert.match(await res.res.text(), /Benutzername oder Passwort falsch/);
});

test('POST /admin-username ohne Sitzung wird abgewiesen', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const res = await fetch(app.url('/admin-username'), {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: 'neuer-name' }).toString(),
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/login');
});

test('ungueltiger Benutzername wird abgelehnt, alter bleibt gueltig', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    for (const bad of ['', '   ', 'mit leerzeichen', 'a'.repeat(65)]) {
        const res = await fetch(app.url('/admin-username'), {
            method: 'POST',
            headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ username: bad }).toString(),
        });
        assert.equal(res.status, 400, `"${bad}" haette 400 ergeben muessen`);
    }

    assert.equal((await app.login()).res.status, 302, 'alter Benutzername muss weiterhin gelten');
});

test('/admin-username mit Accept: application/json liefert JSON statt Redirect/Render', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    const invalid = await fetch(app.url('/admin-username'), {
        method: 'POST',
        headers: {
            Cookie: cookie,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
        },
        body: new URLSearchParams({ username: '' }).toString(),
    });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /Ungültiger Benutzername/);

    const success = await fetch(app.url('/admin-username'), {
        method: 'POST',
        headers: {
            Cookie: cookie,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
        },
        body: new URLSearchParams({ username: 'per-json-gesetzt' }).toString(),
    });
    assert.equal(success.status, 200);
    assert.deepEqual(await success.json(), { ok: true });

    assert.equal((await app.login('korrekt-horse-battery', 'per-json-gesetzt')).res.status, 302);
});

test('erfolgreiche Benutzernamensaenderung: alter schlaegt fehl, neuer funktioniert', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    const res = await fetch(app.url('/admin-username'), {
        method: 'POST',
        redirect: 'manual',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: 'ganz-neuer-name' }).toString(),
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/admin-upload');

    assert.equal((await app.login()).res.status, 401, 'alter Benutzername darf nicht mehr gelten');
    assert.equal((await app.login('korrekt-horse-battery', 'ganz-neuer-name')).res.status, 302);
});

test('geaenderter Benutzername ueberlebt einen Neustart', async t => {
    const app = await startTestApp();
    const { cookie } = await app.login();
    const root = app.root;

    await fetch(app.url('/admin-username'), {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: 'persistierter-name' }).toString(),
    });

    await app.shutdown();
    const restarted = await startTestApp({
        uploadsDir: path.join(root, 'uploads'),
        tmpDir: path.join(root, 'tmp-uploads'),
        dataDir: path.join(root, 'data'),
    });
    t.after(() => restarted.close());

    assert.equal((await restarted.login()).res.status, 401, 'alter Default-Benutzername darf nicht mehr gelten');
    assert.equal(
        (await restarted.login('korrekt-horse-battery', 'persistierter-name')).res.status,
        302
    );
});

test('der Default-Benutzername wird schon beim ersten Start in die DB geschrieben', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    // Kein POST /admin-username noetig — start() bootstrappt den Default
    // direkt in die DB, damit dort nicht "leer" steht.
    assert.equal(await app.services.usernameStore.read(), 'admin');
});

test('ohne ADMIN_PASSWORD wird beim ersten Start genau einmal ein Passwort erzeugt und persistiert', async t => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'iso-share-bootstrap-'));
    t.after(() => fsp.rm(root, { recursive: true, force: true }));

    const warnings = [];
    const log = { log() {}, warn: msg => warnings.push(msg), error() {} };
    const dirs = {
        uploadsDir: path.join(root, 'uploads'),
        tmpDir: path.join(root, 'tmp-uploads'),
        dataDir: path.join(root, 'data'),
        sessionSecret: 'test-secret',
        scanOnStart: false,
        sweepStaleUploads: false,
        log,
    };

    async function loginWith(instance, password) {
        const server = instance.app.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const base = `http://127.0.0.1:${server.address().port}`;
        const res = await fetch(`${base}/login`, {
            method: 'POST',
            redirect: 'manual',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ username: 'admin', password }).toString(),
        });
        server.close();
        server.closeAllConnections();
        await once(server, 'close');
        return res.status;
    }

    const first = createApp(dirs);
    await first.start();

    // [^)]* statt [^:]* bis zum Ende der Klammer: der Pfad selbst enthaelt
    // unter Windows ein Colon (z. B. "C:\...\iso-share.db").
    const match = warnings.join('\n').match(/Einmalig generiertes Passwort \([^)]*\):\n\s+(\S+)/);
    assert.ok(match, 'Passwort haette geloggt werden muessen');
    const generated = match[1];
    assert.ok(await first.services.passwordStore.read(), 'Passwort haette persistiert werden muessen');
    assert.equal(await loginWith(first, generated), 302);
    await first.stop();

    // Zweiter Start, gleiche Verzeichnisse: kein neues Passwort erzeugt
    warnings.length = 0;
    const second = createApp(dirs);
    await second.start();
    assert.equal(
        warnings.some(w => w.includes('Einmalig generiertes Passwort')),
        false,
        'zweiter Start darf kein neues Passwort erzeugen'
    );
    assert.equal(await loginWith(second, generated), 302,
        'urspruenglich generiertes Passwort muss weiterhin gelten');
    await second.stop();
});

/* ======================================================= Upload (Chunks) */

test('fortsetzbarer Upload: init, zwei Chunks, finish', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    const content = makeIso({ volumeId: 'CHUNKED_TEST' });
    const half = Math.floor(content.length / 2);

    const init = await fetch(app.url('/upload/init'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: 'chunk.iso', size: content.length }),
    });
    assert.equal(init.status, 201);
    const session = await init.json();
    assert.equal(session.offset, 0);

    async function patch(offset, slice) {
        return fetch(app.url(`/upload/${session.id}`), {
            method: 'PATCH',
            headers: {
                Cookie: cookie,
                'Content-Type': 'application/octet-stream',
                'Upload-Offset': String(offset),
            },
            body: slice,
        });
    }

    const first = await patch(0, content.subarray(0, half));
    assert.equal(first.status, 200);
    assert.equal((await first.json()).offset, half);

    // Zwischenstand abfragen — genau das macht der Client nach einem Netzfehler
    const status = await fetch(app.url(`/upload/${session.id}`), {
        headers: { Cookie: cookie },
    });
    assert.equal((await status.json()).offset, half);

    const second = await patch(half, content.subarray(half));
    const secondBody = await second.json();
    assert.equal(secondBody.offset, content.length);
    assert.equal(secondBody.complete, true);

    const finish = await fetch(app.url(`/upload/${session.id}/finish`), {
        method: 'POST',
        headers: { Cookie: cookie },
    });
    assert.equal(finish.status, 201);
    assert.equal((await finish.json()).filename, 'chunk.iso');

    const written = await fsp.readFile(path.join(app.uploadsDir, 'chunk.iso'));
    assert.ok(written.equals(content), 'zusammengesetzte Datei muss identisch sein');

    // Checksumme laeuft im Hintergrund nach
    await app.services.hashQueue.whenIdle();
    const meta = await app.services.metadata.read('chunk.iso');
    assert.equal(meta.sha256, crypto.createHash('sha256').update(content).digest('hex'));
    assert.equal(meta.iso.volumeId, 'CHUNKED_TEST');
});

test('PATCH mit falschem Offset liefert 409 samt Serverstand', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    const init = await fetch(app.url('/upload/init'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: 'konflikt.iso', size: 400 }),
    });
    const session = await init.json();

    await fetch(app.url(`/upload/${session.id}`), {
        method: 'PATCH',
        headers: {
            Cookie: cookie,
            'Content-Type': 'application/octet-stream',
            'Upload-Offset': '0',
        },
        body: Buffer.alloc(100),
    });

    const conflict = await fetch(app.url(`/upload/${session.id}`), {
        method: 'PATCH',
        headers: {
            Cookie: cookie,
            'Content-Type': 'application/octet-stream',
            'Upload-Offset': '250',
        },
        body: Buffer.alloc(50),
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).offset, 100);
});

test('PATCH ohne Upload-Offset-Header wird abgelehnt', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    const init = await fetch(app.url('/upload/init'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: 'ohnekopf.iso', size: 100 }),
    });
    const session = await init.json();

    const res = await fetch(app.url(`/upload/${session.id}`), {
        method: 'PATCH',
        headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' },
        body: Buffer.alloc(10),
    });
    assert.equal(res.status, 400);
});

test('Upload-IDs ausserhalb des UUID-Formats werden abgewiesen', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    for (const id of ['..%2F..%2Fetc', 'abc', '1']) {
        const res = await fetch(app.url(`/upload/${id}`), {
            headers: { Cookie: cookie, Accept: 'application/json' },
        });
        assert.equal(res.status, 400, `ID ${id} haette 400 ergeben muessen`);
    }
});

test('init lehnt Nicht-ISO und zu grosse Dateien ab', async t => {
    const app = await startTestApp();   // maxFileSizeMb: 1
    t.after(() => app.close());
    const { cookie } = await app.login();

    async function init(body) {
        return fetch(app.url('/upload/init'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify(body),
        });
    }

    assert.equal((await init({ name: 'schaedlich.txt', size: 10 })).status, 400);
    assert.equal((await init({ name: '../flucht.iso', size: 10 })).status, 400);
    assert.equal((await init({ name: 'zugross.iso', size: 5 * 1024 * 1024 })).status, 413);
});

test('abgebrochener Upload wird serverseitig entfernt', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    const init = await fetch(app.url('/upload/init'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: 'weg.iso', size: 100 }),
    });
    const session = await init.json();

    const del = await fetch(app.url(`/upload/${session.id}`), {
        method: 'DELETE',
        headers: { Cookie: cookie },
    });
    assert.equal(del.status, 204);
    assert.equal((await app.services.uploadSessions.listSessions()).length, 0);
});

/* ==================================== Dedup und explizite Versions-Ersetzung */

/* Fuehrt einen kompletten Chunk-Upload in einem Rutsch durch (ein Chunk). */
async function chunkedUpload(app, cookie, { name, content, replaces }) {
    const init = await fetch(app.url('/upload/init'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name, size: content.length, replaces }),
    });
    const session = await init.json();
    if (init.status !== 201) return { init, session };

    const patch = await fetch(app.url(`/upload/${session.id}`), {
        method: 'PATCH',
        headers: {
            Cookie: cookie,
            'Content-Type': 'application/octet-stream',
            'Upload-Offset': '0',
        },
        body: content,
    });
    assert.equal(patch.status, 200);

    const finish = await fetch(app.url(`/upload/${session.id}/finish`), {
        method: 'POST',
        headers: { Cookie: cookie },
    });
    return { init, finish, body: await finish.json() };
}

test('Chunk-Upload lehnt inhaltsgleiche Datei unter anderem Namen ab', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    const content = await seedIso(app, 'original.iso', { volumeId: 'DUP' });

    const { finish, body } = await chunkedUpload(app, cookie, { name: 'kopie.iso', content });
    assert.equal(finish.status, 409);
    assert.equal(body.duplicateOf, 'original.iso');

    await assert.rejects(fsp.access(path.join(app.uploadsDir, 'kopie.iso')));
    assert.equal((await app.services.uploadSessions.listSessions()).length, 0);
});

test('Chunk-Upload mit "replaces" ersetzt die alte Version automatisch', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    await seedIso(app, 'projekt-v1.iso', { volumeId: 'PROJEKT_V1' });
    const contentV2 = makeIso({ volumeId: 'PROJEKT_V2' });

    const { finish, body } = await chunkedUpload(app, cookie, {
        name: 'projekt-v2.iso', content: contentV2, replaces: 'projekt-v1.iso',
    });
    assert.equal(finish.status, 201);
    assert.equal(body.filename, 'projekt-v2.iso');
    assert.equal(body.replaced, 'projekt-v1.iso');

    await assert.rejects(fsp.access(path.join(app.uploadsDir, 'projekt-v1.iso')));
    assert.equal(await app.services.metadata.read('projekt-v1.iso'), null);
    const written = await fsp.readFile(path.join(app.uploadsDir, 'projekt-v2.iso'));
    assert.ok(written.equals(contentV2));

    const entries = await app.services.auditLog.read({ limit: 10 });
    assert.ok(entries.some(e => e.event === 'upload_replaced' && e.replaces === 'projekt-v1.iso'));
});

test('"replaces" bewahrt ein Duplikat unter dem alten Namen vor der Ablehnung', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    const content = await seedIso(app, 'umbenannt-alt.iso', { volumeId: 'RENAME' });

    // Gleicher Inhalt, neuer Name, aber explizit als Ersatz der alten Datei
    // markiert — kein Duplikat, sondern eine reine Umbenennung.
    const { finish, body } = await chunkedUpload(app, cookie, {
        name: 'umbenannt-neu.iso', content, replaces: 'umbenannt-alt.iso',
    });
    assert.equal(finish.status, 201);
    assert.equal(body.replaced, 'umbenannt-alt.iso');
    await assert.rejects(fsp.access(path.join(app.uploadsDir, 'umbenannt-alt.iso')));
});

test('Multipart-Fallback: Dedup und "replaces" gelten genauso', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    const content = await seedIso(app, 'fallback-original.iso', { volumeId: 'FB_DUP' });

    const dupForm = new FormData();
    dupForm.append('file', new Blob([content]), 'fallback-kopie.iso');
    const dupRes = await fetch(app.url('/upload'), {
        method: 'POST',
        headers: { Cookie: cookie, Accept: 'application/json' },
        body: dupForm,
    });
    assert.equal(dupRes.status, 409);
    await assert.rejects(fsp.access(path.join(app.uploadsDir, 'fallback-kopie.iso')));

    const newContent = makeIso({ volumeId: 'FB_V2' });
    const replaceForm = new FormData();
    replaceForm.append('file', new Blob([newContent]), 'fallback-v2.iso');
    replaceForm.append('replaces', 'fallback-original.iso');
    const replaceRes = await fetch(app.url('/upload'), {
        method: 'POST',
        headers: { Cookie: cookie, Accept: 'application/json' },
        body: replaceForm,
    });
    assert.equal(replaceRes.status, 201);
    const body = await replaceRes.json();
    assert.equal(body.replaced, 'fallback-original.iso');
    await assert.rejects(fsp.access(path.join(app.uploadsDir, 'fallback-original.iso')));
});

/* ================================================= Upload ohne JavaScript */

test('Multipart-Fallback laedt hoch und weist Nicht-ISO ab', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    const content = makeIso({ volumeId: 'NOJS' });

    const form = new FormData();
    form.append('file', new Blob([content]), 'nojs.iso');
    const ok = await fetch(app.url('/upload'), {
        method: 'POST',
        redirect: 'manual',
        headers: { Cookie: cookie },
        body: form,
    });
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.get('location'), '/admin-upload');

    const written = await fsp.readFile(path.join(app.uploadsDir, 'nojs.iso'));
    assert.ok(written.equals(content));

    const bad = new FormData();
    bad.append('file', new Blob(['nur text']), 'schaedlich.txt');
    const rejected = await fetch(app.url('/upload'), {
        method: 'POST',
        headers: { Cookie: cookie },
        body: bad,
    });
    assert.equal(rejected.status, 400);
});

/* ================================================================ Delete */

test('Loeschen entfernt Datei und Sidecar', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    await seedIso(app, 'loeschmich.iso');
    assert.ok(await app.services.metadata.read('loeschmich.iso'));

    const res = await fetch(app.url('/delete'), {
        method: 'POST',
        redirect: 'manual',
        headers: {
            Cookie: cookie,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ filename: 'loeschmich.iso' }).toString(),
    });
    assert.equal(res.status, 302);

    await assert.rejects(() => fsp.stat(path.join(app.uploadsDir, 'loeschmich.iso')));
    assert.equal(await app.services.metadata.read('loeschmich.iso'), null,
        'sonst zeigt ein spaeteres Image mit gleichem Namen die alte Checksumme');
});

test('Loeschen weist Traversal-Namen ab', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    for (const filename of ['../server.js', '../../etc/passwd', 'x.txt']) {
        const res = await fetch(app.url('/delete'), {
            method: 'POST',
            headers: {
                Cookie: cookie,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({ filename }).toString(),
        });
        assert.equal(res.status, 400);
    }
});

/* =============================================================== Suche */

test('Suche filtert serverseitig', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    await seedIso(app, 'alpine.iso');
    await seedIso(app, 'fedora.iso');

    const html = await (await fetch(app.url('/search?q=alp'))).text();
    assert.match(html, /alpine\.iso/);
    assert.doesNotMatch(html, /fedora\.iso/);
});

/* ===================================================== WebAuthn/Passkeys
   Kein echter WebAuthn-Roundtrip hier — der braucht einen echten
   Authenticator (siehe manueller Testpass im Plan). Getestet wird die
   HTTP-Oberflaeche: Auth-Gating, geteiltes Rate-Limit mit /login,
   Eingabevalidierung und dass die Challenge ueber die Session transportiert
   wird. */

test('WebAuthn-Routen verlangen eine Sitzung', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const routes = [
        ['POST', '/webauthn/register/options'],
        ['POST', '/webauthn/register/verify'],
        ['GET', '/webauthn/credentials'],
        ['DELETE', '/webauthn/credentials/abc'],
    ];
    for (const [method, path_] of routes) {
        const res = await fetch(app.url(path_), {
            method,
            headers: { Accept: 'application/json' },
        });
        assert.equal(res.status, 401, `${method} ${path_} haette 401 liefern muessen`);
    }
});

test('POST /webauthn/login/options ist oeffentlich erreichbar', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const res = await fetch(app.url('/webauthn/login/options'), {
        method: 'POST',
        headers: { Accept: 'application/json' },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.challenge, 'string');
});

test('Passkey-Login-Versuche teilen sich das Rate-Limit mit /login', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    let last = 0;
    // Limit ist 10 Fehlversuche je 15 Minuten, geteilt ueber beide Routen
    for (let i = 0; i < 12; i++) {
        if (i % 2 === 0) {
            last = (await app.login('falsch')).res.status;
        } else {
            const res = await fetch(app.url('/webauthn/login/verify'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ credential: { id: 'unbekannt' } }),
            });
            last = res.status;
        }
    }
    assert.equal(last, 429);
    assert.equal((await app.login()).res.status, 429,
        'ein Angreifer darf sein Budget nicht durch Routenwechsel verdoppeln');
});

test('DELETE mit ungueltiger Credential-ID liefert 400', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    const res = await fetch(app.url('/webauthn/credentials/..%2F..%2Fetc'), {
        method: 'DELETE',
        headers: { Cookie: cookie, Accept: 'application/json' },
    });
    assert.equal(res.status, 400);
});

test('register/verify ohne vorherige register/options liefert 400', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    const res = await fetch(app.url('/webauthn/register/verify'), {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ credential: {} }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'Keine offene Registrierung.');
});

test('login/verify mit unbekannter Credential-ID liefert 401 statt zu werfen', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    // Erst die Ceremony beginnen, damit eine Challenge in der Session liegt
    const options = await fetch(app.url('/webauthn/login/options'), {
        method: 'POST',
        headers: { Accept: 'application/json' },
    });
    const cookie = (options.headers.getSetCookie() || [])
        .map(value => value.split(';')[0]).join('; ');

    const res = await fetch(app.url('/webauthn/login/verify'), {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ credential: { id: 'niemals-registriert' } }),
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'Unbekannter Passkey.');
});

test('login/verify: Challenge kommt ueber die Session, nicht ueber den Body', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    // Einen Passkey direkt im Store anlegen — der eigentliche Verify-Aufruf
    // bleibt trotzdem ohne echten Authenticator: eine kaputte Assertion
    // landet im catch-Zweig, aber NACH der "unbekannter Passkey"-Pruefung.
    await app.services.webauthnStore.addCredential({
        credentialId: 'seeded',
        publicKey: Buffer.from('dummy-key').toString('base64url'),
        counter: 0,
        transports: ['internal'],
        label: 'Test-Passkey',
    });

    const options = await fetch(app.url('/webauthn/login/options'), {
        method: 'POST',
        headers: { Accept: 'application/json' },
    });
    const cookie = (options.headers.getSetCookie() || [])
        .map(value => value.split(';')[0]).join('; ');

    const res = await fetch(app.url('/webauthn/login/verify'), {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
            credential: {
                id: 'seeded',
                rawId: 'seeded',
                type: 'public-key',
                response: {
                    clientDataJSON: 'x', authenticatorData: 'x', signature: 'x',
                },
                clientExtensionResults: {},
            },
        }),
    });
    // 401 (Verifikation fehlgeschlagen), nicht 400 (keine offene Anmeldung)
    // — belegt, dass die Challenge ueber die Session transportiert wurde.
    assert.equal(res.status, 401);
    assert.notEqual((await res.json()).error, 'Keine offene Anmeldung.');
});

test('Cross-Origin-POST auf /webauthn/login/verify wird abgelehnt', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const res = await fetch(app.url('/webauthn/login/verify'), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Origin: 'http://angreifer.example',
        },
        body: JSON.stringify({ credential: { id: 'x' } }),
    });
    assert.equal(res.status, 403);
});

test('GET /webauthn/credentials liefert nie den publicKey', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    await app.services.webauthnStore.addCredential({
        credentialId: 'sichtbar',
        publicKey: 'geheim',
        counter: 0,
        label: 'Test-Passkey',
    });

    const res = await fetch(app.url('/webauthn/credentials'), {
        headers: { Cookie: cookie, Accept: 'application/json' },
    });
    assert.equal(res.status, 200);
    const list = await res.json();
    assert.equal(list.length, 1);
    assert.equal(list[0].credentialId, 'sichtbar');
    assert.equal('publicKey' in list[0], false);
});

/* ==================================================================== TOTP */

test('TOTP: Einrichtung erzwingt beim naechsten Login den zweiten Faktor', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    const setupRes = await fetch(app.url('/totp/setup'), {
        method: 'POST',
        headers: { Cookie: cookie, Accept: 'application/json' },
    });
    assert.equal(setupRes.status, 200);
    const { secret, otpauthUrl } = await setupRes.json();
    assert.match(otpauthUrl, /^otpauth:\/\/totp\//);

    const confirmRes = await fetch(app.url('/totp/confirm'), {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ token: totpAt(secret) }),
    });
    assert.equal(confirmRes.status, 200);
    const { recoveryCodes } = await confirmRes.json();
    assert.equal(recoveryCodes.length, 8);

    // Passwort allein reicht jetzt nicht mehr
    const login = await app.login();
    assert.equal(login.res.status, 302);
    assert.equal(login.res.headers.get('location'), '/login/totp');

    const stillLocked = await fetch(app.url('/admin-upload'), {
        headers: { Cookie: login.cookie },
        redirect: 'manual',
    });
    assert.equal(stillLocked.status, 302);
    assert.equal(stillLocked.headers.get('location'), '/login/totp');

    const wrongCode = await fetch(app.url('/login/totp'), {
        method: 'POST',
        redirect: 'manual',
        headers: { Cookie: login.cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: '000000' }).toString(),
    });
    assert.equal(wrongCode.status, 401);

    const rightCode = await fetch(app.url('/login/totp'), {
        method: 'POST',
        redirect: 'manual',
        headers: { Cookie: login.cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: totpAt(secret) }).toString(),
    });
    assert.equal(rightCode.status, 302);
    assert.equal(rightCode.headers.get('location'), '/admin-upload');

    const admin = await fetch(app.url('/admin-upload'), { headers: { Cookie: login.cookie } });
    assert.equal(admin.status, 200);
});

test('TOTP: ein Recovery-Code gilt genau einmal, /totp/disable entfernt den zweiten Faktor', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    const { secret } = await (await fetch(app.url('/totp/setup'), {
        method: 'POST',
        headers: { Cookie: cookie, Accept: 'application/json' },
    })).json();
    const { recoveryCodes } = await (await fetch(app.url('/totp/confirm'), {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ token: totpAt(secret) }),
    })).json();

    const login = await app.login();
    const usedOnce = await fetch(app.url('/login/totp'), {
        method: 'POST',
        redirect: 'manual',
        headers: { Cookie: login.cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: recoveryCodes[0] }).toString(),
    });
    assert.equal(usedOnce.status, 302, 'Recovery-Code muss beim ersten Mal funktionieren');

    const secondLogin = await app.login();
    const usedTwice = await fetch(app.url('/login/totp'), {
        method: 'POST',
        redirect: 'manual',
        headers: { Cookie: secondLogin.cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: recoveryCodes[0] }).toString(),
    });
    assert.equal(usedTwice.status, 401, 'derselbe Recovery-Code darf kein zweites Mal gelten');

    // Zweiten Faktor wieder deaktivieren — braucht eine voll angemeldete Sitzung
    const disableRes = await fetch(app.url('/totp/disable'), {
        method: 'POST',
        headers: { Cookie: cookie, Accept: 'application/json' },
    });
    assert.equal(disableRes.status, 200);

    const plainLogin = await app.login();
    assert.equal(plainLogin.res.status, 302);
    assert.equal(plainLogin.res.headers.get('location'), '/admin-upload');
});

test('TOTP-Setup-Routen verlangen eine Sitzung', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const res = await fetch(app.url('/totp/setup'), {
        method: 'POST',
        redirect: 'manual',
        headers: { Accept: 'application/json' },
    });
    assert.equal(res.status, 401);
});

/* ============================================================ Bulk-Aktionen */

test('POST /download-zip liefert ein ZIP mit den ausgewaehlten Dateien und zaehlt Downloads', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const contentA = await seedIso(app, 'a.iso');
    const contentB = await seedIso(app, 'b.iso');

    const res = await fetch(app.url('/download-zip'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ names: ['a.iso', 'b.iso', '../evil.iso', 'fehlt.iso'] }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/zip/);

    const body = Buffer.from(await res.arrayBuffer());
    assert.equal(body.subarray(0, 4).toString('hex'), '504b0304', 'muss mit einer Local-File-Header-Signatur beginnen');
    assert.ok(body.includes(Buffer.from('a.iso')));
    assert.ok(body.includes(Buffer.from('b.iso')));
    assert.ok(body.length > contentA.length + contentB.length);

    assert.equal((await app.services.metadata.read('a.iso')).downloads, 1);
    assert.equal((await app.services.metadata.read('b.iso')).downloads, 1);
});

test('POST /download-zip lehnt eine leere oder zu grosse Auswahl ab', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const empty = await fetch(app.url('/download-zip'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ names: ['../etc/passwd', 'notizen.txt'] }),
    });
    assert.equal(empty.status, 400);

    const missing = await fetch(app.url('/download-zip'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ names: ['fehlt.iso'] }),
    });
    assert.equal(missing.status, 404);

    const tooMany = Array.from({ length: 101 }, (_, i) => `datei-${i}.iso`);
    const overLimit = await fetch(app.url('/download-zip'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ names: tooMany }),
    });
    assert.equal(overLimit.status, 400);
});

test('POST /delete-bulk loescht mehrere Dateien und ignoriert ungueltige Namen', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    await seedIso(app, 'a.iso');
    await seedIso(app, 'b.iso');
    await seedIso(app, 'c.iso');

    const res = await fetch(app.url('/delete-bulk'), {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ names: ['a.iso', 'b.iso', '../evil.iso'] }),
    });
    assert.equal(res.status, 200);
    const { deleted } = await res.json();
    assert.deepEqual(deleted.sort(), ['a.iso', 'b.iso']);

    const remaining = (await fsp.readdir(app.uploadsDir)).filter(name => name.endsWith('.iso'));
    assert.deepEqual(remaining, ['c.iso']);
});

test('POST /delete-bulk fuehrt einen gueltig benannten, aber nicht existierenden Namen nicht als geloescht auf', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();
    await seedIso(app, 'a.iso');

    const res = await fetch(app.url('/delete-bulk'), {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ names: ['a.iso', 'existiert-nicht.iso'] }),
    });
    assert.equal(res.status, 200);
    const { deleted } = await res.json();
    assert.deepEqual(deleted, ['a.iso'], 'eine nie vorhandene Datei darf nicht als geloescht gemeldet werden');
});

test('POST /delete-bulk ohne Sitzung wird abgewiesen', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    await seedIso(app, 'a.iso');

    const res = await fetch(app.url('/delete-bulk'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ names: ['a.iso'] }),
    });
    assert.equal(res.status, 401);
    assert.ok((await fsp.readdir(app.uploadsDir)).includes('a.iso'), 'Datei darf ohne Sitzung nicht geloescht werden');
});

/* ===================================================================== Tags */

test('POST /files/:name/tags gibt es nicht mehr — Tags werden nur automatisch vergeben', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();
    await seedIso(app, 'debian.iso');

    const res = await fetch(app.url('/files/debian.iso/tags'), {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ tag: 'Linux' }),
    });
    assert.equal(res.status, 404);
});

test('DELETE /files/:name/tags/:tag entfernt einen Tag case-insensitiv', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();
    // Ohne Boot-Plattformen/Volume-Label, damit keine Auto-Tags dazwischenfunken
    await seedIso(app, 'fedora.iso', { platformIds: [], volumeId: '' });
    await app.services.metadata.update('fedora.iso', { tags: ['Workstation'] });

    const res = await fetch(app.url('/files/fedora.iso/tags/WORKSTATION'), {
        method: 'DELETE',
        headers: { Cookie: cookie, Accept: 'application/json' },
    });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).tags, []);
});

test('DELETE /files/:name/tags/:tag ohne Sitzung wird abgewiesen', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    await seedIso(app, 'a.iso');
    await app.services.metadata.update('a.iso', { tags: ['x'] });

    const res = await fetch(app.url('/files/a.iso/tags/x'), {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
    });
    assert.equal(res.status, 401);
    assert.deepEqual((await app.services.metadata.read('a.iso')).tags, ['x']);
});

test('/ zeigt eine Tag-Filterleiste mit allen vorkommenden Tags, auch bei aktiver Suche', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    await seedIso(app, 'ubuntu.iso', { volumeId: 'UBUNTU' });
    await seedIso(app, 'debian.iso', { platformIds: [], volumeId: '' });
    await app.services.metadata.update('debian.iso', { tags: ['sonder-tag'], autoTags: [] });

    const html = await (await fetch(app.url('/'))).text();
    assert.match(html, /class="tag-filter"/);
    assert.match(html, /BIOS/);
    assert.match(html, /sonder-tag/);

    // Auch wenn eine Suche 'sonder-tag' herausfiltert, bleibt 'BIOS' in der
    // Filterleiste anwaehlbar — sie haengt nicht am aktuellen Suchergebnis.
    const search = await (await fetch(app.url('/search?q=sonder'))).text();
    assert.match(search, /BIOS/, 'Tag-Filterleiste muss unabhaengig von der aktiven Suche alle Tags zeigen');

    // Reset-Link nur bei aktiver Suche, und er fuehrt zurueck zur vollen Liste
    assert.doesNotMatch(html, /search__reset/, 'ohne aktive Suche kein Reset-Link');
    assert.match(search, /class="search__reset" href="\/"/, 'aktive Suche zeigt einen Reset-Link auf \/');
});

test('/admin-upload zeigt dieselbe Tag-Filterleiste und einen Reset-Link auf /admin-search', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();
    await seedIso(app, 'ubuntu.iso', { volumeId: 'UBUNTU' });

    const search = await (await fetch(app.url('/admin-search?q=ubuntu'), { headers: { Cookie: cookie } })).text();
    assert.match(search, /class="tag-filter"/);
    assert.match(search, /BIOS/);
    assert.match(search, /class="search__reset" href="\/admin-upload"/);
});

/* ================================================================ Metrics */

test('/metrics liefert Prometheus-Textformat mit Datei- und Aktivitaets-Zaehlern', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const content = await seedIso(app, 'metrics.iso');
    await fetch(app.url('/download/metrics.iso'));

    await fetch(app.url('/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: 'admin', password: 'falsch' }),
    });

    const res = await fetch(app.url('/metrics'));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/plain/);

    const body = await res.text();
    assert.match(body, /# TYPE iso_share_files_total gauge/);
    assert.match(body, /^iso_share_files_total 1$/m);
    assert.match(body, new RegExp(`^iso_share_storage_bytes ${content.length}$`, 'm'));
    assert.match(body, /^iso_share_downloads_total 1$/m);
    assert.match(body, /^iso_share_uploads_total 0$/m, 'metrics.iso wurde direkt in uploads/ gelegt, nicht ueber die Upload-Route');
    assert.match(body, /^iso_share_login_failures_total 1$/m);
});

/* ============================================================== Header */

test('Sicherheits-Header sitzen', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const res = await fetch(app.url('/'));
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'same-origin');
    assert.equal(res.headers.get('x-powered-by'), null);
});

test('unbekannte Route liefert 404 ohne Stacktrace', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const res = await fetch(app.url('/gibt-es-nicht'));
    assert.equal(res.status, 404);
    const body = await res.text();
    assert.equal(body, 'Nicht gefunden');
    assert.doesNotMatch(body, /at .*\.js:\d+/);
});

/* ================================================================ /api/v1 */

async function createApiToken(app, cookie, scopes = ['read', 'write']) {
    const res = await fetch(app.url('/admin/api-tokens'), {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Test-Token', scopes }),
    });
    assert.equal(res.status, 201);
    return res.json();
}

test('GET /api/v1/files ist oeffentlich, paginiert und filtert per q/tag', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    await seedIso(app, 'debian.iso', { platformIds: [], volumeId: '' });
    await app.services.metadata.update('debian.iso', { tags: ['Linux'] });
    await seedIso(app, 'windows.iso', { platformIds: [], volumeId: '' });

    const page = await fetch(app.url('/api/v1/files?perPage=1&page=1'));
    assert.equal(page.status, 200);
    const pageBody = await page.json();
    assert.equal(pageBody.data.length, 1);
    assert.deepEqual(pageBody.meta, { page: 1, perPage: 1, total: 2, totalPages: 2 });

    const byTag = await fetch(app.url('/api/v1/files?tag=linux'));
    const byTagBody = await byTag.json();
    assert.deepEqual(byTagBody.data.map(f => f.name), ['debian.iso']);

    const byQuery = await fetch(app.url('/api/v1/files?q=windows'));
    assert.deepEqual((await byQuery.json()).data.map(f => f.name), ['windows.iso']);
});

test('GET /api/v1/files/:name liefert eine Datei oder 404', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    await seedIso(app, 'found.iso');

    const found = await fetch(app.url('/api/v1/files/found.iso'));
    assert.equal(found.status, 200);
    assert.equal((await found.json()).data.name, 'found.iso');

    const missing = await fetch(app.url('/api/v1/files/missing.iso'));
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, 'not_found');

    const invalid = await fetch(app.url('/api/v1/files/..%2Fevil.iso'));
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).code, 'invalid_name');
});

test('GET /api/v1/tags und /api/v1/checksums sind oeffentlich', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    await seedIso(app, 'a.iso', { platformIds: [], volumeId: '' });
    await app.services.metadata.update('a.iso', { tags: ['Linux'] });

    const tags = await fetch(app.url('/api/v1/tags'));
    assert.deepEqual((await tags.json()).data, ['Linux']);

    const checksums = await fetch(app.url('/api/v1/checksums'));
    const checksumBody = await checksums.json();
    assert.equal(checksumBody.data.length, 1);
    assert.equal(checksumBody.data[0].name, 'a.iso');
    assert.ok(checksumBody.data[0].sha256);
});

test('Schreibende /api/v1-Routen verlangen ein Bearer-Token mit passendem Scope', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    await seedIso(app, 'a.iso');
    const { cookie } = await app.login();
    const readOnly = await createApiToken(app, cookie, ['read']);

    const noToken = await fetch(app.url('/api/v1/files/a.iso'), { method: 'DELETE' });
    assert.equal(noToken.status, 401);
    assert.equal((await noToken.json()).code, 'missing_token');

    const badToken = await fetch(app.url('/api/v1/files/a.iso'), {
        method: 'DELETE',
        headers: { Authorization: 'Bearer iso_nichtvorhanden' },
    });
    assert.equal(badToken.status, 401);
    assert.equal((await badToken.json()).code, 'invalid_token');

    const wrongScope = await fetch(app.url('/api/v1/files/a.iso'), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${readOnly.token}` },
    });
    assert.equal(wrongScope.status, 403);
    assert.equal((await wrongScope.json()).code, 'insufficient_scope');

    // Nur Session-Cookies duerfen /api/v1 niemals autorisieren — ein Cross-
    // Site-Request mit dem Opfer-Cookie im Gepaeck, aber ohne gueltigen
    // Bearer-Header, muss trotz der CSRF-Ausnahme fuer /api/v1 abgelehnt werden.
    const cookieOnly = await fetch(app.url('/api/v1/files/a.iso'), {
        method: 'DELETE',
        headers: { Cookie: cookie },
    });
    assert.equal(cookieOnly.status, 401);
    assert.ok((await fsp.readdir(app.uploadsDir)).includes('a.iso'));
});

test('vollstaendiger Upload-Zyklus ueber /api/v1/uploads mit einem write-Token', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();
    const token = (await createApiToken(app, cookie, ['write'])).token;
    const auth = { Authorization: `Bearer ${token}` };
    const content = makeIso({ volumeId: 'API_TOKEN_TEST' });

    const init = await fetch(app.url('/api/v1/uploads'), {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'api-upload.iso', size: content.length }),
    });
    assert.equal(init.status, 201);
    const session = (await init.json()).data;

    const patch = await fetch(app.url(`/api/v1/uploads/${session.id}`), {
        method: 'PATCH',
        headers: { ...auth, 'Content-Type': 'application/octet-stream', 'Upload-Offset': '0' },
        body: content,
    });
    assert.equal(patch.status, 200);
    assert.equal((await patch.json()).data.complete, true);

    const finish = await fetch(app.url(`/api/v1/uploads/${session.id}/finish`), {
        method: 'POST',
        headers: auth,
    });
    assert.equal(finish.status, 201);
    assert.equal((await finish.json()).data.filename, 'api-upload.iso');
    assert.ok((await fsp.readdir(app.uploadsDir)).includes('api-upload.iso'));

    await app.services.hashQueue.whenIdle();
    const meta = await app.services.metadata.read('api-upload.iso');
    assert.equal(meta.iso.volumeId, 'API_TOKEN_TEST');
});

test('DELETE /api/v1/files/:name, bulk-delete und Tag-Entfernung mit write-Token', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();
    const token = (await createApiToken(app, cookie, ['write'])).token;
    const auth = { Authorization: `Bearer ${token}` };

    await seedIso(app, 'single.iso');
    await seedIso(app, 'bulk-a.iso');
    await seedIso(app, 'bulk-b.iso', { platformIds: [], volumeId: '' });
    await app.services.metadata.update('bulk-b.iso', { tags: ['Custom'] });

    const del = await fetch(app.url('/api/v1/files/single.iso'), { method: 'DELETE', headers: auth });
    assert.equal(del.status, 204);
    assert.ok(!(await fsp.readdir(app.uploadsDir)).includes('single.iso'));

    const bulk = await fetch(app.url('/api/v1/files/bulk-delete'), {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ names: ['bulk-a.iso', '../evil.iso'] }),
    });
    assert.equal(bulk.status, 200);
    assert.deepEqual((await bulk.json()).data.deleted, ['bulk-a.iso']);

    const untag = await fetch(app.url('/api/v1/files/bulk-b.iso/tags/custom'), {
        method: 'DELETE',
        headers: auth,
    });
    assert.equal(untag.status, 200);
    assert.deepEqual((await untag.json()).data.tags, []);
});

test('DELETE /api/v1/files/:name liefert 404 fuer einen gueltig benannten, aber nicht existierenden Namen', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();
    const token = (await createApiToken(app, cookie, ['write'])).token;

    const res = await fetch(app.url('/api/v1/files/existiert-nicht.iso'), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).code, 'not_found');
});

test('GET /api/v1/audit-log verlangt ein Token mit read-Scope', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();
    const token = (await createApiToken(app, cookie, ['read'])).token;

    const noAuth = await fetch(app.url('/api/v1/audit-log'));
    assert.equal(noAuth.status, 401);

    const res = await fetch(app.url('/api/v1/audit-log?perPage=5'), {
        headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.data));
    assert.ok(body.data.some(entry => entry.event === 'api_token_created'));
});

test('/admin/api-tokens: nur mit Sitzung erreichbar, Token wird nach Widerruf ungueltig', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    const noSession = await fetch(app.url('/admin/api-tokens'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ label: 'x', scopes: ['read'] }),
    });
    assert.equal(noSession.status, 401);

    const created = await createApiToken(app, cookie, ['read']);
    assert.match(created.token, /^iso_/);

    const list = await fetch(app.url('/admin/api-tokens'), { headers: { Cookie: cookie } });
    const tokens = await list.json();
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].token, undefined, 'Klartext-Token darf in der Liste nie auftauchen');

    const before = await fetch(app.url('/api/v1/tags'), {
        headers: { Authorization: `Bearer ${created.token}` },
    });
    assert.equal(before.status, 200);

    const revoke = await fetch(app.url(`/admin/api-tokens/${created.id}`), {
        method: 'DELETE',
        headers: { Cookie: cookie },
    });
    assert.equal(revoke.status, 204);

    const after = await fetch(app.url('/api/v1/audit-log'), {
        headers: { Authorization: `Bearer ${created.token}` },
    });
    assert.equal(after.status, 401);
});

test('unbekannte /api/v1-Route liefert JSON-404 statt Plaintext', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const res = await fetch(app.url('/api/v1/gibt-es-nicht'));
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'Nicht gefunden.', code: 'not_found' });
});
