# Changelog

## Unveröffentlicht

### Neu
- Zentrales Event-Log mit Admin-Dashboard (`/admin/logs`): Kennzahlen (Fehlerquote, HTTP-5xx-Quote, fehlgeschlagene Logins, IP-Sperren, kritische Events), Verlauf nach Schweregrad, Verteilung nach Modul, farbcodierte Tabelle mit Filtern (Schweregrad, Modul, Zeitraum, Volltext), Detailansicht mit JSON-Payload, Vorher-Nachher-Diff und Stacktrace, Export als CSV und JSON
- Erfasst werden Audit-Aktionen, jeder HTTP-Request, Hintergrund-Jobs, langsame DB-Abfragen und DB-Fehler, Rate-Limit-Sperren, CSRF-Abweisungen, fehlgeschlagene API-Token-Prüfungen, Mailversand und unbehandelte Fehler — jeweils mit UTC-Zeit, Akteur, IP, User-Agent, Modul, Session-Hash und Request-ID
- Eigene Datei `DATA_DIR/events.db`, asynchron in Stapeln geschrieben; Löschfristen je Schweregrad, Obergrenze und optionales gzip-Archiv, einstellbar unter `/admin/logs/settings`
- `LOG_CONSOLE_LEVEL` (Default `warn`); `/metrics` um `iso_share_events_*` ergänzt
- Ticketsystem:
  - Kunden können Tickets per E-Mail eröffnen (nicht nur beantworten) — nur mit bestätigtem Konto und DKIM/DMARC-Prüfung durch den eigenen Mailserver (`IMAP_AUTHSERV_ID`, siehe `OPERATIONS.md`)
  - Der Support kann Tickets für einen Kunden anlegen (`/admin/tickets/new`, z. B. nach einem Anruf)
  - Tickets können sich auf eine ISO-Datei beziehen: Auswahl beim Anlegen, „Problem mit dieser Datei melden“ in der Dateiliste, Prüfsumme und Boot-Infos in der Ticketansicht, offene Tickets je Datei im Admin-Bereich
  - Antwortfristen (SLA) je Priorität, Ansicht „Frist überschritten“, Sortierung nach Fälligkeit und eine Mail an den Support bei Überschreitung
  - Doppelte Tickets desselben Kunden lassen sich zusammenführen; die alte Nummer leitet weiter, Mail-Antworten auf den alten Thread landen im Ziel
  - Tickets lassen sich aufteilen: ausgewählte Nachrichten samt Anhängen wandern in ein neues Ticket desselben Kunden, beide Verläufe und Seitenleisten verweisen aufeinander, der Kunde bekommt eine Mail
  - Wissensdatenbank unter `/support` mit Suche; passende Artikel werden beim Anlegen eines Tickets vorgeschlagen und lassen sich in Antworten verlinken
  - Anhänge gehen als echte Dateien mit den Ticket-Mails mit (`MAIL_ATTACHMENT_MAX_MB`, Default 10)
  - Berichtsseite `/admin/reports`: erstellt/gelöst im Verlauf, Erstantwort- und Lösungszeit, Fristquote, Zufriedenheit, Verteilungen, meistgelesene Hilfeartikel
  - Wiedervorlage: Ein offenes Ticket lässt sich bis zu einem Zeitpunkt aus dem Posteingang ausblenden. Vorgaben sind „Morgen“, „In 3 Tagen“, „Nächster Montag“ und „In 1 Woche“ (jeweils 9 Uhr), alternativ ein eigener Zeitpunkt; optional mit interner Notiz, auch als Sammelaktion. Zum Zeitpunkt ist das Ticket wieder da und als ungelesen markiert, eine Kundenantwort holt es sofort zurück. Die Antwortfrist läuft weiter, Erinnerung und automatisches Lösen pausieren. Eigene Ansicht „Wiedervorlage“, für Kunden unsichtbar
  - Jede Änderung an Status, Priorität, Kategorie, Tags und ISO-Datei steht mit Vorher/Nachher im Audit-Log, Tag-Änderungen auch im internen Ticketverlauf
- `APP_TIMEZONE` (Default `Europe/Berlin`): alle angezeigten Zeiten — Seiten, Event-Log, Live-Updates im Browser, Dateizeiten in ZIP-Downloads — in einer festen Zeitzone statt der des Servers (im Container UTC) bzw. des Browsers; gespeichert wird weiter UTC

- Einheitliches Bestätigungs-Modal für alle Rückfragen im Projekt: Ticket schließen (auch per Antwort und Sammelaktion), zusammenführen, aufteilen, löschen, Kunde sperren/löschen, Konto löschen, Artikel/Kategorie/Textbaustein/Archiv löschen, Log-Regeln anwenden, Tag entfernen, Upload abbrechen, „Problem gelöst“. Abtipp-Bestätigungen (Ticketnummer, E-Mail, „LÖSCHEN“) passieren im Modal; ohne JS bleibt die bisherige Absicherung im Formular

### Behoben
- Nach dem Absenden eines Formulars (Wiedervorlage, Eigenschaften, Einstellungen, Sammelaktionen …) springt die Seite nicht mehr nach oben — das abgeschickte Formular steht nach dem Neuladen wieder an derselben Stelle, eine Erfolgsmeldung außer Sicht erscheint zusätzlich als Toast
- Live-Updates: Das Eigenschaften-Formular eines Tickets (Status, Priorität, Kategorie, Tags, ISO-Datei) wurde nie aktualisiert, sobald Kategorie oder ISO-Datei leer waren — eine `<select>` ohne vorausgewählte Option galt fälschlich als „gerade bearbeitet“. Betraf jeden Live-Bereich mit so einem Auswahlfeld
- Live-Updates: Die erste Datei erscheint jetzt ohne Neuladen in einer leeren Dateiliste (öffentlich und Admin), nach dem Löschen der letzten erscheint der Leer-Hinweis
- Live-Updates: Die ISO-Karte eines Tickets erscheint bzw. verschwindet live, wenn nachträglich eine Datei zugeordnet oder entfernt wird
- Live-Updates blieben stehen, wenn Admin und Kunden hinter derselben IP (Büro-NAT, lokaler Test) mit mehreren Tabs zusammen das Poll-Limit erreichten — das Limit gilt jetzt je angemeldeter Sitzung
- Ticketsystem gehärtet:
  - Der IMAP-Abruf lud alle Anhänge einer Mail in den Speicher, bevor die Grenze von 5 Dateien griff — eine Mail mit hunderten Anhängen konnte den Prozess zum Absturz bringen. Jetzt werden höchstens so viele geladen, wie übernommen werden, zu große gar nicht
  - Mail-Schleife: Auf jede Antwort an ein geschlossenes Ticket ging ein Hinweis raus — mit einem Autoresponder ohne `Auto-Submitted` endlos. Der Hinweis kommt jetzt höchstens einmal je Ticket und 24 h und nie auf Mails mit `X-Auto-Response-Suppress`/`X-Loop`; Bounces (leerer `Return-Path`, `mailer-daemon`) und Listen-Mails (`List-Id`) werden als automatisch erkannt
  - Ticket-Anhänge prüfen die Speicherreserve `MIN_FREE_DISK_MB` wie ISO-Uploads — ein vollgeschriebenes Volume legte sonst auch die Datenbank lahm
  - Ein Kunde mit vielen IPs konnte das globale Ticket-Limit (600/h) leerlaufen lassen und so alle anderen aussperren. Jetzt gilt ein eigenes Limit je Konto (30/h), das globale ist nur noch Notbremse (5000/h); zusätzlich höchstens 20 neue Web-Tickets je Konto und Tag
  - Eine Mail konnte nach einem Absturz zwischen Verarbeitung und „gelesen“-Markierung doppelt im Ticket landen — jede Mail wird jetzt per Message-ID nur einmal verarbeitet
  - Mails, die jemand im Mailprogramm schon gelesen hatte, wurden nie verarbeitet. Der Abruf merkt sich jetzt die IMAP-UID statt sich auf das Gelesen-Flag zu verlassen; optional wandern verarbeitete Mails in einen Ordner (`IMAP_PROCESSED_MAILBOX`)
  - Schlug das Speichern eines Anhangs fehl, gab es das Ticket trotz Fehlermeldung schon (beim Wiederholen doppelt). Ticket, Nachricht und Anhänge werden jetzt gemeinsam in einer Transaktion angelegt; verwaiste Anhang-Dateien räumt die stündliche Wartung weg
  - Mit `IMAP_AUTHSERV_ID` brauchen auch Mail-Antworten auf bestehende Tickets DKIM/DMARC — die signierte Thread-Referenz allein kennt jeder, der eine Ticket-Mail weitergeleitet bekam
  - Numerische HTML-Entities (`&#8364;`) in HTML-only-Mails werden dekodiert
  - `/metrics`: `iso_share_mail_inbound_total{result}`, `iso_share_ticket_attachments`, `iso_share_ticket_attachments_bytes`

### Geändert
- Live-Updates auch für: Ticket-Zähler in der Navigation auf allen Seiten (neuer Endpoint `/partials/nav`), Hilfeartikel-Liste unter `/support`, einzelne Hilfeartikel, Löschfristen in der Datenschutzerklärung, die „Ersetzt vorhandene Datei“-Auswahl im Upload, Admin-Benutzername und TOTP-Status, Kundenname im Ticket-Kopf und in der Kundenansicht. Das Live-Polling eines Hilfeartikels zählt keinen Aufruf
- `/support` leitet angemeldete Kunden nicht mehr sofort auf ihre Tickets um, sondern zeigt die Hilfeartikel mit Buttons zu „Neues Ticket“ und „Meine Tickets“
- Schema-Version 4 (neue Spalten in `tickets` und `mail_outbox`, zuletzt `tickets.split_from_id`); ein älteres Image verweigert die aktualisierte Datenbank
- Die Konsole zeigt nur noch Wesentliches (Start, Stop, Warnungen, Fehler); einzelne Requests stehen im Event-Log. 4xx-Antworten sind auf der Konsole kein `warn` mehr
- Das Audit-Log ist Teil des Event-Logs; bestehende Einträge aus `audit_log` werden beim ersten Start übernommen. `/admin-audit-log` leitet auf `/admin/logs?audit=1` um
- Die Wiederherstellung einer Sicherung erscheint jetzt selbst im Audit-Log (vorher nur in `last-restore.json`)

## 2.0.0 — 2026-09-23

Produktionsreife. **Breaking** für bestehende Docker-Deployments: siehe „Umstieg“ unten.

### Neu
- Ticketsystem mit Kundenkonten, Mailversand (SMTP-Outbox) und Antworten per Mail (IMAP)
- Konfigurationsprüfung beim Start (`lib/config-check.js`): im Produktivbetrieb startet die App nicht mit fehlendem `TRUST_PROXY`, fehlender oder unverschlüsselter `PUBLIC_URL` (bei aktivem SMTP) oder ungültigen Grenzwerten
- Versionierte Schema-Migrationen über `PRAGMA user_version`; ein älteres Image verweigert eine neuere Datenbank
- Speicherplatzprüfung vor Uploads (HTTP 507, Reserve `MIN_FREE_DISK_MB`), Aufräumen verwaister Multipart-Zwischendateien
- Strukturierte JSON-Logs (`LOG_FORMAT`, `LOG_LEVEL`), Zugriffslog mit `X-Request-Id`, ohne Query-Strings
- Geordnetes Herunterfahren: laufende Requests dürfen bis `SHUTDOWN_TIMEOUT_MS` zu Ende laufen, `unhandledRejection`/`uncaughtException` beenden kontrolliert
- Löschfristen für Audit-Log, unbestätigte Konten und geschlossene Tickets (`*_RETENTION_DAYS`); die Datenschutzerklärung zeigt die wirksamen Werte an
- `/healthz` prüft die Datenbank (503 bei Fehler); `/metrics` mit Outbox-, IMAP-, Backup-, Speicher- und Versionswerten, optional per `METRICS_TOKEN` geschützt
- Stündliche SQLite-Pflege (`PRAGMA optimize`, WAL-Checkpoint); `busy_timeout` und `synchronous=NORMAL`
- Caddy als optionaler TLS-Proxy (`docker compose --profile tls`), `OPERATIONS.md`, `.env.example`
- CI: Node 22 + 24, Syntax-Check (`npm run lint`), Docker-Build mit Smoke-Test und Trivy-Scan; Dependabot

### Geändert
- `.dockerignore` hält `data/`, `uploads/`, `.env*` und Tests aus dem Image (vorher landete eine lokale Datenbank samt Secrets im Image)
- Basis-Image auf `node:24.18-alpine` gepinnt; Anwendungscode gehört root, nur die Datenverzeichnisse dem User `node`
- Compose: App nur noch auf `127.0.0.1:3000`, `init`, `stop_grace_period`, Log-Rotation, `cap_drop`, `no-new-privileges`, Speicherlimit
- Paketname `iso-share`

### Umstieg von 1.x
1. `.env` um `TRUST_PROXY=1` (hinter einem Proxy) und, bei aktivem SMTP, `PUBLIC_URL=https://…` ergänzen — sonst startet der Container nicht.
2. Die App ist nicht mehr direkt auf Port 3000 von außen erreichbar: `--profile tls` (Caddy) nutzen oder den eigenen Proxy auf `127.0.0.1:3000` zeigen lassen.
3. Vor dem Update eine Sicherung anlegen; die Datenbank wird beim ersten Start auf Schema-Version 2 gehoben.
