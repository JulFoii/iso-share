'use strict';

/*
 * Geordnetes Herunterfahren fuer `docker stop` (SIGTERM), Strg+C (SIGINT)
 * und unerwartete Fehler.
 *
 * Vorher: server.close() ohne Abwarten, direkt danach process.exit(0) — jeder
 * laufende Download und jeder PATCH-Chunk brach hart ab. Jetzt:
 *   1. keine neuen Verbindungen mehr annehmen, ruhende Keep-alive-
 *      Verbindungen sofort schliessen,
 *   2. laufende Requests bis zu `timeoutMs` zu Ende laufen lassen,
 *   3. danach verbleibende Verbindungen hart trennen (ein abgebrochener
 *      Chunk-Upload setzt ohnehin am Serverstand fort, siehe
 *      lib/chunked-upload.js),
 *   4. Hintergrunddienste stoppen und die DB schliessen (instance.stop()),
 *   5. mit dem passenden Exit-Code beenden.
 * `timeoutMs` muss unter Dockers stop_grace_period liegen (docker-compose.yml),
 * sonst kommt SIGKILL, bevor die DB geschlossen ist.
 *
 * Ein uncaughtException/unhandledRejection fuehrt ebenfalls zum geordneten
 * Beenden (Exit-Code 1), denn der Prozesszustand ist danach unbestimmt; die
 * restart-Policy startet neu. Ein harter Notausgang nach timeoutMs + 5 s
 * greift, falls selbst das Herunterfahren haengt.
 */

function createShutdown({
    server, stop, log = console, timeoutMs = 30_000, exit = code => process.exit(code),
}) {
    let running = null;

    function shutdown(reason, code = 0) {
        if (running) return running;
        running = (async () => {
            log.warn(`${reason} empfangen — fahre herunter (max. ${Math.round(timeoutMs / 1000)} s).`);

            const hardExit = setTimeout(() => {
                log.error('Herunterfahren haengt — erzwungener Abbruch.');
                exit(code || 1);
            }, timeoutMs + 5_000);
            hardExit.unref?.();

            const closed = new Promise(resolve => server.close(() => resolve()));
            server.closeIdleConnections?.();
            const force = setTimeout(() => {
                log.warn('Laufende Verbindungen nach Timeout getrennt.');
                server.closeAllConnections?.();
            }, timeoutMs);
            force.unref?.();

            await closed;
            clearTimeout(force);

            try {
                await stop();
            } catch (err) {
                log.error('Fehler beim Stoppen der Dienste:', err);
                code = code || 1;
            }
            clearTimeout(hardExit);
            exit(code);
        })();
        return running;
    }

    return shutdown;
}

function installProcessHandlers({ shutdown, log = console, proc = process }) {
    proc.once('SIGTERM', () => shutdown('SIGTERM'));
    proc.once('SIGINT', () => shutdown('SIGINT'));
    proc.on('unhandledRejection', reason => {
        const err = reason instanceof Error ? reason : new Error(String(reason));
        (log.critical ?? log.error)('Unbehandelte Promise-Ablehnung:', err);
        shutdown('unhandledRejection', 1);
    });
    proc.on('uncaughtException', err => {
        (log.critical ?? log.error)('Unbehandelte Ausnahme:', err);
        shutdown('uncaughtException', 1);
    });
}

module.exports = { createShutdown, installProcessHandlers };
