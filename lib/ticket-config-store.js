'use strict';

/*
 * Laufzeit-Konfiguration des Ticketsystems, im Admin-Bereich unter
 * /admin/ticket-settings editierbar (wie die Backup-Einstellungen, ohne
 * Neustart): Kategorien (`ticket_categories`), Textbausteine
 * (`canned_responses`), die Fristen der Automatik (`ticket_settings`, eine
 * Zeile — siehe lib/ticket-automation.js) sowie Anrede und Grussformel fuer
 * Support-Antworten (`ticket_reply_template`, eine Zeile — siehe
 * lib/reply-template.js) und die Antwortfristen je Prioritaet (`ticket_sla`,
 * siehe SLA_DUE_SQL in lib/ticket-store.js).
 *
 * Fehlt die Einstellungszeile, gelten die DEFAULTS; readSettings() schreibt
 * nichts, erst updateSettings() legt die Zeile an. Dasselbe gilt fuer
 * readReplyTemplate()/updateReplyTemplate().
 */

const { REPLY_TEMPLATE_DEFAULTS, REPLY_TEMPLATE_LIMITS } = require('./reply-template');

const DEFAULT_CATEGORIES = ['Allgemeine Frage', 'Download-Problem', 'Fehler melden', 'Wunsch / Anregung'];

const SETTINGS_DEFAULTS = Object.freeze({
    pendingReminderDays: 3,
    pendingAutoResolveDays: 7,
    autoCloseDays: 7,
});

const SETTINGS_LIMITS = {
    pendingReminderDays: [1, 60],
    pendingAutoResolveDays: [1, 90],
    autoCloseDays: [1, 90],
};

// Fuer Fehlermeldungen: die Formular-Beschriftungen statt der internen
// Feldnamen.
const SETTINGS_FIELD_LABELS = {
    pendingReminderDays: 'Erinnerung nach … Tagen',
    pendingAutoResolveDays: 'Automatisch „gelöst“ nach … Tagen',
    autoCloseDays: 'Gelöste Tickets schließen nach … Tagen',
};

/* Antwortfristen in Stunden (Kalenderzeit): Erstantwort auf ein neues
   Ticket, Folgeantwort nach einer Kundennachricht. 0 = keine Frist. */
const SLA_DEFAULTS = Object.freeze({
    urgent: { firstResponseHours: 4, nextResponseHours: 4 },
    high: { firstResponseHours: 8, nextResponseHours: 8 },
    normal: { firstResponseHours: 24, nextResponseHours: 24 },
    low: { firstResponseHours: 72, nextResponseHours: 72 },
});
const SLA_MAX_HOURS = 720;

const REPLY_TEMPLATE_FIELD_LABELS = { greeting: 'Die Anrede', signature: 'Die Grußformel', agentName: 'Der Anzeigename' };

function createTicketConfigStore({ db }) {
    if (!db) throw new Error('ticket config store braucht eine db');

    const listCategoriesStmt = db.prepare('SELECT * FROM ticket_categories ORDER BY position ASC, name ASC');
    const getCategoryStmt = db.prepare('SELECT * FROM ticket_categories WHERE id = ?');
    const insertCategoryStmt = db.prepare(`
        INSERT INTO ticket_categories (name, position)
        VALUES (?, (SELECT COALESCE(MAX(position), 0) + 1 FROM ticket_categories))
    `);
    const renameCategoryStmt = db.prepare('UPDATE ticket_categories SET name = ? WHERE id = ?');
    const deleteCategoryStmt = db.prepare('DELETE FROM ticket_categories WHERE id = ?');
    const countCategoriesStmt = db.prepare('SELECT COUNT(*) AS n FROM ticket_categories');

    const listCannedStmt = db.prepare('SELECT * FROM canned_responses ORDER BY title ASC');
    const getCannedStmt = db.prepare('SELECT * FROM canned_responses WHERE id = ?');
    const insertCannedStmt = db.prepare(
        'INSERT INTO canned_responses (title, body, created_at, updated_at) VALUES (?, ?, ?, ?)'
    );
    const updateCannedStmt = db.prepare('UPDATE canned_responses SET title = ?, body = ?, updated_at = ? WHERE id = ?');
    const deleteCannedStmt = db.prepare('DELETE FROM canned_responses WHERE id = ?');

    const readSettingsStmt = db.prepare('SELECT * FROM ticket_settings WHERE id = 1');
    const writeSettingsStmt = db.prepare(`
        INSERT INTO ticket_settings (id, pending_reminder_days, pending_auto_resolve_days, auto_close_days)
        VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            pending_reminder_days = excluded.pending_reminder_days,
            pending_auto_resolve_days = excluded.pending_auto_resolve_days,
            auto_close_days = excluded.auto_close_days
    `);

    const readReplyTemplateStmt = db.prepare('SELECT * FROM ticket_reply_template WHERE id = 1');
    const writeReplyTemplateStmt = db.prepare(`
        INSERT INTO ticket_reply_template (id, greeting, signature, agent_name)
        VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            greeting = excluded.greeting,
            signature = excluded.signature,
            agent_name = excluded.agent_name
    `);

    const readSlaStmt = db.prepare('SELECT * FROM ticket_sla');
    const seedSlaStmt = db.prepare(`
        INSERT OR IGNORE INTO ticket_sla (priority, first_response_minutes, next_response_minutes) VALUES (?, ?, ?)
    `);
    const writeSlaStmt = db.prepare(`
        INSERT INTO ticket_sla (priority, first_response_minutes, next_response_minutes) VALUES (?, ?, ?)
        ON CONFLICT(priority) DO UPDATE SET
            first_response_minutes = excluded.first_response_minutes,
            next_response_minutes = excluded.next_response_minutes
    `);

    // Die SLA-Zeilen muessen existieren, weil die Faelligkeit in SQL
    // berechnet wird (lib/ticket-store.js) und die Defaults dort nicht
    // sichtbar waeren. INSERT OR IGNORE: eine bewusst auf 0 gesetzte Frist
    // bleibt 0, auch bei bestehenden Installationen ohne seedDefaults().
    for (const [priority, sla] of Object.entries(SLA_DEFAULTS)) {
        seedSlaStmt.run(priority, sla.firstResponseHours * 60, sla.nextResponseHours * 60);
    }

    /* Beim allerersten Start ein paar sinnvolle Kategorien anlegen, damit das
       Formular nicht mit einer leeren Auswahl startet. Die Einstellungszeile
       dient als "schon einmal gelaufen"-Marker: hat der Admin spaeter alle
       Kategorien bewusst geloescht, kommen sie beim naechsten Start nicht
       zurueck. */
    function seedDefaults() {
        if (readSettingsStmt.get()) return;
        if (countCategoriesStmt.get().n === 0) {
            for (const name of DEFAULT_CATEGORIES) insertCategoryStmt.run(name);
        }
        writeSettingsStmt.run(
            SETTINGS_DEFAULTS.pendingReminderDays, SETTINGS_DEFAULTS.pendingAutoResolveDays,
            SETTINGS_DEFAULTS.autoCloseDays
        );
    }

    function listCategories() {
        return listCategoriesStmt.all().map(row => ({ id: row.id, name: row.name }));
    }

    function getCategory(id) {
        const row = getCategoryStmt.get(Number(id) || 0);
        return row ? { id: row.id, name: row.name } : null;
    }

    function addCategory(name) {
        try {
            return insertCategoryStmt.run(String(name).trim()).lastInsertRowid;
        } catch (err) {
            if (/UNIQUE/.test(err.message)) return null;
            throw err;
        }
    }

    function renameCategory(id, name) {
        try {
            return renameCategoryStmt.run(String(name).trim(), Number(id)).changes > 0;
        } catch (err) {
            if (/UNIQUE/.test(err.message)) return false;
            throw err;
        }
    }

    function deleteCategory(id) {
        return deleteCategoryStmt.run(Number(id)).changes > 0;
    }

    function rowToCanned(row) {
        return { id: row.id, title: row.title, body: row.body, updatedAt: row.updated_at };
    }

    function listCanned() {
        return listCannedStmt.all().map(rowToCanned);
    }

    function getCanned(id) {
        const row = getCannedStmt.get(Number(id) || 0);
        return row ? rowToCanned(row) : null;
    }

    function addCanned({ title, body }) {
        const now = Date.now();
        return insertCannedStmt.run(String(title).trim(), String(body), now, now).lastInsertRowid;
    }

    function updateCanned(id, { title, body }) {
        return updateCannedStmt.run(String(title).trim(), String(body), Date.now(), Number(id)).changes > 0;
    }

    function deleteCanned(id) {
        return deleteCannedStmt.run(Number(id)).changes > 0;
    }

    function readSettings() {
        const row = readSettingsStmt.get();
        if (!row) return { ...SETTINGS_DEFAULTS };
        return {
            pendingReminderDays: row.pending_reminder_days,
            pendingAutoResolveDays: row.pending_auto_resolve_days,
            autoCloseDays: row.auto_close_days,
        };
    }

    /* Gibt {settings} oder {error} zurueck; Werte ausserhalb der Grenzen
       werden abgelehnt statt stillschweigend geklemmt. */
    function updateSettings(input) {
        const next = {};
        for (const [key, [min, max]] of Object.entries(SETTINGS_LIMITS)) {
            const value = Number(input?.[key]);
            if (!Number.isInteger(value) || value < min || value > max) {
                return { error: `Ungültiger Wert für „${SETTINGS_FIELD_LABELS[key]}“ (erlaubt: ${min}–${max} Tage).` };
            }
            next[key] = value;
        }
        writeSettingsStmt.run(next.pendingReminderDays, next.pendingAutoResolveDays, next.autoCloseDays);
        return { settings: next };
    }

    function readReplyTemplate() {
        const row = readReplyTemplateStmt.get();
        if (!row) return { ...REPLY_TEMPLATE_DEFAULTS };
        return { greeting: row.greeting, signature: row.signature, agentName: row.agent_name };
    }

    /* Leere Anrede bzw. Grussformel ist erlaubt und schaltet den Teil ab;
       zu lange Werte werden abgelehnt statt abgeschnitten. */
    function updateReplyTemplate(input) {
        const next = {};
        for (const [key, max] of Object.entries(REPLY_TEMPLATE_LIMITS)) {
            const value = String(input?.[key] ?? '').replace(/\r\n/g, '\n').trim();
            if (value.length > max) {
                return { error: `${REPLY_TEMPLATE_FIELD_LABELS[key]} ist zu lang (höchstens ${max} Zeichen).` };
            }
            next[key] = key === 'agentName' ? value.replace(/\s+/g, ' ') : value;
        }
        writeReplyTemplateStmt.run(next.greeting, next.signature, next.agentName);
        return { template: next };
    }

    /* { urgent: { firstResponseHours, nextResponseHours }, ... } — 0 = keine Frist. */
    function readSla() {
        const sla = structuredClone(SLA_DEFAULTS);
        for (const row of readSlaStmt.all()) {
            if (!sla[row.priority]) continue;
            sla[row.priority] = {
                firstResponseHours: (row.first_response_minutes ?? 0) / 60,
                nextResponseHours: (row.next_response_minutes ?? 0) / 60,
            };
        }
        return sla;
    }

    /* input: { urgent_first: '4', urgent_next: '4', ... } (Formularfelder).
       Gibt {sla} oder {error} zurueck. */
    function updateSla(input) {
        const next = {};
        for (const priority of Object.keys(SLA_DEFAULTS)) {
            next[priority] = {};
            for (const [field, key] of [['first', 'firstResponseHours'], ['next', 'nextResponseHours']]) {
                const raw = String(input?.[`${priority}_${field}`] ?? '').trim().replace(',', '.');
                const value = raw === '' ? 0 : Number(raw);
                // Viertelstunden genuegen, feiner wird es nicht gebraucht.
                if (!Number.isFinite(value) || value < 0 || value > SLA_MAX_HOURS || !Number.isInteger(value * 4)) {
                    return { error: `Ungültige Frist (erlaubt: 0–${SLA_MAX_HOURS} Stunden, in Viertelstunden).` };
                }
                next[priority][key] = value;
            }
        }
        for (const [priority, sla] of Object.entries(next)) {
            writeSlaStmt.run(priority, Math.round(sla.firstResponseHours * 60), Math.round(sla.nextResponseHours * 60));
        }
        return { sla: next };
    }

    return {
        db, seedDefaults, listCategories, getCategory, addCategory, renameCategory, deleteCategory,
        listCanned, getCanned, addCanned, updateCanned, deleteCanned, readSettings, updateSettings,
        readReplyTemplate, updateReplyTemplate, readSla, updateSla,
    };
}

module.exports = { createTicketConfigStore, SETTINGS_DEFAULTS, SETTINGS_LIMITS, SLA_DEFAULTS, SLA_MAX_HOURS };
