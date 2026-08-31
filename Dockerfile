# AgentFlow — one file, two images.
#
# `web` and `worker` share a dependency install and a Prisma client, so they
# share a build here and diverge only at the end. Build a specific one with
# `--target web` / `--target worker`; docker-compose does that for you.

# ─────────────────────────────── dependencies ───────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app

# Only the manifests, so a code change does not re-download the world.
COPY package.json package-lock.json ./
COPY web/package.json ./web/
COPY worker/package.json ./worker/
COPY packages/core/package.json ./packages/core/

RUN npm ci

# ──────────────────────────────── build ─────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

# npm workspaces hoist to the root, and the per-workspace directories hold only
# the symlinks back — which live inside this same tree.
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# The Prisma client is generated code; it has to exist before anything compiles.
RUN npx prisma generate

# Next's standalone output: a server plus only the files it actually imports.
RUN npm --workspace web run build

# ───────────────────────────────── web ──────────────────────────────────────
FROM node:22-alpine AS web
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# The standalone bundle, plus the two things Next leaves out of it.
COPY --from=build /app/web/.next/standalone ./
COPY --from=build /app/web/.next/static ./web/.next/static
COPY --from=build /app/web/public ./web/public

# The standalone tracer already brings @prisma/client and the query engine.
# The Prisma CLI is deliberately NOT here: migrations are applied once by the
# `migrate` service in docker-compose.yml, not by every service that starts.

# Not root. An app that runs code-executing agents should own as little as it can.
RUN addgroup -S agentflow && adduser -S agentflow -G agentflow \
  && mkdir -p /data && chown -R agentflow:agentflow /app /data
USER agentflow

EXPOSE 3000
CMD ["node", "web/server.js"]

# ──────────────────────────────── worker ────────────────────────────────────
FROM node:22-alpine AS worker
WORKDIR /app
ENV NODE_ENV=production

# git is not optional here: cloning and pushing IS the worker's job.
RUN apk add --no-cache git openssh-client ca-certificates

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/worker ./worker
COPY --from=build /app/packages ./packages
COPY --from=build /app/prisma ./prisma

RUN addgroup -S agentflow && adduser -S agentflow -G agentflow \
  && mkdir -p /data /workspaces && chown -R agentflow:agentflow /app /data /workspaces
USER agentflow

# Agents work in here; the volume keeps a parked run's clone across a restart.
ENV AGENTFLOW_WORKSPACE_ROOT=/workspaces

CMD ["npx", "tsx", "worker/src/index.ts"]
