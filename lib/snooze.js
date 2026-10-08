'use strict';

/*
 * Wiedervorlage (Snooze) eines Tickets: reine Zeitrechnung, ohne DB.
 *
 * Die Vorgaben ("Morgen 9 Uhr", "Naechster Montag") sind Wanduhrzeiten in
 * APP_TIMEZONE — gerechnet wird deshalb auf dem lokalen Kalenderdatum und
 * erst am Ende ueber clock.parseLocal() in einen Zeitpunkt umgewandelt, damit
 * "morgen 9 Uhr" auch ueber die Zeitumstellung hinweg 9 Uhr bleibt (und
 * nicht "jetzt + 24 h").
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const WAKE_HOUR = '09:00';
const MIN_AHEAD_MS = 60 * 1000;
const MAX_AHEAD_MS = 366 * DAY_MS;

function pad(n) {
    return String(n).padStart(2, '0');
}

/* Lokales Kalenderdatum von `now` plus `days` Tage, um WAKE_HOUR. */
function localDayAt(clock, now, days) {
    const p = clock.parts(now);
    const date = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
    return clock.parseLocal(
        `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${WAKE_HOUR}`
    );
}

function daysUntilNextMonday(clock, now) {
    const p = clock.parts(now);
    const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay(); // 0 = Sonntag
    return ((8 - weekday) % 7) || 7;
}

const PRESETS = [
    { key: 'tomorrow', label: 'Morgen', days: () => 1 },
    { key: '3d', label: 'In 3 Tagen', days: () => 3 },
    { key: 'monday', label: 'Nächster Montag', days: daysUntilNextMonday },
    { key: 'week', label: 'In 1 Woche', days: () => 7 },
];

/* [{ key, label, until }] fuer die Schaltflaechen und Sammelaktionen. */
function snoozePresets(clock, now = Date.now()) {
    return PRESETS.map(preset => ({
        key: preset.key,
        label: preset.label,
        until: localDayAt(clock, now, preset.days(clock, now)),
    }));
}

function presetUntil(key, clock, now = Date.now()) {
    return snoozePresets(clock, now).find(preset => preset.key === key)?.until ?? null;
}

/*
 * Formulareingabe -> { until } oder { error }. `preset` hat Vorrang vor
 * einem eigenen Zeitpunkt `until` (datetime-local, Wanduhrzeit).
 */
function parseSnoozeInput({ preset, until } = {}, clock, now = Date.now()) {
    let at = null;
    if (preset) {
        at = presetUntil(String(preset), clock, now);
        if (at === null) return { error: 'Unbekannte Vorgabe für die Wiedervorlage.' };
    } else {
        at = clock.parseLocal(String(until ?? '').trim());
        if (at === null) return { error: 'Bitte einen gültigen Zeitpunkt für die Wiedervorlage angeben.' };
    }
    if (at < now + MIN_AHEAD_MS) return { error: 'Die Wiedervorlage muss in der Zukunft liegen.' };
    if (at > now + MAX_AHEAD_MS) return { error: 'Die Wiedervorlage darf höchstens ein Jahr in der Zukunft liegen.' };
    return { until: at };
}

module.exports = { snoozePresets, presetUntil, parseSnoozeInput, MAX_AHEAD_MS };
