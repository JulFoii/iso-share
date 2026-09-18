'use strict';

/*
 * TOTP-Zweitfaktor des einen Admin-Accounts in den Tabellen `totp` (ein
 * Datensatz: Secret) und `totp_recovery_codes` (Hashes) — vorher ein
 * Single-Record-JSON in uploads/.meta/totp.json.
 *
 * Ein per /totp/setup erzeugtes, aber noch nicht bestaetigtes Geheimnis wird
 * NICHT hier persistiert, sondern nur in der Session gehalten
 * (req.session.totpSetupSecret) — dasselbe Muster wie die WebAuthn-Challenge.
 * Erst enable() mit einem bereits verifizierten Code schreibt einen
 * aktivierten Datensatz; ein abgebrochenes Setup hinterlaesst so nie einen
 * halb eingerichteten, aber schon "vorhandenen" zweiten Faktor.
 *
 * Recovery-Codes sind serverseitig zufaellig erzeugt (nicht nutzergewaehlt)
 * und damit schon hochentropisch — anders als das nutzergewaehlte
 * Admin-Passwort reicht hier ein einfacher SHA-256-Hash statt scrypt, siehe
 * dieselbe Abwaegung in server.js bei PASSWORD_HASH.
 */

const crypto = require('crypto');
const { base32Encode } = require('./totp');

const RECOVERY_CODE_COUNT = 8;

function hashCode(normalized) {
    return crypto.createHash('sha256').update(normalized).digest('hex');
}

function normalizeRecoveryCode(input) {
    return String(input ?? '').toUpperCase().replace(/[^A-Z2-7]/g, '');
}

function prettyRecoveryCode(raw) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
}

function createTotpStore({ db }) {
    if (!db) throw new Error('totp store braucht eine db');

    const readStmt = db.prepare('SELECT secret FROM totp WHERE id = 1');
    const insertTotpStmt = db.prepare(`
        INSERT INTO totp (id, secret, created_at) VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET secret = excluded.secret, created_at = excluded.created_at
    `);
    const deleteTotpStmt = db.prepare('DELETE FROM totp WHERE id = 1');
    const deleteCodesStmt = db.prepare('DELETE FROM totp_recovery_codes');
    const insertCodeStmt = db.prepare('INSERT INTO totp_recovery_codes (hash) VALUES (?)');
    const deleteCodeStmt = db.prepare('DELETE FROM totp_recovery_codes WHERE hash = ?');
    const allCodesStmt = db.prepare('SELECT hash FROM totp_recovery_codes');

    async function isEnabled() {
        return Boolean(readStmt.get());
    }

    async function getSecret() {
        return readStmt.get()?.secret ?? null;
    }

    /*
     * Aktiviert TOTP mit einem bereits verifizierten Secret und erzeugt
     * frische Recovery-Codes. Gibt sie EINMAL im Klartext zurueck — persistiert
     * wird nur ihr Hash, genau wie beim Passwort.
     */
    async function enable(secret) {
        const rawCodes = Array.from(
            { length: RECOVERY_CODE_COUNT },
            () => base32Encode(crypto.randomBytes(10)) // 16 Base32-Zeichen
        );
        // In einer Transaktion: ohne das koennte ein Prozessabbruch (OOM,
        // Neustart) zwischen den drei Statements TOTP als aktiviert
        // zuruecklassen, aber mit fehlenden/unvollstaendigen Recovery-Codes —
        // ein zweiter Faktor, dessen Recovery-Fallback kaputt ist, ohne dass
        // das irgendwo sichtbar waere.
        db.exec('BEGIN');
        try {
            insertTotpStmt.run(secret, Date.now());
            deleteCodesStmt.run();
            for (const raw of rawCodes) {
                insertCodeStmt.run(hashCode(normalizeRecoveryCode(raw)));
            }
            db.exec('COMMIT');
        } catch (err) {
            db.exec('ROLLBACK');
            throw err;
        }
        return rawCodes.map(prettyRecoveryCode);
    }

    async function disable() {
        db.exec('BEGIN');
        try {
            deleteTotpStmt.run();
            deleteCodesStmt.run();
            db.exec('COMMIT');
        } catch (err) {
            db.exec('ROLLBACK');
            throw err;
        }
    }

    /* Verbraucht einen Recovery-Code beim Treffer (Single-Use, zeitkonstanter
       Vergleich gegen jeden gespeicherten Hash). */
    async function consumeRecoveryCode(candidate) {
        const candidateHash = Buffer.from(hashCode(normalizeRecoveryCode(candidate)));
        const match = allCodesStmt.all().find(row => {
            const hashBuffer = Buffer.from(row.hash);
            return hashBuffer.length === candidateHash.length
                && crypto.timingSafeEqual(hashBuffer, candidateHash);
        });
        if (!match) return false;
        deleteCodeStmt.run(match.hash);
        return true;
    }

    return { db, isEnabled, getSecret, enable, disable, consumeRecoveryCode };
}

module.exports = { createTotpStore };
