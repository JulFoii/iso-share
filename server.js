'use strict';

/*
 * @simplewebauthn/server prueft beim Laden einmalig, ob die Node-Laufzeit
 * experimentelle Post-Quantum-Algorithmen (ML-DSA) unterstuetzt — fuer
 * Attestation-Formate, die wir mit attestationType:'none' nie anfragen. Das
 * loest bei jedem Start zwei ExperimentalWarning-Meldungen von Node selbst
 * aus, unabhaengig davon, wie wir die Bibliothek nutzen.
 *
 * Ein process.on('warning', ...)-Listener reicht dafuer NICHT: Node haengt
 * seinen eigenen stderr-Printer schon beim Bootstrap an dasselbe Event, und
 * der laeuft unabhaengig von jedem eigenen Listener weiter. Nur ein
 * Abfangen vor der Event-Emission — also am emitWarning-Aufruf selbst —
 * unterdrueckt die Ausgabe tatsaechlich. Alles andere geht unveraendert an
 * die urspruengliche Funktion durch.
 */
const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = function (warning, typeOrOptions, ...rest) {
    const message = typeof warning === 'string' ? warning : warning?.message;
    const type = typeof typeOrOptions === 'string' ? typeOrOptions : typeOrOptions?.type;
    if (type === 'ExperimentalWarning' && /Web Crypto API|ML-DSA/.test(message ?? '')) {
        return;
    }
    return originalEmitWarning(warning, typeOrOptions, ...rest);
};

const express = require('express');
const multer = require('multer');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');

const {
    safeIsoName, safeUploadId, safeCredentialId, safePasskeyLabel, safeUsername,
} = require('./lib/safe-name');
const { moveFile } = require('./lib/move-file');
const { createMetadataStore } = require('./lib/metadata');
const { createHashQueue } = require('./lib/hash-queue');
const { createUploadSessions, UploadError } = require('./lib/chunked-upload');
const { FileSessionStore } = require('./lib/session-store');
const { createWebauthnStore } = require('./lib/webauthn-store');
const { createPasswordStore } = require('./lib/password-store');
const { createUsernameStore } = require('./lib/username-store');
const { createTotpStore } = require('./lib/totp-store');
const { generateSecret, verifyTotp, buildOtpauthUri } = require('./lib/totp');
const { createAuditLog } = require('./lib/audit-log');
const { writeZip, fitsInClassicZip } = require('./lib/zip-stream');
const {
    generateRegistrationOptions, verifyRegistrationResponse,
    generateAuthenticationOptions, verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const DEFAULT_MAX_FILE_SIZE_MB = 8192;
const DEFAULT_ADMIN_USERNAME = 'admin';
const STALE_UPLOAD_SWEEP_MS = 60 * 60 * 1000;
const MAX_BULK_FILES = 100;

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
        adminUsername: usernameOption,
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
       Kein funktionsfaehiger Default. Ist ADMIN_PASSWORD gesetzt, bleibt es
       die feste, vom Betreiber gewaehlte Quelle (SHA-256 vorab, damit der
       Vergleich zeitkonstant und unabhaengig von der Laenge laeuft). Ist es
       NICHT gesetzt, wird kein Passwort synchron erzeugt — das passiert erst
       async in start() und dann nur EINMAL: dort wird geprueft, ob schon ein
       Passwort im persistenten Store (lib/password-store.js) liegt, und nur
       wenn nicht, eines erzeugt, dort gespeichert und geloggt. Ohne dieses
       Umleiten ueber den Store waere das generierte Passwort bei jedem
       Neustart ein anderes — das Gegenteil von "fest". */

    let ADMIN_PASSWORD = passwordOption ?? process.env.ADMIN_PASSWORD;
    const PASSWORD_HASH = ADMIN_PASSWORD
        ? crypto.createHash('sha256').update(ADMIN_PASSWORD).digest()
        : null;

    let SESSION_SECRET = secretOption ?? process.env.SESSION_SECRET;
    if (!SESSION_SECRET) {
        SESSION_SECRET = crypto.randomBytes(32).toString('hex');
        log.warn(
            '⚠️  SESSION_SECRET ist nicht gesetzt — es wird ein flüchtiges pro Start\n' +
            '    erzeugt. Bestehende Sitzungen gehen bei jedem Neustart verloren.\n'
        );
    }

    const passwordStore = createPasswordStore({
        file: path.join(path.dirname(sessionDir), 'admin-password.json'),
    });

    /*
     * Anders als das Passwort ist ein Benutzername kein Geheimnis: kein
     * Zufalls-Bootstrap noetig, der Default 'admin' ist schon ueber
     * Neustarts hinweg deterministisch fix. Der Store wird erst durch einen
     * expliziten Aufruf von /admin-username befuellt.
     */
    const ADMIN_USERNAME = usernameOption ?? process.env.ADMIN_USERNAME ?? DEFAULT_ADMIN_USERNAME;
    const usernameStore = createUsernameStore({
        file: path.join(path.dirname(sessionDir), 'admin-username.json'),
    });

    /*
     * Ein einmal ueber /admin-password gesetztes (oder beim ersten Start
     * automatisch erzeugtes, siehe start()) Passwort gewinnt dauerhaft
     * gegenueber ADMIN_PASSWORD, auch nach einem Neustart. Ohne persistierten
     * Hash bleibt der Weg ueber PASSWORD_HASH bestehen — der greift aber nur,
     * wenn ADMIN_PASSWORD tatsaechlich vom Betreiber gesetzt wurde; ist beides
     * leer (start() ist noch nicht gelaufen, oder dessen Schreibversuch ist
     * fehlgeschlagen), wird sicherheitshalber jeder Login abgelehnt statt
     * gegen nichts zu vergleichen.
     */
    async function passwordMatches(candidate) {
        const record = await passwordStore.read();
        if (record) return passwordStore.verify(candidate, record);
        if (!PASSWORD_HASH) return false;
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
    const webauthnStore = createWebauthnStore({ dir: path.join(UPLOADS_DIR, '.meta') });
    const totpStore = createTotpStore({ dir: path.join(UPLOADS_DIR, '.meta') });
    // Gleicher data/-Ordner wie passwordStore/usernameStore (siehe dort).
    const auditLog = createAuditLog({ file: path.join(path.dirname(sessionDir), 'audit.log') });

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

    /*
     * WebAuthn braucht pro Anfrage eine Relying-Party-ID (der Hostname ohne
     * Port) und die exakte Origin, gegen die Attestation/Assertion geprueft
     * werden. Statt einer eigenen Env-Var wird das aus denselben Angaben
     * abgeleitet, die schon sameOrigin() fuer den CSRF-Check nutzt — und
     * respektiert damit automatisch 'trust proxy' wie der secure-Flag des
     * Session-Cookies. Bekannte Einschraenkung: ein Passkey ist an den
     * Hostnamen gebunden, unter dem er registriert wurde; Zugriff ueber
     * einen zweiten Hostnamen (z. B. IP statt DNS-Name) braucht einen
     * eigenen Passkey.
     */
    function rpIdAndOrigin(req) {
        const host = req.get('host');
        return { rpID: host.split(':')[0], expectedOrigin: `${req.protocol}://${host}` };
    }

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
        // Erster Faktor schon bestanden, zweiter noch offen: dorthin statt
        // zurueck zu /login, sonst muesste das Passwort ein zweites Mal rein.
        if (req.session && req.session.pendingTotp) {
            return res.redirect('/login/totp');
        }
        res.redirect('/login');
    }

    /*
     * Gemeinsame Render-Daten fuer admin.ejs — die Seite wird von vier Routen
     * gerendert (GET /admin-upload, GET /admin-search, sowie die
     * Fehler-Pfade von POST /admin-password und /admin-username), alle mit
     * denselben Grunddaten plus je einem eigenen Fehlerfeld/Suchbegriff.
     */
    async function adminPageData({ query = '', passwordError = null, usernameError = null } = {}) {
        const [files, passkeys, currentUsername, totpEnabled, auditEntries] = await Promise.all([
            listFiles(query),
            webauthnStore.listCredentials(),
            usernameStore.read().then(name => name ?? ADMIN_USERNAME),
            totpStore.isEnabled(),
            auditLog.read({ limit: 8 }),
        ]);
        return {
            files, maxFileSizeMb: MAX_FILE_SIZE_MB, passkeys, currentUsername,
            totpEnabled, auditEntries, passwordError, usernameError,
        };
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

    app.post('/login', loginLimiterGlobal, loginLimiterPerIp, async (req, res) => {
        const submittedUsername = String(req.body.username ?? '').trim();
        const storedUsername = (await usernameStore.read()) ?? ADMIN_USERNAME;
        // passwordMatches() immer auswerten, auch bei falschem Benutzernamen
        // — sonst wuerde die Antwortzeit verraten, ob der Benutzername
        // allein schon gestimmt hat.
        const passwordOk = await passwordMatches(req.body.password);
        const usernameOk = submittedUsername.length > 0 && submittedUsername === storedUsername;

        if (usernameOk && passwordOk) {
            const totpEnabled = await totpStore.isEnabled();
            // Session-ID nach erfolgreichem Login neu vergeben (Fixation) —
            // auch wenn TOTP noch als zweiter Faktor aussteht: der erste
            // Faktor hat schon Vertrauen geschaffen, die alte, evtl. dem
            // Angreifer bekannte Session-ID darf ab hier nicht mehr gelten.
            req.session.regenerate(err => {
                if (err) {
                    log.error('Session regenerate error:', err);
                    return res.status(500).render('login', { error: 'Serverfehler.' });
                }
                if (totpEnabled) {
                    req.session.pendingTotp = true;
                    return res.redirect('/login/totp');
                }
                req.session.loggedIn = true;
                auditLog.log('login_success', { ip: req.ip, username: submittedUsername });
                res.redirect('/admin-upload');
            });
        } else {
            // Bewusst generisch — sonst liesse sich per Antwort erraten, ob
            // schon der Benutzername stimmte (Username-Enumeration).
            auditLog.log('login_failed', { ip: req.ip, username: submittedUsername });
            res.status(401).render('login', { error: 'Benutzername oder Passwort falsch.' });
        }
    });

    /*
     * Zweiter Faktor nach erfolgreichem Passwort-Login. Erreichbar nur mit
     * einer Session, die gerade den ersten Faktor bestanden hat
     * (req.session.pendingTotp) — ohne das gilt dieselbe Regel wie ueberall
     * sonst: kein gueltiger Zustand, zurueck zu /login. Gilt bewusst NICHT
     * fuer den Passkey-Login: eine WebAuthn-Anmeldung ist schon
     * Besitz+Verifikation und damit MFA-gleichwertig (siehe CLAUDE.md).
     */
    app.get('/login/totp', (req, res) => {
        if (!req.session || !req.session.pendingTotp) {
            return res.redirect('/login');
        }
        res.render('login-totp', { error: null });
    });

    app.post('/login/totp', loginLimiterGlobal, loginLimiterPerIp, async (req, res) => {
        if (!req.session || !req.session.pendingTotp) {
            return res.redirect('/login');
        }

        const token = String(req.body.token ?? '').trim();
        const secret = await totpStore.getSecret();
        // Ein 6-stelliger Code ist immer der TOTP-Pfad, alles andere wird als
        // Recovery-Code versucht (Format ist fuer Nutzer nicht auswendig zu
        // kennen, daher keine strengere Vorabpruefung noetig).
        const ok = /^\d{6}$/.test(token) && secret
            ? verifyTotp(secret, token)
            : await totpStore.consumeRecoveryCode(token);

        if (!ok) {
            auditLog.log('totp_login_failed', { ip: req.ip });
            return res.status(401).render('login-totp', { error: 'Code ungültig.' });
        }

        delete req.session.pendingTotp;
        req.session.loggedIn = true;
        auditLog.log('totp_login_success', { ip: req.ip });
        res.redirect('/admin-upload');
    });

    app.get('/admin-upload', checkAuth, async (req, res, next) => {
        try {
            res.render('admin', await adminPageData());
        } catch (err) {
            next(err);
        }
    });

    /*
     * Bewusst ohne erneute Eingabe des alten Passworts — eine gueltige
     * Sitzung (egal ob per Passwort oder Passkey zustandegekommen) gilt als
     * Nachweis, dasselbe Vertrauensmodell wie bei der Passkey-Registrierung
     * oben. Wer das Sitzungscookie hat, hat ohnehin schon vollen
     * Admin-Zugriff — das alte Passwort zusaetzlich abzufragen wuerde
     * keinen Angriff verhindern, aber genau den Fall blockieren, fuer den
     * diese Route gedacht ist: das Passwort vergessen zu haben.
     */
    const MIN_PASSWORD_LENGTH = 8;

    // JS-Client schickt Accept: application/json und bekommt eine JSON-
    // Rueckmeldung fuer das Modal (public/js/account-forms.js); ohne JS
    // bleibt der bisherige Form-Submit-Weg (Redirect bzw. Inline-Fehler)
    // unveraendert. Dieselbe Logik gilt fuer /admin-username unten.
    app.post('/admin-password', checkAuth, async (req, res, next) => {
        const wantsJson = req.accepts(['html', 'json']) === 'json';
        const password = String(req.body.password ?? '');
        const confirmPassword = String(req.body.confirmPassword ?? '');
        const error =
            password.length < MIN_PASSWORD_LENGTH
                ? `Das Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen lang sein.`
                : password !== confirmPassword
                    ? 'Die Passwörter stimmen nicht überein.'
                    : null;

        if (error) {
            if (wantsJson) return res.status(400).json({ error });
            try {
                return res.status(400).render('admin', await adminPageData({ passwordError: error }));
            } catch (err) {
                return next(err);
            }
        }

        try {
            await passwordStore.setPassword(password);
            auditLog.log('password_changed', { ip: req.ip });
            if (wantsJson) return res.json({ ok: true });
            res.redirect('/admin-upload');
        } catch (err) {
            next(err);
        }
    });

    app.post('/admin-username', checkAuth, async (req, res, next) => {
        const wantsJson = req.accepts(['html', 'json']) === 'json';
        const username = safeUsername(req.body.username);

        if (!username) {
            const error = 'Ungültiger Benutzername (1–64 Zeichen, keine Leerzeichen).';
            if (wantsJson) return res.status(400).json({ error });
            try {
                return res.status(400).render('admin', await adminPageData({ usernameError: error }));
            } catch (err) {
                return next(err);
            }
        }

        try {
            await usernameStore.write(username);
            auditLog.log('username_changed', { ip: req.ip, username });
            if (wantsJson) return res.json({ ok: true });
            res.redirect('/admin-upload');
        } catch (err) {
            next(err);
        }
    });

    /* ------------------------------------------------- WebAuthn/Passkeys --
       Registrierung nur fuer bereits angemeldete Admins (checkAuth) — es
       gibt bewusst keinen separaten Bootstrap-Flow, der erste Passkey wird
       immer per Passwort-Login freigeschaltet. Die Login-Routen sind
       oeffentlich, teilen sich aber dieselben Rate-Limiter-Instanzen wie
       /login: ein Angreifer kann sein Budget nicht verdoppeln, indem er
       zwischen Passwort- und Passkey-Versuchen wechselt. */

    const PASSKEY_LOGIN_FAILED = { error: 'Anmeldung fehlgeschlagen.' };

    app.post('/webauthn/register/options', checkAuth, async (req, res, next) => {
        try {
            const { rpID } = rpIdAndOrigin(req);
            const userId = await webauthnStore.getOrCreateUserId();
            const existing = await webauthnStore.listCredentials();
            const options = await generateRegistrationOptions({
                rpName: 'ISO Share',
                rpID,
                userName: 'admin',
                userID: Buffer.from(userId, 'base64url'),
                attestationType: 'none',
                excludeCredentials: existing.map(c => ({
                    id: c.credentialId, transports: c.transports,
                })),
                authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
            });
            req.session.webauthnChallenge = options.challenge;
            res.json(options);
        } catch (err) {
            next(err);
        }
    });

    app.post('/webauthn/register/verify', checkAuth, async (req, res) => {
        const expectedChallenge = req.session.webauthnChallenge;
        if (!expectedChallenge) {
            return res.status(400).json({ error: 'Keine offene Registrierung.' });
        }
        const label = safePasskeyLabel(req.body.label)
            ?? `Passkey (${app.locals.formatDate(Date.now())})`;
        try {
            const { rpID, expectedOrigin } = rpIdAndOrigin(req);
            const verification = await verifyRegistrationResponse({
                response: req.body.credential,
                expectedChallenge,
                expectedOrigin,
                expectedRPID: rpID,
            });
            if (!verification.verified) {
                return res.status(400).json({ error: 'Registrierung fehlgeschlagen.' });
            }
            const { credential } = verification.registrationInfo;
            await webauthnStore.addCredential({
                credentialId: credential.id,
                publicKey: Buffer.from(credential.publicKey).toString('base64url'),
                counter: credential.counter,
                transports: credential.transports ?? [],
                label,
            });
            auditLog.log('passkey_registered', { ip: req.ip, label });
            res.status(201).json({ ok: true });
        } catch (err) {
            log.error('WebAuthn Registrierung fehlgeschlagen:', err);
            res.status(400).json({ error: 'Registrierung fehlgeschlagen.' });
        } finally {
            delete req.session.webauthnChallenge;
        }
    });

    app.get('/webauthn/credentials', checkAuth, async (req, res, next) => {
        try {
            res.json(await webauthnStore.listCredentials());
        } catch (err) {
            next(err);
        }
    });

    app.delete('/webauthn/credentials/:id', checkAuth, async (req, res) => {
        const id = safeCredentialId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Ungültige Credential-ID.' });
        const removed = await webauthnStore.removeCredential(id);
        if (removed) auditLog.log('passkey_removed', { ip: req.ip, credentialId: id });
        res.status(removed ? 204 : 404).end();
    });

    app.post('/webauthn/login/options', loginLimiterGlobal, loginLimiterPerIp, async (req, res, next) => {
        try {
            const { rpID } = rpIdAndOrigin(req);
            const existing = await webauthnStore.listCredentials();
            const options = await generateAuthenticationOptions({
                rpID,
                allowCredentials: existing.map(c => ({
                    id: c.credentialId, transports: c.transports,
                })),
                userVerification: 'preferred',
            });
            // saveUninitialized:false verhindert nur, dass eine UNVERAENDERTE
            // Session gespeichert wird. Sobald hier eine Property gesetzt
            // wird, gilt die Session als modifiziert und wird trotzdem
            // gespeichert — auch ganz ohne vorherige Anmeldung.
            req.session.webauthnChallenge = options.challenge;
            res.json(options);
        } catch (err) {
            next(err);
        }
    });

    app.post('/webauthn/login/verify', loginLimiterGlobal, loginLimiterPerIp, async (req, res) => {
        const expectedChallenge = req.session.webauthnChallenge;
        if (!expectedChallenge) {
            return res.status(400).json({ error: 'Keine offene Anmeldung.' });
        }
        const credentialId = safeCredentialId(req.body?.credential?.id);
        const stored = credentialId ? await webauthnStore.findCredential(credentialId) : null;
        if (!stored) {
            delete req.session.webauthnChallenge;
            auditLog.log('passkey_login_failed', { ip: req.ip });
            return res.status(401).json({ error: 'Unbekannter Passkey.' });
        }
        try {
            const { rpID, expectedOrigin } = rpIdAndOrigin(req);
            const verification = await verifyAuthenticationResponse({
                response: req.body.credential,
                expectedChallenge,
                expectedOrigin,
                expectedRPID: rpID,
                credential: {
                    id: stored.credentialId,
                    publicKey: Buffer.from(stored.publicKey, 'base64url'),
                    counter: stored.counter,
                    transports: stored.transports,
                },
            });
            if (!verification.verified) {
                delete req.session.webauthnChallenge;
                auditLog.log('passkey_login_failed', { ip: req.ip });
                return res.status(401).json(PASSKEY_LOGIN_FAILED);
            }
            await webauthnStore.updateCounter(stored.credentialId, verification.authenticationInfo.newCounter);
            // Session-ID nach erfolgreichem Login neu vergeben (Fixation) —
            // dasselbe Muster wie /login. regenerate() ersetzt die Session
            // komplett, die Challenge wird damit automatisch entsorgt.
            req.session.regenerate(err => {
                if (err) {
                    log.error('Session regenerate error:', err);
                    return res.status(500).json({ error: 'Serverfehler.' });
                }
                req.session.loggedIn = true;
                auditLog.log('passkey_login_success', { ip: req.ip, credentialId: stored.credentialId });
                res.json({ ok: true, redirect: '/admin-upload' });
            });
        } catch (err) {
            log.error('WebAuthn Anmeldung fehlgeschlagen:', err);
            delete req.session.webauthnChallenge;
            auditLog.log('passkey_login_failed', { ip: req.ip });
            res.status(401).json(PASSKEY_LOGIN_FAILED);
        }
    });

    /* --------------------------------------------------------------- TOTP --
       Zweiter Faktor fuer den Passwort-Login (siehe /login/totp oben).
       Registrierung/Deaktivierung nur fuer bereits angemeldete Admins,
       dasselbe Vertrauensmodell wie bei Passkeys und /admin-password: eine
       gueltige Sitzung ist Nachweis genug, keine erneute Passwortabfrage. */

    app.post('/totp/setup', checkAuth, async (req, res, next) => {
        try {
            const secret = generateSecret();
            // Nur in der Session, nicht persistiert — siehe lib/totp-store.js.
            req.session.totpSetupSecret = secret;
            const label = (await usernameStore.read()) ?? ADMIN_USERNAME;
            res.json({ secret, otpauthUrl: buildOtpauthUri({ secret, label }) });
        } catch (err) {
            next(err);
        }
    });

    app.post('/totp/confirm', checkAuth, async (req, res, next) => {
        const pendingSecret = req.session.totpSetupSecret;
        if (!pendingSecret) {
            return res.status(400).json({ error: 'Keine offene Einrichtung.' });
        }
        if (!verifyTotp(pendingSecret, req.body.token)) {
            return res.status(400).json({ error: 'Code ungültig.' });
        }
        try {
            const recoveryCodes = await totpStore.enable(pendingSecret);
            delete req.session.totpSetupSecret;
            auditLog.log('totp_enabled', { ip: req.ip });
            res.json({ ok: true, recoveryCodes });
        } catch (err) {
            next(err);
        }
    });

    app.post('/totp/disable', checkAuth, async (req, res, next) => {
        try {
            await totpStore.disable();
            auditLog.log('totp_disabled', { ip: req.ip });
            res.json({ ok: true });
        } catch (err) {
            next(err);
        }
    });

    app.get('/admin-audit-log', checkAuth, async (req, res, next) => {
        try {
            res.render('audit-log', { entries: await auditLog.read({ limit: 500 }) });
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
            auditLog.log('upload', { ip: req.ip, filename });
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
            auditLog.log('upload', { ip: req.ip, filename });

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
        auditLog.log('delete', { ip: req.ip, filename });
        res.redirect('/admin-upload');
    });

    /* ------------------------------------------------- Bulk-Aktionen --
       Mehrfachauswahl in der Dateitabelle (public/js/bulk-actions.js):
       gemeinsamer ZIP-Download fuer beide Ansichten, Loeschen nur im
       Admin-Bereich. Beide Routen nehmen dieselbe { names: string[] }-Form
       und wenden dieselbe safeIsoName()-Pruefung wie /download bzw. /delete
       auf jeden Eintrag an — Mehrfachauswahl aendert nichts an den
       Sicherheitsanforderungen an einen einzelnen Dateinamen. */

    app.post('/download-zip', downloadLimiter, async (req, res) => {
        const requested = Array.isArray(req.body?.names) ? req.body.names : [];
        const names = [...new Set(requested.map(safeIsoName).filter(Boolean))];
        if (names.length === 0) {
            return res.status(400).json({ error: 'Keine gültigen Dateien ausgewählt.' });
        }
        if (names.length > MAX_BULK_FILES) {
            return res.status(400).json({ error: `Höchstens ${MAX_BULK_FILES} Dateien auf einmal.` });
        }

        const files = [];
        for (const name of names) {
            try {
                const filePath = path.join(UPLOADS_DIR, name);
                const stats = await fsp.stat(filePath);
                if (stats.isFile()) files.push({ name, path: filePath, size: stats.size, mtime: stats.mtime });
            } catch {
                // Fehlende Datei stillschweigend uebersprungen — die Auswahl im
                // Browser kann seit dem letzten Laden veraltet sein.
            }
        }
        if (files.length === 0) {
            return res.status(404).json({ error: 'Keine der ausgewählten Dateien wurde gefunden.' });
        }

        // Vorab pruefen statt mittendrin abbrechen, siehe lib/zip-stream.js.
        const totalSize = files.reduce((sum, file) => sum + file.size, 0);
        const headerOverheadEstimate = files.length * 1024;
        if (!files.every(file => fitsInClassicZip(file.size))
            || totalSize + headerOverheadEstimate > 0xFFFFFFFF) {
            return res.status(413).json({
                error: 'Auswahl zu groß für ein ZIP-Archiv (Format-Limit 4 GiB) — bitte in kleineren Gruppen herunterladen.',
            });
        }

        res.type('application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="iso-share-${Date.now()}.zip"`);

        try {
            await writeZip(res, files);
            files.forEach(file => metadata.recordDownload(file.name));
        } catch (err) {
            // Mitten im Stream — Header sind schon raus, es kann kein
            // Fehlerstatus mehr folgen. Best-effort: Verbindung beenden.
            log.error('ZIP-Download-Fehler:', err);
        } finally {
            res.end();
        }
    });

    app.post('/delete-bulk', checkAuth, async (req, res, next) => {
        const requested = Array.isArray(req.body?.names) ? req.body.names : [];
        const names = [...new Set(requested.map(safeIsoName).filter(Boolean))];
        if (names.length === 0) {
            return res.status(400).json({ error: 'Keine gültigen Dateien ausgewählt.' });
        }
        if (names.length > MAX_BULK_FILES) {
            return res.status(400).json({ error: `Höchstens ${MAX_BULK_FILES} Dateien auf einmal.` });
        }

        const deleted = [];
        try {
            for (const name of names) {
                const filePath = path.join(UPLOADS_DIR, name);
                if (path.dirname(filePath) !== UPLOADS_DIR) continue;
                await fsp.rm(filePath, { force: true });
                await metadata.remove(name);
                deleted.push(name);
            }
        } catch (err) {
            return next(err);
        }

        auditLog.log('bulk_delete', { ip: req.ip, count: deleted.length, names: deleted });
        res.json({ deleted });
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
            res.render('admin', { ...(await adminPageData({ query })), searchQuery: query });
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

        // Kein ADMIN_PASSWORD gesetzt: einmalig ein zufaelliges Passwort
        // erzeugen und SOFORT persistieren, statt es nur im Speicher zu
        // halten. Existiert schon ein gespeichertes (aus einem frueheren
        // Start oder ueber /admin-password geaendert), bleibt das bestehen
        // — sonst waere das Passwort bei jedem Neustart ein anderes.
        if (!ADMIN_PASSWORD) {
            const existing = await passwordStore.read();
            if (!existing) {
                const generated = crypto.randomBytes(18).toString('base64url');
                await passwordStore.setPassword(generated);
                log.warn(
                    '\n⚠️  Kein ADMIN_PASSWORD gesetzt. Einmalig generiertes Passwort ' +
                    `(dauerhaft gespeichert in ${passwordStore.file}):\n` +
                    `    ${generated}\n` +
                    '    Wird bei einem Neustart NICHT erneut angezeigt. Ändern jederzeit\n' +
                    '    unter /admin-upload, oder ADMIN_PASSWORD als Umgebungsvariable setzen.\n'
                );
            }
        }

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
        webauthnStore.close();
        totpStore.close();
        await Promise.all([
            metadata.flush(), sessionStore.settled(), webauthnStore.flush(),
            totpStore.flush(), auditLog.flush(),
        ]);
    }

    return {
        app,
        start,
        stop,
        // fuer Tests und /healthz
        services: {
            metadata, hashQueue, uploadSessions, sessionStore,
            webauthnStore, passwordStore, usernameStore, totpStore, auditLog, listFiles,
        },
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
