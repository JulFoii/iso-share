'use strict';

/*
 * Startet eine echte Instanz auf einem freien Port, mit eigenen
 * Verzeichnissen in einem Temp-Ordner. Kein supertest & Co. — Node bringt
 * fetch und den Test-Runner mit, und das Projekt haelt seine
 * Abhaengigkeitsliste absichtlich kurz.
 */

const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { once } = require('events');

const { createApp } = require('../../server');

const QUIET = { log() {}, warn() {}, error() {} };

async function startTestApp(overrides = {}) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'iso-share-test-'));

    const instance = createApp({
        uploadsDir: path.join(root, 'uploads'),
        tmpDir: path.join(root, 'tmp-uploads'),
        dataDir: path.join(root, 'data'),
        adminPassword: 'korrekt-horse-battery',
        sessionSecret: 'test-secret',
        maxFileSizeMb: 1,
        scanOnStart: false,
        sweepStaleUploads: false,
        log: QUIET,
        ...overrides,
    });

    await instance.start();
    const server = instance.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;

    return {
        base,
        root,
        instance,
        services: instance.services,
        uploadsDir: path.join(root, 'uploads'),

        url: pathname => base + pathname,

        /* Loggt sich ein und gibt den Cookie-Header zurueck. Default-
           Benutzername passt zu DEFAULT_ADMIN_USERNAME in server.js. */
        async login(password = 'korrekt-horse-battery', username = 'admin') {
            const res = await fetch(`${base}/login`, {
                method: 'POST',
                redirect: 'manual',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ username, password }).toString(),
            });
            const cookie = (res.headers.getSetCookie() || [])
                .map(value => value.split(';')[0])
                .join('; ');
            return { res, cookie };
        },

        /* Beendet den Server, laesst die Verzeichnisse aber stehen — fuer
           Tests, die dieselben Daten mit einer neuen Instanz weiterbenutzen
           (Neustart-Szenario). */
        async shutdown() {
            server.close();
            // fetch haelt Keep-alive-Sockets offen; ohne das wartet close()
            // bis zum Timeout des Agents (~3 s je Test).
            server.closeAllConnections();
            await once(server, 'close');
            await instance.stop();
        },

        async close() {
            await this.shutdown().catch(() => {});
            await fsp.rm(root, { recursive: true, force: true });
        },
    };
}

module.exports = { startTestApp };
