'use strict';

/*
 * Verschachtelbare Transaktion fuer einen DatabaseSync. Die aeusserste Ebene
 * ist ein normales BEGIN/COMMIT, jede innere ein SAVEPOINT — so kann z. B.
 * lib/attachment-store.js commit() das Anlegen einer Nachricht (selbst eine
 * Transaktion in lib/ticket-store.js) und die Anhang-Zeilen in *eine*
 * Transaktion fassen, ohne dass createTicket() davon wissen muss.
 *
 * Die Tiefe wird je db-Objekt gezaehlt (WeakMap) statt ueber
 * `db.isTransaction`, das es erst ab Node 22.16 gibt — der Boden des
 * Projekts ist 22.5 (siehe package.json). DatabaseSync ist synchron, fn darf
 * also nicht async sein: ein await dazwischen liesse anderen Code in die
 * offene Transaktion schreiben.
 */

const depths = new WeakMap();

function transaction(db, fn) {
    const depth = depths.get(db) ?? 0;
    const savepoint = `sp_${depth}`;
    db.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${savepoint}`);
    depths.set(db, depth + 1);
    try {
        const result = fn();
        if (result && typeof result.then === 'function') {
            throw new Error('transaction(): fn darf kein Promise liefern');
        }
        db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
        return result;
    } catch (err) {
        try {
            if (depth === 0) {
                db.exec('ROLLBACK');
            } else {
                db.exec(`ROLLBACK TO ${savepoint}`);
                db.exec(`RELEASE ${savepoint}`);
            }
        } catch {
            // Rollback scheitert nur, wenn SQLite die Transaktion schon selbst
            // beendet hat — der urspruengliche Fehler ist der interessante.
        }
        throw err;
    } finally {
        depths.set(db, depth);
    }
}

module.exports = { transaction };
