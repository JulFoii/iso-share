(function () {
  function qs(sel) { return document.querySelector(sel); }

  function api(path, data) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data || {})
    }).then(r => r.json());
  }

  function mountBanner() {
    if (!window.__SHOW_COOKIE_BANNER__) return;

    // Bootstrap toast-like banner
    var el = document.createElement('div');
    el.className = 'position-fixed bottom-0 start-0 end-0 p-3';
    el.style.zIndex = 1080;
    el.innerHTML = `
      <div class="container">
        <div class="card shadow">
          <div class="card-body d-flex flex-column flex-md-row align-items-start align-items-md-center gap-3">
            <div class="flex-grow-1">
              <div class="fw-semibold">🍪 Cookies & Datenschutz</div>
              <div class="text-muted small">
                Wir verwenden nur technisch notwendige Cookies (Session für Admin-Login). Optional kannst du Analytics-Cookies erlauben.
                Mehr Infos: <a href="/datenschutz">Datenschutz</a> · <a href="/cookie-settings">Einstellungen</a>
              </div>
            </div>
            <div class="d-flex gap-2">
              <button class="btn btn-outline-secondary btn-sm" id="cc-reject">Nur notwendige</button>
              <button class="btn btn-primary btn-sm" id="cc-accept">Alle akzeptieren</button>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(el);

    var rejectBtn = qs('#cc-reject');
    var acceptBtn = qs('#cc-accept');

    function close() {
      el.remove();
      window.__SHOW_COOKIE_BANNER__ = false;
    }

    rejectBtn.addEventListener('click', function () {
      api('/api/cookie-consent/reject').then(close).catch(close);
    });

    acceptBtn.addEventListener('click', function () {
      api('/api/cookie-consent', { analytics: true }).then(close).catch(close);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountBanner);
  } else {
    mountBanner();
  }
})();
