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

# Pin the stack image to the exact tag this release built, BEFORE redeploying.
# The compose uses `image: ${ARCHER_API_IMAGE:-…:latest}`; without this the
# procedure re-pulls the same tag every time and the container never advances
# (the host gets stuck on a stale image). A unique :sha-<commit> tag each deploy
# forces the pull and gives traceability/rollback.
if [ -n "${ARCHER_API_IMAGE_REF:-}" ]; then
  echo "→ Komodo: pinning ARCHER_API_IMAGE = ${ARCHER_API_IMAGE_REF}"
  curl -fsS -X POST "${KOMODO_URL%/}/write" \
    -H "X-Api-Key: ${KOMODO_API_KEY}" \
    -H "X-Api-Secret: ${KOMODO_API_SECRET}" \
    -H "Content-Type: application/json" \
    -d "{\"type\":\"UpdateVariableValue\",\"params\":{\"name\":\"ARCHER_API_IMAGE\",\"value\":\"${ARCHER_API_IMAGE_REF}\"}}"
  echo
fi

echo "→ Komodo: running procedure '${PROCEDURE}' at ${KOMODO_URL}"
curl -fsS -X POST "${KOMODO_URL%/}/execute" \
  -H "X-Api-Key: ${KOMODO_API_KEY}" \
  -H "X-Api-Secret: ${KOMODO_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"RunProcedure\",\"params\":{\"procedure\":\"${PROCEDURE}\"}}"
echo
echo "✓ redeploy triggered"
