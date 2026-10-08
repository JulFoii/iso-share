'use strict';

/*
 * Stammdaten des Event-Logs (siehe lib/event-store.js): Schweregrade,
 * Module (Systembereiche) und die Zuordnung der bekannten Audit-Ereignisse
 * zu Modul und Schweregrad. Reine Daten + kleine Funktionen, keine DB.
 *
 * Neue Audit-Ereignisse brauchen hier keinen Eintrag: moduleFor() leitet das
 * Modul notfalls aus dem Praefix ab, severityFor() aus Endungen wie
 * `_failed`/`_rejected`. Ein Eintrag in AUDIT_EVENTS ist nur noetig, wenn die
 * Ableitung danebenliegt.
 */

const SEVERITY = Object.freeze({ DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40, CRITICAL: 50 });

const SEVERITIES = [
    { value: 10, key: 'debug', label: 'DEBUG' },
    { value: 20, key: 'info', label: 'INFO' },
    { value: 30, key: 'warning', label: 'WARNING' },
    { value: 40, key: 'error', label: 'ERROR' },
    { value: 50, key: 'critical', label: 'CRITICAL' },
];

const SEVERITY_BY_KEY = Object.fromEntries(SEVERITIES.map(s => [s.key, s.value]));
const SEVERITY_BY_VALUE = Object.fromEntries(SEVERITIES.map(s => [s.value, s]));

/* Logger-Level (lib/logger.js) -> Schweregrad */
const LOG_LEVEL_SEVERITY = { debug: 10, info: 20, warn: 30, error: 40, critical: 50 };

const MODULES = [
    { key: 'auth', label: 'Authentifizierung' },
    { key: 'users', label: 'Benutzerverwaltung' },
    { key: 'files', label: 'Dateien' },
    { key: 'tickets', label: 'Tickets' },
    { key: 'mail', label: 'E-Mail' },
    { key: 'api', label: 'Schnittstellen' },
    { key: 'http', label: 'Web/HTTP' },
    { key: 'database', label: 'Datenbank' },
    { key: 'backup', label: 'Sicherungen' },
    { key: 'jobs', label: 'Hintergrund-Jobs' },
    { key: 'security', label: 'Sicherheit' },
    { key: 'system', label: 'System' },
];
const MODULE_KEYS = new Set(MODULES.map(m => m.key));
const MODULE_LABELS = Object.fromEntries(MODULES.map(m => [m.key, m.label]));

/* Explizite Zuordnung dort, wo die Ableitung unten danebenlaege. */
const AUDIT_EVENTS = {
    login_success: ['auth', 20],
    login_failed: ['auth', 30],
    totp_login_success: ['auth', 20],
    totp_login_failed: ['auth', 30],
    passkey_login_success: ['auth', 20],
    passkey_login_failed: ['auth', 30],
    session_idle_timeout: ['auth', 20],
    customer_login: ['auth', 20],
    customer_login_failed: ['auth', 30],
    customer_login_disabled: ['auth', 30],
    password_changed: ['users', 30],
    username_changed: ['users', 30],
    passkey_registered: ['users', 30],
    passkey_removed: ['users', 30],
    totp_enabled: ['users', 30],
    totp_disabled: ['users', 30],
    register_existing_email: ['users', 20],
    register_honeypot_triggered: ['security', 30],
    api_token_created: ['api', 30],
    api_token_revoked: ['api', 30],
    upload: ['files', 20],
    upload_replaced: ['files', 20],
    delete: ['files', 20],
    bulk_delete: ['files', 20],
    tag_removed: ['files', 20],
    backup_restored: ['backup', 30],
    mail_failed: ['mail', 40],
    mail_inbound_rejected: ['mail', 30],
    retention_purge: ['system', 20],
    tickets_claimed: ['tickets', 20],
    ip_blocked: ['security', 30],
    rate_limit_global: ['security', 40],
    api_auth_failed: ['security', 30],
    csrf_rejected: ['security', 30],
    events_exported: ['security', 20],
    event_settings_changed: ['system', 30],
};

const PREFIX_MODULES = [
    ['customer_', 'users'],
    ['ticket', 'tickets'],
    ['kb_', 'tickets'],
    ['mail_', 'mail'],
    ['backup_', 'backup'],
    ['api_', 'api'],
    ['passkey_', 'users'],
    ['totp_', 'users'],
    ['upload', 'files'],
    ['file_', 'files'],
    ['session_', 'auth'],
    ['login', 'auth'],
];

function moduleFor(event) {
    if (AUDIT_EVENTS[event]) return AUDIT_EVENTS[event][0];
    const hit = PREFIX_MODULES.find(([prefix]) => event.startsWith(prefix));
    return hit ? hit[1] : 'system';
}

function severityFor(event) {
    if (AUDIT_EVENTS[event]) return AUDIT_EVENTS[event][1];
    if (/_(failed|rejected|denied|disabled)$/.test(event)) return SEVERITY.WARNING;
    return SEVERITY.INFO;
}

/*
 * Ergebnis eines Audit-Ereignisses. `_disabled` allein zaehlt nicht als
 * Fehlschlag (totp_disabled ist eine erfolgreiche Admin-Aktion), nur ein
 * abgewiesener Login eines gesperrten Kontos.
 */
function outcomeFor(event) {
    return /_(failed|rejected|denied|triggered)$|_login_disabled$/.test(event) ? 'failure' : 'success';
}

/*
 * Modul eines HTTP-Requests anhand des Pfads. Reihenfolge wichtig
 * (spezifisch vor allgemein).
 */
const PATH_MODULES = [
    [/^\/api\//, 'api'],
    [/^\/(login|logout|webauthn|totp)\b|^\/account\/(login|logout|verify|forgot|reset|resend)/, 'auth'],
    [/^\/(account\/tickets|admin\/tickets|admin-tickets|admin\/kb|admin\/reports|support|contact|attachments)\b/, 'tickets'],
    [/^\/(account|admin\/customers|admin-password|admin-username|admin\/api-tokens)\b/, 'users'],
    [/^\/admin\/(ticket-settings|mail)\b/, 'mail'],
    [/^\/admin\/(backups|backup-settings)\b/, 'backup'],
    [/^\/(upload|download|download-zip|delete|delete-bulk|files|checksums|search)\b/, 'files'],
    [/^\/admin\/logs\b/, 'security'],
];

function moduleForPath(pathname) {
    const hit = PATH_MODULES.find(([pattern]) => pattern.test(pathname));
    return hit ? hit[1] : 'http';
}

function parseSeverity(value) {
    if (value === undefined || value === null || value === '') return null;
    const asNumber = Number(value);
    if (SEVERITY_BY_VALUE[asNumber]) return asNumber;
    return SEVERITY_BY_KEY[String(value).toLowerCase()] ?? null;
}

module.exports = {
    SEVERITY, SEVERITIES, SEVERITY_BY_KEY, SEVERITY_BY_VALUE, LOG_LEVEL_SEVERITY,
    MODULES, MODULE_KEYS, MODULE_LABELS, AUDIT_EVENTS,
    moduleFor, severityFor, outcomeFor, moduleForPath, parseSeverity,
};
