#!/usr/bin/env bash
# unprovision-tenant.sh
# ------------------------------------------------------------------
# Removes a classroom/family from the KidQuest backend. Wipes the
# tenant record, its code alias, and any stored data + snapshots.
# Admin-gated (reads .admin-token or KIDQUEST_ADMIN_TOKEN).
#
# Usage:
#   bash workers/ai-proxy/unprovision-tenant.sh <pin-or-code>
#
# Examples:
#   bash … unprovision-tenant.sh 2020
#   bash … unprovision-tenant.sh dive-cat-apple-23
#
# This is destructive — the classroom's data is gone. Intended for
# cleanup (removing stale or test tenants). If the tenant still has
# users, you may want to export their data via the teacher dashboard
# first.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADMIN_TOKEN_FILE="$SCRIPT_DIR/.admin-token"

die() { printf '\033[1;31m✗\033[0m %s\n' "$1" >&2; exit 1; }

CODE="${1:-}"
[[ -n "$CODE" ]] || die "Usage: $0 <pin-or-code>"

if [[ -n "${KIDQUEST_ADMIN_TOKEN:-}" ]]; then
  ADMIN_TOKEN="$KIDQUEST_ADMIN_TOKEN"
elif [[ -f "$ADMIN_TOKEN_FILE" ]]; then
  ADMIN_TOKEN="$(cat "$ADMIN_TOKEN_FILE")"
else
  die "Admin token not found. Run deploy.sh first, or set KIDQUEST_ADMIN_TOKEN env var."
fi

WORKER_URL="${KIDQUEST_WORKER_URL:-}"
if [[ -z "$WORKER_URL" ]]; then
  INDEX_HTML="$SCRIPT_DIR/../../index.html"
  if [[ -f "$INDEX_HTML" ]]; then
    WORKER_URL="$(grep -oE "DATA_BACKEND_URL[[:space:]]*=[[:space:]]*'https://[^']+'" "$INDEX_HTML" \
      | head -1 | sed -E "s/.*'(https:[^']+)'.*/\1/")"
  fi
fi
[[ -n "$WORKER_URL" ]] || die "Couldn't find Worker URL. Run deploy.sh first, or set KIDQUEST_WORKER_URL env var."

JSON_BODY="$(python3 -c '
import json, sys
print(json.dumps({"code": sys.argv[1]}))
' "$CODE")"

RESP="$(printf '%s' "$JSON_BODY" | curl -sS -X POST "$WORKER_URL/unprovision" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Origin: https://kidquest.rhahavy.com" \
  --data-binary @- 2>&1)" || die "Unprovision request failed. Response: $RESP"

OK="$(echo "$RESP" | python3 -c 'import json,sys
try: d = json.load(sys.stdin)
except: sys.exit(1)
if d.get("ok"):
  r = d.get("removed", {})
  print("ok " + str(r.get("id","?")) + " " + str(r.get("code","?")))
  sys.exit(0)
print("err " + d.get("error","unknown") + ": " + d.get("detail",""))
sys.exit(2)
' 2>&1)" || { die "Server rejected unprovision: $RESP"; }

if [[ "$OK" == ok* ]]; then
  printf '\033[1;32m✓\033[0m Removed tenant (%s)\n' "${OK#ok }"
else
  die "$OK"
fi
