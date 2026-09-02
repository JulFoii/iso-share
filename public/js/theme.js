/*
 * Farbschema-Auswahl.
 *
 * Gespeichert wird die Absicht ("system" | "light" | "dark"), auf <html>
 * landet der aufgeloeste Wert — dieselbe Aufteilung wie in theme-init.js.
 * Das Oeffnen/Schliessen des Menues macht die Popover API selbst, hier haengt
 * nur die Auswahl dran.
 */
(function () {
  var STORAGE_KEY = "iso-share-theme";
  var CHOICES = ["system", "light", "dark"];
  var LABELS = { system: "System", light: "Hell", dark: "Dunkel" };

  var root = document.documentElement;
  var trigger = document.querySelector("[data-theme-toggle]");
  var menu = document.getElementById("themeMenu");
  if (!trigger || !menu) return;

  var items = menu.querySelectorAll("[data-theme-choice]");
  var systemQuery = window.matchMedia("(prefers-color-scheme: light)");

  function resolve(choice) {
    if (choice !== "system") return choice;
    return systemQuery.matches ? "light" : "dark";
  }

  function apply(choice) {
    root.dataset.theme = resolve(choice);
    root.dataset.themePreference = choice;

    CHOICES.forEach(function (name) {
      var icon = trigger.querySelector('[data-theme-icon="' + name + '"]');
      if (icon) icon.hidden = name !== choice;
    });

    Array.prototype.forEach.call(items, function (item) {
      item.setAttribute(
        "aria-checked",
        item.dataset.themeChoice === choice ? "true" : "false"
      );
    });

    trigger.setAttribute("aria-label", "Farbschema: " + LABELS[choice]);
    trigger.setAttribute("title", "Farbschema: " + LABELS[choice]);
  }

  var current = root.dataset.themePreference || "system";
  if (CHOICES.indexOf(current) === -1) current = "system";
  apply(current);

  function choose(choice) {
    current = choice;
    try {
      if (choice === "system") {
        localStorage.removeItem(STORAGE_KEY);
      } else {
        localStorage.setItem(STORAGE_KEY, choice);
      }
    } catch (e) {
      // Ohne Persistenz gilt die Wahl nur fuer diese Seite
    }
    apply(choice);
  }

  Array.prototype.forEach.call(items, function (item) {
    item.addEventListener("click", function () {
      choose(item.dataset.themeChoice);
      menu.hidePopover();
    });
  });

  // Kann der Browser keine Popovers, tut popovertarget nichts und das Menue
  // ist per CSS ausgeblendet. Dann schaltet der Button selbst durch, damit das
  // Farbschema nicht unerreichbar wird.
  if (typeof menu.hidePopover !== "function") {
    trigger.removeAttribute("popovertarget");
    trigger.addEventListener("click", function () {
      choose(CHOICES[(CHOICES.indexOf(current) + 1) % CHOICES.length]);
    });
  }

  // Folgt dem System, solange der Nutzer nichts Eigenes gewaehlt hat
  systemQuery.addEventListener("change", function () {
    if (current === "system") apply("system");
  });
})();
