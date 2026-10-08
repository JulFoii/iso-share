/*
 * Kein Sprung nach oben nach dem Absenden eines Formulars.
 *
 * Fast jedes Formular im Projekt ist ein klassischer POST mit Redirect
 * zurueck auf dieselbe Seite (Wiedervorlage, Eigenschaften, Einstellungen,
 * Sammelaktionen …) — der Browser laedt die Seite dann neu und steht wieder
 * ganz oben. Dieses Skript merkt sich beim Absenden die Scrollposition und
 * stellt sie nach dem Laden wieder her, wenn die Antwort auf derselben Seite
 * (gleicher Pfad) landet. Eingebunden ueber partials/footer.ejs.
 *
 * Nicht wiederhergestellt wird:
 *   - auf einer anderen Seite (Zusammenfuehren -> Ziel-Ticket, Loeschen ->
 *     Liste, Fehlerseite unter der POST-URL)
 *   - wenn der Server selbst einen Anker gesetzt hat, der nicht schon im
 *     action-Attribut stand (Antwort -> #message-…): der Sprung ist gewollt
 *   - bei per fetch verschickten Formularen (preventDefault) und
 *     [data-scroll-top]
 *
 * Erfolgsmeldungen oben auf der Seite (.alert--success) waeren nach dem
 * Wiederherstellen ausser Sicht — sie erscheinen dann zusaetzlich als Toast.
 */
(function () {
  var KEY = "iso-share-scroll";
  var TTL_MS = 15000;

  function storage() {
    try {
      return window.sessionStorage;
    } catch (e) {
      return null;
    }
  }

  /*
   * Gemerkt wird neben scrollY auch, wo das abgeschickte Formular im
   * Fenster stand (action + Abstand zur Oberkante). Nach dem Laden kommt oft
   * oben eine Meldung dazu oder ein Bereich wird hoeher — dann steht dasselbe
   * Formular wieder an derselben Stelle im Fenster, statt dass die Seite um
   * genau diese Hoehe versetzt ist. Fehlt das Formular danach (geloeschter
   * Eintrag), gilt scrollY.
   */
  function remember(hash, form) {
    var store = storage();
    if (!store) return;
    var action = form ? form.getAttribute("action") : null;
    try {
      store.setItem(
        KEY,
        JSON.stringify({
          path: location.pathname, y: window.scrollY, at: Date.now(), hash: hash || "",
          action: action, top: form ? form.getBoundingClientRect().top : null,
        })
      );
    } catch (e) {
      /* voller oder gesperrter Speicher: dann eben ohne */
    }
  }

  // Fuer Skripte, die nach einer Aktion selbst navigieren
  // (location.assign auf dieselbe Seite, z. B. upload.js).
  window.keepScroll = function () {
    remember("");
  };

  // Bubble-Phase: confirm.js (Capture) und Skripte, die per fetch senden,
  // haben da schon preventDefault() aufgerufen, wenn sie das Absenden abfangen.
  document.addEventListener("submit", function (event) {
    var form = event.target;
    if (event.defaultPrevented || !(form instanceof HTMLFormElement)) return;
    if (form.hasAttribute("data-scroll-top")) return;
    var target = (event.submitter && event.submitter.getAttribute("formtarget")) || form.getAttribute("target");
    if (target && target !== "_self") return;
    var action;
    try {
      action = new URL(form.action, location.href);
    } catch (e) {
      return;
    }
    remember(action.hash, form);
  });

  var store = storage();
  var saved = null;
  if (store) {
    try {
      saved = JSON.parse(store.getItem(KEY) || "null");
      store.removeItem(KEY);
    } catch (e) {
      saved = null;
    }
  }
  if (!saved || typeof saved.y !== "number") return;
  if (Date.now() - saved.at > TTL_MS || saved.path !== location.pathname) return;
  if (location.hash && location.hash !== saved.hash) return;

  // Der Anker aus dem action-Attribut (#snooze, #merge …) hat nur noch fuer
  // Fehlerseiten ohne JS eine Aufgabe — sonst zoege er beim Laden/Neuladen
  // wieder dorthin.
  if (location.hash && window.history && history.replaceState) {
    history.replaceState(history.state, "", location.pathname + location.search);
  }

  function anchorForm() {
    if (!saved.action || typeof saved.top !== "number") return null;
    var forms = document.forms;
    for (var i = 0; i < forms.length; i += 1) {
      if (forms[i].getAttribute("action") === saved.action) return forms[i];
    }
    return null;
  }

  function apply() {
    var form = anchorForm();
    var y = form ? form.getBoundingClientRect().top + window.scrollY - saved.top : saved.y;
    // "instant": main.css setzt scroll-behavior: smooth — sonst sieht man die
    // Seite beim Laden erst nach unten fahren
    window.scrollTo({ top: Math.max(0, y), left: 0, behavior: "instant" });
  }
  // Erfolgsmeldung ausser Sicht -> zusaetzlich als Toast. Erst nach dem
  // endgueltigen Wiederherstellen pruefen (vorher ist die Seite oft noch
  // nicht hoch genug, die Meldung laege scheinbar im Bild); toast.js ist bis
  // dahin ebenfalls geladen.
  function flashOutOfView() {
    if (typeof window.toast !== "function") return;
    document.querySelectorAll("main .alert--success").forEach(function (alert) {
      var rect = alert.getBoundingClientRect();
      if (rect.bottom <= 0 || rect.top >= window.innerHeight) window.toast(alert.textContent.trim(), "success");
    });
  }

  apply();
  // Bilder, Schriften und der Anker-Sprung des Browsers kommen erst noch
  window.addEventListener("load", function () {
    apply();
    requestAnimationFrame(function () {
      apply();
      flashOutOfView();
    });
  });
})();
