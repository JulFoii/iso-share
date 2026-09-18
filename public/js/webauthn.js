/*
 * Passkey-Registrierung (Admin-Seite) und Passkey-Login (Login-Seite) in
 * einer Datei, weil beide dieselben base64url-Helfer und dasselbe
 * postJson()-Muster wie upload.js brauchen. Jeder Block guardet sich ueber
 * seine eigenen DOM-Elemente und ist auf der jeweils anderen Seite ein No-op
 * — dasselbe Prinzip wie in den uebrigen Scripts unter public/js/.
 */
(function () {
  if (!window.PublicKeyCredential) return;

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
      .catch(function () {
        return {};
      })
      .then(function (body) {
        return (body && body.error) || fallback;
      });
  }

  /*
   * navigator.credentials.create()/.get() lehnen mit einer DOMException ab,
   * deren .message der rohe, auf Englisch gehaltene Browser-/Spec-Text ist
   * (z. B. "The operation either timed out or was not allowed..." samt Link
   * in die WebAuthn-Spec) — nicht zum Anzeigen gedacht. Hier wird nur
   * anhand des .name (stabil, browserunabhaengig) auf eine eigene deutsche
   * Meldung abgebildet; alles andere (Server-Antworten aus readError())
   * bleibt unangetastet, weil die schon eigene Texte tragen.
   */
  var WEBAUTHN_ERROR_MESSAGES = {
    NotAllowedError: "Vorgang abgebrochen oder Zeit abgelaufen. Bitte erneut versuchen.",
    AbortError: "Vorgang abgebrochen.",
    SecurityError: "Sicherheitsfehler — passt die Adresse zu der, unter der der Passkey angelegt wurde?",
    NotSupportedError: "Dieser Browser oder dieses Gerät unterstützt diese Passkey-Funktion nicht.",
    InvalidStateError: "Dieser Passkey ist bereits registriert.",
    ConstraintError: "Die Anforderungen des Geräts konnten nicht erfüllt werden.",
    UnknownError: "Unbekannter Fehler beim Passkey-Vorgang.",
  };

  function friendlyWebauthnError(err) {
    var message = WEBAUTHN_ERROR_MESSAGES[err && err.name];
    return new Error(message || "Passkey-Vorgang fehlgeschlagen.");
  }

  function bufferToBase64url(buffer) {
    var bytes = new Uint8Array(buffer);
    var str = "";
    for (var i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
    return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function base64urlToBuffer(base64url) {
    var padded = base64url.replace(/-/g, "+").replace(/_/g, "/");
    while (padded.length % 4) padded += "=";
    var str = atob(padded);
    var bytes = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
    return bytes.buffer;
  }

  /* ---------------------------------------------------------- Login-Seite */

  (function () {
    var button = document.getElementById("passkeyLoginButton");
    if (!button) return;
    button.hidden = false;

    button.addEventListener("click", function () {
      button.disabled = true;

      postJson("/webauthn/login/options")
        .then(function (res) {
          if (!res.ok) return readError(res, "Passkey-Anmeldung nicht möglich.").then(function (msg) {
            throw new Error(msg);
          });
          return res.json();
        })
        .then(function (options) {
          options.challenge = base64urlToBuffer(options.challenge);
          (options.allowCredentials || []).forEach(function (cred) {
            cred.id = base64urlToBuffer(cred.id);
          });
          return navigator.credentials.get({ publicKey: options }).catch(function (err) {
            throw friendlyWebauthnError(err);
          });
        })
        .then(function (assertion) {
          var credential = {
            id: assertion.id,
            rawId: bufferToBase64url(assertion.rawId),
            type: assertion.type,
            response: {
              clientDataJSON: bufferToBase64url(assertion.response.clientDataJSON),
              authenticatorData: bufferToBase64url(assertion.response.authenticatorData),
              signature: bufferToBase64url(assertion.response.signature),
              userHandle: assertion.response.userHandle
                ? bufferToBase64url(assertion.response.userHandle)
                : undefined,
            },
            clientExtensionResults: assertion.getClientExtensionResults(),
          };
          return postJson("/webauthn/login/verify", { credential });
        })
        .then(function (res) {
          if (!res.ok) return readError(res, "Anmeldung fehlgeschlagen.").then(function (msg) {
            throw new Error(msg);
          });
          return res.json();
        })
        .then(function (body) {
          window.location.assign(body.redirect || "/admin-upload");
        })
        .catch(function (err) {
          notify(err.message || "Anmeldung fehlgeschlagen.", "error");
          button.disabled = false;
        });
    });
  })();

  /* ---------------------------------------------------------- Admin-Seite */

  (function () {
    var addButton = document.getElementById("passkeyAddButton");
    var unsupportedHint = document.getElementById("passkeyUnsupportedHint");
    var list = document.getElementById("passkeyList");
    if (!addButton) return;

    addButton.hidden = false;
    if (unsupportedHint) unsupportedHint.hidden = true;

    function addRow(passkey) {
      var empty = list.querySelector("[data-passkey-empty]");
      if (empty) empty.remove();

      var li = document.createElement("li");
      li.className = "row row--between";
      li.dataset.passkeyId = passkey.credentialId;
      li.innerHTML =
        '<span>' + passkey.label + ' <span class="hint">— gerade hinzugefügt</span></span>' +
        '<button type="button" class="btn btn--danger-ghost btn--sm" data-passkey-delete="' +
        passkey.credentialId + '">Entfernen</button>';
      list.appendChild(li);
    }

    addButton.addEventListener("click", function () {
      addButton.disabled = true;

      postJson("/webauthn/register/options")
        .then(function (res) {
          if (!res.ok) return readError(res, "Registrierung nicht möglich.").then(function (msg) {
            throw new Error(msg);
          });
          return res.json();
        })
        .then(function (options) {
          options.challenge = base64urlToBuffer(options.challenge);
          options.user.id = base64urlToBuffer(options.user.id);
          (options.excludeCredentials || []).forEach(function (cred) {
            cred.id = base64urlToBuffer(cred.id);
          });
          return navigator.credentials.create({ publicKey: options }).catch(function (err) {
            throw friendlyWebauthnError(err);
          });
        })
        .then(function (created) {
          var credential = {
            id: created.id,
            rawId: bufferToBase64url(created.rawId),
            type: created.type,
            response: {
              clientDataJSON: bufferToBase64url(created.response.clientDataJSON),
              attestationObject: bufferToBase64url(created.response.attestationObject),
              transports: created.response.getTransports
                ? created.response.getTransports()
                : [],
            },
            clientExtensionResults: created.getClientExtensionResults(),
          };
          return postJson("/webauthn/register/verify", { credential: credential });
        })
        .then(function (res) {
          if (!res.ok) return readError(res, "Registrierung fehlgeschlagen.").then(function (msg) {
            throw new Error(msg);
          });
          return fetch("/webauthn/credentials", { headers: { Accept: "application/json" } });
        })
        .then(function (res) {
          return res.json();
        })
        .then(function (passkeys) {
          list.innerHTML = "";
          passkeys.forEach(addRow);
          notify("Passkey hinzugefügt.", "success");
        })
        .catch(function (err) {
          notify(err.message || "Registrierung fehlgeschlagen.", "error");
        })
        .finally(function () {
          addButton.disabled = false;
        });
    });

    var deleteDialog = document.getElementById("passkeyDeleteDialog");
    var deleteConfirm = document.getElementById("passkeyDeleteConfirm");
    var pendingDeleteId = null;

    document.addEventListener("click", function (event) {
      var button = event.target.closest("[data-passkey-delete]");
      if (!button || !deleteDialog) return;
      pendingDeleteId = button.dataset.passkeyDelete;
      deleteDialog.showModal();
    });

    if (deleteDialog && deleteConfirm) {
      deleteConfirm.addEventListener("click", function () {
        if (!pendingDeleteId) return;
        var id = pendingDeleteId;
        deleteConfirm.disabled = true;

        fetch("/webauthn/credentials/" + encodeURIComponent(id), {
          method: "DELETE",
        }).then(function (res) {
          deleteDialog.close();
          if (!res.ok) {
            notify("Passkey konnte nicht entfernt werden.", "error");
            return;
          }
          var row = list.querySelector('[data-passkey-id="' + id + '"]');
          if (row) row.remove();
          if (!list.querySelector("[data-passkey-id]")) {
            var empty = document.createElement("li");
            empty.className = "empty";
            empty.setAttribute("data-passkey-empty", "");
            empty.innerHTML =
              '<p class="empty__title">Keine Passkeys</p>' +
              '<p class="empty__text">Füge einen Passkey hinzu, um dich künftig ohne Passwort anzumelden.</p>';
            list.appendChild(empty);
          }
          notify("Passkey entfernt.", "success");
        }).catch(function () {
          deleteDialog.close();
          notify("Netzwerkfehler.", "error");
        }).finally(function () {
          deleteConfirm.disabled = false;
          pendingDeleteId = null;
        });
      });
    }
  })();
})();
