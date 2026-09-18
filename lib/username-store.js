'use strict';

/*
 * Optionaler, persistierter Admin-Benutzername in der Tabelle
 * `admin_username` (ein Datensatz) — vorher data/admin-username.json.
 *
 * Anders als das Passwort ist ein Benutzername kein Geheimnis: kein Hashing,
 * kein zeitkonstanter Vergleich, kein "einmal zufaellig erzeugen und
 * persistieren"-Bootstrap noetig — der Server-Default ('admin' bzw.
 * ADMIN_USERNAME) ist schon deterministisch fix ueber Neustarts hinweg.
 * Dieser Store wird erst durch einen expliziten Aufruf von
 * POST /admin-username befuellt.
 */

function createUsernameStore({ db }) {
    if (!db) throw new Error('username store braucht eine db');

    const readStmt = db.prepare('SELECT username FROM admin_username WHERE id = 1');
    const writeStmt = db.prepare(`
        INSERT INTO admin_username (id, username) VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET username = excluded.username
    `);

    async function read() {
        return readStmt.get()?.username ?? null;
    }

    async function write(username) {
        writeStmt.run(username);
    }

    return { db, read, write };
}

module.exports = { createUsernameStore };
