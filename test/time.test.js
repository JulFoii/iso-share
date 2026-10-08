'use strict';

/*
 * lib/time.js: Anzeige-Zeitzone, Zeitumstellung, Rueckrechnung aus
 * datetime-local-Eingaben, Ausrichtung von Diagrammbalken.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createClock } = require('../lib/time');
const { dosDateTimeForTest } = require('../lib/zip-stream');

const berlin = createClock('Europe/Berlin');
const iso = ms => new Date(ms).toISOString();

test('Formatierung in Europe/Berlin, unabhaengig von der Zeitzone des Prozesses', () => {
    const summer = Date.UTC(2026, 6, 1, 22, 30, 5); // 00:30:05 MESZ am 2. Juli
    const winter = Date.UTC(2026, 0, 1, 23, 30, 5); // 00:30:05 MEZ am 2. Januar
    assert.equal(berlin.formatStamp(summer), '2026-07-02 00:30:05');
    assert.equal(berlin.formatStamp(winter), '2026-01-02 00:30:05');
    assert.equal(berlin.zoneName(summer), 'MESZ');
    assert.equal(berlin.zoneName(winter), 'MEZ');
    assert.equal(berlin.formatDateTime(summer), '02.07.2026, 00:30');
    assert.equal(berlin.formatTime(summer), '00:30:05');
    assert.equal(berlin.formatIsoLocal(summer), '2026-07-02T00:30:05.000+02:00');
    assert.equal(berlin.formatDate(null), '—');
    assert.equal(berlin.formatDate('2026-07-01T22:30:05Z'), berlin.formatDate(summer));
});

test('parseLocal: normale Zeit, Luecke im Maerz, doppelte Stunde im Oktober', () => {
    assert.equal(iso(berlin.parseLocal('2026-01-02T03:04')), '2026-01-02T02:04:00.000Z');
    assert.equal(iso(berlin.parseLocal('2026-07-02T03:04')), '2026-07-02T01:04:00.000Z');
    // 02:30 gibt es am 29.03. nicht -> nach vorn verschoben (03:30 MESZ)
    assert.equal(iso(berlin.parseLocal('2026-03-29T02:30')), '2026-03-29T01:30:00.000Z');
    // 02:30 gibt es am 25.10. zweimal -> die fruehere (noch MESZ)
    assert.equal(iso(berlin.parseLocal('2026-10-25T02:30')), '2026-10-25T00:30:00.000Z');
    assert.equal(berlin.parseLocal('2026-02-30T10:00'), null);
    assert.equal(berlin.parseLocal('kaputt'), null);
    assert.equal(berlin.toLocalInput(berlin.parseLocal('2026-07-02T03:04')), '2026-07-02T03:04');
});

test('floorLocal: Tagesbalken beginnen um Mitternacht Ortszeit, auch an Tagen mit 23/25 Stunden', () => {
    const DAY = 24 * 60 * 60 * 1000;
    let t = berlin.floorLocal(Date.UTC(2026, 9, 24, 10), DAY);
    const starts = [];
    for (let i = 0; i < 3; i++) {
        starts.push(berlin.formatStamp(t));
        t = berlin.floorLocal(t + DAY * 1.5, DAY);
    }
    assert.deepEqual(starts, ['2026-10-24 00:00:00', '2026-10-25 00:00:00', '2026-10-26 00:00:00']);
    const sixHours = berlin.floorLocal(Date.UTC(2026, 6, 1, 15, 20), 6 * 60 * 60 * 1000);
    assert.equal(berlin.formatStamp(sixHours), '2026-07-01 12:00:00');
});

test('floorLocal: Stundenbalken kommen ueber die doppelte Stunde im Oktober hinweg', () => {
    const HOUR = 60 * 60 * 1000;
    // 02:30 MEZ (zweites Mal) gehoert in den Abschnitt ab 02:00 MEZ, nicht ab 02:00 MESZ
    assert.equal(berlin.floorLocal(Date.UTC(2026, 9, 25, 1, 30), HOUR), Date.UTC(2026, 9, 25, 1));
    assert.equal(berlin.floorLocal(Date.UTC(2026, 9, 25, 0, 30), HOUR), Date.UTC(2026, 9, 25, 0));
    let t = Date.UTC(2026, 9, 24, 23);
    const starts = [];
    for (let i = 0; i < 4; i++) {
        starts.push(new Date(t).toISOString().slice(11, 16));
        t = berlin.floorLocal(t + HOUR * 1.5, HOUR);
    }
    assert.deepEqual(starts, ['23:00', '00:00', '01:00', '02:00']);
});

test('unbekannte Zeitzone wird als Konfigurationsfehler abgelehnt', () => {
    assert.throws(() => createClock('Mars/Olympus'), { code: 'invalid_config' });
    assert.equal(createClock('UTC').formatStamp(Date.UTC(2026, 0, 1, 12)), '2026-01-01 12:00:00');
});

test('ZIP-Zeitstempel in der Anzeige-Zeitzone statt der des Servers', () => {
    const { dosTime, dosDate } = dosDateTimeForTest(new Date(Date.UTC(2026, 6, 1, 22, 30, 4)), berlin.parts);
    assert.equal(dosTime >> 11, 0); // 00:30 MESZ
    assert.equal((dosTime >> 5) & 0x3f, 30);
    assert.equal(dosDate & 0x1f, 2); // 2. Juli
});
