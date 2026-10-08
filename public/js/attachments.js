/*
 * Anhang-Auswahl fuer Ticket-Formulare (partials/attachment-input.ejs,
 * data-attachments). Ohne JS bleibt es ein normales <input type=file
 * multiple>; hier kommen dazu:
 *   - Drag & Drop auf die Zone
 *   - Bilder aus der Zwischenablage ins Textfeld einfuegen (Screenshot!)
 *   - Liste der gewaehlten Dateien mit Entfernen-Knopf
 *   - clientseitige Vorpruefung von Anzahl/Groesse (der Server prueft
 *     trotzdem alles selbst, inkl. Dateityp per Magic-Bytes)
 * Die Dateien werden in einem DataTransfer gesammelt und dem Input wieder
 * zugewiesen, damit das normale Formular-Submit sie mitschickt.
 */
(function () {
  if (typeof DataTransfer === "undefined") return;

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
    return (bytes / 1024 / 1024).toFixed(1).replace(".", ",") + " MB";
  }

  // Eine Datei knapp neben der Ablagezone fallen gelassen: der Browser
  // oeffnete sie sonst selbst und verliesse die Seite — samt angefangenem
  // Text. Nur auf Seiten mit Anhang-Feld, nur fuer Dateien.
  if (document.querySelector("[data-attachments]")) {
    ["dragover", "drop"].forEach(function (type) {
      window.addEventListener(type, function (event) {
        var types = event.dataTransfer && event.dataTransfer.types;
        if (types && Array.prototype.indexOf.call(types, "Files") !== -1) event.preventDefault();
      });
    });
  }

  function notify(message) {
    if (typeof window.toast === "function") window.toast(message, "error");
    else if (typeof window.appAlert === "function") window.appAlert(message);
  }

  document.querySelectorAll("[data-attachments]").forEach(function (root) {
    var input = root.querySelector('input[type="file"]');
    var zone = root.querySelector(".attach__zone");
    var list = root.querySelector("[data-attachment-list]");
    if (!input || !zone || !list) return;

    var maxFiles = Number(root.dataset.maxFiles) || 5;
    var maxBytes = (Number(root.dataset.maxMb) || 10) * 1024 * 1024;
    var store = new DataTransfer();

    function render() {
      list.innerHTML = "";
      Array.prototype.forEach.call(store.files, function (file, index) {
        var item = document.createElement("li");
        item.className = "attach__item";

        var name = document.createElement("span");
        name.className = "attach__name";
        name.textContent = file.name;

        var size = document.createElement("span");
        size.className = "attach__size";
        size.textContent = formatSize(file.size);

        var remove = document.createElement("button");
        remove.type = "button";
        remove.className = "btn btn--ghost btn--sm btn--icon";
        remove.setAttribute("aria-label", file.name + " entfernen");
        remove.innerHTML =
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
        remove.addEventListener("click", function () {
          var next = new DataTransfer();
          Array.prototype.forEach.call(store.files, function (f, i) {
            if (i !== index) next.items.add(f);
          });
          store = next;
          sync();
        });

        item.appendChild(name);
        item.appendChild(size);
        item.appendChild(remove);
        list.appendChild(item);
      });
      list.hidden = store.files.length === 0;
    }

    function sync() {
      input.files = store.files;
      render();
    }

    // composer.js setzt das Formular nach dem Senden per fetch zurueck.
    if (input.form) {
      input.form.addEventListener("reset", function () {
        store = new DataTransfer();
        setTimeout(sync, 0);
      });
    }

    function addFiles(files) {
      Array.prototype.forEach.call(files, function (file) {
        var duplicate = Array.prototype.some.call(store.files, function (f) {
          return f.name === file.name && f.size === file.size;
        });
        if (duplicate) return;
        if (store.files.length >= maxFiles) {
          notify("Höchstens " + maxFiles + " Anhänge pro Nachricht.");
          return;
        }
        if (file.size > maxBytes) {
          notify("„" + file.name + "“ ist zu groß (max. " + formatSize(maxBytes) + ").");
          return;
        }
        store.items.add(file);
      });
      sync();
    }

    input.addEventListener("change", function () {
      // Der native Dialog ersetzt die Auswahl — hier stattdessen anhaengen.
      var picked = Array.prototype.slice.call(input.files);
      input.files = store.files;
      addFiles(picked);
    });

    ["dragenter", "dragover"].forEach(function (type) {
      zone.addEventListener(type, function (event) {
        event.preventDefault();
        zone.classList.add("is-dragover");
      });
    });
    ["dragleave", "drop"].forEach(function (type) {
      zone.addEventListener(type, function (event) {
        event.preventDefault();
        zone.classList.remove("is-dragover");
      });
    });
    zone.addEventListener("drop", function (event) {
      if (event.dataTransfer && event.dataTransfer.files.length) addFiles(event.dataTransfer.files);
    });

    var form = root.closest("form");
    var textarea = form && form.querySelector("textarea");
    if (textarea) {
      textarea.addEventListener("paste", function (event) {
        var files = event.clipboardData && event.clipboardData.files;
        if (!files || files.length === 0) return;
        event.preventDefault();
        // Screenshots heissen in der Zwischenablage meist "image.png" —
        // mit Zeitstempel eindeutig machen, sonst greift die Duplikat-Pruefung.
        var renamed = Array.prototype.map.call(files, function (file) {
          if (!/^image\//.test(file.type)) return file;
          var ext = file.type.split("/")[1] || "png";
          var stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          return new File([file], "screenshot-" + stamp + "." + ext, { type: file.type });
        });
        addFiles(renamed);
      });
    }
  });
})();
