/*
 * Sortieren + Live-Filtern der Dateitabelle, rein deklarativ verdrahtet:
 *
 *   <table data-filetable>            Tabelle
 *   <button class="table__sort">      im <th>, sortiert dessen Spalte
 *   <td data-value="...">             Sortierschluessel (sonst textContent)
 *   <tr data-search="...">            Text, gegen den gefiltert wird
 *   <input data-filter>               Filterfeld
 *   [data-filter-empty]               Hinweis, wenn nichts uebrig bleibt
 *   [data-visible-count]              bekommt die Anzahl sichtbarer Zeilen
 *
 * Der Server liefert unter /search bzw. /admin-search dieselbe Ansicht, das
 * Filtern hier ist nur die schnelle Variante ohne Roundtrip.
 */
(function () {
  var table = document.querySelector("[data-filetable]");
  if (!table) return;

  var tbody = table.tBodies[0];
  var rows = Array.prototype.slice.call(tbody.rows);
  var emptyHint = document.querySelector("[data-filter-empty]");
  var countTargets = document.querySelectorAll("[data-visible-count]");

  /* ---------------------------------------------------------------- Sortieren */

  var buttons = table.querySelectorAll(".table__sort");

  function sortValue(row, index, numeric) {
    var cell = row.cells[index];
    if (!cell) return numeric ? 0 : "";
    var raw = cell.dataset.value;
    if (raw === undefined) raw = cell.textContent.trim();
    return numeric ? parseFloat(raw) || 0 : raw.toLowerCase();
  }

  function sortBy(button) {
    var th = button.closest("th");
    var index = th.cellIndex;
    var numeric = button.dataset.sortType === "number";
    // Erster Klick auf Text aufsteigend, auf Zahlen absteigend (das grosse
    // Image zuerst ist die Frage, die man bei Groesse/Datum meist hat).
    var previous = button.dataset.sortDir;
    var direction;
    if (previous === "ascending") {
      direction = "descending";
    } else if (previous === "descending") {
      direction = "ascending";
    } else {
      direction = numeric ? "descending" : "ascending";
    }

    // aria-sort gehoert an den columnheader, das data-Attribut steuert nur die
    // Pfeilrichtung im Icon.
    for (var i = 0; i < buttons.length; i++) {
      delete buttons[i].dataset.sortDir;
      buttons[i].closest("th").removeAttribute("aria-sort");
    }
    button.dataset.sortDir = direction;
    th.setAttribute("aria-sort", direction);

    var factor = direction === "ascending" ? 1 : -1;
    rows.sort(function (a, b) {
      var va = sortValue(a, index, numeric);
      var vb = sortValue(b, index, numeric);
      if (va < vb) return -1 * factor;
      if (va > vb) return 1 * factor;
      return 0;
    });

    var fragment = document.createDocumentFragment();
    rows.forEach(function (row) {
      fragment.appendChild(row);
    });
    tbody.appendChild(fragment);
  }

  for (var i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener("click", function (event) {
      sortBy(event.currentTarget);
    });
  }

  /* ------------------------------------------------------------------ Filtern */

  var input = document.querySelector("[data-filter]");
  if (!input) return;

  function filter() {
    var query = input.value.trim().toLowerCase();
    var visible = 0;

    rows.forEach(function (row) {
      var haystack = (row.dataset.search || row.textContent).toLowerCase();
      var match = query === "" || haystack.indexOf(query) !== -1;
      row.hidden = !match;
      if (match) visible++;
    });

    if (emptyHint) emptyHint.hidden = visible !== 0;
    table.hidden = visible === 0;
    for (var j = 0; j < countTargets.length; j++) {
      countTargets[j].textContent = visible;
    }
  }

  input.addEventListener("input", filter);

  // Escape leert das Feld, wie in jeder anderen Suchleiste auch
  input.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && input.value !== "") {
      event.stopPropagation();
      input.value = "";
      filter();
    }
  });

  // "/" fokussiert die Suche, solange nicht gerade getippt wird
  document.addEventListener("keydown", function (event) {
    if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    var active = document.activeElement;
    if (
      active &&
      (active.tagName === "INPUT" ||
        active.tagName === "TEXTAREA" ||
        active.isContentEditable)
    ) {
      return;
    }
    event.preventDefault();
    input.focus();
    input.select();
  });

  if (input.value) filter();
})();
