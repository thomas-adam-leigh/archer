#!/usr/bin/env bash
# Archer apply runner — the owner-confirmed apply step.
#
# The web app's "Apply" button POSTs /candidacies/{id}/apply-confirm, which only STAMPS
# the confirmation (apply_confirmed_at) — the browser automation cannot run in the
# archer-api container (ARC-168). This runner is what actually applies: it polls for
# candidacies the owner has confirmed (status='approved' + apply_confirmed_at set) and
# runs `archer apply <id>` for each, on the box where the patched Chromium + Decodo
# proxy + board logins live. Mirrors infra/collection + infra/enrichment.
#
# DEPLOYED: n8n@computer:~/scripts/  (cron `*/5 * * * *`). Runs on the HOST, not the
# archer-api container: apply is Patchright browser automation.
set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"   # uv/node helpers; cron is a non-login shell
D="/home/n8n/Development/archer"
LOG="$HOME/.cache/archer-apply.log"

exec 9>"/tmp/archer-apply.lock"
flock -n 9 || { echo "$(date -Is) skip: already running" >> "$LOG"; exit 0; }

# The box .env carries DATABASE_URL (prod), DECODO_PROXY, SUPABASE_* (the cover-letter
# bucket), and the board creds (PNET_/CAREERJUNCTION_ EMAIL+PASSWORD). Guard nounset
# while sourcing — secret values can contain '$'.
set +u; set -a; . "$D/.env"; set +a; set -u

# Hard guard: production is a German datacenter IP that SA boards WILL flag. Never
# apply (browser scraping) without the Pretoria-exit Decodo proxy — fail loudly.
if [ -z "${DECODO_PROXY:-}" ]; then
  echo "$(date -Is) ABORT: DECODO_PROXY unset — refusing to apply from the German box" >> "$LOG"
  exit 1
fi

# Cheap pre-flight (NO browser, ~0 cost): which candidacies has the owner confirmed for
# apply but not yet applied? `approved` + apply_confirmed_at set. One id per line. A
# candidacy leaves this set as soon as apply moves it applying→applied (or failed), so
# it is never re-applied. psql isn't installed on the box; use psycopg via uv.
IDS="$(uv run --no-project --quiet --with 'psycopg[binary]' python3 - <<'PY' 2>>"$LOG"
import os, psycopg
sql = ("select id from candidacies where status='approved' "
       "and apply_confirmed_at is not null order by status_changed_at")
with psycopg.connect(os.environ['DATABASE_URL']) as conn:
    for row in conn.execute(sql):
        print(row[0])
PY
)"
if [ -z "$IDS" ]; then
  echo "$(date -Is) nothing confirmed to apply — skip" >> "$LOG"
  exit 0
fi

echo "$(date -Is) === apply run start ===" >> "$LOG"
cd "$D"
for id in $IDS; do
  echo "$(date -Is) apply $id" >> "$LOG"
  # Headful under a virtual display (never headless — anti-bot). runApply gates on an
  # approved + confirmed candidacy (both true here) and is idempotent — it never
  # re-applies an already-applied one. A single apply failing doesn't stop the rest.
  xvfb-run -a node services/cli/dist/index.js apply "$id" --json >> "$LOG" 2>&1 \
    || echo "$(date -Is) $id: apply exited non-zero (continuing)" >> "$LOG"
done
echo "$(date -Is) === apply run end ===" >> "$LOG"
