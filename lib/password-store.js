'use strict';

/*
 * Optionales, persistiertes Admin-Passwort als scrypt-Hash in der Tabelle
 * `admin_password` (ein Datensatz) — vorher data/admin-password.json.
 *
 * Solange dieser Datensatz nicht existiert, bleibt ADMIN_PASSWORD (Env-Var
 * oder beim Start zufaellig erzeugt) die alleinige Quelle — server.js prueft
 * das selbst, dieses Modul kennt nur "gibt es einen persistierten Hash oder
 * nicht". Sobald einmal per setPassword() geschrieben wurde, gewinnt dieser
 * Hash dauerhaft, auch nach einem Neustart.
 *
 * Kein In-Memory-Cache: jeder Aufruf liest frisch aus der DB.
 */

const crypto = require('crypto');
const { promisify } = require('util');

const scryptAsync = promisify(crypto.scrypt);
const KEY_LENGTH = 64;

function createPasswordStore({ db }) {
    if (!db) throw new Error('password store braucht eine db');

    const readStmt = db.prepare('SELECT salt, hash FROM admin_password WHERE id = 1');
    const writeStmt = db.prepare(`
        INSERT INTO admin_password (id, salt, hash) VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET salt = excluded.salt, hash = excluded.hash
    `);

    async function read() {
        const row = readStmt.get();
        return row ? { salt: row.salt, hash: row.hash } : null;
    }

    async function setPassword(plaintext) {
        const salt = crypto.randomBytes(16);
        const hash = await scryptAsync(String(plaintext), salt, KEY_LENGTH);
        const record = { salt: salt.toString('base64url'), hash: hash.toString('base64url') };
        writeStmt.run(record.salt, record.hash);
        return record;
    }

    async function verify(candidate, record) {
        const salt = Buffer.from(record.salt, 'base64url');
        const stored = Buffer.from(record.hash, 'base64url');
        const candidateHash = await scryptAsync(String(candidate ?? ''), salt, stored.length);
        return candidateHash.length === stored.length
            && crypto.timingSafeEqual(candidateHash, stored);
    }

    return { db, read, setPassword, verify };
}

module.exports = { createPasswordStore };
