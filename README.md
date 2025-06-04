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
