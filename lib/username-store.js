'use strict';

/*
 * Optionaler, persistierter Admin-Benutzername als Klartext-JSON in
 * data/admin-username.json — liegt neben data/admin-password.json im
 * selben, bereits per Docker-Volume persistierten data/-Ordner.
 *
 * Anders als das Passwort ist ein Benutzername kein Geheimnis: kein
 * Hashing, kein zeitkonstanter Vergleich, kein "einmal zufaellig erzeugen
 * und persistieren"-Bootstrap noetig — der Server-Default ('admin' bzw.
 * ADMIN_USERNAME) ist schon deterministisch fix ueber Neustarts hinweg.
 * Dieser Store wird erst durch einen expliziten Aufruf von
 * POST /admin-username befuellt.
 */

const fsp = require('fs/promises');
const path = require('path');

function createUsernameStore({ file }) {
    if (!file) throw new Error('username store braucht eine file');

    async function read() {
        try {
            const text = await fsp.readFile(file, 'utf8');
            const parsed = JSON.parse(text);
            return parsed && typeof parsed.username === 'string' ? parsed.username : null;
        } catch {
            // Nicht vorhanden oder unlesbar/kaputt — beides bedeutet "kein
            // persistierter Benutzername", nie einen harten Fehler.
            return null;
        }
    }

    /* Atomar: erst in eine temporaere Datei, dann rename. */
    async function write(username) {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await fsp.writeFile(tmp, JSON.stringify({ username }, null, 2), 'utf8');
        try {
            await fsp.rename(tmp, file);
        } catch (err) {
            await fsp.rm(tmp, { force: true });
            throw err;
        }
    }

    return { file, read, write };
}

module.exports = { createUsernameStore };
