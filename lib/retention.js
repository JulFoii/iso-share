'use strict';

/*
 * Loeschfristen (DSGVO Art. 5 Abs. 1 lit. e — Speicherbegrenzung). Laeuft
 * stuendlich aus server.js; jede Frist in Tagen, 0 schaltet sie ab.
 *
 *  - auditLogDays: wird hier nur durchgereicht (fuer views/privacy.ejs) —
 *    geloescht werden Audit-Eintraege vom Event-Log selbst (purge() in
 *    lib/event-store.js), zusammen mit den Fristen je Schweregrad.
 *  - unverifiedAccountDays: Kundenkonten, deren Adresse nach N Tagen noch
 *    immer nicht bestaetigt ist. Bewusst ohne "Konto geloescht"-Mail: die
 *    Adresse wurde nie bestaetigt, gehoert also womoeglich gar nicht der
 *    Person, die sich registriert hat.
 *  - closedTicketDays: geschlossene (status 'closed', nicht nur 'resolved')
 *    Tickets, deren Schliessung N Tage zurueckliegt — samt Nachrichten,
 *    Anhaengen (auch die Dateien) und Outbox-Kopien. Default aus, weil die
 *    passende Frist vom Einsatzzweck abhaengt (Gewaehrleistung,
 *    Aufbewahrungspflichten) und der Betreiber sie bewusst waehlen soll.
 *
 * Direkt per SQL statt ueber die Stores, weil es Massenoperationen nach
 * Alter sind, die sonst niemand braucht; das eigentliche Loeschen eines
 * Tickets/Kontos geht aber durch dieselben Store-Funktionen wie die
 * Admin-Aktionen, damit keine Anhang-Datei und keine Sitzung liegen bleibt.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function createRetention({
    db, ticketStore, attachmentStore, customerStore, sessionStore, outbox, auditLog,
    log = console,
    policy: { auditLogDays = 90, unverifiedAccountDays = 30, closedTicketDays = 0 } = {},
}) {
    const staleAccountsStmt = db.prepare(`
        SELECT id, email FROM customers
        WHERE email_verified_at IS NULL AND created_at < ?
    `);
    const oldTicketsStmt = db.prepare(`
        SELECT id FROM tickets
        WHERE status = 'closed' AND closed_at IS NOT NULL AND closed_at < ?
    `);

    const enabled = days => Number.isFinite(days) && days > 0;

    async function runOnce(now = Date.now()) {
        const result = { accounts: 0, tickets: 0 };

        if (enabled(closedTicketDays)) {
            for (const { id } of oldTicketsStmt.all(now - closedTicketDays * DAY_MS)) {
                const attachmentIds = ticketStore.deleteTicket(id);
                if (attachmentIds === null) continue;
                await attachmentStore.removeFiles(attachmentIds);
                outbox?.forgetTicket(id);
                result.tickets++;
            }
        }

        if (enabled(unverifiedAccountDays)) {
            for (const customer of staleAccountsStmt.all(now - unverifiedAccountDays * DAY_MS)) {
                const attachmentIds = ticketStore.deleteTicketsOfCustomer(customer.id);
                await attachmentStore.removeFiles(attachmentIds);
                customerStore.deleteCustomer(customer.id);
                sessionStore?.destroyForCustomer(customer.id);
                outbox?.forgetAddress(customer.email);
                result.accounts++;
            }
        }

        if (result.accounts + result.tickets > 0) {
            auditLog?.log('retention_purge', result);
            log.info?.('Löschfristen angewendet', result);
        }
        return result;
    }

    return { runOnce, policy: { auditLogDays, unverifiedAccountDays, closedTicketDays } };
}

module.exports = { createRetention };
