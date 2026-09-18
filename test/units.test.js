'use strict';

/* Einheitentests der Module unter lib/ — kein Server, kein Netz. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable, Writable } = require('stream');
const { promisify } = require('util');

const { safeIsoName, safeUploadId } = require('../lib/safe-name');
const { readIsoInfo } = require('../lib/iso9660');
const { openDatabase } = require('../lib/db');
const { createMetadataStore } = require('../lib/metadata');
const { createHashQueue } = require('../lib/hash-queue');
const { deriveAutoTags, applyAutoTags } = require('../lib/auto-tags');
const { createUploadSessions } = require('../lib/chunked-upload');
const { SqliteSessionStore } = require('../lib/session-store');
const { createWebauthnStore } = require('../lib/webauthn-store');
const { createApiTokenStore } = require('../lib/api-token-store');
const { createSessionSecretStore } = require('../lib/session-secret-store');
const { createPasswordStore } = require('../lib/password-store');
const { createUsernameStore } = require('../lib/username-store');
const { safeCredentialId, safePasskeyLabel, safeUsername, safeTag } = require('../lib/safe-name');
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

/* Eine In-Memory-DB je Test — schnell, kein Aufraeumen noetig. Fuer Tests,
   die einen Neustart simulieren (dieselbe Datenbank, neue Store-Instanz),
   braucht es stattdessen eine echte Datei, siehe restartDb() unten. */
function memoryDb() {
    return openDatabase(':memory:');
}

async function restartDb() {
    const dir = await tempDir();
    const file = path.join(dir, 'test.db');
    return { file, open: () => openDatabase(file), cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
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

test('safeTag trimmt, faltet Leerzeichen und begrenzt', () => {
    assert.equal(safeTag('  linux   distro  '), 'linux distro');
    assert.equal(safeTag("Server's (v2)"), "Server's (v2)");
    for (const input of ['', '   ', null, undefined, 'a'.repeat(33), '<script>', 'a/b']) {
        assert.equal(safeTag(input), null, `haette ${JSON.stringify(input)} ablehnen muessen`);
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

test('readIsoInfo verwirft ein Erstelldatum mit unplausiblem Jahr oder Nicht-Ziffern', async () => {
    const dir = await tempDir();

    const zuFrueh = path.join(dir, 'zu-frueh.iso');
    await fsp.writeFile(zuFrueh, makeIso({ createdAt: '1969123123595900', platformIds: [] }));
    assert.equal((await readIsoInfo(zuFrueh)).createdAt, null);

    const zuSpaet = path.join(dir, 'zu-spaet.iso');
    await fsp.writeFile(zuSpaet, makeIso({ createdAt: '2201010100000000', platformIds: [] }));
    assert.equal((await readIsoInfo(zuSpaet)).createdAt, null);

    const keineZiffern = path.join(dir, 'keine-ziffern.iso');
    await fsp.writeFile(keineZiffern, makeIso({ createdAt: 'nicht-numerisch!!', platformIds: [] }));
    assert.equal((await readIsoInfo(keineZiffern)).createdAt, null);

    await fsp.rm(dir, { recursive: true, force: true });
});

test('readIsoInfo rechnet den Zeitzonen-Offset korrekt auf UTC um', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'tz.iso');
    // +2:00 Uhr Lokalzeit (8 Viertelstunden) -> 2 Stunden von der Lokalzeit abziehen
    await fsp.writeFile(file, makeIso({
        createdAt: '2026060112000000', tzOffsetQuarters: 8, platformIds: [],
    }));

    const info = await readIsoInfo(file);
    assert.equal(info.createdAt, '2026-06-01T10:00:00.000Z');

    await fsp.rm(dir, { recursive: true, force: true });
});

test('readIsoInfo laesst eine unbekannte Boot-Plattform-ID weg', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'unbekannt.iso');
    // 0x03 ist in keiner realen Spezifikation vergeben und taucht nicht in PLATFORMS auf
    await fsp.writeFile(file, makeIso({ platformIds: [0x03] }));

    const info = await readIsoInfo(file);
    assert.deepEqual(info.bootable, [], 'eine nicht gemappte Plattform-ID darf nicht als leerer/undefined-Eintrag durchrutschen');

    await fsp.rm(dir, { recursive: true, force: true });
});

test('readIsoInfo ignoriert einen Boot-Katalog-Sektor von 0', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'sektor-null.iso');
    await fsp.writeFile(file, makeIso({ platformIds: [0x00], catalogSectorOverride: 0 }));

    const info = await readIsoInfo(file);
    assert.deepEqual(info.bootable, []);

    await fsp.rm(dir, { recursive: true, force: true });
});

test('readIsoInfo ignoriert einen Boot Record, der nicht El Torito ist', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'anderer-boot-record.iso');
    await fsp.writeFile(file, makeIso({ platformIds: [0x00], bootSystemId: 'IRGENDWAS ANDERES' }));

    const info = await readIsoInfo(file);
    assert.deepEqual(info.bootable, []);

    await fsp.rm(dir, { recursive: true, force: true });
});

test('readIsoInfo berechnet volumeSize, gibt aber null bei blockSize 0', async () => {
    const dir = await tempDir();

    const normal = path.join(dir, 'normal.iso');
    await fsp.writeFile(normal, makeIso({ platformIds: [], padSectors: 2 }));
    const infoNormal = await readIsoInfo(normal);
    assert.equal(infoNormal.volumeSize, (16 + 3 + 2) * 2048);

    const nullBlockSize = path.join(dir, 'null-blocksize.iso');
    await fsp.writeFile(nullBlockSize, makeIso({ platformIds: [], blockSize: 0 }));
    assert.equal((await readIsoInfo(nullBlockSize)).volumeSize, null);

    await fsp.rm(dir, { recursive: true, force: true });
});

test('readIsoInfo verwendet nur den ersten Primary Volume Descriptor', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'doppelt.iso');
    await fsp.writeFile(file, makeIso({ volumeId: 'ERSTER', platformIds: [], extraPvd: 'ZWEITER' }));

    const info = await readIsoInfo(file);
    assert.equal(info.volumeId, 'ERSTER');

    await fsp.rm(dir, { recursive: true, force: true });
});

/* ============================================================ metadata */

test('Metadaten werden gemergt, nicht ersetzt', async () => {
    const store = createMetadataStore({ db: memoryDb() });

    await store.update('a.iso', { sha256: 'abc', size: 10, mtime: 1 });
    await store.update('a.iso', { iso: { volumeId: 'X' } });

    const meta = await store.read('a.iso');
    assert.equal(meta.sha256, 'abc');
    assert.deepEqual(meta.iso, { volumeId: 'X' });
});

test('Download-Zaehler ist sofort sichtbar (atomares UPDATE, kein Puffer mehr noetig)', async () => {
    const store = createMetadataStore({ db: memoryDb() });

    store.recordDownload('a.iso');
    store.recordDownload('a.iso');
    assert.equal((await store.read('a.iso')).downloads, 2);

    store.recordDownload('a.iso');
    assert.equal((await store.read('a.iso')).downloads, 3);
});

test('hasCurrentChecksum verwirft eine Checksumme nach Aenderung der Datei', async () => {
    const store = createMetadataStore({ db: memoryDb() });
    await store.update('a.iso', { sha256: 'abc', size: 10, mtime: 5 });
    const meta = await store.read('a.iso');

    assert.equal(store.hasCurrentChecksum(meta, { size: 10, mtimeMs: 5 }), true);
    assert.equal(store.hasCurrentChecksum(meta, { size: 11, mtimeMs: 5 }), false);
    assert.equal(store.hasCurrentChecksum(meta, { size: 10, mtimeMs: 6 }), false);
    assert.equal(store.hasCurrentChecksum(null, { size: 10, mtimeMs: 5 }), false);
});

test('remove loescht den Datensatz', async () => {
    const store = createMetadataStore({ db: memoryDb() });
    await store.update('a.iso', { sha256: 'abc' });
    await store.remove('a.iso');
    assert.equal(await store.read('a.iso'), null);
});

test('unbekannter Name gilt als "keine Metadaten"', async () => {
    const store = createMetadataStore({ db: memoryDb() });
    assert.equal(await store.read('nie-gesehen.iso'), null);
});

test('findByChecksum findet alle Dateien mit derselben Pruefsumme (Dedup-Grundlage)', async () => {
    const store = createMetadataStore({ db: memoryDb() });
    await store.update('a.iso', { sha256: 'gleich' });
    await store.update('b.iso', { sha256: 'gleich' });
    await store.update('c.iso', { sha256: 'anders' });

    assert.deepEqual((await store.findByChecksum('gleich')).sort(), ['a.iso', 'b.iso']);
    assert.deepEqual(await store.findByChecksum('unbekannt'), []);
});

/* ========================================================== hash-queue */

test('scanAll hasht auch Dateien, die ausserhalb der App abgelegt wurden', async () => {
    const root = await tempDir();
    const uploadsDir = path.join(root, 'uploads');
    await fsp.mkdir(uploadsDir, { recursive: true });

    const content = makeIso({ volumeId: 'RSYNC_IMAGE' });
    await fsp.writeFile(path.join(uploadsDir, 'fremd.iso'), content);

    const metadata = createMetadataStore({ db: memoryDb() });
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

    const metadata = createMetadataStore({ db: memoryDb() });
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

/* =========================================================== auto-tags */

test('deriveAutoTags liest Boot-Plattformen und Volume-Label', () => {
    assert.deepEqual(
        deriveAutoTags({ bootable: ['BIOS', 'UEFI'], volumeId: 'UBUNTU_24_04' }),
        ['BIOS', 'UEFI', 'UBUNTU_24_04']
    );
    assert.deepEqual(deriveAutoTags({ bootable: [], volumeId: null }), []);
    assert.deepEqual(deriveAutoTags(null), []);
});

test('deriveAutoTags verwirft eine volumeId, die safeTag nicht akzeptiert', () => {
    // Enthaelt "/", das safeTag() nicht erlaubt -> kein drittes Tag, BIOS/UEFI bleiben
    assert.deepEqual(
        deriveAutoTags({ bootable: ['BIOS', 'UEFI'], volumeId: 'ARCHIV/2024' }),
        ['BIOS', 'UEFI']
    );
});

test('deriveAutoTags dedupliziert case-insensitiv, wenn die volumeId einer Bootplattform entspricht', () => {
    assert.deepEqual(
        deriveAutoTags({ bootable: ['BIOS'], volumeId: 'bios' }),
        ['BIOS'],
        'der zuerst hinzugefuegte Kandidat (BIOS aus bootable) gewinnt in der urspruenglichen Schreibweise'
    );
});

test('applyAutoTags dupliziert nichts bei einem erneuten Rescan', () => {
    const first = applyAutoTags(null, ['BIOS', 'UEFI', 'ARCHIV'], 15);
    assert.deepEqual(first.tags, ['BIOS', 'UEFI', 'ARCHIV']);
    assert.deepEqual(first.autoTags, ['BIOS', 'UEFI', 'ARCHIV']);

    // gleicher Kandidaten-Satz wie beim letzten Lauf -> keine Duplikate
    const rescanned = applyAutoTags(
        { tags: first.tags, autoTags: first.autoTags },
        ['BIOS', 'UEFI', 'ARCHIV'],
        15
    );
    assert.deepEqual(rescanned.tags, ['BIOS', 'UEFI', 'ARCHIV']);
});

test('applyAutoTags laesst manuelle Tags unangetastet', () => {
    const meta = { tags: ['BIOS', 'meine-notiz'], autoTags: ['BIOS'] };
    const result = applyAutoTags(meta, ['BIOS', 'UEFI'], 15);
    assert.deepEqual(result.tags, ['meine-notiz', 'BIOS', 'UEFI']);
    assert.deepEqual(result.autoTags, ['BIOS', 'UEFI']);
});

test('applyAutoTags laesst einen entfernten Auto-Tag beim Rescan weg', () => {
    // Admin hat 'UEFI' geloescht, server.js traegt es in removedAutoTags ein
    const meta = { tags: ['BIOS'], autoTags: ['BIOS'], removedAutoTags: ['UEFI'] };
    const result = applyAutoTags(meta, ['BIOS', 'UEFI'], 15);
    assert.deepEqual(result.tags, ['BIOS']);
    assert.deepEqual(result.autoTags, ['BIOS']);
});

test('applyAutoTags verwirft einen veralteten Auto-Tag, wenn sich die volumeId aendert', () => {
    const meta = { tags: ['BIOS', 'ALT'], autoTags: ['BIOS', 'ALT'] };
    const result = applyAutoTags(meta, ['BIOS', 'NEU'], 15);
    assert.deepEqual(result.tags, ['BIOS', 'NEU']);
});

test('applyAutoTags haelt die Gesamtzahl im Limit', () => {
    const meta = { tags: ['a', 'b'], autoTags: [] };
    const result = applyAutoTags(meta, ['BIOS', 'UEFI', 'VOL'], 3);
    assert.deepEqual(result.tags, ['a', 'b', 'BIOS']);
    assert.deepEqual(result.autoTags, ['BIOS']);
});

test('applyAutoTags fuegt keine Auto-Tags mehr hinzu, wenn schon allein die manuellen Tags das Limit erreichen', () => {
    const meta = { tags: ['a', 'b', 'c'], autoTags: [] };
    const result = applyAutoTags(meta, ['BIOS', 'UEFI'], 3);
    assert.deepEqual(result.tags, ['a', 'b', 'c'], 'manuelle Tags duerfen durchs Limit nie gekappt werden');
    assert.deepEqual(result.autoTags, []);
});

test('applyAutoTags dupliziert einen manuellen Tag nicht, der zufaellig mit einem neuen Kandidaten uebereinstimmt', () => {
    // 'BIOS' wurde nie automatisch vergeben (autoTags: []) -> gilt als manuell
    const meta = { tags: ['BIOS'], autoTags: [] };
    const result = applyAutoTags(meta, ['BIOS', 'UEFI'], 15);
    assert.deepEqual(result.tags, ['BIOS', 'UEFI']);
    assert.deepEqual(result.autoTags, ['UEFI'], 'BIOS bleibt manuell und wird nicht zusaetzlich als Auto-Tag gefuehrt');
});

test('applyAutoTags erkennt einen entfernten Auto-Tag case-insensitiv wieder', () => {
    const meta = { tags: [], autoTags: [], removedAutoTags: ['uefi'] };
    const result = applyAutoTags(meta, ['BIOS', 'UEFI'], 15);
    assert.deepEqual(result.tags, ['BIOS'], 'GROSS/klein darf removedAutoTags nicht umgehen');
});

test('hash-queue vergibt Auto-Tags und haengt sie bei einem Rescan nicht doppelt an', async () => {
    const root = await tempDir();
    const uploadsDir = path.join(root, 'uploads');
    await fsp.mkdir(uploadsDir, { recursive: true });
    const file = path.join(uploadsDir, 'x.iso');

    const metadata = createMetadataStore({ db: memoryDb() });
    const queue = createHashQueue({ uploadsDir, metadata, log: { error() {} } });

    await fsp.writeFile(file, makeIso({ volumeId: 'ARCHIV' }));
    await queue.scanAll();
    await queue.whenIdle();

    let meta = await metadata.read('x.iso');
    assert.deepEqual(meta.tags, ['BIOS', 'UEFI', 'ARCHIV']);
    assert.deepEqual(meta.autoTags, ['BIOS', 'UEFI', 'ARCHIV']);

    // Admin entfernt 'UEFI' von Hand (simuliert, was server.js beim DELETE tut)
    await metadata.update('x.iso', {
        tags: meta.tags.filter(t => t !== 'UEFI'),
        autoTags: meta.autoTags.filter(t => t !== 'UEFI'),
        removedAutoTags: ['UEFI'],
    });

    // Erneuter Scan derselben unveraenderten Datei -> nichts zu tun, kein Wiederanhaengen
    assert.equal(await queue.scanAll(), 0);
    await queue.whenIdle();
    meta = await metadata.read('x.iso');
    assert.deepEqual(meta.tags, ['BIOS', 'ARCHIV']);

    await fsp.rm(root, { recursive: true, force: true });
});

test('hash-queue traegt Auto-Tags bei laengst gehashten Bestandsdateien nach, ohne neu zu hashen', async () => {
    const root = await tempDir();
    const uploadsDir = path.join(root, 'uploads');
    await fsp.mkdir(uploadsDir, { recursive: true });
    const file = path.join(uploadsDir, 'x.iso');
    await fsp.writeFile(file, makeIso({ volumeId: 'ARCHIV' }));

    const metadata = createMetadataStore({ db: memoryDb() });
    const stats = await fsp.stat(file);
    const iso = await readIsoInfo(file);
    // Datensatz wie vor dem Auto-Tag-Feature: Checksumme/ISO-Info schon
    // vorhanden und aktuell, aber kein autoTags-Feld.
    await metadata.update('x.iso', {
        size: stats.size,
        mtime: stats.mtimeMs,
        sha256: 'deadbeef',
        iso,
        tags: [],
    });

    const queue = createHashQueue({ uploadsDir, metadata, log: { error() {} } });
    const missing = await queue.scanAll();
    assert.equal(missing, 0, 'Checksumme ist aktuell, darf nicht als fehlend gezaehlt/neu gehasht werden');
    await queue.whenIdle();

    const meta = await metadata.read('x.iso');
    assert.deepEqual(meta.tags, ['BIOS', 'UEFI', 'ARCHIV']);
    assert.deepEqual(meta.autoTags, ['BIOS', 'UEFI', 'ARCHIV']);
    assert.equal(meta.sha256, 'deadbeef', 'Backfill darf die vorhandene Checksumme nicht neu berechnen');

    await fsp.rm(root, { recursive: true, force: true });
});

/* ======================================================= chunked-upload */

test('Chunk-Upload setzt am Serverstand fort', async () => {
    const root = await tempDir();
    const sessions = createUploadSessions({
        db: memoryDb(),
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
        db: memoryDb(),
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
        db: memoryDb(),
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
        db: memoryDb(),
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
        db: memoryDb(),
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

test('gleichzeitige Chunks auf dieselbe Sitzung: der zweite bekommt 409 statt zu ueberschreiben', async () => {
    const root = await tempDir();
    const sessions = createUploadSessions({
        db: memoryDb(),
        tmpDir: path.join(root, 'tmp'),
        uploadsDir: path.join(root, 'uploads'),
        maxBytes: 10_000,
    });
    const created = await sessions.create({ name: 'x.iso', size: 200 });

    async function* slow() {
        yield Buffer.alloc(50);
        await new Promise(resolve => setTimeout(resolve, 50));
        yield Buffer.alloc(50);
    }

    const firstPromise = sessions.append(created.id, 0, slow());
    await new Promise(resolve => setTimeout(resolve, 10)); // sicherstellen, dass der erste Aufruf schon "busy" gesetzt hat

    await assert.rejects(
        () => sessions.append(created.id, 0, Readable.from([Buffer.alloc(10)])),
        err => err.status === 409 && /bereits ein Chunk/.test(err.message)
    );

    const state = await firstPromise;
    assert.equal(state.offset, 100, 'der erste, nicht abgebrochene Aufruf muss trotzdem vollstaendig durchlaufen');

    await fsp.rm(root, { recursive: true, force: true });
});

test('pendingHash liefert die bisherige Pruefsumme, ohne finish() zu verfaelschen', async () => {
    const root = await tempDir();
    const db = memoryDb();
    const sessions = createUploadSessions({
        db, tmpDir: path.join(root, 'tmp'), uploadsDir: path.join(root, 'uploads'), maxBytes: 10_000,
    });

    const payload = crypto.randomBytes(200);
    const created = await sessions.create({ name: 'x.iso', size: 200 });
    assert.equal(sessions.pendingHash(created.id), crypto.createHash('sha256').digest('hex'), 'leerer Hasher vor dem ersten Byte');

    await sessions.append(created.id, 0, Readable.from([payload.subarray(0, 100)]));
    assert.equal(
        sessions.pendingHash(created.id),
        crypto.createHash('sha256').update(payload.subarray(0, 100)).digest('hex')
    );

    await sessions.append(created.id, 100, Readable.from([payload.subarray(100)]));
    const { sha256 } = await sessions.finish(created.id);
    assert.equal(sha256, crypto.createHash('sha256').update(payload).digest('hex'),
        'pendingHash() (hash.copy()) darf den eigentlichen Hasher in finish() nicht verbraucht haben');

    await fsp.rm(root, { recursive: true, force: true });
});

test('pendingHash liefert null, wenn der Hasher nicht (mehr) im Speicher ist (z.B. nach einem Neustart)', async () => {
    const root = await tempDir();
    const db = memoryDb();
    const tmpDir = path.join(root, 'tmp');
    const uploadsDir = path.join(root, 'uploads');

    const first = createUploadSessions({ db, tmpDir, uploadsDir, maxBytes: 10_000 });
    const created = await first.create({ name: 'x.iso', size: 100 });
    await first.append(created.id, 0, Readable.from([Buffer.alloc(50)]));

    // Neue Instanz auf derselben DB/demselben Verzeichnis simuliert einen
    // Neustart: die Hasher-Map ist ein reiner In-Memory-Zustand und daher leer.
    const restarted = createUploadSessions({ db, tmpDir, uploadsDir, maxBytes: 10_000 });
    assert.equal(restarted.pendingHash(created.id), null);

    await restarted.append(created.id, 50, Readable.from([Buffer.alloc(50)]));
    const { sha256 } = await restarted.finish(created.id);
    assert.equal(sha256, null, 'ohne Hasher bleibt die Pruefsumme null, die Hash-Queue liefert sie spaeter nach');

    await fsp.rm(root, { recursive: true, force: true });
});

/* ========================================================= session-store */

test('Session-Store haelt Sitzungen ueber Instanzen (Neustarts) hinweg', async () => {
    const { open, cleanup } = await restartDb();

    const firstDb = open();
    const first = new SqliteSessionStore({ db: firstDb });
    await promisify(first.set).bind(first)('sid-eins', {
        loggedIn: true,
        cookie: { expires: new Date(Date.now() + 60_000), maxAge: 60_000 },
    });
    first.close();
    firstDb.close();

    // Neue DB-Verbindung zur selben Datei = simulierter Neustart.
    const secondDb = open();
    const second = new SqliteSessionStore({ db: secondDb });
    const session = await promisify(second.get).bind(second)('sid-eins');
    assert.equal(session.loggedIn, true);
    second.close();
    secondDb.close();

    await cleanup();
});

test('Session-Store verwirft Abgelaufenes und unbekannte IDs', async () => {
    const store = new SqliteSessionStore({ db: memoryDb() });
    const get = promisify(store.get).bind(store);
    const set = promisify(store.set).bind(store);

    await set('abgelaufen', { cookie: { expires: new Date(Date.now() - 1000) } });
    assert.equal(await get('abgelaufen'), null);
    // get() entsorgt die Zeile gleich mit
    assert.equal(store.countStmt.get().n, 0);

    assert.equal(await get('nicht-vorhanden'), null);

    store.close();
});

test('prune entfernt abgelaufene Sitzungen', async () => {
    const store = new SqliteSessionStore({ db: memoryDb() });
    const set = promisify(store.set).bind(store);

    await set('lebt', { cookie: { expires: new Date(Date.now() + 60_000) } });
    await set('totA', { cookie: { expires: new Date(Date.now() - 1) } });
    await set('totB', { cookie: { expires: new Date(Date.now() - 1) } });

    assert.equal(store.prune(), 2);
    assert.equal(await promisify(store.length).bind(store)(), 1);

    store.close();
});

/* ========================================================= webauthn-store */

test('getOrCreateUserId ist stabil, auch ueber Instanzen (Neustarts) hinweg', async () => {
    const { open, cleanup } = await restartDb();

    const firstDb = open();
    const store = createWebauthnStore({ db: firstDb });
    const id = await store.getOrCreateUserId();
    assert.equal(await store.getOrCreateUserId(), id);
    firstDb.close();

    const secondDb = open();
    const restarted = createWebauthnStore({ db: secondDb });
    assert.equal(await restarted.getOrCreateUserId(), id);
    secondDb.close();

    await cleanup();
});

test('addCredential/findCredential geben alle Felder unveraendert zurueck', async () => {
    const store = createWebauthnStore({ db: memoryDb() });

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
});

test('addCredential wirft bei doppelter credentialId', async () => {
    const store = createWebauthnStore({ db: memoryDb() });
    await store.addCredential({ credentialId: 'x', publicKey: 'k', counter: 0, label: 'A' });
    await assert.rejects(() =>
        store.addCredential({ credentialId: 'x', publicKey: 'k', counter: 0, label: 'B' })
    );
});

test('listCredentials enthaelt nie den publicKey', async () => {
    const store = createWebauthnStore({ db: memoryDb() });
    await store.addCredential({ credentialId: 'x', publicKey: 'geheim', counter: 0, label: 'A' });

    const list = await store.listCredentials();
    assert.equal(list.length, 1);
    assert.equal(list[0].credentialId, 'x');
    assert.equal('publicKey' in list[0], false);
});

test('updateCounter persistiert, removeCredential entfernt', async () => {
    const store = createWebauthnStore({ db: memoryDb() });
    await store.addCredential({ credentialId: 'x', publicKey: 'k', counter: 0, label: 'A' });

    await store.updateCounter('x', 5);
    assert.equal((await store.findCredential('x')).counter, 5);

    assert.equal(await store.removeCredential('nicht-vorhanden'), false);
    assert.equal(await store.removeCredential('x'), true);
    assert.equal(await store.findCredential('x'), null);
    assert.deepEqual(await store.listCredentials(), []);
});

test('keine Passkeys ist der Ausgangszustand einer frischen DB', async () => {
    const store = createWebauthnStore({ db: memoryDb() });
    assert.deepEqual(await store.listCredentials(), []);
    assert.equal(typeof (await store.getOrCreateUserId()), 'string');
});

test('parallele addCredential-Aufrufe landen beide', async () => {
    const store = createWebauthnStore({ db: memoryDb() });

    await Promise.all([
        store.addCredential({ credentialId: 'a', publicKey: 'k', counter: 0, label: 'A' }),
        store.addCredential({ credentialId: 'b', publicKey: 'k', counter: 0, label: 'B' }),
    ]);

    const list = await store.listCredentials();
    assert.deepEqual(list.map(c => c.credentialId).sort(), ['a', 'b']);
});

/* ======================================================== api-token-store */

test('createToken gibt das Klartext-Token genau einmal zurueck, findByToken findet es wieder', async () => {
    const store = createApiTokenStore({ db: memoryDb() });

    const created = await store.createToken({ label: 'CI', scopes: ['read', 'write'] });
    assert.match(created.token, /^iso_/);
    assert.equal(created.label, 'CI');
    assert.deepEqual(created.scopes, ['read', 'write']);

    const found = await store.findByToken(created.token);
    assert.equal(found.id, created.id);
    assert.deepEqual(found.scopes, ['read', 'write']);
    assert.equal('token' in found, false, 'findByToken darf das Klartext-Token nicht zurueckgeben');
});

test('findByToken liefert null fuer unbekannte/manipulierte Tokens', async () => {
    const store = createApiTokenStore({ db: memoryDb() });
    await store.createToken({ label: 'x', scopes: ['read'] });

    assert.equal(await store.findByToken('iso_nichtvorhanden'), null);
    assert.equal(await store.findByToken(''), null);
});

test('createToken lehnt unbekannte Scopes ab', async () => {
    const store = createApiTokenStore({ db: memoryDb() });
    assert.equal(await store.createToken({ label: 'x', scopes: ['admin'] }), null);
    assert.equal(await store.createToken({ label: 'x', scopes: [] }), null);
});

test('listTokens enthaelt nie token oder token_hash', async () => {
    const store = createApiTokenStore({ db: memoryDb() });
    await store.createToken({ label: 'A', scopes: ['read'] });

    const list = await store.listTokens();
    assert.equal(list.length, 1);
    assert.equal('token' in list[0], false);
    assert.equal('tokenHash' in list[0], false);
    assert.equal('token_hash' in list[0], false);
});

test('revokeToken entfernt das Token, findByToken schlaegt danach fehl', async () => {
    const store = createApiTokenStore({ db: memoryDb() });
    const created = await store.createToken({ label: 'A', scopes: ['read'] });

    assert.equal(await store.revokeToken('nicht-vorhanden'), false);
    assert.equal(await store.revokeToken(created.id), true);
    assert.equal(await store.findByToken(created.token), null);
    assert.deepEqual(await store.listTokens(), []);
});

test('findByToken aktualisiert lastUsedAt', async () => {
    const store = createApiTokenStore({ db: memoryDb() });
    const created = await store.createToken({ label: 'A', scopes: ['read'] });
    assert.equal((await store.listTokens())[0].lastUsedAt, null);

    await store.findByToken(created.token);
    assert.equal(typeof (await store.listTokens())[0].lastUsedAt, 'number');
});

/* ==================================================== session-secret-store */

test('ensure() persistiert den Kandidaten beim ersten Aufruf und liefert ihn danach zurueck', async () => {
    const store = createSessionSecretStore({ db: memoryDb() });

    assert.equal(store.read(), null);
    assert.equal(store.ensure('erster-kandidat'), 'erster-kandidat');
    assert.equal(store.read(), 'erster-kandidat');

    // Ein zweiter Kandidat (z. B. eine geaenderte Env-Var) darf den
    // persistierten Wert nicht mehr ueberschreiben.
    assert.equal(store.ensure('zweiter-kandidat'), 'erster-kandidat');
    assert.equal(store.read(), 'erster-kandidat');
});

test('session-secret ueberlebt eine neue Store-Instanz (simulierter Neustart)', async () => {
    const { open, cleanup } = await restartDb();

    const firstDb = open();
    const first = createSessionSecretStore({ db: firstDb });
    first.ensure('bootstrap-secret');
    firstDb.close();

    const secondDb = open();
    const second = createSessionSecretStore({ db: secondDb });
    // Ein Neustart ohne gesetzte Env-Var wuerde hier sonst einen neuen
    // Kandidaten anbieten — der persistierte Wert muss trotzdem gewinnen.
    assert.equal(second.ensure('anderer-kandidat-nach-neustart'), 'bootstrap-secret');
    secondDb.close();

    await cleanup();
});

/* ========================================================== password-store */

test('setPassword/verify: richtiges Passwort true, falsches false', async () => {
    const store = createPasswordStore({ db: memoryDb() });

    const record = await store.setPassword('korrekt-horse-battery');
    assert.equal(await store.verify('korrekt-horse-battery', record), true);
    assert.equal(await store.verify('falsch', record), false);
});

test('read() liefert null, solange kein Passwort gesetzt wurde', async () => {
    const store = createPasswordStore({ db: memoryDb() });
    assert.equal(await store.read(), null);
});

test('Passwort-Hash ueberlebt eine neue Store-Instanz (simulierter Neustart)', async () => {
    const { open, cleanup } = await restartDb();

    const firstDb = open();
    const first = createPasswordStore({ db: firstDb });
    await first.setPassword('neues-passwort');
    firstDb.close();

    const secondDb = open();
    const second = createPasswordStore({ db: secondDb });
    const record = await second.read();
    assert.notEqual(record, null);
    assert.equal(await second.verify('neues-passwort', record), true);
    secondDb.close();

    await cleanup();
});

/* ========================================================== username-store */

test('write/read: Roundtrip liefert genau den gespeicherten Benutzernamen', async () => {
    const store = createUsernameStore({ db: memoryDb() });

    assert.equal(await store.read(), null);
    await store.write('julian');
    assert.equal(await store.read(), 'julian');
});

test('Benutzername ueberlebt eine neue Store-Instanz (simulierter Neustart)', async () => {
    const { open, cleanup } = await restartDb();

    const firstDb = open();
    const first = createUsernameStore({ db: firstDb });
    await first.write('neuer-name');
    firstDb.close();

    const secondDb = open();
    const second = createUsernameStore({ db: secondDb });
    assert.equal(await second.read(), 'neuer-name');
    secondDb.close();

    await cleanup();
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
    const store = createTotpStore({ db: memoryDb() });

    assert.equal(await store.isEnabled(), false);
    assert.equal(await store.getSecret(), null);
});

test('totp-store: enable() persistiert und liefert 8 einmalige Recovery-Codes', async () => {
    const store = createTotpStore({ db: memoryDb() });

    const codes = await store.enable('JBSWY3DPEHPK3PXP');
    assert.equal(codes.length, 8);
    assert.ok(codes.every(code => /^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/.test(code)));
    assert.equal(new Set(codes).size, 8, 'Codes muessen sich unterscheiden');

    assert.equal(await store.isEnabled(), true);
    assert.equal(await store.getSecret(), 'JBSWY3DPEHPK3PXP');
});

test('totp-store: consumeRecoveryCode verbraucht einen Code genau einmal', async () => {
    const store = createTotpStore({ db: memoryDb() });
    const [firstCode] = await store.enable('JBSWY3DPEHPK3PXP');

    assert.equal(await store.consumeRecoveryCode('nicht-vorhanden'), false);
    assert.equal(await store.consumeRecoveryCode(firstCode), true);
    assert.equal(await store.consumeRecoveryCode(firstCode), false, 'derselbe Code darf kein zweites Mal gelten');
});

test('totp-store: enable() ist alles-oder-nichts, wenn ein Recovery-Code-Insert mittendrin fehlschlaegt', async () => {
    // Statements werden beim createTotpStore()-Aufruf selbst vorbereitet, das
    // Patchen muss also vorher an der rohen db ansetzen, nicht erst am
    // zurueckgegebenen Store.
    const db = memoryDb();
    const originalPrepare = db.prepare.bind(db);
    let codeInserts = 0;
    db.prepare = sql => {
        const stmt = originalPrepare(sql);
        if (sql.includes('INSERT INTO totp_recovery_codes')) {
            const originalRun = stmt.run.bind(stmt);
            stmt.run = (...args) => {
                codeInserts += 1;
                // Simuliert einen Fehler beim Schreiben eines Recovery-Codes
                // (z. B. Platte voll) — ohne Transaktion bliebe TOTP als
                // "aktiviert" stehen, obwohl nur ein Teil der Codes existiert.
                if (codeInserts === 4) throw new Error('simulierter Fehler beim Schreiben');
                return originalRun(...args);
            };
        }
        return stmt;
    };
    const store = createTotpStore({ db });

    await assert.rejects(() => store.enable('JBSWY3DPEHPK3PXP'));

    assert.equal(await store.isEnabled(), false, 'ein fehlgeschlagener enable() darf TOTP nicht halb aktiviert lassen');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM totp_recovery_codes').get().n, 0);
});

test('totp-store: disable() entfernt den Datensatz vollstaendig', async () => {
    const store = createTotpStore({ db: memoryDb() });
    await store.enable('JBSWY3DPEHPK3PXP');
    await store.disable();

    assert.equal(await store.isEnabled(), false);
});

/* ============================================================= audit-log */

test('audit-log: log()/read() liefern die juengsten Eintraege zuerst', async () => {
    const auditLog = createAuditLog({ db: memoryDb() });

    await auditLog.log('login_success', { ip: '127.0.0.1' });
    await auditLog.log('upload', { filename: 'a.iso' });

    const entries = await auditLog.read();
    assert.equal(entries.length, 2);
    assert.equal(entries[0].event, 'upload');
    assert.equal(entries[1].event, 'login_success');
    assert.equal(entries[0].filename, 'a.iso');
    assert.equal(typeof entries[0].ts, 'number');
});

test('audit-log: read() liefert die id mit, aufsteigend vergeben (fuer den Heartbeat)', async () => {
    const auditLog = createAuditLog({ db: memoryDb() });

    await auditLog.log('login_success', { ip: '127.0.0.1' });
    await auditLog.log('upload', { filename: 'a.iso' });

    const entries = await auditLog.read();
    assert.equal(typeof entries[0].id, 'number');
    assert.ok(entries[0].id > entries[1].id, 'neueste Eintraege haben die groessere id');
});

test('audit-log: read() ohne Eintraege liefert eine leere Liste', async () => {
    const auditLog = createAuditLog({ db: memoryDb() });
    assert.deepEqual(await auditLog.read(), []);
});

test('audit-log: read({limit: Infinity}) liefert alle Eintraege', async () => {
    const auditLog = createAuditLog({ db: memoryDb() });
    for (let i = 0; i < 5; i++) await auditLog.log('ereignis', { i });
    assert.equal((await auditLog.read({ limit: Infinity })).length, 5);
});

test('audit-log: kuerzt auf die juengsten Zeilen, sobald das Zeilenlimit ueberschritten wird', async () => {
    const auditLog = createAuditLog({ db: memoryDb(), maxRows: 50, keepRowsOnTrim: 30 });

    for (let i = 0; i < 50; i++) await auditLog.log('filler', { i });
    assert.equal((await auditLog.read({ limit: Infinity })).length, 50, 'am Limit wird noch nicht gekuerzt');

    await auditLog.log('neuestes_ereignis', {});

    const entries = await auditLog.read({ limit: Infinity });
    assert.equal(entries.length, 30, 'muss nach dem Schreiben auf keepRowsOnTrim gekuerzt worden sein');
    assert.equal(entries[0].event, 'neuestes_ereignis', 'juengster Eintrag darf beim Kuerzen nie verloren gehen');
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
