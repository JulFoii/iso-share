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

- **[Node.js](https://nodejs.org/)** (v14 oder höher)
- **npm** (wird mit Node.js installiert)

### Setup

1. **Repository klonen:**

   git clone https://github.com/JulFoii/iso-share.git

   cd iso-share

3. **Abhängigkeiten installieren**

   npm install

4. **Uploads-Ordner ignorieren**

  Stelle sicher, dass der uploads-Ordner in der .gitignore eingetragen ist

4. **Server starten**

   node server.js

5. **Browser öffnen**

   Rufe http://loalhost:3000 auf, um die Anwendung zu nutzen
