/*
 * Bereichs-Tabs der Verwaltungsseite.
 *
 * Ohne JS sind die Tab-Links normale Sprungmarken und alle Bereiche stehen
 * untereinander (kein <panel hidden> im Markup) — erst hier wird auf einen
 * aktiven Tab reduziert, damit ein no-JS-Client nie an ausgeblendeten Inhalt
 * geraet.
 */
(function () {
  var nav = document.querySelector("[data-tabs]");
  var links = nav ? nav.querySelectorAll("[data-tab-link]") : [];
  var panels = document.querySelectorAll("[data-tab-panel]");
  if (!nav || !links.length || !panels.length) return;

  var STORAGE_KEY = "iso-share-admin-tab";
  var names = Array.prototype.map.call(links, function (link) {
    return link.dataset.tabLink;
  });

  function show(name) {
    Array.prototype.forEach.call(panels, function (panel) {
      panel.hidden = panel.dataset.tabPanel !== name;
    });
    Array.prototype.forEach.call(links, function (link) {
      var active = link.dataset.tabLink === name;
      link.setAttribute("aria-current", active ? "page" : "false");
    });
    try {
      localStorage.setItem(STORAGE_KEY, name);
    } catch (e) {
      // Ohne Persistenz gilt die Auswahl nur fuer diesen Aufruf
    }
  }

  Array.prototype.forEach.call(links, function (link) {
    link.addEventListener("click", function (event) {
      event.preventDefault();
      show(link.dataset.tabLink);
      history.replaceState(null, "", link.getAttribute("href"));
      // Ein Tab-Wechsel ist aus Nutzersicht ein Seitenwechsel (Dateien /
      // Sicherheit / Konto) — siehe idle-timer.js dazu, warum nur das (und
      // kein bloszes Mausbewegen) den Idle-Countdown zuruecksetzt.
      if (window.isoShareIdleTimer) window.isoShareIdleTimer.markActive();
    });
  });

  var initial = (location.hash || "").replace("#tab-", "");
  if (names.indexOf(initial) === -1) {
    try {
      initial = localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      initial = null;
    }
  }
  if (names.indexOf(initial) === -1) initial = names[0];
  show(initial);
})();
