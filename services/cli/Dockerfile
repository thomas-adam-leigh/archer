# syntax=docker/dockerfile:1.9
#
# Archer CLI (Scout) — built from the monorepo root as context:
#   docker build -f services/cli/Dockerfile -t archer-cli .
#
# Runs as a one-shot / scheduled container (e.g. the daily collect job).
# NOTE: when Scout becomes Python (Patchwright), this Dockerfile is replaced by a
# uv-based build that bakes Chromium — the CI/CD wiring around it stays identical.

FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm" PATH="/pnpm:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile
# Build the workspace dep (@archer/api) then the CLI itself.
RUN pnpm --filter @archer/cli... build
RUN pnpm --filter @archer/cli deploy --prod --legacy /prod/cli

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /prod/cli ./
USER node
ENTRYPOINT ["node", "dist/index.js"]
CMD ["--help"]
