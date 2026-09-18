/*
 * Sichtbarer Countdown bis zur automatischen Abmeldung wegen Inaktivitaet
 * (wie bei Banken) — rein clientseitige Anzeige, das serverseitige
 * checkAuth in server.js bleibt die eigentliche Durchsetzung.
 *
 * Opt-in ueber das Badge in partials/navbar.ejs (data-idle-remaining +
 * data-idle-timeout-ms), also nur sichtbar, wenn eine Sitzung besteht. Der
 * Countdown startet sofort bei jedem Seitenaufruf (Login inklusive, da der
 * ist selbst ein voller Seitenaufruf) bei den vollen 10 Minuten und laeuft
 * jede Sekunde sichtbar runter — bewusst OHNE auf bloszes Mausbewegen,
 * Scrollen oder Tastendruck zu reagieren, das waere kein "man ist wieder
 * aktiv", nur ein Zufallssignal, das den Countdown de facto einfriert.
 *
 * Zurueckgesetzt wird er ausschlieszlich durch window.isoShareIdleTimer.
 * markActive(), aufgerufen von:
 *   - admin-tabs.js  bei einem Wechsel zwischen Dateien/Sicherheit/Konto
 *     (clientseitiger "Seitenwechsel" ohne echten Reload)
 *   - upload.js      waehrend ein Chunk-Upload tatsaechlich Fortschritt
 *     macht, sonst wuerde ein groszer Upload, bei dem niemand zwischen
 *     Tabs wechselt, mitten im Transfer clientseitig ausgeloggt und der
 *     laufende XHR mit der Seite weggerissen
 * markActive() setzt den Countdown auf die volle Zeit zurueck UND stoesst
 * — throttled auf hoechstens einmal pro PING_INTERVAL_MS — einen
 * Keepalive-Request an /admin/ping an, der die echte Sitzung in checkAuth
 * verlaengert (fuer den Tab-Wechsel-Fall, der selbst keinen Request an den
 * Server schickt). Das automatische Heartbeat-Polling (siehe
 * heartbeat.js/server.js) ruft markActive() bewusst nie auf — ein einfach
 * offen gelassener, unbeobachteter Tab soll den Countdown nicht ewig oben
 * halten.
 */
(function () {
  function noop() {}

  var badge = document.querySelector("[data-idle-remaining]");
  var timeoutMs = badge ? Number(badge.dataset.idleTimeoutMs) || 0 : 0;

  if (!badge || timeoutMs <= 0) {
    window.isoShareIdleTimer = { markActive: noop };
    return;
  }

  var PING_URL = "/admin/ping";
  var PING_INTERVAL_MS = 60000;
  var WARN_MS = Math.min(60000, timeoutMs / 4);

  var expiresAt = Date.now() + timeoutMs;
  var lastPing = 0;
  var expired = false;

  function format(ms) {
    var totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    var minutes = Math.floor(totalSeconds / 60);
    var seconds = totalSeconds % 60;
    return minutes + ":" + (seconds < 10 ? "0" : "") + seconds;
  }

  function expire() {
    if (expired) return;
    expired = true;
    // ?idle=1: server.js' /logout zeigt dann auf /login?idle=1 statt auf
    // '/', damit nach dem automatischen Abmelden dieselbe Meldung erscheint
    // wie beim serverseitig erkannten Idle-Timeout in checkAuth.
    window.location.href = "/logout?idle=1";
  }

  function render() {
    var remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      expire();
      return;
    }
    badge.hidden = false;
    badge.textContent = format(remaining);
    badge.classList.toggle("badge--warning", remaining <= WARN_MS);
  }

  function ping() {
    var now = Date.now();
    if (now - lastPing < PING_INTERVAL_MS) return;
    lastPing = now;
    fetch(PING_URL, { headers: { Accept: "application/json" } })
      .then(function (res) {
        if (res.status === 401) expire();
      })
      .catch(function () {
        // Netzwerkfehler: naechster Tick/Ping versucht es erneut, kein
        // sofortiges Ausloggen bei einer bloss kurz weggebrochenen Leitung.
      });
  }

  function markActive() {
    if (expired) return;
    expiresAt = Date.now() + timeoutMs;
    ping();
  }

  window.isoShareIdleTimer = { markActive: markActive };

  render();
  setInterval(render, 1000);
})();
