# syntax=docker/dockerfile:1.9
#
# Archer scheduler — built from the monorepo root as context:
#   docker build -f services/scheduler/Dockerfile -t archer-scheduler .
#
# Strategy: install + build once in a builder stage, then `pnpm deploy` a
# self-contained, prod-only tree into a slim non-root runtime image.
#
# NOTE: the default scheduled command runs `claude -p` — the Claude Code CLI must
# be present on PATH in whatever environment actually executes the ticks.

FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm" PATH="/pnpm:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS build
# better-sqlite3 is a native module — it needs a toolchain to build/rebuild.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
# Copy the whole workspace so pnpm can resolve the lockfile + workspace graph.
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile
RUN pnpm --filter @archer/scheduler build
# Produce an isolated, prod-only deployment of just this service.
RUN pnpm --filter @archer/scheduler deploy --prod --legacy /prod/scheduler

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /prod/scheduler ./
USER node
CMD ["node", "dist/index.js"]
