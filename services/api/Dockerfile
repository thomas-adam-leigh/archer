# syntax=docker/dockerfile:1.9
#
# Archer API (Hono) — built from the monorepo root as context:
#   docker build -f services/api/Dockerfile -t archer-api .
#
# Strategy: install + build once in a builder stage, then `pnpm deploy` a
# self-contained, prod-only tree into a slim non-root runtime image.

FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm" PATH="/pnpm:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS build
# Copy the whole workspace so pnpm can resolve the lockfile + workspace graph.
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile
RUN pnpm --filter @archer/api build
# Produce an isolated, prod-only deployment of just this service.
RUN pnpm --filter @archer/api deploy --prod --legacy /prod/api

FROM node:22-slim AS runtime
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build /prod/api ./
USER node
EXPOSE 3000
# Container-level liveness — Komodo's deploy procedure also gates on this.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
