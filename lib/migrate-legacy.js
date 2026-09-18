'use strict';

/*
 * Import aus dem alten Stand (JSON-Sidecars/-Dateien, vor dem Umstieg auf die
 * SQLite-Datenbank in lib/db.js) in die jeweilige Tabelle, aufgerufen bei
 * jedem `start()`.
 *
 * Zwei Faelle, klar getrennt:
 *   - Datensatz noch nicht in der DB, Legacy-Datei vorhanden -> importieren,
 *     dann die Datei loeschen.
 *   - Datensatz schon in der DB (aus einem frueheren Lauf), Legacy-Datei
 *     aber noch da -> NICHT erneut importieren (die DB koennte seither
 *     abweichen, z. B. ein hochgezaehlter Downloads-Zaehler — die Datei ist
 *     reine Karteileiche), sondern nur die Datei loeschen.
 * In beiden Faellen bleibt am Ende nur die Datenbank uebrig. Diese Trennung
 * ist bewusst, nicht nur ein einfaches "Tabelle leer? -> alles machen": sonst
 * wuerde ein Import, der aus irgendeinem Grund schon vor einem
 * Code-Update gelaufen ist (die Tabelle also nicht mehr leer ist), die
 * zugehoerige Legacy-Datei fuer immer liegen lassen, weil kein Start mehr
 * das Aufraeumen erreicht. Jeder einzelne Datensatz braucht also einen
 * ON CONFLICT ... DO NOTHING statt eines pauschalen Tabellen-leer-Checks vorn
 * an der ganzen Funktion.
 *
 * Sitzungen (express-session) werden bewusst NICHT migriert — sie sind
 * kurzlebig, ein einmaliges erneutes Einloggen nach dem Umstieg ist kein
 * nennenswerter Verlust. Der alte data/sessions/-Ordner wird trotzdem
 * geleert: er wird von keinem Code mehr gelesen (SqliteSessionStore kennt
 * nur die `sessions`-Tabelle) und wuerde sonst als tote Karteileiche liegen
 * bleiben, ohne dass ihn je wieder etwas aufraeumt.
 *
 * Ein Fehler in einem Teil darf die anderen nicht verhindern und niemals den
 * Start blockieren — derselbe Grundsatz wie beim Audit-Log.
 */

const fsp = require('fs/promises');
const path = require('path');

async function readJson(file) {
    try {
        const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

async function removeQuiet(file) {
    await fsp.rm(file, { force: true }).catch(() => {});
}

async function migrateFiles({ db, uploadsDir, log }) {
    const metaDir = path.join(uploadsDir, '.meta');
    let entries;
    try {
        entries = await fsp.readdir(metaDir);
    } catch {
        return 0;
    }

    const insert = db.prepare(`
        INSERT INTO files
            (name, sha256, hashed_at, size, mtime, iso_json, downloads, tags_json, auto_tags_json, removed_auto_tags_json)
        VALUES
            (@name, @sha256, @hashedAt, @size, @mtime, @isoJson, @downloads, @tagsJson, @autoTagsJson, @removedAutoTagsJson)
        ON CONFLICT(name) DO NOTHING
    `);

    let migrated = 0;
    for (const entry of entries) {
        if (!entry.endsWith('.iso.json')) continue; // webauthn.json/totp.json ausgenommen
        const file = path.join(metaDir, entry);
        const data = await readJson(file);
        if (!data || typeof data.name !== 'string') continue;
        const { changes } = insert.run({
            name: data.name,
            sha256: data.sha256 ?? null,
            hashedAt: data.hashedAt ?? null,
            size: data.size ?? null,
            mtime: data.mtime ?? null,
            isoJson: data.iso !== undefined ? JSON.stringify(data.iso) : null,
            downloads: data.downloads ?? 0,
            tagsJson: JSON.stringify(data.tags ?? []),
            autoTagsJson: data.autoTags !== undefined ? JSON.stringify(data.autoTags) : null,
            removedAutoTagsJson: JSON.stringify(data.removedAutoTags ?? []),
        });
        await removeQuiet(file); // in jedem Fall Karteileiche, ob gerade importiert oder schon vorher
        if (changes > 0) migrated++;
    }
    if (migrated > 0) log.log(`📦 ${migrated} Datei-Metadaten aus uploads/.meta/ in die Datenbank uebernommen.`);
    return migrated;
}

async function migratePassword({ db, dataDir, log }) {
    const file = path.join(dataDir, 'admin-password.json');
    const data = await readJson(file);
    if (!data || typeof data.salt !== 'string' || typeof data.hash !== 'string') return false;

    const { changes } = db.prepare(
        'INSERT INTO admin_password (id, salt, hash) VALUES (1, ?, ?) ON CONFLICT(id) DO NOTHING'
    ).run(data.salt, data.hash);
    await removeQuiet(file);
    if (changes > 0) log.log('📦 Admin-Passwort-Hash aus data/admin-password.json uebernommen.');
    return changes > 0;
}

async function migrateUsername({ db, dataDir, log }) {
    const file = path.join(dataDir, 'admin-username.json');
    const data = await readJson(file);
    if (!data || typeof data.username !== 'string') return false;

    const { changes } = db.prepare(
        'INSERT INTO admin_username (id, username) VALUES (1, ?) ON CONFLICT(id) DO NOTHING'
    ).run(data.username);
    await removeQuiet(file);
    if (changes > 0) log.log('📦 Admin-Benutzername aus data/admin-username.json uebernommen.');
    return changes > 0;
}

async function migrateWebauthn({ db, uploadsDir, log }) {
    const file = path.join(uploadsDir, '.meta', 'webauthn.json');
    const data = await readJson(file);
    if (!data) return false;

    let userMigrated = false;
    if (typeof data.userId === 'string') {
        const { changes } = db.prepare(
            'INSERT INTO webauthn_user (id, user_id) VALUES (1, ?) ON CONFLICT(id) DO NOTHING'
        ).run(data.userId);
        userMigrated = changes > 0;
    }
    const credentials = Array.isArray(data.credentials) ? data.credentials : [];
    const insert = db.prepare(`
        INSERT INTO webauthn_credentials
            (credential_id, public_key, counter, transports_json, label, created_at, last_used_at)
        VALUES (@credentialId, @publicKey, @counter, @transportsJson, @label, @createdAt, @lastUsedAt)
        ON CONFLICT(credential_id) DO NOTHING
    `);
    let credentialsMigrated = 0;
    for (const cred of credentials) {
        if (!cred || typeof cred.credentialId !== 'string') continue;
        const { changes } = insert.run({
            credentialId: cred.credentialId,
            publicKey: cred.publicKey,
            counter: cred.counter ?? 0,
            transportsJson: JSON.stringify(cred.transports ?? []),
            label: cred.label ?? null,
            createdAt: cred.createdAt ?? Date.now(),
            lastUsedAt: cred.lastUsedAt ?? null,
        });
        if (changes > 0) credentialsMigrated++;
    }
    await removeQuiet(file);
    if (userMigrated || credentialsMigrated > 0) {
        log.log(`📦 ${credentialsMigrated} Passkey(s) aus uploads/.meta/webauthn.json uebernommen.`);
    }
    return true;
}

async function migrateTotp({ db, uploadsDir, log }) {
    const file = path.join(uploadsDir, '.meta', 'totp.json');
    const data = await readJson(file);
    if (!data) return false; // fehlend oder kaputtes JSON -> nichts zu tun, Datei bleibt fuer manuelle Pruefung

    // data ist ein geparstes Objekt, aber TOTP war nie aktiviert (enabled:
    // false) oder das Secret fehlt -> Karteileiche wie bei migrateWebauthn,
    // trotzdem aufraeumen statt sie fuer immer liegen zu lassen.
    let migrated = false;
    if (data.enabled && typeof data.secret === 'string') {
        const { changes } = db.prepare(
            'INSERT INTO totp (id, secret, created_at) VALUES (1, ?, ?) ON CONFLICT(id) DO NOTHING'
        ).run(data.secret, data.createdAt ?? Date.now());
        if (changes > 0) {
            const insertCode = db.prepare('INSERT INTO totp_recovery_codes (hash) VALUES (?) ON CONFLICT DO NOTHING');
            for (const hash of Array.isArray(data.recoveryCodeHashes) ? data.recoveryCodeHashes : []) {
                insertCode.run(hash);
            }
            log.log('📦 TOTP-Zweitfaktor aus uploads/.meta/totp.json uebernommen.');
            migrated = true;
        }
    }
    await removeQuiet(file);
    return migrated;
}

async function migrateAuditLog({ db, dataDir, log }) {
    const file = path.join(dataDir, 'audit.log');
    let text;
    try {
        text = await fsp.readFile(file, 'utf8');
    } catch {
        return 0;
    }

    // audit_log hat keinen natuerlichen Unique-Key je Zeile (id ist ein
    // Autoincrement-Zaehler ohne Bezug zum Inhalt) — ein zweites Mal
    // importieren wuerde also Duplikate anlegen. Deshalb hier, anders als
    // oben, doch ein grober Tabellen-hat-schon-Zeilen-Check.
    const alreadyHasRows = Boolean(db.prepare('SELECT id FROM audit_log LIMIT 1').get());
    let migrated = 0;
    if (!alreadyHasRows) {
        // In einer Transaktion: stuerzt der Prozess mitten in der Schleife ab,
        // landet entweder alles oder nichts in der Tabelle. Ohne das wuerde ein
        // Absturz nach den ersten paar Zeilen beim naechsten Start als
        // "alreadyHasRows" durchgehen (Import wird uebersprungen), die Datei
        // aber trotzdem weiter unten geloescht — der Rest waere unwiederbringlich
        // weg.
        db.exec('BEGIN');
        try {
            const insert = db.prepare('INSERT INTO audit_log (ts, event, detail_json) VALUES (?, ?, ?)');
            for (const line of text.split('\n')) {
                if (!line.trim()) continue;
                // Nur das Parsen darf eine kaputte Zeile stillschweigend
                // ueberspringen — ein Fehler aus insert.run() selbst (z. B.
                // Platte voll) muss die Transaktion abbrechen statt als
                // "ungueltige Zeile" durchzugehen.
                let entry;
                try {
                    entry = JSON.parse(line);
                } catch {
                    continue;
                }
                const { ts, event, ...detail } = entry;
                if (typeof ts !== 'number' || typeof event !== 'string') continue;
                insert.run(ts, event, JSON.stringify(detail));
                migrated++;
            }
            db.exec('COMMIT');
        } catch (err) {
            db.exec('ROLLBACK');
            throw err;
        }
        if (migrated > 0) log.log(`📦 ${migrated} Audit-Log-Eintraege aus data/audit.log uebernommen.`);
    }
    await removeQuiet(file);
    return migrated;
}

/*
 * Laufende Chunk-Uploads (POST /upload/init + PATCH-Sitzungen, siehe
 * lib/chunked-upload.js) landeten vor dem Umstieg als <id>.json neben der
 * <id>.part-Datei in tmp-uploads/. Nur die kleine Buchhaltung (Name,
 * angekuendigte Groesse, Erstellzeit) wandert in die DB — die .part-Datei
 * mit den bereits hochgeladenen Bytes bleibt unveraendert liegen, ein Upload
 * kann nach dem Umstieg also ganz normal fortgesetzt werden statt neu zu
 * beginnen. Eine .json ohne zugehoerige .part (oder umgekehrt) ist Muell und
 * wird von uploadSessions.cleanupStale() beim naechsten Lauf entsorgt.
 */
async function migrateUploadSessions({ db, tmpDir, log }) {
    let entries;
    try {
        entries = await fsp.readdir(tmpDir);
    } catch {
        return 0;
    }

    const insert = db.prepare(
        'INSERT INTO upload_sessions (id, name, size, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING'
    );
    let migrated = 0;
    for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const id = entry.slice(0, -'.json'.length);
        const file = path.join(tmpDir, entry);
        const data = await readJson(file);
        if (!data || typeof data.name !== 'string' || !Number.isInteger(data.size)) {
            await removeQuiet(file);
            continue;
        }
        try {
            await fsp.access(path.join(tmpDir, `${id}.part`));
        } catch {
            await removeQuiet(file); // Sitzung ohne Chunk-Bytes -> nichts fortzusetzen
            continue;
        }
        const { changes } = insert.run(id, data.name, data.size, data.createdAt ?? Date.now());
        await removeQuiet(file);
        if (changes > 0) migrated++;
    }
    if (migrated > 0) log.log(`📦 ${migrated} laufende Upload-Sitzung(en) aus tmp-uploads/ uebernommen.`);
    return migrated;
}

/* Kein Migrationsziel (siehe oben) — nur Aufraeumen einer Karteileiche, die
   sonst nie wieder jemand entsorgt. */
async function cleanupLegacySessionFiles({ dataDir, log }) {
    const dir = path.join(dataDir, 'sessions');
    let entries;
    try {
        entries = await fsp.readdir(dir);
    } catch {
        return 0;
    }
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    if (entries.length > 0) {
        log.log(`🧹 ${entries.length} veraltete Sitzungsdatei(en) aus data/sessions/ entfernt (nicht migriert, siehe lib/session-store.js).`);
    }
    return entries.length;
}

async function migrateLegacyData({ db, uploadsDir, dataDir, tmpDir, log = console }) {
    try {
        await Promise.all([
            migrateFiles({ db, uploadsDir, log }),
            migratePassword({ db, dataDir, log }),
            migrateUsername({ db, dataDir, log }),
            migrateWebauthn({ db, uploadsDir, log }),
            migrateTotp({ db, uploadsDir, log }),
            migrateAuditLog({ db, dataDir, log }),
            migrateUploadSessions({ db, tmpDir, log }),
            cleanupLegacySessionFiles({ dataDir, log }),
        ]);
    } catch (err) {
        log.error('Legacy-Datenmigration teilweise fehlgeschlagen:', err.message);
    }

    // uploads/.meta/ war ausschliesslich Sidecar-Speicher; ist der Ordner nach
    // der Migration leer, kann er weg. Best-effort: ein nicht-leerer Ordner
    // (z. B. weil ein Import oben fehlgeschlagen ist) bleibt unangetastet.
    await fsp.rmdir(path.join(uploadsDir, '.meta')).catch(() => {});
}

module.exports = { migrateLegacyData };
