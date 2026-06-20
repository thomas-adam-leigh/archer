# Komodo GitOps (`infra/komodo`)

Komodo owns Archer's **runtime**. GitHub Actions owns **build + test + sign**.
`release.yml` pushes a signed image to GHCR, then calls Komodo to redeploy.

```
GitHub Actions ──build+sign──▶ GHCR ──redeploy(API)──▶ Komodo ──▶ archer-api (Hetzner)
```

`resources.toml` declares everything: the `archer-api` stack, the `archer-deploy`
procedure (deploy → smoke test), the smoke `action`, an `alerter`, the
`ARCHER_API_IMAGE` variable, and the `archer-gitops` ResourceSync itself.

## ⚠️ Sibling-stack safety

The box also runs `finance`, `job-hunter`, `n8n`, `shelby`, `akuna-matata`, and the
existing `archer` (hermes-agent) stack. The sync is **non-managed** (`managed = false`)
so it never deletes anything — it only adds/updates the `archer-*` resources above.
Review the diff in the Komodo UI before executing the first sync. Want a clean
"wipe & restore" story? First bring those siblings under their own sync files, then
a wipe becomes a routine restore test rather than data loss.

## One-time bootstrap

1. In Komodo, create a **ResourceSync** named `archer-gitops` pointing at
   `github.com/thomas-adam-leigh/archer`, branch `main`, resource path `infra/komodo`.
   (Or `POST {KOMODO_URL}/write` with `CreateResourceSync`.)
2. Open it, **review the pending diff** — confirm it only creates `archer-*`.
3. Execute the sync. Komodo creates the stack, procedure, action, alerter, variable.
4. Set runtime secrets (below) on the `archer-api` stack and as Komodo Secrets.

## Secrets to set

**In Komodo** (never in git):
- `archer-api` stack env: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_PUBLISHABLE_KEY`, `DATABASE_URL`
- Komodo Secret `ARCHER_ALERT_WEBHOOK` — Slack/Discord/ntfy/n8n webhook for the alerter
- Komodo Variable `ARCHER_API_HEALTH_URL` — e.g. `http://host.docker.internal:9125/health`

**In Supabase Vault** (the event engine reads these — `20260620180000_event_engine.sql`):
- `archer_api_base_url` — public base URL the DB webhooks/cron POST to, e.g. `https://archer-api.<host>` (no trailing slash)
- `archer_api_secret` — the `x-archer-secret` shared secret (must equal the API's `ARCHER_API_SECRET`)

Set once per project: `select vault.create_secret('<value>', 'archer_api_base_url');` (same for `archer_api_secret`). Until set, the engine logs a warning and skips the POST — it never breaks the firing DML.

**In GitHub** (repo → Settings → Secrets and variables → Actions):
- Secrets: `KOMODO_URL`, `KOMODO_API_KEY`, `KOMODO_API_SECRET`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`
- Variables: `KOMODO_PROCEDURE` = `archer-deploy`, `ARCHER_API_HEALTH_URL` (for the canary)
- Environment `production` with **required reviewers** = the deploy approval gate

## Rollback

Pin `ARCHER_API_IMAGE` to a previous immutable tag and redeploy:

```
# via Komodo API
POST {KOMODO_URL}/write  {"type":"UpdateVariableValue","params":{"name":"ARCHER_API_IMAGE","value":"ghcr.io/thomas-adam-leigh/archer-api:sha-<old>"}}
POST {KOMODO_URL}/execute {"type":"RunProcedure","params":{"procedure":"archer-deploy"}}
```

Every released image is cosign-signed; verify before trusting one:

```
cosign verify ghcr.io/thomas-adam-leigh/archer-api@<digest> \
  --certificate-identity-regexp 'https://github.com/thomas-adam-leigh/archer/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```
