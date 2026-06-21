# Archer Backend & Client Integration Guide

This is the guide for building mobile and web clients against the Archer backend. Everything here is grounded in the code as it exists on `main` — migrations under `packages/db/supabase/migrations/`, the Hono API under `services/api/src/`, and the reference CLI consumer under `services/cli/src/`. Where the code and the intended design diverge, it is called out. Where something is not built, it says **not implemented** rather than inventing it.

Citations use `path:line` against the repo.

---

## 0. Orientation — the mental model

Three ideas carry the whole architecture:

1. **The database is the source of truth (and the contract).** Every durable fact lives in Postgres (Supabase). The generated TypeScript types (`packages/db/src/database.types.ts`) are the TypeScript projection of the migrations; Python services regenerate their own models from the same migrations (`packages/db/src/index.ts:1-8`). If you want to know what's real, read the schema.

2. **AG-UI is the one conversation contract.** Agent interaction is modelled on the AG-UI protocol (vendored docs under `docs/docs/ag-ui/`). A *run* is opened, it emits an **ordered, append-only event log** (`RunStarted → text/tool-call/state events → RunFinished`), and that log — persisted in the `events` table — is the replayable source of truth for a conversation. A client renders by folding that event stream; it reconnects by replaying it.

3. **Clients are thin: render-state + dispatch-actions.** A client does two things — render the state it reads (directly from Supabase under RLS, or from API read endpoints) and dispatch actions (POST to the API). It holds no business logic. The status machines, gates, and orchestration all live server-side.

### Two ways a client reaches data

- **Direct Supabase reads under RLS** — a client authenticated with a Supabase JWT can `select` its own rows directly (PostgREST / supabase-js), and subscribe to Realtime. RLS guarantees it only ever sees its own data. Clients **cannot write** the agent-owned tables directly — those writes are service-role only.
- **Through the Hono API** — all *actions* (run an agent, transition a candidacy, submit a profile version, decide a proposal) go through the API, which holds the service-role DB connection and enforces the gates.

> The service-role DB client (`packages/db/src/client.ts`) connects via the Supabase pooler and **bypasses RLS**. It is used by the API, CLI, and agents — never shipped to a client. "Clients (mobile/admin) talk to Supabase/PostgREST directly instead" (`client.ts:5-7`).

### Stubbed vs real — the seams

The **run loop, the brain, and STT are now real; the remaining outside-world I/O is stubbed.** Each stub is a deliberate, swappable seam (a typed interface + a deterministic stand-in), not a missing feature:

| Seam | What's real today | What's stubbed |
|---|---|---|
| **Agent brain** (Guide/Scribe/Matchmaker) | The run lifecycle, event ordering, persistence, interrupt/resume contract — **plus a real, swappable LLM** behind every call-site (`packages/llm`, default MiniMax M3; OpenRouter BYOK swap). The brain (`services/api/src/brain.ts`), Matchmaker judge (`commands/match.ts` `createLlmJudge`), and Scribe (`services/api/src/scribe.ts`) all call it | Nothing in the path — but a deterministic stub stays **injectable for tests** (`setBrain`/`setScribe`, `stubJudge`, or `LLM_PROVIDER=mock`) so CI never calls a live model |
| **STT** (voicenote → transcript) | **Real** ElevenLabs Scribe via a Supabase Edge Function (`packages/db/supabase/functions/transcribe/`); the ingest path, `transcribe` Activity, transcript-message persistence. **Audio is never persisted** | Nothing — the edge function's core is unit-tested with a mocked fetch (CI never calls ElevenLabs) |
| **Browser automation** (board collect / apply / external-form fill) | The Activity orchestration, status machine, idempotency, notifications | The actual Patchright/Chrome-DevTools scraping & form-filling (`services/cli/src/adapters/careerjunction.ts` throws `NotIntegratedError`; `commands/apply.ts` `stubApplier`; `commands/external-fill.ts` `stubFiller`) |
| **Company enrichment** (LinkedIn MCP + Firecrawl) | The enrich Activity, the writes into `companies`, the candidacy gate | The research tools (`commands/enrich.ts` `stubEnricher`) |
| **TTS** (cover-letter → spoken note) | The `spoken_note` Activity, artifact recorded on the version | The ElevenLabs synthesis (`services/api/src/tts.ts` `stubSynthesizer`) |
| **Resume/portfolio extraction** | The proposed-version path, `proposal_exec` Activity | The file → structured-content extraction (`services/api/src/ingest.ts` `stubResumeExtractor`) |

Every remaining stub is deterministic and pure, so the full end-to-end paths run and are tested offline. A client author can treat these paths as working — the data they produce is real, the content is canned. See `docs/SECURITY-OPS-RUNBOOK.md` §5–§6 for the STT flow and the LLM provider switch.

---

## 1. Auth & session

### Identity

Auth is **Supabase Auth**. On signup, a Postgres trigger (`handle_new_user`) provisions:
- a `public.users` row mirroring `auth.users` (id, email, full_name, avatar_url) — `20260614125512_create_users.sql`, `20260614173525_add_email_to_users.sql`;
- the user's **first `threads` row** in the same transaction, so the moment a user authenticates they have a conversation to subscribe to (`20260620120000_bootstrap_first_thread.sql:24-26`).

The `auth.users` → `public.users` provisioning is `SECURITY DEFINER`. An `accounts` row (the membership gate) is **not** provisioned at signup — it's created just-in-time on first `/accounts/submit` and defaults to `onboarding` for any user without a row (`20260620170000_acceptance_gate.sql:33-46`).

### How RLS scopes everything

Every user-owned table has RLS enabled with an "own rows only" read policy keyed on `(select auth.uid()) = user_id`. Child tables of a thread (`runs`, `events`, `messages`, `thread_state`) key through the owning thread via an `exists (... where t.user_id = auth.uid())` subquery (`20260620090000_archer_interaction.sql:143-181`). The JWT carries `auth.uid()`; Supabase evaluates the policy per request and per Realtime message. A second user sees nothing of yours — including over Realtime — with no extra plumbing (`20260620130000_realtime_fanout.sql:5-11`).

### Establishing a session

1. Client signs in with supabase-js → receives a JWT.
2. Client may now **read directly**: its `users`, `profiles`, `threads`, `runs`, `events`, `messages`, `thread_state`, `candidacies`, `target_titles`, `negative_criteria`, `notifications`, `activities`, `accounts`, profile-spine tables, `cover_letter_versions`, `external_application_forms`, plus the **shared objective** tables (`boards`, `companies`, `contacts`, `postings`) which are readable by *any* authenticated user.
3. Client **subscribes** to Realtime on the `events` table filtered to its thread(s).
4. For any **action**, the client calls the Hono API.

> ⚠️ **API auth today is a shared secret, not the user's JWT.** Every API route calls `authorized(c)` (`app.ts:93-97`), which checks a constant `x-archer-secret` header against `ARCHER_API_SECRET` (or, in non-prod with `ARCHER_API_DEV_OPEN=1`, allows open). The API does **not** verify the Supabase JWT, and it trusts a `user`/`userId` parameter from the caller to scope user data. This is an internal/trusted-caller posture: the API is currently designed to sit behind a trusted gateway (or be driven by the CLI / cron), **not** to be called directly by an untrusted mobile client. A real client deployment needs a JWT-verifying layer in front that maps `auth.uid()` to the `user` parameter. See §10.

---

## 2. Backend tables reference

Legend for "client touch": **R(direct)** = client can `select` under RLS; **API** = mutated only through the API (service role); **shared** = any authenticated user can read.

### Identity & membership

| Table | Purpose | Key columns / enums | Relationships | RLS | Client touch |
|---|---|---|---|---|---|
| `users` | Identity mirror of `auth.users` | `id` (PK = auth uid), `email`, `full_name`, `avatar_url` | root of all user-owned FKs | read/update own | R(direct) read; profile bits via API |
| `accounts` | Membership gate lifecycle | `status` enum `account_status` = `onboarding\|submitted\|under_review\|accepted\|rejected`; `submitted_at`, `reviewed_at`, `review_note` | 1:1 `users` | read own; **no client write** | R(direct); writes via `/accounts/*` |

### Conversation spine (AG-UI)

| Table | Purpose | Key columns / enums | Relationships | RLS | Client touch |
|---|---|---|---|---|---|
| `threads` | One per-user conversation; the subscription unit | `id`, `user_id`, `title` | parent of runs/events/messages/thread_state | read own | R(direct); created by signup trigger |
| `thread_state` | The thread's shared state object (1:1) | `state` jsonb (StateSnapshot / JSON-Patch target) | 1:1 `threads` | read own (via thread) | R(direct). **Note:** the live run loop does not write this table — see §3/§10 |
| `runs` | One AG-UI run per row | `status` enum `run_status` = `running\|completed\|interrupted\|error`; `parent_run_id` (resume lineage); `input`, `outcome`, `error` | self-ref `parent_run_id`; → `threads` | read own (via thread) | R(direct); created by API |
| `events` | Ordered append-only AG-UI event log (source of truth) | `seq` (per-run monotonic; `(run_id,seq)` unique); `type` enum `event_type`; `data` jsonb | → `runs`, `threads` | read own (via thread) | **R(direct) + Realtime**; written by API |
| `messages` | Chat turns incl. activity/reasoning roles (tier-2 corpus) | `role` enum `message_role`; `content`, `name`, `tool_call_id`, `tool_calls` | → `threads`, `runs` (nullable) | read own (via thread) | R(direct); FTS index on `content` (`20260620140000`) |

### Profile (structured spine + versioned history)

| Table | Purpose | Key columns / enums | Relationships | RLS | Client touch |
|---|---|---|---|---|---|
| `profiles` | The flat live profile + live `attributes` jsonb | `about`, `location`, `willing_remote`, `work_pref` (`work_mode`), salaries, `resume_text`, `attributes` jsonb | 1:1 `users` | read/insert/update own | R(direct) + API |
| `profile_versions` | A whole submitted profile draft (the approvable unit) | `version_no` (per-user ordinal); `status` enum `profile_version_status` = `draft\|proposed\|approved\|rejected\|superseded`; `attributes`, `details` jsonb. **Partial unique index: ≤1 `approved` per user** | → `users` | read own; **no client write** | R(direct); written via API/proposals |
| `work_experiences`, `projects`, `certifications`, `courses`, `skills`, `education` | Spine items, one row per item | typed canonical cols + `details` jsonb; each carries both `user_id` (RLS) and `version_id` (version scoping) | → `users`, `profile_versions` | read own; **no client write** | R(direct). *No API write endpoints exist for these yet — see §10* |

The **live profile** = the spine rows of the `profile_versions` row whose `status='approved'`.

### Search / targeting

| Table | Purpose | Key columns | RLS | Client touch |
|---|---|---|---|---|
| `target_titles` | The 1–5 roles a user searches under (collect keys) | `title`, `is_active` | manage own (full RLS) | R(direct) + API `/titles` |
| `negative_criteria` | Explicit disqualifiers the Matchmaker reads | `text` | manage own (full RLS) | R(direct) + API `/criteria` |

> `target_titles` and `negative_criteria` are the only user-owned tables with a **full** RLS policy (`for all`) — a client *could* write them directly under RLS. The API also exposes them; pick one path.

### Jobs pipeline

| Table | Purpose | Key columns / enums | Relationships | RLS | Client touch |
|---|---|---|---|---|---|
| `boards` | The 3 ZA job sites + adapter registry | `slug` (PK); `collect_status`, `apply_status` (`integration_status`); `cred_env_prefix` | parent of postings | read by any authenticated | shared read |
| `companies` | Employers | `status` enum `company_status` = `new\|researching\|enriched\|enrichment_failed`; `enrichment` jsonb; promoted cols (domain/website/recruitment_email…) | parent of contacts/postings | read by any authenticated | shared read; written by enrich |
| `contacts` | People at a company (no phone by design) | `full_name`, `email`, `linkedin_url`, `role_title` | → `companies` | read by any authenticated | shared read |
| `postings` | One deduped job ad | `board_slug`, `url`, `title`, `work_mode`; unique `(board_slug,url)` and `(board_slug,external_id)` | → `boards`, `companies` | read by any authenticated | shared read; written by collect |
| `candidacies` | A user pursuing a posting (the jobs kanban) | `status` enum `candidacy_status` (12 values); `triage_decision`, `triage_reason`, `match_score`; unique `(user_id,posting_id)` | → `users`, `postings` | read **and update** own | R(direct); transitions via API |

> `candidacies` has a client `update` policy, but moves should go through the API's guarded `transitionCandidacy` (the status machine, §6/§8) — a raw direct update would bypass the legality check.

### Execution & control

| Table | Purpose | Key columns / enums | RLS | Client touch |
|---|---|---|---|---|
| `activities` | The universal run primitive — every unit of work | `type` enum `activity_type` (11 values incl. `collect`, `match`, `enrich`, `cover_letter`, `apply`, `external_fill`, `proposal_exec`, `cli_repair`, `deploy`, `transcribe`, `spoken_note`); `status` (`activity_status`); `detail`, `error` jsonb; typed nullable subject FKs | read own (rows with your `user_id`) | R(direct) + API `/activities`. System rows (`user_id` null, e.g. `deploy`) are admin-only |
| `proposals` | The agent→owner control channel (also backs AG-UI interrupts) | `kind`, `title`, `rationale`, `plan` jsonb, `status` enum `proposal_status`; `decided_at`, `decision_note` | **RLS on, no authenticated policy** → service-role only | **Not directly readable by clients.** Surfaced through API responses |
| `notifications` | Per-user pushes (cover-letter ready, apply result…) | `kind`, `title`, `body`, `ref` jsonb, `read_at` | read/update own | R(direct) — render the inbox here |

### Applications

| Table | Purpose | Key columns / enums | RLS | Client touch |
|---|---|---|---|---|
| `cover_letter_versions` | Versioned cover-letter history per candidacy | `version_no` (per-candidacy); `status` enum `cover_letter_version_status` (`draft\|proposed\|approved\|rejected\|superseded`); `content`, `details` jsonb. **Partial unique: ≤1 `approved` per candidacy** | read own; **no client write** | R(direct); written via API/proposals |
| `external_application_forms` | The off-board redirect record | `status` enum `external_form_status` = `pending\|in_progress\|completed\|failed`; `url`, `detail`, `error`. **Partial unique: ≤1 open per candidacy** | read own; **no client write** | R(direct) |

**`proposals` is the one user-relevant table a client cannot read directly** (no authenticated RLS policy). Interrupt/proposal info reaches the client only through the API run response and the `notifications` table. See §10.

---

## 3. The AG-UI contract

All agent interaction goes through **`POST /agui/run`**. The run loop is real, and the conversational reply is now produced by a **real, swappable LLM** (`services/api/src/brain.ts` → `packages/llm`; default MiniMax M3, OpenRouter BYOK swap). A deterministic stub stays injectable for tests (`setBrain`, or `LLM_PROVIDER=mock`), so the event ordering below is identical whether a live model or the stub produced the text. See `docs/SECURITY-OPS-RUNBOOK.md` §6.

### `RunAgentInput` (request body)

The slice the backend consumes (`agui.ts:28-35`):

```ts
{
  threadId: string;            // required, must be a uuid
  runId?: string;
  messages?: { role: string; content?: string }[];
  state?: Json;
  resume?: { interruptId: string; status: "resolved" | "cancelled"; payload?: Json }[];
  forwardedProps?: { outcome?: "success" | "interrupt" } & Record<string, Json>;
}
```

> `forwardedProps.outcome` is the **stub's scripted-outcome hint**: `"interrupt"` makes the stub propose a tool call that needs approval and end on an interrupt; otherwise it completes. This is a stub affordance — a real brain decides on its own.

### The event stream out

A run returns its **full event log** in the JSON response `events` array (this is *not* an SSE/streaming endpoint today — the run executes synchronously and the whole bounded log comes back at once; live delivery to other subscribers is via Realtime, §4). Every run is bounded by `run_started … run_finished` (or `run_error`).

A fresh non-interrupt run emits (`agui.ts:76-89`):

```
run_started → step_started → text_message_start → text_message_content
→ text_message_end → state_snapshot → step_finished → run_finished{outcome:success}
```

An interrupt run additionally emits a `tool_call_start/args/end` triplet, then `state_snapshot` + `messages_snapshot`, then `run_finished{outcome:interrupt, interrupts:[…]}` (`agui.ts:91-157`).

### How a client renders each event type

The reference projection is `restoreThread` (`agui.ts:706-746`) — a client should fold the live stream the same way:

| Event type | Client action |
|---|---|
| `run_started` / `run_finished` / `step_started` / `step_finished` | Lifecycle markers; show run state. `run_finished.data.outcome.type` is `success` or `interrupt` |
| `run_error` | The run was rejected (contract violation); show `data.message` |
| `text_message_start` | Materialize an empty message (`messageId`, `role`) |
| `text_message_content` | Append `data.delta` to that message's content |
| `text_message_end` | Finalize the message |
| `tool_call_start` / `tool_call_args` / `tool_call_end` | The agent is proposing/calling a tool (`toolCallName`, args delta JSON) |
| `tool_call_result` | A tool's result (`{status:"executed"\|"skipped", args}`) |
| `state_snapshot` | **Replace** shared state with `data.snapshot` |
| `state_delta` | Apply the RFC-6902 JSON-Patch ops in `data.delta` to current state |
| `messages_snapshot` | Authoritatively **replace** the message list with `data.messages` |

`tool_call_chunk`, `text_message_chunk`, `activity_*`, `reasoning_*`, `raw`, `custom` are in the enum vocabulary but the stub does not emit them yet.

### Shared state (StateSnapshot + JSON-Patch deltas)

State is transported the AG-UI way: a `state_snapshot` sets the whole object, and `state_delta` layers JSON-Patch (add/replace/remove) ops onto it (`agui.ts:662-691` is the reference applier; it's lenient by design — missing intermediate objects are created, a delta never throws). Onboarding accretes a draft field-by-field with deltas (`agui.ts:247-287`); the Scribe writes the letter into `state.draft.content` with one delta (`agui.ts:359-392`).

> The folded state lives in the **event log**, not in `thread_state`. The `thread_state` table exists but the run loop never writes it (see §10). To know "current shared state," fold the events (or call history restore).

### The interrupt → approve/reject/edit → resume cycle

This is the core human-in-the-loop primitive, enforced purely from the thread's interrupt state by `classifyRun` (`agui.ts:582-619`) and applied by the route (`app.ts:248-321`):

1. **A run ends on an interrupt.** `run_finished.outcome` is `{type:"interrupt", interrupts:[{ id, reason:"tool_call", action, message, toolCallId, responseSchema }]}`. The `responseSchema` is JSON-Schema: `{ approved: boolean (required), editedArgs?: object }` — `editedArgs` is a **full replacement** of the tool args, not a merge (`agui.ts:141-152`).
2. **The interrupt is durably backed by a `proposals` row** (`kind` carries the interrupt linkage), `status='submitted'` (`app.ts:307-319`). This is what the next run is classified against.
3. **The client resolves it** by POSTing `/agui/run` again with `resume: [{ interruptId, status:"resolved", payload:{ approved: true|false, editedArgs? }}]`.
4. **A resume opens a CHILD run** whose `parent_run_id` is the interrupted run (`app.ts:272-298`). The continuation records each decision on its proposal (approved → `proposals.status='approved'`, else `'rejected'`) and emits a `tool_call_result` (executed-with-edited-args, or skipped), a confirming text message, and `run_finished{success}` (`agui.ts:168-203`).

**The four contract rules** (`classifyRun`, `agui.ts:570-619`):

| Situation | Result |
|---|---|
| Non-resume request while interrupts are open | `RunError` — *"pending interrupts must be resolved before new input"* (HTTP **409**, a bounded persisted error run) |
| Resume referencing an interrupt unknown to this thread | `RunError` — *"unknown interrupt: …"* (cross-thread protection) |
| Resume that resolves *some but not all* open interrupts | `RunError` — *"resume must cover all open interrupts"* |
| Resume referencing only already-decided interrupts | **`noop` replay** — `{ status:"noop", replay:true }`, idempotent, no new run |

### History restore

**`GET /agui/threads/:threadId/history`** (`app.ts:328-335`) folds the thread's whole persisted event log into `{ threadId, state, messages, events }` — a StateSnapshot + MessagesSnapshot + the replayable log. A reconnecting or brand-new client rebuilds the conversation **identically** to what a live subscriber accumulated. The proof test asserts `restored.events == live run1 ++ live run2` and `state == {phase:"completed"}` (`proof.test.ts:146-156`).

---

## 4. Realtime

The `events` table is added to the `supabase_realtime` publication (`20260620130000_realtime_fanout.sql:29`). Every inserted event fans out to subscribers as a Postgres Changes INSERT message. Realtime authorizes each subscriber against the table's RLS, so **a client receives only events on threads it owns** — per-user isolation, no extra server code.

Subscribe per thread (the documented pattern, `20260620130000_realtime_fanout.sql:12-15`):

```js
supabase.channel('thread:<id>')
  .on('postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'events', filter: 'thread_id=eq.<id>' },
    handler)
  .subscribe()
```

**What fans out:** only `events`. `notifications`, `candidacies`, `activities`, etc. are **not** in the publication — a client polls those (or adds them to the publication itself; not done in code). The jobs feed and activity feed are poll-based reads today (`app.ts:170-207`).

**Reconcile live vs restored:** on connect, call history restore to seed state + messages, then apply incoming Realtime `events` by `seq` order onto the same projection. Because the live fold and the restored fold are the same function, they converge. `(run_id, seq)` uniqueness lets you dedupe/order deterministically.

---

## 5. The typed client

The client is `hc<AppType>` from `hono/client`, where `AppType = typeof app` is exported from the API (`app.ts:919`). The CLI builds it once (`services/cli/src/api.ts:21-27`):

```ts
import type { AppType } from "@archer/api";
import { hc } from "hono/client";

export function createApiClient(opts = {}) {
  const { baseUrl = process.env.ARCHER_API_URL ?? "http://localhost:3000", fetch } = opts;
  return hc<AppType>(baseUrl, fetch ? { fetch } : undefined);
}
```

This gives a fully typed RPC surface: `client.agui.run.$post({ json })`, `client.jobs.$get({ query })`, `client.agui.threads[":threadId"].history.$get({ param })`, etc. The types come straight from the route definitions, so **the client cannot drift from the API** — CI typechecks it even when the DB-backed runtime test is skipped (`proof.test.ts:11-18`).

### The copy-pasteable reference flow

`services/cli/src/proof.test.ts` is the canonical end-to-end consumer. It walks the AG-UI capstone over the same `hc<AppType>` client (mounted in-process via `fetch: app.request`):

1. **Fresh interrupt run** — `client.agui.run.$post({ json: { threadId, forwardedProps:{ outcome:"interrupt" }}})` → `status:"interrupted"`, events contain `state_snapshot` + `messages_snapshot`, terminal `run_finished` carries the `responseSchema` with `approved` + `editedArgs`. A `submitted` proposal now exists (`proof.test.ts:74-104`).
2. **Approve-with-edits resume** — `$post({ json: { threadId, resume:[{ interruptId, status:"resolved", payload:{ approved:true, editedArgs }}]}})` → child run (`parentRunId == run1.runId`), `status:"completed"`, the `tool_call_result` carries the **edited** args, the proposal is now `approved` (`proof.test.ts:106-141`).
3. **History restore** — `client.agui.threads[":threadId"].history.$get({ param:{ threadId }})` → restored events equal live run1 ++ run2; restored messages contain both turns (`proof.test.ts:143-156`).
4. **Idempotent replay** — resubmitting the same decision → `{ status:"noop" }` (`proof.test.ts:158-167`).

To run it against a real DB: set `TEST_DATABASE_URL`, then `pnpm --filter @archer/cli test`. Skipped otherwise.

---

## 6. User journeys → sequence diagrams

Each diagram shows: client action → API → events/DB → what the user sees. These are the flows that actually exist in the code.

### 6.1 Signup → onboard → submit profile version → approve

```mermaid
sequenceDiagram
  actor U as User
  participant SB as Supabase Auth
  participant DB as Postgres (triggers)
  participant API as Hono API
  participant Cl as Client

  U->>SB: sign up
  SB->>DB: insert auth.users
  DB->>DB: handle_new_user → users row + first threads row
  Cl->>API: POST /onboarding/state?user=U
  API-->>Cl: { onboarding: true, liveVersionId: null }
  Cl->>API: POST /onboarding/run { threadId, draft? }
  API->>DB: createRun + onboardingRun events (snapshot + deltas)
  API->>DB: createProfileVersion(proposed) + submitVersionProposal
  API-->>Cl: { runId, versionId, proposalId, attributes, events }
  Note over Cl,U: client folds events → shows assembled draft profile
  U->>Cl: review & approve
  Cl->>API: POST /onboarding/proposals/:proposalId/decide { action:"approve", edits? }
  API->>DB: applyVersionProposal → supersede prior live, approve target, sync profiles.attributes
  API-->>Cl: { proposalStatus:"completed", versionStatus:"approved" }
  Note over Cl,U: liveVersionId now set; user is out of onboarding
```

Non-conversational variant: `POST /profile/versions` (draft) → `POST /profile/versions/:id/submit` → same `/onboarding/proposals/:id/decide` decision route. `applyVersionProposal` (`queries.ts:947-1019`) supersedes the prior `approved` version and re-syncs `profiles.attributes` in one transaction; it is idempotent (a replayed decide returns the already-decided outcome).

### 6.2 Run → interrupt → resume (the AG-UI capstone)

```mermaid
sequenceDiagram
  actor U as User
  participant Cl as Client
  participant API as Hono API
  participant DB as Postgres
  participant RT as Realtime

  Cl->>API: POST /agui/run { threadId, forwardedProps:{outcome:"interrupt"} }
  API->>DB: createRun + append events + createInterruptProposal(submitted) + finishRun(interrupted)
  DB-->>RT: events INSERT (fan out)
  API-->>Cl: { status:"interrupted", events:[…run_finished{interrupt, responseSchema}] }
  Note over Cl,U: client renders the approval card (action, message, schema)
  U->>Cl: approve (optionally edit args)
  Cl->>API: POST /agui/run { threadId, resume:[{interruptId,status:"resolved",payload:{approved,editedArgs}}] }
  API->>DB: classifyRun→resume; decideInterruptProposal(approved); child run; tool_call_result + text; finishRun(completed)
  API-->>Cl: { status:"completed", parentRunId, events }
  Note over Cl,U: "Done — I've sent it." ; proposal now approved
  Cl->>API: GET /agui/threads/:id/history
  API-->>Cl: { state, messages, events }  (== live run1 ++ run2)
```

A bad request — new input while an interrupt is open, an unknown interrupt, or a partial resume — comes back **409** with a persisted `run_error` event (`app.ts:254-262`).

### 6.3 Collect → match → enrich → cover-letter draft/revise/approve → apply

This is the full jobs pipeline. Collect/match/enrich/apply/external-fill run **the CLI as a subprocess** ("API runs the CLI", `cli.ts`); the cover-letter draft/submit runs are **AG-UI runs** in the API.

```mermaid
sequenceDiagram
  participant Cron as pg_cron
  participant API as Hono API
  participant CLI as Archer CLI (subprocess)
  participant DB as Postgres
  actor U as User
  participant Cl as Client

  Cron->>API: POST /commands/collect/:board (13:00 wkdays, per integrated board)
  API->>CLI: archer collect <board> --json
  CLI->>DB: collect Activity; upsert companies/postings; insert candidacies(status=new)
  Cron->>API: POST /commands/match (per-minute, only if `new` candidacies exist)
  API->>CLI: archer match --json
  CLI->>DB: match Activity; stubJudge → shortlisted | alternative_outreach | dismissed
  Note over DB: candidacy_external_form / cron triggers fire on state change
  Cl->>API: POST /commands/enrich/:companyId  (shortlisted company)
  API->>CLI: archer enrich <id> --json
  CLI->>DB: enrich Activity; companies→enriched; advance candidacies→awaiting_cover_letter; notify
  U->>Cl: open a candidacy ready for a cover letter
  Cl->>API: POST /cover-letters/run { threadId, candidacyId }
  API->>DB: scribeRun (draft in shared state); createCoverLetterVersion(proposed); candidacy→drafting
  Cl->>API: POST /cover-letters/submit { threadId, candidacyId }
  API->>DB: coverLetterSubmitRun (ends on interrupt); proposal(submitted); candidacy→in_review
  API-->>Cl: { interruptId, proposalId, events:[…interrupt] }
  U->>Cl: approve cover letter
  Cl->>API: POST /cover-letters/proposals/:proposalId/decide { action:"approve", edits? }
  API->>DB: applyCoverLetterVersionProposal → version approved (active); candidacy→approved
  Cl->>API: POST /commands/apply/:candidacyId
  API->>CLI: archer apply <candidacyId> --json
  CLI->>DB: apply Activity; candidacy→applying→ applied | external_pending | application_failed
  alt off-board redirect
    DB->>DB: candidacy→external_pending → trigger webhooks /hooks/external-form
    API->>CLI: archer external-fill <candidacyId> --json
    CLI->>DB: external_fill Activity; form pending→in_progress→completed; candidacy→applied
  end
```

Optional spoken note: `POST /cover-letters/spoken-note { threadId, versionId }` records a `spoken_note` Activity and writes the audio artifact ref onto the version's `details` (stubbed TTS, `app.ts:594-636`).

---

## 7. Screen → contract map

| Screen | Reads (direct RLS / API) | Actions (API) | Realtime / events |
|---|---|---|---|
| **Sign-up / welcome** | supabase-js auth; `GET /onboarding/state`, `GET /accounts/state` | supabase signup | — |
| **Agent chat** | `GET /agui/threads/:id/history`; `events` (direct) | `POST /agui/run` | `channel('thread:<id>')` on `events` |
| **Onboarding wizard** | `GET /profile`, `GET /profile/versions` | `POST /onboarding/run`, `POST /onboarding/resume`, `POST /onboarding/voicenote`, `POST /profile/versions[...]` | thread `events` |
| **Approvals inbox** | `notifications` (direct); proposal/interrupt info from the run response | `/onboarding/proposals/:id/decide`, `/cover-letters/proposals/:id/decide`, `/agui/run` (resume) | `notifications` polled |
| **Jobs feed / kanban** | `GET /jobs?user=&status=`; `candidacies`/`postings`/`companies` (direct) | `POST /commands/candidacies/:id/transition` | poll (not in Realtime) |
| **Cover-letter review** | `GET /agui/threads/:id/history`; `cover_letter_versions` (direct) | `/cover-letters/run`, `/cover-letters/submit`, `/cover-letters/proposals/:id/decide`, `/cover-letters/spoken-note` | thread `events` |
| **Profile / version timeline** | `GET /profile/versions`, `GET /profile/versions/:id`; spine tables (direct) | `/profile/versions/:id/submit`, `/profile/versions/:id/rollback` | — |
| **Activity / observability** | `GET /activities?user=&type=&status=`; `activities` (direct) | — | poll |
| **Targeting (titles/criteria)** | `GET /titles`, `GET /criteria` (or direct under full RLS) | `POST/DELETE /titles`, `POST/DELETE /criteria` | — |
| **Membership gate** | `GET /accounts/state` (status + readiness reasons) | `POST /accounts/submit` (owner: `/accounts/:id/decide`) | — |

---

## 8. Full API endpoint catalog

All routes require the `x-archer-secret` header (`ARCHER_API_SECRET`), or dev-open in non-prod. The **three owner-gated `/decide` routes** additionally require the `x-archer-admin-secret` header (`ARCHER_API_ADMIN_SECRET`) — they are flagged below. All take/return JSON. `user` defaults to `process.env.ARCHER_USER_ID` when omitted. Source: `services/api/src/app.ts` (now an `OpenAPIHono` app). The live, machine-readable spec is at **`GET /openapi.json`** and a self-hosted **Scalar** reference UI at **`GET /reference`** (`docs/SECURITY-OPS-RUNBOOK.md` §4); both declare the `serviceSecret`/`ownerSecret` schemes.

### Agent commands (API → CLI subprocess)

| Method | Path | Auth | Request | Response | Notes |
|---|---|---|---|---|---|
| POST | `/commands/collect/:board` | secret | `?user=` | CLI collect summary JSON | gated on `isAccepted(user)` → 403 if not accepted; board must match `^[a-z][a-z0-9_-]{0,63}$` |
| POST | `/commands/match` | secret | `?user=` | CLI match summary | accepted-gate 403; no-op if no `new` candidacies |
| POST | `/commands/enrich/:companyId` | secret | uuid path | CLI enrich summary | company-scoped, no user gate |
| POST | `/commands/apply/:candidacyId` | secret | uuid path | CLI apply summary | CLI gates on an approved cover letter |
| POST | `/hooks/external-form` | secret | `{ record:{ id } }` | `{ received, ref, result? }` **202** | fired by candidacy→`external_pending` trigger; never 5xxs |
| POST | `/hooks/activity-failed` | secret | activity record | `{ received }` **202** | TODO: wakes the Mechanic (`app.ts:912-917`) — **not implemented** |

### DB commands

| Method | Path | Request | Response | Notes |
|---|---|---|---|---|
| POST | `/commands/candidacies/:id/transition` | `{ to, reason? }` | `{ id, status }` | guarded by the status machine → **409** `IllegalCandidacyTransitionError`; 404 unknown |

### Reads

| Method | Path | Query | Response |
|---|---|---|---|
| GET | `/` | — | `{ name, status }` |
| GET | `/health` | — | `{ status:"ok" }` (no DB needed) |
| GET | `/openapi.json` | — | OpenAPI 3.0 document (generated; declares `serviceSecret`/`ownerSecret`) |
| GET | `/reference` | — | self-hosted Scalar API reference UI over `/openapi.json` |
| GET | `/jobs` | `user`, `status?` | `{ user, jobs:[CandidacyListItem] }` |
| GET | `/activities` | `user`, `type?`, `status?` | `{ user, activities:[…] }` |
| GET | `/onboarding/state` | `user` | `{ user, onboarding:boolean, liveVersionId }` |
| GET | `/accounts/state` | `user` | `{ user, status, readiness:{ ready, targetTitles, negativeCriteria, hasLiveProfile, reasons[] } }` |
| GET | `/profile` | `user` | `{ user, profile }` |
| GET | `/profile/versions` | `user` | `{ user, versions[], liveVersionId }` |
| GET | `/profile/versions/:id` | `user` | `{ user, version }` (404 if not owned) |
| GET | `/titles` | `user`, `all=1?` | `{ user, titles }` |
| GET | `/criteria` | `user` | `{ user, criteria }` |

### AG-UI

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/agui/run` | `RunAgentInput` (§3) | `{ threadId, runId, status, events }` — or `{ status:"noop", replay:true }`, or **409** `run_error` |
| GET | `/agui/threads/:threadId/history` | — | `{ threadId, state, messages, events }` |

### Onboarding & profile

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/onboarding/run` | `{ threadId, draft? }` | `{ runId, versionId, proposalId, attributes, events }` |
| POST | `/onboarding/proposals/:proposalId/decide` | `{ action:"approve"\|"reject", edits?, note? }` | `{ proposalStatus, versionStatus, error? }` — **owner-gated** (`x-archer-admin-secret`) |
| POST | `/onboarding/resume` | `{ userId, storageRef, filename?, kind?:"resume"\|"portfolio" }` | `{ user, kind, status:"proposed", versionId, proposalId, … }` — resume/portfolio ingest (stub extractor) |
| POST | `/onboarding/voicenote` | `{ threadId, transcript, provider?, filename? }` | `{ threadId, status:"transcribed", transcript, … }` — persists an already-transcribed note: `transcribe` Activity + transcript message. The client transcribes **first** via the `transcribe` Edge Function (real STT, audio never persisted — runbook §5); `provider` defaults to `"elevenlabs"` |
| POST | `/profile/versions` | `{ userId?, attributes?, label? }` | `{ versionId, status:"draft", version }` |
| POST | `/profile/versions/:id/submit` | `{ userId?, title? }` | `{ versionId, proposalId }` |
| POST | `/profile/versions/:id/rollback` | `{ userId? }` | `{ versionId, versionStatus, error? }` (**409** on bad target) |

### Cover letters

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/cover-letters/run` | `{ threadId, candidacyId, highlights? }` | `{ runId, versionId, versionStatus, content, events }` — Scribe draft; candidacy → `drafting`. **409** if candidacy not `awaiting_cover_letter`/`drafting`; **403** if not owned |
| POST | `/cover-letters/submit` | `{ threadId, candidacyId }` | `{ runId, versionId, proposalId, interruptId, events }` — ends on interrupt; candidacy → `in_review`. **409** if not `drafting` or no proposed draft |
| POST | `/cover-letters/proposals/:proposalId/decide` | `{ action:"approve"\|"reject", edits?, note? }` | `{ proposalStatus, … }` — **owner-gated** (`x-archer-admin-secret`); approve → version active + candidacy `approved`; reject → back to `drafting` |
| POST | `/cover-letters/spoken-note` | `{ threadId, versionId }` | `{ activityId, spokenNote:{ audioUrl, provider, durationMs } }` (stub TTS); **403** if not owned |

### Targeting & accounts

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/titles` | `{ userId?, title }` (≤256) | `{ user, title }` |
| DELETE | `/titles/:id` | — | `{ removed }` |
| POST | `/criteria` | `{ userId?, text }` (≤512) | `{ user, criterion }` |
| DELETE | `/criteria/:id` | — | `{ removed }` |
| POST | `/accounts/submit` | `{ userId? }` | `{ user, status }` — provisions row JIT |
| POST | `/accounts/:userId/decide` | `{ action:"review"\|"accept"\|"reject", note? }` | `{ user, status, readiness? }` — **owner-gated** (`x-archer-admin-secret`); **409** if refused. `accept` re-checks readiness atomically |

> Validation: every path/query id is checked against a UUID regex; bad input → **400**. Unknown candidacy/thread/version → **404**. Unauthorized → **401**.

---

## 9. Stubbed seams & what each needs to go live

| Seam | Interface in code | What's needed to go live |
|---|---|---|
| **Agent brain** ✅ *real* | `getBrain`/`llmBrain` (`brain.ts`), `getScribe`/`llmScribe` (`scribe.ts`), `createLlmJudge`/`resolveJudge` (`commands/match.ts`) → `packages/llm` | **Done.** Real, swappable LLM (MiniMax M3 default; OpenRouter BYOK). Stub stays injectable for tests. Keys in Supabase secrets (`MINIMAX_API_KEY`/`OPENROUTER_API_KEY`) |
| **STT (voicenote)** ✅ *real* | `transcribe` Edge Function (`packages/db/supabase/functions/transcribe/`) | **Done.** Real ElevenLabs Scribe; audio never persisted; `ELEVENLABS_API_KEY` in Supabase secrets |
| **Board collect** | `BoardAdapter.collect` (`adapters/types.ts`); `careerjunction` throws `NotIntegratedError` | Per-board Patchright/Chromium scraping via residential proxy + VNC; map selectors; then flip `boards.collect_status` to `integrated`. Creds: `<PREFIX>_EMAIL/_PASSWORD`, `DECODO_PROXY` |
| **Board apply** | `Applier`/`stubApplier` (`commands/apply.ts`) | Browser form-fill returning `submitted\|redirect\|failed`; same creds/proxy; flip `boards.apply_status` |
| **External-form fill** | `Filler`/`stubFiller` + `ArcherMcp` (`commands/external-fill.ts`, `archer-mcp.ts`) | Browser agent driving the off-site form, reading the candidate only through the least-privilege Archer MCP surface |
| **Company enrichment** | `Enricher`/`stubEnricher` (`commands/enrich.ts`) | LinkedIn MCP + Firecrawl calls; the writes into `companies`/`contacts` and the candidacy gate are already real |
| **TTS (spoken note)** | `Synthesizer`/`stubSynthesizer` (`tts.ts`) | ElevenLabs streaming audio into storage, returning the artifact ref |
| **Resume/portfolio extraction** | `ResumeExtractor`/`stubResumeExtractor` (`ingest.ts`) | CLI/parser that reads the uploaded file → structured `attributes`/`details` |
| **Event-engine webhooks** | `archer_event_post` + triggers/cron (`20260620180000_event_engine.sql`) | Set Vault secrets `archer_api_base_url` + `archer_api_secret` per environment; pg_cron fires in **UTC** (13:00 = 13:00 UTC — see the migration note) |

Each stub is a one-line swap at the call site behind a typed interface (`fixture`/mock injection points already exist for testing).

---

## 10. Gotchas & contract rules

**Auth posture (most important):** see `docs/SECURITY-OPS-RUNBOOK.md` for the operator-facing two-plane trust model, the fail-closed-in-prod startup invariant, and the network/deploy posture.
- The API authenticates with a **shared secret**, not the user's JWT, and **trusts the `user`/`userId` parameter** for data scoping (`authorized()` in `app.ts`; `/jobs`, `/profile`, etc.). A mobile client must not call this API directly with an attacker-controllable `user`. Put a JWT-verifying gateway in front that derives `user` from `auth.uid()`, or have clients use **direct Supabase reads** (RLS-safe) for reads and only proxy *actions* through a trusted server.
- For **direct reads**, RLS is solid and per-user. Prefer direct Supabase for all read screens (jobs, activities, notifications, profile, versions, cover letters) — RLS makes them safe by construction.

**RLS pitfalls:**
- `proposals` has **no authenticated read policy** — a client cannot see proposals/interrupts directly. Interrupt details arrive only in the `/agui/run` response; surface approvals via `notifications`.
- The **profile-spine tables and `cover_letter_versions`/`external_application_forms` are read-only to clients** (no write policy). Don't try to write them directly; use the API.
- `target_titles`, `negative_criteria`, and `candidacies` *do* have client write policies. Writing `candidacies.status` directly bypasses the legality machine — always use `/commands/candidacies/:id/transition`.

**Idempotency / replay:**
- AG-UI resume is idempotent — replaying a decided interrupt is a `noop`, not a new run (§3).
- `applyVersionProposal` / `applyCoverLetterVersionProposal` / `decideAccount` claim the proposal atomically; a concurrent or replayed decide returns the already-decided outcome rather than double-applying (`queries.ts:947-1019`).
- `collect`/`enrich`/`apply`/`external-fill`/`match` are each idempotent in their own way (no-op when already in the terminal/expected state; apply never re-fires). Postings dedupe on `(board_slug, url)`.
- The `events` table is append-only with a unique `(run_id, seq)` — use `seq` to order and dedupe Realtime deliveries.

**Contract rules a client author must honor:**
- Resolve **all** open interrupts before sending new input; otherwise the run is a 409 `run_error`.
- `editedArgs` in an interrupt response is a **full replacement**, not a merge.
- The candidacy status machine is strict (`candidacy-status.ts`): e.g. `new → applied` is rejected. Only offer transitions the machine allows. Terminal states: `dismissed`, `applied`, `application_failed`.
- Collect/match require `accounts.status='accepted'` — gate the relevant UI on `/accounts/state` (a non-accepted user gets 403).
- Acceptance requires **readiness**: 1–5 active target titles + ≥1 negative criterion + an approved profile version. The `readiness.reasons[]` array tells the user exactly what's missing.

**Known gaps / drift noticed while documenting (feed a separate review):**
- `thread_state` table is defined and RLS-readable, but **the run loop never writes it** — shared state lives only in the event log. A client relying on `thread_state` for "current state" will see an empty `{}`. Either wire the run loop to persist folded state there, or document it as event-log-only.
- Only `events` is in the Realtime publication — `notifications`/`candidacies`/`activities` updates are not pushed, so those screens must poll. Likely a gap vs. the intended "live feed."
- `/hooks/activity-failed` is a stub acknowledgment (TODO: wake the Mechanic) — failed activities are recorded but nothing reacts yet.
- The profile-spine item tables (`work_experiences`, `skills`, etc.) have no API write path; only the profile-wide `attributes` jsonb is assembled/approved today. Versioned spine items are schema-ready but not yet populated by any endpoint.
- Owner/human-decision routes are now gated behind a **separate admin secret** (`x-archer-admin-secret`, ARC-51) and the API **fails closed in production** if `ARCHER_API_SECRET` is unset (ARC-55). The remaining gap: the API still trusts the caller-supplied `user` for **read scoping** (no JWT verification), so it must stay behind a trusted gateway / not be exposed to untrusted clients directly (runbook §1–§3).
- pg_cron schedules fire in **UTC**; `0 13 * * 1-5` is 13:00 UTC, not 13:00 SAST as the surrounding "13:00 weekday" comments might imply (the migration flags this explicitly).
