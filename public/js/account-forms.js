/*
 * Account-Formulare (Passwort, Benutzername): laufen ohne JS als normaler
 * Form-Submit (Redirect bzw. Inline-Fehler in der neu gerenderten Seite,
 * siehe admin.ejs). Mit JS wird der Submit abgefangen und das Ergebnis
 * stattdessen in einem eigenen Modal angezeigt (Erfolg wie Fehler), ohne die
 * Seite neu zu laden. Beide Formulare brauchen exakt dieselbe Logik, daher
 * eine gemeinsame Hilfsfunktion statt zweier fast identischer Kopien.
 */
(function () {
  function wireAsyncForm(formId, dialogId, successTitle, successMessage) {
    var form = document.getElementById(formId);
    var dialog = document.getElementById(dialogId);
    if (!form || !dialog) return;

    var titleEl = dialog.querySelector("[data-result-title]");
    var textEl = dialog.querySelector("[data-result-text]");

    function showResult(ok, title, message) {
      titleEl.textContent = title;
      textEl.textContent = message;
      dialog.showModal();
    }

    form.addEventListener("submit", function (event) {
      event.preventDefault();

      var submitButton = form.querySelector('button[type="submit"]');
      if (submitButton) submitButton.disabled = true;

      fetch(form.action, {
        method: "POST",
        headers: { Accept: "application/json" },
        body: new URLSearchParams(new FormData(form)),
      })
        .then(function (res) {
          return res
            .json()
            .catch(function () {
              return {};
            })
            .then(function (data) {
              return { ok: res.ok, data: data };
            });
        })
        .then(function (result) {
          if (result.ok) {
            var wasPassword = form.querySelector('input[type="password"]');
            if (wasPassword) form.reset();
            showResult(true, successTitle, successMessage);
          } else {
            showResult(false, "Fehler", result.data.error || "Änderung fehlgeschlagen.");
          }
        })
        .catch(function () {
          showResult(false, "Fehler", "Netzwerkfehler — bitte erneut versuchen.");
        })
        .finally(function () {
          if (submitButton) submitButton.disabled = false;
        });
    });
  }

  wireAsyncForm(
    "passwordForm",
    "passwordResultDialog",
    "Passwort geändert",
    "Das neue Passwort gilt ab sofort für neue Anmeldungen."
  );
  wireAsyncForm(
    "usernameForm",
    "usernameResultDialog",
    "Benutzername geändert",
    "Der neue Benutzername gilt ab sofort für neue Anmeldungen."
  );
})();
