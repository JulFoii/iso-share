'use strict';

/*
 * Passkeys des einen Admin-Accounts in den Tabellen `webauthn_user` (ein
 * Datensatz: die stabile WebAuthn userId) und `webauthn_credentials` — vorher
 * ein Single-Record-JSON in uploads/.meta/webauthn.json.
 *
 * Keine Schreibkette mehr noetig: DatabaseSync ist synchron, zwei
 * "gleichzeitige" addCredential()-Aufrufe laufen damit ohnehin nacheinander
 * ab, nie ineinander verschraenkt.
 */

const crypto = require('crypto');

function rowToCredential(row) {
    return {
        credentialId: row.credential_id,
        publicKey: row.public_key,
        counter: row.counter,
        transports: JSON.parse(row.transports_json),
        label: row.label,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
    };
}

function createWebauthnStore({ db }) {
    if (!db) throw new Error('webauthn store braucht eine db');

    const getUserStmt = db.prepare('SELECT user_id FROM webauthn_user WHERE id = 1');
    const insertUserStmt = db.prepare('INSERT INTO webauthn_user (id, user_id) VALUES (1, ?)');
    const listStmt = db.prepare('SELECT * FROM webauthn_credentials ORDER BY created_at');
    const findStmt = db.prepare('SELECT * FROM webauthn_credentials WHERE credential_id = ?');
    const insertCredStmt = db.prepare(`
        INSERT INTO webauthn_credentials
            (credential_id, public_key, counter, transports_json, label, created_at, last_used_at)
        VALUES (@credentialId, @publicKey, @counter, @transportsJson, @label, @createdAt, NULL)
    `);
    const updateCounterStmt = db.prepare(
        'UPDATE webauthn_credentials SET counter = ?, last_used_at = ? WHERE credential_id = ?'
    );
    const deleteCredStmt = db.prepare('DELETE FROM webauthn_credentials WHERE credential_id = ?');

    async function getOrCreateUserId() {
        const row = getUserStmt.get();
        if (row) return row.user_id;
        const userId = crypto.randomBytes(32).toString('base64url');
        insertUserStmt.run(userId);
        return userId;
    }

    async function listCredentials() {
        // publicKey verlaesst den Server nie — wird hier fest aus jeder
        // nach aussen gegebenen Kopie entfernt statt es jedem Aufrufer zu
        // ueberlassen, das selbst zu beachten.
        return listStmt.all().map(row => {
            const { publicKey, ...rest } = rowToCredential(row);
            return rest;
        });
    }

    async function findCredential(credentialId) {
        const row = findStmt.get(credentialId);
        return row ? rowToCredential(row) : null;
    }

    async function addCredential({ credentialId, publicKey, counter, transports, label }) {
        try {
            insertCredStmt.run({
                credentialId,
                publicKey,
                counter,
                transportsJson: JSON.stringify(transports ?? []),
                label,
                createdAt: Date.now(),
            });
        } catch (err) {
            if (err.code === 'ERR_SQLITE_ERROR' && /UNIQUE/.test(err.message)) {
                throw new Error(`Passkey mit credentialId "${credentialId}" existiert bereits`);
            }
            throw err;
        }
        return findCredential(credentialId);
    }

    async function updateCounter(credentialId, newCounter) {
        updateCounterStmt.run(newCounter, Date.now(), credentialId);
    }

    async function removeCredential(credentialId) {
        return deleteCredStmt.run(credentialId).changes > 0;
    }

    return {
        db,
        getOrCreateUserId,
        listCredentials,
        findCredential,
        addCredential,
        updateCounter,
        removeCredential,
    };
}

module.exports = { createWebauthnStore };
