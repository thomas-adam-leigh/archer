#!/usr/bin/env bash
#
# Canary drift handler: open a GitHub issue AND file an Archer Proposal so the
# Mechanic can pick it up. Both are best-effort — a canary should never hard-fail
# the pipeline, only raise a flag.
set -uo pipefail

TITLE="Board canary drift — $(date -u +%Y-%m-%d)"
BODY="The board canary detected drift. Investigate and, if needed, propose an Archer CLI adapter repair.

Run: ${RUN_URL:-n/a}"

# 1) GitHub issue (visible, assignable)
if command -v gh >/dev/null 2>&1 && [ -n "${GH_TOKEN:-}" ]; then
  gh issue create --title "$TITLE" --body "$BODY" --label "self-heal,board-drift" \
    || echo "note: could not create issue"
fi

# 2) Archer Proposal row (the agent-to-owner control channel). Dormant until the
#    `proposals` table exists (foundation §1 / milestone M4).
if [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_SECRET_KEY:-}" ]; then
  curl -fsS -X POST "${SUPABASE_URL%/}/rest/v1/proposals" \
    -H "apikey: ${SUPABASE_SECRET_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SECRET_KEY}" \
    -H "Content-Type: application/json" \
    -H "Prefer: return=minimal" \
    -d "{\"title\":\"${TITLE}\",\"rationale\":\"canary drift\",\"status\":\"submitted\",\"plan\":{\"run\":\"${RUN_URL:-}\"}}" \
    && echo "✓ Proposal filed" \
    || echo "note: proposals table not present yet — non-fatal."
fi
exit 0
