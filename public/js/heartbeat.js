/*
 * Heartbeat: fragt periodisch nach, ob es neue Daten gibt, und patcht nur die
 * betroffenen Bereiche — deklarativ wie die uebrigen Scripts:
 *
 *   <body data-heartbeat="public">   index.ejs, /search
 *   <body data-heartbeat="admin">    admin.ejs, /admin-search, audit-log.ejs
 *
 * Jeder Teilbereich (Dateitabelle, Tag-Filterleiste, Audit-Widget/-Seite,
 * Passkeys, API-Tokens) wird unabhaengig behandelt und ist ein No-Op, wenn
 * sein Markup auf der aktuellen Seite fehlt — dieselbe Opt-in-Regel wie bei
 * row-details.js/tags.js. Server-Gegenstueck: GET /partials/listing (oeffent-
 * lich) bzw. GET /admin/partials/listing (checkAuth) in server.js, beide
 * liefern bereits fertig gerendertes HTML fuer Dateizeilen/Tag-Filter/
 * Passkeys/Tokens (dasselbe Partial wie beim Server-Side-Render) statt roher
 * JSON-Daten, damit hier kein zweites Zeilen-Template gepflegt werden muss.
 *
 * node:sqlite hat keinerlei Pub/Sub — reines Polling ist die einzige Option.
 */
(function () {
  var body = document.body;
  var mode = body && body.dataset ? body.dataset.heartbeat : null;
  if (mode !== "public" && mode !== "admin") return;

  var ENDPOINT = mode === "admin" ? "/admin/partials/listing" : "/partials/listing";
  var INTERVAL_MS = 20000;
  var FLASH_MS = 1200;

  function flash(el) {
    if (!el) return;
    el.classList.add("is-updated");
    setTimeout(function () {
      el.classList.remove("is-updated");
    }, FLASH_MS);
  }

  function parseFragment(html) {
    var template = document.createElement("template");
    template.innerHTML = html;
    return template.content;
  }

  /* ---------------------------------------------------------- Dateitabelle
   * Zeile+Detailzeile werden ueber den Dateinamen (data-row/data-detail-for,
   * siehe partials/file-row.ejs) gezielt ersetzt/eingefuegt/entfernt, statt
   * die ganze Tabelle neu zu rendern — sonst gingen aufgeklappte Detail-
   * zeilen, Checkbox-Auswahl und die aktive Sortierung/Filterung verloren.
   */

  function rowFingerprint(row) {
    if (!row) return "";
    var size = row.cells[2] ? row.cells[2].dataset.value : "";
    var uploaded = row.cells[3] ? row.cells[3].dataset.value : "";
    return (row.dataset.search || "") + "|" + size + "|" + uploaded;
  }

  function detailFingerprint(detail) {
    if (!detail) return "";
    var cell = detail.querySelector("td");
    return cell ? cell.innerHTML : "";
  }

  function collectRows(root) {
    var map = {};
    var order = [];
    root.querySelectorAll("tr[data-row]").forEach(function (row) {
      var key = row.dataset.row;
      order.push(key);
      map[key] = { row: row, detail: null };
    });
    root.querySelectorAll("tr[data-detail-for]").forEach(function (detail) {
      var key = detail.dataset.detailFor;
      if (map[key]) map[key].detail = detail;
    });
    return { map: map, order: order };
  }

  function syncFileRows(html) {
    var tbody = document.querySelector("[data-file-rows]");
    if (!tbody) return;

    var incoming = collectRows(parseFragment(html));
    var current = collectRows(tbody);
    var changed = false;

    current.order.forEach(function (key) {
      if (!incoming.map[key]) {
        current.map[key].row.remove();
        if (current.map[key].detail) current.map[key].detail.remove();
        changed = true;
      }
    });

    incoming.order.forEach(function (key) {
      var next = incoming.map[key];
      var existing = current.map[key];

      if (!existing) {
        flash(next.row);
        tbody.appendChild(next.row);
        if (next.detail) tbody.appendChild(next.detail);
        changed = true;
        return;
      }

      var sameRow = rowFingerprint(existing.row) === rowFingerprint(next.row);
      var sameDetail = detailFingerprint(existing.detail) === detailFingerprint(next.detail);
      if (sameRow && sameDetail) return;

      // Aufgeklappt-/Ausgewaehlt-Zustand von der alten auf die neue Zeile
      // uebertragen, bevor die alte verschwindet — sonst klappt eine gerade
      // offene Detailzeile beim naechsten Tick unbemerkt wieder zu.
      var oldToggle = existing.row.querySelector("[data-row-toggle]");
      var wasExpanded = oldToggle && oldToggle.getAttribute("aria-expanded") === "true";
      var oldCheckbox = existing.row.querySelector("[data-select-file]");
      var wasChecked = oldCheckbox && oldCheckbox.checked;

      flash(next.row);
      existing.row.replaceWith(next.row);
      if (existing.detail && next.detail) {
        existing.detail.replaceWith(next.detail);
      } else if (existing.detail) {
        existing.detail.remove();
      } else if (next.detail) {
        next.row.after(next.detail);
      }

      if (wasExpanded) {
        var newToggle = next.row.querySelector("[data-row-toggle]");
        if (newToggle) newToggle.setAttribute("aria-expanded", "true");
        if (next.detail) next.detail.hidden = false;
      }
      if (wasChecked) {
        var newCheckbox = next.row.querySelector("[data-select-file]");
        if (newCheckbox) newCheckbox.checked = true;
      }

      changed = true;
    });

    if (!changed) return;

    var table = tbody.closest("table");
    if (table) table.dispatchEvent(new CustomEvent("table:changed"));

    var totalSize = 0;
    tbody.querySelectorAll("tr[data-row] td[data-value]").forEach(function (cell) {
      if (cell.closest("tr").cells[2] === cell) totalSize += Number(cell.dataset.value) || 0;
    });
    document.querySelectorAll("[data-total-size]").forEach(function (el) {
      el.textContent = formatBytes(totalSize);
    });
  }

  function formatBytes(bytes) {
    if (!bytes) return "0 B";
    var units = ["B", "KB", "MB", "GB", "TB"];
    var exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    var value = bytes / Math.pow(1024, exponent);
    return value.toFixed(value < 10 && exponent > 0 ? 1 : 0) + " " + units[exponent];
  }

  /* --------------------------------------------------------- Tag-Filterleiste
   * Zustandslose Liste von Links — bei einer Aenderung einfach ersetzen. */

  function syncTagFilter(html) {
    var container = document.querySelector("[data-tag-filter]");
    if (!container) return;
    if (container.innerHTML.trim() === html.trim()) return;
    container.innerHTML = html;
  }

  /* ------------------------------------------------------- Passkeys/Tokens
   * Gleiche Namens-/ID-Diff-Technik wie bei Dateien, aber ohne Detailzeile
   * und ohne aufklappbaren Zustand — ein einfacher innerHTML-Vergleich je
   * Zeile reicht.
   */

  function syncSimpleList(container, html, keyAttr, emptyAttr, emptyBuilder) {
    if (!container) return;

    var incoming = parseFragment(html);
    var incomingItems = incoming.querySelectorAll("[" + keyAttr + "]");
    var incomingKeys = {};
    incomingItems.forEach(function (el) {
      incomingKeys[el.getAttribute(keyAttr)] = el;
    });

    var currentItems = Array.prototype.slice.call(container.querySelectorAll("[" + keyAttr + "]"));
    var currentKeys = {};
    currentItems.forEach(function (el) {
      currentKeys[el.getAttribute(keyAttr)] = el;
      if (!incomingKeys[el.getAttribute(keyAttr)]) el.remove();
    });

    var previous = null;
    incomingItems.forEach(function (el) {
      var key = el.getAttribute(keyAttr);
      var existing = currentKeys[key];
      if (!existing) {
        flash(el);
        if (previous) previous.after(el);
        else container.insertBefore(el, container.firstChild);
      } else if (existing.innerHTML !== el.innerHTML) {
        flash(el);
        existing.replaceWith(el);
      }
      previous = container.querySelector("[" + keyAttr + '="' + key + '"]');
    });

    var empty = container.querySelector("[" + emptyAttr + "]");
    if (incomingItems.length === 0 && !empty) {
      container.appendChild(emptyBuilder());
    } else if (incomingItems.length > 0 && empty) {
      empty.remove();
    }
  }

  /* --------------------------------------------------------------- Audit-Log
   * auditEntries kommt als kleines JSON-Array (neueste zuerst, siehe
   * lib/audit-log.js) statt vorgerendertem HTML — das Markup ist einfach
   * genug (~10 Zeilen ohne verschachtelte Partials), um es hier ohne
   * Duplikationsrisiko nachzubauen. Nur echte Neuzugaenge (id > hoechste
   * bereits angezeigte id) werden eingefuegt.
   */

  var dateFormatter = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "short", year: "numeric" });

  function formatEntryTime(ts) {
    var date = new Date(ts);
    return dateFormatter.format(date) + " " + date.toLocaleTimeString("de-DE");
  }

  function buildWidgetEntry(entry) {
    var li = document.createElement("li");
    li.className = "row row--between";
    li.dataset.auditId = String(entry.id);

    var left = document.createElement("span");
    var badge = document.createElement("span");
    badge.className = "badge badge--mono";
    badge.textContent = entry.event;
    left.appendChild(badge);
    left.appendChild(document.createTextNode(" "));
    var ip = document.createElement("span");
    ip.className = "hint";
    ip.textContent = entry.ip || "";
    left.appendChild(ip);

    var time = document.createElement("time");
    time.className = "hint";
    time.dateTime = new Date(entry.ts).toISOString();
    time.textContent = formatEntryTime(entry.ts);

    li.appendChild(left);
    li.appendChild(time);
    return li;
  }

  function buildLogRow(entry) {
    var tr = document.createElement("tr");
    tr.dataset.auditId = String(entry.id);

    var tsCell = document.createElement("td");
    tsCell.className = "table__num";
    tsCell.dataset.label = "Zeitpunkt";
    var time = document.createElement("time");
    time.dateTime = new Date(entry.ts).toISOString();
    time.textContent = formatEntryTime(entry.ts);
    tsCell.appendChild(time);

    var eventCell = document.createElement("td");
    eventCell.dataset.label = "Ereignis";
    var badge = document.createElement("span");
    badge.className = "badge badge--mono";
    badge.textContent = entry.event;
    eventCell.appendChild(badge);

    var ipCell = document.createElement("td");
    ipCell.className = "table__num mono";
    ipCell.dataset.label = "IP";
    ipCell.textContent = entry.ip || "—";

    var detailCell = document.createElement("td");
    detailCell.className = "mono";
    detailCell.dataset.label = "Details";
    var rest = {};
    Object.keys(entry).forEach(function (key) {
      if (["id", "ts", "event", "ip"].indexOf(key) === -1) rest[key] = entry[key];
    });
    detailCell.textContent = Object.keys(rest).length > 0 ? JSON.stringify(rest) : "";

    tr.appendChild(tsCell);
    tr.appendChild(eventCell);
    tr.appendChild(ipCell);
    tr.appendChild(detailCell);
    return tr;
  }

  function prependNewEntries(container, entries, build, maxItems) {
    if (!container) return;
    var currentMax = 0;
    container.querySelectorAll("[data-audit-id]").forEach(function (el) {
      currentMax = Math.max(currentMax, Number(el.dataset.auditId) || 0);
    });

    var fresh = entries
      .filter(function (entry) {
        return entry.id > currentMax;
      })
      .sort(function (a, b) {
        return a.id - b.id;
      });

    fresh.forEach(function (entry) {
      var el = build(entry);
      flash(el);
      container.insertBefore(el, container.firstChild);
    });

    if (maxItems) {
      var items = container.querySelectorAll("[data-audit-id]");
      for (var i = maxItems; i < items.length; i++) items[i].remove();
    }

    return fresh.length > 0;
  }

  function syncAuditWidget(entries) {
    var list = document.getElementById("auditWidgetList");
    var emptyHint = document.getElementById("auditWidgetEmpty");
    if (!list) return;
    prependNewEntries(list, entries, buildWidgetEntry, 8);
    var hasEntries = list.querySelector("[data-audit-id]") !== null;
    list.hidden = !hasEntries;
    if (emptyHint) emptyHint.hidden = hasEntries;
  }

  function syncAuditPage(entries) {
    var body = document.getElementById("auditLogBody");
    if (!body) return;
    prependNewEntries(body, entries, buildLogRow, null);
  }

  /* -------------------------------------------------------------- Steuerung */

  function fetchJson(url) {
    // X-Idle-Background markiert diesen Request bei checkAuth (server.js)
    // als reines Hintergrund-Polling, das den Admin-Idle-Timeout NICHT
    // verlaengert — sonst wuerde ein offen gelassener, aber unbeobachteter
    // Tab (data-heartbeat="admin" pollt automatisch alle 20s) den Timeout
    // aushebeln. Siehe idle-timer.js fuer den Gegenpart, der echte
    // Nutzeraktivitaet erkennt.
    return fetch(url, { headers: { Accept: "application/json", "X-Idle-Background": "1" } }).then(function (res) {
      if (res.status === 401) throw new Error("unauthenticated");
      if (!res.ok) throw new Error("http_" + res.status);
      return res.json();
    });
  }

  var timer = null;
  var stopped = false;

  function tick() {
    fetchJson(ENDPOINT)
      .then(function (data) {
        syncFileRows(data.filesHtml);
        syncTagFilter(data.tagsHtml);
        if (mode === "admin") {
          syncSimpleList(document.getElementById("passkeyList"), data.passkeysHtml, "data-passkey-id", "data-passkey-empty", function () {
            var li = document.createElement("li");
            li.className = "empty";
            li.setAttribute("data-passkey-empty", "");
            li.innerHTML =
              '<p class="empty__title">Keine Passkeys</p>' +
              '<p class="empty__text">Füge einen Passkey hinzu, um dich künftig ohne Passwort anzumelden.</p>';
            return li;
          });
          syncSimpleList(document.getElementById("apiTokenList"), data.apiTokensHtml, "data-token-id", "data-token-empty", function () {
            var li = document.createElement("li");
            li.className = "empty";
            li.setAttribute("data-token-empty", "");
            li.innerHTML =
              '<p class="empty__title">Keine API-Tokens</p>' +
              '<p class="empty__text">Erstelle ein Token, um Dateien per Skript hoch-/herunterzuladen oder zu verwalten.</p>';
            return li;
          });
          if (Array.isArray(data.auditEntries)) {
            syncAuditWidget(data.auditEntries);
            syncAuditPage(data.auditEntries);
          }
        }
      })
      .catch(function (err) {
        // Sitzung abgelaufen: stillschweigend aufhoeren statt endlos gegen
        // 401 zu pollen — ein Reload bringt den Nutzer ohnehin zu /login.
        if (err.message === "unauthenticated") stopped = true;
      });
  }

  function schedule() {
    if (timer) clearInterval(timer);
    timer = setInterval(function () {
      if (stopped || document.hidden) return;
      tick();
    }, INTERVAL_MS);
  }

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && !stopped) tick();
  });

  tick();
  schedule();
})();
