/* Kleine Toast-Queue, global als window.toast(text, variant) */
(function () {
  var ICONS = {
    success:
      '<path d="M20 6 9 17l-5-5"/>',
    error:
      '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  };

  function container() {
    var el = document.querySelector(".toasts");
    if (!el) {
      el = document.createElement("div");
      el.className = "toasts";
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      document.body.appendChild(el);
    }
    return el;
  }

  window.toast = function (message, variant) {
    variant = variant || "info";

    var el = document.createElement("div");
    el.className = "toast toast--" + variant;
    el.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      (ICONS[variant] || ICONS.info) +
      "</svg><span></span>";
    el.querySelector("span").textContent = message;

    container().appendChild(el);

    // Auftritt kommt aus @starting-style, der Abgang aus der Transition auf
    // .is-leaving — hier wird nur nach dem Ende aufgeraeumt.
    setTimeout(function () {
      el.classList.add("is-leaving");
      el.addEventListener(
        "transitionend",
        function () {
          el.remove();
        },
        { once: true }
      );
    }, 4500);
  };
})();
