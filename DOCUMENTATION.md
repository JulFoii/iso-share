# ISO Share - Complete Documentation

## Table of Contents

1. [Project Overview](#project-overview)
2. [Architecture](#architecture)
3. [Installation & Setup](#installation--setup)
4. [Configuration](#configuration)
5. [API Reference](#api-reference)
6. [Frontend Structure](#frontend-structure)
7. [Security](#security)
8. [Development](#development)
9. [Deployment](#deployment)
10. [Troubleshooting](#troubleshooting)

---

## Project Overview

**ISO Share** is a minimalistic web application designed for secure sharing and management of ISO files. Built with Node.js and Express, it provides a clean, responsive interface for uploading, downloading, and managing ISO files with both public viewing and protected administrative functionality.

### Key Features

- **File Management**: Upload, download, and delete ISO files
- **Two-Tier Access**: Public file listing and protected admin interface
- **Real-time Search**: Live filtering of files in both user and admin views
- **Responsive Design**: Bootstrap-based UI with mobile support
- **Security**: Session-based authentication with file type validation
- **Docker Support**: Containerized deployment with Docker Compose
- **Modern UI**: Clean, light-themed interface with sorting capabilities

---

## Architecture

### Technology Stack

- **Backend**: Node.js with Express.js framework
- **Template Engine**: EJS (Embedded JavaScript Templates)
- **File Upload**: Multer middleware
- **Session Management**: express-session
- **Frontend**: Bootstrap 5, vanilla JavaScript
- **Containerization**: Docker with Alpine Linux base

### File Structure

```
iso-share/
├── server.js              # Main application server
├── package.json           # Node.js dependencies
├── Dockerfile             # Docker container configuration
├── docker-compose.yml     # Docker Compose setup
├── CLAUDE.md              # Project instructions for Claude Code
├── README.md              # Basic project information
├── uploads/               # File storage directory (created automatically)
└── views/                 # EJS templates
    ├── index.ejs          # Public file listing page
    ├── admin.ejs          # Admin interface
    ├── login.ejs          # Authentication page
    ├── privacy.ejs        # Privacy policy
    └── imprint.ejs        # Imprint page
```

### Application Flow

```
Public Users:
Browser → / → View files → /download/:filename

Admin Users:
Browser → /login → /admin-upload → Upload/Delete files
```

---

## Installation & Setup

### Prerequisites

Choose one of the following options:

**Option A: Node.js Installation**
- Node.js v14 or higher
- npm package manager

**Option B: Docker Installation**
- Docker Engine
- Docker Compose

### Standard Installation

```bash
# Clone the repository
git clone https://github.com/JulFoii/iso-share.git
cd iso-share

# Install dependencies
npm install

# Start the server
npm start
# or
node server.js

# Access the application
# Public: http://localhost:3000
# Admin: http://localhost:3000/login
```

### Docker Installation

```bash
# Clone the repository
git clone https://github.com/JulFoii/iso-share.git
cd iso-share

# Start with Docker Compose
docker-compose up -d

# View logs
docker-compose logs -f

# Stop the application
docker-compose down
```

---

## Configuration

### Environment Variables

The application can be configured using environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `ADMIN_PASSWORD` | `'PASSWORD'` | Admin login password |
| `SESSION_SECRET` | `'supersecretkey'` | Session encryption key |

### Setting Environment Variables

**Development:**
```bash
export ADMIN_PASSWORD="your-secure-password"
export SESSION_SECRET="your-session-secret"
npm start
```

**Production (Docker):**
```yaml
# docker-compose.yml
environment:
  - ADMIN_PASSWORD=your-secure-password
  - SESSION_SECRET=your-session-secret
```

### File Storage

- Files are stored in the `uploads/` directory
- Directory is created automatically if it doesn't exist
- Only `.iso` files are accepted
- File size limits depend on your server configuration

---

## API Reference

### Public Routes

#### GET /
**Description**: Display public file listing page
**Access**: Public
**Response**: Rendered index.ejs with file list

#### GET /download/:filename
**Description**: Download a specific ISO file
**Access**: Public
**Parameters**:
- `filename` (URL parameter): Name of the ISO file
**Security**: Path traversal protection implemented
**Response**: File download or 404 error

#### GET /search
**Description**: Search files in public view
**Access**: Public
**Parameters**:
- `q` (query parameter): Search query
**Response**: Rendered index.ejs with filtered results

### Authentication Routes

#### GET /login
**Description**: Display login page
**Access**: Public
**Response**: Rendered login.ejs

#### POST /login
**Description**: Authenticate admin user
**Access**: Public
**Body**:
```json
{
  "password": "admin-password"
}
```
**Response**: Redirect to `/admin-upload` or error message

#### GET /logout
**Description**: Destroy admin session
**Access**: Authenticated
**Response**: Redirect to public homepage

### Admin Routes

#### GET /admin-upload
**Description**: Display admin interface
**Access**: Authenticated only
**Response**: Rendered admin.ejs with file management interface

#### POST /upload
**Description**: Upload new ISO file
**Access**: Authenticated only
**Content-Type**: `multipart/form-data`
**Body**: File data with `file` field
**Validation**: Only `.iso` files accepted
**Response**: Redirect to admin interface

#### POST /delete
**Description**: Delete an existing file
**Access**: Authenticated only
**Body**:
```json
{
  "filename": "file-to-delete.iso"
}
```
**Response**: Redirect to admin interface

#### GET /admin-search
**Description**: Search files in admin view
**Access**: Authenticated only
**Parameters**:
- `q` (query parameter): Search query
**Response**: Rendered admin.ejs with filtered results

### Legal Pages

#### GET /privacy
**Description**: Privacy policy page
**Access**: Public
**Response**: Rendered privacy.ejs

#### GET /imprint
**Description**: Imprint/legal information page
**Access**: Public
**Response**: Rendered imprint.ejs

---

## Frontend Structure

### Templates (EJS)

#### index.ejs - Public Interface
- **Purpose**: File listing for public users
- **Features**:
  - Responsive file table with sorting
  - Real-time search functionality
  - Download buttons for each file
  - Link to admin area
- **Styling**: Bootstrap 5 with custom CSS
- **JavaScript**: Table sorting and live search

#### admin.ejs - Admin Interface
- **Purpose**: File management for administrators
- **Features**:
  - Drag-and-drop file upload
  - Progress bar for uploads
  - File deletion with confirmation modal
  - Real-time search and sorting
  - Logout functionality
- **Styling**: Enhanced Bootstrap with custom animations
- **JavaScript**: Advanced upload handling, drag-and-drop, modals

#### login.ejs - Authentication
- **Purpose**: Admin login form
- **Features**:
  - Simple password authentication
  - Error message display
  - Responsive design
- **Styling**: Centered card layout

### CSS Styling

- **Framework**: Bootstrap 5.3.2
- **Theme**: Light theme with blue accents
- **Responsive**: Mobile-first design
- **Custom Elements**:
  - Drag-and-drop upload zone
  - Sortable table headers
  - Sticky footer
  - Loading animations

### JavaScript Features

#### File Upload (admin.ejs)
```javascript
// Drag and drop functionality
// Progress bar updates
// File type validation
// AJAX upload with error handling
```

#### Table Sorting (both views)
```javascript
// Sortable columns (filename, size)
// Toggle ascending/descending order
// Numeric and text sorting
```

#### Real-time Search
```javascript
// Live filtering as user types
// Case-insensitive search
// Instant results without page reload
```

---

## Security

### Authentication
- **Method**: Session-based authentication
- **Password**: Configurable via environment variable
- **Session**: 24-hour expiry, secure configuration
- **Protection**: All admin routes protected by middleware

### File Security
- **Upload Validation**: Only `.iso` files accepted
- **Path Traversal**: Protection against `../` attacks
- **File Storage**: Isolated uploads directory
- **Access Control**: Direct file access controlled

### Security Headers
- **XSS Protection**: Basic output escaping in templates
- **CSRF**: Protected by session verification
- **File Type**: MIME type validation on upload

### Docker Security
- **Non-root User**: Container runs as `node` user
- **Limited Permissions**: Minimal file system access
- **Health Checks**: Container health monitoring
- **Alpine Base**: Minimal attack surface

---

## Development

### Project Structure Details

#### server.js (Main Application)
```javascript
// Core modules and configuration
const express = require('express');
const multer = require('multer');
const session = require('express-session');

// Key functions:
// - checkAuth(): Authentication middleware
// - File upload handling with validation
// - Session management
// - Error handling and logging
```

#### Development Commands
```bash
# Start development server
npm start

# Install new dependencies
npm install package-name

# View application logs
node server.js

# Test file upload
curl -F "file=@test.iso" http://localhost:3000/upload
```

### Common Development Tasks

#### Adding New Routes
```javascript
// In server.js
app.get('/new-route', (req, res) => {
  res.render('template-name', { data });
});
```

#### Modifying Templates
- Edit files in `views/` directory
- Use EJS syntax: `<%= variable %>`
- Include Bootstrap classes for styling
- Test responsive design

#### Environment Setup
```bash
# Development environment
export NODE_ENV=development
export ADMIN_PASSWORD=dev-password
export SESSION_SECRET=dev-secret
```

---

## Deployment

### Production Deployment

#### Docker Production Setup
```yaml
# docker-compose.prod.yml
version: '3.8'
services:
  iso-share:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - ADMIN_PASSWORD=${ADMIN_PASSWORD}
      - SESSION_SECRET=${SESSION_SECRET}
    volumes:
      - ./uploads:/app/uploads
    restart: unless-stopped
```

#### Environment Configuration
```bash
# Production environment variables
export ADMIN_PASSWORD="secure-production-password"
export SESSION_SECRET="cryptographically-secure-secret"
export NODE_ENV=production
```

#### Reverse Proxy (Nginx)
```nginx
server {
    listen 80;
    server_name your-domain.com;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### Monitoring and Maintenance

#### Health Checks
- Built-in Docker health check on port 3000
- Monitor upload directory disk usage
- Session cleanup (automatic)

#### Backup Strategy
```bash
# Backup uploaded files
tar -czf backup-$(date +%Y%m%d).tar.gz uploads/

# Restore from backup
tar -xzf backup-20250101.tar.gz
```

#### Log Management
```bash
# View container logs
docker-compose logs -f iso-share

# Log rotation (in production)
docker-compose logs --tail=1000 iso-share > app.log
```

---

## Troubleshooting

### Common Issues

#### Port Already in Use
```bash
# Find process using port 3000
sudo lsof -i :3000

# Kill the process
sudo kill -9 PID

# Or use different port
export PORT=3001
```

#### File Upload Fails
- **Check file type**: Only `.iso` files allowed
- **Check file size**: May exceed server limits
- **Check permissions**: Ensure uploads directory is writable
- **Check disk space**: Server may be full

#### Session Issues
- **Clear browser cookies**: Remove session cookies
- **Check session secret**: Ensure SESSION_SECRET is set
- **Restart server**: Clear server-side sessions

#### Docker Issues
```bash
# Rebuild container
docker-compose down
docker-compose up --build

# Check container status
docker-compose ps

# View detailed logs
docker-compose logs iso-share
```

#### File Not Found Errors
- **Check uploads directory**: Ensure it exists and has files
- **Check file names**: Case-sensitive file system
- **Check permissions**: Files must be readable

### Debug Mode

Enable detailed logging:
```javascript
// Add to server.js for debugging
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`, req.body);
  next();
});
```

### Performance Optimization

#### File Upload Optimization
- Configure multer limits in server.js
- Implement file size validation
- Add upload progress tracking

#### Database Alternative
For high-volume deployments, consider:
- Adding SQLite for file metadata
- Implementing file indexing
- Adding user management

---

## License

This project is licensed under the ISC License. See the package.json file for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## Support

For issues and support:
- Check this documentation
- Review the CLAUDE.md file for development guidance
- Check the existing GitHub issues
- Create a new issue with detailed information

---

*Last updated: January 2025*