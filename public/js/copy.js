/*
 * In die Zwischenablage kopieren, deklarativ verdrahtet:
 *
 *   <button data-copy="der Text" data-copy-label="Meldung">…</button>
 *
 * navigator.clipboard braucht einen sicheren Kontext (HTTPS oder localhost).
 * Ueber http im LAN ist es nicht verfuegbar — dort greift der Fallback ueber
 * ein temporaeres <textarea> und execCommand, damit die Checksumme nicht per
 * Hand abgetippt werden muss.
 */
(function () {
  function legacyCopy(text) {
    var area = document.createElement("textarea");
    area.value = text;
    // Ausserhalb des Viewports statt display:none — nicht gerenderte
    // Elemente lassen sich nicht selektieren.
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    document.body.appendChild(area);
    area.select();

    var ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (e) {
      ok = false;
    }
    area.remove();
    return ok;
  }

  function notify(message, variant) {
    if (typeof window.toast === "function") window.toast(message, variant);
  }

  function fallback(text, label) {
    var ok = legacyCopy(text);
    notify(ok ? label : "Kopieren nicht möglich.", ok ? "success" : "error");
  }

  document.addEventListener("click", function (event) {
    var button = event.target.closest("[data-copy]");
    if (!button) return;

    var text = button.dataset.copy;
    var label = button.dataset.copyLabel || "Kopiert";

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () {
          notify(label, "success");
        },
        function () {
          fallback(text, label);
        }
      );
      return;
    }

    fallback(text, label);
  });
})();
