'use strict';

/* Integrationstests gegen eine echte Instanz auf einem freien Port. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const { startTestApp } = require('./helpers/app');
const { makeIso } = require('./helpers/make-iso');

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

    await app.services.metadata.flush();
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

    await app.services.metadata.flush();
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
        sessionDir: path.join(root, 'sessions'),
    });
    t.after(() => restarted.close());

    const res = await fetch(restarted.url('/admin-upload'), {
        headers: { Cookie: cookie },
        redirect: 'manual',
    });
    assert.equal(res.status, 200, 'Cookie muss nach dem Neustart noch gelten');
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
