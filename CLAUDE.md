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

# Development with auto-reload
npm run dev

# Access the application
# Public view: http://localhost:3000
# Admin login: http://localhost:3000/login
```

### Testing & Quality
```bash
# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Run tests in watch mode
npm run test:watch

# Run linting
npm run lint

# Fix linting issues
npm run lint:fix
```

### CI/CD & Deployment
```bash
# Build Docker image
docker build -t iso-share .

# Run with Docker Compose (development)
docker-compose up -d

# Run with Docker Compose (production)
docker-compose -f docker-compose.prod.yml up -d

# Deploy to different environments
./scripts/deploy.sh staging
./scripts/deploy.sh production
./scripts/deploy.sh k8s

# Kubernetes deployment
kubectl apply -f k8s/
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