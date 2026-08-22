# ─────────────────────────────────────────────────────────────────────────────
# Telenow Shopify app — production image.
#
# Single-stage: this app has no build step (plain ESM, no bundler, no TypeScript).
# The only thing to do is install production dependencies and copy source.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine

# dumb-init reaps zombies and forwards SIGTERM to node, so `docker compose down`
# and EC2 reboots shut the server down cleanly instead of SIGKILLing it mid-write.
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production
WORKDIR /app

# Copy manifests first so `npm ci` is cached until dependencies actually change.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src/ ./src/

# DATA_DIR is a mounted volume (see docker-compose.yml). Create it and hand it to
# the unprivileged `node` user, which already exists in the base image — the app
# must never run as root on a public-facing box.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV PORT=3000 DATA_DIR=/data
EXPOSE 3000

# The app already serves this; Docker/compose uses it to gate restarts.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/server.js"]
