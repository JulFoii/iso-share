# Use official Node.js runtime as base image
FROM node:18-alpine

# Build metadata (populated by CI)
ARG VERSION="dev"
ARG VCS_REF="unknown"
ARG BUILD_DATE="unknown"

LABEL org.opencontainers.image.title="iso-share" \
      org.opencontainers.image.description="ISO Share - simple ISO/file share web app" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.revision="$VCS_REF" \
      org.opencontainers.image.created="$BUILD_DATE"

# Set working directory in container
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install curl for health checks + install production dependencies
RUN apk add --no-cache curl \
  && npm ci --only=production

# Copy application code
COPY . .

# Create uploads directory and set permissions
RUN mkdir -p uploads && \
    chown -R node:node /app

# Switch to non-root user for security
USER node

# Expose port 3000
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/ || exit 1

# Start the application
CMD ["node", "server.js"]