/*
 * API-Token-Verwaltung auf der Admin-Seite (Erstellen/Widerrufen). Kein
 * Formular-Fallback ohne JavaScript, wie schon bei totp.js — /admin/api-
 * tokens gibt es nur fuer den JS-Client, das Erstellen eines Tokens ohne
 * Moeglichkeit, es danach einmalig anzuzeigen, waere ohnehin nutzlos.
 */
(function () {
  var addButton = document.getElementById("apiTokenAddButton");
  var list = document.getElementById("apiTokenList");
  if (!addButton || !list) return;

  function notify(message, variant) {
    if (typeof window.toast === "function") window.toast(message, variant);
  }

  function postJson(url, body) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body || {}),
    });
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

  function formatDate(ts) {
    return new Date(ts).toLocaleDateString("de-DE", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  }

  function addRow(token) {
    var empty = list.querySelector("[data-token-empty]");
    if (empty) empty.remove();

    var scopeBadges = (token.scopes || [])
      .map(function (scope) {
        return '<span class="badge badge--mono">' + scope + "</span>";
      })
      .join(" ");

    var li = document.createElement("li");
    li.className = "row row--between";
    li.dataset.tokenId = token.id;
    li.innerHTML =
      "<span>" +
      (token.label || "Unbenanntes Token") +
      " " +
      scopeBadges +
      ' <span class="hint">— erstellt ' +
      formatDate(token.createdAt) +
      ", noch nicht genutzt</span></span>" +
      '<button type="button" class="btn btn--danger-ghost btn--sm" data-token-delete="' +
      token.id +
      '">Entfernen</button>';
    list.appendChild(li);
  }

  var createDialog = document.getElementById("apiTokenCreateDialog");
  var resultDialog = document.getElementById("apiTokenResultDialog");

  if (createDialog) {
    var labelInput = document.getElementById("apiTokenLabel");
    var readCheckbox = document.getElementById("apiTokenScopeRead");
    var writeCheckbox = document.getElementById("apiTokenScopeWrite");
    var errorEl = document.getElementById("apiTokenCreateError");
    var confirmButton = document.getElementById("apiTokenCreateConfirm");
    var resultValue = document.getElementById("apiTokenResultValue");
    var resultCopy = document.getElementById("apiTokenResultCopy");

    addButton.addEventListener("click", function () {
      labelInput.value = "";
      readCheckbox.checked = true;
      writeCheckbox.checked = false;
      errorEl.textContent = "";
      createDialog.showModal();
      labelInput.focus();
    });

    confirmButton.addEventListener("click", function () {
      var scopes = [];
      if (readCheckbox.checked) scopes.push("read");
      if (writeCheckbox.checked) scopes.push("write");
      if (scopes.length === 0) {
        errorEl.textContent = "Mindestens eine Berechtigung auswählen.";
        return;
      }

      confirmButton.disabled = true;
      postJson("/admin/api-tokens", { label: labelInput.value.trim(), scopes: scopes })
        .then(function (res) {
          if (!res.ok)
            return readError(res, "Token konnte nicht erstellt werden.").then(function (msg) {
              throw new Error(msg);
            });
          return res.json();
        })
        .then(function (token) {
          createDialog.close();
          addRow(token);
          if (resultDialog && resultValue) {
            resultValue.textContent = token.token;
            if (resultCopy) resultCopy.dataset.copy = token.token;
            resultDialog.showModal();
          }
          notify("Token erstellt.", "success");
        })
        .catch(function (err) {
          errorEl.textContent = err.message || "Token konnte nicht erstellt werden.";
        })
        .finally(function () {
          confirmButton.disabled = false;
        });
    });
  }

  var deleteDialog = document.getElementById("apiTokenDeleteDialog");
  var deleteConfirm = document.getElementById("apiTokenDeleteConfirm");
  var pendingDeleteId = null;

  document.addEventListener("click", function (event) {
    var button = event.target.closest("[data-token-delete]");
    if (!button || !deleteDialog) return;
    pendingDeleteId = button.dataset.tokenDelete;
    deleteDialog.showModal();
  });

  if (deleteDialog && deleteConfirm) {
    deleteConfirm.addEventListener("click", function () {
      if (!pendingDeleteId) return;
      var id = pendingDeleteId;
      deleteConfirm.disabled = true;

      fetch("/admin/api-tokens/" + encodeURIComponent(id), {
        method: "DELETE",
      })
        .then(function (res) {
          deleteDialog.close();
          if (!res.ok) {
            notify("Token konnte nicht widerrufen werden.", "error");
            return;
          }
          var row = list.querySelector('[data-token-id="' + id + '"]');
          if (row) row.remove();
          if (!list.querySelector("[data-token-id]")) {
            var empty = document.createElement("li");
            empty.className = "empty";
            empty.setAttribute("data-token-empty", "");
            empty.innerHTML =
              '<p class="empty__title">Keine API-Tokens</p>' +
              '<p class="empty__text">Erstelle ein Token, um Dateien per Skript hoch-/herunterzuladen oder zu verwalten.</p>';
            list.appendChild(empty);
          }
          notify("Token widerrufen.", "success");
        })
        .catch(function () {
          deleteDialog.close();
          notify("Netzwerkfehler.", "error");
        })
        .finally(function () {
          deleteConfirm.disabled = false;
          pendingDeleteId = null;
        });
    });
  }
})();
