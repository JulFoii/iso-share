'use strict';

/*
 * Zentrales Event-Log: jedes Ereignis der App (Audit-Aktionen, HTTP-Requests,
 * Hintergrund-Jobs, DB-Auffaelligkeiten, Sicherheitsereignisse, Log-
 * Meldungen) als eine Zeile in einer EIGENEN SQLite-Datei
 * (DATA_DIR/events.db), getrennt von iso-share.db:
 *
 *  - das Log-Volumen konkurriert nicht um die Schreibsperre der Haupt-DB
 *    (Sessions, Tickets),
 *  - die DB-Sicherungen (VACUUM INTO, lib/backup-store.js) blaehen sich nicht
 *    auf,
 *  - ein Restore der Haupt-DB spielt keinen alten Stand ueber das Protokoll —
 *    der Restore selbst bleibt als Ereignis erhalten.
 *
 * Erfassung: record() baut die Zeile synchron (Kontext aus dem laufenden
 * Request via AsyncLocalStorage) und legt sie in eine Queue im Speicher. Ein
 * Timer schreibt alle `flushIntervalMs` bzw. ab `batchSize` Eintraegen alles
 * in EINER Transaktion — ein Request wartet also nie auf das Log. Audit-,
 * Sicherheits-(>= CRITICAL) Ereignisse werden sofort geschrieben (sie sind
 * selten, und ein direkt folgendes read() soll sie sehen). Die Queue ist
 * begrenzt: bei Ueberlauf fallen zuerst DEBUG/INFO-Eintraege weg (gezaehlt,
 * siehe `stats().dropped`, und in /metrics), WARNING und hoeher nie.
 *
 * Auswertung: `events_hourly` wird beim Schreiben mitgezaehlt (Modul x
 * Schweregrad x HTTP-Statusklasse je Stunde). Kennzahlen und Grafiken lesen
 * nur diese kleine Tabelle, nie die Rohdaten. Die Volltextsuche laeuft ueber
 * eine FTS5-Tabelle (contentless, nur die Suchtexte); ohne FTS5 faellt sie
 * auf LIKE zurueck. Geblaettert wird ueber die letzte gesehene id (Cursor),
 * nie per OFFSET.
 *
 * Datenschutz: Session-IDs nur als gekuerzter SHA-256, nie roh (im Export
 * waeren sie sonst ein Werkzeug zur Sitzungsuebernahme). Payloads laufen
 * durch redact(): Passwoerter, Tokens, Secrets, Hashes, Cookies werden
 * maskiert, ueberlange Werte gekuerzt. Query-Strings werden nie gespeichert
 * (dort stehen Einmal-Tokens), SQL-Parameter nie, nur der SQL-Text.
 * Loeschfristen je Schweregrad plus eigene Frist fuer Audit-Eintraege, siehe
 * purge(); die tatsaechlich wirksamen Fristen zeigt views/privacy.ejs.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { once } = require('events');
const { finished } = require('stream/promises');
const { AsyncLocalStorage } = require('async_hooks');
const { performance } = require('perf_hooks');
const { DatabaseSync } = require('node:sqlite');

const {
    SEVERITY, SEVERITY_BY_VALUE, LOG_LEVEL_SEVERITY, MODULE_KEYS, moduleFor, severityFor, outcomeFor, moduleForPath,
} = require('./event-catalog');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_PAYLOAD_CHARS = 16_000;
const MAX_STRING_CHARS = 2_000;
const MAX_STACK_CHARS = 16_000;
const MAX_UA_CHARS = 400;
const ROLLUP_KEEP_DAYS = 400;
const PURGE_BATCH = 5_000;
const UA_CACHE_MAX = 2_000;

const SCHEMA = `
    CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        severity INTEGER NOT NULL,
        module TEXT NOT NULL,
        event TEXT NOT NULL,
        audit INTEGER NOT NULL DEFAULT 0,
        outcome TEXT,
        actor_type TEXT,
        actor_id TEXT,
        session_hash TEXT,
        ip TEXT,
        ua_id INTEGER,
        request_id TEXT,
        method TEXT,
        path TEXT,
        status INTEGER,
        duration_ms REAL,
        message TEXT,
        payload_json TEXT,
        error_stack TEXT
    );
    CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
    CREATE INDEX IF NOT EXISTS events_severity_ts ON events(severity, ts);
    CREATE INDEX IF NOT EXISTS events_module_ts ON events(module, ts);
    CREATE INDEX IF NOT EXISTS events_event_ts ON events(event, ts);
    CREATE INDEX IF NOT EXISTS events_request ON events(request_id) WHERE request_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS events_audit ON events(id) WHERE audit = 1;

    CREATE TABLE IF NOT EXISTS user_agents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ua TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS events_hourly (
        bucket INTEGER NOT NULL,
        module TEXT NOT NULL,
        severity INTEGER NOT NULL,
        http_class INTEGER NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (bucket, module, severity, http_class)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS event_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        debug_days INTEGER NOT NULL,
        info_days INTEGER NOT NULL,
        warning_days INTEGER NOT NULL,
        error_days INTEGER NOT NULL,
        critical_days INTEGER NOT NULL,
        archive_enabled INTEGER NOT NULL,
        archive_days INTEGER NOT NULL,
        max_rows INTEGER NOT NULL,
        store_debug INTEGER NOT NULL,
        trace_queries INTEGER NOT NULL,
        slow_query_ms INTEGER NOT NULL,
        updated_at INTEGER
    );
`;

const FTS_SCHEMA = `
    CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(body, content='', contentless_delete=1);
    CREATE TRIGGER IF NOT EXISTS events_fts_delete AFTER DELETE ON events BEGIN
        DELETE FROM events_fts WHERE rowid = old.id;
    END;
`;

const DEFAULT_SETTINGS = Object.freeze({
    debugDays: 3,
    infoDays: 30,
    warningDays: 90,
    errorDays: 365,
    criticalDays: 365,
    archiveEnabled: false,
    archiveDays: 365,
    maxRows: 1_000_000,
    storeDebug: false,
    traceQueries: false,
    slowQueryMs: 50,
});

/* Grenzen fuer writeSettings(); Tage: 0 = nie loeschen */
const SETTING_LIMITS = {
    debugDays: [0, 3650], infoDays: [0, 3650], warningDays: [0, 3650], errorDays: [0, 3650],
    criticalDays: [0, 3650], archiveDays: [0, 3650], maxRows: [10_000, 50_000_000], slowQueryMs: [1, 60_000],
};

const SEVERITY_DAY_FIELDS = { 10: 'debugDays', 20: 'infoDays', 30: 'warningDays', 40: 'errorDays', 50: 'criticalDays' };

/* ------------------------------------------------------------ Hilfen -- */

// Schluessel, deren Werte nie ins Log gehoeren. Bewusst auf die *Endung*
// geprueft: `tokenId`/`hashStatus` bleiben lesbar, `token`/`passwordHash`
// nicht.
const SECRET_KEY = /(password|passwd|pass|secret|token|cookie|authorization|salt|hash|recoverycodes?|sid|otp|totp|apikey|privatekey|credential(publickey)?)$/i;
const SAFE_KEYS = new Set(['sha256', 'sessionhash']);

function truncate(value, max) {
    if (value === undefined || value === null) return null;
    const text = String(value);
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

function redact(value, depth = 0) {
    if (value === null || value === undefined) return value;
    if (depth > 6) return '[…]';
    if (typeof value === 'string') return truncate(value, MAX_STRING_CHARS);
    if (typeof value === 'bigint') return value.toString();
    if (typeof value !== 'object') return value;
    if (value instanceof Error) return { name: value.name, message: value.message, code: value.code };
    if (value instanceof Date) return value.toISOString();
    if (Buffer.isBuffer(value)) return `[${value.length} Byte]`;
    if (Array.isArray(value)) {
        const items = value.slice(0, 200).map(item => redact(item, depth + 1));
        if (value.length > 200) items.push(`[… ${value.length - 200} weitere]`);
        return items;
    }
    const out = {};
    for (const [key, val] of Object.entries(value)) {
        const lower = key.toLowerCase();
        out[key] = !SAFE_KEYS.has(lower) && SECRET_KEY.test(lower) && val !== null && val !== undefined && val !== ''
            ? '[redacted]'
            : redact(val, depth + 1);
    }
    return out;
}

/*
 * Vorher-Nachher-Vergleich fuer CRUD-Aenderungen: nur die geaenderten Felder,
 * sensible Werte maskiert (redact). `null` wenn sich nichts geaendert hat.
 */
function diff(before, after) {
    const a = before ?? {};
    const b = after ?? {};
    const changes = {};
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (JSON.stringify(a[key]) === JSON.stringify(b[key])) continue;
        const secret = !SAFE_KEYS.has(key.toLowerCase()) && SECRET_KEY.test(key.toLowerCase());
        changes[key] = secret
            ? { from: '[redacted]', to: '[redacted]' }
            : { from: redact(a[key] ?? null), to: redact(b[key] ?? null) };
    }
    return Object.keys(changes).length > 0 ? changes : null;
}

function stringifyPayload(payload) {
    if (payload === undefined || payload === null) return null;
    let json;
    try {
        json = JSON.stringify(redact(payload));
    } catch {
        json = JSON.stringify({ unserializable: true });
    }
    if (json === '{}' || json === '[]') return null;
    if (json.length > MAX_PAYLOAD_CHARS) {
        json = JSON.stringify({ truncated: true, preview: json.slice(0, MAX_PAYLOAD_CHARS) });
    }
    return json;
}

function hashSession(sessionId) {
    return crypto.createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 16);
}

function pathOf(req) {
    const raw = req.originalUrl ?? req.url ?? '';
    return truncate(raw.split('?')[0], 300);
}

/*
 * FTS5-Suchausdruck aus Nutzereingabe: jedes Wort als Phrase mit
 * Praefix-Suche, verknuepft per UND. Anfuehrungszeichen fliegen raus, damit
 * nie eine FTS5-Syntax aus der Eingabe entsteht.
 */
function ftsQuery(input) {
    const terms = String(input ?? '')
        .split(/\s+/)
        .map(term => term.replace(/"/g, '').trim())
        .filter(term => /[\p{L}\p{N}]/u.test(term))
        .slice(0, 8);
    if (terms.length === 0) return null;
    return terms.map(term => `"${term}"*`).join(' ');
}

function escapeLike(term) {
    return term.replace(/[\\%_]/g, char => `\\${char}`);
}

function settingsFromRow(row) {
    if (!row) return { ...DEFAULT_SETTINGS };
    return {
        debugDays: row.debug_days,
        infoDays: row.info_days,
        warningDays: row.warning_days,
        errorDays: row.error_days,
        criticalDays: row.critical_days,
        archiveEnabled: row.archive_enabled === 1,
        archiveDays: row.archive_days,
        maxRows: row.max_rows,
        storeDebug: row.store_debug === 1,
        traceQueries: row.trace_queries === 1,
        slowQueryMs: row.slow_query_ms,
        updatedAt: row.updated_at ?? null,
    };
}

function rowToEvent(row) {
    let payload = null;
    if (row.payload_json) {
        try {
            payload = JSON.parse(row.payload_json);
        } catch {
            payload = { raw: row.payload_json };
        }
    }
    return {
        id: row.id,
        ts: row.ts,
        severity: row.severity,
        severityKey: SEVERITY_BY_VALUE[row.severity]?.key ?? 'info',
        severityLabel: SEVERITY_BY_VALUE[row.severity]?.label ?? String(row.severity),
        module: row.module,
        event: row.event,
        audit: row.audit === 1,
        outcome: row.outcome,
        actorType: row.actor_type,
        actorId: row.actor_id,
        sessionHash: row.session_hash,
        ip: row.ip,
        userAgent: row.ua ?? null,
        requestId: row.request_id,
        method: row.method,
        path: row.path,
        status: row.status,
        durationMs: row.duration_ms,
        message: row.message,
        payload,
        errorStack: row.error_stack,
    };
}

/* ======================================================================== */

function createEventStore({
    file,
    now = Date.now,
    flushIntervalMs = 250,
    batchSize = 500,
    maxQueue = 10_000,
    // Frist fuer Audit-Eintraege in Tagen (0 = nie) — env-only wie bisher
    // (AUDIT_LOG_RETENTION_DAYS), nicht ueber die UI aenderbar
    auditDays = 90,
    archiveDir = null,
    // Anzeigename des Admins fuer actor_id (es gibt genau einen Admin)
    adminName = () => 'admin',
    // Letzte Instanz, wenn das Event-Log selbst nicht schreiben kann — nie
    // das eigene Logger-Objekt (dessen Senke fuehrt wieder hierher)
    fallback = console,
} = {}) {
    if (!file) throw new Error('event store braucht eine Datei');
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });

    const db = new DatabaseSync(file);
    db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;
    `);
    db.exec(SCHEMA);
    let ftsEnabled = true;
    try {
        db.exec(FTS_SCHEMA);
    } catch {
        ftsEnabled = false;
    }

    const als = new AsyncLocalStorage();

    /* --------------------------------------------------- Einstellungen -- */

    const readSettingsStmt = db.prepare('SELECT * FROM event_settings WHERE id = 1');
    const writeSettingsStmt = db.prepare(`
        INSERT INTO event_settings (id, debug_days, info_days, warning_days, error_days, critical_days,
            archive_enabled, archive_days, max_rows, store_debug, trace_queries, slow_query_ms, updated_at)
        VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            debug_days = excluded.debug_days, info_days = excluded.info_days,
            warning_days = excluded.warning_days, error_days = excluded.error_days,
            critical_days = excluded.critical_days, archive_enabled = excluded.archive_enabled,
            archive_days = excluded.archive_days, max_rows = excluded.max_rows,
            store_debug = excluded.store_debug, trace_queries = excluded.trace_queries,
            slow_query_ms = excluded.slow_query_ms, updated_at = excluded.updated_at
    `);
    // Im Speicher gehalten: record() und jede instrumentierte DB-Abfrage
    // fragen die Einstellungen ab, das darf keine eigene Query kosten
    let settings = settingsFromRow(readSettingsStmt.get());

    function readSettings() {
        return { ...settings, auditDays };
    }

    /*
     * Validiert und speichert; `null` bei ungueltigen Werten. Checkboxen
     * kommen als beliebiger truthy-Wert oder fehlen ganz.
     */
    function writeSettings(input) {
        const next = { ...settings };
        for (const [key, [min, max]] of Object.entries(SETTING_LIMITS)) {
            if (input[key] === undefined) continue;
            const value = Number(input[key]);
            if (!Number.isInteger(value) || value < min || value > max) return null;
            next[key] = value;
        }
        for (const key of ['archiveEnabled', 'storeDebug', 'traceQueries']) {
            if (input[key] !== undefined) next[key] = Boolean(input[key]) && input[key] !== '0' && input[key] !== 'false';
        }
        writeSettingsStmt.run(
            next.debugDays, next.infoDays, next.warningDays, next.errorDays, next.criticalDays,
            next.archiveEnabled ? 1 : 0, next.archiveDays, next.maxRows,
            next.storeDebug ? 1 : 0, next.traceQueries ? 1 : 0, next.slowQueryMs, now()
        );
        const before = settings;
        settings = settingsFromRow(readSettingsStmt.get());
        return { settings: readSettings(), changes: diff(before, settings) };
    }

    /* ----------------------------------------------------- Schreibpfad -- */

    const insertStmt = db.prepare(`
        INSERT INTO events (ts, severity, module, event, audit, outcome, actor_type, actor_id, session_hash,
            ip, ua_id, request_id, method, path, status, duration_ms, message, payload_json, error_stack)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFtsStmt = ftsEnabled ? db.prepare('INSERT INTO events_fts (rowid, body) VALUES (?, ?)') : null;
    const findUaStmt = db.prepare('SELECT id FROM user_agents WHERE ua = ?');
    const insertUaStmt = db.prepare('INSERT INTO user_agents (ua) VALUES (?)');
    const rollupStmt = db.prepare(`
        INSERT INTO events_hourly (bucket, module, severity, http_class, count) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(bucket, module, severity, http_class) DO UPDATE SET count = count + excluded.count
    `);

    const uaCache = new Map();
    function uaId(ua) {
        if (!ua) return null;
        const cached = uaCache.get(ua);
        if (cached !== undefined) return cached;
        const id = findUaStmt.get(ua)?.id ?? Number(insertUaStmt.run(ua).lastInsertRowid);
        if (uaCache.size >= UA_CACHE_MAX) uaCache.clear();
        uaCache.set(ua, id);
        return id;
    }

    const queue = [];
    let timer = null;
    let closed = false;
    const counters = { recorded: 0, written: 0, dropped: 0, writeFailures: 0 };
    let lastFallbackAt = 0;

    function reportFailure(err, lost) {
        counters.writeFailures++;
        // Hoechstens einmal pro Minute auf die Konsole, sonst floetet ein
        // defektes Volume genau den Spam hinein, den das Event-Log vermeiden soll
        if (now() - lastFallbackAt > 60_000) {
            lastFallbackAt = now();
            fallback.error?.(`Event-Log: ${lost} Eintrag/Eintraege konnten nicht gespeichert werden:`, err.message);
        }
    }

    function flush() {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        if (queue.length === 0 || closed) return 0;
        const batch = queue.splice(0, queue.length);
        const rollup = new Map();
        try {
            db.exec('BEGIN IMMEDIATE');
            for (const row of batch) {
                const info = insertStmt.run(
                    row.ts, row.severity, row.module, row.event, row.audit ? 1 : 0, row.outcome,
                    row.actorType, row.actorId, row.sessionHash, row.ip, uaId(row.ua), row.requestId,
                    row.method, row.path, row.status, row.durationMs, row.message, row.payloadJson, row.errorStack
                );
                if (insertFtsStmt) {
                    insertFtsStmt.run(info.lastInsertRowid, [
                        row.event, row.message, row.path, row.ip, row.actorId, row.requestId,
                        row.payloadJson ? row.payloadJson.slice(0, 4000) : null,
                        row.errorStack ? row.errorStack.slice(0, 1000) : null,
                    ].filter(Boolean).join(' '));
                }
                const httpClass = row.status ? Math.floor(row.status / 100) : 0;
                const key = `${Math.floor(row.ts / HOUR_MS)}|${row.module}|${row.severity}|${httpClass}`;
                rollup.set(key, (rollup.get(key) ?? 0) + 1);
            }
            for (const [key, count] of rollup) {
                const [bucket, module, severity, httpClass] = key.split('|');
                rollupStmt.run(Number(bucket), module, Number(severity), Number(httpClass), count);
            }
            db.exec('COMMIT');
            counters.written += batch.length;
            return batch.length;
        } catch (err) {
            try {
                db.exec('ROLLBACK');
            } catch { /* keine offene Transaktion */ }
            uaCache.clear();
            reportFailure(err, batch.length);
            return 0;
        }
    }

    function schedule() {
        if (timer || closed) return;
        timer = setTimeout(flush, flushIntervalMs);
        if (typeof timer.unref === 'function') timer.unref();
    }

    function enqueue(row, { immediate = false } = {}) {
        if (closed) {
            // Nach dem Herunterfahren nur noch Kritisches auf die Konsole —
            // Nachzuegler (Abfragen auf die schon geschlossene DB) waeren Rauschen
            if (row.severity >= SEVERITY.CRITICAL) fallback.error?.(`[${row.module}] ${row.event}: ${row.message ?? ''}`);
            return;
        }
        counters.recorded++;
        if (queue.length >= maxQueue) {
            if (row.severity <= SEVERITY.INFO && !row.audit) {
                counters.dropped++;
                return;
            }
            const victim = queue.findIndex(item => item.severity <= SEVERITY.INFO && !item.audit);
            if (victim >= 0) {
                queue.splice(victim, 1);
                counters.dropped++;
            }
        }
        queue.push(row);
        if (immediate || row.audit || row.severity >= SEVERITY.CRITICAL || queue.length >= batchSize) {
            flush();
        } else {
            schedule();
        }
    }

    /* ------------------------------------------------------- Kontext -- */

    function actorOf(req) {
        if (!req) return { actorType: 'system', actorId: null };
        if (req.apiToken) return { actorType: 'token', actorId: String(req.apiToken.id) };
        const session = req.session;
        if (session?.loggedIn) return { actorType: 'admin', actorId: adminName() };
        if (session?.customerId) return { actorType: 'customer', actorId: String(session.customerId) };
        return { actorType: 'anonymous', actorId: null };
    }

    function contextOf(req) {
        const store = als.getStore();
        const source = req ?? store?.req ?? null;
        if (!source) {
            return { actorType: 'system', actorId: null, requestId: store?.runId ?? null, job: store?.job ?? null };
        }
        const session = source.session;
        const authenticated = session && (session.loggedIn || session.customerId || session.pendingTotp);
        return {
            ...actorOf(source),
            ip: source.ip ?? null,
            ua: truncate(typeof source.get === 'function' ? source.get('user-agent') : null, MAX_UA_CHARS),
            requestId: source.id ?? null,
            method: source.method ?? null,
            path: pathOf(source),
            sessionHash: authenticated && source.sessionID ? hashSession(source.sessionID) : null,
        };
    }

    /*
     * Ein Ereignis erfassen. Pflicht ist nur `event`; alles andere hat
     * Defaults oder kommt aus dem Request-Kontext. `force` speichert DEBUG
     * auch dann, wenn DEBUG-Speicherung aus ist (Query-Tracing).
     */
    function record({
        event, module = 'system', severity = SEVERITY.INFO, message = null, payload = null, error = null,
        audit = false, outcome = null, req = null, status = null, durationMs = null, ip, ts,
        immediate = false, force = false,
    }) {
        try {
            if (!event) return;
            if (severity < SEVERITY.INFO && !settings.storeDebug && !force) return;
            const ctx = contextOf(req);
            let payloadData = payload;
            if (ctx.job) payloadData = { job: ctx.job, ...(payloadData ?? {}) };
            let stack = null;
            if (error) {
                const err = error instanceof Error ? error : new Error(String(error));
                stack = truncate(err.stack || `${err.name}: ${err.message}`, MAX_STACK_CHARS);
                payloadData = { ...(payloadData ?? {}), error: { name: err.name, message: err.message, code: err.code } };
                if (!message) message = err.message;
            }
            enqueue({
                ts: ts ?? now(),
                severity,
                module: MODULE_KEYS.has(module) ? module : 'system',
                event: truncate(event, 100),
                audit,
                outcome,
                actorType: ctx.actorType ?? null,
                actorId: truncate(ctx.actorId, 200),
                sessionHash: ctx.sessionHash ?? null,
                ip: ip !== undefined ? ip : (ctx.ip ?? null),
                ua: ctx.ua ?? null,
                requestId: ctx.requestId ?? null,
                method: ctx.method ?? null,
                path: ctx.path ?? null,
                status,
                durationMs: durationMs === null || durationMs === undefined ? null : Math.round(durationMs * 10) / 10,
                message: truncate(message, MAX_STRING_CHARS),
                payloadJson: stringifyPayload(payloadData),
                errorStack: stack,
            }, { immediate });
        } catch (err) {
            // Das Protokollieren darf nie die eigentliche Aktion scheitern lassen
            reportFailure(err, 1);
        }
    }

    /* Adapter fuer lib/audit-log.js: bisherige Aufrufe auditLog.log(event, detail) */
    function audit(event, detail = {}) {
        try {
            if (typeof event !== 'string' || !event) return;
            const { ip, ...rest } = detail ?? {};
            record({
                event,
                module: moduleFor(event),
                severity: severityFor(event),
                audit: true,
                outcome: outcomeFor(event),
                payload: rest,
                ...(ip !== undefined ? { ip } : {}),
            });
        } catch (err) {
            // wie record(): das Protokollieren darf die Aktion nie scheitern lassen
            reportFailure(err, 1);
        }
    }

    const POLL_PATH = /\/(partials\/listing|partials\/nav|updates|pulse|ping)$/;

    function recordRequest(req, res, durationMs, { aborted = false } = {}) {
        const status = aborted ? null : res.statusCode;
        const path = pathOf(req);
        const background = req.get?.('x-idle-background') === '1' || POLL_PATH.test(path);
        let severity = SEVERITY.INFO;
        if (aborted) severity = SEVERITY.INFO;
        else if (status >= 500) severity = SEVERITY.ERROR;
        else if (status === 401 || status === 403 || status === 429) severity = SEVERITY.WARNING;
        else if (background && status < 400) severity = SEVERITY.DEBUG;
        const bytes = Number(res.get?.('content-length')) || undefined;
        record({
            event: aborted ? 'http_aborted' : 'http_request',
            module: moduleForPath(path),
            severity,
            outcome: aborted ? 'failure' : (status < 400 ? 'success' : 'failure'),
            message: aborted ? `${req.method} ${path} abgebrochen` : `${req.method} ${path} → ${status}`,
            payload: bytes ? { bytes } : null,
            req,
            status,
            durationMs,
        });
    }

    /* Senke fuer lib/logger.js: jede Log-Meldung wird ein Ereignis */
    function fromLog({ level, msg, fields, error, module, time }) {
        const { event, durationMs, ...rest } = fields ?? {};
        record({
            event: event || 'log',
            module: module || 'system',
            severity: LOG_LEVEL_SEVERITY[level] ?? SEVERITY.INFO,
            message: msg || null,
            payload: Object.keys(rest).length > 0 ? rest : null,
            error,
            durationMs: typeof durationMs === 'number' ? durationMs : null,
            ts: time ? time.getTime() : undefined,
        });
    }

    /* Express-Middleware: macht den Request fuer record() ohne Durchreichen verfuegbar */
    function middleware() {
        return function eventContext(req, res, next) {
            als.run({ req }, next);
        };
    }

    /*
     * Hintergrund-Job mit Start/Ende/Dauer/Fehler protokollieren. Alle
     * Ereignisse waehrend des Laufs tragen dieselbe Lauf-ID in request_id —
     * "alle Events dieses Laufs" funktioniert damit wie bei einem Request.
     * `quiet` fuer Jobs, die im Minutentakt laufen: ein erfolgreicher Lauf
     * ist dann nur DEBUG.
     */
    async function job(name, fn, { quiet = false, module = 'jobs' } = {}) {
        const runId = `job-${crypto.randomUUID().slice(0, 8)}`;
        const started = performance.now();
        return als.run({ job: name, runId }, async () => {
            try {
                const result = await fn();
                record({
                    event: 'job_finished', module, severity: quiet ? SEVERITY.DEBUG : SEVERITY.INFO,
                    outcome: 'success', message: `Job „${name}“ abgeschlossen`,
                    payload: result && typeof result === 'object' ? { result } : null,
                    durationMs: performance.now() - started,
                });
                return result;
            } catch (err) {
                record({
                    event: 'job_failed', module, severity: SEVERITY.ERROR, outcome: 'failure',
                    message: `Job „${name}“ fehlgeschlagen: ${err.message}`, error: err,
                    durationMs: performance.now() - started,
                });
                throw err;
            }
        });
    }

    /*
     * Haupt-DB instrumentieren: Proxy um DatabaseSync, der jede Abfrage
     * misst. Protokolliert werden langsame Abfragen (> slowQueryMs, WARNING)
     * und Fehler (ERROR, mit Stack); bei eingeschaltetem Query-Tracing jede
     * Abfrage als DEBUG. Nie die Parameter — dort stehen E-Mail-Adressen,
     * Token-Hashes, Nachrichten. Die Event-DB selbst wird nicht instrumen-
     * tiert, sonst erzeugte jedes geschriebene Event ein weiteres.
     */
    function instrumentDatabase(target) {
        const TIMED = new Set(['run', 'get', 'all', 'iterate']);

        function observe(sql, op, fn) {
            const started = performance.now();
            try {
                const result = fn();
                const elapsed = performance.now() - started;
                if (elapsed >= settings.slowQueryMs) {
                    record({
                        event: 'db_slow_query', module: 'database', severity: SEVERITY.WARNING,
                        message: `Langsame Abfrage (${Math.round(elapsed)} ms)`,
                        payload: { op, sql: truncate(sql, 500) }, durationMs: elapsed,
                    });
                } else if (settings.traceQueries) {
                    record({
                        event: 'db_query', module: 'database', severity: SEVERITY.DEBUG, force: true,
                        payload: { op, sql: truncate(sql, 500) }, durationMs: elapsed,
                    });
                }
                return result;
            } catch (err) {
                record({
                    event: 'db_error', module: 'database', severity: SEVERITY.ERROR, outcome: 'failure',
                    message: `Datenbankfehler: ${err.message}`, payload: { op, sql: truncate(sql, 500) },
                    error: err, durationMs: performance.now() - started,
                });
                throw err;
            }
        }

        function wrapStatement(statement, sql) {
            return new Proxy(statement, {
                get(stmt, prop) {
                    const value = Reflect.get(stmt, prop, stmt);
                    if (typeof value !== 'function') return value;
                    if (TIMED.has(prop)) {
                        return (...args) => observe(sql, prop, () => value.apply(stmt, args));
                    }
                    return value.bind(stmt);
                },
            });
        }

        return new Proxy(target, {
            get(dbTarget, prop) {
                const value = Reflect.get(dbTarget, prop, dbTarget);
                if (typeof value !== 'function') return value;
                if (prop === 'prepare') {
                    return sql => {
                        const statement = observe(sql, 'prepare', () => value.call(dbTarget, sql));
                        return wrapStatement(statement, sql);
                    };
                }
                if (prop === 'exec') {
                    return sql => observe(sql, 'exec', () => value.call(dbTarget, sql));
                }
                return value.bind(dbTarget);
            },
        });
    }

    /* -------------------------------------------------------- Abfragen -- */

    const getStmt = db.prepare(`
        SELECT e.*, u.ua FROM events e LEFT JOIN user_agents u ON u.id = e.ua_id WHERE e.id = ?
    `);

    /*
     * Filter -> WHERE-Klausel. Nur Platzhalter, nie Nutzereingabe im SQL-
     * Text; Listen (Schweregrade, Module) werden vorher gegen die bekannten
     * Werte gefiltert.
     */
    function buildWhere(filters = {}) {
        const where = [];
        const params = [];
        if (filters.from) { where.push('e.ts >= ?'); params.push(Number(filters.from)); }
        if (filters.to) { where.push('e.ts <= ?'); params.push(Number(filters.to)); }
        const severities = (filters.severities ?? []).filter(value => SEVERITY_BY_VALUE[value]);
        if (severities.length > 0) {
            where.push(`e.severity IN (${severities.map(() => '?').join(',')})`);
            params.push(...severities);
        } else if (filters.minSeverity) {
            where.push('e.severity >= ?');
            params.push(Number(filters.minSeverity));
        }
        const modules = (filters.modules ?? []).filter(value => MODULE_KEYS.has(value));
        if (modules.length > 0) {
            where.push(`e.module IN (${modules.map(() => '?').join(',')})`);
            params.push(...modules);
        }
        if (filters.audit) where.push('e.audit = 1');
        if (filters.event) { where.push('e.event = ?'); params.push(String(filters.event)); }
        if (filters.requestId) { where.push('e.request_id = ?'); params.push(String(filters.requestId)); }
        if (filters.ip) { where.push('e.ip = ?'); params.push(String(filters.ip)); }
        if (filters.actorType) { where.push('e.actor_type = ?'); params.push(String(filters.actorType)); }
        if (filters.before) { where.push('e.id < ?'); params.push(Number(filters.before)); }
        if (filters.q) {
            const match = ftsEnabled ? ftsQuery(filters.q) : null;
            if (match) {
                where.push('e.id IN (SELECT rowid FROM events_fts WHERE events_fts MATCH ?)');
                params.push(match);
            } else {
                const like = `%${escapeLike(String(filters.q).slice(0, 200))}%`;
                where.push(`(e.event LIKE ? ESCAPE '\\' OR e.message LIKE ? ESCAPE '\\' OR e.path LIKE ? ESCAPE '\\'
                    OR e.ip LIKE ? ESCAPE '\\' OR e.payload_json LIKE ? ESCAPE '\\' OR e.request_id LIKE ? ESCAPE '\\')`);
                params.push(like, like, like, like, like, like);
            }
        }
        return { sql: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '', params };
    }

    /* Eine Seite, neueste zuerst; `nextCursor` = id fuer `before` der naechsten Seite */
    function list(filters = {}, { limit = 100 } = {}) {
        flush();
        const pageSize = Math.min(Math.max(1, Number(limit) || 100), 1000);
        const { sql, params } = buildWhere(filters);
        const statement = db.prepare(`
            SELECT e.*, u.ua FROM events e LEFT JOIN user_agents u ON u.id = e.ua_id
            ${sql} ORDER BY e.id DESC LIMIT ?
        `);
        const rows = statement.all(...params, pageSize + 1);
        const hasMore = rows.length > pageSize;
        const events = rows.slice(0, pageSize).map(rowToEvent);
        return { events, nextCursor: hasMore ? events[events.length - 1].id : null };
    }

    const earliestStmt = db.prepare('SELECT MIN(ts) AS ts FROM events');
    function earliestTs() {
        flush();
        return earliestStmt.get().ts ?? null;
    }

    function get(id) {
        flush();
        const row = getStmt.get(Number(id));
        return row ? rowToEvent(row) : null;
    }

    /* Alle Treffer in Seiten zu je `chunk`, fuer den Export (Generator) */
    function* iterate(filters = {}, { chunk = 1000, max = 500_000 } = {}) {
        let before = filters.before ?? null;
        let emitted = 0;
        while (emitted < max) {
            const page = list({ ...filters, before }, { limit: Math.min(chunk, max - emitted) });
            for (const event of page.events) yield event;
            emitted += page.events.length;
            if (!page.nextCursor) return;
            before = page.nextCursor;
        }
    }

    /* Juengste Audit-Eintraege im bisherigen Format von lib/audit-log.js */
    const readAuditStmt = db.prepare(`
        SELECT id, ts, event, ip, payload_json FROM events WHERE audit = 1 ORDER BY id DESC LIMIT ?
    `);
    function readAudit({ limit = 200 } = {}) {
        flush();
        const n = Number.isFinite(limit) ? limit : -1;
        return readAuditStmt.all(n).map(row => {
            let detail = {};
            try {
                detail = row.payload_json ? JSON.parse(row.payload_json) : {};
            } catch { /* kaputte Zeile: nur Kopf */ }
            return { id: row.id, ts: row.ts, event: row.event, ...(row.ip ? { ip: row.ip } : {}), ...detail };
        });
    }

    function countAudit(eventNames) {
        flush();
        if (eventNames.length === 0) return 0;
        return db.prepare(`
            SELECT COUNT(*) AS n FROM events WHERE audit = 1 AND event IN (${eventNames.map(() => '?').join(',')})
        `).get(...eventNames).n;
    }

    function sumAuditField(eventName, field) {
        flush();
        return db.prepare(`
            SELECT COALESCE(SUM(json_extract(payload_json, ?)), 0) AS n FROM events WHERE audit = 1 AND event = ?
        `).get(`$.${field}`, eventName).n;
    }

    /* ------------------------------------------------------ Kennzahlen -- */

    const rollupRangeStmt = db.prepare(`
        SELECT module, severity, http_class, SUM(count) AS n FROM events_hourly
        WHERE bucket >= ? AND bucket <= ? GROUP BY module, severity, http_class
    `);
    const rollupTimelineStmt = db.prepare(`
        SELECT bucket, severity, SUM(count) AS n FROM events_hourly
        WHERE bucket >= ? AND bucket <= ? GROUP BY bucket, severity
    `);
    const rawTimelineStmt = db.prepare(`
        SELECT (ts / 60000) AS minute, severity, COUNT(*) AS n FROM events
        WHERE ts >= ? AND ts <= ? GROUP BY minute, severity
    `);
    const countEventsStmt = db.prepare(`
        SELECT COUNT(*) AS n FROM events WHERE event = ? AND ts >= ? AND ts <= ?
    `);
    const countLoginFailuresStmt = db.prepare(`
        SELECT COUNT(*) AS n FROM events
        WHERE event IN ('login_failed', 'totp_login_failed', 'passkey_login_failed', 'customer_login_failed')
          AND ts >= ? AND ts <= ?
    `);

    function aggregate(from, to) {
        const totals = { total: 0, bySeverity: {}, byModule: {}, http: 0, http5xx: 0, http4xx: 0 };
        for (const row of rollupRangeStmt.all(Math.floor(from / HOUR_MS), Math.floor(to / HOUR_MS))) {
            totals.total += row.n;
            totals.bySeverity[row.severity] = (totals.bySeverity[row.severity] ?? 0) + row.n;
            totals.byModule[row.module] = (totals.byModule[row.module] ?? 0) + row.n;
            if (row.http_class > 0) {
                totals.http += row.n;
                if (row.http_class === 5) totals.http5xx += row.n;
                if (row.http_class === 4) totals.http4xx += row.n;
            }
        }
        const errors = (totals.bySeverity[40] ?? 0) + (totals.bySeverity[50] ?? 0);
        totals.errors = errors;
        totals.critical = totals.bySeverity[50] ?? 0;
        totals.errorRate = totals.total > 0 ? errors / totals.total : 0;
        totals.httpErrorRate = totals.http > 0 ? totals.http5xx / totals.http : 0;
        return totals;
    }

    /*
     * Kennzahlen + Grafikdaten fuer [from, to]. Zaehler aus events_hourly
     * (stundengenau, fuer kurze Zeitraeume grob — die Zeitleiste nimmt dort
     * die Rohdaten), Vergleich mit dem gleich langen Zeitraum davor.
     */
    /* "Runde" Balkenbreiten, damit die Achse auf glatten Uhrzeiten liegt */
    const NICE_MINUTES = [1, 2, 5, 10, 15, 30];
    const NICE_HOURS = [1, 2, 3, 4, 6, 12, 24, 48, 72, 96, 168];

    function niceBucketMs(span, bars) {
        const wanted = span / bars;
        const minutes = NICE_MINUTES.find(m => m * 60_000 >= wanted);
        if (minutes) return minutes * 60_000;
        const hours = NICE_HOURS.find(h => h * HOUR_MS >= wanted);
        return hours ? hours * HOUR_MS : Math.ceil(wanted / DAY_MS) * DAY_MS;
    }

    const floorUtc = (ts, bucketMs) => Math.floor(ts / bucketMs) * bucketMs;

    /*
     * `floor(ts, bucketMs)` richtet die Balken aus — lib/time.js'
     * floorLocal() fuer Balken an der Wanduhr der Anzeige-Zeitzone
     * (Tagesbalken ab Mitternacht Ortszeit, auch ueber die Zeitumstellung).
     */
    function stats({ from, to, bars = 24, floor = floorUtc } = {}) {
        flush();
        const end = to ?? now();
        const start = from ?? end - DAY_MS;
        const span = Math.max(end - start, 60_000);
        const current = aggregate(start, end);
        const previous = aggregate(start - span, start - 1);

        const bucketMs = niceBucketMs(span, bars);
        // Kurze Zeitraeume minutengenau aus den Rohdaten, sonst aus dem
        // Stunden-Rollup (Balken sind dann immer ganze Stunden)
        const rows = bucketMs < HOUR_MS
            ? rawTimelineStmt.all(start, end).map(row => ({ at: row.minute * 60_000, severity: row.severity, n: row.n }))
            : rollupTimelineStmt.all(Math.floor(start / HOUR_MS), Math.floor(end / HOUR_MS))
                .map(row => ({ at: row.bucket * HOUR_MS, severity: row.severity, n: row.n }));

        // Balkengrenzen einzeln bestimmen statt start + i * bucketMs: ein
        // Tag an der Zeitumstellung hat 23 bzw. 25 Stunden
        const timeline = [];
        for (let t = floor(start, bucketMs); t <= end && timeline.length < 500;) {
            let next = bucketMs < HOUR_MS ? t + bucketMs : floor(t + bucketMs * 1.5, bucketMs);
            // Schutz gegen eine Ausrichtung, die nicht vorankommt (Endlosbalken)
            if (!(next > t)) next = t + bucketMs;
            timeline.push({ start: t, end: next, counts: { 10: 0, 20: 0, 30: 0, 40: 0, 50: 0 }, total: 0 });
            t = next;
        }
        for (const row of rows) {
            let lo = 0;
            let hi = timeline.length - 1;
            if (hi < 0 || row.at < timeline[0].start) continue;
            while (lo < hi) {
                const mid = (lo + hi + 1) >> 1;
                if (timeline[mid].start <= row.at) lo = mid; else hi = mid - 1;
            }
            const bar = timeline[lo];
            if (row.at >= bar.end) continue;
            bar.counts[row.severity] = (bar.counts[row.severity] ?? 0) + row.n;
            bar.total += row.n;
        }

        return {
            from: start,
            to: end,
            bucketMs,
            ...current,
            previous: { total: previous.total, errors: previous.errors, errorRate: previous.errorRate },
            failedLogins: countLoginFailuresStmt.get(start, end).n,
            ipBlocks: countEventsStmt.get('ip_blocked', start, end).n,
            timeline,
            modules: Object.entries(current.byModule)
                .map(([module, n]) => ({ module, n }))
                .sort((a, b) => b.n - a.n),
        };
    }

    /* ------------------------------------------- Bereinigung/Archiv -- */

    const countAllStmt = db.prepare('SELECT COUNT(*) AS n FROM events');
    const deleteRollupStmt = db.prepare('DELETE FROM events_hourly WHERE bucket < ?');
    let purging = null;

    function archiveFileName() {
        const stamp = new Date(now()).toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
        return `events-${stamp}-${crypto.randomBytes(3).toString('hex')}.ndjson.gz`;
    }

    /*
     * Loescht alles, was `whereSql` trifft, in Portionen — bei aktivem
     * Archiv vorher als NDJSON (gzip) nach archiveDir. Liefert die Anzahl.
     */
    async function deleteMatching(whereSql, params, archive) {
        const select = db.prepare(`
            SELECT e.*, u.ua FROM events e LEFT JOIN user_agents u ON u.id = e.ua_id
            WHERE ${whereSql} ORDER BY e.id LIMIT ${PURGE_BATCH}
        `);
        let removed = 0;
        for (;;) {
            const rows = select.all(...params);
            if (rows.length === 0) break;
            if (archive) await archive.write(rows.map(rowToEvent));
            const ids = rows.map(row => row.id);
            db.exec('BEGIN IMMEDIATE');
            try {
                const del = db.prepare(`DELETE FROM events WHERE id IN (${ids.map(() => '?').join(',')})`);
                del.run(...ids);
                db.exec('COMMIT');
            } catch (err) {
                db.exec('ROLLBACK');
                throw err;
            }
            removed += rows.length;
            if (rows.length < PURGE_BATCH) break;
            // Zwischen den Portionen den Event-Loop freigeben
            await new Promise(resolve => setImmediate(resolve));
        }
        return removed;
    }

    function openArchive() {
        if (!archiveDir) return null;
        let gzip = null;
        let out = null;
        let target = null;
        let count = 0;
        return {
            async write(events) {
                if (!gzip) {
                    await fsp.mkdir(archiveDir, { recursive: true });
                    target = path.join(archiveDir, archiveFileName());
                    gzip = zlib.createGzip();
                    out = fs.createWriteStream(target, { flags: 'wx' });
                    gzip.pipe(out);
                }
                for (const event of events) {
                    if (!gzip.write(`${JSON.stringify(event)}\n`)) await once(gzip, 'drain');
                    count++;
                }
            },
            async close() {
                if (!gzip) return null;
                gzip.end();
                // Fertig ist die Datei erst, wenn der WriteStream geschlossen ist
                await finished(out);
                return { file: path.basename(target), count };
            },
        };
    }

    async function purgeArchives(current) {
        if (!archiveDir || !(current.archiveDays > 0)) return 0;
        let removed = 0;
        for (const archive of await listArchives()) {
            if (archive.createdAt < now() - current.archiveDays * DAY_MS) {
                await fsp.rm(path.join(archiveDir, archive.file), { force: true });
                removed++;
            }
        }
        return removed;
    }

    /*
     * Loeschfristen anwenden: je Schweregrad (Nicht-Audit-Eintraege), Audit-
     * Eintraege nach auditDays, danach die Obergrenze maxRows (aelteste
     * zuerst). Stuendlich aus server.js. Ueberlappende Laeufe teilen sich
     * dasselbe Promise.
     */
    function purge() {
        if (purging) return purging;
        purging = (async () => {
            flush();
            const current = settings;
            const archive = current.archiveEnabled ? openArchive() : null;
            const result = { deleted: 0, bySeverity: {}, audit: 0, overflow: 0, archive: null, archivesRemoved: 0 };
            try {
                for (const [severity, field] of Object.entries(SEVERITY_DAY_FIELDS)) {
                    const days = current[field];
                    if (!(days > 0)) continue;
                    const n = await deleteMatching(
                        'e.audit = 0 AND e.severity = ? AND e.ts < ?', [Number(severity), now() - days * DAY_MS], archive
                    );
                    if (n > 0) result.bySeverity[severity] = n;
                    result.deleted += n;
                }
                if (auditDays > 0) {
                    result.audit = await deleteMatching('e.audit = 1 AND e.ts < ?', [now() - auditDays * DAY_MS], archive);
                    result.deleted += result.audit;
                }
                const total = countAllStmt.get().n;
                if (total > current.maxRows) {
                    const excess = total - Math.floor(current.maxRows * 0.9);
                    const cutoff = db.prepare('SELECT id FROM events ORDER BY id LIMIT 1 OFFSET ?').get(excess - 1)?.id;
                    if (cutoff) {
                        result.overflow = await deleteMatching('e.id <= ?', [cutoff], archive);
                        result.deleted += result.overflow;
                    }
                }
                deleteRollupStmt.run(Math.floor((now() - ROLLUP_KEEP_DAYS * DAY_MS) / HOUR_MS));
            } finally {
                if (archive) result.archive = await archive.close();
            }
            result.archivesRemoved = await purgeArchives(current);
            if (result.deleted > 0) {
                record({
                    event: 'events_purged', module: 'system', severity: SEVERITY.INFO,
                    message: `${result.deleted} Log-Einträge bereinigt`, payload: result,
                });
                flush();
            }
            return result;
        })().finally(() => {
            purging = null;
        });
        return purging;
    }

    async function listArchives() {
        if (!archiveDir) return [];
        let names;
        try {
            names = await fsp.readdir(archiveDir);
        } catch {
            return [];
        }
        const archives = [];
        for (const file of names.filter(name => /^events-[\w-]+\.ndjson\.gz$/.test(name))) {
            try {
                const stat = await fsp.stat(path.join(archiveDir, file));
                archives.push({ file, size: stat.size, createdAt: stat.mtimeMs });
            } catch { /* inzwischen geloescht */ }
        }
        return archives.sort((a, b) => b.createdAt - a.createdAt);
    }

    function safeArchiveName(name) {
        const base = path.basename(String(name ?? ''));
        return /^events-[\w-]+\.ndjson\.gz$/.test(base) && base === name ? base : null;
    }

    async function deleteArchive(name) {
        const file = safeArchiveName(name);
        if (!file || !archiveDir) return false;
        try {
            await fsp.rm(path.join(archiveDir, file));
            return true;
        } catch {
            return false;
        }
    }

    /* --------------------------------------------- Uebernahme alt -> neu -- */

    /*
     * Einmalige Uebernahme der Zeilen aus audit_log (Haupt-DB) — dort landen
     * auch Importe aus der JSON-Aera (lib/migrate-legacy.js). Erst nach dem
     * Commit hier werden die uebernommenen Zeilen dort geloescht; stirbt der
     * Prozess genau dazwischen, stehen sie beim naechsten Start doppelt drin
     * (harmlos, nichts geht verloren).
     */
    function importLegacyAudit(mainDb) {
        let rows;
        try {
            rows = mainDb.prepare('SELECT id, ts, event, detail_json FROM audit_log ORDER BY id').all();
        } catch {
            return 0;
        }
        if (rows.length === 0) return 0;
        flush();
        db.exec('BEGIN IMMEDIATE');
        try {
            for (const row of rows) {
                let detail = {};
                try {
                    detail = JSON.parse(row.detail_json) ?? {};
                } catch { /* kaputte Zeile: nur Kopf */ }
                const { ip = null, ...rest } = detail;
                const payloadJson = stringifyPayload(rest);
                const severity = severityFor(row.event);
                const module = moduleFor(row.event);
                const info = insertStmt.run(
                    row.ts, severity, module, row.event, 1,
                    outcomeFor(row.event),
                    null, null, null, ip, null, null, null, null, null, null, null, payloadJson, null
                );
                if (insertFtsStmt) {
                    insertFtsStmt.run(info.lastInsertRowid, [row.event, ip, payloadJson].filter(Boolean).join(' '));
                }
                rollupStmt.run(Math.floor(row.ts / HOUR_MS), module, severity, 0, 1);
            }
            db.exec('COMMIT');
        } catch (err) {
            db.exec('ROLLBACK');
            throw err;
        }
        mainDb.prepare('DELETE FROM audit_log WHERE id <= ?').run(rows[rows.length - 1].id);
        return rows.length;
    }

    /* ---------------------------------------------------------- Betrieb -- */

    function status() {
        return {
            ...counters,
            queued: queue.length,
            ftsEnabled,
        };
    }

    function maintain() {
        db.exec('PRAGMA optimize');
        db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    }

    function close() {
        if (closed) return;
        flush();
        closed = true;
        db.close();
    }

    return {
        file,
        record, audit, recordRequest, fromLog, middleware, job, instrumentDatabase,
        flush, list, get, earliestTs, iterate, readAudit, countAudit, sumAuditField, stats,
        readSettings, writeSettings, purge, listArchives, deleteArchive, safeArchiveName,
        archiveDir, importLegacyAudit, status, maintain, close,
    };
}

module.exports = {
    createEventStore, redact, diff, ftsQuery, DEFAULT_SETTINGS,
};
