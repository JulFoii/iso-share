# ISO Share

**ISO Share** ist eine minimalistische Webanwendung zum sicheren Teilen und Verwalten von ISO-Dateien – ideal als Basis für weitere Erweiterungen. Die Anwendung bietet einen einfachen Datei‑Upload, Download sowie Echtzeit‑Suche und Sortierung mit einem sauberen, klassischen, hellen Bootstrap‑Design.

---

## Inhaltsverzeichnis

- [Features](#features)
- [Installation](#installation)

---

## Features

- **Einfacher Datei‑Upload:**  
  Lade ausschließlich ISO-Dateien hoch – unerwünschte Dateitypen werden automatisch abgelehnt.

- **Dateiverwaltung & Download:**  
  Alle hochgeladenen Dateien werden in einer übersichtlichen, sortierbaren Tabelle angezeigt.  
  *Sortierung:*  
  - Klick auf „Dateiname“ sortiert abwechselnd von A–Z und Z–A.  
  - Klick auf „Größe“ sortiert erst aufsteigend, dann absteigend.

- **Echtzeit-Suche:**  
  Filtere Dateien direkt beim Tippen – egal ob im Benutzerbereich oder im Admin‑Bereich.

- **Admin-Bereich:**  
  Ein geschützter Bereich ermöglicht:
  - Dateiupload und Löschen
  - Erweiterte Verwaltungsfunktionen
  - Login-System (mit einfachem Passwortschutz)

- **Modernes Design:**  
  Einheitliches, helles Bootstrap‑Design (Weiß/hellgrau) mit klassischer Ästhetik, responsiv und benutzerfreundlich.

- **Footer:**  
  Der Footer bleibt stets am Seitenende, unabhängig von der Content‑Länge.

---

## Installation

### Voraussetzungen

- **[Node.js](https://nodejs.org/)** (v14 oder höher) und **npm** ODER
- **[Docker](https://www.docker.com/)** und **Docker Compose**

### Setup

#### Konfiguration per Umgebungsvariablen (.env)

Du kannst die wichtigsten Einstellungen über Umgebungsvariablen setzen (z. B. in einer `.env`).

**Sicherheit / Login**

```env
ADMIN_PASSWORD=DEIN_SICHERES_PASSWORT
SESSION_SECRET=EIN_LANGES_RANDOM_SECRET
```

**Impressum & Datenschutz (werden in den Seiten dynamisch angezeigt)**

```env
LEGAL_NAME=Julian Foitzik
LEGAL_COMPANY=
LEGAL_ADDRESS_LINE1=Musterstraße 1
LEGAL_ADDRESS_LINE2=
LEGAL_POSTAL_CITY=12345 Musterstadt
LEGAL_COUNTRY=Deutschland
LEGAL_EMAIL=kontakt@example.de
LEGAL_PHONE=
LEGAL_VAT_ID=
LEGAL_CONTENT_RESPONSIBLE=
```

> Hinweis: Wenn Felder leer sind (z. B. USt-ID), wird das in den Rechtstexten automatisch passend angezeigt.

### Recht & Compliance (DE/EU)

- **Datenschutz:** `/datenschutz`
- **Impressum:** `/impressum`
- **Cookie-Einstellungen (TTDSG):** `/cookie-settings` (Preference-Cookie; Analytics standardmäßig deaktiviert)
- **Datenexport (Art. 20 DSGVO):** `/account/export` (nach Admin-Login)
- **Account-Löschung / Purge:** `/account` → Session löschen (optional: Upload-Purge mit Bestätigung)

#### Option 1: Standard Installation

1. **Repository klonen:**

   ```bash
   git clone https://github.com/JulFoii/iso-share.git
   cd iso-share
   ```

2. **Abhängigkeiten installieren:**

   ```bash
   npm install
   ```

3. **Uploads-Ordner ignorieren:**

   Stelle sicher, dass der uploads-Ordner in der .gitignore eingetragen ist

4. **Server starten:**

   ```bash
   node server.js
   ```

5. **Browser öffnen:**

   Rufe http://localhost:3000 auf, um die Anwendung zu nutzen

#### Option 2: Docker Installation

1. **Repository klonen:**

   ```bash
   git clone https://github.com/JulFoii/iso-share.git
   cd iso-share
   ```

2. **Mit Docker Compose starten:**

   ```bash
   docker-compose up -d
   ```

3. **Browser öffnen:**

   Rufe http://localhost:3000 auf, um die Anwendung zu nutzen

#### Docker Befehle

- **Container stoppen:** `docker-compose down`
- **Logs anzeigen:** `docker-compose logs -f`
- **Container neu erstellen:** `docker-compose up -d --build`
- **Nur Docker (ohne Compose):**
  ```bash
  docker build -t iso-share .
  docker run -d -p 3000:3000 -v $(pwd)/uploads:/app/uploads iso-share
  ```


## CI/CD (Docker + GHCR + Watchtower)

Dieses Repo enthält eine GitHub Actions Pipeline, die bei jedem Push/Merge nach `main` automatisch:
1) ein neues Docker-Image **aus dem aktuellen Code** baut,
2) es **versioniert** nach **GitHub Container Registry (GHCR)** pusht (Tags: `latest`, `sha-...`, `v0.0.<run>`),
3) einen **GitHub Release** erstellt und als „Latest Release“ markiert.

Auf dem Server übernimmt **Watchtower** dann vollautomatisch das Update:
- neues Image ziehen,
  laufenden Container kontrolliert stoppen,
  neuen Container starten,
  alte Images aufräumen.

### 1) Voraussetzungen

- Docker + Docker Compose Plugin auf dem Server
- GHCR Image ist **public** ODER du loggst den Server einmalig an GHCR ein (für private Repos)

**Wichtig (gegen 403 beim Push nach GHCR):**

Damit GitHub Actions Images nach **GHCR** pushen darf (mit dem eingebauten `GITHUB_TOKEN`), muss im Repo folgendes gesetzt sein:

1. **Settings → Actions → General → Workflow permissions**
   - ✅ **Read and write permissions** aktivieren

Optional (wenn du die GHCR-Pakete wirklich öffentlich brauchst):
2. **Packages → iso-share → Package settings**
   - Visibility: **Public**

### 2) Server-Setup (einmalig)

Auf dem Server (z.B. `/opt/iso-share`):

```bash
mkdir -p /opt/iso-share/uploads
cd /opt/iso-share

# docker-compose.yml und .env hierhin kopieren

# nur nötig, wenn GHCR privat ist:
docker login ghcr.io -u <dein_github_user> -p <DEIN_PAT_MIT_read:packages>

docker compose --profile watchtower up -d
```

✅ Ab jetzt aktualisiert Watchtower automatisch den Container, sobald `:latest` auf GHCR neu gebaut wurde.

### 3) Wie Watchtower arbeitet

- Watchtower läuft als eigener Container im selben Compose-Stack.
- Der App-Container hat das Label `com.centurylinklabs.watchtower.enable=true`.
- Watchtower prüft in Intervallen (default hier: 60s) auf Updates und macht dann ein kontrolliertes Replace/Restart.

### 4) GitHub Actions Pipeline

Die Pipeline liegt unter:

- `.github/workflows/docker-image.yml`

Sie benötigt **keine SSH-Secrets** mehr – nur das Standard `GITHUB_TOKEN` (wird automatisch bereitgestellt).

Hinweis: Damit der Server Images ziehen kann, muss das GHCR-Paket entweder **public** sein oder du nutzt `docker login` (siehe oben).

### 5) Production Compose

Nutze für Production:
- `docker-compose.yml` (einzige Compose-Datei; kann lokal bauen oder in Produktion ein Image von GHCR ziehen; Watchtower ist per Profile aktivierbar)

Uploads bleiben erhalten, weil `./uploads` auf dem Server ein bind-mount ist.


## CI/CD (Public GitHub Repo + GHCR + Watchtower)

- Das Repository ist **öffentlich**. Das Docker-Image wird nach **GitHub Container Registry (GHCR)** gepusht.
- Für **öffentliche** GHCR-Packages ist auf dem Server **kein `docker login` nötig**.
- Wichtig: Stelle in GitHub unter *Packages* die Sichtbarkeit des Images auf **Public** (nach dem ersten Push erscheint das Package dort).

### Server (einmalig)
1. Lege `.env` an und setze mindestens:

```env
ISO_SHARE_IMAGE=ghcr.io/<OWNER>/<REPO>:latest
ISO_SHARE_PORT=3000
```

2. Starte den Stack:

```bash
docker compose --profile watchtower up -d
```

Ab dann: **Push/Merge nach `main` ⇒ neues Image ⇒ Watchtower zieht & ersetzt automatisch.**
