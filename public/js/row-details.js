/*
 * Klappt die Detailzeile einer Datei auf, deklarativ verdrahtet:
 *
 *   <button data-row-toggle="<id der detailzeile>" aria-expanded="false">
 *   <tr id="<id>" data-detail-for="…" hidden>
 *
 * Die Detailzeile startet serverseitig als [hidden]. Ohne JavaScript bleibt
 * sie also zu — die Checksumme ist dann ueber /checksums erreichbar.
 */
(function () {
  function setExpanded(button, expanded) {
    var row = document.getElementById(button.dataset.rowToggle);
    if (!row) return;
    row.hidden = !expanded;
    button.setAttribute("aria-expanded", expanded ? "true" : "false");
  }

  document.addEventListener("click", function (event) {
    var button = event.target.closest("[data-row-toggle]");
    if (!button) return;
    setExpanded(button, button.getAttribute("aria-expanded") !== "true");
  });
})();
