# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ISO Share is a minimalistic web application for secure sharing and management of ISO files. It's built as a Node.js Express application with EJS templating, providing both public file viewing and protected admin functionality.

## Key Architecture

- **Single-file server**: `server.js` contains the entire backend logic
- **Express-based**: Uses Express.js with EJS templating for server-side rendering
- **Session-based auth**: Simple password authentication with express-session
- **File management**: Multer for uploads, direct filesystem operations for file management
- **Two-tier access**: Public file listing/download and admin upload/delete functionality
- **Frontend**: No CSS/JS framework and no CDN — everything is served from `public/`. `public/css/tokens.css` holds the design tokens (dark is the default, `[data-theme="light"]` overrides), `public/css/main.css` the components. The scripts in `public/js/` are small self-contained IIFEs wired up declaratively via `data-*` attributes, so a view opts into behaviour by adding markup, not by adding a script tag
- **Progressive enhancement is load-bearing**: the newer platform features (cross-document view transitions, `@starting-style`, scroll-driven `.reveal` animations, Popover API + anchor positioning) are all layered so an unsupporting browser gets the static version instead of a broken one. Two guards must stay: the `.reveal` rules live inside `@supports (animation-timeline: view())` because their `opacity: 0` start frame would otherwise hide the cards permanently, and `@supports not selector(:popover-open)` hides the theme menu so it can't sit invisible over the nav (`theme.js` then falls back to cycling on click)

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

### File Operations
- Files are stored in the `uploads/` directory
- Only `.iso` files are accepted for upload
- Admin password comes from `ADMIN_PASSWORD`; if unset, a random one is generated and logged once at startup (no hardcoded default). `SESSION_SECRET` likewise falls back to a random per-start value

## Key Routes Structure

- `/` - Public file listing with search and download
- `/login` - Admin authentication
- `/admin-upload` - Protected admin area for file management
- `/upload` - File upload endpoint (admin only)
- `/delete` - File deletion endpoint (admin only)
- `/search` and `/admin-search` - Real-time file filtering

## Views Structure

- `views/index.ejs` - Public file listing page
- `views/admin.ejs` - Admin file management page  
- `views/login.ejs` - Authentication page

All views use Bootstrap 5 for styling with a light theme and responsive design.

## Security

`server.js` is hardened against the common web risks; keep these in place when editing:
- **Secrets**: no functional defaults — `ADMIN_PASSWORD`/`SESSION_SECRET` are random-generated if unset. The password is compared timing-safe via SHA-256 + `crypto.timingSafeEqual`
- **helmet** sets CSP (`'self'` only, `data:` for images), `frame-ancestors 'none'`, `nosniff`, `no-referrer`; `x-powered-by` is disabled
- **CSRF**: `sameSite: 'strict'` cookie plus a same-origin (Origin/Referer host == Host) check on every POST/PUT/PATCH/DELETE
- **Session**: `httpOnly`, `sameSite: 'strict'`, `secure` when prod or behind a proxy; regenerated on login (anti-fixation). Cookie name `iso.sid`. `TRUST_PROXY` numeric = hop count
- **Rate limit**: `express-rate-limit` on `/login` (10 / 15 min)
- **Filename safety**: `safeIsoName()` (basename + allowlist regex + `.iso`) guards both `/upload` and `/delete` and `/download`
- **Uploads**: `uploads/` is NOT served statically — only via `/download` with type check; multer temp dir is `tmp-uploads/` (outside web root) with a `MAX_FILE_SIZE_MB` limit
- Errors are caught by a final handler that never leaks stack traces
- **All request-path filesystem access is async** (`fs/promises`); no `*Sync` call runs inside a handler, so a large `uploads/` can't block the event loop. The upload move uses `rename` with a `copyFile`+`rm` fallback for `EXDEV` (temp dir and `uploads/` on different mounts, e.g. a Docker bind mount)
- **Login brute-force** is capped two ways: per-IP (`express-rate-limit`, failures only) and a global backstop keyed to a constant, so a spoofed `X-Forwarded-For` (when `TRUST_PROXY` is set without a real proxy) can't mint fresh buckets. Only enable `TRUST_PROXY` behind a proxy that overwrites `X-Forwarded-For`
