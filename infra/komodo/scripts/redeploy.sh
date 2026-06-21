#!/usr/bin/env bash
#
# Ask Komodo to redeploy archer-api after CI has pushed fresh, signed images to
# GHCR. Called by .github/workflows/release.yml. Komodo (not Actions) owns
# runtime; the actual deploy→smoke→rollback logic lives in the Komodo Procedure.
#
# The deployed image is controlled by ARCHER_API_IMAGE in the archer-api STACK's
# managed environment (the compose uses `image: ${ARCHER_API_IMAGE:-…:latest}`).
# We bump that env entry to the exact :sha this release built — a unique tag every
# deploy forces the pull and gives traceability/rollback — then run the procedure.
set -euo pipefail

: "${KOMODO_URL:?set KOMODO_URL (e.g. https://build.n8n.computer)}"
: "${KOMODO_API_KEY:?set KOMODO_API_KEY}"
: "${KOMODO_API_SECRET:?set KOMODO_API_SECRET}"
PROCEDURE="${KOMODO_PROCEDURE:-archer-deploy}"
STACK="${ARCHER_STACK:-archer-api}"

# curl (not python urllib) for transport — the Komodo host is behind Cloudflare,
# which 1010-blocks urllib's TLS fingerprint. Bodies are passed via files so
# secrets in the stack env never hit argv.
kapi() { curl -fsS -X POST "${KOMODO_URL%/}/$1" \
  -H "X-Api-Key: ${KOMODO_API_KEY}" -H "X-Api-Secret: ${KOMODO_API_SECRET}" \
  -H "Content-Type: application/json" --data-binary @"$2"; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

if [ -n "${ARCHER_API_IMAGE_REF:-}" ]; then
  echo "→ Komodo: setting ${STACK} stack image = ${ARCHER_API_IMAGE_REF}"
  printf '{"type":"GetStack","params":{"stack":"%s"}}' "$STACK" > "$TMP/get.json"
  kapi read "$TMP/get.json" > "$TMP/stack.json"
  IMG="$ARCHER_API_IMAGE_REF" python3 - "$TMP" <<'PY'
import json, os, sys
TMP = sys.argv[1]; IMG = os.environ["IMG"]
def parent_with(o, k):
    if isinstance(o, dict):
        if k in o: return o
        for v in o.values():
            r = parent_with(v, k)
            if r is not None: return r
    elif isinstance(o, list):
        for v in o:
            r = parent_with(v, k)
            if r is not None: return r
    return None
stack = json.load(open(TMP + "/stack.json"))
sid = parent_with(stack, "_id")["_id"]
sid = sid["$oid"] if isinstance(sid, dict) else sid
env = parent_with(stack, "environment")["environment"]
seen = False; out = []
for line in env.splitlines():
    if line.startswith("ARCHER_API_IMAGE="):
        out.append("ARCHER_API_IMAGE=" + IMG); seen = True
    else:
        out.append(line)
if not seen:
    out.append("ARCHER_API_IMAGE=" + IMG)
# Partial config update — only `environment`, everything else untouched.
json.dump({"type": "UpdateStack", "params": {"id": sid, "config": {"environment": "\n".join(out)}}},
          open(TMP + "/update.json", "w"))
PY
  kapi write "$TMP/update.json" > /dev/null
  echo "  ✓ stack env updated"
fi

echo "→ Komodo: running procedure '${PROCEDURE}' at ${KOMODO_URL}"
printf '{"type":"RunProcedure","params":{"procedure":"%s"}}' "$PROCEDURE" > "$TMP/deploy.json"
kapi execute "$TMP/deploy.json"
echo
echo "✓ redeploy triggered"
