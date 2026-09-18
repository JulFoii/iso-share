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
    safeIsoName, safeUploadId, safeCredentialId, safePasskeyLabel, safeUsername, safeTag,
    safeApiTokenId, safeApiTokenLabel,
} = require('./lib/safe-name');
const { moveFile } = require('./lib/move-file');
const { openDatabase } = require('./lib/db');
const { migrateLegacyData } = require('./lib/migrate-legacy');
const { createMetadataStore } = require('./lib/metadata');
const { createHashQueue, sha256OfFile } = require('./lib/hash-queue');
const { createUploadSessions, UploadError } = require('./lib/chunked-upload');
const { SqliteSessionStore } = require('./lib/session-store');
const { createSessionSecretStore } = require('./lib/session-secret-store');
const { createWebauthnStore } = require('./lib/webauthn-store');
const { createPasswordStore } = require('./lib/password-store');
const { createUsernameStore } = require('./lib/username-store');
const { createTotpStore } = require('./lib/totp-store');
const { createApiTokenStore } = require('./lib/api-token-store');
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
const MAX_TAGS_PER_FILE = 15;
// Getrennt von der festen 24h-Cookie-Laufzeit (siehe cookie.maxAge unten):
// eine angemeldete, aber laenger unbeobachtete Admin-Session gilt ab hier als
// abgelaufen, unabhaengig davon, wie lange das Cookie selbst noch gueltig
// waere.
const ADMIN_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

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
        dataDir = process.env.DATA_DIR
            || path.join(__dirname, 'data'),
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
        // Tests uebergeben hier einen winzigen Wert statt echter 10 Minuten.
        adminIdleTimeoutMs = ADMIN_IDLE_TIMEOUT_MS,
    } = options;

    const UPLOADS_DIR = path.resolve(uploadsDir);
    const TMP_DIR = path.resolve(tmpDir);
    const DATA_DIR = path.resolve(dataDir);
    const MAX_FILE_SIZE_MB = maxFileSizeMb;
    const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
    const IDLE_TIMEOUT_MS = adminIdleTimeoutMs;

    /*
     * Eine einzige SQLite-Datenbank fuer alles, was frueher als JSON-Dateien
     * unter data/ und uploads/.meta/ lag (siehe lib/db.js). Synchron ge-
     * oeffnet, weil DatabaseSync selbst synchron ist und dies nur einmal
     * beim App-Aufbau passiert, nie in einem Request-Handler.
     */
    const db = openDatabase(path.join(DATA_DIR, 'iso-share.db'));

    /* ----------------------------------------------------------- Secrets --
       Bootstrap-Prinzip (siehe auch der Kommentar oben in lib/db.js): der aus
       Env-Var/Option berechnete Wert wird beim allerersten Start persistiert
       und gewinnt danach dauerhaft — eine spaeter geaenderte Env-Var wirkt
       sich nicht mehr aus, dieselbe Regel wie bei einer expliziten Aenderung
       ueber die Admin-UI. Ein Geheimnis, das dauerhaft in einer Env-Var
       steht, ist im Produktivbetrieb die schlechtere Aufbewahrung als die DB. */

    let ADMIN_PASSWORD = passwordOption ?? process.env.ADMIN_PASSWORD;
    const PASSWORD_HASH = ADMIN_PASSWORD
        ? crypto.createHash('sha256').update(ADMIN_PASSWORD).digest()
        : null;

    /*
     * Der Session-Signierschluessel wird SYNCHRON persistiert, weil er noch
     * vor app.use(session(...)) unten feststehen muss — also vor dem
     * asynchronen start(). Erster Start: der aus SESSION_SECRET/Option
     * berechnete oder frisch generierte Wert wird sofort in die DB
     * geschrieben. Jeder weitere Start liest denselben Wert zurueck, egal was
     * SESSION_SECRET inzwischen sagt — ohne das wuerde ein Neustart ohne
     * gesetzte Env-Var alle Sitzungen ungueltig machen.
     */
    const sessionSecretStore = createSessionSecretStore({ db });
    let SESSION_SECRET = sessionSecretStore.read();
    if (!SESSION_SECRET) {
        const candidate = secretOption ?? process.env.SESSION_SECRET
            ?? crypto.randomBytes(32).toString('hex');
        if (!secretOption && !process.env.SESSION_SECRET) {
            log.warn(
                '⚠️  Kein SESSION_SECRET gesetzt — es wird jetzt einmalig ein zufälliges\n' +
                '    erzeugt und dauerhaft in der Datenbank gespeichert.\n'
            );
        }
        SESSION_SECRET = sessionSecretStore.ensure(candidate);
    }

    const passwordStore = createPasswordStore({ db });
    const usernameStore = createUsernameStore({ db });

    /*
     * ADMIN_USERNAME bleibt der Default/die Env-Var, bis start() (siehe
     * unten) den ersten Wert in die DB schreibt oder /admin-username ihn
     * explizit aendert — danach gewinnt in beiden Faellen die DB.
     */
    const ADMIN_USERNAME = usernameOption ?? process.env.ADMIN_USERNAME ?? DEFAULT_ADMIN_USERNAME;

    /*
     * Ein einmal ueber /admin-password gesetztes (oder beim ersten Start
     * automatisch bootstrappedes, siehe start()) Passwort gewinnt dauerhaft
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

    const metadata = createMetadataStore({ db });
    const hashQueue = createHashQueue({
        uploadsDir: UPLOADS_DIR, metadata, log, maxAutoTags: MAX_TAGS_PER_FILE,
    });
    const uploadSessions = createUploadSessions({
        db,
        tmpDir: TMP_DIR,
        uploadsDir: UPLOADS_DIR,
        maxBytes: MAX_FILE_SIZE_BYTES,
    });
    const sessionStore = new SqliteSessionStore({ db });
    const webauthnStore = createWebauthnStore({ db });
    const totpStore = createTotpStore({ db });
    const auditLog = createAuditLog({ db });
    const apiTokenStore = createApiTokenStore({ db });

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
    // In jedem render() verfuegbar, ohne dass jede Route sie einzeln
    // durchreichen muss — public/js/idle-timer.js liest sie ueber
    // partials/navbar.ejs aus dem Abmelden-Link.
    app.locals.adminIdleTimeoutMs = IDLE_TIMEOUT_MS;

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
        // /api/v1 ist Token-authentifiziert (Authorization: Bearer ...), nicht
        // Cookie-authentifiziert — die Session traegt dort gar keine
        // Berechtigung (checkApiToken sieht req.session nie an). Ein
        // CSRF-Request mit dem Opfer-Cookie im Gepaeck kommt darum ohnehin nie
        // durch, der sameOrigin-Check waere hier nur ein falsch-positiver
        // Blocker fuer legitime Skript-/CI-Clients ohne passenden Origin/
        // Referer-Header.
        if (req.path.startsWith('/api/v1/')) {
            return next();
        }
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

    // Genereller Schutz gegen ausser Kontrolle geratene Skripte auf der
    // gesamten /api/v1-Flaeche (Lesen wie Schreiben) — die HTML-Seiten haben
    // kein Aequivalent, weil dort ein Browser, kein Loop-Skript, anfragt.
    const apiLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 300,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Zu viele Anfragen. Bitte kurz warten.', code: 'rate_limited' },
    });

    // Gleiches Zwei-Ebenen-Prinzip wie beim Login (siehe oben), angewandt auf
    // fehlgeschlagene Token-Pruefungen. Defense-in-depth: ein 256-Bit-Token
    // ist ohnehin nicht brute-forcebar, aber die Instanzen kosten nichts und
    // halten das Muster konsistent mit /login.
    const API_TOO_MANY = { error: 'Zu viele fehlgeschlagene Anfragen.', code: 'rate_limited' };

    const apiAuthLimiterPerIp = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 30,
        standardHeaders: true,
        legacyHeaders: false,
        skipSuccessfulRequests: true,
        message: API_TOO_MANY,
    });

    const apiAuthLimiterGlobal = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 300,
        standardHeaders: false,
        legacyHeaders: false,
        skipSuccessfulRequests: true,
        keyGenerator: () => 'global',
        message: API_TOO_MANY,
    });

    // Heartbeat-Fragmente (siehe /partials/listing, /admin/partials/listing
    // weiter unten) werden von public/js/heartbeat.js alle 20s automatisch
    // abgefragt — grosszuegiger als apiLimiter noetig waere (ein Tab erzeugt
    // hoechstens 3 Requests/Minute), aber mehrere offene Tabs/Fenster sollen
    // nicht gegenseitig blockieren.
    const pollLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 40,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Zu viele Anfragen. Bitte kurz warten.', code: 'rate_limited' },
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
            tags: meta?.tags ?? [],
            // 'done' | 'hashing' | 'queued' | 'pending'
            hashStatus: current ? 'done' : (hashQueue.statusOf(name) ?? 'pending'),
        };
    }

    async function describeAll() {
        await fsp.mkdir(UPLOADS_DIR, { recursive: true });
        const names = (await fsp.readdir(UPLOADS_DIR))
            .filter(name => name.toLowerCase().endsWith('.iso'));
        return Promise.all(names.map(describe));
    }

    async function listFiles(query = '') {
        // Tags stecken im Sidecar und sind erst nach describe() bekannt,
        // darum laeuft der Suchfilter hier statt schon auf den readdir()-
        // Namen wie frueher — kostet bei einer Suche ein paar zusaetzlich
        // gelesene Sidecars, fuer die Dateizahl einer Single-Admin-Instanz
        // unproblematisch.
        const files = await describeAll();
        const needle = query.toLowerCase();
        const matched = needle
            ? files.filter(file =>
                file.name.toLowerCase().includes(needle) ||
                file.tags.some(tag => tag.toLowerCase().includes(needle)))
            : files;

        return matched.sort((a, b) => a.name.localeCompare(b.name, 'de'));
    }

    /* Alle vorkommenden Tags ueber alle Dateien hinweg, fuer die Tag-
       Filterleiste in index.ejs/admin.ejs — bewusst unabhaengig von einer
       aktiven Suche, damit auch Tags aus herausgefilterten Dateien
       anwaehlbar bleiben und man per Klick wieder auf sie filtern kann. */
    async function listAllTags() {
        const files = await describeAll();
        const seen = new Map();
        for (const file of files) {
            for (const tag of file.tags) {
                const key = tag.toLowerCase();
                if (!seen.has(key)) seen.set(key, tag);
            }
        }
        return [...seen.values()].sort((a, b) => a.localeCompare(b, 'de'));
    }

    /* --------------------------------------------------- API-v1-Helfer --
       Paginierung/Sortierung nur fuer /api/v1/files — die HTML-Seiten zeigen
       ohnehin die komplette Liste (Single-Admin-Datenmenge), ein Skript, das
       gegen die API laeuft, will dagegen typischerweise nicht 500 Zeilen JSON
       auf einmal. */

    const API_SORTERS = {
        name: (a, b) => a.name.localeCompare(b.name, 'de'),
        '-name': (a, b) => b.name.localeCompare(a.name, 'de'),
        downloads: (a, b) => a.downloads - b.downloads,
        '-downloads': (a, b) => b.downloads - a.downloads,
        size: (a, b) => a.size - b.size,
        '-size': (a, b) => b.size - a.size,
    };

    function parsePageParams(query) {
        const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
        const perPage = Math.min(200, Math.max(1, Number.parseInt(query.perPage, 10) || 50));
        return { page, perPage };
    }

    function paginate(items, { page, perPage }) {
        const total = items.length;
        const totalPages = Math.max(1, Math.ceil(total / perPage));
        const clampedPage = Math.min(page, totalPages);
        const start = (clampedPage - 1) * perPage;
        return {
            data: items.slice(start, start + perPage),
            meta: { page: clampedPage, perPage, total, totalPages },
        };
    }

    function checkAuth(req, res, next) {
        if (req.session && req.session.loggedIn) {
            // Idle-Timeout: getrennt von der 24h-Cookie-Laufzeit (siehe
            // session()-Konfiguration oben) und nur fuer bereits
            // eingeloggte Sessions relevant. lastActivity fehlt nur bei
            // einer Session aus der Zeit vor diesem Feature — dann zaehlt
            // der erste Zugriff danach als Start des Idle-Fensters, statt
            // sofort abzulaufen.
            const now = Date.now();
            const lastActivity = req.session.lastActivity ?? now;
            if (now - lastActivity > IDLE_TIMEOUT_MS) {
                auditLog.log('session_idle_timeout', { ip: req.ip });
                return req.session.destroy(() => {
                    res.clearCookie('iso.sid');
                    if (req.accepts(['html', 'json']) === 'json') {
                        return res.status(401).json({ error: 'Sitzung wegen Inaktivität abgelaufen.' });
                    }
                    res.redirect('/login?idle=1');
                });
            }
            // heartbeat.js fragt admin/partials/listing automatisch alle 20s
            // ab, solange die Seite offen und sichtbar ist — auch wenn der
            // Admin laengst nicht mehr da ist. Zaehlte das als Aktivitaet,
            // wuerde ein einfach offen gelassener Tab den Idle-Timeout
            // komplett aushebeln. Nur idle-timer.js' Keepalive-Ping
            // (/admin/ping, ausgeloest durch echte Maus-/Tastatureingaben)
            // und normale Navigations-/Formular-Requests verlaengern die
            // Sitzung wirklich.
            if (req.get('X-Idle-Background') !== '1') {
                req.session.lastActivity = now;
            }
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
     * Token-Authentifizierung fuer /api/v1 (Skripte, CI) — vollstaendig
     * getrennt von checkAuth/der Session, siehe Design-Kommentar bei der
     * sameOrigin-Ausnahme oben. Ein Token kann nur erzeugen, wer schon eine
     * gueltige Session hat (POST /admin/api-tokens, checkAuth-gated) — es
     * gibt keinen API-Weg, sich selbst ein erstes Token auszustellen, genau
     * wie bei Passkeys. Antwortet immer JSON, nie ein Redirect: anders als
     * checkAuth gibt es hier kein Login-Formular, zu dem man zurueck koennte.
     * Gibt ein Array zurueck (Rate-Limiter + eigentliche Pruefung), Express
     * flacht das als Middleware-Liste automatisch ab.
     */
    function checkApiToken(requiredScope) {
        return [
            apiAuthLimiterGlobal,
            apiAuthLimiterPerIp,
            async (req, res, next) => {
                const match = /^Bearer\s+(\S+)$/.exec(req.get('authorization') || '');
                if (!match) {
                    return res.status(401).json({ error: 'Kein Token angegeben.', code: 'missing_token' });
                }
                const record = await apiTokenStore.findByToken(match[1]);
                if (!record) {
                    return res.status(401).json({ error: 'Ungültiges Token.', code: 'invalid_token' });
                }
                if (requiredScope && !record.scopes.includes(requiredScope)) {
                    return res.status(403).json({
                        error: 'Token hat nicht die nötige Berechtigung.', code: 'insufficient_scope',
                    });
                }
                req.apiToken = record;
                next();
            },
        ];
    }

    /*
     * Rendert ein View-Partial zu einem HTML-String statt es direkt zu
     * senden — Grundlage der Heartbeat-Fragment-Routen weiter unten
     * (/partials/listing, /admin/partials/listing). So bleibt
     * views/partials/file-rows.ejs (und die anderen Zeilen-Partials) die
     * einzige Stelle, die dieses Markup erzeugt; das erste Server-Side-
     * Render und das per Poll nachgelieferte Fragment sehen garantiert
     * gleich aus.
     */
    function renderPartial(view, locals) {
        return new Promise((resolve, reject) => {
            app.render(view, locals, (err, html) => {
                if (err) reject(err); else resolve(html);
            });
        });
    }

    /*
     * Gemeinsame Render-Daten fuer admin.ejs — die Seite wird von vier Routen
     * gerendert (GET /admin-upload, GET /admin-search, sowie die
     * Fehler-Pfade von POST /admin-password und /admin-username), alle mit
     * denselben Grunddaten plus je einem eigenen Fehlerfeld/Suchbegriff.
     */
    async function adminPageData({ query = '', passwordError = null, usernameError = null } = {}) {
        const [files, allTags, passkeys, currentUsername, totpEnabled, auditEntries, apiTokens] =
            await Promise.all([
                listFiles(query),
                listAllTags(),
                webauthnStore.listCredentials(),
                usernameStore.read().then(name => name ?? ADMIN_USERNAME),
                totpStore.isEnabled(),
                auditLog.read({ limit: 8 }),
                apiTokenStore.listTokens(),
            ]);
        return {
            files, allTags, maxFileSizeMb: MAX_FILE_SIZE_MB, passkeys, currentUsername,
            totpEnabled, auditEntries, apiTokens, passwordError, usernameError,
        };
    }

    /* ============================================================ Routen */

    app.get('/', async (req, res, next) => {
        const loggedIn = Boolean(req.session && req.session.loggedIn);
        try {
            const [files, allTags] = await Promise.all([listFiles(), listAllTags()]);
            res.render('index', { files, allTags, loggedIn });
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
     * JSON-Gegenstueck zur Startseite/zu /checksums — fuer eigene Skripte,
     * CI-Checks oder ein Monitoring, das die Dateiliste nicht aus HTML
     * herausparsen soll. Liefert dieselben Felder wie describe() (siehe
     * oben), also auch Dateien ohne aktuelle Checksumme (sha256: null,
     * hashStatus verrät warum). Genau wie /checksums oeffentlich: die Werte
     * stehen ohnehin schon auf der oeffentlichen Startseite.
     */
    app.get('/api/files.json', async (req, res, next) => {
        const query = String(req.query.q || '').slice(0, 200);
        try {
            res.json(await listFiles(query));
        } catch (err) {
            next(err);
        }
    });

    /* Alle vorkommenden Tags, unabhaengig von einer Suche — JSON-Gegenstueck
       zur Tag-Filterleiste (siehe listAllTags() oben). */
    app.get('/api/tags.json', async (req, res, next) => {
        try {
            res.json(await listAllTags());
        } catch (err) {
            next(err);
        }
    });

    /*
     * Heartbeat-Fragment fuer die oeffentliche Startseite/das Suchergebnis
     * (public/js/heartbeat.js, alle 20s abgefragt, siehe pollLimiter oben).
     * Liefert die Dateitabelle und die Tag-Filterleiste bereits fertig
     * gerendert (dasselbe Partial wie beim ersten Server-Side-Render, siehe
     * renderPartial()) statt roher JSON-Daten — so muss kein zweites Mal in
     * JavaScript nachgebaut werden, wie eine Datei-Zeile aussieht. Immer die
     * komplette, ungefilterte Liste: eine aktive Freitextsuche filtert schon
     * client-seitig (filetable.js), der Heartbeat aktualisiert nur die
     * zugrundeliegenden Daten.
     */
    app.get('/partials/listing', pollLimiter, async (req, res, next) => {
        try {
            const [files, allTags] = await Promise.all([listFiles(), listAllTags()]);
            const [filesHtml, tagsHtml] = await Promise.all([
                renderPartial('partials/file-rows', { files, admin: false }),
                renderPartial('partials/tag-filter', { allTags, searchQuery: '', searchBase: '/search' }),
            ]);
            res.json({ filesHtml, tagsHtml, visibleCount: files.length });
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

    function metricLine(name, type, help, value) {
        return `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${name} ${value}`;
    }

    /*
     * Prometheus-Textformat, oeffentlich wie /healthz — die Zahlen hier
     * (Dateizahl, Speicherplatz, Downloads) verraten nichts, was die
     * oeffentliche Startseite nicht ohnehin schon zeigt. Upload-/Lösch-/
     * Login-Zaehler kommen aus dem Audit-Log (siehe lib/audit-log.js) und
     * sind damit nur so vollstaendig wie dessen Kuerzungsgrenze (2 MB /
     * die juengsten 3000 Zeilen) — fuer ein Live-Dashboard einer Single-
     * Admin-Instanz ausreichend, kein Ersatz fuer /admin-audit-log.
     */
    app.get('/metrics', async (req, res, next) => {
        try {
            const [files, auditEntries] = await Promise.all([
                listFiles(),
                auditLog.read({ limit: Infinity }),
            ]);

            const storageBytes = files.reduce((sum, file) => sum + file.size, 0);
            const downloadsTotal = files.reduce((sum, file) => sum + file.downloads, 0);
            const countEvents = (...events) =>
                auditEntries.filter(entry => events.includes(entry.event)).length;
            const uploadsTotal = countEvents('upload');
            const deletesTotal = countEvents('delete') +
                auditEntries
                    .filter(entry => entry.event === 'bulk_delete')
                    .reduce((sum, entry) => sum + (entry.count || 0), 0);
            const loginFailuresTotal = countEvents(
                'login_failed', 'totp_login_failed', 'passkey_login_failed'
            );
            const loginSuccessesTotal = countEvents(
                'login_success', 'totp_login_success', 'passkey_login_success'
            );

            const body = [
                metricLine('iso_share_uptime_seconds', 'gauge',
                    'Sekunden seit Prozessstart.', process.uptime()),
                metricLine('iso_share_files_total', 'gauge',
                    'Anzahl der aktuell gespeicherten ISO-Dateien.', files.length),
                metricLine('iso_share_storage_bytes', 'gauge',
                    'Belegter Speicherplatz aller ISO-Dateien in Byte.', storageBytes),
                metricLine('iso_share_downloads_total', 'counter',
                    'Kumulierte Downloads aller Dateien.', downloadsTotal),
                metricLine('iso_share_uploads_total', 'counter',
                    'Anzahl erfolgreicher Uploads (aus dem Audit-Log).', uploadsTotal),
                metricLine('iso_share_deletes_total', 'counter',
                    'Anzahl geloeschter Dateien, einzeln plus Bulk (aus dem Audit-Log).', deletesTotal),
                metricLine('iso_share_login_failures_total', 'counter',
                    'Fehlgeschlagene Anmeldeversuche ueber Passwort, TOTP oder Passkey (aus dem Audit-Log).', loginFailuresTotal),
                metricLine('iso_share_login_successes_total', 'counter',
                    'Erfolgreiche Anmeldungen (aus dem Audit-Log).', loginSuccessesTotal),
                metricLine('iso_share_hash_queue_busy', 'gauge',
                    '1 waehrend die Hintergrund-Checksummenberechnung laeuft, sonst 0.', hashQueue.isIdle() ? 0 : 1),
            ].join('\n\n');

            res.type('text/plain; version=0.0.4; charset=utf-8');
            res.send(`${body}\n`);
        } catch (err) {
            next(err);
        }
    });

    app.get('/login', (req, res) => {
        // ?idle=1 kommt ausschliesslich vom eigenen checkAuth-Redirect nach
        // Session-Idle-Timeout (siehe oben) — kein Nutzereingriff moeglich,
        // der Text ist fest verdrahtet.
        const error = req.query.idle === '1' ? 'Wegen Inaktivität abgemeldet. Bitte erneut anmelden.' : null;
        res.render('login', { error });
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
                req.session.lastActivity = Date.now();
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
        req.session.lastActivity = Date.now();
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
                req.session.lastActivity = Date.now();
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

    /* ---------------------------------------------------- API-Tokens --
       Erstellung/Verwaltung nur fuer bereits angemeldete Admins (checkAuth)
       — kein API-Weg zur Selbstausstellung, dasselbe Bootstrap-Prinzip wie
       bei Passkeys oben. Die Tokens selbst werden unter /api/v1 verwendet
       (siehe checkApiToken). */

    app.get('/admin/api-tokens', checkAuth, async (req, res, next) => {
        try {
            res.json(await apiTokenStore.listTokens());
        } catch (err) {
            next(err);
        }
    });

    app.post('/admin/api-tokens', checkAuth, async (req, res, next) => {
        const label = safeApiTokenLabel(req.body.label) ?? null;
        const scopes = Array.isArray(req.body.scopes) ? req.body.scopes : ['read'];
        try {
            const created = await apiTokenStore.createToken({ label, scopes });
            if (!created) {
                return res.status(400).json({ error: 'Ungültige Scopes.' });
            }
            auditLog.log('api_token_created', {
                ip: req.ip, tokenId: created.id, label: created.label, scopes: created.scopes,
            });
            // Klartext-Token nur hier, genau einmal — danach nicht mehr
            // rekonstruierbar (siehe lib/api-token-store.js).
            res.status(201).json(created);
        } catch (err) {
            next(err);
        }
    });

    app.delete('/admin/api-tokens/:id', checkAuth, async (req, res) => {
        const id = safeApiTokenId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Ungültige Token-ID.' });
        const removed = await apiTokenStore.revokeToken(id);
        if (removed) auditLog.log('api_token_revoked', { ip: req.ip, tokenId: id });
        res.status(removed ? 204 : 404).end();
    });

    app.get('/admin-audit-log', checkAuth, async (req, res, next) => {
        try {
            res.render('audit-log', { entries: await auditLog.read({ limit: 500 }) });
        } catch (err) {
            next(err);
        }
    });

    /*
     * Admin-Gegenstueck zu /partials/listing oben: Dateitabelle, Tag-
     * Filterleiste, Passkeys und API-Tokens fertig gerendert, plus die
     * juengsten Audit-Log-Eintraege als JSON (deren Markup ist einfach genug,
     * um es ohne Duplikationsrisiko direkt in heartbeat.js nachzubauen —
     * anders als eine Datei-Zeile). Ein einziger Request pro Poll-Intervall
     * fuer die ganze admin.ejs/audit-log.ejs-Seite statt mehrerer.
     */
    app.get('/admin/partials/listing', checkAuth, pollLimiter, async (req, res, next) => {
        try {
            const [files, allTags, passkeys, apiTokens, auditEntries] = await Promise.all([
                listFiles(),
                listAllTags(),
                webauthnStore.listCredentials(),
                apiTokenStore.listTokens(),
                auditLog.read({ limit: 20 }),
            ]);
            const [filesHtml, tagsHtml, passkeysHtml, apiTokensHtml] = await Promise.all([
                renderPartial('partials/file-rows', { files, admin: true }),
                renderPartial('partials/tag-filter-panel', { allTags, searchQuery: '', searchBase: '/admin-search' }),
                renderPartial('partials/passkey-rows', { passkeys }),
                renderPartial('partials/token-rows', { apiTokens }),
            ]);
            res.json({
                filesHtml, tagsHtml, passkeysHtml, apiTokensHtml, auditEntries, visibleCount: files.length,
            });
        } catch (err) {
            next(err);
        }
    });

    /*
     * Keepalive fuer public/js/idle-timer.js: wird ausschliesslich durch
     * echte Nutzeraktivitaet (Klick/Taste/Maus, dort throttled) ausgeloest,
     * nie automatisch wie das Heartbeat-Polling oben — checkAuth erneuert
     * lastActivity also tatsaechlich. Keine eigene Nutzlast, nur der
     * Seiteneffekt in checkAuth zaehlt.
     */
    app.get('/admin/ping', checkAuth, pollLimiter, (req, res) => {
        res.status(204).end();
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

    /*
     * Dedup-Pruefung, gemeinsam fuer den fortsetzbaren und den Multipart-
     * Fallback-Upload: gibt es bereits eine Datei mit exakt dieser
     * Pruefsumme (unter einem anderen Namen als dem Ziel und nicht der per
     * `replaces` explizit zu ersetzenden Datei), ist es ein echtes Duplikat.
     * sha256 ist null, wenn keine mitgelaufene Pruefsumme vorliegt (z. B.
     * Upload-Sitzung ueberlebte einen Serverneustart) — dann faellt die
     * Pruefung fuer diesen einen Upload einfach aus, der Hash-Queue holt die
     * echte Checksumme wie gewohnt im Hintergrund nach.
     */
    async function findDuplicate(sha256, { targetName, replaces }) {
        if (!sha256) return null;
        const matches = await metadata.findByChecksum(sha256);
        return matches.find(name => name !== targetName && name !== replaces) ?? null;
    }

    /*
     * Loescht die per `replaces` explizit vom Admin ausgewaehlte alte Datei
     * — immer erst NACH dem erfolgreichen Verschieben der neuen, damit ein
     * fehlgeschlagener Upload nie grundlos die alte Version mitreisst.
     * Best-effort: ist die alte Datei inzwischen schon weg, passiert nichts.
     */
    async function replaceOldVersion(replaces, { ip, filename }) {
        if (!replaces) return false;
        const oldPath = path.join(UPLOADS_DIR, replaces);
        if (path.dirname(oldPath) !== UPLOADS_DIR) return false;
        await fsp.rm(oldPath, { force: true });
        await metadata.remove(replaces);
        auditLog.log('upload_replaced', { ip, filename, replaces });
        return true;
    }

    /*
     * Loescht jede der uebergebenen Dateien (samt Metadaten-Zeile) und gibt
     * zurueck, welche davon tatsaechlich existierten — gemeinsame Basis fuer
     * /delete, /delete-bulk und deren /api/v1-Gegenstuecke, damit die
     * Pfadabsicherung (dirname-Check) nur an einer Stelle steht.
     */
    async function deleteFiles(names) {
        const deleted = [];
        for (const name of names) {
            const filePath = path.join(UPLOADS_DIR, name);
            if (path.dirname(filePath) !== UPLOADS_DIR) continue;
            // Kein { force: true }: das wuerde eine fehlende Datei stillschweigend
            // als Erfolg behandeln, obwohl deleted[] laut Dokumentation nur
            // tatsaechlich existierende Dateien enthalten soll (Grundlage fuer
            // den 404-Zweig von DELETE /api/v1/files/:name).
            try {
                await fsp.rm(filePath);
            } catch (err) {
                if (err.code === 'ENOENT') continue;
                throw err;
            }
            await metadata.remove(name);
            deleted.push(name);
        }
        return deleted;
    }

    /*
     * Entfernt einen einzelnen Tag und pflegt removedAutoTags nach, falls es
     * ein Auto-Tag war (siehe lib/auto-tags.js) — gemeinsame Basis fuer
     * DELETE /files/:name/tags/:tag und dessen /api/v1-Gegenstueck.
     */
    async function removeTag(filename, tag) {
        const meta = await metadata.read(filename);
        const existing = meta?.tags ?? [];
        const tags = existing.filter(t => t.toLowerCase() !== tag.toLowerCase());
        if (tags.length === existing.length) return { tags, changed: false };

        const autoTags = meta?.autoTags ?? [];
        const wasAutoTag = autoTags.some(t => t.toLowerCase() === tag.toLowerCase());
        const patch = { tags };
        if (wasAutoTag) {
            patch.autoTags = autoTags.filter(t => t.toLowerCase() !== tag.toLowerCase());
            const removedAuto = meta?.removedAutoTags ?? [];
            if (!removedAuto.some(t => t.toLowerCase() === tag.toLowerCase())) {
                patch.removedAutoTags = [...removedAuto, tag];
            }
        }
        await metadata.update(filename, patch);
        return { tags, changed: true };
    }

    app.post('/upload/init', checkAuth, async (req, res) => {
        try {
            const state = await uploadSessions.create({
                name: req.body.name,
                size: Number(req.body.size),
                replaces: req.body.replaces,
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
            const session = await uploadSessions.get(id);
            const duplicateOf = await findDuplicate(uploadSessions.pendingHash(id), {
                targetName: session.name, replaces: session.replaces,
            });
            if (duplicateOf) {
                await uploadSessions.abort(id);
                return res.status(409).json({
                    error: `Identischer Inhalt liegt bereits als „${duplicateOf}“ vor.`,
                    duplicateOf,
                });
            }

            const { filename, replaces } = await uploadSessions.finish(id);
            // Checksumme und Volume-Infos laufen im Hintergrund nach
            hashQueue.enqueue(filename);
            auditLog.log('upload', { ip: req.ip, filename });
            const replaced = await replaceOldVersion(replaces, { ip: req.ip, filename });
            res.status(201).json({ filename, replaced: replaced ? replaces : null });
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

            const requestedReplaces = safeIsoName(req.body.replaces);
            const replaces = requestedReplaces && requestedReplaces !== filename
                ? requestedReplaces : null;

            try {
                // Kein mitlaufender Hasher wie beim Chunk-Upload (der
                // Multipart-Fallback ist der No-JS-Pfad, keine Streaming-
                // Chunks) — die Datei liegt schon komplett im temp-Verzeichnis,
                // also einmal durchhashen, bevor sie nach uploads/ zieht.
                const sha256 = await sha256OfFile(file.path);
                const duplicateOf = await findDuplicate(sha256, { targetName: filename, replaces });
                if (duplicateOf) {
                    await fsp.rm(file.path, { force: true });
                    return fail(409, `Identischer Inhalt liegt bereits als „${duplicateOf}“ vor.`);
                }

                await fsp.mkdir(UPLOADS_DIR, { recursive: true });
                await moveFile(file.path, path.join(UPLOADS_DIR, filename));
            } catch (moveErr) {
                log.error('Upload move error:', moveErr);
                await fsp.rm(file.path, { force: true });
                return fail(500, 'Datei konnte nicht gespeichert werden.');
            }

            hashQueue.enqueue(filename);
            auditLog.log('upload', { ip: req.ip, filename });
            const replaced = await replaceOldVersion(replaces, { ip: req.ip, filename });

            if (wantsJson) return res.status(201).json({ filename, replaced: replaced ? replaces : null });
            res.redirect('/admin-upload');
        });
    });

    app.post('/delete', checkAuth, async (req, res, next) => {
        const filename = safeIsoName(req.body.filename);
        if (!filename) {
            return res.status(400).send('Ungültiger Dateiname.');
        }
        try {
            await deleteFiles([filename]);
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

        let deleted;
        try {
            deleted = await deleteFiles(names);
        } catch (err) {
            return next(err);
        }

        auditLog.log('bulk_delete', { ip: req.ip, count: deleted.length, names: deleted });
        res.json({ deleted });
    });

    /* ------------------------------------------------------------- Tags --
       Freitext-Kategorien je Datei, im metadata-Sidecar gespeichert
       (metadata.update() ist ein Merge-Patch, tags braucht darum keine
       Aenderung in lib/metadata.js). Tags werden ausschliesslich automatisch
       von lib/hash-queue.js (siehe lib/auto-tags.js) aus dem ISO selbst
       vergeben — es gibt bewusst keine Route zum manuellen Hinzufuegen mehr,
       nur zum Entfernen eines einzelnen (falschen) Auto-Tags, JS-only wie
       /webauthn/credentials/:id und /delete-bulk. Ein entfernter Auto-Tag
       landet in removedAutoTags, damit der naechste Rescan ihn nicht wieder
       anhaengt (siehe lib/auto-tags.js). */

    app.delete('/files/:name/tags/:tag', checkAuth, async (req, res, next) => {
        const filename = safeIsoName(req.params.name);
        const tag = safeTag(req.params.tag);
        if (!filename || !tag) {
            return res.status(400).json({ error: 'Ungültige Anfrage.' });
        }

        try {
            const { tags, changed } = await removeTag(filename, tag);
            if (changed) {
                auditLog.log('tag_removed', { ip: req.ip, filename, tag });
            }
            res.json({ tags });
        } catch (err) {
            next(err);
        }
    });

    /* ================================================================
       /api/v1 — versionierte JSON-API fuer Skripte/CI.

       Lese-Endpunkte bleiben oeffentlich, aus demselben Grund wie
       /api/files.json oben: die Daten stehen ohnehin auf der oeffentlichen
       Startseite. Schreib-Endpunkte und der Audit-Log-Endpunkt verlangen ein
       Bearer-Token (siehe checkApiToken oben). Antworten folgen einem
       einheitlichen Envelope — { data, meta? } bei Erfolg, { error, code }
       bei Fehlern — anders als die alten /api/*.json-Routen, die aus
       Kompatibilitaetsgruenden unveraendert bleiben.
       ================================================================ */

    app.use('/api/v1', apiLimiter);

    function sendApiUploadError(res, err) {
        if (err instanceof UploadError) {
            const body = { error: err.message, code: 'upload_error' };
            if (err.extra.offset !== undefined) body.offset = err.extra.offset;
            if (err.extra.size !== undefined) body.size = err.extra.size;
            return res.status(err.status).json(body);
        }
        log.error('API-Upload-Fehler:', err);
        res.status(500).json({ error: 'Upload fehlgeschlagen.', code: 'server_error' });
    }

    app.get('/api/v1/files', async (req, res, next) => {
        try {
            const query = String(req.query.q || '').slice(0, 200);
            const tag = String(req.query.tag || '').toLowerCase();
            const sorter = API_SORTERS[req.query.sort] ?? API_SORTERS.name;

            let files = await listFiles(query);
            if (tag) files = files.filter(file => file.tags.some(t => t.toLowerCase() === tag));
            files = [...files].sort(sorter);

            res.json(paginate(files, parsePageParams(req.query)));
        } catch (err) {
            next(err);
        }
    });

    app.get('/api/v1/files/:name', async (req, res, next) => {
        const filename = safeIsoName(req.params.name);
        if (!filename) {
            return res.status(400).json({ error: 'Ungültiger Dateiname.', code: 'invalid_name' });
        }
        try {
            await fsp.access(path.join(UPLOADS_DIR, filename));
        } catch {
            return res.status(404).json({ error: 'Datei nicht gefunden.', code: 'not_found' });
        }
        try {
            res.json({ data: await describe(filename) });
        } catch (err) {
            next(err);
        }
    });

    app.get('/api/v1/tags', async (req, res, next) => {
        try {
            res.json({ data: await listAllTags() });
        } catch (err) {
            next(err);
        }
    });

    app.get('/api/v1/checksums', async (req, res, next) => {
        try {
            const files = await listFiles();
            res.json({
                data: files
                    .filter(file => file.sha256)
                    .map(file => ({ name: file.name, sha256: file.sha256 })),
            });
        } catch (err) {
            next(err);
        }
    });

    app.get('/api/v1/audit-log', checkApiToken('read'), async (req, res, next) => {
        try {
            const entries = await auditLog.read({ limit: Infinity });
            res.json(paginate(entries, parsePageParams(req.query)));
        } catch (err) {
            next(err);
        }
    });

    /* -------------------------------------------------- Uploads (write) --
       Identisches Protokoll wie /upload/init + Freunde (siehe
       lib/chunked-upload.js) — nur die Auth wechselt von checkAuth auf ein
       Bearer-Token mit write-Scope, und die Antworten kommen im API-Envelope. */

    app.post('/api/v1/uploads', checkApiToken('write'), async (req, res) => {
        try {
            const state = await uploadSessions.create({
                name: req.body.name,
                size: Number(req.body.size),
                replaces: req.body.replaces,
            });
            res.status(201).json({ data: state });
        } catch (err) {
            sendApiUploadError(res, err);
        }
    });

    app.get('/api/v1/uploads/:id', checkApiToken('write'), async (req, res) => {
        const id = safeUploadId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Ungültige Upload-ID.', code: 'invalid_id' });
        try {
            res.json({ data: await uploadSessions.get(id) });
        } catch (err) {
            sendApiUploadError(res, err);
        }
    });

    app.patch('/api/v1/uploads/:id', checkApiToken('write'), async (req, res) => {
        const id = safeUploadId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Ungültige Upload-ID.', code: 'invalid_id' });

        const header = req.get('upload-offset');
        const claimed = /^\d+$/.test(String(header ?? '')) ? Number(header) : NaN;

        try {
            const state = await uploadSessions.append(id, claimed, req);
            res.json({ data: { offset: state.offset, size: state.size, complete: state.complete } });
        } catch (err) {
            sendApiUploadError(res, err);
        }
    });

    app.post('/api/v1/uploads/:id/finish', checkApiToken('write'), async (req, res) => {
        const id = safeUploadId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Ungültige Upload-ID.', code: 'invalid_id' });
        try {
            const session = await uploadSessions.get(id);
            const duplicateOf = await findDuplicate(uploadSessions.pendingHash(id), {
                targetName: session.name, replaces: session.replaces,
            });
            if (duplicateOf) {
                await uploadSessions.abort(id);
                return res.status(409).json({
                    error: `Identischer Inhalt liegt bereits als „${duplicateOf}“ vor.`,
                    code: 'duplicate',
                    duplicateOf,
                });
            }

            const { filename, replaces } = await uploadSessions.finish(id);
            hashQueue.enqueue(filename);
            auditLog.log('upload', { ip: req.ip, filename, via: 'api', tokenId: req.apiToken.id });
            const replaced = await replaceOldVersion(replaces, { ip: req.ip, filename });
            res.status(201).json({ data: { filename, replaced: replaced ? replaces : null } });
        } catch (err) {
            sendApiUploadError(res, err);
        }
    });

    app.delete('/api/v1/uploads/:id', checkApiToken('write'), async (req, res) => {
        const id = safeUploadId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Ungültige Upload-ID.', code: 'invalid_id' });
        await uploadSessions.abort(id);
        res.status(204).end();
    });

    /* --------------------------------------------------- Delete/Tags (write) -- */

    app.delete('/api/v1/files/:name', checkApiToken('write'), async (req, res, next) => {
        const filename = safeIsoName(req.params.name);
        if (!filename) {
            return res.status(400).json({ error: 'Ungültiger Dateiname.', code: 'invalid_name' });
        }
        let deleted;
        try {
            deleted = await deleteFiles([filename]);
        } catch (err) {
            return next(err);
        }
        if (deleted.length === 0) {
            return res.status(404).json({ error: 'Datei nicht gefunden.', code: 'not_found' });
        }
        auditLog.log('delete', { ip: req.ip, filename, via: 'api', tokenId: req.apiToken.id });
        res.status(204).end();
    });

    app.post('/api/v1/files/bulk-delete', checkApiToken('write'), async (req, res, next) => {
        const requested = Array.isArray(req.body?.names) ? req.body.names : [];
        const names = [...new Set(requested.map(safeIsoName).filter(Boolean))];
        if (names.length === 0) {
            return res.status(400).json({ error: 'Keine gültigen Dateien ausgewählt.', code: 'invalid_name' });
        }
        if (names.length > MAX_BULK_FILES) {
            return res.status(400).json({
                error: `Höchstens ${MAX_BULK_FILES} Dateien auf einmal.`, code: 'too_many_files',
            });
        }

        let deleted;
        try {
            deleted = await deleteFiles(names);
        } catch (err) {
            return next(err);
        }

        auditLog.log('bulk_delete', {
            ip: req.ip, count: deleted.length, names: deleted, via: 'api', tokenId: req.apiToken.id,
        });
        res.json({ data: { deleted } });
    });

    app.delete('/api/v1/files/:name/tags/:tag', checkApiToken('write'), async (req, res, next) => {
        const filename = safeIsoName(req.params.name);
        const tag = safeTag(req.params.tag);
        if (!filename || !tag) {
            return res.status(400).json({ error: 'Ungültige Anfrage.', code: 'invalid_request' });
        }
        try {
            const { tags, changed } = await removeTag(filename, tag);
            if (changed) {
                auditLog.log('tag_removed', { ip: req.ip, filename, tag, via: 'api', tokenId: req.apiToken.id });
            }
            res.json({ data: { tags } });
        } catch (err) {
            next(err);
        }
    });

    app.get('/logout', (req, res) => {
        // ?idle=1 kommt von public/js/idle-timer.js, wenn der clientseitige
        // Countdown abgelaufen ist (oder der Keepalive-Ping mit 401
        // antwortet) — derselbe Fall wie der serverseitige Idle-Timeout in
        // checkAuth oben, nur clientseitig erkannt, bevor ein weiterer
        // admin-Request den Server selbst dazu bringen wuerde. Landet daher
        // ebenfalls auf /login?idle=1 statt auf '/', sonst faehrt der Nutzer
        // ohne jede Meldung auf der oeffentlichen Startseite auf.
        const idle = req.query.idle === '1';
        if (idle) {
            auditLog.log('session_idle_timeout', { ip: req.ip });
        }
        req.session.destroy(() => {
            res.clearCookie('iso.sid');
            res.redirect(idle ? '/login?idle=1' : '/');
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
            const [files, allTags] = await Promise.all([listFiles(query), listAllTags()]);
            res.render('index', {
                files,
                allTags,
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
        if (req.path.startsWith('/api/v1/')) {
            return res.status(404).json({ error: 'Nicht gefunden.', code: 'not_found' });
        }
        res.status(404).send('Nicht gefunden');
    });

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        log.error('Unhandled error:', err);
        if (res.headersSent) return next(err);
        if (req.path.startsWith('/api/v1/')) {
            return res.status(500).json({ error: 'Serverfehler.', code: 'server_error' });
        }
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

        // Einmaliger Best-Effort-Import aus dem alten JSON-Dateien-Stand,
        // falls hier noch welcher liegt (siehe lib/migrate-legacy.js). Greift
        // nur auf leere Tabellen, macht also bei jedem weiteren Start nichts.
        await migrateLegacyData({
            db, uploadsDir: UPLOADS_DIR, dataDir: DATA_DIR, tmpDir: TMP_DIR, log,
        });

        // Bootstrap: existiert noch kein persistiertes Passwort, wird der
        // wirksame Wert sofort persistiert — ADMIN_PASSWORD, falls gesetzt,
        // sonst ein frisch generiertes. Ab hier gewinnt in jedem Fall die DB
        // (siehe Kommentar oben bei den Secrets); eine spaeter gesetzte oder
        // geaenderte ADMIN_PASSWORD-Env-Var hat danach keine Wirkung mehr.
        if (!(await passwordStore.read())) {
            if (ADMIN_PASSWORD) {
                await passwordStore.setPassword(ADMIN_PASSWORD);
            } else {
                const generated = crypto.randomBytes(18).toString('base64url');
                await passwordStore.setPassword(generated);
                log.warn(
                    '\n⚠️  Kein ADMIN_PASSWORD gesetzt. Einmalig generiertes Passwort ' +
                    `(dauerhaft gespeichert in ${path.join(DATA_DIR, 'iso-share.db')}):\n` +
                    `    ${generated}\n` +
                    '    Wird bei einem Neustart NICHT erneut angezeigt. Ändern jederzeit\n' +
                    '    unter /admin-upload.\n'
                );
            }
        }

        // Derselbe Bootstrap fuer den Benutzernamen: der wirksame Wert
        // (ADMIN_USERNAME/Default 'admin') wird beim ersten Start
        // persistiert, danach gewinnt die DB — genau wie beim Passwort.
        if (!(await usernameStore.read())) {
            await usernameStore.write(ADMIN_USERNAME);
        }

        await uploadSessions.cleanupStale().catch(() => {});
        if (scanOnStart) {
            const missing = await hashQueue.scanAll();
            if (missing > 0) {
                log.log(`🔢 ${missing} Datei(en) ohne Checksumme — wird im Hintergrund berechnet.`);
            }
        }
    }

    /*
     * Timer abbauen, Datenbank schliessen. Alle Schreibvorgaenge in den
     * Stores oben sind synchrone SQLite-Operationen — es gibt nichts mehr im
     * Speicher zu puffern oder "settled" abzuwarten.
     */
    async function stop() {
        timers.forEach(clearInterval);
        sessionStore.close();
        db.close();
    }

    return {
        app,
        start,
        stop,
        // fuer Tests und /healthz
        services: {
            db, metadata, hashQueue, uploadSessions, sessionStore,
            webauthnStore, passwordStore, usernameStore, totpStore, auditLog, listFiles,
            apiTokenStore,
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
