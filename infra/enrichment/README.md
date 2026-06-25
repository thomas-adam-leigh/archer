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
- **Cron:** `17,47 * * * *` (every 30 min) in the `n8n` user crontab. Gentle on LinkedIn;
  the `flock` skips overlapping runs; logs to `~/.cache/archer-enrich.log`.
- **DB trigger** — `packages/db/supabase/migrations/20260625100000_enriched_candidacy_gate.sql`.
  On a company reaching `enriched`, advances its shortlisted/alt candidacies to
  `awaiting_cover_letter` and notifies the owner. Status-driven, so it fires no matter
  who sets `enriched`.

## Host setup gotcha

`~/.linkedin-mcp/run-server.sh` calls `uv`, which isn't on the PATH when `claude`
spawns the MCP. The wrapper now prepends `~/.local/bin` to PATH; without that the
LinkedIn MCP shows `✘ Failed to connect` (`uv: not found`).

## Not yet autonomous end-to-end

The pg_cron event engine (`/commands/enrich`) can't trigger this — the API container
can't run `claude`/the CLI (see ARC-168). For now the host cron is the trigger. The
fully API-driven version rides on the ARC-168 infra fix.
