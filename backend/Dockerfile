# ============================================================
# PRISM-X backend — production image
#
# Multi-stage on purpose. The build stage needs the full dependency tree, the
# TypeScript compiler and the Prisma generator; the runtime needs none of them.
# Shipping one image with all of it would mean deploying a compiler, its
# transitive dependencies and their advisories to every production host.
# ============================================================

# ---------- deps: install once, reuse for build and runtime ----------
FROM node:22-alpine AS deps
WORKDIR /app

# Only the manifests, so this layer is cached until dependencies actually
# change. Copying the source first would invalidate it on every edit.
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

# ---------- build: compile and generate ----------
FROM node:22-alpine AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# The Prisma client is generated from the schema rather than committed, so it
# always matches the schema in the same commit.
RUN npx prisma generate \
 && npm run build \
 # Drop dev dependencies from the tree that will be copied forward.
 && npm prune --omit=dev

# ---------- runtime ----------
FROM node:22-alpine AS runtime
WORKDIR /app

# dumb-init reaps zombies and forwards signals, which is what makes
# SIGTERM reach Node and the graceful shutdown hook actually run. Without it
# the container is killed after the grace period instead of draining.
RUN apk add --no-cache dumb-init curl \
 && addgroup -g 1001 -S prismx \
 && adduser -u 1001 -S prismx -G prismx

ENV NODE_ENV=production \
    PORT=3000 \
    NODE_OPTIONS="--enable-source-maps"

COPY --from=build --chown=prismx:prismx /app/node_modules ./node_modules
COPY --from=build --chown=prismx:prismx /app/dist ./dist
COPY --from=build --chown=prismx:prismx /app/prisma ./prisma
COPY --from=build --chown=prismx:prismx /app/package.json ./package.json
COPY --from=build --chown=prismx:prismx /app/docs ./docs

# Never root. A container escape should land somewhere without privileges.
USER prismx
EXPOSE 3000

# Liveness only: a health check that fails on a database blip would restart a
# healthy container and turn a dependency wobble into an outage.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/v1/ops/health/live || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
