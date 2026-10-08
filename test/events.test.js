'use strict';

/*
 * Zentrales Event-Log: lib/event-store.js, lib/logger.js (Konsole vs.
 * Senke), lib/routes/event-log.js (Dashboard, Export, Einstellungen).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const { createEventStore, redact, diff, ftsQuery } = require('../lib/event-store');
const { createLogger } = require('../lib/logger');
const { SEVERITY, moduleFor, severityFor, moduleForPath } = require('../lib/event-catalog');
const { parseFilters, filterQuery, csvCell } = require('../lib/routes/event-log');
const { openDatabase } = require('../lib/db');
const { startTestApp } = require('./helpers/app');

const DAY_MS = 24 * 60 * 60 * 1000;
const QUIET = { log() {}, warn() {}, error() {} };

function memoryEvents(options = {}) {
    return createEventStore({ file: ':memory:', fallback: QUIET, ...options });
}

async function tempDir() {
    return fsp.mkdtemp(path.join(os.tmpdir(), 'iso-share-events-'));
}

/* =============================================================== Helfer */

test('redact maskiert Geheimnisse anhand der Schluessel-Endung, laesst IDs lesbar', () => {
    const out = redact({
        password: 'geheim', passwordHash: 'abc', token: 't', tokenId: 'id-1', sha256: 'f00',
        nested: { apiKey: 'k', cookie: 'c', hashStatus: 'done' }, list: [{ secret: 's' }],
    });
    assert.equal(out.password, '[redacted]');
    assert.equal(out.passwordHash, '[redacted]');
    assert.equal(out.token, '[redacted]');
    assert.equal(out.tokenId, 'id-1');
    assert.equal(out.sha256, 'f00');
    assert.equal(out.nested.apiKey, '[redacted]');
    assert.equal(out.nested.cookie, '[redacted]');
    assert.equal(out.nested.hashStatus, 'done');
    assert.equal(out.list[0].secret, '[redacted]');
});

test('diff liefert nur geaenderte Felder, sensible maskiert, null ohne Aenderung', () => {
    assert.deepEqual(diff({ a: 1, b: 2 }, { a: 1, b: 3 }), { b: { from: 2, to: 3 } });
    assert.deepEqual(diff({ password: 'x' }, { password: 'y' }), { password: { from: '[redacted]', to: '[redacted]' } });
    assert.equal(diff({ a: [1] }, { a: [1] }), null);
    assert.deepEqual(diff(null, { neu: true }), { neu: { from: null, to: true } });
});

test('ftsQuery baut nie FTS-Syntax aus der Eingabe', () => {
    assert.equal(ftsQuery('login fail'), '"login"* "fail"*');
    assert.equal(ftsQuery('a"b OR'), '"ab"* "OR"*');
    assert.equal(ftsQuery('  ** () '), null);
});

test('Katalog: Modul und Schweregrad fuer bekannte und abgeleitete Ereignisse', () => {
    assert.equal(moduleFor('login_failed'), 'auth');
    assert.equal(severityFor('login_failed'), SEVERITY.WARNING);
    assert.equal(moduleFor('ticket_created'), 'tickets');
    assert.equal(severityFor('irgendwas_rejected'), SEVERITY.WARNING);
    assert.equal(moduleFor('unbekannt'), 'system');
    assert.equal(moduleForPath('/api/v1/files'), 'api');
    assert.equal(moduleForPath('/login'), 'auth');
    assert.equal(moduleForPath('/admin/tickets/1001'), 'tickets');
    assert.equal(moduleForPath('/'), 'http');
});

test('csvCell: Quoting und Schutz gegen Formel-Injection', () => {
    assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
    assert.equal(csvCell('-1+2'), "'-1+2");
    assert.equal(csvCell('a;b'), '"a;b"');
    assert.equal(csvCell(null), '');
    assert.equal(csvCell(42), '42');
});

test('parseFilters/filterQuery: normalisiert und ergibt wieder denselben Query-String', () => {
    const filters = parseFilters({
        sev: ['error', 'critical', 'quatsch'], module: 'auth,gibtsnicht', q: ' login ', range: '7d', audit: '1',
    }, 1_000_000_000_000);
    assert.deepEqual(filters.severities, [40, 50]);
    assert.deepEqual(filters.modules, ['auth']);
    assert.equal(filters.q, 'login');
    assert.equal(filters.from, 1_000_000_000_000 - 7 * DAY_MS);
    assert.equal(filterQuery(filters), '?range=7d&sev=error&sev=critical&module=auth&q=login&audit=1');

    const custom = parseFilters({ from: '2026-01-02T03:04', to: 'kaputt' });
    assert.equal(custom.range, 'custom');
    // Eigener Zeitraum ist Wanduhrzeit Europe/Berlin (Winter: UTC+1)
    assert.equal(custom.from, Date.UTC(2026, 0, 2, 2, 4));
    assert.equal(custom.to, null);
});

/* ========================================================== Event-Store */

test('record() puffert und flush() schreibt in einer Transaktion; list() filtert', () => {
    const events = memoryEvents({ flushIntervalMs: 60_000 });
    events.record({ event: 'a', module: 'files', severity: SEVERITY.INFO, message: 'erste' });
    events.record({ event: 'b', module: 'auth', severity: SEVERITY.ERROR, error: new Error('kaputt') });
    events.record({ event: 'c', module: 'mail', severity: SEVERITY.WARNING, payload: { token: 'x', count: 2 } });
    assert.equal(events.status().queued, 3, 'noch nicht geschrieben');

    const all = events.list({});
    assert.deepEqual(all.events.map(e => e.event), ['c', 'b', 'a']);
    assert.equal(events.status().queued, 0);

    const errors = events.list({ severities: [SEVERITY.ERROR] }).events;
    assert.equal(errors.length, 1);
    assert.match(errors[0].errorStack, /Error: kaputt/);
    assert.equal(errors[0].message, 'kaputt');

    const mail = events.list({ modules: ['mail'] }).events[0];
    assert.deepEqual(mail.payload, { token: '[redacted]', count: 2 });
    events.close();
});

test('Volltextsuche findet Ereignis, Meldung, IP und Payload; Cursor blaettert ohne Luecken', () => {
    const events = memoryEvents();
    for (let i = 0; i < 25; i++) {
        events.record({ event: 'download', message: `Datei ${i}`, payload: { file: `ubuntu-${i}.iso` }, ip: '10.0.0.1' });
    }
    events.record({ event: 'login_failed', ip: '203.0.113.9', payload: { username: 'mallory' } });

    assert.equal(events.list({ q: 'mallory' }).events[0].event, 'login_failed');
    assert.equal(events.list({ q: '203.0.113.9' }).events.length, 1);
    assert.equal(events.list({ q: 'login_failed' }).events.length, 1);
    assert.equal(events.list({ q: 'ubuntu-7' }).events.length, 1);

    const seen = [];
    let before = null;
    for (;;) {
        const page = events.list({ event: 'download', before }, { limit: 10 });
        seen.push(...page.events.map(e => e.id));
        if (!page.nextCursor) break;
        before = page.nextCursor;
    }
    assert.equal(seen.length, 25);
    assert.equal(new Set(seen).size, 25);
    events.close();
});

test('DEBUG wird nur mit storeDebug gespeichert; Queue-Ueberlauf verwirft INFO, nie WARNING', () => {
    const events = memoryEvents({ flushIntervalMs: 60_000, maxQueue: 3, batchSize: 1000 });
    events.record({ event: 'dbg', severity: SEVERITY.DEBUG });
    assert.equal(events.status().queued, 0);
    events.writeSettings({ storeDebug: true });
    events.record({ event: 'dbg', severity: SEVERITY.DEBUG });
    events.record({ event: 'i1' });
    events.record({ event: 'i2' });
    events.record({ event: 'i3' }); // voll -> verworfen
    events.record({ event: 'w', severity: SEVERITY.WARNING }); // verdraengt einen DEBUG/INFO
    const names = events.list({}).events.map(e => e.event);
    assert.ok(names.includes('w'));
    assert.ok(!names.includes('i3'));
    assert.equal(events.status().dropped, 2);
    events.close();
});

test('Audit-Eintraege werden sofort geschrieben, ohne auf den Timer zu warten', () => {
    const events = memoryEvents({ flushIntervalMs: 60_000 });
    events.audit('login_success', { ip: '1.2.3.4' });
    assert.equal(events.status().queued, 0);
    assert.equal(events.status().written, 1);
    events.close();
});

test('stats(): Kennzahlen aus der Stunden-Rollup-Tabelle, Zeitleiste gestapelt, Vergleich zur Vorperiode', () => {
    const now = Date.UTC(2026, 8, 23, 12, 0);
    const events = memoryEvents({ now: () => now });
    events.record({ event: 'http_request', module: 'http', status: 200 });
    events.record({ event: 'http_request', module: 'http', status: 500, severity: SEVERITY.ERROR });
    events.record({ event: 'login_failed', module: 'auth', severity: SEVERITY.WARNING });
    events.record({ event: 'ip_blocked', module: 'security', severity: SEVERITY.WARNING });
    events.record({ event: 'old', ts: now - 30 * 60 * 60 * 1000 });

    const stats = events.stats({ from: now - DAY_MS, to: now });
    assert.equal(stats.total, 4);
    assert.equal(stats.errors, 1);
    assert.equal(stats.http, 2);
    assert.equal(stats.http5xx, 1);
    assert.equal(stats.httpErrorRate, 0.5);
    assert.equal(stats.failedLogins, 1);
    assert.equal(stats.ipBlocks, 1);
    assert.equal(stats.previous.total, 1);
    assert.equal(stats.timeline.reduce((sum, bar) => sum + bar.total, 0), 4);
    assert.equal(stats.modules[0].module, 'http');
    events.close();
});

test('purge(): Fristen je Schweregrad, Audit getrennt, Archiv als gzip-NDJSON', async () => {
    const dir = await tempDir();
    const now = Date.now();
    const events = memoryEvents({ archiveDir: dir, auditDays: 90 });
    try {
        events.writeSettings({ infoDays: 30, errorDays: 365, archiveEnabled: true });
        events.record({ event: 'alt_info', ts: now - 31 * DAY_MS });
        events.record({ event: 'jung_info', ts: now - 29 * DAY_MS });
        events.record({ event: 'alt_error', severity: SEVERITY.ERROR, ts: now - 31 * DAY_MS });
        events.record({ event: 'audit_alt', audit: true, ts: now - 31 * DAY_MS });

        const result = await events.purge();
        assert.equal(result.bySeverity[20], 1);
        const names = events.list({}).events.map(e => e.event);
        assert.ok(!names.includes('alt_info'));
        assert.ok(names.includes('jung_info'));
        assert.ok(names.includes('alt_error'), 'ERROR-Frist ist laenger');
        assert.ok(names.includes('audit_alt'), 'Audit folgt nur der Audit-Frist');
        assert.ok(names.includes('events_purged'));

        const [archive] = await events.listArchives();
        assert.equal(result.archive.file, archive.file);
        const lines = zlib.gunzipSync(await fsp.readFile(path.join(dir, archive.file))).toString().trim().split('\n');
        assert.deepEqual(lines.map(line => JSON.parse(line).event), ['alt_info']);
        assert.equal(events.list({ q: 'alt_info' }).events.length, 0, 'auch aus dem Suchindex entfernt');
    } finally {
        events.close();
        await fsp.rm(dir, { recursive: true, force: true });
    }
});

test('writeSettings validiert Grenzen und liefert die Aenderungen', () => {
    const events = memoryEvents();
    assert.equal(events.writeSettings({ infoDays: -1 }), null);
    assert.equal(events.writeSettings({ maxRows: 5 }), null);
    const { settings, changes } = events.writeSettings({ infoDays: '14', traceQueries: true });
    assert.equal(settings.infoDays, 14);
    assert.equal(settings.traceQueries, true);
    assert.deepEqual(changes.infoDays, { from: 30, to: 14 });
    events.close();
});

test('instrumentDatabase: DB-Fehler und langsame Abfragen werden Events, nie die Parameter', () => {
    const events = memoryEvents();
    const db = events.instrumentDatabase(openDatabase(':memory:'));
    assert.throws(() => db.prepare('SELECT * FROM gibt_es_nicht'));
    const error = events.list({ event: 'db_error' }).events[0];
    assert.equal(error.module, 'database');
    assert.match(error.payload.sql, /gibt_es_nicht/);
    assert.ok(error.errorStack);

    events.writeSettings({ slowQueryMs: 1, traceQueries: true });
    db.prepare("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 300000) SELECT SUM(x) FROM n WHERE ? = ?")
        .get('geheim@example.com', 'geheim@example.com');
    const slow = events.list({ event: 'db_slow_query' }).events[0];
    assert.ok(slow, 'langsame Abfrage erfasst');
    assert.ok(!JSON.stringify(slow).includes('geheim@example.com'));
    // Instrumentierung aendert das Verhalten nicht
    assert.equal(db.prepare('SELECT 1 AS one').get().one, 1);
    assert.equal(db.isOpen, true);
    db.close();
    events.close();
});

test('job(): Erfolg und Fehler mit Dauer und gemeinsamer Lauf-ID', async () => {
    const events = memoryEvents();
    await events.job('aufraeumen', async () => {
        events.record({ event: 'zwischendurch' });
        return { removed: 3 };
    });
    await assert.rejects(events.job('kaputt', async () => { throw new Error('nope'); }));

    const finished = events.list({ event: 'job_finished' }).events[0];
    assert.deepEqual(finished.payload.result, { removed: 3 });
    assert.equal(typeof finished.durationMs, 'number');
    const inside = events.list({ event: 'zwischendurch' }).events[0];
    assert.equal(inside.requestId, finished.requestId);
    assert.equal(inside.payload.job, 'aufraeumen');
    const failed = events.list({ event: 'job_failed' }).events[0];
    assert.equal(failed.severity, SEVERITY.ERROR);
    assert.match(failed.errorStack, /nope/);
    events.close();
});

test('importLegacyAudit uebernimmt audit_log-Zeilen einmalig und leert die Tabelle', () => {
    const events = memoryEvents();
    const db = openDatabase(':memory:');
    db.prepare('INSERT INTO audit_log (ts, event, detail_json) VALUES (?, ?, ?)')
        .run(1000, 'login_failed', '{"ip":"1.2.3.4","username":"x"}');
    db.prepare('INSERT INTO audit_log (ts, event, detail_json) VALUES (?, ?, ?)').run(2000, 'upload', 'kaputt');

    assert.equal(events.importLegacyAudit(db), 2);
    assert.equal(events.importLegacyAudit(db), 0);
    const entries = events.readAudit({ limit: Infinity });
    assert.deepEqual(entries.map(e => e.event), ['upload', 'login_failed']);
    assert.equal(entries[1].ip, '1.2.3.4');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n, 0);
    db.close();
    events.close();
});

/* =============================================================== Logger */

function capture() {
    const out = [];
    return { out, stdout: { write: c => out.push(c) }, stderr: { write: c => out.push(c) } };
}

test('Logger: Modul-Logger bleiben unter detailLevel von der Konsole fern, die Senke bekommt alles', () => {
    const c = capture();
    const log = createLogger({ format: 'pretty', level: 'info', detailLevel: 'warn', stdout: c.stdout, stderr: c.stderr });
    const sunk = [];
    log.info('frueh'); // vor attachSink -> gepuffert
    log.attachSink(entry => sunk.push(entry));

    const mail = log.child('mail');
    mail.info('Mail zugestellt', { event: 'mail_sent' });
    mail.warn('Server langsam');
    log.info('Server läuft');
    log.child('http', { sink: false }).error('request', { status: 500 });

    assert.deepEqual(c.out, ['frueh\n', '[mail] Server langsam\n', 'Server läuft\n', '[http] request {"status":500}\n']);
    assert.deepEqual(sunk.map(e => [e.module, e.msg]), [
        [null, 'frueh'], ['mail', 'Mail zugestellt'], ['mail', 'Server langsam'], [null, 'Server läuft'],
    ]);
});

test('Logger-Senke: Meldungen werden Events mit Modul, Schweregrad und Stacktrace', () => {
    const events = memoryEvents();
    const log = createLogger({ stdout: { write() {} }, stderr: { write() {} } });
    log.attachSink(events.fromLog);
    log.child('mail').info('zugestellt', { event: 'mail_sent', mailId: 7, durationMs: 12 });
    log.critical('Unbehandelte Ausnahme:', new Error('boom'));

    const [crit, sent] = events.list({}).events;
    assert.equal(sent.event, 'mail_sent');
    assert.equal(sent.module, 'mail');
    assert.equal(sent.durationMs, 12);
    assert.deepEqual(sent.payload, { mailId: 7 });
    assert.equal(crit.severity, SEVERITY.CRITICAL);
    assert.match(crit.errorStack, /boom/);
    events.close();
});

/* =============================================================== Routen */

test('/admin/logs verlangt Anmeldung; Requests landen mit vollem Kontext im Event-Log', async t => {
    const app = await startTestApp();
    t.after(() => app.close());

    const anon = await fetch(app.url('/admin/logs'), { redirect: 'manual' });
    assert.equal(anon.status, 302);

    const { cookie } = await app.login();
    const res = await fetch(app.url('/admin/files-gibt-es-nicht'), {
        headers: { cookie, 'User-Agent': 'TestAgent/1.0', 'X-Request-Id': 'req-kontext-1' },
    });
    assert.equal(res.status, 404);
    await new Promise(resolve => setTimeout(resolve, 50));

    const [event] = app.services.events.list({ requestId: 'req-kontext-1' }).events;
    assert.equal(event.event, 'http_request');
    assert.equal(event.status, 404);
    assert.equal(event.actorType, 'admin');
    assert.equal(event.actorId, 'admin');
    assert.equal(event.userAgent, 'TestAgent/1.0');
    assert.equal(event.ip, '127.0.0.1');
    assert.match(event.sessionHash, /^[0-9a-f]{16}$/);
    assert.ok(!cookie.includes(event.sessionHash), 'nie die Session-ID selbst');

    const page = await fetch(app.url('/admin/logs?range=1h'), { headers: { cookie } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Event-Log/);
    assert.match(html, /login_success/);
});

test('Detailansicht escaped Payloads; Query-Strings werden nie gespeichert', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();

    app.services.events.record({ event: 'xss_probe', message: '<script>alert(1)</script>', immediate: true });
    await fetch(app.url('/account/verify?token=GEHEIM123'));
    await new Promise(resolve => setTimeout(resolve, 50));
    app.services.events.flush();

    const [probe] = app.services.events.list({ event: 'xss_probe' }).events;
    const detail = await (await fetch(app.url(`/admin/logs/${probe.id}?partial=1`), { headers: { cookie } })).text();
    assert.ok(!detail.includes('<script>alert(1)</script>'));
    assert.ok(detail.includes('&lt;script&gt;'));

    const everything = JSON.stringify(app.services.events.list({ range: 'all' }, { limit: 1000 }).events);
    assert.ok(!everything.includes('GEHEIM123'));
    assert.ok(everything.includes('/account/verify'));
});

test('Export: CSV mit denselben Filtern, JSON als Array; der Export selbst wird protokolliert', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();
    app.services.events.record({ event: 'formel', message: '=cmd|calc', severity: SEVERITY.ERROR });

    const csv = await (await fetch(app.url('/admin/logs/export.csv?sev=error'), { headers: { cookie } })).text();
    const lines = csv.trim().split('\r\n');
    assert.match(lines[0], /^id;time_utc;time_local;severity;module;event/);
    assert.equal(lines.length, 2);
    // UTC eindeutig fuer Tools, daneben dieselbe Zeit in Europe/Berlin mit Versatz
    assert.match(lines[1], /^\d+;\d{4}-\d\d-\d\dT[\d:.]+Z;\d{4}-\d\d-\d\dT[\d:.]+\+0[12]:00;/);
    assert.ok(lines[1].includes("'=cmd|calc"));

    const res = await fetch(app.url('/admin/logs/export.json?q=formel'), { headers: { cookie } });
    assert.match(res.headers.get('content-disposition'), /attachment; filename="iso-share-events-.*\.json"/);
    const data = await res.json();
    assert.equal(data.length, 1);
    assert.equal(data[0].event, 'formel');

    const audit = await app.services.auditLog.read();
    assert.ok(audit.some(entry => entry.event === 'events_exported' && entry.format === 'csv' && entry.count === 1));
});

test('Archivregeln: speichern mit Vorher-Nachher im Audit, ungueltige Werte werden abgelehnt', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();
    const post = body => fetch(app.url('/admin/logs/settings'), {
        method: 'POST',
        redirect: 'manual',
        headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
    });
    const base = {
        debugDays: '3', infoDays: '14', warningDays: '90', errorDays: '365', criticalDays: '365',
        archiveDays: '365', maxRows: '1000000', slowQueryMs: '50',
    };

    const ok = await post({ ...base, storeDebug: '1' });
    assert.equal(ok.status, 302);
    const settings = app.services.events.readSettings();
    assert.equal(settings.infoDays, 14);
    assert.equal(settings.storeDebug, true);
    assert.equal(settings.archiveEnabled, false);
    const [entry] = (await app.services.auditLog.read()).filter(e => e.event === 'event_settings_changed');
    assert.deepEqual(entry.changes.infoDays, { from: 30, to: 14 });

    const bad = await post({ ...base, infoDays: '-5' });
    assert.equal(bad.status, 400);
    assert.equal(app.services.events.readSettings().infoDays, 14);
});

test('Rate-Limit: die erste abgewiesene Anfrage wird ein ip_blocked-Sicherheitsereignis, weitere nicht', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    for (let i = 0; i < 12; i++) await app.login('falsch');

    const blocked = app.services.events.list({ event: 'ip_blocked' }).events;
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].module, 'security');
    assert.equal(blocked[0].payload.limiter, 'login');
    assert.equal(blocked[0].ip, '127.0.0.1');
});

test('CSRF-Abweisung wird protokolliert', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const res = await fetch(app.url('/login'), {
        method: 'POST',
        headers: { Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'username=a&password=b',
    });
    assert.equal(res.status, 403);
    const [event] = app.services.events.list({ event: 'csrf_rejected' }).events;
    assert.equal(event.payload.sourceHost, 'evil.example');
});

test('Datei loeschen: CRUD-Ereignis mit Vorher-Zustand, Tag entfernen mit Vorher-Nachher', async t => {
    const app = await startTestApp();
    t.after(() => app.close());
    const { cookie } = await app.login();
    await fsp.writeFile(path.join(app.uploadsDir, 'a.iso'), 'x');
    await app.services.metadata.update('a.iso', { tags: ['BIOS', 'UEFI'], sha256: 'abc', downloads: 4 });

    const tagRes = await fetch(app.url('/files/a.iso/tags/UEFI'), { method: 'DELETE', headers: { cookie } });
    assert.equal(tagRes.status, 200);
    const tagEntry = (await app.services.auditLog.read()).find(e => e.event === 'tag_removed');
    assert.deepEqual(tagEntry.changes.tags, { from: ['BIOS', 'UEFI'], to: ['BIOS'] });

    await fetch(app.url('/delete'), {
        method: 'POST',
        redirect: 'manual',
        headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'filename=a.iso',
    });
    const [deleted] = app.services.events.list({ event: 'file_deleted' }).events;
    assert.equal(deleted.payload.before.downloads, 4);
    assert.equal(deleted.payload.before.sha256, 'abc');
    assert.equal(deleted.actorType, 'admin');
});
