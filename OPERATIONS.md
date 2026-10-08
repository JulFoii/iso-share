# Betriebshandbuch

Alles, was für den Produktivbetrieb von ISO Share nötig ist: Go-live-Checkliste, Deployment, Backups, Monitoring, Updates und Notfälle. Architektur und Sicherheitsdetails stehen in `CLAUDE.md`.

## Go-live-Checkliste

- [ ] DNS-Eintrag für die Domain zeigt auf den Server, Ports 80 und 443 sind offen, 3000 **nicht**
- [ ] `.env` aus `.env.example` angelegt, `chmod 600 .env`
- [ ] `DOMAIN`, `PUBLIC_URL` (https) und `TRUST_PROXY=1` gesetzt
- [ ] `METRICS_TOKEN` gesetzt (`openssl rand -hex 32`)
- [ ] SMTP konfiguriert und eine Testmail unter `/admin/ticket-settings` erfolgreich verschickt
- [ ] Erster Start: Admin-Passwort aus dem Log notiert (`docker compose logs iso-share | grep 'generiertes Passwort'`) und sofort unter `/admin-upload` geändert
- [ ] Passkey **oder** TOTP für den Admin eingerichtet, Recovery-Codes offline abgelegt
- [ ] Automatische Datenbank-Sicherung unter `/admin-upload` aktiviert
- [ ] Offsite-Backup des Volumes eingerichtet (siehe unten) und **einmal testweise wiederhergestellt**
- [ ] Monitoring: `/healthz` von außen überwacht, `/metrics` gescrapt, Alerts aktiv
- [ ] Impressum (`views/imprint.ejs`) und Datenschutzerklärung (`views/privacy.ejs`) inhaltlich geprüft: Betreiber, Mail-Anbieter als Auftragsverarbeiter, Speicherdauer der Server-Logfiles
- [ ] Löschfristen (`*_RETENTION_DAYS`) bewusst gewählt — die Datenschutzerklärung zeigt die eingestellten Werte automatisch an

## Deployment

```bash
cp .env.example .env && chmod 600 .env   # ausfüllen
docker compose --profile tls up -d --build
docker compose logs -f iso-share
```

- **Mit mitgeliefertem Caddy** (`--profile tls`): Caddy holt das Let's-Encrypt-Zertifikat für `DOMAIN` automatisch, leitet http auf https um und streamt Uploads/Downloads ungepuffert durch.
- **Mit eigenem Reverse Proxy** (nginx, Traefik, …): `docker compose up -d` startet nur die App auf `127.0.0.1:3000`. Der Proxy muss `X-Forwarded-For` **überschreiben** (nicht anhängen) und `X-Forwarded-Proto` setzen. Für nginx außerdem `client_max_body_size 0; proxy_request_buffering off; proxy_buffering off; proxy_read_timeout 1h;`, sonst brechen große Uploads/Downloads ab.

Die App startet im Produktivbetrieb **nicht**, wenn die Konfiguration unsicher ist (fehlendes `TRUST_PROXY`, `PUBLIC_URL` ohne https bei aktivem SMTP, …). Die Meldung im Log nennt alle Probleme auf einmal.

### Volumes

| Pfad im Container | Inhalt | Backup |
|---|---|---|
| `/app/data` (Volume `iso-share-sessions`) | SQLite-DB, `events.db` (Event-Log), `backups/`, `ticket-attachments/`, `log-archive/` | **Pflicht** |
| `/app/uploads` (Bind-Mount `./uploads`) | ISO-Dateien | je nach Wiederbeschaffbarkeit |

`./uploads` muss für UID 1000 (User `node` im Container) beschreibbar sein: `sudo chown -R 1000:1000 uploads`.

## Backups

Die eingebauten Sicherungen (`/admin-upload` → Sicherungen) sind konsistente Snapshots der **Datenbank**. Sie liegen aber auf demselben Volume wie die Datenbank selbst und enthalten weder Ticket-Anhänge noch ISOs. Ein Plattendefekt nimmt sie also mit. Für den Produktivbetrieb deshalb zusätzlich das Volume außer Haus sichern, z. B. mit restic:

```bash
# /etc/cron.d/iso-share-backup — täglich 03:30
# Volume-Name = <Compose-Projekt>_iso-share-sessions, siehe `docker volume ls`
30 3 * * * root VOL=$(docker volume inspect -f '{{.Mountpoint}}' iso-share_iso-share-sessions) && \
  restic -r sftp:backup@host:/iso-share backup "$VOL/backups" "$VOL/ticket-attachments" /opt/iso-share/uploads && \
  restic -r sftp:backup@host:/iso-share forget --keep-daily 14 --keep-weekly 8 --prune
```

Gesichert werden `backups/` (konsistente DB-Snapshots, **nicht** die offene `iso-share.db`, deren Kopie im laufenden Betrieb inkonsistent sein kann), `ticket-attachments/` und optional `uploads/`.

### Wiederherstellen

- **Einzelner DB-Stand**: `/admin-upload` → Sicherung → „Wiederherstellen“. Die App legt vorher automatisch einen `pre-restore-`-Snapshot an und startet danach neu.
- **Komplettverlust**: Volume neu anlegen, `backups/<datei>.db` als `iso-share.db` und `ticket-attachments/` zurückkopieren, Container starten. Ältere Schema-Versionen werden beim Start automatisch migriert.

## Monitoring

- **Liveness**: `GET /healthz` → `200 {"status":"ok","db":"ok"}`, bei nicht erreichbarer DB `503`. Der Docker-Healthcheck nutzt denselben Endpunkt. Zusätzlich von außen prüfen (z. B. Uptime Kuma), um Ausfälle von Caddy, DNS und Zertifikat mitzubekommen.
- **Metriken**: `GET /metrics` (Prometheus-Format, mit `Authorization: Bearer $METRICS_TOKEN`).
- **Event-Log** (`/admin/logs`): alle Ereignisse der App in `DATA_DIR/events.db`, einer eigenen SQLite-Datei neben der Haupt-DB — Anmeldungen, Rechte- und Datenänderungen mit Vorher-Nachher-Zustand, jeder HTTP-Request mit Status und Dauer, Hintergrund-Jobs, langsame Datenbankabfragen und DB-Fehler, Rate-Limit-Sperren, CSRF-Abweisungen, Mailversand und unbehandelte Fehler mit Stacktrace. Kennzahlen, Grafiken, Filter nach Schweregrad/Modul/Zeitraum, Volltextsuche und Export als CSV/JSON. Jede Antwort trägt einen `X-Request-Id`-Header; nennt ein Nutzer diese ID, zeigt `/admin/logs?range=all&req=<id>` alle Ereignisse dieses Requests. Query-Strings werden nie gespeichert, weil dort Einmal-Tokens stehen; Session-IDs nur als gekürzter Hash.
- **Konsole**: bewusst knapp — Start, Herunterfahren, Konfigurationswarnungen und alles ab `warn`. Einzelne Requests, Mails und Jobs erscheinen dort nur mit `LOG_CONSOLE_LEVEL=info` (oder `debug`). JSON-Zeilen auf stdout/stderr, rotiert von Docker (5 × 20 MB).
- `events.db` ist **nicht** Teil der eingebauten DB-Sicherungen (sonst würde ein Restore das Protokoll zurückdrehen). Wer sie außer Haus sichern will: `sqlite3 events.db ".backup events-copy.db"` oder die Archivdateien aus `log-archive/` mitnehmen.

Beispiel-Alertregeln (Prometheus):

```yaml
groups:
  - name: iso-share
    rules:
      - alert: IsoShareDown
        expr: up{job="iso-share"} == 0
        for: 5m
      - alert: IsoShareDiskAlmostFull
        expr: iso_share_disk_free_bytes < 5 * 1024^3
        for: 15m
      - alert: IsoShareMailFailed
        expr: iso_share_mail_outbox{status="failed"} > 0
      - alert: IsoShareMailBacklog
        expr: iso_share_mail_outbox{status="pending"} > 20
        for: 30m
      - alert: IsoShareBackupStale
        expr: time() - iso_share_backup_last_timestamp_seconds > 2 * 86400
      - alert: IsoShareImapFailing
        expr: iso_share_imap_last_poll_ok == 0
        for: 30m
      - alert: IsoShareEventLogFailing
        expr: increase(iso_share_events_write_failures_total[15m]) > 0
      - alert: IsoShareEventLogDropping
        expr: increase(iso_share_events_dropped_total[15m]) > 0
```

## Tickets per E-Mail

Mit IMAP (`IMAP_HOST`/`IMAP_USER`) nimmt die App Antworten auf bestehende Tickets an. Welche Mails neu sind, merkt sie sich über die IMAP-UID (Tabelle `imap_state`), nicht über das Gelesen-Flag — wer das Postfach nebenbei im Mailprogramm liest, verschluckt also keine Antworten mehr. Beim allerersten Abruf werden nur ungelesene Mails übernommen, ältere gelesene bleiben unberührt. Mit `IMAP_PROCESSED_MAILBOX` (z. B. `Verarbeitet`, bei manchen Servern `INBOX.Verarbeitet`) wandern verarbeitete Mails in diesen Ordner, sonst bleiben sie gelesen im Postfach. Jede Mail wird höchstens einmal verarbeitet (Message-ID, 90 Tage gemerkt), auch wenn sie nach einem Absturz erneut geliefert wird.

Damit Kunden auch **neue** Tickets per Mail eröffnen können, muss zusätzlich `IMAP_AUTHSERV_ID` gesetzt sein:

1. Vom Konto eines Testkunden eine Mail an die Support-Adresse schicken.
2. Im Webmailer/Mailprogramm des Support-Postfachs die Kopfzeilen (Quelltext) dieser Mail öffnen.
3. Den **obersten** `Authentication-Results:`-Header suchen. Das erste Wort vor dem Semikolon ist die authserv-id, z. B. `Authentication-Results: mx.gmx.net; dkim=pass …` → `IMAP_AUTHSERV_ID=mx.gmx.net`.

Die App vertraut nur diesem Header (ein Absender kann beliebige weitere mitschicken) und akzeptiert nur `dmarc=pass` für die Absenderdomain oder `dkim=pass` mit passender Signaturdomain. Außerdem muss die Absenderadresse ein bestätigtes, nicht gesperrtes Kundenkonto sein; höchstens 5 neue Tickets je Konto und Stunde. Alles andere wird still verworfen und erscheint im Event-Log als `mail_inbound_rejected` mit Grund (`no_account`, `unverified`, `auth_failed`, `rate_limited` …). Schlägt `auth_failed` bei echten Kunden an, stimmt meist die authserv-id nicht (Detail `no_auth_results`), oder die Absenderdomain signiert nicht (`not_aligned`).

Mit gesetzter `IMAP_AUTHSERV_ID` gilt dieselbe DKIM/DMARC-Prüfung auch für **Antworten** auf bestehende Tickets: die signierte Thread-Referenz kennt jeder, der eine Ticket-Mail weitergeleitet oder in CC bekommen hat, und könnte sonst mit gefälschtem Absender im Namen des Kunden antworten. Kunden einer Domain ohne DKIM/DMARC können dann nur noch im Portal antworten (Event-Log: `mail_inbound_rejected`, Grund `auth_failed`).

Schutz vor Mail-Schleifen: Automatische Mails (`Auto-Submitted`, `Precedence: bulk/list`, `List-Id`, leerer `Return-Path`, `mailer-daemon`/`postmaster`) werden nie zu Nachrichten. Den Hinweis „Ticket ist geschlossen“ bekommt ein Kunde höchstens einmal je Ticket und 24 h, und nie auf eine Mail mit `X-Auto-Response-Suppress`/`X-Loop`. Der Abruf lädt je Mail höchstens so viele Anhänge, wie übernommen werden (`TICKET_ATTACHMENT_MAX_MB`, 5 Stück); zu große werden gar nicht heruntergeladen. `/metrics` zählt eingehende Mails je Ergebnis (`iso_share_mail_inbound_total{result}`) und die Größe der Ticket-Anhänge (`iso_share_ticket_attachments_bytes`).

Ticket-Anhänge unterliegen derselben Speicherreserve wie ISO-Uploads (`MIN_FREE_DISK_MB`): passt ein Upload nicht mehr, lehnt das Formular ihn mit einer Meldung ab; per Mail kommt die Nachricht ohne die Anhänge und mit Hinweis an. Verwaiste Anhang-Dateien (Absturz zwischen Speichern und Datenbank-Eintrag) räumt die stündliche Wartung weg.

Anhänge gehen als echte Dateien mit Ticket-Mails mit, bis ihre Summe `MAIL_ATTACHMENT_MAX_MB` (Default 10) erreicht — manche Provider lehnen Mails ab ~20 MB ab (Base64 macht Anhänge rund ein Drittel größer).

## Updates

```bash
git pull
docker compose --profile tls up -d --build
docker compose logs -f iso-share    # auf "Server läuft" und Migrationen achten
```

- Vor jedem Update unter `/admin-upload` eine manuelle Sicherung anlegen.
- Schema-Änderungen laufen beim Start automatisch und transaktional (`PRAGMA user_version`, siehe `lib/db.js`).
- **Rollback**: Ein älteres Image verweigert den Start mit einer DB, deren Schema neuer ist, statt sie zu beschädigen. In diesem Fall die vor dem Update angelegte Sicherung zurückspielen oder wieder das neuere Image starten.
- `docker stop` wartet bis zu 40 s. Laufende Downloads dürfen in dieser Zeit zu Ende laufen; abgebrochene Chunk-Uploads setzen nach dem Neustart am Serverstand fort.

## Löschfristen

Laufen stündlich und beim Start (`lib/retention.js`), jeweils in Tagen, `0` schaltet ab:

| Variable | Default | Was |
|---|---|---|
| `AUDIT_LOG_RETENTION_DAYS` | 90 | Audit-Log-Einträge (mit IP-Adressen) |
| `UNVERIFIED_ACCOUNT_RETENTION_DAYS` | 30 | nie bestätigte Kundenkonten (ohne Benachrichtigung) |
| `CLOSED_TICKET_RETENTION_DAYS` | 0 (aus) | geschlossene Tickets samt Anhängen, gezählt ab Schließung |

Das Event-Log hat eigene Fristen je Schweregrad (Default DEBUG 3, INFO 30, WARNING 90, ERROR/CRITICAL 365 Tage) plus eine Obergrenze der Eintragszahl, einstellbar zur Laufzeit unter `/admin/logs/settings`. Audit-Einträge (Anmeldungen, Rechte- und Datenänderungen) folgen ausschließlich `AUDIT_LOG_RETENTION_DAYS`. Optional werden gelöschte Einträge vorher als gzip-NDJSON nach `DATA_DIR/log-archive/` geschrieben; diese Archive enthalten ebenfalls IP-Adressen und haben eine eigene Frist. Die Datenschutzerklärung nennt automatisch die wirksamen Werte.

Achtung, wenn der Mailversand fehlt: Neue Kundenkonten müssen dann manuell unter `/admin/customers` freigeschaltet werden, sonst fallen sie nach `UNVERIFIED_ACCOUNT_RETENTION_DAYS` weg.

## Notfälle

| Symptom | Ursache / Abhilfe |
|---|---|
| Container startet nicht, Log „Ungültige Konfiguration“ | Die Meldung nennt jede fehlende oder unsichere Variable; `.env` korrigieren |
| Log „Datenbank-Schema ist Version X“ | Älteres Image gegen neuere DB, siehe Rollback |
| Login schlägt ohne Fehlermeldung fehl | Aufruf nicht über https bzw. `TRUST_PROXY` falsch; das secure-Cookie wird nicht gesetzt |
| Uploads enden mit 507 | Volume voll bzw. Reserve `MIN_FREE_DISK_MB` unterschritten; Platz schaffen, der Upload lässt sich danach fortsetzen |
| Admin-Passwort vergessen | Zeile löschen und mit `ADMIN_PASSWORD` neu starten: `docker compose exec iso-share node -e "const{DatabaseSync}=require('node:sqlite');new DatabaseSync('/app/data/iso-share.db').exec('DELETE FROM admin_password')"`, danach `ADMIN_PASSWORD` setzen und neu starten (siehe „Bootstrap-once“ in `CLAUDE.md`) |
| Mails bleiben hängen | `/admin/ticket-settings` → Outbox: Fehlermeldung des SMTP-Servers; nach Korrektur „Erneut senden“ |
