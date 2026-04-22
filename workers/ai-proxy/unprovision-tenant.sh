#!/usr/bin/env bash
# unprovision-tenant.sh
# ------------------------------------------------------------------
# Removes a classroom/family from the Solvix backend. Wipes the
# tenant record, its code alias, and any stored data + snapshots.
# Admin-gated (reads .admin-token or KIDQUEST_ADMIN_TOKEN).
#
# Stripe: by default the tenant's Stripe subscription is canceled at
# the end of the current billing period (cancel_at_period_end=true) —
# the customer keeps service through what they already paid for, then
# it lapses cleanly. Pass --immediate for a hard DELETE (fraud /
# chargeback / hard-stop) that stops billing right now and does NOT
# prorate. If the tenant has no Stripe subscription on file (manual
# tenant / free plan), the Stripe step is skipped silently.
#
# Usage:
#   bash workers/ai-proxy/unprovision-tenant.sh <pin-or-code> [--immediate]
#
# Examples:
#   bash … unprovision-tenant.sh 2020
#   bash … unprovision-tenant.sh dive-cat-apple-23
#   bash … unprovision-tenant.sh dive-cat-apple-23 --immediate
#
# This is destructive — the classroom's data is gone. Intended for
# cleanup (removing stale or test tenants). If the tenant still has
# users, you may want to export their data via the teacher dashboard
# first.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADMIN_TOKEN_FILE="$SCRIPT_DIR/.admin-token"

die() { printf '\033[1;31m✗\033[0m %s\n' "$1" >&2; exit 1; }

# Parse args. Positional: <pin-or-code>. Flags: --immediate.
CODE=""
IMMEDIATE="false"
for arg in "$@"; do
  case "$arg" in
    --immediate) IMMEDIATE="true" ;;
    -h|--help)   sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)          die "Unknown flag: $arg (only --immediate supported)" ;;
    *)           if [[ -z "$CODE" ]]; then CODE="$arg"; else die "Too many positional args (got '$arg' after '$CODE')"; fi ;;
  esac
done

[[ -n "$CODE" ]] || die "Usage: $0 <pin-or-code> [--immediate]"

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

# Build JSON body. Only include "immediate":true when the flag was set —
# the worker treats absence as the safe default (cancel-at-period-end).
JSON_BODY="$(python3 -c '
import json, sys
out = {"code": sys.argv[1]}
if sys.argv[2] == "true":
    out["immediate"] = True
print(json.dumps(out))
' "$CODE" "$IMMEDIATE")"

RESP="$(printf '%s' "$JSON_BODY" | curl -sS -X POST "$WORKER_URL/unprovision" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Origin: https://kidquest.fun" \
  --data-binary @- 2>&1)" || die "Unprovision request failed. Response: $RESP"

# Parse the response. ok: tenant removed (Stripe outcome reported in detail
# line). err: server rejected — surface the reason.
OK="$(echo "$RESP" | python3 -c 'import json,sys
try: d = json.load(sys.stdin)
except: sys.exit(1)
if d.get("ok"):
  r = d.get("removed", {})
  s = d.get("stripe", {}) or {}
  line = "ok " + str(r.get("id","?")) + " " + str(r.get("code","?"))
  if s.get("attempted"):
    if s.get("canceled"):
      line += " | stripe " + str(s.get("mode","?")) + " " + str(s.get("subscriptionId","?"))
      if s.get("status"): line += " status=" + str(s.get("status"))
    else:
      line += " | stripe FAILED " + str(s.get("subscriptionId","?")) + " err=" + str(s.get("error","?"))
  else:
    line += " | stripe skipped (no subscription on file)"
  print(line); sys.exit(0)
print("err " + d.get("error","unknown") + ": " + d.get("detail",""))
sys.exit(2)
' 2>&1)" || { die "Server rejected unprovision: $RESP"; }

if [[ "$OK" == ok* ]]; then
  printf '\033[1;32m✓\033[0m Removed tenant (%s)\n' "${OK#ok }"
  if [[ "$OK" == *"stripe FAILED"* ]]; then
    printf '\033[1;33m!\033[0m Stripe cancellation FAILED — check the Stripe dashboard manually.\n' >&2
    exit 3
  fi
else
  die "$OK"
fi
