'use strict';

/*
 * API-Tokens fuer den programmatischen Zugriff auf /api/v1 (Skripte, CI) in
 * der Tabelle `api_tokens` — mehrere Datensaetze pro Admin-Account, analog zu
 * lib/webauthn-store.js. Ein Token kann nur erzeugen, wer schon eine gueltige
 * Session hat (checkAuth-gated Routen in server.js) — derselbe Bootstrap-
 * Gedanke wie bei Passkeys: kein API-Weg, um sich selbst ein erstes Token zu
 * geben, das waere eine Privilege-Escalation ueber die API selbst.
 *
 * Gespeichert wird nur sha256(token) als indizierter Lookup-Key, nie das
 * Klartext-Token. createToken() gibt es genau einmal im Klartext zurueck,
 * danach ist es nirgends mehr rekonstruierbar — dasselbe Prinzip wie die
 * TOTP-Recovery-Codes in lib/totp-store.js.
 */

const crypto = require('crypto');

const TOKEN_PREFIX = 'iso_';
const VALID_SCOPES = ['read', 'write'];

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function rowToToken(row) {
    return {
        id: row.id,
        label: row.label,
        scopes: JSON.parse(row.scopes_json),
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
    };
}

function normalizeScopes(scopes) {
    const requested = Array.isArray(scopes) ? scopes : ['read'];
    const unique = [...new Set(requested)];
    if (unique.length === 0 || !unique.every(scope => VALID_SCOPES.includes(scope))) {
        return null;
    }
    return unique;
}

function createApiTokenStore({ db }) {
    if (!db) throw new Error('api token store braucht eine db');

    const listStmt = db.prepare('SELECT * FROM api_tokens ORDER BY created_at');
    const findByHashStmt = db.prepare('SELECT * FROM api_tokens WHERE token_hash = ?');
    const insertStmt = db.prepare(`
        INSERT INTO api_tokens (id, token_hash, label, scopes_json, created_at, last_used_at)
        VALUES (@id, @tokenHash, @label, @scopesJson, @createdAt, NULL)
    `);
    const touchStmt = db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?');
    const deleteStmt = db.prepare('DELETE FROM api_tokens WHERE id = ?');

    async function listTokens() {
        return listStmt.all().map(rowToToken);
    }

    /* Gibt {id, token, label, scopes, createdAt} zurueck — token ist ab hier
       nicht mehr rekonstruierbar, nur sein Hash bleibt gespeichert. */
    async function createToken({ label, scopes } = {}) {
        const normalizedScopes = normalizeScopes(scopes);
        if (!normalizedScopes) return null;

        const id = crypto.randomUUID();
        const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
        const createdAt = Date.now();
        insertStmt.run({
            id,
            tokenHash: hashToken(token),
            label: label || null,
            scopesJson: JSON.stringify(normalizedScopes),
            createdAt,
        });
        return { id, token, label: label || null, scopes: normalizedScopes, createdAt };
    }

    /* Auth-Pfad: wird bei jedem /api/v1-Request mit Bearer-Header aufgerufen.
       token_hash ist der Primaerschluessel-Index, ein direkter WHERE-Lookup
       ist hier unproblematisch (kein Timing-Seitenkanal-Risiko wie bei den
       TOTP-Recovery-Codes) — um den Hash ueberhaupt zu treffen, muesste ein
       Angreifer das 256-Bit-Klartext-Token schon kennen. */
    async function findByToken(presented) {
        const row = findByHashStmt.get(hashToken(String(presented ?? '')));
        if (!row) return null;
        touchStmt.run(Date.now(), row.id);
        return rowToToken(row);
    }

    async function revokeToken(id) {
        return deleteStmt.run(id).changes > 0;
    }

    return { db, listTokens, createToken, findByToken, revokeToken };
}

module.exports = { createApiTokenStore, VALID_SCOPES };
