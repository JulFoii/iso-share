/*
 * Backup-Verwaltung auf der Admin-Seite: manuelle Sicherung, Zeitplan-
 * Einstellungen, Loeschen und Wiederherstellen. Erstellen/Einstellungen
 * bleiben normale Formular-Submits mit Progressive Enhancement (siehe
 * account-forms.js fuer dasselbe Muster) — Loeschen/Wiederherstellen sind
 * wie bei api-tokens.js/webauthn.js JS-only, weil beide ein <dialog> mit
 * Rueckfrage brauchen, die es ohne JS nicht geben kann.
 */
(function () {
  function notify(message, variant) {
    if (typeof window.toast === "function") window.toast(message, variant);
  }

  function readError(res, fallback) {
    return res
      .json()
      .catch(function () {
        return {};
      })
      .then(function (body) {
        return (body && body.error) || fallback;
      });
  }

  /* --------------------------------------------------- Jetzt sichern -- */
  var createForm = document.getElementById("backupCreateForm");
  var list = document.getElementById("backupList");

  if (createForm && list) {
    createForm.addEventListener("submit", function (event) {
      event.preventDefault();
      var button = document.getElementById("backupCreateButton");
      if (button) button.disabled = true;

      fetch(createForm.action, {
        method: "POST",
        headers: { Accept: "application/json" },
      })
        .then(function (res) {
          if (!res.ok)
            return readError(res, "Sicherung fehlgeschlagen.").then(function (msg) {
              throw new Error(msg);
            });
          return res.json();
        })
        .then(function () {
          notify("Sicherung erstellt.", "success");
          location.reload();
        })
        .catch(function (err) {
          notify(err.message || "Sicherung fehlgeschlagen.", "error");
        })
        .finally(function () {
          if (button) button.disabled = false;
        });
    });
  }

  /* ------------------------------------------------------- Zeitplan -- */
  var settingsForm = document.getElementById("backupSettingsForm");
  if (settingsForm) {
    settingsForm.addEventListener("submit", function (event) {
      event.preventDefault();
      var submitButton = settingsForm.querySelector('button[type="submit"]');
      if (submitButton) submitButton.disabled = true;

      var enabledInput = document.getElementById("backupEnabled");
      fetch(settingsForm.action, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          intervalMinutes: Number(document.getElementById("backupInterval").value),
          retentionCount: Number(document.getElementById("backupRetention").value),
          enabled: Boolean(enabledInput && enabledInput.checked),
        }),
      })
        .then(function (res) {
          if (!res.ok)
            return readError(res, "Einstellungen konnten nicht gespeichert werden.").then(function (msg) {
              throw new Error(msg);
            });
          return res.json();
        })
        .then(function () {
          // Gespeicherte Werte sind jetzt der Server-Stand — sonst hielte
          // live-regions.js die Felder weiter fuer "in Bearbeitung" und
          // wuerde Aenderungen aus einem anderen Tab nie uebernehmen.
          settingsForm.querySelectorAll("input").forEach(function (input) {
            input.defaultValue = input.value;
            input.defaultChecked = input.checked;
          });
          notify("Zeitplan gespeichert.", "success");
        })
        .catch(function (err) {
          notify(err.message || "Einstellungen konnten nicht gespeichert werden.", "error");
        })
        .finally(function () {
          if (submitButton) submitButton.disabled = false;
        });
    });
  }

  if (!list) return;

  /* --------------------------------------------------------- Loeschen -- */
  var deleteDialog = document.getElementById("backupDeleteDialog");
  var deleteConfirm = document.getElementById("backupDeleteConfirm");
  var deleteFilenameEl = document.getElementById("backupDeleteFilename");
  var pendingDeleteFile = null;

  document.addEventListener("click", function (event) {
    var button = event.target.closest("[data-backup-delete]");
    if (!button || !deleteDialog) return;
    pendingDeleteFile = button.dataset.backupDelete;
    if (deleteFilenameEl) deleteFilenameEl.textContent = pendingDeleteFile;
    deleteDialog.showModal();
  });

  if (deleteDialog && deleteConfirm) {
    deleteConfirm.addEventListener("click", function () {
      if (!pendingDeleteFile) return;
      var file = pendingDeleteFile;
      deleteConfirm.disabled = true;

      fetch("/admin/backups/" + encodeURIComponent(file), { method: "DELETE" })
        .then(function (res) {
          deleteDialog.close();
          if (!res.ok) {
            notify("Sicherung konnte nicht gelöscht werden.", "error");
            return;
          }
          var row = list.querySelector('[data-backup-file="' + file + '"]');
          if (row) row.remove();
          if (!list.querySelector("[data-backup-file]")) {
            var empty = document.createElement("li");
            empty.className = "empty";
            empty.setAttribute("data-backup-empty", "");
            empty.innerHTML =
              '<p class="empty__title">Noch keine Sicherung</p>' +
              '<p class="empty__text">Läuft automatisch nach Zeitplan, oder jetzt manuell anstoßen.</p>';
            list.appendChild(empty);
          }
          notify("Sicherung gelöscht.", "success");
        })
        .catch(function () {
          deleteDialog.close();
          notify("Netzwerkfehler.", "error");
        })
        .finally(function () {
          deleteConfirm.disabled = false;
          pendingDeleteFile = null;
        });
    });
  }

  /* --------------------------------------------------- Wiederherstellen -- */
  var restoreDialog = document.getElementById("backupRestoreDialog");
  var restoreConfirm = document.getElementById("backupRestoreConfirm");
  var restoreFilenameEl = document.getElementById("backupRestoreFilename");
  var restoreInput = document.getElementById("backupRestoreConfirmInput");
  var restoreError = document.getElementById("backupRestoreError");
  var pendingRestoreFile = null;

  document.addEventListener("click", function (event) {
    var button = event.target.closest("[data-backup-restore]");
    if (!button || !restoreDialog) return;
    pendingRestoreFile = button.dataset.backupRestore;
    if (restoreFilenameEl) restoreFilenameEl.textContent = pendingRestoreFile;
    if (restoreInput) restoreInput.value = "";
    if (restoreError) restoreError.textContent = "";
    if (restoreConfirm) restoreConfirm.disabled = true;
    restoreDialog.showModal();
    if (restoreInput) restoreInput.focus();
  });

  if (restoreInput && restoreConfirm) {
    restoreInput.addEventListener("input", function () {
      restoreConfirm.disabled = restoreInput.value !== pendingRestoreFile;
    });
  }

  if (restoreDialog && restoreConfirm) {
    restoreConfirm.addEventListener("click", function () {
      if (!pendingRestoreFile || restoreInput.value !== pendingRestoreFile) return;
      var file = pendingRestoreFile;
      restoreConfirm.disabled = true;

      fetch("/admin/backups/" + encodeURIComponent(file) + "/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ confirm: file }),
      })
        .then(function (res) {
          return res.json().then(function (body) {
            if (!res.ok) throw new Error((body && body.error) || "Wiederherstellung fehlgeschlagen.");
            return body;
          });
        })
        .then(function () {
          restoreDialog.close();
          notify("Wiederhergestellt — Server startet neu …", "success");
          setTimeout(function () {
            location.href = "/login";
          }, 4000);
        })
        .catch(function (err) {
          if (restoreError) restoreError.textContent = err.message || "Wiederherstellung fehlgeschlagen.";
          restoreConfirm.disabled = false;
        });
    });
  }
})();
