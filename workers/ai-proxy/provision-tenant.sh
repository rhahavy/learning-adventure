#!/usr/bin/env bash
# provision-tenant.sh
# ------------------------------------------------------------------
# Mints a new classroom/family code on the KidQuest multi-tenant
# backend. Each classroom gets a short PIN (4 digits) that becomes
# the bearer token the app uses against /data and /snapshots.
#
# Usage:
#   bash workers/ai-proxy/provision-tenant.sh "Classroom Label" [options]
#
# Positional:
#   $1  label          short human label (e.g. "Rhahavy's Mission Hub").
#                      Visible in the teacher banner so users know
#                      which classroom they're in.
#
# Options (any order, any combination):
#   --pin 2020         pick a specific 4-digit PIN for this classroom.
#                      If omitted, a random word-code is minted instead
#                      (handy for one-shot guest access).
#   --teacher-pw foo   per-tenant teacher password. Defaults to the
#                      label slugged + "-2025" (e.g. "demo-2025").
#   --demo             mark this classroom as a demo tenant. The app
#                      skips the profile picker and lands visitors
#                      straight on the demo-grade picker. Use this for
#                      the public preview classroom.
#
# Examples:
#   bash … provision-tenant.sh "Rhahavy's Mission Hub" --pin 2020
#   bash … provision-tenant.sh "Demo"                  --pin 2228 --demo
#   bash … provision-tenant.sh "Guest"                 # word-code, no PIN
#
# Reads:
#   .admin-token  (chmod 600, written by deploy.sh)
#   ../../index.html (discovers DATA_BACKEND_URL if KIDQUEST_WORKER_URL
#                     env var isn't set)
#
# Output: a block with the PIN + teacher password to give the family.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADMIN_TOKEN_FILE="$SCRIPT_DIR/.admin-token"

if [[ -x "$SCRIPT_DIR/node_modules/.bin/wrangler" ]]; then
  export PATH="$SCRIPT_DIR/node_modules/.bin:$PATH"
fi

die() { printf '\033[1;31m✗\033[0m %s\n' "$1" >&2; exit 1; }
usage() { die "Usage: $0 \"Classroom Label\" [--pin 1234] [--teacher-pw X] [--demo]"; }

# ---- Arg parsing -------------------------------------------------
LABEL=""
PIN=""
TEACHER_PW=""
IS_DEMO="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pin)         shift; PIN="${1:-}"; [[ -n "$PIN" ]] || die "--pin requires a value"; shift;;
    --teacher-pw)  shift; TEACHER_PW="${1:-}"; [[ -n "$TEACHER_PW" ]] || die "--teacher-pw requires a value"; shift;;
    --demo)        IS_DEMO="true"; shift;;
    -h|--help)     usage;;
    --*)           die "Unknown flag: $1";;
    *)
      if [[ -z "$LABEL" ]]; then LABEL="$1"; else die "Unexpected extra argument: $1"; fi
      shift;;
  esac
done

[[ -n "$LABEL" ]] || usage
if [[ -n "$PIN" && ! "$PIN" =~ ^[0-9]{4}$ ]]; then
  die "--pin must be exactly 4 digits (got: $PIN)"
fi

if [[ -z "$TEACHER_PW" ]]; then
  TEACHER_PW="$(echo "$LABEL" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-' | sed -E 's/-+/-/g; s/^-//; s/-$//')-2025"
fi

# ---- Admin token -------------------------------------------------
if [[ -n "${KIDQUEST_ADMIN_TOKEN:-}" ]]; then
  ADMIN_TOKEN="$KIDQUEST_ADMIN_TOKEN"
elif [[ -f "$ADMIN_TOKEN_FILE" ]]; then
  ADMIN_TOKEN="$(cat "$ADMIN_TOKEN_FILE")"
else
  die "Admin token not found. Run deploy.sh first (writes $ADMIN_TOKEN_FILE), or set KIDQUEST_ADMIN_TOKEN env var."
fi

# ---- Worker URL discovery ---------------------------------------
# Priority: env override → DATA_BACKEND_URL in index.html (written by
# deploy.sh, always current) → error. Avoids the brittle subdomain
# reverse-engineering from `wrangler whoami`.
WORKER_URL="${KIDQUEST_WORKER_URL:-}"
if [[ -z "$WORKER_URL" ]]; then
  INDEX_HTML="$SCRIPT_DIR/../../index.html"
  if [[ -f "$INDEX_HTML" ]]; then
    WORKER_URL="$(grep -oE "DATA_BACKEND_URL[[:space:]]*=[[:space:]]*'https://[^']+'" "$INDEX_HTML" \
      | head -1 | sed -E "s/.*'(https:[^']+)'.*/\1/")"
  fi
fi
[[ -n "$WORKER_URL" ]] || die "Couldn't find Worker URL. Run deploy.sh first, or set KIDQUEST_WORKER_URL env var."

# ---- Request -----------------------------------------------------
# Build JSON via python (handles escaping of labels with apostrophes etc.)
# and pipe it into curl's stdin. Avoids brittle nested quoting.
JSON_BODY="$(python3 -c '
import json, sys
payload = {
  "label": sys.argv[1],
  "teacherPassword": sys.argv[2],
  "isDemo": sys.argv[3] == "true",
}
pin = sys.argv[4]
if pin:
  payload["pin"] = pin
print(json.dumps(payload))
' "$LABEL" "$TEACHER_PW" "$IS_DEMO" "$PIN")"

ORIGIN="https://kidquest.rhahavy.com"

RESP="$(printf '%s' "$JSON_BODY" | curl -sS -X POST "$WORKER_URL/provision" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Origin: $ORIGIN" \
  --data-binary @- 2>&1)" || die "Provision request failed. Response: $RESP"

# Worker returns non-2xx with an error body on validation failures
# (invalid_pin, pin_taken). Surface those clearly rather than eating them.
ERR="$(echo "$RESP" | python3 -c 'import json,sys
try: d = json.load(sys.stdin)
except: sys.exit(0)
if "error" in d:
  print(d["error"] + ": " + d.get("detail",""))
' 2>/dev/null || true)"
if [[ -n "$ERR" ]]; then die "Server rejected provision — $ERR"; fi

CODE="$(echo "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["tenant"]["code"])' 2>/dev/null)" \
  || die "Bad response from /provision: $RESP"

DEMO_LINE=""
if [[ "$IS_DEMO" == "true" ]]; then DEMO_LINE="$(printf '\n  │  Demo tenant:       yes (skips profile picker)')"; fi

cat <<EOF

  ┌─────────────────────────────────────────────────────────────┐
  │  Classroom provisioned                                      │
  ├─────────────────────────────────────────────────────────────┤
  │  Label:             $LABEL
  │  Classroom PIN:     $CODE
  │  Teacher password:  $TEACHER_PW$DEMO_LINE
  ├─────────────────────────────────────────────────────────────┤
  │  Send this to the family/teacher:                           │
  │                                                             │
  │    "Visit https://kidquest.rhahavy.com and type $CODE        "
  │     on the welcome PIN gate.                                 "
  │     Use $TEACHER_PW for teacher mode."
  └─────────────────────────────────────────────────────────────┘

EOF
