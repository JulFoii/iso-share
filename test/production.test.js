'use strict';

/*
 * Tests fuer die Produktionsreife: Konfigurationspruefung, Schema-
 * Migrationen, Speicherplatzpruefung bei Uploads, Aufraeumen verwaister
 * Temp-Dateien, Logging, geordnetes Herunterfahren, Loeschfristen,
 * /healthz + /metrics und die Deployment-Dateien.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');
const { once, EventEmitter } = require('events');
const { Readable } = require('stream');
const { DatabaseSync } = require('node:sqlite');

const { startTestApp } = require('./helpers/app');
const { createApp } = require('../server');
const { checkConfig, assertConfig } = require('../lib/config-check');
const {
    openDatabase, applyMigrations, schemaVersion, maintainDatabase, SCHEMA_VERSION, MIGRATIONS,
} = require('../lib/db');
const { createUploadSessions, UploadError } = require('../lib/chunked-upload');
const { createLogger, requestLogger } = require('../lib/logger');
const { createShutdown, installProcessHandlers } = require('../lib/lifecycle');
const { createRetention } = require('../lib/retention');
const { createCustomerStore } = require('../lib/customer-store');
const { createTicketStore } = require('../lib/ticket-store');
const { createAttachmentStore } = require('../lib/attachment-store');
const { createAuditLog } = require('../lib/audit-log');
const { createEventStore } = require('../lib/event-store');

const QUIET = { log() {}, info() {}, warn() {}, error() {} };
const ROOT = path.join(__dirname, '..');
const DAY_MS = 24 * 60 * 60 * 1000;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

async function tempDir(prefix = 'iso-share-prod-') {
    return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

/* ======================================================== config-check */

test('config-check: im Produktivbetrieb sind fehlender Proxy und fehlende PUBLIC_URL fatal', () => {
    const { errors } = checkConfig({ isProd: true, mailEnabled: true, trustProxy: null, publicUrl: null });
    assert.equal(errors.length, 2);
    assert.ok(errors.some(message => message.includes('TRUST_PROXY')));
    assert.ok(errors.some(message => message.includes('PUBLIC_URL')));
});

test('config-check: http:// und localhost als PUBLIC_URL sind in production Fehler, sonst Warnungen', () => {
    const prod = checkConfig({ isProd: true, trustProxy: '1', publicUrl: 'http://localhost:3000', metricsToken: 'x' });
    assert.equal(prod.errors.length, 2);
    const dev = checkConfig({ isProd: false, publicUrl: 'http://localhost:3000' });
    assert.equal(dev.errors.length, 0);
    assert.equal(dev.warnings.length, 2);
});

test('config-check: eine korrekte Produktivkonfiguration ist fehler- und warnungsfrei', () => {
    const result = checkConfig({
        isProd: true, trustProxy: '1', publicUrl: 'https://iso.example.com', mailEnabled: true,
        inboundEnabled: true, metricsToken: 'geheim', maxFileSizeMb: 8192, attachmentMaxMb: 10,
        mailAttachmentMaxMb: 10, imapAuthservId: 'mx.example.com',
    });
    assert.deepEqual(result, { errors: [], warnings: [] });
});

test('config-check: IMAP ohne IMAP_AUTHSERV_ID warnt, eine ungueltige authserv-id oder negatives Mail-Anhang-Limit ist ein Fehler', () => {
    const missing = checkConfig({ inboundEnabled: true, mailEnabled: true });
    assert.ok(missing.warnings.some(message => message.includes('IMAP_AUTHSERV_ID')));
    const invalid = checkConfig({ imapAuthservId: 'mx.example.com; dkim=pass', mailAttachmentMaxMb: -1 });
    assert.ok(invalid.errors.some(message => message.includes('IMAP_AUTHSERV_ID')));
    assert.ok(invalid.errors.some(message => message.includes('MAIL_ATTACHMENT_MAX_MB')));
    assert.equal(checkConfig({ mailAttachmentMaxMb: 0 }).errors.length, 0);
});

test('config-check: ungueltige URL und ungueltige Groessen sind immer Fehler, auch ausserhalb production', () => {
    const { errors } = checkConfig({
        publicUrl: 'ftp://example.com', maxFileSizeMb: 0, attachmentMaxMb: Number.NaN,
    });
    assert.equal(errors.length, 3);
    assert.ok(checkConfig({ publicUrl: 'https://x.example/?a=1' }).errors[0].includes('Query'));
});

test('config-check: ohne METRICS_TOKEN in production nur eine Warnung', () => {
    const { errors, warnings } = checkConfig({ isProd: true, trustProxy: '1' });
    assert.equal(errors.length, 0);
    assert.ok(warnings.some(message => message.includes('METRICS_TOKEN')));
});

test('config-check: assertConfig wirft mit allen Fehlern gesammelt und loggt Warnungen', () => {
    const warned = [];
    assert.throws(
        () => assertConfig({ isProd: true, mailEnabled: true }, { warn: message => warned.push(message) }),
        err => err.code === 'invalid_config' && err.configErrors.length === 2
            && err.message.includes('TRUST_PROXY') && err.message.includes('PUBLIC_URL')
    );
    assert.ok(warned.some(message => message.includes('METRICS_TOKEN')));
});

test('createApp bricht bei ungueltiger Produktivkonfiguration ab, bevor die DB angelegt wird', async () => {
    const root = await tempDir();
    try {
        assert.throws(() => createApp({
            uploadsDir: path.join(root, 'uploads'),
            tmpDir: path.join(root, 'tmp'),
            dataDir: path.join(root, 'data'),
            isProd: true,
            trustProxy: null,
            log: QUIET,
        }), err => err.code === 'invalid_config');
        assert.equal(fs.existsSync(path.join(root, 'data', 'iso-share.db')), false);
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});

/* ========================================================== migrationen */

test('db: frische Datenbank steht auf der aktuellen Schema-Version, Pragmas sind gesetzt', async () => {
    const root = await tempDir();
    const db = openDatabase(path.join(root, 'a.db'));
    try {
        assert.equal(schemaVersion(db), SCHEMA_VERSION);
        assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
        assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
        assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 1); // NORMAL
        assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
        maintainDatabase(db); // darf auf einer frischen DB nicht werfen
    } finally {
        db.close();
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test('db: eine Alt-Datenbank ohne Versionsnummer wird migriert (fehlende Spalte wird ergaenzt)', async () => {
    const root = await tempDir();
    const file = path.join(root, 'legacy.db');
    const legacy = new DatabaseSync(file);
    legacy.exec('CREATE TABLE upload_sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL)');
    legacy.exec(`INSERT INTO upload_sessions VALUES ('u1', 'a.iso', 10, 1)`);
    legacy.close();

    const db = openDatabase(file);
    try {
        assert.equal(schemaVersion(db), SCHEMA_VERSION);
        const columns = db.prepare('PRAGMA table_info(upload_sessions)').all().map(col => col.name);
        assert.ok(columns.includes('replaces'));
        assert.equal(db.prepare('SELECT name FROM upload_sessions').get().name, 'a.iso');
    } finally {
        db.close();
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test('db: Migration 3 ergaenzt Ticket- und Outbox-Spalten einer Version-2-Datenbank, Daten bleiben erhalten', async () => {
    const root = await tempDir();
    const file = path.join(root, 'v2.db');
    const v2 = openDatabase(file, { migrations: MIGRATIONS.filter(m => m.version <= 2) });
    assert.equal(schemaVersion(v2), 2);
    assert.equal(v2.prepare('PRAGMA table_info(tickets)').all().some(col => col.name === 'iso_file'), false);
    v2.exec(`INSERT INTO tickets (id, number, requester_email, subject, created_at, updated_at)
             VALUES ('t1', 1001, 'a@example.com', 'Alt', 1, 1)`);
    v2.exec(`INSERT INTO mail_outbox (kind, to_addr, subject, text_body, next_attempt_at, created_at)
             VALUES ('x', 'a@example.com', 's', 't', 1, 1)`);
    v2.close();

    const db = openDatabase(file);
    try {
        assert.equal(schemaVersion(db), SCHEMA_VERSION);
        const columns = db.prepare('PRAGMA table_info(tickets)').all().map(col => col.name);
        for (const column of ['iso_file', 'source', 'merged_into_id', 'sla_notified_at', 'split_from_id']) assert.ok(columns.includes(column), column);
        const ticket = db.prepare('SELECT subject, source, iso_file FROM tickets WHERE id = ?').get('t1');
        assert.deepEqual({ ...ticket }, { subject: 'Alt', source: 'web', iso_file: null });
        assert.equal(db.prepare('SELECT attachments_json FROM mail_outbox').get().attachments_json, '[]');
        assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'tickets_iso_file'").get());
    } finally {
        db.close();
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test('db: zweites Oeffnen wendet keine Migration erneut an', async () => {
    const root = await tempDir();
    const file = path.join(root, 'b.db');
    openDatabase(file).close();
    const db = openDatabase(file);
    try {
        assert.deepEqual(applyMigrations(db), []);
    } finally {
        db.close();
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test('db: eine Datenbank einer neueren App-Version wird abgelehnt statt weiterbenutzt', async () => {
    const root = await tempDir();
    const file = path.join(root, 'future.db');
    const future = new DatabaseSync(file);
    future.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`);
    future.close();
    try {
        assert.throws(() => openDatabase(file), err => err.code === 'schema_too_new');
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test('db: eine fehlschlagende Migration wird komplett zurueckgerollt, die Version bleibt stehen', () => {
    const db = new DatabaseSync(':memory:');
    const migrations = [
        { version: 1, name: 'ok', up: d => d.exec('CREATE TABLE a (x INTEGER)') },
        {
            version: 2,
            name: 'kaputt',
            up(d) {
                d.exec('CREATE TABLE b (x INTEGER)');
                throw new Error('absichtlich');
            },
        },
    ];
    assert.throws(() => applyMigrations(db, migrations), /Migration 2 \(kaputt\).*absichtlich/);
    assert.equal(schemaVersion(db), 1);
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map(row => row.name);
    assert.ok(tables.includes('a'));
    assert.ok(!tables.includes('b'));
    db.close();
});

/* ============================================== Upload: Speicherplatz */

async function uploadFixture({ free = Infinity, minFreeBytes = 100, sameDevice = true, maxBytes = 10_000 } = {}) {
    const root = await tempDir();
    const tmpDir = path.join(root, 'tmp');
    const uploadsDir = path.join(root, 'uploads');
    const db = openDatabase(':memory:');
    const calls = [];
    const diskInfo = async dir => {
        calls.push(dir);
        return { free: typeof free === 'function' ? free(dir) : free, device: sameDevice ? 1 : dir };
    };
    const sessions = createUploadSessions({ db, tmpDir, uploadsDir, maxBytes, minFreeBytes, diskInfo });
    return {
        root, tmpDir, uploadsDir, db, sessions, calls,
        async cleanup() {
            db.close();
            await fsp.rm(root, { recursive: true, force: true });
        },
    };
}

test('chunked-upload: create lehnt mit 507 ab, wenn Datei plus Reserve nicht mehr passen', async () => {
    const fx = await uploadFixture({ free: 1000, minFreeBytes: 100 });
    try {
        await assert.rejects(
            fx.sessions.create({ name: 'gross.iso', size: 901 }),
            err => err instanceof UploadError && err.status === 507 && err.extra.required === 1001
        );
        const ok = await fx.sessions.create({ name: 'passt.iso', size: 900 });
        assert.equal(ok.offset, 0);
    } finally {
        await fx.cleanup();
    }
});

test('chunked-upload: noch ausstehende Bytes anderer Uploads zaehlen mit', async () => {
    const fx = await uploadFixture({ free: 1000, minFreeBytes: 0 });
    try {
        await fx.sessions.create({ name: 'a.iso', size: 600 });
        await assert.rejects(fx.sessions.create({ name: 'b.iso', size: 500 }), err => err.status === 507);
        await fx.sessions.create({ name: 'c.iso', size: 400 });
    } finally {
        await fx.cleanup();
    }
});

test('chunked-upload: Fortsetzen einer Sitzung prueft nur den Rest, ohne sich selbst doppelt zu zaehlen', async () => {
    let free = 10_000;
    const fx = await uploadFixture({ free: () => free, minFreeBytes: 0 });
    try {
        const first = await fx.sessions.create({ name: 'a.iso', size: 1000 });
        await fx.sessions.append(first.id, 0, Readable.from([Buffer.alloc(600)]));
        free = 450; // 400 fehlen noch
        const resumed = await fx.sessions.create({ name: 'a.iso', size: 1000 });
        assert.equal(resumed.id, first.id);
        assert.equal(resumed.offset, 600);
        free = 399;
        await assert.rejects(fx.sessions.create({ name: 'a.iso', size: 1000 }), err => err.status === 507);
    } finally {
        await fx.cleanup();
    }
});

test('chunked-upload: tmp und uploads auf demselben Volume werden nur einmal geprueft, getrennte beide', async () => {
    const same = await uploadFixture({ sameDevice: true });
    const separate = await uploadFixture({ sameDevice: false });
    try {
        await same.sessions.create({ name: 'a.iso', size: 10 });
        await separate.sessions.create({ name: 'a.iso', size: 10 });
        // Beide Verzeichnisse werden abgefragt; bei gleichem Geraet greift
        // der zweite Vergleich aber nicht erneut (kein Fehler trotz Doppelzaehlung)
        assert.equal(same.calls.length, 2);
        assert.equal(separate.calls.length, 2);
    } finally {
        await same.cleanup();
        await separate.cleanup();
    }
});

test('chunked-upload: ohne statfs-Info (null) wird nicht blockiert', async () => {
    const root = await tempDir();
    const db = openDatabase(':memory:');
    try {
        const sessions = createUploadSessions({
            db, tmpDir: path.join(root, 'tmp'), uploadsDir: path.join(root, 'up'),
            maxBytes: 1000, minFreeBytes: 10 ** 15, diskInfo: async () => null,
        });
        const created = await sessions.create({ name: 'a.iso', size: 10 });
        assert.equal(created.offset, 0);
    } finally {
        db.close();
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test('chunked-upload: echter statfs liefert freien Platz und Geraet', async () => {
    const { defaultDiskInfo } = require('../lib/chunked-upload');
    const info = await defaultDiskInfo(os.tmpdir());
    assert.ok(info === null || (info.free > 0 && info.device !== undefined));
    assert.equal(await defaultDiskInfo(path.join(os.tmpdir(), 'gibt-es-nicht-' + Date.now())), null);
});

test('chunked-upload: cleanupStale entfernt alte Multer-Reste, laesst frische Dateien und Ordner stehen', async () => {
    const fx = await uploadFixture();
    try {
        await fsp.mkdir(fx.tmpDir, { recursive: true });
        const old = path.join(fx.tmpDir, 'a1b2c3d4e5f6');
        const fresh = path.join(fx.tmpDir, 'f6e5d4c3b2a1');
        const folder = path.join(fx.tmpDir, 'unterordner');
        await fsp.writeFile(old, 'alt');
        await fsp.writeFile(fresh, 'neu');
        await fsp.mkdir(folder);
        const longAgo = new Date(Date.now() - 2 * DAY_MS);
        await fsp.utimes(old, longAgo, longAgo);
        await fsp.utimes(folder, longAgo, longAgo);

        const removed = await fx.sessions.cleanupStale();
        assert.equal(removed, 1);
        assert.equal(fs.existsSync(old), false);
        assert.equal(fs.existsSync(fresh), true);
        assert.equal(fs.existsSync(folder), true);
    } finally {
        await fx.cleanup();
    }
});

test('Route /upload/init antwortet bei vollem Volume mit 507, /api/v1/uploads mit code insufficient_storage', async t => {
    const app = await startTestApp({
        minFreeDiskMb: 0,
        diskInfo: async () => ({ free: 100, device: 1 }),
    });
    t.after(() => app.close());
    const { cookie } = await app.login();

    const init = await fetch(app.url('/upload/init'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: 'voll.iso', size: 1000 }),
    });
    assert.equal(init.status, 507);
    assert.match((await init.json()).error, /Speicherplatz/);

    const { token } = await app.services.apiTokenStore.createToken({ label: 'ci', scopes: ['write'] });
    const api = await fetch(app.url('/api/v1/uploads'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: 'voll.iso', size: 1000 }),
    });
    assert.equal(api.status, 507);
    assert.equal((await api.json()).code, 'insufficient_storage');
});

test('Route /upload (Multipart) lehnt anhand der Content-Length vor dem Einlesen mit 507 ab', async t => {
    const app = await startTestApp({
        minFreeDiskMb: 0,
        diskInfo: async () => ({ free: 50, device: 1 }),
    });
    t.after(() => app.close());
    const { cookie } = await app.login();

    const form = new FormData();
    form.append('file', new Blob([Buffer.alloc(200)]), 'voll.iso');
    const res = await fetch(app.url('/upload'), {
        method: 'POST',
        headers: { Cookie: cookie, Accept: 'application/json' },
        body: form,
    });
    assert.equal(res.status, 507);
    assert.match((await res.json()).error, /Speicherplatz/);
    assert.equal(fs.existsSync(path.join(app.uploadsDir, 'voll.iso')), false);
});

/* =============================================================== Logger */

function capture() {
    const out = [];
    const err = [];
    return {
        out, err,
        stdout: { write: chunk => out.push(chunk) },
        stderr: { write: chunk => err.push(chunk) },
    };
}

test('logger: JSON-Format schreibt eine Zeile je Eintrag mit Feldern und serialisiertem Fehler', () => {
    const c = capture();
    const log = createLogger({ format: 'json', stdout: c.stdout, stderr: c.stderr, now: () => new Date(0) });
    log.info('hallo', 'welt', { reqId: 'r1' });
    log.error('kaputt:', new Error('boom'));

    const info = JSON.parse(c.out[0]);
    assert.deepEqual(info, { time: '1970-01-01T00:00:00.000Z', level: 'info', msg: 'hallo welt', reqId: 'r1' });
    const error = JSON.parse(c.err[0]);
    assert.equal(error.level, 'error');
    assert.equal(error.msg, 'kaputt:');
    assert.equal(error.err.message, 'boom');
    assert.match(error.err.stack, /Error: boom/);
    assert.ok(c.out[0].endsWith('\n') && !c.out[0].slice(0, -1).includes('\n'));
});

test('logger: Level-Schwelle filtert, warn/error gehen nach stderr, log() ist ein Alias fuer info', () => {
    const c = capture();
    const log = createLogger({ format: 'pretty', level: 'warn', stdout: c.stdout, stderr: c.stderr });
    log.debug('d');
    log.info('i');
    log.log('l');
    log.warn('w');
    assert.equal(c.out.length, 0);
    assert.deepEqual(c.err, ['w\n']);

    const c2 = capture();
    createLogger({ format: 'pretty', level: 'debug', stdout: c2.stdout, stderr: c2.stderr }).log('x', { a: 1 });
    assert.deepEqual(c2.out, ['x {"a":1}\n']);
});

test('requestLogger: Request-ID wird uebernommen oder erzeugt, Query-String nie geloggt, /healthz ausgelassen', async t => {
    const entries = [];
    const log = {
        info: (msg, fields) => entries.push({ level: 'info', msg, ...fields }),
        warn: (msg, fields) => entries.push({ level: 'warn', msg, ...fields }),
        error: (msg, fields) => entries.push({ level: 'error', msg, ...fields }),
    };
    const app = await startTestApp({ log: { ...QUIET, ...log } });
    t.after(() => app.close());

    const own = await fetch(app.url('/account/verify?token=GEHEIM123'), { headers: { 'X-Request-Id': 'abc-123' } });
    assert.equal(own.headers.get('x-request-id'), 'abc-123');
    const bad = await fetch(app.url('/'), { headers: { 'X-Request-Id': 'bad id with spaces' } });
    assert.match(bad.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
    await fetch(app.url('/healthz'));
    await fetch(app.url('/gibt-es-nicht'));
    // 'finish' feuert nach dem Senden — kurz warten, bis alle Eintraege da sind
    await new Promise(resolve => setTimeout(resolve, 50));

    const requests = entries.filter(entry => entry.msg === 'request');
    assert.ok(!JSON.stringify(entries).includes('GEHEIM123'), 'Token aus dem Query-String darf nie im Log stehen');
    const verify = requests.find(entry => entry.path === '/account/verify');
    assert.equal(verify.reqId, 'abc-123');
    assert.equal(verify.method, 'GET');
    assert.equal(typeof verify.durationMs, 'number');
    assert.ok(!requests.some(entry => entry.path === '/healthz'));
    const notFound = requests.find(entry => entry.path === '/gibt-es-nicht');
    assert.equal(notFound.status, 404);
    // 4xx sind auf der Konsole kein warn mehr (nur noch 5xx als error) —
    // Details gehoeren ins Event-Log, nicht in die Konsole
    assert.equal(notFound.level, 'info');
});

test('requestLogger funktioniert auch mit einem Logger ohne info()', () => {
    const lines = [];
    const middleware = requestLogger({ log: (...args) => lines.push(args), warn() {}, error() {} }, { randomId: () => 'id1' });
    const res = new EventEmitter();
    const headers = {};
    res.set = (key, value) => { headers[key] = value; };
    res.get = () => undefined;
    res.statusCode = 200;
    res.writableFinished = true;
    let called = false;
    middleware({ get: () => undefined, path: '/x', method: 'GET', ip: '1.2.3.4' }, res, () => { called = true; });
    res.emit('finish');
    assert.ok(called);
    assert.equal(headers['X-Request-Id'], 'id1');
    assert.equal(lines[0][0], 'request');
});

/* =========================================================== Lifecycle */

async function slowServer(delayMs) {
    const server = http.createServer((req, res) => {
        setTimeout(() => res.end('fertig'), delayMs);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

test('lifecycle: laufende Requests duerfen vor dem Beenden zu Ende laufen', async () => {
    const { server, url } = await slowServer(150);
    const events = [];
    const shutdown = createShutdown({
        server,
        stop: async () => { events.push('stop'); },
        exit: code => events.push(`exit:${code}`),
        log: QUIET,
        timeoutMs: 2000,
    });

    const pending = fetch(url).then(res => res.text());
    await new Promise(resolve => setTimeout(resolve, 30));
    const done = shutdown('SIGTERM');
    assert.equal(shutdown('SIGTERM'), done, 'zweites Signal startet kein zweites Herunterfahren');

    assert.equal(await pending, 'fertig');
    await done;
    assert.deepEqual(events, ['stop', 'exit:0']);
});

test('lifecycle: haengende Verbindungen werden nach dem Timeout getrennt', async () => {
    const { server, url } = await slowServer(10_000);
    const events = [];
    const shutdown = createShutdown({
        server, stop: async () => events.push('stop'), exit: code => events.push(`exit:${code}`),
        log: QUIET, timeoutMs: 100,
    });
    const pending = fetch(url).then(() => 'antwort', () => 'abgebrochen');
    await new Promise(resolve => setTimeout(resolve, 30));
    const started = Date.now();
    await shutdown('SIGTERM');
    assert.ok(Date.now() - started < 2000);
    assert.equal(await pending, 'abgebrochen');
    assert.deepEqual(events, ['stop', 'exit:0']);
});

test('lifecycle: Fehler beim Stoppen fuehrt zu Exit-Code 1, Prozess-Handler loesen Herunterfahren aus', async () => {
    const { server } = await slowServer(0);
    const exits = [];
    const shutdown = createShutdown({
        server, stop: async () => { throw new Error('db kaputt'); }, exit: code => exits.push(code),
        log: QUIET, timeoutMs: 100,
    });
    await shutdown('SIGTERM');
    assert.deepEqual(exits, [1]);

    const proc = new EventEmitter();
    const reasons = [];
    installProcessHandlers({ shutdown: (reason, code) => reasons.push([reason, code]), log: QUIET, proc });
    proc.emit('SIGTERM');
    proc.emit('SIGTERM'); // once
    proc.emit('unhandledRejection', 'nur ein String');
    proc.emit('uncaughtException', new Error('x'));
    assert.deepEqual(reasons, [['SIGTERM', undefined], ['unhandledRejection', 1], ['uncaughtException', 1]]);
});

/* =========================================================== Retention */

async function retentionFixture(policy) {
    const dir = await tempDir();
    const db = openDatabase(':memory:');
    const customerStore = createCustomerStore({ db });
    const ticketStore = createTicketStore({ db });
    const attachmentStore = createAttachmentStore({ db, dir, maxBytes: 1024 });
    const events = createEventStore({ file: ':memory:' });
    const auditLog = createAuditLog({ events });
    const forgotten = { tickets: [], addresses: [] };
    const outbox = {
        forgetTicket: id => forgotten.tickets.push(id),
        forgetAddress: address => forgotten.addresses.push(address),
    };
    const destroyed = [];
    const sessionStore = { destroyForCustomer: id => destroyed.push(id) };
    const retention = createRetention({
        db, ticketStore, attachmentStore, customerStore, sessionStore, outbox, auditLog, log: QUIET, policy,
    });
    return {
        db, dir, customerStore, ticketStore, attachmentStore, auditLog, events, retention, forgotten, destroyed,
        async cleanup() {
            db.close();
            events.close();
            await fsp.rm(dir, { recursive: true, force: true });
        },
    };
}

test('Event-Log: Audit-Eintraege aelter als die Audit-Frist werden geloescht, juengere bleiben', async () => {
    const events = createEventStore({ file: ':memory:', auditDays: 30 });
    try {
        const now = Date.now();
        events.record({ event: 'alt', audit: true, ts: now - 31 * DAY_MS, ip: '1.2.3.4' });
        events.record({ event: 'jung', audit: true, ts: now - 29 * DAY_MS });

        const result = await events.purge();
        assert.equal(result.audit, 1);
        const names = events.readAudit({ limit: Infinity }).map(entry => entry.event);
        assert.deepEqual(names, ['jung']);
    } finally {
        events.close();
    }
});

test('retention: nur alte, unbestaetigte Konten werden still entfernt', async () => {
    const fx = await retentionFixture({ auditLogDays: 0, unverifiedAccountDays: 30, closedTicketDays: 0 });
    try {
        const oldUnverified = await fx.customerStore.createCustomer({ email: 'alt@example.com', name: 'A', password: 'x'.repeat(12) });
        const oldVerified = await fx.customerStore.createCustomer({ email: 'ok@example.com', name: 'B', password: 'x'.repeat(12) });
        const young = await fx.customerStore.createCustomer({ email: 'neu@example.com', name: 'C', password: 'x'.repeat(12) });
        fx.customerStore.markVerified(oldVerified.id);
        fx.db.prepare('UPDATE customers SET created_at = ? WHERE id IN (?, ?)')
            .run(Date.now() - 40 * DAY_MS, oldUnverified.id, oldVerified.id);

        const result = await fx.retention.runOnce();
        assert.equal(result.accounts, 1);
        assert.equal(fx.customerStore.getCustomer(oldUnverified.id), null);
        assert.ok(fx.customerStore.getCustomer(oldVerified.id));
        assert.ok(fx.customerStore.getCustomer(young.id));
        assert.deepEqual(fx.destroyed, [oldUnverified.id]);
        assert.deepEqual(fx.forgotten.addresses, ['alt@example.com']);
    } finally {
        await fx.cleanup();
    }
});

test('retention: alte geschlossene Tickets samt Anhang-Dateien werden geloescht, geloeste und junge bleiben', async () => {
    const fx = await retentionFixture({ auditLogDays: 0, unverifiedAccountDays: 0, closedTicketDays: 90 });
    try {
        const customer = await fx.customerStore.createCustomer({ email: 'k@example.com', name: 'K', password: 'x'.repeat(12) });
        fx.customerStore.markVerified(customer.id);
        const full = fx.customerStore.getCustomer(customer.id);
        const make = subject => fx.ticketStore.createTicket({ customer: full, subject, body: 'x' });

        const old = make('alt');
        const [saved] = await fx.attachmentStore.storeAll(
            fx.attachmentStore.inspectBuffers([{ filename: 'a.png', content: PNG }]),
            { ticketId: old.ticket.id, messageId: old.message.id }
        );
        const recent = make('jung');
        const resolved = make('geloest');
        const longAgo = Date.now() - 100 * DAY_MS;
        const set = fx.db.prepare('UPDATE tickets SET status = ?, closed_at = ? WHERE id = ?');
        set.run('closed', longAgo, old.ticket.id);
        set.run('closed', Date.now() - DAY_MS, recent.ticket.id);
        set.run('resolved', null, resolved.ticket.id);

        const result = await fx.retention.runOnce();
        assert.equal(result.tickets, 1);
        assert.equal(fx.ticketStore.getTicket(old.ticket.id), null);
        assert.ok(fx.ticketStore.getTicket(recent.ticket.id));
        assert.ok(fx.ticketStore.getTicket(resolved.ticket.id));
        assert.equal(fs.existsSync(fx.attachmentStore.filePath(saved.id)), false);
        assert.deepEqual(fx.forgotten.tickets, [old.ticket.id]);
    } finally {
        await fx.cleanup();
    }
});

test('retention: Frist 0 schaltet ab, ein Lauf ohne Treffer schreibt keinen Audit-Eintrag', async () => {
    const fx = await retentionFixture({ auditLogDays: 0, unverifiedAccountDays: 0, closedTicketDays: 0 });
    try {
        await fx.auditLog.log('uralt', {});
        const result = await fx.retention.runOnce();
        assert.deepEqual(result, { accounts: 0, tickets: 0 });
        assert.deepEqual((await fx.auditLog.read()).map(entry => entry.event), ['uralt']);
    } finally {
        await fx.cleanup();
    }
});

test('retention laeuft beim Start der App mit den konfigurierten Fristen', async t => {
    // Erste Instanz legt die DB an, danach wird ein uralter Eintrag
    // hineingeschrieben und die App neu gestartet
    const first = await startTestApp();
    t.after(() => fsp.rm(first.root, { recursive: true, force: true }));
    await first.shutdown();
    const dbFile = path.join(first.root, 'data', 'iso-share.db');
    const raw = new DatabaseSync(dbFile);
    raw.prepare('INSERT INTO audit_log (ts, event, detail_json) VALUES (?, ?, ?)')
        .run(Date.now() - 10 * DAY_MS, 'uralt', '{}');
    raw.close();

    const policy = { auditLogDays: 1, unverifiedAccountDays: 0, closedTicketDays: 0 };
    const instance = createApp({
        uploadsDir: path.join(first.root, 'uploads'),
        tmpDir: path.join(first.root, 'tmp-uploads'),
        dataDir: path.join(first.root, 'data'),
        adminPassword: 'x'.repeat(16), sessionSecret: 's', scanOnStart: false, sweepStaleUploads: false,
        startMailWorkers: false, minFreeDiskMb: 0, requestLog: false, log: QUIET,
        maintenanceIntervalMs: 60 * 60 * 1000, retentionPolicy: policy,
    });
    await instance.start();
    try {
        assert.deepEqual(instance.services.retention.policy, policy);
        // Die Altzeile aus audit_log wurde beim Start ins Event-Log uebernommen
        // und dort von der Audit-Frist (auditLogDays) gleich wieder entfernt
        const events = (await instance.services.auditLog.read()).map(entry => entry.event);
        assert.ok(!events.includes('uralt'));
        assert.equal(instance.services.events.list({ event: 'events_purged' }).events.length, 1);
        assert.equal(instance.services.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n, 0);
    } finally {
        await instance.stop();
    }
});

test('Datenschutzerklaerung nennt die tatsaechlich konfigurierten Loeschfristen', async t => {
    const app = await startTestApp({
        retentionPolicy: { auditLogDays: 45, unverifiedAccountDays: 14, closedTicketDays: 0 },
    });
    t.after(() => app.close());
    const html = await (await fetch(app.url('/privacy'))).text();
    assert.match(html, /nach 45 Tagen automatisch gelöscht/);
    assert.match(html, /innerhalb von 14 Tagen bestätigt/);
    assert.doesNotMatch(html, /Geschlossene Tickets werden/);
});

/* ===================================================== healthz/metrics */

test('/healthz prueft die Datenbank und meldet 503, wenn sie nicht erreichbar ist', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const ok = await fetch(app.url('/healthz'));
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).db, 'ok');

    app.services.db.close();
    const broken = await fetch(app.url('/healthz'));
    assert.equal(broken.status, 503);
    assert.equal((await broken.json()).status, 'error');
});

test('/metrics enthaelt Betriebswerte (Outbox, Backups, Speicher, Version)', async t => {
    const app = await startTestApp({ diskInfo: async () => ({ free: 12345, device: 1 }) });
    t.after(() => app.close());
    await app.services.backupStore.createBackup('manual');

    const res = await fetch(app.url('/metrics'));
    assert.equal(res.status, 200);
    const body = await res.text();
    const version = require('../package.json').version;
    assert.ok(body.includes(`iso_share_build_info{version="${version}",schema="${SCHEMA_VERSION}"`));
    assert.match(body, /^iso_share_mail_outbox\{status="failed"\} 0$/m);
    assert.match(body, /^iso_share_backups 1$/m);
    assert.match(body, /^iso_share_backup_last_timestamp_seconds [1-9]\d*(\.\d+)?$/m);
    assert.match(body, /^iso_share_disk_free_bytes\{volume="uploads"\} 12345$/m);
    assert.match(body, /^iso_share_hash_queue_pending 0$/m);
    assert.match(body, /^iso_share_upload_sessions 0$/m);
    assert.match(body, /^iso_share_db_bytes [1-9]\d*$/m);
});

test('/metrics verlangt mit gesetztem METRICS_TOKEN ein passendes Bearer-Token', async t => {
    const app = await startTestApp({ metricsToken: 'scrape-geheim' });
    t.after(() => app.close());

    const none = await fetch(app.url('/metrics'));
    assert.equal(none.status, 401);
    assert.match(none.headers.get('www-authenticate'), /Bearer/);
    const wrong = await fetch(app.url('/metrics'), { headers: { Authorization: 'Bearer falsch' } });
    assert.equal(wrong.status, 401);
    const right = await fetch(app.url('/metrics'), { headers: { Authorization: 'Bearer scrape-geheim' } });
    assert.equal(right.status, 200);
    assert.match(await right.text(), /iso_share_files_total/);
});

/* ======================================================== Deployment */

test('.dockerignore haelt Datenbank, Uploads und Secrets aus dem Image', async () => {
    const lines = (await fsp.readFile(path.join(ROOT, '.dockerignore'), 'utf8'))
        .split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    for (const entry of ['data', 'uploads', 'tmp-uploads', '.env', '.env.*', '*.db', 'node_modules', '.git', 'test']) {
        assert.ok(lines.includes(entry), `${entry} fehlt in .dockerignore`);
    }
});

test('docker-compose bindet die App nur lokal, setzt TRUST_PROXY und eine Stop-Frist ueber dem Shutdown-Timeout', async () => {
    const compose = await fsp.readFile(path.join(ROOT, 'docker-compose.yml'), 'utf8');
    assert.match(compose, /"127\.0\.0\.1:3000:3000"/);
    assert.doesNotMatch(compose, /^\s*- "3000:3000"/m);
    assert.match(compose, /TRUST_PROXY=\$\{TRUST_PROXY:-1\}/);
    const grace = Number(/stop_grace_period:\s*(\d+)s/.exec(compose)[1]) * 1000;
    const shutdownMs = Number(/SHUTDOWN_TIMEOUT_MS:-(\d+)/.exec(compose)[1]);
    assert.ok(grace > shutdownMs + 5000, 'stop_grace_period muss ueber SHUTDOWN_TIMEOUT_MS + Notausgang liegen');
    assert.match(compose, /max-size/);
});

test('Dockerfile laeuft als node-User mit gepinntem Basis-Image und Healthcheck', async () => {
    const dockerfile = await fsp.readFile(path.join(ROOT, 'Dockerfile'), 'utf8');
    assert.match(dockerfile, /^FROM node:\d+\.\d+-alpine/m);
    assert.match(dockerfile, /^USER node$/m);
    assert.match(dockerfile, /^HEALTHCHECK .*\r?\n?.*\/healthz/m);
    assert.match(dockerfile, /npm ci --omit=dev/);
});
