# Archer

An event-driven job-application platform where **the database is the source of truth
and the orchestrator**, and stateless Claude agents do the work. See
[`VISION.md`](./docs/VISION.md) and the foundation docs in [`docs/`](./docs).

## Monorepo layout

```
archer/
├─ apps/
│  └─ agent/             # Obsidian vault — Archer's system prompts & memory (front-ends to come)
├─ services/
│  ├─ api/               # @archer/api — Hono API (deployable)
│  ├─ cli/               # @archer/cli — Archer's CLI (deployable; → Python/Patchwright)
│  └─ scheduler/         # @archer/scheduler — SQLite-backed tick: runs `claude -p` on an interval
├─ packages/
│  └─ db/                # @archer/db — Supabase migrations + generated types (the contract)
├─ infra/
│  ├─ komodo/            # GitOps runtime definitions (Komodo)
│  └─ observability/     # Uptime Kuma + dead-man's-switch
├─ docs/                 # VISION · architecture · CI/CD design
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

## Scheduler (the tick)

`@archer/scheduler` is a long-running process that, on a configurable interval
(default **30 minutes**), runs a configurable shell command — by default
`claude -p "@./services/scheduler/prompt.md"`, feeding the tracked prompt file to
Claude. Config and run history live in a local SQLite DB (`SCHEDULER_DB_PATH`,
default `services/scheduler/scheduler.db`). Each tick re-reads the config, so
changes take effect on the next cycle without a restart.

```sh
pnpm --filter @archer/scheduler build
pnpm --filter @archer/scheduler start          # run the daemon

# Configure it (writes to the SQLite DB):
node services/scheduler/dist/cli.js status
node services/scheduler/dist/cli.js set-interval 30
node services/scheduler/dist/cli.js set-command 'claude -p "@./services/scheduler/prompt.md"'
node services/scheduler/dist/cli.js disable     # / enable
node services/scheduler/dist/cli.js runs        # recent run history
```

Edit `services/scheduler/prompt.md` to change what Archer does each tick. Design:
[`docs/superpowers/specs/2026-06-20-scheduler-design.md`](./docs/superpowers/specs/2026-06-20-scheduler-design.md).

## CI/CD

GitHub Actions builds, tests, and signs; Komodo deploys. On a PR the gates run
(lint · typecheck · test · drift · security · image build). On merge to `main`,
`release.yml` builds + cosign-signs images to GHCR and — behind a manual approval —
tells Komodo to redeploy. Full design: [`docs/Archer-CICD-Pipeline-Vision-v0.2.md`](./docs/Archer-CICD-Pipeline-Vision-v0.2.md).

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the day-to-day workflow.
