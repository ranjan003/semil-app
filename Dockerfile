# ── Stage 1: install production dependencies ──
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# ── Stage 2: production image ──
FROM node:20-alpine AS production
LABEL maintainer="Semil Retail Industries"
LABEL description="Semil Talent Discovery — Recruitment Assessment Platform"

# Security: run as non-root
RUN addgroup -g 1001 -S semil && adduser -S semil -u 1001 -G semil

WORKDIR /app

# Copy dependencies from stage 1
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY package.json ./
COPY src/ ./src/
COPY db/ ./db/
COPY public/ ./public/
COPY scripts/ ./scripts/
# Create storage directory (may be empty on first build)
RUN mkdir -p ./storage && chown -R semil:semil ./storage

# Environment defaults
ENV NODE_ENV=production
ENV PORT=3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/healthz || exit 1

# Switch to non-root user
USER semil

EXPOSE 3000

CMD ["node", "src/server.js"]
