'use strict';

/*
 * Prueft anhand des Authentication-Results-Headers (RFC 8601), ob eine
 * eingehende Mail wirklich von der Domain ihres Absenders stammt — Grundlage
 * dafuer, dass lib/mail-inbound.js aus einer *neuen* Mail (ohne signierte
 * Thread-Referenz) ein Ticket anlegen darf. Die Absenderadresse selbst ist
 * trivial faelschbar; DKIM/DMARC-Pruefung macht der Mailserver des
 * Postfachs, und er schreibt das Ergebnis in diesen Header.
 *
 * Vertraut wird ausschliesslich einem Header, dessen authserv-id genau der
 * konfigurierten IMAP_AUTHSERV_ID entspricht (der Hostname, den der eigene
 * Mailserver dort eintraegt, z. B. "mx.gmx.net"). Jeder Absender kann
 * beliebige Authentication-Results-Header mitschicken; nur den des eigenen
 * Servers kann er nicht vorhersagen. Von mehreren passenden zaehlt nur der
 * oberste (der zuletzt hinzugefuegte, also der des eigenen Servers) — ein
 * weiter unten mitgeschickter, gefaelschter mit derselben ID aendert nichts.
 *
 * Akzeptiert:
 *   - dmarc=pass mit header.from == Absenderdomain, oder
 *   - dkim=pass mit header.d == Absenderdomain oder einer uebergeordneten
 *     Domain davon (Absender support.example.com, Signatur example.com —
 *     "relaxed alignment" wie bei DMARC).
 * SPF allein reicht bewusst nicht: es prueft nur den Envelope-Absender, nicht
 * die sichtbare From-Adresse.
 *
 * Rein funktional, ohne Mailserver testbar.
 */

/* Entfernt (auch verschachtelte) Kommentare in runden Klammern. */
function stripComments(value) {
    let out = '';
    let depth = 0;
    let quoted = false;
    for (const char of String(value ?? '')) {
        if (char === '"' && depth === 0) quoted = !quoted;
        if (!quoted && char === '(') {
            depth += 1;
            continue;
        }
        if (!quoted && char === ')' && depth > 0) {
            depth -= 1;
            continue;
        }
        if (depth === 0) out += char;
    }
    return out;
}

/*
 * "mx.example; dkim=pass header.d=a.de; dmarc=fail header.from=a.de" ->
 * { authservId: 'mx.example', results: [{ method, result, props: {...} }] }
 */
function parseAuthResults(value) {
    const [head, ...parts] = stripComments(value).split(';');
    const authservId = String(head ?? '').trim().split(/\s+/)[0].toLowerCase();
    const results = [];
    for (const part of parts) {
        const tokens = part.trim().split(/\s+/).filter(Boolean);
        if (tokens.length === 0) continue;
        const [method, result] = tokens[0].toLowerCase().split('=');
        if (!method || !result) continue;
        const props = {};
        for (const token of tokens.slice(1)) {
            const index = token.indexOf('=');
            if (index <= 0) continue;
            props[token.slice(0, index).toLowerCase()] = token.slice(index + 1).replace(/^"|"$/g, '').toLowerCase();
        }
        results.push({ method, result, props });
    }
    return { authservId, results };
}

function domainOf(address) {
    const match = /@([^@\s>]+)\s*>?\s*$/.exec(String(address ?? '').trim());
    return match ? match[1].toLowerCase().replace(/\.$/, '') : null;
}

/* Alle Werte eines (mehrfach vorkommenden) Headers in Reihenfolge, von oben
   nach unten — lib/imap-poller.js parseHeaders() behaelt nur den letzten. */
function headerValues(raw, name) {
    const wanted = String(name).toLowerCase();
    const unfolded = String(raw ?? '').replace(/\r?\n[ \t]+/g, ' ');
    const values = [];
    for (const line of unfolded.split(/\r?\n/)) {
        const index = line.indexOf(':');
        if (index <= 0) continue;
        if (line.slice(0, index).trim().toLowerCase() === wanted) values.push(line.slice(index + 1).trim());
    }
    return values;
}

/*
 * authResults: alle Authentication-Results-Werte, oberster zuerst.
 * Gibt { ok: true, method } oder { ok: false, reason } zurueck.
 */
function authenticatedSender(authResults, { authservId, fromAddress }) {
    const expectedId = String(authservId ?? '').trim().toLowerCase();
    if (!expectedId) return { ok: false, reason: 'not_configured' };
    const fromDomain = domainOf(fromAddress);
    if (!fromDomain) return { ok: false, reason: 'no_sender' };

    const own = (authResults || []).map(parseAuthResults).find(parsed => parsed.authservId === expectedId);
    if (!own) return { ok: false, reason: 'no_auth_results' };

    const dmarc = own.results.find(r => r.method === 'dmarc' && r.result === 'pass'
        && r.props['header.from'] === fromDomain);
    if (dmarc) return { ok: true, method: 'dmarc' };

    const dkim = own.results.find(r => {
        if (r.method !== 'dkim' || r.result !== 'pass') return false;
        const signer = r.props['header.d'] || domainOf(r.props['header.i']);
        // Eine Signatur einer nackten TLD ("com") zaehlt nie als uebergeordnet
        return Boolean(signer) && signer.includes('.')
            && (signer === fromDomain || fromDomain.endsWith(`.${signer}`));
    });
    if (dkim) return { ok: true, method: 'dkim' };

    return { ok: false, reason: 'not_aligned' };
}

module.exports = { authenticatedSender, parseAuthResults, headerValues, domainOf, stripComments };
