#!/usr/bin/env bash
# maintenance.sh — flip the global-maintenance gate ON/OFF from the CLI.
# ----------------------------------------------------------------------
# Usage:
#   bash workers/ai-proxy/maintenance.sh status                # read current state
#   bash workers/ai-proxy/maintenance.sh on   ["operator note"] # flip ON
#   bash workers/ai-proxy/maintenance.sh off                   # flip OFF
#
# About the optional message:
#   It is NOT shown to end-users. The user-facing maintenance screen
#   (renderMaintenanceScreen in app/index.html) intentionally ignores
#   the global-gate message and always renders DEFAULT_MAINTENANCE_MESSAGE
#   so we never leak deploy/roadmap details to kids or parents. The
#   message you pass here is just an internal log/audit note, visible
#   to the operator via `maintenance.sh status` or the admin console.
#   In practice you can almost always omit it.
#
# Reads the admin token from workers/ai-proxy/.admin-token (chmod 600,
# written by deploy.sh, gitignored). The token never leaves the file —
# we cat it directly into the curl Authorization header. If you ever
# rotate the secret on the Worker, re-run deploy.sh to refresh this file.
#
# Effect: every /health response carries the new state immediately, and
# clients pick it up on their next poll (~25s). When ON, the app shows
# the friendly hold screen on every device until you flip OFF.

set -euo pipefail

MODE="${1:-status}"
MSG="${2:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOKEN_FILE="$SCRIPT_DIR/.admin-token"
WORKER_URL="https://kidquest-ai-proxy.rhahavy-b.workers.dev"
# The worker rejects requests without a CORS-allowed Origin header
# (see ALLOWED_ORIGINS in wrangler.toml). curl from the CLI doesn't
# send one by default, so we forge one that matches the production
# site. The worker treats it as a normal browser request from there.
ORIGIN="https://kidquest.fun"

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
  status)
    curl -sS -H "Origin: $ORIGIN" -H "Authorization: Bearer $TOKEN" \
      "$WORKER_URL/admin/global-maintenance" | pretty
    ;;
  on)
    # Default message keeps tone friendly. Override with $2 for ad-hoc copy.
    BODY=$(python3 -c '
import json, sys
msg = sys.argv[1] if len(sys.argv) > 1 else ""
print(json.dumps({"active": True, "message": msg}))
' "$MSG")
    curl -sS -X POST -H "Origin: $ORIGIN" -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "$BODY" \
      "$WORKER_URL/admin/global-maintenance" | pretty
    ;;
  off)
    curl -sS -X POST -H "Origin: $ORIGIN" -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d '{"active":false}' \
      "$WORKER_URL/admin/global-maintenance" | pretty
    ;;
  *)
    echo "Usage: $0 status | on [message] | off" >&2
    exit 1
    ;;
esac
