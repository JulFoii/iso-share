'use strict';

/*
 * Der express-session-Signierschluessel in der Tabelle `session_secret` (ein
 * Datensatz). Bewusst synchron (nicht async wie die anderen Stores): er wird
 * gebraucht, bevor `app.use(session(...))` in server.js aufgesetzt wird —
 * also noch innerhalb des synchronen createApp(), lange vor dem asynchronen
 * start(). DatabaseSync macht das moeglich, ohne createApp() selbst async
 * machen zu muessen.
 *
 * ensure(candidate) liefert den bereits persistierten Schluessel, falls
 * vorhanden — sonst wird `candidate` (aus SESSION_SECRET oder frisch
 * zufaellig erzeugt, siehe server.js) einmalig gespeichert und zurueckgegeben.
 * Ab dem ersten Aufruf gewinnt also immer die DB, eine spaeter geaenderte
 * Env-Var wirkt sich nicht mehr aus — ein Neustart ohne persistierten
 * Schluessel wuerde sonst alle Sitzungen ungueltig machen.
 */

function createSessionSecretStore({ db }) {
    if (!db) throw new Error('session secret store braucht eine db');

    const readStmt = db.prepare('SELECT secret FROM session_secret WHERE id = 1');
    const writeStmt = db.prepare(
        'INSERT INTO session_secret (id, secret) VALUES (1, ?) ON CONFLICT(id) DO NOTHING'
    );

    function read() {
        return readStmt.get()?.secret ?? null;
    }

    function ensure(candidate) {
        const existing = read();
        if (existing) return existing;
        writeStmt.run(candidate);
        return candidate;
    }

    return { db, read, ensure };
}

module.exports = { createSessionSecretStore };
