/*
 * Upload-Formular: Dropzone, Dateivorschau, Fortschritt per XHR.
 *
 * /upload antwortet auf `Accept: application/json` mit JSON (statt Redirect),
 * damit Fehler hier als Text ankommen und nicht als HTML-Seite im XHR landen.
 */
(function () {
  var form = document.getElementById("uploadForm");
  if (!form) return;

  var zone = document.getElementById("dropzone");
  var input = document.getElementById("fileInput");
  var submit = document.getElementById("uploadSubmit");
  var preview = document.getElementById("filePreview");
  var previewName = document.getElementById("filePreviewName");
  var previewSize = document.getElementById("filePreviewSize");
  var progress = document.getElementById("uploadProgress");
  var bar = document.getElementById("uploadProgressBar");
  var percentLabel = document.getElementById("uploadPercent");
  var transferLabel = document.getElementById("uploadTransfer");

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

  function selectFile(file) {
    if (!file) return;
    if (!/\.iso$/i.test(file.name)) {
      window.toast("Nur .iso-Dateien sind erlaubt.", "error");
      return;
    }
    previewName.textContent = file.name;
    previewSize.textContent = formatSize(file.size);
    preview.hidden = false;
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

  /* --------------------------------------------------------------- Absenden */

  form.addEventListener("submit", function (event) {
    event.preventDefault();

    var file = input.files[0];
    if (!file) {
      window.toast("Bitte zuerst eine Datei auswählen.", "error");
      return;
    }

    var body = new FormData();
    body.append("file", file);

    submit.disabled = true;
    submit.textContent = "Wird hochgeladen…";
    progress.hidden = false;
    bar.style.width = "0%";
    bar.parentElement.setAttribute("aria-valuenow", "0");
    percentLabel.textContent = "0 %";
    transferLabel.textContent = "0 B von " + formatSize(file.size);

    function fail(message) {
      window.toast(message, "error");
      submit.disabled = false;
      submit.textContent = "Hochladen";
      progress.hidden = true;
    }

    var xhr = new XMLHttpRequest();

    xhr.upload.addEventListener("progress", function (e) {
      if (!e.lengthComputable) return;
      var percent = Math.round((e.loaded / e.total) * 100);
      bar.style.width = percent + "%";
      bar.parentElement.setAttribute("aria-valuenow", String(percent));
      percentLabel.textContent = percent + " %";
      transferLabel.textContent =
        formatSize(e.loaded) + " von " + formatSize(e.total);
    });

    xhr.addEventListener("load", function () {
      var payload = {};
      try {
        payload = JSON.parse(xhr.responseText);
      } catch (e) {
        // Nicht-JSON-Antwort (z. B. Login-Redirect) unten generisch behandeln
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          sessionStorage.setItem(
            "iso-share-flash",
            (payload.filename || file.name) + " wurde hochgeladen."
          );
        } catch (e) {
          // Ohne sessionStorage entfaellt nur die Bestaetigung nach dem Reload
        }
        window.location.assign("/admin-upload");
        return;
      }

      if (xhr.status === 401 || xhr.status === 403) {
        fail("Sitzung abgelaufen. Bitte neu anmelden.");
        return;
      }

      fail(payload.error || "Upload fehlgeschlagen (HTTP " + xhr.status + ").");
    });

    xhr.addEventListener("error", function () {
      fail("Netzwerkfehler beim Upload.");
    });

    xhr.addEventListener("abort", function () {
      fail("Upload abgebrochen.");
    });

    xhr.open("POST", "/upload");
    xhr.setRequestHeader("Accept", "application/json");
    xhr.send(body);
  });

  /* Bestaetigung nach dem Reload nachtragen */
  try {
    var flash = sessionStorage.getItem("iso-share-flash");
    if (flash) {
      sessionStorage.removeItem("iso-share-flash");
      window.toast(flash, "success");
    }
  } catch (e) {
    // ignorieren
  }
})();
