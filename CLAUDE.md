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
- Admin password is set in `server.js` as `const PASSWORD = 'PASSWORD'`

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