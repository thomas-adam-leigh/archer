# syntax=docker/dockerfile:1.9
#
# Archer web app (TanStack Start + Nitro) — built from the monorepo root as context:
#   docker build -f apps/web/Dockerfile \
#     --build-arg VITE_SUPABASE_URL=... \
#     --build-arg VITE_SUPABASE_PUBLISHABLE_KEY=... \
#     --build-arg VITE_ARCHER_API_URL=... \
#     -t archer-web .
#
# The three VITE_ values are PUBLIC client config (project URL, publishable key,
# API base URL) — they ship in the browser bundle by design, so baking them in as
# build args is safe. Vite inlines them at `vite build`, so they must be present in
# the build stage; they are not read at runtime.
#
# Nitro's `node-server` preset emits a self-contained `.output` (workspace + npm
# deps bundled into `_libs`), so the runtime image is just node + `.output` — no
# install, no node_modules. Mirrors services/api/Dockerfile's builder→slim shape.

FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm" PATH="/pnpm:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS build
# Vite inlines these into the client bundle at build time (all public values).
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ARG VITE_ARCHER_API_URL
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY \
    VITE_ARCHER_API_URL=$VITE_ARCHER_API_URL
# Copy the whole workspace so pnpm can resolve the lockfile + workspace graph.
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile
# `web...` builds `web` AND its workspace dep @archer/agui-client — without it the
# shared AG-UI client's dist/ is missing and the SSR build fails to resolve it.
RUN pnpm --filter web... build

FROM node:22-slim AS runtime
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0
WORKDIR /app
# The Nitro node-server output is self-contained — copy just it.
COPY --from=build /app/apps/web/.output ./.output
USER node
EXPOSE 3000
# Container-level liveness; the SSR root renders for an unauthenticated GET.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", ".output/server/index.mjs"]
