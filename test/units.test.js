'use strict';

/* Einheitentests der Module unter lib/ — kein Server, kein Netz. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('fs/promises');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable, Writable } = require('stream');
const { promisify } = require('util');

const { safeIsoName, safeUploadId } = require('../lib/safe-name');
const { readIsoInfo } = require('../lib/iso9660');
const { createMetadataStore } = require('../lib/metadata');
const { createHashQueue } = require('../lib/hash-queue');
const { createUploadSessions } = require('../lib/chunked-upload');
const { FileSessionStore } = require('../lib/session-store');
const { createWebauthnStore } = require('../lib/webauthn-store');
const { createPasswordStore } = require('../lib/password-store');
const { createUsernameStore } = require('../lib/username-store');
const { safeCredentialId, safePasskeyLabel, safeUsername } = require('../lib/safe-name');
const {
    generateSecret, base32Encode, base32Decode, totpAt, verifyTotp, buildOtpauthUri,
} = require('../lib/totp');
const { createTotpStore } = require('../lib/totp-store');
const { createAuditLog } = require('../lib/audit-log');
const { writeZip, fitsInClassicZip, crc32Update } = require('../lib/zip-stream');
const { makeIso } = require('./helpers/make-iso');

async function tempDir() {
    return fsp.mkdtemp(path.join(os.tmpdir(), 'iso-share-unit-'));
}

/* ========================================================== safeIsoName */

test('safeIsoName akzeptiert gueltige Namen', () => {
    assert.equal(safeIsoName('ubuntu-24.04.1-desktop-amd64.iso'), 'ubuntu-24.04.1-desktop-amd64.iso');
    assert.equal(safeIsoName('Windows 11 (23H2).iso'), 'Windows 11 (23H2).iso');
    assert.equal(safeIsoName('UPPER.ISO'), 'UPPER.ISO');
});

test('safeIsoName weist Traversal, Nicht-ISO und Sonderfaelle ab', () => {
    for (const input of [
        '../etc/passwd.iso',
        '..\\windows\\system32.iso',
        '/absolut/pfad.iso',
        'unterordner/datei.iso',
        'nur-text.txt',
        'ohne-endung',
        '.iso',
        'datei.iso\0.txt',
        'semikolon;rm-rf.iso',
        '',
        null,
        undefined,
        'a'.repeat(252) + '.iso',   // 256 Zeichen
    ]) {
        assert.equal(safeIsoName(input), null, `haette ${JSON.stringify(input)} ablehnen muessen`);
    }
});

test('safeIsoName laesst die Laengengrenze von 255 zu', () => {
    const name = 'a'.repeat(251) + '.iso';
    assert.equal(name.length, 255);
    assert.equal(safeIsoName(name), name);
});

test('safeUploadId akzeptiert nur UUIDs', () => {
    assert.equal(safeUploadId(crypto.randomUUID()).length, 36);
    for (const input of ['../x', 'abc', '', null, '../../etc/passwd']) {
        assert.equal(safeUploadId(input), null);
    }
});

test('safeCredentialId akzeptiert nur base64url', () => {
    assert.equal(safeCredentialId('abcDEF012_-'), 'abcDEF012_-');
    for (const input of ['../x', 'abc+def', 'abc/def', 'abc=', '', null, 'a'.repeat(513)]) {
        assert.equal(safeCredentialId(input), null, `haette ${JSON.stringify(input)} ablehnen muessen`);
    }
});

test('safePasskeyLabel trimmt und begrenzt', () => {
    assert.equal(safePasskeyLabel('  Windows Hello  '), 'Windows Hello');
    assert.equal(safePasskeyLabel('YubiKey (Büro)'), 'YubiKey (Büro)');
    for (const input of ['', '   ', null, 'a'.repeat(65), '<script>']) {
        assert.equal(safePasskeyLabel(input), null, `haette ${JSON.stringify(input)} ablehnen muessen`);
    }
});

test('safeUsername akzeptiert Identifier ohne Leerzeichen', () => {
    assert.equal(safeUsername('  admin  '), 'admin');
    assert.equal(safeUsername('julian.foitzik'), 'julian.foitzik');
    assert.equal(safeUsername('admin@example.com'), 'admin@example.com');
    for (const input of ['', '   ', null, 'a'.repeat(65), 'mit leerzeichen', '<script>']) {
        assert.equal(safeUsername(input), null, `haette ${JSON.stringify(input)} ablehnen muessen`);
    }
});

/* ============================================================= iso9660 */

test('readIsoInfo liest Volume-Label, Datum und Bootplattformen', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'test.iso');
    await fsp.writeFile(file, makeIso({
        volumeId: 'UBUNTU_24_04',
        publisher: 'CANONICAL',
        createdAt: '2026010112300000',
        platformIds: [0x00, 0xef],
    }));

    const info = await readIsoInfo(file);
    assert.equal(info.volumeId, 'UBUNTU_24_04');
    assert.equal(info.publisher, 'CANONICAL');
    // Das Zeitzonen-Byte ist 0 = UTC, die Zeit also unveraendert
    assert.equal(info.createdAt, '2026-01-01T12:30:00.000Z');
    assert.deepEqual(info.bootable, ['BIOS', 'UEFI']);

    await fsp.rm(dir, { recursive: true, force: true });
});

test('readIsoInfo erkennt ein nicht bootfaehiges Datenimage', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'daten.iso');
    await fsp.writeFile(file, makeIso({ volumeId: 'ARCHIV', platformIds: [] }));

    const info = await readIsoInfo(file);
    assert.equal(info.volumeId, 'ARCHIV');
    assert.deepEqual(info.bootable, []);

    await fsp.rm(dir, { recursive: true, force: true });
});

test('readIsoInfo gibt null zurueck statt zu werfen', async () => {
    const dir = await tempDir();

    // Kein ISO-9660: nur Nullen, also kein 'CD001' bei Sektor 16
    const nonIso = path.join(dir, 'kaputt.iso');
    await fsp.writeFile(nonIso, Buffer.alloc(70000));
    assert.equal(await readIsoInfo(nonIso), null);

    // Vor dem ersten Deskriptor abgeschnitten
    const truncated = path.join(dir, 'kurz.iso');
    await fsp.writeFile(truncated, makeIso().subarray(0, 33000));
    assert.equal(await readIsoInfo(truncated), null);

    // Gar nicht vorhanden
    assert.equal(await readIsoInfo(path.join(dir, 'fehlt.iso')), null);

    await fsp.rm(dir, { recursive: true, force: true });
});

/* ============================================================ metadata */

test('Metadaten werden gemergt, nicht ersetzt', async () => {
    const dir = await tempDir();
    const store = createMetadataStore({ dir });

    await store.update('a.iso', { sha256: 'abc', size: 10, mtime: 1 });
    await store.update('a.iso', { iso: { volumeId: 'X' } });

    const meta = await store.read('a.iso');
    assert.equal(meta.sha256, 'abc');
    assert.deepEqual(meta.iso, { volumeId: 'X' });

    await fsp.rm(dir, { recursive: true, force: true });
});

test('Download-Zaehler ist sofort sichtbar und wird gebuendelt geschrieben', async () => {
    const dir = await tempDir();
    const store = createMetadataStore({ dir, flushDelayMs: 10_000 });

    store.recordDownload('a.iso');
    store.recordDownload('a.iso');
    // Vor dem Flush schon im Ergebnis — sonst sieht die Ansicht veraltete Werte
    assert.equal((await store.read('a.iso')).downloads, 2);

    await store.flush();
    assert.equal((await store.read('a.iso')).downloads, 2);

    store.recordDownload('a.iso');
    await store.flush();
    assert.equal((await store.read('a.iso')).downloads, 3);

    await fsp.rm(dir, { recursive: true, force: true });
});

test('hasCurrentChecksum verwirft eine Checksumme nach Aenderung der Datei', async () => {
    const dir = await tempDir();
    const store = createMetadataStore({ dir });
    await store.update('a.iso', { sha256: 'abc', size: 10, mtime: 5 });
    const meta = await store.read('a.iso');

    assert.equal(store.hasCurrentChecksum(meta, { size: 10, mtimeMs: 5 }), true);
    assert.equal(store.hasCurrentChecksum(meta, { size: 11, mtimeMs: 5 }), false);
    assert.equal(store.hasCurrentChecksum(meta, { size: 10, mtimeMs: 6 }), false);
    assert.equal(store.hasCurrentChecksum(null, { size: 10, mtimeMs: 5 }), false);

    await fsp.rm(dir, { recursive: true, force: true });
});

test('remove loescht das Sidecar', async () => {
    const dir = await tempDir();
    const store = createMetadataStore({ dir });
    await store.update('a.iso', { sha256: 'abc' });
    await store.remove('a.iso');
    assert.equal(await store.read('a.iso'), null);
    await fsp.rm(dir, { recursive: true, force: true });
});

test('kaputtes Sidecar gilt als "keine Metadaten"', async () => {
    const dir = await tempDir();
    const store = createMetadataStore({ dir });
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'a.iso.json'), '{ das ist kein json');
    assert.equal(await store.read('a.iso'), null);
    await fsp.rm(dir, { recursive: true, force: true });
});

/* ========================================================== hash-queue */

test('scanAll hasht auch Dateien, die ausserhalb der App abgelegt wurden', async () => {
    const root = await tempDir();
    const uploadsDir = path.join(root, 'uploads');
    await fsp.mkdir(uploadsDir, { recursive: true });

    const content = makeIso({ volumeId: 'RSYNC_IMAGE' });
    await fsp.writeFile(path.join(uploadsDir, 'fremd.iso'), content);

    const metadata = createMetadataStore({ dir: path.join(uploadsDir, '.meta') });
    const queue = createHashQueue({
        uploadsDir, metadata, log: { error() {} },
    });

    assert.equal(await queue.scanAll(), 1);
    await queue.whenIdle();

    const meta = await metadata.read('fremd.iso');
    const expected = crypto.createHash('sha256').update(content).digest('hex');
    assert.equal(meta.sha256, expected);
    assert.equal(meta.iso.volumeId, 'RSYNC_IMAGE');

    // Zweiter Lauf findet nichts mehr zu tun
    assert.equal(await queue.scanAll(), 0);

    await fsp.rm(root, { recursive: true, force: true });
});

test('nach einer Aenderung wird neu gehasht', async () => {
    const root = await tempDir();
    const uploadsDir = path.join(root, 'uploads');
    await fsp.mkdir(uploadsDir, { recursive: true });
    const file = path.join(uploadsDir, 'x.iso');

    const metadata = createMetadataStore({ dir: path.join(uploadsDir, '.meta') });
    const queue = createHashQueue({ uploadsDir, metadata, log: { error() {} } });

    await fsp.writeFile(file, makeIso({ volumeId: 'ERSTE' }));
    await queue.scanAll();
    await queue.whenIdle();
    const first = (await metadata.read('x.iso')).sha256;

    const second = makeIso({ volumeId: 'ZWEITE', padSectors: 8 });
    await fsp.writeFile(file, second);
    assert.equal(await queue.scanAll(), 1, 'geaenderte Datei muss neu eingereiht werden');
    await queue.whenIdle();

    const meta = await metadata.read('x.iso');
    assert.notEqual(meta.sha256, first);
    assert.equal(meta.sha256, crypto.createHash('sha256').update(second).digest('hex'));
    assert.equal(meta.iso.volumeId, 'ZWEITE');

    await fsp.rm(root, { recursive: true, force: true });
});

/* ======================================================= chunked-upload */

test('Chunk-Upload setzt am Serverstand fort', async () => {
    const root = await tempDir();
    const sessions = createUploadSessions({
        tmpDir: path.join(root, 'tmp'),
        uploadsDir: path.join(root, 'uploads'),
        maxBytes: 1000,
    });

    const payload = crypto.randomBytes(300);
    const created = await sessions.create({ name: 'x.iso', size: 300 });
    assert.equal(created.offset, 0);
    assert.equal(created.resumed, false);

    let state = await sessions.append(created.id, 0, Readable.from([payload.subarray(0, 100)]));
    assert.equal(state.offset, 100);
    assert.equal(state.complete, false);

    // Erneutes create() zur gleichen Datei findet die offene Sitzung
    const again = await sessions.create({ name: 'x.iso', size: 300 });
    assert.equal(again.id, created.id);
    assert.equal(again.offset, 100);
    assert.equal(again.resumed, true);

    state = await sessions.append(created.id, 100, Readable.from([payload.subarray(100)]));
    assert.equal(state.offset, 300);
    assert.equal(state.complete, true);

    const { filename } = await sessions.finish(created.id);
    assert.equal(filename, 'x.iso');
    const written = await fsp.readFile(path.join(root, 'uploads', 'x.iso'));
    assert.ok(written.equals(payload), 'Inhalt muss byteweise stimmen');

    await fsp.rm(root, { recursive: true, force: true });
});

test('falscher Offset wird mit 409 und dem echten Stand abgelehnt', async () => {
    const root = await tempDir();
    const sessions = createUploadSessions({
        tmpDir: path.join(root, 'tmp'),
        uploadsDir: path.join(root, 'uploads'),
        maxBytes: 1000,
    });
    const created = await sessions.create({ name: 'x.iso', size: 300 });
    await sessions.append(created.id, 0, Readable.from([Buffer.alloc(100)]));

    // Ein Loch schreiben zu duerfen waere der eigentliche Schaden
    await assert.rejects(
        () => sessions.append(created.id, 200, Readable.from([Buffer.alloc(50)])),
        err => err.status === 409 && err.extra.offset === 100
    );
    await assert.rejects(
        () => sessions.append(created.id, 0, Readable.from([Buffer.alloc(50)])),
        err => err.status === 409 && err.extra.offset === 100
    );
    // Offset unveraendert, nichts angehaengt
    assert.equal((await sessions.get(created.id)).offset, 100);

    await fsp.rm(root, { recursive: true, force: true });
});

test('mehr Bytes als angekuendigt werden gekappt und abgelehnt', async () => {
    const root = await tempDir();
    const sessions = createUploadSessions({
        tmpDir: path.join(root, 'tmp'),
        uploadsDir: path.join(root, 'uploads'),
        maxBytes: 10_000,
    });
    const created = await sessions.create({ name: 'x.iso', size: 50 });

    await assert.rejects(
        () => sessions.append(created.id, 0, Readable.from([Buffer.alloc(5000)])),
        err => err.status === 413 && err.extra.offset === 50
    );

    await fsp.rm(root, { recursive: true, force: true });
});

test('Upload-Sitzungen pruefen Name, Groesse und Limit', async () => {
    const root = await tempDir();
    const sessions = createUploadSessions({
        tmpDir: path.join(root, 'tmp'),
        uploadsDir: path.join(root, 'uploads'),
        maxBytes: 1000,
    });

    await assert.rejects(() => sessions.create({ name: 'x.txt', size: 10 }),
        err => err.status === 400);
    await assert.rejects(() => sessions.create({ name: '../x.iso', size: 10 }),
        err => err.status === 400);
    await assert.rejects(() => sessions.create({ name: 'x.iso', size: 0 }),
        err => err.status === 400);
    await assert.rejects(() => sessions.create({ name: 'x.iso', size: 5000 }),
        err => err.status === 413);
    await assert.rejects(() => sessions.get('gibtsnicht'),
        err => err.status === 404);

    const created = await sessions.create({ name: 'x.iso', size: 50 });
    await assert.rejects(() => sessions.finish(created.id),
        err => err.status === 409, 'unvollstaendig darf nicht abgeschlossen werden');

    await fsp.rm(root, { recursive: true, force: true });
});

test('cleanupStale raeumt alte Sitzungen und verwaiste .part-Dateien', async () => {
    const root = await tempDir();
    const tmpDir = path.join(root, 'tmp');
    const sessions = createUploadSessions({
        tmpDir,
        uploadsDir: path.join(root, 'uploads'),
        maxBytes: 1000,
        ttlMs: 60_000,
    });

    await sessions.create({ name: 'alt.iso', size: 50 });
    await fsp.writeFile(path.join(tmpDir, 'waise.part'), 'x');

    // Nichts abgelaufen -> nur die Waise fliegt raus
    assert.equal(await sessions.cleanupStale(Date.now()), 1);
    assert.equal((await sessions.listSessions()).length, 1);

    // Jetzt mit einem Zeitpunkt weit in der Zukunft
    assert.equal(await sessions.cleanupStale(Date.now() + 120_000), 1);
    assert.equal((await sessions.listSessions()).length, 0);

    await fsp.rm(root, { recursive: true, force: true });
});

/* ========================================================= session-store */

test('Session-Store haelt Sitzungen ueber Instanzen hinweg', async () => {
    const dir = await tempDir();

    const first = new FileSessionStore({ dir });
    await promisify(first.set).bind(first)('sid-eins', {
        loggedIn: true,
        cookie: { expires: new Date(Date.now() + 60_000), maxAge: 60_000 },
    });
    first.close();

    // Neue Instanz = simulierter Neustart. Genau das ging im MemoryStore
    // verloren.
    const second = new FileSessionStore({ dir });
    const session = await promisify(second.get).bind(second)('sid-eins');
    assert.equal(session.loggedIn, true);
    second.close();

    await fsp.rm(dir, { recursive: true, force: true });
});

test('Session-Store verwirft Abgelaufenes und ungueltige IDs', async () => {
    const dir = await tempDir();
    const store = new FileSessionStore({ dir });
    const get = promisify(store.get).bind(store);
    const set = promisify(store.set).bind(store);

    await set('abgelaufen', { cookie: { expires: new Date(Date.now() - 1000) } });
    assert.equal(await get('abgelaufen'), null);
    // get() entsorgt die Datei gleich mit
    assert.equal(fs.existsSync(path.join(dir, 'abgelaufen.json')), false);

    assert.equal(await get('../../../etc/passwd'), null);
    assert.equal(await get('nicht-vorhanden'), null);

    await fsp.writeFile(path.join(dir, 'muell.json'), 'kein json');
    assert.equal(await get('muell'), null);

    store.close();
    await fsp.rm(dir, { recursive: true, force: true });
});

test('prune entfernt abgelaufene Sitzungsdateien', async () => {
    const dir = await tempDir();
    const store = new FileSessionStore({ dir });
    const set = promisify(store.set).bind(store);

    await set('lebt', { cookie: { expires: new Date(Date.now() + 60_000) } });
    await set('totA', { cookie: { expires: new Date(Date.now() - 1) } });
    await set('totB', { cookie: { expires: new Date(Date.now() - 1) } });

    assert.equal(await store.prune(), 2);
    assert.equal(await promisify(store.length).bind(store)(), 1);

    store.close();
    await fsp.rm(dir, { recursive: true, force: true });
});

/* ========================================================= webauthn-store */

test('getOrCreateUserId ist stabil, auch ueber Instanzen hinweg', async () => {
    const dir = await tempDir();
    const store = createWebauthnStore({ dir });

    const id = await store.getOrCreateUserId();
    assert.equal(await store.getOrCreateUserId(), id);

    const restarted = createWebauthnStore({ dir });
    assert.equal(await restarted.getOrCreateUserId(), id);

    await fsp.rm(dir, { recursive: true, force: true });
});

test('addCredential/findCredential geben alle Felder unveraendert zurueck', async () => {
    const dir = await tempDir();
    const store = createWebauthnStore({ dir });

    await store.addCredential({
        credentialId: 'cred-1',
        publicKey: 'cHVia2V5',
        counter: 0,
        transports: ['internal'],
        label: 'Windows Hello',
    });

    const found = await store.findCredential('cred-1');
    assert.equal(found.credentialId, 'cred-1');
    assert.equal(found.publicKey, 'cHVia2V5');
    assert.equal(found.counter, 0);
    assert.deepEqual(found.transports, ['internal']);
    assert.equal(found.label, 'Windows Hello');
    assert.equal(typeof found.createdAt, 'number');

    await fsp.rm(dir, { recursive: true, force: true });
});

test('addCredential wirft bei doppelter credentialId', async () => {
    const dir = await tempDir();
    const store = createWebauthnStore({ dir });
    await store.addCredential({ credentialId: 'x', publicKey: 'k', counter: 0, label: 'A' });
    await assert.rejects(() =>
        store.addCredential({ credentialId: 'x', publicKey: 'k', counter: 0, label: 'B' })
    );
    await fsp.rm(dir, { recursive: true, force: true });
});

test('listCredentials enthaelt nie den publicKey', async () => {
    const dir = await tempDir();
    const store = createWebauthnStore({ dir });
    await store.addCredential({ credentialId: 'x', publicKey: 'geheim', counter: 0, label: 'A' });

    const list = await store.listCredentials();
    assert.equal(list.length, 1);
    assert.equal(list[0].credentialId, 'x');
    assert.equal('publicKey' in list[0], false);

    await fsp.rm(dir, { recursive: true, force: true });
});

test('updateCounter persistiert, removeCredential entfernt', async () => {
    const dir = await tempDir();
    const store = createWebauthnStore({ dir });
    await store.addCredential({ credentialId: 'x', publicKey: 'k', counter: 0, label: 'A' });

    await store.updateCounter('x', 5);
    assert.equal((await store.findCredential('x')).counter, 5);

    assert.equal(await store.removeCredential('nicht-vorhanden'), false);
    assert.equal(await store.removeCredential('x'), true);
    assert.equal(await store.findCredential('x'), null);
    assert.deepEqual(await store.listCredentials(), []);

    await fsp.rm(dir, { recursive: true, force: true });
});

test('kaputte/fehlende webauthn.json gilt als "keine Passkeys"', async () => {
    const dir = await tempDir();
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'webauthn.json'), '{ kein json');

    const store = createWebauthnStore({ dir });
    assert.deepEqual(await store.listCredentials(), []);
    assert.equal(typeof (await store.getOrCreateUserId()), 'string');

    await fsp.rm(dir, { recursive: true, force: true });
});

test('parallele addCredential-Aufrufe landen beide', async () => {
    const dir = await tempDir();
    const store = createWebauthnStore({ dir });

    await Promise.all([
        store.addCredential({ credentialId: 'a', publicKey: 'k', counter: 0, label: 'A' }),
        store.addCredential({ credentialId: 'b', publicKey: 'k', counter: 0, label: 'B' }),
    ]);

    const list = await store.listCredentials();
    assert.deepEqual(list.map(c => c.credentialId).sort(), ['a', 'b']);

    await fsp.rm(dir, { recursive: true, force: true });
});

/* ========================================================== password-store */

test('setPassword/verify: richtiges Passwort true, falsches false', async () => {
    const dir = await tempDir();
    const store = createPasswordStore({ file: path.join(dir, 'admin-password.json') });

    const record = await store.setPassword('korrekt-horse-battery');
    assert.equal(await store.verify('korrekt-horse-battery', record), true);
    assert.equal(await store.verify('falsch', record), false);

    await fsp.rm(dir, { recursive: true, force: true });
});

test('read() liefert null bei fehlender/kaputter Datei', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'admin-password.json');
    const store = createPasswordStore({ file });

    assert.equal(await store.read(), null);

    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(file, '{ kein json');
    assert.equal(await store.read(), null);

    await fsp.rm(dir, { recursive: true, force: true });
});

test('Passwort-Hash ueberlebt eine neue Store-Instanz (simulierter Neustart)', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'admin-password.json');

    const first = createPasswordStore({ file });
    await first.setPassword('neues-passwort');

    const second = createPasswordStore({ file });
    const record = await second.read();
    assert.notEqual(record, null);
    assert.equal(await second.verify('neues-passwort', record), true);

    await fsp.rm(dir, { recursive: true, force: true });
});

/* ========================================================== username-store */

test('write/read: Roundtrip liefert genau den gespeicherten Benutzernamen', async () => {
    const dir = await tempDir();
    const store = createUsernameStore({ file: path.join(dir, 'admin-username.json') });

    assert.equal(await store.read(), null);
    await store.write('julian');
    assert.equal(await store.read(), 'julian');

    await fsp.rm(dir, { recursive: true, force: true });
});

test('username-store: read() liefert null bei kaputter Datei', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'admin-username.json');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(file, '{ kein json');

    const store = createUsernameStore({ file });
    assert.equal(await store.read(), null);

    await fsp.rm(dir, { recursive: true, force: true });
});

test('Benutzername ueberlebt eine neue Store-Instanz (simulierter Neustart)', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'admin-username.json');

    const first = createUsernameStore({ file });
    await first.write('neuer-name');

    const second = createUsernameStore({ file });
    assert.equal(await second.read(), 'neuer-name');

    await fsp.rm(dir, { recursive: true, force: true });
});

/* ================================================================== totp */

test('base32Encode/base32Decode: Roundtrip fuer beliebige Bytelaengen', () => {
    for (const length of [1, 5, 10, 16, 20, 33]) {
        const original = crypto.randomBytes(length);
        const encoded = base32Encode(original);
        assert.match(encoded, /^[A-Z2-7]+$/);
        assert.ok(base32Decode(encoded).equals(original));
    }
});

test('totpAt liefert einen 6-stelligen Code, stabil innerhalb eines 30s-Schritts', () => {
    const secret = generateSecret();
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const code = totpAt(secret, now);
    assert.match(code, /^\d{6}$/);
    // Innerhalb desselben 30s-Fensters identisch
    assert.equal(totpAt(secret, now + 5000), code);
    // Verschiedene Sekunden ergeben typischerweise verschiedene Codes ueber
    // ein ganzes 30s-Fenster hinweg betrachtet
    assert.notEqual(totpAt(secret, now + 30000), code);
});

test('verifyTotp akzeptiert den aktuellen Code und toleriert +/- 1 Schritt', () => {
    const secret = generateSecret();
    const now = Date.now();
    const code = totpAt(secret, now);

    assert.equal(verifyTotp(secret, code, { time: now }), true);
    assert.equal(verifyTotp(secret, code, { time: now + 30000 }), true, 'ein Schritt spaeter noch gueltig');
    assert.equal(verifyTotp(secret, code, { time: now - 30000 }), true, 'ein Schritt frueher noch gueltig');
    assert.equal(verifyTotp(secret, code, { time: now + 90000 }), false, 'drei Schritte weiter nicht mehr gueltig');
});

test('verifyTotp weist falsche und falsch formatierte Codes ab', () => {
    const secret = generateSecret();
    assert.equal(verifyTotp(secret, '000000'), false);
    assert.equal(verifyTotp(secret, 'abcdef'), false);
    assert.equal(verifyTotp(secret, ''), false);
    assert.equal(verifyTotp(secret, null), false);
});

test('buildOtpauthUri enthaelt Secret, Label und Issuer', () => {
    const uri = buildOtpauthUri({ secret: 'ABCDEFGH', label: 'admin', issuer: 'ISO Share' });
    assert.match(uri, /^otpauth:\/\/totp\//);
    assert.match(uri, /secret=ABCDEFGH/);
    assert.match(uri, /issuer=ISO\+Share/);
});

/* ============================================================ totp-store */

test('totp-store: isEnabled/getSecret vor dem Aktivieren', async () => {
    const dir = await tempDir();
    const store = createTotpStore({ dir });

    assert.equal(await store.isEnabled(), false);
    assert.equal(await store.getSecret(), null);

    await fsp.rm(dir, { recursive: true, force: true });
});

test('totp-store: enable() persistiert und liefert 8 einmalige Recovery-Codes', async () => {
    const dir = await tempDir();
    const store = createTotpStore({ dir });

    const codes = await store.enable('JBSWY3DPEHPK3PXP');
    assert.equal(codes.length, 8);
    assert.ok(codes.every(code => /^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/.test(code)));
    assert.equal(new Set(codes).size, 8, 'Codes muessen sich unterscheiden');

    assert.equal(await store.isEnabled(), true);
    assert.equal(await store.getSecret(), 'JBSWY3DPEHPK3PXP');

    await fsp.rm(dir, { recursive: true, force: true });
});

test('totp-store: consumeRecoveryCode verbraucht einen Code genau einmal', async () => {
    const dir = await tempDir();
    const store = createTotpStore({ dir });
    const [firstCode] = await store.enable('JBSWY3DPEHPK3PXP');

    assert.equal(await store.consumeRecoveryCode('nicht-vorhanden'), false);
    assert.equal(await store.consumeRecoveryCode(firstCode), true);
    assert.equal(await store.consumeRecoveryCode(firstCode), false, 'derselbe Code darf kein zweites Mal gelten');

    await fsp.rm(dir, { recursive: true, force: true });
});

test('totp-store: disable() entfernt den Datensatz vollstaendig', async () => {
    const dir = await tempDir();
    const store = createTotpStore({ dir });
    await store.enable('JBSWY3DPEHPK3PXP');
    await store.disable();

    assert.equal(await store.isEnabled(), false);

    await fsp.rm(dir, { recursive: true, force: true });
});

/* ============================================================= audit-log */

test('audit-log: log()/read() liefern die juengsten Eintraege zuerst', async () => {
    const dir = await tempDir();
    const auditLog = createAuditLog({ file: path.join(dir, 'audit.log') });

    await auditLog.log('login_success', { ip: '127.0.0.1' });
    await auditLog.log('upload', { filename: 'a.iso' });

    const entries = await auditLog.read();
    assert.equal(entries.length, 2);
    assert.equal(entries[0].event, 'upload');
    assert.equal(entries[1].event, 'login_success');
    assert.equal(entries[0].filename, 'a.iso');
    assert.equal(typeof entries[0].ts, 'number');

    await fsp.rm(dir, { recursive: true, force: true });
});

test('audit-log: read() ohne vorhandene Datei liefert eine leere Liste', async () => {
    const dir = await tempDir();
    const auditLog = createAuditLog({ file: path.join(dir, 'fehlt', 'audit.log') });
    assert.deepEqual(await auditLog.read(), []);
    await fsp.rm(dir, { recursive: true, force: true });
});

test('audit-log: eine kaputte Zeile wird uebersprungen statt die Liste zu verwerfen', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'audit.log');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(file, '{"ts":1,"event":"ok"}\nkein json\n{"ts":2,"event":"auch-ok"}\n');

    const auditLog = createAuditLog({ file });
    const entries = await auditLog.read();
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map(e => e.event), ['auch-ok', 'ok']);

    await fsp.rm(dir, { recursive: true, force: true });
});

test('audit-log: kuerzt die Datei, sobald sie das Groessenlimit ueberschreitet', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'audit.log');
    const auditLog = createAuditLog({ file });
    // Direkt eine grosse Datei simulieren statt zehntausender einzelner
    // log()-Aufrufe — realistische Zeilengroesse, damit 3000 behaltene
    // Zeilen tatsaechlich unter dem Limit landen.
    await fsp.mkdir(dir, { recursive: true });
    const lines = [];
    for (let i = 0; i < 80000; i++) {
        lines.push(JSON.stringify({ ts: i, event: 'filler', ip: '127.0.0.1' }));
    }
    await fsp.writeFile(file, `${lines.join('\n')}\n`);
    assert.ok((await fsp.stat(file)).size > 2 * 1024 * 1024, 'Testaufbau muss ueber dem Limit starten');

    await auditLog.log('neuestes_ereignis', {});

    const stats = await fsp.stat(file);
    assert.ok(stats.size < 2 * 1024 * 1024, 'Datei muss nach dem Schreiben gekuerzt worden sein');
    const entries = await auditLog.read({ limit: 1 });
    assert.equal(entries[0].event, 'neuestes_ereignis', 'juengster Eintrag darf beim Kuerzen nie verloren gehen');

    await fsp.rm(dir, { recursive: true, force: true });
});

/* ============================================================= zip-stream */

test('crc32Update stimmt mit dem bekannten Testvektor ueberein', () => {
    // Standard-Testvektor: CRC-32 von "The quick brown fox jumps over the lazy dog"
    const crc = crc32Update(0, Buffer.from('The quick brown fox jumps over the lazy dog', 'ascii'));
    assert.equal(crc.toString(16), '414fa339');
});

test('fitsInClassicZip weist Groessen ueber 4 GiB ab', () => {
    assert.equal(fitsInClassicZip(1024), true);
    assert.equal(fitsInClassicZip(0xFFFFFFFF), true);
    assert.equal(fitsInClassicZip(0xFFFFFFFF + 1), false);
});

/* Minimaler ZIP-Parser fuer den Test: liest die Central-Directory-Eintraege
   und extrahiert jede Datei anhand ihres Local-Header-Offsets — unabhaengig
   von writeZip() selbst geschrieben, damit der Test einen echten
   Rundtrip-Fehler auch findet. */
function parseZip(buffer) {
    const eocdSignature = 0x06054b50;
    let eocdOffset = -1;
    for (let i = buffer.length - 22; i >= 0; i--) {
        if (buffer.readUInt32LE(i) === eocdSignature) {
            eocdOffset = i;
            break;
        }
    }
    assert.notEqual(eocdOffset, -1, 'End-of-Central-Directory-Signatur fehlt');

    const entryCount = buffer.readUInt16LE(eocdOffset + 10);
    const centralStart = buffer.readUInt32LE(eocdOffset + 16);

    const entries = [];
    let cursor = centralStart;
    for (let i = 0; i < entryCount; i++) {
        assert.equal(buffer.readUInt32LE(cursor), 0x02014b50, 'Central-Directory-Signatur fehlt');
        const crc = buffer.readUInt32LE(cursor + 16);
        const compressedSize = buffer.readUInt32LE(cursor + 20);
        const uncompressedSize = buffer.readUInt32LE(cursor + 24);
        const nameLength = buffer.readUInt16LE(cursor + 28);
        const extraLength = buffer.readUInt16LE(cursor + 30);
        const commentLength = buffer.readUInt16LE(cursor + 32);
        const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
        const name = buffer.toString('ascii', cursor + 46, cursor + 46 + nameLength);

        // Lokalen Header lesen: Dateiname-Laenge steht dort noch einmal
        assert.equal(buffer.readUInt32LE(localHeaderOffset), 0x04034b50, 'Local-File-Header-Signatur fehlt');
        const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
        const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
        const content = buffer.subarray(dataStart, dataStart + uncompressedSize);

        entries.push({ name, crc, compressedSize, uncompressedSize, content });
        cursor += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
}

async function collectZip(files) {
    const chunks = [];
    const sink = new Writable({
        write(chunk, encoding, callback) {
            chunks.push(Buffer.from(chunk));
            callback();
        },
    });
    await writeZip(sink, files);
    return Buffer.concat(chunks);
}

test('writeZip erzeugt ein Archiv, dessen Central Directory jede Datei bytegenau wiederfindet', async () => {
    const dir = await tempDir();
    const contentA = crypto.randomBytes(5000);
    const contentB = Buffer.from('kleine Textdatei\n'.repeat(20), 'utf8');
    await fsp.writeFile(path.join(dir, 'a.iso'), contentA);
    await fsp.writeFile(path.join(dir, 'b.iso'), contentB);

    const files = [
        { name: 'a.iso', path: path.join(dir, 'a.iso'), size: contentA.length, mtime: new Date() },
        { name: 'b.iso', path: path.join(dir, 'b.iso'), size: contentB.length, mtime: new Date() },
    ];

    const zip = await collectZip(files);
    const entries = parseZip(zip);

    assert.equal(entries.length, 2);
    assert.equal(entries[0].name, 'a.iso');
    assert.ok(entries[0].content.equals(contentA), 'Inhalt von a.iso muss bytegenau erhalten bleiben');
    assert.equal(entries[0].crc, crc32Update(0, contentA));
    assert.equal(entries[1].name, 'b.iso');
    assert.ok(entries[1].content.equals(contentB), 'Inhalt von b.iso muss bytegenau erhalten bleiben');
    assert.equal(entries[1].crc, crc32Update(0, contentB));

    await fsp.rm(dir, { recursive: true, force: true });
});

test('writeZip: leere Datei ergibt einen validen 0-Byte-Eintrag', async () => {
    const dir = await tempDir();
    await fsp.writeFile(path.join(dir, 'leer.iso'), Buffer.alloc(0));

    const zip = await collectZip([
        { name: 'leer.iso', path: path.join(dir, 'leer.iso'), size: 0, mtime: new Date() },
    ]);
    const entries = parseZip(zip);

    assert.equal(entries.length, 1);
    assert.equal(entries[0].uncompressedSize, 0);
    assert.equal(entries[0].content.length, 0);

    await fsp.rm(dir, { recursive: true, force: true });
});
