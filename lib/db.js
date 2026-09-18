'use strict';

/*
 * Eine einzige SQLite-Datenbank (data/iso-share.db) fuer alles, was frueher
 * als einzelne JSON-Dateien unter data/ und uploads/.meta/ lag: Datei-
 * Metadaten, Sitzungen, Passkeys, Admin-Passwort/-Benutzername, den
 * Session-Signierschluessel, TOTP und das Audit-Log. Nur die ISO-Dateien
 * selbst bleiben im Dateisystem — die gehoeren nicht in eine relationale
 * Datenbank.
 *
 * Bootstrap-Prinzip fuer sicherheitsrelevante Einzelwerte (Passwort,
 * Benutzername, Session-Secret): der aus Env-Var/Default berechnete Wert wird
 * beim allerersten Start, an dem die jeweilige Tabelle noch leer ist, sofort
 * in die DB geschrieben. Ab da gewinnt ausschliesslich die DB — eine
 * spaetere Aenderung der Env-Var hat keine Wirkung mehr, dieselbe Regel wie
 * fuer eine explizite Aenderung ueber die Admin-UI. Aendern geht danach nur
 * noch ueber die App (bzw. per Hand in der DB, siehe unten) — das ist
 * beabsichtigt: ein Geheimnis, das dauerhaft in einer Env-Var/.env-Datei
 * steht, ist im Produktivbetrieb die schlechtere Aufbewahrung.
 *
 * node:sqlite (DatabaseSync) statt einer Dependency wie better-sqlite3: seit
 * Node 22.5 im Core, synchron (kein Treiber-Overhead, keine zusaetzliche
 * Angriffsflaeche), passt damit zur kurz gehaltenen Abhaengigkeitsliste des
 * Projekts. Die Synchronitaet ist hier unproblematisch — anders als eine
 * *Sync-fs-Operation auf einer moeglicherweise riesigen ISO-Datei sind das
 * einzelne, indizierte Operationen auf einer kleinen eingebetteten DB
 * (Mikrosekunden), nicht Bytes einer 8-GB-Datei.
 *
 * WAL-Modus: Lesen blockiert Schreiben nicht (und umgekehrt), wichtig weil
 * derselbe Prozess parallel Downloads zaehlt, Sitzungen aktualisiert und
 * Checksummen im Hintergrund schreibt.
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS files (
        name TEXT PRIMARY KEY,
        sha256 TEXT,
        hashed_at INTEGER,
        size INTEGER,
        mtime INTEGER,
        iso_json TEXT,
        downloads INTEGER NOT NULL DEFAULT 0,
        tags_json TEXT NOT NULL DEFAULT '[]',
        auto_tags_json TEXT,
        removed_auto_tags_json TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        expires INTEGER NOT NULL,
        data_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires);

    CREATE TABLE IF NOT EXISTS webauthn_user (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        user_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS webauthn_credentials (
        credential_id TEXT PRIMARY KEY,
        public_key TEXT NOT NULL,
        counter INTEGER NOT NULL,
        transports_json TEXT NOT NULL DEFAULT '[]',
        label TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS session_secret (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        secret TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_password (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        salt TEXT NOT NULL,
        hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_username (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        username TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS totp (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        secret TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS totp_recovery_codes (
        hash TEXT PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS upload_sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        replaces TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        event TEXT NOT NULL,
        detail_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_log_ts ON audit_log(ts);

    CREATE TABLE IF NOT EXISTS api_tokens (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL,
        label TEXT,
        scopes_json TEXT NOT NULL DEFAULT '["read"]',
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS api_tokens_hash ON api_tokens(token_hash);
`;

/* Synchron wie DatabaseSync selbst — laeuft einmal beim App-Aufbau, nie in
   einem Request-Handler. ':memory:' (Tests) braucht kein Verzeichnis. */
function openDatabase(file) {
    if (file !== ':memory:') {
        fs.mkdirSync(path.dirname(file), { recursive: true });
    }
    const db = new DatabaseSync(file);
    db.exec(SCHEMA);

    // CREATE TABLE IF NOT EXISTS legt die Spalte nur in einer frischen DB an;
    // eine bereits bestehende upload_sessions-Tabelle (vor dem Explicit-
    // Replace-Feature) braucht sie nachtraeglich per ALTER TABLE.
    const uploadSessionColumns = db.prepare('PRAGMA table_info(upload_sessions)').all();
    if (!uploadSessionColumns.some(col => col.name === 'replaces')) {
        db.exec('ALTER TABLE upload_sessions ADD COLUMN replaces TEXT');
    }

    return db;
}

module.exports = { openDatabase };
