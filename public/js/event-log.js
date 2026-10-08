/*
 * Event-Log-Dashboard (views/admin/logs.ejs):
 *
 *   [data-event-filters]   Auswahlfelder und Checkboxen schicken das
 *                          Filterformular sofort ab; ohne JS gibt es den
 *                          "Filtern"-Knopf.
 *   tr[data-event-id]      Klick auf eine Zeile oeffnet die Details im
 *                          <dialog id="eventDialog"> (GET /admin/logs/:id
 *                          ?partial=1). Ohne JS fuehrt der Zeit-Link auf
 *                          die eigene Detailseite. Strg/Cmd-Klick und
 *                          mittlere Maustaste bleiben normale Links.
 *
 * Die Zeilen koennen von live-regions.js ersetzt werden — darum per
 * Event-Delegation am Dokument statt an den Zeilen selbst.
 */
(function () {
  var form = document.querySelector("[data-event-filters]");
  if (form) {
    form.addEventListener("change", function (event) {
      var target = event.target;
      if (!target || target.type === "search" || target.type === "datetime-local") return;
      // Ein gewaehltes Preset hebt einen eigenen Zeitraum auf
      if (target.name === "range") {
        form.querySelectorAll('input[type="datetime-local"]').forEach(function (input) {
          input.value = "";
        });
      }
      form.requestSubmit ? form.requestSubmit() : form.submit();
    });
    // Leere Felder nicht in die URL schreiben (kuerzere, teilbare Links)
    form.addEventListener("submit", function () {
      form.querySelectorAll("input, select").forEach(function (field) {
        if (field.name && field.value === "" && field.type !== "checkbox") field.disabled = true;
      });
      if (form.querySelector('select[name="range"]').value === "custom") {
        form.querySelector('select[name="range"]').disabled = true;
      }
    });
  }

  var dialog = document.getElementById("eventDialog");
  if (!dialog || typeof dialog.showModal !== "function") return;
  var body = dialog.querySelector("[data-event-dialog-body]");
  var pageLink = dialog.querySelector("[data-event-dialog-link]");
  var pending = null;

  function open(id) {
    var url = "/admin/logs/" + encodeURIComponent(id);
    if (pending) pending.abort();
    pending = new AbortController();
    body.innerHTML = '<p class="hint">Lade …</p>';
    pageLink.href = url;
    if (!dialog.open) dialog.showModal();
    fetch(url + "?partial=1", {
      headers: { Accept: "text/html" },
      credentials: "same-origin",
      signal: pending.signal,
    })
      .then(function (res) {
        if (res.status === 401) {
          window.location.href = "/login";
          return null;
        }
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.text();
      })
      .then(function (html) {
        if (html === null) return;
        // Vom eigenen Server, serverseitig vollstaendig escaped
        var template = document.createElement("template");
        template.innerHTML = html;
        body.replaceChildren(template.content);
      })
      .catch(function (err) {
        if (err.name === "AbortError") return;
        body.innerHTML = '<p class="hint text-danger">Details konnten nicht geladen werden.</p>';
      });
  }

  document.addEventListener("click", function (event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    var row = event.target.closest("tr[data-event-id]");
    if (!row) return;
    // Links innerhalb der Zeile (ausser dem Zeit-Link) normal folgen lassen
    var link = event.target.closest("a");
    if (link && !link.hasAttribute("data-event-open")) return;
    // Textauswahl in der Zeile nicht als Klick werten
    if (window.getSelection && String(window.getSelection()).length > 0) return;
    event.preventDefault();
    open(row.dataset.eventId);
  });

  dialog.addEventListener("close", function () {
    if (pending) pending.abort();
  });
})();
