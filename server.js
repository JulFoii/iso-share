'use strict';

const express = require('express');
const multer = require('multer');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');

const { safeIsoName, safeUploadId } = require('./lib/safe-name');
const { moveFile } = require('./lib/move-file');
const { createMetadataStore } = require('./lib/metadata');
const { createHashQueue } = require('./lib/hash-queue');
const { createUploadSessions, UploadError } = require('./lib/chunked-upload');
const { FileSessionStore } = require('./lib/session-store');

const DEFAULT_MAX_FILE_SIZE_MB = 8192;
const STALE_UPLOAD_SWEEP_MS = 60 * 60 * 1000;

/* ==========================================================================
   App-Aufbau

   Alles laeuft ueber createApp(), damit die Tests eine Instanz mit eigenen
   Verzeichnissen und eigenem Passwort bekommen, ohne den Prozess zu starten.
   Die Umgebungsvariablen sind nur die Defaults dieser Funktion.
   ========================================================================== */

function createApp(options = {}) {
    const {
        uploadsDir = path.join(__dirname, 'uploads'),
        tmpDir = path.join(__dirname, 'tmp-uploads'),
        sessionDir = process.env.SESSION_DIR
            || path.join(__dirname, 'data', 'sessions'),
        maxFileSizeMb = Number(process.env.MAX_FILE_SIZE_MB)
            || DEFAULT_MAX_FILE_SIZE_MB,
        isProd = process.env.NODE_ENV === 'production',
        trustProxy = process.env.TRUST_PROXY,
        // Tests uebergeben beides direkt und loesen so keine Warnung aus
        adminPassword: passwordOption,
        sessionSecret: secretOption,
        // Der Startscan liest jede Datei in uploads/ einmal durch — im Test
        // unerwuenscht, im Betrieb genau richtig.
        scanOnStart = true,
        sweepStaleUploads = true,
        log = console,
    } = options;

    const UPLOADS_DIR = path.resolve(uploadsDir);
    const TMP_DIR = path.resolve(tmpDir);
    const MAX_FILE_SIZE_MB = maxFileSizeMb;
    const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

    /* ----------------------------------------------------------- Secrets --
       Kein funktionsfaehiger Default. Ist nichts gesetzt, wird ein
       zufaelliges Passwort erzeugt und EINMAL geloggt, statt auf ein im Repo
       bekanntes zurueckzufallen. */

    let ADMIN_PASSWORD = passwordOption ?? process.env.ADMIN_PASSWORD;
    if (!ADMIN_PASSWORD) {
        ADMIN_PASSWORD = crypto.randomBytes(18).toString('base64url');
        log.warn(
            '\n⚠️  ADMIN_PASSWORD ist nicht gesetzt. Einmalig generiertes Passwort:\n' +
            `    ${ADMIN_PASSWORD}\n` +
            '    Setze ADMIN_PASSWORD als Umgebungsvariable, um ein festes zu verwenden.\n'
        );
    }

    // SHA-256 des Passworts einmal vorab, damit der Vergleich zeitkonstant und
    // unabhaengig von der Laenge laeuft.
    const PASSWORD_HASH = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();

    let SESSION_SECRET = secretOption ?? process.env.SESSION_SECRET;
    if (!SESSION_SECRET) {
        SESSION_SECRET = crypto.randomBytes(32).toString('hex');
        log.warn(
            '⚠️  SESSION_SECRET ist nicht gesetzt — es wird ein flüchtiges pro Start\n' +
            '    erzeugt. Bestehende Sitzungen gehen bei jedem Neustart verloren.\n'
        );
    }

    function passwordMatches(candidate) {
        const candidateHash = crypto
            .createHash('sha256')
            .update(String(candidate ?? ''))
            .digest();
        return crypto.timingSafeEqual(candidateHash, PASSWORD_HASH);
    }

    /* --------------------------------------------------------- Dienste -- */

    const metadata = createMetadataStore({
        dir: path.join(UPLOADS_DIR, '.meta'),
    });
    const hashQueue = createHashQueue({ uploadsDir: UPLOADS_DIR, metadata, log });
    const uploadSessions = createUploadSessions({
        tmpDir: TMP_DIR,
        uploadsDir: UPLOADS_DIR,
        maxBytes: MAX_FILE_SIZE_BYTES,
    });
    const sessionStore = new FileSessionStore({ dir: sessionDir });

    const app = express();

    /* ------------------------------------------- Sicherheits-Middleware -- */

    app.disable('x-powered-by');

    // Hinter einem Reverse Proxy (TLS-Terminierung) korrekt Secure-Cookies
    // setzen. Eine reine Zahl muss als Number uebergeben werden (Anzahl Hops)
    // — als String interpretiert Express sie sonst als Adressliste, und
    // req.secure bliebe false.
    if (trustProxy) {
        app.set(
            'trust proxy',
            /^\d+$/.test(String(trustProxy)) ? Number(trustProxy) : trustProxy
        );
    }

    // Security-Header inkl. CSP. Alles wird selbst gehostet, daher 'self';
    // data: nur fuer das Grain-SVG und das Favicon; keine Inline-Skripte.
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'"],
                styleSrc: ["'self'"],
                imgSrc: ["'self'", 'data:'],
                fontSrc: ["'self'"],
                connectSrc: ["'self'"],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
                formAction: ["'self'"],
                frameAncestors: ["'none'"],
                upgradeInsecureRequests: isProd ? [] : null,
            },
        },
        hsts: isProd,
        crossOriginResourcePolicy: { policy: 'same-origin' },
        // same-origin: eigene Requests behalten den Referer (dient dem
        // CSRF-Check als Fallback), zu fremden Seiten wird nichts geleakt.
        referrerPolicy: { policy: 'same-origin' },
    }));

    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, 'views'));

    // Nur public/ statisch ausliefern. uploads/ wird bewusst NICHT eingebunden
    // — Downloads laufen ausschliesslich ueber die /download-Route mit
    // Namenspruefung, damit keine hochgeladene Nicht-ISO als HTML rausgeht.
    app.use(express.static(path.join(__dirname, 'public'), {
        maxAge: '1h',
        dotfiles: 'ignore',
    }));

    // Bewusst kleine Body-Limits — hier fliesst nur ein Passwort, ein
    // Dateiname oder der kleine JSON-Kopf eines Uploads. Die Chunks selbst
    // kommen als application/octet-stream und werden gestreamt, nicht
    // gepuffert; kein Body-Parser fasst sie an.
    app.use(express.urlencoded({ extended: false, limit: '16kb' }));
    app.use(express.json({ limit: '16kb' }));

    app.use(session({
        name: 'iso.sid',
        secret: SESSION_SECRET,
        store: sessionStore,
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            // sameSite:'strict' blockiert das Mitsenden bei Cross-Site-
            // Requests und ist damit die primaere CSRF-Abwehr.
            sameSite: 'strict',
            // Secure sobald prod oder hinter Proxy — sonst waere lokal ohne
            // TLS gar kein Login moeglich.
            secure: isProd || Boolean(trustProxy),
            maxAge: 1000 * 60 * 60 * 24,
        },
    }));

    /*
     * CSRF-Abwehr als ZWEITE Verteidigungslinie zusaetzlich zu
     * SameSite=strict. Primaerschutz ist das Cookie: ein Cross-Site-POST
     * traegt das Sitzungs-Cookie gar nicht erst, checkAuth schlaegt dann fehl.
     *
     * Dieser Check verwirft zusaetzlich Anfragen, deren Origin/Referer
     * nachweislich von fremdem Host stammt. Er darf aber legitime Logins nicht
     * aussperren: Browser senden in mehreren harmlosen Faellen `Origin: null`
     * oder gar keinen Origin. Solche nicht-auswertbaren Faelle werden
     * durchgelassen (SameSite schuetzt weiterhin) — abgelehnt wird nur ein
     * eindeutig fremder Host.
     */
    function hostOf(value) {
        if (!value || value === 'null') return null;
        try {
            return new URL(value).host;
        } catch {
            return null;
        }
    }

    function sameOrigin(req, res, next) {
        const sourceHost = hostOf(req.get('origin')) ?? hostOf(req.get('referer'));
        // Kein auswertbarer Origin/Referer -> nicht blockieren, SameSite greift
        if (sourceHost === null) {
            return next();
        }
        if (sourceHost !== req.get('host')) {
            return res.status(403).send('Cross-Origin-Anfrage abgelehnt.');
        }
        next();
    }

    app.use((req, res, next) => {
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
            return sameOrigin(req, res, next);
        }
        next();
    });

    /* ------------------------------------------------------ Rate-Limits -- */

    // Login gedrosselt gegen Brute-Force, in zwei Ebenen: ein per Reverse
    // Proxy fehlkonfiguriertes `trust proxy` leitet die IP aus
    // X-Forwarded-For ab, und ein Angreifer koennte die pro-IP-Sperre sonst
    // durch gefaelschte Header umgehen.
    //   1. pro IP (feinkoernig, zaehlt nur Fehlversuche)
    //   2. global als Backstop, das auch bei IP-Spoofing greift
    const TOO_MANY = 'Zu viele Anmeldeversuche. Bitte später erneut versuchen.';

    const loginLimiterPerIp = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 10,
        standardHeaders: true,
        legacyHeaders: false,
        skipSuccessfulRequests: true,   // nur fehlgeschlagene Logins zaehlen
        message: TOO_MANY,
    });

    // Ein Bucket fuer alle: begrenzt die Gesamtzahl fehlgeschlagener Logins
    // und kann durch keinen gefaelschten Header umgangen werden. Bewusst
    // grosszuegig, damit normaler Betrieb nicht blockiert wird (Kehrseite:
    // theoretisch als Login-DoS missbrauchbar — fuer eine Single-Admin-
    // Instanz akzeptabel).
    const loginLimiterGlobal = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 100,
        standardHeaders: false,
        legacyHeaders: false,
        skipSuccessfulRequests: true,
        keyGenerator: () => 'global',
        message: TOO_MANY,
    });

    // /download ist die teuerste Route der App und die einzige
    // unauthentifizierte, die echtes I/O ausloest. Das Limit ist so gesetzt,
    // dass ein Download-Manager mit mehreren parallelen Range-Verbindungen
    // nicht dagegenlaeuft.
    const downloadLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 60,
        standardHeaders: true,
        legacyHeaders: false,
        message: 'Zu viele Download-Anfragen. Bitte kurz warten.',
    });

    /* ----------------------------------------------- Multipart-Fallback --
       Der eigentliche Upload laeuft fortsetzbar ueber /upload/init +
       PATCH (siehe lib/chunked-upload.js). Dieses Formular bleibt fuer
       Browser ohne JavaScript. */

    const upload = multer({
        dest: TMP_DIR,
        limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 },
    });

    /* ---------------------------------------------------- View-Helfer -- */

    app.locals.formatSize = function formatSize(bytes) {
        if (!bytes) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        const exponent = Math.min(
            Math.floor(Math.log(bytes) / Math.log(1024)),
            units.length - 1
        );
        const value = bytes / 1024 ** exponent;
        return `${value.toFixed(value < 10 && exponent > 0 ? 1 : 0)} ${units[exponent]}`;
    };

    app.locals.formatDate = function formatDate(timestamp) {
        return new Intl.DateTimeFormat('de-DE', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
        }).format(new Date(timestamp));
    };

    /* --------------------------------------------------- Dateiauflistung --
       Asynchron, damit die Datei-I/O den Event-Loop nicht blockiert
       (verhindert eine DoS-Flaeche auf den unauthentifizierten Routen / und
       /search bei vielen Dateien). stat() und Metadaten laufen parallel. */

    async function describe(name) {
        const stats = await fsp.stat(path.join(UPLOADS_DIR, name));
        const meta = await metadata.read(name);
        // Checksumme und Volume-Infos gelten nur, solange Groesse und mtime
        // zu dem passen, was beim Hashen galt — sonst wuerde nach einem
        // Ueberschreiben der alte Hash zur neuen Datei angezeigt.
        const current = metadata.hasCurrentChecksum(meta, stats);

        return {
            name,
            size: stats.size,
            mtime: stats.mtimeMs,
            downloads: meta?.downloads ?? 0,
            sha256: current ? meta.sha256 : null,
            iso: current ? (meta.iso ?? null) : null,
            // 'done' | 'hashing' | 'queued' | 'pending'
            hashStatus: current ? 'done' : (hashQueue.statusOf(name) ?? 'pending'),
        };
    }

    async function listFiles(query = '') {
        await fsp.mkdir(UPLOADS_DIR, { recursive: true });

        const needle = query.toLowerCase();
        const names = (await fsp.readdir(UPLOADS_DIR)).filter(
            name =>
                name.toLowerCase().endsWith('.iso') &&
                name.toLowerCase().includes(needle)
        );

        const files = await Promise.all(names.map(describe));
        return files.sort((a, b) => a.name.localeCompare(b.name, 'de'));
    }

    function checkAuth(req, res, next) {
        if (req.session && req.session.loggedIn) {
            return next();
        }
        if (req.accepts(['html', 'json']) === 'json') {
            return res.status(401).json({ error: 'Nicht angemeldet.' });
        }
        res.redirect('/login');
    }

    /* ============================================================ Routen */

    app.get('/', async (req, res, next) => {
        const loggedIn = Boolean(req.session && req.session.loggedIn);
        try {
            res.render('index', { files: await listFiles(), loggedIn });
        } catch (err) {
            next(err);
        }
    });

    app.get('/download/:filename', downloadLimiter, async (req, res, next) => {
        const filename = safeIsoName(req.params.filename);
        if (!filename) {
            return res.status(400).send('Invalid filename');
        }
        const filePath = path.join(UPLOADS_DIR, filename);
        try {
            await fsp.access(filePath);
        } catch {
            return res.status(404).send('Datei nicht gefunden');
        }

        // Range-Requests nicht mitzaehlen: ein Download-Manager mit acht
        // parallelen Verbindungen ist ein Download, nicht acht.
        const countable = !req.get('range');

        res.download(filePath, err => {
            if (err) {
                // Verbindungsabbruch waehrend des Streams ist kein Serverfehler
                if (!res.headersSent) next(err);
                return;
            }
            if (countable) metadata.recordDownload(filename);
        });
    });

    /*
     * SHA256SUMS im Format von coreutils, damit
     *   sha256sum -c SHA256SUMS
     * direkt durchlaeuft. Dateien, deren Checksumme noch berechnet wird,
     * fehlen hier — lieber eine unvollstaendige Liste als eine falsche Zeile.
     */
    app.get('/checksums', async (req, res, next) => {
        try {
            const files = await listFiles();
            const lines = files
                .filter(file => file.sha256)
                .map(file => `${file.sha256}  ${file.name}`);

            res.type('text/plain; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename="SHA256SUMS"');
            res.send(lines.length > 0 ? `${lines.join('\n')}\n` : '');
        } catch (err) {
            next(err);
        }
    });

    /*
     * Fuer den Docker-Healthcheck. Bewusst ohne Verzeichnis-Listing: der
     * alte Check lief gegen / und hat dafuer alle 30 Sekunden die komplette
     * Dateiliste samt Metadaten gerendert.
     */
    app.get('/healthz', (req, res) => {
        res.json({
            status: 'ok',
            uptime: Math.round(process.uptime()),
            hashing: hashQueue.isIdle() ? 'idle' : 'busy',
        });
    });

    app.get('/login', (req, res) => {
        res.render('login', { error: null });
    });

    app.post('/login', loginLimiterGlobal, loginLimiterPerIp, (req, res) => {
        if (passwordMatches(req.body.password)) {
            // Session-ID nach erfolgreichem Login neu vergeben (Fixation)
            req.session.regenerate(err => {
                if (err) {
                    log.error('Session regenerate error:', err);
                    return res.status(500).render('login', { error: 'Serverfehler.' });
                }
                req.session.loggedIn = true;
                res.redirect('/admin-upload');
            });
        } else {
            res.status(401).render('login', { error: 'Falsches Passwort!' });
        }
    });

    app.get('/admin-upload', checkAuth, async (req, res, next) => {
        try {
            res.render('admin', {
                files: await listFiles(),
                maxFileSizeMb: MAX_FILE_SIZE_MB,
            });
        } catch (err) {
            next(err);
        }
    });

    /* ------------------------------------------- Fortsetzbarer Upload -- */

    function sendUploadError(res, err, log) {
        if (err instanceof UploadError) {
            const body = { error: err.message };
            // Den Serverstand mitschicken: der Client kann damit
            // resynchronisieren, statt von vorn anzufangen.
            if (err.extra.offset !== undefined) body.offset = err.extra.offset;
            if (err.extra.size !== undefined) body.size = err.extra.size;
            return res.status(err.status).json(body);
        }
        log.error('Upload error:', err);
        res.status(500).json({ error: 'Upload fehlgeschlagen.' });
    }

    app.post('/upload/init', checkAuth, async (req, res) => {
        try {
            const state = await uploadSessions.create({
                name: req.body.name,
                size: Number(req.body.size),
            });
            res.status(201).json(state);
        } catch (err) {
            sendUploadError(res, err, log);
        }
    });

    app.get('/upload/:id', checkAuth, async (req, res) => {
        const id = safeUploadId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Ungültige Upload-ID.' });
        try {
            res.json(await uploadSessions.get(id));
        } catch (err) {
            sendUploadError(res, err, log);
        }
    });

    // Der Request-Stream geht direkt in die .part-Datei; nichts wird im
    // Speicher gepuffert, darum sind auch grosse Chunks unkritisch.
    app.patch('/upload/:id', checkAuth, async (req, res) => {
        const id = safeUploadId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Ungültige Upload-ID.' });

        const header = req.get('upload-offset');
        const claimed = /^\d+$/.test(String(header ?? '')) ? Number(header) : NaN;

        try {
            const state = await uploadSessions.append(id, claimed, req);
            res.json({
                offset: state.offset,
                size: state.size,
                complete: state.complete,
            });
        } catch (err) {
            sendUploadError(res, err, log);
        }
    });

    app.post('/upload/:id/finish', checkAuth, async (req, res) => {
        const id = safeUploadId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Ungültige Upload-ID.' });
        try {
            const { filename } = await uploadSessions.finish(id);
            // Checksumme und Volume-Infos laufen im Hintergrund nach
            hashQueue.enqueue(filename);
            res.status(201).json({ filename });
        } catch (err) {
            sendUploadError(res, err, log);
        }
    });

    app.delete('/upload/:id', checkAuth, async (req, res) => {
        const id = safeUploadId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Ungültige Upload-ID.' });
        await uploadSessions.abort(id);
        res.status(204).end();
    });

    /* ------------------------------------------- Upload ohne JavaScript -- */

    app.post('/upload', checkAuth, (req, res) => {
        const wantsJson = req.accepts(['html', 'json']) === 'json';
        const fail = (status, message) => {
            if (wantsJson) return res.status(status).json({ error: message });
            return res.status(status).send(message);
        };

        upload.single('file')(req, res, async err => {
            if (err) {
                if (err.code === 'LIMIT_FILE_SIZE') {
                    return fail(413, `Datei überschreitet ${MAX_FILE_SIZE_MB} MB.`);
                }
                log.error('Upload error:', err);
                return fail(400, 'Upload fehlgeschlagen.');
            }

            const file = req.file;
            if (!file) {
                return fail(400, 'Keine Datei empfangen.');
            }

            const filename = safeIsoName(file.originalname);
            if (!filename) {
                await fsp.rm(file.path, { force: true });
                return fail(400, 'Ungültiger Name — nur .iso-Dateien sind erlaubt.');
            }

            try {
                await fsp.mkdir(UPLOADS_DIR, { recursive: true });
                await moveFile(file.path, path.join(UPLOADS_DIR, filename));
            } catch (moveErr) {
                log.error('Upload move error:', moveErr);
                await fsp.rm(file.path, { force: true });
                return fail(500, 'Datei konnte nicht gespeichert werden.');
            }

            hashQueue.enqueue(filename);

            if (wantsJson) return res.status(201).json({ filename });
            res.redirect('/admin-upload');
        });
    });

    app.post('/delete', checkAuth, async (req, res, next) => {
        const filename = safeIsoName(req.body.filename);
        if (!filename) {
            return res.status(400).send('Ungültiger Dateiname.');
        }
        const filePath = path.join(UPLOADS_DIR, filename);
        // Sicherstellen, dass der aufgeloeste Pfad wirklich in uploads/ liegt
        if (path.dirname(filePath) !== UPLOADS_DIR) {
            return res.status(400).send('Ungültiger Dateiname.');
        }
        try {
            await fsp.rm(filePath, { force: true }); // force: kein Fehler, wenn weg
            // Sidecar mit entfernen, sonst zeigt ein spaeteres Image mit
            // gleichem Namen die Checksumme des alten.
            await metadata.remove(filename);
        } catch (err) {
            return next(err);
        }
        res.redirect('/admin-upload');
    });

    app.get('/logout', (req, res) => {
        req.session.destroy(() => {
            res.clearCookie('iso.sid');
            res.redirect('/');
        });
    });

    app.get('/privacy', (req, res) => {
        res.render('privacy', { loggedIn: Boolean(req.session && req.session.loggedIn) });
    });

    app.get('/imprint', (req, res) => {
        res.render('imprint', { loggedIn: Boolean(req.session && req.session.loggedIn) });
    });

    app.get('/search', async (req, res, next) => {
        const query = String(req.query.q || '').slice(0, 200);
        try {
            res.render('index', {
                files: await listFiles(query),
                searchQuery: query,
                loggedIn: Boolean(req.session && req.session.loggedIn),
            });
        } catch (err) {
            next(err);
        }
    });

    app.get('/admin-search', checkAuth, async (req, res, next) => {
        const query = String(req.query.q || '').slice(0, 200);
        try {
            res.render('admin', {
                files: await listFiles(query),
                searchQuery: query,
                maxFileSizeMb: MAX_FILE_SIZE_MB,
            });
        } catch (err) {
            next(err);
        }
    });

    /* ------------------------------------------------- Fehlerbehandlung --
       Nie Stacktraces nach aussen. */

    app.use((req, res) => {
        res.status(404).send('Nicht gefunden');
    });

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        log.error('Unhandled error:', err);
        if (res.headersSent) return next(err);
        res.status(500).send('Serverfehler');
    });

    /* -------------------------------------------------- Hintergrundlauf -- */

    const timers = [];

    if (sweepStaleUploads) {
        const sweep = setInterval(() => {
            uploadSessions.cleanupStale().catch(() => {});
        }, STALE_UPLOAD_SWEEP_MS);
        if (typeof sweep.unref === 'function') sweep.unref();
        timers.push(sweep);
    }

    async function start() {
        await fsp.mkdir(UPLOADS_DIR, { recursive: true });
        await fsp.mkdir(TMP_DIR, { recursive: true });
        await uploadSessions.cleanupStale().catch(() => {});
        if (scanOnStart) {
            const missing = await hashQueue.scanAll();
            if (missing > 0) {
                log.log(`🔢 ${missing} Datei(en) ohne Checksumme — wird im Hintergrund berechnet.`);
            }
        }
    }

    /* Offene Zaehler und Sitzungen wegschreiben, Timer abbauen. */
    async function stop() {
        timers.forEach(clearInterval);
        sessionStore.close();
        await Promise.all([metadata.flush(), sessionStore.settled()]);
    }

    return {
        app,
        start,
        stop,
        // fuer Tests und /healthz
        services: { metadata, hashQueue, uploadSessions, sessionStore, listFiles },
    };
}

/* ==========================================================================
   Prozessstart — nur wenn direkt aufgerufen, nicht beim require aus Tests
   ========================================================================== */

if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    const instance = createApp();

    instance.start()
        .then(() => {
            const server = instance.app.listen(PORT, () => {
                console.log(`🚀 Server läuft auf http://localhost:${PORT}`);
            });

            // SIGTERM kommt von `docker stop`. Ohne das Flush waeren die
            // seit dem letzten Intervall gezaehlten Downloads verloren.
            const shutdown = signal => async () => {
                console.log(`\n${signal} empfangen — beende.`);
                server.close();
                await instance.stop().catch(() => {});
                process.exit(0);
            };
            process.once('SIGTERM', shutdown('SIGTERM'));
            process.once('SIGINT', shutdown('SIGINT'));
        })
        .catch(err => {
            console.error('Start fehlgeschlagen:', err);
            process.exit(1);
        });
}

module.exports = { createApp };
