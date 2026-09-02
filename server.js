const express = require('express');
const multer = require('multer');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB) || 8192;
const isProd = process.env.NODE_ENV === 'production';

/* ==========================================================================
   Secrets — kein funktionsfaehiger Default mehr (Befund 1)
   ========================================================================== */

// Ist kein Admin-Passwort gesetzt, wird ein zufaelliges erzeugt und EINMAL
// geloggt, statt auf ein im Repo bekanntes 'PASSWORD' zurueckzufallen.
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
    ADMIN_PASSWORD = crypto.randomBytes(18).toString('base64url');
    console.warn(
        '\n⚠️  ADMIN_PASSWORD ist nicht gesetzt. Einmalig generiertes Passwort:\n' +
        `    ${ADMIN_PASSWORD}\n` +
        '    Setze ADMIN_PASSWORD als Umgebungsvariable, um ein festes zu verwenden.\n'
    );
}

// SHA-256 des Passworts einmal vorab, damit der Vergleich zeitkonstant und
// unabhaengig von der Laenge laeuft (Befund: nicht-zeitkonstanter Vergleich).
const PASSWORD_HASH = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();

// Ohne gesetztes SESSION_SECRET pro Start ein zufaelliges — nie das bekannte
// 'supersecretkey', mit dem sich Cookies faelschen liessen (Befund 1).
let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
    SESSION_SECRET = crypto.randomBytes(32).toString('hex');
    console.warn(
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

/* ==========================================================================
   Sicherheits-Middleware
   ========================================================================== */

app.disable('x-powered-by');

// Hinter einem Reverse Proxy (TLS-Terminierung) korrekt Secure-Cookies setzen.
// Eine reine Zahl muss als Number uebergeben werden (Anzahl Hops) — als String
// interpretiert Express sie sonst als Adressliste, und req.secure bliebe false.
if (process.env.TRUST_PROXY) {
    const tp = process.env.TRUST_PROXY;
    app.set('trust proxy', /^\d+$/.test(tp) ? Number(tp) : tp);
}

// Security-Header inkl. CSP (Befund 8). Alles wird selbst gehostet, daher
// 'self'; data: nur fuer das Grain-SVG und das Favicon; keine Inline-Skripte.
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
    // same-origin: eigene Requests behalten den Referer (dient dem CSRF-Check
    // als Fallback), zu fremden Seiten wird nichts geleakt.
    referrerPolicy: { policy: 'same-origin' },
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Nur public/ statisch ausliefern. uploads/ wird bewusst NICHT eingebunden
// (Befund 7) — Downloads laufen ausschliesslich ueber die /download-Route mit
// Typpruefung, damit keine hochgeladene Nicht-ISO als HTML ausgeliefert wird.
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: '1h',
    dotfiles: 'ignore',
}));

// Bewusst kleine Body-Limits — hier fliesst nur ein Passwort bzw. ein Dateiname
app.use(express.urlencoded({ extended: false, limit: '16kb' }));
app.use(express.json({ limit: '16kb' }));

app.use(session({
    name: 'iso.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        // sameSite:'strict' blockiert das Mitsenden bei Cross-Site-Requests
        // und ist damit die primaere CSRF-Abwehr (Befund 3, 6).
        sameSite: 'strict',
        // Secure sobald prod oder hinter Proxy — sonst waere lokal ohne TLS
        // gar kein Login moeglich.
        secure: isProd || Boolean(process.env.TRUST_PROXY),
        maxAge: 1000 * 60 * 60 * 24,
    },
}));

/*
 * CSRF-Abwehr als ZWEITE Verteidigungslinie zusaetzlich zu SameSite=strict
 * (Befund 3). Primaerschutz ist das Cookie mit SameSite=strict: ein Cross-Site-
 * POST traegt das Sitzungs-Cookie gar nicht erst, checkAuth schlaegt dann fehl.
 *
 * Dieser Check verwirft zusaetzlich Anfragen, deren Origin/Referer nachweislich
 * von fremdem Host stammt. Er darf aber legitime Logins nicht aussperren:
 * Browser senden in mehreren harmlosen Faellen `Origin: null` oder gar keinen
 * Origin. Solche nicht-auswertbaren Faelle werden durchgelassen (SameSite
 * schuetzt weiterhin) — abgelehnt wird nur ein eindeutig fremder Host.
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

// Login gedrosselt gegen Brute-Force (Befund 4).
// Zwei Ebenen, weil ein per Reverse Proxy fehlkonfiguriertes `trust proxy` die
// IP aus X-Forwarded-For ableitet und ein Angreifer die pro-IP-Sperre sonst
// durch gefaelschte Header umgehen kann:
//   1. pro IP (feinkörnig, zählt nur Fehlversuche)
//   2. global als Backstop, das auch bei IP-Spoofing greift
const TOO_MANY = 'Zu viele Anmeldeversuche. Bitte später erneut versuchen.';

const loginLimiterPerIp = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true, // nur fehlgeschlagene Logins zählen
    message: TOO_MANY,
});

// Ein Bucket fuer alle: begrenzt die Gesamtzahl fehlgeschlagener Logins und
// kann durch keinen gefaelschten Header umgangen werden. Bewusst grosszuegig,
// damit normaler Betrieb nicht blockiert wird (Kehrseite: theoretisch als
// Login-DoS missbrauchbar — für eine Single-Admin-Instanz akzeptabel).
const loginLimiterGlobal = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: false,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    keyGenerator: () => 'global',
    message: TOO_MANY,
});

/* ==========================================================================
   Uploads
   ========================================================================== */

// Zwischenspeicher ausserhalb des ausgelieferten Baums, mit Groessenlimit
// (Befund 5). Temp-Dateien liegen so nie im Web-Root.
const TMP_DIR = path.join(__dirname, 'tmp-uploads');
fs.mkdirSync(TMP_DIR, { recursive: true });
const upload = multer({
    dest: TMP_DIR,
    limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024, files: 1 },
});

/* ==========================================================================
   View-Helfer
   ========================================================================== */

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

// Genau ein Dateiname-Segment, nur erlaubte Zeichen, muss auf .iso enden.
// Zentrale Stelle fuer Upload UND Delete (Befund 2, 9).
function safeIsoName(input) {
    const raw = String(input ?? '');
    // Laenge zuerst kappen: begrenzt den Backtracking-Aufwand des Regex und
    // deckt das übliche Dateisystem-Limit ab (betrifft auch das
    // unauthentifizierte /download).
    if (raw.length === 0 || raw.length > 255) return null;
    if (raw.includes('\0')) return null;
    const base = path.basename(raw);
    if (base !== raw) return null;                 // enthielt Pfadanteile
    if (!/^[\w.\- ()]+\.iso$/i.test(base)) return null;
    return base;
}

// Asynchron, damit die Datei-I/O den Event-Loop nicht blockiert (verhindert
// eine DoS-Fläche auf den unauthentifizierten Routen / und /search bei vielen
// Dateien). Die stat()-Aufrufe laufen parallel.
async function listFiles(query = '') {
    await fsp.mkdir(UPLOADS_DIR, { recursive: true });

    const needle = query.toLowerCase();
    const names = (await fsp.readdir(UPLOADS_DIR)).filter(
        name =>
            name.toLowerCase().endsWith('.iso') &&
            name.toLowerCase().includes(needle)
    );

    const files = await Promise.all(
        names.map(async name => {
            const stats = await fsp.stat(path.join(UPLOADS_DIR, name));
            return { name, size: stats.size, mtime: stats.mtimeMs };
        })
    );

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

/* ==========================================================================
   Routen
   ========================================================================== */

app.get('/', async (req, res, next) => {
    const loggedIn = Boolean(req.session && req.session.loggedIn);
    try {
        res.render('index', { files: await listFiles(), loggedIn });
    } catch (err) {
        next(err);
    }
});

app.get('/download/:filename', async (req, res, next) => {
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
    res.download(filePath, err => {
        // Verbindungsabbruch waehrend des Streams ist kein Serverfehler
        if (err && !res.headersSent) next(err);
    });
});

app.get('/login', (req, res) => {
    res.render('login', { error: null });
});

app.post('/login', loginLimiterGlobal, loginLimiterPerIp, (req, res) => {
    if (passwordMatches(req.body.password)) {
        // Session-ID nach erfolgreichem Login neu vergeben (Session-Fixation)
        req.session.regenerate(err => {
            if (err) {
                console.error('Session regenerate error:', err);
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
        res.render('admin', { files: await listFiles() });
    } catch (err) {
        next(err);
    }
});

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
            console.error('Upload error:', err);
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
            // Erst innerhalb desselben Verzeichnisses (rename kann geräte-
            // übergreifend scheitern, wenn tmp und uploads auf verschiedenen
            // Mounts liegen) — daher mit copy+unlink als Fallback.
            await fsp.rename(file.path, path.join(UPLOADS_DIR, filename)).catch(
                async renameErr => {
                    if (renameErr.code !== 'EXDEV') throw renameErr;
                    await fsp.copyFile(file.path, path.join(UPLOADS_DIR, filename));
                    await fsp.rm(file.path, { force: true });
                }
            );
        } catch (moveErr) {
            console.error('Upload move error:', moveErr);
            await fsp.rm(file.path, { force: true });
            return fail(500, 'Datei konnte nicht gespeichert werden.');
        }

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
        res.render('admin', { files: await listFiles(query), searchQuery: query });
    } catch (err) {
        next(err);
    }
});

/* ==========================================================================
   Fehlerbehandlung — nie Stacktraces nach aussen (Befund: Disclosure)
   ========================================================================== */

app.use((req, res) => {
    res.status(404).send('Nicht gefunden');
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    if (res.headersSent) return next(err);
    res.status(500).send('Serverfehler');
});

app.listen(PORT, () => {
    console.log(`🚀 Server läuft auf http://localhost:${PORT}`);
});
