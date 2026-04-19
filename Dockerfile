# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — Builder
# Compiles TypeScript to JavaScript.
# The builder stage includes devDependencies (TypeScript, tsx, etc.)
# which are NOT needed at runtime. They are left behind when we copy
# only the compiled output into the production stage.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first — Docker layer cache means npm install only
# re-runs when package.json or package-lock.json actually changes.
COPY package*.json ./

# Install ALL dependencies including devDependencies — needed for tsc
RUN npm ci

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Compile TypeScript → dist/
RUN npm run build


# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — Production
# Runs the compiled JavaScript. Contains only what is needed at runtime:
#   - node_modules (production dependencies only)
#   - dist/ (compiled output)
#   - No TypeScript compiler, no source files, no devDependencies
# ─────────────────────────────────────────────────────────────────────────────

FROM node:20-alpine AS production

# Security: run as non-root user
# node:alpine ships with a 'node' user (uid 1000) built in
RUN addgroup -g 1001 -S checkoutos && \
    adduser -S -u 1001 -G checkoutos checkoutos

WORKDIR /app

# Copy package files for production install
COPY package*.json ./

# Install production dependencies only — devDependencies excluded
RUN npm ci --omit=dev && \
    # Clean npm cache to reduce image size
    npm cache clean --force

# Copy compiled output from builder stage
COPY --from=builder /app/dist ./dist

# Switch to non-root user
USER checkoutos

# Expose the port the app listens on
# This is documentation — the actual port is controlled by the PORT env var
EXPOSE 3000

# Health check — Docker will mark the container unhealthy if this fails
# Starts checking 30s after startup, checks every 30s, allows 10s per check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

# Start the compiled server
CMD ["node", "dist/server.js"]