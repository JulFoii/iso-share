'use strict';

/*
 * Passkeys des einen Admin-Accounts als Single-Record-JSON in
 * uploads/.meta/webauthn.json — liegt bewusst im selben .meta-Ordner wie die
 * ISO-Sidecars aus metadata.js (nimmt denselben Docker-Bind-Mount mit),
 * kollidiert aber nicht mit deren <name>.iso.json-Schema, da kein ISO
 * "webauthn.json" heissen kann (safeIsoName erzwingt eine .iso-Endung).
 *
 * Anders als metadata.js gibt es hier nur EINEN Datensatz statt einem pro
 * Datei, und Aenderungen (Registrierung/Loeschung eines Passkeys) sind seltene
 * Admin-Aktionen statt eines Downloads pro Sekunde — deshalb kein Puffern,
 * jede Aenderung schreibt sofort durch. Das Atomic-Write-Muster (tmp-Datei +
 * rename) und die serialisierte Schreibkette sind trotzdem uebernommen, aus
 * denselben Gruenden wie dort: ein Absturz mitten im Schreiben darf kein
 * halbes JSON hinterlassen, und zwei gleichzeitige Aenderungen duerfen sich
 * nicht gegenseitig ueberschreiben.
 */

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');

const FILE_NAME = 'webauthn.json';

function createWebauthnStore({ dir }) {
    if (!dir) throw new Error('webauthn store braucht ein dir');

    const filePath = path.join(dir, FILE_NAME);

    // Alle Schreibvorgaenge haengen an dieser einen Kette, da es nur einen
    // Datensatz gibt (kein Map-je-Schluessel wie in metadata.js noetig).
    let writeChain = Promise.resolve();

    function serialize(task) {
        const next = writeChain.catch(() => {}).then(task);
        writeChain = next;
        return next;
    }

    async function ensureDir() {
        await fsp.mkdir(dir, { recursive: true });
    }

    async function readRaw() {
        try {
            const text = await fsp.readFile(filePath, 'utf8');
            const parsed = JSON.parse(text);
            if (!parsed || typeof parsed !== 'object') return null;
            return {
                userId: typeof parsed.userId === 'string' ? parsed.userId : null,
                credentials: Array.isArray(parsed.credentials) ? parsed.credentials : [],
            };
        } catch {
            // Nicht vorhanden oder unlesbar/kaputt — beides bedeutet
            // "noch keine Passkeys", nie einen harten Fehler.
            return null;
        }
    }

    /* Atomar: erst in eine temporaere Datei, dann rename. */
    async function writeRaw(record) {
        await ensureDir();
        const tmp = `${filePath}.${process.pid}.tmp`;
        await fsp.writeFile(tmp, JSON.stringify(record, null, 2), 'utf8');
        try {
            await fsp.rename(tmp, filePath);
        } catch (err) {
            await fsp.rm(tmp, { force: true });
            throw err;
        }
    }

    function getOrCreateUserId() {
        return serialize(async () => {
            const stored = (await readRaw()) ?? { userId: null, credentials: [] };
            if (stored.userId) return stored.userId;
            const userId = crypto.randomBytes(32).toString('base64url');
            await writeRaw({ ...stored, userId });
            return userId;
        });
    }

    async function listCredentials() {
        const stored = await readRaw();
        const credentials = stored?.credentials ?? [];
        // publicKey verlaesst den Server nie — wird hier fest aus jeder
        // nach aussen gegebenen Kopie entfernt statt es jedem Aufrufer zu
        // ueberlassen, das selbst zu beachten.
        return credentials.map(({ publicKey, ...rest }) => rest);
    }

    async function findCredential(credentialId) {
        const stored = await readRaw();
        const credentials = stored?.credentials ?? [];
        return credentials.find(c => c.credentialId === credentialId) ?? null;
    }

    function addCredential({ credentialId, publicKey, counter, transports, label }) {
        return serialize(async () => {
            const stored = (await readRaw()) ?? { userId: null, credentials: [] };
            if (stored.credentials.some(c => c.credentialId === credentialId)) {
                throw new Error(`Passkey mit credentialId "${credentialId}" existiert bereits`);
            }
            const record = {
                credentialId,
                publicKey,
                counter,
                transports: transports ?? [],
                label,
                createdAt: Date.now(),
                lastUsedAt: null,
            };
            const credentials = [...stored.credentials, record];
            await writeRaw({ ...stored, credentials });
            return record;
        });
    }

    function updateCounter(credentialId, newCounter) {
        return serialize(async () => {
            const stored = (await readRaw()) ?? { userId: null, credentials: [] };
            const credentials = stored.credentials.map(c =>
                c.credentialId === credentialId
                    ? { ...c, counter: newCounter, lastUsedAt: Date.now() }
                    : c
            );
            await writeRaw({ ...stored, credentials });
        });
    }

    function removeCredential(credentialId) {
        return serialize(async () => {
            const stored = (await readRaw()) ?? { userId: null, credentials: [] };
            const credentials = stored.credentials.filter(c => c.credentialId !== credentialId);
            const removed = credentials.length !== stored.credentials.length;
            if (removed) await writeRaw({ ...stored, credentials });
            return removed;
        });
    }

    /* Wartet, bis alle angestossenen Schreibvorgaenge durch sind. */
    function flush() {
        return writeChain.catch(() => {});
    }

    function close() {
        // Kein Timer zu stoppen — hier nur fuer Symmetrie mit
        // FileSessionStore.close()/metadata.flush(), damit stop() in
        // server.js alle Stores gleich behandeln kann.
    }

    return {
        dir,
        getOrCreateUserId,
        listCredentials,
        findCredential,
        addCredential,
        updateCounter,
        removeCredential,
        flush,
        close,
    };
}

module.exports = { createWebauthnStore };
