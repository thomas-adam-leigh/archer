# Daily job collection (host-runner) — ARC-170

The weekday job that actually collects new postings: runs the `collect` CLI for
**CareerJunction + PNET** via the Decodo Pretoria proxy. The missing "engine" behind
the milestone — the cron + dashboard schedule (ARC-171/172) only *declare* a time; this
is what runs on it.

## Why it runs on the host, not the `archer-api` container
Collection is browser scraping (Patchright + patched Chromium) against South-African job
boards, and it MUST exit through the Decodo Pretoria residential proxy (production is a
German Hetzner IP that SA boards flag and block). The patched Chromium, the proxy, and the
board logins all live on `n8n@computer`, run from the checkout at
`/home/n8n/Development/archer`. The `archer-api` container can't run the CLI at all
(ARC-168). So — exactly like the enrichment runner — the collector runs on the host.

## Pieces
- **`archer-collect-runner.sh`** — deployed to `n8n@computer:~/scripts/`. `flock`-guarded;
  sources the box archer `.env` (`DATABASE_URL` + `DECODO_PROXY` + board creds); for each of
  **careerjunction, pnet** runs `xvfb-run node …/collect <board> --user <id>` (headful under a
  virtual display — never headless; titles default to the user's `target_titles`;
  `--since today`). Aborts loudly if `DECODO_PROXY` is unset. Logs to `~/.cache/archer-collect.log`.
- **Cron:** `0 6 * * 1-5` UTC (= **08:00 SAST**) in the `n8n` crontab — the single declared
  schedule the API + dashboard now surface (ARC-171/172).
- **CareerJet excluded** — anti-bot-walled at the Decodo exit.

## Known gaps / follow-ups (important)
- **Matching must also run** for collected postings to surface. The matcher runs through the
  broken API→CLI path (ARC-168) and has **no host runner yet**, so freshly-collected postings
  sit as untriaged `new` candidacies until a matcher host runner exists. **Collection alone
  does not put new jobs on the dashboard** — it needs a sibling matcher runner (trivial; it's
  an LLM-only step, no browser).
- **PNET over-collects** — its adapter pulls the whole board (not title-filtered), so a run
  adds many irrelevant postings. The matcher + dashboard filter them out of *view*, but the DB
  gets cluttered; fixing the adapter's title-filtering is a separate issue.

## Box dependencies
`/home/n8n/Development/archer` (checkout + built CLI in `services/cli/dist`), Node, patched
Chromium (`~/.cache/ms-playwright`), `xvfb-run`, and the board creds + `DECODO_PROXY` in that
checkout's `.env`.
