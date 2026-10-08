'use strict';

/*
 * @simplewebauthn/server prueft beim Laden einmalig, ob die Node-Laufzeit
 * experimentelle Post-Quantum-Algorithmen (ML-DSA) unterstuetzt — fuer
 * Attestation-Formate, die wir mit attestationType:'none' nie anfragen. Das
 * loest bei jedem Start zwei ExperimentalWarning-Meldungen von Node selbst
 * aus, unabhaengig davon, wie wir die Bibliothek nutzen.
 *
 * Ein process.on('warning', ...)-Listener reicht dafuer NICHT: Node haengt
 * seinen eigenen stderr-Printer schon beim Bootstrap an dasselbe Event, und
 * der laeuft unabhaengig von jedem eigenen Listener weiter. Nur ein
 * Abfangen vor der Event-Emission — also am emitWarning-Aufruf selbst —
 * unterdrueckt die Ausgabe tatsaechlich. Alles andere geht unveraendert an
 * die urspruengliche Funktion durch.
 */
const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = function (warning, typeOrOptions, ...rest) {
    const message = typeof warning === 'string' ? warning : warning?.message;
    const type = typeof typeOrOptions === 'string' ? typeOrOptions : typeOrOptions?.type;
    if (type === 'ExperimentalWarning' && /Web Crypto API|ML-DSA/.test(message ?? '')) {
        return;
    }
    return originalEmitWarning(warning, typeOrOptions, ...rest);
};

const express = require('express');
const multer = require('multer');
const session = require('express-session');
const helmet = require('helmet');
const expressRateLimit = require('express-rate-limit');
const { ipKeyGenerator } = expressRateLimit;
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const {
    safeIsoName, safeUploadId, safeCredentialId, safePasskeyLabel, safeUsername, safeTag,
    safeApiTokenId, safeApiTokenLabel, safeBackupName,
} = require('./lib/safe-name');
const { moveFile } = require('./lib/move-file');
const { openDatabase, maintainDatabase, SCHEMA_VERSION } = require('./lib/db');
const { createShutdown, installProcessHandlers } = require('./lib/lifecycle');
const APP_VERSION = require('./package.json').version;
const { migrateLegacyData } = require('./lib/migrate-legacy');
const { createMetadataStore } = require('./lib/metadata');
const { createHashQueue, sha256OfFile } = require('./lib/hash-queue');
const { createUploadSessions, UploadError } = require('./lib/chunked-upload');
const { SqliteSessionStore } = require('./lib/session-store');
const { createSessionSecretStore } = require('./lib/session-secret-store');
const { createWebauthnStore } = require('./lib/webauthn-store');
const { createPasswordStore } = require('./lib/password-store');
const { createUsernameStore } = require('./lib/username-store');
const { createTotpStore } = require('./lib/totp-store');
const { createApiTokenStore } = require('./lib/api-token-store');
const { createBackupStore } = require('./lib/backup-store');
const { createTicketStore } = require('./lib/ticket-store');
const { createCustomerStore } = require('./lib/customer-store');
const { createTicketConfigStore } = require('./lib/ticket-config-store');
const { createAttachmentStore } = require('./lib/attachment-store');
const { createMailer } = require('./lib/mailer');
const { createMailOutbox } = require('./lib/mail-outbox');
const { createTicketMail } = require('./lib/ticket-mail');
const { createInboundProcessor } = require('./lib/mail-inbound');
const { createImapPoller } = require('./lib/imap-poller');
const { createInboundMailStore } = require('./lib/inbound-mail-store');
const { createTicketAutomation } = require('./lib/ticket-automation');
const { createRetention } = require('./lib/retention');
const { defaultDiskInfo } = require('./lib/chunked-upload');
const { registerAccountRoutes, createCustomerAuth } = require('./lib/routes/account');
const { registerCustomerTicketRoutes } = require('./lib/routes/tickets-customer');
const { registerAdminTicketRoutes } = require('./lib/routes/tickets-admin');
const { registerKbRoutes } = require('./lib/routes/kb');
const { registerReportRoutes } = require('./lib/routes/reports');
const { createKbStore } = require('./lib/kb-store');
const {
    formatMessage, relativeTime, formatDuration, initials, slaState,
} = require('./lib/routes/helpers');
const {
    STATUS_LABELS, CUSTOMER_STATUS_LABELS, PRIORITY_LABELS, SOURCE_LABELS, customerEventText,
} = require('./lib/ticket-store');
const { generateSecret, verifyTotp, buildOtpauthUri } = require('./lib/totp');
const { createAuditLog } = require('./lib/audit-log');
const { createEventStore, diff } = require('./lib/event-store');
const { SEVERITY, moduleForPath } = require('./lib/event-catalog');
const { registerEventLogRoutes } = require('./lib/routes/event-log');
const { assertConfig } = require('./lib/config-check');
const { createClock, DEFAULT_TIME_ZONE } = require('./lib/time');
const { createLogger, requestLogger, childLog } = require('./lib/logger');
const { writeZip, fitsInClassicZip } = require('./lib/zip-stream');
const {
    generateRegistrationOptions, verifyRegistrationResponse,
    generateAuthenticationOptions, verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const DEFAULT_MAX_FILE_SIZE_MB = 8192;
const DEFAULT_MIN_FREE_DISK_MB = 1024;
const DEFAULT_ADMIN_USERNAME = 'admin';
const STALE_UPLOAD_SWEEP_MS = 60 * 60 * 1000;
const MAX_BULK_FILES = 100;
const MAX_TAGS_PER_FILE = 15;
const TICKET_AUTOMATION_INTERVAL_MS = 10 * 60 * 1000;
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;
// Getrennt von der festen 24h-Cookie-Laufzeit (siehe cookie.maxAge unten):
// eine angemeldete, aber laenger unbeobachtete Admin-Session gilt ab hier als
// abgelaufen, unabhaengig davon, wie lange das Cookie selbst noch gueltig
// waere.
const ADMIN_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/* Zahl aus einer Env-Var; leer/nicht gesetzt -> Default. Anders als
   `Number(x) || default` bleibt eine explizite 0 eine 0 (z. B. "aus"). */
function envNumber(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
}

/* ==========================================================================
   App-Aufbau

   Alles laeuft ueber createApp(), damit die Tests eine Instanz mit eigenen
   Verzeichnissen und eigenem Passwort bekommen, ohne den Prozess zu starten.
   Die Umgebungsvariablen sind nur die Defaults dieser Funktion.
   ========================================================================== */

function createApp(options = {}) {
    const {
        uploadsDir = path.join(__dirname, 'uploads'),
        tmpDir = path.join(__dirname, 'tmp-uploads'),
        dataDir = process.env.DATA_DIR
            || path.join(__dirname, 'data'),
        maxFileSizeMb = Number(process.env.MAX_FILE_SIZE_MB)
            || DEFAULT_MAX_FILE_SIZE_MB,
        // Mindestens so viel muss nach allen laufenden Uploads frei bleiben
        // (siehe assertDiskSpace in lib/chunked-upload.js). Tests injizieren
        // zusaetzlich diskInfo, um ein volles Volume zu simulieren.
        minFreeDiskMb = envNumber('MIN_FREE_DISK_MB', DEFAULT_MIN_FREE_DISK_MB),
        diskInfo = undefined,
        // Loeschfristen in Tagen, 0 = aus (siehe lib/retention.js)
        retentionPolicy = {
            auditLogDays: envNumber('AUDIT_LOG_RETENTION_DAYS', 90),
            unverifiedAccountDays: envNumber('UNVERIFIED_ACCOUNT_RETENTION_DAYS', 30),
            closedTicketDays: envNumber('CLOSED_TICKET_RETENTION_DAYS', 0),
        },
        // Gesetzt: /metrics nur mit Authorization: Bearer <token>
        metricsToken = process.env.METRICS_TOKEN || null,
        // Loeschfristen + DB-Pflege; 0 schaltet den Timer ab
        maintenanceIntervalMs = MAINTENANCE_INTERVAL_MS,
        isProd = process.env.NODE_ENV === 'production',
        trustProxy = process.env.TRUST_PROXY,
        // Mailversand (SMTP) und -empfang (IMAP) fuer das Ticketsystem —
        // env-only wie TRUST_PROXY/DATA_DIR, siehe lib/mailer.js und
        // lib/imap-poller.js: Zugangsdaten sind eine Deployment-
        // Entscheidung, kein Laufzeit-Setting wie die Backup-Einstellungen.
        // Ohne SMTP_HOST bzw. IMAP_HOST bleibt die jeweilige Richtung aus.
        smtpHost = process.env.SMTP_HOST,
        // SMTPS (implizites TLS, Port 465) ist der Standard; SMTP_SECURE=false
        // schaltet auf STARTTLS (Port 587) um — erzwungen, nie Klartext.
        smtpSecure = process.env.SMTP_SECURE !== 'false',
        smtpPort = Number(process.env.SMTP_PORT) || (smtpSecure ? 465 : 587),
        smtpUser = process.env.SMTP_USER,
        smtpPass = process.env.SMTP_PASS,
        smtpFrom = process.env.SMTP_FROM || smtpUser,
        // Tests injizieren hier einen Fake-Transport statt echtem SMTP.
        mailTransport = null,
        ticketNotifyEmail = process.env.TICKET_NOTIFY_EMAIL,
        imapHost = process.env.IMAP_HOST,
        // IMAPS (implizites TLS, Port 993) ist der Standard; IMAP_SECURE=false
        // schaltet auf erzwungenes STARTTLS (Port 143) um.
        imapSecure = process.env.IMAP_SECURE !== 'false',
        imapPort = Number(process.env.IMAP_PORT) || (imapSecure ? 993 : 143),
        imapUser = process.env.IMAP_USER,
        imapPass = process.env.IMAP_PASS,
        imapMailbox = process.env.IMAP_MAILBOX || 'INBOX',
        // Verarbeitete Mails in diesen Ordner verschieben (leer = im
        // Postfach lassen), siehe lib/imap-poller.js
        imapProcessedMailbox = process.env.IMAP_PROCESSED_MAILBOX || '',
        imapPollSeconds = Number(process.env.IMAP_POLL_SECONDS) || 60,
        // Adresse, an die Kunden per "Antworten" schreiben — das per IMAP
        // abgerufene Postfach. Default: IMAP_USER, falls das eine Adresse ist.
        supportReplyTo = process.env.SUPPORT_REPLY_TO
            || (/@/.test(String(imapUser ?? '')) ? imapUser : null),
        /*
         * Basis-URL fuer alle Links in Mails (Bestaetigung, Passwort-Reset,
         * Ticket-Links). Bewusst NICHT aus dem Host-Header der Anfrage
         * abgeleitet: sonst koennte ein Angreifer per gefaelschtem Host einen
         * Reset-Link fuer ein fremdes Konto auf seine eigene Domain zeigen
         * lassen (Password-Reset-Poisoning).
         */
        publicUrl = process.env.PUBLIC_URL,
        attachmentMaxMb = Number(process.env.TICKET_ATTACHMENT_MAX_MB) || 10,
        // Summe der Anhaenge, die einer Mail als echte Dateien beiliegen
        // (lib/ticket-mail.js); 0 = nur Namen nennen, nie anhaengen.
        mailAttachmentMaxMb = envNumber('MAIL_ATTACHMENT_MAX_MB', 10),
        // authserv-id des eigenen Mailservers im Authentication-Results-
        // Header (lib/mail-auth.js). Nur damit nimmt der IMAP-Abruf auch
        // neue Tickets per Mail an, nicht nur Antworten.
        imapAuthservId = process.env.IMAP_AUTHSERV_ID || null,
        ticketAutomationIntervalMs = TICKET_AUTOMATION_INTERVAL_MS,
        startMailWorkers = true,
        // Tests uebergeben beides direkt und loesen so keine Warnung aus
        adminPassword: passwordOption,
        adminUsername: usernameOption,
        sessionSecret: secretOption,
        // Der Startscan liest jede Datei in uploads/ einmal durch — im Test
        // unerwuenscht, im Betrieb genau richtig.
        scanOnStart = true,
        sweepStaleUploads = true,
        log = console,
        // Zugriffslog je Request (lib/logger.js); Tests uebergeben ohnehin
        // einen stummen Logger
        requestLog = true,
        // Tests uebergeben hier einen winzigen Wert statt echter 10 Minuten.
        adminIdleTimeoutMs = ADMIN_IDLE_TIMEOUT_MS,
        // Event-Log (lib/event-store.js): eigene SQLite-Datei neben der
        // Haupt-DB; Tests koennen ':memory:' uebergeben
        eventsFile = undefined,
        eventFlushIntervalMs = 250,
        // Anzeige-Zeitzone (lib/time.js); gespeichert wird immer UTC
        timeZone = process.env.APP_TIMEZONE || DEFAULT_TIME_ZONE,
    } = options;

    const UPLOADS_DIR = path.resolve(uploadsDir);
    const TMP_DIR = path.resolve(tmpDir);
    const DATA_DIR = path.resolve(dataDir);
    const MAX_FILE_SIZE_MB = maxFileSizeMb;
    const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
    const IDLE_TIMEOUT_MS = adminIdleTimeoutMs;

    // Im Produktivbetrieb fatal (siehe lib/config-check.js): lieber gar nicht
    // starten als Mails mit localhost-Links verschicken oder nie ein
    // Session-Cookie setzen. Laeuft vor dem Oeffnen der DB, damit ein
    // Abbruch keine offene Datei und keine Timer hinterlaesst.
    const inboundEnabled = Boolean(imapHost && imapUser);
    // Wirft bei unbekannter APP_TIMEZONE (code 'invalid_config')
    const clock = createClock(timeZone);
    assertConfig({
        isProd, publicUrl, mailEnabled: Boolean(smtpHost || mailTransport), inboundEnabled, trustProxy,
        maxFileSizeMb, attachmentMaxMb, mailAttachmentMaxMb, imapAuthservId, metricsToken,
    }, log);

    /*
     * Eine einzige SQLite-Datenbank fuer alles, was frueher als JSON-Dateien
     * unter data/ und uploads/.meta/ lag (siehe lib/db.js). Synchron ge-
     * oeffnet, weil DatabaseSync selbst synchron ist und dies nur einmal
     * beim App-Aufbau passiert, nie in einem Request-Handler.
     */
    const DB_PATH = path.join(DATA_DIR, 'iso-share.db');

    /*
     * Zentrales Event-Log (lib/event-store.js) — vor der Haupt-DB, damit
     * schon deren Abfragen gemessen werden (langsame Abfragen, Fehler) und
     * die Konfig-Warnungen oben (vom Logger gepuffert) hier landen. Die
     * Konsole bekommt ab hier nur noch das Wesentliche, siehe lib/logger.js.
     */
    let currentAdminName = usernameOption ?? process.env.ADMIN_USERNAME ?? DEFAULT_ADMIN_USERNAME;
    const events = createEventStore({
        file: eventsFile ?? path.join(DATA_DIR, 'events.db'),
        flushIntervalMs: eventFlushIntervalMs,
        auditDays: retentionPolicy.auditLogDays,
        archiveDir: path.join(DATA_DIR, 'log-archive'),
        adminName: () => currentAdminName,
    });
    log.attachSink?.(events.fromLog);
    // Nur Konsole, nie Senke: diese Meldungen stehen schon als eigenes
    // Ereignis im Event-Log (Request-Zeilen, unbehandelte Fehler)
    const httpConsole = childLog(log, 'http', { sink: false });

    let db;
    try {
        db = events.instrumentDatabase(openDatabase(DB_PATH));
    } catch (err) {
        log.detachSink?.();
        events.close();
        throw err;
    }

    /* ----------------------------------------------------------- Secrets --
       Bootstrap-Prinzip (siehe auch der Kommentar oben in lib/db.js): der aus
       Env-Var/Option berechnete Wert wird beim allerersten Start persistiert
       und gewinnt danach dauerhaft — eine spaeter geaenderte Env-Var wirkt
       sich nicht mehr aus, dieselbe Regel wie bei einer expliziten Aenderung
       ueber die Admin-UI. Ein Geheimnis, das dauerhaft in einer Env-Var
       steht, ist im Produktivbetrieb die schlechtere Aufbewahrung als die DB. */

    let ADMIN_PASSWORD = passwordOption ?? process.env.ADMIN_PASSWORD;
    const PASSWORD_HASH = ADMIN_PASSWORD
        ? crypto.createHash('sha256').update(ADMIN_PASSWORD).digest()
        : null;

    /*
     * Der Session-Signierschluessel wird SYNCHRON persistiert, weil er noch
     * vor app.use(session(...)) unten feststehen muss — also vor dem
     * asynchronen start(). Erster Start: der aus SESSION_SECRET/Option
     * berechnete oder frisch generierte Wert wird sofort in die DB
     * geschrieben. Jeder weitere Start liest denselben Wert zurueck, egal was
     * SESSION_SECRET inzwischen sagt — ohne das wuerde ein Neustart ohne
     * gesetzte Env-Var alle Sitzungen ungueltig machen.
     */
    const sessionSecretStore = createSessionSecretStore({ db });
    let SESSION_SECRET = sessionSecretStore.read();
    if (!SESSION_SECRET) {
        const candidate = secretOption ?? process.env.SESSION_SECRET
            ?? crypto.randomBytes(32).toString('hex');
        if (!secretOption && !process.env.SESSION_SECRET) {
            log.warn(
                '⚠️  Kein SESSION_SECRET gesetzt — es wird jetzt einmalig ein zufälliges\n' +
                '    erzeugt und dauerhaft in der Datenbank gespeichert.\n'
            );
        }
        SESSION_SECRET = sessionSecretStore.ensure(candidate);
    }

    const passwordStore = createPasswordStore({ db });
    const usernameStore = createUsernameStore({ db });

    /*
     * ADMIN_USERNAME bleibt der Default/die Env-Var, bis start() (siehe
     * unten) den ersten Wert in die DB schreibt oder /admin-username ihn
     * explizit aendert — danach gewinnt in beiden Faellen die DB.
     */
    const ADMIN_USERNAME = usernameOption ?? process.env.ADMIN_USERNAME ?? DEFAULT_ADMIN_USERNAME;

    /*
     * Ein einmal ueber /admin-password gesetztes (oder beim ersten Start
     * automatisch bootstrappedes, siehe start()) Passwort gewinnt dauerhaft
     * gegenueber ADMIN_PASSWORD, auch nach einem Neustart. Ohne persistierten
     * Hash bleibt der Weg ueber PASSWORD_HASH bestehen — der greift aber nur,
     * wenn ADMIN_PASSWORD tatsaechlich vom Betreiber gesetzt wurde; ist beides
     * leer (start() ist noch nicht gelaufen, oder dessen Schreibversuch ist
     * fehlgeschlagen), wird sicherheitshalber jeder Login abgelehnt statt
     * gegen nichts zu vergleichen.
     */
    async function passwordMatches(candidate) {
        const record = await passwordStore.read();
        if (record) return passwordStore.verify(candidate, record);
        if (!PASSWORD_HASH) return false;
        const candidateHash = crypto
            .createHash('sha256')
            .update(String(candidate ?? ''))
            .digest();
        return crypto.timingSafeEqual(candidateHash, PASSWORD_HASH);
    }

    /* --------------------------------------------------------- Dienste -- */

    const metadata = createMetadataStore({ db });
    const hashQueue = createHashQueue({
        uploadsDir: UPLOADS_DIR, metadata, log: childLog(log, 'files'), maxAutoTags: MAX_TAGS_PER_FILE,
    });
    const uploadSessions = createUploadSessions({
        db,
        tmpDir: TMP_DIR,
        uploadsDir: UPLOADS_DIR,
        maxBytes: MAX_FILE_SIZE_BYTES,
        minFreeBytes: minFreeDiskMb * 1024 * 1024,
        ...(diskInfo ? { diskInfo } : {}),
    });
    const sessionStore = new SqliteSessionStore({ db });
    const webauthnStore = createWebauthnStore({ db });
    const totpStore = createTotpStore({ db });
    const auditLog = createAuditLog({ events });
    const apiTokenStore = createApiTokenStore({ db });
    const BACKUP_DIR = path.join(DATA_DIR, 'backups');
    const backupStore = createBackupStore({ db, backupDir: BACKUP_DIR, log: childLog(log, 'backup') });

    /* ------------------------------------------------ Ticketsystem --
       Kundenkonten, Tickets, Anhaenge und Mail (Outbox + IMAP-Eingang),
       siehe die jeweiligen Module in lib/ und die Routen in lib/routes/. */
    const PUBLIC_URL = String(publicUrl || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
    const customerStore = createCustomerStore({ db });
    const ticketStore = createTicketStore({ db });
    const configStore = createTicketConfigStore({ db });
    configStore.seedDefaults();
    const kbStore = createKbStore({ db });
    const attachmentStore = createAttachmentStore({
        db, dir: path.join(DATA_DIR, 'ticket-attachments'), maxBytes: attachmentMaxMb * 1024 * 1024,
        // Dieselbe Reserve wie fuer ISO-Uploads: ein von Anhaengen volles
        // Volume legte sonst auch SQLite lahm (lib/attachment-store.js)
        minFreeBytes: minFreeDiskMb * 1024 * 1024, tmpDir: TMP_DIR,
        ...(diskInfo ? { diskInfo } : {}),
    });
    const mailLog = childLog(log, 'mail');
    const mailer = createMailer({
        host: smtpHost, port: smtpPort, secure: smtpSecure, user: smtpUser, pass: smtpPass,
        from: smtpFrom, transport: mailTransport, log: mailLog,
    });
    // Abstand zwischen zwei Mails (siehe lib/mail-outbox.js) — nicht mit
    // injiziertem Test-Transport, sonst warten die Tests nur.
    /* Anhang-IDs aus der Outbox (lib/mail-outbox.js) in nodemailer-Anhaenge
       aufloesen — erst beim Versand, nie in der DB gespeichert. Fehlende
       (inzwischen geloeschte) Dateien werden ausgelassen. */
    async function resolveMailAttachments(ids) {
        const result = [];
        for (const id of ids) {
            const attachment = attachmentStore.getAttachment(id);
            if (!attachment) continue;
            const file = attachmentStore.filePath(attachment.id);
            try {
                await fsp.access(file);
            } catch {
                continue;
            }
            result.push({ filename: attachment.filename, path: file, contentType: attachment.mime });
        }
        return result;
    }
    const outbox = createMailOutbox({
        db, mailer, log: mailLog, auditLog, sendIntervalMs: mailTransport ? 0 : 2000, formatTime: clock.formatTimeShort,
        resolveAttachments: resolveMailAttachments,
    });
    const ticketMail = createTicketMail({
        outbox, customerStore, publicUrl: PUBLIC_URL, notifyEmail: ticketNotifyEmail || null,
        replyTo: supportReplyTo, threadSecret: `mail-thread:${SESSION_SECRET}`, domain: mailer.domain,
        inboundEnabled, attachmentMaxBytes: mailAttachmentMaxMb * 1024 * 1024, formatDateTime: clock.formatDateTime,
    });
    // Neue Tickets per Mail nur mit bekannter authserv-id (siehe oben)
    const inboundNewTickets = inboundEnabled && Boolean(imapAuthservId);
    const inboundStore = createInboundMailStore({ db });
    const inboundProcessor = createInboundProcessor({
        ticketStore, customerStore, attachmentStore, ticketMail, auditLog, log: mailLog, inboundStore,
        authservId: inboundNewTickets ? imapAuthservId : null,
    });
    const imapPoller = createImapPoller({
        host: imapHost, port: imapPort, secure: imapSecure, user: imapUser, pass: imapPass,
        mailbox: imapMailbox, intervalMs: imapPollSeconds * 1000, processor: inboundProcessor,
        maxAttachmentBytes: attachmentStore.maxBytes, maxAttachmentFiles: attachmentStore.maxFiles,
        processedMailbox: imapProcessedMailbox, stateStore: inboundStore, log: mailLog,
    });
    const ticketAutomation = createTicketAutomation({
        ticketStore, configStore, ticketMail, auditLog, log: childLog(log, 'tickets'),
    });
    const retention = createRetention({
        db, ticketStore, attachmentStore, customerStore, sessionStore, outbox, auditLog, log: childLog(log, 'jobs'),
        policy: retentionPolicy,
    });

    const app = express();

    /* ------------------------------------------- Sicherheits-Middleware -- */

    app.disable('x-powered-by');

    // Zuerst, damit auch von spaeteren Middlewares abgelehnte Requests
    // (CSRF, Rate-Limit) im Log stehen und eine Request-ID haben
    if (requestLog) app.use(requestLogger(httpConsole, { onFinish: events.recordRequest }));
    // Request-Kontext fuer das Event-Log (Akteur, IP, User-Agent, Session-
    // Hash), ohne ihn durch jede Funktion reichen zu muessen
    app.use(events.middleware());

    // Hinter einem Reverse Proxy (TLS-Terminierung) korrekt Secure-Cookies
    // setzen. Eine reine Zahl muss als Number uebergeben werden (Anzahl Hops)
    // — als String interpretiert Express sie sonst als Adressliste, und
    // req.secure bliebe false.
    if (trustProxy) {
        app.set(
            'trust proxy',
            /^\d+$/.test(String(trustProxy)) ? Number(trustProxy) : trustProxy
        );
    }

    // Security-Header inkl. CSP. Alles wird selbst gehostet, daher 'self';
    // data: nur fuer das Grain-SVG und das Favicon; keine Inline-Skripte.
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'"],
                styleSrc: ["'self'"],
                imgSrc: ["'self'", 'data:'],
                fontSrc: ["'self'"],
                connectSrc: ["'self'"],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
                formAction: ["'self'"],
                frameAncestors: ["'none'"],
                upgradeInsecureRequests: isProd ? [] : null,
            },
        },
        hsts: isProd,
        crossOriginResourcePolicy: { policy: 'same-origin' },
        // same-origin: eigene Requests behalten den Referer (dient dem
        // CSRF-Check als Fallback), zu fremden Seiten wird nichts geleakt.
        referrerPolicy: { policy: 'same-origin' },
    }));

    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, 'views'));
    // In jedem render() verfuegbar, ohne dass jede Route sie einzeln
    // durchreichen muss — public/js/idle-timer.js liest sie ueber
    // partials/navbar.ejs aus dem Abmelden-Link.
    app.locals.adminIdleTimeoutMs = IDLE_TIMEOUT_MS;
    // Fuer die Datenschutzerklaerung — zeigt die tatsaechlich wirksamen Fristen
    app.locals.retentionPolicy = retention.policy;
    // Fristen des Event-Logs (zur Laufzeit unter /admin/logs/settings
    // aenderbar, darum eine Funktion statt eines festen Werts)
    app.locals.eventRetention = function eventRetention() {
        const settings = events.readSettings();
        // DEBUG zaehlt nur, wenn es ueberhaupt gespeichert wird
        const days = [
            ...(settings.storeDebug ? [settings.debugDays] : []),
            settings.infoDays, settings.warningDays, settings.errorDays, settings.criticalDays,
        ];
        const active = days.filter(value => value > 0);
        return {
            min: active.length > 0 ? Math.min(...active) : null,
            // null: mindestens eine Stufe ist unbefristet (0 = nie loeschen)
            max: active.length === days.length ? Math.max(...active) : null,
            info: settings.infoDays,
            archiveDays: settings.archiveEnabled && settings.archiveDays > 0 ? settings.archiveDays : null,
        };
    };

    // Nur public/ statisch ausliefern. uploads/ wird bewusst NICHT eingebunden
    // — Downloads laufen ausschliesslich ueber die /download-Route mit
    // Namenspruefung, damit keine hochgeladene Nicht-ISO als HTML rausgeht.
    app.use(express.static(path.join(__dirname, 'public'), {
        maxAge: '1h',
        dotfiles: 'ignore',
    }));

    // Cache-Busting fuer die eigenen Skripte/Stylesheets: Views binden sie
    // ueber asset('/js/x.js') ein, das haengt ?v=<Inhalts-Hash> an. Aendert
    // sich eine Datei, aendert sich die URL, und kein Browser benutzt
    // innerhalb der 1h-Cache-Zeit oben noch die alte Fassung (neues HTML mit
    // altem JS war z. B. der Grund, warum das Absenden per fetch nach einem
    // Update erst nach einer Stunde griff). Einmal beim Start berechnet —
    // synchron, aber ausserhalb jedes Request-Handlers, wie DatabaseSync.
    const assetVersions = new Map();
    for (const dir of ['js', 'css']) {
        const abs = path.join(__dirname, 'public', dir);
        for (const file of fs.readdirSync(abs)) {
            const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(abs, file))).digest('hex');
            assetVersions.set(`/${dir}/${file}`, hash.slice(0, 10));
        }
    }
    app.locals.asset = function asset(url) {
        const version = assetVersions.get(url);
        return version ? `${url}?v=${version}` : url;
    };

    // Bewusst kleine Body-Limits — hier fliesst nur ein Passwort, ein
    // Dateiname oder der kleine JSON-Kopf eines Uploads. Die Chunks selbst
    // kommen als application/octet-stream und werden gestreamt, nicht
    // gepuffert; kein Body-Parser fasst sie an.
    app.use(express.urlencoded({ extended: false, limit: '16kb' }));
    app.use(express.json({ limit: '16kb' }));

    app.use(session({
        name: 'iso.sid',
        secret: SESSION_SECRET,
        store: sessionStore,
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            // sameSite:'strict' blockiert das Mitsenden bei Cross-Site-
            // Requests und ist damit die primaere CSRF-Abwehr.
            sameSite: 'strict',
            // Secure sobald prod oder hinter Proxy — sonst waere lokal ohne
            // TLS gar kein Login moeglich.
            secure: isProd || Boolean(trustProxy),
            maxAge: 1000 * 60 * 60 * 24,
        },
    }));

    /*
     * CSRF-Abwehr als ZWEITE Verteidigungslinie zusaetzlich zu
     * SameSite=strict. Primaerschutz ist das Cookie: ein Cross-Site-POST
     * traegt das Sitzungs-Cookie gar nicht erst, checkAuth schlaegt dann fehl.
     *
     * Dieser Check verwirft zusaetzlich Anfragen, deren Origin/Referer
     * nachweislich von fremdem Host stammt. Er darf aber legitime Logins nicht
     * aussperren: Browser senden in mehreren harmlosen Faellen `Origin: null`
     * oder gar keinen Origin. Solche nicht-auswertbaren Faelle werden
     * durchgelassen (SameSite schuetzt weiterhin) — abgelehnt wird nur ein
     * eindeutig fremder Host.
     */
    function hostOf(value) {
        if (!value || value === 'null') return null;
        try {
            return new URL(value).host;
        } catch {
            return null;
        }
    }

    function sameOrigin(req, res, next) {
        const sourceHost = hostOf(req.get('origin')) ?? hostOf(req.get('referer'));
        // Kein auswertbarer Origin/Referer -> nicht blockieren, SameSite greift
        if (sourceHost === null) {
            return next();
        }
        if (sourceHost !== req.get('host')) {
            auditLog.log('csrf_rejected', { ip: req.ip, sourceHost, method: req.method });
            return res.status(403).send('Cross-Origin-Anfrage abgelehnt.');
        }
        next();
    }

    app.use((req, res, next) => {
        // /api/v1 ist Token-authentifiziert (Authorization: Bearer ...), nicht
        // Cookie-authentifiziert — die Session traegt dort gar keine
        // Berechtigung (checkApiToken sieht req.session nie an). Ein
        // CSRF-Request mit dem Opfer-Cookie im Gepaeck kommt darum ohnehin nie
        // durch, der sameOrigin-Check waere hier nur ein falsch-positiver
        // Blocker fuer legitime Skript-/CI-Clients ohne passenden Origin/
        // Referer-Header.
        if (req.path.startsWith('/api/v1/')) {
            return next();
        }
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
            return sameOrigin(req, res, next);
        }
        next();
    });

    /* Kunden-Session (Ticketsystem) fuer jede Anfrage aufloesen — siehe
       createCustomerAuth() in lib/routes/account.js. */
    const customerAuth = createCustomerAuth({ customerStore, ticketStore });
    app.use(customerAuth.loadCustomer);

    /*
     * WebAuthn braucht pro Anfrage eine Relying-Party-ID (der Hostname ohne
     * Port) und die exakte Origin, gegen die Attestation/Assertion geprueft
     * werden. Statt einer eigenen Env-Var wird das aus denselben Angaben
     * abgeleitet, die schon sameOrigin() fuer den CSRF-Check nutzt — und
     * respektiert damit automatisch 'trust proxy' wie der secure-Flag des
     * Session-Cookies. Bekannte Einschraenkung: ein Passkey ist an den
     * Hostnamen gebunden, unter dem er registriert wurde; Zugriff ueber
     * einen zweiten Hostnamen (z. B. IP statt DNS-Name) braucht einen
     * eigenen Passkey.
     */
    function rpIdAndOrigin(req) {
        const host = req.get('host');
        return { rpID: host.split(':')[0], expectedOrigin: `${req.protocol}://${host}` };
    }

    /* ------------------------------------------------------ Rate-Limits -- */

    // Login gedrosselt gegen Brute-Force, in zwei Ebenen: ein per Reverse
    // Proxy fehlkonfiguriertes `trust proxy` leitet die IP aus
    // X-Forwarded-For ab, und ein Angreifer koennte die pro-IP-Sperre sonst
    // durch gefaelschte Header umgehen.
    //   1. pro IP (feinkoernig, zaehlt nur Fehlversuche)
    //   2. global als Backstop, das auch bei IP-Spoofing greift
    const TOO_MANY = 'Zu viele Anmeldeversuche. Bitte später erneut versuchen.';

    /*
     * express-rate-limit mit Protokollierung: die erste abgewiesene Anfrage
     * eines Fensters wird ein Sicherheitsereignis (ip_blocked bzw. bei den
     * globalen Backstops rate_limit_global) — jede weitere nicht, sonst
     * schriebe ein Angreifer mit jedem Versuch eine Zeile ins Log.
     */
    function rateLimit({ name, auditEvent, ...limiterOptions }) {
        const blockedEvent = auditEvent || (limiterOptions.keyGenerator ? 'rate_limit_global' : 'ip_blocked');
        return expressRateLimit({
            ...limiterOptions,
            handler(req, res, next, used) {
                const info = req.rateLimit;
                if (info && info.used === info.limit + 1) {
                    auditLog.log(blockedEvent, {
                        ip: req.ip, limiter: name, limit: info.limit, windowMs: used.windowMs,
                        resetAt: info.resetTime ? info.resetTime.getTime() : null,
                    });
                }
                res.status(used.statusCode).send(used.message);
            },
        });
    }

    const loginLimiterPerIp = rateLimit({
        name: 'login',
        windowMs: 15 * 60 * 1000,
        max: 10,
        standardHeaders: true,
        legacyHeaders: false,
        skipSuccessfulRequests: true,   // nur fehlgeschlagene Logins zaehlen
        message: TOO_MANY,
    });

    // Ein Bucket fuer alle: begrenzt die Gesamtzahl fehlgeschlagener Logins
    // und kann durch keinen gefaelschten Header umgangen werden. Bewusst
    // grosszuegig, damit normaler Betrieb nicht blockiert wird (Kehrseite:
    // theoretisch als Login-DoS missbrauchbar — fuer eine Single-Admin-
    // Instanz akzeptabel).
    const loginLimiterGlobal = rateLimit({
        name: 'login_global',
        windowMs: 15 * 60 * 1000,
        max: 100,
        standardHeaders: false,
        legacyHeaders: false,
        skipSuccessfulRequests: true,
        keyGenerator: () => 'global',
        message: TOO_MANY,
    });

    // /download ist die teuerste Route der App und die einzige
    // unauthentifizierte, die echtes I/O ausloest. Das Limit ist so gesetzt,
    // dass ein Download-Manager mit mehreren parallelen Range-Verbindungen
    // nicht dagegenlaeuft.
    const downloadLimiter = rateLimit({
        name: 'download',
        windowMs: 60 * 1000,
        max: 60,
        standardHeaders: true,
        legacyHeaders: false,
        message: 'Zu viele Download-Anfragen. Bitte kurz warten.',
    });

    // Genereller Schutz gegen ausser Kontrolle geratene Skripte auf der
    // gesamten /api/v1-Flaeche (Lesen wie Schreiben) — die HTML-Seiten haben
    // kein Aequivalent, weil dort ein Browser, kein Loop-Skript, anfragt.
    const apiLimiter = rateLimit({
        name: 'api',
        windowMs: 60 * 1000,
        max: 300,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Zu viele Anfragen. Bitte kurz warten.', code: 'rate_limited' },
    });

    // Gleiches Zwei-Ebenen-Prinzip wie beim Login (siehe oben), angewandt auf
    // fehlgeschlagene Token-Pruefungen. Defense-in-depth: ein 256-Bit-Token
    // ist ohnehin nicht brute-forcebar, aber die Instanzen kosten nichts und
    // halten das Muster konsistent mit /login.
    const API_TOO_MANY = { error: 'Zu viele fehlgeschlagene Anfragen.', code: 'rate_limited' };

    const apiAuthLimiterPerIp = rateLimit({
        name: 'api_auth',
        windowMs: 15 * 60 * 1000,
        max: 30,
        standardHeaders: true,
        legacyHeaders: false,
        skipSuccessfulRequests: true,
        message: API_TOO_MANY,
    });

    const apiAuthLimiterGlobal = rateLimit({
        name: 'api_auth_global',
        windowMs: 15 * 60 * 1000,
        max: 300,
        standardHeaders: false,
        legacyHeaders: false,
        skipSuccessfulRequests: true,
        keyGenerator: () => 'global',
        message: API_TOO_MANY,
    });

    // Heartbeat-Fragmente (siehe /partials/listing, /admin/partials/listing
    // weiter unten), Ticket-Verlauf/Posteingangs-Puls (ticket-live.js), der
    // Navigationszaehler (/partials/nav) und das Event-Log werden automatisch
    // alle 15-30 s abgefragt — ein Tab erzeugt so 3-7 Requests/Minute.
    // Angemeldete (Admin oder Kunde) bekommen einen Bucket pro Sitzung statt
    // pro IP: sonst teilen sich Admin und Kunden hinter derselben NAT-Adresse
    // (Buero, lokaler Test) ein Kontingent, und bei ein paar offenen Tabs
    // blieben die Live-Updates mit 429 stumm stehen. Anonyme Clients haben
    // keine dauerhafte Sitzung und bleiben bei der IP.
    const pollLimiter = rateLimit({
        name: 'poll',
        auditEvent: 'ip_blocked',
        keyGenerator: req => (req.session && (req.session.loggedIn || req.session.customerId)
            ? `session:${req.sessionID}`
            : ipKeyGenerator(req.ip)),
        windowMs: 60 * 1000,
        max: 60,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Zu viele Anfragen. Bitte kurz warten.', code: 'rate_limited' },
    });

    /*
     * Ticketsystem: Registrierung, "Passwort vergessen" und Co. legen Zeilen
     * an bzw. verschicken Mails — gedrosselt gegen Spam/Mailbomben nach dem
     * Zwei-Ebenen-Prinzip des Admin-Logins (pro IP + globaler Backstop).
     * Der Kunden-Login bekommt eigene Instanzen mit denselben Werten wie der
     * Admin-Login: sonst koennte ein Angreifer mit fehlgeschlagenen
     * Kunden-Logins den globalen Admin-Login-Bucket leerlaufen lassen.
     */
    const ACCOUNT_TOO_MANY = 'Zu viele Anfragen. Bitte später erneut versuchen.';

    function twoTierLimiter({ name, windowMs, perIp, global, skipSuccessfulRequests = false, message }) {
        const common = { windowMs, legacyHeaders: false, skipSuccessfulRequests, message };
        return {
            perIp: rateLimit({ ...common, name, max: perIp, standardHeaders: true }),
            global: rateLimit({
                ...common, name: `${name}_global`, max: global, standardHeaders: false, keyGenerator: () => 'global',
            }),
        };
    }

    const accountLimiters = twoTierLimiter({
        name: 'account', windowMs: 60 * 60 * 1000, perIp: 10, global: 200, message: ACCOUNT_TOO_MANY,
    });
    const customerLoginLimiters = twoTierLimiter({
        name: 'customer_login', windowMs: 15 * 60 * 1000, perIp: 10, global: 100, skipSuccessfulRequests: true,
        message: TOO_MANY,
    });
    // Neue Tickets/Antworten: grosszuegig fuer echte Nutzung, aber genug,
    // um ein Skript mit gestohlener Kunden-Session auszubremsen. Die
    // eigentliche Bremse ist der Limiter je Konto — der globale ist nur
    // Notbremse und so hoch, dass ein einzelnes Konto mit vielen IPs ihn
    // nicht fuer alle anderen Kunden leerlaufen lassen kann.
    const ticketWriteLimiters = twoTierLimiter({
        name: 'ticket_write', windowMs: 60 * 60 * 1000, perIp: 60, global: 5000, message: ACCOUNT_TOO_MANY,
    });
    const ticketWritePerCustomer = rateLimit({
        name: 'ticket_write_customer', auditEvent: 'rate_limit_customer', windowMs: 60 * 60 * 1000, max: 30,
        legacyHeaders: false,
        standardHeaders: true, message: ACCOUNT_TOO_MANY,
        // Nur hinter checkCustomer eingehaengt — customerId ist dann gesetzt
        keyGenerator: req => `customer:${req.session?.customerId ?? 'none'}`,
    });

    /* ----------------------------------------------- Multipart-Fallback --
       Der eigentliche Upload laeuft fortsetzbar ueber /upload/init +
       PATCH (siehe lib/chunked-upload.js). Dieses Formular bleibt fuer
       Browser ohne JavaScript. */

    const upload = multer({
        dest: TMP_DIR,
        limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 },
    });

    /* ---------------------------------------------------- View-Helfer -- */

    app.locals.formatSize = function formatSize(bytes) {
        if (!bytes) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        const exponent = Math.min(
            Math.floor(Math.log(bytes) / Math.log(1024)),
            units.length - 1
        );
        const value = bytes / 1024 ** exponent;
        return `${value.toFixed(value < 10 && exponent > 0 ? 1 : 0)} ${units[exponent]}`;
    };

    // Datum/Uhrzeit immer in der Anzeige-Zeitzone (lib/time.js), nie in der
    // des Servers — im Container waere das UTC. appTimeZone landet ueber
    // head.ejs als <meta name="app-time-zone"> auch bei den Browser-Skripten.
    Object.assign(app.locals, {
        formatDate: clock.formatDate,
        formatDateTime: clock.formatDateTime,
        formatTime: clock.formatTime,
        formatStamp: clock.formatStamp,
        zoneName: clock.zoneName,
        appTimeZone: clock.timeZone,
    });

    // Ticketsystem: relative Zeitangaben, sicher gerenderter Nachrichtentext
    // (siehe formatMessage() in lib/routes/helpers.js) und die deutschen Labels.
    Object.assign(app.locals, {
        relativeTime, formatDuration, formatMessage, initials, slaState,
        statusLabels: STATUS_LABELS, customerStatusLabels: CUSTOMER_STATUS_LABELS, priorityLabels: PRIORITY_LABELS,
        sourceLabels: SOURCE_LABELS, customerEventText,
        // Admin-Dateiliste: offene Tickets je Datei (views/partials/file-row.ejs)
        openTicketsForFile: name => ticketStore.countActiveForIsoFile(name),
    });

    /* --------------------------------------------------- Dateiauflistung --
       Asynchron, damit die Datei-I/O den Event-Loop nicht blockiert
       (verhindert eine DoS-Flaeche auf den unauthentifizierten Routen / und
       /search bei vielen Dateien). stat() und Metadaten laufen parallel. */

    async function describe(name) {
        const stats = await fsp.stat(path.join(UPLOADS_DIR, name));
        const meta = await metadata.read(name);
        // Checksumme und Volume-Infos gelten nur, solange Groesse und mtime
        // zu dem passen, was beim Hashen galt — sonst wuerde nach einem
        // Ueberschreiben der alte Hash zur neuen Datei angezeigt.
        const current = metadata.hasCurrentChecksum(meta, stats);

        return {
            name,
            size: stats.size,
            mtime: stats.mtimeMs,
            downloads: meta?.downloads ?? 0,
            sha256: current ? meta.sha256 : null,
            iso: current ? (meta.iso ?? null) : null,
            tags: meta?.tags ?? [],
            // 'done' | 'hashing' | 'queued' | 'pending'
            hashStatus: current ? 'done' : (hashQueue.statusOf(name) ?? 'pending'),
        };
    }

    async function describeAll() {
        await fsp.mkdir(UPLOADS_DIR, { recursive: true });
        const names = (await fsp.readdir(UPLOADS_DIR))
            .filter(name => name.toLowerCase().endsWith('.iso'));
        // Zwischen readdir() und stat() geloeschte Dateien (paralleles
        // /delete, rsync) einfach auslassen, statt die ganze Liste mit 500
        // scheitern zu lassen
        const files = await Promise.all(names.map(name => describe(name).catch(err => {
            if (err.code === 'ENOENT') return null;
            throw err;
        })));
        return files.filter(Boolean);
    }

    // Welche iso9660-Felder eine Volltextsuche zusaetzlich zu Name/Tags
    // durchsucht — dieselbe Liste treibt sowohl den Server-Filter unten als
    // auch die data-*-Attribute in file-row.ejs (fuer den clientseitigen
    // Schnellfilter in filetable.js), damit beide Seiten dieselben Treffer
    // liefern.
    const ISO_SEARCH_FIELDS = ['volumeId', 'systemId', 'publisher', 'preparer', 'application', 'volumeSetId'];

    function isoSearchText(iso) {
        if (!iso) return '';
        return ISO_SEARCH_FIELDS.map(field => iso[field] ?? '').join(' ');
    }

    async function listFiles(query = '') {
        // Tags stecken im Sidecar und sind erst nach describe() bekannt,
        // darum laeuft der Suchfilter hier statt schon auf den readdir()-
        // Namen wie frueher — kostet bei einer Suche ein paar zusaetzlich
        // gelesene Sidecars, fuer die Dateizahl einer Single-Admin-Instanz
        // unproblematisch.
        const files = await describeAll();
        const needle = query.toLowerCase();
        const matched = needle
            ? files.filter(file =>
                file.name.toLowerCase().includes(needle) ||
                file.tags.some(tag => tag.toLowerCase().includes(needle)) ||
                isoSearchText(file.iso).toLowerCase().includes(needle))
            : files;

        return matched.sort((a, b) => a.name.localeCompare(b.name, 'de'));
    }


    /* Alle vorkommenden Tags ueber alle Dateien hinweg, fuer die Tag-
       Filterleiste in index.ejs/admin.ejs — bewusst unabhaengig von einer
       aktiven Suche, damit auch Tags aus herausgefilterten Dateien
       anwaehlbar bleiben und man per Klick wieder auf sie filtern kann. */
    async function listAllTags() {
        const files = await describeAll();
        const seen = new Map();
        for (const file of files) {
            for (const tag of file.tags) {
                const key = tag.toLowerCase();
                if (!seen.has(key)) seen.set(key, tag);
            }
        }
        return [...seen.values()].sort((a, b) => a.localeCompare(b, 'de'));
    }

    /* --------------------------------------------------- API-v1-Helfer --
       Paginierung/Sortierung nur fuer /api/v1/files — die HTML-Seiten zeigen
       ohnehin die komplette Liste (Single-Admin-Datenmenge), ein Skript, das
       gegen die API laeuft, will dagegen typischerweise nicht 500 Zeilen JSON
       auf einmal. */

    const API_SORTERS = {
        name: (a, b) => a.name.localeCompare(b.name, 'de'),
        '-name': (a, b) => b.name.localeCompare(a.name, 'de'),
        downloads: (a, b) => a.downloads - b.downloads,
        '-downloads': (a, b) => b.downloads - a.downloads,
        size: (a, b) => a.size - b.size,
        '-size': (a, b) => b.size - a.size,
    };

    function parsePageParams(query) {
        const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
        const perPage = Math.min(200, Math.max(1, Number.parseInt(query.perPage, 10) || 50));
        return { page, perPage };
    }

    function paginate(items, { page, perPage }) {
        const total = items.length;
        const totalPages = Math.max(1, Math.ceil(total / perPage));
        const clampedPage = Math.min(page, totalPages);
        const start = (clampedPage - 1) * perPage;
        return {
            data: items.slice(start, start + perPage),
            meta: { page: clampedPage, perPage, total, totalPages },
        };
    }

    function checkAuth(req, res, next) {
        if (req.session && req.session.loggedIn) {
            // Idle-Timeout: getrennt von der 24h-Cookie-Laufzeit (siehe
            // session()-Konfiguration oben) und nur fuer bereits
            // eingeloggte Sessions relevant. lastActivity fehlt nur bei
            // einer Session aus der Zeit vor diesem Feature — dann zaehlt
            // der erste Zugriff danach als Start des Idle-Fensters, statt
            // sofort abzulaufen.
            const now = Date.now();
            const lastActivity = req.session.lastActivity ?? now;
            if (now - lastActivity > IDLE_TIMEOUT_MS) {
                auditLog.log('session_idle_timeout', { ip: req.ip });
                return req.session.destroy(() => {
                    res.clearCookie('iso.sid');
                    if (req.accepts(['html', 'json']) === 'json') {
                        return res.status(401).json({ error: 'Sitzung wegen Inaktivität abgelaufen.' });
                    }
                    res.redirect('/login?idle=1');
                });
            }
            // heartbeat.js fragt admin/partials/listing automatisch alle 20s
            // ab, solange die Seite offen und sichtbar ist — auch wenn der
            // Admin laengst nicht mehr da ist. Zaehlte das als Aktivitaet,
            // wuerde ein einfach offen gelassener Tab den Idle-Timeout
            // komplett aushebeln. Nur idle-timer.js' Keepalive-Ping
            // (/admin/ping, ausgeloest durch echte Maus-/Tastatureingaben)
            // und normale Navigations-/Formular-Requests verlaengern die
            // Sitzung wirklich.
            if (req.get('X-Idle-Background') !== '1') {
                req.session.lastActivity = now;
            }
            return next();
        }
        if (req.accepts(['html', 'json']) === 'json') {
            return res.status(401).json({ error: 'Nicht angemeldet.' });
        }
        // Erster Faktor schon bestanden, zweiter noch offen: dorthin statt
        // zurueck zu /login, sonst muesste das Passwort ein zweites Mal rein.
        if (req.session && req.session.pendingTotp) {
            return res.redirect('/login/totp');
        }
        res.redirect('/login');
    }

    /*
     * Token-Authentifizierung fuer /api/v1 (Skripte, CI) — vollstaendig
     * getrennt von checkAuth/der Session, siehe Design-Kommentar bei der
     * sameOrigin-Ausnahme oben. Ein Token kann nur erzeugen, wer schon eine
     * gueltige Session hat (POST /admin/api-tokens, checkAuth-gated) — es
     * gibt keinen API-Weg, sich selbst ein erstes Token auszustellen, genau
     * wie bei Passkeys. Antwortet immer JSON, nie ein Redirect: anders als
     * checkAuth gibt es hier kein Login-Formular, zu dem man zurueck koennte.
     * Gibt ein Array zurueck (Rate-Limiter + eigentliche Pruefung), Express
     * flacht das als Middleware-Liste automatisch ab.
     */
    function checkApiToken(requiredScope) {
        return [
            apiAuthLimiterGlobal,
            apiAuthLimiterPerIp,
            async (req, res, next) => {
                const match = /^Bearer\s+(\S+)$/.exec(req.get('authorization') || '');
                if (!match) {
                    auditLog.log('api_auth_failed', { ip: req.ip, code: 'missing_token' });
                    return res.status(401).json({ error: 'Kein Token angegeben.', code: 'missing_token' });
                }
                const record = await apiTokenStore.findByToken(match[1]);
                if (!record) {
                    auditLog.log('api_auth_failed', { ip: req.ip, code: 'invalid_token' });
                    return res.status(401).json({ error: 'Ungültiges Token.', code: 'invalid_token' });
                }
                if (requiredScope && !record.scopes.includes(requiredScope)) {
                    auditLog.log('api_auth_failed', {
                        ip: req.ip, code: 'insufficient_scope', tokenId: record.id, requiredScope,
                    });
                    return res.status(403).json({
                        error: 'Token hat nicht die nötige Berechtigung.', code: 'insufficient_scope',
                    });
                }
                req.apiToken = record;
                next();
            },
        ];
    }

    /*
     * Rendert ein View-Partial zu einem HTML-String statt es direkt zu
     * senden — Grundlage der Heartbeat-Fragment-Routen weiter unten
     * (/partials/listing, /admin/partials/listing). So bleibt
     * views/partials/file-rows.ejs (und die anderen Zeilen-Partials) die
     * einzige Stelle, die dieses Markup erzeugt; das erste Server-Side-
     * Render und das per Poll nachgelieferte Fragment sehen garantiert
     * gleich aus.
     */
    function renderPartial(view, locals) {
        return new Promise((resolve, reject) => {
            app.render(view, locals, (err, html) => {
                if (err) reject(err); else resolve(html);
            });
        });
    }

    /* Zaehler am Tickets-Link der Navigation (Live-Bereich "nav-count") —
       dieselben res.locals, die loadCustomer (lib/routes/account.js) fuer
       den normalen Seiten-Render setzt. */
    function renderNavCount(res) {
        const { loggedIn, adminTicketBadge, currentCustomer, customerUnread } = res.locals;
        if (loggedIn) return renderPartial('partials/nav-count', { count: adminTicketBadge ?? 0, title: 'Ungelesene Tickets' });
        if (currentCustomer) return renderPartial('partials/nav-count', { count: customerUnread ?? 0, title: 'Neue Antworten' });
        return Promise.resolve('');
    }

    /*
     * Gemeinsame Render-Daten fuer admin.ejs — die Seite wird von vier Routen
     * gerendert (GET /admin-upload, GET /admin-search, sowie die
     * Fehler-Pfade von POST /admin-password und /admin-username), alle mit
     * denselben Grunddaten plus je einem eigenen Fehlerfeld/Suchbegriff.
     */
    async function adminPageData({
        query = '', passwordError = null, usernameError = null, backupSettingsError = null,
    } = {}) {
        const [
            files, allTags, passkeys, currentUsername, totpEnabled, auditEntries, apiTokens,
            backups,
        ] =
            await Promise.all([
                listFiles(query),
                listAllTags(),
                webauthnStore.listCredentials(),
                usernameStore.read().then(name => name ?? ADMIN_USERNAME),
                totpStore.isEnabled(),
                auditLog.read({ limit: 8 }),
                apiTokenStore.listTokens(),
                backupStore.listBackups(),
            ]);
        return {
            files, allTags, maxFileSizeMb: MAX_FILE_SIZE_MB, passkeys, currentUsername,
            totpEnabled, auditEntries, apiTokens, passwordError, usernameError,
            backups, backupSettings: backupStore.readSettings(), backupSettingsError,
            ticketStats: ticketStore.stats(),
            recentTickets: ticketStore.listTickets({ view: 'active', perPage: 6 }).tickets,
            customerCount: customerStore.countCustomers(),
        };
    }

    /* ============================================================ Routen */

    app.get('/', async (req, res, next) => {
        const loggedIn = Boolean(req.session && req.session.loggedIn);
        try {
            const [files, allTags] = await Promise.all([listFiles(), listAllTags()]);
            res.render('index', { files, allTags, loggedIn });
        } catch (err) {
            next(err);
        }
    });

    app.get('/download/:filename', downloadLimiter, async (req, res, next) => {
        const filename = safeIsoName(req.params.filename);
        if (!filename) {
            return res.status(400).send('Invalid filename');
        }
        const filePath = path.join(UPLOADS_DIR, filename);
        try {
            await fsp.access(filePath);
        } catch {
            return res.status(404).send('Datei nicht gefunden');
        }

        // Range-Requests nicht mitzaehlen: ein Download-Manager mit acht
        // parallelen Verbindungen ist ein Download, nicht acht.
        const countable = !req.get('range');

        res.download(filePath, err => {
            if (err) {
                // Verbindungsabbruch waehrend des Streams ist kein Serverfehler
                if (!res.headersSent) next(err);
                return;
            }
            if (countable) metadata.recordDownload(filename);
        });
    });

    /*
     * SHA256SUMS im Format von coreutils, damit
     *   sha256sum -c SHA256SUMS
     * direkt durchlaeuft. Dateien, deren Checksumme noch berechnet wird,
     * fehlen hier — lieber eine unvollstaendige Liste als eine falsche Zeile.
     */
    app.get('/checksums', async (req, res, next) => {
        try {
            const files = await listFiles();
            const lines = files
                .filter(file => file.sha256)
                .map(file => `${file.sha256}  ${file.name}`);

            res.type('text/plain; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename="SHA256SUMS"');
            res.send(lines.length > 0 ? `${lines.join('\n')}\n` : '');
        } catch (err) {
            next(err);
        }
    });

    /*
     * JSON-Gegenstueck zur Startseite/zu /checksums — fuer eigene Skripte,
     * CI-Checks oder ein Monitoring, das die Dateiliste nicht aus HTML
     * herausparsen soll. Liefert dieselben Felder wie describe() (siehe
     * oben), also auch Dateien ohne aktuelle Checksumme (sha256: null,
     * hashStatus verrät warum). Genau wie /checksums oeffentlich: die Werte
     * stehen ohnehin schon auf der oeffentlichen Startseite.
     */
    app.get('/api/files.json', async (req, res, next) => {
        const query = String(req.query.q || '').slice(0, 200);
        try {
            res.json(await listFiles(query));
        } catch (err) {
            next(err);
        }
    });

    /* Alle vorkommenden Tags, unabhaengig von einer Suche — JSON-Gegenstueck
       zur Tag-Filterleiste (siehe listAllTags() oben). */
    app.get('/api/tags.json', async (req, res, next) => {
        try {
            res.json(await listAllTags());
        } catch (err) {
            next(err);
        }
    });

    /*
     * Heartbeat-Fragment fuer die oeffentliche Startseite/das Suchergebnis
     * (public/js/heartbeat.js, alle 20s abgefragt, siehe pollLimiter oben).
     * Liefert die Dateitabelle und die Tag-Filterleiste bereits fertig
     * gerendert (dasselbe Partial wie beim ersten Server-Side-Render, siehe
     * renderPartial()) statt roher JSON-Daten — so muss kein zweites Mal in
     * JavaScript nachgebaut werden, wie eine Datei-Zeile aussieht. Immer die
     * komplette, ungefilterte Liste: eine aktive Freitextsuche filtert schon
     * client-seitig (filetable.js), der Heartbeat aktualisiert nur die
     * zugrundeliegenden Daten.
     */
    app.get('/partials/listing', pollLimiter, async (req, res, next) => {
        try {
            const [files, allTags] = await Promise.all([listFiles(), listAllTags()]);
            const [filesHtml, tagsHtml, navCount] = await Promise.all([
                renderPartial('partials/file-rows', { files, admin: false }),
                renderPartial('partials/tag-filter', { allTags, searchQuery: '', searchBase: '/search' }),
                renderNavCount(res),
            ]);
            res.json({ filesHtml, tagsHtml, visibleCount: files.length, regions: { 'nav-count': navCount } });
        } catch (err) {
            next(err);
        }
    });

    /*
     * Nur der Ticket-Zaehler der Navigation — fuer Seiten ohne eigenes
     * Polling (Impressum, Hilfeartikel-Editor, Event-Detail …), die ihn
     * trotzdem zeigen, sobald jemand angemeldet ist (live-regions.js).
     * Ohne checkAuth: ein Admin bekommt seinen Zaehler, ein Kunde seinen,
     * alle anderen einen leeren Bereich; lastActivity bleibt unberuehrt.
     */
    app.get('/partials/nav', pollLimiter, async (req, res, next) => {
        try {
            res.json({ regions: { 'nav-count': await renderNavCount(res) } });
        } catch (err) {
            next(err);
        }
    });

    /*
     * Fuer den Docker-Healthcheck. Bewusst ohne Verzeichnis-Listing: der
     * alte Check lief gegen / und hat dafuer alle 30 Sekunden die komplette
     * Dateiliste samt Metadaten gerendert.
     */
    app.get('/healthz', (req, res) => {
        // Eine echte Abfrage statt eines festen "ok": nach einem
        // fehlgeschlagenen Restore (db geschlossen) oder einem kaputten
        // Volume meldet der Container sich damit als unhealthy
        let dbOk = true;
        try {
            db.prepare('SELECT 1').get();
        } catch (err) {
            dbOk = false;
            events.record({
                event: 'healthcheck_failed', module: 'database', severity: SEVERITY.CRITICAL,
                message: 'Datenbank nicht nutzbar', error: err,
            });
        }
        res.status(dbOk ? 200 : 503).json({
            status: dbOk ? 'ok' : 'error',
            db: dbOk ? 'ok' : 'error',
            uptime: Math.round(process.uptime()),
            hashing: hashQueue.isIdle() ? 'idle' : 'busy',
        });
    });

    function metricLine(name, type, help, value) {
        return `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${name} ${value}`;
    }

    /*
     * Prometheus-Textformat, oeffentlich wie /healthz — die Zahlen hier
     * (Dateizahl, Speicherplatz, Downloads) verraten nichts, was die
     * oeffentliche Startseite nicht ohnehin schon zeigt. Upload-/Lösch-/
     * Login-Zaehler kommen aus dem Audit-Log (siehe lib/audit-log.js) und
     * sind damit nur so vollstaendig wie dessen Kuerzungsgrenze (2 MB /
     * die juengsten 3000 Zeilen) — fuer ein Live-Dashboard einer Single-
     * Admin-Instanz ausreichend, kein Ersatz fuer /admin-audit-log.
     */
    /*
     * Mit gesetztem METRICS_TOKEN nur noch mit `Authorization: Bearer
     * <token>` — die Betriebswerte unten (freier Speicher, Mail-Fehler,
     * Backup-Alter) verraten mehr als die oeffentliche Liste. Der Vergleich
     * laeuft ueber SHA-256 + timingSafeEqual, damit die Laenge/Praefixe des
     * Tokens nicht ueber die Antwortzeit messbar sind.
     */
    const METRICS_TOKEN_HASH = metricsToken
        ? crypto.createHash('sha256').update(String(metricsToken)).digest()
        : null;
    function metricsAuthorized(req) {
        if (!METRICS_TOKEN_HASH) return true;
        const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
        if (!match) return false;
        const candidate = crypto.createHash('sha256').update(match[1].trim()).digest();
        return crypto.timingSafeEqual(candidate, METRICS_TOKEN_HASH);
    }

    function labelled(name, type, help, samples) {
        const lines = samples.map(([labels, value]) => {
            const rendered = Object.entries(labels)
                .map(([key, val]) => `${key}="${String(val).replace(/["\\\n]/g, '_')}"`)
                .join(',');
            return `${name}{${rendered}} ${value}`;
        });
        return `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${lines.join('\n')}`;
    }

    /*
     * Werte, auf die ein Alert gehoert: Mail-Outbox mit Fehlschlaegen,
     * IMAP-Abruf mit Fehler, letzte Sicherung zu alt, Volume fast voll.
     * Beispielregeln stehen in OPERATIONS.md.
     */
    function operationalMetrics({ backups, uploadSessionList, uploadsDisk, dataDisk, dbBytes, walBytes }) {
        const mailCounts = outbox.counts();
        const regularBackups = backups.filter(backup => !backup.preRestore);
        const lastBackup = regularBackups.length > 0
            ? Math.max(...regularBackups.map(backup => backup.createdAt)) / 1000 : 0;
        const lines = [
            labelled('iso_share_build_info', 'gauge', 'Version der laufenden App und des DB-Schemas.',
                [[{ version: APP_VERSION, schema: SCHEMA_VERSION, node: process.version }, 1]]),
            metricLine('iso_share_hash_queue_pending', 'gauge',
                'Dateien, deren Checksumme noch berechnet wird oder wartet.', hashQueue.pendingCount()),
            metricLine('iso_share_upload_sessions', 'gauge',
                'Offene fortsetzbare Upload-Sitzungen.', uploadSessionList.length),
            labelled('iso_share_mail_outbox', 'gauge',
                'Mails in der Outbox je Status (failed = endgueltig fehlgeschlagen).',
                ['pending', 'failed'].map(status => [{ status }, mailCounts[status] ?? 0])),
            metricLine('iso_share_mail_enabled', 'gauge', '1 wenn SMTP konfiguriert ist.', outbox.enabled ? 1 : 0),
            metricLine('iso_share_backups', 'gauge',
                'Anzahl regulaerer Datenbank-Sicherungen (ohne pre-restore).', regularBackups.length),
            metricLine('iso_share_backup_last_timestamp_seconds', 'gauge',
                'Zeitpunkt der juengsten regulaeren Sicherung (Unix-Sekunden, 0 = keine).', lastBackup),
            metricLine('iso_share_db_bytes', 'gauge',
                'Groesse der SQLite-Datenbank inklusive WAL-Datei.', dbBytes + walBytes),
        ];
        const attachmentTotals = attachmentStore.totals();
        lines.push(
            metricLine('iso_share_ticket_attachments', 'gauge', 'Anzahl gespeicherter Ticket-Anhaenge.', attachmentTotals.count),
            metricLine('iso_share_ticket_attachments_bytes', 'gauge',
                'Gesamtgroesse der Ticket-Anhaenge (DATA_DIR/ticket-attachments).', attachmentTotals.bytes),
        );
        if (imapPoller.enabled) {
            const inbound = inboundProcessor.stats();
            if (Object.keys(inbound).length > 0) {
                lines.push(labelled('iso_share_mail_inbound_total', 'counter',
                    'Eingehende Mails seit Prozessstart je Ergebnis (added/created/duplicate/abgelehnt mit Grund).',
                    Object.entries(inbound).map(([result, value]) => [{ result }, value])));
            }
            const { lastRunAt, lastError } = imapPoller.status;
            lines.push(
                metricLine('iso_share_imap_last_poll_ok', 'gauge',
                    '1 wenn der letzte IMAP-Abruf fehlerfrei war.', lastRunAt && !lastError ? 1 : 0),
                metricLine('iso_share_imap_last_poll_timestamp_seconds', 'gauge',
                    'Zeitpunkt des letzten IMAP-Abrufs (Unix-Sekunden).', (lastRunAt ?? 0) / 1000),
            );
        }
        const disks = [['uploads', uploadsDisk], ['data', dataDisk]].filter(([, info]) => info);
        if (disks.length > 0) {
            lines.push(labelled('iso_share_disk_free_bytes', 'gauge',
                'Freier Speicher auf dem Volume des jeweiligen Verzeichnisses.',
                disks.map(([volume, info]) => [{ volume }, info.free])));
        }
        return lines;
    }

    /* Zustand des Event-Logs selbst (lib/event-store.js) */
    function eventMetrics() {
        const state = events.status();
        return [
            metricLine('iso_share_events_queued', 'gauge',
                'Ereignisse in der Schreib-Queue des Event-Logs.', state.queued),
            metricLine('iso_share_events_written_total', 'counter',
                'Seit Prozessstart ins Event-Log geschriebene Ereignisse.', state.written),
            metricLine('iso_share_events_dropped_total', 'counter',
                'Wegen voller Queue verworfene DEBUG/INFO-Ereignisse.', state.dropped),
            metricLine('iso_share_events_write_failures_total', 'counter',
                'Fehlgeschlagene Schreibvorgaenge des Event-Logs.', state.writeFailures),
        ];
    }

    async function fileSizeOrZero(file) {
        try {
            return (await fsp.stat(file)).size;
        } catch {
            return 0;
        }
    }

    app.get('/metrics', async (req, res, next) => {
        if (!metricsAuthorized(req)) {
            res.set('WWW-Authenticate', 'Bearer realm="metrics"');
            return res.status(401).type('text/plain').send('Nicht autorisiert');
        }
        try {
            const diskInfoFn = diskInfo || defaultDiskInfo;
            const [files, backups, uploadSessionList, uploadsDisk, dataDisk, dbBytes, walBytes] =
                await Promise.all([
                    listFiles(),
                    backupStore.listBackups().catch(() => []),
                    uploadSessions.listSessions().catch(() => []),
                    diskInfoFn(UPLOADS_DIR),
                    diskInfoFn(DATA_DIR),
                    fileSizeOrZero(DB_PATH),
                    fileSizeOrZero(DB_PATH + '-wal'),
                ]);

            const storageBytes = files.reduce((sum, file) => sum + file.size, 0);
            const downloadsTotal = files.reduce((sum, file) => sum + file.downloads, 0);
            const countEvents = (...names) => events.countAudit(names);
            const uploadsTotal = countEvents('upload');
            const deletesTotal = countEvents('delete') + events.sumAuditField('bulk_delete', 'count');
            const loginFailuresTotal = countEvents(
                'login_failed', 'totp_login_failed', 'passkey_login_failed'
            );
            const loginSuccessesTotal = countEvents(
                'login_success', 'totp_login_success', 'passkey_login_success'
            );

            const body = [
                metricLine('iso_share_uptime_seconds', 'gauge',
                    'Sekunden seit Prozessstart.', process.uptime()),
                metricLine('iso_share_files_total', 'gauge',
                    'Anzahl der aktuell gespeicherten ISO-Dateien.', files.length),
                metricLine('iso_share_storage_bytes', 'gauge',
                    'Belegter Speicherplatz aller ISO-Dateien in Byte.', storageBytes),
                metricLine('iso_share_downloads_total', 'counter',
                    'Kumulierte Downloads aller Dateien.', downloadsTotal),
                metricLine('iso_share_uploads_total', 'counter',
                    'Anzahl erfolgreicher Uploads (aus dem Audit-Log).', uploadsTotal),
                metricLine('iso_share_deletes_total', 'counter',
                    'Anzahl geloeschter Dateien, einzeln plus Bulk (aus dem Audit-Log).', deletesTotal),
                metricLine('iso_share_login_failures_total', 'counter',
                    'Fehlgeschlagene Anmeldeversuche ueber Passwort, TOTP oder Passkey (aus dem Audit-Log).', loginFailuresTotal),
                metricLine('iso_share_login_successes_total', 'counter',
                    'Erfolgreiche Anmeldungen (aus dem Audit-Log).', loginSuccessesTotal),
                metricLine('iso_share_hash_queue_busy', 'gauge',
                    '1 waehrend die Hintergrund-Checksummenberechnung laeuft, sonst 0.', hashQueue.isIdle() ? 0 : 1),
                ...operationalMetrics({ backups, uploadSessionList, uploadsDisk, dataDisk, dbBytes, walBytes }),
                ...eventMetrics(),
            ].join('\n\n');

            res.type('text/plain; version=0.0.4; charset=utf-8');
            res.send(`${body}\n`);
        } catch (err) {
            next(err);
        }
    });

    app.get('/login', (req, res) => {
        // ?idle=1 kommt ausschliesslich vom eigenen checkAuth-Redirect nach
        // Session-Idle-Timeout (siehe oben) — kein Nutzereingriff moeglich,
        // der Text ist fest verdrahtet.
        const error = req.query.idle === '1' ? 'Wegen Inaktivität abgemeldet. Bitte erneut anmelden.' : null;
        res.render('login', { error });
    });

    app.post('/login', loginLimiterGlobal, loginLimiterPerIp, async (req, res) => {
        const submittedUsername = String(req.body.username ?? '').trim();
        const storedUsername = (await usernameStore.read()) ?? ADMIN_USERNAME;
        // passwordMatches() immer auswerten, auch bei falschem Benutzernamen
        // — sonst wuerde die Antwortzeit verraten, ob der Benutzername
        // allein schon gestimmt hat.
        const passwordOk = await passwordMatches(req.body.password);
        const usernameOk = submittedUsername.length > 0 && submittedUsername === storedUsername;

        if (usernameOk && passwordOk) {
            const totpEnabled = await totpStore.isEnabled();
            // Session-ID nach erfolgreichem Login neu vergeben (Fixation) —
            // auch wenn TOTP noch als zweiter Faktor aussteht: der erste
            // Faktor hat schon Vertrauen geschaffen, die alte, evtl. dem
            // Angreifer bekannte Session-ID darf ab hier nicht mehr gelten.
            req.session.regenerate(err => {
                if (err) {
                    log.error('Session regenerate error:', err);
                    return res.status(500).render('login', { error: 'Serverfehler.' });
                }
                if (totpEnabled) {
                    req.session.pendingTotp = true;
                    return res.redirect('/login/totp');
                }
                req.session.loggedIn = true;
                req.session.lastActivity = Date.now();
                auditLog.log('login_success', { ip: req.ip, username: submittedUsername });
                res.redirect('/admin-upload');
            });
        } else {
            // Bewusst generisch — sonst liesse sich per Antwort erraten, ob
            // schon der Benutzername stimmte (Username-Enumeration).
            auditLog.log('login_failed', { ip: req.ip, username: submittedUsername });
            res.status(401).render('login', { error: 'Benutzername oder Passwort falsch.' });
        }
    });

    /*
     * Zweiter Faktor nach erfolgreichem Passwort-Login. Erreichbar nur mit
     * einer Session, die gerade den ersten Faktor bestanden hat
     * (req.session.pendingTotp) — ohne das gilt dieselbe Regel wie ueberall
     * sonst: kein gueltiger Zustand, zurueck zu /login. Gilt bewusst NICHT
     * fuer den Passkey-Login: eine WebAuthn-Anmeldung ist schon
     * Besitz+Verifikation und damit MFA-gleichwertig (siehe CLAUDE.md).
     */
    app.get('/login/totp', (req, res) => {
        if (!req.session || !req.session.pendingTotp) {
            return res.redirect('/login');
        }
        res.render('login-totp', { error: null });
    });

    app.post('/login/totp', loginLimiterGlobal, loginLimiterPerIp, async (req, res) => {
        if (!req.session || !req.session.pendingTotp) {
            return res.redirect('/login');
        }

        const token = String(req.body.token ?? '').trim();
        const secret = await totpStore.getSecret();
        // Ein 6-stelliger Code ist immer der TOTP-Pfad, alles andere wird als
        // Recovery-Code versucht (Format ist fuer Nutzer nicht auswendig zu
        // kennen, daher keine strengere Vorabpruefung noetig).
        const ok = /^\d{6}$/.test(token) && secret
            ? verifyTotp(secret, token)
            : await totpStore.consumeRecoveryCode(token);

        if (!ok) {
            auditLog.log('totp_login_failed', { ip: req.ip });
            return res.status(401).render('login-totp', { error: 'Code ungültig.' });
        }

        delete req.session.pendingTotp;
        req.session.loggedIn = true;
        req.session.lastActivity = Date.now();
        auditLog.log('totp_login_success', { ip: req.ip });
        res.redirect('/admin-upload');
    });

    app.get('/admin-upload', checkAuth, async (req, res, next) => {
        try {
            res.render('admin', await adminPageData());
        } catch (err) {
            next(err);
        }
    });

    /*
     * Bewusst ohne erneute Eingabe des alten Passworts — eine gueltige
     * Sitzung (egal ob per Passwort oder Passkey zustandegekommen) gilt als
     * Nachweis, dasselbe Vertrauensmodell wie bei der Passkey-Registrierung
     * oben. Wer das Sitzungscookie hat, hat ohnehin schon vollen
     * Admin-Zugriff — das alte Passwort zusaetzlich abzufragen wuerde
     * keinen Angriff verhindern, aber genau den Fall blockieren, fuer den
     * diese Route gedacht ist: das Passwort vergessen zu haben.
     */
    const MIN_PASSWORD_LENGTH = 8;

    // JS-Client schickt Accept: application/json und bekommt eine JSON-
    // Rueckmeldung fuer das Modal (public/js/account-forms.js); ohne JS
    // bleibt der bisherige Form-Submit-Weg (Redirect bzw. Inline-Fehler)
    // unveraendert. Dieselbe Logik gilt fuer /admin-username unten.
    app.post('/admin-password', checkAuth, async (req, res, next) => {
        const wantsJson = req.accepts(['html', 'json']) === 'json';
        const password = String(req.body.password ?? '');
        const confirmPassword = String(req.body.confirmPassword ?? '');
        const error =
            password.length < MIN_PASSWORD_LENGTH
                ? `Das Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen lang sein.`
                : password !== confirmPassword
                    ? 'Die Passwörter stimmen nicht überein.'
                    : null;

        if (error) {
            if (wantsJson) return res.status(400).json({ error });
            try {
                return res.status(400).render('admin', await adminPageData({ passwordError: error }));
            } catch (err) {
                return next(err);
            }
        }

        try {
            await passwordStore.setPassword(password);
            auditLog.log('password_changed', { ip: req.ip });
            if (wantsJson) return res.json({ ok: true });
            res.redirect('/admin-upload');
        } catch (err) {
            next(err);
        }
    });

    app.post('/admin-username', checkAuth, async (req, res, next) => {
        const wantsJson = req.accepts(['html', 'json']) === 'json';
        const username = safeUsername(req.body.username);

        if (!username) {
            const error = 'Ungültiger Benutzername (1–64 Zeichen, keine Leerzeichen).';
            if (wantsJson) return res.status(400).json({ error });
            try {
                return res.status(400).render('admin', await adminPageData({ usernameError: error }));
            } catch (err) {
                return next(err);
            }
        }

        try {
            const previous = (await usernameStore.read()) ?? ADMIN_USERNAME;
            await usernameStore.write(username);
            currentAdminName = username;
            auditLog.log('username_changed', {
                ip: req.ip, username, changes: diff({ username: previous }, { username }),
            });
            if (wantsJson) return res.json({ ok: true });
            res.redirect('/admin-upload');
        } catch (err) {
            next(err);
        }
    });

    /* ------------------------------------------------- WebAuthn/Passkeys --
       Registrierung nur fuer bereits angemeldete Admins (checkAuth) — es
       gibt bewusst keinen separaten Bootstrap-Flow, der erste Passkey wird
       immer per Passwort-Login freigeschaltet. Die Login-Routen sind
       oeffentlich, teilen sich aber dieselben Rate-Limiter-Instanzen wie
       /login: ein Angreifer kann sein Budget nicht verdoppeln, indem er
       zwischen Passwort- und Passkey-Versuchen wechselt. */

    const PASSKEY_LOGIN_FAILED = { error: 'Anmeldung fehlgeschlagen.' };

    app.post('/webauthn/register/options', checkAuth, async (req, res, next) => {
        try {
            const { rpID } = rpIdAndOrigin(req);
            const userId = await webauthnStore.getOrCreateUserId();
            const existing = await webauthnStore.listCredentials();
            const options = await generateRegistrationOptions({
                rpName: 'ISO Share',
                rpID,
                userName: 'admin',
                userID: Buffer.from(userId, 'base64url'),
                attestationType: 'none',
                excludeCredentials: existing.map(c => ({
                    id: c.credentialId, transports: c.transports,
                })),
                authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
            });
            req.session.webauthnChallenge = options.challenge;
            res.json(options);
        } catch (err) {
            next(err);
        }
    });

    app.post('/webauthn/register/verify', checkAuth, async (req, res) => {
        const expectedChallenge = req.session.webauthnChallenge;
        if (!expectedChallenge) {
            return res.status(400).json({ error: 'Keine offene Registrierung.' });
        }
        const label = safePasskeyLabel(req.body.label)
            ?? `Passkey (${app.locals.formatDate(Date.now())})`;
        try {
            const { rpID, expectedOrigin } = rpIdAndOrigin(req);
            const verification = await verifyRegistrationResponse({
                response: req.body.credential,
                expectedChallenge,
                expectedOrigin,
                expectedRPID: rpID,
            });
            if (!verification.verified) {
                return res.status(400).json({ error: 'Registrierung fehlgeschlagen.' });
            }
            const { credential } = verification.registrationInfo;
            await webauthnStore.addCredential({
                credentialId: credential.id,
                publicKey: Buffer.from(credential.publicKey).toString('base64url'),
                counter: credential.counter,
                transports: credential.transports ?? [],
                label,
            });
            auditLog.log('passkey_registered', { ip: req.ip, label });
            res.status(201).json({ ok: true });
        } catch (err) {
            log.error('WebAuthn Registrierung fehlgeschlagen:', err);
            res.status(400).json({ error: 'Registrierung fehlgeschlagen.' });
        } finally {
            delete req.session.webauthnChallenge;
        }
    });

    app.get('/webauthn/credentials', checkAuth, async (req, res, next) => {
        try {
            res.json(await webauthnStore.listCredentials());
        } catch (err) {
            next(err);
        }
    });

    app.delete('/webauthn/credentials/:id', checkAuth, async (req, res) => {
        const id = safeCredentialId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Ungültige Credential-ID.' });
        const removed = await webauthnStore.removeCredential(id);
        if (removed) auditLog.log('passkey_removed', { ip: req.ip, credentialId: id });
        res.status(removed ? 204 : 404).end();
    });

    app.post('/webauthn/login/options', loginLimiterGlobal, loginLimiterPerIp, async (req, res, next) => {
        try {
            const { rpID } = rpIdAndOrigin(req);
            const existing = await webauthnStore.listCredentials();
            const options = await generateAuthenticationOptions({
                rpID,
                allowCredentials: existing.map(c => ({
                    id: c.credentialId, transports: c.transports,
                })),
                userVerification: 'preferred',
            });
            // saveUninitialized:false verhindert nur, dass eine UNVERAENDERTE
            // Session gespeichert wird. Sobald hier eine Property gesetzt
            // wird, gilt die Session als modifiziert und wird trotzdem
            // gespeichert — auch ganz ohne vorherige Anmeldung.
            req.session.webauthnChallenge = options.challenge;
            res.json(options);
        } catch (err) {
            next(err);
        }
    });

    app.post('/webauthn/login/verify', loginLimiterGlobal, loginLimiterPerIp, async (req, res) => {
        const expectedChallenge = req.session.webauthnChallenge;
        if (!expectedChallenge) {
            return res.status(400).json({ error: 'Keine offene Anmeldung.' });
        }
        const credentialId = safeCredentialId(req.body?.credential?.id);
        const stored = credentialId ? await webauthnStore.findCredential(credentialId) : null;
        if (!stored) {
            delete req.session.webauthnChallenge;
            auditLog.log('passkey_login_failed', { ip: req.ip });
            return res.status(401).json({ error: 'Unbekannter Passkey.' });
        }
        try {
            const { rpID, expectedOrigin } = rpIdAndOrigin(req);
            const verification = await verifyAuthenticationResponse({
                response: req.body.credential,
                expectedChallenge,
                expectedOrigin,
                expectedRPID: rpID,
                credential: {
                    id: stored.credentialId,
                    publicKey: Buffer.from(stored.publicKey, 'base64url'),
                    counter: stored.counter,
                    transports: stored.transports,
                },
            });
            if (!verification.verified) {
                delete req.session.webauthnChallenge;
                auditLog.log('passkey_login_failed', { ip: req.ip });
                return res.status(401).json(PASSKEY_LOGIN_FAILED);
            }
            await webauthnStore.updateCounter(stored.credentialId, verification.authenticationInfo.newCounter);
            // Session-ID nach erfolgreichem Login neu vergeben (Fixation) —
            // dasselbe Muster wie /login. regenerate() ersetzt die Session
            // komplett, die Challenge wird damit automatisch entsorgt.
            req.session.regenerate(err => {
                if (err) {
                    log.error('Session regenerate error:', err);
                    return res.status(500).json({ error: 'Serverfehler.' });
                }
                req.session.loggedIn = true;
                req.session.lastActivity = Date.now();
                auditLog.log('passkey_login_success', { ip: req.ip, credentialId: stored.credentialId });
                res.json({ ok: true, redirect: '/admin-upload' });
            });
        } catch (err) {
            log.error('WebAuthn Anmeldung fehlgeschlagen:', err);
            delete req.session.webauthnChallenge;
            auditLog.log('passkey_login_failed', { ip: req.ip });
            res.status(401).json(PASSKEY_LOGIN_FAILED);
        }
    });

    /* --------------------------------------------------------------- TOTP --
       Zweiter Faktor fuer den Passwort-Login (siehe /login/totp oben).
       Registrierung/Deaktivierung nur fuer bereits angemeldete Admins,
       dasselbe Vertrauensmodell wie bei Passkeys und /admin-password: eine
       gueltige Sitzung ist Nachweis genug, keine erneute Passwortabfrage. */

    app.post('/totp/setup', checkAuth, async (req, res, next) => {
        try {
            const secret = generateSecret();
            // Nur in der Session, nicht persistiert — siehe lib/totp-store.js.
            req.session.totpSetupSecret = secret;
            const label = (await usernameStore.read()) ?? ADMIN_USERNAME;
            res.json({ secret, otpauthUrl: buildOtpauthUri({ secret, label }) });
        } catch (err) {
            next(err);
        }
    });

    // Dieselben Limiter wie /login (siehe CLAUDE.md) — nach checkAuth, damit
    // nicht angemeldete Anfragen den globalen Login-Bucket nicht leeren.
    app.post('/totp/confirm', checkAuth, loginLimiterGlobal, loginLimiterPerIp, async (req, res, next) => {
        const pendingSecret = req.session.totpSetupSecret;
        if (!pendingSecret) {
            return res.status(400).json({ error: 'Keine offene Einrichtung.' });
        }
        if (!verifyTotp(pendingSecret, req.body.token)) {
            return res.status(400).json({ error: 'Code ungültig.' });
        }
        try {
            const recoveryCodes = await totpStore.enable(pendingSecret);
            delete req.session.totpSetupSecret;
            auditLog.log('totp_enabled', { ip: req.ip });
            res.json({ ok: true, recoveryCodes });
        } catch (err) {
            next(err);
        }
    });

    app.post('/totp/disable', checkAuth, async (req, res, next) => {
        try {
            await totpStore.disable();
            auditLog.log('totp_disabled', { ip: req.ip });
            res.json({ ok: true });
        } catch (err) {
            next(err);
        }
    });

    /* ---------------------------------------------------- API-Tokens --
       Erstellung/Verwaltung nur fuer bereits angemeldete Admins (checkAuth)
       — kein API-Weg zur Selbstausstellung, dasselbe Bootstrap-Prinzip wie
       bei Passkeys oben. Die Tokens selbst werden unter /api/v1 verwendet
       (siehe checkApiToken). */

    app.get('/admin/api-tokens', checkAuth, async (req, res, next) => {
        try {
            res.json(await apiTokenStore.listTokens());
        } catch (err) {
            next(err);
        }
    });

    app.post('/admin/api-tokens', checkAuth, async (req, res, next) => {
        const label = safeApiTokenLabel(req.body.label) ?? null;
        const scopes = Array.isArray(req.body.scopes) ? req.body.scopes : ['read'];
        try {
            const created = await apiTokenStore.createToken({ label, scopes });
            if (!created) {
                return res.status(400).json({ error: 'Ungültige Scopes.' });
            }
            auditLog.log('api_token_created', {
                ip: req.ip, tokenId: created.id, label: created.label, scopes: created.scopes,
            });
            // Klartext-Token nur hier, genau einmal — danach nicht mehr
            // rekonstruierbar (siehe lib/api-token-store.js).
            res.status(201).json(created);
        } catch (err) {
            next(err);
        }
    });

    app.delete('/admin/api-tokens/:id', checkAuth, async (req, res) => {
        const id = safeApiTokenId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Ungültige Token-ID.' });
        const removed = await apiTokenStore.revokeToken(id);
        if (removed) auditLog.log('api_token_revoked', { ip: req.ip, tokenId: id });
        res.status(removed ? 204 : 404).end();
    });

    /*
     * Sicherungen der Datenbank selbst (siehe lib/backup-store.js) — nicht
     * der ISO-Dateien in uploads/, die bleiben Sache des Admins. Liste und
     * Einstellungen kommen ueber adminPageData() mit auf die Verwaltungs-
     * seite, hier nur die Aktionen.
     */

    app.post('/admin/backups', checkAuth, async (req, res, next) => {
        const wantsJson = req.accepts(['html', 'json']) === 'json';
        try {
            const backup = await backupStore.createBackup('manual');
            auditLog.log('backup_created', { ip: req.ip, file: backup.file, size: backup.size });
            if (wantsJson) return res.status(201).json(backup);
            res.redirect('/admin-upload#tab-backups');
        } catch (err) {
            // Kollidiert mit einem gerade laufenden geplanten/manuellen Lauf
            // oder einer laufenden Wiederherstellung — kein Serverfehler,
            // einfach nochmal versuchen.
            if (err.code === 'backup_in_progress') {
                if (wantsJson) return res.status(409).json({ error: err.message, code: err.code });
                return res.redirect('/admin-upload#tab-backups');
            }
            next(err);
        }
    });

    app.get('/admin/backups/:filename/download', checkAuth, async (req, res, next) => {
        const filename = safeBackupName(req.params.filename);
        if (!filename) return res.status(400).send('Ungültiger Dateiname.');
        try {
            await fsp.access(path.join(BACKUP_DIR, filename));
        } catch {
            return res.status(404).send('Sicherung nicht gefunden.');
        }
        res.download(path.join(BACKUP_DIR, filename), filename, err => {
            if (err && !res.headersSent) next(err);
        });
    });

    app.delete('/admin/backups/:filename', checkAuth, async (req, res) => {
        const filename = safeBackupName(req.params.filename);
        if (!filename) return res.status(400).json({ error: 'Ungültiger Dateiname.' });
        const removed = await backupStore.deleteBackup(filename);
        if (removed) auditLog.log('backup_deleted', { ip: req.ip, file: filename });
        res.status(removed ? 204 : 404).end();
    });

    app.post('/admin/backup-settings', checkAuth, async (req, res, next) => {
        const wantsJson = req.accepts(['html', 'json']) === 'json';
        const previousSettings = backupStore.readSettings();
        const updated = backupStore.writeSettings({
            intervalMinutes: req.body.intervalMinutes,
            retentionCount: req.body.retentionCount,
            enabled: Boolean(req.body.enabled),
        });
        if (!updated) {
            const error = 'Ungültige Werte für Intervall oder Aufbewahrung.';
            if (wantsJson) return res.status(400).json({ error });
            try {
                return res.status(400).render('admin', await adminPageData({ backupSettingsError: error }));
            } catch (err) {
                return next(err);
            }
        }
        try {
            armBackupTimer();
            auditLog.log('backup_settings_changed', { ip: req.ip, ...updated, changes: diff(previousSettings, updated) });
            if (wantsJson) return res.json(updated);
            res.redirect('/admin-upload#tab-backups');
        } catch (err) {
            next(err);
        }
    });

    /*
     * Die destruktive Aktion: tauscht die Live-Datenbankdatei gegen die
     * gewaehlte Sicherung aus und beendet danach den Prozess absichtlich,
     * damit ein Neustart (docker-compose.yml: restart: unless-stopped) eine
     * frische DatabaseSync-Instanz auf der wiederhergestellten Datei
     * oeffnet — siehe Design-Kommentar bei restoreBackup() in
     * lib/backup-store.js dazu, warum kein Live-Reopen ohne Neustart
     * versucht wird. `confirm` muss exakt dem Dateinamen entsprechen
     * (Tippen-zum-Bestaetigen im UI), dieselbe Reibung wie bei anderen
     * irreversiblen Aktionen erwartet.
     */
    app.post('/admin/backups/:filename/restore', checkAuth, async (req, res, next) => {
        const filename = safeBackupName(req.params.filename);
        if (!filename) return res.status(400).json({ error: 'Ungültiger Dateiname.' });
        if (String(req.body.confirm ?? '') !== filename) {
            return res.status(400).json({ error: 'Bestätigung stimmt nicht mit dem Dateinamen überein.' });
        }

        let result;
        try {
            result = await backupStore.restoreBackup(filename, { dbPath: DB_PATH });
        } catch (err) {
            // db ist in diesem Fall schon geschlossen (siehe Design-Kommentar
            // bei restoreBackup() in lib/backup-store.js) — der Dateitausch
            // selbst ist zwar evtl. nicht vollstaendig geglueckt, aber der
            // Prozess kann in diesem Zustand nicht mehr normal weiterlaufen
            // und MUSS trotzdem beendet werden, statt als "sauberer" 400
            // ohne Neustart durchzugehen. Die zuvor angelegte pre-restore-
            // Sicherheitskopie bleibt fuer eine manuelle Reparatur erhalten.
            if (err.dbClosed) {
                events.record({
                    event: 'backup_restore_failed', module: 'backup', severity: SEVERITY.CRITICAL,
                    message: 'Restore-Dateitausch nach Schliessen der DB fehlgeschlagen', error: err,
                });
                log.error(
                    'Restore-Dateitausch fehlgeschlagen, nachdem die DB bereits geschlossen wurde — ' +
                    'Prozess wird trotzdem beendet:', err.message
                );
                res.status(500).json({ error: 'Wiederherstellung fehlgeschlagen — Server startet trotzdem neu.' });
                return res.on('finish', () => {
                    setTimeout(() => process.exit(1), 250);
                });
            }
            if (err.code === 'backup_in_progress') {
                return res.status(409).json({ error: err.message, code: err.code });
            }
            if (err.code) return res.status(400).json({ error: err.message, code: err.code });
            return next(err);
        }

        // Das Event-Log liegt in einer eigenen Datei (events.db) und
        // ueberlebt den Restore der Haupt-DB — der Eintrag bleibt also
        // erhalten. Die Markerdatei bleibt zusaetzlich fuer Betreiber, die
        // sie per Skript auswerten.
        auditLog.log('backup_restored', { ip: req.ip, ...result });
        events.flush();
        await fsp.writeFile(
            path.join(DATA_DIR, 'last-restore.json'),
            JSON.stringify({ ...result, ip: req.ip, ts: Date.now() }, null, 2)
        ).catch(() => {});

        res.json({ ok: true, message: 'Wiederhergestellt. Server startet neu …' });
        res.on('finish', () => {
            setTimeout(() => process.exit(1), 250);
        });
    });

    // Frueher eine eigene Audit-Log-Seite, jetzt ein Filter des Event-Log-
    // Dashboards (lib/routes/event-log.js)
    app.get('/admin-audit-log', checkAuth, (req, res) => {
        res.redirect(301, '/admin/logs?audit=1');
    });

    /*
     * Admin-Gegenstueck zu /partials/listing oben: Dateitabelle, Tag-
     * Filterleiste, Passkeys und API-Tokens fertig gerendert, Benutzername
     * und TOTP-Status als Werte, plus die
     * juengsten Audit-Log-Eintraege als JSON (deren Markup ist einfach genug,
     * um es ohne Duplikationsrisiko direkt in heartbeat.js nachzubauen —
     * anders als eine Datei-Zeile). Ein einziger Request pro Poll-Intervall
     * fuer die ganze admin.ejs/audit-log.ejs-Seite statt mehrerer.
     */
    app.get('/admin/partials/listing', checkAuth, pollLimiter, async (req, res, next) => {
        try {
            const [files, allTags, passkeys, apiTokens, auditEntries, backups, username, totpEnabled] = await Promise.all([
                listFiles(),
                listAllTags(),
                webauthnStore.listCredentials(),
                apiTokenStore.listTokens(),
                auditLog.read({ limit: 20 }),
                backupStore.listBackups(),
                usernameStore.read().then(name => name ?? ADMIN_USERNAME),
                totpStore.isEnabled(),
            ]);
            const ticketStats = ticketStore.stats();
            const [
                filesHtml, tagsHtml, passkeysHtml, apiTokensHtml,
                navCount, ticketTabBadge, ticketOverview, backupsHtml, backupSettingsHtml, uploadReplacesHtml,
            ] = await Promise.all([
                renderPartial('partials/file-rows', { files, admin: true }),
                renderPartial('partials/tag-filter-panel', { allTags, searchQuery: '', searchBase: '/admin-search' }),
                renderPartial('partials/passkey-rows', { passkeys }),
                renderPartial('partials/token-rows', { apiTokens }),
                renderNavCount(res),
                renderPartial('partials/ticket-tab-badge', { unread: ticketStats.views.unread }),
                renderPartial('partials/admin-ticket-overview', {
                    ticketStats,
                    recentTickets: ticketStore.listTickets({ view: 'active', perPage: 6 }).tickets,
                    customerCount: customerStore.countCustomers(),
                }),
                renderPartial('partials/backup-list', { backups }),
                renderPartial('partials/backup-settings-fields', { backupSettings: backupStore.readSettings() }),
                renderPartial('partials/upload-replaces', { files }),
            ]);
            res.json({
                filesHtml, tagsHtml, passkeysHtml, apiTokensHtml, auditEntries, visibleCount: files.length,
                // Konto-Karte: Zustand, den totp.js/account-forms.js selbst
                // verwalten (Buttons, Eingabefeld) — darum Werte statt Markup,
                // heartbeat.js setzt sie nur, solange niemand dort arbeitet.
                account: { username, totpEnabled },
                // Kleinere Bereiche ohne eigene Diff-Logik: heartbeat.js reicht
                // sie an live-regions.js weiter (Schluessel = data-live-region).
                regions: {
                    'nav-count': navCount,
                    'ticket-tab-badge': ticketTabBadge,
                    'ticket-overview': ticketOverview,
                    backups: backupsHtml,
                    'backup-settings': backupSettingsHtml,
                    'upload-replaces': uploadReplacesHtml,
                },
            });
        } catch (err) {
            next(err);
        }
    });

    /*
     * Keepalive fuer public/js/idle-timer.js: wird ausschliesslich durch
     * echte Nutzeraktivitaet (Klick/Taste/Maus, dort throttled) ausgeloest,
     * nie automatisch wie das Heartbeat-Polling oben — checkAuth erneuert
     * lastActivity also tatsaechlich. Keine eigene Nutzlast, nur der
     * Seiteneffekt in checkAuth zaehlt.
     */
    app.get('/admin/ping', checkAuth, pollLimiter, (req, res) => {
        res.status(204).end();
    });

    /* ---------------------------------------------------- Ticketsystem --
       Kundenkonten, Kunden- und Admin-Sicht der Tickets — ausgelagert nach
       lib/routes/, weil der Block allein groesser waere als der Rest dieser
       Datei. Reihenfolge wichtig: registerAccountRoutes() haengt die
       loadCustomer-Middleware ein und stellt checkCustomer bereit, beides
       brauchen die beiden anderen Module. */

    const attachmentUpload = multer({
        dest: TMP_DIR,
        // Browser schicken den Dateinamen als rohes UTF-8 ohne charset-
        // Angabe; busboys Default latin1 machte aus "Größe.png" sonst
        // "GrÃ¶Ãe.png".
        defParamCharset: 'utf8',
        limits: {
            fileSize: attachmentStore.maxBytes,
            files: attachmentStore.maxFiles,
            fields: 30,
            fieldSize: 128 * 1024,
        },
    });

    const ticketContext = {
        app, log, auditLog, sessionStore, checkAuth, renderPartial, checkCustomer: customerAuth.checkCustomer,
        customerStore, ticketStore, configStore, attachmentStore, ticketMail, outbox, mailer, imapPoller,
        attachmentUpload, inboundEnabled, mailEnabled: mailer.enabled, notifyEmail: ticketNotifyEmail || null,
        publicUrl: PUBLIC_URL, kbStore, clock, inboundNewTickets, supportAddress: supportReplyTo || null,
        // ISO-Bezug von Tickets: Auswahlliste der vorhandenen Dateien und
        // Infos (Pruefsumme, Boot) zu einer Datei — null, wenn sie nicht
        // (mehr) existiert.
        listIsoFileNames: async () => (await describeAll()).map(file => file.name).sort((a, b) => a.localeCompare(b, 'de')),
        describeIsoFile: async name => {
            const safe = safeIsoName(name);
            return safe ? describe(safe).catch(() => null) : null;
        },
        // Fuer Routen, die Admin *oder* Kunde bedienen (/attachments/:id) und
        // darum nicht hinter checkAuth haengen: dieselbe Idle-Regel wie dort,
        // nur ohne Seiteneffekte — eine abgelaufene, aber noch nicht
        // zerstoerte Admin-Session zaehlt nicht mehr als Admin.
        isActiveAdmin: req => Boolean(req.session && req.session.loggedIn)
            && Date.now() - (req.session.lastActivity ?? Date.now()) <= IDLE_TIMEOUT_MS,
        // Fallback fuer {agent} in der Grussformel, solange kein eigener
        // Anzeigename unter /admin/ticket-settings hinterlegt ist.
        adminUsername: async () => (await usernameStore.read()) ?? ADMIN_USERNAME,
        limiters: {
            accountPerIp: accountLimiters.perIp,
            accountGlobal: accountLimiters.global,
            customerLoginPerIp: customerLoginLimiters.perIp,
            customerLoginGlobal: customerLoginLimiters.global,
            ticketWritePerIp: ticketWriteLimiters.perIp,
            ticketWriteGlobal: ticketWriteLimiters.global,
            ticketWritePerCustomer,
            poll: pollLimiter,
        },
    };
    registerAccountRoutes(ticketContext);
    registerCustomerTicketRoutes(ticketContext);
    registerAdminTicketRoutes(ticketContext);
    registerKbRoutes(ticketContext);
    registerReportRoutes(ticketContext);

    /* Event-Log-Dashboard (/admin/logs*), siehe lib/routes/event-log.js */
    registerEventLogRoutes({ app, events, auditLog, checkAuth, renderPartial, pollLimiter, clock });

    /* ------------------------------------------- Fortsetzbarer Upload -- */

    function sendUploadError(res, err, log) {
        if (err instanceof UploadError) {
            const body = { error: err.message };
            // Den Serverstand mitschicken: der Client kann damit
            // resynchronisieren, statt von vorn anzufangen.
            if (err.extra.offset !== undefined) body.offset = err.extra.offset;
            if (err.extra.size !== undefined) body.size = err.extra.size;
            return res.status(err.status).json(body);
        }
        log.error('Upload error:', err);
        res.status(500).json({ error: 'Upload fehlgeschlagen.' });
    }

    /*
     * Dedup-Pruefung, gemeinsam fuer den fortsetzbaren und den Multipart-
     * Fallback-Upload: gibt es bereits eine Datei mit exakt dieser
     * Pruefsumme (unter einem anderen Namen als dem Ziel und nicht der per
     * `replaces` explizit zu ersetzenden Datei), ist es ein echtes Duplikat.
     * sha256 ist null, wenn keine mitgelaufene Pruefsumme vorliegt (z. B.
     * Upload-Sitzung ueberlebte einen Serverneustart) — dann faellt die
     * Pruefung fuer diesen einen Upload einfach aus, der Hash-Queue holt die
     * echte Checksumme wie gewohnt im Hintergrund nach.
     */
    async function findDuplicate(sha256, { targetName, replaces }) {
        if (!sha256) return null;
        const matches = (await metadata.findByChecksum(sha256))
            .filter(name => name !== targetName && name !== replaces);
        // Nur Dateien, die noch wirklich in uploads/ liegen — eine
        // verwaiste Metadaten-Zeile (Datei ausserhalb der App geloescht)
        // darf keinen Upload als "Duplikat" abweisen
        for (const name of matches) {
            try {
                if ((await fsp.stat(path.join(UPLOADS_DIR, name))).isFile()) return name;
            } catch {
                // nicht (mehr) vorhanden
            }
        }
        return null;
    }

    /*
     * Loescht die per `replaces` explizit vom Admin ausgewaehlte alte Datei
     * — immer erst NACH dem erfolgreichen Verschieben der neuen, damit ein
     * fehlgeschlagener Upload nie grundlos die alte Version mitreisst.
     * Best-effort: ist die alte Datei inzwischen schon weg, passiert nichts.
     */
    async function replaceOldVersion(replaces, { ip, filename }) {
        if (!replaces) return false;
        const oldPath = path.join(UPLOADS_DIR, replaces);
        if (path.dirname(oldPath) !== UPLOADS_DIR) return false;
        await fsp.rm(oldPath, { force: true });
        await metadata.remove(replaces);
        auditLog.log('upload_replaced', { ip, filename, replaces });
        return true;
    }

    /*
     * Loescht jede der uebergebenen Dateien (samt Metadaten-Zeile) und gibt
     * zurueck, welche davon tatsaechlich existierten — gemeinsame Basis fuer
     * /delete, /delete-bulk und deren /api/v1-Gegenstuecke, damit die
     * Pfadabsicherung (dirname-Check) nur an einer Stelle steht.
     */
    async function deleteFiles(names) {
        const deleted = [];
        for (const name of names) {
            const filePath = path.join(UPLOADS_DIR, name);
            if (path.dirname(filePath) !== UPLOADS_DIR) continue;
            // Kein { force: true }: das wuerde eine fehlende Datei stillschweigend
            // als Erfolg behandeln, obwohl deleted[] laut Dokumentation nur
            // tatsaechlich existierende Dateien enthalten soll (Grundlage fuer
            // den 404-Zweig von DELETE /api/v1/files/:name).
            const before = await metadata.read(name);
            try {
                await fsp.rm(filePath);
            } catch (err) {
                if (err.code === 'ENOENT') continue;
                throw err;
            }
            await metadata.remove(name);
            deleted.push(name);
            // CRUD-Ereignis mit dem Zustand vor dem Loeschen (Checksumme,
            // Downloads, Tags) — das Audit-Ereignis des Aufrufers nennt nur
            // den Namen
            events.record({
                event: 'file_deleted', module: 'files', severity: SEVERITY.INFO, outcome: 'success',
                message: `Datei ${name} gelöscht`,
                payload: {
                    filename: name,
                    before: before ? {
                        size: before.size ?? null, sha256: before.sha256 ?? null, downloads: before.downloads ?? 0,
                        tags: before.tags ?? [], volumeId: before.iso?.volumeId ?? null,
                    } : null,
                },
            });
        }
        return deleted;
    }

    /*
     * Entfernt einen einzelnen Tag und pflegt removedAutoTags nach, falls es
     * ein Auto-Tag war (siehe lib/auto-tags.js) — gemeinsame Basis fuer
     * DELETE /files/:name/tags/:tag und dessen /api/v1-Gegenstueck.
     */
    async function removeTag(filename, tag) {
        const meta = await metadata.read(filename);
        const existing = meta?.tags ?? [];
        const tags = existing.filter(t => t.toLowerCase() !== tag.toLowerCase());
        if (tags.length === existing.length) return { tags, changed: false };

        const autoTags = meta?.autoTags ?? [];
        const wasAutoTag = autoTags.some(t => t.toLowerCase() === tag.toLowerCase());
        const patch = { tags };
        if (wasAutoTag) {
            patch.autoTags = autoTags.filter(t => t.toLowerCase() !== tag.toLowerCase());
            const removedAuto = meta?.removedAutoTags ?? [];
            if (!removedAuto.some(t => t.toLowerCase() === tag.toLowerCase())) {
                patch.removedAutoTags = [...removedAuto, tag];
            }
        }
        await metadata.update(filename, patch);
        return { tags, changed: true, changes: diff({ tags: existing }, { tags }) };
    }

    app.post('/upload/init', checkAuth, async (req, res) => {
        try {
            const state = await uploadSessions.create({
                name: req.body.name,
                size: Number(req.body.size),
                replaces: req.body.replaces,
            });
            res.status(201).json(state);
        } catch (err) {
            sendUploadError(res, err, log);
        }
    });

    app.get('/upload/:id', checkAuth, async (req, res) => {
        const id = safeUploadId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Ungültige Upload-ID.' });
        try {
            res.json(await uploadSessions.get(id));
        } catch (err) {
            sendUploadError(res, err, log);
        }
    });

    // Der Request-Stream geht direkt in die .part-Datei; nichts wird im
    // Speicher gepuffert, darum sind auch grosse Chunks unkritisch.
    app.patch('/upload/:id', checkAuth, async (req, res) => {
        const id = safeUploadId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Ungültige Upload-ID.' });

        const header = req.get('upload-offset');
        const claimed = /^\d+$/.test(String(header ?? '')) ? Number(header) : NaN;

        try {
            const state = await uploadSessions.append(id, claimed, req);
            res.json({
                offset: state.offset,
                size: state.size,
                complete: state.complete,
            });
        } catch (err) {
            sendUploadError(res, err, log);
        }
    });

    app.post('/upload/:id/finish', checkAuth, async (req, res) => {
        const id = safeUploadId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Ungültige Upload-ID.' });
        try {
            const session = await uploadSessions.get(id);
            const duplicateOf = await findDuplicate(uploadSessions.pendingHash(id), {
                targetName: session.name, replaces: session.replaces,
            });
            if (duplicateOf) {
                await uploadSessions.abort(id);
                return res.status(409).json({
                    error: `Identischer Inhalt liegt bereits als „${duplicateOf}“ vor.`,
                    duplicateOf,
                });
            }

            const { filename, replaces } = await uploadSessions.finish(id);
            // Checksumme und Volume-Infos laufen im Hintergrund nach
            hashQueue.enqueue(filename);
            auditLog.log('upload', { ip: req.ip, filename });
            const replaced = await replaceOldVersion(replaces, { ip: req.ip, filename });
            res.status(201).json({ filename, replaced: replaced ? replaces : null });
        } catch (err) {
            sendUploadError(res, err, log);
        }
    });

    app.delete('/upload/:id', checkAuth, async (req, res) => {
        const id = safeUploadId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Ungültige Upload-ID.' });
        await uploadSessions.abort(id);
        res.status(204).end();
    });

    /* ------------------------------------------- Upload ohne JavaScript -- */

    app.post('/upload', checkAuth, (req, res) => {
        const wantsJson = req.accepts(['html', 'json']) === 'json';
        const fail = (status, message) => {
            if (wantsJson) return res.status(status).json({ error: message });
            return res.status(status).send(message);
        };

        /*
         * Vor dem Annehmen des Bodys: passt die Datei laut Content-Length
         * ueberhaupt noch aufs Volume? (Beim chunked Upload prueft das
         * uploadSessions.create() anhand der angekuendigten Groesse.) Ohne
         * Content-Length greift nur das multer-Groessenlimit.
         */
        const announced = Number(req.get('content-length'));
        const spaceCheck = Number.isFinite(announced) && announced > 0
            ? uploadSessions.assertDiskSpace(announced)
            : Promise.resolve();

        spaceCheck.then(() => upload.single('file')(req, res, async err => {
            if (err) {
                if (err.code === 'LIMIT_FILE_SIZE') {
                    return fail(413, `Datei überschreitet ${MAX_FILE_SIZE_MB} MB.`);
                }
                log.error('Upload error:', err);
                return fail(400, 'Upload fehlgeschlagen.');
            }

            const file = req.file;
            if (!file) {
                return fail(400, 'Keine Datei empfangen.');
            }

            const filename = safeIsoName(file.originalname);
            if (!filename) {
                await fsp.rm(file.path, { force: true });
                return fail(400, 'Ungültiger Name — nur .iso-Dateien sind erlaubt.');
            }

            const requestedReplaces = safeIsoName(req.body.replaces);
            const replaces = requestedReplaces && requestedReplaces !== filename
                ? requestedReplaces : null;

            try {
                // Kein mitlaufender Hasher wie beim Chunk-Upload (der
                // Multipart-Fallback ist der No-JS-Pfad, keine Streaming-
                // Chunks) — die Datei liegt schon komplett im temp-Verzeichnis,
                // also einmal durchhashen, bevor sie nach uploads/ zieht.
                const sha256 = await sha256OfFile(file.path);
                const duplicateOf = await findDuplicate(sha256, { targetName: filename, replaces });
                if (duplicateOf) {
                    await fsp.rm(file.path, { force: true });
                    return fail(409, `Identischer Inhalt liegt bereits als „${duplicateOf}“ vor.`);
                }

                await fsp.mkdir(UPLOADS_DIR, { recursive: true });
                await moveFile(file.path, path.join(UPLOADS_DIR, filename));
            } catch (moveErr) {
                log.error('Upload move error:', moveErr);
                await fsp.rm(file.path, { force: true });
                return fail(500, 'Datei konnte nicht gespeichert werden.');
            }

            hashQueue.enqueue(filename);
            auditLog.log('upload', { ip: req.ip, filename });
            // Dieser Callback ist async, multer wartet aber nicht auf ihn — ein
            // Fehler hier waere sonst eine unbehandelte Rejection (und damit
            // ein Prozessende ueber installProcessHandlers)
            let replaced = false;
            try {
                replaced = await replaceOldVersion(replaces, { ip: req.ip, filename });
            } catch (replaceErr) {
                log.error('Alte Version konnte nicht entfernt werden:', replaceErr);
            }

            if (wantsJson) return res.status(201).json({ filename, replaced: replaced ? replaces : null });
            res.redirect('/admin-upload');
        }), err => {
            // Den ungelesenen Body nicht mehr annehmen
            res.set('Connection', 'close');
            if (err instanceof UploadError) return fail(err.status, err.message);
            log.error('Upload error:', err);
            return fail(500, 'Upload fehlgeschlagen.');
        });
    });

    app.post('/delete', checkAuth, async (req, res, next) => {
        const filename = safeIsoName(req.body.filename);
        if (!filename) {
            return res.status(400).send('Ungültiger Dateiname.');
        }
        try {
            await deleteFiles([filename]);
        } catch (err) {
            return next(err);
        }
        auditLog.log('delete', { ip: req.ip, filename });
        res.redirect('/admin-upload');
    });

    /* ------------------------------------------------- Bulk-Aktionen --
       Mehrfachauswahl in der Dateitabelle (public/js/bulk-actions.js):
       gemeinsamer ZIP-Download fuer beide Ansichten, Loeschen nur im
       Admin-Bereich. Beide Routen nehmen dieselbe { names: string[] }-Form
       und wenden dieselbe safeIsoName()-Pruefung wie /download bzw. /delete
       auf jeden Eintrag an — Mehrfachauswahl aendert nichts an den
       Sicherheitsanforderungen an einen einzelnen Dateinamen. */

    app.post('/download-zip', downloadLimiter, async (req, res) => {
        const requested = Array.isArray(req.body?.names) ? req.body.names : [];
        const names = [...new Set(requested.map(safeIsoName).filter(Boolean))];
        if (names.length === 0) {
            return res.status(400).json({ error: 'Keine gültigen Dateien ausgewählt.' });
        }
        if (names.length > MAX_BULK_FILES) {
            return res.status(400).json({ error: `Höchstens ${MAX_BULK_FILES} Dateien auf einmal.` });
        }

        const files = [];
        for (const name of names) {
            try {
                const filePath = path.join(UPLOADS_DIR, name);
                const stats = await fsp.stat(filePath);
                if (stats.isFile()) files.push({ name, path: filePath, size: stats.size, mtime: stats.mtime });
            } catch {
                // Fehlende Datei stillschweigend uebersprungen — die Auswahl im
                // Browser kann seit dem letzten Laden veraltet sein.
            }
        }
        if (files.length === 0) {
            return res.status(404).json({ error: 'Keine der ausgewählten Dateien wurde gefunden.' });
        }

        // Vorab pruefen statt mittendrin abbrechen, siehe lib/zip-stream.js.
        const totalSize = files.reduce((sum, file) => sum + file.size, 0);
        const headerOverheadEstimate = files.length * 1024;
        if (!files.every(file => fitsInClassicZip(file.size))
            || totalSize + headerOverheadEstimate > 0xFFFFFFFF) {
            return res.status(413).json({
                error: 'Auswahl zu groß für ein ZIP-Archiv (Format-Limit 4 GiB) — bitte in kleineren Gruppen herunterladen.',
            });
        }

        res.type('application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="iso-share-${Date.now()}.zip"`);

        try {
            await writeZip(res, files, { parts: clock.parts });
            files.forEach(file => metadata.recordDownload(file.name));
        } catch (err) {
            // Mitten im Stream — Header sind schon raus, es kann kein
            // Fehlerstatus mehr folgen. Best-effort: Verbindung beenden.
            log.error('ZIP-Download-Fehler:', err);
        } finally {
            res.end();
        }
    });

    app.post('/delete-bulk', checkAuth, async (req, res, next) => {
        const requested = Array.isArray(req.body?.names) ? req.body.names : [];
        const names = [...new Set(requested.map(safeIsoName).filter(Boolean))];
        if (names.length === 0) {
            return res.status(400).json({ error: 'Keine gültigen Dateien ausgewählt.' });
        }
        if (names.length > MAX_BULK_FILES) {
            return res.status(400).json({ error: `Höchstens ${MAX_BULK_FILES} Dateien auf einmal.` });
        }

        let deleted;
        try {
            deleted = await deleteFiles(names);
        } catch (err) {
            return next(err);
        }

        auditLog.log('bulk_delete', { ip: req.ip, count: deleted.length, names: deleted });
        res.json({ deleted });
    });

    /* ------------------------------------------------------------- Tags --
       Freitext-Kategorien je Datei, im metadata-Sidecar gespeichert
       (metadata.update() ist ein Merge-Patch, tags braucht darum keine
       Aenderung in lib/metadata.js). Tags werden ausschliesslich automatisch
       von lib/hash-queue.js (siehe lib/auto-tags.js) aus dem ISO selbst
       vergeben — es gibt bewusst keine Route zum manuellen Hinzufuegen mehr,
       nur zum Entfernen eines einzelnen (falschen) Auto-Tags, JS-only wie
       /webauthn/credentials/:id und /delete-bulk. Ein entfernter Auto-Tag
       landet in removedAutoTags, damit der naechste Rescan ihn nicht wieder
       anhaengt (siehe lib/auto-tags.js). */

    app.delete('/files/:name/tags/:tag', checkAuth, async (req, res, next) => {
        const filename = safeIsoName(req.params.name);
        const tag = safeTag(req.params.tag);
        if (!filename || !tag) {
            return res.status(400).json({ error: 'Ungültige Anfrage.' });
        }

        try {
            const { tags, changed, changes } = await removeTag(filename, tag);
            if (changed) {
                auditLog.log('tag_removed', { ip: req.ip, filename, tag, changes });
            }
            res.json({ tags });
        } catch (err) {
            next(err);
        }
    });

    /* ================================================================
       /api/v1 — versionierte JSON-API fuer Skripte/CI.

       Lese-Endpunkte bleiben oeffentlich, aus demselben Grund wie
       /api/files.json oben: die Daten stehen ohnehin auf der oeffentlichen
       Startseite. Schreib-Endpunkte und der Audit-Log-Endpunkt verlangen ein
       Bearer-Token (siehe checkApiToken oben). Antworten folgen einem
       einheitlichen Envelope — { data, meta? } bei Erfolg, { error, code }
       bei Fehlern — anders als die alten /api/*.json-Routen, die aus
       Kompatibilitaetsgruenden unveraendert bleiben.
       ================================================================ */

    app.use('/api/v1', apiLimiter);

    function sendApiUploadError(res, err) {
        if (err instanceof UploadError) {
            const body = { error: err.message, code: err.status === 507 ? 'insufficient_storage' : 'upload_error' };
            if (err.extra.offset !== undefined) body.offset = err.extra.offset;
            if (err.extra.size !== undefined) body.size = err.extra.size;
            return res.status(err.status).json(body);
        }
        log.error('API-Upload-Fehler:', err);
        res.status(500).json({ error: 'Upload fehlgeschlagen.', code: 'server_error' });
    }

    app.get('/api/v1/files', async (req, res, next) => {
        try {
            const query = String(req.query.q || '').slice(0, 200);
            const tag = String(req.query.tag || '').toLowerCase();
            const sorter = API_SORTERS[req.query.sort] ?? API_SORTERS.name;

            let files = await listFiles(query);
            if (tag) files = files.filter(file => file.tags.some(t => t.toLowerCase() === tag));
            files = [...files].sort(sorter);

            res.json(paginate(files, parsePageParams(req.query)));
        } catch (err) {
            next(err);
        }
    });

    app.get('/api/v1/files/:name', async (req, res, next) => {
        const filename = safeIsoName(req.params.name);
        if (!filename) {
            return res.status(400).json({ error: 'Ungültiger Dateiname.', code: 'invalid_name' });
        }
        try {
            await fsp.access(path.join(UPLOADS_DIR, filename));
        } catch {
            return res.status(404).json({ error: 'Datei nicht gefunden.', code: 'not_found' });
        }
        try {
            res.json({ data: await describe(filename) });
        } catch (err) {
            next(err);
        }
    });

    app.get('/api/v1/tags', async (req, res, next) => {
        try {
            res.json({ data: await listAllTags() });
        } catch (err) {
            next(err);
        }
    });

    app.get('/api/v1/checksums', async (req, res, next) => {
        try {
            const files = await listFiles();
            res.json({
                data: files
                    .filter(file => file.sha256)
                    .map(file => ({ name: file.name, sha256: file.sha256 })),
            });
        } catch (err) {
            next(err);
        }
    });

    app.get('/api/v1/audit-log', checkApiToken('read'), async (req, res, next) => {
        try {
            const entries = await auditLog.read({ limit: Infinity });
            res.json(paginate(entries, parsePageParams(req.query)));
        } catch (err) {
            next(err);
        }
    });

    /* -------------------------------------------------- Uploads (write) --
       Identisches Protokoll wie /upload/init + Freunde (siehe
       lib/chunked-upload.js) — nur die Auth wechselt von checkAuth auf ein
       Bearer-Token mit write-Scope, und die Antworten kommen im API-Envelope. */

    app.post('/api/v1/uploads', checkApiToken('write'), async (req, res) => {
        try {
            const state = await uploadSessions.create({
                name: req.body.name,
                size: Number(req.body.size),
                replaces: req.body.replaces,
            });
            res.status(201).json({ data: state });
        } catch (err) {
            sendApiUploadError(res, err);
        }
    });

    app.get('/api/v1/uploads/:id', checkApiToken('write'), async (req, res) => {
        const id = safeUploadId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Ungültige Upload-ID.', code: 'invalid_id' });
        try {
            res.json({ data: await uploadSessions.get(id) });
        } catch (err) {
            sendApiUploadError(res, err);
        }
    });

    app.patch('/api/v1/uploads/:id', checkApiToken('write'), async (req, res) => {
        const id = safeUploadId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Ungültige Upload-ID.', code: 'invalid_id' });

        const header = req.get('upload-offset');
        const claimed = /^\d+$/.test(String(header ?? '')) ? Number(header) : NaN;

        try {
            const state = await uploadSessions.append(id, claimed, req);
            res.json({ data: { offset: state.offset, size: state.size, complete: state.complete } });
        } catch (err) {
            sendApiUploadError(res, err);
        }
    });

    app.post('/api/v1/uploads/:id/finish', checkApiToken('write'), async (req, res) => {
        const id = safeUploadId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Ungültige Upload-ID.', code: 'invalid_id' });
        try {
            const session = await uploadSessions.get(id);
            const duplicateOf = await findDuplicate(uploadSessions.pendingHash(id), {
                targetName: session.name, replaces: session.replaces,
            });
            if (duplicateOf) {
                await uploadSessions.abort(id);
                return res.status(409).json({
                    error: `Identischer Inhalt liegt bereits als „${duplicateOf}“ vor.`,
                    code: 'duplicate',
                    duplicateOf,
                });
            }

            const { filename, replaces } = await uploadSessions.finish(id);
            hashQueue.enqueue(filename);
            auditLog.log('upload', { ip: req.ip, filename, via: 'api', tokenId: req.apiToken.id });
            const replaced = await replaceOldVersion(replaces, { ip: req.ip, filename });
            res.status(201).json({ data: { filename, replaced: replaced ? replaces : null } });
        } catch (err) {
            sendApiUploadError(res, err);
        }
    });

    app.delete('/api/v1/uploads/:id', checkApiToken('write'), async (req, res) => {
        const id = safeUploadId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Ungültige Upload-ID.', code: 'invalid_id' });
        await uploadSessions.abort(id);
        res.status(204).end();
    });

    /* --------------------------------------------------- Delete/Tags (write) -- */

    app.delete('/api/v1/files/:name', checkApiToken('write'), async (req, res, next) => {
        const filename = safeIsoName(req.params.name);
        if (!filename) {
            return res.status(400).json({ error: 'Ungültiger Dateiname.', code: 'invalid_name' });
        }
        let deleted;
        try {
            deleted = await deleteFiles([filename]);
        } catch (err) {
            return next(err);
        }
        if (deleted.length === 0) {
            return res.status(404).json({ error: 'Datei nicht gefunden.', code: 'not_found' });
        }
        auditLog.log('delete', { ip: req.ip, filename, via: 'api', tokenId: req.apiToken.id });
        res.status(204).end();
    });

    app.post('/api/v1/files/bulk-delete', checkApiToken('write'), async (req, res, next) => {
        const requested = Array.isArray(req.body?.names) ? req.body.names : [];
        const names = [...new Set(requested.map(safeIsoName).filter(Boolean))];
        if (names.length === 0) {
            return res.status(400).json({ error: 'Keine gültigen Dateien ausgewählt.', code: 'invalid_name' });
        }
        if (names.length > MAX_BULK_FILES) {
            return res.status(400).json({
                error: `Höchstens ${MAX_BULK_FILES} Dateien auf einmal.`, code: 'too_many_files',
            });
        }

        let deleted;
        try {
            deleted = await deleteFiles(names);
        } catch (err) {
            return next(err);
        }

        auditLog.log('bulk_delete', {
            ip: req.ip, count: deleted.length, names: deleted, via: 'api', tokenId: req.apiToken.id,
        });
        res.json({ data: { deleted } });
    });

    app.delete('/api/v1/files/:name/tags/:tag', checkApiToken('write'), async (req, res, next) => {
        const filename = safeIsoName(req.params.name);
        const tag = safeTag(req.params.tag);
        if (!filename || !tag) {
            return res.status(400).json({ error: 'Ungültige Anfrage.', code: 'invalid_request' });
        }
        try {
            const { tags, changed, changes } = await removeTag(filename, tag);
            if (changed) {
                auditLog.log('tag_removed', {
                    ip: req.ip, filename, tag, changes, via: 'api', tokenId: req.apiToken.id,
                });
            }
            res.json({ data: { tags } });
        } catch (err) {
            next(err);
        }
    });

    app.get('/logout', (req, res) => {
        // ?idle=1 kommt von public/js/idle-timer.js, wenn der clientseitige
        // Countdown abgelaufen ist (oder der Keepalive-Ping mit 401
        // antwortet) — derselbe Fall wie der serverseitige Idle-Timeout in
        // checkAuth oben, nur clientseitig erkannt, bevor ein weiterer
        // admin-Request den Server selbst dazu bringen wuerde. Landet daher
        // ebenfalls auf /login?idle=1 statt auf '/', sonst faehrt der Nutzer
        // ohne jede Meldung auf der oeffentlichen Startseite auf.
        const idle = req.query.idle === '1';
        if (idle) {
            auditLog.log('session_idle_timeout', { ip: req.ip });
        }
        req.session.destroy(() => {
            res.clearCookie('iso.sid');
            res.redirect(idle ? '/login?idle=1' : '/');
        });
    });

    app.get('/privacy', (req, res) => {
        res.render('privacy', { loggedIn: Boolean(req.session && req.session.loggedIn) });
    });

    app.get('/imprint', (req, res) => {
        res.render('imprint', { loggedIn: Boolean(req.session && req.session.loggedIn) });
    });

    app.get('/search', async (req, res, next) => {
        const query = String(req.query.q || '').slice(0, 200);
        try {
            const [files, allTags] = await Promise.all([listFiles(query), listAllTags()]);
            res.render('index', {
                files,
                allTags,
                searchQuery: query,
                loggedIn: Boolean(req.session && req.session.loggedIn),
            });
        } catch (err) {
            next(err);
        }
    });

    app.get('/admin-search', checkAuth, async (req, res, next) => {
        const query = String(req.query.q || '').slice(0, 200);
        try {
            res.render('admin', { ...(await adminPageData({ query })), searchQuery: query });
        } catch (err) {
            next(err);
        }
    });

    /* ------------------------------------------------- Fehlerbehandlung --
       Nie Stacktraces nach aussen. */

    app.use((req, res) => {
        if (req.path.startsWith('/api/v1/')) {
            return res.status(404).json({ error: 'Nicht gefunden.', code: 'not_found' });
        }
        res.status(404).send('Nicht gefunden');
    });

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        events.record({
            event: 'unhandled_error', module: moduleForPath(req.path), severity: SEVERITY.ERROR,
            outcome: 'failure', error: err, req,
        });
        httpConsole.error('Unhandled error:', err, { reqId: req.id, method: req.method, path: req.path });
        if (res.headersSent) return next(err);
        if (req.path.startsWith('/api/v1/')) {
            return res.status(500).json({ error: 'Serverfehler.', code: 'server_error' });
        }
        res.status(500).send('Serverfehler');
    });

    /* -------------------------------------------------- Hintergrundlauf -- */

    const timers = [];

    if (sweepStaleUploads) {
        const sweep = setInterval(() => {
            events.job('upload-cleanup', () => uploadSessions.cleanupStale(), { quiet: true }).catch(() => {});
        }, STALE_UPLOAD_SWEEP_MS);
        if (typeof sweep.unref === 'function') sweep.unref();
        timers.push(sweep);
    }

    /*
     * Anders als der feste sweep-Timer oben neu einplanbar: /admin/backup-
     * settings ruft das nach jeder Aenderung erneut auf, damit ein neues
     * Intervall sofort greift, ohne die App neu zu starten — genau die vom
     * Nutzer gewuenschte Einstellbarkeit.
     */
    let backupTimer = null;
    function armBackupTimer() {
        if (backupTimer) clearInterval(backupTimer);
        const settings = backupStore.readSettings();
        if (!settings.enabled) {
            backupTimer = null;
            return;
        }
        backupTimer = setInterval(() => {
            events.job('backup', async () => {
                const backup = await backupStore.createBackup('scheduled');
                return { file: backup.file, size: backup.size };
            }, { module: 'backup' }).catch(err => {
                log.error('Geplante Sicherung fehlgeschlagen:', err.message);
            });
        }, settings.intervalMinutes * 60 * 1000);
        if (typeof backupTimer.unref === 'function') backupTimer.unref();
    }
    armBackupTimer();

    // Mail-Outbox, IMAP-Abruf und Ticket-Automatik (Erinnerungen, Auto-
    // Loesen/-Schliessen). Tests schalten die Worker ab und stossen sie bei
    // Bedarf direkt an (services.outbox.processDue(), ticketAutomation.runOnce()).
    if (startMailWorkers) {
        outbox.start();
        imapPoller.start();
        const automationTimer = setInterval(() => {
            events.job('ticket-automation', async () => {
                const result = ticketAutomation.runOnce();
                customerStore.purgeExpiredTokens();
                return result;
            }, { quiet: true }).catch(err => {
                log.error('Ticket-Automatik fehlgeschlagen:', err.message);
            });
        }, ticketAutomationIntervalMs);
        if (typeof automationTimer.unref === 'function') automationTimer.unref();
        timers.push(automationTimer);
    }

    /* Loeschfristen und SQLite-Pflege — Fehler werden nur geloggt, ein
       fehlgeschlagener Lauf wird eine Stunde spaeter wiederholt. */
    async function runMaintenance() {
        try {
            await events.job('retention', () => retention.runOnce());
        } catch (err) {
            log.error('Löschfristen fehlgeschlagen:', err);
        }
        try {
            await events.job('mail-inbound-cleanup', async () => {
                const orphans = await attachmentStore.sweepOrphans();
                const pruned = inboundStore.prune();
                if (orphans > 0) log.info(`${orphans} verwaiste Anhang-Datei(en) entfernt`, { event: 'attachment_orphans_removed', orphans });
                return { orphans, pruned };
            }, { module: 'tickets', quiet: true });
        } catch (err) {
            log.error('Aufräumen von Anhängen/Mail-Eingang fehlgeschlagen:', err);
        }
        try {
            await events.job('event-log-purge', () => events.purge());
        } catch (err) {
            log.error('Bereinigung des Event-Logs fehlgeschlagen:', err);
        }
        try {
            await events.job('db-maintenance', async () => {
                maintainDatabase(db);
                events.maintain();
            }, { module: 'database', quiet: true });
        } catch (err) {
            log.error('Datenbank-Pflege fehlgeschlagen:', err);
        }
    }
    if (maintenanceIntervalMs > 0) {
        const maintenanceTimer = setInterval(() => { runMaintenance(); }, maintenanceIntervalMs);
        if (typeof maintenanceTimer.unref === 'function') maintenanceTimer.unref();
        timers.push(maintenanceTimer);
    }

    async function start() {
        await fsp.mkdir(UPLOADS_DIR, { recursive: true });
        await fsp.mkdir(TMP_DIR, { recursive: true });

        // Einmaliger Best-Effort-Import aus dem alten JSON-Dateien-Stand,
        // falls hier noch welcher liegt (siehe lib/migrate-legacy.js). Greift
        // nur auf leere Tabellen, macht also bei jedem weiteren Start nichts.
        await migrateLegacyData({
            db, uploadsDir: UPLOADS_DIR, dataDir: DATA_DIR, tmpDir: TMP_DIR, log,
        });

        // Audit-Eintraege aus der Zeit vor dem Event-Log (Tabelle audit_log
        // der Haupt-DB, dorthin importiert auch migrateLegacyData) einmalig
        // uebernehmen — danach ist die Tabelle leer und das hier ein No-op
        const importedAudit = events.importLegacyAudit(db);
        if (importedAudit > 0) {
            log.log(`📦 ${importedAudit} Audit-Log-Einträge ins Event-Log übernommen.`);
        }

        // Bootstrap: existiert noch kein persistiertes Passwort, wird der
        // wirksame Wert sofort persistiert — ADMIN_PASSWORD, falls gesetzt,
        // sonst ein frisch generiertes. Ab hier gewinnt in jedem Fall die DB
        // (siehe Kommentar oben bei den Secrets); eine spaeter gesetzte oder
        // geaenderte ADMIN_PASSWORD-Env-Var hat danach keine Wirkung mehr.
        if (!(await passwordStore.read())) {
            if (ADMIN_PASSWORD) {
                await passwordStore.setPassword(ADMIN_PASSWORD);
            } else {
                const generated = crypto.randomBytes(18).toString('base64url');
                await passwordStore.setPassword(generated);
                log.warn(
                    '\n⚠️  Kein ADMIN_PASSWORD gesetzt. Einmalig generiertes Passwort ' +
                    `(dauerhaft gespeichert in ${path.join(DATA_DIR, 'iso-share.db')}):\n` +
                    `    ${generated}\n` +
                    '    Wird bei einem Neustart NICHT erneut angezeigt. Ändern jederzeit\n' +
                    '    unter /admin-upload.\n'
                );
            }
        }

        // Derselbe Bootstrap fuer den Benutzernamen: der wirksame Wert
        // (ADMIN_USERNAME/Default 'admin') wird beim ersten Start
        // persistiert, danach gewinnt die DB — genau wie beim Passwort.
        if (!(await usernameStore.read())) {
            await usernameStore.write(ADMIN_USERNAME);
        }
        currentAdminName = (await usernameStore.read()) ?? ADMIN_USERNAME;

        await uploadSessions.cleanupStale().catch(() => {});
        if (maintenanceIntervalMs > 0) await runMaintenance();
        if (scanOnStart) {
            const missing = await hashQueue.scanAll();
            if (missing > 0) {
                log.log(`🔢 ${missing} Datei(en) ohne Checksumme — wird im Hintergrund berechnet.`);
            }
        }
    }

    /*
     * Timer abbauen, Datenbank schliessen. Alle Schreibvorgaenge in den
     * Stores oben sind synchrone SQLite-Operationen — es gibt nichts mehr im
     * Speicher zu puffern oder "settled" abzuwarten.
     */
    async function stop() {
        timers.forEach(clearInterval);
        outbox.stop();
        imapPoller.stop();
        await outbox.whenIdle().catch(() => {});
        if (backupTimer) clearInterval(backupTimer);
        try {
            sessionStore.close();
            db.close();
        } finally {
            // Zuletzt und auch dann, wenn die Haupt-DB schon zu war (nach
            // einem Restore): schreibt die Queue weg und gibt events.db frei
            log.detachSink?.();
            events.close();
        }
    }

    return {
        app,
        start,
        stop,
        // fuer Tests und /healthz
        services: {
            db, metadata, hashQueue, uploadSessions, sessionStore,
            webauthnStore, passwordStore, usernameStore, totpStore, auditLog, listFiles,
            apiTokenStore, backupStore, ticketStore, mailer, customerStore, configStore, attachmentStore,
            outbox, ticketMail, inboundProcessor, imapPoller, ticketAutomation, retention, events, kbStore,
        },
    };
}

/* ==========================================================================
   Prozessstart — nur wenn direkt aufgerufen, nicht beim require aus Tests
   ========================================================================== */

if (require.main === module) {
    // Lokale Konfiguration aus .env laden (Node-Bordmittel, keine
    // dotenv-Dependency). Bereits gesetzte Umgebungsvariablen — etwa die von
    // docker-compose.yml — behalten Vorrang; die .env selbst landet per
    // .dockerignore nie im Image. Fehlt die Datei, laeuft alles wie bisher.
    try {
        process.loadEnvFile(path.join(__dirname, '.env'));
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.error('⚠️  .env konnte nicht gelesen werden:', err.message);
        }
    }

    const PORT = process.env.PORT || 3000;
    const log = createLogger({
        format: process.env.LOG_FORMAT || undefined,
        level: process.env.LOG_LEVEL || 'info',
        // Detailmeldungen der Module (Requests, Mails, Jobs) erst ab diesem
        // Level auf der Konsole; im Event-Log (/admin/logs) stehen sie immer
        detailLevel: process.env.LOG_CONSOLE_LEVEL || 'warn',
    });

    let instance;
    try {
        instance = createApp({ log });
    } catch (err) {
        // Z. B. ungueltige Konfiguration (lib/config-check.js) oder ein zu
        // neues DB-Schema (lib/db.js) — die Meldung sagt, was zu tun ist
        log.error('Start fehlgeschlagen:', err);
        process.exit(1);
    }

    instance.start()
        .then(() => {
            const server = instance.app.listen(PORT, () => {
                log.info(`🚀 Server läuft auf Port ${PORT}`, { port: Number(PORT), version: APP_VERSION });
            });
            // Laenger als das Keep-alive des Reverse Proxys, sonst schliesst
            // Node eine Verbindung, die der Proxy gerade wiederverwenden will
            // (sporadische 502). Caddy/nginx nutzen 60 s bzw. weniger.
            server.keepAliveTimeout = 65_000;
            server.headersTimeout = 66_000;

            const shutdown = createShutdown({
                server,
                stop: () => instance.stop(),
                log,
                timeoutMs: envNumber('SHUTDOWN_TIMEOUT_MS', 30_000),
            });
            installProcessHandlers({ shutdown, log });
        })
        .catch(err => {
            log.error('Start fehlgeschlagen:', err);
            process.exit(1);
        });
}

module.exports = { createApp };
