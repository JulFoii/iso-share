'use strict';

/*
 * Event-Log-Dashboard fuer den Admin (/admin/logs*), siehe lib/event-store.js.
 *
 *  - GET  /admin/logs                  Kennzahlen, Grafiken, gefilterte Tabelle
 *  - GET  /admin/logs/:id              Detailansicht (?partial=1: nur der
 *                                      Inhalt fuer den <dialog>, public/js/event-log.js)
 *  - GET  /admin/logs/export.csv|json  Export mit denselben Filtern wie die Tabelle
 *  - GET  /admin/logs/settings         Archivierungs-/Loeschregeln
 *  - POST /admin/logs/settings         ... speichern
 *  - POST /admin/logs/purge            Regeln sofort anwenden
 *  - GET  /admin/logs/archives/:file   Archivdatei herunterladen
 *  - POST /admin/logs/archives/:file/delete
 *
 * Alle Filter stehen als GET-Parameter in der URL: eine Ansicht ist damit
 * teilbar, funktioniert ohne JavaScript, und live-regions.js kann dieselbe
 * URL zum Aktualisieren erneut abrufen. Zeiten sind durchgehend UTC.
 */

const path = require('path');

const {
    SEVERITIES, SEVERITY_BY_VALUE, MODULES, MODULE_LABELS, parseSeverity,
} = require('../event-catalog');
const { createClock } = require('../time');

// Fuer Aufrufer ohne eigene Uhr (Tests); die App uebergibt ihre (APP_TIMEZONE)
const DEFAULT_CLOCK = createClock();

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const RANGES = [
    ['1h', 'Letzte Stunde', HOUR_MS],
    ['24h', '24 Stunden', DAY_MS],
    ['7d', '7 Tage', 7 * DAY_MS],
    ['30d', '30 Tage', 30 * DAY_MS],
    ['90d', '90 Tage', 90 * DAY_MS],
    ['all', 'Alles', null],
];
const RANGE_MS = Object.fromEntries(RANGES.map(([key, , ms]) => [key, ms]));
const PAGE_SIZE = 100;

function asList(value) {
    if (value === undefined || value === null || value === '') return [];
    return (Array.isArray(value) ? value : [value])
        .flatMap(item => String(item).split(','))
        .map(item => item.trim())
        .filter(Boolean);
}

/*
 * Query -> normalisierte Filter. Unbekannte Schweregrade/Module fallen still
 * weg; ein eigener Zeitraum (from/to) schlaegt das Preset und ist Wanduhrzeit
 * der Anzeige-Zeitzone (datetime-local kennt keine Zeitzone).
 */
function parseFilters(query, now = Date.now(), clock = DEFAULT_CLOCK) {
    const severities = [...new Set(asList(query.sev).map(parseSeverity).filter(Boolean))];
    const modules = [...new Set(asList(query.module).filter(key => MODULE_LABELS[key]))];
    const customFrom = clock.parseLocal(query.from);
    const customTo = clock.parseLocal(query.to);
    let range = RANGE_MS[query.range] !== undefined ? query.range : '24h';
    let from;
    let to = null;
    if (customFrom || customTo) {
        range = 'custom';
        from = customFrom;
        to = customTo;
    } else {
        from = RANGE_MS[range] ? now - RANGE_MS[range] : null;
    }
    const before = Number.parseInt(query.before, 10);
    return {
        range,
        from,
        to,
        severities,
        modules,
        q: String(query.q ?? '').trim().slice(0, 200),
        audit: query.audit === '1',
        requestId: String(query.req ?? '').trim().slice(0, 80) || null,
        ip: String(query.ip ?? '').trim().slice(0, 64) || null,
        event: String(query.event ?? '').trim().slice(0, 100) || null,
        before: Number.isInteger(before) && before > 0 ? before : null,
    };
}

/* Filter -> Query-String (ohne Cursor), fuer Links, Export und Paginierung */
function filterQuery(filters, overrides = {}, clock = DEFAULT_CLOCK) {
    const merged = { ...filters, ...overrides };
    const params = new URLSearchParams();
    if (merged.range === 'custom') {
        if (merged.from) params.set('from', clock.toLocalInput(merged.from));
        if (merged.to) params.set('to', clock.toLocalInput(merged.to));
    } else if (merged.range && merged.range !== '24h') {
        params.set('range', merged.range);
    }
    for (const severity of merged.severities ?? []) params.append('sev', SEVERITY_BY_VALUE[severity].key);
    for (const module of merged.modules ?? []) params.append('module', module);
    if (merged.q) params.set('q', merged.q);
    if (merged.audit) params.set('audit', '1');
    if (merged.requestId) params.set('req', merged.requestId);
    if (merged.ip) params.set('ip', merged.ip);
    if (merged.event) params.set('event', merged.event);
    if (merged.before) params.set('before', String(merged.before));
    const text = params.toString();
    return text ? `?${text}` : '';
}

/* ------------------------------------------------------- Grafikdaten -- */

const SEVERITY_ORDER = [10, 20, 30, 40, 50];

function formatBucketLabel(ms, bucketMs, clock) {
    const p = clock.parts(ms);
    const pad = n => String(n).padStart(2, '0');
    // Ganze Tage und Mitternacht als Datum, sonst die Uhrzeit
    if (bucketMs >= DAY_MS || (bucketMs >= HOUR_MS && p.hour === 0 && p.minute === 0)) {
        return `${pad(p.day)}.${pad(p.month)}.`;
    }
    return `${pad(p.hour)}:${pad(p.minute)}`;
}

/*
 * Gestapelte Balken je Zeitabschnitt, fertig berechnet fuer das SVG in
 * views/partials/event-charts.ejs (Geometrie im viewBox-Raster 0..width,
 * 0..height). Segmente von unten nach oben DEBUG -> CRITICAL, mit 1px
 * Luecke zwischen den Segmenten.
 */
function timelineGeometry(stats, { width = 720, height = 160, clock = DEFAULT_CLOCK } = {}) {
    const bars = stats.timeline;
    const max = Math.max(1, ...bars.map(bar => bar.total));
    const slot = width / Math.max(1, bars.length);
    const barWidth = Math.max(2, Math.min(28, slot - Math.max(2, slot * 0.25)));
    const labelEvery = Math.max(1, Math.ceil(bars.length / 8));
    return {
        width,
        height,
        max,
        gridlines: [0.5, 1].map(fraction => ({ y: height - fraction * height, value: Math.round(max * fraction) })),
        bars: bars.map((bar, index) => {
            const x = index * slot + (slot - barWidth) / 2;
            let y = height;
            const segments = [];
            for (const severity of SEVERITY_ORDER) {
                const count = bar.counts[severity] ?? 0;
                if (count === 0) continue;
                const h = Math.max(1, (count / max) * height);
                y -= h;
                segments.push({ severity, key: SEVERITY_BY_VALUE[severity].key, count, x, y, w: barWidth, h: Math.max(0.5, h - 1) });
            }
            return {
                x, w: barWidth, slot, total: bar.total, start: bar.start, end: bar.end, segments,
                label: index % labelEvery === 0 ? formatBucketLabel(bar.start, stats.bucketMs, clock) : null,
                tooltip: `${clock.formatStamp(bar.start).slice(0, 16)} – ${clock.formatStamp(bar.end).slice(11, 16)} `
                    + `${clock.zoneName(bar.start)}: ${bar.total} Events`
                    + SEVERITY_ORDER.filter(s => bar.counts[s]).map(s => `\n${SEVERITY_BY_VALUE[s].label}: ${bar.counts[s]}`).join(''),
            };
        }),
    };
}

function percent(value) {
    return `${(value * 100).toFixed(value > 0 && value < 0.1 ? 2 : 1).replace('.', ',')} %`;
}

function trend(current, previous) {
    if (!previous && !current) return { dir: 'flat', text: '±0' };
    if (!previous) return { dir: 'up', text: 'neu' };
    const change = (current - previous) / previous;
    if (Math.abs(change) < 0.005) return { dir: 'flat', text: '±0 %' };
    return { dir: change > 0 ? 'up' : 'down', text: `${change > 0 ? '+' : '−'}${Math.abs(change * 100).toFixed(0)} %` };
}

/* ---------------------------------------------------------- Export -- */

const CSV_COLUMNS = [
    ['id', e => e.id],
    ['time_utc', e => new Date(e.ts).toISOString()],
    ['time_local', (e, clock) => clock.formatIsoLocal(e.ts)],
    ['severity', e => e.severityLabel],
    ['module', e => e.module],
    ['event', e => e.event],
    ['audit', e => (e.audit ? 1 : 0)],
    ['outcome', e => e.outcome],
    ['actor_type', e => e.actorType],
    ['actor_id', e => e.actorId],
    ['session_hash', e => e.sessionHash],
    ['ip', e => e.ip],
    ['user_agent', e => e.userAgent],
    ['request_id', e => e.requestId],
    ['method', e => e.method],
    ['path', e => e.path],
    ['status', e => e.status],
    ['duration_ms', e => e.durationMs],
    ['message', e => e.message],
    ['payload', e => (e.payload ? JSON.stringify(e.payload) : '')],
    ['error_stack', e => e.errorStack],
];

/*
 * Semikolon-getrennt (Excel mit deutscher Einstellung oeffnet das direkt),
 * RFC-4180-Quoting. Zellen, die mit = + - @ beginnen, bekommen ein
 * fuehrendes ' — sonst liesse sich ueber einen protokollierten Wert
 * (User-Agent, Suchbegriff) eine Formel in die Tabellenkalkulation des
 * Admins schmuggeln (CSV-Injection).
 */
function csvCell(value) {
    if (value === null || value === undefined) return '';
    let text = String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/*
 * Schreibt mit Backpressure. Bricht der Client ab, kommt nie mehr ein
 * 'drain' — darum auch auf 'close' warten, sonst haengt der Export (samt
 * offenem Cursor) fuer immer.
 */
async function writeChunk(res, chunk) {
    if (res.destroyed) throw abortedError();
    if (res.write(chunk)) return;
    await new Promise((resolve, reject) => {
        const onDrain = () => { res.off('close', onClose); resolve(); };
        const onClose = () => { res.off('drain', onDrain); reject(abortedError()); };
        res.once('drain', onDrain);
        res.once('close', onClose);
    });
}

function abortedError() {
    const err = new Error('Export vom Client abgebrochen');
    err.code = 'export_aborted';
    return err;
}

/* ======================================================================== */

function registerEventLogRoutes({ app, events, auditLog, checkAuth, pollLimiter, clock = DEFAULT_CLOCK }) {
    function pageData(req) {
        const now = Date.now();
        const filters = parseFilters(req.query, now, clock);
        const statsFrom = filters.from ?? events.earliestTs() ?? now - DAY_MS;
        const statsTo = filters.to ?? now;
        const stats = events.stats({
            from: statsFrom, to: statsTo, bars: filters.range === '1h' ? 30 : 24,
            floor: clock.floorLocal,
        });
        const page = events.list(filters, { limit: PAGE_SIZE });
        return {
            filters,
            stats,
            timeline: timelineGeometry(stats, { clock }),
            moduleMax: Math.max(1, ...stats.modules.map(m => m.n)),
            page,
            ranges: RANGES,
            severities: SEVERITIES,
            modules: MODULES,
            moduleLabels: MODULE_LABELS,
            filterQuery: overrides => filterQuery(filters, overrides, clock),
            toLocalInput: clock.toLocalInput,
            formatStamp: clock.formatStamp,
            zoneName: clock.zoneName,
            timeZone: clock.timeZone,
            percent,
            trend,
            hasFilters: Boolean(
                filters.severities.length || filters.modules.length || filters.q || filters.audit
                || filters.requestId || filters.ip || filters.event || filters.range !== '24h'
            ),
            settings: events.readSettings(),
            eventStatus: events.status(),
        };
    }

    app.get('/admin/logs', checkAuth, pollLimiter, (req, res, next) => {
        try {
            res.render('admin/logs', pageData(req));
        } catch (err) {
            next(err);
        }
    });

    async function exportEvents(format, req, res, next) {
        const filters = { ...parseFilters(req.query, Date.now(), clock), before: null };
        const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-');
        let count = 0;
        try {
            res.set('Cache-Control', 'no-store');
            res.attachment(`iso-share-events-${stamp}.${format}`);
            if (format === 'csv') {
                res.type('text/csv; charset=utf-8');
                // BOM: sonst liest Excel UTF-8 als Windows-1252
                await writeChunk(res, `﻿${CSV_COLUMNS.map(([name]) => name).join(';')}\r\n`);
                for (const event of events.iterate(filters)) {
                    await writeChunk(res, `${CSV_COLUMNS.map(([, get]) => csvCell(get(event, clock))).join(';')}\r\n`);
                    count++;
                }
            } else {
                res.type('application/json; charset=utf-8');
                await writeChunk(res, '[\n');
                for (const event of events.iterate(filters)) {
                    const { severityKey, ...rest } = event;
                    await writeChunk(res, `${count > 0 ? ',\n' : ''}${JSON.stringify({
                        ...rest, time: new Date(event.ts).toISOString(), timeLocal: clock.formatIsoLocal(event.ts),
                    })}`);
                    count++;
                }
                await writeChunk(res, '\n]\n');
            }
            res.end();
            auditLog.log('events_exported', {
                ip: req.ip, format, count, filters: filterQuery(filters, {}, clock) || '(keine)',
            });
        } catch (err) {
            if (!res.headersSent) return next(err);
            res.destroy(err.code === 'export_aborted' ? undefined : err);
        }
    }

    app.get('/admin/logs/export.csv', checkAuth, (req, res, next) => exportEvents('csv', req, res, next));
    app.get('/admin/logs/export.json', checkAuth, (req, res, next) => exportEvents('json', req, res, next));

    app.get('/admin/logs/settings', checkAuth, async (req, res, next) => {
        try {
            res.render('admin/log-settings', {
                settings: events.readSettings(),
                archives: await events.listArchives(),
                status: events.status(),
                saved: req.query.saved === '1',
                purged: /^\d{1,12}$/.test(String(req.query.purged ?? '')) ? Number(req.query.purged) : null,
                error: null,
            });
        } catch (err) {
            next(err);
        }
    });

    app.post('/admin/logs/settings', checkAuth, async (req, res, next) => {
        const body = req.body ?? {};
        const flags = {
            // Checkboxen fehlen im Body, wenn sie nicht angehakt sind
            archiveEnabled: body.archiveEnabled === '1',
            storeDebug: body.storeDebug === '1',
            traceQueries: body.traceQueries === '1',
        };
        const result = events.writeSettings({
            debugDays: body.debugDays,
            infoDays: body.infoDays,
            warningDays: body.warningDays,
            errorDays: body.errorDays,
            criticalDays: body.criticalDays,
            archiveDays: body.archiveDays,
            maxRows: body.maxRows,
            slowQueryMs: body.slowQueryMs,
            ...flags,
        });
        try {
            if (!result) {
                return res.status(400).render('admin/log-settings', {
                    // Eingaben wieder anzeigen, auch abgewaehlte Checkboxen
                    settings: { ...events.readSettings(), ...body, ...flags },
                    archives: await events.listArchives(),
                    status: events.status(),
                    saved: false,
                    purged: null,
                    error: 'Ungültige Werte — Tage 0 bis 3650, Obergrenze 10.000 bis 50.000.000 Einträge, Schwelle 1 bis 60.000 ms.',
                });
            }
            auditLog.log('event_settings_changed', { ip: req.ip, changes: result.changes });
            res.redirect('/admin/logs/settings?saved=1');
        } catch (err) {
            next(err);
        }
    });

    app.post('/admin/logs/purge', checkAuth, async (req, res, next) => {
        try {
            const result = await events.purge();
            res.redirect(`/admin/logs/settings?purged=${result.deleted}`);
        } catch (err) {
            next(err);
        }
    });

    app.get('/admin/logs/archives/:file', checkAuth, (req, res, next) => {
        const file = events.safeArchiveName(req.params.file);
        if (!file || !events.archiveDir) return res.status(404).send('Nicht gefunden');
        res.download(path.join(events.archiveDir, file), file, err => {
            if (err && !res.headersSent) res.status(404).send('Nicht gefunden');
            else if (err) next(err);
        });
    });

    app.post('/admin/logs/archives/:file/delete', checkAuth, async (req, res) => {
        const file = events.safeArchiveName(req.params.file);
        const removed = file ? await events.deleteArchive(file) : false;
        if (removed) auditLog.log('event_archive_deleted', { ip: req.ip, file });
        res.redirect('/admin/logs/settings');
    });

    app.get('/admin/logs/:id', checkAuth, (req, res, next) => {
        const id = Number.parseInt(req.params.id, 10);
        if (!/^\d+$/.test(req.params.id) || !Number.isSafeInteger(id)) return next();
        try {
            const event = events.get(id);
            if (!event) return res.status(404).send('Ereignis nicht gefunden');
            const locals = { event, moduleLabels: MODULE_LABELS };
            if (req.query.partial === '1') {
                return res.render('partials/event-detail', { ...locals, inDialog: true });
            }
            res.render('admin/log-event', locals);
        } catch (err) {
            next(err);
        }
    });
}

module.exports = {
    registerEventLogRoutes, parseFilters, filterQuery, csvCell, timelineGeometry,
};
