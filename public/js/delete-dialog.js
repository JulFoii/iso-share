/* Loeschbestaetigung ueber das native <dialog> */
(function () {
  var dialog = document.getElementById("deleteDialog");
  if (!dialog) return;

  var nameEl = document.getElementById("deleteDialogFilename");
  var hidden = document.getElementById("deleteDialogInput");
  var trigger = null;

  document.addEventListener("click", function (event) {
    var button = event.target.closest("[data-delete]");
    if (!button) return;

    trigger = button;
    nameEl.textContent = button.dataset.delete;
    hidden.value = button.dataset.delete;
    dialog.showModal();
  });

  dialog.addEventListener("close", function () {
    // Fokus zurueck auf den Button, von dem der Dialog ausging
    if (trigger && document.contains(trigger)) trigger.focus();
    trigger = null;
  });
})();
