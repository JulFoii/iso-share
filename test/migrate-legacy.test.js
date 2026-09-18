'use strict';

/*
 * Einheitentests fuer lib/move-file.js und lib/migrate-legacy.js — bislang
 * ohne jede Testabdeckung (siehe CLAUDE.md-Beschreibung beider Module).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const { moveFile } = require('../lib/move-file');
const { migrateLegacyData } = require('../lib/migrate-legacy');
const { openDatabase } = require('../lib/db');

const QUIET = { log() {}, warn() {}, error() {} };

async function tempDir() {
    return fsp.mkdtemp(path.join(os.tmpdir(), 'iso-share-migrate-'));
}

/* =============================================================== moveFile */

test('moveFile benennt eine Datei um (gleiches Verzeichnis)', async () => {
    const dir = await tempDir();
    const source = path.join(dir, 'a.iso');
    const target = path.join(dir, 'sub', 'b.iso');
    await fsp.mkdir(path.join(dir, 'sub'));
    await fsp.writeFile(source, 'inhalt');

    await moveFile(source, target);

    assert.equal(await fsp.readFile(target, 'utf8'), 'inhalt');
    await assert.rejects(() => fsp.access(source), { code: 'ENOENT' });

    await fsp.rm(dir, { recursive: true, force: true });
});

test('moveFile faellt bei EXDEV auf copyFile+rm zurueck', async t => {
    const dir = await tempDir();
    const source = path.join(dir, 'a.iso');
    const target = path.join(dir, 'b.iso');
    await fsp.writeFile(source, 'grenzueberschreitender inhalt');

    t.mock.method(fsp, 'rename', async () => {
        const err = new Error('cross-device link not permitted');
        err.code = 'EXDEV';
        throw err;
    });

    await moveFile(source, target);

    assert.equal(await fsp.readFile(target, 'utf8'), 'grenzueberschreitender inhalt');
    await assert.rejects(() => fsp.access(source), { code: 'ENOENT' }, 'Quelle muss nach dem Fallback weg sein');

    await fsp.rm(dir, { recursive: true, force: true });
});

test('moveFile reicht Fehler ausser EXDEV unveraendert durch (kein Fallback)', async () => {
    const dir = await tempDir();
    const source = path.join(dir, 'fehlt-gar-nicht.iso');
    const target = path.join(dir, 'b.iso');

    await assert.rejects(() => moveFile(source, target), err => err.code === 'ENOENT');
    // Kein Fallback-Artefakt am Ziel angelegt
    await assert.rejects(() => fsp.access(target), { code: 'ENOENT' });

    await fsp.rm(dir, { recursive: true, force: true });
});

/* ===================================================== migrateLegacyData */

async function setup() {
    const root = await tempDir();
    const uploadsDir = path.join(root, 'uploads');
    const dataDir = path.join(root, 'data');
    const tmpDir = path.join(root, 'tmp-uploads');
    const metaDir = path.join(uploadsDir, '.meta');
    await fsp.mkdir(metaDir, { recursive: true });
    await fsp.mkdir(dataDir, { recursive: true });
    await fsp.mkdir(tmpDir, { recursive: true });

    const db = openDatabase(':memory:');
    return {
        root, uploadsDir, dataDir, tmpDir, metaDir, db,
        cleanup: () => fsp.rm(root, { recursive: true, force: true }),
        run: () => migrateLegacyData({ db, uploadsDir, dataDir, tmpDir, log: QUIET }),
    };
}

test('migriert Datei-Metadaten, Passwort, Benutzername, Passkeys, TOTP, Audit-Log und laufende Uploads in einem Rutsch', async () => {
    const ctx = await setup();

    await fsp.writeFile(path.join(ctx.metaDir, 'a.iso.json'), JSON.stringify({
        name: 'a.iso',
        sha256: 'deadbeef',
        hashedAt: 111,
        size: 222,
        mtime: 333,
        iso: { volumeId: 'ARCHIV' },
        downloads: 5,
        tags: ['BIOS', 'ARCHIV'],
        autoTags: ['BIOS', 'ARCHIV'],
        removedAutoTags: [],
    }));

    await fsp.writeFile(path.join(ctx.dataDir, 'admin-password.json'), JSON.stringify({
        salt: 'c2FsdA', hash: 'aGFzaA',
    }));
    await fsp.writeFile(path.join(ctx.dataDir, 'admin-username.json'), JSON.stringify({
        username: 'julian',
    }));

    await fsp.writeFile(path.join(ctx.metaDir, 'webauthn.json'), JSON.stringify({
        userId: 'stable-user-id',
        credentials: [{
            credentialId: 'cred-1',
            publicKey: 'cHVia2V5',
            counter: 3,
            transports: ['internal'],
            label: 'Windows Hello',
            createdAt: 555,
            lastUsedAt: 999,
        }],
    }));

    await fsp.writeFile(path.join(ctx.metaDir, 'totp.json'), JSON.stringify({
        enabled: true,
        secret: 'JBSWY3DPEHPK3PXP',
        createdAt: 777,
        recoveryCodeHashes: ['hash-a', 'hash-b'],
    }));

    await fsp.writeFile(path.join(ctx.dataDir, 'audit.log'), [
        JSON.stringify({ ts: 1000, event: 'login_success', ip: '127.0.0.1' }),
        'diese Zeile ist kein JSON',
        JSON.stringify({ ts: 2000, event: 'upload', filename: 'a.iso' }),
        '',
    ].join('\n'));

    const sessionId = '11111111-1111-1111-1111-111111111111';
    await fsp.writeFile(path.join(ctx.tmpDir, `${sessionId}.json`), JSON.stringify({
        name: 'resume-mich.iso', size: 999, createdAt: 4242,
    }));
    await fsp.writeFile(path.join(ctx.tmpDir, `${sessionId}.part`), Buffer.alloc(100));

    const sessionsDir = path.join(ctx.dataDir, 'sessions');
    await fsp.mkdir(sessionsDir, { recursive: true });
    await fsp.writeFile(path.join(sessionsDir, 'irgendeine-sid.json'), '{}');

    await ctx.run();

    // files
    const fileRow = ctx.db.prepare('SELECT * FROM files WHERE name = ?').get('a.iso');
    assert.equal(fileRow.sha256, 'deadbeef');
    assert.equal(fileRow.downloads, 5);
    assert.deepEqual(JSON.parse(fileRow.tags_json), ['BIOS', 'ARCHIV']);
    assert.deepEqual(JSON.parse(fileRow.iso_json), { volumeId: 'ARCHIV' });

    // password / username
    const pw = ctx.db.prepare('SELECT * FROM admin_password WHERE id = 1').get();
    assert.equal(pw.salt, 'c2FsdA');
    assert.equal(pw.hash, 'aGFzaA');
    const username = ctx.db.prepare('SELECT username FROM admin_username WHERE id = 1').get();
    assert.equal(username.username, 'julian');

    // webauthn
    const user = ctx.db.prepare('SELECT user_id FROM webauthn_user WHERE id = 1').get();
    assert.equal(user.user_id, 'stable-user-id');
    const cred = ctx.db.prepare('SELECT * FROM webauthn_credentials WHERE credential_id = ?').get('cred-1');
    assert.equal(cred.public_key, 'cHVia2V5');
    assert.equal(cred.counter, 3);
    assert.deepEqual(JSON.parse(cred.transports_json), ['internal']);

    // totp
    const totp = ctx.db.prepare('SELECT * FROM totp WHERE id = 1').get();
    assert.equal(totp.secret, 'JBSWY3DPEHPK3PXP');
    const codes = ctx.db.prepare('SELECT hash FROM totp_recovery_codes ORDER BY hash').all();
    assert.deepEqual(codes.map(c => c.hash), ['hash-a', 'hash-b']);

    // audit log: kaputte Zeile uebersprungen, die zwei gueltigen migriert
    const auditRows = ctx.db.prepare('SELECT event, ts FROM audit_log ORDER BY ts').all();
    assert.deepEqual(auditRows.map(r => r.event), ['login_success', 'upload']);

    // laufende Upload-Sitzung
    const session = ctx.db.prepare('SELECT * FROM upload_sessions WHERE id = ?').get(sessionId);
    assert.equal(session.name, 'resume-mich.iso');
    assert.equal(session.size, 999);

    // alle Legacy-Dateien/-Ordner sind weg, nur die .part-Datei bleibt
    await assert.rejects(() => fsp.access(ctx.metaDir), { code: 'ENOENT' }, '.meta/ muss leer und entfernt sein');
    await assert.rejects(() => fsp.access(path.join(ctx.dataDir, 'admin-password.json')), { code: 'ENOENT' });
    await assert.rejects(() => fsp.access(path.join(ctx.dataDir, 'admin-username.json')), { code: 'ENOENT' });
    await assert.rejects(() => fsp.access(path.join(ctx.dataDir, 'audit.log')), { code: 'ENOENT' });
    await assert.rejects(() => fsp.access(path.join(ctx.tmpDir, `${sessionId}.json`)), { code: 'ENOENT' });
    await fsp.access(path.join(ctx.tmpDir, `${sessionId}.part`)); // wirft nicht -> existiert noch
    await assert.rejects(() => fsp.access(sessionsDir), { code: 'ENOENT' }, 'data/sessions/ muss komplett entfernt sein');

    await ctx.cleanup();
});

test('ein zweiter Lauf importiert nichts erneut, auch wenn Legacy-Dateien wieder auftauchen', async () => {
    const ctx = await setup();

    await fsp.writeFile(path.join(ctx.metaDir, 'a.iso.json'), JSON.stringify({
        name: 'a.iso', sha256: 'erste-version', downloads: 1,
    }));
    await ctx.run();
    assert.equal(ctx.db.prepare('SELECT sha256 FROM files WHERE name = ?').get('a.iso').sha256, 'erste-version');

    // Zwischenzeitlich hat die App den Datensatz veraendert (z. B. Downloads
    // hochgezaehlt) -- ein zweiter Migrationslauf darf das NICHT ueberschreiben.
    ctx.db.prepare('UPDATE files SET downloads = 99 WHERE name = ?').run('a.iso');

    // Eine Karteileiche taucht wieder auf (z. B. aus einem alten Backup)
    await fsp.mkdir(ctx.metaDir, { recursive: true });
    await fsp.writeFile(path.join(ctx.metaDir, 'a.iso.json'), JSON.stringify({
        name: 'a.iso', sha256: 'sollte-nicht-gewinnen', downloads: 0,
    }));

    await ctx.run();

    const row = ctx.db.prepare('SELECT sha256, downloads FROM files WHERE name = ?').get('a.iso');
    assert.equal(row.sha256, 'erste-version', 'ON CONFLICT DO NOTHING darf einen bestehenden Datensatz nicht ersetzen');
    assert.equal(row.downloads, 99);
    await assert.rejects(() => fsp.access(path.join(ctx.metaDir, 'a.iso.json')), { code: 'ENOENT' },
        'die wieder aufgetauchte Karteileiche muss trotzdem entsorgt werden');

    await ctx.cleanup();
});

test('kaputtes JSON in einer Datei-Metadaten-Karteileiche bleibt liegen, gueltige Eintraege werden trotzdem migriert', async () => {
    const ctx = await setup();

    await fsp.writeFile(path.join(ctx.metaDir, 'kaputt.iso.json'), '{ das ist kein json');
    await fsp.writeFile(path.join(ctx.metaDir, 'gut.iso.json'), JSON.stringify({ name: 'gut.iso', sha256: 'ok' }));

    const migrated = await ctx.run();
    void migrated;

    assert.ok(ctx.db.prepare('SELECT * FROM files WHERE name = ?').get('gut.iso'));
    assert.equal(ctx.db.prepare('SELECT * FROM files WHERE name = ?').get('kaputt.iso'), undefined);

    await fsp.access(path.join(ctx.metaDir, 'kaputt.iso.json')); // wirft nicht -> liegt weiterhin da
    await assert.rejects(() => fsp.access(path.join(ctx.metaDir, 'gut.iso.json')), { code: 'ENOENT' });

    await ctx.cleanup();
});

test('totp.json mit enabled:false wird aufgeraeumt, aber nichts importiert', async () => {
    const ctx = await setup();

    await fsp.writeFile(path.join(ctx.metaDir, 'totp.json'), JSON.stringify({
        enabled: false,
    }));

    await ctx.run();

    assert.equal(ctx.db.prepare('SELECT * FROM totp WHERE id = 1').get(), undefined);
    await assert.rejects(() => fsp.access(path.join(ctx.metaDir, 'totp.json')), { code: 'ENOENT' },
        'eine gueltige, aber inaktive Legacy-Datei darf nicht fuer immer liegen bleiben');

    await ctx.cleanup();
});

test('eine Upload-Sitzung ohne zugehoerige .part-Datei wird verworfen statt migriert', async () => {
    const ctx = await setup();

    const orphanId = '22222222-2222-2222-2222-222222222222';
    await fsp.writeFile(path.join(ctx.tmpDir, `${orphanId}.json`), JSON.stringify({
        name: 'verwaist.iso', size: 10, createdAt: Date.now(),
    }));
    // absichtlich keine <id>.part-Datei

    await ctx.run();

    assert.equal(ctx.db.prepare('SELECT * FROM upload_sessions WHERE id = ?').get(orphanId), undefined);
    await assert.rejects(() => fsp.access(path.join(ctx.tmpDir, `${orphanId}.json`)), { code: 'ENOENT' });

    await ctx.cleanup();
});

test('migrateLegacyData wirft nicht und tut nichts, wenn keine Legacy-Daten vorhanden sind', async () => {
    const ctx = await setup();
    // Verzeichnisse existieren, aber komplett leer

    await ctx.run();

    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM files').get().n, 0);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n, 0);

    await ctx.cleanup();
});

test('migrateLegacyData wirft nicht, wenn uploads-/data-/tmp-Verzeichnisse komplett fehlen', async () => {
    const root = await tempDir();
    const db = openDatabase(':memory:');

    await migrateLegacyData({
        db,
        uploadsDir: path.join(root, 'nie-angelegt', 'uploads'),
        dataDir: path.join(root, 'nie-angelegt', 'data'),
        tmpDir: path.join(root, 'nie-angelegt', 'tmp'),
        log: QUIET,
    });

    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM files').get().n, 0);
    await fsp.rm(root, { recursive: true, force: true });
});

test('audit.log-Import ist alles-oder-nichts: ein DB-Fehler mitten in der Schleife hinterlaesst keine Teilzeilen und loescht die Datei nicht', async () => {
    const ctx = await setup();

    await fsp.writeFile(path.join(ctx.dataDir, 'audit.log'), [
        JSON.stringify({ ts: 1, event: 'eins' }),
        JSON.stringify({ ts: 2, event: 'zwei' }),
        JSON.stringify({ ts: 3, event: 'drei' }),
    ].join('\n'));

    // Simuliert einen Absturz mitten in der Insert-Schleife (z. B. OOM/Kill):
    // der zweite INSERT auf audit_log schlaegt fehl.
    const originalPrepare = ctx.db.prepare.bind(ctx.db);
    let insertCalls = 0;
    ctx.db.prepare = sql => {
        const stmt = originalPrepare(sql);
        if (sql.includes('INSERT INTO audit_log')) {
            const originalRun = stmt.run.bind(stmt);
            stmt.run = (...args) => {
                insertCalls += 1;
                if (insertCalls === 2) throw new Error('simulierter Absturz mitten im Import');
                return originalRun(...args);
            };
        }
        return stmt;
    };

    await ctx.run(); // migrateLegacyData faengt den Fehler selbst ab und wirft nicht

    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n, 0,
        'ohne Transaktion wuerde hier eine einzelne Teilzeile committed sein');
    await fsp.access(path.join(ctx.dataDir, 'audit.log')); // wirft nicht -> Datei existiert noch fuer einen erneuten Versuch

    await ctx.cleanup();
});

test('audit.log wird bei bereits vorhandenen Zeilen nicht erneut importiert, die Datei aber trotzdem geloescht', async () => {
    const ctx = await setup();
    ctx.db.prepare('INSERT INTO audit_log (ts, event, detail_json) VALUES (?, ?, ?)').run(1, 'bereits_da', '{}');

    await fsp.writeFile(path.join(ctx.dataDir, 'audit.log'),
        JSON.stringify({ ts: 2000, event: 'sollte_nicht_importiert_werden' }));

    await ctx.run();

    const rows = ctx.db.prepare('SELECT event FROM audit_log').all();
    assert.deepEqual(rows.map(r => r.event), ['bereits_da']);
    await assert.rejects(() => fsp.access(path.join(ctx.dataDir, 'audit.log')), { code: 'ENOENT' });

    await ctx.cleanup();
});
