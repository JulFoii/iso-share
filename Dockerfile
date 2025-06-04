# Multi-stage build for optimized CI/CD
FROM node:18-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install all dependencies (including dev dependencies for testing)
RUN npm ci

# Copy source code
COPY . .

# Run tests and linting in build stage
RUN npm run test && npm run lint

# Production stage
FROM node:18-alpine AS production

# Install curl for health checks
RUN apk add --no-cache curl

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production && npm cache clean --force

# Copy application code from builder stage
COPY --from=builder /app/server.js ./
COPY --from=builder /app/views ./views/

# Create uploads directory and set permissions
RUN mkdir -p uploads && \
    addgroup -g 1001 -S nodejs && \
    adduser -S nodeuser -u 1001 && \
    chown -R nodeuser:nodejs /app

# Switch to non-root user for security
USER nodeuser

# Expose port 3000
EXPOSE 3000

# Health check with better configuration
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:3000/ || exit 1

# Start the application
CMD ["node", "server.js"]