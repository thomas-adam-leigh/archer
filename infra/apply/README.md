# Apply runner (host-runner) — owner-confirmed applies

The step that actually submits an application. The web app's **Apply** button POSTs
`/candidacies/{id}/apply-confirm`, which only **stamps** the owner's confirmation
(`apply_confirmed_at`) — it does **not** run the apply. This runner does.

## Why it runs on the host, not the `archer-api` container
Apply is browser automation (Patchright + patched Chromium) against SA job boards,
through the Decodo Pretoria proxy (production is a German Hetzner IP that boards flag).
The container has no browser (ARC-168) — like collect/match/enrich, apply runs on
`n8n@computer` from the checkout at `/home/n8n/Development/archer`.

## The flow
```
web "Apply" button
  → POST /candidacies/{id}/apply-confirm   (stamps apply_confirmed_at; candidacy stays `approved`)
  → this runner (cron)                     (finds approved + confirmed candidacies)
  → archer apply <id>                      (browser apply; runApply moves approved→applying→applied
                                            | external_pending | application_failed)
```

## Pieces
- **`archer-apply-runner.sh`** — deployed to `n8n@computer:~/scripts/`. `flock`-guarded;
  sources the box `.env` (`DATABASE_URL` + `DECODO_PROXY` + `SUPABASE_*` + board creds);
  a **cheap pre-flight** (psycopg via `uv`, zero browser cost) lists candidacies that are
  `approved` **and** `apply_confirmed_at` is set; for each runs
  `xvfb-run node …/apply <id> --json` (headful under a virtual display — never headless).
  Aborts loudly if `DECODO_PROXY` is unset. Logs to `~/.cache/archer-apply.log`.
- **Cron:** `*/5 * * * *` in the `n8n` crontab — responsive to the owner's click, and
  cheap when idle (the pre-flight skips the browser when nothing is confirmed).

## Idempotency & safety
`runApply` gates on `approved` + confirmed (both true for anything the pre-flight
returns) and never re-applies an already-`applied`/`external_pending` candidacy. Once a
candidacy applies, it leaves the pre-flight set (status is no longer `approved`), so it
is applied exactly once. A genuine failure lands it on `application_failed` (terminal),
so it is not retried until the owner re-approves/re-confirms.

## Box dependencies
`/home/n8n/Development/archer` (checkout + built CLI in `services/cli/dist`), Node,
patched Chromium (`~/.cache/ms-playwright`), `xvfb-run`, `uv`, and the board creds +
`DECODO_PROXY` + `SUPABASE_*` in that checkout's `.env`.
