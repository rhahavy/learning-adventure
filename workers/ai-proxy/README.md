# KidQuest AI Proxy

Cloudflare Worker that fronts AI providers (Anthropic, OpenAI, ElevenLabs)
for every AI-powered feature on the KidQuest site. One worker, many
endpoints, shared security + caps + audit.

## What this is

Sibling to `tts-proxy`. Same pattern: the frontend hits the Worker, the
Worker holds the API keys, secrets never reach the browser. GitHub Pages
has no backend, so this is the backend.

**Default state: everything OFF.** The master `AI_ENABLED` flag and every
per-feature flag start `false` in `wrangler.toml`. Even after you deploy
this Worker, nothing calls a paid API until you flip a flag and redeploy.
So you can ship this scaffolding now, at $0/month, and activate features
as budget allows.

## Why a single worker (not 11)

- One origin allow-list, one CORS config, one secret store.
- Shared daily-cap logic means a kid who maxes out the /sidekick quota
  also can't spam /explain.
- One KV namespace for cache, caps, and audit — easier to reason about.
- One `wrangler deploy` activates whatever flags you've turned on.
- Matches how `tts-proxy` is structured: endpoints are cheap, workers
  aren't.

## Endpoints

All are `POST` (except `/health`) and all return 503 when the feature
is disabled — the frontend should have a fallback path for every one.

| Path | Flag | Phase | What it does |
|---|---|---|---|
| `/plan-parse` | `FEATURE_PLAN_PARSE` | A | Tutor's free-text plan notes → structured toggle JSON |
| `/explain` | `FEATURE_EXPLAIN` | A | "Why was this answer wrong?" — 2-3 sentence kid-friendly explanation |
| `/feedback` | `FEATURE_FEEDBACK` | A | Rubric-based feedback on a writing-prompt submission |
| `/simplify` | `FEATURE_SIMPLIFY` | A | Rewrite a question in simpler language for ESL / early readers |
| `/generate-questions` | `FEATURE_GENERATE_QUESTIONS` | B | Generate harder variants of an activity's question pool |
| `/worked-example` | `FEATURE_WORKED_EXAMPLE` | B | Step-by-step walkthrough on demand |
| `/teacher-summary` | `FEATURE_TEACHER_SUMMARY` | C | Weekly per-student summary for the teacher dashboard |
| `/parent-report` | `FEATURE_PARENT_REPORT` | C | Plain-English weekly summary for parents |
| `/voice-clone` | `FEATURE_VOICE_CLONE` | C | Upload a parent voice sample to ElevenLabs |
| `/sidekick` | `FEATURE_SIDEKICK` | D | Chat sidekick (heavily capped + moderated) |
| `/photo-extract` | `FEATURE_PHOTO_EXTRACT` | D | Extract questions from a photo of homework |
| `/health` | — | always on | Reports which flags are lit; frontend polls on page load |

**Current state:** every endpoint is scaffolded but returns
`503 feature_disabled → not_implemented` until its handler ships.

### Data backend (Phase 0a — replaces textdb.dev)

These routes don't go through the AI flag chain. They store the
serialized student-data and snapshot blobs that previously lived on
textdb.dev's public buckets, and require a bearer token.

| Method | Path | What it does |
|---|---|---|
| `GET`  | `/data?env=prod\|dev` | Read the student-data blob for the env |
| `POST` | `/data?env=prod\|dev` | Overwrite the student-data blob |
| `GET`  | `/snapshots?env=prod\|dev` | Read the snapshot ring |
| `POST` | `/snapshots?env=prod\|dev` | Overwrite the snapshot ring |

All four require `Authorization: Bearer <DATA_TOKEN>`. KV must be
bound (returns 500 `kv_not_bound` otherwise). 5 MB ceiling per blob.

**Activation:** see "Phase 0a — Data backend" below.

## First-time deploy (zero-cost)

This gets the Worker live without turning on any paid features.

```bash
# 1. Log into Cloudflare (same account as tts-proxy).
wrangler login

# 2. From repo root:
cd workers/ai-proxy

# 3. Deploy with everything off.
wrangler deploy
```

Wrangler prints a URL like `https://kidquest-ai-proxy.<sub>.workers.dev`.
Hit `/health` in a browser — you should see:

```json
{
  "ok": true,
  "service": "kidquest-ai-proxy",
  "ai_enabled": false,
  "has_anthropic_key": false,
  "kv_bound": false,
  "features": { "FEATURE_PLAN_PARSE": false, ... }
}
```

That's the "deployed but dormant" state. No money moves.

## Phase 0a — Data backend (gets you off textdb.dev)

The single most urgent activation. Before this, the site syncs student
data through `textdb.dev` — a third-party public paste service. Anyone
who knows the bucket name can read or overwrite all your students'
progress, names, ages, parent emails, etc. This phase moves data sync
to your own Cloudflare Worker + KV.

```bash
cd workers/ai-proxy

# 1. Create the KV namespace (or reuse the existing AI_CACHE one).
wrangler kv:namespace create AI_CACHE
# Paste the printed `id = "..."` into wrangler.toml under [[kv_namespaces]]
# and uncomment the binding block.

# 2. Generate a long random data token.
openssl rand -base64 48
# (Save it somewhere — you'll paste it twice.)

# 3. Set it as a Worker secret.
wrangler secret put DATA_TOKEN
# Paste the token when prompted.

# 4. Deploy.
wrangler deploy
```

Verify with:

```bash
curl -s "https://kidquest-ai-proxy.<sub>.workers.dev/health" | jq
# Look for: "kv_bound": true, "data_backend_ready": true
```

Then in `index.html`, fill in the two constants:

```js
const DATA_BACKEND_URL   = 'https://kidquest-ai-proxy.<sub>.workers.dev';
const DATA_BACKEND_TOKEN = '<the same token you put as DATA_TOKEN>';
```

Reload the site. The console should print `— backend: WORKER`.

**One-time data migration** — copy existing textdb.dev data into the
new Worker KV:

1. Open the live site (`https://rhahavy.github.io/kidquest/`) in a
   browser with devtools open.
2. In the console, run:
   ```js
   await __migrateCloudToWorker()
   ```
3. You should see `✅ Migration successful` and a summary of bytes
   transferred. If you see ⚠️, read the `errors` array carefully —
   do NOT reload the live site until those are resolved (kids would
   land on default state).
4. For the dev sandbox, repeat from a localhost tab.
5. Reload the live site and verify kids see their progress unchanged.

**Rollback:** blank either of the two `index.html` constants and
reload. The textdb.dev code path kicks back in. Keep this rollback
available for at least a week before manually wiping the textdb.dev
buckets.

**What's still single-tenant:** the `DATA_TOKEN` is one shared token
for everyone. Anyone with view-source on the site can read/write the
blob. This is strictly better than textdb.dev (which was equally
visible AND publicly guessable AND anonymous), but it's not yet
multi-tenant. Phase 0b replaces this with per-tutor accounts +
isolated KV keys.

## Activation ladder

Each rung turns on more features. You can stop at any rung — nothing is
permanent.

### Rung 0 — Deployed, dormant
- Status: all flags off
- Cost: **$0/month**
- Frontend: behaves exactly as if this Worker didn't exist

### Rung 1 — Phase A, free-credits edition
Point the Worker at Anthropic and flip on the cheap endpoints. Most new
Anthropic accounts get $5 free credit, which covers ~3 months of Phase A
for a 5-kid roster.

```bash
# One-time: create an Anthropic account at console.anthropic.com,
# grab an API key, then:
wrangler secret put ANTHROPIC_API_KEY
# Paste the key when prompted.

# Edit wrangler.toml: set the master switch + Phase A flags to "true":
#   AI_ENABLED                  = "true"
#   FEATURE_PLAN_PARSE          = "true"
#   FEATURE_EXPLAIN             = "true"
#   FEATURE_FEEDBACK            = "true"
#   FEATURE_SIMPLIFY            = "true"

wrangler deploy
```

- Status: plan-parse, explain, feedback, simplify → live
- Cost: **~$0 for first 3 months** (free credit), then **~$5–10/year**
- Frontend: "why was I wrong?" buttons appear, writing feedback appears,
  plan-notes save parses prose into toggles

### Rung 2 — Add KV caching (strongly recommended before heavy use)

```bash
wrangler kv:namespace create AI_CACHE
# It prints an id. Uncomment the [[kv_namespaces]] block in wrangler.toml
# and paste the id into `id = "..."`.
wrangler deploy
```

- Daily cap enforcement turns on
- Audit log starts recording (30-day retention)
- Response cache starts saving money — same "why-wrong" question only
  costs one API call, ever

### Rung 3 — Phase B
Flip `FEATURE_GENERATE_QUESTIONS` and `FEATURE_WORKED_EXAMPLE` in
`wrangler.toml`, `wrangler deploy`. Cost: **+~$5/year**.

### Rung 4 — Phase C
Flip `FEATURE_TEACHER_SUMMARY` and `FEATURE_PARENT_REPORT`.
`FEATURE_VOICE_CLONE` requires an ElevenLabs Creator subscription
(~$22/mo) plus `wrangler secret put ELEVENLABS_API_KEY`.
Cost: **+~$15/year** (text) + **$22/mo** if voice cloning.

### Rung 5 — Phase D
Flip `FEATURE_SIDEKICK` and `FEATURE_PHOTO_EXTRACT` only after Phases
A–C have been in production for a few weeks and you trust the setup.
These are the most expensive + highest-risk endpoints.
Cost: **+~$75–100/year** with the built-in caps.

## The caps, explained

Three knobs bound your worst-case spend:

1. **`AI_ENABLED = "false"`** — nothing costs anything.
2. **Per-feature flags** — granular: e.g. keep sidekick off while using
   explain.
3. **`DAILY_CAP_PER_STUDENT`** (default 50) — a single kid cannot make
   more than 50 AI calls in one UTC day. Once they hit it, every
   endpoint returns 429 until midnight UTC. Worst case per kid per day:
   50 × (avg call cost ~$0.003) = **$0.15/day**.

Additionally:
- `MAX_INPUT_CHARS` (default 4000) prevents one request from being
  astronomically long.
- The Cloudflare Worker free tier caps you at 100,000 requests/day
  regardless of AI — extra backstop.

## Secrets (set via `wrangler secret put`, never in wrangler.toml)

| Secret | Needed for | How to get |
|---|---|---|
| `ANTHROPIC_API_KEY` | any text feature | console.anthropic.com → API Keys |
| `OPENAI_API_KEY` | optional (moderation, vision) | platform.openai.com → API keys |
| `ELEVENLABS_API_KEY` | `/voice-clone` only | reuse from tts-proxy |

Rotate any of them with the same command — takes effect immediately, no
redeploy needed.

## Security posture

- **Origin allow-list** — only `rhahavy.github.io`, the custom domain,
  and `localhost` can call the endpoints. Everyone else gets 403.
- **Secrets in `wrangler secret`** — never in `wrangler.toml`, never in
  git.
- **Daily per-student cap** — bounds cost and abuse.
- **Input length cap** — bounds prompt-injection surface.
- **Audit log** — every real AI call records (ts, endpoint, short
  summary) to KV with 30-day TTL, so a tutor can review what the kid
  saw. Stored keyed by student id.
- **No logging of raw student text beyond the audit summary.** The
  summary is a short gist, not a transcript.

## Troubleshooting

- **Frontend doesn't show any AI UI** → expected if `AI_ENABLED=false`
  or individual flags are off. Hit `/health` and check the `features`
  block.
- **Every endpoint returns 503 `ai_globally_disabled`** → `AI_ENABLED`
  is `"false"`. Flip to `"true"` in `wrangler.toml` and redeploy.
- **Endpoint returns 503 `feature_disabled`** → that specific
  `FEATURE_*` flag is off. Flip it in `wrangler.toml` and redeploy.
- **Endpoint returns 503 `not_implemented`** → the handler hasn't been
  written yet (expected for scaffolded endpoints). Wait for that
  phase to ship.
- **500 `missing_api_key`** → `wrangler secret put ANTHROPIC_API_KEY`
  (or whichever key the feature needs).
- **429 `daily_cap_reached`** → that student hit their daily cap. Wait
  for UTC midnight, or raise `DAILY_CAP_PER_STUDENT` in `wrangler.toml`
  if the ceiling is too tight.
- **403 `origin_not_allowed`** → your site's Origin isn't in
  `ALLOWED_ORIGINS`. Add it and redeploy.

## Cost & limits

- **Cloudflare Workers free tier**: 100,000 requests/day. Not the
  limiting factor for this app.
- **Cloudflare KV free tier**: 100,000 reads/day, 1,000 writes/day.
  With aggressive response caching, reads dominate — plenty of room.
- **AI provider costs**: see the activation ladder above. Everything
  flag-off = $0. Phase A on = ~$5–10/year. All features on with caps
  = ~$100–150/year at current model prices.

## Relationship to `tts-proxy`

- Same Cloudflare account, separate Worker.
- `tts-proxy` is intentionally stateless (no KV, no logging) because
  TTS payloads are read-aloud text we don't want a trail of.
- `ai-proxy` uses KV on purpose — caching is how the cost stays low.
- They don't call each other. The frontend calls each directly.
