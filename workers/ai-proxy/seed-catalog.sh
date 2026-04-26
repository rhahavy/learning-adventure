#!/usr/bin/env bash
# seed-catalog.sh — push the bundled default-catalog.json into KV.
# ----------------------------------------------------------------------
# Usage:
#   bash workers/ai-proxy/seed-catalog.sh                      # POST defaults
#   bash workers/ai-proxy/seed-catalog.sh path/to/custom.json  # POST custom file
#   bash workers/ai-proxy/seed-catalog.sh --status             # show current
#
# When to run:
#   • First-ever deploy of the catalog feature: KV is empty, kids see
#     the in-app fallback seed. Run this once and you're done — kids
#     pick up the live KV catalog on their next /store/catalog poll
#     (browser cache: 2 min).
#   • Ad-hoc bulk re-seed: rotate the prize wall back to defaults if
#     someone made an edit you want to undo. The whole catalog is
#     replaced — there is no per-item merge.
#
# Editing prizes in production:
#   Once seeded, prefer the /admin/ Prize Catalog panel for live edits
#   so you don't need a checkout. This script is for the rare bulk
#   replace.
#
# Auth: reads workers/ai-proxy/.admin-token (chmod 600, gitignored,
# minted by deploy.sh). Never re-prints the token. Forges a CORS-allowed
# Origin header (kidquest.fun) because the worker rejects no-Origin
# admin POSTs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOKEN_FILE="$SCRIPT_DIR/.admin-token"
DEFAULT_JSON="$SCRIPT_DIR/default-catalog.json"
WORKER_URL="https://kidquest-ai-proxy.rhahavy-b.workers.dev"
ORIGIN="https://kidquest.fun"

MODE="${1:-seed}"

if [[ ! -f "$TOKEN_FILE" ]]; then
  echo "✗ No .admin-token at $TOKEN_FILE — run workers/ai-proxy/deploy.sh once to mint one." >&2
  exit 1
fi
TOKEN="$(cat "$TOKEN_FILE")"
if [[ -z "$TOKEN" ]]; then
  echo "✗ .admin-token is empty. Re-run deploy.sh to refresh." >&2
  exit 1
fi

# Pretty-print JSON if python3 is available; otherwise raw output.
pretty() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -m json.tool 2>/dev/null || cat
  else
    cat
  fi
}

case "$MODE" in
  --status|status)
    echo "▸ Current catalog (admin view):"
    curl -sS -H "Origin: $ORIGIN" -H "Authorization: Bearer $TOKEN" \
      "$WORKER_URL/admin/store/catalog" | pretty
    ;;
  *)
    SOURCE="${1:-$DEFAULT_JSON}"
    if [[ ! -f "$SOURCE" ]]; then
      echo "✗ Catalog file not found: $SOURCE" >&2
      exit 1
    fi
    if ! command -v python3 >/dev/null 2>&1; then
      echo "✗ python3 is required (used to validate + wrap the JSON)." >&2
      exit 1
    fi
    # Validate JSON locally before sending. Saves a round-trip on typos.
    # Pass the path as argv to avoid shell-quoting issues.
    python3 - "$SOURCE" <<'PY' || { echo "✗ JSON validation failed at $SOURCE" >&2; exit 1; }
import json, sys
with open(sys.argv[1]) as f:
    d = json.load(f)
assert isinstance(d, list), 'top-level must be an array'
print(f"\u2713 Local validation: {len(d)} item{'s' if len(d)!=1 else ''}")
PY
    # Wrap the array in { "catalog": [...] } as the endpoint expects.
    BODY="$(python3 - "$SOURCE" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    items = json.load(f)
print(json.dumps({"catalog": items}))
PY
)"
    echo "▸ Posting catalog to $WORKER_URL/admin/store/catalog ..."
    RESP="$(curl -sS -X POST \
      -H "Origin: $ORIGIN" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "$BODY" \
      "$WORKER_URL/admin/store/catalog")"
    echo "$RESP" | pretty
    # Surface a one-line success/failure summary so the operator
    # doesn't have to scan the JSON for the `ok` field.
    if echo "$RESP" | grep -q '"ok": *true'; then
      echo "✓ Catalog saved. Kids pick it up on their next /store/catalog poll (~2 min browser cache)."
    else
      echo "✗ Save failed — see response above." >&2
      exit 1
    fi
    ;;
esac
