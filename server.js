const express = require('express');
const multer = require('multer');
const session = require('express-session');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'PASSWORD';

const UPLOADS_DIR = path.join(__dirname, 'uploads');
const ISO_EXT = '.iso';

// -----------------------------------------------------------------------------
// Legal / site owner info (configure via .env)
// -----------------------------------------------------------------------------
const LEGAL = {
    name: process.env.LEGAL_NAME || 'Bitte LEGAL_NAME in .env setzen',
    company: process.env.LEGAL_COMPANY || '',
    addressLine1: process.env.LEGAL_ADDRESS_LINE1 || 'Bitte LEGAL_ADDRESS_LINE1 in .env setzen',
    addressLine2: process.env.LEGAL_ADDRESS_LINE2 || '',
    postalCodeCity: process.env.LEGAL_POSTAL_CITY || 'Bitte LEGAL_POSTAL_CITY in .env setzen',
    country: process.env.LEGAL_COUNTRY || 'Deutschland',
    email: process.env.LEGAL_EMAIL || 'Bitte LEGAL_EMAIL in .env setzen',
    phone: process.env.LEGAL_PHONE || '',
    vatId: process.env.LEGAL_VAT_ID || '',
    contentResponsibleName: process.env.LEGAL_CONTENT_RESPONSIBLE || '',
};

const upload = multer({ dest: UPLOADS_DIR });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static assets (never serve uploads directly; downloads go through the /download route)
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

function ensureUploadsDir() {
    if (!fs.existsSync(UPLOADS_DIR)) {
        fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    }
}

function isSafeBasename(name) {
    // blocks path traversal / directory separators
    return typeof name === 'string' && name.length > 0 && !name.includes('..') && !name.includes('/') && !name.includes('\\');
}

function toIsoBasename(name) {
    if (!isSafeBasename(name)) return null;
    const base = path.basename(name);
    if (!base.toLowerCase().endsWith(ISO_EXT)) return null;
    return base;
}

function listIsoFiles(q = '') {
    ensureUploadsDir();
    const query = String(q || '').trim().toLowerCase();
    return fs
        .readdirSync(UPLOADS_DIR)
        .filter((f) => f.toLowerCase().endsWith(ISO_EXT))
        .filter((f) => (query ? f.toLowerCase().includes(query) : true))
        .map((name) => {
            const stat = fs.statSync(path.join(UPLOADS_DIR, name));
            return { name, size: stat.size, mtime: stat.mtime };
        });
}

// -----------------------------------------------------------------------------
// Minimal cookie helpers (no additional dependency)
// -----------------------------------------------------------------------------
function parseCookies(cookieHeader = '') {
    const out = {};
    cookieHeader.split(';').forEach(part => {
        const idx = part.indexOf('=');
        if (idx === -1) return;
        const key = part.slice(0, idx).trim();
        const val = part.slice(idx + 1).trim();
        if (!key) return;
        out[key] = decodeURIComponent(val);
    });
    return out;
}

function setCookie(res, name, value, opts = {}) {
    const parts = [`${name}=${encodeURIComponent(value)}`];
    if (opts.maxAge != null) parts.push(`Max-Age=${opts.maxAge}`);
    if (opts.path) parts.push(`Path=${opts.path}`);
    if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
    if (opts.httpOnly) parts.push('HttpOnly');
    if (opts.secure) parts.push('Secure');
    res.append('Set-Cookie', parts.join('; '));
}

function clearCookie(res, name, opts = {}) {
    setCookie(res, name, '', { ...opts, maxAge: 0 });
}

// Cookie consent (TTDSG): store user choice in a non-essential preference cookie
// Note: This app only uses an essential session cookie for admin login.
const COOKIE_CONSENT_NAME = 'cookie_consent_v1';
const COOKIE_CONSENT_MAX_AGE = 60 * 60 * 24 * 180; // 180 days

function defaultConsent() {
    return { necessary: true, analytics: false, timestamp: null };
}

// Provide common template variables
app.use((req, res, next) => {
    res.locals.year = new Date().getFullYear();
    res.locals.legal = LEGAL;
    next();
});

// Cookie consent state for templates
app.use((req, res, next) => {
    const cookies = parseCookies(req.headers.cookie || '');
    let consent = null;
    if (cookies[COOKIE_CONSENT_NAME]) {
        try {
            consent = JSON.parse(cookies[COOKIE_CONSENT_NAME]);
        } catch (e) {
            consent = null;
        }
    }
    if (!consent || typeof consent !== 'object') consent = defaultConsent();
    res.locals.cookieConsent = consent;
    // If cookie isn't set yet, we show the banner
    res.locals.showCookieBanner = !cookies[COOKIE_CONSENT_NAME];
    next();
});

// Session-Konfiguration
app.set('trust proxy', 1);
app.use(
    session({
        secret: process.env.SESSION_SECRET || 'supersecretkey',
        resave: false,
        saveUninitialized: false,
        cookie: {
            secure: false, // set true only behind HTTPS
            sameSite: 'lax',
            maxAge: 1000 * 60 * 60 * 24, // 24h
        },
    })
);

// Auth-Middleware
function checkAuth(req, res, next) {
    if (req.session?.loggedIn) return next();
    return res.redirect('/login');
}

// Startseite (User-Ansicht)
app.get('/', (req, res) => {
    try {
        const searchQuery = String(req.query.q || '').trim();
        const files = listIsoFiles(searchQuery);
        res.render('index', { files, searchQuery });
    } catch (error) {
        console.error('Error loading files:', error);
        res.status(500).render('index', { files: [], searchQuery: '' });
    }
});

// Datei-Download
app.get('/download/:filename', (req, res) => {
    try {
        const filename = toIsoBasename(req.params.filename);
        if (!filename) return res.status(400).send('Invalid filename');
        const filePath = path.join(UPLOADS_DIR, filename);
        if (!fs.existsSync(filePath)) return res.status(404).send('Datei nicht gefunden');
        return res.download(filePath);
    } catch (error) {
        console.error('Download error:', error);
        return res.status(500).send('Server error');
    }
});

// Login
app.get('/login', (req, res) => {
    res.render('login', { error: null });
});

app.post('/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        req.session.loggedIn = true;
        res.redirect('/admin-upload');
    } else {
        res.render('login', { error: 'Falsches Passwort!' });
    }
});

// Admin Upload-Ansicht
app.get('/admin-upload', checkAuth, (req, res) => {
    try {
        const searchQuery = String(req.query.q || '').trim();
        const files = listIsoFiles(searchQuery);
        res.render('admin', { files, searchQuery });
    } catch (error) {
        console.error('Error loading admin files:', error);
        res.status(500).render('admin', { files: [], searchQuery: '' });
    }
});

// Upload
app.post('/upload', checkAuth, upload.single('file'), (req, res) => {
    const file = req.file;
    if (!file) return res.status(400).send('Keine Datei hochgeladen');

    const safeName = toIsoBasename(file.originalname);
    if (!safeName) {
        try { fs.unlinkSync(file.path); } catch (_) {}
        return res.status(400).send('Nur .iso-Dateien erlaubt!');
    }

    ensureUploadsDir();
    const targetPath = path.join(UPLOADS_DIR, safeName);
    fs.renameSync(file.path, targetPath);
    return res.redirect('/admin-upload');
});

// Datei löschen
app.post('/delete', checkAuth, (req, res) => {
    const filename = toIsoBasename(req.body?.filename);
    if (!filename) return res.redirect('/admin-upload');
    const filePath = path.join(UPLOADS_DIR, filename);
    try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) {
        console.error('Delete error:', e);
    }
    return res.redirect('/admin-upload');
});

// Logout
app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
});

// Privacy Policy
app.get(['/privacy', '/datenschutz'], (req, res) => {
    res.render('privacy');
});

// Imprint
app.get(['/imprint', '/impressum'], (req, res) => {
    res.render('imprint');
});

// -----------------------------------------------------------------------------
// Cookie-Consent (TTDSG)
// -----------------------------------------------------------------------------
app.get(['/cookies', '/cookie-settings'], (req, res) => {
    res.render('cookie-settings');
});

app.post('/api/cookie-consent', (req, res) => {
    const body = req.body || {};
    const consent = {
        necessary: true,
        analytics: body.analytics === true || body.analytics === 'true',
        timestamp: new Date().toISOString(),
    };
    setCookie(res, COOKIE_CONSENT_NAME, JSON.stringify(consent), {
        maxAge: COOKIE_CONSENT_MAX_AGE,
        path: '/',
        sameSite: 'Lax',
    });
    res.json({ ok: true, consent });
});

app.post('/api/cookie-consent/reject', (req, res) => {
    const consent = { necessary: true, analytics: false, timestamp: new Date().toISOString() };
    setCookie(res, COOKIE_CONSENT_NAME, JSON.stringify(consent), {
        maxAge: COOKIE_CONSENT_MAX_AGE,
        path: '/',
        sameSite: 'Lax',
    });
    res.json({ ok: true, consent });
});

// -----------------------------------------------------------------------------
// DSGVO: Datenexport (Art. 20) & Account-Löschung mit Purge
// Hinweis: Dieses Projekt hat keine Benutzerkonten. "Account" = Admin-Session.
// -----------------------------------------------------------------------------
app.get('/account', checkAuth, (req, res) => {
    res.render('account');
});

// Export: liefert JSON-Datei mit (minimal) gespeicherten Daten
app.get('/account/export', checkAuth, (req, res) => {
    try {
        const uploads = listIsoFiles().map((u) => ({
            name: u.name,
            size: u.size,
            mtime: u.mtime.toISOString(),
        }));

        const exportData = {
            exportedAt: new Date().toISOString(),
            app: { name: 'ISO Share', version: process.env.npm_package_version || null },
            session: {
                loggedIn: !!req.session?.loggedIn,
                cookieMaxAgeMs: req.session?.cookie?.maxAge || null,
            },
            consent: res.locals.cookieConsent,
            uploads,
        };

        const filename = `iso-share-export-${Date.now()}.json`;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(JSON.stringify(exportData, null, 2));
    } catch (error) {
        console.error('Export error:', error);
        res.status(500).send('Export fehlgeschlagen');
    }
});

// Löschung: beendet Session; optional (mit Bestätigung) Purge der Uploads
app.post('/account/delete', checkAuth, (req, res) => {
    const purgeUploads = req.body?.purgeUploads === 'true' || req.body?.purgeUploads === true;
    const confirmText = String(req.body?.confirmText || '');

    const doPurge = purgeUploads && confirmText === 'DELETE';

    try {
        if (doPurge) {
            ensureUploadsDir();
            for (const f of fs.readdirSync(UPLOADS_DIR)) {
                if (f.toLowerCase().endsWith(ISO_EXT)) {
                    fs.unlinkSync(path.join(UPLOADS_DIR, f));
                }
            }
        }
    } catch (error) {
        console.error('Purge error:', error);
        // Purge failure shouldn't prevent logout
    }

    // Clear consent cookie (preference cookie) and destroy session
    clearCookie(res, COOKIE_CONSENT_NAME, { path: '/' });
    req.session.destroy(() => {
        res.redirect('/');
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Server läuft auf http://localhost:${PORT}`);
});
