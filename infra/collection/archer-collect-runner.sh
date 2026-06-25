#!/usr/bin/env bash
# Archer collection runner — the weekday job that actually collects new postings.
# Runs the `collect` CLI for CareerJunction + PNET (CareerJet excluded — anti-bot-
# walled at the Decodo exit) for the test user's `target_titles`, via the Decodo
# Pretoria proxy, on the box where the patched Chromium + board logins live.
# Mirrors infra/enrichment/. (ARC-170)
#
# DEPLOYED: n8n@computer:~/scripts/  (cron `0 6 * * 1-5` UTC = 08:00 SAST).
# Runs on the HOST, NOT the archer-api container: collection is browser scraping
# (Patchright), so it needs the patched Chromium + the Decodo proxy + the board
# logins, all of which live on the box, from the box's checkout at
# /home/n8n/Development/archer (built CLI in services/cli/dist).
set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"   # uv/node helpers; cron is a non-login shell
D="/home/n8n/Development/archer"
LOG="$HOME/.cache/archer-collect.log"
USER_ID="5cd494a2-32f1-4dea-9397-bd430123b015"
# CareerJet is OUT — anti-bot-walled at the Decodo exit (see board-integration notes).
BOARDS="careerjunction pnet"

exec 9>"/tmp/archer-collect.lock"
flock -n 9 || { echo "$(date -Is) skip: already running" >> "$LOG"; exit 0; }

# The box archer .env carries DATABASE_URL (prod), DECODO_PROXY, SUPABASE_URL, and
# the board login creds (CAREERJUNCTION_/PNET_ EMAIL+PASSWORD).
set -a; . "$D/.env"; set +a

# Hard guard: production is a German datacenter IP that SA boards WILL flag. Never
# scrape without the Pretoria-exit Decodo proxy — fail loudly instead of leaking the
# bare IP and risking the accounts.
if [ -z "${DECODO_PROXY:-}" ]; then
  echo "$(date -Is) ABORT: DECODO_PROXY unset — refusing to scrape SA boards from the German box" >> "$LOG"
  exit 1
fi

echo "$(date -Is) === collect run start ===" >> "$LOG"
cd "$D"
for board in $BOARDS; do
  echo "$(date -Is) collect $board" >> "$LOG"
  # Headful under a virtual display (never headless — anti-bot). Titles default to the
  # user's active target_titles; --since defaults to today. A single board failing
  # doesn't stop the rest — collect records its own per-board Activity outcome.
  xvfb-run -a node services/cli/dist/index.js collect "$board" --user "$USER_ID" >> "$LOG" 2>&1 \
    || echo "$(date -Is) $board: collect exited non-zero (continuing)" >> "$LOG"
done
echo "$(date -Is) === collect run end ===" >> "$LOG"
