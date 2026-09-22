'use strict';

/*
 * Sicherungen der SQLite-Datenbank selbst (nicht der ISO-Dateien in
 * uploads/ — deren Sicherung bleibt Sache des Admins, siehe CLAUDE.md). Ein
 * Backup ist ein per `VACUUM INTO` erzeugter, konsistenter Snapshot der
 * laufenden Datenbank; bewusst nicht die neuere node:sqlite-backup()-
 * Funktion, die die in package.json deklarierte Node-Untergrenze
 * (>=22.5.0) stillschweigend anheben wuerde. VACUUM INTO ist seit SQLite
 * 3.27 Bordmittel, laeuft synchron auf der offenen DatabaseSync-Instanz
 * (wie jede andere Operation in diesem Projekt) und braucht die App dafuer
 * nicht zu stoppen.
 *
 * Zeitplan-Einstellungen (Intervall/Aufbewahrung/An-Aus) liegen in der
 * Tabelle `backup_settings` (eine Zeile) und sind reine Laufzeit-Werte ohne
 * Bootstrap-Env-Var, anders als Passwort/Secret — beim ersten Zugriff hier
 * wird per INSERT OR IGNORE eine Standardzeile angelegt.
 *
 * Dateinamen sind immer serverseitig aus einem Zeitstempel gebildet, nie
 * aus Nutzereingabe (safeBackupName in lib/safe-name.js prueft genau dieses
 * feste Format beim Zurueckkommen als Pfadparameter).
 *
 * restoreBackup() ist die einzige wirklich destruktive Operation hier: sie
 * schliesst die uebergebene DatabaseSync-Instanz und ersetzt die Live-
 * Datenbankdatei durch die gewaehlte Sicherung. Der Aufrufer (server.js)
 * ist danach dafuer verantwortlich, den Prozess kontrolliert zu beenden —
 * dieses Modul startet nichts neu, es tauscht nur die Datei aus.
 */

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');

const { sha256OfFile } = require('./hash-queue');
const { safeBackupName } = require('./safe-name');

const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 1440;
const MIN_RETENTION = 1;
const MAX_RETENTION = 500;

function timestampForFilename(date = new Date()) {
    const iso = date.toISOString(); // z.B. 2026-09-22T14:03:05.123Z
    return `${iso.slice(0, 10).replace(/-/g, '')}T${iso.slice(11, 19).replace(/:/g, '')}Z`;
}

/* Sekundenaufloesung reicht als Zeitstempel nicht, um zwei Sicherungen
   innerhalb derselben Sekunde auseinanderzuhalten — VACUUM INTO scheitert,
   wenn die Zieldatei schon existiert (z.B. ein zweiter Klick auf "Jetzt
   sichern" kurz nach dem ersten). Ein kurzer Zufalls-Suffix macht den
   Dateinamen trotzdem eindeutig, ohne die chronologische Sortierbarkeit zu
   verlieren (der Zeitstempel bleibt fuehrend). */
function backupFilename(reason, date = new Date()) {
    const prefix = reason === 'pre-restore' ? 'pre-restore-' : '';
    const suffix = crypto.randomBytes(3).toString('hex');
    return `${prefix}iso-share-${timestampForFilename(date)}-${suffix}.db`;
}

function createBackupStore({ db, backupDir, log = console }) {
    if (!db) throw new Error('backup store braucht eine db');
    if (!backupDir) throw new Error('backup store braucht ein backupDir');

    db.exec(`
        INSERT OR IGNORE INTO backup_settings (id, interval_minutes, retention_count, enabled)
        VALUES (1, 60, 24, 1)
    `);

    const readSettingsStmt = db.prepare(
        'SELECT interval_minutes, retention_count, enabled FROM backup_settings WHERE id = 1'
    );
    const writeSettingsStmt = db.prepare(
        'UPDATE backup_settings SET interval_minutes = ?, retention_count = ?, enabled = ? WHERE id = 1'
    );

    function readSettings() {
        const row = readSettingsStmt.get();
        return {
            intervalMinutes: row.interval_minutes,
            retentionCount: row.retention_count,
            enabled: Boolean(row.enabled),
        };
    }

    /* Grenzwerte werden geklemmt statt abgelehnt, ausser bei nicht-
       numerischer Eingabe (null zurueck) — dieselbe Grosszuegigkeit wie bei
       anderen Zahlen-Feldern in diesem Projekt. */
    function writeSettings({ intervalMinutes, retentionCount, enabled }) {
        const interval = Number(intervalMinutes);
        const retention = Number(retentionCount);
        if (!Number.isFinite(interval) || !Number.isFinite(retention)) return null;
        const clampedInterval = Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.round(interval)));
        const clampedRetention = Math.min(MAX_RETENTION, Math.max(MIN_RETENTION, Math.round(retention)));
        writeSettingsStmt.run(clampedInterval, clampedRetention, enabled ? 1 : 0);
        return readSettings();
    }

    async function ensureDir() {
        await fsp.mkdir(backupDir, { recursive: true });
    }

    /* Sicherungen mit dem Praefix pre-restore- entstehen als Sicherheitsnetz
       unmittelbar vor einer Wiederherstellung (siehe restoreBackup unten)
       und werden von der regulaeren Aufbewahrungs-Kuerzung bewusst
       ausgenommen — es gibt davon naturgemaess nur sehr wenige, und gerade
       die soll eine normale Rotation nicht unbemerkt wegraeumen. Loeschen
       geht weiterhin explizit ueber deleteBackup().
       Sortiert nach mtime statt nach Dateiname: der Zufalls-Suffix im Namen
       (siehe backupFilename) ist innerhalb derselben Sekunde nicht
       chronologisch, ein Sortieren nach Namen koennte dann die gerade erst
       erzeugte Sicherung faelschlich als "aelteste" kuerzen. */
    async function pruneOldBackups(retentionCount) {
        let entries;
        try {
            entries = await fsp.readdir(backupDir);
        } catch {
            return;
        }
        const names = entries.filter(name => safeBackupName(name) && !name.startsWith('pre-restore-'));
        const withStats = (await Promise.all(names.map(async name => {
            const stats = await fsp.stat(path.join(backupDir, name)).catch(() => null);
            return stats && { name, mtimeMs: stats.mtimeMs };
        }))).filter(Boolean);
        withStats.sort((a, b) => a.mtimeMs - b.mtimeMs);

        const excess = withStats.length - retentionCount;
        if (excess <= 0) return;

        for (const { name } of withStats.slice(0, excess)) {
            await fsp.unlink(path.join(backupDir, name)).catch(err => {
                log.error(`Aufbewahrungs-Kuerzung: ${name} konnte nicht geloescht werden:`, err.message);
            });
            await fsp.unlink(path.join(backupDir, name + '.sha256')).catch(() => {});
        }
    }

    /* Ein einziger Guard fuer beide destruktiven/langlaufenden Operationen
       (createBackup und restoreBackup) — restoreBackup haelt ihn ueber
       seine gesamte Dauer, nicht nur waehrend der eingebetteten
       Sicherheitskopie, sonst koennten zwei gleichzeitige Restore-
       Anfragen beide db.close() erreichen (siehe restoreBackup unten). */
    let running = false;

    /* Der eigentliche Kopiervorgang, ohne den running-Guard — createBackup()
       und restoreBackup() (fuer dessen Sicherheits-Snapshot) setzen den
       Guard jeweils selbst um ihren gesamten Ablauf, nicht nur um diesen
       Ausschnitt. */
    async function doCreateBackup(reason) {
        await ensureDir();
        const filename = backupFilename(reason);
        const destPath = path.join(backupDir, filename);

        db.prepare('VACUUM INTO ?').run(destPath);

        const sha256 = await sha256OfFile(destPath);
        await fsp.writeFile(destPath + '.sha256', sha256, 'utf8');

        if (reason !== 'pre-restore') {
            await pruneOldBackups(readSettings().retentionCount);
        }

        const stats = await fsp.stat(destPath);
        return { file: filename, size: stats.size, createdAt: stats.mtimeMs, sha256 };
    }

    /* reason: 'scheduled' | 'manual' | 'pre-restore' — nur fuer den
       Dateinamen relevant. */
    async function createBackup(reason = 'manual') {
        if (running) {
            const err = new Error('Es läuft bereits eine Sicherung oder Wiederherstellung.');
            err.code = 'backup_in_progress';
            throw err;
        }
        running = true;
        try {
            return await doCreateBackup(reason);
        } finally {
            running = false;
        }
    }

    async function listBackups() {
        await ensureDir();
        let entries;
        try {
            entries = await fsp.readdir(backupDir);
        } catch {
            return [];
        }
        const names = entries.filter(name => safeBackupName(name));
        const rows = await Promise.all(names.map(async name => {
            const filePath = path.join(backupDir, name);
            const stats = await fsp.stat(filePath);
            let sha256 = null;
            try {
                sha256 = (await fsp.readFile(filePath + '.sha256', 'utf8')).trim();
            } catch {
                // Sidecar fehlt (z.B. Backup von aussen kopiert) — Checksumme
                // bleibt unbekannt statt die Liste scheitern zu lassen.
            }
            return {
                file: name,
                size: stats.size,
                createdAt: stats.mtimeMs,
                sha256,
                preRestore: name.startsWith('pre-restore-'),
            };
        }));
        rows.sort((a, b) => b.createdAt - a.createdAt);
        return rows;
    }

    async function deleteBackup(filename) {
        const safe = safeBackupName(filename);
        if (!safe) return false;
        try {
            await fsp.unlink(path.join(backupDir, safe));
        } catch {
            return false;
        }
        await fsp.unlink(path.join(backupDir, safe + '.sha256')).catch(() => {});
        return true;
    }

    /* Rechnet die Checksumme der Backup-Datei neu und vergleicht sie mit
       dem beim Erstellen geschriebenen Sidecar — Grundlage dafuer, dass
       restoreBackup() nie eine beschaedigte oder manipulierte Datei
       einspielt. */
    async function verifyBackup(filename) {
        const safe = safeBackupName(filename);
        if (!safe) return { ok: false, reason: 'invalid_name' };
        const filePath = path.join(backupDir, safe);

        let expected;
        try {
            expected = (await fsp.readFile(filePath + '.sha256', 'utf8')).trim();
        } catch {
            return { ok: false, reason: 'missing_checksum' };
        }

        let actual;
        try {
            actual = await sha256OfFile(filePath);
        } catch {
            return { ok: false, reason: 'missing_file' };
        }

        return actual === expected
            ? { ok: true, sha256: actual }
            : { ok: false, reason: 'mismatch' };
    }

    /*
     * Ersetzt die Live-Datenbankdatei durch die gewaehlte Sicherung.
     * Ablauf:
     *   1. Checksumme der Sicherung pruefen — bei Abweichung wird nichts
     *      angefasst.
     *   2. Sicherheits-Snapshot der AKTUELLEN Datenbank anlegen (reason
     *      'pre-restore'), solange sie noch offen ist — macht diesen
     *      Vorgang selbst rueckgaengig machbar.
     *   3. db.close() — checkpointet den WAL und gibt die Datei frei.
     *   4. Sicherungsdatei ueber die Live-Datei kopieren (die Sicherung
     *      selbst bleibt in backupDir erhalten), verwaiste -wal/-shm-
     *      Dateien der alten DB entfernen.
     *
     * db ist danach geschlossen — der Aufrufer darf ihn nicht mehr
     * verwenden und muss den Prozess beenden, damit ein Neustart eine
     * frische DatabaseSync-Instanz auf der wiederhergestellten Datei
     * oeffnet (siehe server.js).
     *
     * Haelt den running-Guard ueber die GESAMTE Dauer (nicht nur waehrend
     * des Sicherheits-Snapshots) — sonst koennten zwei gleichzeitige
     * Restore-Anfragen beide bis db.close() durchkommen und um dieselbe
     * Zieldatei konkurrieren. Schlaegt der Dateitausch NACH db.close() fehl
     * (z.B. Festplatte voll waehrend fsp.copyFile), ist die DatabaseSync-
     * Instanz bereits unbrauchbar — der Fehler traegt dann `dbClosed: true`,
     * damit der Aufrufer (server.js) den Prozess trotzdem beendet, statt
     * mit einer dauerhaft geschlossenen DB weiterzulaufen.
     */
    async function restoreBackup(filename, { dbPath }) {
        const safe = safeBackupName(filename);
        if (!safe) {
            const err = new Error('Ungültiger Backup-Dateiname.');
            err.code = 'invalid_name';
            throw err;
        }

        const verification = await verifyBackup(safe);
        if (!verification.ok) {
            const err = new Error('Die Checksumme der Sicherung stimmt nicht.');
            err.code = verification.reason;
            throw err;
        }

        if (running) {
            const err = new Error('Es läuft bereits eine Sicherung oder Wiederherstellung.');
            err.code = 'backup_in_progress';
            throw err;
        }
        running = true;
        try {
            const safetySnapshot = await doCreateBackup('pre-restore');

            const srcPath = path.join(backupDir, safe);
            db.close();

            try {
                await fsp.copyFile(srcPath, dbPath);
                await fsp.rm(dbPath + '-wal', { force: true });
                await fsp.rm(dbPath + '-shm', { force: true });
            } catch (err) {
                err.dbClosed = true;
                throw err;
            }

            return { restoredFrom: safe, safetySnapshot: safetySnapshot.file };
        } finally {
            running = false;
        }
    }

    return {
        readSettings, writeSettings, createBackup, listBackups, deleteBackup, verifyBackup,
        restoreBackup,
    };
}

module.exports = {
    createBackupStore, MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES, MIN_RETENTION, MAX_RETENTION,
};
