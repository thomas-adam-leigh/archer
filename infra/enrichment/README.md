# Company enrichment (host-runner)

Real company enrichment: research a shortlisted company on LinkedIn, write
`companies.enrichment` + `contacts`, and advance its candidacies toward a cover
letter. Replaces the stub `Enricher` in `services/cli`.

## Why it runs on the host, not the `archer-api` container

The LinkedIn MCP is a **patchright browser scraper with a long-lived logged-in
session** that lives on `n8n@computer` (`~/.linkedin-mcp/`, Decodo proxy + cookies).
The `archer-api` container has **no `claude` binary and no MCPs** — and you would
not want to replicate a browser login inside an ephemeral, redeployed container
anyway. So enrichment runs on the host, where `claude` + the LinkedIn + Supabase
MCPs already live. The container→host gap is bridged by **the DB as a queue**: the
host pulls work; nothing in the container has to call the host.

## Pieces

- **`archer-enrich-runner.sh`** — deployed to `n8n@computer:~/scripts/`. A `flock`-guarded
  wrapper that runs a `claude -p` agent. The agent: queries prod (Supabase MCP) for
  companies that are `status=new` behind a `shortlisted`/`alternative_outreach`
  candidacy, then for each one — sets `researching`, researches via the LinkedIn MCP,
  writes `companies.enrichment` + `contacts`, and sets `enriched` (or `enrichment_failed`
  with a reason). It never touches candidacies, and never fabricates emails/URLs.
- **Token-saving pre-flight** — before the agent, the wrapper runs a cheap `psycopg`
  query (via `uv`, against `DATABASE_URL` in `~/.archer-enrich.env`) for the *same*
  "is there a `new` company behind a shortlisted/alt candidacy?" condition. If not, it
  exits in ~1s with **zero LLM cost** — so the every-30-min cron doesn't burn tokens on
  empty runs. It fails toward skipping (any query error → no agent run).
- **Cron:** `17,47 * * * *` (every 30 min) in the `n8n` user crontab. Gentle on LinkedIn;
  the `flock` skips overlapping runs; logs to `~/.cache/archer-enrich.log`.
- **DB trigger** — `packages/db/supabase/migrations/20260625100000_enriched_candidacy_gate.sql`.
  On a company reaching `enriched`, advances its shortlisted/alt candidacies to
  `awaiting_cover_letter` and notifies the owner. Status-driven, so it fires no matter
  who sets `enriched`.

## Host setup gotcha

`~/.linkedin-mcp/run-server.sh` calls `uv`, which isn't on the PATH when `claude`
spawns the MCP. The wrapper now prepends `~/.local/bin` to PATH; without that the
LinkedIn MCP shows `✘ Failed to connect` (`uv: not found`). The enrich runner has the
same `export PATH` for its own `uv` pre-flight (cron runs in a non-login shell).

**Host secret:** `~/.archer-enrich.env` (perms 600) holds `DATABASE_URL` for the
pre-flight. It's the only host dependency beyond `claude` + the MCPs.

## Not yet autonomous end-to-end

The pg_cron event engine (`/commands/enrich`) can't trigger this — the API container
can't run `claude`/the CLI (see ARC-168). For now the host cron is the trigger. The
fully API-driven version rides on the ARC-168 infra fix.
