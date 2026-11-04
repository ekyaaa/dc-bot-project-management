# ==============================================================================
# Multi-Stage Dockerfile for Discord Project Management Bot
# Base Image: node:22-bookworm-slim (Debian 12 Bookworm, glibc, Node 22 LTS)
# Security: Non-root user 'node' (UID/GID 1000), dumb-init PID 1 supervisor
# Native Compatibility: C++ toolchain for compiling better-sqlite3 in builder
# ==============================================================================

# ------------------------------------------------------------------------------
# Stage 1: Build & Native Addon Compilation
# ------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Install native build tools required for compiling better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

# Install all dependencies (including devDependencies for TypeScript compilation)
COPY package.json package-lock.json ./
RUN npm ci

# Copy TypeScript configuration and source code
COPY tsconfig.json ./
COPY src/ ./src/

# Compile TypeScript to JavaScript in dist/
RUN npm run build

# Prune devDependencies to keep only production modules & compiled native addons
RUN npm prune --omit=dev && npm cache clean --force

# ------------------------------------------------------------------------------
# Stage 2: Minimal Production Runner
# ------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runner
WORKDIR /app

# Runtime environment configuration
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/data/bot.db \
    TZ=Asia/Jakarta

# Install dumb-init for PID 1 signal handling and zombie reaping
RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init \
  && rm -rf /var/lib/apt/lists/*

# Pre-create /data and /app owned by unprivileged user 'node' (UID/GID 1000)
RUN mkdir -p /data /app && chown -R node:node /data /app && chmod 700 /data

# Copy production node_modules from builder
COPY --from=builder --chown=node:node /app/node_modules ./node_modules

# Copy compiled JavaScript output from builder
COPY --from=builder --chown=node:node /app/dist ./dist

# Copy database schema migrations required by migrator at startup
COPY --chown=node:node migrations ./migrations

# Copy package.json to preserve ESM ("type": "module") module semantics
COPY --chown=node:node package.json ./

# Switch to standard non-root user
USER node

# Expose HTTP port for webhook ingestion and health checks
EXPOSE 3000

# Container liveness health check using Node 22 native fetch (zero curl dependency)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health/live').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Process supervisor entrypoint
ENTRYPOINT ["dumb-init", "--"]

# Start bot service
CMD ["node", "dist/main.js"]
