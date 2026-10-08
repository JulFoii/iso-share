'use strict';

/*
 * Kennzahlen fuer die Reporting-Seite /admin/reports (lib/routes/reports.js)
 * — reines SQL ueber tickets/ticket_sla/kb_articles, ohne eigene Tabelle.
 * Zeitraum [from, to) in Epoch-ms; die Buckets des Verlaufs (Tag bzw.
 * Kalenderwoche ab Montag) sind an der Wanduhr von APP_TIMEZONE
 * ausgerichtet (lib/time.js), gespeichert wird wie ueberall UTC.
 *
 * Die SLA-Quote misst die Erstantwort gegen die *aktuell* eingestellte
 * Frist der jeweiligen Prioritaet — eine geaenderte Frist wirkt also
 * rueckwirkend; die Seite sagt das dazu. Tickets, die der Support selbst
 * angelegt hat (source 'admin'), zaehlen fuer Erstantwort und SLA nicht:
 * deren "Erstantwort" ist die Anlage selbst.
 */

const { PRIORITIES, PRIORITY_LABELS, SOURCE_LABELS } = require('./ticket-store');

const DAY_MS = 24 * 60 * 60 * 1000;

function median(values) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function average(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function pad(n) {
    return String(n).padStart(2, '0');
}

/*
 * Bucket-Grenzen fuer den Verlauf: bis 45 Tage je Tag, darueber je Woche
 * (Montag 00:00 Ortszeit). Gibt [{ start, end }] zurueck.
 */
function buckets(from, to, clock) {
    const weekly = to - from > 45 * DAY_MS;
    const startOfDay = ts => clock.floorLocal(ts, DAY_MS);
    // Wanduhr-Datum + n Tage -> Mitternacht Ortszeit (ueber DST hinweg korrekt)
    const addDays = (ts, days) => {
        const p = clock.parts(ts);
        const date = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
        return clock.parseLocal(`${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T00:00`);
    };
    let start = startOfDay(from);
    if (weekly) {
        const p = clock.parts(start);
        const weekday = (new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() + 6) % 7; // Mo = 0
        start = addDays(start, -weekday);
    }
    const out = [];
    while (start < to && out.length < 400) {
        const end = addDays(start, weekly ? 7 : 1);
        out.push({ start, end });
        start = end;
    }
    return { weekly, list: out };
}

function createTicketReports({ db, clock }) {
    function slaTargets() {
        const targets = {};
        for (const row of db.prepare('SELECT * FROM ticket_sla').all()) {
            targets[row.priority] = row.first_response_minutes > 0 ? row.first_response_minutes * 60e3 : null;
        }
        return targets;
    }

    function report({ from, to, now = Date.now() }) {
        const range = { from, to };

        const created = db.prepare(`
            SELECT id, created_at, first_response_at, priority, source, category_id, iso_file
            FROM tickets WHERE created_at >= @from AND created_at < @to
        `).all(range);
        const resolvedRows = db.prepare(`
            SELECT created_at, resolved_at FROM tickets
            WHERE resolved_at IS NOT NULL AND resolved_at >= @from AND resolved_at < @to
        `).all(range);
        const ratings = db.prepare(`
            SELECT t.number, t.subject, t.rating, t.rating_comment, t.rated_at
            FROM tickets t WHERE t.rated_at IS NOT NULL AND t.rated_at >= @from AND t.rated_at < @to
            ORDER BY t.rated_at DESC
        `).all(range);

        /* Erstantwort + SLA (ohne vom Support angelegte Tickets) */
        const targets = slaTargets();
        const firstResponses = [];
        let slaHit = 0;
        let slaMissed = 0;
        for (const ticket of created) {
            if (ticket.source === 'admin') continue;
            if (ticket.first_response_at) firstResponses.push(ticket.first_response_at - ticket.created_at);
            const target = targets[ticket.priority];
            if (!target) continue;
            if (ticket.first_response_at) {
                if (ticket.first_response_at - ticket.created_at <= target) slaHit += 1;
                else slaMissed += 1;
            } else if (now - ticket.created_at > target) {
                // Noch unbeantwortet und schon ueberfaellig: sicher verfehlt;
                // noch nicht faellig: (noch) nicht bewertbar.
                slaMissed += 1;
            }
        }
        const resolutionTimes = resolvedRows.map(row => row.resolved_at - row.created_at);

        /* Verlauf erstellt/geloest */
        const { weekly, list } = buckets(from, to, clock);
        const series = list.map(bucket => ({ ...bucket, created: 0, resolved: 0 }));
        const place = (ts, key) => {
            // Buckets sind sortiert und klein (<= 400) — binaere Suche lohnt nicht
            const hit = series.find(bucket => ts >= bucket.start && ts < bucket.end);
            if (hit) hit[key] += 1;
        };
        created.forEach(ticket => place(ticket.created_at, 'created'));
        resolvedRows.forEach(row => place(row.resolved_at, 'resolved'));

        /* Verteilungen der im Zeitraum erstellten Tickets */
        const categories = new Map(db.prepare('SELECT id, name FROM ticket_categories').all().map(row => [row.id, row.name]));
        const count = (keyOf, labelOf) => {
            const map = new Map();
            for (const ticket of created) {
                const key = keyOf(ticket);
                map.set(key, (map.get(key) ?? 0) + 1);
            }
            return [...map.entries()]
                .map(([key, n]) => ({ key, label: labelOf(key), n }))
                .sort((a, b) => b.n - a.n || String(a.label).localeCompare(String(b.label), 'de'));
        };
        const byCategory = count(t => t.category_id ?? null, key => (key == null ? 'Ohne Kategorie' : categories.get(key) ?? 'Gelöschte Kategorie'));
        const byPriority = count(t => t.priority, key => PRIORITY_LABELS[key] ?? key)
            .sort((a, b) => PRIORITIES.indexOf(b.key) - PRIORITIES.indexOf(a.key));
        const bySource = count(t => t.source ?? 'web', key => SOURCE_LABELS[key] ?? key);
        const byIsoFile = count(t => t.iso_file ?? null, key => key ?? 'Ohne Datei')
            .filter(entry => entry.key !== null).slice(0, 10);

        const distribution = [1, 2, 3, 4, 5].map(stars => ({ stars, n: ratings.filter(r => r.rating === stars).length }));

        return {
            from, to, weekly,
            createdCount: created.length,
            resolvedCount: resolvedRows.length,
            firstResponse: { median: median(firstResponses), average: average(firstResponses), n: firstResponses.length },
            resolution: { median: median(resolutionTimes), average: average(resolutionTimes), n: resolutionTimes.length },
            sla: { hit: slaHit, missed: slaMissed, rate: slaHit + slaMissed ? slaHit / (slaHit + slaMissed) : null },
            csat: { average: average(ratings.map(r => r.rating)), n: ratings.length, distribution },
            comments: ratings.filter(r => r.rating_comment).slice(0, 20).map(r => ({
                number: r.number, subject: r.subject, rating: r.rating, comment: r.rating_comment, ratedAt: r.rated_at,
            })),
            series,
            byCategory, byPriority, bySource, byIsoFile,
            topArticles: db.prepare(
                'SELECT slug, title, views FROM kb_articles WHERE views > 0 ORDER BY views DESC LIMIT 10'
            ).all(),
        };
    }

    return { report };
}

/* SVG-Geometrie fuer "erstellt vs. geloest" als gruppierte Balken, im Stil
   von timelineGeometry() in lib/routes/event-log.js. */
function seriesGeometry(series, { width = 720, height = 160, weekly = false, clock } = {}) {
    const max = Math.max(1, ...series.map(bucket => Math.max(bucket.created, bucket.resolved)));
    const slot = width / Math.max(1, series.length);
    const barWidth = Math.max(1.5, Math.min(14, (slot - Math.max(2, slot * 0.25)) / 2));
    const labelEvery = Math.max(1, Math.ceil(series.length / 8));
    const label = ts => {
        const p = clock.parts(ts);
        return `${pad(p.day)}.${pad(p.month)}.`;
    };
    return {
        width, height, max,
        gridlines: [0.5, 1].map(fraction => ({ y: height - fraction * height, value: Math.round(max * fraction) })),
        bars: series.map((bucket, index) => {
            const x = index * slot + (slot - 2 * barWidth) / 2;
            const bar = (value, offset) => {
                const h = value ? Math.max(1, (value / max) * height) : 0;
                return { x: x + offset, y: height - h, w: barWidth, h };
            };
            return {
                slot, hitX: index * slot,
                created: bar(bucket.created, 0),
                resolved: bar(bucket.resolved, barWidth),
                label: index % labelEvery === 0 ? label(bucket.start) : null,
                labelX: index * slot + slot / 2,
                tooltip: `${weekly ? 'Woche ab ' : ''}${clock.formatDate(bucket.start)}: `
                    + `${bucket.created} erstellt, ${bucket.resolved} gelöst`,
            };
        }),
    };
}

module.exports = { createTicketReports, seriesGeometry, median, buckets };
