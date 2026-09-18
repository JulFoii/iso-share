/*
 * Upload-Formular: Dropzone, Dateivorschau, fortsetzbarer Chunk-Upload.
 *
 * Statt eines einzigen Requests ueber die ganze Datei laeuft der Upload in
 * Bloecken gegen das Protokoll aus lib/chunked-upload.js:
 *
 *   POST  /upload/init   -> {id, offset}   (offset > 0 = es wird fortgesetzt)
 *   PATCH /upload/:id    -> {offset}       je Block, mit Upload-Offset-Header
 *   POST  /upload/:id/finish
 *
 * Der Server fuehrt den Offset, nicht der Client: nach jedem Netzfehler wird
 * er neu abgefragt und dort weitergemacht. Ein 409 liefert den korrekten Wert
 * gleich mit, dann synchronisiert die Schleife sich selbst.
 *
 * Ohne JavaScript bleibt das Formular ein normaler Multipart-POST auf
 * /upload — dieser Pfad existiert im Server weiterhin.
 */
(function () {
  var form = document.getElementById("uploadForm");
  if (!form) return;

  var zone = document.getElementById("dropzone");
  var input = document.getElementById("fileInput");
  var submit = document.getElementById("uploadSubmit");
  var pauseButton = document.getElementById("uploadPause");
  var cancelButton = document.getElementById("uploadCancel");
  var preview = document.getElementById("filePreview");
  var previewName = document.getElementById("filePreviewName");
  var previewSize = document.getElementById("filePreviewSize");
  var resume = document.getElementById("uploadResume");
  var resumeText = document.getElementById("uploadResumeText");
  var replacesSelect = document.getElementById("uploadReplaces");
  var progress = document.getElementById("uploadProgress");
  var bar = document.getElementById("uploadProgressBar");
  var percentLabel = document.getElementById("uploadPercent");
  var transferLabel = document.getElementById("uploadTransfer");

  var CHUNK_SIZE = 8 * 1024 * 1024;
  var MAX_RETRIES = 4;

  // Laufender Upload; null, solange nichts uebertragen wird.
  var job = null;

  function formatSize(bytes) {
    if (!bytes) return "0 B";
    var units = ["B", "KB", "MB", "GB", "TB"];
    var exponent = Math.min(
      Math.floor(Math.log(bytes) / Math.log(1024)),
      units.length - 1
    );
    var value = bytes / Math.pow(1024, exponent);
    var digits = value < 10 && exponent > 0 ? 1 : 0;
    return value.toFixed(digits) + " " + units[exponent];
  }

  function notify(message, variant) {
    if (typeof window.toast === "function") window.toast(message, variant);
  }

  /* --------------------------------------------------------------- Anzeige */

  function renderProgress(loaded, total) {
    var percent = total > 0 ? Math.round((loaded / total) * 100) : 0;
    bar.style.width = percent + "%";
    bar.parentElement.setAttribute("aria-valuenow", String(percent));
    percentLabel.textContent = percent + " %";
    transferLabel.textContent =
      formatSize(loaded) + " von " + formatSize(total);
    // Ein groszer Upload kann laenger als der Idle-Timeout dauern, ohne
    // dass zwischendurch ein Tab gewechselt wird — echter Fortschritt zaehlt
    // darum als Aktivitaet, sonst reiszt der clientseitige Countdown die
    // laufende Uebertragung mitten im Transfer weg (siehe idle-timer.js).
    if (window.isoShareIdleTimer) window.isoShareIdleTimer.markActive();
  }

  function setBusy(busy) {
    submit.disabled = busy;
    submit.textContent = busy ? "Wird hochgeladen…" : "Hochladen";
    pauseButton.hidden = !busy;
    cancelButton.hidden = !busy;
    progress.hidden = !busy;
  }

  function resetUi() {
    setBusy(false);
    pauseButton.textContent = "Pause";
    submit.disabled = !input.files[0];
  }

  function selectFile(file) {
    if (!file) return;
    if (!/\.iso$/i.test(file.name)) {
      notify("Nur .iso-Dateien sind erlaubt.", "error");
      return;
    }
    previewName.textContent = file.name;
    previewSize.textContent = formatSize(file.size);
    preview.hidden = false;
    resume.hidden = true;
    submit.disabled = false;
  }

  /* ----------------------------------------------------------- Dateiauswahl */

  zone.addEventListener("click", function () {
    input.click();
  });

  zone.addEventListener("keydown", function (event) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      input.click();
    }
  });

  input.addEventListener("change", function () {
    selectFile(input.files[0]);
  });

  // dragenter/dragleave feuern auch fuer Kindelemente, darum mitzaehlen
  var depth = 0;

  zone.addEventListener("dragenter", function (event) {
    event.preventDefault();
    depth++;
    zone.classList.add("is-dragover");
  });

  zone.addEventListener("dragover", function (event) {
    event.preventDefault();
  });

  zone.addEventListener("dragleave", function () {
    depth = Math.max(0, depth - 1);
    if (depth === 0) zone.classList.remove("is-dragover");
  });

  zone.addEventListener("drop", function (event) {
    event.preventDefault();
    depth = 0;
    zone.classList.remove("is-dragover");

    var file = event.dataTransfer.files[0];
    if (!file) return;
    // Der File-Input ist die Quelle der Wahrheit fuer das Formular
    input.files = event.dataTransfer.files;
    selectFile(file);
  });

  /* ------------------------------------------------------------ Transport */

  function readError(xhr) {
    try {
      return JSON.parse(xhr.responseText);
    } catch (e) {
      // Nicht-JSON (z. B. eine Login-HTML-Seite) — generisch behandeln
      return {};
    }
  }

  /*
   * Ein Block per XHR. Gegenueber fetch() gibt XHR hier zwei Dinge, die den
   * Aufwand rechtfertigen: Fortschritt *innerhalb* des Blocks und ein
   * abort(), das die Pause-Taste sofort wirksam macht.
   */
  function sendChunk(id, offset, blob, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      job.xhr = xhr;

      xhr.upload.addEventListener("progress", function (event) {
        if (event.lengthComputable) onProgress(event.loaded);
      });

      xhr.addEventListener("load", function () {
        job.xhr = null;
        var payload = readError(xhr);
        if (xhr.status >= 200 && xhr.status < 300) return resolve(payload);
        reject({ status: xhr.status, payload: payload });
      });
      xhr.addEventListener("error", function () {
        job.xhr = null;
        reject({ status: 0, payload: {} });
      });
      xhr.addEventListener("abort", function () {
        job.xhr = null;
        reject({ aborted: true });
      });

      xhr.open("PATCH", "/upload/" + id);
      xhr.setRequestHeader("Accept", "application/json");
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.setRequestHeader("Upload-Offset", String(offset));
      xhr.send(blob);
    });
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

  /* Serverstand abfragen — nach jedem Netzfehler die Quelle der Wahrheit. */
  function fetchOffset(id) {
    return fetch("/upload/" + id, { headers: { Accept: "application/json" } })
      .then(function (res) {
        if (!res.ok) throw new Error("Sitzung nicht mehr vorhanden.");
        return res.json();
      })
      .then(function (state) {
        return state.offset;
      });
  }

  function wait(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  /* ------------------------------------------------------------- Ablauf */

  async function runJob(current) {
    var retries = 0;

    while (current.offset < current.size) {
      if (current.paused || current.cancelled) return;

      var end = Math.min(current.offset + CHUNK_SIZE, current.size);
      var blob = current.file.slice(current.offset, end);
      var base = current.offset;

      try {
        var state = await sendChunk(current.id, base, blob, function (loaded) {
          renderProgress(base + loaded, current.size);
        });
        current.offset = state.offset;
        retries = 0;
        renderProgress(current.offset, current.size);
      } catch (failure) {
        if (failure.aborted || current.cancelled) return;

        // 409 heisst: der Server steht woanders. Er schickt den echten
        // Offset mit, also dort fortsetzen statt abzubrechen.
        if (failure.status === 409 && typeof failure.payload.offset === "number") {
          current.offset = failure.payload.offset;
          continue;
        }
        if (failure.status === 401 || failure.status === 403) {
          throw new Error("Sitzung abgelaufen. Bitte neu anmelden.");
        }
        if (failure.status === 413) {
          throw new Error(failure.payload.error || "Datei ist zu groß.");
        }
        if (failure.status === 404) {
          throw new Error("Die Upload-Sitzung ist abgelaufen.");
        }

        // Netzfehler oder 5xx: Offset neu holen und begrenzt wiederholen.
        retries++;
        if (retries > MAX_RETRIES) {
          throw new Error(
            failure.payload.error ||
            "Verbindung unterbrochen. Der Upload lässt sich später fortsetzen."
          );
        }
        var delay = Math.pow(2, retries) * 500;
        transferLabel.textContent =
          "Verbindungsfehler — neuer Versuch in " + delay / 1000 + " s";
        await wait(delay);
        if (current.paused || current.cancelled) return;
        current.offset = await fetchOffset(current.id);
        renderProgress(current.offset, current.size);
      }
    }

    var response = await postJson("/upload/" + current.id + "/finish");
    if (!response.ok) {
      var payload = await response.json().catch(function () {
        return {};
      });
      throw new Error(payload.error || "Abschluss fehlgeschlagen.");
    }
    var done = await response.json();

    try {
      var message = (done.filename || current.file.name) +
        " wurde hochgeladen. Checksumme wird berechnet.";
      if (done.replaced) {
        message += " „" + done.replaced + "“ wurde als alte Version entfernt.";
      }
      sessionStorage.setItem("iso-share-flash", message);
    } catch (e) {
      // Ohne sessionStorage entfaellt nur die Bestaetigung nach dem Reload
    }
    window.location.assign("/admin-upload");
  }

  function fail(message) {
    notify(message, "error");
    resetUi();
    job = null;
  }

  async function startOrResume(file) {
    var response;
    try {
      response = await postJson("/upload/init", {
        name: file.name,
        size: file.size,
        replaces: replacesSelect && replacesSelect.value ? replacesSelect.value : undefined,
      });
    } catch (e) {
      fail("Netzwerkfehler beim Start des Uploads.");
      return;
    }

    var payload = await response.json().catch(function () {
      return {};
    });

    if (!response.ok) {
      fail(payload.error || "Upload konnte nicht gestartet werden.");
      return;
    }

    job = {
      id: payload.id,
      offset: payload.offset || 0,
      size: file.size,
      file: file,
      paused: false,
      cancelled: false,
      xhr: null,
    };

    if (job.offset > 0) {
      var percent = Math.round((job.offset / job.size) * 100);
      resumeText.textContent =
        "Auf dem Server liegen schon " + formatSize(job.offset) +
        " (" + percent + " %) dieser Datei — der Upload wird dort fortgesetzt.";
      resume.hidden = false;
    }

    renderProgress(job.offset, job.size);

    try {
      await runJob(job);
    } catch (err) {
      fail(err.message || "Upload fehlgeschlagen.");
    }
  }

  /* --------------------------------------------------------------- Steuerung */

  form.addEventListener("submit", function (event) {
    event.preventDefault();

    var file = input.files[0];
    if (!file) {
      notify("Bitte zuerst eine Datei auswählen.", "error");
      return;
    }
    if (job && !job.paused) return;

    setBusy(true);

    // Fortsetzen eines pausierten Uploads statt neu zu beginnen
    if (job && job.paused) {
      job.paused = false;
      pauseButton.textContent = "Pause";
      runJob(job).catch(function (err) {
        fail(err.message || "Upload fehlgeschlagen.");
      });
      return;
    }

    startOrResume(file);
  });

  pauseButton.addEventListener("click", function () {
    if (!job) return;

    if (job.paused) {
      job.paused = false;
      pauseButton.textContent = "Pause";
      transferLabel.textContent = "Wird fortgesetzt…";
      runJob(job).catch(function (err) {
        fail(err.message || "Upload fehlgeschlagen.");
      });
      return;
    }

    job.paused = true;
    pauseButton.textContent = "Fortsetzen";
    // Den laufenden Block abbrechen. Die bereits geschriebenen Bytes bleiben
    // serverseitig gueltig, der Offset steht danach nur niedriger.
    if (job.xhr) job.xhr.abort();
    transferLabel.textContent = "Pausiert bei " + formatSize(job.offset);
  });

  cancelButton.addEventListener("click", function () {
    if (!job) return;
    var id = job.id;
    job.cancelled = true;
    if (job.xhr) job.xhr.abort();
    job = null;

    fetch("/upload/" + id, { method: "DELETE" }).catch(function () {});
    resetUi();
    resume.hidden = true;
    notify("Upload abgebrochen.", "info");
  });

  /* Bestaetigung nach dem Reload nachtragen */
  try {
    var flash = sessionStorage.getItem("iso-share-flash");
    if (flash) {
      sessionStorage.removeItem("iso-share-flash");
      notify(flash, "success");
    }
  } catch (e) {
    // ignorieren
  }
})();
