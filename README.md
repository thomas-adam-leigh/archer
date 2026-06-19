# Archer

An event-driven job-application platform where **the database is the source of truth
and the orchestrator**, and stateless Claude agents do the work. See
[`VISION.md`](./VISION.md) and the foundation docs in [`docs/`](./docs).

## Monorepo layout

```
archer/
├─ apps/                 # front-ends (mobile · web · admin) — to come
├─ services/
│  ├─ api/               # @archer/api — Hono API (deployable)
│  └─ cli/               # @archer/cli — Scout (deployable; → Python/Patchwright)
├─ packages/
│  └─ db/                # @archer/db — Supabase migrations + generated types (the contract)
├─ infra/
│  ├─ komodo/            # GitOps runtime definitions (Komodo)
│  └─ observability/     # Uptime Kuma + dead-man's-switch
├─ docs/                 # architecture + CI/CD design
└─ .github/workflows/    # CI · release · canary · codeql · dependency-review
```

## Quickstart

Prereqs: Node ≥ 20 (`.nvmrc` → 22), pnpm 10, Docker (for the DB drift gate).

```sh
pnpm install            # also wires the Husky hooks
pnpm dev                # (per service) e.g. pnpm --filter @archer/api dev
pnpm typecheck          # tsc across the workspace
pnpm test               # Vitest
pnpm lint               # Biome (use lint:fix to autofix)
pnpm build              # tsc build, topological
```

## Database (the contract)

The Postgres schema in `packages/db/supabase/migrations` is the cross-language
contract. After changing a migration, regenerate the TypeScript types:

```sh
pnpm db:gen             # apply migrations to an ephemeral Postgres, regenerate types
```

CI runs `pnpm --filter @archer/db db:gen:check` and **fails if the committed types
are stale** — keeping TypeScript (and, later, Python) honest to the schema.

## CI/CD

GitHub Actions builds, tests, and signs; Komodo deploys. On a PR the gates run
(lint · typecheck · test · drift · security · image build). On merge to `main`,
`release.yml` builds + cosign-signs images to GHCR and — behind a manual approval —
tells Komodo to redeploy. Full design: [`docs/Archer-CICD-Pipeline-Vision-v0.2.md`](./docs/Archer-CICD-Pipeline-Vision-v0.2.md).

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the day-to-day workflow.
