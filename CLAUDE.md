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
- Admin password comes from `ADMIN_PASSWORD`; if unset, a random one is generated and logged once at startup (no hardcoded default). `SESSION_SECRET` likewise falls back to a random per-start value
- `MAX_FILE_SIZE_MB` (default 8192) caps both the multipart and the chunked-upload path
- `SESSION_DIR` (default `data/sessions/`) is where `FileSessionStore` persists sessions — mount this as a volume in Docker, not `/tmp`

## Key Routes Structure

- `/` - Public file listing with search and download
- `/checksums` - `SHA256SUMS` (coreutils format) for every file with a current checksum
- `/healthz` - liveness endpoint for the Docker healthcheck; deliberately not `/`, which would render the whole listing every 30s
- `/login` - Admin authentication
- `/admin-upload` - Protected admin area for file management
- `/upload` - Multipart file upload endpoint, admin only (no-JS fallback; `upload.js` prefers the chunked protocol below)
- `/upload/init`, `/upload/:id` (GET/PATCH/DELETE), `/upload/:id/finish` - Resumable chunked-upload protocol, admin only (see `lib/chunked-upload.js`)
- `/delete` - File deletion endpoint (admin only), also removes the metadata sidecar
- `/search` and `/admin-search` - Real-time file filtering

## Views Structure

- `views/index.ejs` - Public file listing page
- `views/admin.ejs` - Admin file management page  
- `views/login.ejs` - Authentication page
- `views/partials/file-row.ejs` - One file's table row + detail row, shared by index and admin

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
