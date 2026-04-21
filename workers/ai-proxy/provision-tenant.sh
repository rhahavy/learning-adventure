#!/usr/bin/env bash
# provision-tenant.sh
# ------------------------------------------------------------------
# Mints a new family/classroom code for someone you're onboarding.
#
# Usage:
#   bash workers/ai-proxy/provision-tenant.sh "Smith Family" [teacher-password]
#
# Args:
#   $1  label  — short human label (e.g. "Smith Family", "Mrs. Lee G3").
#                Stored on the tenant record; visible in the dashboard
#                banner so users know which classroom they're in.
#   $2  teacher-password (optional) — sets the per-tenant teacher
#                password. If omitted, defaults to the label slugged +
#                "-2025" (e.g. "smith-family-2025"). The user can change
#                it later from the teacher dashboard if you build that
#                UI; for now, send them what's printed.
#
# Reads:
#   .admin-token  (chmod 600, written by deploy.sh)
#   wrangler.toml (to find the worker name)
#
# Output: a 4-line block with the code + teacher password to give
# the family. Safe to re-run — each run mints a NEW tenant.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADMIN_TOKEN_FILE="$SCRIPT_DIR/.admin-token"

if [[ -x "$SCRIPT_DIR/node_modules/.bin/wrangler" ]]; then
  export PATH="$SCRIPT_DIR/node_modules/.bin:$PATH"
fi

die() { printf '\033[1;31m✗\033[0m %s\n' "$1" >&2; exit 1; }

LABEL="${1:-}"
TEACHER_PW="${2:-}"
[[ -n "$LABEL" ]] || die "Usage: $0 \"Family or Classroom Label\" [teacher-password]"

if [[ -z "$TEACHER_PW" ]]; then
  TEACHER_PW="$(echo "$LABEL" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-' | sed -E 's/-+/-/g; s/^-//; s/-$//')-2025"
fi

# Read the admin token. Allow override via env var so CI can supply it
# without a file. Local file is the default.
if [[ -n "${KIDQUEST_ADMIN_TOKEN:-}" ]]; then
  ADMIN_TOKEN="$KIDQUEST_ADMIN_TOKEN"
elif [[ -f "$ADMIN_TOKEN_FILE" ]]; then
  ADMIN_TOKEN="$(cat "$ADMIN_TOKEN_FILE")"
else
  die "Admin token not found. Run deploy.sh first (writes $ADMIN_TOKEN_FILE), or set KIDQUEST_ADMIN_TOKEN env var."
fi

# Discover the Worker URL. Three sources, in priority order:
#   1. KIDQUEST_WORKER_URL env var (explicit override).
#   2. The DATA_BACKEND_URL constant in index.html — deploy.sh writes
#      this on every deploy, so it's always current. This avoids us
#      having to reverse-engineer the workers.dev account subdomain
#      from `wrangler whoami` (which is brittle — emails with dots
#      and accounts with multi-segment subdomains break naive regexes).
#   3. `wrangler deployments status` parsing as a last resort.
WORKER_URL="${KIDQUEST_WORKER_URL:-}"
if [[ -z "$WORKER_URL" ]]; then
  INDEX_HTML="$SCRIPT_DIR/../../index.html"
  if [[ -f "$INDEX_HTML" ]]; then
    WORKER_URL="$(grep -oE "DATA_BACKEND_URL[[:space:]]*=[[:space:]]*'https://[^']+'" "$INDEX_HTML" \
      | head -1 | sed -E "s/.*'(https:[^']+)'.*/\1/")"
  fi
fi
if [[ -z "$WORKER_URL" ]]; then
  die "Couldn't find Worker URL. Either run deploy.sh first, or set KIDQUEST_WORKER_URL env var (e.g. https://kidquest-ai-proxy.YOUR.workers.dev)."
fi

# Use the prod origin since /provision enforces the CORS allow-list.
# kidquest.rhahavy.com is in ALLOWED_ORIGINS in wrangler.toml.
ORIGIN="https://kidquest.rhahavy.com"

# Build the JSON body via python (handles escaping for any label/password)
# and pipe it into curl via stdin (`-d @-`). Doing it through stdin avoids
# the brittle nested-quoting of `-d "$(python -c ...)"` inside bash command
# substitution, which broke on labels containing apostrophes.
JSON_BODY="$(python3 -c '
import json, sys
print(json.dumps({"label": sys.argv[1], "teacherPassword": sys.argv[2]}))
' "$LABEL" "$TEACHER_PW")"

RESP="$(printf '%s' "$JSON_BODY" | curl -fsS -X POST "$WORKER_URL/provision" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Origin: $ORIGIN" \
  --data-binary @- 2>&1)" || die "Provision request failed. Response: $RESP"

CODE="$(echo "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["tenant"]["code"])' 2>/dev/null)" \
  || die "Bad response from /provision: $RESP"

cat <<EOF

  ┌─────────────────────────────────────────────────────────────┐
  │  Tenant provisioned                                         │
  ├─────────────────────────────────────────────────────────────┤
  │  Label:             $LABEL
  │  Family code:       $CODE
  │  Teacher password:  $TEACHER_PW
  ├─────────────────────────────────────────────────────────────┤
  │  Send this to the family/teacher:                           │
  │                                                             │
  │    "Visit https://kidquest.rhahavy.com and enter            │
  │     $CODE on the welcome screen.                            │
  │     Use $TEACHER_PW for teacher mode."                      │
  └─────────────────────────────────────────────────────────────┘

EOF
