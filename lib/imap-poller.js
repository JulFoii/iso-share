'use strict';

/*
 * Holt Mails per IMAP aus dem Support-Postfach (Antworten auf Tickets und —
 * mit IMAP_AUTHSERV_ID — neue Tickets) und reicht sie an lib/mail-inbound.js
 * weiter. imapflow ist die dritte bewusste Ausnahme von
 * der kurzen Abhaengigkeitsliste (nach @simplewebauthn/server und
 * nodemailer): IMAP samt MIME-Dekodierung (Transfer-Encodings, Zeichensaetze,
 * RFC-2231-Dateinamen) von Hand waere weit fehleranfaelliger als eine
 * gepflegte Bibliothek.
 *
 * Bewusst einfach gehalten: alle paar Sekunden verbinden, neue Mails
 * abholen, verarbeiten, abmelden. Kein dauerhaft offenes IDLE — ein
 * haengender Socket ueber Stunden ist fehleranfaelliger als ein kurzer Abruf
 * pro Minute. Ohne IMAP_HOST ist der Poller deaktiviert (enabled=false), und
 * die Mails an Kunden sagen dann auch, dass Antworten per Mail nicht ankommen.
 *
 * Welche Mails "neu" sind, entscheidet die UID, nicht das \Seen-Flag: mit
 * stateStore (lib/inbound-mail-store.js) merkt sich der Poller die hoechste
 * verarbeitete UID samt UIDVALIDITY und holt danach nur "last+1:*". Oeffnet
 * jemand das Postfach im Mailprogramm und liest eine Mail, wird sie trotzdem
 * verarbeitet. Nur beim allerersten Lauf (oder nach einer geaenderten
 * UIDVALIDITY) gilt wie frueher "ungelesen" — alte, gelesene Mails im
 * Postfach sollen nicht auf einen Schlag zu Tickets werden. \Seen wird
 * weiterhin gesetzt (fuer Menschen im Mailprogramm), und mit
 * processedMailbox (IMAP_PROCESSED_MAILBOX) wandern verarbeitete Mails in
 * diesen Ordner, damit das Postfach nicht endlos waechst. Eine doppelt
 * gelieferte Mail (Absturz zwischen Verarbeitung und UID-Stand) faengt
 * lib/mail-inbound.js per Message-ID ab.
 *
 * Speicher: je Mail werden hoechstens maxAttachmentFiles Anhaenge geladen,
 * jeder mit maxBytes-Grenze; ein laut BODYSTRUCTURE zu grosser Anhang wird
 * gar nicht heruntergeladen, sondern nur als {tooLarge: true} gemeldet. Eine
 * Mail mit hunderten Anhaengen kann den Prozess so nicht mehr in den
 * Speicher-Tod treiben.
 *
 * Der Status (letzter Lauf, letzter Fehler, Anzahl verarbeiteter Mails)
 * steht im Admin-Bereich unter /admin/ticket-settings.
 */

const { headerValues } = require('./mail-auth');

const MAX_PER_RUN = 50;
const MAX_TEXT_BYTES = 256 * 1024;
const FETCH_HEADERS = [
    'references', 'auto-submitted', 'x-autoreply', 'x-autorespond', 'precedence', 'authentication-results',
    'list-id', 'list-unsubscribe', 'return-path', 'x-auto-response-suppress', 'x-ms-exchange-inbox-rules-loop',
    'x-loop',
];

function parseHeaders(buffer) {
    const headers = {};
    const unfolded = String(buffer ?? '').replace(/\r?\n[ \t]+/g, ' ');
    for (const line of unfolded.split(/\r?\n/)) {
        const index = line.indexOf(':');
        if (index <= 0) continue;
        headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
    }
    return headers;
}

/* Automatisch erzeugt — wird nie zu einer Nachricht: Autoresponder,
   Bounces (leerer Return-Path, mailer-daemon/postmaster), Newsletter und
   Mailinglisten. */
function isAutoSubmitted(headers, from = '') {
    const autoSubmitted = (headers['auto-submitted'] || 'no').toLowerCase();
    const precedence = (headers.precedence || '').toLowerCase();
    const localPart = String(from).toLowerCase().split('@')[0];
    return autoSubmitted !== 'no'
        || Boolean(headers['x-autoreply'] || headers['x-autorespond'])
        || ['bulk', 'junk', 'auto_reply', 'list'].includes(precedence)
        || Boolean(headers['list-id'] || headers['list-unsubscribe'])
        || /^<\s*>$/.test(headers['return-path'] || '')
        || ['mailer-daemon', 'postmaster'].includes(localPart);
}

/* Die Mail ist echt, bittet aber darum, nicht automatisch beantwortet zu
   werden (Outlook/Exchange, weitergeleitet per Regel, Schleifen-Marker) —
   sie wird verarbeitet, bekommt aber keine automatische Hinweis-Mail. */
function suppressesAutoResponse(headers) {
    const suppress = (headers['x-auto-response-suppress'] || '').toLowerCase();
    return /\b(all|oof|autoreply)\b/.test(suppress)
        || Boolean(headers['x-ms-exchange-inbox-rules-loop'] || headers['x-loop']);
}

/* Sammelt aus der BODYSTRUCTURE den ersten text/plain- und text/html-Teil
   sowie alle Anhaenge. */
function walkStructure(node, found = { text: null, html: null, attachments: [] }) {
    if (!node) return found;
    if (Array.isArray(node.childNodes) && node.childNodes.length) {
        for (const child of node.childNodes) walkStructure(child, found);
        return found;
    }
    const type = String(node.type || '').toLowerCase();
    const part = node.part || '1';
    const filename = node.dispositionParameters?.filename || node.parameters?.name || null;
    const isAttachment = String(node.disposition || '').toLowerCase() === 'attachment' || Boolean(filename);
    if (isAttachment) {
        found.attachments.push({ part, filename: filename || 'anhang', size: node.size || 0 });
    } else if (type === 'text/plain' && !found.text) {
        found.text = part;
    } else if (type === 'text/html' && !found.html) {
        found.html = part;
    }
    return found;
}

/* Liest hoechstens maxBytes (+1, damit "zu gross" erkennbar bleibt) — auch
   wenn der Server die maxBytes-Option von download() ignoriert. */
async function streamToBuffer(stream, maxBytes = Infinity) {
    const chunks = [];
    let total = 0;
    for await (const chunk of stream) {
        const room = maxBytes + 1 - total;
        if (room <= 0) break;
        const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
        chunks.push(piece);
        total += piece.length;
        if (total > maxBytes) break;
    }
    if (typeof stream.destroy === 'function') stream.destroy();
    return Buffer.concat(chunks);
}

function createImapPoller({
    host, port = 993, secure = true, user, pass, mailbox = 'INBOX', intervalMs = 60e3, processor,
    maxAttachmentBytes = 10 * 1024 * 1024, maxAttachmentFiles = 5, processedMailbox = '', stateStore = null,
    log = console, clientFactory = null,
}) {
    const enabled = Boolean(host && user);
    const security = enabled ? (secure ? `IMAPS (TLS, Port ${port})` : `STARTTLS erzwungen (Port ${port})`) : null;
    const status = { enabled, security, lastRunAt: null, lastError: null, lastProcessed: 0, totalProcessed: 0 };
    let timer = null;
    let running = null;
    // Zielordner nur einmal pro Prozess anlegen (bzw. als fehlend merken)
    let processedReady = null;

    function createClient() {
        if (clientFactory) return clientFactory();
        const { ImapFlow } = require('imapflow');
        // IMAPS (TLS ab dem ersten Byte, Port 993) ist der Normalfall. Ohne
        // secure wird STARTTLS erzwungen (doSTARTTLS) — nie Klartext. In
        // beiden Faellen mindestens TLS 1.2 mit gueltigem Zertifikat.
        return new ImapFlow({
            host, port, secure, doSTARTTLS: secure ? undefined : true,
            tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true, servername: host },
            auth: { user, pass }, logger: false,
        });
    }

    async function download(client, uid, part, maxBytes) {
        const { content } = await client.download(String(uid), part, { uid: true, maxBytes });
        return streamToBuffer(content, maxBytes);
    }

    async function handleMessage(client, uid, uidValidity) {
        const message = await client.fetchOne(String(uid), {
            envelope: true,
            bodyStructure: true,
            headers: FETCH_HEADERS,
        }, { uid: true });
        if (!message) return;

        const from = message.envelope?.from?.[0]?.address || '';
        const headers = parseHeaders(message.headers);
        // Mehrfach vorhanden und reihenfolgesensitiv (lib/mail-auth.js) —
        // parseHeaders() behielte nur den untersten, faelschbaren.
        const authResults = headerValues(message.headers, 'authentication-results');
        const structure = walkStructure(message.bodyStructure);
        const text = structure.text ? (await download(client, uid, structure.text, MAX_TEXT_BYTES)).toString('utf8') : '';
        const html = !text && structure.html
            ? (await download(client, uid, structure.html, MAX_TEXT_BYTES)).toString('utf8')
            : '';

        // Nur so viele Anhaenge laden, wie ueberhaupt uebernommen werden
        const attachments = [];
        for (const att of structure.attachments.slice(0, maxAttachmentFiles)) {
            // Kodierte Groesse (Base64) liegt ~37 % ueber der echten — grob
            // vorfiltern, die exakte Pruefung macht lib/attachment-store.js.
            if (att.size > maxAttachmentBytes * 1.4) {
                attachments.push({ filename: att.filename, tooLarge: true });
                continue;
            }
            const content = await download(client, uid, att.part, maxAttachmentBytes);
            attachments.push(content.length > maxAttachmentBytes
                ? { filename: att.filename, tooLarge: true }
                : { filename: att.filename, content });
        }

        await processor.process({
            from,
            subject: message.envelope?.subject || '',
            messageId: message.envelope?.messageId || '',
            // Ersatz fuer Mails ohne Message-ID (lib/mail-inbound.js)
            dedupKey: `uid:${mailbox}:${uidValidity ?? '-'}:${uid}`,
            inReplyTo: message.envelope?.inReplyTo || '',
            references: headers.references || '',
            autoSubmitted: isAutoSubmitted(headers, from),
            suppressAutoResponse: suppressesAutoResponse(headers),
            authResults,
            text,
            html,
            attachments,
            attachmentCount: structure.attachments.length,
        });
    }

    async function ensureProcessedMailbox(client) {
        if (!processedMailbox) return false;
        if (processedReady === null) {
            try {
                await client.mailboxCreate(processedMailbox);
                processedReady = true;
            } catch (err) {
                processedReady = false;
                log.warn?.(`IMAP: Ordner „${processedMailbox}“ konnte nicht angelegt werden — Mails bleiben im Postfach:`,
                    err.message);
            }
        }
        return processedReady;
    }

    /* Welche UIDs jetzt dran sind: mit bekanntem Stand alles ueber der
       letzten UID, sonst (erster Lauf, neue UIDVALIDITY) nur ungelesene. */
    async function pendingUids(client, uidValidity) {
        const state = stateStore?.getImapState(mailbox);
        const known = state && uidValidity != null && state.uidValidity === uidValidity;
        const raw = known
            ? await client.search({ uid: `${state.lastUid + 1}:*` }, { uid: true })
            : await client.search({ seen: false }, { uid: true });
        // "n:*" liefert laut RFC 3501 immer auch die hoechste UID, selbst
        // wenn sie kleiner als n ist — darum nachfiltern.
        const floor = known ? state.lastUid : 0;
        const uids = [...new Set((raw || []).map(Number))].filter(uid => uid > floor).sort((a, b) => a - b);
        return { uids, known };
    }

    async function pollOnce() {
        if (!enabled) return 0;
        if (running) return running;
        running = (async () => {
            const client = createClient();
            let processed = 0;
            try {
                await client.connect();
                const lock = await client.getMailboxLock(mailbox);
                try {
                    const uidValidity = client.mailbox?.uidValidity != null ? String(client.mailbox.uidValidity) : null;
                    const { uids, known } = await pendingUids(client, uidValidity);
                    const batch = uids.slice(0, MAX_PER_RUN);
                    const move = batch.length > 0 && await ensureProcessedMailbox(client);
                    let lastUid = known ? stateStore.getImapState(mailbox).lastUid : 0;
                    for (const uid of batch) {
                        try {
                            await handleMessage(client, uid, uidValidity);
                        } catch (err) {
                            log.error?.(`IMAP: Mail ${uid} konnte nicht verarbeitet werden:`, err.message);
                        }
                        // Auch bei einem Verarbeitungsfehler weiter — sonst
                        // wuerde eine kaputte Mail bei jedem Lauf erneut
                        // scheitern und alles dahinter blockieren.
                        await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
                        lastUid = Math.max(lastUid, uid);
                        if (stateStore && uidValidity != null) stateStore.setImapState(mailbox, { uidValidity, lastUid });
                        if (move) {
                            try {
                                await client.messageMove(String(uid), processedMailbox, { uid: true });
                            } catch (err) {
                                log.warn?.(`IMAP: Mail ${uid} konnte nicht verschoben werden:`, err.message);
                            }
                        }
                        processed += 1;
                    }
                    // Erster Lauf ohne Rueckstand: ab hier nur noch neue UIDs,
                    // auch die bereits gelesenen Alt-Mails bleiben unberuehrt.
                    const uidNext = Number(client.mailbox?.uidNext);
                    if (stateStore && uidValidity != null && !known && uids.length <= MAX_PER_RUN
                        && Number.isInteger(uidNext) && uidNext > 0) {
                        stateStore.setImapState(mailbox, { uidValidity, lastUid: Math.max(lastUid, uidNext - 1) });
                    }
                } finally {
                    lock.release();
                }
                await client.logout();
                status.lastError = null;
                // Leere Abrufe nur als DEBUG — sie laufen im Minutentakt
                (processed > 0 ? log.info : log.debug)?.(`IMAP-Abruf: ${processed} Mail(s) verarbeitet`, {
                    event: 'imap_polled', processed,
                });
            } catch (err) {
                status.lastError = err.message;
                log.error?.('IMAP-Abruf fehlgeschlagen:', err.message);
                try {
                    client.close?.();
                } catch {
                    // ignorieren
                }
            } finally {
                status.lastRunAt = Date.now();
                status.lastProcessed = processed;
                status.totalProcessed += processed;
            }
            return processed;
        })();
        try {
            return await running;
        } finally {
            running = null;
        }
    }

    function start() {
        if (!enabled || timer) return;
        timer = setInterval(() => {
            pollOnce().catch(() => {});
        }, intervalMs);
        if (typeof timer.unref === 'function') timer.unref();
        pollOnce().catch(() => {});
    }

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
    }

    return { enabled, status, pollOnce, start, stop, mailbox, processedMailbox: processedMailbox || null };
}

module.exports = { createImapPoller, parseHeaders, isAutoSubmitted, suppressesAutoResponse, walkStructure, streamToBuffer };
