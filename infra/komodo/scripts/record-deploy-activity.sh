#!/usr/bin/env bash
#
# Record a deploy as an Activity — the universal task primitive from the
# architecture doc. This makes pipeline deploys first-class, visible alongside
# collect/enrich/apply, and subscribable by the Mechanic for self-healing.
#
# Wired now, dormant until the `activities` table exists (foundation milestone M0).
set -euo pipefail

: "${SUPABASE_URL:?}"
: "${SUPABASE_SECRET_KEY:?}"

payload="$(cat <<JSON
{"type":"deploy","status":"${DEPLOY_STATUS:-succeeded}","detail":{"sha":"${SHA:-}","actor":"${GITHUB_ACTOR:-ci}","run_id":"${GITHUB_RUN_ID:-}"}}
JSON
)"

if curl -fsS -X POST "${SUPABASE_URL%/}/rest/v1/activities" \
  -H "apikey: ${SUPABASE_SECRET_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SECRET_KEY}" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=minimal" \
  -d "${payload}"; then
  echo "✓ deploy Activity recorded"
else
  echo "note: could not write Activity (the 'activities' table lands in M0) — non-fatal."
fi
