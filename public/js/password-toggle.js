/* Passwort ein-/ausblenden */
(function () {
  var toggles = document.querySelectorAll("[data-password-toggle]");

  Array.prototype.forEach.call(toggles, function (button) {
    var field = document.getElementById(button.dataset.passwordToggle);
    if (!field) return;

    var showIcon = button.querySelector('[data-password-icon="show"]');
    var hideIcon = button.querySelector('[data-password-icon="hide"]');

    button.addEventListener("click", function () {
      var visible = field.type === "text";
      field.type = visible ? "password" : "text";

      if (showIcon) showIcon.hidden = !visible;
      if (hideIcon) hideIcon.hidden = visible;
      button.setAttribute(
        "aria-label",
        visible ? "Passwort anzeigen" : "Passwort verbergen"
      );

      // Cursor ans Ende, sonst springt er beim Typwechsel nach vorne
      field.focus();
      var end = field.value.length;
      try {
        field.setSelectionRange(end, end);
      } catch (e) {
        // setSelectionRange ist bei type="password" nicht ueberall erlaubt
      }
    });
  });
})();
