/*
 * Eigenes Bestaetigungs-Modal fuer jede Rueckfrage im Projekt — statt
 * window.confirm()/alert() und statt Pflicht-Checkboxen/Abtipp-Feldern mitten
 * im Formular. Deklarativ ueber data-Attribute, eingebunden ueber
 * partials/footer.ejs auf jeder Seite:
 *
 *   data-confirm="Text"            an einem Submit-Button, einer <option>
 *                                  (greift nur, wenn sie gerade neu gewaehlt
 *                                  ist, nicht die vorausgewaehlte) oder am
 *                                  <form> — in dieser Reihenfolge
 *   data-confirm-title="…"         Ueberschrift (Default "Wirklich fortfahren?")
 *   data-confirm-ok="Löschen"      Beschriftung des Bestaetigen-Knopfs
 *   data-confirm-variant="primary" statt des Defaults "danger"
 *   data-confirm-type="1001"       muss im Modal abgetippt werden
 *   data-confirm-type-label="…"    Beschriftung dieses Felds
 *
 * {feld} im Text/Titel wird durch den angezeigten Wert des Formularfelds
 * `feld` ersetzt (bei <select> der Text der gewaehlten Option).
 *
 * Ohne JS bleibt die bisherige Absicherung im Formular stehen: ein Bereich
 * mit [data-confirm-inline] (Pflicht-Checkbox, Abtipp-Feld) — mit JS blendet
 * ihn CSS aus (html.js, gesetzt von theme-init.js), dieses Skript nimmt beim
 * Klick das `required` heraus und fuellt ihn nach der Bestaetigung aus (Haken
 * gesetzt, Abtipp-Feld = abgetippter Wert). Der Server prueft weiter selbst.
 *
 * Das DOM der Seite wird beim Laden bewusst nicht angefasst — live-regions.js
 * merkt sich das Markup jeder Region, eine Aenderung beim Start saehe fuer
 * ihn wie eine Bearbeitung aus.
 *
 * Global: window.appConfirm(opts) -> Promise<boolean>, window.appAlert(opts).
 */
(function () {
  var dialog = null;
  var parts = {};
  var pending = null;

  function build() {
    if (dialog) return;
    dialog = document.createElement("dialog");
    dialog.className = "dialog";
    dialog.id = "confirmDialog";
    dialog.setAttribute("aria-labelledby", "confirmDialogTitle");
    dialog.innerHTML =
      '<form method="dialog">' +
      '<div class="dialog__body">' +
      '<h2 class="dialog__title" id="confirmDialogTitle"></h2>' +
      '<p class="dialog__text" data-part="text"></p>' +
      '<div class="field" data-part="field" hidden>' +
      '<label class="label" for="confirmDialogInput" data-part="label"></label>' +
      '<input class="input mono" type="text" id="confirmDialogInput" autocomplete="off" spellcheck="false">' +
      "</div>" +
      "</div>" +
      '<div class="dialog__footer">' +
      '<button type="submit" class="btn btn--secondary" data-part="cancel" formnovalidate>Abbrechen</button>' +
      '<button type="button" class="btn" data-part="ok"></button>' +
      "</div>" +
      "</form>";
    document.body.appendChild(dialog);
    parts = {
      title: dialog.querySelector("#confirmDialogTitle"),
      text: dialog.querySelector('[data-part="text"]'),
      field: dialog.querySelector('[data-part="field"]'),
      label: dialog.querySelector('[data-part="label"]'),
      input: dialog.querySelector("#confirmDialogInput"),
      cancel: dialog.querySelector('[data-part="cancel"]'),
      ok: dialog.querySelector('[data-part="ok"]'),
    };

    parts.ok.addEventListener("click", function () {
      if (parts.ok.disabled) return;
      finish(true);
    });
    parts.input.addEventListener("input", syncOk);
    // Enter im Abtipp-Feld: bestaetigen statt (Default-Knopf) abbrechen
    parts.input.addEventListener("keydown", function (event) {
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (!parts.ok.disabled) finish(true);
    });
    // Esc, Abbrechen-Knopf, Schliessen von aussen
    dialog.addEventListener("close", function () {
      if (pending) finish(false);
    });
  }

  function syncOk() {
    var expected = parts.input.dataset.expected;
    parts.ok.disabled = expected !== undefined && parts.input.value.trim() !== expected;
  }

  function finish(result) {
    var current = pending;
    pending = null;
    if (dialog.open) dialog.close();
    if (!current) return;
    if (!result && current.returnFocus && document.contains(current.returnFocus)) current.returnFocus.focus();
    current.resolve(result ? { value: parts.input.value.trim() } : null);
  }

  /* Oeffnet das Modal; resolved mit { value } bei Bestaetigung, sonst null. */
  function open(opts) {
    build();
    if (pending) finish(false);
    var variant = opts.variant === "primary" ? "btn--primary" : "btn--danger";
    parts.title.textContent = opts.title || "Wirklich fortfahren?";
    parts.text.textContent = opts.text || "";
    parts.text.hidden = !opts.text;
    parts.ok.className = "btn " + variant;
    parts.ok.textContent = opts.ok || "Bestätigen";
    parts.cancel.hidden = !!opts.alertOnly;
    if (opts.type !== undefined && opts.type !== null && opts.type !== "") {
      parts.field.hidden = false;
      parts.label.textContent = opts.typeLabel || "Zur Bestätigung „" + opts.type + "“ eingeben";
      parts.input.value = "";
      parts.input.dataset.expected = String(opts.type);
    } else {
      parts.field.hidden = true;
      parts.input.value = "";
      delete parts.input.dataset.expected;
    }
    syncOk();
    return new Promise(function (resolve) {
      pending = { resolve: resolve, returnFocus: opts.returnFocus || document.activeElement };
      dialog.showModal();
      // Destruktiv: Fokus auf "Abbrechen", damit ein versehentliches Enter
      // nichts loescht; mit Abtipp-Feld dorthin; sonst auf den Knopf.
      if (!parts.field.hidden) parts.input.focus();
      else if (opts.variant === "primary" || opts.alertOnly) parts.ok.focus();
      else parts.cancel.focus();
    });
  }

  window.appConfirm = function (opts) {
    return open(opts || {}).then(function (result) {
      return !!result;
    });
  };

  window.appAlert = function (opts) {
    if (typeof opts === "string") opts = { text: opts };
    return open(Object.assign({ title: "Hinweis", ok: "OK", variant: "primary", alertOnly: true }, opts)).then(
      function () {}
    );
  };

  /* ---------------------------------------------------- Formulare */

  function fieldText(form, name) {
    var field = form.elements[name];
    if (!field) return "";
    if (field.tagName === "SELECT") {
      var option = field.options[field.selectedIndex];
      return option ? option.textContent.trim() : "";
    }
    return String(field.value || "").trim();
  }

  function fill(form, text) {
    return String(text || "").replace(/\{([\w-]+)\}/g, function (all, name) {
      return form.elements[name] ? fieldText(form, name) : all;
    });
  }

  /* Wo steht die Rueckfrage? Knopf, dann neu gewaehlte Option, dann Formular. */
  function source(form, submitter) {
    if (submitter && submitter.hasAttribute("data-confirm")) return submitter;
    var selects = form.querySelectorAll("select");
    for (var i = 0; i < selects.length; i += 1) {
      var option = selects[i].options[selects[i].selectedIndex];
      if (option && option.hasAttribute("data-confirm") && !option.defaultSelected) return option;
    }
    return form.hasAttribute("data-confirm") ? form : null;
  }

  function isSubmitButton(el) {
    if (!el || !el.form) return false;
    if (el.tagName === "BUTTON") return (el.getAttribute("type") || "submit").toLowerCase() === "submit";
    return el.tagName === "INPUT" && (el.type === "submit" || el.type === "image");
  }

  // Vor der Browser-Validierung: das (per CSS ausgeblendete) Inline-Feld darf
  // das Absenden nicht mehr blockieren — die Rueckfrage uebernimmt das Modal.
  // Enter in einem Textfeld loest ebenfalls einen Klick auf den
  // Default-Knopf aus, landet also auch hier.
  document.addEventListener(
    "click",
    function (event) {
      var button = event.target.closest && event.target.closest("button, input");
      if (!isSubmitButton(button) || button.formNoValidate) return;
      var form = button.form;
      if (!source(form, button)) return;
      form.querySelectorAll("[data-confirm-inline] [required]").forEach(function (field) {
        field.required = false;
      });
    },
    true
  );

  document.addEventListener(
    "submit",
    function (event) {
      var form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      if (form.__confirmed) {
        form.__confirmed = false;
        return;
      }
      var submitter = event.submitter || null;
      var el = source(form, submitter);
      if (!el) return;
      event.preventDefault();
      event.stopImmediatePropagation();

      var d = el.dataset;
      var type = d.confirmType !== undefined ? fill(form, d.confirmType) : null;
      open({
        title: fill(form, d.confirmTitle),
        text: fill(form, d.confirm),
        ok: d.confirmOk,
        variant: d.confirmVariant,
        type: type,
        typeLabel: d.confirmTypeLabel,
        returnFocus: submitter,
      }).then(function (result) {
        if (!result) return;
        form.querySelectorAll("[data-confirm-inline] input").forEach(function (field) {
          if (field.type === "checkbox" || field.type === "radio") field.checked = true;
          else if (type !== null) field.value = result.value;
        });
        form.__confirmed = true;
        if (typeof form.requestSubmit === "function") {
          form.requestSubmit(submitter && submitter.form === form ? submitter : undefined);
          // Scheitert die Validierung doch noch, kommt kein submit-Event —
          // die Freigabe darf dann nicht fuer den naechsten Versuch stehen bleiben.
          form.__confirmed = false;
        } else {
          if (submitter && submitter.name) {
            var hidden = document.createElement("input");
            hidden.type = "hidden";
            hidden.name = submitter.name;
            hidden.value = submitter.value;
            form.appendChild(hidden);
          }
          form.submit();
        }
      });
    },
    true
  );
})();
