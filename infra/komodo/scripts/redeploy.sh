#!/usr/bin/env bash
#
# Ask Komodo to redeploy Archer after CI has pushed fresh, signed images to GHCR.
# Called by .github/workflows/release.yml. Komodo (not Actions) owns runtime; the
# actual deploy→smoke→rollback logic lives in the Komodo Procedure.
#
# Each deployed image is controlled by an env entry in its STACK's managed
# environment (the compose uses `image: ${ARCHER_*_IMAGE:-…:latest}`). We bump
# those entries to the exact :sha this release built — a unique tag every deploy
# forces the pull and gives traceability/rollback — then run the procedure that
# deploys archer-api + archer-web and smoke-tests the API.
set -euo pipefail

: "${KOMODO_URL:?set KOMODO_URL (e.g. https://build.n8n.computer)}"
: "${KOMODO_API_KEY:?set KOMODO_API_KEY}"
: "${KOMODO_API_SECRET:?set KOMODO_API_SECRET}"
PROCEDURE="${KOMODO_PROCEDURE:-archer-deploy}"

# curl (not python urllib) for transport — the Komodo host is behind Cloudflare,
# which 1010-blocks urllib's TLS fingerprint. Bodies are passed via files so
# secrets in the stack env never hit argv.
kapi() { curl -fsS -X POST "${KOMODO_URL%/}/$1" \
  -H "X-Api-Key: ${KOMODO_API_KEY}" -H "X-Api-Secret: ${KOMODO_API_SECRET}" \
  -H "Content-Type: application/json" --data-binary @"$2"; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# bump_stack <stack> <env_key> <image_ref>: pin one stack's image env entry to a
# specific GHCR ref via a partial UpdateStack (only `environment` is touched).
bump_stack() {
  local stack="$1" env_key="$2" image_ref="$3"
  echo "→ Komodo: setting ${stack} stack ${env_key} = ${image_ref}"
  printf '{"type":"GetStack","params":{"stack":"%s"}}' "$stack" > "$TMP/get.json"
  kapi read "$TMP/get.json" > "$TMP/stack.json"
  IMG="$image_ref" ENV_KEY="$env_key" python3 - "$TMP" <<'PY'
import json, os, sys
TMP = sys.argv[1]; IMG = os.environ["IMG"]; KEY = os.environ["ENV_KEY"]
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
    if line.startswith(KEY + "="):
        out.append(KEY + "=" + IMG); seen = True
    else:
        out.append(line)
if not seen:
    out.append(KEY + "=" + IMG)
# Partial config update — only `environment`, everything else untouched.
json.dump({"type": "UpdateStack", "params": {"id": sid, "config": {"environment": "\n".join(out)}}},
          open(TMP + "/update.json", "w"))
PY
  kapi write "$TMP/update.json" > /dev/null
  echo "  ✓ ${stack} env updated"
}

[ -n "${ARCHER_API_IMAGE_REF:-}" ] && bump_stack "${ARCHER_API_STACK:-archer-api}" "ARCHER_API_IMAGE" "$ARCHER_API_IMAGE_REF"
[ -n "${ARCHER_WEB_IMAGE_REF:-}" ] && bump_stack "${ARCHER_WEB_STACK:-archer-web}" "ARCHER_WEB_IMAGE" "$ARCHER_WEB_IMAGE_REF"

echo "→ Komodo: running procedure '${PROCEDURE}' at ${KOMODO_URL}"
printf '{"type":"RunProcedure","params":{"procedure":"%s"}}' "$PROCEDURE" > "$TMP/deploy.json"
kapi execute "$TMP/deploy.json"
echo
echo "✓ redeploy triggered"
