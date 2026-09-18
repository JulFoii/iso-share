/*
 * Tag-Entfernen in der Detailzeile (nur admin.ejs), deklarativ wie die
 * uebrigen Scripts:
 *
 *   [data-tag-remove]     Button, DELETE /files/:name/tags/:tag
 *
 * Tags werden nur automatisch vergeben (siehe lib/auto-tags.js) — hier laesst
 * sich lediglich ein einzelner (falscher) Tag entfernen, JS-only wie die
 * Passkey-Verwaltung und /delete-bulk.
 *
 * Nach der Aktion wird die Seite neu geladen statt den DOM zu patchen —
 * dasselbe Muster wie bulk-actions.js fuer /delete-bulk, haelt Badges in
 * der Namenszelle und Chips in der Detailzeile ohne doppelte Logik in Sync.
 */
(function () {
  function notify(message, variant) {
    if (typeof window.toast === "function") window.toast(message, variant);
  }

  document.addEventListener("click", function (event) {
    var button = event.target.closest("[data-tag-remove]");
    if (!button) return;
    event.preventDefault();
    button.disabled = true;

    var url =
      "/files/" +
      encodeURIComponent(button.dataset.tagFile) +
      "/tags/" +
      encodeURIComponent(button.dataset.tagValue);

    fetch(url, { method: "DELETE", headers: { Accept: "application/json" } })
      .then(function (res) {
        if (!res.ok) throw new Error("Tag konnte nicht entfernt werden.");
        window.location.reload();
      })
      .catch(function (err) {
        notify(err.message, "error");
        button.disabled = false;
      });
  });
})();
