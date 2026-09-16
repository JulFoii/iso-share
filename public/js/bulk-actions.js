/*
 * Mehrfachauswahl in der Dateitabelle, deklarativ ueber data-*-Attribute wie
 * die uebrigen Scripts:
 *
 *   [data-select-all]     Checkbox im <thead>, (de)markiert alle Zeilen
 *   [data-select-file]    Checkbox je Zeile, value = Dateiname
 *   [data-bulk-bar]       Aktionsleiste, wird sichtbar sobald >=1 markiert
 *   [data-bulk-count]     bekommt die Anzahl markierter Dateien
 *   [data-bulk-zip]       Button: markierte Dateien als ZIP laden
 *   [data-bulk-delete]    Button (nur Admin): markierte Dateien loeschen
 *   [data-bulk-clear]     Button: Auswahl aufheben
 *   #bulkDeleteDialog     <dialog> mit Bestaetigung (nur admin.ejs)
 *
 * Ohne JavaScript bleibt die Aktionsleiste per [hidden] zu — Mehrfachauswahl
 * ist reine Erweiterung, Einzeldatei-Download/-Löschen funktionieren
 * weiterhin ganz ohne Skript.
 *
 * filetable.js bewegt Zeilen beim Sortieren/Filtern im DOM, aendert aber
 * nicht ihre Checkbox-Zustaende — die Auswahl bleibt darum ueber
 * Sortierung/Filter hinweg erhalten.
 */
(function () {
  var table = document.querySelector("[data-filetable]");
  if (!table) return;

  var selectAll = table.querySelector("[data-select-all]");
  var bar = document.querySelector("[data-bulk-bar]");
  if (!bar) return;

  var countEl = bar.querySelector("[data-bulk-count]");
  var zipButton = bar.querySelector("[data-bulk-zip]");
  var deleteButton = bar.querySelector("[data-bulk-delete]");
  var clearButton = bar.querySelector("[data-bulk-clear]");

  function notify(message, variant) {
    if (typeof window.toast === "function") window.toast(message, variant);
  }

  function checkboxes() {
    return Array.prototype.slice.call(table.querySelectorAll("[data-select-file]"));
  }

  function selected() {
    return checkboxes()
      .filter(function (box) { return box.checked; })
      .map(function (box) { return box.value; });
  }

  function refresh() {
    var names = selected();
    bar.hidden = names.length === 0;
    if (countEl) countEl.textContent = String(names.length);
    if (selectAll) {
      var all = checkboxes();
      selectAll.checked = all.length > 0 && names.length === all.length;
      selectAll.indeterminate = names.length > 0 && names.length < all.length;
    }
  }

  table.addEventListener("change", function (event) {
    if (event.target.matches("[data-select-file]")) {
      refresh();
    } else if (selectAll && event.target === selectAll) {
      checkboxes().forEach(function (box) {
        box.checked = selectAll.checked;
      });
      refresh();
    }
  });

  if (clearButton) {
    clearButton.addEventListener("click", function () {
      checkboxes().forEach(function (box) { box.checked = false; });
      refresh();
    });
  }

  if (zipButton) {
    zipButton.addEventListener("click", function () {
      var names = selected();
      if (names.length === 0) return;
      zipButton.disabled = true;

      fetch("/download-zip", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ names: names }),
      })
        .then(function (res) {
          if (!res.ok) {
            return res.json().catch(function () { return {}; }).then(function (body) {
              throw new Error(body.error || "ZIP-Download fehlgeschlagen.");
            });
          }
          return res.blob();
        })
        .then(function (blob) {
          var url = URL.createObjectURL(blob);
          var link = document.createElement("a");
          link.href = url;
          link.download = "iso-share-" + Date.now() + ".zip";
          document.body.appendChild(link);
          link.click();
          link.remove();
          setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        })
        .catch(function (err) {
          notify(err.message || "ZIP-Download fehlgeschlagen.", "error");
        })
        .finally(function () {
          zipButton.disabled = false;
        });
    });
  }

  if (deleteButton) {
    var dialog = document.getElementById("bulkDeleteDialog");
    var listEl = dialog ? dialog.querySelector("[data-bulk-delete-list]") : null;
    var confirmButton = dialog ? dialog.querySelector("[data-bulk-delete-confirm]") : null;

    deleteButton.addEventListener("click", function () {
      var names = selected();
      if (names.length === 0 || !dialog) return;
      if (listEl) listEl.textContent = names.join(", ");
      dialog.showModal();
    });

    if (confirmButton) {
      confirmButton.addEventListener("click", function () {
        var names = selected();
        confirmButton.disabled = true;

        fetch("/delete-bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ names: names }),
        })
          .then(function (res) {
            if (!res.ok) {
              return res.json().catch(function () { return {}; }).then(function (body) {
                throw new Error(body.error || "Löschen fehlgeschlagen.");
              });
            }
            return res.json();
          })
          .then(function (data) {
            dialog.close();
            notify((data.deleted || []).length + " Datei(en) gelöscht.", "success");
            // Neu laden statt DOM zu patchen: haelt Zaehler/Gesamtgroesse im
            // Seitenkopf und die Tabelle konsistent, wie delete-dialog.js es
            // fuer die Einzeldatei-Loeschung per Form-Submit ohnehin tut.
            window.location.reload();
          })
          .catch(function (err) {
            notify(err.message || "Löschen fehlgeschlagen.", "error");
          })
          .finally(function () {
            confirmButton.disabled = false;
          });
      });
    }
  }

  refresh();
})();
