'use strict';

/*
 * `npm run lint`: prueft jede JavaScript-Datei des Projekts mit `node --check`
 * auf Syntaxfehler — auch die Browser-Skripte in public/js/, die kein Test
 * laedt. Bewusst ohne ESLint-Dependency (kurze Abhaengigkeitsliste, siehe
 * CLAUDE.md); faengt vor allem kaputte Merges und Tippfehler in Dateien ab,
 * die nur im Browser laufen.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIRS = ['lib', 'public/js', 'test', 'scripts'];

function collect(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return collect(full);
        return entry.name.endsWith('.js') ? [full] : [];
    });
}

const files = [path.join(ROOT, 'server.js'), ...DIRS.flatMap(dir => collect(path.join(ROOT, dir)))];
let failed = 0;
for (const file of files) {
    try {
        execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (err) {
        failed++;
        process.stderr.write(`✖ ${path.relative(ROOT, file)}\n${err.stderr}\n`);
    }
}
JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'openapi.json'), 'utf8'));
console.log(`${files.length - failed}/${files.length} Dateien syntaktisch in Ordnung, openapi.json gültig.`);
process.exit(failed > 0 ? 1 : 0);
