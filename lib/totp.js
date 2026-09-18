'use strict';

/*
 * TOTP (RFC 6238) auf HOTP (RFC 4226) aufgebaut, von Hand implementiert statt
 * per Abhaengigkeit: der Algorithmus ist ein kurzer, stabil spezifizierter
 * HMAC-Schritt, kein Bereich wie WebAuthn, in dem sich leicht ein subtiler
 * Fehler einschleicht (siehe lib/webauthn-store.js zur Abwaegung dort).
 *
 * Kein QR-Code: das Setup zeigt den Base32-Schluessel als Text plus die
 * otpauth://-URI zum Kopieren. Jede Authenticator-App akzeptiert die manuelle
 * Eingabe eines Setup-Schluessels — eine QR-Bibliothek waere eine weitere
 * Abhaengigkeit fuer reinen Komfort.
 */

const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;
const DEFAULT_WINDOW = 1; // +/- 1 Schritt = +/- 30s Uhrenversatz toleriert

function base32Encode(buffer) {
    let bits = '';
    for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
    let output = '';
    for (let i = 0; i + 5 <= bits.length; i += 5) {
        output += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
    }
    const remainder = bits.length % 5;
    if (remainder > 0) {
        const chunk = bits.slice(bits.length - remainder).padEnd(5, '0');
        output += BASE32_ALPHABET[parseInt(chunk, 2)];
    }
    return output;
}

function base32Decode(input) {
    const clean = String(input ?? '').toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bits = '';
    for (const char of clean) {
        const value = BASE32_ALPHABET.indexOf(char);
        if (value === -1) continue;
        bits += value.toString(2).padStart(5, '0');
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
        bytes.push(parseInt(bits.slice(i, i + 8), 2));
    }
    return Buffer.from(bytes);
}

function generateSecret(byteLength = 20) {
    return base32Encode(crypto.randomBytes(byteLength));
}

/* RFC 4226 HOTP: HMAC-SHA1 ueber dem 8-Byte-Zaehler, dynamische Truncation. */
function hotp(secretBuffer, counter, digits = DIGITS) {
    const counterBuffer = Buffer.alloc(8);
    counterBuffer.writeBigUInt64BE(BigInt(counter));
    const hmac = crypto.createHmac('sha1', secretBuffer).update(counterBuffer).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const binary =
        ((hmac[offset] & 0x7f) << 24) |
        ((hmac[offset + 1] & 0xff) << 16) |
        ((hmac[offset + 2] & 0xff) << 8) |
        (hmac[offset + 3] & 0xff);
    return String(binary % 10 ** digits).padStart(digits, '0');
}

function totpAt(base32Secret, time = Date.now(), step = STEP_SECONDS) {
    const counter = Math.floor(time / 1000 / step);
    return hotp(base32Decode(base32Secret), counter);
}

/*
 * Zeitfenster von +/- `window` Schritten toleriert Uhrenversatz zwischen
 * Server und Authenticator-App. Der Vergleich pro Kandidat laeuft
 * zeitkonstant — ein 6-stelliger Code ist zwar kein hochentropisches
 * Geheimnis, aber konsistent mit dem Rest der Codebase (timingSafeEqual
 * ueberall, wo ein Server- gegen einen Client-Wert geprueft wird).
 */
function verifyTotp(base32Secret, token, { window = DEFAULT_WINDOW, time = Date.now(), step = STEP_SECONDS } = {}) {
    const candidate = String(token ?? '').trim();
    if (!/^\d{6}$/.test(candidate)) return false;
    const candidateBuffer = Buffer.from(candidate);
    const counter = Math.floor(time / 1000 / step);
    const secretBuffer = base32Decode(base32Secret);

    for (let offset = -window; offset <= window; offset++) {
        const expected = Buffer.from(hotp(secretBuffer, counter + offset, candidate.length));
        if (expected.length === candidateBuffer.length && crypto.timingSafeEqual(expected, candidateBuffer)) {
            return true;
        }
    }
    return false;
}

function buildOtpauthUri({ secret, label, issuer = 'ISO Share' }) {
    const encodedLabel = encodeURIComponent(`${issuer}:${label}`);
    const params = new URLSearchParams({
        secret,
        issuer,
        algorithm: 'SHA1',
        digits: String(DIGITS),
        period: String(STEP_SECONDS),
    });
    return `otpauth://totp/${encodedLabel}?${params.toString()}`;
}

module.exports = {
    generateSecret, base32Encode, base32Decode, hotp, totpAt, verifyTotp, buildOtpauthUri,
};
