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
