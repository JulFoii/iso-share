'use strict';

/*
 * Ausgehende Mails als Warteschlange in der Tabelle `mail_outbox` (siehe
 * lib/db.js). Jede Mail wird zuerst gespeichert und dann von einem kleinen
 * Worker verschickt — so geht bei einem SMTP-Ausfall oder Neustart nichts
 * verloren, und ein Request-Handler wartet nie auf einen langsamen
 * Mailserver.
 *
 * Fehler werden nach classifyError() unterschieden:
 *   - endgueltig (5xx: Postfach existiert nicht, Mail als Spam abgelehnt):
 *     sofort 'failed' — sieben Wiederholungen ueber zehn Stunden aendern an
 *     einem "550 no such user" nichts.
 *   - voruebergehend fuer diesen Empfaenger (4xx, z. B. GMX' "450 … Try
 *     again later", wenn zu viele Mails in kurzer Zeit an ein Postfach
 *     gehen): Wiederholung mit wachsendem Abstand (BACKOFF_MS). Alle anderen
 *     faelligen Mails an dieselbe Adresse werden mit zurueckgestellt, ohne
 *     einen Versuch zu verbrauchen — sofort weiterzusenden wuerde die
 *     Drosselung beim Provider nur verlaengern.
 *   - Server/Verbindung/Anmeldung (ECONNECTION, EAUTH, 421 …): betrifft jede
 *     Mail gleich, also wird die ganze Warteschlange pausiert statt dass
 *     jede Mail einzeln ihre Versuche verbraucht.
 * Nach MAX_ATTEMPTS gilt eine Mail als 'failed' und taucht im Admin-Bereich
 * (/admin/ticket-settings) mit Fehlermeldung auf, von wo sie sich erneut
 * anstossen laesst. Zwischen zwei Mails liegt mindestens sendIntervalMs,
 * damit ein Schwall (Sammelaktion, mehrere Antworten hintereinander) beim
 * Provider nicht als Spam-Welle ankommt. Verschickte Mails werden nach
 * SENT_RETENTION_MS aufgeraeumt — die Outbox ist kein Mailarchiv.
 *
 * Ist der Mailversand deaktiviert (kein SMTP_HOST, siehe lib/mailer.js),
 * legt enqueue() nichts an: eine Warteschlange, die nie abgearbeitet werden
 * kann, waere nur ein wachsender Stapel personenbezogener Daten.
 *
 * Anhaenge: gespeichert werden nur die IDs der Ticket-Anhaenge
 * (attachments_json), nie die Bytes — erst sendOne() loest sie ueber das
 * injizierte resolveAttachments() in Dateipfade auf. Ist ein Anhang
 * inzwischen geloescht (Ticket geloescht), fehlt er einfach in der Mail,
 * statt den Versand scheitern zu lassen.
 */

const BACKOFF_MS = [60e3, 5 * 60e3, 15 * 60e3, 60 * 60e3, 3 * 60 * 60e3, 6 * 60 * 60e3];
const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
const SENT_RETENTION_MS = 30 * 24 * 60 * 60e3;

const SERVER_ERROR_CODES = new Set([
    'EAUTH', 'ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ETLS', 'ECONNREFUSED', 'ECONNRESET', 'EPROTOCOL',
]);

function smtpCode(err) {
    const direct = Number(err?.responseCode);
    if (direct) return direct;
    const rejected = err?.rejectedErrors?.find(entry => Number(entry?.responseCode));
    return rejected ? Number(rejected.responseCode) : 0;
}

/* 'permanent' | 'recipient' (voruebergehend, nur diese Adresse) | 'server'
   (betrifft alle Mails). Unbekannte Fehler gelten als voruebergehend — lieber
   einmal zu oft wiederholen als eine Mail still verlieren. */
function classifyError(err) {
    const code = smtpCode(err);
    if (SERVER_ERROR_CODES.has(err?.code) || code === 421 || code === 454 || code === 530 || code === 535) {
        return 'server';
    }
    if (code >= 500 && code < 600) return 'permanent';
    return 'recipient';
}

function defaultFormatTime(ms) {
    return new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function rowToMail(row) {
    let headers = {};
    try {
        headers = JSON.parse(row.headers_json || '{}');
    } catch {
        headers = {};
    }
    let attachments = [];
    try {
        const parsed = JSON.parse(row.attachments_json || '[]');
        attachments = Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
        attachments = [];
    }
    return {
        id: row.id,
        kind: row.kind,
        to: row.to_addr,
        subject: row.subject,
        text: row.text_body,
        html: row.html_body,
        headers,
        attachments,
        ticketId: row.ticket_id,
        status: row.status,
        attempts: row.attempts,
        lastError: row.last_error,
        nextAttemptAt: row.next_attempt_at,
        createdAt: row.created_at,
        sentAt: row.sent_at,
    };
}

function createMailOutbox({
    db, mailer, log = console, auditLog = null, sendIntervalMs = 0, formatTime = defaultFormatTime,
    resolveAttachments = null,
}) {
    if (!db) throw new Error('mail outbox braucht eine db');

    const insertStmt = db.prepare(`
        INSERT INTO mail_outbox (kind, to_addr, subject, text_body, html_body, headers_json, ticket_id,
                                 attachments_json, status, next_attempt_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `);
    const dueStmt = db.prepare(`
        SELECT * FROM mail_outbox WHERE status = 'pending' AND next_attempt_at <= ?
        ORDER BY id ASC LIMIT ?
    `);
    const sentStmt = db.prepare("UPDATE mail_outbox SET status = 'sent', sent_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?");
    const failStmt = db.prepare(`
        UPDATE mail_outbox SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?
    `);
    const retryStmt = db.prepare(`
        UPDATE mail_outbox SET status = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL
        WHERE id = ? AND status = 'failed'
    `);
    // Zurueckstellen ohne Versuch zu verbrauchen (siehe classifyError()).
    const deferAllStmt = db.prepare(
        "UPDATE mail_outbox SET next_attempt_at = ? WHERE status = 'pending' AND next_attempt_at < ?"
    );
    const deferRecipientStmt = db.prepare(
        "UPDATE mail_outbox SET next_attempt_at = ? WHERE status = 'pending' AND to_addr = ? AND next_attempt_at < ?"
    );
    const listStmt = db.prepare('SELECT * FROM mail_outbox ORDER BY id DESC LIMIT ?');
    const listByStatusStmt = db.prepare('SELECT * FROM mail_outbox WHERE status = ? ORDER BY id DESC LIMIT ?');
    const countsStmt = db.prepare('SELECT status, COUNT(*) AS n FROM mail_outbox GROUP BY status');
    const pruneStmt = db.prepare("DELETE FROM mail_outbox WHERE status = 'sent' AND sent_at <= ?");
    const deleteForTicketStmt = db.prepare("DELETE FROM mail_outbox WHERE ticket_id = ? AND status != 'pending'");
    const deleteForAddressStmt = db.prepare('DELETE FROM mail_outbox WHERE to_addr = ?');

    let running = null;
    let timer = null;
    let kickScheduled = false;
    let lastSendAt = 0;

    /* Legt eine Mail an und stoesst den Versand sofort (asynchron) an.
       Gibt die ID zurueck oder null, wenn der Versand deaktiviert ist. */
    function enqueue({ kind, to, subject, text, html = null, headers = {}, ticketId = null, attachments = [] }) {
        if (!mailer.enabled) {
            log.log?.(`✉️  Mail "${kind}" an ${to} nicht verschickt — Mailversand deaktiviert.`);
            return null;
        }
        if (!to) return null;
        const now = Date.now();
        const { lastInsertRowid } = insertStmt.run(
            kind, String(to), String(subject), String(text), html, JSON.stringify(headers), ticketId,
            JSON.stringify((attachments || []).map(String)), now, now
        );
        kick();
        return Number(lastInsertRowid);
    }

    function kick() {
        if (kickScheduled) return;
        kickScheduled = true;
        setImmediate(() => {
            kickScheduled = false;
            processDue().catch(err => log.error?.('Mail-Outbox:', err.message));
        });
    }

    /* Gibt { ok } oder { ok: false, scope, retryAt } zurueck; scope wie
       classifyError(), retryAt = naechster Versuch (null bei failed). */
    async function sendOne(mail) {
        const wait = lastSendAt + sendIntervalMs - Date.now();
        if (wait > 0) await sleep(wait);
        lastSendAt = Date.now();
        try {
            const attachments = mail.attachments.length && resolveAttachments
                ? await resolveAttachments(mail.attachments)
                : [];
            await mailer.send({
                to: mail.to, subject: mail.subject, text: mail.text, html: mail.html, headers: mail.headers, attachments,
            });
            sentStmt.run(Date.now(), mail.id);
            // Nur Art und id, keine Adresse: die steht in der Outbox selbst
            log.info?.(`Mail "${mail.kind}" zugestellt`, { event: 'mail_sent', mailId: mail.id, kind: mail.kind });
            return { ok: true };
        } catch (err) {
            const scope = classifyError(err);
            const attempts = mail.attempts + 1;
            const failed = scope === 'permanent' || attempts >= MAX_ATTEMPTS;
            const retryAt = Date.now() + BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];
            const code = smtpCode(err);
            const message = String(err.message).replace(/\s+/g, ' ').trim();
            failStmt.run(
                failed ? 'failed' : 'pending', attempts, message.slice(0, 500), retryAt, mail.id
            );
            const label = `Mail "${mail.kind}" an ${mail.to}${code ? ` (SMTP ${code})` : ''}`;
            if (failed) {
                log.error?.(`✉️  ${label} endgültig nicht zugestellt${scope === 'permanent' ? '' : ` nach ${attempts} Versuchen`}: ${message}`);
                auditLog?.log('mail_failed', { mailId: mail.id, kind: mail.kind, code: code || null });
            } else {
                const what = scope === 'server'
                    ? 'Mailserver nicht erreichbar/Anmeldung fehlgeschlagen — Warteschlange pausiert'
                    : 'vom Mailserver vorübergehend abgelehnt';
                log.warn?.(`✉️  ${label} ${what}, neuer Versuch um ${formatTime(retryAt)} (Versuch ${attempts}/${MAX_ATTEMPTS}): ${message}`);
            }
            return { ok: false, scope, retryAt: failed ? null : retryAt };
        }
    }

    /* Arbeitet alle faelligen Mails ab. Laeuft nie doppelt: ein zweiter
       Aufruf waehrend eines laufenden haengt sich an dessen Promise und
       startet danach einen weiteren Durchgang (fuer inzwischen
       hinzugekommene Mails). */
    async function processDue({ limit = 25 } = {}) {
        // while statt if: warten mehrere Aufrufer gleichzeitig, prueft jeder
        // nach dem Aufwachen erneut, ob ein anderer schon neu gestartet hat.
        while (running) {
            await running.catch(() => {});
        }
        running = (async () => {
            let sent = 0;
            for (;;) {
                const due = dueStmt.all(Date.now(), limit).map(rowToMail);
                if (due.length === 0) break;
                let paused = false;
                const deferred = new Set();
                for (const mail of due) {
                    // In dieser Runde schon zurueckgestellt (siehe unten).
                    if (deferred.has(mail.to)) continue;
                    const result = await sendOne(mail);
                    if (result.ok) {
                        sent += 1;
                    } else if (result.scope === 'server') {
                        deferAllStmt.run(result.retryAt ?? Date.now() + BACKOFF_MS[0], Date.now() + 1);
                        paused = true;
                        break;
                    } else if (result.scope === 'recipient' && result.retryAt) {
                        deferRecipientStmt.run(result.retryAt, mail.to, result.retryAt);
                        deferred.add(mail.to);
                    }
                }
                if (paused || due.length < limit) break;
            }
            return sent;
        })();
        try {
            return await running;
        } finally {
            running = null;
        }
    }

    /* Fuer Tests: wartet, bis angestossene Versandlaeufe durch sind. */
    async function whenIdle() {
        await new Promise(resolve => setImmediate(resolve));
        while (running || kickScheduled) {
            if (running) await running.catch(() => {});
            else await new Promise(resolve => setImmediate(resolve));
        }
    }

    function start(intervalMs = 30e3) {
        if (timer || !mailer.enabled) return;
        timer = setInterval(() => {
            processDue().catch(err => log.error?.('Mail-Outbox:', err.message));
            pruneStmt.run(Date.now() - SENT_RETENTION_MS);
        }, intervalMs);
        if (typeof timer.unref === 'function') timer.unref();
        kick();
    }

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
    }

    function list({ status = null, limit = 50 } = {}) {
        const rows = status ? listByStatusStmt.all(status, limit) : listStmt.all(limit);
        return rows.map(rowToMail);
    }

    function counts() {
        const result = { pending: 0, sent: 0, failed: 0 };
        for (const row of countsStmt.all()) result[row.status] = row.n;
        return result;
    }

    function retry(id) {
        const changed = retryStmt.run(Date.now(), Number(id)).changes > 0;
        if (changed) kick();
        return changed;
    }

    /* DSGVO: beim Loeschen eines Tickets/Kontos keine Kopien der Inhalte in
       der Outbox zuruecklassen (noch ausstehende Mails bleiben — die sollen
       ja noch rausgehen, z. B. "Konto geloescht"). */
    function forgetTicket(ticketId) {
        deleteForTicketStmt.run(ticketId);
    }

    function forgetAddress(address) {
        deleteForAddressStmt.run(String(address));
    }

    return {
        enabled: mailer.enabled, enqueue, processDue, whenIdle, start, stop, list, counts, retry,
        forgetTicket, forgetAddress,
    };
}

module.exports = { createMailOutbox, classifyError, BACKOFF_MS, MAX_ATTEMPTS };
