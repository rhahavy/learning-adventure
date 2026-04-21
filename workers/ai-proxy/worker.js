/* KidQuest AI Proxy — Cloudflare Worker
 * ---------------------------------------------------------------
 * Single worker that fronts Anthropic / OpenAI / other AI providers
 * for every AI-powered feature on the KidQuest site. One worker,
 * many endpoints, shared security layer — same idea as grouping
 * API routes on a normal backend instead of spinning up 11 separate
 * services.
 *
 * Default state: everything OFF. The master AI_ENABLED flag and
 * every FEATURE_* flag start "false", so even if this Worker is
 * deployed, nothing actually calls a paid API until a human flips a
 * flag in wrangler.toml and redeploys. Zero surprise bills.
 *
 * Design goals:
 *   - Flag-gated activation. AI_ENABLED is a master kill-switch;
 *     each feature has its own FEATURE_* flag on top of that.
 *     A disabled endpoint returns 503 with a friendly JSON body
 *     so the frontend's fallback path kicks in (same contract as
 *     the TTS proxy when TTS is down).
 *   - Strict CORS. Only the production site + localhost dev server
 *     are allowed in. Everyone else gets 403 so that our API keys
 *     can't be burned by some random origin pointing at the URL.
 *   - Per-student daily cap. KV-backed counter keyed by student id
 *     (passed via X-Student-Id header) and the UTC date. Once a
 *     kid hits DAILY_CAP_PER_STUDENT calls, the endpoint returns
 *     429 for the rest of the day. One runaway kid can cost at
 *     most N * (avg per-call cost) — not unbounded.
 *   - Input length cap. MAX_INPUT_CHARS per request prevents both
 *     accidental multi-megabyte bodies and prompt-injection attempts
 *     that stuff in huge adversarial payloads.
 *   - Audit hook. Every successful AI call writes a short record
 *     to KV (30-day TTL) so tutors/parents can review what the AI
 *     showed a kid. Populated by real endpoint handlers — the
 *     scaffolded stubs don't call it (there's nothing to audit).
 *   - Intentional persistence. Unlike the TTS proxy (which stores
 *     nothing), this Worker uses KV for counters + audit + response
 *     cache. That's a deliberate cost-vs-privacy tradeoff for AI
 *     features where caching saves real money and the tutor-facing
 *     audit trail is a feature, not a leak.
 *
 * Endpoints (all POST, all currently stubbed → 503 when flag off):
 *   /plan-parse         — Phase A. Tutor's free-text plan notes
 *                         → structured toggle JSON.
 *   /explain            — Phase A. "Why was this answer wrong?"
 *                         kid-friendly 2-3 sentence explanation.
 *   /feedback           — Phase A. Rubric-based feedback on a
 *                         kid's writing prompt submission.
 *   /simplify           — Phase A. Rewrite a question in simpler
 *                         language for ESL / early-reader kids.
 *   /generate-questions — Phase B. Generate harder variants of an
 *                         activity's question pool (stretch mode).
 *   /worked-example     — Phase B. Step-by-step walkthrough on
 *                         demand for a specific question.
 *   /teacher-summary    — Phase C. Weekly per-student summary for
 *                         the teacher dashboard.
 *   /parent-report      — Phase C. Plain-English weekly summary
 *                         for parents.
 *   /voice-clone        — Phase C. Upload a parent's voice sample
 *                         to ElevenLabs for custom TTS.
 *   /sidekick           — Phase D. Chat sidekick character
 *                         (heavily capped + moderated).
 *   /photo-extract      — Phase D. Extract quiz questions from a
 *                         photo of homework via vision API.
 *
 *   /health             — Always on. Reports which flags are lit.
 *                         Frontend polls this at page load to decide
 *                         which AI-powered UI elements to show.
 *   OPTIONS *           — CORS preflight.
 *
 * Secrets (set via `wrangler secret put`, NOT in wrangler.toml):
 *   ANTHROPIC_API_KEY   — required once any FEATURE_* flag is on.
 *                         When absent, even flag-on endpoints return
 *                         500 "missing_api_key".
 *   OPENAI_API_KEY      — optional. If set, reserved for features
 *                         that specifically need OpenAI (e.g. a
 *                         moderation pass or the vision API). Not
 *                         used in Phase A.
 *   ELEVENLABS_API_KEY  — optional. Only needed for /voice-clone;
 *                         reuses the same key as tts-proxy if set.
 *
 * KV bindings (optional; create before first activation):
 *   KV — used for daily caps, audit log, and response cache.
 *        Create with:  wrangler kv:namespace create AI_CACHE
 *        Then paste the id into wrangler.toml under [[kv_namespaces]].
 *        Scaffolded endpoints work without KV (they don't need it);
 *        real feature handlers will check for it and return 500 if
 *        it's missing.
 */

// -------- fallback config --------

// Origins allowed to call /plan-parse, /explain, etc. Override via
// ALLOWED_ORIGINS in wrangler.toml when you add a custom domain.
const DEFAULT_ALLOWED_ORIGINS = [
  'https://rhahavy.github.io',
  'https://kidquest.rhahavy.com',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
];

// Input body size cap in characters. Most AI calls fit comfortably
// under 2000; a weekly teacher summary is the biggest at ~3000.
// 4000 gives headroom without letting someone POST War and Peace.
const DEFAULT_MAX_INPUT_CHARS = 4000;

// Per-student, per-day call cap. Once reached, all endpoints return
// 429 until UTC midnight. Tunable via wrangler.toml without a redeploy
// is not possible (env vars require a deploy), but it's a one-liner.
const DEFAULT_DAILY_CAP_PER_STUDENT = 50;

// All the feature flags the frontend needs to know about. The
// /health endpoint echoes the lit/unlit state of each.
const FEATURE_FLAGS = [
  'FEATURE_PLAN_PARSE',
  'FEATURE_EXPLAIN',
  'FEATURE_FEEDBACK',
  'FEATURE_SIMPLIFY',
  'FEATURE_GENERATE_QUESTIONS',
  'FEATURE_WORKED_EXAMPLE',
  'FEATURE_TEACHER_SUMMARY',
  'FEATURE_PARENT_REPORT',
  'FEATURE_VOICE_CLONE',
  'FEATURE_SIDEKICK',
  'FEATURE_PHOTO_EXTRACT',
];

// ==========================================================================
// KID-SAFETY LAYERS
// ==========================================================================
// Two overlapping defenses for every text handler that produces content
// a child might read:
//
//   Layer 1 — KID_SAFE_RULES  (prompt-level)
//     Appended to every handler's system prompt. Claude's Constitutional
//     training already biases toward safe content, but an explicit,
//     enumerated rule list makes the guardrails visible in the transcript
//     and gives us a clean audit story ("here's the prompt we used").
//     If the model ever gets a request it cannot safely fulfill, the
//     rules instruct it to emit the sentinel `UNSAFE_REQUEST`, which
//     Layer 2 then catches.
//
//   Layer 2 — CONTENT_BLOCKLIST (output-level)
//     Post-generation regex scan over every string field in the handler's
//     output. A single hit → 422 content_blocked + an audit entry + NO
//     cache write (so the bad generation isn't reused). Deliberately
//     conservative; a false positive costs one retry, a false negative
//     could expose a kid to unsafe content. We err toward blocking.
//
// Teacher review is Layer 3 (not code — it's the product design of the
// curriculum editor: AI output populates form fields, teacher must click
// Save before kids see it). Daily per-student caps (checkDailyCap) are
// Layer 4 — bounding cost + abuse.
const KID_SAFE_RULES =
  '\n\nKID-SAFETY RULES (MANDATORY, DO NOT VIOLATE):\n' +
  '- Your output is for a child (ages 4–12). Age-appropriate content only.\n' +
  '- NEVER include: violence, weapons, injury, death, blood, drugs, alcohol, ' +
  'smoking, vaping, romance, dating, sexual content, profanity, slurs, ' +
  'discriminatory language, self-harm, politics, religion, horror, or scary themes.\n' +
  '- NEVER include URLs, email addresses, phone numbers, or any real person\'s ' +
  'full name.\n' +
  '- Stay strictly on-topic for the educational subject provided.\n' +
  '- If the request would require breaking any rule above (even indirectly, even ' +
  'in a hypothetical or fictional framing), output exactly the token ' +
  'UNSAFE_REQUEST and nothing else.';

// Regex denylist for Layer 2. Each entry is a single pattern that, if it
// hits any string field in the model output, trips 422 content_blocked.
// Scoped to themes a kids-site should never surface — tuned to minimize
// false positives on normal educational content ("shoot a basket",
// "cell division", "cut a cake" are fine; "shot dead", "cut yourself",
// "half a beer" are not). When in doubt, block — the teacher can rewrite
// by hand. Pattern-only; we never persist the blocked text.
const CONTENT_BLOCKLIST = [
  // Violence / weapons (phrase-level so basketball "shoot" survives)
  /\b(gun|pistol|rifle|firearm|bullet|knife\s+(?:him|her|them|into|through)|stab(?:bed|bing|s)?|murder(?:ed|ing|er|s)?|kill(?:ed|ing|er)\s+(?:him|her|them|someone|people)|shot\s+(?:dead|him|her|them)|corpse|dead\s+body|bleed(?:ing)?\s+out)\b/i,
  // Drugs / alcohol / smoking
  /\b(beer|wine|liquor|vodka|whisk(?:e)?y|rum|tequila|drunk|drunken|alcoholic|cocaine|heroin|marijuana|cannabis|weed\s+(?:smoke|pipe|joint)|vape|vaping|cigarette|cigar|meth(?:amphetamine)?)\b/i,
  // Sexual / romantic content
  /\b(sex(?:y|ual|ually)?|naked|nude|porn(?:ographic)?|makeout|make\s+out|penis|vagina|breast(?:s)?|nipple(?:s)?|boyfriend|girlfriend|crush\s+on)\b/i,
  // Self-harm
  /\b(suicide|kill\s+(?:my|him|her|your)self|cut(?:ting)?\s+(?:my|your)self|self[\s\-]?harm|kms|kys)\b/i,
  // Horror / occult
  /\b(satan|satanic|devil\s+worship|demon(?:ic)?\s+possess|torture|mutilat|gore\b|gruesome)\b/i,
  // PII leakage
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,          // email
  /\b(?:\+?\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/, // phone (US/CA)
  /\bhttps?:\/\/\S+/i,                                            // any URL
  // Model self-report: if Claude refused internally per KID_SAFE_RULES,
  // the sentinel reaches Layer 2 and gets blocked. Without this, an
  // UNSAFE_REQUEST string could reach a kid.
  /\bUNSAFE_REQUEST\b/,
];

// Scan a string against the blocklist. Returns { pattern, match } on hit
// or null on clean. Keep the returned match short — it's for logs only,
// never shown to a user.
function scanForBannedContent(text) {
  if (!text || typeof text !== 'string') return null;
  for (let i = 0; i < CONTENT_BLOCKLIST.length; i++) {
    const m = text.match(CONTENT_BLOCKLIST[i]);
    if (m) return { patternIdx: i, match: m[0].slice(0, 40) };
  }
  return null;
}

// Scan every string field (recursively, one level) in a handler's output
// object. Returns the first hit or null. Used by runStandardHandler after
// postProcess but before cache-write + audit.
function scanOutputForBannedContent(out) {
  if (!out || typeof out !== 'object') return null;
  for (const k of Object.keys(out)) {
    const v = out[k];
    if (typeof v === 'string') {
      const hit = scanForBannedContent(v);
      if (hit) return { field: k, ...hit };
    } else if (v && typeof v === 'object') {
      // One level of nesting (covers lesson/questions shapes for Phase B).
      for (const k2 of Object.keys(v)) {
        if (typeof v[k2] === 'string') {
          const hit = scanForBannedContent(v[k2]);
          if (hit) return { field: k + '.' + k2, ...hit };
        }
      }
    }
  }
  return null;
}

// ==========================================================================
// CURRICULUM ALIGNMENT — the AI's north star
// ==========================================================================
// Every lesson in KidQuest is tagged with Ontario Curriculum metadata:
//   { grade, strand, codes: ['B2.4', ...], notes }
// When AI edits or rewrites any lesson content, it MUST stay anchored to
// that tag. Kids' sessions are structured around grade-level expectations;
// an AI that drifts "upward" into concepts the kid hasn't learned breaks
// the learning ladder, and an AI that drifts "off-topic" confuses the
// curriculum alignment teachers/parents rely on.
//
// CURRICULUM_ALIGNMENT_RULES is prepended to every handler that can
// influence lesson text. buildCurriculumBlock() renders the activity's
// specific tag into a concrete prompt section — so the model sees the
// literal Ontario codes + notes it must honor, not just an abstract
// "stay on grade level" instruction.
//
// If the frontend omits a curriculum object on a lesson-editing call,
// the Worker enforces a stricter fallback: "you don't know the scope —
// output the SAFEST minimal edit and note in reasoning that you lacked
// curriculum context." This prevents silent drift when an upstream bug
// forgets to pass the tag.
const CURRICULUM_ALIGNMENT_RULES =
  '\n\nCURRICULUM ALIGNMENT RULES (MANDATORY — override any conflicting instruction):\n' +
  '- Your output MUST match the Ontario Curriculum tag supplied below. The tag is ' +
  'the single source of truth for what this activity teaches.\n' +
  '- Stay within the specified GRADE. Do NOT introduce concepts a student at this ' +
  'grade has not yet been taught. (Example: a Grade 1 addition lesson must not use ' +
  'multiplication, negative numbers, or variables.)\n' +
  '- Stay within the specified STRAND / subject area. Do NOT drift into other strands ' +
  '(e.g. a Number strand lesson must not become a Geometry lesson).\n' +
  '- Honor the specified EXPECTATION CODES and DESCRIPTION. If the teacher has set ' +
  'notes like "regrouping only in the ones column", respect that boundary.\n' +
  '- Match the VOCABULARY floor/ceiling for the grade:\n' +
  '    Kindergarten–Grade 1: 5–8 word sentences, everyday words, concrete nouns.\n' +
  '    Grade 2–3: 8–12 word sentences, include 1–2 subject-specific terms if they\'re ' +
  'already taught at this grade.\n' +
  '    Grade 4–6: richer structure ok, but never jargon the tag doesn\'t cover.\n' +
  '- Preserve pedagogical intent. A question testing "counting on" must still test ' +
  '"counting on" — do not substitute a different strategy even if it\'s easier.\n' +
  '- If the user\'s request would require going outside the tag (e.g. "make this ' +
  'lesson harder — add fractions" on a Grade 1 addition tag), output exactly ' +
  'CURRICULUM_VIOLATION and nothing else. The client will surface this to the teacher.';

// Render a concrete curriculum block for the user prompt. Called with
// whatever shape the frontend passes (possibly partial/missing fields).
// Returns a single string ready to splice into the prompt — or a
// fallback block when curriculum is missing, which tells the model to
// be maximally conservative. Never throws.
function buildCurriculumBlock(curriculum) {
  if (!curriculum || typeof curriculum !== 'object') {
    return (
      'ONTARIO CURRICULUM TAG: (missing)\n' +
      'Instruction: Because no curriculum tag was supplied, make the SAFEST, ' +
      'minimal edit possible. Do not introduce new concepts or vocabulary. ' +
      'If the edit cannot be done safely without knowing the grade and strand, ' +
      'output CURRICULUM_VIOLATION.'
    );
  }
  const grade = String(curriculum.grade || '').trim().slice(0, 40);
  const strand = String(curriculum.strand || '').trim().slice(0, 80);
  const codes = Array.isArray(curriculum.codes)
    ? curriculum.codes.filter(c => typeof c === 'string').slice(0, 10).map(c => c.slice(0, 16))
    : [];
  const notes = String(curriculum.notes || '').trim().slice(0, 400);
  let block = 'ONTARIO CURRICULUM TAG:\n';
  block += '  Grade:  ' + (grade || '(unspecified)') + '\n';
  block += '  Strand: ' + (strand || '(unspecified)') + '\n';
  if (codes.length) block += '  Codes:  ' + codes.join(', ') + '\n';
  if (notes)        block += '  Notes:  ' + notes + '\n';
  block += 'All your output must honor this tag. See CURRICULUM ALIGNMENT RULES above.';
  return block;
}

// Second-line defense: after the model responds, verify it didn't output
// the CURRICULUM_VIOLATION sentinel. If it did, treat as a structured
// refusal and return 422 — the teacher sees a friendly "AI declined to
// make this edit because it would violate the curriculum tag" message.
function scanOutputForCurriculumViolation(out) {
  if (!out || typeof out !== 'object') return false;
  const probe = (v) => typeof v === 'string' && /\bCURRICULUM_VIOLATION\b/.test(v);
  for (const k of Object.keys(out)) {
    if (probe(out[k])) return true;
    if (out[k] && typeof out[k] === 'object') {
      for (const k2 of Object.keys(out[k])) if (probe(out[k][k2])) return true;
    }
  }
  return false;
}

// ==========================================================================
// MULTI-TENANT DATA BACKEND  (Phase 0b)
// ==========================================================================
// Each family/classroom is a "tenant" identified by an opaque tenantId
// and reached via a memorable "code" the parent/teacher types into the
// site (e.g. "tiger-pizza-cloud-42"). The code IS the session bearer;
// the client stores it in localStorage and sends it as
// `Authorization: Bearer <code>` on every /data and /snapshots call.
//
// KV layout:
//   code:{code}            → tenantId               (lookup index)
//   tenant:{tenantId}      → JSON metadata          {id, label, code, teacherPassword, createdAt}
//   tenant:{tenantId}:data → blob (full app state)  (replaces `data:prod` from Phase 0a)
//   tenant:{tenantId}:snapshots → blob              (replaces `snapshots:prod`)
//   ratelimit:auth:{ip}    → JSON {n, resetAt}      (sliding cap on bad code attempts)
//
// Two auth roles:
//   • Tenant code  — used by /auth, /tenant, /data, /snapshots. Looked
//     up via KV. Anyone with a code reaches the tenant's data.
//   • Admin token  — env.ADMIN_TOKEN secret. Used by /provision to mint
//     new tenants. Replaces the old single DATA_TOKEN.
//
// Why the code is the bearer (no separate "session token"):
//   • Simpler: nothing to expire or refresh on the client.
//   • Codes are revocable (delete `code:{code}` and the tenant becomes
//     unreachable immediately).
//   • The trust model assumes anyone with the code is "inside" — that
//     matches how a family password works in practice.
//
// Why per-tenant teacher password:
//   • The code unlocks the tenant; the teacher password gates teacher-
//     mode features within the tenant (so kids who know the family
//     code can't accidentally edit the curriculum).
//   • Each family chooses their own at provisioning time — no shared
//     hardcoded `Chili2025` across everyone we sell to.

// 128-word, kid-friendly diceware-style list. Short, common, easy to
// spell aloud, no homophones I could think of. With 3 words + 2 digits,
// codes have ~28 bits of entropy = ~268M combinations. Per-IP rate-
// limit at 10 attempts/hour means ~28k years of brute-force per IP.
// Safe against drive-by guessing; not safe against a leaked DB dump,
// but the codes ARE the DB so that concern is moot.
const TENANT_WORDS = (
  'ant bear bee bird cat cow crab deer dog duck eagle fish fox frog goat ' +
  'hawk horse koala lamb lion mouse owl panda pig rabbit robin seal sheep ' +
  'snake swan tiger wolf apple bagel berry bread cake candy cheese cherry ' +
  'cookie cream donut fruit grape honey lemon mango melon mint muffin pizza ' +
  'plum sushi taco waffle beach brook cloud fern forest grass hill lake ' +
  'leaf meadow moon mountain ocean pond rain river rock sand sky snow star ' +
  'sun tree wind blue coral cyan gold green ivory jade lime navy peach pink ' +
  'purple red ruby silver teal ball bell book brush comb drum gem hat key ' +
  'kite lamp mug pen ring scarf vase castle garden harbor library market ' +
  'palace park tower dance dive fly glide hop jump sing swim'
).split(' ');

// 5 MB ceiling per blob. Cloudflare KV's hard limit is 25 MB; 5 MB
// gives us 5x headroom and matches localStorage's typical cap. Every
// per-tenant blob is bounded by this — runaway client can't bloat KV.
const DATA_MAX_BYTES = 5 * 1024 * 1024;

// Auth rate limit: per IP, max N failed code attempts per hour. Beyond
// that, return 429 for the rest of the window. Doesn't apply to /auth
// successes (a real user shouldn't get throttled for typing slowly).
const AUTH_RATE_LIMIT_MAX     = 10;
const AUTH_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

// Generate a fresh tenant code. crypto.getRandomValues is unbiased
// enough for 128-word selection (modulo bias is ~2^-25, undetectable).
function generateTenantCode() {
  const a = new Uint32Array(4);
  crypto.getRandomValues(a);
  const w1 = TENANT_WORDS[a[0] % TENANT_WORDS.length];
  const w2 = TENANT_WORDS[a[1] % TENANT_WORDS.length];
  const w3 = TENANT_WORDS[a[2] % TENANT_WORDS.length];
  const dd = String(a[3] % 100).padStart(2, '0');
  return `${w1}-${w2}-${w3}-${dd}`;
}

// Opaque tenant id — 12 random bytes hex. 96 bits, no collision risk
// at any plausible tenant count. Used as the KV key prefix so that
// rotating a code doesn't move the data.
function generateTenantId() {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time-ish admin token check. Same shape as the old data-token
// check; ADMIN_TOKEN is what /provision (and only /provision) requires.
function checkAdminAuth(request, env) {
  const expected = env.ADMIN_TOKEN;
  if (!expected || typeof expected !== 'string') return false;
  const header = request.headers.get('authorization') || '';
  if (!header.startsWith('Bearer ')) return false;
  const got = header.slice(7);
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// Extract the bearer code from the Authorization header. Returns null
// if missing/malformed. Does NOT validate the code — caller looks it
// up in KV.
function extractBearer(request) {
  const header = request.headers.get('authorization') || '';
  if (!header.startsWith('Bearer ')) return null;
  const got = header.slice(7).trim();
  return got || null;
}

// Look up `code:{code}` → tenantId, then `tenant:{tenantId}` → metadata.
// Returns the parsed tenant object, or null on miss / malformed entry.
async function lookupTenantByCode(env, code) {
  if (!code || !env.KV) return null;
  const tenantId = await env.KV.get(`code:${code}`);
  if (!tenantId) return null;
  const raw = await env.KV.get(`tenant:${tenantId}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Per-IP sliding-window failure counter. Read → decide → write. Not
// transactional (KV doesn't support that), but the worst case is two
// concurrent bad attempts get counted as one — acceptable.
async function rateLimitAuthFailure(env, ip) {
  if (!env.KV || !ip) return { ok: true, remaining: AUTH_RATE_LIMIT_MAX };
  const key = `ratelimit:auth:${ip}`;
  const now = Date.now();
  let state = { n: 0, resetAt: now + AUTH_RATE_LIMIT_WINDOW_MS };
  try {
    const raw = await env.KV.get(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.resetAt > now) state = parsed;
    }
  } catch {}
  state.n += 1;
  // KV TTL ensures the key auto-deletes when the window passes — no
  // accumulation of stale per-IP keys.
  const ttl = Math.max(60, Math.ceil((state.resetAt - now) / 1000));
  await env.KV.put(key, JSON.stringify(state), { expirationTtl: ttl });
  return { ok: state.n <= AUTH_RATE_LIMIT_MAX, remaining: Math.max(0, AUTH_RATE_LIMIT_MAX - state.n), resetAt: state.resetAt };
}

async function rateLimitCheck(env, ip) {
  if (!env.KV || !ip) return { ok: true };
  try {
    const raw = await env.KV.get(`ratelimit:auth:${ip}`);
    if (!raw) return { ok: true };
    const parsed = JSON.parse(raw);
    if (parsed.resetAt < Date.now()) return { ok: true };
    return { ok: parsed.n < AUTH_RATE_LIMIT_MAX, resetAt: parsed.resetAt };
  } catch { return { ok: true }; }
}

// POST /provision — admin-only. Body: { label, teacherPassword? }.
// Returns: { ok, tenant: {id, label, code, teacherPassword, createdAt} }.
// No idempotency: re-calling with the same label creates a SECOND
// tenant. CLI script handles "is this what you meant?" UX.
async function handleProvisionRoute(request, env, corsOrigin) {
  if (!env.KV) return json({ error: 'kv_not_bound' }, 500, corsOrigin);
  if (!checkAdminAuth(request, env)) return json({ error: 'admin_unauthorized' }, 401, corsOrigin);
  let body = {};
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400, corsOrigin); }
  const label = (body.label || '').toString().trim().slice(0, 80) || 'Untitled';
  const teacherPassword = (body.teacherPassword || '').toString().slice(0, 64);
  const isDemo = body.isDemo === true;

  // If the caller supplied a specific PIN (4 digits), use that as the code.
  // This is the common path for classroom/family onboarding: the operator
  // picks a memorable PIN and hands it out verbally (e.g. "2020"). Fall
  // back to the random word-code generator when no PIN is supplied — useful
  // for one-shot guest access or when the operator doesn't care about
  // memorability.
  const pinRaw = (body.pin == null ? '' : String(body.pin)).trim();
  let code = '';
  if (pinRaw) {
    if (!/^\d{4}$/.test(pinRaw)) {
      return json({ error: 'invalid_pin', detail: 'PIN must be exactly 4 digits (0000-9999).' }, 400, corsOrigin);
    }
    const taken = await env.KV.get(`code:${pinRaw}`);
    if (taken) return json({ error: 'pin_taken', detail: 'That PIN is already in use by another classroom.' }, 409, corsOrigin);
    code = pinRaw;
  } else {
    // Try a few times in the unlikely event of a code collision.
    for (let i = 0; i < 5; i++) {
      const candidate = generateTenantCode();
      const taken = await env.KV.get(`code:${candidate}`);
      if (!taken) { code = candidate; break; }
    }
    if (!code) return json({ error: 'code_generation_failed' }, 500, corsOrigin);
  }

  const id = generateTenantId();
  const tenant = { id, label, code, teacherPassword, isDemo, createdAt: new Date().toISOString() };
  await env.KV.put(`tenant:${id}`, JSON.stringify(tenant));
  await env.KV.put(`code:${code}`, id);
  return json({ ok: true, tenant }, 200, corsOrigin);
}

// POST /unprovision — admin only. Body: { code } or { tenantId }.
// Wipes the tenant record, its code alias, and its data+snapshots blobs.
// Intentionally exposed via POST (with body) rather than DELETE on a
// REST path so we don't have to route on path segments and so curl
// examples stay symmetric with /provision.
async function handleUnprovisionRoute(request, env, corsOrigin) {
  if (!env.KV) return json({ error: 'kv_not_bound' }, 500, corsOrigin);
  if (!checkAdminAuth(request, env)) return json({ error: 'admin_unauthorized' }, 401, corsOrigin);
  let body = {};
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400, corsOrigin); }
  const code = (body.code || '').toString().trim().toLowerCase();
  let tenantId = (body.tenantId || '').toString().trim();
  if (!tenantId && code) {
    tenantId = (await env.KV.get(`code:${code}`)) || '';
  }
  if (!tenantId) return json({ error: 'not_found' }, 404, corsOrigin);

  // Fetch the current record so we can clean up the code alias even
  // if the caller only passed us a tenantId.
  const raw = await env.KV.get(`tenant:${tenantId}`);
  const existing = raw ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : null;
  const codeToWipe = (existing && existing.code) || code;

  await env.KV.delete(`tenant:${tenantId}`);
  await env.KV.delete(`tenant:${tenantId}:data`);
  await env.KV.delete(`tenant:${tenantId}:snapshots`);
  if (codeToWipe) await env.KV.delete(`code:${codeToWipe}`);
  return json({ ok: true, removed: { id: tenantId, code: codeToWipe || null } }, 200, corsOrigin);
}

// POST /auth — body: { code }. Returns full tenant metadata on hit, 401
// on miss. Failed attempts increment the per-IP rate-limit counter so
// brute-force attempts get throttled. Successful attempts do NOT
// reset the counter (avoid letting an attacker burn their counter via
// known-good codes).
async function handleAuthRoute(request, env, corsOrigin) {
  if (!env.KV) return json({ error: 'kv_not_bound' }, 500, corsOrigin);
  const ip = request.headers.get('cf-connecting-ip') || '';
  const pre = await rateLimitCheck(env, ip);
  if (!pre.ok) return json({ error: 'rate_limited', resetAt: pre.resetAt }, 429, corsOrigin);
  let body = {};
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400, corsOrigin); }
  const code = (body.code || '').toString().trim().toLowerCase();
  if (!code) return json({ error: 'missing_code' }, 400, corsOrigin);
  const tenant = await lookupTenantByCode(env, code);
  if (!tenant) {
    const after = await rateLimitAuthFailure(env, ip);
    return json({ error: 'invalid_code', remaining: after.remaining }, 401, corsOrigin);
  }
  return json({ ok: true, tenant }, 200, corsOrigin);
}

// GET /tenant — Bearer = code. Returns the tenant metadata. Used by
// the client on boot to refresh teacherPassword/label without
// requiring re-entry of the code.
async function handleTenantInfoRoute(request, env, corsOrigin) {
  if (!env.KV) return json({ error: 'kv_not_bound' }, 500, corsOrigin);
  const code = (extractBearer(request) || '').toLowerCase();
  const tenant = await lookupTenantByCode(env, code);
  if (!tenant) return json({ error: 'invalid_code' }, 401, corsOrigin);
  return json({ ok: true, tenant }, 200, corsOrigin);
}

// /data and /snapshots routing table — same shape as before, but the
// auth model is "Bearer = tenant code" and KV keys are namespaced by
// tenantId, not by ?env=.
const DATA_ROUTES = {
  'GET /data':      { kind: 'data',      read: true  },
  'POST /data':     { kind: 'data',      read: false },
  'GET /snapshots': { kind: 'snapshots', read: true  },
  'POST /snapshots':{ kind: 'snapshots', read: false },
};

async function handleDataRoute(request, env, corsOrigin, route) {
  if (!env.KV) return json({ error: 'kv_not_bound' }, 500, corsOrigin);
  const code = (extractBearer(request) || '').toLowerCase();
  const tenant = await lookupTenantByCode(env, code);
  if (!tenant) return json({ error: 'invalid_code' }, 401, corsOrigin);
  const key = `tenant:${tenant.id}:${route.kind}`;
  if (route.read) {
    const value = await env.KV.get(key);
    return new Response(value || '', {
      status: 200,
      headers: {
        ...corsHeaders(corsOrigin),
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  }
  const body = await request.text();
  if (body.length > DATA_MAX_BYTES) {
    return json({ error: 'payload_too_large', max_bytes: DATA_MAX_BYTES }, 413, corsOrigin);
  }
  await env.KV.put(key, body);
  return json({ ok: true, bytes: body.length, tenantId: tenant.id }, 200, corsOrigin);
}

// Routing table. Each entry binds a method+path to (feature flag,
// handler function). The handler runs only after the master flag +
// the feature flag are both on AND the input passes the length cap.
// Scaffolded handlers all point at `notYetImplemented(name)` which
// returns 503. Real implementations will replace those one by one
// as phases land.
const ROUTES = {
  // Phase A — real handlers.
  'POST /plan-parse':         { flag: 'FEATURE_PLAN_PARSE',         fn: handlePlanParse },
  'POST /explain':            { flag: 'FEATURE_EXPLAIN',            fn: handleExplain },
  'POST /feedback':           { flag: 'FEATURE_FEEDBACK',           fn: handleFeedback },
  'POST /simplify':           { flag: 'FEATURE_SIMPLIFY',           fn: handleSimplify },
  // Phase B — real handler for generate-questions; worked-example still stubbed.
  'POST /generate-questions': { flag: 'FEATURE_GENERATE_QUESTIONS', fn: handleGenerateQuestions },
  'POST /worked-example':     { flag: 'FEATURE_WORKED_EXAMPLE',     fn: notYetImplemented('worked-example') },
  // Phase C — scaffolded.
  'POST /teacher-summary':    { flag: 'FEATURE_TEACHER_SUMMARY',    fn: notYetImplemented('teacher-summary') },
  'POST /parent-report':      { flag: 'FEATURE_PARENT_REPORT',      fn: notYetImplemented('parent-report') },
  'POST /voice-clone':        { flag: 'FEATURE_VOICE_CLONE',        fn: notYetImplemented('voice-clone') },
  // Phase D — scaffolded.
  'POST /sidekick':           { flag: 'FEATURE_SIDEKICK',           fn: notYetImplemented('sidekick') },
  'POST /photo-extract':      { flag: 'FEATURE_PHOTO_EXTRACT',      fn: notYetImplemented('photo-extract') },
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowed = getAllowedOrigins(env);
    const corsOrigin = allowed.includes(origin) ? origin : '';

    // Preflight — browsers send this before any POST with a JSON body.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(corsOrigin) });
    }

    // Health is always on — the frontend polls it at page load to
    // figure out which AI UI elements to render. Returning flag state
    // here is what lets us ship UI that auto-hides when features are
    // off, without the frontend having to know the wrangler config.
    if (url.pathname === '/health' && request.method === 'GET') {
      return json(buildHealthPayload(env), 200, corsOrigin);
    }

    // Origin gate. An empty corsOrigin means the Origin header didn't
    // match the allow-list — block it so nobody can point a random
    // site at our Worker and drain API credits.
    if (!corsOrigin) {
      return json({ error: 'origin_not_allowed' }, 403, '');
    }

    // Tenant + data backend routes. Registered before the AI route
    // table so they bypass the AI_ENABLED gate, the per-feature flag
    // gate, and the AI input-length cap (data blobs are bigger and
    // have their own DATA_MAX_BYTES ceiling). Auth model differs
    // per route — see each handler.
    try {
      const routeKey = `${request.method} ${url.pathname}`;
      if (routeKey === 'POST /provision')   return await handleProvisionRoute(request, env, corsOrigin);
      if (routeKey === 'POST /unprovision') return await handleUnprovisionRoute(request, env, corsOrigin);
      if (routeKey === 'POST /auth')        return await handleAuthRoute(request, env, corsOrigin);
      if (routeKey === 'GET /tenant')       return await handleTenantInfoRoute(request, env, corsOrigin);
      const dataRoute = DATA_ROUTES[routeKey];
      if (dataRoute) return await handleDataRoute(request, env, corsOrigin, dataRoute);
    } catch (err) {
      console.error('tenant-route error', err && err.stack || err);
      return json({ error: 'internal_error' }, 500, corsOrigin);
    }

    // Route lookup. Unknown path → 404.
    const routeKey = `${request.method} ${url.pathname}`;
    const route = ROUTES[routeKey];
    if (!route) {
      return json({ error: 'not_found' }, 404, corsOrigin);
    }

    // Master kill-switch. When AI_ENABLED is off, every feature is
    // off regardless of its individual flag. This is the single
    // place to "disable all AI" without editing 11 flags.
    if (!isFlagOn(env, 'AI_ENABLED')) {
      return disabledResponse(
        'ai_globally_disabled',
        'AI_ENABLED is false. Flip it in wrangler.toml and redeploy.',
        corsOrigin,
      );
    }

    // Per-feature flag. Off → 503 with a reason, client falls back.
    if (!isFlagOn(env, route.flag)) {
      return disabledResponse(
        'feature_disabled',
        `${route.flag} is false. Flip it in wrangler.toml and redeploy.`,
        corsOrigin,
      );
    }

    // Length cap. Applied before any downstream work so a 10MB body
    // doesn't even buy a KV write, let alone an AI call.
    const maxInput = intEnv(env.MAX_INPUT_CHARS, DEFAULT_MAX_INPUT_CHARS);
    const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
    if (contentLength && contentLength > maxInput * 2) {
      // content-length is bytes; chars can be up to 4 bytes in UTF-8.
      // Using 2x as a loose upper bound for ASCII-heavy content.
      return json({ error: 'input_too_long', max_chars: maxInput }, 413, corsOrigin);
    }

    try {
      return await route.fn(request, env, ctx, corsOrigin);
    } catch (err) {
      // Handlers should catch their own errors, but belt-and-suspenders:
      // any uncaught throw becomes a 500 so the frontend falls back
      // instead of seeing a blank response.
      console.error('ai-proxy handler error', err && err.stack || err);
      return json({ error: 'internal_error' }, 500, corsOrigin);
    }
  },
};

// ---------- stub handler ----------

// Returns a 503 with a reason so the frontend's fallback kicks in.
// Consumes the request body (up to the cap) to validate length
// without keeping it — stubs shouldn't leak "we read your data"
// signals by holding on to it. Real handlers will parse + act.
function notYetImplemented(name) {
  return async (request, env, ctx, corsOrigin) => {
    const maxInput = intEnv(env.MAX_INPUT_CHARS, DEFAULT_MAX_INPUT_CHARS);
    let body = '';
    try {
      body = await request.text();
    } catch {
      // A failed read is fine here — nothing to process.
    }
    if (body.length > maxInput) {
      return json({ error: 'input_too_long', max_chars: maxInput }, 413, corsOrigin);
    }
    return disabledResponse(
      'not_implemented',
      `Endpoint /${name} is scaffolded but the handler hasn't been wired yet. ` +
      `This is the expected state until its phase ships.`,
      corsOrigin,
    );
  };
}

// ==========================================================================
// PHASE A HANDLERS
// ==========================================================================
// All four share the same flow: parse body → daily-cap + cache → Claude
// call → parse/validate response → cache-and-audit → return. The shared
// `runStandardHandler` below factors that out so each handler just
// supplies (a) how to read inputs, (b) the prompts, (c) how to post-
// process the model's text.

// ---- /plan-parse -------------------------------------------------------
// Tutor prose → structured toggle JSON. The response shape is a plain
// object of known-key booleans + an optional `extendedTime` number.
// Unknown keys are discarded on the client side (see attachAiParseNotes
// in index.html), so we're forgiving with what the model returns — but
// we still cap it to the schema we advertise.
async function handlePlanParse(request, env, ctx, corsOrigin) {
  return runStandardHandler({
    request, env, ctx, corsOrigin,
    endpoint: '/plan-parse',
    readInputs: async (body) => ({
      notes: String(body.notes || '').trim().slice(0, 2000),
      planType: String(body.planType || 'none'),
      availableKeys: Array.isArray(body.availableKeys)
        ? body.availableKeys.filter(k => typeof k === 'string').slice(0, 20)
        : ['shortSessions','earlyBridge','noTimer','alwaysTTS','avoidPassages','autoStretch','simpleLanguage'],
    }),
    validate: ({ notes }) => notes ? null : { error: 'missing_notes' },
    cacheKey: ({ notes, planType }) => hashKey('plan-parse', notes, planType),
    cacheTtlSeconds: 7 * 24 * 3600, // 7 days — tutor notes rarely re-parse before a plan edit
    maxTokens: 350,
    buildSystemPrompt: () => (
      'You translate free-form tutor notes about a student into a small set of ' +
      'structured accommodations for a kids\' learning app.\n\n' +
      'Output STRICT JSON ONLY, no prose, no markdown fences. Shape:\n' +
      '{\n' +
      '  "toggles": { "shortSessions": boolean, "earlyBridge": boolean, ' +
      '"noTimer": boolean, "alwaysTTS": boolean, "avoidPassages": boolean, ' +
      '"autoStretch": boolean, "simpleLanguage": boolean },\n' +
      '  "extendedTime": number,   // one of 1.0, 1.2, 1.3, 1.5, 2.0\n' +
      '  "reasoning": string       // one short sentence, plain English\n' +
      '}\n\n' +
      'Toggle meanings:\n' +
      '- shortSessions: cap activities at 3 questions. Use for focus/stamina notes.\n' +
      '- earlyBridge: drop to easier questions after 1 wrong. Use for fragile learners.\n' +
      '- noTimer: remove the per-question countdown. Use for anxiety/timer-stress notes.\n' +
      '- alwaysTTS: auto-enable read-aloud. Use for ESL/early reader/decoding notes.\n' +
      '- avoidPassages: skip long reading passages + long write prompts. Use for reading-fatigue notes.\n' +
      '- autoStretch: unlock harder questions after any completion (not just perfect). Use for gifted/bored notes.\n' +
      '- simpleLanguage: rewrite prompts in simpler words (when FEATURE_SIMPLIFY is on). Use for ESL notes.\n\n' +
      'extendedTime: 1.0 standard, 1.2 mild ESL, 1.3 typical IEP, 1.5 significant IEP, 2.0 severe.\n\n' +
      'Omit any toggle you are not confident the notes support. Do not invent concerns.'
      // Kid-safety: these notes are written BY a tutor ABOUT a student, so the
      // output still reaches a shared dashboard. Same banned-topic rules apply
      // to the `reasoning` string we echo back. No CURRICULUM_ALIGNMENT_RULES
      // here — this endpoint parses prose about a learner, not lesson content.
      + KID_SAFE_RULES
    ),
    buildUserPrompt: ({ notes, planType, availableKeys }) => (
      'Plan type: ' + planType + '\n' +
      'Available toggle keys: ' + availableKeys.join(', ') + '\n\n' +
      'Tutor notes:\n"""\n' + notes + '\n"""\n\n' +
      'Return the JSON now.'
    ),
    postProcess: (text) => {
      const parsed = parseJsonFromText(text);
      if (!parsed || typeof parsed !== 'object') {
        return { error: 'parse_failed', raw: text.slice(0, 200) };
      }
      // Normalise: only allow known keys through, coerce to boolean.
      const KNOWN = new Set(['shortSessions','earlyBridge','noTimer','alwaysTTS','avoidPassages','autoStretch','simpleLanguage']);
      const toggles = {};
      if (parsed.toggles && typeof parsed.toggles === 'object') {
        for (const k of Object.keys(parsed.toggles)) {
          if (KNOWN.has(k)) toggles[k] = !!parsed.toggles[k];
        }
      }
      const out = { toggles };
      // Extended time: snap to allowed steps.
      const ALLOWED_EXT = [1.0, 1.2, 1.3, 1.5, 2.0];
      if (typeof parsed.extendedTime === 'number') {
        let best = 1.0, dist = Infinity;
        for (const s of ALLOWED_EXT) {
          const d = Math.abs(s - parsed.extendedTime);
          if (d < dist) { dist = d; best = s; }
        }
        out.extendedTime = best;
      }
      if (typeof parsed.reasoning === 'string') {
        out.reasoning = parsed.reasoning.slice(0, 240);
      }
      return out;
    },
    auditSummary: (inputs, out) => {
      const n = out && out.toggles ? Object.keys(out.toggles).filter(k => out.toggles[k]).length : 0;
      return `plan-parse → ${n} toggle(s), extT=${out && out.extendedTime || '—'}`;
    },
  });
}

// ---- /explain ----------------------------------------------------------
// "Why was this wrong?" — 2-3 sentences of kid-friendly explanation.
// Cache key is (question + correct answer + grade level) because the
// same wrong guess on the same question should always give the same
// explanation. We don't cache by the specific wrong answer because the
// vast majority of wrongs are "anything that isn't the right answer"
// and re-prompting for each wrong pick burns API for no benefit.
async function handleExplain(request, env, ctx, corsOrigin) {
  return runStandardHandler({
    request, env, ctx, corsOrigin,
    endpoint: '/explain',
    readInputs: async (body) => ({
      questionType: String(body.questionType || 'unknown').slice(0, 40),
      prompt: String(body.prompt || '').trim().slice(0, 600),
      choices: Array.isArray(body.choices) ? body.choices.slice(0, 6).map(c => String(c).slice(0, 120)) : null,
      correctAnswer: body.correctAnswer,
      gradeContext: String(body.gradeContext || '').slice(0, 40),
      curriculum: (body.curriculum && typeof body.curriculum === 'object') ? body.curriculum : null,
    }),
    validate: ({ prompt }) => prompt ? null : { error: 'missing_prompt' },
    cacheKey: ({ prompt, choices, correctAnswer, gradeContext, curriculum }) =>
      hashKey(
        'explain',
        prompt,
        JSON.stringify(choices || []),
        String(correctAnswer),
        gradeContext,
        curriculum ? JSON.stringify({g:curriculum.grade, s:curriculum.strand, c:curriculum.codes}) : ''
      ),
    cacheTtlSeconds: 30 * 24 * 3600,
    maxTokens: 200,
    buildSystemPrompt: () => (
      'You explain why a quiz answer is the correct one, in a warm, encouraging ' +
      'way, for a child. Rules:\n' +
      '- 2 to 3 short sentences max.\n' +
      '- Match the student\'s grade level: use simple words for K-2, slightly richer for 3-5, solid for 6+.\n' +
      '- Do NOT lecture. Do NOT say "you got it wrong." Just explain the concept briefly and point to the right choice.\n' +
      '- Never mention the student\'s name, the wrong choice specifically, or any identifying detail.\n' +
      '- Output plain text only — no JSON, no markdown.'
      + KID_SAFE_RULES
      + CURRICULUM_ALIGNMENT_RULES
    ),
    buildUserPrompt: ({ questionType, prompt, choices, correctAnswer, gradeContext, curriculum }) => {
      let p = buildCurriculumBlock(curriculum || { grade: gradeContext }) + '\n\n';
      p += 'Question type: ' + questionType + '\n';
      p += 'Question: ' + prompt + '\n';
      if (choices && choices.length) {
        p += 'Choices:\n';
        choices.forEach((c, i) => { p += '  ' + i + '. ' + c + '\n'; });
        if (typeof correctAnswer === 'number' && choices[correctAnswer] !== undefined) {
          p += 'Correct choice: ' + correctAnswer + ' (' + choices[correctAnswer] + ')\n';
        }
      } else if (correctAnswer !== null && correctAnswer !== undefined) {
        p += 'Correct answer: ' + String(correctAnswer) + '\n';
      }
      p += '\nWrite the explanation now.';
      return p;
    },
    postProcess: (text) => ({ explanation: (text || '').trim().slice(0, 500) }),
    auditSummary: (inputs) => `explain → Q="${(inputs.prompt||'').slice(0, 60)}"`,
  });
}

// ---- /feedback ---------------------------------------------------------
// Writing coach. We do NOT cache this — each student's writing is
// unique, and caching would accidentally show one kid's feedback to
// another if their text happened to collide. Cost per call is tiny
// (~$0.001 on Haiku) so skipping the cache is fine.
async function handleFeedback(request, env, ctx, corsOrigin) {
  return runStandardHandler({
    request, env, ctx, corsOrigin,
    endpoint: '/feedback',
    readInputs: async (body) => ({
      text: String(body.text || '').trim().slice(0, 3000),
      prompt: String(body.prompt || '').slice(0, 600),
      minWords: Number(body.minWords || 0),
      goodWords: Number(body.goodWords || 0),
      rubricLevel: Number(body.rubricLevel || 0),
      rubricNotes: String(body.rubricNotes || '').slice(0, 300),
      gradeContext: String(body.gradeContext || '').slice(0, 40),
      curriculum: (body.curriculum && typeof body.curriculum === 'object') ? body.curriculum : null,
    }),
    validate: ({ text }) => text ? null : { error: 'missing_text' },
    cacheKey: null, // don't cache — see comment above
    maxTokens: 400,
    buildSystemPrompt: () => (
      'You are a warm, specific writing coach for a child. Given the student\'s short ' +
      'writing, the prompt they were answering, and a baseline rubric score, reply with ' +
      'STRICT JSON ONLY (no prose, no markdown fences). Shape:\n' +
      '{\n' +
      '  "strength": string,        // one specific thing that is working, 1 sentence\n' +
      '  "suggestion": string,      // one specific thing to try next time, 1 sentence, actionable\n' +
      '  "exampleRewrite": string   // optional — rewrite ONE sentence from the student\'s ' +
      'text into a stronger version. Omit if not helpful.\n' +
      '}\n\n' +
      'Rules:\n' +
      '- Match the grade level: K-2 very simple words, 3-5 friendly, 6+ solid.\n' +
      '- Be specific — name something concrete the student did.\n' +
      '- Never scold. Never mention spelling errors unless they block meaning.\n' +
      '- Never mention the student\'s name or any identifying detail.\n' +
      '- Feedback must reinforce the Ontario Curriculum expectation below — suggestions ' +
      'should pull the student toward the tagged skill, not a different one.'
      + KID_SAFE_RULES
      + CURRICULUM_ALIGNMENT_RULES
    ),
    buildUserPrompt: ({ text, prompt, minWords, goodWords, rubricLevel, rubricNotes, gradeContext, curriculum }) => (
      buildCurriculumBlock(curriculum || { grade: gradeContext }) + '\n\n' +
      'Prompt they answered: ' + (prompt || '(none)') + '\n' +
      'Target length: ' + minWords + '–' + goodWords + ' words\n' +
      'Rubric level (1-4): ' + rubricLevel + '\n' +
      'Rubric auto-notes: ' + (rubricNotes || '(none)') + '\n\n' +
      'Student writing:\n"""\n' + text + '\n"""\n\n' +
      'Return the JSON now.'
    ),
    postProcess: (text) => {
      const parsed = parseJsonFromText(text);
      if (!parsed || typeof parsed !== 'object') {
        return { error: 'parse_failed', raw: (text || '').slice(0, 200) };
      }
      const out = {};
      if (typeof parsed.strength === 'string') out.strength = parsed.strength.slice(0, 300);
      if (typeof parsed.suggestion === 'string') out.suggestion = parsed.suggestion.slice(0, 300);
      if (typeof parsed.exampleRewrite === 'string' && parsed.exampleRewrite.trim()) {
        out.exampleRewrite = parsed.exampleRewrite.slice(0, 300);
      }
      return out;
    },
    auditSummary: (inputs) => `feedback → ${(inputs.text||'').split(/\s+/).filter(Boolean).length}w, lv=${inputs.rubricLevel}`,
  });
}

// ---- /simplify ---------------------------------------------------------
// Rewrite a question, writing prompt, or lesson intro in simpler English.
// Cached aggressively — the same (prompt, curriculum) always gives the
// same rewrite. Curriculum alignment is mandatory: the simpler version
// must still teach the same Ontario expectation at the same grade level.
async function handleSimplify(request, env, ctx, corsOrigin) {
  return runStandardHandler({
    request, env, ctx, corsOrigin,
    endpoint: '/simplify',
    readInputs: async (body) => ({
      prompt: String(body.prompt || '').trim().slice(0, 600),
      gradeContext: String(body.gradeContext || '').slice(0, 40),
      // Full Ontario Curriculum tag for alignment enforcement. Accepted
      // as an optional object; a missing curriculum triggers the
      // conservative fallback in buildCurriculumBlock().
      curriculum: (body.curriculum && typeof body.curriculum === 'object') ? body.curriculum : null,
    }),
    validate: ({ prompt }) => prompt ? null : { error: 'missing_prompt' },
    // Cache key includes curriculum so a "simplify to Grade 1" and a
    // "simplify to Grade 4" of the same text don't collide.
    cacheKey: ({ prompt, gradeContext, curriculum }) => hashKey(
      'simplify',
      prompt,
      gradeContext,
      curriculum ? JSON.stringify({g:curriculum.grade, s:curriculum.strand, c:curriculum.codes}) : ''
    ),
    cacheTtlSeconds: 30 * 24 * 3600,
    maxTokens: 200,
    buildSystemPrompt: () => (
      'You rewrite a single lesson intro, quiz question, or writing prompt in simpler ' +
      'English for an ESL or early-reader child. Rules:\n' +
      '- Keep the meaning identical and the CONCEPT BEING TAUGHT identical.\n' +
      '- Use common, short words. Lower the reading floor by one grade level while ' +
      'staying within the curriculum\'s expected vocabulary ceiling.\n' +
      '- Keep the length the same or shorter.\n' +
      '- Output the rewritten text as plain text only — no JSON, no quotes, no prefix.'
      + KID_SAFE_RULES
      + CURRICULUM_ALIGNMENT_RULES
    ),
    buildUserPrompt: ({ prompt, gradeContext, curriculum }) => (
      buildCurriculumBlock(curriculum || { grade: gradeContext }) + '\n\n' +
      'Original text:\n' + prompt + '\n\n' +
      'Write the simpler version now.'
    ),
    postProcess: (text) => ({ simplified: (text || '').trim().slice(0, 600) }),
    auditSummary: (inputs) => `simplify → g=${(inputs.curriculum && inputs.curriculum.grade) || inputs.gradeContext || '?'} "${(inputs.prompt||'').slice(0, 40)}"`,
  });
}

// ---- /generate-questions -----------------------------------------------
// Generates harder MCQ variants for a student on `autoStretch`. The input
// carries the activity's existing questions so the model learns the
// shape, style, and difficulty floor — and its job is to push ONE STEP
// harder without jumping out of the stated curriculum expectation.
//
// Strict JSON output enforced by postProcess. A malformed or
// schema-breaking response returns parse_failed (no cache write), so the
// frontend falls back to the tutor-authored stretchQuestions pool if
// present.
//
// NOTE: every generated question is then gated through the tutor approval
// panel before any student sees it — this handler just produces candidates.
async function handleGenerateQuestions(request, env, ctx, corsOrigin) {
  return runStandardHandler({
    request, env, ctx, corsOrigin,
    endpoint: '/generate-questions',
    readInputs: async (body) => ({
      // Curriculum is REQUIRED — question generation without a grade
      // anchor is how you end up with "factor the polynomial" on a
      // Grade 2 lesson. validate() enforces this below.
      curriculum: (body.curriculum && typeof body.curriculum === 'object') ? body.curriculum : null,
      // Existing base questions — 3-5 of them is plenty. The model
      // needs shape + topic, not the whole pool.
      existingQuestions: Array.isArray(body.existingQuestions)
        ? body.existingQuestions.slice(0, 6).map(q => ({
            q: String(q.q || '').slice(0, 400),
            choices: Array.isArray(q.choices) ? q.choices.slice(0, 6).map(c => String(c).slice(0, 120)) : [],
            answer: typeof q.answer === 'number' ? q.answer : null,
          }))
        : [],
      // How many new questions to generate. Capped at 5 so a buggy
      // frontend can't request War-and-Peace-sized outputs.
      count: Math.max(1, Math.min(5, Number(body.count) || 3)),
      // Lesson context — title + intro help the model stay on-topic
      // for lessons whose questions are terse ("3 + 4 = ?" alone
      // doesn't convey "we're learning single-digit sums").
      lessonTitle: String(body.lessonTitle || '').slice(0, 160),
      lessonIntro: String(body.lessonIntro || '').slice(0, 600),
      // Difficulty hint is informational — the prompt already says
      // "one step harder than the existing pool" — but we pass it
      // through for audit + future tunability.
      difficulty: String(body.difficulty || 'stretch').slice(0, 20),
    }),
    validate: ({ curriculum, existingQuestions }) => {
      if (!curriculum || !curriculum.grade) return { error: 'missing_curriculum' };
      if (!existingQuestions.length) return { error: 'missing_existing_questions' };
      return null;
    },
    // Cache key folds in curriculum + a digest of the first couple of
    // existing questions + count + difficulty. Two lessons with the
    // same curriculum but different question styles should not collide.
    cacheKey: ({ curriculum, existingQuestions, count, difficulty }) => hashKey(
      'generate-questions',
      JSON.stringify({g:curriculum.grade, s:curriculum.strand, c:curriculum.codes}),
      JSON.stringify(existingQuestions.slice(0, 3).map(q => ({q:q.q, a:q.answer}))),
      String(count),
      difficulty
    ),
    cacheTtlSeconds: 30 * 24 * 3600,
    maxTokens: 900,
    buildSystemPrompt: () => (
      'You generate harder practice questions for a child on a "stretch" / gifted plan. ' +
      'Given the curriculum tag and an example pool of base-difficulty MCQ questions, ' +
      'produce NEW questions that are ONE step harder — testing the same Ontario ' +
      'Curriculum expectation at a more demanding level.\n\n' +
      'Output STRICT JSON ONLY (no prose, no markdown fences). Shape:\n' +
      '{\n' +
      '  "questions": [\n' +
      '    { "q": string, "choices": [string, string, string, string], "answer": integer }\n' +
      '  ]\n' +
      '}\n\n' +
      'Hard rules:\n' +
      '- Return the exact number of questions requested — no more, no fewer.\n' +
      '- Every question MUST be "mcq" shape: exactly 4 choices.\n' +
      '- `answer` is a 0-based index into `choices` and MUST be correct. Double-check arithmetic before writing it.\n' +
      '- Distractors must be plausible wrong answers a kid might pick — common mistakes, off-by-one, sign errors. Not random text.\n' +
      '- Do NOT reuse the example questions verbatim. Fresh problems, same concept.\n' +
      '- Stay INSIDE the tagged curriculum expectation. Do not drift to a different strand.\n' +
      '- No word problems that require reading at a higher grade than the tagged grade.\n' +
      '- No culturally-specific references (names, places) the kid might not know.\n' +
      '- No trick questions — "stretch" means harder concept, not trickier wording.'
      + KID_SAFE_RULES
      + CURRICULUM_ALIGNMENT_RULES
    ),
    buildUserPrompt: ({ curriculum, existingQuestions, count, lessonTitle, lessonIntro, difficulty }) => {
      let p = buildCurriculumBlock(curriculum) + '\n\n';
      if (lessonTitle) p += 'Lesson: ' + lessonTitle + '\n';
      if (lessonIntro) p += 'Lesson intro:\n"""\n' + lessonIntro + '\n"""\n\n';
      p += 'Base-difficulty example pool (' + existingQuestions.length + ' shown):\n';
      existingQuestions.forEach((q, i) => {
        p += '\n  Example ' + (i + 1) + ':\n';
        p += '    q: ' + q.q + '\n';
        q.choices.forEach((c, j) => {
          const marker = (j === q.answer) ? ' ← correct' : '';
          p += '    [' + j + '] ' + c + marker + '\n';
        });
      });
      p += '\nDifficulty target: ' + difficulty + ' (one step harder than the pool above).\n';
      p += 'Generate exactly ' + count + ' new question(s) now. Return the JSON.';
      return p;
    },
    postProcess: (text) => {
      const parsed = parseJsonFromText(text);
      if (!parsed || typeof parsed !== 'object') {
        return { error: 'parse_failed', raw: (text || '').slice(0, 200) };
      }
      if (!Array.isArray(parsed.questions)) {
        return { error: 'parse_failed', raw: 'no questions array' };
      }
      const questions = [];
      for (const raw of parsed.questions) {
        if (!raw || typeof raw !== 'object') continue;
        const q = String(raw.q || '').trim();
        if (!q || q.length > 500) continue;
        if (!Array.isArray(raw.choices) || raw.choices.length !== 4) continue;
        const choices = raw.choices.map(c => String(c || '').trim().slice(0, 180));
        if (choices.some(c => !c)) continue;
        const answer = Number(raw.answer);
        if (!Number.isInteger(answer) || answer < 0 || answer > 3) continue;
        // Detect duplicate choices — a lazy model may emit ["12","12","14","15"]
        // which makes the "correct" answer ambiguous.
        const uniqChoices = new Set(choices);
        if (uniqChoices.size !== 4) continue;
        questions.push({ type: 'mcq', q, choices, answer });
      }
      if (!questions.length) {
        return { error: 'parse_failed', raw: 'all questions failed schema check' };
      }
      return { questions };
    },
    auditSummary: (inputs, out) => {
      const n = (out && Array.isArray(out.questions)) ? out.questions.length : 0;
      const g = (inputs.curriculum && inputs.curriculum.grade) || '?';
      return `generate-questions → ${n}q, ${g}, ${inputs.difficulty}`;
    },
  });
}

// ---- Shared flow wrapper ----------------------------------------------
// All Phase A handlers run through this. Guarantees consistent behavior
// around: input parsing + length cap, cache-check-before-cap, daily cap
// enforcement, Claude call with timeout, response post-processing,
// cache write + audit log, and uniform JSON response shape. Each
// handler supplies the handful of pieces unique to it.
//
// Return-shape contract (what the frontend sees):
//   200 { ok:true, data:{...}, cached?:true }
//   413 { error:'input_too_long', max_chars }
//   400 { error:'missing_x' }  (from validate)
//   429 { error:'rate_limited', used, cap }
//   500 { error:'missing_api_key' | 'upstream_failed' }
//   503 is handled earlier in fetch() before we get here.
async function runStandardHandler({
  request, env, ctx, corsOrigin,
  endpoint,
  readInputs,           // async (body) => inputs
  validate,             // (inputs) => null | {error}
  cacheKey,             // (inputs) => string | null
  cacheTtlSeconds,      // number — how long to keep cache entries
  maxTokens,            // number — Claude max_tokens for this endpoint
  buildSystemPrompt,    // () => string
  buildUserPrompt,      // (inputs) => string
  postProcess,          // (text) => out object (may include {error})
  auditSummary,         // (inputs, out) => string (short gist)
}) {
  const maxInput = intEnv(env.MAX_INPUT_CHARS, DEFAULT_MAX_INPUT_CHARS);
  // Parse body.
  let raw;
  try { raw = await request.text(); } catch { raw = ''; }
  if (raw.length > maxInput) {
    return json({ error: 'input_too_long', max_chars: maxInput }, 413, corsOrigin);
  }
  let body = {};
  if (raw) {
    try { body = JSON.parse(raw); } catch { return json({ error: 'invalid_json' }, 400, corsOrigin); }
  }
  const inputs = await readInputs(body);
  // Per-handler validation (e.g. required fields).
  const vErr = validate ? validate(inputs) : null;
  if (vErr) return json(vErr, 400, corsOrigin);
  // Identify the student for cap + audit. Prefer the X-Student-Id
  // header (set by the frontend), fall back to anonymous — which
  // means the cap applies globally for this call.
  const studentId = request.headers.get('X-Student-Id') || 'anon';
  // Cache lookup FIRST — a hit is free so it shouldn't count against
  // the kid's daily budget.
  const key = typeof cacheKey === 'function' ? cacheKey(inputs) : null;
  if (key) {
    const cached = await cacheGet(env, key);
    if (cached) {
      return json({ ok: true, cached: true, data: cached }, 200, corsOrigin);
    }
  }
  // Daily cap. Now increment — cache missed, we're about to spend.
  const gate = await checkDailyCap(env, studentId);
  if (!gate.ok) {
    return json({ error: 'rate_limited', reason: gate.reason, used: gate.used, cap: gate.cap }, 429, corsOrigin);
  }
  // Claude call.
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: 'missing_api_key', reason: 'Run `wrangler secret put ANTHROPIC_API_KEY` to enable.' }, 500, corsOrigin);
  }
  let modelText;
  try {
    modelText = await callClaude(env, {
      system: buildSystemPrompt(),
      user: buildUserPrompt(inputs),
      maxTokens: maxTokens || 300,
    });
  } catch (err) {
    console.error('claude call failed', endpoint, err && err.message);
    return json({ error: 'upstream_failed', detail: String(err && err.message || err).slice(0, 200) }, 502, corsOrigin);
  }
  // Handler-specific post-processing.
  const out = postProcess(modelText);
  if (out && out.error) {
    // Model returned unparseable output — treat as upstream failure
    // so the frontend falls back gracefully.
    return json({ error: 'parse_failed', detail: out.error }, 502, corsOrigin);
  }
  // ---- Kid-safety Layer 2: content blocklist scan ---------------------
  // Runs on every string field in the output. A single hit → 422 + audit
  // entry + NO cache write (so the bad generation isn't reused). The
  // blocked text never reaches the frontend; we only return the category
  // of violation + a short snippet for the teacher-facing error log.
  const safetyHit = scanOutputForBannedContent(out);
  if (safetyHit) {
    console.warn('ai-proxy content_blocked', endpoint, safetyHit);
    try {
      if (ctx && typeof ctx.waitUntil === 'function' && env.KV) {
        ctx.waitUntil(recordAudit(env, studentId, endpoint, 'BLOCKED: ' + safetyHit.field + ' ~ ' + safetyHit.match));
      }
    } catch(_){}
    return json({ error: 'content_blocked', field: safetyHit.field }, 422, corsOrigin);
  }
  // ---- Curriculum alignment Layer 2: refusal sentinel -----------------
  // If the model decided the requested edit would violate the curriculum
  // tag, it outputs CURRICULUM_VIOLATION per the alignment rules. Surface
  // this to the frontend as a distinct 422 so the teacher sees "AI
  // declined because this would go outside the grade/strand" instead of
  // a generic error.
  if (scanOutputForCurriculumViolation(out)) {
    console.warn('ai-proxy curriculum_violation', endpoint);
    try {
      if (ctx && typeof ctx.waitUntil === 'function' && env.KV) {
        ctx.waitUntil(recordAudit(env, studentId, endpoint, 'CURRICULUM_VIOLATION refusal'));
      }
    } catch(_){}
    return json({ error: 'curriculum_violation' }, 422, corsOrigin);
  }
  // Cache + audit. Waitable but we want the cache write to complete
  // so the next request benefits; audit can fire-and-forget.
  if (key && cacheTtlSeconds) {
    try { await cachePut(env, key, out, cacheTtlSeconds); } catch(_){}
  }
  try {
    const summary = typeof auditSummary === 'function' ? auditSummary(inputs, out) : endpoint;
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(recordAudit(env, studentId, endpoint, summary));
    } else {
      // No ctx (shouldn't happen in prod, but defensive in tests).
      await recordAudit(env, studentId, endpoint, summary);
    }
  } catch(_){}
  return json({ ok: true, data: out }, 200, corsOrigin);
}

// ---- Claude API call ---------------------------------------------------
// Thin wrapper around the Messages endpoint. Returns the first text
// content block. Throws on non-2xx so the caller can return 502.
// Model is configurable via env.ANTHROPIC_MODEL so updating when
// Anthropic releases a new Haiku is a wrangler.toml edit, not a
// code change.
async function callClaude(env, { system, user, maxTokens }) {
  const model = env.ANTHROPIC_MODEL || 'claude-haiku-4-5';
  const url = 'https://api.anthropic.com/v1/messages';
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 20000); // 20s hard ceiling
  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens || 300,
        system,
        messages: [{ role: 'user', content: user }],
      }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(to);
  }
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.text()).slice(0, 300); } catch(_){}
    throw new Error('claude ' + r.status + ' ' + detail);
  }
  const j = await r.json();
  // Messages API returns { content: [{ type: 'text', text: '...' }, ...] }.
  // We only look at the first text block.
  if (!j || !Array.isArray(j.content)) throw new Error('claude: unexpected response shape');
  const first = j.content.find(b => b && b.type === 'text');
  if (!first) throw new Error('claude: no text block in response');
  return String(first.text || '');
}

// ---- JSON extraction --------------------------------------------------
// Claude sometimes wraps JSON in ```json ... ``` fences despite
// instructions. Strip those before parsing. Returns null on anything
// that doesn't parse — caller decides whether that's fatal.
function parseJsonFromText(text) {
  if (!text) return null;
  let t = String(text).trim();
  // Strip markdown fence if present.
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  // Some models wrap the JSON in "Here's the JSON: {...}" — extract
  // the first {...} block if the whole string doesn't parse.
  try { return JSON.parse(t); } catch {}
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch {}
  }
  return null;
}

// ---- Cache key hashing -------------------------------------------------
// SHA-256 over the join of all parts, truncated to 16 hex chars. That's
// 64 bits of collision resistance — plenty for this cache's size.
// Synchronous interface by awaiting subtle.digest inline.
async function hashKey(...parts) {
  const msg = parts.map(p => String(p == null ? '' : p)).join('\u0001');
  const buf = new TextEncoder().encode(msg);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(hash);
  let out = '';
  for (let i = 0; i < 8; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

// ---------- helpers exported for future feature handlers ----------

// Per-student daily cap. Increments the counter in KV and returns
// { ok, used, cap }. When ok is false, the caller should return
// 429. Real feature handlers will call this AFTER basic validation
// but BEFORE the AI call. The scaffolded stubs don't call it — a
// disabled endpoint shouldn't penalize the kid's quota.
//
// Exported via the env namespace convention for future handlers:
//    const gate = await checkDailyCap(env, studentId);
//    if (!gate.ok) return json({ error: 'rate_limited', ...gate }, 429, origin);
//
// If KV isn't bound (e.g. in local dev without `--kv`), returns
// { ok: true, used: 0, cap: 0, unlimited: true } — fail-open. For a
// kids-site demo this is the right tradeoff; in hostile production
// we'd fail-closed.
async function checkDailyCap(env, studentId) {
  if (!env.KV) return { ok: true, used: 0, cap: 0, unlimited: true };
  if (!studentId) return { ok: false, reason: 'missing_student_id' };
  const cap = intEnv(env.DAILY_CAP_PER_STUDENT, DEFAULT_DAILY_CAP_PER_STUDENT);
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const key = `daily:${studentId}:${today}`;
  const raw = await env.KV.get(key);
  const used = parseInt(raw || '0', 10) || 0;
  if (used >= cap) {
    return { ok: false, reason: 'daily_cap_reached', used, cap };
  }
  await env.KV.put(key, String(used + 1), {
    expirationTtl: 2 * 24 * 3600, // 2 days; covers any timezone drift
  });
  return { ok: true, used: used + 1, cap };
}

// Append a short audit record so tutors can later review what the
// AI told the kid. 30-day retention. Keep the `summary` short — this
// is for "here's the gist," not full transcripts. The real transcript,
// if it needs to exist at all, belongs in a separate log pipeline.
async function recordAudit(env, studentId, endpoint, summary) {
  if (!env.KV) return;
  if (!studentId) return;
  const ts = Date.now();
  const key = `audit:${studentId}:${ts}`;
  const payload = {
    ts,
    endpoint,
    summary: typeof summary === 'string' ? summary.slice(0, 500) : '',
  };
  try {
    await env.KV.put(key, JSON.stringify(payload), {
      expirationTtl: 30 * 24 * 3600,
    });
  } catch (err) {
    // Audit write failure shouldn't break the user-facing call.
    console.warn('audit write failed', err);
  }
}

// Look up a cached response by content-hash key. Returns null on
// miss. Real handlers will use this as the first step:
//    const cached = await cacheGet(env, key);
//    if (cached) return cached;
async function cacheGet(env, key) {
  if (!env.KV) return null;
  try {
    const raw = await env.KV.get(`cache:${key}`);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function cachePut(env, key, value, ttlSeconds) {
  if (!env.KV) return;
  try {
    await env.KV.put(`cache:${key}`, JSON.stringify(value), {
      expirationTtl: ttlSeconds || 30 * 24 * 3600,
    });
  } catch (err) {
    console.warn('cache write failed', err);
  }
}

// Expose helpers for future handlers. Attached to the module scope
// so we can reference them when we replace notYetImplemented stubs.
// Not exported — Workers don't use imports across files.
// (Kept here for discoverability.)
// eslint-disable-next-line no-unused-vars
const _internalHelpers = { checkDailyCap, recordAudit, cacheGet, cachePut };

// ---------- response helpers ----------

// 503 with a structured body. Frontend contract: any 5xx from this
// Worker means "use your non-AI fallback path, don't retry hot."
function disabledResponse(code, reason, corsOrigin) {
  return json({
    error: 'feature_disabled',
    code,
    reason,
    fallback: 'client should use its non-AI fallback path',
  }, 503, corsOrigin);
}

function buildHealthPayload(env) {
  const features = {};
  for (const flag of FEATURE_FLAGS) {
    features[flag] = isFlagOn(env, flag);
  }
  return {
    ok: true,
    service: 'kidquest-ai-proxy',
    ai_enabled: isFlagOn(env, 'AI_ENABLED'),
    has_anthropic_key: !!env.ANTHROPIC_API_KEY,
    has_openai_key: !!env.OPENAI_API_KEY,
    has_elevenlabs_key: !!env.ELEVENLABS_API_KEY,
    kv_bound: !!env.KV,
    // Tenant backend (Phase 0b) — KV must be bound for /auth, /data,
    // /snapshots; ADMIN_TOKEN must be set for /provision. Surfaced
    // here so the deploy checklist can curl /health and confirm
    // everything is wired before provisioning the first tenant.
    tenant_backend_ready: !!env.KV,
    admin_provision_ready: !!(env.KV && env.ADMIN_TOKEN),
    features,
    caps: {
      max_input_chars: intEnv(env.MAX_INPUT_CHARS, DEFAULT_MAX_INPUT_CHARS),
      daily_cap_per_student: intEnv(env.DAILY_CAP_PER_STUDENT, DEFAULT_DAILY_CAP_PER_STUDENT),
    },
  };
}

function getAllowedOrigins(env) {
  if (env.ALLOWED_ORIGINS && typeof env.ALLOWED_ORIGINS === 'string') {
    return env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
  }
  return DEFAULT_ALLOWED_ORIGINS;
}

function corsHeaders(origin) {
  const h = {
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    // `authorization` is required by the data backend routes (Phase 0a
    // bearer-token auth). Browsers omit it from cross-origin requests
    // unless explicitly listed in the preflight's allow-headers.
    'access-control-allow-headers': 'content-type, x-student-id, authorization',
    'access-control-max-age': '86400',
    'vary': 'Origin',
  };
  if (origin) h['access-control-allow-origin'] = origin;
  return h;
}

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      ...corsHeaders(origin),
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

// Env vars are strings. Accept "true" (case-insensitive) as truthy
// and everything else as falsy. Intentional: `"false"` and `""` and
// `undefined` all mean off, which is the safe default.
function isFlagOn(env, name) {
  const v = env[name];
  if (v === true) return true;
  if (typeof v === 'string') return v.trim().toLowerCase() === 'true';
  return false;
}

function intEnv(value, fallback) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = parseInt(value, 10);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}
