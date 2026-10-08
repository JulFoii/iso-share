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

/*
 * Verbindungs-Pragmas, bei jedem Oeffnen gesetzt (gelten nur fuer diese
 * Verbindung, werden nicht in der Datei gespeichert — ausser journal_mode):
 *  - WAL: Lesen blockiert Schreiben nicht, siehe oben.
 *  - synchronous=NORMAL: im WAL-Modus die empfohlene Stufe — ein Stromausfall
 *    kann hoechstens die allerletzten Transaktionen kosten, die Datei bleibt
 *    aber immer konsistent; FULL wuerde jeden Commit mit einem fsync bezahlen.
 *  - busy_timeout: wartet bis zu 5 s auf eine Sperre statt sofort mit
 *    SQLITE_BUSY zu scheitern — relevant, sobald ausser dieser App noch
 *    jemand die Datei oeffnet (DB-Browser, das node -e-Snippet aus CLAUDE.md,
 *    ein Backup-Tool auf dem Host).
 */
const PRAGMAS = `
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
`;

const SCHEMA = `

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

    CREATE TABLE IF NOT EXISTS backup_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        interval_minutes INTEGER NOT NULL DEFAULT 60,
        retention_count INTEGER NOT NULL DEFAULT 24,
        enabled INTEGER NOT NULL DEFAULT 1
    );
`;

/*
 * Ticketsystem mit Kundenkonten (siehe lib/customer-store.js,
 * lib/ticket-store.js, lib/mail-outbox.js). Eigener Block statt Teil von
 * SCHEMA, weil migratePrototypeTickets() unten eine aeltere tickets-Tabelle
 * (Gast-Tickets mit Token-Link) erst beiseiteraeumen muss, bevor diese
 * Definition greifen kann — sonst wuerde CREATE TABLE IF NOT EXISTS die alte
 * Tabelle stehen lassen und die Indizes auf den neuen Spalten scheitern.
 */
const TICKET_SCHEMA = `
    CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        name TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        email_verified_at INTEGER,
        disabled INTEGER NOT NULL DEFAULT 0,
        notify_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        last_login_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS customers_email ON customers(email);

    CREATE TABLE IF NOT EXISTS customer_tokens (
        token_hash TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL CHECK (purpose IN ('verify', 'reset', 'email_change')),
        payload TEXT,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS customer_tokens_customer ON customer_tokens(customer_id);

    CREATE TABLE IF NOT EXISTS ticket_categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        position INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY,
        number INTEGER NOT NULL UNIQUE,
        customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
        requester_email TEXT NOT NULL,
        requester_name TEXT,
        subject TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'new'
            CHECK (status IN ('new', 'open', 'pending', 'resolved', 'closed')),
        priority TEXT NOT NULL DEFAULT 'normal'
            CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
        category_id INTEGER REFERENCES ticket_categories(id) ON DELETE SET NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_customer_activity_at INTEGER,
        last_admin_activity_at INTEGER,
        first_response_at INTEGER,
        resolved_at INTEGER,
        closed_at INTEGER,
        customer_unread INTEGER NOT NULL DEFAULT 0,
        admin_unread INTEGER NOT NULL DEFAULT 1,
        reminder_sent_at INTEGER,
        rating INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
        rating_comment TEXT,
        rated_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS tickets_status ON tickets(status);
    CREATE INDEX IF NOT EXISTS tickets_customer ON tickets(customer_id);
    CREATE INDEX IF NOT EXISTS tickets_updated ON tickets(updated_at);

    CREATE TABLE IF NOT EXISTS ticket_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        author TEXT NOT NULL CHECK (author IN ('customer', 'admin', 'system')),
        kind TEXT NOT NULL CHECK (kind IN ('reply', 'note', 'event')),
        internal INTEGER NOT NULL DEFAULT 0,
        body TEXT NOT NULL,
        via TEXT NOT NULL DEFAULT 'web' CHECK (via IN ('web', 'email')),
        created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ticket_messages_ticket_id ON ticket_messages(ticket_id);

    CREATE TABLE IF NOT EXISTS ticket_attachments (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        message_id INTEGER REFERENCES ticket_messages(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ticket_attachments_ticket ON ticket_attachments(ticket_id);
    CREATE INDEX IF NOT EXISTS ticket_attachments_message ON ticket_attachments(message_id);

    CREATE TABLE IF NOT EXISTS canned_responses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ticket_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        pending_reminder_days INTEGER NOT NULL DEFAULT 3,
        pending_auto_resolve_days INTEGER NOT NULL DEFAULT 7,
        auto_close_days INTEGER NOT NULL DEFAULT 7
    );

    -- Anrede/Grussformel fuer Support-Antworten (lib/reply-template.js).
    -- Eigene Tabelle statt weiterer Spalten in ticket_settings, damit
    -- bestehende Datenbanken kein ALTER TABLE brauchen.
    CREATE TABLE IF NOT EXISTS ticket_reply_template (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        greeting TEXT NOT NULL,
        signature TEXT NOT NULL,
        agent_name TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS mail_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        to_addr TEXT NOT NULL,
        subject TEXT NOT NULL,
        text_body TEXT NOT NULL,
        html_body TEXT,
        headers_json TEXT NOT NULL DEFAULT '{}',
        ticket_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        next_attempt_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        sent_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS mail_outbox_due ON mail_outbox(status, next_attempt_at);

    -- Antwortfristen je Prioritaet (lib/ticket-config-store.js readSla()).
    -- NULL/0 = keine Frist. Fehlt eine Zeile, gelten die SLA_DEFAULTS.
    CREATE TABLE IF NOT EXISTS ticket_sla (
        priority TEXT PRIMARY KEY CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
        first_response_minutes INTEGER,
        next_response_minutes INTEGER
    );

    -- Wissensdatenbank / FAQ auf /support (lib/kb-store.js).
    CREATE TABLE IF NOT EXISTS kb_articles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        category_id INTEGER REFERENCES ticket_categories(id) ON DELETE SET NULL,
        published INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL DEFAULT 0,
        views INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );

    -- Mail-Eingang (lib/inbound-mail-store.js): schon verarbeitete Mails
    -- (Message-ID, gegen Doppelverarbeitung nach Absturz/Neustart),
    -- gedrosselte Hinweis-Mails (gegen Autoresponder-Schleifen) und der
    -- IMAP-UID-Stand je Postfach.
    CREATE TABLE IF NOT EXISTS inbound_mail_seen (
        key TEXT PRIMARY KEY,
        seen_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS inbound_mail_seen_at ON inbound_mail_seen(seen_at);
    CREATE TABLE IF NOT EXISTS inbound_mail_notices (
        key TEXT PRIMARY KEY,
        sent_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS imap_state (
        mailbox TEXT PRIMARY KEY,
        uid_validity TEXT NOT NULL,
        last_uid INTEGER NOT NULL
    );
`;

/*
 * Vor den Kundenkonten gab es einen Prototyp mit Gast-Tickets (Token-Link
 * statt Konto, Spalte token_hash, Nachrichten-Spalte sender). Dessen Tabellen
 * werden hier einmalig umbenannt, das neue Schema angelegt und der Inhalt
 * uebernommen: jedes Ticket bekommt eine fortlaufende Nummer, bleibt ohne
 * customer_id (requester_email haelt die Adresse) und wird automatisch einem
 * Konto zugeordnet, sobald sich jemand mit genau dieser Adresse registriert
 * und sie bestaetigt (siehe claimTicketsByEmail() in lib/ticket-store.js).
 * Erkennung ueber die Tabellenform statt einer Versionsnummer — laeuft also
 * genau einmal und ist danach ein No-op.
 */
function migratePrototypeTickets(db) {
    const columns = db.prepare('PRAGMA table_info(tickets)').all();
    const isPrototype = columns.some(col => col.name === 'token_hash');
    if (!isPrototype) {
        db.exec(TICKET_SCHEMA);
        return;
    }

    // Transaktion: kommt vom Migrations-Runner (applyMigrations unten)
    const statusMap = { open: 'open', answered: 'pending', closed: 'closed' };
    {
        db.exec('DROP INDEX IF EXISTS tickets_token_hash');
        db.exec('DROP INDEX IF EXISTS tickets_status');
        db.exec('DROP INDEX IF EXISTS ticket_messages_ticket_id');
        db.exec('ALTER TABLE tickets RENAME TO tickets_prototype');
        db.exec('ALTER TABLE ticket_messages RENAME TO ticket_messages_prototype');
        db.exec(TICKET_SCHEMA);

        const oldTickets = db.prepare('SELECT * FROM tickets_prototype ORDER BY created_at ASC').all();
        const insertTicket = db.prepare(`
            INSERT INTO tickets (id, number, requester_email, subject, status, created_at, updated_at,
                                 admin_unread, closed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
        `);
        const insertMessage = db.prepare(`
            INSERT INTO ticket_messages (ticket_id, author, kind, body, created_at)
            VALUES (?, ?, 'reply', ?, ?)
        `);
        const oldMessages = db.prepare(
            'SELECT * FROM ticket_messages_prototype WHERE ticket_id = ? ORDER BY created_at ASC, id ASC'
        );
        let number = 1000;
        for (const row of oldTickets) {
            number += 1;
            const status = statusMap[row.status] ?? 'open';
            insertTicket.run(
                row.id, number, String(row.email).toLowerCase(), row.subject, status,
                row.created_at, row.updated_at, status === 'closed' ? row.updated_at : null
            );
            for (const message of oldMessages.all(row.id)) {
                insertMessage.run(
                    row.id, message.sender === 'admin' ? 'admin' : 'customer', message.body, message.created_at
                );
            }
        }
        db.exec('DROP TABLE ticket_messages_prototype');
        db.exec('DROP TABLE tickets_prototype');
    }
}

function hasColumn(db, table, column) {
    return db.prepare(`PRAGMA table_info(${table})`).all().some(col => col.name === column);
}

/*
 * Versionierte Schema-Migrationen. Die aktuelle Version steht in
 * `PRAGMA user_version` der Datei selbst; beim Oeffnen laufen genau die
 * Migrationen mit hoeherer Nummer, jede in ihrer eigenen Transaktion
 * zusammen mit dem Hochzaehlen der Version — bricht eine ab, bleibt die DB
 * auf dem vorherigen, konsistenten Stand.
 *
 * Regeln fuer neue Eintraege: nur anhaengen (nie umnummerieren oder
 * nachtraeglich aendern), fortlaufend nummerieren. Neue Tabellen duerfen
 * weiterhin per CREATE TABLE IF NOT EXISTS in SCHEMA stehen; alles, was eine
 * *bestehende* Tabelle aendert (ALTER TABLE, Datenumbau), gehoert hierher.
 *
 * 3: Ticket-Erweiterungen (ISO-Bezug, Kanal, Zusammenfuehren, SLA-Meldung)
 * und Anhang-IDs in der Mail-Outbox.
 *
 * 1 und 2 sind die beiden Umbauten aus der Zeit vor der Versionierung. Sie
 * pruefen ihren Zielzustand selbst (Spalte vorhanden? Prototyp-Tabelle?),
 * weil eine bestehende DB mit user_version 0 sie teils schon hinter sich hat.
 */
const MIGRATIONS = [
    {
        version: 1,
        name: 'upload_sessions.replaces',
        up(db) {
            if (!hasColumn(db, 'upload_sessions', 'replaces')) {
                db.exec('ALTER TABLE upload_sessions ADD COLUMN replaces TEXT');
            }
        },
    },
    {
        version: 2,
        name: 'tickets: Gast-Prototyp -> Kundenkonten',
        up: migratePrototypeTickets,
    },
    {
        version: 3,
        name: 'tickets: ISO-Bezug, Kanal, Zusammenfuehren, SLA; Mail-Anhaenge',
        up(db) {
            const columns = [
                ['tickets', 'iso_file', 'TEXT'],
                ['tickets', 'source', "TEXT NOT NULL DEFAULT 'web'"],
                ['tickets', 'merged_into_id', 'TEXT'],
                ['tickets', 'sla_notified_at', 'INTEGER'],
                ['mail_outbox', 'attachments_json', "TEXT NOT NULL DEFAULT '[]'"],
            ];
            for (const [table, column, type] of columns) {
                if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
            }
            db.exec('CREATE INDEX IF NOT EXISTS tickets_iso_file ON tickets(iso_file)');
        },
    },
    {
        version: 4,
        name: 'tickets: Aufteilen (split_from_id)',
        up(db) {
            if (!hasColumn(db, 'tickets', 'split_from_id')) {
                db.exec('ALTER TABLE tickets ADD COLUMN split_from_id TEXT');
            }
            db.exec('CREATE INDEX IF NOT EXISTS tickets_split_from ON tickets(split_from_id)');
        },
    },
    {
        version: 5,
        name: 'tickets: Wiedervorlage (snoozed_until)',
        up(db) {
            if (!hasColumn(db, 'tickets', 'snoozed_until')) {
                db.exec('ALTER TABLE tickets ADD COLUMN snoozed_until INTEGER');
            }
            db.exec('CREATE INDEX IF NOT EXISTS tickets_snoozed ON tickets(snoozed_until)');
        },
    },
];

const SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

function schemaVersion(db) {
    return db.prepare('PRAGMA user_version').get().user_version;
}

/*
 * Wendet alle ausstehenden Migrationen an und liefert die Liste der
 * angewendeten Versionen. Eine Datei mit *hoeherer* Version als dieser Code
 * kennt (Rollback auf ein aelteres Image nach einem Update) wird abgelehnt,
 * statt sie mit einem veralteten Schema weiterzubenutzen — dann das neuere
 * Image starten oder ein Backup von vor dem Update zurueckspielen.
 */
function applyMigrations(db, migrations = MIGRATIONS) {
    const target = migrations.reduce((max, m) => Math.max(max, m.version), 0);
    const current = schemaVersion(db);
    if (current > target) {
        const err = new Error(
            `Datenbank-Schema ist Version ${current}, diese App-Version kennt nur bis ${target}. `
            + 'Die Datenbank stammt von einer neueren Version — bitte diese starten oder ein '
            + 'Backup von vor dem Update wiederherstellen.'
        );
        err.code = 'schema_too_new';
        throw err;
    }
    const applied = [];
    for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
        if (migration.version <= current) continue;
        db.exec('BEGIN IMMEDIATE');
        try {
            migration.up(db);
            // PRAGMA nimmt keine Parameter — version ist eine Zahl aus dem
            // Code, nie Nutzereingabe
            db.exec(`PRAGMA user_version = ${Number(migration.version)}`);
            db.exec('COMMIT');
        } catch (err) {
            db.exec('ROLLBACK');
            err.message = `Migration ${migration.version} (${migration.name}) fehlgeschlagen: ${err.message}`;
            throw err;
        }
        applied.push(migration.version);
    }
    return applied;
}

/*
 * Regelmaessige Pflege (aus server.js stuendlich aufgerufen): PRAGMA optimize
 * aktualisiert bei Bedarf die Statistiken des Query-Planers, ein passiver
 * WAL-Checkpoint haelt die -wal-Datei klein, ohne auf Leser zu warten.
 */
function maintainDatabase(db) {
    db.exec('PRAGMA optimize');
    db.exec('PRAGMA wal_checkpoint(PASSIVE)');
}

/* Synchron wie DatabaseSync selbst — laeuft einmal beim App-Aufbau, nie in
   einem Request-Handler. ':memory:' (Tests) braucht kein Verzeichnis. */
function openDatabase(file, { migrations = MIGRATIONS } = {}) {
    if (file !== ':memory:') {
        fs.mkdirSync(path.dirname(file), { recursive: true });
    }
    const db = new DatabaseSync(file);
    try {
        db.exec(PRAGMAS);
        db.exec(SCHEMA);
        applyMigrations(db, migrations);
        // Ticket-Tabellen: Migration 2 legt sie an (bzw. baut den Prototyp
        // um); CREATE ... IF NOT EXISTS hier ist danach ein No-op und legt
        // spaeter ergaenzte Ticket-Tabellen/-Indizes an.
        db.exec(TICKET_SCHEMA);
    } catch (err) {
        db.close();
        throw err;
    }
    return db;
}

module.exports = {
    openDatabase, applyMigrations, maintainDatabase, schemaVersion, MIGRATIONS, SCHEMA_VERSION,
};
