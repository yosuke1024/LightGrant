# --- Build Stage ---
FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src/ ./src
RUN npm run build

# --- Production Runner Stage ---
FROM node:22-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled files and migrations
COPY --from=builder /app/dist ./dist
COPY migrations ./migrations
COPY manifests ./manifests

# Create data directory for SQLite with correct permissions for non-root 'node' user
RUN mkdir -p /data && chown -R node:node /data

# Use standard non-root user 'node' provided by the base alpine image
USER node

# Expose port
EXPOSE 3000

# Start command
CMD ["node", "dist/main.js"]
