'use strict';

/*
 * Kundenkonten fuer das Ticketsystem (Tabellen `customers` und
 * `customer_tokens`, siehe lib/db.js). Vollstaendig getrennt vom einen
 * Admin-Account: ein Kunde meldet sich ueber /account/login an, bekommt
 * req.session.customerId (nie req.session.loggedIn) und sieht ausschliesslich
 * seine eigenen Tickets — siehe checkCustomer in lib/routes/account.js.
 *
 * Passwoerter: scrypt mit Salt, dasselbe Verfahren wie lib/password-store.js
 * fuer das Admin-Passwort (vom Nutzer gewaehlt, also die langsame KDF).
 *
 * Einmal-Tokens (E-Mail bestaetigen, Passwort zuruecksetzen, E-Mail-Adresse
 * aendern): gespeichert wird nur sha256(token), dasselbe Muster wie
 * lib/api-token-store.js — das Klartext-Token steht nur in der verschickten
 * Mail. consumeToken() loescht den Eintrag beim Einloesen, ein Link
 * funktioniert also genau einmal.
 *
 * E-Mail-Adressen werden kleingeschrieben gespeichert und verglichen: ein
 * Konto pro Postfach, egal wie jemand die Adresse beim Login tippt.
 */

const crypto = require('crypto');
const { promisify } = require('util');

const scryptAsync = promisify(crypto.scrypt);
const KEY_LENGTH = 64;
const TOKEN_PREFIX = 'ctk_';
const TOKEN_PURPOSES = ['verify', 'reset', 'email_change'];

// Welche Mails ein Kunde abbestellen kann. Sicherheitsrelevante Mails
// (Bestaetigung, Passwort-Reset, Passwort geaendert) sind bewusst nicht
// darunter — die gehen immer raus.
const NOTIFY_DEFAULTS = Object.freeze({ replies: true, status: true, reminders: true });

function normalizeEmail(email) {
    return String(email ?? '').trim().toLowerCase();
}

function hashToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

async function hashPassword(plaintext) {
    const salt = crypto.randomBytes(16);
    const hash = await scryptAsync(String(plaintext), salt, KEY_LENGTH);
    return { salt: salt.toString('base64url'), hash: hash.toString('base64url') };
}

function parseNotify(json) {
    let parsed = {};
    try {
        parsed = JSON.parse(json || '{}');
    } catch {
        parsed = {};
    }
    const result = { ...NOTIFY_DEFAULTS };
    for (const key of Object.keys(NOTIFY_DEFAULTS)) {
        if (typeof parsed[key] === 'boolean') result[key] = parsed[key];
    }
    return result;
}

function rowToCustomer(row) {
    return {
        id: row.id,
        email: row.email,
        name: row.name,
        emailVerified: row.email_verified_at != null,
        emailVerifiedAt: row.email_verified_at,
        disabled: row.disabled === 1,
        notify: parseNotify(row.notify_json),
        createdAt: row.created_at,
        lastLoginAt: row.last_login_at,
    };
}

function createCustomerStore({ db }) {
    if (!db) throw new Error('customer store braucht eine db');

    const insertStmt = db.prepare(`
        INSERT INTO customers (id, email, name, password_salt, password_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    const getStmt = db.prepare('SELECT * FROM customers WHERE id = ?');
    const byEmailStmt = db.prepare('SELECT * FROM customers WHERE email = ?');
    const setPasswordStmt = db.prepare('UPDATE customers SET password_salt = ?, password_hash = ? WHERE id = ?');
    const setNameStmt = db.prepare('UPDATE customers SET name = ? WHERE id = ?');
    const setEmailStmt = db.prepare('UPDATE customers SET email = ?, email_verified_at = ? WHERE id = ?');
    const verifyStmt = db.prepare(
        'UPDATE customers SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?'
    );
    const setDisabledStmt = db.prepare('UPDATE customers SET disabled = ? WHERE id = ?');
    const setNotifyStmt = db.prepare('UPDATE customers SET notify_json = ? WHERE id = ?');
    const loginStmt = db.prepare('UPDATE customers SET last_login_at = ? WHERE id = ?');
    const deleteStmt = db.prepare('DELETE FROM customers WHERE id = ?');
    const countStmt = db.prepare('SELECT COUNT(*) AS n FROM customers');
    const listStmt = db.prepare(`
        SELECT c.*, (SELECT COUNT(*) FROM tickets t WHERE t.customer_id = c.id) AS ticket_count
        FROM customers c
        WHERE (@q = '' OR c.email LIKE @like ESCAPE '\\' OR c.name LIKE @like ESCAPE '\\')
        ORDER BY c.created_at DESC
        LIMIT @limit OFFSET @offset
    `);
    const listCountStmt = db.prepare(`
        SELECT COUNT(*) AS n FROM customers c
        WHERE (@q = '' OR c.email LIKE @like ESCAPE '\\' OR c.name LIKE @like ESCAPE '\\')
    `);

    const insertTokenStmt = db.prepare(`
        INSERT INTO customer_tokens (token_hash, customer_id, purpose, payload, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    const findTokenStmt = db.prepare('SELECT * FROM customer_tokens WHERE token_hash = ? AND purpose = ?');
    const deleteTokenStmt = db.prepare('DELETE FROM customer_tokens WHERE token_hash = ?');
    const deleteTokensForStmt = db.prepare('DELETE FROM customer_tokens WHERE customer_id = ? AND purpose = ?');
    const purgeTokensStmt = db.prepare('DELETE FROM customer_tokens WHERE expires_at <= ?');

    // Fuer den Login-Pfad: auch bei unbekannter Adresse eine scrypt-Runde
    // gegen diesen Dummy-Hash rechnen, damit die Antwortzeit nicht verraet,
    // ob es ein Konto zu der Adresse gibt (dasselbe Prinzip wie
    // passwordMatches() beim Admin-Login in server.js).
    const dummy = { salt: crypto.randomBytes(16).toString('base64url'), hash: crypto.randomBytes(KEY_LENGTH).toString('base64url') };

    async function createCustomer({ email, name, password }) {
        const normalized = normalizeEmail(email);
        if (byEmailStmt.get(normalized)) {
            const err = new Error('E-Mail-Adresse bereits registriert');
            err.code = 'email_taken';
            throw err;
        }
        const id = crypto.randomUUID();
        const { salt, hash } = await hashPassword(password);
        // Zwischen dem Check oben und hier liegt ein await (scrypt) — ein
        // paralleler Request koennte dieselbe Adresse inzwischen angelegt
        // haben. Der UNIQUE-Index faengt das ab, hier nur freundlich
        // uebersetzt.
        try {
            insertStmt.run(id, normalized, String(name).trim(), salt, hash, Date.now());
        } catch (err) {
            if (/UNIQUE/.test(err.message)) {
                const taken = new Error('E-Mail-Adresse bereits registriert');
                taken.code = 'email_taken';
                throw taken;
            }
            throw err;
        }
        return getCustomer(id);
    }

    function getCustomer(id) {
        const row = getStmt.get(String(id ?? ''));
        return row ? rowToCustomer(row) : null;
    }

    function findByEmail(email) {
        const row = byEmailStmt.get(normalizeEmail(email));
        return row ? rowToCustomer(row) : null;
    }

    /* Gibt den Kunden bei passendem Passwort zurueck, sonst null — rechnet in
       jedem Fall genau eine scrypt-Runde (siehe dummy oben). */
    async function authenticate(email, password) {
        const row = byEmailStmt.get(normalizeEmail(email));
        const record = row ? { salt: row.password_salt, hash: row.password_hash } : dummy;
        const ok = await verifyAgainst(password, record);
        return row && ok ? rowToCustomer(row) : null;
    }

    async function verifyPassword(id, password) {
        const row = getStmt.get(String(id ?? ''));
        const record = row ? { salt: row.password_salt, hash: row.password_hash } : dummy;
        const ok = await verifyAgainst(password, record);
        return Boolean(row) && ok;
    }

    async function verifyAgainst(candidate, record) {
        const salt = Buffer.from(record.salt, 'base64url');
        const stored = Buffer.from(record.hash, 'base64url');
        const candidateHash = await scryptAsync(String(candidate ?? ''), salt, stored.length);
        return candidateHash.length === stored.length && crypto.timingSafeEqual(candidateHash, stored);
    }

    async function setPassword(id, password) {
        const { salt, hash } = await hashPassword(password);
        return setPasswordStmt.run(salt, hash, id).changes > 0;
    }

    function setName(id, name) {
        return setNameStmt.run(String(name).trim(), id).changes > 0;
    }

    /* Nur nach bestaetigtem email_change-Token aufrufen — die neue Adresse
       gilt damit gleich als verifiziert. */
    function setEmail(id, email) {
        try {
            return setEmailStmt.run(normalizeEmail(email), Date.now(), id).changes > 0;
        } catch (err) {
            if (/UNIQUE/.test(err.message)) return false;
            throw err;
        }
    }

    function markVerified(id) {
        return verifyStmt.run(Date.now(), id).changes > 0;
    }

    function setDisabled(id, disabled) {
        return setDisabledStmt.run(disabled ? 1 : 0, id).changes > 0;
    }

    function setNotify(id, prefs) {
        const merged = { ...NOTIFY_DEFAULTS };
        for (const key of Object.keys(NOTIFY_DEFAULTS)) merged[key] = Boolean(prefs?.[key]);
        return setNotifyStmt.run(JSON.stringify(merged), id).changes > 0;
    }

    function recordLogin(id) {
        loginStmt.run(Date.now(), id);
    }

    function deleteCustomer(id) {
        return deleteStmt.run(id).changes > 0;
    }

    function listCustomers({ q = '', page = 1, perPage = 50 } = {}) {
        const query = String(q ?? '').trim();
        const params = {
            q: query,
            // % und _ escapen statt entfernen — Adressen wie vor_nach@… sonst unauffindbar
            like: `%${query.replace(/[%_\\]/g, '\\$&')}%`,
        };
        const total = listCountStmt.get(params).n;
        // Eine Seite hinter dem Ende zeigt die letzte statt einer leeren Liste
        const lastPage = Math.max(1, Math.ceil(total / perPage));
        const current = Math.min(Math.max(1, Math.floor(Number(page)) || 1), lastPage);
        const rows = listStmt.all({ ...params, limit: perPage, offset: (current - 1) * perPage });
        return {
            customers: rows.map(row => ({ ...rowToCustomer(row), ticketCount: row.ticket_count })),
            total,
            page: current,
        };
    }

    function countCustomers() {
        return countStmt.get().n;
    }

    /* Legt ein neues Einmal-Token an und verwirft dabei alle aelteren
       desselben Zwecks — nur der zuletzt verschickte Link gilt. */
    function issueToken(customerId, purpose, { ttlMs, payload = null }) {
        if (!TOKEN_PURPOSES.includes(purpose)) throw new Error(`unbekannter Token-Zweck: ${purpose}`);
        const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
        const now = Date.now();
        deleteTokensForStmt.run(customerId, purpose);
        insertTokenStmt.run(hashToken(token), customerId, purpose, payload, now + ttlMs, now);
        return token;
    }

    /* Loest ein Token ein: {customer, payload} oder null (unbekannt,
       abgelaufen, falscher Zweck). Loescht es in jedem Trefferfall. */
    function consumeToken(token, purpose) {
        const tokenHash = hashToken(token);
        const row = findTokenStmt.get(tokenHash, purpose);
        if (!row) return null;
        deleteTokenStmt.run(tokenHash);
        if (row.expires_at <= Date.now()) return null;
        const customer = getCustomer(row.customer_id);
        return customer ? { customer, payload: row.payload } : null;
    }

    /* Wie consumeToken, loescht aber nichts — fuer die GET-Seite des
       Passwort-Resets, die das Formular erst anzeigt. */
    function peekToken(token, purpose) {
        const row = findTokenStmt.get(hashToken(token), purpose);
        if (!row || row.expires_at <= Date.now()) return null;
        return getCustomer(row.customer_id);
    }

    function purgeExpiredTokens() {
        return purgeTokensStmt.run(Date.now()).changes;
    }

    return {
        db, createCustomer, getCustomer, findByEmail, authenticate, verifyPassword, setPassword,
        setName, setEmail, markVerified, setDisabled, setNotify, recordLogin, deleteCustomer,
        listCustomers, countCustomers, issueToken, consumeToken, peekToken, purgeExpiredTokens,
    };
}

module.exports = { createCustomerStore, normalizeEmail, NOTIFY_DEFAULTS };
