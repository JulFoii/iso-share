# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ISO Share is a minimalistic web application for secure sharing and management of ISO files. It's built as a Node.js Express application with EJS templating, providing both public file viewing and protected admin functionality.

## Key Architecture

- **`server.js`** wires everything together but delegates the non-trivial logic to `lib/`; it stays the place to read for routes and middleware, not for file-format or state-machine details
- **`lib/safe-name.js`**: `safeIsoName()` (filename allowlist) and `safeUploadId()` (UUID check for the chunked-upload session id) — the single validation point every route uses before touching the filesystem or a session file
- **`lib/iso9660.js`**: reads the ISO-9660 Primary Volume Descriptor and El Torito boot catalog straight from the file (no mounting, no external tool) to get volume label, publisher, creation date and BIOS/UEFI bootability. Never throws — a malformed or non-ISO file just yields fewer fields
- **`lib/metadata.js`**: per-file sidecar JSON at `uploads/.meta/<name>.iso.json` (checksum, ISO info, download counter). `listFiles()` filters on `.iso`, so the sidecar directory is invisible in listings. Download counts are buffered in memory and flushed periodically / on shutdown, not written synchronously per request
- **`lib/hash-queue.js`**: background, one-at-a-time SHA-256 + ISO-info worker. `scanAll()` runs at startup and picks up files dropped into `uploads/` outside the app (e.g. `rsync`); a checksum is considered stale (and gets recomputed) whenever the file's size/mtime no longer match what was hashed
- **`lib/chunked-upload.js`**: the resumable-upload protocol (`POST /upload/init`, `PATCH /upload/:id`, `POST /upload/:id/finish`, `DELETE /upload/:id`). The `.part` file's on-disk size *is* the offset — the client never tracks progress itself, it re-reads the server's offset after any network error. A `PATCH` whose `Upload-Offset` header doesn't match the real offset is rejected with 409 and the true offset, so the client resyncs instead of corrupting the file
- **`lib/session-store.js`**: `FileSessionStore`, a small `express-session` store (one JSON file per session under `data/sessions/`, write-through cache so a client following the login redirect never race-loses against the not-yet-flushed file). Replaces the default `MemoryStore`, which lost every session on restart
- **`lib/move-file.js`**: `rename()` with a `copyFile`+`rm` fallback for `EXDEV`, shared by both the multipart and the chunked-upload finish path
- **`lib/webauthn-store.js`**: single-record JSON store (`uploads/.meta/webauthn.json`) for the admin's registered passkeys plus the one stable WebAuthn `userId`; verification itself is `@simplewebauthn/server` (the one deliberate exception to this project's short-dependency-list rule — the crypto involved is too easy to get subtly wrong by hand)
- **`lib/password-store.js`**: optional, persisted admin password as a `scrypt` hash in `data/admin-password.json` (Node's built-in `crypto.scrypt`, no dependency). Absent by default — `ADMIN_PASSWORD` stays authoritative until the admin changes the password via `/admin-password`, after which the persisted hash wins permanently, surviving restarts, even if `ADMIN_PASSWORD` is still set
- **`lib/username-store.js`**: same idea as the password store but for the login username, and much simpler since a username isn't a secret — no hashing, no bootstrap, just plaintext JSON in `data/admin-username.json`. Default is `admin` (`ADMIN_USERNAME` env var or `/admin-username` override it). Only the password-based `/login` form asks for it; passkey login stays username-less since the credential already identifies the one admin account
- **`lib/totp.js`** / **`lib/totp-store.js`**: TOTP second factor for the password login, hand-implemented (RFC 4226/6238 is a short, stable HMAC-SHA1 spec, not a place like WebAuthn where a hand-rolled implementation risks a subtle bug) instead of adding a dependency. `totp.js` is pure crypto (base32, HOTP, `verifyTotp()` with a ±1-step window, the `otpauth://` URI builder); `totp-store.js` persists the single-record `uploads/.meta/totp.json` (secret + hashed recovery codes) the same way `webauthn-store.js` does. No QR code — the setup dialog shows the base32 key as copyable text, since every authenticator app accepts manual entry and a QR library would be a dependency for pure convenience. An in-progress setup lives only in `req.session.totpSetupSecret` until confirmed, so an abandoned setup never leaves a half-enabled second factor
- **`lib/audit-log.js`**: append-only JSON-Lines log at `data/audit.log` for security-relevant events (logins, passkey/TOTP changes, uploads, deletes, password/username changes). Trimmed to the newest lines once the file passes 2 MB, so it never grows unbounded. A logging failure is swallowed — it must never fail the action it's logging
- **`lib/zip-stream.js`**: hand-rolled streaming ZIP writer (`writeZip()`) for the bulk-download route, store method only (no compression — ISOs barely compress anyway) with a data descriptor per entry, so it never needs to know a file's CRC32/size before streaming it straight from disk into the response. Deliberately no Zip64: `fitsInClassicZip()` lets `server.js` reject a selection whose per-file or total size would overflow the classic 32-bit fields *before* the stream starts, rather than emit a truncated/corrupt archive
- **Express-based**: Uses Express.js with EJS templating for server-side rendering
- **Session-based auth**: Simple password authentication with express-session, session state persisted via `FileSessionStore` (see above)
- **File management**: multipart upload (`/upload`, no-JS fallback) and a resumable chunked-upload protocol (`/upload/init` + friends, what `upload.js` actually uses) both land in `uploads/` through `lib/move-file.js`
- **Two-tier access**: Public file listing/download and admin upload/delete functionality
- **Frontend**: No CSS/JS framework and no CDN — everything is served from `public/`. `public/css/tokens.css` holds the design tokens (dark is the default, `[data-theme="light"]` overrides), `public/css/main.css` the components. The scripts in `public/js/` are small self-contained IIFEs wired up declaratively via `data-*` attributes, so a view opts into behaviour by adding markup, not by adding a script tag. `views/partials/file-row.ejs` renders one file's row + its collapsible detail row (checksum, verify snippet, boot info) and is shared by `index.ejs` and `admin.ejs`
- **Progressive enhancement is load-bearing**: the newer platform features (cross-document view transitions, `@starting-style`, scroll-driven `.reveal` animations, Popover API + anchor positioning) are all layered so an unsupporting browser gets the static version instead of a broken one. Two guards must stay: the `.reveal` rules live inside `@supports (animation-timeline: view())` because their `opacity: 0` start frame would otherwise hide the cards permanently, and `@supports not selector(:popover-open)` hides the theme menu so it can't sit invisible over the nav (`theme.js` then falls back to cycling on click). The detail row starts `[hidden]` server-side and only opens via `row-details.js`, so a no-JS client still gets the checksum through `/checksums`

## Common Commands

### Development
```bash
# Install dependencies
npm install

# Start the server
npm start
# or
node server.js

# Access the application
# Public view: http://localhost:3000
# Admin login: http://localhost:3000/login
```

### Tests
```bash
npm test
# node --test test/*.test.js — unit tests for lib/ (no server) plus
# integration tests that boot a real instance on a random port per test
```

### File Operations
- Files are stored in the `uploads/` directory; per-file metadata (checksum, ISO info, download count) lives alongside in `uploads/.meta/`
- Only `.iso` files are accepted for upload
- Admin password comes from `ADMIN_PASSWORD`; if unset, a random one is generated **once** on the very first `start()` and persisted to `data/admin-password.json` (not regenerated on every restart — only logged that one time, so note it down or change it right away). `SESSION_SECRET` still falls back to a random per-start value (unrelated: it signs cookies, not the password). The password can be changed from the admin area (`/admin-password`, no re-entry of the old one needed — a valid session, password- or passkey-based, is proof enough); once changed (or auto-generated), the persisted hash in `data/admin-password.json` wins over `ADMIN_PASSWORD` from then on. Delete that file to fall back to the env var again
- `MAX_FILE_SIZE_MB` (default 8192) caps both the multipart and the chunked-upload path
- `SESSION_DIR` (default `data/sessions/`) is where `FileSessionStore` persists sessions — mount this as a volume in Docker, not `/tmp`

## Key Routes Structure

- `/` - Public file listing with search and download
- `/checksums` - `SHA256SUMS` (coreutils format) for every file with a current checksum
- `/healthz` - liveness endpoint for the Docker healthcheck; deliberately not `/`, which would render the whole listing every 30s
- `/login` - Admin authentication (password, plus an optional passkey via `/webauthn/login/options` + `/webauthn/login/verify`, same rate limiters as the password form). A password login with TOTP enabled redirects to `/login/totp` instead of setting up the session directly
- `/login/totp` - Second factor after a successful password login (`req.session.pendingTotp`); accepts a 6-digit TOTP code or a recovery code, same rate limiters as `/login`. Not required after a passkey login, which already counts as MFA-equivalent
- `/admin-upload` - Protected admin area for file management, including passkey registration (`/webauthn/register/options` + `/webauthn/register/verify`) and management (`GET`/`DELETE /webauthn/credentials`)
- `/admin-password` - Change the admin password (admin only, no old-password re-entry — see `lib/password-store.js`)
- `/admin-username` - Change the admin username (admin only, used by the password login form; not by passkey login — see `lib/username-store.js`)
- `/totp/setup`, `/totp/confirm`, `/totp/disable` - Set up/confirm/disable the TOTP second factor (admin only, see `lib/totp-store.js`); `/totp/confirm` returns a set of one-time recovery codes exactly once
- `/admin-audit-log` - Full audit log (admin only); `admin.ejs` also shows the latest few entries inline, see `lib/audit-log.js`
- `/upload` - Multipart file upload endpoint, admin only (no-JS fallback; `upload.js` prefers the chunked protocol below)
- `/upload/init`, `/upload/:id` (GET/PATCH/DELETE), `/upload/:id/finish` - Resumable chunked-upload protocol, admin only (see `lib/chunked-upload.js`)
- `/delete` - File deletion endpoint (admin only), also removes the metadata sidecar
- `/download-zip` - Bulk download of several selected files as one streamed ZIP (public, same rate limiter as `/download`; see `lib/zip-stream.js`). Silently skips names that no longer exist, rejects a selection over `MAX_BULK_FILES` (100) or one that would overflow the classic ZIP format's 32-bit size fields
- `/delete-bulk` - Bulk deletion of several selected files in one request (admin only), same name validation and `MAX_BULK_FILES` cap as `/download-zip`
- `/search` and `/admin-search` - Real-time file filtering

## Views Structure

- `views/index.ejs` - Public file listing page
- `views/admin.ejs` - Admin file management page  
- `views/login.ejs` - Authentication page
- `views/login-totp.ejs` - Second-factor prompt after a password login, when TOTP is enabled
- `views/audit-log.ejs` - Full audit log (admin only)
- `views/partials/file-row.ejs` - One file's table row + detail row, shared by index and admin
- `views/partials/passkey-row.ejs` - One registered passkey's list row on the admin page

All views use the hand-rolled `public/css/` design system described above — no Bootstrap, no CDN.

## Security

`server.js` is hardened against the common web risks; keep these in place when editing:
- **Secrets**: no functional defaults — `ADMIN_PASSWORD`/`SESSION_SECRET` are random-generated if unset. The password is compared timing-safe via SHA-256 + `crypto.timingSafeEqual`
- **helmet** sets CSP (`'self'` only, `data:` for images), `frame-ancestors 'none'`, `nosniff`, `same-origin` referrer policy; `x-powered-by` is disabled
- **CSRF**: `sameSite: 'strict'` cookie plus a same-origin (Origin/Referer host == Host) check on every POST/PUT/PATCH/DELETE
- **Session**: `httpOnly`, `sameSite: 'strict'`, `secure` when prod or behind a proxy; regenerated on login (anti-fixation). Cookie name `iso.sid`, backed by `FileSessionStore` (`lib/session-store.js`), not the default in-memory store. `TRUST_PROXY` numeric = hop count
- **Rate limit**: `express-rate-limit` on `/login` (10 / 15 min, plus a global backstop — see below) and on `/download` (60 / min per IP; range requests aren't double-counted as separate downloads)
- **Filename safety**: `safeIsoName()` (basename + allowlist regex + `.iso`) guards `/upload`, `/delete`, `/download` and the chunked-upload's `name` field; `safeUploadId()` guards the `:id` path param on every `/upload/:id*` route
- **Uploads**: `uploads/` is NOT served statically — only via `/download` with type check; multer temp dir and the chunked-upload `.part`/`.json` files live in `tmp-uploads/` (outside web root), both capped by `MAX_FILE_SIZE_MB`. `uploads/.meta/` (checksums, download counts) is likewise never served directly
- Errors are caught by a final handler that never leaks stack traces
- **All request-path filesystem access is async** (`fs/promises`); no `*Sync` call runs inside a handler, so a large `uploads/` can't block the event loop. The upload move uses `rename` with a `copyFile`+`rm` fallback for `EXDEV` (temp dir and `uploads/` on different mounts, e.g. a Docker bind mount) — see `lib/move-file.js`
- **Login brute-force** is capped two ways: per-IP (`express-rate-limit`, failures only) and a global backstop keyed to a constant, so a spoofed `X-Forwarded-For` (when `TRUST_PROXY` is set without a real proxy) can't mint fresh buckets. Only enable `TRUST_PROXY` behind a proxy that overwrites `X-Forwarded-For`
- **Chunked-upload protocol**: a `PATCH` is only accepted when its `Upload-Offset` header equals the session's real on-disk offset, and the server never writes more bytes than the size announced at `init` — both close off ways a client could otherwise corrupt or oversize the assembled file
- **Passkeys**: additive, not a replacement — the password form is always the fallback. A passkey can only be registered by an already-authenticated admin (no separate bootstrap route); `/webauthn/login/options` and `/webauthn/login/verify` are public but share the exact same `loginLimiterGlobal`/`loginLimiterPerIp` instances as `/login`, so an attacker can't double their brute-force budget by alternating routes. `rpID`/`expectedOrigin` are derived per-request from `req.get('host')`/`req.protocol` (same inputs as the CSRF `sameOrigin` check) rather than a separate env var — a passkey is therefore bound to the hostname it was registered under
- **Password change** (`/admin-password`): checkAuth-gated only, deliberately without re-entering the current password — the whole point is recovering from a forgotten one, and a valid session already implies full admin access regardless. Hashed with `scrypt` (salted, promisified so it doesn't block the event loop), not the plain `SHA-256` used for the `ADMIN_PASSWORD` env-var comparison — that one is fine unsalted since it's not user-chosen/persisted, but a user-settable password gets the stronger, deliberately slow KDF
- **Username check** (`/login`): a wrong username and a wrong password get the exact same generic error ("Benutzername oder Passwort falsch") — distinguishing them would let an attacker enumerate the username. `passwordMatches()` is always awaited even when the username is already known to be wrong, so a mismatched username can't be inferred from a faster response. Both `/admin-password` and `/admin-username` share the same async-form + `<dialog>`-modal pattern in `public/js/account-forms.js`, with a plain-form no-JS fallback (inline error / silent redirect) preserved for both
- **TOTP second factor**: the session is regenerated right after the *first* factor (password) succeeds, before `/login/totp` is even reached — an attacker who somehow knew the pre-login session id can't ride it through to a fully authenticated session just because TOTP was still pending. `/login/totp` and `/totp/confirm` share the exact same rate limiters as `/login`, for the same anti-doubling reason as the passkey routes. Recovery codes are single-use, checked with a `timingSafeEqual` loop, and hashed with plain SHA-256 rather than `scrypt` — unlike the admin password they're server-generated and already high-entropy, so a slow KDF buys nothing (same reasoning as `PASSWORD_HASH` for the env-var password)
- **Bulk routes** (`/download-zip`, `/delete-bulk`): every name in the `{ names: [...] }` body goes through the exact same `safeIsoName()` as the single-file routes — a batch of names is not a new trust boundary. `/download-zip` stays public (like `/download`) and shares its rate limiter; `/delete-bulk` is `checkAuth`-gated like `/delete`
