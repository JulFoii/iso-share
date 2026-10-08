/*
 * Live-Updates fuer das Ticketsystem, deklarativ wie heartbeat.js:
 *
 *   [data-live-thread data-updates-url data-updated-at]
 *       Ticket-Verlauf (Kunde und Admin). Fragt alle 15 s nach, ob sich das
 *       Ticket seit updated-at geaendert hat, und ersetzt dann den Verlauf
 *       durch das fertig gerenderte Fragment vom Server (dasselbe Partial
 *       wie beim ersten Render). Neue Nachrichten blinken kurz auf.
 *       Ein "ticket:refresh"-Event am Verlauf (composer.js nach dem Senden)
 *       aktualisiert sofort und haelt dabei das Antwortformular an seiner
 *       Bildschirmposition — die neue Nachricht erscheint darueber, ohne
 *       dass die Seite springt.
 *
 *       Statuswechsel ohne Neuladen: [data-live-show="pending …"] wird nur
 *       bei diesen Status angezeigt, [data-live-status-label] bekommt den
 *       Text aus seinem data-labels-JSON, [data-live-status-select] den Wert.
 *       Beruehrt der Wechsel einen Status aus data-live-reload-on-status
 *       (Kundenseite: Stepper, Bewertung, "Problem geloest" haengen an
 *       neu/geloest/geschlossen), wird neu geladen — das Antwortformular
 *       steht danach an derselben Bildschirmposition. Nie, solange im
 *       Antwortfeld ungesendeter Text steht.
 *
 *   [data-live-pulse data-pulse-url data-latest]
 *       Admin-Posteingang: blendet einen "Neue Aktivitaet"-Hinweis ein,
 *       solange live-regions.js die Liste nicht ersetzen darf (Auswahl
 *       aktiv, Mauszeiger darueber) — statt sie unter dem Mauszeiger
 *       umzubauen.
 *
 * Nur solange der Tab sichtbar ist. X-Idle-Background: 1 sorgt dafuer, dass
 * die automatischen Abfragen den Admin-Idle-Timeout nicht verlaengern
 * (siehe checkAuth in server.js).
 */
(function () {
  var THREAD_INTERVAL_MS = 15000;
  var PULSE_INTERVAL_MS = 30000;

  function poll(url) {
    return fetch(url, {
      headers: { Accept: "application/json", "X-Idle-Background": "1" },
      credentials: "same-origin",
    }).then(function (res) {
      if (res.status === 401) throw new Error("unauthorized");
      if (!res.ok) throw new Error("status " + res.status);
      return res.json();
    });
  }

  function every(interval, task) {
    var stopped = false;
    var timer = null;
    function tick() {
      if (stopped) return;
      if (document.visibilityState !== "visible") {
        timer = setTimeout(tick, interval);
        return;
      }
      task()
        .catch(function (err) {
          if (err && err.message === "unauthorized") stopped = true;
        })
        .then(function () {
          if (!stopped) timer = setTimeout(tick, interval);
        });
    }
    timer = setTimeout(tick, interval);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && !stopped) {
        clearTimeout(timer);
        tick();
      }
    });
  }

  var SCROLL_KEY = "ticket-live-scroll:" + location.pathname;

  // Ausgleichs-Scrollen muss sofort passieren: main.css setzt
  // scroll-behavior: smooth auf <html>, ein normales scrollBy() wuerde
  // animieren — das Formular rutschte dann erst mit dem neuen Inhalt nach
  // unten und gliche langsam zurueck, was genau wie ein Sprung aussieht.
  function jumpBy(delta) {
    if (!delta) return;
    try {
      window.scrollBy({ top: delta, left: 0, behavior: "instant" });
    } catch (err) {
      window.scrollBy(0, delta);
    }
  }

  function jumpTo(y) {
    try {
      window.scrollTo({ top: y, left: 0, behavior: "instant" });
    } catch (err) {
      window.scrollTo(0, y);
    }
  }

  function storage() {
    try {
      return window.sessionStorage;
    } catch (err) {
      return null;
    }
  }

  var thread = document.querySelector("[data-live-thread]");
  if (thread) {
    var composer = document.getElementById("reply");

    // Nach einem Neuladen wegen Statuswechsel: das Antwortformular (oder,
    // falls es fehlt, die Seite) wieder an dieselbe Bildschirmposition.
    // Zweimal: sofort und nach "load" — bis dahin koennen Schriften das
    // Layout noch verschieben. Die eigene Scroll-Wiederherstellung des
    // Browsers ist vor dem Neuladen abgeschaltet (siehe unten), sonst
    // ueberschreibt sie diese Position.
    var saved = storage() && storage().getItem(SCROLL_KEY);
    if (saved !== null && saved !== undefined) {
      storage().removeItem(SCROLL_KEY);
      var pos = {};
      try {
        pos = JSON.parse(saved) || {};
      } catch (err) {
        pos = {};
      }
      var restore = function () {
        if (composer && typeof pos.composerTop === "number") {
          jumpBy(composer.getBoundingClientRect().top - pos.composerTop);
        } else {
          jumpTo(Number(pos.scrollY) || 0);
        }
      };
      restore();
      if (document.readyState === "complete") setTimeout(restore, 0);
      else window.addEventListener("load", restore, { once: true });
      // Erst beim Verlassen wieder einschalten — sofort wuerde der Browser
      // nach dem Laden noch seine alte Position ueber unsere setzen.
      window.addEventListener("pagehide", function () {
        if ("scrollRestoration" in history) history.scrollRestoration = "auto";
      });
    }

    // Beim Laden zur verlinkten Nachricht (#message-…) kurz hervorheben
    var target = saved == null && location.hash && document.getElementById(location.hash.slice(1));
    if (target && thread.contains(target)) {
      target.classList.add("is-updated");
      setTimeout(function () {
        target.classList.remove("is-updated");
      }, 1600);
    }

    function hasDraft() {
      var field = composer && composer.querySelector("textarea");
      return !!field && field.value.trim() !== "" && field.value !== field.defaultValue;
    }

    // own: nach eigenem Senden — nicht scrollen, kein "Neue Nachricht"-Toast.
    function refresh(own) {
      var since = thread.dataset.updatedAt || "0";
      var url = thread.dataset.updatesUrl + "?since=" + encodeURIComponent(since);
      return poll(url).then(function (data) {
        if (!data.changed) return;

        var previous = thread.dataset.status;
        if (data.status && previous && data.status !== previous) {
          var reloadOn = (thread.dataset.liveReloadOnStatus || "").split(/\s+/);
          var needsReload = reloadOn.indexOf(previous) !== -1 || reloadOn.indexOf(data.status) !== -1;
          if (needsReload && !hasDraft()) {
            if (storage()) {
              storage().setItem(
                SCROLL_KEY,
                JSON.stringify({
                  scrollY: window.scrollY,
                  composerTop: composer ? composer.getBoundingClientRect().top : null,
                })
              );
            }
            if ("scrollRestoration" in history) history.scrollRestoration = "manual";
            location.reload();
            return;
          }
          applyStatus(data.status);
        }

        var known = {};
        thread.querySelectorAll("[id^='message-']").forEach(function (el) {
          known[el.id] = true;
        });
        var nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 400;
        var anchorTop = own && composer ? composer.getBoundingClientRect().top : null;

        thread.innerHTML = data.threadHtml;
        thread.dataset.updatedAt = String(data.updatedAt);
        var status = document.querySelector("[data-live-status]");
        if (status && data.statusHtml) status.innerHTML = data.statusHtml;

        // Die neue Nachricht schiebt das Formular nach unten — genau um so
        // viel zurueckscrollen, dass es optisch stehen bleibt.
        if (anchorTop !== null) {
          jumpBy(composer.getBoundingClientRect().top - anchorTop);
        }

        var fresh = [];
        thread.querySelectorAll("[id^='message-']").forEach(function (el) {
          if (!known[el.id]) fresh.push(el);
        });
        fresh.forEach(function (el) {
          el.classList.add("is-updated");
          setTimeout(function () {
            el.classList.remove("is-updated");
          }, 1600);
        });
        if (own) return;
        if (fresh.length && nearBottom) {
          fresh[fresh.length - 1].scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
        if (fresh.length && typeof window.toast === "function") {
          window.toast(fresh.length === 1 ? "Neue Nachricht im Ticket" : fresh.length + " neue Nachrichten", "info");
        }
      });
    }

    function applyStatus(status) {
      thread.dataset.status = status;
      // Auch defaultSelected: das ist jetzt der Server-Stand, keine
      // Eingabe des Admins — sonst hielte live-regions.js das Formular fuer
      // "in Bearbeitung" und liesse es nie mehr aktualisieren.
      document.querySelectorAll("[data-live-status-select]").forEach(function (select) {
        Array.prototype.forEach.call(select.options, function (option) {
          option.defaultSelected = option.value === status;
        });
        select.value = status;
      });
      document.querySelectorAll("[data-live-show]").forEach(function (el) {
        el.hidden = el.dataset.liveShow.split(/\s+/).indexOf(status) === -1;
      });
      document.querySelectorAll("[data-live-status-label]").forEach(function (el) {
        try {
          var labels = JSON.parse(el.dataset.labels || "{}");
          if (labels[status]) el.textContent = labels[status];
        } catch (err) {
          // Label bleibt stehen.
        }
      });
    }

    thread.addEventListener("ticket:refresh", function () {
      refresh(true).catch(function () {
        // Faellt auf das naechste regulaere Polling zurueck.
      });
    });

    every(THREAD_INTERVAL_MS, function () {
      return refresh(false);
    });
  }

  var pulse = document.querySelector("[data-live-pulse]");
  if (pulse) {
    // live-regions.js haelt die Liste selbst aktuell; der Hinweis ist nur
    // noch der Fallback fuer die Zeit, in der sie gerade nicht ersetzt
    // werden darf (Auswahl aktiv, Mauszeiger darueber). Sobald die Liste
    // wieder dem Server-Stand entspricht, verschwindet er.
    document.addEventListener("live:page", function (event) {
      if (event.detail.inSync.indexOf("inbox-list") === -1) return;
      var fresh = event.detail.doc.querySelector("[data-live-pulse]");
      if (fresh) pulse.dataset.latest = fresh.dataset.latest;
      pulse.hidden = true;
    });
    every(PULSE_INTERVAL_MS, function () {
      return poll(pulse.dataset.pulseUrl).then(function (data) {
        if (Number(data.latest) > Number(pulse.dataset.latest || 0)) pulse.hidden = false;
      });
    });
  }
})();
