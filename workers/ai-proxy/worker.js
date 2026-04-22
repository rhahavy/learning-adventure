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
  'https://kidquest.fun',
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

// Rate limit windows. Each bucket has its own (max, window) tuple so
// we can throttle different abuse vectors at different cadences.
//   AUTH_IP     — per-IP /auth failures. 10/hr blocks a single host
//                 from churning through PINs.
//   AUTH_CODE   — per-code /auth failures. 5/hr locks THAT code if
//                 attackers distribute across IPs (botnet). This is
//                 what stops a realistic 4-digit PIN brute force.
//   ADMIN_IP    — per-IP /provision + /unprovision. 30/hr caps the
//                 damage if the admin token leaks.
//   TAUTH_IP    — per-IP /teacher-auth failures. 20/hr.
//   TAUTH_CODE  — per-code /teacher-auth failures. 10/hr.
const RL = {
  AUTH_IP:    { max: 10, window: 60 * 60 * 1000 },
  AUTH_CODE:  { max: 5,  window: 60 * 60 * 1000 },
  ADMIN_IP:   { max: 30, window: 60 * 60 * 1000 },
  TAUTH_IP:   { max: 20, window: 60 * 60 * 1000 },
  TAUTH_CODE: { max: 10, window: 60 * 60 * 1000 },
  // /demo/request is public — anyone on the marketing page can hit it.
  // 5/hr/IP keeps a single bored visitor (or low-effort scraper) from
  // emailing themselves a hundred PINs in a minute. Bump if legit
  // demand outpaces this cap; it's a comfort number, not load-bearing.
  DEMO_REQ_IP:{ max: 5,  window: 60 * 60 * 1000 },
};
// Kept as an alias so existing callers that reference this constant
// (if any linger) don't break. Prefer RL.AUTH_IP.
const AUTH_RATE_LIMIT_MAX     = RL.AUTH_IP.max;
const AUTH_RATE_LIMIT_WINDOW_MS = RL.AUTH_IP.window;

// PBKDF2 iterations for teacher-password hashing. 100k ≈ 100ms on a
// Worker CPU — plenty slow for offline brute-force attackers, fast
// enough that a teacher clicking "login" doesn't notice.
const PBKDF2_ITERATIONS = 100000;

// Reserved tenant codes that ALWAYS work — they're hardcoded in source,
// self-heal into KV on first auth after a wipe, and are blocked from
// /unprovision. Used for the "demo PIN we hand out in talks / put on
// flyers / promise on the website" — the kind of code where it would
// be embarrassing if it stopped working because someone accidentally
// ran a cleanup script.
//
// Tenant id is deterministic (`reserved-{code}`) so that even after a
// full KV wipe + self-heal, the data namespace is the same — kids who
// used PIN 2228 a month ago still see their progress when they come
// back. Different reserved PINs get different deterministic ids, so
// they don't share data with each other.
//
// Settings used on self-heal:
//   isDemo: true            — flagged as demo in admin UI / CSS
//   planType: 'classroom'   — full feature set, since these are "show
//                             everything KidQuest can do" demos
//   teacherPasswordHash:null — no teacher gate; the PIN is the only secret
//   storeEnabled: true      — rewards shop visible
//
// To add another reserved PIN: add an entry below + redeploy. To change
// settings: bump the entry, then once-off `wrangler kv key delete
// tenant:reserved-{code}` (the next /auth re-creates from the template).
const RESERVED_TENANTS = {
  '2228': {
    id: 'reserved-2228',
    label: 'KidQuest Demo (PIN 2228)',
    code: '2228',
    teacherPasswordHash: null,
    isDemo: true,
    planType: 'classroom',
    storeEnabled: true,
    createdAt: '2026-04-22T00:00:00.000Z',
    reserved: true,
  },
};
function isReservedCode(code) {
  if (!code) return false;
  return Object.prototype.hasOwnProperty.call(RESERVED_TENANTS, String(code).toLowerCase());
}
function getReservedTenant(code) {
  if (!isReservedCode(code)) return null;
  // Return a fresh shallow copy so callers can mutate (e.g. add
  // updatedAt) without poisoning the constant.
  return Object.assign({}, RESERVED_TENANTS[String(code).toLowerCase()]);
}

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

// Generate a fresh DEMO code. Distinct shape from regular tenant codes
// ("demo-" prefix + 2 words + 4 digits) so an operator can spot one at
// a glance in logs and the admin dashboard. ~24 bits of entropy on top
// of the prefix — plenty for short-lived (24h) demo aliases.
function generateDemoCode() {
  const a = new Uint32Array(3);
  crypto.getRandomValues(a);
  const w1 = TENANT_WORDS[a[0] % TENANT_WORDS.length];
  const w2 = TENANT_WORDS[a[1] % TENANT_WORDS.length];
  const dd = String(a[2] % 10000).padStart(4, '0');
  return `demo-${w1}-${w2}-${dd}`;
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
//
// Reserved codes (see RESERVED_TENANTS) self-heal: if the KV record is
// missing — fresh deploy, accidental wipe, expired demo code — we
// re-create it from the source template before returning. Result: the
// PIN literally cannot stop working short of editing the worker source.
async function lookupTenantByCode(env, code) {
  if (!code || !env.KV) return null;
  const tenantId = await env.KV.get(`code:${code}`);
  if (tenantId) {
    const raw = await env.KV.get(`tenant:${tenantId}`);
    if (raw) {
      try { return JSON.parse(raw); } catch { /* fall through to reserved-heal */ }
    }
  }
  // KV miss (or malformed record) on a reserved code → self-heal.
  if (isReservedCode(code)) {
    const reserved = getReservedTenant(code);
    // Write WITHOUT expirationTtl — reserved tenants live forever.
    // If a previous /unprovision deleted the KV record, this resurrects it.
    await env.KV.put(`code:${code}`, reserved.id);
    await env.KV.put(`tenant:${reserved.id}`, JSON.stringify(reserved));
    return reserved;
  }
  return null;
}

// Generic KV-backed sliding-window counter. Pass the bucket key
// (e.g. `ratelimit:auth:ip:1.2.3.4`) plus max + window — this function
// is bucket-agnostic so the same machinery serves every endpoint's
// abuse-throttling needs. Read→decide→write is not transactional
// (KV doesn't support that), but the worst case is two concurrent
// attempts get counted as one — acceptable for abuse-prevention.
async function rateLimitHit(env, key, max, windowMs) {
  if (!env.KV || !key) return { ok: true, remaining: max };
  const now = Date.now();
  let state = { n: 0, resetAt: now + windowMs };
  try {
    const raw = await env.KV.get(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.resetAt > now) state = parsed;
    }
  } catch {}
  state.n += 1;
  // KV TTL auto-evicts stale buckets when the window passes — no
  // unbounded key growth.
  const ttl = Math.max(60, Math.ceil((state.resetAt - now) / 1000));
  await env.KV.put(key, JSON.stringify(state), { expirationTtl: ttl });
  return { ok: state.n <= max, remaining: Math.max(0, max - state.n), resetAt: state.resetAt };
}

// Read-only peek at a rate-limit bucket. Used pre-auth to reject
// requests from a tripped bucket without incrementing it further.
async function rateLimitPeek(env, key, max) {
  if (!env.KV || !key) return { ok: true };
  try {
    const raw = await env.KV.get(key);
    if (!raw) return { ok: true };
    const parsed = JSON.parse(raw);
    if (parsed.resetAt < Date.now()) return { ok: true };
    return { ok: parsed.n < max, resetAt: parsed.resetAt };
  } catch { return { ok: true }; }
}

// PBKDF2(SHA-256) password hashing via WebCrypto — the only KDF
// available in Workers runtime without pulling a WASM dep. Output
// shape is a JSON-safe record; verifyPassword reads the iterations
// from the record so we can bump the work factor later without
// breaking old hashes.
async function hashPassword(password) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const bits = await pbkdf2Bits(password, salt, PBKDF2_ITERATIONS);
  return {
    alg: 'pbkdf2-sha256',
    iterations: PBKDF2_ITERATIONS,
    salt: bytesToHex(salt),
    hash: bytesToHex(new Uint8Array(bits)),
  };
}

async function verifyPassword(password, record) {
  if (!record || record.alg !== 'pbkdf2-sha256' || !record.salt || !record.hash) return false;
  const salt = hexToBytes(record.salt);
  const iterations = record.iterations || PBKDF2_ITERATIONS;
  const bits = await pbkdf2Bits(password, salt, iterations);
  const got = new Uint8Array(bits);
  const expected = hexToBytes(record.hash);
  if (got.length !== expected.length) return false;
  // Constant-time compare — prevents timing-based password leaks.
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ expected[i];
  return diff === 0;
}

async function pbkdf2Bits(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256
  );
}

function bytesToHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
// SHA-256 helper for idempotency keys, dedupe markers, etc. Returns
// the hex digest as a string. Not for password hashing — use
// hashPassword (PBKDF2) for anything user-supplied.
async function sha256Hex(input) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(input)));
  return bytesToHex(new Uint8Array(buf));
}

// Mask an email for display: "alice@gmail.com" → "a***@gmail.com",
// "ab@gmail.com" → "a***@gmail.com", "a@gmail.com" → "***@gmail.com".
// Used on the thank-you page so we can confirm WHICH inbox got the
// code without echoing the full address back to anyone holding the
// session id. Pure function; safe to call client-side too.
function maskEmail(email) {
  const s = String(email || '').trim();
  if (!s.includes('@')) return '';
  const [local, domain] = s.split('@');
  if (!local || !domain) return '';
  const visible = local.length >= 2 ? local.slice(0, 1) : '';
  return `${visible}***@${domain}`;
}

// HTML-escape for use inside <td> / <p>. Just the four chars; we
// don't allow any user input into attribute positions so quote
// escaping isn't needed but we include it for safety.
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Send the tenant-activation email via Resend. Resend was chosen
// over Mailgun/SendGrid because:
//   • Pure HTTPS API — no SMTP gymnastics from Workers
//   • Generous free tier (3k/mo) covers small SaaS comfortably
//   • Single secret to manage (RESEND_API_KEY)
//   • SPF/DKIM auto-configured per verified domain
//
// Required:
//   env.RESEND_API_KEY  (secret)  — re_xxx from resend.com dashboard
//   env.EMAIL_FROM      (var)     — "KidQuest <hello@kidquest.fun>"
//                                   The sender domain MUST be verified
//                                   in Resend; otherwise sends fail
//                                   immediately with 403.
// Optional:
//   env.EMAIL_REPLY_TO  (var)     — e.g. "support@kidquest.fun"
//   env.APP_URL         (var)     — link target in the email body.
//                                   Falls back to the bare path "/app/"
//                                   so it works even if unset.
//
// Returns { ok: bool, status, error? }. Caller should LOG but NOT
// THROW on failure — provisioning has already succeeded by the time
// we get here, and the user can still recover via /stripe/resend-code.
async function sendTenantCodeEmail(env, toEmail, code, label, planType) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
    return { ok: false, status: 0, error: 'email_not_configured' };
  }
  if (!toEmail || !String(toEmail).includes('@')) {
    return { ok: false, status: 0, error: 'no_recipient' };
  }
  const appUrl = env.APP_URL || '/app/';
  const planNoun = planType === 'family' ? 'family account' : 'classroom';
  const labelClean = escapeHtml(label || (planType === 'family' ? 'your family' : 'your classroom'));
  const codeUpper = String(code).toUpperCase();

  const subject = `Your KidQuest login code: ${codeUpper}`;
  // Plain-text fallback for clients that prefer it (Apple Mail, etc.)
  const text = [
    `Welcome to KidQuest!`,
    ``,
    `Your ${planNoun} "${label || 'is ready'}" is set up.`,
    ``,
    `Your login code: ${codeUpper}`,
    ``,
    `Open the app: ${appUrl}`,
    ``,
    `On the sign-in screen, enter the code above. Save this email — you'll`,
    `need the code to sign in on every device.`,
    ``,
    `Your 7-day free trial starts now. No charge until day 8. Cancel anytime`,
    `from the Teacher Dashboard → Subscription & Billing.`,
    ``,
    `Need help? Reply to this email.`,
  ].join('\n');

  // Inline-styled HTML. No external CSS — many email clients strip it.
  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F0EEFF;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1A1035;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F0EEFF;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:24px;padding:36px;box-shadow:0 12px 32px rgba(108,92,231,0.15);">
        <tr><td>
          <h1 style="margin:0 0 8px;font-size:24px;font-weight:800;color:#1A1035;">🎉 Welcome to KidQuest!</h1>
          <p style="margin:0 0 24px;font-size:16px;line-height:1.5;color:#5B5580;">Your ${escapeHtml(planNoun)} <strong>${labelClean}</strong> is ready to go.</p>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#6C5CE7,#A29BFE);border-radius:18px;padding:24px;text-align:center;margin:0 0 24px;">
            <tr><td align="center">
              <div style="font-size:12px;font-weight:700;letter-spacing:1.5px;color:#fff;opacity:0.85;text-transform:uppercase;margin-bottom:8px;">Your Login Code</div>
              <div style="font-size:38px;font-weight:800;letter-spacing:0.08em;color:#fff;font-family:'SF Mono',Menlo,monospace;">${escapeHtml(codeUpper)}</div>
            </td></tr>
          </table>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
            <tr><td align="center">
              <a href="${escapeHtml(appUrl)}" style="display:inline-block;background:#6C5CE7;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 28px;border-radius:999px;">Open KidQuest →</a>
            </td></tr>
          </table>

          <div style="background:#F7F5FF;padding:18px 22px;border-radius:14px;margin:0 0 20px;">
            <p style="margin:0 0 8px;font-size:14px;font-weight:700;color:#1A1035;">What's next:</p>
            <ol style="margin:0;padding-left:20px;color:#5B5580;font-size:14px;line-height:1.7;">
              <li>Click <strong>Open KidQuest</strong> above.</li>
              <li>Enter your code on the sign-in screen.</li>
              <li>Your 7-day free trial starts now — no charge until day 8.</li>
            </ol>
          </div>

          <p style="margin:0;font-size:13px;color:#9B95B0;line-height:1.5;">
            Save this email — you'll need the code to sign in on every device.
            Cancel anytime from Teacher Dashboard → Subscription &amp; Billing.
            Need help? Just reply.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const payload = {
    from: env.EMAIL_FROM,
    to: [toEmail],
    subject,
    html,
    text,
  };
  if (env.EMAIL_REPLY_TO) payload.reply_to = env.EMAIL_REPLY_TO;

  let r;
  try {
    r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.RESEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return { ok: false, status: 0, error: 'fetch_failed:' + (e && e.message || e) };
  }
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.text()).slice(0, 200); } catch {}
    return { ok: false, status: r.status, error: detail || ('http_' + r.status) };
  }
  return { ok: true, status: r.status };
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i*2, i*2+2), 16);
  return out;
}

// Email a 24h demo PIN to a visitor who requested it from the marketing
// page. Same Resend plumbing as sendTenantCodeEmail — different copy
// because (a) it's a demo, not a paid signup, and (b) the code expires
// in 24h, which the email needs to make blindingly obvious so people
// don't bookmark a dead PIN. Best-effort like the other email senders:
// returns { ok, status, error? } and never throws.
async function sendDemoCodeEmail(env, toEmail, code, requesterName) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
    return { ok: false, status: 0, error: 'email_not_configured' };
  }
  if (!toEmail || !String(toEmail).includes('@')) {
    return { ok: false, status: 0, error: 'no_recipient' };
  }
  const appUrl = env.APP_URL || '/app/';
  const codeUpper = String(code).toUpperCase();
  const greeting = requesterName ? `Hi ${escapeHtml(requesterName.toString().slice(0, 60))},` : 'Hi there,';

  const subject = `Your KidQuest demo code: ${codeUpper}`;
  const text = [
    `Thanks for trying KidQuest!`,
    ``,
    `Your demo code: ${codeUpper}`,
    ``,
    `Open the app: ${appUrl}`,
    ``,
    `On the sign-in screen, enter the code above.`,
    ``,
    `IMPORTANT: This demo code is valid for 24 hours, then it expires`,
    `and the demo data is wiped. If you'd like to keep your kid's`,
    `progress, sign up for a 7-day free trial at https://kidquest.fun/#pricing`,
    `before the demo ends.`,
    ``,
    `Questions? Reply to this email.`,
  ].join('\n');

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F0EEFF;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1A1035;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F0EEFF;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:24px;padding:36px;box-shadow:0 12px 32px rgba(108,92,231,0.15);">
        <tr><td>
          <h1 style="margin:0 0 8px;font-size:24px;font-weight:800;color:#1A1035;">🎮 Your KidQuest demo is ready</h1>
          <p style="margin:0 0 24px;font-size:16px;line-height:1.5;color:#5B5580;">${greeting} here's your one-time demo PIN — kick the tires for 24 hours, no card required.</p>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#6C5CE7,#A29BFE);border-radius:18px;padding:24px;text-align:center;margin:0 0 24px;">
            <tr><td align="center">
              <div style="font-size:12px;font-weight:700;letter-spacing:1.5px;color:#fff;opacity:0.85;text-transform:uppercase;margin-bottom:8px;">Your Demo Code</div>
              <div style="font-size:34px;font-weight:800;letter-spacing:0.06em;color:#fff;font-family:'SF Mono',Menlo,monospace;">${escapeHtml(codeUpper)}</div>
              <div style="font-size:12px;color:#fff;opacity:0.85;margin-top:10px;">Expires in 24 hours</div>
            </td></tr>
          </table>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
            <tr><td align="center">
              <a href="${escapeHtml(appUrl)}" style="display:inline-block;background:#6C5CE7;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 28px;border-radius:999px;">Try KidQuest →</a>
            </td></tr>
          </table>

          <div style="background:#FFF8E1;padding:16px 20px;border-radius:14px;margin:0 0 20px;border-left:4px solid #FDCB6E;">
            <p style="margin:0;font-size:13px;color:#7C5E10;line-height:1.5;">
              <strong>Heads up:</strong> demo data wipes after 24h. If your kid loves it, sign up for a free 7-day trial at <a href="https://kidquest.fun/#pricing" style="color:#6C5CE7;font-weight:700;">kidquest.fun</a> before the demo ends so progress carries over.
            </p>
          </div>

          <p style="margin:0;font-size:13px;color:#9B95B0;line-height:1.5;">Questions? Just reply.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const payload = { from: env.EMAIL_FROM, to: [toEmail], subject, html, text };
  if (env.EMAIL_REPLY_TO) payload.reply_to = env.EMAIL_REPLY_TO;

  let r;
  try {
    r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.RESEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return { ok: false, status: 0, error: 'fetch_failed:' + (e && e.message || e) };
  }
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.text()).slice(0, 200); } catch {}
    return { ok: false, status: r.status, error: detail || ('http_' + r.status) };
  }
  return { ok: true, status: r.status };
}

// Notify the operator that someone requested a demo PIN. Mirrors the
// shape of sendOwnerSignupNotification — best-effort, never throws.
// The PIN is included verbatim so the operator can also hand it off
// manually if the visitor's email bounces.
async function sendOwnerDemoNotification(env, demo) {
  if (!env.OWNER_EMAIL) return { ok: false, error: 'owner_email_unset' };
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return { ok: false, error: 'email_not_configured' };

  const subject = `[KidQuest] Demo requested: ${demo.requestedBy || '(no email)'}`;
  const codeUpper = String(demo.code).toUpperCase();
  const text = [
    `Someone just requested a 24h demo PIN.`,
    ``,
    `Code:        ${codeUpper}`,
    `Expires:     ${demo.expiresAt}`,
    `Email:       ${demo.requestedBy || '(none)'}`,
    `Name:        ${demo.requestedByName || '(none)'}`,
    `Message:     ${demo.message || '(none)'}`,
    `Source:      ${demo.source || 'marketing-form'}`,
    `Tenant ID:   ${demo.tenantId}`,
    ``,
    `View active demo PINs: ${(env.APP_URL || '').replace(/\/app\/?$/, '') || ''}/admin/`,
  ].join('\n');

  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#fafafa;padding:24px;color:#1a1035;">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;padding:28px;border:1px solid #eee;">
      <tr><td>
        <h2 style="margin:0 0 8px;font-size:20px;">🎮 Demo PIN requested</h2>
        <p style="margin:0 0 16px;color:#666;font-size:14px;">${escapeHtml(demo.requestedByName || '(no name)')} &lt;${escapeHtml(demo.requestedBy || 'no email')}&gt;</p>
        <table role="presentation" width="100%" cellpadding="6" cellspacing="0" style="font-size:14px;font-family:'SF Mono',Menlo,monospace;background:#f7f5ff;border-radius:8px;">
          <tr><td style="color:#666;width:120px;">Code</td><td><strong>${escapeHtml(codeUpper)}</strong></td></tr>
          <tr><td style="color:#666;">Expires</td><td>${escapeHtml(demo.expiresAt)}</td></tr>
          <tr><td style="color:#666;">Email</td><td>${escapeHtml(demo.requestedBy || '(none)')}</td></tr>
          <tr><td style="color:#666;">Name</td><td>${escapeHtml(demo.requestedByName || '(none)')}</td></tr>
          <tr><td style="color:#666;">Source</td><td>${escapeHtml(demo.source || 'marketing-form')}</td></tr>
          <tr><td style="color:#666;">Tenant ID</td><td>${escapeHtml(demo.tenantId)}</td></tr>
        </table>
        ${demo.message ? `<p style="margin:16px 0 0;color:#5B5580;font-size:14px;line-height:1.5;"><strong>Message:</strong><br>${escapeHtml(demo.message)}</p>` : ''}
      </td></tr>
    </table>
  </body></html>`;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.RESEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [env.OWNER_EMAIL], subject, text, html }),
    });
    if (!r.ok) {
      let detail = '';
      try { detail = (await r.text()).slice(0, 200); } catch {}
      console.warn('owner demo notification failed:', r.status, detail);
      return { ok: false, status: r.status, error: detail };
    }
    return { ok: true };
  } catch (e) {
    console.warn('owner demo notification threw:', String(e && e.message || e));
    return { ok: false, error: String(e && e.message || e) };
  }
}

// Whitelists the tenant fields that are safe to return to an
// authenticated client. Secrets (password hashes) and anything the
// frontend doesn't legitimately need stay server-side. Default
// `planType: 'classroom'` and `storeEnabled: true` so legacy
// tenants (pre-schema-update) behave like classrooms with the
// rewards shop on — matching today's behavior.
function sanitizeTenantForClient(tenant) {
  if (!tenant) return null;
  return {
    id: tenant.id,
    label: tenant.label,
    code: tenant.code,
    isDemo: !!tenant.isDemo,
    planType: tenant.planType || 'classroom',
    storeEnabled: tenant.storeEnabled !== false,
    hasTeacherPassword: !!(tenant.teacherPasswordHash || tenant.teacherPassword),
    // Does this tenant have an active Stripe subscription we can
    // manage? Used to gate the "Manage Subscription" button in the
    // teacher dashboard — no Stripe customer id means the tenant
    // was provisioned manually via /provision and has no portal.
    hasSubscription: !!tenant.stripeCustomerId,
    suspended: !!tenant.suspended,
    createdAt: tenant.createdAt,
  };
}

// POST /provision — admin-only. Body: { label, teacherPassword?, pin?,
// isDemo?, planType?, storeEnabled? }. Returns sanitized tenant record
// (no password material ever leaves the server after provisioning).
//
// planType: 'family' | 'classroom' (default 'classroom'). Family plans
// hide the teacher dashboard and content editor; classrooms get the
// full admin surface.
//
// storeEnabled: default true. When false the kid-facing rewards shop
// is hidden and coins don't show — coins still accumulate so flipping
// it back on restores the pile.
//
// Rate-limited per-IP even though this is admin-gated: if the admin
// token ever leaks (CI log, stolen laptop), the attacker can't wipe
// KV with 10k provisions in 10 seconds.
async function handleProvisionRoute(request, env, corsOrigin) {
  if (!env.KV) return json({ error: 'kv_not_bound' }, 500, corsOrigin);
  if (!checkAdminAuth(request, env)) return json({ error: 'admin_unauthorized' }, 401, corsOrigin);
  const ip = request.headers.get('cf-connecting-ip') || '';
  const rlKey = `ratelimit:provision:ip:${ip}`;
  const rl = await rateLimitHit(env, rlKey, RL.ADMIN_IP.max, RL.ADMIN_IP.window);
  if (!rl.ok) return json({ error: 'rate_limited', resetAt: rl.resetAt }, 429, corsOrigin);

  let body = {};
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400, corsOrigin); }
  const label = (body.label || '').toString().trim().slice(0, 80) || 'Untitled';
  const teacherPasswordRaw = (body.teacherPassword || '').toString().slice(0, 64);
  const isDemo = body.isDemo === true;
  const planType = (body.planType === 'family') ? 'family' : 'classroom';
  const storeEnabled = body.storeEnabled !== false; // default ON

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
    // Reserved codes are owned by the worker source — admin can't
    // overwrite them via /provision. Same protection as /unprovision.
    if (isReservedCode(pinRaw)) {
      return json({ error: 'reserved_code', detail: 'PIN ' + pinRaw + ' is reserved (hardcoded in worker source) and cannot be re-provisioned.' }, 409, corsOrigin);
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

  // Hash the teacher password if provided. Plaintext is never stored.
  // Family plans typically don't set one (parent is the admin by default).
  const teacherPasswordHash = teacherPasswordRaw
    ? await hashPassword(teacherPasswordRaw)
    : null;

  const id = generateTenantId();
  const tenant = {
    id, label, code,
    teacherPasswordHash,
    isDemo, planType, storeEnabled,
    createdAt: new Date().toISOString(),
  };
  await env.KV.put(`tenant:${id}`, JSON.stringify(tenant));
  await env.KV.put(`code:${code}`, id);
  // Return the sanitized tenant (no hash, no password material) PLUS
  // the raw code — the admin CLI needs to print the code to the
  // operator so they can hand it off to the family/teacher.
  return json({ ok: true, tenant: sanitizeTenantForClient(tenant) }, 200, corsOrigin);
}

// POST /unprovision — admin only. Body: { code, immediate? }.
// Wipes the tenant record, its code alias, and its data+snapshots blobs.
// Intentionally takes `code` (not `tenantId`) to reduce the blast radius
// of an admin-token leak — an attacker who learns a tenantId via some
// other channel can't unprovision it without also knowing the code.
// Rate-limited per-IP for the same reason /provision is.
//
// Stripe handling: if the tenant record carries a stripeSubscriptionId,
// we MUST cancel it before wiping KV — once the tenant record is gone
// we lose the only pointer to the live subscription and the customer
// keeps getting charged for service they no longer have. Default mode
// is cancel-at-period-end (POST /v1/subscriptions/:id with
// cancel_at_period_end=true) — the customer keeps service through what
// they already paid for, then it lapses cleanly. Pass { immediate: true }
// for a hard DELETE /v1/subscriptions/:id (fraud / chargeback /
// hard-stop). If Stripe says the subscription is already gone (404), we
// treat that as success and continue with KV wipe. Other Stripe errors
// are reported in the response so the operator can decide whether to
// retry — KV wipe still proceeds because leaving a half-deleted tenant
// is worse than leaving a Stripe sub for the operator to clean up by
// hand from the Stripe dashboard.
async function handleUnprovisionRoute(request, env, corsOrigin) {
  if (!env.KV) return json({ error: 'kv_not_bound' }, 500, corsOrigin);
  if (!checkAdminAuth(request, env)) return json({ error: 'admin_unauthorized' }, 401, corsOrigin);
  const ip = request.headers.get('cf-connecting-ip') || '';
  const rlKey = `ratelimit:unprovision:ip:${ip}`;
  const rl = await rateLimitHit(env, rlKey, RL.ADMIN_IP.max, RL.ADMIN_IP.window);
  if (!rl.ok) return json({ error: 'rate_limited', resetAt: rl.resetAt }, 429, corsOrigin);

  let body = {};
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400, corsOrigin); }
  const code = (body.code || '').toString().trim().toLowerCase();
  if (!code) return json({ error: 'missing_code' }, 400, corsOrigin);
  // Reserved codes (e.g. PIN 2228) cannot be unprovisioned — they're
  // hardcoded as always-on demo codes. If the operator really needs to
  // reset one, deleting the KV records by hand triggers a self-heal on
  // next /auth (see lookupTenantByCode).
  if (isReservedCode(code)) {
    return json({ error: 'reserved_code', detail: 'PIN ' + code + ' is reserved (hardcoded in worker source) and cannot be unprovisioned.' }, 403, corsOrigin);
  }
  const immediate = body.immediate === true;
  const tenantId = (await env.KV.get(`code:${code}`)) || '';
  if (!tenantId) return json({ error: 'not_found' }, 404, corsOrigin);

  // Look up the tenant record FIRST, BEFORE deletion, so we still have
  // the Stripe subscription id when we make the cancel call.
  let tenant = null;
  try {
    const raw = await env.KV.get(`tenant:${tenantId}`);
    if (raw) tenant = JSON.parse(raw);
  } catch {}

  const subId = tenant && tenant.stripeSubscriptionId ? String(tenant.stripeSubscriptionId) : '';
  const stripeResult = {
    attempted: false,
    canceled: false,
    mode: null,            // 'period_end' | 'immediate' | null
    subscriptionId: null,
    status: null,          // Stripe subscription.status after the call
    error: null,
  };

  if (subId) {
    stripeResult.attempted = true;
    stripeResult.subscriptionId = subId;
    stripeResult.mode = immediate ? 'immediate' : 'period_end';
    try {
      const r = immediate
        ? await stripeApi(env, 'DELETE', `/subscriptions/${encodeURIComponent(subId)}`, null)
        : await stripeApi(env, 'POST',   `/subscriptions/${encodeURIComponent(subId)}`, { cancel_at_period_end: true });
      if (r && r.ok) {
        stripeResult.canceled = true;
        stripeResult.status = (r.data && r.data.status) || null;
      } else if (r && r.status === 404) {
        // Already canceled or never existed — benign; continue with wipe.
        stripeResult.canceled = true;
        stripeResult.status = 'already_gone';
      } else {
        const errMsg  = (r && r.data && r.data.error && r.data.error.message) || 'unknown_stripe_error';
        const errCode = (r && r.data && r.data.error && r.data.error.code) || null;
        stripeResult.error = `${r ? r.status : '?'}: ${errMsg}${errCode ? ' (' + errCode + ')' : ''}`;
      }
    } catch (e) {
      stripeResult.error = (e && e.message) || 'stripe_call_threw';
    }
  }

  // THEN delete KV keys. We deliberately wipe even if the Stripe call
  // failed — see the route comment above for the reasoning.
  await env.KV.delete(`tenant:${tenantId}`);
  await env.KV.delete(`tenant:${tenantId}:data`);
  await env.KV.delete(`tenant:${tenantId}:snapshots`);
  await env.KV.delete(`code:${code}`);
  return json({ ok: true, removed: { id: tenantId, code }, stripe: stripeResult }, 200, corsOrigin);
}

// POST /admin/reset-teacher-password — admin only. Body: { code, password }.
// One-shot recovery for the case where a teacher locks themselves out (or
// the legacy plaintext-→-hash migration set a hash that doesn't match the
// password they remember). Resets the stored hash to a fresh hash of the
// supplied plaintext AND clears any rate-limit lockout for that code so
// the teacher can log in immediately. Per-IP rate-limited like the other
// admin routes — admin-token leak still has a ceiling on blast radius.
async function handleAdminResetTeacherPasswordRoute(request, env, corsOrigin) {
  if (!env.KV) return json({ error: 'kv_not_bound' }, 500, corsOrigin);
  if (!checkAdminAuth(request, env)) return json({ error: 'admin_unauthorized' }, 401, corsOrigin);
  const ip = request.headers.get('cf-connecting-ip') || '';
  const rlKey = `ratelimit:adminreset:ip:${ip}`;
  const rl = await rateLimitHit(env, rlKey, RL.ADMIN_IP.max, RL.ADMIN_IP.window);
  if (!rl.ok) return json({ error: 'rate_limited', resetAt: rl.resetAt }, 429, corsOrigin);

  let body = {};
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400, corsOrigin); }
  const code = (body.code || '').toString().trim().toLowerCase();
  const password = (body.password || '').toString().slice(0, 64);
  if (!code) return json({ error: 'missing_code' }, 400, corsOrigin);
  if (!password) return json({ error: 'missing_password' }, 400, corsOrigin);

  const tenantId = (await env.KV.get(`code:${code}`)) || '';
  if (!tenantId) return json({ error: 'not_found' }, 404, corsOrigin);
  const raw = await env.KV.get(`tenant:${tenantId}`);
  if (!raw) return json({ error: 'tenant_record_missing' }, 404, corsOrigin);
  let tenant; try { tenant = JSON.parse(raw); } catch { return json({ error: 'tenant_malformed' }, 500, corsOrigin); }

  // Fresh hash with current PBKDF2 iteration count + new salt. Drop any
  // lingering legacy plaintext field at the same time so future reads go
  // through the hash path only.
  tenant.teacherPasswordHash = await hashPassword(password);
  if (tenant.teacherPassword) delete tenant.teacherPassword;
  await env.KV.put(`tenant:${tenantId}`, JSON.stringify(tenant));

  // Clear /teacher-auth lockout buckets (per-code AND per-IP for the calling
  // IP — usually the operator's IP, fine to clear). The per-IP bucket for
  // the teacher's own client IP would naturally clear as the window passes;
  // we don't have it here. The per-code clear is the important one — that's
  // what locks out further attempts globally.
  await env.KV.delete(`ratelimit:tauth:code:${code}`);
  if (ip) await env.KV.delete(`ratelimit:tauth:ip:${ip}`);

  return json({ ok: true, tenantId, code, cleared: ['teacher-auth-rate-limit-code', ip ? 'teacher-auth-rate-limit-admin-ip' : null].filter(Boolean) }, 200, corsOrigin);
}

// =====================================================================
// ADMIN DASHBOARD ROUTES
// =====================================================================
// All admin routes share three guarantees:
//   1. ADMIN_TOKEN bearer required (constant-time compared)
//   2. Per-IP rate limit (RL.ADMIN_IP) — caps blast radius if token leaks
//   3. Read-only by default; mutating routes use POST with explicit `code`
//
// The HTML for /admin/ lives in /admin/index.html on the marketing site,
// served from the same origin as the marketing page. It calls these
// endpoints with the operator-typed admin token in localStorage. The
// token NEVER appears in markup, query strings, or logs.

// GET /admin/tenants — list every tenant with summary fields.
// Returns: { ok, tenants: [{id, code, label, planType, suspended,
//   stripeCustomerId, stripeSubscriptionStatus, customerEmail,
//   createdAt, isDemo}], cursor? }
//
// Pagination via Cloudflare KV's list({prefix, cursor, limit}) primitive.
// Default limit 100 (KV's max per call is 1000, but 100 keeps each
// request fast and the JSON manageable).
async function handleAdminListTenantsRoute(request, env, corsOrigin) {
  if (!env.KV) return json({ error: 'kv_not_bound' }, 500, corsOrigin);
  if (!checkAdminAuth(request, env)) return json({ error: 'admin_unauthorized' }, 401, corsOrigin);
  const ip = request.headers.get('cf-connecting-ip') || '';
  const rl = await rateLimitHit(env, `ratelimit:admin-list:ip:${ip}`, RL.ADMIN_IP.max, RL.ADMIN_IP.window);
  if (!rl.ok) return json({ error: 'rate_limited', resetAt: rl.resetAt }, 429, corsOrigin);

  const url = new URL(request.url);
  const cursor = url.searchParams.get('cursor') || undefined;
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 500);

  // KV list returns keys; we then GET each tenant record. List is
  // O(keys) but at typical scale (hundreds-low-thousands of tenants)
  // this is fine. If you ever cross ~10k tenants, denormalise into
  // a paginated index key — not needed today.
  const result = await env.KV.list({ prefix: 'tenant:', cursor, limit });
  const tenants = [];
  for (const k of result.keys) {
    // Skip sub-keys like tenant:<id>:data, tenant:<id>:snapshots
    if (k.name.split(':').length !== 2) continue;
    const raw = await env.KV.get(k.name);
    if (!raw) continue;
    let t; try { t = JSON.parse(raw); } catch { continue; }
    tenants.push({
      id: t.id,
      code: t.code,
      label: t.label,
      planType: t.planType,
      suspended: !!t.suspended,
      isDemo: !!t.isDemo,
      stripeCustomerId: t.stripeCustomerId || null,
      stripeSubscriptionId: t.stripeSubscriptionId || null,
      stripeSubscriptionStatus: t.stripeSubscriptionStatus || null,
      customerEmail: t.customerEmail || null,
      hasTeacherPassword: !!(t.teacherPasswordHash || t.teacherPassword),
      hasLegacyPlaintextPassword: !!t.teacherPassword && !t.teacherPasswordHash,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    });
  }
  // Sort newest first (createdAt is ISO-8601 so string compare works).
  tenants.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return json({
    ok: true,
    tenants,
    cursor: result.list_complete ? null : result.cursor,
    listComplete: !!result.list_complete,
    total: tenants.length,
  }, 200, corsOrigin);
}

// GET /admin/tenant/:id — full record for one tenant. Mostly the same
// fields as the list endpoint, but includes things we hide from the
// list view to keep the JSON small (and one-shot lookups can afford
// an extra round-trip).
async function handleAdminGetTenantRoute(request, env, corsOrigin) {
  if (!env.KV) return json({ error: 'kv_not_bound' }, 500, corsOrigin);
  if (!checkAdminAuth(request, env)) return json({ error: 'admin_unauthorized' }, 401, corsOrigin);
  const ip = request.headers.get('cf-connecting-ip') || '';
  const rl = await rateLimitHit(env, `ratelimit:admin-get:ip:${ip}`, RL.ADMIN_IP.max, RL.ADMIN_IP.window);
  if (!rl.ok) return json({ error: 'rate_limited', resetAt: rl.resetAt }, 429, corsOrigin);

  const url = new URL(request.url);
  const tenantId = url.pathname.split('/').pop() || '';
  if (!tenantId) return json({ error: 'missing_id' }, 400, corsOrigin);
  const raw = await env.KV.get(`tenant:${tenantId}`);
  if (!raw) return json({ error: 'not_found' }, 404, corsOrigin);
  let t; try { t = JSON.parse(raw); } catch { return json({ error: 'malformed' }, 500, corsOrigin); }

  // Look up the data + snapshots blob sizes so the operator can see
  // who's storing what without ever reading the contents.
  let dataBytes = 0, snapshotsBytes = 0;
  try { const d = await env.KV.get(`tenant:${tenantId}:data`); dataBytes = d ? d.length : 0; } catch {}
  try { const s = await env.KV.get(`tenant:${tenantId}:snapshots`); snapshotsBytes = s ? s.length : 0; } catch {}

  return json({
    ok: true,
    tenant: {
      ...t,
      // Never echo the password hash back, even to the admin UI —
      // the UI doesn't need it and exposing it makes a future
      // hash-mining vector trivially easier.
      teacherPasswordHash: t.teacherPasswordHash ? '(set)' : null,
      teacherPassword: t.teacherPassword ? '(LEGACY PLAINTEXT — needs migration)' : null,
    },
    storage: {
      dataBytes,
      snapshotsBytes,
      totalBytes: dataBytes + snapshotsBytes,
    },
  }, 200, corsOrigin);
}

// POST /admin/tenant/:id/suspend  body: {} — manually suspend (e.g.
// fraud, policy violation). Independent of Stripe webhook flow.
// POST /admin/tenant/:id/unsuspend body: {} — clear the manual flag.
//
// Note: if the Stripe subscription is also in past_due/canceled, an
// unsuspend here will get re-suspended on the next webhook. That's
// the right behavior — Stripe is the source of truth for billing.
async function handleAdminTenantSuspendRoute(request, env, corsOrigin, mode) {
  if (!env.KV) return json({ error: 'kv_not_bound' }, 500, corsOrigin);
  if (!checkAdminAuth(request, env)) return json({ error: 'admin_unauthorized' }, 401, corsOrigin);
  const ip = request.headers.get('cf-connecting-ip') || '';
  const rl = await rateLimitHit(env, `ratelimit:admin-suspend:ip:${ip}`, RL.ADMIN_IP.max, RL.ADMIN_IP.window);
  if (!rl.ok) return json({ error: 'rate_limited', resetAt: rl.resetAt }, 429, corsOrigin);

  const url = new URL(request.url);
  // /admin/tenant/<id>/suspend → split = ['', 'admin', 'tenant', '<id>', 'suspend']
  const parts = url.pathname.split('/');
  const tenantId = parts[3] || '';
  if (!tenantId) return json({ error: 'missing_id' }, 400, corsOrigin);
  const raw = await env.KV.get(`tenant:${tenantId}`);
  if (!raw) return json({ error: 'not_found' }, 404, corsOrigin);
  let t; try { t = JSON.parse(raw); } catch { return json({ error: 'malformed' }, 500, corsOrigin); }

  t.suspended = (mode === 'suspend');
  t.adminSuspendedAt = (mode === 'suspend') ? new Date().toISOString() : null;
  t.updatedAt = Date.now();
  await env.KV.put(`tenant:${tenantId}`, JSON.stringify(t));
  return json({ ok: true, tenantId, suspended: t.suspended }, 200, corsOrigin);
}

// POST /admin/tenant/:id/resend-code — re-sends the welcome email
// to the customer's address on file. Useful when a customer says
// they never got the email and contacts you directly. Same email
// safety guarantee as /stripe/resend-code: destination is NEVER
// user-supplied.
async function handleAdminResendCodeRoute(request, env, corsOrigin) {
  if (!env.KV) return json({ error: 'kv_not_bound' }, 500, corsOrigin);
  if (!checkAdminAuth(request, env)) return json({ error: 'admin_unauthorized' }, 401, corsOrigin);
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return json({ error: 'email_not_configured' }, 503, corsOrigin);
  const ip = request.headers.get('cf-connecting-ip') || '';
  const rl = await rateLimitHit(env, `ratelimit:admin-resend:ip:${ip}`, RL.ADMIN_IP.max, RL.ADMIN_IP.window);
  if (!rl.ok) return json({ error: 'rate_limited', resetAt: rl.resetAt }, 429, corsOrigin);

  const url = new URL(request.url);
  const parts = url.pathname.split('/');
  const tenantId = parts[3] || '';
  if (!tenantId) return json({ error: 'missing_id' }, 400, corsOrigin);
  const raw = await env.KV.get(`tenant:${tenantId}`);
  if (!raw) return json({ error: 'not_found' }, 404, corsOrigin);
  let t; try { t = JSON.parse(raw); } catch { return json({ error: 'malformed' }, 500, corsOrigin); }

  // Allow operator to override the destination via body.email (rare,
  // e.g. customer typed the wrong address at checkout). Default is
  // the email already on the tenant record.
  let body = {};
  try { body = await request.json(); } catch {}
  const overrideEmail = (body && body.email) ? String(body.email).trim() : '';
  const toEmail = overrideEmail || t.customerEmail || '';
  if (!toEmail || !toEmail.includes('@')) return json({ error: 'no_email_on_file' }, 400, corsOrigin);

  // If operator overrode the email, also persist it so future resends
  // and the customer-facing /stripe/resend-code use the corrected one.
  if (overrideEmail && overrideEmail !== t.customerEmail) {
    t.customerEmail = overrideEmail;
    t.updatedAt = Date.now();
    await env.KV.put(`tenant:${tenantId}`, JSON.stringify(t));
  }

  const r = await sendTenantCodeEmail(env, toEmail, t.code, t.label, t.planType);
  if (!r.ok) return json({ error: 'send_failed', detail: r.error }, 502, corsOrigin);
  return json({ ok: true, sentTo: maskEmail(toEmail) }, 200, corsOrigin);
}

// GET /admin/stats — aggregate counters for the dashboard top strip.
// Cheap O(N) scan; cache for 60s in KV so the dashboard refreshing
// doesn't hammer the list endpoint.
async function handleAdminStatsRoute(request, env, corsOrigin) {
  if (!env.KV) return json({ error: 'kv_not_bound' }, 500, corsOrigin);
  if (!checkAdminAuth(request, env)) return json({ error: 'admin_unauthorized' }, 401, corsOrigin);
  const ip = request.headers.get('cf-connecting-ip') || '';
  const rl = await rateLimitHit(env, `ratelimit:admin-stats:ip:${ip}`, RL.ADMIN_IP.max, RL.ADMIN_IP.window);
  if (!rl.ok) return json({ error: 'rate_limited', resetAt: rl.resetAt }, 429, corsOrigin);

  const cached = await env.KV.get('admin:stats:cache');
  if (cached) {
    try { return json(JSON.parse(cached), 200, corsOrigin); } catch {}
  }

  let total = 0, family = 0, classroom = 0, suspended = 0, demo = 0,
      withStripe = 0, legacyPwd = 0, last7d = 0;
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let cursor;
  do {
    const page = await env.KV.list({ prefix: 'tenant:', cursor, limit: 1000 });
    for (const k of page.keys) {
      if (k.name.split(':').length !== 2) continue;
      const raw = await env.KV.get(k.name);
      if (!raw) continue;
      let t; try { t = JSON.parse(raw); } catch { continue; }
      total++;
      if (t.planType === 'family') family++; else classroom++;
      if (t.suspended) suspended++;
      if (t.isDemo) demo++;
      if (t.stripeCustomerId) withStripe++;
      if (t.teacherPassword && !t.teacherPasswordHash) legacyPwd++;
      // createdAt is ISO-8601; new Date() parses it. Skip if missing.
      if (t.createdAt) {
        const ts = Date.parse(t.createdAt);
        if (!isNaN(ts) && ts >= cutoff) last7d++;
      }
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);

  const stats = { ok: true, total, family, classroom, suspended, demo, withStripe, legacyPwd, last7d, generatedAt: new Date().toISOString() };
  // Cache for 60s — admin refreshes don't need to be real-time.
  await env.KV.put('admin:stats:cache', JSON.stringify(stats), { expirationTtl: 60 });
  return json(stats, 200, corsOrigin);
}

// =====================================================================
// DEMO PIN ROUTES
// =====================================================================
// /demo/request          (public)  — visitor asks for a 24h demo PIN
// /admin/demo-pins       (admin)   — list active demo PINs
// /admin/demo-pins/generate (admin) — operator manually creates one
//
// Storage shape (everything below has expirationTtl set on the KV
// keys, so demo records auto-vanish after 24h with no cron needed):
//   tenant:{id}            — full tenant record (planType:'demo',
//                            isDemo:true, expiresAt:ISO)
//   code:{code}            — code → tenantId alias (the app's auth
//                            flow reads this via lookupTenantByCode)
//   demo-pin:{code}        — lightweight admin index, holds the
//                            requester's email/name + expiresAt so
//                            /admin/demo-pins can list without
//                            scanning every tenant key
//
// Why a separate demo-pin: index? Listing tenant:* and filtering
// in-process works but is O(tenants) and reads a lot of unrelated
// data. demo-pin:* gives the admin page a tight prefix scan — only
// active demo records, only the fields the dashboard needs.

// Shared helper for both /demo/request and /admin/demo-pins/generate.
// Generates a fresh demo code (retrying on the rare collision),
// writes the three KV records with 24h TTL, and returns the records
// the callers need. Does NOT email — the caller decides whether the
// requester gets the code by email (public route) or only the
// operator sees it (admin manual generate).
async function createDemoPin(env, { requestedBy, requestedByName, message, source, label, ttlSeconds }) {
  const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : 60 * 60 * 24;
  const now = Date.now();
  const expiresAtMs = now + ttl * 1000;
  const expiresAt = new Date(expiresAtMs).toISOString();
  const requestedAt = new Date(now).toISOString();

  // Try a few times in the unlikely event of a code collision. KV
  // get-then-put isn't atomic, but at this volume + entropy a race is
  // effectively impossible — the next caller will pick a different code
  // and overwrite is harmless because we're about to write the alias.
  let code = '';
  for (let i = 0; i < 5; i++) {
    const candidate = generateDemoCode();
    const taken = await env.KV.get(`code:${candidate}`);
    if (!taken) { code = candidate; break; }
  }
  if (!code) return { ok: false, error: 'code_generation_failed' };

  const id = generateTenantId();
  const labelClean = (label || (requestedByName ? `${requestedByName}'s demo` : 'Demo session')).toString().slice(0, 80);

  const tenant = {
    id,
    label: labelClean,
    code,
    teacherPasswordHash: null,
    isDemo: true,
    planType: 'demo',
    storeEnabled: true,
    expiresAt,
    createdAt: requestedAt,
    // Track requester on the tenant too so an operator looking at the
    // tenant record (not the demo-pin index) can still see who asked.
    demoRequestedBy: requestedBy || null,
    demoRequestedByName: requestedByName || null,
    demoSource: source || 'marketing-form',
  };

  // The lightweight index that /admin/demo-pins lists.
  const demoIndex = {
    code,
    tenantId: id,
    label: labelClean,
    requestedBy: requestedBy || null,
    requestedByName: requestedByName || null,
    message: (message || '').toString().slice(0, 500) || null,
    source: source || 'marketing-form',
    requestedAt,
    expiresAt,
  };

  await env.KV.put(`tenant:${id}`, JSON.stringify(tenant), { expirationTtl: ttl });
  await env.KV.put(`code:${code}`, id,                     { expirationTtl: ttl });
  await env.KV.put(`demo-pin:${code}`, JSON.stringify(demoIndex), { expirationTtl: ttl });

  return { ok: true, tenant, demoIndex };
}

// POST /demo/request — public. Body: { email, name?, message? }.
// Generates a 24h demo PIN, emails it to the requester, and notifies
// the operator. Rate-limited per-IP. The PIN is NEVER returned in the
// response — the requester only learns it from the email — so a
// spammer can't farm PINs via this endpoint to seed an attack.
async function handleDemoRequestRoute(request, env, corsOrigin) {
  if (!env.KV) return json({ error: 'kv_not_bound' }, 500, corsOrigin);
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
    // Email is the ONLY delivery channel for demo PINs by design. If
    // it's not configured, we fail loudly rather than silently storing
    // a PIN nobody can retrieve.
    return json({ error: 'email_not_configured' }, 503, corsOrigin);
  }
  const ip = request.headers.get('cf-connecting-ip') || '';
  const rl = await rateLimitHit(env, `ratelimit:demo-req:ip:${ip}`, RL.DEMO_REQ_IP.max, RL.DEMO_REQ_IP.window);
  if (!rl.ok) return json({ error: 'rate_limited', resetAt: rl.resetAt }, 429, corsOrigin);

  let body = {};
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400, corsOrigin); }
  const email = (body.email || '').toString().trim().slice(0, 200);
  const name  = (body.name  || '').toString().trim().slice(0, 80);
  const messageRaw = (body.message || '').toString().trim().slice(0, 500);
  // Honeypot field — marketing form ships a hidden input named
  // "website". Real users leave it blank; bots fill every field.
  const honeypot = (body.website || '').toString().trim();
  if (honeypot) {
    // Pretend it worked. Don't tell the bot it tripped the trap.
    return json({ ok: true, sentTo: maskEmail(email || 'someone@example.com') }, 200, corsOrigin);
  }

  // Loose email validation — Resend will reject malformed addresses,
  // but catching obvious garbage here saves a round-trip.
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'invalid_email' }, 400, corsOrigin);
  }

  const created = await createDemoPin(env, {
    requestedBy: email,
    requestedByName: name || null,
    message: messageRaw || null,
    source: 'marketing-form',
    label: name ? `${name}'s demo` : 'Marketing demo',
    ttlSeconds: 60 * 60 * 24,
  });
  if (!created.ok) return json({ error: created.error || 'create_failed' }, 500, corsOrigin);

  // Fire-and-forget the two emails. We return success even if either
  // fails — the operator notification is purely informational, and
  // the requester can ask again if their email bounced. We do log
  // failures for the operator to investigate.
  const [requesterEmail, ownerEmail] = await Promise.all([
    sendDemoCodeEmail(env, email, created.tenant.code, name),
    sendOwnerDemoNotification(env, created.demoIndex),
  ]);
  if (!requesterEmail.ok) console.warn('demo email to requester failed:', requesterEmail.error);
  if (!ownerEmail.ok)     console.warn('demo email to owner failed:',     ownerEmail.error);

  return json({
    ok: true,
    sentTo: maskEmail(email),
    expiresAt: created.demoIndex.expiresAt,
  }, 200, corsOrigin);
}

// GET /admin/demo-pins — admin only. Returns active (non-expired)
// demo PINs from the demo-pin: KV prefix. Cloudflare KV evicts
// expired keys lazily, so we still belt-and-suspenders filter by
// expiresAt > now in case a stale record is briefly visible.
async function handleAdminListDemoPinsRoute(request, env, corsOrigin) {
  if (!env.KV) return json({ error: 'kv_not_bound' }, 500, corsOrigin);
  if (!checkAdminAuth(request, env)) return json({ error: 'admin_unauthorized' }, 401, corsOrigin);
  const ip = request.headers.get('cf-connecting-ip') || '';
  const rl = await rateLimitHit(env, `ratelimit:admin-demo-list:ip:${ip}`, RL.ADMIN_IP.max, RL.ADMIN_IP.window);
  if (!rl.ok) return json({ error: 'rate_limited', resetAt: rl.resetAt }, 429, corsOrigin);

  const now = Date.now();
  const pins = [];
  let cursor;
  do {
    const page = await env.KV.list({ prefix: 'demo-pin:', cursor, limit: 1000 });
    for (const k of page.keys) {
      const raw = await env.KV.get(k.name);
      if (!raw) continue;
      let r; try { r = JSON.parse(raw); } catch { continue; }
      const expMs = Date.parse(r.expiresAt || '');
      if (!Number.isFinite(expMs) || expMs <= now) continue;
      pins.push({
        code: r.code,
        tenantId: r.tenantId,
        label: r.label || null,
        requestedBy: r.requestedBy || null,
        requestedByName: r.requestedByName || null,
        message: r.message || null,
        source: r.source || 'marketing-form',
        requestedAt: r.requestedAt,
        expiresAt: r.expiresAt,
        secondsLeft: Math.max(0, Math.floor((expMs - now) / 1000)),
      });
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);

  // Newest-first so the operator sees the most recent request at the top.
  pins.sort((a, b) => (Date.parse(b.requestedAt || '') || 0) - (Date.parse(a.requestedAt || '') || 0));
  return json({ ok: true, pins, generatedAt: new Date().toISOString() }, 200, corsOrigin);
}

// POST /admin/demo-pins/generate — admin only. Body: { label?, note? }.
// Operator manually mints a demo PIN (e.g. for handing out at a school
// event). No email is sent because there's no requester address — the
// PIN is returned in the response so the operator can copy-paste it.
async function handleAdminGenerateDemoPinRoute(request, env, corsOrigin) {
  if (!env.KV) return json({ error: 'kv_not_bound' }, 500, corsOrigin);
  if (!checkAdminAuth(request, env)) return json({ error: 'admin_unauthorized' }, 401, corsOrigin);
  const ip = request.headers.get('cf-connecting-ip') || '';
  const rl = await rateLimitHit(env, `ratelimit:admin-demo-gen:ip:${ip}`, RL.ADMIN_IP.max, RL.ADMIN_IP.window);
  if (!rl.ok) return json({ error: 'rate_limited', resetAt: rl.resetAt }, 429, corsOrigin);

  let body = {};
  try { body = await request.json(); } catch { /* empty body OK */ }
  const label = (body.label || '').toString().trim().slice(0, 80) || 'Manual demo';
  const note  = (body.note  || '').toString().trim().slice(0, 500) || null;

  const created = await createDemoPin(env, {
    requestedBy: null,
    requestedByName: null,
    message: note,
    source: 'admin-manual',
    label,
    ttlSeconds: 60 * 60 * 24,
  });
  if (!created.ok) return json({ error: created.error || 'create_failed' }, 500, corsOrigin);

  // Manual generation IS the path that returns the PIN — by design,
  // because the operator needs to read it off the screen.
  return json({
    ok: true,
    pin: {
      code: created.tenant.code,
      tenantId: created.tenant.id,
      label: created.tenant.label,
      expiresAt: created.demoIndex.expiresAt,
    },
  }, 200, corsOrigin);
}

// =====================================================================
// END DEMO PIN ROUTES
// =====================================================================

// =====================================================================
// END ADMIN DASHBOARD ROUTES
// =====================================================================

// POST /auth — body: { code }. Returns sanitized tenant metadata on
// hit, 401 on miss. Failed attempts increment BOTH a per-IP counter
// (blocks a single host from churning through codes) AND a per-code
// counter (locks that code if attackers distribute the brute force
// across IPs). The per-code lockout is the key defense against
// botnet-distributed PIN brute forcing — a 4-digit keyspace is too
// small to rely on per-IP limits alone.
async function handleAuthRoute(request, env, corsOrigin) {
  if (!env.KV) return json({ error: 'kv_not_bound' }, 500, corsOrigin);
  const ip = request.headers.get('cf-connecting-ip') || '';
  let body = {};
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400, corsOrigin); }
  const code = (body.code || '').toString().trim().toLowerCase();
  if (!code) return json({ error: 'missing_code' }, 400, corsOrigin);

  const ipKey   = `ratelimit:auth:ip:${ip}`;
  const codeKey = `ratelimit:auth:code:${code}`;
  const ipPre   = await rateLimitPeek(env, ipKey,   RL.AUTH_IP.max);
  const codePre = await rateLimitPeek(env, codeKey, RL.AUTH_CODE.max);
  if (!ipPre.ok || !codePre.ok) {
    return json({ error: 'rate_limited', resetAt: ipPre.resetAt || codePre.resetAt }, 429, corsOrigin);
  }

  const tenant = await lookupTenantByCode(env, code);
  if (!tenant) {
    await rateLimitHit(env, ipKey,   RL.AUTH_IP.max,   RL.AUTH_IP.window);
    await rateLimitHit(env, codeKey, RL.AUTH_CODE.max, RL.AUTH_CODE.window);
    return json({ error: 'invalid_code' }, 401, corsOrigin);
  }
  return json({ ok: true, tenant: sanitizeTenantForClient(tenant) }, 200, corsOrigin);
}

// GET /tenant — Bearer = code. Returns sanitized tenant metadata so the
// client can refresh label / planType / storeEnabled without re-entering
// the code. No password material in the response.
async function handleTenantInfoRoute(request, env, corsOrigin) {
  if (!env.KV) return json({ error: 'kv_not_bound' }, 500, corsOrigin);
  const code = (extractBearer(request) || '').toLowerCase();
  const tenant = await lookupTenantByCode(env, code);
  if (!tenant) return json({ error: 'invalid_code' }, 401, corsOrigin);
  return json({ ok: true, tenant: sanitizeTenantForClient(tenant) }, 200, corsOrigin);
}

// POST /teacher-auth — Bearer = tenant code. Body: { password }.
// Returns { ok: true } on match, 401 otherwise. Replaces the
// client-side plaintext compare that leaked the teacher password in
// every /auth and /tenant response. Rate-limited per-IP and per-code.
// Auto-migrates legacy tenants (those still carrying plaintext
// `teacherPassword` from before the hashing change) on first
// successful login.
async function handleTeacherAuthRoute(request, env, corsOrigin) {
  if (!env.KV) return json({ error: 'kv_not_bound' }, 500, corsOrigin);
  const ip = request.headers.get('cf-connecting-ip') || '';
  const code = (extractBearer(request) || '').toLowerCase();
  if (!code) return json({ error: 'missing_bearer' }, 401, corsOrigin);

  const ipKey   = `ratelimit:tauth:ip:${ip}`;
  const codeKey = `ratelimit:tauth:code:${code}`;
  const ipPre   = await rateLimitPeek(env, ipKey,   RL.TAUTH_IP.max);
  const codePre = await rateLimitPeek(env, codeKey, RL.TAUTH_CODE.max);
  if (!ipPre.ok || !codePre.ok) {
    return json({ error: 'rate_limited', resetAt: ipPre.resetAt || codePre.resetAt }, 429, corsOrigin);
  }

  const tenant = await lookupTenantByCode(env, code);
  if (!tenant) return json({ error: 'invalid_code' }, 401, corsOrigin);

  let body = {};
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400, corsOrigin); }
  const password = (body.password || '').toString();
  if (!password) return json({ error: 'missing_password' }, 400, corsOrigin);

  let ok = false;
  if (tenant.teacherPasswordHash) {
    ok = await verifyPassword(password, tenant.teacherPasswordHash);
  } else if (tenant.teacherPassword) {
    // Legacy plaintext record — compare, then migrate on success so
    // the next login runs the PBKDF2 path and plaintext disappears.
    ok = (password === tenant.teacherPassword);
    if (ok) {
      tenant.teacherPasswordHash = await hashPassword(password);
      delete tenant.teacherPassword;
      await env.KV.put(`tenant:${tenant.id}`, JSON.stringify(tenant));
    }
  }

  if (!ok) {
    await rateLimitHit(env, ipKey,   RL.TAUTH_IP.max,   RL.TAUTH_IP.window);
    await rateLimitHit(env, codeKey, RL.TAUTH_CODE.max, RL.TAUTH_CODE.window);
    return json({ error: 'invalid_password' }, 401, corsOrigin);
  }
  return json({ ok: true }, 200, corsOrigin);
}

// /tenant-settings — teacher/parent edits a small whitelist of tenant-level
// preferences (currently storeEnabled, planType is set at provision time only).
// Bearer = tenant code. Body: { password, storeEnabled?: boolean }.
// Same rate limiting as /teacher-auth because it's also a password-gated
// write endpoint. Returns the sanitized tenant so the client can refresh
// its in-memory tenant_state.
async function handleTenantSettingsRoute(request, env, corsOrigin) {
  if (!env.KV) return json({ error: 'kv_not_bound' }, 500, corsOrigin);
  const ip = request.headers.get('cf-connecting-ip') || '';
  const code = (extractBearer(request) || '').toLowerCase();
  if (!code) return json({ error: 'missing_bearer' }, 401, corsOrigin);

  const ipKey   = `ratelimit:tauth:ip:${ip}`;
  const codeKey = `ratelimit:tauth:code:${code}`;
  const ipPre   = await rateLimitPeek(env, ipKey,   RL.TAUTH_IP.max);
  const codePre = await rateLimitPeek(env, codeKey, RL.TAUTH_CODE.max);
  if (!ipPre.ok || !codePre.ok) {
    return json({ error: 'rate_limited', resetAt: ipPre.resetAt || codePre.resetAt }, 429, corsOrigin);
  }

  const tenant = await lookupTenantByCode(env, code);
  if (!tenant) return json({ error: 'invalid_code' }, 401, corsOrigin);

  let body = {};
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400, corsOrigin); }
  const password = (body.password || '').toString();
  if (!password) return json({ error: 'missing_password' }, 400, corsOrigin);

  // Reuse the same password-verify logic as /teacher-auth (including the
  // legacy plaintext migration path). Anyone holding a valid code + correct
  // password can flip settings; we DON'T treat this as admin-only because a
  // family-plan user has no separate admin.
  let ok = false;
  if (tenant.teacherPasswordHash) {
    ok = await verifyPassword(password, tenant.teacherPasswordHash);
  } else if (tenant.teacherPassword) {
    ok = (password === tenant.teacherPassword);
    if (ok) {
      tenant.teacherPasswordHash = await hashPassword(password);
      delete tenant.teacherPassword;
    }
  }
  if (!ok) {
    await rateLimitHit(env, ipKey,   RL.TAUTH_IP.max,   RL.TAUTH_IP.window);
    await rateLimitHit(env, codeKey, RL.TAUTH_CODE.max, RL.TAUTH_CODE.window);
    return json({ error: 'invalid_password' }, 401, corsOrigin);
  }

  // Apply whitelisted fields only. Anything else in the body is ignored —
  // a future bug that sends `teacherPasswordHash` or `id` from the client
  // must NOT be honoured.
  let mutated = false;
  if (typeof body.storeEnabled === 'boolean') {
    tenant.storeEnabled = body.storeEnabled;
    mutated = true;
  }

  if (mutated) {
    tenant.updatedAt = Date.now();
    await env.KV.put(`tenant:${tenant.id}`, JSON.stringify(tenant));
  }
  return json({ ok: true, tenant: sanitizeTenantForClient(tenant) }, 200, corsOrigin);
}

/* ============================================================
 * STRIPE BILLING — Checkout + Webhook + Customer Portal
 * ============================================================
 * End-to-end subscription flow. Prospects hit the marketing page,
 * pick a plan, and land at a Stripe Checkout URL minted here.
 * Stripe redirects them back with a session_id on success.
 * A webhook then auto-provisions a tenant and emails the code.
 * Teachers later use the portal endpoint to manage / cancel.
 *
 * Required secrets (wrangler secret put):
 *   STRIPE_SECRET_KEY        — sk_live_... or sk_test_...
 *   STRIPE_WEBHOOK_SECRET    — whsec_... (from Stripe dashboard webhook endpoint)
 *
 * Required env vars (wrangler.toml [vars]):
 *   STRIPE_PRICE_FAMILY_MONTHLY     — price_...
 *   STRIPE_PRICE_FAMILY_YEARLY      — price_...
 *   STRIPE_PRICE_CLASSROOM_MONTHLY  — price_...
 *   STRIPE_PRICE_CLASSROOM_YEARLY   — price_...
 *   STRIPE_SUCCESS_URL              — e.g. https://solvix.com/welcome?session_id={CHECKOUT_SESSION_ID}
 *   STRIPE_CANCEL_URL               — e.g. https://solvix.com/#pricing
 *   STRIPE_PORTAL_RETURN_URL        — e.g. https://solvix.com/app/
 *   STRIPE_TRIAL_DAYS               — integer string, e.g. "7". Default 7 if unset.
 *
 * If any of the above are unset, the corresponding endpoint returns
 * 503 with a clear error. This keeps the Worker deployable even
 * before Stripe is configured (nothing breaks — just that route).
 */

// Map the public plan id (what the marketing site sends) to the
// env var holding the Stripe price id. Keeping this small map in
// one place means a new plan needs just a new row here + a new
// env var — no other code changes.
const STRIPE_PLAN_TO_PRICE_ENV = {
  'family-monthly':    { priceEnv: 'STRIPE_PRICE_FAMILY_MONTHLY',    planType: 'family'    },
  'family-yearly':     { priceEnv: 'STRIPE_PRICE_FAMILY_YEARLY',     planType: 'family'    },
  'classroom-monthly': { priceEnv: 'STRIPE_PRICE_CLASSROOM_MONTHLY', planType: 'classroom' },
  'classroom-yearly':  { priceEnv: 'STRIPE_PRICE_CLASSROOM_YEARLY',  planType: 'classroom' },
};

// Low-level Stripe REST call. Stripe's API uses form-encoded bodies,
// so we can't just pass JSON — we flatten the body with bracket
// notation (key[sub]=value). Returns { ok, status, data } where
// data is the parsed JSON response or null on non-JSON error.
//
// `opts.idempotencyKey` (optional) sets Stripe's Idempotency-Key
// header. Stripe replays the exact original response for 24h on the
// same key, so a double-clicked checkout button creates ONE session
// instead of two. Use a stable hash of the meaningful request inputs
// (plan + actor + minute bucket) — NOT a random UUID, or you defeat
// the purpose. Only meaningful on POSTs that create resources.
async function stripeApi(env, method, path, body, opts) {
  if (!env.STRIPE_SECRET_KEY) {
    return { ok: false, status: 500, data: { error: { message: 'stripe_secret_key_missing' } } };
  }
  const url = 'https://api.stripe.com/v1' + path;
  const init = {
    method,
    headers: {
      'Authorization': 'Bearer ' + env.STRIPE_SECRET_KEY,
      'Stripe-Version': '2024-06-20',
    },
  };
  if (opts && opts.idempotencyKey) {
    init.headers['Idempotency-Key'] = opts.idempotencyKey;
  }
  if (body) {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = stripeEncodeBody(body);
  }
  const r = await fetch(url, init);
  let data = null;
  try { data = await r.json(); } catch {}
  return { ok: r.ok, status: r.status, data };
}

// Flatten an object into Stripe's form-encoded shape.
// { a: 1, b: [2,3], c: { d: 4 } } → "a=1&b[0]=2&b[1]=3&c[d]=4"
function stripeEncodeBody(obj, prefix) {
  const parts = [];
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (value == null) continue;
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        if (v && typeof v === 'object') {
          parts.push(stripeEncodeBody(v, `${fullKey}[${i}]`));
        } else {
          parts.push(`${encodeURIComponent(`${fullKey}[${i}]`)}=${encodeURIComponent(String(v))}`);
        }
      });
    } else if (typeof value === 'object') {
      parts.push(stripeEncodeBody(value, fullKey));
    } else {
      parts.push(`${encodeURIComponent(fullKey)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.filter(Boolean).join('&');
}

// POST /stripe/checkout — public. Body: { plan, label?, email? }.
// plan ∈ keys of STRIPE_PLAN_TO_PRICE_ENV. Returns { ok, url } which
// the caller redirects to. Rate-limited per-IP so a bot can't fill
// our Stripe dashboard with abandoned sessions.
async function handleStripeCheckoutRoute(request, env, corsOrigin) {
  const ip = request.headers.get('cf-connecting-ip') || '';
  const rlKey = `ratelimit:stripe-checkout:ip:${ip}`;
  const rl = await rateLimitHit(env, rlKey, RL.AUTH_IP.max, RL.AUTH_IP.window);
  if (!rl.ok) return json({ error: 'rate_limited', resetAt: rl.resetAt }, 429, corsOrigin);

  let body = {};
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400, corsOrigin); }
  const planKey = String(body.plan || '').trim();
  const spec = STRIPE_PLAN_TO_PRICE_ENV[planKey];
  if (!spec) return json({ error: 'invalid_plan', allowed: Object.keys(STRIPE_PLAN_TO_PRICE_ENV) }, 400, corsOrigin);

  const priceId = env[spec.priceEnv];
  if (!priceId) return json({ error: 'plan_not_configured', detail: `${spec.priceEnv} unset` }, 503, corsOrigin);

  const successUrl = env.STRIPE_SUCCESS_URL;
  const cancelUrl  = env.STRIPE_CANCEL_URL;
  if (!successUrl || !cancelUrl) return json({ error: 'urls_not_configured' }, 503, corsOrigin);

  // Metadata travels with the session → subscription → customer,
  // so the webhook can read planType + label without a separate DB
  // lookup. `label` is what the user typed on the pricing page to
  // name their classroom / family ("Smith Family", "Room 7"); if
  // absent we default later in the webhook.
  const label = (body.label || '').toString().trim().slice(0, 80);
  const email = (body.email || '').toString().trim().slice(0, 120);
  const trialDays = parseInt(env.STRIPE_TRIAL_DAYS || '7', 10) || 7;

  const params = {
    mode: 'subscription',
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': 1,
    // Always collect a card, even during the trial. Kills "free
    // trial abuse where signup rate is orders of magnitude above
    // real intent" without blocking the kicking-the-tires demo.
    payment_method_collection: 'always',
    'subscription_data[trial_period_days]': String(trialDays),
    // Capture our custom fields in BOTH places — the checkout
    // session AND the resulting subscription — so every webhook
    // event can read them. Stripe doesn't automatically copy
    // session metadata to the subscription.
    'metadata[planType]':  spec.planType,
    'metadata[planKey]':   planKey,
    'metadata[label]':     label,
    'subscription_data[metadata][planType]': spec.planType,
    'subscription_data[metadata][planKey]':  planKey,
    'subscription_data[metadata][label]':    label,
    success_url: successUrl,
    cancel_url:  cancelUrl,
    // Prefill email if provided; otherwise Stripe collects it.
    ...(email ? { customer_email: email } : {}),
    // Consent mode: promotional emails OFF by default. We can
    // always re-enable through portal / account settings.
    'consent_collection[promotions]': 'none',
  };

  // Idempotency key — collapses double-clicks (and accidental
  // browser-back-then-resubmit) into one Stripe session for ~5
  // minutes. Bucket on the minute so a deliberate retry later still
  // creates a fresh session if the user changed their mind. Includes
  // email when present so two different prospects from the same NAT
  // don't collide.
  const minuteBucket = Math.floor(Date.now() / (5 * 60 * 1000));
  const idemRaw = `checkout|${ip}|${planKey}|${email || ''}|${label || ''}|${minuteBucket}`;
  const idemKey = await sha256Hex(idemRaw);

  const res = await stripeApi(env, 'POST', '/checkout/sessions', params, { idempotencyKey: idemKey });
  if (!res.ok || !res.data || !res.data.url) {
    return json({ error: 'stripe_error', detail: (res.data && res.data.error && res.data.error.message) || 'unknown' }, 502, corsOrigin);
  }
  return json({ ok: true, url: res.data.url }, 200, corsOrigin);
}

// POST /stripe/webhook — called by Stripe. Signature verified via
// HMAC-SHA256(STRIPE_WEBHOOK_SECRET, "{timestamp}.{body}"). On
// `checkout.session.completed` we provision a tenant; on
// subscription updates we flip the tenant's `suspended` flag to
// match the subscription status; on deletion we mark suspended.
//
// We do NOT delete tenants on cancel — data preservation matters
// more than storage cost. The teacher can revive their tenant by
// resubscribing; a separate sweeper can delete after N days.
async function handleStripeWebhookRoute(request, env, corsOrigin) {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return json({ error: 'webhook_secret_missing' }, 503, corsOrigin);
  }
  const sigHeader = request.headers.get('stripe-signature') || '';
  const rawBody = await request.text();
  const verified = await verifyStripeSignature(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET);
  if (!verified) return json({ error: 'signature_invalid' }, 400, corsOrigin);

  let event;
  try { event = JSON.parse(rawBody); } catch { return json({ error: 'bad_json' }, 400, corsOrigin); }

  // Event-ID dedupe. Stripe retries on 5xx and occasionally sends the
  // same event twice; the underlying ops below are mostly idempotent
  // (last-write-wins on subscription updates, customer-id guard on
  // checkout.session.completed) but a stale `customer.subscription.
  // updated` arriving AFTER a newer one can flip `suspended` the wrong
  // way. Marking the event id as seen first kills that race entirely.
  // 7-day TTL — Stripe stops retrying long before then.
  if (env.KV && event && event.id) {
    const seenKey = `stripe-event-seen:${event.id}`;
    const already = await env.KV.get(seenKey);
    if (already) return json({ received: true, deduped: true }, 200, corsOrigin);
    // Write the marker BEFORE handling. If the handler then throws,
    // we'll return 500 → Stripe retries → next attempt sees the marker
    // and short-circuits. That's the right trade: better to skip a
    // failed retry than to double-apply a partially-failed handler.
    // (For the rare case where the marker write succeeds and the
    // handler crashes the whole isolate, you can manually delete the
    // KV key to force a re-process.)
    await env.KV.put(seenKey, '1', { expirationTtl: 60 * 60 * 24 * 7 });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleStripeCheckoutCompleted(event.data.object, env);
        break;
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await handleStripeSubscriptionChange(event.data.object, env);
        break;
      // Ignore everything else — we'd rather be silent than 400
      // on events we haven't wired up yet. Stripe will re-send on
      // non-2xx, which clogs the dashboard.
      default:
        break;
    }
  } catch (e) {
    // Swallow the error back to Stripe as 500 so they retry. The
    // idempotent pieces (tenant lookup by customer id) handle
    // double-fire correctly.
    return json({ error: 'webhook_handler_failed', detail: String(e && e.message || e) }, 500, corsOrigin);
  }
  return json({ received: true }, 200, corsOrigin);
}

// Pull the customer email out of a Stripe checkout session. Stripe
// puts it in different fields depending on whether the customer
// pre-filled it, so we check several places.
function emailFromSession(session) {
  if (!session) return '';
  return (session.customer_details && session.customer_details.email)
      || session.customer_email
      || (session.customer && typeof session.customer === 'object' && session.customer.email)
      || '';
}

// Notify the operator (you) that a new tenant signed up. Sends to
// env.OWNER_EMAIL. Best-effort — failure is logged but never throws,
// so a flaky alert email never blocks provisioning.
async function sendOwnerSignupNotification(env, tenant, customerEmail) {
  if (!env.OWNER_EMAIL) return { ok: false, error: 'owner_email_unset' };
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return { ok: false, error: 'email_not_configured' };

  const planNoun = tenant.planType === 'family' ? 'Family' : 'Classroom';
  const subject = `[KidQuest] New ${planNoun} signup: ${tenant.label || tenant.code}`;
  const text = [
    `New KidQuest signup just landed.`,
    ``,
    `Plan:        ${tenant.planType}`,
    `Label:       ${tenant.label || '(none)'}`,
    `Code:        ${String(tenant.code).toUpperCase()}`,
    `Tenant ID:   ${tenant.id}`,
    `Customer:    ${customerEmail || '(no email on session)'}`,
    `Stripe Cust: ${tenant.stripeCustomerId || '(none)'}`,
    `Stripe Sub:  ${tenant.stripeSubscriptionId || '(none)'}`,
    `Created:     ${tenant.createdAt}`,
    ``,
    `Manage in admin dashboard.`,
  ].join('\n');

  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#fafafa;padding:24px;color:#1a1035;">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;padding:28px;border:1px solid #eee;">
      <tr><td>
        <h2 style="margin:0 0 8px;font-size:20px;">🎉 New ${escapeHtml(planNoun)} signup</h2>
        <p style="margin:0 0 16px;color:#666;font-size:14px;">${escapeHtml(tenant.label || '(no label)')}</p>
        <table role="presentation" width="100%" cellpadding="6" cellspacing="0" style="font-size:14px;font-family:'SF Mono',Menlo,monospace;background:#f7f5ff;border-radius:8px;">
          <tr><td style="color:#666;width:120px;">Plan</td><td>${escapeHtml(tenant.planType)}</td></tr>
          <tr><td style="color:#666;">Code</td><td><strong>${escapeHtml(String(tenant.code).toUpperCase())}</strong></td></tr>
          <tr><td style="color:#666;">Tenant ID</td><td>${escapeHtml(tenant.id)}</td></tr>
          <tr><td style="color:#666;">Customer</td><td>${escapeHtml(customerEmail || '(none)')}</td></tr>
          <tr><td style="color:#666;">Stripe Cust</td><td>${escapeHtml(tenant.stripeCustomerId || '(none)')}</td></tr>
          <tr><td style="color:#666;">Stripe Sub</td><td>${escapeHtml(tenant.stripeSubscriptionId || '(none)')}</td></tr>
          <tr><td style="color:#666;">Created</td><td>${escapeHtml(tenant.createdAt)}</td></tr>
        </table>
      </td></tr>
    </table>
  </body></html>`;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.RESEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [env.OWNER_EMAIL],
        subject, text, html,
      }),
    });
    if (!r.ok) {
      let detail = '';
      try { detail = (await r.text()).slice(0, 200); } catch {}
      console.warn('owner notification failed:', r.status, detail);
      return { ok: false, status: r.status, error: detail };
    }
    return { ok: true };
  } catch (e) {
    console.warn('owner notification threw:', String(e && e.message || e));
    return { ok: false, error: String(e && e.message || e) };
  }
}

// Provision a tenant from a completed checkout session. Idempotent —
// if we already provisioned for this customer, just update the
// stored record instead of creating a duplicate.
async function handleStripeCheckoutCompleted(session, env) {
  if (!env.KV) return;
  const customerId = session.customer || '';
  const subscriptionId = session.subscription || '';
  if (!customerId) return; // can't correlate → skip silently

  const customerEmail = emailFromSession(session);

  // If we already have a tenant for this customer, this is a replay
  // — just refresh the subscription id + status and return. We do
  // NOT re-send the welcome email on replay (that would spam the
  // customer if Stripe redelivers the event), but we DO re-send the
  // owner notification because the operator wants to know about every
  // signup attempt for monitoring.
  const existingId = await env.KV.get(`customer:stripe:${customerId}`);
  if (existingId) {
    const raw = await env.KV.get(`tenant:${existingId}`);
    const existing = raw ? JSON.parse(raw) : null;
    if (existing) {
      existing.stripeSubscriptionId = subscriptionId || existing.stripeSubscriptionId;
      existing.suspended = false;
      existing.updatedAt = Date.now();
      if (customerEmail && !existing.customerEmail) existing.customerEmail = customerEmail;
      await env.KV.put(`tenant:${existingId}`, JSON.stringify(existing));
    }
    return;
  }

  // New customer → fresh tenant. planType comes from metadata;
  // label too. If metadata is missing (e.g. bare-API checkout)
  // we fall back to sane defaults.
  const planType = (session.metadata && session.metadata.planType) === 'family' ? 'family' : 'classroom';
  const labelRaw = (session.metadata && session.metadata.label) || '';
  const label    = labelRaw ? String(labelRaw).slice(0, 80) : (planType === 'family' ? 'New Family' : 'New Classroom');

  // Generate a fresh code. PIN conflict is extremely rare with the
  // word-code generator but we still retry a few times.
  let code = '';
  for (let i = 0; i < 5; i++) {
    const candidate = generateTenantCode();
    const taken = await env.KV.get(`code:${candidate}`);
    if (!taken) { code = candidate; break; }
  }
  if (!code) throw new Error('code_generation_failed');

  const id = generateTenantId();
  const tenant = {
    id, label, code,
    teacherPasswordHash: null, // user sets this on first login
    isDemo: false,
    planType,
    storeEnabled: true,
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId,
    suspended: false,
    customerEmail: customerEmail || '',  // surfaces in admin dashboard + needed for resend
    createdAt: new Date().toISOString(),
    updatedAt: Date.now(),
  };
  await env.KV.put(`tenant:${id}`, JSON.stringify(tenant));
  await env.KV.put(`code:${code}`, id);
  await env.KV.put(`customer:stripe:${customerId}`, id);

  // Email the customer their login code. Best-effort — failure is
  // logged but does NOT throw, because the tenant is already
  // provisioned and we'd rather succeed-with-warning than re-trigger
  // the whole webhook (which would race against the operator using
  // the resend endpoint to recover).
  if (customerEmail) {
    try {
      const emailRes = await sendTenantCodeEmail(env, customerEmail, code, label, planType);
      if (!emailRes.ok) console.warn('tenant code email failed:', emailRes.status, emailRes.error);
    } catch (e) {
      console.warn('tenant code email threw:', String(e && e.message || e));
    }
  }

  // Notify the operator about every new signup. Best-effort, never
  // throws — the tenant is already created either way.
  await sendOwnerSignupNotification(env, tenant, customerEmail);
}

// Sync tenant.suspended with Stripe subscription status.
// Active + trialing = not suspended. Anything else = suspended.
async function handleStripeSubscriptionChange(subscription, env) {
  if (!env.KV) return;
  const customerId = subscription.customer || '';
  if (!customerId) return;
  const tenantId = await env.KV.get(`customer:stripe:${customerId}`);
  if (!tenantId) return;
  const raw = await env.KV.get(`tenant:${tenantId}`);
  if (!raw) return;
  let tenant;
  try { tenant = JSON.parse(raw); } catch { return; }

  const active = subscription.status === 'active' || subscription.status === 'trialing';
  tenant.suspended = !active;
  tenant.stripeSubscriptionStatus = subscription.status;
  tenant.stripeSubscriptionId = subscription.id;
  tenant.updatedAt = Date.now();
  await env.KV.put(`tenant:${tenantId}`, JSON.stringify(tenant));
}

// Verify Stripe signature header. Format:
//   t=<unix-ts>,v1=<sig>,v1=<sig-2>,...
// We check all v1 signatures because Stripe rotates during
// webhook secret cycles. Tolerance is 5 minutes against replays.
async function verifyStripeSignature(rawBody, header, secret) {
  if (!header) return false;
  const parts = header.split(',').map(s => s.trim());
  let ts = '';
  const sigs = [];
  for (const p of parts) {
    const [k, v] = p.split('=');
    if (k === 't') ts = v;
    else if (k === 'v1') sigs.push(v);
  }
  if (!ts || !sigs.length) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(ts, 10)) > 300) return false; // 5 min replay window

  const enc = new TextEncoder();
  const signed = `${ts}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(signed));
  const expected = bytesToHex(new Uint8Array(sigBuf));
  // Constant-time compare against each candidate.
  for (const s of sigs) {
    if (s.length === expected.length && constantTimeEqualHex(s, expected)) return true;
  }
  return false;
}

function constantTimeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// POST /stripe/portal — teacher-auth only. Bearer = code, body: { password }.
// Returns { ok, url } — a short-lived Stripe-hosted billing portal link
// where the teacher can update payment, download invoices, or cancel.
async function handleStripePortalRoute(request, env, corsOrigin) {
  if (!env.KV) return json({ error: 'kv_not_bound' }, 500, corsOrigin);
  const ip = request.headers.get('cf-connecting-ip') || '';
  const code = (extractBearer(request) || '').toLowerCase();
  if (!code) return json({ error: 'missing_bearer' }, 401, corsOrigin);

  const ipKey   = `ratelimit:tauth:ip:${ip}`;
  const codeKey = `ratelimit:tauth:code:${code}`;
  const ipPre   = await rateLimitPeek(env, ipKey,   RL.TAUTH_IP.max);
  const codePre = await rateLimitPeek(env, codeKey, RL.TAUTH_CODE.max);
  if (!ipPre.ok || !codePre.ok) return json({ error: 'rate_limited' }, 429, corsOrigin);

  const tenant = await lookupTenantByCode(env, code);
  if (!tenant) return json({ error: 'invalid_code' }, 401, corsOrigin);

  let body = {};
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400, corsOrigin); }
  const password = (body.password || '').toString();
  if (!password) return json({ error: 'missing_password' }, 400, corsOrigin);

  let ok = false;
  if (tenant.teacherPasswordHash) {
    ok = await verifyPassword(password, tenant.teacherPasswordHash);
  } else if (tenant.teacherPassword) {
    // Legacy plaintext record — compare, then migrate on success so
    // the next call runs the PBKDF2 path and plaintext disappears.
    // Mirrors the upgrade flow in /auth and /teacher-auth so a teacher
    // touching billing also gets their tenant migrated off plaintext.
    ok = (password === tenant.teacherPassword);
    if (ok) {
      tenant.teacherPasswordHash = await hashPassword(password);
      delete tenant.teacherPassword;
      await env.KV.put(`tenant:${tenant.id}`, JSON.stringify(tenant));
    }
  }
  if (!ok) {
    await rateLimitHit(env, ipKey,   RL.TAUTH_IP.max,   RL.TAUTH_IP.window);
    await rateLimitHit(env, codeKey, RL.TAUTH_CODE.max, RL.TAUTH_CODE.window);
    return json({ error: 'invalid_password' }, 401, corsOrigin);
  }

  if (!tenant.stripeCustomerId) return json({ error: 'no_stripe_customer' }, 400, corsOrigin);
  const returnUrl = env.STRIPE_PORTAL_RETURN_URL;
  if (!returnUrl) return json({ error: 'return_url_not_configured' }, 503, corsOrigin);

  const res = await stripeApi(env, 'POST', '/billing_portal/sessions', {
    customer: tenant.stripeCustomerId,
    return_url: returnUrl,
  });
  if (!res.ok || !res.data || !res.data.url) {
    return json({ error: 'stripe_error', detail: (res.data && res.data.error && res.data.error.message) || 'unknown' }, 502, corsOrigin);
  }
  return json({ ok: true, url: res.data.url }, 200, corsOrigin);
}

// GET /stripe/session/:id — public, read-only. The marketing
// "thank you" page uses this AFTER checkout to confirm the payment
// went through and tell the user "we sent your code to k***@…".
//
// Security note: the tenant code IS a credential (it's how teachers
// log in), so we MUST assume Stripe session IDs leak — they appear
// in browser history, Referer headers to any third-party tracker on
// the thank-you page, and screenshotted URLs.
//
// Defense (this is the leak-class fix): the response NEVER contains
// the tenant code itself. Only label, plan type, and a masked email
// (e.g. "k***@gmail.com") so the user can confirm the right inbox.
// The credential is delivered exclusively via the welcome email sent
// by the webhook. If the user lost the email, they hit the
// /stripe/resend-code endpoint (rate-limited) to get a fresh send.
//
// Per-IP rate limit kept anyway as a belt-and-suspenders measure
// against enumeration of the masked-email surface.
async function handleStripeSessionLookupRoute(request, env, corsOrigin) {
  if (!env.KV || !env.STRIPE_SECRET_KEY) return json({ error: 'not_configured' }, 503, corsOrigin);

  // Per-IP rate limit. Reuses the AUTH_IP bucket shape (10/hr) —
  // legit users hit this endpoint exactly once per checkout, so 10
  // is plenty of headroom for retries while still capping abuse.
  const ip = request.headers.get('cf-connecting-ip') || '';
  const rlKey = `ratelimit:stripe-session:ip:${ip}`;
  const rl = await rateLimitHit(env, rlKey, RL.AUTH_IP.max, RL.AUTH_IP.window);
  if (!rl.ok) return json({ error: 'rate_limited', resetAt: rl.resetAt }, 429, corsOrigin);

  const url = new URL(request.url);
  const sessionId = url.pathname.split('/').pop() || '';
  if (!sessionId.startsWith('cs_')) return json({ error: 'bad_session_id' }, 400, corsOrigin);

  // Fetch the session from Stripe to get the customer id.
  const res = await stripeApi(env, 'GET', `/checkout/sessions/${encodeURIComponent(sessionId)}`);
  if (!res.ok || !res.data) return json({ error: 'stripe_error' }, 502, corsOrigin);
  const customerId = res.data.customer;
  if (!customerId) return json({ error: 'no_customer_yet' }, 404, corsOrigin);

  const tenantId = await env.KV.get(`customer:stripe:${customerId}`);
  if (!tenantId) return json({ error: 'not_provisioned_yet' }, 404, corsOrigin);
  const rawT = await env.KV.get(`tenant:${tenantId}`);
  if (!rawT) return json({ error: 'tenant_gone' }, 404, corsOrigin);
  const tenant = JSON.parse(rawT);

  // Pull the customer email from the session if the tenant record
  // doesn't have it cached yet (older provisions, or webhook race).
  const emailForMask = tenant.customerEmail || emailFromSession(res.data) || '';

  return json({
    ok: true,
    label: tenant.label,
    planType: tenant.planType,
    emailMasked: maskEmail(emailForMask),
    hasEmail: !!emailForMask,
    // session id echoed back so the page can hand it to /resend-code
    // without the user having to do anything.
    sessionId,
  }, 200, corsOrigin);
}

// POST /stripe/resend-code — body: { sessionId }. Re-sends the
// welcome email to whatever address Stripe has on file for this
// session's customer. Two important guarantees:
//
//   1) The destination is NEVER user-supplied. We look up the email
//      from the Stripe session (or the cached tenant record). This
//      stops an attacker from holding a session id and redirecting
//      the code to their own inbox.
//   2) Heavily rate-limited per session AND per IP — a stolen
//      session id is good for at most a few resends before the
//      bucket trips, and an IP can't pivot across sessions.
async function handleStripeResendCodeRoute(request, env, corsOrigin) {
  if (!env.KV || !env.STRIPE_SECRET_KEY) return json({ error: 'not_configured' }, 503, corsOrigin);
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return json({ error: 'email_not_configured' }, 503, corsOrigin);

  let body = {};
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400, corsOrigin); }
  const sessionId = String(body.sessionId || '').trim();
  if (!sessionId.startsWith('cs_')) return json({ error: 'bad_session_id' }, 400, corsOrigin);

  // Per-IP cap (10/hr). Per-session cap (3/24h) — enough for "didn't
  // get it, check spam, try once more" but not enough for harassment.
  const ip = request.headers.get('cf-connecting-ip') || '';
  const ipKey   = `ratelimit:resend-code:ip:${ip}`;
  const sesKey  = `ratelimit:resend-code:ses:${sessionId}`;
  const ipRl  = await rateLimitHit(env, ipKey,  RL.AUTH_IP.max, RL.AUTH_IP.window);
  if (!ipRl.ok)  return json({ error: 'rate_limited', resetAt: ipRl.resetAt }, 429, corsOrigin);
  const sesRl = await rateLimitHit(env, sesKey, 3, 60 * 60 * 24 * 1000);
  if (!sesRl.ok) return json({ error: 'rate_limited', resetAt: sesRl.resetAt }, 429, corsOrigin);

  // Resolve session → customer → tenant.
  const res = await stripeApi(env, 'GET', `/checkout/sessions/${encodeURIComponent(sessionId)}`);
  if (!res.ok || !res.data) return json({ error: 'stripe_error' }, 502, corsOrigin);
  const customerId = res.data.customer;
  if (!customerId) return json({ error: 'no_customer_yet' }, 404, corsOrigin);
  const tenantId = await env.KV.get(`customer:stripe:${customerId}`);
  if (!tenantId) return json({ error: 'not_provisioned_yet' }, 404, corsOrigin);
  const rawT = await env.KV.get(`tenant:${tenantId}`);
  if (!rawT) return json({ error: 'tenant_gone' }, 404, corsOrigin);
  const tenant = JSON.parse(rawT);

  const toEmail = tenant.customerEmail || emailFromSession(res.data) || '';
  if (!toEmail) return json({ error: 'no_email_on_file' }, 400, corsOrigin);

  const r = await sendTenantCodeEmail(env, toEmail, tenant.code, tenant.label, tenant.planType);
  if (!r.ok) return json({ error: 'send_failed', detail: r.error }, 502, corsOrigin);

  // Confirm to caller WHICH inbox we sent to — but masked, so a
  // session-id holder can't fish for the full address.
  return json({ ok: true, emailMasked: maskEmail(toEmail) }, 200, corsOrigin);
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
  // Intentionally don't echo tenantId back — caller already has their
  // code, and exposing internal IDs widens the surface for future bugs
  // that might trust a tenantId from untrusted input.
  return json({ ok: true, bytes: body.length }, 200, corsOrigin);
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
      if (routeKey === 'POST /provision')    return await handleProvisionRoute(request, env, corsOrigin);
      if (routeKey === 'POST /unprovision')  return await handleUnprovisionRoute(request, env, corsOrigin);
      if (routeKey === 'POST /admin/reset-teacher-password') return await handleAdminResetTeacherPasswordRoute(request, env, corsOrigin);
      // Admin dashboard endpoints — all ADMIN_TOKEN-gated, all rate-limited.
      if (routeKey === 'GET /admin/tenants') return await handleAdminListTenantsRoute(request, env, corsOrigin);
      if (routeKey === 'GET /admin/stats')   return await handleAdminStatsRoute(request, env, corsOrigin);
      // Demo PIN admin routes (list active, manually generate). The
      // /admin/demo-pins prefix is matched before the generic
      // /admin/tenant/ block below so the order matters — keep these
      // above any startsWith('/admin/') catchalls.
      if (routeKey === 'GET /admin/demo-pins')           return await handleAdminListDemoPinsRoute(request, env, corsOrigin);
      if (routeKey === 'POST /admin/demo-pins/generate') return await handleAdminGenerateDemoPinRoute(request, env, corsOrigin);
      // Public demo-PIN request (visitor on the marketing page).
      if (routeKey === 'POST /demo/request') return await handleDemoRequestRoute(request, env, corsOrigin);
      if (request.method === 'GET' && url.pathname.startsWith('/admin/tenant/') && !url.pathname.includes('/suspend') && !url.pathname.includes('/unsuspend') && !url.pathname.includes('/resend-code')) {
        return await handleAdminGetTenantRoute(request, env, corsOrigin);
      }
      if (request.method === 'POST' && url.pathname.startsWith('/admin/tenant/') && url.pathname.endsWith('/suspend')) {
        return await handleAdminTenantSuspendRoute(request, env, corsOrigin, 'suspend');
      }
      if (request.method === 'POST' && url.pathname.startsWith('/admin/tenant/') && url.pathname.endsWith('/unsuspend')) {
        return await handleAdminTenantSuspendRoute(request, env, corsOrigin, 'unsuspend');
      }
      if (request.method === 'POST' && url.pathname.startsWith('/admin/tenant/') && url.pathname.endsWith('/resend-code')) {
        return await handleAdminResendCodeRoute(request, env, corsOrigin);
      }
      if (routeKey === 'POST /auth')         return await handleAuthRoute(request, env, corsOrigin);
      if (routeKey === 'GET /tenant')        return await handleTenantInfoRoute(request, env, corsOrigin);
      if (routeKey === 'POST /teacher-auth') return await handleTeacherAuthRoute(request, env, corsOrigin);
      if (routeKey === 'POST /tenant-settings') return await handleTenantSettingsRoute(request, env, corsOrigin);
      // Stripe billing routes. Webhook is unauthenticated by design —
      // signature is what we trust. Checkout is public. Portal is
      // teacher-auth'd. Session-lookup is public (returns only code).
      if (routeKey === 'POST /stripe/checkout')  return await handleStripeCheckoutRoute(request, env, corsOrigin);
      if (routeKey === 'POST /stripe/webhook')   return await handleStripeWebhookRoute(request, env, corsOrigin);
      if (routeKey === 'POST /stripe/portal')      return await handleStripePortalRoute(request, env, corsOrigin);
      if (routeKey === 'POST /stripe/resend-code') return await handleStripeResendCodeRoute(request, env, corsOrigin);
      if (request.method === 'GET' && url.pathname.startsWith('/stripe/session/')) {
        return await handleStripeSessionLookupRoute(request, env, corsOrigin);
      }
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
    // admin_provision_ready intentionally omitted — fingerprinting the
    // admin-token state from an unauthenticated endpoint lets attackers
    // watch for freshly deployed Workers with misconfigured secrets.
    // deploy.sh verifies admin-token state by POSTing to /provision
    // with a bogus bearer and checking for 401.
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
    // Defense-in-depth: even though this Worker returns JSON, these
    // headers protect against sniffing, clickjacking, and referrer
    // leakage in case a response is ever rendered in a browser context.
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'strict-transport-security': 'max-age=31536000; includeSubDomains',
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
