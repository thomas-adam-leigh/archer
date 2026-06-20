# @archer/api — AG-UI interaction substrate

The fail-closed Hono service every Archer client plugs into over one contract:
[AG-UI](../../docs/docs/ag-ui/). It opens runs, drives the deterministic stubbed
agent through the full run lifecycle, persists the ordered event log, and serves
history restore. The run loop is real; the brain is stubbed (`src/agui.ts`).

`AppType` (the chained Hono app type) is exported from `src/app.ts` and consumed
by the typed `hc<AppType>` client in `@archer/cli` (`services/cli/src/api.ts`).

## Auth

Every route except `/` and `/health` is fail-closed. Send the shared secret as
`x-archer-secret: $ARCHER_API_SECRET`. With no secret configured, routes are
denied unless `ARCHER_API_DEV_OPEN=1` (non-production only).

## Command triggers — the orchestrating agent's surface

The pipeline stages an external orchestrator (the scheduler/agent) pokes. Each is
fail-closed (see Auth) and follows the "API runs the CLI" model: the route shells
out to `@archer/cli` (browser work and the stubbed LinkedIn MCP + Firecrawl tool
calls stay isolated in the CLI process), parses its `--json`, and returns it. A
non-zero CLI exit surfaces as `502 { error, code }`.

| Trigger | Stage | Notes |
| --- | --- | --- |
| `POST /commands/collect/:board?user=<uuid>` | scrape a board → postings + `new` candidacies | `:board` is `^[a-z][a-z0-9_-]{0,63}$`; gated to an **accepted** account (`403` otherwise) |
| `POST /commands/match?user=<uuid>` | Matchmaker triages `new` candidacies → shortlisted / alternative_outreach / dismissed | idempotent no-op when nothing is `new`; gated to an accepted account |
| `POST /commands/enrich/:companyId` | Researcher enriches a shortlisted company → `enriched`, then advances its shortlisted / alternative_outreach candidacies → `awaiting_cover_letter` | `:companyId` is a uuid; **company-scoped, no user gate**; idempotent (an already-`enriched` company is a no-op); refused (`502`) unless a shortlisted candidacy sits behind the company |

`user` defaults to `ARCHER_USER_ID` when omitted. The collect → match → enrich
slice is locked end-to-end (no live browser/LLM/MCP) by
`services/cli/src/enrich-e2e.test.ts`, run against a migrated Postgres when
`TEST_DATABASE_URL` is set.

## `POST /agui/run` — run lifecycle

One endpoint, four outcomes, decided from the thread's open vs decided interrupts
(see `classifyRun` in `src/agui.ts`). Body is a `RunAgentInput`:

```jsonc
// Start a fresh run on a thread.
{ "threadId": "<uuid>" }

// Script the stub to pause for approval (interrupt outcome).
{ "threadId": "<uuid>", "forwardedProps": { "outcome": "interrupt" } }

// Resume: decide every open interrupt, approving with edited tool args.
// Opens a CHILD run (parent_run_id = the interrupted run).
{
  "threadId": "<uuid>",
  "resume": [
    {
      "interruptId": "<run>:int1",
      "status": "resolved",                 // or "cancelled" to reject
      "payload": { "approved": true, "editedArgs": { "to": "you@x.com" } }
    }
  ]
}
```

Outcomes:

| Situation | Response | HTTP |
| --- | --- | --- |
| Fresh run, no open interrupts | `{ threadId, runId, status, events }` | 200 |
| Resume covering all open interrupts | `{ threadId, runId, status, parentRunId, events }` | 200 |
| Resume referencing only already-decided interrupts | `{ threadId, status: "noop", replay: true }` | 200 |
| Contract violation (pending interrupts block new input; unknown interrupt; partial cover) | `{ threadId, runId, status: "error", error, events }` | 409 |

`status` is the run's terminal `run_status` (`completed` / `interrupted` /
`error`). An `interrupted` run finishes with `StateSnapshot` + `MessagesSnapshot`
then a `run_finished` whose `outcome.interrupts[]` carry an `id`, `reason`,
`toolCallId`, and a `responseSchema` (with `approved` + `editedArgs`). Each
interrupt is durably backed by a `proposals` row; the resume records the decision.

## `GET /agui/threads/:threadId/history` — history restore

Folds the thread's full ordered event log (across all its runs) into a snapshot a
reconnecting or brand-new client uses to rebuild the conversation identically to
what a live subscriber accumulated:

```jsonc
{ "threadId": "<uuid>", "state": { /* StateSnapshot */ },
  "messages": [ /* MessagesSnapshot */ ], "events": [ /* replayable log */ ] }
```

## Realtime fan-out (per-user channel)

Live updates ride **Supabase Realtime on the `events` table**, RLS-scoped per
user so a client receives only its own threads' events (a second user sees
nothing). See `packages/db/supabase/migrations/20260620130000_realtime_fanout.sql`.
The thread is the subscription unit; history restore (above) seeds a client that
missed events while disconnected, then live deltas continue on the channel.

## Proving it end-to-end

`services/cli/src/proof.test.ts` walks the whole flow over the typed `hc<AppType>`
client (start → interrupt → approve-with-edits resume → history restore →
idempotent replay), asserting the restored log equals the live one. It is
typechecked against `AppType` in CI (no contract drift) and runs against a
migrated Postgres when `TEST_DATABASE_URL` is set:

```sh
TEST_DATABASE_URL=postgres://… pnpm --filter @archer/cli test
```
