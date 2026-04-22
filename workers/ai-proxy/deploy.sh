#!/usr/bin/env bash
# deploy.sh
# ------------------------------------------------------------------
# One-shot deployer for the Solvix AI Proxy Worker (Phase 0b
# multi-tenant data backend).
#
# Run this AFTER:
#   1. wrangler install — global (`npm i -g wrangler`) OR local
#      (`cd workers/ai-proxy && npm install`). Script auto-detects.
#   2. wrangler login   — opens browser, links to Cloudflare.
#
# Then from anywhere:
#   bash workers/ai-proxy/deploy.sh
#
# What it does:
#   1. Verifies wrangler is installed and you're logged in.
#   2. Creates the AI_CACHE KV namespace (or reuses one if it exists).
#   3. Patches wrangler.toml with the namespace id (idempotent).
#   4. Generates a random ADMIN_TOKEN, sets it as a Cloudflare secret,
#      and saves it locally to .admin-token (chmod 600, gitignored)
#      so provision-tenant.sh can read it without re-prompting.
#   5. Deploys the Worker.
#   6. Hits /health to confirm tenant_backend_ready + admin_provision_ready.
#   7. Patches DATA_BACKEND_URL in index.html (no client-side token —
#      tenancy is identified by the per-family code typed at runtime).
#
# Re-running:
#   • KV namespace: detected, reused (no recreation).
#   • ADMIN_TOKEN: rotated (the old token stops working immediately).
#   • Worker code: redeployed (current source).
# Avoid re-running unnecessarily — rotating ADMIN_TOKEN means any
# provision script using a stale token will start failing.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WRANGLER_TOML="$SCRIPT_DIR/wrangler.toml"
INDEX_HTML="$REPO_ROOT/index.html"
ADMIN_TOKEN_FILE="$SCRIPT_DIR/.admin-token"

if [[ -x "$SCRIPT_DIR/node_modules/.bin/wrangler" ]]; then
  export PATH="$SCRIPT_DIR/node_modules/.bin:$PATH"
fi

banner() { printf '\n\033[1;36m=== %s ===\033[0m\n' "$1"; }
ok()     { printf '\033[1;32m✓\033[0m %s\n' "$1"; }
warn()   { printf '\033[1;33m!\033[0m %s\n' "$1"; }
die()    { printf '\033[1;31m✗\033[0m %s\n' "$1" >&2; exit 1; }

# ---- 1. Preflight ------------------------------------------------
banner "1. Checking wrangler"
command -v wrangler >/dev/null 2>&1 \
  || die "wrangler not installed. Run: cd workers/ai-proxy && npm install   (or: npm i -g wrangler)"
ok "wrangler $(wrangler --version 2>&1 | head -1)"

WHOAMI_OUTPUT="$(wrangler whoami 2>&1 || true)"
if echo "$WHOAMI_OUTPUT" | grep -qi "not authenticated\|not logged in"; then
  die "Not logged in. Run: wrangler login"
fi
ok "Logged in: $(echo "$WHOAMI_OUTPUT" | grep -iE 'email|account' | head -1 | sed 's/^[[:space:]]*//')"

[[ -f "$WRANGLER_TOML" ]] || die "wrangler.toml not found at $WRANGLER_TOML"
[[ -f "$INDEX_HTML"    ]] || die "index.html not found at $INDEX_HTML"

# ---- 2. KV namespace --------------------------------------------
banner "2. KV namespace (AI_CACHE)"
cd "$SCRIPT_DIR"

# Two wrangler syntaxes for KV exist in the wild: the modern `wrangler kv
# namespace …` (>=4.x) and the legacy `wrangler kv:namespace …` (<=3.x).
# Crucially, when wrangler rejects an unknown subcommand it still prints
# its help text to STDOUT (not stderr) before exiting non-zero. That means
# `cmd_a || cmd_b` inside a command-substitution captures BOTH outputs,
# corrupting the JSON we want to parse. So: try each form on its own and
# only keep the output of the one that exits 0.
if KV_LIST="$(wrangler kv namespace list 2>/dev/null)"; then
  : # modern syntax worked
elif KV_LIST="$(wrangler kv:namespace list 2>/dev/null)"; then
  : # legacy syntax worked
else
  KV_LIST='[]'
fi

KV_ID="$(echo "$KV_LIST" | python3 -c '
import json, sys
try:
    namespaces = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for ns in namespaces:
    title = ns.get("title", "")
    if title.endswith("-AI_CACHE") or title == "AI_CACHE":
        print(ns.get("id", ""))
        sys.exit(0)
' || true)"

if [[ -n "$KV_ID" ]]; then
  ok "Reusing existing namespace: $KV_ID"
else
  if CREATE_OUT="$(wrangler kv namespace create AI_CACHE 2>&1)"; then
    : # modern syntax
  elif CREATE_OUT="$(wrangler kv:namespace create AI_CACHE 2>&1)"; then
    : # legacy syntax
  else
    die "Failed to create KV namespace. Output: $CREATE_OUT"
  fi
  echo "$CREATE_OUT"
  KV_ID="$(echo "$CREATE_OUT" | grep -oE 'id[[:space:]]*=[[:space:]]*"[a-f0-9]+"' | head -1 | sed -E 's/.*"([a-f0-9]+)".*/\1/')"
  [[ -n "$KV_ID" ]] || die "Could not parse KV id from wrangler output. Edit wrangler.toml manually."
  ok "Created namespace: $KV_ID"
fi

# ---- 3. Patch wrangler.toml -------------------------------------
banner "3. Patching wrangler.toml"
if grep -qE '^\[\[kv_namespaces\]\]' "$WRANGLER_TOML"; then
  python3 - "$WRANGLER_TOML" "$KV_ID" <<'PY'
import re, sys
path, kv_id = sys.argv[1], sys.argv[2]
with open(path) as f: src = f.read()
src = re.sub(r'(\[\[kv_namespaces\]\][^\[]*?id\s*=\s*")[^"]*(")',
             lambda m: m.group(1) + kv_id + m.group(2),
             src, count=1, flags=re.S)
with open(path, 'w') as f: f.write(src)
PY
  ok "Updated existing kv_namespaces id"
else
  python3 - "$WRANGLER_TOML" "$KV_ID" <<'PY'
import sys
path, kv_id = sys.argv[1], sys.argv[2]
with open(path) as f: src = f.read()
block = '\n[[kv_namespaces]]\nbinding = "KV"\nid = "' + kv_id + '"\n'
src = src.replace(
    '# [[kv_namespaces]]\n# binding = "KV"\n# id = "<paste-from-wrangler-kv-namespace-create-output>"\n',
    ''
)
src = src.rstrip() + '\n' + block
with open(path, 'w') as f: f.write(src)
PY
  ok "Uncommented kv_namespaces block with id $KV_ID"
fi

# ---- 4. ADMIN_TOKEN secret + local copy -------------------------
banner "4. ADMIN_TOKEN secret"
ADMIN_TOKEN="$(openssl rand -base64 48 | tr -d '\n')"
echo "$ADMIN_TOKEN" | wrangler secret put ADMIN_TOKEN
ok "ADMIN_TOKEN set on Worker (length: ${#ADMIN_TOKEN})"

# Save locally so provision-tenant.sh can read it. chmod 600 + gitignored.
umask 077
printf '%s\n' "$ADMIN_TOKEN" > "$ADMIN_TOKEN_FILE"
chmod 600 "$ADMIN_TOKEN_FILE"
ok "Saved admin token to $ADMIN_TOKEN_FILE (chmod 600, gitignored)"

# Best-effort cleanup of the old single-tenant DATA_TOKEN secret, if a
# previous Phase 0a deploy left one behind. Failure is fine — most
# accounts won't have it.
if wrangler secret delete DATA_TOKEN --force >/dev/null 2>&1; then
  ok "Removed legacy DATA_TOKEN secret (Phase 0a cleanup)"
fi

# ---- 5. Deploy ---------------------------------------------------
banner "5. Deploying Worker"
DEPLOY_OUT="$(wrangler deploy 2>&1)"
echo "$DEPLOY_OUT"

WORKER_URL="$(echo "$DEPLOY_OUT" | grep -oE 'https://[a-zA-Z0-9.-]+\.workers\.dev' | head -1)"
[[ -n "$WORKER_URL" ]] || die "Could not parse Worker URL from deploy output. Find it in the dashboard."
ok "Deployed: $WORKER_URL"

# ---- 6. Health check --------------------------------------------
banner "6. Health check"
sleep 3  # let the deploy propagate
HEALTH="$(curl -fsS "$WORKER_URL/health" 2>&1 || true)"
echo "$HEALTH"
if echo "$HEALTH" | grep -q '"tenant_backend_ready":true' \
&& echo "$HEALTH" | grep -q '"admin_provision_ready":true'; then
  ok "tenant_backend_ready + admin_provision_ready: true"
else
  warn "Health check didn't report both flags true. KV may still be propagating; retry /health in 30s."
fi

# ---- 7. Patch index.html (URL only, no token) -------------------
banner "7. Patching index.html"
python3 - "$INDEX_HTML" "$WORKER_URL" <<'PY'
import re, sys
path, url = sys.argv[1], sys.argv[2]
with open(path) as f: src = f.read()
before = src
src = re.sub(
    r"const DATA_BACKEND_URL\s*=\s*'[^']*';",
    "const DATA_BACKEND_URL   = '" + url + "';",
    src, count=1
)
# Phase 0b doesn't use a static client token — clear it so any old
# value doesn't accidentally get sent. The actual bearer is the
# per-tenant code typed at runtime.
src = re.sub(
    r"const DATA_BACKEND_TOKEN\s*=\s*'[^']*';",
    "const DATA_BACKEND_TOKEN = '';  // Phase 0b: bearer is the per-tenant code, set at runtime",
    src, count=1
)
if src == before:
    print("WARNING: no DATA_BACKEND_URL constant found to patch.", file=sys.stderr)
    sys.exit(1)
with open(path, 'w') as f: f.write(src)
PY
ok "Patched DATA_BACKEND_URL"

# ---- Done -------------------------------------------------------
banner "Done"
cat <<EOF

Worker URL:  $WORKER_URL
Health URL:  $WORKER_URL/health
Admin token: $ADMIN_TOKEN_FILE  (keep secret — never commit)

Next steps:

  1. Provision your first tenant (your own family/classroom):
       bash workers/ai-proxy/provision-tenant.sh "My Family"
     This prints a code like "tiger-pizza-cloud-42". Write it down.

  2. (Optional) Migrate existing textdb.dev data into that tenant:
     Reload the site, enter the code on the new login screen, then
     in DevTools console:
       await __migrateCloudToTenant()

  3. Sanity-check by reloading + verifying kids see their progress.

To provision more tenants later (other families/classrooms):
  bash workers/ai-proxy/provision-tenant.sh "Smith Family"
  bash workers/ai-proxy/provision-tenant.sh "Mrs. Lee's Grade 3"

EOF
