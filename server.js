const express = require('express');
const multer = require('multer');
const session = require('express-session');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.ADMIN_PASSWORD || 'PASSWORD'; // 🔐 Use environment variable or default

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

const upload = multer({ dest: 'uploads/' });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static('uploads'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

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
app.use(session({
    secret: process.env.SESSION_SECRET || 'supersecretkey',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 1000 * 60 * 60 * 24 } // 24 hours
}));

// Auth-Middleware
function checkAuth(req, res, next) {
    if (req.session && req.session.loggedIn) {
        return next();
    }
    res.redirect('/login');
}

// Startseite (User-Ansicht)
app.get('/', (req, res) => {
    try {
        if (!fs.existsSync('./uploads')) {
            fs.mkdirSync('./uploads', { recursive: true });
        }
        const files = fs.readdirSync('./uploads').filter(f => f.endsWith('.iso'));
        const fileData = files.map(name => {
            const size = fs.statSync(path.join('uploads', name)).size;
            return { name, size };
        });
        res.render('index', { files: fileData });
    } catch (error) {
        console.error('Error loading files:', error);
        res.status(500).render('index', { files: [] });
    }
});

// Datei-Download
app.get('/download/:filename', (req, res) => {
    try {
        const filename = req.params.filename;
        // Security: Prevent path traversal attacks
        if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
            return res.status(400).send('Invalid filename');
        }
        
        const filePath = path.join(__dirname, 'uploads', filename);
        if (fs.existsSync(filePath) && filename.endsWith('.iso')) {
            res.download(filePath);
        } else {
            res.status(404).send('Datei nicht gefunden');
        }
    } catch (error) {
        console.error('Download error:', error);
        res.status(500).send('Server error');
    }
});

// Login
app.get('/login', (req, res) => {
    res.render('login', { error: null });
});

app.post('/login', (req, res) => {
    const { password } = req.body;
    if (password === PASSWORD) {
        req.session.loggedIn = true;
        res.redirect('/admin-upload');
    } else {
        res.render('login', { error: 'Falsches Passwort!' });
    }
});

// Admin Upload-Ansicht
app.get('/admin-upload', checkAuth, (req, res) => {
    try {
        if (!fs.existsSync('./uploads')) {
            fs.mkdirSync('./uploads', { recursive: true });
        }
        const files = fs.readdirSync('./uploads').filter(f => f.endsWith('.iso'));
        const fileData = files.map(name => {
            const size = fs.statSync(path.join('uploads', name)).size;
            return { name, size };
        });
        res.render('admin', { files: fileData });
    } catch (error) {
        console.error('Error loading admin files:', error);
        res.status(500).render('admin', { files: [] });
    }
});

// Upload
app.post('/upload', checkAuth, upload.single('file'), (req, res) => {
    const file = req.file;
    if (!file.originalname.endsWith('.iso')) {
        fs.unlinkSync(file.path);
        return res.send('Nur .iso-Dateien erlaubt!');
    }
    const targetPath = path.join('uploads', file.originalname);
    fs.renameSync(file.path, targetPath);
    res.redirect('/admin-upload');
});

// Datei löschen
app.post('/delete', checkAuth, (req, res) => {
    const { filename } = req.body;
    const filePath = path.join(__dirname, 'uploads', filename);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }
    res.redirect('/admin-upload');
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
        if (!fs.existsSync('./uploads')) {
            fs.mkdirSync('./uploads', { recursive: true });
        }
        const uploads = fs.readdirSync('./uploads')
            .filter(f => f.endsWith('.iso'))
            .map(name => {
                const stat = fs.statSync(path.join('uploads', name));
                return { name, size: stat.size, mtime: stat.mtime.toISOString() };
            });

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
            if (fs.existsSync('./uploads')) {
                for (const f of fs.readdirSync('./uploads')) {
                    if (f.endsWith('.iso')) {
                        fs.unlinkSync(path.join('uploads', f));
                    }
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

// 🔍 Suche in der User-Ansicht
app.get('/search', (req, res) => {
    if (!fs.existsSync('./uploads')) {
        fs.mkdirSync('./uploads', { recursive: true });
    }
    const query = req.query.q?.toLowerCase() || '';
    const files = fs.readdirSync('./uploads').filter(f =>
        f.endsWith('.iso') && f.toLowerCase().includes(query)
    );
    const fileData = files.map(name => {
        const size = fs.statSync(path.join('uploads', name)).size;
        return { name, size };
    });
    res.render('index', { files: fileData, searchQuery: query });
});

// 🔍 Suche in der Admin-Ansicht
app.get('/admin-search', checkAuth, (req, res) => {
    if (!fs.existsSync('./uploads')) {
        fs.mkdirSync('./uploads', { recursive: true });
    }
    const query = req.query.q?.toLowerCase() || '';
    const files = fs.readdirSync('./uploads').filter(f =>
        f.endsWith('.iso') && f.toLowerCase().includes(query)
    );
    const fileData = files.map(name => {
        const size = fs.statSync(path.join('uploads', name)).size;
        return { name, size };
    });
    res.render('admin', { files: fileData, searchQuery: query });
});

app.listen(PORT, () => {
    console.log(`🚀 Server läuft auf http://localhost:${PORT}`);
});
