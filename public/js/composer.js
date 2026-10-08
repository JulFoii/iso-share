/*
 * Komfort fuer die Ticket-Formulare — alles optional, ohne JS funktionieren
 * die Formulare genauso:
 *
 *   [data-composer]      Strg/Cmd+Enter sendet, Doppel-Submit wird
 *                        verhindert, Warnung beim Verlassen mit ungesendetem
 *                        Text, Umschalter Antwort/Interne Notiz (Admin),
 *                        Vorbelegung mit Anrede/Grussformel
 *                        (data-reply-template, Cursor an data-reply-caret)
 *   [data-composer][data-async]
 *                        Sendet per fetch statt per Seitenwechsel: kein
 *                        Sprung nach oben, das Formular wird geleert und
 *                        der Verlauf ([data-live-thread], ticket-live.js)
 *                        sofort aktualisiert. Fehler erscheinen in
 *                        [data-composer-error]. Ohne fetch/FormData oder
 *                        ohne Verlauf auf der Seite: normales Absenden.
 *   [data-canned]        Textbaustein (bzw. Link auf einen Hilfeartikel) an
 *                        der Cursorposition einfuegen — mehrere pro Formular
 *   [data-bulk-form]     "Alle auswaehlen" + Anzahl im Posteingang
 *   [data-autosubmit]    Filter-Selects schicken das Formular sofort ab
 */
(function () {
  document.querySelectorAll("[data-composer]").forEach(function (form) {
    var textarea = form.querySelector("textarea");
    var submit = form.querySelector('button[type="submit"]');
    var submitting = false;
    var initial = textarea ? textarea.value : "";
    var template = (textarea && textarea.dataset.replyTemplate) || "";
    var caret = textarea ? Number(textarea.dataset.replyCaret) || 0 : 0;
    var squash = function (value) {
      return value.replace(/\s+/g, " ").trim();
    };
    // Noch nichts Eigenes geschrieben: leer oder nur die Vorbelegung.
    var untouched = function () {
      var value = squash(textarea.value);
      return value === "" || (template !== "" && value === squash(template));
    };

    // Beim ersten Fokus auf die unveraenderte Vorbelegung landet der Cursor
    // zwischen Anrede und Grussformel statt am Ende. setTimeout, weil ein
    // Klick den Cursor erst nach dem focus-Event setzt.
    if (textarea && template) {
      textarea.addEventListener(
        "focus",
        function () {
          setTimeout(function () {
            if (textarea.value === template && textarea.selectionStart === textarea.selectionEnd) {
              textarea.setSelectionRange(caret, caret);
            }
          }, 0);
        },
        { once: true }
      );
    }

    if (textarea) {
      textarea.addEventListener("keydown", function (event) {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          if (typeof form.requestSubmit === "function") form.requestSubmit();
          else form.submit();
        }
      });
    }

    var thread = document.querySelector("[data-live-thread]");
    var errorBox = form.querySelector("[data-composer-error]");
    var asyncSend =
      form.hasAttribute("data-async") && !!thread && typeof fetch === "function" && typeof FormData === "function";

    function setBusy(busy) {
      if (!submit) return;
      submit.classList.toggle("is-busy", busy);
      if (busy) {
        // Erst nach dem Absenden deaktivieren — ein disabled-Button wuerde
        // sonst gar nicht erst mitgeschickt.
        setTimeout(function () {
          submit.disabled = true;
        }, 0);
      } else {
        submit.disabled = false;
      }
    }

    function showError(message) {
      if (!errorBox) {
        if (message && typeof window.toast === "function") window.toast(message, "error");
        return;
      }
      errorBox.innerHTML = "";
      errorBox.hidden = !message;
      if (!message) return;
      var alert = document.createElement("div");
      alert.className = "alert alert--danger";
      alert.setAttribute("role", "alert");
      var text = document.createElement("span");
      text.textContent = message;
      alert.appendChild(text);
      errorBox.appendChild(alert);
    }

    // Eine Fehlermeldung vom letzten Versuch verschwindet, sobald weiter-
    // geschrieben wird — sonst stuende sie noch da, wenn laengst Text im
    // Feld ist.
    if (textarea && errorBox) {
      textarea.addEventListener("input", function () {
        if (!errorBox.hidden) showError("");
      });
    }

    form.addEventListener("submit", function (event) {
      if (submitting) {
        event.preventDefault();
        return;
      }
      submitting = true;
      setBusy(true);
      if (!asyncSend) return;

      event.preventDefault();
      var checked = form.querySelector('input[name="mode"]:checked');
      var wasNote = !!checked && checked.value === "note";
      showError("");
      fetch(form.action, {
        method: "POST",
        body: new FormData(form),
        headers: { Accept: "application/json" },
        credentials: "same-origin",
      })
        .then(function (res) {
          // Sitzung abgelaufen (Admin-Idle-Timeout, Kunden-Logout): neu
          // laden fuehrt zur Anmeldung.
          if (res.status === 401) {
            location.reload();
            throw new Error("");
          }
          return res
            .json()
            .catch(function () {
              return {};
            })
            .then(function (data) {
              if (!res.ok || !data.ok) {
                throw new Error(
                  data.error ||
                    (res.status === 429
                      ? "Zu viele Nachrichten in kurzer Zeit — bitte kurz warten."
                      : "Senden fehlgeschlagen — bitte erneut versuchen.")
                );
              }
              return data;
            });
        })
        .then(function () {
          // Zurueck auf den Ausgangszustand der Seite: Textfeld (beim Admin
          // wieder mit Anrede/Grussformel), Modus "Antwort", Status
          // "Automatisch", keine Anhaenge (attachments.js hoert auf reset).
          form.reset();
          if (typeof update === "function") update();
          initial = textarea ? textarea.value : "";
          thread.dispatchEvent(new CustomEvent("ticket:refresh"));
          if (typeof window.toast === "function") {
            window.toast(wasNote ? "Notiz gespeichert" : "Antwort gesendet", "success");
          }
        })
        .catch(function (err) {
          if (err && err.message) showError(err.message);
        })
        .then(function () {
          submitting = false;
          setBusy(false);
        });
    });

    window.addEventListener("beforeunload", function (event) {
      if (submitting || !textarea || textarea.value.trim() === initial.trim() || untouched()) return;
      event.preventDefault();
      event.returnValue = "";
    });

    // Admin: Antwort vs. interne Notiz
    var modes = form.querySelectorAll('input[name="mode"]');
    if (modes.length && textarea) {
      var replyPlaceholder = textarea.placeholder;
      var notePlaceholder = textarea.dataset.notePlaceholder || replyPlaceholder;
      var update = function () {
        var checked = form.querySelector('input[name="mode"]:checked');
        var mode = checked ? checked.value : "reply";
        form.dataset.mode = mode;
        textarea.placeholder = mode === "note" ? notePlaceholder : replyPlaceholder;
        return mode;
      };
      modes.forEach(function (radio) {
        radio.addEventListener("change", function () {
          var mode = update();
          // Anrede/Grussformel gehoeren nur zur Antwort: bei einer Notiz
          // raus, zurueck bei der Antwort wieder rein — beides nur, solange
          // noch nichts Eigenes im Feld steht.
          if (template && untouched()) {
            textarea.value = mode === "note" ? "" : template;
          }
          textarea.focus();
          if (mode === "reply" && textarea.value === template) textarea.setSelectionRange(caret, caret);
        });
      });
      update();
    }

    form.querySelectorAll("[data-canned]").forEach(function (canned) {
      if (!textarea) return;
      canned.hidden = false;
      canned.addEventListener("change", function () {
        var option = canned.options[canned.selectedIndex];
        var text = option && option.dataset.body;
        if (text) {
          var start = textarea.selectionStart || 0;
          var end = textarea.selectionEnd || 0;
          var before = textarea.value.slice(0, start);
          var after = textarea.value.slice(end);
          var glue = before && !/\n$/.test(before) ? "\n" : "";
          textarea.value = before + glue + text + after;
          var caret = (before + glue + text).length;
          textarea.focus();
          textarea.setSelectionRange(caret, caret);
        }
        canned.selectedIndex = 0;
      });
    });
  });

  document.querySelectorAll("[data-bulk-form]").forEach(function (form) {
    var all = form.querySelector("[data-select-all]");
    var actions = form.querySelector("[data-bulk-actions]");
    var count = form.querySelector("[data-bulk-count]");
    form.classList.add("js-bulk");
    var boxes = function () {
      return form.querySelectorAll('input[name="numbers"]');
    };
    var update = function () {
      var checked = Array.prototype.filter.call(boxes(), function (box) {
        return box.checked;
      }).length;
      if (actions) actions.classList.toggle("is-active", checked > 0);
      if (count) count.textContent = checked > 0 ? checked + " ausgewählt" : "";
      if (all) {
        all.checked = checked > 0 && checked === boxes().length;
        all.indeterminate = checked > 0 && checked < boxes().length;
      }
    };
    if (all) {
      all.addEventListener("change", function () {
        boxes().forEach(function (box) {
          box.checked = all.checked;
        });
        update();
      });
    }
    form.addEventListener("change", function (event) {
      if (event.target && event.target.name === "numbers") update();
    });
    update();
  });

  document.querySelectorAll("form[data-autosubmit]").forEach(function (form) {
    form.classList.add("js-autosubmit");
    form.querySelectorAll("select").forEach(function (select) {
      select.addEventListener("change", function () {
        // requestSubmit statt submit(): nur so gibt es ein submit-Event,
        // an dem scroll-keep.js die Position mitnimmt
        if (typeof form.requestSubmit === "function") form.requestSubmit();
        else form.submit();
      });
    });
  });
})();
