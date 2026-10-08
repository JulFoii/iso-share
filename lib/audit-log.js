'use strict';

/*
 * Audit-Log als duenne Fassade ueber das zentrale Event-Log
 * (lib/event-store.js). Die rund 60 Aufrufstellen behalten ihre
 * Schnittstelle auditLog.log(event, detail); jeder Eintrag landet als
 * Ereignis mit audit = 1, Modul und Schweregrad aus lib/event-catalog.js
 * und dem Kontext des laufenden Requests (Akteur, IP, User-Agent,
 * Session-Hash, Request-ID).
 *
 * Audit-Eintraege werden sofort geschrieben, nicht gepuffert — ein direkt
 * folgendes read() (Heartbeat, Tests) sieht sie also schon. Frueher lagen
 * sie in der Tabelle `audit_log` der Haupt-DB; deren Zeilen uebernimmt
 * start() einmalig (siehe importLegacyAudit()).
 *
 * `detail.changes` (siehe diff() in lib/event-store.js) traegt bei
 * Aenderungen den Vorher-Nachher-Zustand.
 */

function createAuditLog({ events }) {
    if (!events) throw new Error('audit log braucht den event store');

    /*
     * Bewusst ohne await/.catch beim Aufrufer gedacht: ein Audit-Log-Fehler
     * darf niemals die eigentliche Aktion (Login, Upload, Loeschen) scheitern
     * lassen — record() faengt selbst alles ab.
     */
    async function log(event, detail = {}) {
        events.audit(event, detail);
    }

    /* Neueste zuerst, Format wie bisher: { id, ts, event, ip?, ...detail }.
       `id` (aufsteigend vergeben) laesst den Heartbeat-Client neue Eintraege
       erkennen, siehe public/js/heartbeat.js. */
    async function read({ limit = 200 } = {}) {
        return events.readAudit({ limit });
    }

    return { log, read };
}

module.exports = { createAuditLog };
