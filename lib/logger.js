'use strict';

/*
 * Kleiner Logger ohne Dependency. Dieselbe Schnittstelle wie `console`
 * (log/info/warn/error/debug mit beliebig vielen Argumenten), damit jedes
 * Modul, das heute `log = console` bekommt, ihn unveraendert nutzen kann.
 *
 * Zwei Ziele (siehe lib/event-store.js):
 *  - die Konsole bekommt nur das Wesentliche: Start/Stop, Konfig-Warnungen
 *    und alles ab `level` vom Hauptlogger, von Modul-Loggern (child())
 *    dagegen erst ab `detailLevel` (Default warn). Einzelne Requests, Mail-
 *    Versand, Checksummen usw. fluten die Konsole damit nicht mehr.
 *  - die Senke (attachSink(), das Event-Log) bekommt JEDE Meldung, egal auf
 *    welchem Level — gefiltert wird im Dashboard. Meldungen vor dem
 *    Anhaengen der Senke (Konfig-Pruefung beim Start) werden gepuffert und
 *    beim Anhaengen nachgereicht.
 *
 *  - format 'json' (Default in production): eine JSON-Zeile je Eintrag auf
 *    stdout/stderr — direkt von Docker/Loki/ELK auswertbar, mehrzeilige
 *    Meldungen und Stacktraces bleiben ein einziger Eintrag.
 *  - format 'pretty' (Default sonst): lesbare Zeilen wie bisher.
 *
 * Ein Error-Argument wird mit Stacktrace serialisiert, ein einzelnes
 * Plain-Object am Ende als strukturierte Felder uebernommen
 * (log.info('request', { method, path, status })).
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, critical: 50 };
const EARLY_BUFFER_MAX = 200;

function serializeError(err) {
    return { name: err.name, message: err.message, code: err.code, stack: err.stack };
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function parseArgs(args) {
    const parts = [];
    let fields = {};
    let error = null;
    args.forEach((arg, index) => {
        if (arg instanceof Error) {
            error = arg;
        } else if (index === args.length - 1 && index > 0 && isPlainObject(arg)) {
            fields = arg;
        } else if (typeof arg === 'string') {
            parts.push(arg);
        } else {
            try {
                parts.push(JSON.stringify(arg));
            } catch {
                parts.push(String(arg));
            }
        }
    });
    // Emoji/Einrueckung der bisherigen Konsolenmeldungen sind im JSON nur
    // Rauschen — die Meldung selbst bleibt unveraendert lesbar
    return { msg: parts.join(' ').trim(), fields, error };
}

function createLogger({
    format = process.env.NODE_ENV === 'production' ? 'json' : 'pretty',
    level = 'info',
    detailLevel = 'warn',
    stdout = process.stdout,
    stderr = process.stderr,
    now = () => new Date(),
} = {}) {
    const threshold = LEVELS[level] ?? LEVELS.info;
    const detailThreshold = Math.max(threshold, LEVELS[detailLevel] ?? LEVELS.warn);

    let sink = null;
    const early = [];

    function toSink(entry) {
        if (sink) {
            try {
                sink(entry);
            } catch { /* das Event-Log darf den Logger nie mitreissen */ }
        } else if (early.length < EARLY_BUFFER_MAX) {
            early.push(entry);
        }
    }

    function toConsole(lvl, { msg, fields, error }, module, time) {
        const stream = LEVELS[lvl] >= LEVELS.warn ? stderr : stdout;
        const err = error ? serializeError(error) : null;
        if (format === 'json') {
            const entry = { time: time.toISOString(), level: lvl, ...(module ? { module } : {}), msg, ...fields };
            if (err) entry.err = err;
            stream.write(JSON.stringify(entry) + '\n');
            return;
        }
        const prefix = module ? `[${module}] ` : '';
        const extra = Object.keys(fields).length > 0 ? ' ' + JSON.stringify(fields) : '';
        const stack = err ? '\n' + (err.stack || err.message) : '';
        stream.write(`${prefix}${msg}${extra}${stack}\n`);
    }

    function build({ module = null, consoleThreshold = threshold, useSink = true } = {}) {
        function write(lvl, args) {
            const parsed = parseArgs(args);
            const time = now();
            if (useSink) toSink({ level: lvl, ...parsed, module, time });
            if (LEVELS[lvl] >= consoleThreshold) toConsole(lvl, parsed, module, time);
        }
        return {
            debug: (...args) => write('debug', args),
            info: (...args) => write('info', args),
            log: (...args) => write('info', args),
            warn: (...args) => write('warn', args),
            error: (...args) => write('error', args),
            critical: (...args) => write('critical', args),
            /*
             * Logger fuer ein Modul (Systembereich des Event-Logs). Auf der
             * Konsole erst ab detailLevel; `sink: false` fuer Meldungen, die
             * schon als eigenes Ereignis im Event-Log stehen (Request-Zeilen).
             */
            child: (childModule, { sink: childSink = true } = {}) => build({
                module: childModule, consoleThreshold: detailThreshold, useSink: useSink && childSink,
            }),
            attachSink(fn) {
                sink = fn;
                for (const entry of early.splice(0)) toSink(entry);
            },
            detachSink() {
                sink = null;
            },
        };
    }

    return build();
}

/* Modul-Logger, auch fuer console-aehnliche Objekte ohne child() (Tests) */
function childLog(log, module, options) {
    return typeof log?.child === 'function' ? log.child(module, options) : log;
}

/*
 * Request-Log-Middleware mit Request-ID. Die ID kommt aus einem gueltigen
 * eingehenden X-Request-Id (vom Reverse Proxy) oder wird neu erzeugt, steht
 * als req.id bereit und geht als X-Request-Id an den Client zurueck — ein
 * Nutzer kann sie beim Support nennen, der Betreiber findet damit alle
 * Ereignisse dieses Requests im Event-Log.
 *
 * `onFinish(req, res, durationMs, { aborted })` schreibt den Request ins
 * Event-Log. Auf die Konsole (ueber `log`) geht jede Zeile auf info — mit
 * einem Modul-Logger also standardmaessig gar nicht —, nur 5xx als error.
 *
 * Geloggt wird nur der Pfad, NIE der Query-String: dort stehen Einmal-Tokens
 * (/account/verify?token=..., /account/reset?token=...), die nichts im Log
 * zu suchen haben. Healthcheck und Metrics-Scrapes fluten das Log sonst alle
 * paar Sekunden und werden daher ausgelassen, ebenso statische Assets.
 */
const SKIP_PATHS = new Set(['/healthz', '/metrics']);
const STATIC_PREFIXES = ['/css/', '/js/', '/img/', '/fonts/', '/favicon'];
const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

function requestLogger(log, { randomId = () => require('crypto').randomUUID(), onFinish = null } = {}) {
    // Auch mit einem console-aehnlichen Objekt ohne info() nutzbar (Tests)
    const info = (log.info ?? log.log).bind(log);
    return function logRequests(req, res, next) {
        const incoming = req.get('x-request-id');
        req.id = incoming && REQUEST_ID.test(incoming) ? incoming : randomId();
        res.set('X-Request-Id', req.id);

        const path = req.path;
        if (SKIP_PATHS.has(path) || STATIC_PREFIXES.some(prefix => path.startsWith(prefix))) {
            return next();
        }

        const started = process.hrtime.bigint();
        const elapsed = () => Number(process.hrtime.bigint() - started) / 1e6;
        res.on('finish', () => {
            const durationMs = elapsed();
            const status = res.statusCode;
            onFinish?.(req, res, durationMs, { aborted: false });
            const fields = {
                reqId: req.id,
                method: req.method,
                path,
                status,
                durationMs: Math.round(durationMs * 10) / 10,
                bytes: Number(res.get('content-length')) || undefined,
                ip: req.ip,
            };
            if (status >= 500) log.error('request', fields);
            else info('request', fields);
        });
        // Abgebrochene Verbindung (Client weg mitten im Download/Upload)
        res.on('close', () => {
            if (res.writableFinished) return;
            onFinish?.(req, res, elapsed(), { aborted: true });
            info('request aborted', {
                reqId: req.id, method: req.method, path, ip: req.ip,
            });
        });
        next();
    };
}

module.exports = { createLogger, requestLogger, childLog, LEVELS };
