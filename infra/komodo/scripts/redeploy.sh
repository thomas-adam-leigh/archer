#!/usr/bin/env bash
#
# Ask Komodo to redeploy Archer after CI has pushed fresh, signed images to GHCR.
# Called by .github/workflows/release.yml. Komodo (not Actions) owns runtime, so
# this is a thin trigger — the actual migrate→deploy→healthcheck→rollback logic
# lives in the Komodo Procedure (see infra/komodo/resources.toml).
set -euo pipefail

: "${KOMODO_URL:?set KOMODO_URL (e.g. https://build.n8n.computer)}"
: "${KOMODO_API_KEY:?set KOMODO_API_KEY}"
: "${KOMODO_API_SECRET:?set KOMODO_API_SECRET}"
PROCEDURE="${KOMODO_PROCEDURE:-archer-deploy}"

echo "→ Komodo: running procedure '${PROCEDURE}' at ${KOMODO_URL}"
curl -fsS -X POST "${KOMODO_URL%/}/execute" \
  -H "X-Api-Key: ${KOMODO_API_KEY}" \
  -H "X-Api-Secret: ${KOMODO_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"RunProcedure\",\"params\":{\"procedure\":\"${PROCEDURE}\"}}"
echo
echo "✓ redeploy triggered"
