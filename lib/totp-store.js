'use strict';

/*
 * TOTP-Zweitfaktor des einen Admin-Accounts, als Single-Record-JSON in
 * uploads/.meta/totp.json — gleiches Verzeichnis wie webauthn.json (siehe
 * lib/webauthn-store.js), gleiches Atomic-Write- und Schreibketten-Muster,
 * aus denselben Gruenden.
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
const fsp = require('fs/promises');
const path = require('path');
const { base32Encode } = require('./totp');

const FILE_NAME = 'totp.json';
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

function createTotpStore({ dir }) {
    if (!dir) throw new Error('totp store braucht ein dir');

    const filePath = path.join(dir, FILE_NAME);
    let writeChain = Promise.resolve();

    function serialize(task) {
        const next = writeChain.catch(() => {}).then(task);
        writeChain = next;
        return next;
    }

    async function readRaw() {
        try {
            const text = await fsp.readFile(filePath, 'utf8');
            const parsed = JSON.parse(text);
            if (!parsed || typeof parsed !== 'object') return null;
            if (!parsed.enabled || typeof parsed.secret !== 'string') return null;
            return {
                secret: parsed.secret,
                enabled: true,
                recoveryCodeHashes: Array.isArray(parsed.recoveryCodeHashes) ? parsed.recoveryCodeHashes : [],
                createdAt: parsed.createdAt ?? null,
            };
        } catch {
            // Nicht vorhanden oder unlesbar/kaputt — beides bedeutet "kein
            // aktiver zweiter Faktor", nie einen harten Fehler.
            return null;
        }
    }

    /* Atomar: erst in eine temporaere Datei, dann rename. */
    async function writeRaw(record) {
        await fsp.mkdir(dir, { recursive: true });
        const tmp = `${filePath}.${process.pid}.tmp`;
        await fsp.writeFile(tmp, JSON.stringify(record, null, 2), 'utf8');
        try {
            await fsp.rename(tmp, filePath);
        } catch (err) {
            await fsp.rm(tmp, { force: true });
            throw err;
        }
    }

    async function isEnabled() {
        return Boolean(await readRaw());
    }

    async function getSecret() {
        const stored = await readRaw();
        return stored?.secret ?? null;
    }

    /*
     * Aktiviert TOTP mit einem bereits verifizierten Secret und erzeugt
     * frische Recovery-Codes. Gibt sie EINMAL im Klartext zurueck — persistiert
     * wird nur ihr Hash, genau wie beim Passwort.
     */
    function enable(secret) {
        return serialize(async () => {
            const rawCodes = Array.from(
                { length: RECOVERY_CODE_COUNT },
                () => base32Encode(crypto.randomBytes(10)) // 16 Base32-Zeichen
            );
            const record = {
                secret,
                enabled: true,
                recoveryCodeHashes: rawCodes.map(raw => hashCode(normalizeRecoveryCode(raw))),
                createdAt: Date.now(),
            };
            await writeRaw(record);
            return rawCodes.map(prettyRecoveryCode);
        });
    }

    function disable() {
        return serialize(() => fsp.rm(filePath, { force: true }));
    }

    /* Verbraucht einen Recovery-Code beim Treffer (Single-Use, zeitkonstanter
       Vergleich gegen jeden gespeicherten Hash). */
    function consumeRecoveryCode(candidate) {
        return serialize(async () => {
            const stored = await readRaw();
            if (!stored || stored.recoveryCodeHashes.length === 0) return false;

            const candidateHash = Buffer.from(hashCode(normalizeRecoveryCode(candidate)));
            const index = stored.recoveryCodeHashes.findIndex(hash => {
                const hashBuffer = Buffer.from(hash);
                return hashBuffer.length === candidateHash.length
                    && crypto.timingSafeEqual(hashBuffer, candidateHash);
            });
            if (index === -1) return false;

            const recoveryCodeHashes = stored.recoveryCodeHashes.filter((_, i) => i !== index);
            await writeRaw({ ...stored, recoveryCodeHashes });
            return true;
        });
    }

    function flush() {
        return writeChain.catch(() => {});
    }

    function close() {
        // Kein Timer zu stoppen — nur fuer Symmetrie mit den anderen Stores.
    }

    return {
        dir, isEnabled, getSecret, enable, disable, consumeRecoveryCode, flush, close,
    };
}

module.exports = { createTotpStore };
