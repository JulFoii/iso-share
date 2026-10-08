'use strict';

/*
 * Reporting-Seite des Ticketsystems (/admin/reports, checkAuth-gated),
 * Kennzahlen aus lib/ticket-reports.js. Der Zeitraum steht wie beim
 * Event-Log komplett in der Query (teilbar, ohne JS nutzbar): ein Preset
 * (range=30|90|365 Tage) oder ein eigener Zeitraum (from/to als Datum,
 * Wanduhr in APP_TIMEZONE, "to" einschliesslich).
 */

const { createTicketReports, seriesGeometry } = require('../ticket-reports');

const PRESETS = { 30: '30 Tage', 90: '90 Tage', 365: '12 Monate' };
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_MS = 3 * 366 * DAY_MS;

function parseRange(query, clock, now = Date.now()) {
    const dateOk = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''));
    if (dateOk(query.from) && dateOk(query.to)) {
        const from = clock.parseLocal(`${query.from}T00:00`);
        const toStart = clock.parseLocal(`${query.to}T00:00`);
        if (from !== null && toStart !== null && toStart >= from) {
            // "bis einschliesslich": Mitternacht des Folgetags, ueber den
            // Tagesbucket statt +24 h (Zeitumstellung)
            const to = clock.floorLocal(toStart + 36 * 3600e3, DAY_MS);
            if (to - from <= MAX_RANGE_MS) {
                return { preset: null, from, to, fromInput: query.from, toInput: query.to };
            }
        }
    }
    const days = Object.hasOwn(PRESETS, query.range) ? Number(query.range) : 30;
    const to = now;
    const from = clock.floorLocal(now - days * DAY_MS, DAY_MS);
    return { preset: String(days), from, to, fromInput: '', toInput: '' };
}

function registerReportRoutes(ctx) {
    const { app, checkAuth, ticketStore, clock } = ctx;
    const reports = createTicketReports({ db: ticketStore.db, clock });

    app.get('/admin/reports', checkAuth, (req, res) => {
        const range = parseRange(req.query, clock);
        const data = reports.report({ from: range.from, to: range.to });
        res.render('admin/reports', {
            range,
            presets: PRESETS,
            report: data,
            chart: seriesGeometry(data.series, { weekly: data.weekly, clock }),
        });
    });
}

module.exports = { registerReportRoutes, parseRange };
