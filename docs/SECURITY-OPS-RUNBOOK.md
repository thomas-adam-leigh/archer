# Archer Security & Ops Runbook

Operator-facing security and operational notes for the Archer backend. Grounded in
the code on `main`; citations use `path:line`. This runbook is seeded by the
trust-model hardening work (ARC-55) and is rounded out (OpenAPI/Scalar/MCP, STT
flow, secret provisioning) by the documentation capstone (ARC-56).

---

## 1. The two-plane trust model

Archer's backend is reached over **two separate planes**, and keeping them separate
is the core of the security posture:

| Plane | Who uses it | Auth | What it can do |
|---|---|---|---|
| **Data plane** | Clients (mobile/web) | Supabase **JWT** (`auth.uid()`) | **Read** own rows + subscribe to Realtime, under RLS. Write only the few client-writable tables (`target_titles`, `negative_criteria`, `candidacies`). |
| **Control plane** | Cron, DB triggers, trusted agents/CLI | Shared **`ARCHER_API_SECRET`** (`x-archer-secret` header) | Run agents, drive the status machines and gates, invoke the CLI — via the **service-role** DB connection that **bypasses RLS** (`services/api/src/db.ts`). |

Key consequences:

- **The Hono API is server-to-server only.** It authenticates with a shared
  secret, not the user's JWT, and trusts a caller-supplied `user`/`userId` param
  for data scoping (`services/api/src/app.ts`, `authorized()`). It is **not** safe
  to expose directly to an untrusted client: an attacker who could call it with an
  arbitrary `user` would read another user's data. Clients must use the **data
  plane** (direct Supabase reads under RLS) for reads, and only proxy *actions*
  through a trusted server that derives `user` from a verified `auth.uid()`.
- **`ARCHER_API_SECRET` is a high-value infra secret.** Holding it is equivalent
  to RLS-bypass access to every user's data. Treat it like a root credential:
  store it only in the deploy env (Komodo managed stack env + the Supabase Vault
  secret the event engine reads — `infra/komodo/README.md`), never in git, and
  rotate it on any suspected exposure.
- **The owner gate is a *separate* secret.** Human-decision routes (account
  acceptance, profile/cover-letter version approvals — ARC-51) require
  `ARCHER_API_ADMIN_SECRET` (`x-archer-admin-secret`), checked by
  `ownerAuthorized()`. A caller holding only the service secret cannot accept
  accounts or approve versions. The admin secret must also be set in production.

See `docs/CLIENT-INTEGRATION.md` §0–§1 and §10 for the client-side view of the same
model (RLS scoping, which tables are client-writable, and the auth-posture gotchas).

---

## 2. Fail-closed in production (ARC-55)

The runtime auth helpers (`authorized()` / `ownerAuthorized()`,
`services/api/src/app.ts`) fall back to the **dev-open bypass**
(`ARCHER_API_DEV_OPEN=1`) only when `NODE_ENV !== "production"`. That makes the
closed-in-prod guarantee depend on `NODE_ENV` being set correctly — and on the
service secret actually being present.

To make a misconfiguration fail **loudly at boot** instead of silently serving a
locked (every request `401`) or — with a wrong `NODE_ENV` — an open API,
`assertSecureStartup()` runs before the server opens a port (`services/api/src/index.ts`):

- **In production**, if `ARCHER_API_SECRET` is unset, the process **refuses to
  start** (throws). Set `ARCHER_API_SECRET` (and `ARCHER_API_ADMIN_SECRET`) in the
  deploy env before shipping.
- **Outside production**, startup is unchanged — local `pnpm dev` and tests still
  run without a secret.

> Operationally: if the API container crash-loops on boot with
> *"Refusing to start: ARCHER_API_SECRET must be set in production"*, the deploy env
> is missing the secret — set it in the Komodo stack env and redeploy.

---

## 3. Network / deploy posture — keeping the API off the public client path

The two-plane model is enforced in code (shared-secret auth, service-role
RLS-bypass) **and** at the network layer by the deploy config:

- The API container publishes its port **bound to loopback only** —
  `127.0.0.1:9125:3000` (`infra/komodo/compose/archer-api.compose.yaml:18-19`). It
  is **not** published on a public interface. The host's Caddy reverse-proxy
  terminates TLS and is the only thing in front of it (compose comment, line 17).
- Therefore the API is reachable by **trusted server-to-server callers** (the
  event-engine cron/triggers via the Vault `archer_api_base_url` + `archer_api_secret`,
  `infra/komodo/README.md`) and the host's reverse-proxy — **not** directly by
  public clients. Public clients reach data only via the Supabase data plane.

**Rule:** do not expose the API container on a public port or route an untrusted
client path to it without first placing a JWT-verifying gateway in front that maps
`auth.uid()` → `user`. Until that exists, the API/MCP stays internal/trusted (the
Client-Readiness Gate condition).

---

## 4. API documentation surface — OpenAPI → Scalar → Registry → `archer` MCP

The API is built on **`OpenAPIHono`** (`@hono/zod-openapi`), so routes are defined
with zod schemas and the spec is generated, not hand-maintained (`services/api/src/app.ts`).
`AppType` is still exported (`app.ts:1453`), so the typed `hc<AppType>` RPC client
(the CLI, `services/cli/src/api.ts`) keeps working unchanged.

Two endpoints are served by the API itself:

- **`GET /openapi.json`** — the OpenAPI 3.0 document (`app.ts:1447-1450`).
- **`GET /reference`** — a self-hosted **Scalar** API reference UI over that spec
  (`@scalar/hono-api-reference`, `app.ts:1451`).

The spec declares **two `securitySchemes`** matching the two-plane auth (registered at
`app.ts:1424-1433`):

| Scheme | Header | Secret | Used by |
|---|---|---|---|
| `serviceSecret` | `x-archer-secret` | `ARCHER_API_SECRET` | all control-plane routes |
| `ownerSecret` | `x-archer-admin-secret` | `ARCHER_API_ADMIN_SECRET` | the three owner-gated `/decide` routes |

These two endpoints are part of the **control plane** and inherit its posture: they
are reachable only by trusted callers (loopback + reverse-proxy), **not** the public
client path, until the owner-identity gateway exists (§1, §3).

**Registry + `archer` MCP (capstone — NOT built yet; ARC-54).** Publishing
`/openapi.json` to the Scalar **Registry** (via `SCALAR_API_KEY` in a CI step) and
wiring the hosted `archer` **MCP** installation to the published spec is a separate
issue (**ARC-54**) and is **not yet implemented** — there is no `SCALAR_API_KEY`
usage, no registry-publish workflow, and no `mcp.scalar.com` wiring in the repo today.

> **Public-exposure gate.** When ARC-54 lands, the MCP acts **behind the shared
> secret**, so the operator selects which user to act as — that makes it a god-token
> over every user's data. It **must stay internal/trusted** and must **not** be made
> publicly reachable until owner-identity (ARC-51, done) is extended into a per-user
> JWT-verifying front (§1). Any Scalar dashboard config done during ARC-54 must be
> recorded here.

---

## 5. Speech-to-text (STT) — audio in, text out, **never persisted** (ARC-53)

Voice input is transcribed by a **Supabase Edge Function**, not by the API. The audio
bytes never touch Archer's database, storage, or disk — they exist only for the
duration of the function's call to ElevenLabs.

**The function:** `transcribe` (`packages/db/supabase/functions/transcribe/`).
- Accepts `POST` of `multipart/form-data` (field `file`/`audio`) or a raw audio body
  (`index.ts:31-65`). `verify_jwt = true` — only authenticated Supabase users may
  call it (`config.toml`).
- Calls **ElevenLabs Speech-to-Text (Scribe)** — `https://api.elevenlabs.io/v1/speech-to-text`,
  model `scribe_v1` — with the `xi-api-key` header (`transcribe.ts:11-13,48-84`).
- Returns **text only**: `{ transcript, provider:"elevenlabs", languageCode? }`. The
  code states the audio is *never* written to storage/DB/disk (`index.ts:6-7,59`;
  `transcribe.ts:8-9`).
- Reads its key from `Deno.env.get("ELEVENLABS_API_KEY")` (`index.ts:34`) — a
  **Supabase secret**, never the API process env. Missing key → `503`.

**The voice flow end-to-end:**

```
client records audio
  → POST /functions/v1/transcribe  (Supabase JWT)        [edge function → ElevenLabs]
  ← { transcript, provider, languageCode? }              (audio discarded here)
  → POST /onboarding/voicenote { threadId, transcript }  (x-archer-secret, control plane)
      → ingestVoicenote: transcribe Activity + a `user` message holding the transcript
```

> The API's `/onboarding/voicenote` route now takes the **already-transcribed
> `transcript`** (not a `storageRef`) — the client transcribes first, then submits text
> (`app.ts:976-1026`). Only the transcript text + provider provenance reach the
> backend; there is no audio at rest anywhere.

CI never calls the live API: the function's core is unit-tested with a mocked fetch
(`transcribe.test.ts`).

---

## 6. The real, swappable LLM (ARC-59/60/61)

Every LLM call-site goes through **one provider abstraction** (`packages/llm`,
`resolveLlm()` in `providers.ts:74-115`). It is a config switch, swappable with no
code changes, and **fail-closed** — it throws `LlmConfigError` if the selected
provider's key is absent (never a silent live call).

| `LLM_PROVIDER` | Key required | Default model | Endpoint |
|---|---|---|---|
| `minimax` (**default**) | `MINIMAX_API_KEY` | `MiniMax-M3` | `https://api.minimax.io/v1` |
| `openrouter` (BYOK, any model) | `OPENROUTER_API_KEY` | `minimax/minimax-m3` | `https://openrouter.ai/api/v1` |
| `mock` (tests/CI) | none | — | none (deterministic) |

`LLM_MODEL` overrides the chosen provider's model; `MINIMAX_BASE_URL`/`OPENROUTER_BASE_URL`
and `OPENROUTER_REFERER`/`OPENROUTER_TITLE` are optional overrides (`providers.ts:62-71`).

Three call-sites are wired to it, each keeping a **deterministic stub injectable for
tests** so CI never needs a live model:
- **AG-UI conversational brain** — `llmBrain`/`getBrain()`/`setBrain()` (`services/api/src/brain.ts`), replacing the old scripted stub in the run loop.
- **Matchmaker triage judge** — `createLlmJudge()` with `resolveJudge()` falling back to `stubJudge` when no key (`services/cli/src/commands/match.ts:175-201`).
- **Scribe cover-letter assembly** — `llmScribe`/`getScribe()` falling back to `stubScribe` when no key (`services/api/src/scribe.ts:50-79`).

Tests run with `LLM_PROVIDER=mock` (or by injecting the stub). The LLM keys are
**provisioned in Supabase secrets** (and injected into the runtime env); they are not
checked into `.env`.

---

## 7. Secret provisioning — which secret lives where

Each secret belongs to **exactly one source of truth**. Real values live only in the
deploy/CI environments below; the repo carries only `.env.example` (the contract).
`.env` is gitignored and **gitleaks is a hard CI gate** — never commit a real value.

The four provisioning locations:

- **`.env` / process env** — local dev + the API/CLI/scheduler runtime.
- **Supabase secrets** — the Edge Function runtime **and** Postgres Vault secrets read
  by pg_cron/triggers. Set via `supabase secrets set <NAME> <value>`.
- **GitHub Actions secrets/vars** — only the CI/release workflows.
- **Komodo stack env** — the deployed container runtime.

### Runtime — API / CLI / scheduler (`.env` locally; **Komodo** in prod)

| Secret / var | Purpose | Read at |
|---|---|---|
| `SUPABASE_URL` | Project URL | `packages/db/src/client.ts` |
| `SUPABASE_PUBLISHABLE_KEY` | Anon key for client-plane reads | clients / docs |
| `SUPABASE_SECRET_KEY` | Service-role key (RLS-bypass control plane) | `packages/db/src/client.ts` |
| `DATABASE_URL` | Service-role Postgres connection | `packages/db/src/client.ts` |
| `ARCHER_API_SECRET` | Control-plane shared secret (`x-archer-secret`). **Required in prod** — fail-closed (§2) | `app.ts:99` |
| `ARCHER_API_ADMIN_SECRET` | Owner/admin secret (`x-archer-admin-secret`) for `/decide` routes | `app.ts:112` |
| `ARCHER_API_DEV_OPEN` | `=1` opens the API in non-prod only. **Never set in prod** | `app.ts:101` |
| `ARCHER_CLI_PATH` | Path to the packaged CLI the API spawns (fail-closed when unset) | `services/api/src/cli.ts` |
| `ARCHER_USER_ID` | Default `user` when a request omits it | `app.ts` |
| `ARCHER_API_URL` | CLI/client → API base URL (default `http://localhost:3000`) | `services/cli/src/api.ts` |
| `LLM_PROVIDER` / `LLM_MODEL` | LLM selection + model override (§6) | `packages/llm/src/providers.ts:75-76` |
| `MINIMAX_API_KEY` | LLM key when `LLM_PROVIDER=minimax` (default). **Provision in Supabase secrets** → runtime env | `providers.ts:83` |
| `OPENROUTER_API_KEY` | LLM key when `LLM_PROVIDER=openrouter` (BYOK). **Provision in Supabase secrets** → runtime env | `providers.ts:96` |
| `UPTIME_KUMA_PUSH_URL` | Daily-collect dead-man's-switch heartbeat (unset = no-op) | `infra/observability/README.md` |
| `NODE_ENV` | `production` enables fail-closed startup (§2) | `app.ts:125` |
| `PORT` | API listen port (default `3000`) | `services/api/src/index.ts` |

### Supabase secrets (Edge Function runtime + Postgres Vault)

| Secret | Purpose | Read at |
|---|---|---|
| `ELEVENLABS_API_KEY` | STT — read by the `transcribe` Edge Function **only** (§5). Never in `.env` | `functions/transcribe/index.ts:34` |
| `MINIMAX_API_KEY` / `OPENROUTER_API_KEY` | LLM keys (§6) — stored here, injected into the runtime env | runtime `process.env` |
| Vault `archer_api_base_url` | API base URL the DB event-engine posts to | `20260620180000_event_engine.sql` |
| Vault `archer_api_secret` | The `x-archer-secret` value the DB event-engine sends | `20260620180000_event_engine.sql` |

### GitHub Actions (CI / release only)

| Secret / var | Purpose | Read at |
|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | CLI auth for `link` / `db push` / `functions deploy` | `.github/workflows/release.yml` |
| `SUPABASE_DB_PASSWORD` | Direct Postgres password for `supabase db push` (migrations-on-merge) | `.github/workflows/release.yml` |
| `SUPABASE_PROJECT_REF` | Project ref for `link` + edge-function deploy | `.github/workflows/release.yml` |
| `SUPABASE_URL` / `SUPABASE_SECRET_KEY` | Best-effort deploy-Activity recording | `.github/workflows/release.yml` |
| `KOMODO_URL` / `KOMODO_API_KEY` / `KOMODO_API_SECRET` / `KOMODO_PROCEDURE` | Trigger the gated Komodo redeploy | `infra/komodo/scripts/redeploy.sh` |
| `ARCHER_API_HEALTH_URL` | Canary / post-deploy smoke target | `.github/workflows/canary.yml` |
| `SCALAR_API_KEY` | **Not used yet** — reserved for the ARC-54 Registry publish step (§4) | — |

### Komodo-only (deployed runtime, never git)

`ARCHER_API_IMAGE` (the pinned `:sha`, injected by `redeploy.sh`), the runtime
board/proxy creds (`<PREFIX>_EMAIL`/`<PREFIX>_PASSWORD`, `DECODO_PROXY` — consumed by
the still-stubbed CLI adapters), plus the runtime copies of `ARCHER_API_SECRET`,
`ARCHER_API_ADMIN_SECRET`, `SUPABASE_*`, `DATABASE_URL`, and the LLM keys.

> See `docs/CLIENT-INTEGRATION.md` for the client/data-plane view, and
> `infra/komodo/README.md` for the managed stack env.
