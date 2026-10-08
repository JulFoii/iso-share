'use strict';

/*
 * Buchfuehrung fuer den Mail-Eingang (lib/mail-inbound.js,
 * lib/imap-poller.js) in drei kleinen Tabellen (siehe lib/db.js):
 *
 * - inbound_mail_seen: jede Mail wird genau einmal verarbeitet. Der Poller
 *   setzt \Seen erst *nach* der Verarbeitung — stuerzt der Prozess
 *   dazwischen ab, kaeme dieselbe Mail beim naechsten Abruf wieder. claim()
 *   ist ein atomares INSERT OR IGNORE auf die Message-ID (bzw. einen
 *   Ersatzschluessel), die erste Verarbeitung gewinnt. Gespeichert wird nur
 *   ein SHA-256 des Schluessels — er enthaelt die Absenderadresse, und die
 *   gehoert nicht 90 Tage lang in eine Tabelle, die nur "schon gesehen?"
 *   beantworten muss.
 * - inbound_mail_notices: notifyOnce() laesst eine automatische Hinweis-Mail
 *   (z. B. "Ticket ist geschlossen") hoechstens einmal je Schluessel und
 *   Zeitfenster zu. Sonst antworten sich ein Autoresponder ohne
 *   Auto-Submitted-Header und unser Hinweis endlos gegenseitig.
 * - imap_state: hoechste verarbeitete UID je Postfach samt UIDVALIDITY, damit
 *   der Poller nicht vom \Seen-Flag abhaengt (das ein Mensch im Mailprogramm
 *   jederzeit setzen kann).
 */

const crypto = require('crypto');

const SEEN_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

function createInboundMailStore({ db, now = () => Date.now() }) {
    if (!db) throw new Error('inbound mail store braucht eine db');

    const claimStmt = db.prepare('INSERT OR IGNORE INTO inbound_mail_seen (key, seen_at) VALUES (?, ?)');
    const pruneSeenStmt = db.prepare('DELETE FROM inbound_mail_seen WHERE seen_at < ?');
    const getNoticeStmt = db.prepare('SELECT sent_at FROM inbound_mail_notices WHERE key = ?');
    const upsertNoticeStmt = db.prepare(`
        INSERT INTO inbound_mail_notices (key, sent_at) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET sent_at = excluded.sent_at
    `);
    const pruneNoticesStmt = db.prepare('DELETE FROM inbound_mail_notices WHERE sent_at < ?');
    const getStateStmt = db.prepare('SELECT uid_validity, last_uid FROM imap_state WHERE mailbox = ?');
    const setStateStmt = db.prepare(`
        INSERT INTO imap_state (mailbox, uid_validity, last_uid) VALUES (?, ?, ?)
        ON CONFLICT(mailbox) DO UPDATE SET uid_validity = excluded.uid_validity, last_uid = excluded.last_uid
    `);

    /* true, wenn diese Mail zum ersten Mal gesehen wird. Leerer Schluessel
       (kein Message-ID, kein Ersatz) wird immer verarbeitet. */
    function claim(key) {
        const value = String(key ?? '').trim();
        if (!value) return true;
        const hash = crypto.createHash('sha256').update(value).digest('hex');
        return claimStmt.run(hash, now()).changes === 1;
    }

    /* true = Hinweis darf jetzt raus (und ist ab jetzt fuer windowMs gesperrt). */
    function notifyOnce(key, windowMs) {
        const row = getNoticeStmt.get(String(key));
        const at = now();
        if (row && at - row.sent_at < windowMs) return false;
        upsertNoticeStmt.run(String(key), at);
        return true;
    }

    function getImapState(mailbox) {
        const row = getStateStmt.get(String(mailbox));
        return row ? { uidValidity: row.uid_validity, lastUid: row.last_uid } : null;
    }

    function setImapState(mailbox, { uidValidity, lastUid }) {
        setStateStmt.run(String(mailbox), String(uidValidity), Number(lastUid) || 0);
    }

    function prune({ seenRetentionMs = SEEN_RETENTION_MS, noticeRetentionMs = SEEN_RETENTION_MS } = {}) {
        const at = now();
        return pruneSeenStmt.run(at - seenRetentionMs).changes + pruneNoticesStmt.run(at - noticeRetentionMs).changes;
    }

    return { claim, notifyOnce, getImapState, setImapState, prune };
}

module.exports = { createInboundMailStore };
