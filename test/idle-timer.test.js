'use strict';

/*
 * Einheitentests fuer public/js/idle-timer.js — reines Browser-Skript ohne
 * jede Serverkomponente. Statt einer neuen Abhaengigkeit (z. B. jsdom, was
 * dem Kurz-Abhaengigkeitsprinzip des Projekts widerspraeche) laeuft das
 * Skript unveraendert in einer handgebauten vm-Sandbox mit minimalen
 * document/window/fetch/Date/setInterval-Stubs — genau die Stellen, die
 * idle-timer.js tatsaechlich anfasst.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'idle-timer.js'),
    'utf8',
);

function createBadge(timeoutMs) {
    const classes = new Set();
    return {
        hidden: true,
        textContent: '',
        dataset: timeoutMs === undefined ? {} : { idleTimeoutMs: String(timeoutMs) },
        classList: {
            toggle(name, on) {
                if (on) classes.add(name);
                else classes.delete(name);
            },
            contains(name) {
                return classes.has(name);
            },
        },
    };
}

/*
 * Baut eine frische Sandbox samt Zeit-/Fetch-Kontrolle auf und fuehrt das
 * echte Skript darin aus. `badge: null` simuliert eine Seite ohne
 * eingeloggte Sitzung (Badge fehlt im Markup, siehe navbar.ejs).
 */
function run({ timeoutMs = 600000, badge = createBadge(timeoutMs), fetchImpl } = {}) {
    // Realistisch groszer Startzeitpunkt (nicht 0) — genau wie ein echtes
    // Date.now() beim Seitenaufruf, das immer weit ueber PING_INTERVAL_MS
    // liegt, sodass der allererste markActive()-Aufruf tatsaechlich pingt
    // statt vom Drossel-Fenster (das bei lastPing=0 startet) verschluckt
    // zu werden.
    let currentNow = 10 * 24 * 60 * 60 * 1000;
    const timers = [];
    const fetchCalls = [];
    const locationStub = { href: null };
    const windowStub = { location: locationStub };

    const sandbox = {
        document: {
            querySelector(selector) {
                return selector === '[data-idle-remaining]' ? badge : null;
            },
        },
        window: windowStub,
        Date: { now: () => currentNow },
        setInterval(cb) {
            timers.push(cb);
            return timers.length;
        },
        clearInterval() {},
        fetch(url, opts) {
            fetchCalls.push({ url, opts });
            const impl = fetchImpl || (() => Promise.resolve({ status: 204 }));
            return Promise.resolve(impl(url, opts));
        },
    };

    vm.createContext(sandbox);
    vm.runInContext(SOURCE, sandbox);

    return {
        badge,
        location: locationStub,
        fetchCalls,
        advance(ms) {
            currentNow += ms;
        },
        tick() {
            timers.forEach(cb => cb());
        },
        markActive() {
            sandbox.window.isoShareIdleTimer.markActive();
        },
        flushMicrotasks() {
            return Promise.resolve().then(() => Promise.resolve());
        },
    };
}

test('Countdown startet sofort mit der vollen Zeit und zaehlt jede Sekunde sichtbar runter', () => {
    const env = run({ timeoutMs: 600000 });

    // render() laeuft synchron beim Laden des Skripts, ganz ohne Tick/Klick.
    assert.equal(env.badge.hidden, false);
    assert.equal(env.badge.textContent, '10:00');

    env.advance(1000);
    env.tick();
    assert.equal(env.badge.textContent, '9:59');

    env.advance(1000);
    env.tick();
    assert.equal(env.badge.textContent, '9:58');
});

test('Bloszer Zeitablauf ohne markActive() setzt den Countdown nicht zurueck', () => {
    const env = run({ timeoutMs: 600000 });

    env.advance(5 * 60 * 1000);
    env.tick();
    assert.equal(env.badge.textContent, '5:00', 'nach 5 Minuten ohne Aktivitaet bleiben genau 5 Minuten');
});

test('markActive() (Tab-Wechsel/Upload-Fortschritt) setzt den Countdown auf die volle Zeit zurueck', () => {
    const env = run({ timeoutMs: 600000 });

    env.advance(5 * 60 * 1000);
    env.tick();
    assert.equal(env.badge.textContent, '5:00');

    env.markActive();
    env.tick();
    assert.equal(env.badge.textContent, '10:00', 'markActive() muss wieder auf die volle Zeit hochgehen');
});

test('markActive() stoesst einen Keepalive-Ping an /admin/ping an, gedrosselt auf hoechstens einen pro Minute', () => {
    const env = run({ timeoutMs: 600000 });

    env.markActive();
    assert.equal(env.fetchCalls.length, 1);
    assert.equal(env.fetchCalls[0].url, '/admin/ping');

    // Direkt danach nochmal aktiv: soll nicht sofort erneut pingen.
    env.markActive();
    assert.equal(env.fetchCalls.length, 1, 'Ping ist gedrosselt auf einmal pro Minute');

    // Nach Ablauf des Drossel-Fensters darf wieder gepingt werden.
    env.advance(60000);
    env.markActive();
    assert.equal(env.fetchCalls.length, 2);
});

test('Ablauf des Countdowns ohne jede Aktivitaet fuehrt zu /logout?idle=1', () => {
    const env = run({ timeoutMs: 5000 });

    env.advance(5001);
    env.tick();
    assert.equal(env.location.href, '/logout?idle=1');
});

test('Ein 401 auf den Keepalive-Ping meldet sofort ab, auch wenn lokal noch Zeit uebrig waere', async () => {
    const env = run({
        timeoutMs: 600000,
        fetchImpl: () => ({ status: 401 }),
    });

    env.markActive();
    await env.flushMicrotasks();

    assert.equal(env.location.href, '/logout?idle=1');
});

test('Ohne Badge (keine eingeloggte Sitzung) ist markActive() ein wirkungsloser No-Op', () => {
    const env = run({ badge: null });

    assert.doesNotThrow(() => env.markActive());
    assert.equal(env.fetchCalls.length, 0);
    assert.equal(env.location.href, null);
});

test('Ein Badge ohne (oder mit ungueltiger) Zeitangabe deaktiviert den Countdown ebenfalls', () => {
    const badge = createBadge(undefined);
    const env = run({ badge });

    assert.equal(badge.hidden, true, 'ohne timeoutMs wird nie gerendert');
    assert.doesNotThrow(() => env.markActive());
    assert.equal(env.fetchCalls.length, 0);
});

test('Badge bekommt die Warnklasse erst in der letzten Minute vor Ablauf', () => {
    const env = run({ timeoutMs: 600000 }); // WARN_MS = min(60000, 600000/4) = 60000

    env.advance(538000); // 62s Rest
    env.tick();
    assert.equal(env.badge.classList.contains('badge--warning'), false, 'bei mehr als 1:00 Rest noch keine Warnung');

    env.advance(3000); // 59s Rest
    env.tick();
    assert.equal(env.badge.classList.contains('badge--warning'), true, 'unter 1:00 Rest greift die Warnung');
});
