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

# Map GitHub's job.status (success|failure|cancelled) to the activity_status enum
# (queued|in_progress|succeeded|failed) defined in the core schema migration.
case "${DEPLOY_STATUS:-success}" in
  success | succeeded) status="succeeded" ;;
  *) status="failed" ;;
esac

payload="$(cat <<JSON
{"type":"deploy","status":"${status}","detail":{"sha":"${SHA:-}","actor":"${GITHUB_ACTOR:-ci}","run_id":"${GITHUB_RUN_ID:-}"}}
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
