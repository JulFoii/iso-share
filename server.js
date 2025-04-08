const express = require('express');
const multer = require('multer');
const session = require('express-session');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
const PASSWORD = 'PASSWORD'; // 🔐 Hier dein Admin-Passwort

const upload = multer({ dest: 'uploads/' });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static('uploads'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Session-Konfiguration
app.use(session({
    secret: 'supersecretkey',
    resave: false,
    saveUninitialized: false
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
    const files = fs.readdirSync('./uploads').filter(f => f.endsWith('.iso'));
    const fileData = files.map(name => {
        const size = fs.statSync(path.join('uploads', name)).size;
        return { name, size };
    });
    res.render('index', { files: fileData });
});

// Datei-Download
app.get('/download/:filename', (req, res) => {
    const filePath = path.join(__dirname, 'uploads', req.params.filename);
    if (fs.existsSync(filePath)) {
        res.download(filePath);
    } else {
        res.status(404).send('Datei nicht gefunden');
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
    const files = fs.readdirSync('./uploads').filter(f => f.endsWith('.iso'));
    const fileData = files.map(name => {
        const size = fs.statSync(path.join('uploads', name)).size;
        return { name, size };
    });
    res.render('admin', { files: fileData });
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

// 🔍 Suche in der User-Ansicht
app.get('/search', (req, res) => {
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
