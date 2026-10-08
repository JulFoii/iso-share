# ISO Share

**ISO Share** ist eine schlanke, selbst gehostete Webanwendung zum sicheren Teilen und Verwalten von ISO-Images, mit integriertem Support-Ticketsystem.

## Features

- **ISO-Verwaltung**: fortsetzbare Uploads bis mehrere GB, Downloads mit Range-Support, ZIP-Sammeldownload, Duplikaterkennung per SHA-256, automatische Tags aus den ISO-Metadaten (Bootfähigkeit BIOS/UEFI, Volume-Label)
- **Prüfsummen**: `SHA256SUMS` unter `/checksums`, JSON-API unter `/api/v1` (OpenAPI: `/openapi.json`)
- **Admin-Bereich**: Passwort plus optional Passkey oder TOTP, Audit-Log, API-Tokens, automatische Datenbank-Sicherungen mit Wiederherstellung
- **Support-Portal**: Kundenkonten, Tickets mit Anhängen, Mail-Benachrichtigungen, Antworten per E-Mail, Automatik für Erinnerungen und Schließen
- **Betrieb**: SQLite ohne separaten DB-Server, JSON-Logs, `/healthz`, Prometheus-`/metrics`, Löschfristen nach DSGVO
- Kein CSS/JS-Framework, kein CDN — alles wird vom eigenen Server ausgeliefert

## Schnellstart (Entwicklung)

Voraussetzung: [Node.js](https://nodejs.org/) ≥ 22.5 (empfohlen 24).

```bash
git clone https://github.com/JulFoii/iso-share.git
cd iso-share
npm install
npm start          # http://localhost:3000, Admin-Login unter /login
npm test           # Unit- und Integrationstests
npm run lint       # Syntax-Check aller JavaScript-Dateien
```

Ohne `ADMIN_PASSWORD` wird beim ersten Start ein zufälliges Passwort erzeugt und einmalig im Log ausgegeben.

## Produktivbetrieb

```bash
cp .env.example .env && chmod 600 .env   # DOMAIN, PUBLIC_URL, SMTP, … ausfüllen
docker compose --profile tls up -d --build
```

Das startet die App hinter Caddy mit automatischem Let's-Encrypt-Zertifikat. Go-live-Checkliste, Backups (inklusive Offsite), Monitoring, Updates und Notfälle beschreibt **[OPERATIONS.md](OPERATIONS.md)**. Die Architektur und alle Umgebungsvariablen stehen in [CLAUDE.md](CLAUDE.md), die Änderungen in [CHANGELOG.md](CHANGELOG.md).
