# Use official Node.js runtime as base image
# >=22.5 fuer node:sqlite (siehe lib/db.js) — v24 ausgeliefert, damit die
# eingebaute SQLite-API ohne --experimental-sqlite-Flag und ohne
# ExperimentalWarning laeuft (auf v22/23 noch flag- bzw. warnungspflichtig).
FROM node:24-alpine

# Set working directory in container
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Create upload, temp and data directories and set permissions
# data/ haelt die SQLite-Datenbank (Sitzungen, Metadaten, Zugangsdaten, ...)
# ueber einen Neustart hinweg, siehe lib/db.js
RUN mkdir -p uploads tmp-uploads data && \
    chown -R node:node /app

# Switch to non-root user for security
USER node

# Expose port 3000
ENV NODE_ENV=production

EXPOSE 3000

# /healthz statt / — der Healthcheck soll nicht alle 30 s die
# komplette Dateiliste samt Metadaten rendern
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Start the application
CMD ["node", "server.js"]