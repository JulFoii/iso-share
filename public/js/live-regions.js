/*
 * Live-Bereiche: haelt Teile einer Seite automatisch aktuell, ohne dass die
 * Seite dafuer ein eigenes Fragment-Endpoint braucht — deklarativ wie
 * heartbeat.js/ticket-live.js:
 *
 *   <body data-live-page [data-live-url="/admin/ticket-settings"]>
 *       Fragt alle 20 s dieselbe Seite (bzw. data-live-url, falls die Seite
 *       nach einem fehlgeschlagenen POST unter der Formular-URL gerendert
 *       wurde) erneut ab und ersetzt jeden [data-live-region="key"], dessen
 *       Inhalt sich gegenueber dem neuen Server-Render geaendert hat. Kein
 *       zweites Template: der Server rendert exakt dieselbe Seite.
 *
 *   [data-live-region="key"]
 *       Ein austauschbarer Bereich. Wird nie ersetzt, solange der Nutzer
 *       darin arbeitet: Fokus in einem Feld, ein geaendertes Feld (Wert,
 *       Haken, Auswahl), ein offener <dialog> — sonst ginge Getipptes
 *       verloren. Der Bereich wird dann beim naechsten Durchlauf erneut
 *       versucht. Mit data-live-guard-hover zusaetzlich nicht, solange der
 *       Mauszeiger darueber steht (Listen, in die man gerade klicken will).
 *
 *   Ohne data-live-page (und ohne heartbeat.js) wird nur der Ticket-Zaehler
 *   der Navigation aktuell gehalten, ueber GET /partials/nav — sofern die
 *   Seite ihn ueberhaupt zeigt (nur fuer Angemeldete).
 *
 *   [data-live-key] innerhalb eines Bereichs
 *       Wiedererkennung einzelner Eintraege: neue blinken kurz auf, und ein
 *       aufgeklapptes <details data-live-key> bleibt nach dem Ersetzen offen.
 *
 * Verglichen wird mit dem zuletzt vom Server gelieferten Markup, nicht mit
 * dem aktuellen DOM — andere Scripts duerfen den Bereich also veraendern
 * (Klassen, Zaehler), ohne dass das als Aenderung gilt. Darum muss dieses
 * Script vor den anderen eingebunden werden (defer haelt die Reihenfolge).
 *
 * heartbeat.js nutzt dieselbe Ersetzungslogik ueber window.LiveRegions.apply()
 * fuer die Bereiche auf admin.ejs, die es ohnehin schon abfragt.
 *
 * Nur bei sichtbarem Tab; X-Idle-Background: 1 sorgt dafuer, dass die
 * Abfragen den Admin-Idle-Timeout nicht verlaengern (checkAuth in server.js).
 */
(function () {
  var INTERVAL_MS = 20000;
  var FLASH_MS = 1200;

  function normalize(html) {
    return String(html || "")
      .replace(/>\s+</g, "><")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Ueber einen <template> geparst, damit Server-HTML und DOM-Stand gleich
  // serialisiert verglichen werden (Attribut-Quoting, Entities).
  function serialize(html) {
    var template = document.createElement("template");
    template.innerHTML = html;
    return normalize(template.innerHTML);
  }

  var pristine = new WeakMap();

  function regions(root) {
    var map = {};
    root.querySelectorAll("[data-live-region]").forEach(function (el) {
      map[el.getAttribute("data-live-region")] = el;
    });
    return map;
  }

  function remember(el) {
    if (!pristine.has(el)) pristine.set(el, normalize(el.innerHTML));
  }

  document.querySelectorAll("[data-live-region]").forEach(remember);

  /*
   * Index der Option, die ein einfaches <select> ohne Nutzereingriff zeigt.
   * Ohne `selected`-Attribut waehlt der Browser die erste nicht deaktivierte
   * Option, deren defaultSelected aber false ist — ein reiner Vergleich
   * selected/defaultSelected hielte jedes solche Feld (z. B. "— keine —" bei
   * Kategorie/ISO-Datei eines Tickets) fuer geaendert, und der Bereich wuerde
   * nie mehr aktualisiert. Bei mehreren `selected` gewinnt die letzte.
   */
  function defaultIndex(select) {
    var index = -1;
    var firstEnabled = -1;
    Array.prototype.forEach.call(select.options, function (option, i) {
      if (option.defaultSelected) index = i;
      if (firstEnabled === -1 && !option.disabled) firstEnabled = i;
    });
    return index !== -1 ? index : firstEnabled;
  }

  function isDirty(field) {
    if (field.type === "checkbox" || field.type === "radio") return field.checked !== field.defaultChecked;
    if (field.tagName === "SELECT") {
      if (!field.multiple && field.size <= 1) return field.selectedIndex !== defaultIndex(field);
      return Array.prototype.some.call(field.options, function (option) {
        return option.selected !== option.defaultSelected;
      });
    }
    if (field.type === "file") return field.files && field.files.length > 0;
    if ("defaultValue" in field) return field.value !== field.defaultValue;
    return false;
  }

  function isBusy(region) {
    var active = document.activeElement;
    if (active && active !== document.body && region.contains(active) && active.matches("input, textarea, select, [contenteditable]")) {
      return true;
    }
    if (region.querySelector("dialog[open]")) return true;
    if (region.hasAttribute("data-live-guard-hover") && region.matches(":hover")) return true;
    // Der Bereich kann selbst ein Feld sein (<select data-live-region>, dessen
    // Optionen ersetzt werden) — querySelectorAll findet nur Nachfahren.
    var fields = Array.prototype.slice.call(region.querySelectorAll("input, textarea, select"));
    if (region.matches("select")) fields.push(region);
    return fields.some(isDirty);
  }

  function flash(el) {
    el.classList.add("is-updated");
    setTimeout(function () {
      el.classList.remove("is-updated");
    }, FLASH_MS);
  }

  function replace(region, html) {
    var knownKeys = {};
    var openKeys = {};
    region.querySelectorAll("[data-live-key]").forEach(function (el) {
      knownKeys[el.getAttribute("data-live-key")] = true;
      if (el.tagName === "DETAILS" && el.open) openKeys[el.getAttribute("data-live-key")] = true;
    });
    region.innerHTML = html;
    pristine.set(region, normalize(region.innerHTML));

    region.querySelectorAll("[data-live-key]").forEach(function (el) {
      var key = el.getAttribute("data-live-key");
      if (el.tagName === "DETAILS" && openKeys[key]) el.open = true;
      if (!knownKeys[key]) flash(el);
    });
    region.dispatchEvent(new CustomEvent("live:updated", { bubbles: true }));
  }

  /*
   * Wendet neue Inhalte auf die Bereiche der aktuellen Seite an. `incoming`
   * ist entweder ein geparstes Dokument (Seiten-Polling) oder ein Objekt
   * { key: html } (heartbeat.js). Liefert die Schluessel der Bereiche, die
   * danach dem Server-Stand entsprechen (ersetzt oder schon gleich).
   */
  function apply(incoming) {
    var current = regions(document);
    var next = {};
    if (incoming && typeof incoming.querySelectorAll === "function") {
      var found = regions(incoming);
      Object.keys(found).forEach(function (key) {
        next[key] = found[key].innerHTML;
      });
    } else {
      next = incoming || {};
    }

    var inSync = [];
    Object.keys(current).forEach(function (key) {
      if (typeof next[key] !== "string") return;
      var region = current[key];
      remember(region);
      if (serialize(next[key]) === pristine.get(region)) {
        inSync.push(key);
        return;
      }
      if (isBusy(region)) return;
      replace(region, next[key]);
      inSync.push(key);
    });
    return inSync;
  }

  window.LiveRegions = { apply: apply };

  var body = document.body;
  if (!body) return;
  if (!("DOMParser" in window) || !("fetch" in window)) return;

  // Seiten ohne eigenes Polling (Hilfeartikel-Editor, Event-Detail, Impressum
  // …) haben trotzdem den Ticket-Zaehler in der Navigation, sobald jemand
  // angemeldet ist: den holt ein kleiner JSON-Endpoint statt der ganzen
  // Seite. heartbeat.js liefert ihn auf seinen Seiten selbst mit.
  var navOnly = !body.hasAttribute("data-live-page");
  if (navOnly && (body.hasAttribute("data-heartbeat") || !document.querySelector('[data-live-region="nav-count"]'))) return;

  var url = navOnly ? "/partials/nav" : body.getAttribute("data-live-url") || location.pathname + location.search;
  var stopped = false;
  var timer = null;

  function tick() {
    return fetch(url, {
      headers: { Accept: navOnly ? "application/json" : "text/html", "X-Idle-Background": "1" },
      credentials: "same-origin",
    })
      .then(function (res) {
        // Umgeleitet (abgemeldet, Idle-Timeout, Seite gibt es nicht mehr)
        // oder Fehler: aufhoeren statt immer wieder dasselbe zu versuchen.
        if (res.redirected || res.status === 401 || res.status === 403 || res.status === 404) {
          stopped = true;
          return null;
        }
        if (!res.ok) return null;
        return navOnly ? res.json() : res.text();
      })
      .then(function (html) {
        if (!html) return;
        if (navOnly) {
          apply(html.regions);
          return;
        }
        var doc = new DOMParser().parseFromString(html, "text/html");
        var inSync = apply(doc);
        document.dispatchEvent(new CustomEvent("live:page", { detail: { doc: doc, inSync: inSync } }));
      })
      .catch(function () {
        // Netzwerkfehler: naechster Durchlauf versucht es erneut.
      });
  }

  var inFlight = false;

  function schedule(delay) {
    clearTimeout(timer);
    timer = setTimeout(run, delay);
  }

  function run() {
    if (stopped || inFlight) return;
    if (document.visibilityState !== "visible") return schedule(INTERVAL_MS);
    inFlight = true;
    tick().then(function () {
      inFlight = false;
      if (!stopped) schedule(INTERVAL_MS);
    });
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") run();
  });

  schedule(INTERVAL_MS);
})();
