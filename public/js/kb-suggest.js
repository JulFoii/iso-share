/*
 * Hilfeartikel-Vorschlaege beim Anlegen eines Tickets.
 *
 *   <input data-kb-suggest="/support/articles.json" aria-describedby="box-id">
 *   <aside id="box-id" hidden> … <ul data-kb-suggest-list></ul></aside>
 *
 * Fragt nach einer kurzen Tipppause die Wissensdatenbank ab (lib/routes/kb.js)
 * und zeigt bis zu fuenf passende Artikel; ohne Treffer bleibt der Bereich
 * versteckt. Links oeffnen in einem neuen Tab, damit der angefangene
 * Ticket-Text nicht verloren geht. Ohne JS passiert einfach nichts.
 */
(function () {
  document.querySelectorAll("[data-kb-suggest]").forEach(function (input) {
    var box = document.getElementById(input.getAttribute("aria-describedby") || "");
    var list = box && box.querySelector("[data-kb-suggest-list]");
    if (!box || !list) return;
    var url = input.dataset.kbSuggest;
    var timer = null;
    var lastQuery = "";
    var controller = null;

    function render(items) {
      list.textContent = "";
      items.forEach(function (item) {
        var li = document.createElement("li");
        var link = document.createElement("a");
        link.href = item.url;
        link.target = "_blank";
        link.rel = "noopener";
        link.className = "kb-suggest__link";
        link.textContent = item.title;
        li.appendChild(link);
        if (item.excerpt) {
          var excerpt = document.createElement("span");
          excerpt.className = "kb-suggest__excerpt";
          excerpt.textContent = item.excerpt;
          li.appendChild(excerpt);
        }
        list.appendChild(li);
      });
      box.hidden = items.length === 0;
    }

    function lookup() {
      var query = input.value.trim();
      if (query === lastQuery) return;
      lastQuery = query;
      if (query.length < 3) {
        render([]);
        return;
      }
      if (controller) controller.abort();
      controller = typeof AbortController === "function" ? new AbortController() : null;
      fetch(url + "?q=" + encodeURIComponent(query), {
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        signal: controller ? controller.signal : undefined,
      })
        .then(function (res) {
          return res.ok ? res.json() : { data: [] };
        })
        .then(function (body) {
          render(Array.isArray(body.data) ? body.data : []);
        })
        .catch(function () {
          // Abgebrochen oder offline: Vorschlaege sind nur eine Hilfe.
        });
    }

    input.addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(lookup, 400);
    });
    if (input.value.trim()) lookup();
  });
})();
