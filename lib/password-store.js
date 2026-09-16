'use strict';

/*
 * Optionales, persistiertes Admin-Passwort als scrypt-Hash in
 * data/admin-password.json — liegt bewusst im selben, bereits per
 * Docker-Volume persistierten data/-Ordner wie data/sessions/.
 *
 * Solange diese Datei nicht existiert, bleibt ADMIN_PASSWORD (Env-Var oder
 * beim Start zufaellig erzeugt) die alleinige Quelle — server.js prueft das
 * selbst, dieses Modul kennt nur "gibt es einen persistierten Hash oder
 * nicht". Sobald einmal per setPassword() geschrieben wurde, gewinnt dieser
 * Hash dauerhaft, auch nach einem Neustart: Sinn der Funktion ist ja gerade,
 * das Passwort aendern zu koennen, ohne die Env-Var anzufassen.
 *
 * Kein In-Memory-Cache: jeder Aufruf liest frisch von der Platte, damit auch
 * ein zweiter Prozess auf demselben Volume eine Aenderung sofort sieht statt
 * erst nach eigenem Neustart (anders als das bisherige PASSWORD_HASH, das
 * einmal beim Start berechnet wird).
 */

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const { promisify } = require('util');

const scryptAsync = promisify(crypto.scrypt);
const KEY_LENGTH = 64;

function createPasswordStore({ file }) {
    if (!file) throw new Error('password store braucht eine file');

    async function read() {
        try {
            const text = await fsp.readFile(file, 'utf8');
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed.salt === 'string' && typeof parsed.hash === 'string') {
                return parsed;
            }
            return null;
        } catch {
            // Nicht vorhanden oder unlesbar/kaputt — beides bedeutet "kein
            // persistiertes Passwort", nie einen harten Fehler.
            return null;
        }
    }

    /* Atomar: erst in eine temporaere Datei, dann rename. */
    async function write(record) {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await fsp.writeFile(tmp, JSON.stringify(record, null, 2), 'utf8');
        try {
            await fsp.rename(tmp, file);
        } catch (err) {
            await fsp.rm(tmp, { force: true });
            throw err;
        }
    }

    async function setPassword(plaintext) {
        const salt = crypto.randomBytes(16);
        const hash = await scryptAsync(String(plaintext), salt, KEY_LENGTH);
        const record = { salt: salt.toString('base64url'), hash: hash.toString('base64url') };
        await write(record);
        return record;
    }

    async function verify(candidate, record) {
        const salt = Buffer.from(record.salt, 'base64url');
        const stored = Buffer.from(record.hash, 'base64url');
        const candidateHash = await scryptAsync(String(candidate ?? ''), salt, stored.length);
        return candidateHash.length === stored.length
            && crypto.timingSafeEqual(candidateHash, stored);
    }

    return { file, read, setPassword, verify };
}

module.exports = { createPasswordStore };
