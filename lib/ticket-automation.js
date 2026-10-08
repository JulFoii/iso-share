'use strict';

/*
 * Zeitgesteuerte Ticket-Regeln, alle paar Minuten aus server.js aufgerufen
 * (Fristen in lib/ticket-config-store.js, im Admin-Bereich einstellbar):
 *
 *   1. pending seit pendingReminderDays ohne Kundenantwort
 *        -> Erinnerungsmail, reminder_sent_at gesetzt
 *   2. nach der Erinnerung weitere pendingAutoResolveDays ohne Antwort
 *        -> automatisch 'resolved' (der Kunde kann per Antwort wiedereroeffnen)
 *   3. 'resolved' seit autoCloseDays
 *        -> automatisch 'closed'
 *   4. Antwortfrist (SLA, siehe SLA_DUE_SQL in lib/ticket-store.js)
 *      ueberschritten -> einmal eine Mail an den Support, sla_notified_at
 *      gesetzt; jede Antwort und jeder Statuswechsel setzt es zurueck
 *   5. Wiedervorlage (snoozed_until) erreicht -> aufgeraeumt, als ungelesen
 *      markiert, Ereignis im Verlauf. Sichtbar ist das Ticket in den
 *      Ansichten schon ab dem Zeitpunkt selbst (Vergleich in SQL), dieser
 *      Schritt sorgt nur fuer die Markierung
 *
 * reminder_sent_at wird auch dann gesetzt, wenn der Kunde Erinnerungen
 * abbestellt hat — sonst wuerde Schritt 2 fuer ihn nie greifen. Jede
 * Kunden- und jede neue Support-Antwort setzt reminder_sent_at zurueck
 * (lib/ticket-store.js), die Uhr beginnt dann von vorn.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function createTicketAutomation({ ticketStore, configStore, ticketMail, auditLog, log = console }) {
    function runOnce(now = Date.now()) {
        const settings = configStore.readSettings();
        const result = { reminded: 0, resolved: 0, closed: 0, slaBreached: 0, woken: 0 };

        for (const ticket of ticketStore.dueForReminder(now - settings.pendingReminderDays * DAY_MS)) {
            ticketMail.pendingReminder(ticket, settings.pendingAutoResolveDays);
            ticketStore.markReminderSent(ticket.id);
            result.reminded += 1;
        }

        for (const ticket of ticketStore.dueForAutoResolve(now - settings.pendingAutoResolveDays * DAY_MS)) {
            const change = ticketStore.setStatus(ticket.id, 'resolved', { actor: 'system' });
            if (change?.changed) {
                ticketMail.statusChanged(change.ticket, change.from, change.to, 'system');
                result.resolved += 1;
            }
        }

        for (const ticket of ticketStore.dueForAutoClose(now - settings.autoCloseDays * DAY_MS)) {
            const change = ticketStore.setStatus(ticket.id, 'closed', { actor: 'system' });
            if (change?.changed) {
                ticketMail.statusChanged(change.ticket, change.from, change.to, 'system');
                result.closed += 1;
            }
        }

        for (const ticket of ticketStore.dueForSlaBreach(now)) {
            ticketMail.slaBreached?.(ticket);
            ticketStore.markSlaNotified(ticket.id);
            result.slaBreached += 1;
        }

        for (const ticket of ticketStore.dueForWake(now)) {
            if (ticketStore.unsnooze(ticket.id, { reason: 'due' })) result.woken += 1;
        }

        if (result.reminded || result.resolved || result.closed || result.slaBreached || result.woken) {
            auditLog?.log('ticket_automation', result);
            log.log?.(`🎫 Ticket-Automatik: ${result.reminded} erinnert, ${result.resolved} gelöst, `
                + `${result.closed} geschlossen, ${result.slaBreached} Fristen überschritten, `
                + `${result.woken} Wiedervorlagen fällig.`);
        }
        return result;
    }

    return { runOnce };
}

module.exports = { createTicketAutomation, DAY_MS };
