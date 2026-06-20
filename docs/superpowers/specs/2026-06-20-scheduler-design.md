# `@archer/scheduler` — design

**Date:** 2026-06-20
**Status:** approved

## Problem

We need a self-contained scheduler that, on a configurable interval (default **30
minutes**), runs a configurable shell command — by default
`claude -p "@./services/scheduler/prompt.md"` — and keeps an audit trail of every
run. The interval and the command must be settable without editing code, and changes
should take effect without re-installing anything.

The prompt itself lives in a tracked markdown file (`services/scheduler/prompt.md`)
that the default command references via Claude's `@file` syntax, so the operator
edits *what the tick does* by editing the markdown, not by re-quoting a shell string.

This is the recurring "tick" for the autonomous Archer agent: a heartbeat that wakes
`claude -p` on a schedule the operator controls.

## Scope

In scope:

- A SQLite database holding the schedule config and a run-history log.
- A long-running Node process that fires the command on the interval.
- A small CLI to **set** the interval / command / enabled flag and inspect runs.

Explicitly out of scope (YAGNI):

- No Postgres/Supabase integration — SQLite is deliberate and local.
- No web UI.
- No OS-level crontab. The interval lives in the DB and is honoured by the loop, so
  a static `*/30` crontab line would contradict "an interval I can change in the DB".

## Placement

A new deployable workspace `services/scheduler` (`@archer/scheduler`), alongside
`services/api` and `services/cli`. Matches the existing `services/*` deployable
pattern: own `package.json`, `tsconfig.json`, `Dockerfile`, in-package tests.

## Data model (SQLite, `better-sqlite3`)

Schema is created idempotently (`CREATE TABLE IF NOT EXISTS`) and the single config
row is seeded on first open.

`schedule` — one config row, `id = 1`:

| column             | type    | notes                                   |
| ------------------ | ------- | --------------------------------------- |
| `id`               | INTEGER | PRIMARY KEY, `CHECK (id = 1)`           |
| `interval_minutes` | INTEGER | NOT NULL, default `30`                  |
| `command`          | TEXT    | NOT NULL, default `claude -p "@./services/scheduler/prompt.md"` |
| `enabled`          | INTEGER | NOT NULL, default `1` (0/1 boolean)     |
| `updated_at`       | TEXT    | ISO timestamp                           |

`runs` — append-only audit log:

| column        | type    | notes                          |
| ------------- | ------- | ------------------------------ |
| `id`          | INTEGER | PRIMARY KEY AUTOINCREMENT      |
| `command`     | TEXT    | the command as actually run    |
| `started_at`  | TEXT    | ISO timestamp                  |
| `finished_at` | TEXT    | ISO timestamp, null while running |
| `exit_code`   | INTEGER | null while running             |
| `stdout`      | TEXT    | captured stdout                |
| `stderr`      | TEXT    | captured stderr                |

DB file path comes from `SCHEDULER_DB_PATH` (default `services/scheduler/scheduler.db`,
gitignored).

## Units

Each unit is small and independently testable.

1. **`db.ts`** — open + migrate + seed SQLite. Typed accessors: `getSchedule()`,
   `setSchedule(partial)`, `startRun(command)` → run id, `finishRun(id, result)`,
   `listRuns(limit)`. No scheduling or process logic here.

2. **`runner.ts`** — `runCommand(cmd): Promise<RunResult>` via
   `spawn("sh", ["-c", cmd])`, capturing `{ code, stdout, stderr }`. Mirrors the
   existing `services/api/src/cli.ts` `runCli` pattern. This is what executes "a bash
   command". Pure with respect to the DB.

3. **`scheduler.ts`** — the loop. A recursive `setTimeout` (not `setInterval`):
   each tick re-reads `getSchedule()`, and if `enabled` runs the command via the
   injected runner, recording the run via the db. Then it sleeps `interval_minutes`.
   Re-reading every tick means interval/command edits take effect live, and runs
   never overlap. The clock (`setTimeout`), runner, and db are injectable so the loop
   is testable without real time or real subprocesses.

4. **`index.ts`** — entrypoint: open the db, start the loop, log, and shut down
   cleanly on SIGINT/SIGTERM.

5. **`cli.ts`** (+ `bin: archer-scheduler`) — the operator's "set" surface, built on
   `commander` (already used by `services/cli`): `status`, `set-interval <minutes>`,
   `set-command <string>`, `enable`, `disable`, `runs [--limit n]`.

## Testing (TDD)

- `runner.test.ts` — `echo hello` → code 0, stdout `hello`; `exit 3` → code 3;
  stderr captured. Mirrors `cli.test.ts` style.
- `db.test.ts` — fresh temp db seeds interval 30 + default command; `setSchedule`
  updates; `startRun`/`finishRun`/`listRuns` round-trip.
- `scheduler.test.ts` — next-delay is derived from `interval_minutes`; one tick with
  an injected fake clock + runner invokes the runner with the configured command and
  records a run; a disabled schedule does not run the command.

## Env contract additions (`.env.example`)

```
# --- services/scheduler ---
SCHEDULER_DB_PATH=services/scheduler/scheduler.db
```
