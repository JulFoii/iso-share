/*
 * TOTP-Einrichtung/-Deaktivierung auf der Admin-Seite. Ohne JavaScript bleibt
 * TOTP schlicht nicht einrichtbar (die Buttons brauchen kein Formular-
 * Fallback, anders als Passwort/Benutzername) — Login per Passwort oder
 * Passkey funktioniert unveraendert.
 */
(function () {
  var setupButton = document.getElementById("totpSetupButton");
  var disableButton = document.getElementById("totpDisableButton");
  if (!setupButton && !disableButton) return;

  var statusBadge = document.getElementById("totpStatusBadge");

  function notify(message, variant) {
    if (typeof window.toast === "function") window.toast(message, variant);
  }

  function postJson(url, body) {
    return fetch(url, {
      method: "POST",
      headers: body
        ? { "Content-Type": "application/json", Accept: "application/json" }
        : { Accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  function readError(res, fallback) {
    return res
      .json()
      .catch(function () { return {}; })
      .then(function (body) {
        return (body && body.error) || fallback;
      });
  }

  function setEnabledUi(enabled) {
    if (setupButton) setupButton.hidden = enabled;
    if (disableButton) disableButton.hidden = !enabled;
    if (statusBadge) {
      statusBadge.textContent = enabled ? "Aktiv" : "Inaktiv";
      statusBadge.classList.toggle("badge--ok", enabled);
    }
  }

  var setupDialog = document.getElementById("totpSetupDialog");
  if (setupButton && setupDialog) {
    var secretDisplay = document.getElementById("totpSecretDisplay");
    var secretCopy = document.getElementById("totpSecretCopy");
    var tokenInput = document.getElementById("totpToken");
    var errorEl = document.getElementById("totpSetupError");
    var confirmButton = document.getElementById("totpSetupConfirm");
    var recoveryDialog = document.getElementById("totpRecoveryDialog");
    var recoveryList = document.getElementById("totpRecoveryList");

    setupButton.addEventListener("click", function () {
      postJson("/totp/setup")
        .then(function (res) {
          if (!res.ok) return readError(res, "Einrichtung nicht möglich.").then(function (msg) {
            throw new Error(msg);
          });
          return res.json();
        })
        .then(function (data) {
          secretDisplay.textContent = data.secret;
          if (secretCopy) secretCopy.dataset.copy = data.secret;
          tokenInput.value = "";
          errorEl.textContent = "";
          setupDialog.showModal();
          tokenInput.focus();
        })
        .catch(function (err) {
          notify(err.message || "Einrichtung nicht möglich.", "error");
        });
    });

    confirmButton.addEventListener("click", function () {
      var token = tokenInput.value.trim();
      confirmButton.disabled = true;
      postJson("/totp/confirm", { token: token })
        .then(function (res) {
          if (!res.ok) return readError(res, "Code ungültig.").then(function (msg) {
            throw new Error(msg);
          });
          return res.json();
        })
        .then(function (data) {
          setupDialog.close();
          setEnabledUi(true);
          if (recoveryDialog && recoveryList) {
            recoveryList.innerHTML = "";
            (data.recoveryCodes || []).forEach(function (code) {
              var li = document.createElement("li");
              li.textContent = code;
              recoveryList.appendChild(li);
            });
            recoveryDialog.showModal();
          }
          notify("TOTP aktiviert.", "success");
        })
        .catch(function (err) {
          errorEl.textContent = err.message || "Code ungültig.";
        })
        .finally(function () {
          confirmButton.disabled = false;
        });
    });
  }

  if (disableButton) {
    var disableDialog = document.getElementById("totpDisableDialog");
    var disableConfirm = document.getElementById("totpDisableConfirm");

    disableButton.addEventListener("click", function () {
      if (!disableDialog) return;
      disableDialog.showModal();
    });

    if (disableDialog && disableConfirm) {
      disableConfirm.addEventListener("click", function () {
        disableConfirm.disabled = true;
        postJson("/totp/disable")
          .then(function (res) {
            if (!res.ok) return readError(res, "Deaktivieren fehlgeschlagen.").then(function (msg) {
              throw new Error(msg);
            });
            disableDialog.close();
            setEnabledUi(false);
            notify("TOTP deaktiviert.", "success");
          })
          .catch(function (err) {
            notify(err.message || "Deaktivieren fehlgeschlagen.", "error");
          })
          .finally(function () {
            disableConfirm.disabled = false;
          });
      });
    }
  }
})();
