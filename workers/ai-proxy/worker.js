/* Solvix AI Proxy — Cloudflare Worker
 * ---------------------------------------------------------------
 * Single worker that fronts Anthropic / OpenAI / other AI providers
 * for every AI-powered feature on the Solvix site. One worker,
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
// Every lesson in Solvix is tagged with Ontario Curriculum metadata:
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
  // Refunds are MONEY OUT. If the admin token leaks, refund spam is
  // the highest-impact abuse path — every successful call drains real
  // dollars to a real card. Tighter than ADMIN_IP on purpose: 10/hr is
  // plenty for legit operator use (you're not refunding 30 customers
  // an hour) and caps blast radius if a token is in the wild before
  // we notice the OWNER_EMAIL alerts.
  REFUND_IP:  { max: 10, window: 60 * 60 * 1000 },
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
// Tenant id is deterministic (`reserved-{slug}`) so that even after a
// full KV wipe + self-heal, the data namespace is the same — kids who
// used PIN 2228 a month ago still see their progress when they come
// back. Different reserved PINs get different deterministic ids, so
// they don't share data with each other.
//
// DUAL-DEMO MODEL — same PIN, two dashboards:
// PIN 2228 powers BOTH the parent demo and the teacher demo. The user
// types `2228`; the marketing page / app appends `:parent` or `:teacher`
// to disambiguate before calling /auth. Each variant lives in its own
// KV namespace (`reserved-2228-parent` vs `reserved-2228-teacher`) so
// the rosters never collide. Bare `2228` is kept as a back-compat
// alias for old builds and resolves to the teacher demo (matches what
// shipped before the dual-demo split).
//
// Settings used on self-heal:
//   isDemo: true             — flagged as demo in admin UI / CSS
//   planType: 'family'/'classroom' — drives the parent vs teacher dashboard
//   teacherPasswordHash:null — no teacher gate; the PIN is the only secret
//   storeEnabled: true       — rewards shop visible
//
// To add another reserved PIN: add an entry below + redeploy. To change
// settings: bump the entry, then once-off `wrangler kv key delete
// tenant:reserved-{slug}` (the next /auth re-creates from the template).
const RESERVED_TENANTS = {
  // Parent demo — family plan → Parent Hub dashboard, 5-kid roster.
  '2228:parent': {
    id: 'reserved-2228-parent',
    label: 'Solvix Family Demo',
    code: '2228:parent',
    teacherPasswordHash: null,
    isDemo: true,
    demoMode: 'parent',
    planType: 'family',
    storeEnabled: true,
    createdAt: '2026-04-22T00:00:00.000Z',
    reserved: true,
  },
  // Teacher demo — classroom plan → Teacher Dashboard, full grade roster.
  '2228:teacher': {
    id: 'reserved-2228-teacher',
    label: 'Solvix Classroom Demo',
    code: '2228:teacher',
    teacherPasswordHash: null,
    isDemo: true,
    demoMode: 'teacher',
    planType: 'classroom',
    storeEnabled: true,
    createdAt: '2026-04-22T00:00:00.000Z',
    reserved: true,
  },
  // Back-compat: bare `2228` from pre-dual-demo app builds resolves to
  // the teacher demo (the original behavior). Kept as a real entry so
  // self-heal still works for any legacy bookmarks.
  '2228': {
    id: 'reserved-2228-teacher',
    label: 'Solvix Classroom Demo',
    code: '2228',
    teacherPasswordHash: null,
    isDemo: true,
    demoMode: 'teacher',
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

// Generate a fresh tenant code — a 4-digit PIN.
//
// Why digits, not the word-codes this used to return: the tenant gate
// UI in app/index.html hard-codes the input to maxlength=4 +
// pattern=[0-9]*. A word-code like "mint-star-brook-59" minted by the
// Stripe webhook can't be typed into that input at all, so paying
// customers got an unenterable code in their welcome email. Switching
// to a PIN keeps the existing UI/marketing copy ("Enter your PIN")
// honest and matches the demo PIN format already in use.
//
// 10,000-PIN space is fine for current scale; the per-call KV
// existence check at the call site protects against collisions with
// previously-minted codes. If we ever ship more than ~2,000 tenants
// we should widen the gate UI to accept a 5- or 6-digit PIN and bump
// the modulo here; until then 4 digits keeps the kid-typing UX.
//
// We re-roll past reserved codes (demo PINs) so a paying customer
// never accidentally gets handed the read-only demo tenant.
function generateTenantCode() {
  const a = new Uint32Array(1);
  for (let i = 0; i < 30; i++) {
    crypto.getRandomValues(a);
    const candidate = String(a[0] % 10000).padStart(4, '0');
    if (!isReservedCode(candidate)) return candidate;
  }
  // 30 reserved-code hits in a row is statistically impossible with
  // the current ~3-entry RESERVED_TENANTS table, but guard anyway so
  // we never return a reserved code.
  return String((Date.now() ^ 0x9E3779B1) % 10000).padStart(4, '0');
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
//   env.EMAIL_FROM      (var)     — "Solvix <admin@kidquest.fun>"
//                                   The sender domain MUST be verified
//                                   in Resend; otherwise sends fail
//                                   immediately with 403.
// Optional:
//   env.EMAIL_REPLY_TO  (var)     — e.g. "admin@kidquest.fun"
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

  const subject = `Your Solvix login code: ${codeUpper}`;
  // Plain-text fallback for clients that prefer it (Apple Mail, etc.)
  const text = [
    `Welcome to Solvix!`,
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
          <h1 style="margin:0 0 8px;font-size:24px;font-weight:800;color:#1A1035;">🎉 Welcome to Solvix!</h1>
          <p style="margin:0 0 24px;font-size:16px;line-height:1.5;color:#5B5580;">Your ${escapeHtml(planNoun)} <strong>${labelClean}</strong> is ready to go.</p>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#6C5CE7,#A29BFE);border-radius:18px;padding:24px;text-align:center;margin:0 0 24px;">
            <tr><td align="center">
              <div style="font-size:12px;font-weight:700;letter-spacing:1.5px;color:#fff;opacity:0.85;text-transform:uppercase;margin-bottom:8px;">Your Login Code</div>
              <div style="font-size:38px;font-weight:800;letter-spacing:0.08em;color:#fff;font-family:'SF Mono',Menlo,monospace;">${escapeHtml(codeUpper)}</div>
            </td></tr>
          </table>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
            <tr><td align="center">
              <a href="${escapeHtml(appUrl)}" style="display:inline-block;background:#6C5CE7;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 28px;border-radius:999px;">Open Solvix →</a>
            </td></tr>
          </table>

          <div style="background:#F7F5FF;padding:18px 22px;border-radius:14px;margin:0 0 20px;">
            <p style="margin:0 0 8px;font-size:14px;font-weight:700;color:#1A1035;">What's next:</p>
            <ol style="margin:0;padding-left:20px;color:#5B5580;font-size:14px;line-height:1.7;">
              <li>Click <strong>Open Solvix</strong> above.</li>
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

  const subject = `Your Solvix demo code: ${codeUpper}`;
  const text = [
    `Thanks for trying Solvix!`,
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
          <h1 style="margin:0 0 8px;font-size:24px;font-weight:800;color:#1A1035;">🎮 Your Solvix demo is ready</h1>
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
              <a href="${escapeHtml(appUrl)}" style="display:inline-block;background:#6C5CE7;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 28px;border-radius:999px;">Try Solvix →</a>
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

  const subject = `[Solvix] Demo requested: ${demo.requestedBy || '(no email)'}`;
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
    // demoMode: 'parent' | 'teacher' for dual-demo tenants. Lets the
    // app render a friendly "Parent Demo" / "Teacher Demo" banner and
    // pick the right canned roster. Undefined for non-demo tenants.
    demoMode: tenant.demoMode || undefined,
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
  await env.KV.delete(`tenant:${tenantId}:audit-snapshots`);
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

// POST /teacher-set-initial-password — Bearer = code. Body: { password }.
// Lets a brand-new tenant (Stripe checkout just created their record with
// teacherPasswordHash:null) set the parent/teacher password themselves
// the first time they sign in, without an admin round-trip.
//
// This is NOT a "change password" endpoint — it is intentionally a
// one-shot. If a password (hashed OR legacy plaintext) is already on
// file, we refuse with `password_already_set` and the caller is told
// to use the regular login form (or contact support for a reset).
// That's what makes it safe to expose without an existing-password
// challenge: the only window in which it can write is when there is
// no password to challenge against in the first place.
//
// Same per-IP + per-code rate limits as /teacher-auth so an attacker
// can't farm fresh tenants at scale even if they somehow knew a code
// before the legitimate customer did.
async function handleTeacherSetInitialPasswordRoute(request, env, corsOrigin) {
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

  let body = {};
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400, corsOrigin); }
  const password = (body.password || '').toString();
  if (!password) return json({ error: 'missing_password' }, 400, corsOrigin);
  if (password.length < 4) return json({ error: 'password_too_short', detail: 'min 4 characters' }, 400, corsOrigin);
  if (password.length > 64) return json({ error: 'password_too_long', detail: 'max 64 characters' }, 400, corsOrigin);

  const tenantId = (await env.KV.get(`code:${code}`)) || '';
  if (!tenantId) {
    // Burn a rate-limit hit on bad codes so this can't be used to
    // probe valid codes any faster than /teacher-auth itself can.
    await rateLimitHit(env, ipKey,   RL.TAUTH_IP.max,   RL.TAUTH_IP.window);
    await rateLimitHit(env, codeKey, RL.TAUTH_CODE.max, RL.TAUTH_CODE.window);
    return json({ error: 'invalid_code' }, 401, corsOrigin);
  }
  const raw = await env.KV.get(`tenant:${tenantId}`);
  if (!raw) return json({ error: 'tenant_record_missing' }, 404, corsOrigin);
  let tenant; try { tenant = JSON.parse(raw); } catch { return json({ error: 'tenant_malformed' }, 500, corsOrigin); }

  // The whole point of the endpoint is that it ONLY works when no
  // password is set yet. If somebody already configured one, we refuse
  // — they can use /teacher-auth to log in, or ask the admin for a
  // reset via /admin/reset-teacher-password.
  if (tenant.teacherPasswordHash || tenant.teacherPassword) {
    return json({ error: 'password_already_set' }, 409, corsOrigin);
  }

  tenant.teacherPasswordHash = await hashPassword(password);
  tenant.updatedAt = Date.now();
  await env.KV.put(`tenant:${tenantId}`, JSON.stringify(tenant));

  return json({ ok: true, tenantId, code }, 200, corsOrigin);
}

// =====================================================================
// GLOBAL MAINTENANCE GATE
// =====================================================================
// Single KV key (`global:maintenance`) controls a site-wide gate that
// the client checks via /health on every page load and every cloud
// poll. When active, every tenant + the demo tenants AND any users
// who haven't yet entered a tenant code see the same hold screen.
//
// Why global vs per-tenant: per-tenant maintenance (lives in
// allData.maintenance inside each tenant's data blob) requires the
// teacher to log into each tenant separately to flip the gate. That's
// fine for a single classroom doing local cleanup, but useless for the
// operator pre-deploy: there's no way to gate every tenant at once
// without flipping each one by hand. The global gate is the operator's
// "deploying now, hold tight" lever — one toggle, every user holds.
//
// Storage shape (JSON in `global:maintenance`):
//   { active: boolean, message: string, updatedAt: number }
// Default (no key set) = inactive.
//
// Resolution order on the client:
//   1. Per-tenant maintenance (kid-mid-activity exception, etc.)
//   2. Global maintenance (no exceptions — operator-driven)
// Either one being active shows the hold screen.

async function getGlobalMaintenance(env) {
  if (!env.KV) return { active: false, message: '', updatedAt: 0 };
  const raw = await env.KV.get('global:maintenance');
  if (!raw) return { active: false, message: '', updatedAt: 0 };
  try {
    const v = JSON.parse(raw);
    return {
      active: !!v.active,
      message: typeof v.message === 'string' ? v.message : '',
      updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : 0,
    };
  } catch {
    return { active: false, message: '', updatedAt: 0 };
  }
}

// POST /admin/global-maintenance — admin only. Body: { active, message? }.
// Flips the global gate and updates the message shown on the hold screen.
// Effect is immediate: every /health response from this point reports
// the new state, and clients pick it up on their next poll (~25s).
async function handleAdminGlobalMaintenanceRoute(request, env, corsOrigin) {
  if (!env.KV) return json({ error: 'kv_not_bound' }, 500, corsOrigin);
  if (!checkAdminAuth(request, env)) return json({ error: 'admin_unauthorized' }, 401, corsOrigin);
  const ip = request.headers.get('cf-connecting-ip') || '';
  const rl = await rateLimitHit(env, `ratelimit:admin-globalmaint:ip:${ip}`, RL.ADMIN_IP.max, RL.ADMIN_IP.window);
  if (!rl.ok) return json({ error: 'rate_limited', resetAt: rl.resetAt }, 429, corsOrigin);

  let body = {};
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400, corsOrigin); }
  const active = !!body.active;
  // Cap message length so a typo can't write 100KB into KV. Default
  // empty so the client falls back to its built-in friendly copy.
  const message = (body.message || '').toString().slice(0, 500);
  const next = { active, message, updatedAt: Date.now() };
  await env.KV.put('global:maintenance', JSON.stringify(next));
  return json({ ok: true, maintenance: next }, 200, corsOrigin);
}

// GET /admin/global-maintenance — admin only. Read-only state inspection.
async function handleAdminGetGlobalMaintenanceRoute(request, env, corsOrigin) {
  if (!env.KV) return json({ error: 'kv_not_bound' }, 500, corsOrigin);
  if (!checkAdminAuth(request, env)) return json({ error: 'admin_unauthorized' }, 401, corsOrigin);
  const ip = request.headers.get('cf-connecting-ip') || '';
  const rl = await rateLimitHit(env, `ratelimit:admin-globalmaint:ip:${ip}`, RL.ADMIN_IP.max, RL.ADMIN_IP.window);
  if (!rl.ok) return json({ error: 'rate_limited', resetAt: rl.resetAt }, 429, corsOrigin);
  const m = await getGlobalMaintenance(env);
  return json({ ok: true, maintenance: m }, 200, corsOrigin);
}

// =====================================================================
// GLOBAL PRIZE CATALOG
// =====================================================================
// Single operator-managed catalog of physical rewards every tenant sees.
// Lives in KV under `global:store:catalog`. Teachers/parents do NOT
// edit prizes — they only flip `storeEnabled` (per-tenant) and toggle
// per-item `catalogOverrides` (per-item availability) in their dashboard.
//
// Why a single catalog instead of per-tenant: kids across all tenants
// effectively choose from the same Solvix-administered prize wall, so
// inventory + pricing decisions stay in one place. If a tenant wants a
// custom prize they ask the operator — that's by design.
//
// Public read (`GET /store/catalog`) is uncached at the Worker layer
// but carries a 2-minute browser Cache-Control hint. The app also
// localStorages the response so kids don't see a flash of "loading"
// when they tap the Shop tab.

const CATALOG_MAX_ITEMS = 200;
const CATALOG_MAX_BYTES = 200 * 1024; // 200 KB ceiling on KV write

// Whitelist of fields we persist. Anything else the operator pastes
// in gets silently dropped — keeps clients from being surprised by
// fields they don't render, and keeps the KV blob small.
function sanitizeCatalogItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim().slice(0, 60).replace(/[^a-z0-9_\-]/gi, '');
  if (!id) return null;
  const name = String(raw.name || '').trim().slice(0, 120);
  if (!name) return null;
  const category = String(raw.category || '').trim().slice(0, 40) || 'misc';
  const emoji = String(raw.emoji || '').trim().slice(0, 8) || '🎁';
  const description = String(raw.description || '').trim().slice(0, 500);
  const approxPrice = Number.isFinite(+raw.approxPrice) ? Math.max(0, +raw.approxPrice) : 0;
  const coinCost = Number.isFinite(+raw.coinCost) ? Math.max(0, Math.floor(+raw.coinCost)) : 0;
  const image = (raw.image == null || raw.image === '') ? null : String(raw.image).slice(0, 500);
  const amazonLink = String(raw.amazonLink || '').slice(0, 500);
  const isAvailable = raw.isAvailable !== false; // default true
  const special = !!raw.special;
  const r = (raw.requirements && typeof raw.requirements === 'object') ? raw.requirements : {};
  const challenge = (r.challenge === 'easy' || r.challenge === 'medium' || r.challenge === 'hard')
    ? r.challenge : 'easy';
  const requirements = {
    minLevels:   Number.isFinite(+r.minLevels)   ? Math.max(0, Math.floor(+r.minLevels))   : 1,
    minSubjects: Number.isFinite(+r.minSubjects) ? Math.max(0, Math.floor(+r.minSubjects)) : 1,
    challenge,
  };
  return { id, name, category, emoji, description, approxPrice, coinCost,
           image, amazonLink, isAvailable, special, requirements };
}

async function getStoreCatalog(env) {
  if (!env.KV) return null;
  const raw = await env.KV.get('global:store:catalog');
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!v || !Array.isArray(v.items)) return null;
    return {
      items: v.items,
      updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : 0,
      updatedBy: typeof v.updatedBy === 'string' ? v.updatedBy : '',
    };
  } catch {
    return null;
  }
}

// GET /store/catalog — public (origin-gated). Returns the operator-set
// catalog so the app can populate the rewards Shop. If KV is empty
// (first-run, before the operator seeds it via /admin/), responds 404
// with `no_catalog` — the app falls back to its hardcoded seed array.
async function handleStoreCatalogRoute(request, env, corsOrigin) {
  if (!env.KV) return json({ error: 'kv_not_bound' }, 500, corsOrigin);
  // No tenant auth — every visitor can read the prize wall. Light
  // per-IP rate limit so a misbehaving client can't pound KV.
  const ip = request.headers.get('cf-connecting-ip') || '';
  const rl = await rateLimitHit(env, `ratelimit:store-catalog:ip:${ip}`, 120, 60);
  if (!rl.ok) return json({ error: 'rate_limited', resetAt: rl.resetAt }, 429, corsOrigin);
  const cat = await getStoreCatalog(env);
  if (!cat) return json({ ok: false, error: 'no_catalog' }, 404, corsOrigin);
  // Browser cache for 2 minutes — keeps the Shop tab snappy without
  // making catalog edits take forever to propagate to live tabs.
  return new Response(JSON.stringify({ ok: true, catalog: cat.items, updatedAt: cat.updatedAt }), {
    status: 200,
    headers: {
      ...corsHeaders(corsOrigin),
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=120',
    },
  });
}

// GET /admin/store/catalog — admin only. Returns the full catalog
// (including private fields like updatedBy) for the admin editor UI.
async function handleAdminGetStoreCatalogRoute(request, env, corsOrigin) {
  if (!env.KV) return json({ error: 'kv_not_bound' }, 500, corsOrigin);
  if (!checkAdminAuth(request, env)) return json({ error: 'admin_unauthorized' }, 401, corsOrigin);
  const ip = request.headers.get('cf-connecting-ip') || '';
  const rl = await rateLimitHit(env, `ratelimit:admin-catalog:ip:${ip}`, RL.ADMIN_IP.max, RL.ADMIN_IP.window);
  if (!rl.ok) return json({ error: 'rate_limited', resetAt: rl.resetAt }, 429, corsOrigin);
  const cat = await getStoreCatalog(env);
  if (!cat) {
    // Surface "no catalog yet" explicitly rather than 404'ing — the
    // admin UI uses this to show a "Seed from defaults" button.
    return json({ ok: true, catalog: [], updatedAt: 0, updatedBy: '', empty: true }, 200, corsOrigin);
  }
  return json({ ok: true, catalog: cat.items, updatedAt: cat.updatedAt, updatedBy: cat.updatedBy }, 200, corsOrigin);
}

// POST /admin/store/catalog — admin only. Body: { catalog: [...item] }.
// Replaces the entire catalog. We accept full replacement (not patch)
// because the operator UI always sends the full edited list — keeps
// the wire protocol dead simple and avoids merge-conflict edge cases.
async function handleAdminSetStoreCatalogRoute(request, env, corsOrigin) {
  if (!env.KV) return json({ error: 'kv_not_bound' }, 500, corsOrigin);
  if (!checkAdminAuth(request, env)) return json({ error: 'admin_unauthorized' }, 401, corsOrigin);
  const ip = request.headers.get('cf-connecting-ip') || '';
  const rl = await rateLimitHit(env, `ratelimit:admin-catalog:ip:${ip}`, RL.ADMIN_IP.max, RL.ADMIN_IP.window);
  if (!rl.ok) return json({ error: 'rate_limited', resetAt: rl.resetAt }, 429, corsOrigin);

  let body = {};
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400, corsOrigin); }
  const incoming = Array.isArray(body.catalog) ? body.catalog : null;
  if (!incoming) return json({ error: 'missing_catalog' }, 400, corsOrigin);
  if (incoming.length > CATALOG_MAX_ITEMS) {
    return json({ error: 'too_many_items', max: CATALOG_MAX_ITEMS }, 400, corsOrigin);
  }
  // Sanitize + dedupe by id. Last write wins for duplicate ids since
  // the operator probably meant to update the later one.
  const byId = new Map();
  const rejected = [];
  for (let i = 0; i < incoming.length; i++) {
    const clean = sanitizeCatalogItem(incoming[i]);
    if (!clean) { rejected.push(i); continue; }
    byId.set(clean.id, clean);
  }
  const items = [...byId.values()];
  if (items.length === 0) return json({ error: 'empty_catalog', rejected }, 400, corsOrigin);

  const now = Date.now();
  const blob = { items, updatedAt: now, updatedBy: 'admin' };
  const serialized = JSON.stringify(blob);
  if (serialized.length > CATALOG_MAX_BYTES) {
    return json({ error: 'catalog_too_large', maxBytes: CATALOG_MAX_BYTES, got: serialized.length }, 413, corsOrigin);
  }
  await env.KV.put('global:store:catalog', serialized);
  return json({ ok: true, count: items.length, rejected, updatedAt: now }, 200, corsOrigin);
}

// =====================================================================
// GLOBAL CURRICULUM OVERRIDES
// =====================================================================
// One operator-managed layer that sits BETWEEN the bundled WEEKS
// (hardcoded in app/index.html) and per-tenant tutor overrides
// (allData.curriculum.overrides). Lets the operator fix bugs in the
// shipped curriculum (e.g. a Grade 3 reading lesson missing its
// passage) without redeploying the SPA — the change propagates to
// every tenant on next page load.
//
// Storage: single KV blob `global:curriculum:overrides`. Shape:
//   {
//     overrides: { [activityId]: { ...partial activity fields } },
//     updatedAt: <ms>,
//     updatedBy: 'admin',
//   }
// Each override is shallow-merged into the matching base activity
// (same semantics as applyCurriculumOverride in the app). Setting
// `_hidden: true` removes the activity from the merged output.
//
// Wire protocol uses single-activity PUT/DELETE (not full-blob
// replacement) so two operators editing different lessons can't
// clobber each other. Conflicts on the SAME activity still last-
// write-wins, but that's an extreme edge case.

const CURRICULUM_OVERRIDES_KEY = 'global:curriculum:overrides';
// Soft cap on a single override's serialized size — a generous
// activity payload (lesson + 10 questions with passages) is
// comfortably under 8 KB; 32 KB leaves room for stretchQuestions
// and unusual content without inviting abuse.
const CURRICULUM_OVERRIDE_MAX_BYTES = 32 * 1024;
// Cap on total overrides count — at ~150 lessons in the shipped
// curriculum, 500 is plenty of headroom for future weeks.
const CURRICULUM_OVERRIDES_MAX_COUNT = 500;
// Activity ids look like `w1-akshayan-r5` — letters, digits, hyphens.
const ACTIVITY_ID_RE = /^[a-z0-9][a-z0-9_-]{1,80}$/i;

async function loadCurriculumOverrides(env) {
  if (!env.KV) return null;
  const raw = await env.KV.get(CURRICULUM_OVERRIDES_KEY);
  if (!raw) return { overrides: {}, updatedAt: 0, updatedBy: '' };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { overrides: {}, updatedAt: 0, updatedBy: '' };
    return {
      overrides: (parsed.overrides && typeof parsed.overrides === 'object') ? parsed.overrides : {},
      updatedAt: parsed.updatedAt || 0,
      updatedBy: parsed.updatedBy || '',
    };
  } catch {
    return { overrides: {}, updatedAt: 0, updatedBy: '' };
  }
}

async function saveCurriculumOverrides(env, blob) {
  blob.updatedAt = Date.now();
  blob.updatedBy = blob.updatedBy || 'admin';
  await env.KV.put(CURRICULUM_OVERRIDES_KEY, JSON.stringify(blob));
}

// GET /curriculum/global-overrides — PUBLIC (origin-gated, rate-limited).
// Every app load fetches this so the merge layer is fresh. Response is
// small (typically a few KB) and cached at the browser for 60s — long
// enough to avoid hammering KV from N tabs, short enough that an
// override edit propagates to live users within a minute.
async function handleCurriculumGlobalOverridesPublicRoute(request, env, corsOrigin) {
  if (!env.KV) return json({ error: 'kv_not_bound' }, 500, corsOrigin);
  const ip = request.headers.get('cf-connecting-ip') || '';
  const rl = await rateLimitHit(env, `ratelimit:curriculum-public:ip:${ip}`, 240, 60);
  if (!rl.ok) return json({ error: 'rate_limited', resetAt: rl.resetAt }, 429, corsOrigin);
  const blob = await loadCurriculumOverrides(env) || { overrides: {}, updatedAt: 0 };
  return new Response(JSON.stringify({
    ok: true,
    overrides: blob.overrides,
    updatedAt: blob.updatedAt,
  }), {
    status: 200,
    headers: {
      ...corsHeaders(corsOrigin),
      'content-type': 'application/json; charset=utf-8',
      // 60s browser cache — short enough that fixes propagate fast,
      // long enough to absorb the N-tabs-on-one-device case.
      'cache-control': 'public, max-age=60',
    },
  });
}

// GET /admin/curriculum/global-overrides — admin only. Same blob, no
// edge cache so the editor always sees the live KV state.
async function handleAdminCurriculumGetOverridesRoute(request, env, corsOrigin) {
  if (!env.KV) return json({ error: 'kv_not_bound' }, 500, corsOrigin);
  if (!checkAdminAuth(request, env)) return json({ error: 'admin_unauthorized' }, 401, corsOrigin);
  const ip = request.headers.get('cf-connecting-ip') || '';
  const rl = await rateLimitHit(env, `ratelimit:admin-curriculum:ip:${ip}`, RL.ADMIN_IP.max, RL.ADMIN_IP.window);
  if (!rl.ok) return json({ error: 'rate_limited', resetAt: rl.resetAt }, 429, corsOrigin);
  const blob = await loadCurriculumOverrides(env);
  return json({
    ok: true,
    overrides: blob.overrides,
    updatedAt: blob.updatedAt,
    updatedBy: blob.updatedBy,
    count: Object.keys(blob.overrides).length,
  }, 200, corsOrigin);
}

// PUT /admin/curriculum/global-override — admin only. Body:
//   { activityId: 'w1-akshayan-r5', override: { ...partial fields } }
// Sets the override for a single activity. Pass override:{_hidden:true}
// to hide a lesson from kids. Subsequent writes to the same activityId
// REPLACE the previous override (not deep-merge) — this matches the
// app's apply semantics and keeps the wire protocol simple.
async function handleAdminCurriculumPutOverrideRoute(request, env, corsOrigin) {
  if (!env.KV) return json({ error: 'kv_not_bound' }, 500, corsOrigin);
  if (!checkAdminAuth(request, env)) return json({ error: 'admin_unauthorized' }, 401, corsOrigin);
  const ip = request.headers.get('cf-connecting-ip') || '';
  const rl = await rateLimitHit(env, `ratelimit:admin-curriculum:ip:${ip}`, RL.ADMIN_IP.max, RL.ADMIN_IP.window);
  if (!rl.ok) return json({ error: 'rate_limited', resetAt: rl.resetAt }, 429, corsOrigin);

  let body = {};
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400, corsOrigin); }
  const activityId = String(body.activityId || '');
  if (!ACTIVITY_ID_RE.test(activityId)) return json({ error: 'bad_activity_id' }, 400, corsOrigin);
  const override = body.override;
  if (!override || typeof override !== 'object' || Array.isArray(override)) {
    return json({ error: 'bad_override' }, 400, corsOrigin);
  }
  // Reject suspicious top-level keys. Allowlist the fields we know
  // the app's shallow-merge actually uses; ignore anything else so a
  // typo doesn't silently bloat the blob with dead data.
  const ALLOWED = new Set([
    'title', 'emoji', 'videoIds', 'curriculum', 'lesson',
    'questions', 'stretchQuestions', 'demoOnly', '_hidden',
  ]);
  const cleaned = {};
  for (const k of Object.keys(override)) {
    if (ALLOWED.has(k)) cleaned[k] = override[k];
  }
  if (Object.keys(cleaned).length === 0) {
    return json({ error: 'empty_override', allowed: [...ALLOWED] }, 400, corsOrigin);
  }
  // Size guard on the single override.
  const serializedOne = JSON.stringify(cleaned);
  if (serializedOne.length > CURRICULUM_OVERRIDE_MAX_BYTES) {
    return json({ error: 'override_too_large', maxBytes: CURRICULUM_OVERRIDE_MAX_BYTES, got: serializedOne.length }, 413, corsOrigin);
  }

  const blob = await loadCurriculumOverrides(env);
  // Count guard — only reject if this is a NEW activity id; existing
  // ids can be re-saved even at the cap (no growth).
  const isNew = !Object.prototype.hasOwnProperty.call(blob.overrides, activityId);
  if (isNew && Object.keys(blob.overrides).length >= CURRICULUM_OVERRIDES_MAX_COUNT) {
    return json({ error: 'too_many_overrides', max: CURRICULUM_OVERRIDES_MAX_COUNT }, 400, corsOrigin);
  }
  blob.overrides[activityId] = cleaned;
  await saveCurriculumOverrides(env, blob);
  return json({
    ok: true,
    activityId,
    override: cleaned,
    updatedAt: blob.updatedAt,
    count: Object.keys(blob.overrides).length,
  }, 200, corsOrigin);
}

// DELETE /admin/curriculum/global-override — admin only. Body:
//   { activityId: 'w1-akshayan-r5' }
// Clears the override (lesson reverts to its bundled WEEKS content
// + per-tenant overrides). No-op if the override didn't exist.
async function handleAdminCurriculumDeleteOverrideRoute(request, env, corsOrigin) {
  if (!env.KV) return json({ error: 'kv_not_bound' }, 500, corsOrigin);
  if (!checkAdminAuth(request, env)) return json({ error: 'admin_unauthorized' }, 401, corsOrigin);
  const ip = request.headers.get('cf-connecting-ip') || '';
  const rl = await rateLimitHit(env, `ratelimit:admin-curriculum:ip:${ip}`, RL.ADMIN_IP.max, RL.ADMIN_IP.window);
  if (!rl.ok) return json({ error: 'rate_limited', resetAt: rl.resetAt }, 429, corsOrigin);

  let body = {};
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400, corsOrigin); }
  const activityId = String(body.activityId || '');
  if (!ACTIVITY_ID_RE.test(activityId)) return json({ error: 'bad_activity_id' }, 400, corsOrigin);

  const blob = await loadCurriculumOverrides(env);
  const had = Object.prototype.hasOwnProperty.call(blob.overrides, activityId);
  if (had) {
    delete blob.overrides[activityId];
    await saveCurriculumOverrides(env, blob);
  }
  return json({
    ok: true,
    activityId,
    removed: had,
    updatedAt: blob.updatedAt,
    count: Object.keys(blob.overrides).length,
  }, 200, corsOrigin);
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

// POST /admin/backfill-email-index — one-shot maintenance endpoint.
// Walks every tenant:* key, reads the customerEmail field, and writes
// the corresponding email:{lowercase} → tenantId index entry. Safe to
// run multiple times — overwrites are idempotent.
//
// Body (JSON, optional):
//   { dryRun: true }  → enumerate without writing (returns what WOULD be done)
//   { force: true }   → re-write entries even if already present (default skips)
//
// Returns: { ok, scanned, written, skipped, conflicts: [...], emails: [...] }
//
// Used to retro-cover the existing 6 tenants (provisioned before the
// email index existed) so the duplicate-signup guard catches them
// going forward. After the first successful run + verification you
// can leave this endpoint deployed (it's gated by ADMIN_TOKEN) for
// future repair scenarios.
async function handleAdminBackfillEmailIndexRoute(request, env, corsOrigin) {
  if (!env.KV) return json({ error: 'kv_not_bound' }, 500, corsOrigin);
  if (!checkAdminAuth(request, env)) return json({ error: 'admin_unauthorized' }, 401, corsOrigin);
  const ip = request.headers.get('cf-connecting-ip') || '';
  const rl = await rateLimitHit(env, `ratelimit:admin-backfill:ip:${ip}`, RL.ADMIN_IP.max, RL.ADMIN_IP.window);
  if (!rl.ok) return json({ error: 'rate_limited', resetAt: rl.resetAt }, 429, corsOrigin);

  let body = {};
  try { body = await request.json(); } catch {}
  const dryRun = !!body.dryRun;
  const force  = !!body.force;

  // Pass 1: enumerate every tenant, group by email, pick the OLDEST
  // (earliest createdAt) per email as the canonical mapping. Subsequent
  // signups under the same email are reported as duplicates so the
  // operator can clean them up — we never silently overwrite an older
  // tenant with a newer one (older tenants have accumulated data;
  // newer duplicates are the accidental signups we're guarding against).
  const byEmail = new Map(); // email → { canonical: {id, createdAt}, others: [{id, createdAt}] }
  const noEmail = [];
  let scanned = 0;
  let cursor = undefined;
  while (true) {
    const result = await env.KV.list({ prefix: 'tenant:', cursor, limit: 1000 });
    for (const k of result.keys) {
      // Skip sub-keys like tenant:<id>:data
      if (k.name.split(':').length !== 2) continue;
      scanned++;
      const raw = await env.KV.get(k.name);
      if (!raw) continue;
      let t; try { t = JSON.parse(raw); } catch { continue; }
      const email = String(t.customerEmail || '').toLowerCase().trim();
      if (!email || !email.includes('@')) { noEmail.push(t.id); continue; }
      const entry = byEmail.get(email);
      const rec = { id: t.id, createdAt: t.createdAt || '', stripeCustomerId: t.stripeCustomerId || null, code: t.code };
      if (!entry) {
        byEmail.set(email, { canonical: rec, others: [] });
      } else {
        // Older createdAt wins as canonical; the displaced one drops
        // into `others`.
        if (String(rec.createdAt).localeCompare(String(entry.canonical.createdAt)) < 0) {
          entry.others.push(entry.canonical);
          entry.canonical = rec;
        } else {
          entry.others.push(rec);
        }
      }
    }
    if (result.list_complete) break;
    cursor = result.cursor;
    if (!cursor) break;
  }

  // Pass 2: write the canonical mapping for each email. Skip entries
  // whose KV index already matches; with `force`, overwrite anything
  // that points elsewhere.
  let written = 0, skipped = 0;
  const emails = [];        // canonical writes
  const conflicts = [];     // emails with >1 tenant — needs operator attention

  for (const [email, entry] of byEmail.entries()) {
    if (entry.others.length > 0) {
      conflicts.push({
        email,
        canonical: entry.canonical,
        duplicates: entry.others,
      });
    }
    const indexKey = tenantEmailKey(email);
    const existing = await env.KV.get(indexKey);
    if (existing === entry.canonical.id) { skipped++; continue; }
    if (existing && existing !== entry.canonical.id && !force) {
      // Index already points to something else (probably a previous
      // run). Don't overwrite without explicit force — surface it.
      conflicts.push({
        email,
        kvPointsTo: existing,
        wantsToWrite: entry.canonical.id,
        reason: 'kv_index_mismatch_use_force_to_overwrite',
      });
      skipped++;
      continue;
    }
    if (!dryRun) await env.KV.put(indexKey, entry.canonical.id);
    written++;
    emails.push({ email, tenantId: entry.canonical.id, overwrote: existing || null });
  }

  return json({
    ok: true,
    dryRun,
    force,
    scanned,
    written,
    skipped,
    conflictCount: conflicts.length,
    conflicts,
    noEmailCount: noEmail.length,
    noEmail,
    emails,
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
// fraud, policy violation, account dispute).
// POST /admin/tenant/:id/unsuspend body: {} — clear the manual flag.
//
// Stripe billing is paused/resumed alongside the local flag so suspended
// accounts don't keep getting auto-charged on renewal:
//
//   • Suspend  → POST /subscriptions/:id { cancel_at_period_end: true }
//                Customer keeps service through what they already paid
//                for, then it lapses cleanly. No surprise renewal charge.
//   • Unsuspend → if the sub is still active+cancel_scheduled, clear the
//                cancel flag (resume billing). If it has already lapsed
//                (canceled / unpaid / incomplete_expired), we can't
//                reactivate from the API — the customer has to re-checkout.
//                We surface { stripe.needsCheckout: true } so the admin
//                UI can warn the operator.
//
// We also stamp adminSuspendedAt so handleStripeSubscriptionChange knows
// to keep the local flag set even if Stripe says "active" (the cancel
// is scheduled but not yet applied — Stripe still considers the sub
// active during the grace period).
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

  const subId = t.stripeSubscriptionId ? String(t.stripeSubscriptionId) : '';
  const stripeResult = {
    attempted: false,
    success: false,
    mode: null,            // 'cancel_at_period_end' | 'reactivate' | 'noop' | null
    subscriptionId: subId || null,
    status: null,
    cancelAtPeriodEnd: null,
    needsCheckout: false,  // unsuspend can't reactivate — customer must re-checkout
    error: null,
  };

  if (mode === 'suspend') {
    t.suspended = true;
    t.adminSuspendedAt = new Date().toISOString();

    if (subId) {
      stripeResult.attempted = true;
      stripeResult.mode = 'cancel_at_period_end';
      try {
        const r = await stripeApi(env, 'POST', `/subscriptions/${encodeURIComponent(subId)}`, { cancel_at_period_end: true });
        if (r && r.ok) {
          stripeResult.success = true;
          stripeResult.status = (r.data && r.data.status) || null;
          stripeResult.cancelAtPeriodEnd = !!(r.data && r.data.cancel_at_period_end);
          if (r.data && r.data.status) t.stripeSubscriptionStatus = r.data.status;
        } else if (r && r.status === 404) {
          // Already gone in Stripe — local suspend still takes effect.
          stripeResult.success = true;
          stripeResult.status = 'already_gone';
        } else {
          stripeResult.error = (r && r.data && r.data.error && r.data.error.message) || `stripe_${r ? r.status : 'unknown'}`;
        }
      } catch (e) {
        stripeResult.error = (e && e.message) || 'stripe_call_threw';
      }
    }
  } else {
    // mode === 'unsuspend'
    t.adminSuspendedAt = null;

    if (subId) {
      stripeResult.attempted = true;
      try {
        // Read current Stripe state first so we know what's possible.
        const cur = await stripeApi(env, 'GET', `/subscriptions/${encodeURIComponent(subId)}`);
        if (cur && cur.ok && cur.data) {
          const status = cur.data.status;
          const cancelFlag = !!cur.data.cancel_at_period_end;
          stripeResult.status = status;
          stripeResult.cancelAtPeriodEnd = cancelFlag;
          t.stripeSubscriptionStatus = status;

          if ((status === 'active' || status === 'trialing') && cancelFlag) {
            // Reactivatable — clear the cancel flag.
            stripeResult.mode = 'reactivate';
            const r = await stripeApi(env, 'POST', `/subscriptions/${encodeURIComponent(subId)}`, { cancel_at_period_end: false });
            if (r && r.ok) {
              stripeResult.success = true;
              stripeResult.cancelAtPeriodEnd = !!(r.data && r.data.cancel_at_period_end);
              if (r.data && r.data.status) {
                stripeResult.status = r.data.status;
                t.stripeSubscriptionStatus = r.data.status;
              }
              t.suspended = false;
            } else {
              stripeResult.error = (r && r.data && r.data.error && r.data.error.message) || `stripe_${r ? r.status : 'unknown'}`;
              // Stripe call failed — leave the local flag as-is so the
              // operator sees the failure and can retry.
              t.suspended = !!t.suspended;
            }
          } else if (status === 'active' || status === 'trialing') {
            // Already healthy with no cancel scheduled — nothing to do.
            stripeResult.mode = 'noop';
            stripeResult.success = true;
            t.suspended = false;
          } else {
            // canceled / unpaid / incomplete_expired / past_due —
            // can't reactivate without a fresh checkout. The webhook
            // will keep tenant.suspended=true on the next sync anyway,
            // so we set it now to reflect reality in the admin list.
            stripeResult.mode = 'noop';
            stripeResult.success = false;
            stripeResult.needsCheckout = true;
            t.suspended = true;
          }
        } else if (cur && cur.status === 404) {
          // Subscription gone entirely — needs new checkout.
          stripeResult.needsCheckout = true;
          t.suspended = true;
        } else {
          stripeResult.error = (cur && cur.data && cur.data.error && cur.data.error.message) || `stripe_${cur ? cur.status : 'unknown'}`;
          // Don't flip the local flag if we couldn't read Stripe — leave
          // it for the operator to retry once the error is understood.
        }
      } catch (e) {
        stripeResult.error = (e && e.message) || 'stripe_call_threw';
      }
    } else {
      // No Stripe subscription on file (e.g. manual / demo tenant).
      // Just clear the local flag.
      t.suspended = false;
    }
  }

  t.updatedAt = Date.now();
  await env.KV.put(`tenant:${tenantId}`, JSON.stringify(t));
  return json({ ok: true, tenantId, suspended: t.suspended, stripe: stripeResult }, 200, corsOrigin);
}

// ====================================================================
// REWARD ORDERS — operator-administered prize fulfillment
// --------------------------------------------------------------------
// Each tenant tracks their own reward orders in `tenant:<id>:data` under
// `orders` (see placeOrder() in app/index.html). The OPERATOR (admin) is
// the one who actually ships/delivers the prize, so we need a global
// view across all tenants + a way to mark fulfillment.
//
// Endpoints:
//   GET /admin/orders[?status=pending&limit=200]
//     Aggregates orders from every tenant data blob. Adds tenant
//     context (label, code, isDemo) to each order so the operator can
//     contact the family if needed. Default returns pending only.
//
//   POST /admin/orders/<tenantId>/<orderId>/status
//     Body: { status: 'pending'|'fulfilled'|'cancelled', note?: string }
//     Updates the order in-place inside the tenant's data blob and
//     stamps statusUpdatedAt + statusUpdatedBy:'admin'. We do NOT
//     refund coins on cancel — that's intentional: a cancelled order
//     usually means the kid still got something equivalent (substitute
//     prize, store credit, etc.) so silently restoring the coin
//     balance would inflate the economy. If a real refund is needed,
//     the operator does it via the (now-removed) per-tenant Coin
//     Adjuster — or, post-removal, a direct KV edit.
// ====================================================================

async function handleAdminListOrdersRoute(request, env, corsOrigin) {
  if (!env.KV) return json({ error: 'kv_not_bound' }, 500, corsOrigin);
  if (!checkAdminAuth(request, env)) return json({ error: 'admin_unauthorized' }, 401, corsOrigin);
  const ip = request.headers.get('cf-connecting-ip') || '';
  const rl = await rateLimitHit(env, `ratelimit:admin-orders:ip:${ip}`, RL.ADMIN_IP.max, RL.ADMIN_IP.window);
  if (!rl.ok) return json({ error: 'rate_limited', resetAt: rl.resetAt }, 429, corsOrigin);

  const url = new URL(request.url);
  const filterStatus = (url.searchParams.get('status') || '').toLowerCase();
  const includeDemo  = url.searchParams.get('includeDemo') === '1';
  const hardLimit    = Math.min(500, Math.max(10, parseInt(url.searchParams.get('limit') || '200', 10)));

  // List every tenant. KV.list returns a flat name list; we want the
  // `:data` keys specifically because that's where orders live. We
  // also need the parent `tenant:<id>` blob for the label/code/isDemo
  // context, so we batch those reads after we've collected the data
  // keys to avoid N round-trips when the orders array is empty.
  const list = await env.KV.list({ prefix: 'tenant:', limit: 1000 });
  const dataKeys = list.keys.filter(k => k.name.endsWith(':data'));

  const orders = [];
  // Walk tenants in order. We bail early once orders.length hits hardLimit.
  for (const k of dataKeys) {
    if (orders.length >= hardLimit) break;
    const tenantId = k.name.slice('tenant:'.length, -':data'.length);
    let dataRaw;
    try { dataRaw = await env.KV.get(k.name); } catch { continue; }
    if (!dataRaw) continue;
    let data;
    try { data = JSON.parse(dataRaw); } catch { continue; }
    if (!Array.isArray(data.orders) || data.orders.length === 0) continue;

    // Lazy fetch of the tenant header blob — only for tenants that
    // actually have orders, so empty tenants don't trigger a round-trip.
    let tenant = {};
    try {
      const tRaw = await env.KV.get(`tenant:${tenantId}`);
      if (tRaw) tenant = JSON.parse(tRaw) || {};
    } catch {}

    if (!includeDemo && tenant.isDemo) continue;

    for (const o of data.orders) {
      if (!o || typeof o !== 'object') continue;
      const status = String(o.status || 'pending').toLowerCase();
      if (filterStatus && status !== filterStatus) continue;
      orders.push({
        ...o,
        status,
        tenantId,
        tenantLabel: tenant.label || '',
        tenantCode: (tenant.code || '').toUpperCase(),
        tenantIsDemo: !!tenant.isDemo,
        customerEmail: tenant.customerEmail || '',
      });
      if (orders.length >= hardLimit) break;
    }
  }

  // Newest first — operators want the most recent pending orders at
  // the top of the list. Pending status sorts first within same-day
  // ties because operators care about action items.
  orders.sort((a, b) => {
    const ap = a.status === 'pending' ? 0 : 1;
    const bp = b.status === 'pending' ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return (b.requestedAt || 0) - (a.requestedAt || 0);
  });

  return json({ ok: true, orders, total: orders.length }, 200, corsOrigin);
}

async function handleAdminUpdateOrderStatusRoute(request, env, corsOrigin) {
  if (!env.KV) return json({ error: 'kv_not_bound' }, 500, corsOrigin);
  if (!checkAdminAuth(request, env)) return json({ error: 'admin_unauthorized' }, 401, corsOrigin);
  const ip = request.headers.get('cf-connecting-ip') || '';
  const rl = await rateLimitHit(env, `ratelimit:admin-orders-update:ip:${ip}`, RL.ADMIN_IP.max, RL.ADMIN_IP.window);
  if (!rl.ok) return json({ error: 'rate_limited', resetAt: rl.resetAt }, 429, corsOrigin);

  const url = new URL(request.url);
  // /admin/orders/<tenantId>/<orderId>/status
  // split = ['', 'admin', 'orders', '<tenantId>', '<orderId>', 'status']
  const parts = url.pathname.split('/');
  const tenantId = parts[3] || '';
  const orderId  = parts[4] || '';
  if (!tenantId || !orderId) return json({ error: 'missing_params' }, 400, corsOrigin);

  let body = {};
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400, corsOrigin); }
  const next = String(body.status || '').toLowerCase();
  const VALID = ['pending', 'fulfilled', 'cancelled'];
  if (!VALID.includes(next)) return json({ error: 'invalid_status', valid: VALID }, 400, corsOrigin);

  const dataKey = `tenant:${tenantId}:data`;
  const raw = await env.KV.get(dataKey);
  if (!raw) return json({ error: 'tenant_not_found' }, 404, corsOrigin);
  let data;
  try { data = JSON.parse(raw); } catch { return json({ error: 'malformed' }, 500, corsOrigin); }
  if (!Array.isArray(data.orders)) return json({ error: 'no_orders_array' }, 404, corsOrigin);

  const idx = data.orders.findIndex(o => o && o.id === orderId);
  if (idx < 0) return json({ error: 'order_not_found' }, 404, corsOrigin);

  const order = data.orders[idx];
  order.status = next;
  order.statusUpdatedAt = Date.now();
  order.statusUpdatedBy = 'admin';
  if (typeof body.note === 'string' && body.note.trim()) {
    order.adminNote = body.note.trim().slice(0, 500);
  }

  await env.KV.put(dataKey, JSON.stringify(data));
  return json({ ok: true, order }, 200, corsOrigin);
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
// REFUND ROUTES
// =====================================================================
// Refunds let the operator give a customer money back without leaving
// the admin dashboard. Three modes:
//
//   mode: 'months', months: N          — refund N billing-months worth.
//   mode: 'amount', amountCents: N     — refund a specific dollar amount.
//   mode: 'charge_full', chargeId: ch_ — refund exactly one charge in full.
//
// All three walk the customer's PAID invoices newest-first, refunding
// each invoice's underlying charge fully (or partially on the last one)
// until the target amount is met. We can only refund what was actually
// paid — so a 6-month refund on a customer who's been on a monthly plan
// for 3 months refunds the 3 months we have, not 6.
//
// Money safety guarantees (paranoid by design — these are real $ moving):
//   1. Idempotency-Key on every Stripe POST /refunds call. A double-click
//      cannot create two refunds for the same target.
//   2. Audit log: every refund writes a refund:<id> KV record with
//      who/what/when/why so a future "what happened?" investigation
//      has ground truth even if Stripe's UI is unavailable.
//   3. Owner email after every refund. Operator gets a paper-trail
//      receipt in their inbox immediately — and if a stolen admin
//      token starts spraying refunds, the operator notices in minutes
//      instead of at the next bank statement.
//   4. Tighter rate limit (RL.REFUND_IP) than other admin actions.
//      Refunds are money-OUT; if the token leaks, this is the first
//      thing an attacker would abuse.
//   5. If the operator asks for more than the refundable balance, we
//      REFUSE rather than silently capping. Money decisions stay
//      explicit.

// Lists the customer's PAID invoices, with the underlying charge
// object inlined so we can compute refundable-cents in one round-trip.
// Stripe caps `limit` at 100 per page; 12-24 covers a typical customer.
async function stripeListPaidInvoices(env, customerId, limit) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 12, 1), 100);
  // expand[]=data.charge inlines the charge object so we get amount,
  // amount_refunded, etc. without an extra GET per invoice.
  const path = `/invoices?customer=${encodeURIComponent(customerId)}` +
               `&status=paid&limit=${lim}&expand%5B%5D=data.charge`;
  const r = await stripeApi(env, 'GET', path);
  if (!r.ok) {
    return { ok: false, status: r.status,
             error: (r.data && r.data.error && r.data.error.message) || 'list_failed' };
  }
  return { ok: true, invoices: (r.data && r.data.data) || [] };
}

// Resolve a subscription's effective per-month price in cents. Returns
// null if we can't tell (no items, non-recurring price, weird interval).
// Used by mode=months to compute target = monthly × N.
function subscriptionMonthlyCents(sub) {
  try {
    const item = sub && sub.items && sub.items.data && sub.items.data[0];
    if (!item || !item.price || !item.price.recurring) return null;
    const cents = parseInt(item.price.unit_amount, 10);
    if (!Number.isFinite(cents) || cents <= 0) return null;
    const interval = item.price.recurring.interval;            // 'month' | 'year' | 'week' | 'day'
    const ic       = parseInt(item.price.recurring.interval_count, 10) || 1;
    if (interval === 'month') return Math.round(cents / ic);
    if (interval === 'year')  return Math.round(cents / (12 * ic));
    if (interval === 'week')  return Math.round((cents * 52) / (12 * ic));
    if (interval === 'day')   return Math.round((cents * 30) / ic);
    return null;
  } catch { return null; }
}

// GET /admin/tenant/:id/charges — admin only. Returns the customer's
// recent paid invoices with refundable-cents per invoice + the
// subscription's billing interval so the UI can preview "N months = $X".
async function handleAdminListChargesRoute(request, env, corsOrigin) {
  if (!env.KV) return json({ error: 'kv_not_bound' }, 500, corsOrigin);
  if (!checkAdminAuth(request, env)) return json({ error: 'admin_unauthorized' }, 401, corsOrigin);
  const ip = request.headers.get('cf-connecting-ip') || '';
  const rl = await rateLimitHit(env, `ratelimit:admin-charges:ip:${ip}`, RL.ADMIN_IP.max, RL.ADMIN_IP.window);
  if (!rl.ok) return json({ error: 'rate_limited', resetAt: rl.resetAt }, 429, corsOrigin);

  const url = new URL(request.url);
  // /admin/tenant/<id>/charges → split = ['', 'admin', 'tenant', '<id>', 'charges']
  const parts = url.pathname.split('/');
  const tenantId = parts[3] || '';
  if (!tenantId) return json({ error: 'missing_id' }, 400, corsOrigin);
  const raw = await env.KV.get(`tenant:${tenantId}`);
  if (!raw) return json({ error: 'not_found' }, 404, corsOrigin);
  let t; try { t = JSON.parse(raw); } catch { return json({ error: 'malformed' }, 500, corsOrigin); }

  const customerId = t.stripeCustomerId || '';
  if (!customerId) {
    return json({
      error: 'no_stripe_customer',
      detail: 'Tenant has no Stripe customer on file (manual or demo tenant). No refundable history.',
    }, 400, corsOrigin);
  }

  // Pull the subscription (if any) so we can tell the UI the billing
  // interval and per-month price for the months-mode preview.
  let subscription = null, monthlyCents = null, currency = null, billingInterval = null;
  if (t.stripeSubscriptionId) {
    const subRes = await stripeApi(env, 'GET', `/subscriptions/${encodeURIComponent(t.stripeSubscriptionId)}`);
    if (subRes.ok && subRes.data) {
      subscription = subRes.data;
      monthlyCents    = subscriptionMonthlyCents(subscription);
      const item      = subscription.items && subscription.items.data && subscription.items.data[0];
      currency        = (item && item.price && item.price.currency) || null;
      billingInterval = (item && item.price && item.price.recurring && item.price.recurring.interval) || null;
    }
  }

  const inv = await stripeListPaidInvoices(env, customerId, 12);
  if (!inv.ok) return json({ error: 'stripe_list_failed', detail: inv.error }, 502, corsOrigin);

  const charges = [];
  for (const i of inv.invoices) {
    const ch = i.charge && typeof i.charge === 'object' ? i.charge : null;
    if (!ch || !ch.id) continue;            // unpaid / no underlying charge → not refundable here
    const amt        = parseInt(ch.amount, 10) || 0;
    const refunded   = parseInt(ch.amount_refunded, 10) || 0;
    const refundable = Math.max(0, amt - refunded);
    charges.push({
      chargeId:           ch.id,
      invoiceId:          i.id,
      invoiceNumber:      i.number || null,
      createdAt:          (ch.created ? new Date(ch.created * 1000).toISOString() : null),
      amountCents:        amt,
      amountRefundedCents:refunded,
      refundableCents:    refundable,
      currency:           ch.currency || i.currency || null,
      description:        (i.lines && i.lines.data && i.lines.data[0] && i.lines.data[0].description) || i.description || null,
      hostedInvoiceUrl:   i.hosted_invoice_url || null,
      receiptUrl:         ch.receipt_url || null,
      paid:               !!ch.paid,
      fullyRefunded:      refundable === 0 && amt > 0,
    });
  }

  return json({
    ok: true,
    tenantId,
    customerId,
    subscriptionId:     t.stripeSubscriptionId || null,
    subscriptionStatus: subscription ? subscription.status : null,
    billingInterval,                                                 // 'month' | 'year' | null
    monthlyCents,                                                    // computed per-month price
    currency: currency || (charges[0] && charges[0].currency) || 'usd',
    charges,
  }, 200, corsOrigin);
}

// POST /admin/tenant/:id/refund — admin only. Body:
//   { mode: 'months'|'amount'|'charge_full',
//     months?: number,        // mode=months
//     amountCents?: number,   // mode=amount
//     chargeId?: string,      // mode=charge_full
//     reason?: string,        // free-text operator note (audit log)
//     stripeReason?: 'duplicate'|'fraudulent'|'requested_by_customer' }
async function handleAdminRefundRoute(request, env, corsOrigin) {
  if (!env.KV) return json({ error: 'kv_not_bound' }, 500, corsOrigin);
  if (!checkAdminAuth(request, env)) return json({ error: 'admin_unauthorized' }, 401, corsOrigin);
  const ip = request.headers.get('cf-connecting-ip') || '';
  const rl = await rateLimitHit(env, `ratelimit:admin-refund:ip:${ip}`, RL.REFUND_IP.max, RL.REFUND_IP.window);
  if (!rl.ok) return json({ error: 'rate_limited', resetAt: rl.resetAt }, 429, corsOrigin);

  const url = new URL(request.url);
  const parts = url.pathname.split('/');
  const tenantId = parts[3] || '';
  if (!tenantId) return json({ error: 'missing_id' }, 400, corsOrigin);
  const raw = await env.KV.get(`tenant:${tenantId}`);
  if (!raw) return json({ error: 'not_found' }, 404, corsOrigin);
  let t; try { t = JSON.parse(raw); } catch { return json({ error: 'malformed' }, 500, corsOrigin); }

  const customerId = t.stripeCustomerId || '';
  if (!customerId) return json({ error: 'no_stripe_customer' }, 400, corsOrigin);

  let body = {};
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400, corsOrigin); }
  const mode    = String(body.mode || '').trim();
  const reason  = (body.reason || '').toString().trim().slice(0, 500);
  // Stripe accepts only these reason enums; anything else is rejected.
  // Default to requested_by_customer because that's the typical case
  // and it's the most innocuous — fraudulent/duplicate have downstream
  // effects in Stripe Radar's risk scoring.
  const allowedReasons = ['duplicate', 'fraudulent', 'requested_by_customer'];
  const stripeReasonRaw = String(body.stripeReason || '').trim();
  const stripeReason = allowedReasons.includes(stripeReasonRaw) ? stripeReasonRaw : 'requested_by_customer';

  // Compute target_cents per mode and build the work queue (charges
  // newest-first to refund). For charge_full mode we skip the queue
  // and refund just that one charge.
  let targetCents = 0;
  let workQueue = [];   // [{chargeId, refundableCents, createdAt?}]

  if (mode === 'charge_full') {
    const chargeId = String(body.chargeId || '').trim();
    if (!chargeId) return json({ error: 'missing_chargeId' }, 400, corsOrigin);
    // Fetch the charge to know its refundable amount AND verify it
    // belongs to this tenant — never accept arbitrary IDs from the
    // operator, even with auth (defends against typos and stale UI).
    const cr = await stripeApi(env, 'GET', `/charges/${encodeURIComponent(chargeId)}`);
    if (!cr.ok) {
      return json({
        error: 'charge_lookup_failed',
        detail: (cr.data && cr.data.error && cr.data.error.message) || ('http_'+cr.status),
      }, 502, corsOrigin);
    }
    const ch = cr.data || {};
    if (ch.customer !== customerId) {
      return json({
        error: 'charge_customer_mismatch',
        detail: 'Charge belongs to a different Stripe customer.',
      }, 400, corsOrigin);
    }
    const refundable = Math.max(0, (parseInt(ch.amount,10)||0) - (parseInt(ch.amount_refunded,10)||0));
    if (refundable <= 0) {
      return json({ error: 'nothing_to_refund', detail: 'Charge is already fully refunded.' }, 400, corsOrigin);
    }
    targetCents = refundable;
    workQueue.push({ chargeId, refundableCents: refundable });
  } else {
    // Need invoice list for both 'months' and 'amount' modes.
    const inv = await stripeListPaidInvoices(env, customerId, 24);
    if (!inv.ok) return json({ error: 'stripe_list_failed', detail: inv.error }, 502, corsOrigin);
    for (const i of inv.invoices) {
      const ch = i.charge && typeof i.charge === 'object' ? i.charge : null;
      if (!ch || !ch.id) continue;
      const refundable = Math.max(0, (parseInt(ch.amount,10)||0) - (parseInt(ch.amount_refunded,10)||0));
      if (refundable <= 0) continue;
      workQueue.push({ chargeId: ch.id, refundableCents: refundable, createdAt: ch.created || 0 });
    }
    // Newest-first — that's the customer's intuitive expectation
    // ("refund my last 2 months", not "refund my first 2 months").
    workQueue.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    if (mode === 'amount') {
      const amt = parseInt(body.amountCents, 10);
      if (!Number.isFinite(amt) || amt <= 0) return json({ error: 'invalid_amountCents' }, 400, corsOrigin);
      targetCents = amt;
    } else if (mode === 'months') {
      const months = parseInt(body.months, 10);
      if (!Number.isFinite(months) || months <= 0) return json({ error: 'invalid_months' }, 400, corsOrigin);
      if (!t.stripeSubscriptionId) {
        return json({
          error: 'no_subscription',
          detail: 'Tenant has no subscription; use mode=amount or mode=charge_full instead.',
        }, 400, corsOrigin);
      }
      const subRes = await stripeApi(env, 'GET', `/subscriptions/${encodeURIComponent(t.stripeSubscriptionId)}`);
      if (!subRes.ok) {
        return json({
          error: 'subscription_lookup_failed',
          detail: (subRes.data && subRes.data.error && subRes.data.error.message) || ('http_'+subRes.status),
        }, 502, corsOrigin);
      }
      const monthlyCents = subscriptionMonthlyCents(subRes.data);
      if (!monthlyCents || monthlyCents <= 0) {
        return json({
          error: 'cannot_compute_monthly_price',
          detail: 'Subscription has no resolvable monthly price; use mode=amount instead.',
        }, 400, corsOrigin);
      }
      targetCents = monthlyCents * months;
    } else {
      return json({
        error: 'invalid_mode',
        detail: 'mode must be one of: months, amount, charge_full',
      }, 400, corsOrigin);
    }

    // Refuse-rather-than-cap if the ask exceeds available balance.
    // Silent capping would have the operator believe a $100 refund went
    // through when only $30 was actually refundable — bad for trust and
    // bad for accounting reconciliation.
    const totalRefundable = workQueue.reduce((s, x) => s + x.refundableCents, 0);
    if (totalRefundable <= 0) {
      return json({ error: 'nothing_to_refund', detail: 'No paid invoices have any refundable balance.' }, 400, corsOrigin);
    }
    if (targetCents > totalRefundable) {
      return json({
        error: 'amount_exceeds_refundable',
        detail: `Asked to refund ${targetCents}¢ but only ${totalRefundable}¢ is refundable across all paid invoices.`,
        targetCents,
        totalRefundableCents: totalRefundable,
      }, 400, corsOrigin);
    }
  }

  // Walk the queue and issue refunds. Track everything for the audit
  // log and the response. If a single refund fails, STOP — don't keep
  // trying. The operator can decide whether to retry with the partial
  // state captured in refundsCreated/refundsFailed.
  let remaining = targetCents;
  const refundsCreated = [];
  const refundsFailed  = [];
  // idemBase scopes idempotency to (tenant, mode, this request). Same
  // base on a retry within Stripe's 24h replay window returns the same
  // refund records — no double-spend on a double-clicked button.
  const idemBase = `refund-${tenantId}-${mode}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;

  for (const item of workQueue) {
    if (remaining <= 0) break;
    const thisAmount = Math.min(item.refundableCents, remaining);
    const refundBody = {
      charge: item.chargeId,
      amount: thisAmount,
      reason: stripeReason,
      // Metadata travels with the refund forever in Stripe's UI — gives
      // the operator (or an auditor) full provenance for "why did this
      // refund happen?" without leaving the dashboard.
      'metadata[tenant_id]':    tenantId,
      'metadata[admin_mode]':   mode,
      'metadata[admin_reason]': reason || '(none)',
      'metadata[admin_actor]':  'admin-dashboard',
      'metadata[from_ip]':      ip || '(none)',
    };
    const idemKey = `${idemBase}-${item.chargeId}`;
    const r = await stripeApi(env, 'POST', '/refunds', refundBody, { idempotencyKey: idemKey });
    if (r.ok && r.data && r.data.id) {
      refundsCreated.push({
        refundId:    r.data.id,
        chargeId:    item.chargeId,
        amountCents: thisAmount,
        status:      r.data.status,
      });
      remaining -= thisAmount;
    } else {
      refundsFailed.push({
        chargeId:    item.chargeId,
        amountCents: thisAmount,
        error:       (r.data && r.data.error && r.data.error.message) || ('http_'+r.status),
      });
      break;  // stop cascading if Stripe is having a bad time
    }
  }

  const refundedCents = targetCents - remaining;
  const auditId = idemBase;
  const audit = {
    auditId,
    tenantId,
    customerId,
    mode,
    targetCents,
    refundedCents,
    requestedBy:     'admin-dashboard',
    requestedAt:     new Date().toISOString(),
    requestedFromIp: ip || null,
    reason,
    stripeReason,
    months:      mode === 'months'      ? parseInt(body.months,10)  : null,
    chargeIdReq: mode === 'charge_full' ? String(body.chargeId||'') : null,
    refundsCreated,
    refundsFailed,
    fullySatisfied: remaining === 0 && refundsFailed.length === 0,
  };
  // 90-day audit retention. Stripe also keeps the refund record forever
  // on its side, so this KV record is just for in-app history / quick
  // operator lookup. Bump or drop the TTL as you like.
  try { await env.KV.put(`refund:${auditId}`, JSON.stringify(audit), { expirationTtl: 60*60*24*90 }); } catch {}

  // Owner notification — paper trail for stolen-token detection. Best
  // effort, never blocks the response on email delivery.
  sendOwnerRefundNotification(env, audit, t).catch(() => {});

  if (refundsFailed.length > 0 && refundedCents === 0) {
    // Total failure — no money moved. Surface 502 so the UI can show
    // "Refund failed, nothing refunded" rather than a fake success.
    return json({ ok: false, error: 'refund_failed', audit }, 502, corsOrigin);
  }
  return json({ ok: true, audit, partial: !audit.fullySatisfied }, 200, corsOrigin);
}

// Owner notification email after every refund. Best-effort, never throws.
// Includes amount + tenant + reason so the operator gets an instant
// receipt — and notices fast if a stolen admin token is firing refunds.
async function sendOwnerRefundNotification(env, audit, tenant) {
  if (!env.OWNER_EMAIL) return { ok: false, error: 'owner_email_unset' };
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return { ok: false, error: 'email_not_configured' };

  const dollarsRefunded = (audit.refundedCents / 100).toFixed(2);
  const dollarsTarget   = (audit.targetCents   / 100).toFixed(2);
  const subject = `[Solvix] Refund issued: $${dollarsRefunded} to ${tenant.label || tenant.code || tenant.id}`;
  const text = [
    `An admin-dashboard refund just executed.`,
    ``,
    `Tenant:        ${tenant.label || '(no label)'} (${tenant.id})`,
    `Code:          ${(tenant.code || '').toUpperCase()}`,
    `Customer:      ${tenant.customerEmail || '(no email)'}`,
    `Stripe cust:   ${audit.customerId}`,
    ``,
    `Mode:          ${audit.mode}${audit.months ? ' ('+audit.months+' months)' : ''}`,
    `Target:        $${dollarsTarget}`,
    `Refunded:      $${dollarsRefunded}`,
    `Stripe reason: ${audit.stripeReason}`,
    `Operator note: ${audit.reason || '(none)'}`,
    `Audit ID:      ${audit.auditId}`,
    `From IP:       ${audit.requestedFromIp || '(none)'}`,
    ``,
    `Refunds created (${audit.refundsCreated.length}):`,
    ...audit.refundsCreated.map(r => `  • ${r.refundId} — $${(r.amountCents/100).toFixed(2)} on ${r.chargeId} (status=${r.status})`),
    audit.refundsFailed.length ? `\nRefunds FAILED (${audit.refundsFailed.length}):` : '',
    ...audit.refundsFailed.map(r => `  ✗ $${(r.amountCents/100).toFixed(2)} on ${r.chargeId}: ${r.error}`),
    ``,
    `If you did NOT initiate this refund, your ADMIN_TOKEN may be compromised — rotate immediately:`,
    `  wrangler secret put ADMIN_TOKEN`,
  ].filter(Boolean).join('\n');

  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#fafafa;padding:24px;color:#1a1035;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#fff;border-radius:14px;padding:28px;border:1px solid #eee;">
      <tr><td>
        <h2 style="margin:0 0 8px;font-size:20px;">💸 Refund issued</h2>
        <p style="margin:0 0 16px;color:#666;font-size:14px;">$${escapeHtml(dollarsRefunded)} refunded to <strong>${escapeHtml(tenant.label || tenant.code || tenant.id)}</strong>.</p>
        <table role="presentation" width="100%" cellpadding="6" cellspacing="0" style="font-size:14px;font-family:'SF Mono',Menlo,monospace;background:#f7f5ff;border-radius:8px;">
          <tr><td style="color:#666;width:140px;">Tenant</td><td>${escapeHtml(tenant.label || '(no label)')} (${escapeHtml(tenant.id)})</td></tr>
          <tr><td style="color:#666;">Code</td><td><strong>${escapeHtml((tenant.code||'').toUpperCase())}</strong></td></tr>
          <tr><td style="color:#666;">Customer email</td><td>${escapeHtml(tenant.customerEmail || '(none)')}</td></tr>
          <tr><td style="color:#666;">Mode</td><td>${escapeHtml(audit.mode)}${audit.months ? ' ('+escapeHtml(String(audit.months))+' months)' : ''}</td></tr>
          <tr><td style="color:#666;">Target</td><td>$${escapeHtml(dollarsTarget)}</td></tr>
          <tr><td style="color:#666;">Refunded</td><td><strong>$${escapeHtml(dollarsRefunded)}</strong></td></tr>
          <tr><td style="color:#666;">Stripe reason</td><td>${escapeHtml(audit.stripeReason)}</td></tr>
          <tr><td style="color:#666;">Operator note</td><td>${escapeHtml(audit.reason || '(none)')}</td></tr>
          <tr><td style="color:#666;">From IP</td><td>${escapeHtml(audit.requestedFromIp || '(none)')}</td></tr>
          <tr><td style="color:#666;">Audit ID</td><td>${escapeHtml(audit.auditId)}</td></tr>
        </table>
        ${audit.refundsCreated.length ? `<p style="margin:16px 0 6px;font-weight:700;font-size:13px;">Refunds created:</p><ul style="margin:0 0 8px 16px;padding:0;font-size:13px;color:#444;font-family:'SF Mono',Menlo,monospace;">${audit.refundsCreated.map(r => `<li>${escapeHtml(r.refundId)} — $${escapeHtml((r.amountCents/100).toFixed(2))} on ${escapeHtml(r.chargeId)} (${escapeHtml(r.status)})</li>`).join('')}</ul>` : ''}
        ${audit.refundsFailed.length ? `<p style="margin:16px 0 6px;font-weight:700;font-size:13px;color:#b91c1c;">Refunds FAILED:</p><ul style="margin:0 0 8px 16px;padding:0;font-size:13px;color:#b91c1c;font-family:'SF Mono',Menlo,monospace;">${audit.refundsFailed.map(r => `<li>$${escapeHtml((r.amountCents/100).toFixed(2))} on ${escapeHtml(r.chargeId)}: ${escapeHtml(r.error)}</li>`).join('')}</ul>` : ''}
        <p style="margin:18px 0 0;color:#888;font-size:12px;">If you did NOT initiate this refund, rotate <code>ADMIN_TOKEN</code> immediately.</p>
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
      console.warn('owner refund notification failed:', r.status, detail);
      return { ok: false, status: r.status, error: detail };
    }
    return { ok: true };
  } catch (e) {
    console.warn('owner refund notification threw:', String(e && e.message || e));
    return { ok: false, error: String(e && e.message || e) };
  }
}

// =====================================================================
// END REFUND ROUTES
// =====================================================================

// =====================================================================
// END ADMIN DASHBOARD ROUTES
// =====================================================================

// POST /auth — body: { code, mode? }. Returns sanitized tenant
// metadata on hit, 401 on miss. Failed attempts increment BOTH a
// per-IP counter (blocks a single host from churning through codes)
// AND a per-code counter (locks that code if attackers distribute the
// brute force across IPs). The per-code lockout is the key defense
// against botnet-distributed PIN brute forcing — a 4-digit keyspace
// is too small to rely on per-IP limits alone.
//
// Optional `mode` ('parent' | 'teacher'): the dual-demo reserved PIN
// has two variants (`<pin>:parent` and `<pin>:teacher`) keyed in
// RESERVED_TENANTS. The client sends `mode` instead of combining it
// with the code client-side — that way the PIN literal never has to
// appear in client source. If `<code>:<mode>` matches a reserved
// tenant we return that; otherwise we fall through to plain `<code>`
// lookup (for regular tenants or the back-compat alias). Rate limits
// key on the ORIGINAL code so mode-switching doesn't bypass the
// per-code lockout.
async function handleAuthRoute(request, env, corsOrigin) {
  if (!env.KV) return json({ error: 'kv_not_bound' }, 500, corsOrigin);
  const ip = request.headers.get('cf-connecting-ip') || '';
  let body = {};
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400, corsOrigin); }
  const code = (body.code || '').toString().trim().toLowerCase();
  if (!code) return json({ error: 'missing_code' }, 400, corsOrigin);
  const rawMode = (body.mode || '').toString().trim().toLowerCase();
  const mode = (rawMode === 'parent' || rawMode === 'teacher') ? rawMode : '';

  const ipKey   = `ratelimit:auth:ip:${ip}`;
  const codeKey = `ratelimit:auth:code:${code}`;
  const ipPre   = await rateLimitPeek(env, ipKey,   RL.AUTH_IP.max);
  const codePre = await rateLimitPeek(env, codeKey, RL.AUTH_CODE.max);
  if (!ipPre.ok || !codePre.ok) {
    return json({ error: 'rate_limited', resetAt: ipPre.resetAt || codePre.resetAt }, 429, corsOrigin);
  }

  // Try `code:mode` first (dual-demo), then plain code (regular
  // tenants + back-compat alias).
  let tenant = null;
  if (mode) tenant = await lookupTenantByCode(env, code + ':' + mode);
  if (!tenant) tenant = await lookupTenantByCode(env, code);
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
  // Master signup kill-switch. When SIGNUPS_ENABLED is "false" the
  // /stripe/checkout endpoint refuses to mint new sessions, regardless
  // of how the marketing site is configured. This is the single
  // operator knob to "stop new customers" — flip the env var and
  // redeploy, no frontend change required (e.g. for a privacy /
  // architecture freeze where existing tenants keep working but no
  // new ones can be provisioned). Default true so this is opt-in.
  if (String(env.SIGNUPS_ENABLED || 'true').toLowerCase() === 'false') {
    return json({
      error: 'signups_paused',
      message: 'New signups are temporarily paused while we improve the onboarding experience. Join the waitlist at admin@kidquest.fun.',
    }, 503, corsOrigin);
  }
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
    // NOTE: previously sent `consent_collection[promotions] = none`
    // here, but that parameter is EU-only — Canadian/US Stripe
    // accounts reject the entire Checkout call with
    //   "consent_collection.promotions is not available in your country"
    // Since the default behaviour is already "do not solicit
    // promotional consent", omitting the field has the same end-user
    // effect for our merchants and unblocks signup outside the EU.
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
  const subject = `[Solvix] New ${planNoun} signup: ${tenant.label || tenant.code}`;
  const text = [
    `New Solvix signup just landed.`,
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

// ---------------------------------------------------------------
// Email→tenant index. Stripe does NOT auto-dedupe customers by
// email — two checkouts with the same email mint two distinct
// `cus_…` ids — so the `customer:stripe:{customerId}` index alone
// can't catch duplicate signups. We additionally maintain an
// `email:{lowercase}` → tenantId mapping that is written on every
// successful provisioning and consulted before we mint a new
// tenant. The index is best-effort: a missing entry never blocks
// new signups, only the presence of one (with a different Stripe
// customer) cancels a duplicate.
function tenantEmailKey(email) {
  return `email:${String(email || '').toLowerCase().trim()}`;
}
async function writeTenantEmailIndex(env, email, tenantId) {
  if (!email || !tenantId || !env.KV) return;
  try { await env.KV.put(tenantEmailKey(email), tenantId); } catch (e) {}
}
async function findTenantByEmail(env, email) {
  if (!email || !env.KV) return null;
  let id = null;
  try { id = await env.KV.get(tenantEmailKey(email)); } catch { return null; }
  if (!id) return null;
  let raw = null;
  try { raw = await env.KV.get(`tenant:${id}`); } catch { return null; }
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Cancel a Stripe subscription IMMEDIATELY (not at period end). Used
// when a duplicate signup is detected — we don't want to leave the
// orphan customer on a 7-day trial that will eventually charge them
// for an account they can't access. Best-effort; returns whatever
// stripeApi returns. Caller should log but not fatal-error on failure
// (the dedup branch already prevents the duplicate tenant from being
// created, so the worst case is a leaked Stripe customer with a
// dangling subscription that the operator can clean up manually).
async function cancelStripeSubscriptionImmediate(env, subscriptionId) {
  if (!subscriptionId) return { ok: false, error: 'no_subscription_id' };
  try {
    return await stripeApi(env, 'DELETE', `/subscriptions/${subscriptionId}`, null);
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// Email the customer when we detect a duplicate signup. They tried to
// sign up again (probably forgot they had an account) — point them at
// their existing code and confirm we cancelled the duplicate trial so
// they don't get double-charged. Best-effort; never throws.
async function sendDuplicateSignupNoticeEmail(env, toEmail, existingTenant) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return { ok: false, error: 'email_not_configured' };
  if (!toEmail || !String(toEmail).includes('@')) return { ok: false, error: 'no_recipient' };
  if (!existingTenant) return { ok: false, error: 'no_existing_tenant' };

  const codeUpper = String(existingTenant.code || '').toUpperCase();
  const labelClean = escapeHtml(existingTenant.label || 'your Solvix account');
  const appUrl = env.APP_URL || '/app/';

  const subject = `You already have a Solvix account — duplicate signup cancelled`;
  const text = [
    `Hi! It looks like you already have a Solvix account under this email,`,
    `so we cancelled the new trial you just started — no charge will happen`,
    `from that second signup.`,
    ``,
    `Your existing account: ${existingTenant.label || ''}`,
    `Your login code:       ${codeUpper}`,
    ``,
    `Open the app: ${appUrl}`,
    ``,
    `If you forgot your code, this email is your reminder — save it!`,
    `If you actually wanted a SECOND account (e.g. a separate classroom),`,
    `reply to this email and we'll set you up manually.`,
    ``,
    `— Solvix`,
  ].join('\n');

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F0EEFF;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1A1035;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F0EEFF;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:24px;padding:36px;box-shadow:0 12px 32px rgba(108,92,231,0.15);">
        <tr><td>
          <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#1A1035;">You already have a Solvix account 👋</h1>
          <p style="margin:0 0 18px;font-size:15px;line-height:1.55;color:#5B5580;">It looks like you signed up again under the same email, so we cancelled the second trial automatically — you won't get double-charged.</p>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#6C5CE7,#A29BFE);border-radius:18px;padding:22px;text-align:center;margin:0 0 22px;">
            <tr><td align="center">
              <div style="font-size:12px;font-weight:700;letter-spacing:1.5px;color:#fff;opacity:0.85;text-transform:uppercase;margin-bottom:8px;">Your Existing Login Code</div>
              <div style="font-size:36px;font-weight:800;letter-spacing:0.08em;color:#fff;font-family:'SF Mono',Menlo,monospace;">${escapeHtml(codeUpper)}</div>
              <div style="font-size:13px;color:#fff;opacity:0.85;margin-top:10px;">${labelClean}</div>
            </td></tr>
          </table>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px;">
            <tr><td align="center">
              <a href="${escapeHtml(appUrl)}" style="display:inline-block;background:#6C5CE7;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 28px;border-radius:999px;">Open Solvix →</a>
            </td></tr>
          </table>

          <p style="margin:0;font-size:13px;color:#9B95B0;line-height:1.55;">
            If you actually wanted a <strong>second</strong> account (e.g. a separate classroom),
            just reply to this email and we'll set you up manually.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const payload = {
    from: env.EMAIL_FROM,
    to: [toEmail],
    subject, text, html,
  };
  if (env.EMAIL_REPLY_TO) payload.reply_to = env.EMAIL_REPLY_TO;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.RESEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      let detail = '';
      try { detail = (await r.text()).slice(0, 200); } catch {}
      console.warn('duplicate-signup notice failed:', r.status, detail);
      return { ok: false, status: r.status, error: detail };
    }
    return { ok: true };
  } catch (e) {
    console.warn('duplicate-signup notice threw:', String(e && e.message || e));
    return { ok: false, error: String(e && e.message || e) };
  }
}

// Provision a tenant from a completed checkout session. Idempotent —
// if we already provisioned for this customer, just update the
// stored record instead of creating a duplicate. Also dedupes on
// customer email: if the same address signs up twice (via two
// different Stripe customer ids), we cancel the duplicate trial
// and email the user their existing code instead.
// ====================================================================
// SAFETY NET — auto-snapshot before every Stripe webhook mutation
// --------------------------------------------------------------------
// INVARIANT: Stripe webhooks may NEVER mutate `tenant:{id}:data` —
// that's the kid's progress (coins, completed activities, perfect
// counts, streaks, wrong-answer log). Plan upgrades, downgrades,
// cancellations, and re-checkouts only ever touch the tenant
// metadata blob (`tenant:{id}` — subscription IDs, status, suspended
// flag). The handlers themselves enforce this in their bodies; this
// helper is the belt-and-suspenders second layer.
//
// snapshotForStripeEvent reads the CURRENT `:data` blob and stamps a
// copy into `tenant:{id}:audit-snapshots` BEFORE any state mutation.
// If a future bug ever did write to `:data` from a webhook path, the
// pre-mutation copy stays here and we can recover by replaying it.
//
// Stored separately from the user-driven `:snapshots` blob so plan
// thrashing can't push out user save-points, and vice versa. Capped
// at 10 entries (FIFO eviction) — a tenant making 11+ plan changes
// without ever being touched again is rare enough that the trade-off
// is fine.
// ====================================================================
const STRIPE_AUDIT_SNAPSHOT_MAX = 10;
const STRIPE_AUDIT_SNAPSHOT_MAX_DATA_BYTES = 200 * 1024; // 200KB cap per snapshot

async function snapshotForStripeEvent(env, tenantId, eventName) {
  if (!env.KV || !tenantId) return;
  try {
    const dataRaw = await env.KV.get(`tenant:${tenantId}:data`);
    if (!dataRaw) return; // nothing to snapshot — fresh tenant or unprovisioned
    // Hard size cap. If the data blob has somehow ballooned past the
    // limit, log + skip — better to write a missing-snapshot warning
    // than to refuse the webhook and have Stripe retry forever.
    if (dataRaw.length > STRIPE_AUDIT_SNAPSHOT_MAX_DATA_BYTES) {
      console.warn('[stripe-snapshot] data blob too large to snapshot', {
        tenantId, bytes: dataRaw.length, event: eventName,
      });
      return;
    }
    let list = [];
    try {
      const auditRaw = await env.KV.get(`tenant:${tenantId}:audit-snapshots`);
      if (auditRaw) {
        const parsed = JSON.parse(auditRaw);
        if (Array.isArray(parsed)) list = parsed;
      }
    } catch (_) {
      // Corrupt audit blob — start fresh rather than block the webhook.
    }
    const entry = {
      at: Date.now(),
      reason: 'stripe:' + (eventName || 'unknown'),
      _stripeEvent: true,
      data: dataRaw,
    };
    list.unshift(entry);
    if (list.length > STRIPE_AUDIT_SNAPSHOT_MAX) {
      list = list.slice(0, STRIPE_AUDIT_SNAPSHOT_MAX);
    }
    await env.KV.put(`tenant:${tenantId}:audit-snapshots`, JSON.stringify(list));
  } catch (e) {
    // Snapshot failure must NEVER block the webhook handler — Stripe
    // retries are at-least-once and a stuck failure would replay forever.
    // Log and continue.
    console.warn('[stripe-snapshot] failed', { tenantId, event: eventName, error: String(e && e.message || e) });
  }
}

async function handleStripeCheckoutCompleted(session, env) {
  // INVARIANT: NEVER mutate `tenant:{id}:data` from this handler.
  // Plan changes / re-checkouts / replays only ever update tenant
  // metadata (subscription IDs, status, suspended flag, customerEmail).
  // Kid progress lives in `:data` and stays untouched. Before any
  // mutation we auto-snapshot via snapshotForStripeEvent so a future
  // bug couldn't lose data without leaving a recoverable copy in
  // `:audit-snapshots`. See the snapshotForStripeEvent comment block
  // above for the reasoning + storage shape.
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
    // Safety-net: snapshot BEFORE we touch the tenant blob. The handler
    // body below only mutates `tenant:{id}` (metadata), but the
    // snapshot covers the future case where someone adds a `:data`
    // mutation here without realising the invariant.
    await snapshotForStripeEvent(env, existingId, 'checkout.completed.replay');
    const raw = await env.KV.get(`tenant:${existingId}`);
    const existing = raw ? JSON.parse(raw) : null;
    if (existing) {
      existing.stripeSubscriptionId = subscriptionId || existing.stripeSubscriptionId;
      existing.suspended = false;
      existing.updatedAt = Date.now();
      if (customerEmail && !existing.customerEmail) existing.customerEmail = customerEmail;
      await env.KV.put(`tenant:${existingId}`, JSON.stringify(existing));
      // Backfill the email index on replay if it's missing — older
      // tenants pre-date the index, so the first webhook replay is a
      // good opportunity to populate it.
      if (customerEmail) await writeTenantEmailIndex(env, customerEmail, existingId);
    }
    return;
  }

  // EMAIL DEDUP: Stripe makes a NEW customer for every checkout that
  // doesn't pre-supply a customer id, so two signups from the same
  // email become two distinct `cus_…` ids and the customer-id index
  // above will miss them. Look up by email before minting a fresh
  // tenant. If we find one with a DIFFERENT Stripe customer, cancel
  // the duplicate trial immediately, email the user their existing
  // code, and bail without creating a second tenant.
  if (customerEmail) {
    const dupTenant = await findTenantByEmail(env, customerEmail);
    if (dupTenant && dupTenant.stripeCustomerId && dupTenant.stripeCustomerId !== customerId) {
      console.warn('duplicate signup detected', {
        email: customerEmail,
        existingTenantId: dupTenant.id,
        existingCustomer: dupTenant.stripeCustomerId,
        duplicateCustomer: customerId,
        duplicateSubscription: subscriptionId,
      });
      // Cancel the duplicate subscription IMMEDIATELY — fire-and-log,
      // never throw. Even if cancellation fails (network blip, Stripe
      // down), the important guarantee — no duplicate tenant in our
      // KV — is already preserved by returning below.
      if (subscriptionId) {
        const cancelRes = await cancelStripeSubscriptionImmediate(env, subscriptionId);
        if (!cancelRes.ok) {
          console.warn('duplicate sub cancel failed:', cancelRes.status, cancelRes.error || cancelRes.data);
        }
      }
      // Best-effort email pointing them at their existing code.
      try {
        await sendDuplicateSignupNoticeEmail(env, customerEmail, dupTenant);
      } catch (e) {
        console.warn('duplicate-signup notice threw:', String(e && e.message || e));
      }
      // Tell the operator a duplicate happened so it shows up in
      // their inbox alongside legit signups (different subject line
      // would help; for now we annotate via tenant.label-style text).
      try {
        await sendOwnerSignupNotification(env, {
          ...dupTenant,
          label: `[DUPLICATE — cancelled] ${dupTenant.label || ''}`,
          stripeCustomerId: customerId,           // the new (cancelled) one
          stripeSubscriptionId: subscriptionId,   // the new (cancelled) one
        }, customerEmail);
      } catch (e) {
        console.warn('owner notification (dup) threw:', String(e && e.message || e));
      }
      return;
    }
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
  // Email→tenant index: the dedup guard above relies on this being
  // written for every tenant with an email on file. Best-effort —
  // a failure here just means the next duplicate from this email
  // won't be auto-cancelled (it falls back to manual cleanup), but
  // the tenant itself is already provisioned successfully.
  if (customerEmail) await writeTenantEmailIndex(env, customerEmail, id);

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
//
// Admin override: if tenant.adminSuspendedAt is set, the operator has
// manually suspended the account. We keep tenant.suspended=true even if
// Stripe still reports the sub as active (which it does during the
// cancel-at-period-end grace window we open in the suspend handler).
// The override is cleared only by /admin/tenant/:id/unsuspend, never
// by a webhook.
async function handleStripeSubscriptionChange(subscription, env) {
  // INVARIANT: NEVER mutate `tenant:{id}:data` from this handler.
  // This fires on plan upgrades, downgrades, cancellations, payment
  // failures, and reactivations — each one only ever updates tenant
  // metadata (subscription status + ID + suspended flag). Kid
  // progress is preserved across every plan change because we don't
  // touch `:data`. Before any mutation we auto-snapshot via
  // snapshotForStripeEvent so a future bug couldn't lose data without
  // leaving a recoverable copy in `:audit-snapshots`.
  if (!env.KV) return;
  const customerId = subscription.customer || '';
  if (!customerId) return;
  const tenantId = await env.KV.get(`customer:stripe:${customerId}`);
  if (!tenantId) return;
  // Safety-net snapshot before any state mutation. event.type isn't
  // available here — we tag it with the subscription status so the
  // audit log shows what triggered each snapshot ("active",
  // "past_due", "canceled", etc.).
  await snapshotForStripeEvent(env, tenantId, 'subscription.' + (subscription.status || 'change'));
  const raw = await env.KV.get(`tenant:${tenantId}`);
  if (!raw) return;
  let tenant;
  try { tenant = JSON.parse(raw); } catch { return; }

  const active = subscription.status === 'active' || subscription.status === 'trialing';
  if (tenant.adminSuspendedAt) {
    tenant.suspended = true;
  } else {
    tenant.suspended = !active;
  }
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
  // /activity is read-only via this route (returns the rolling event log
  // as-is). Writes go through handleActivityLogRoute below — that path
  // computes IP/geo/UA server-side, so the client can't forge them.
  'GET /activity':  { kind: 'activity',  read: true  },
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

// ---------- Activity log ----------
// Records "someone logged into this tenant" events. Visible to anyone
// with the tenant code (i.e. anyone in the family/classroom), so a
// stolen code is detectable: a parent looking at the picker sees an
// unfamiliar device or city in the log.
//
// Server fills in IP-derived geo (request.cf), User-Agent, and timestamp
// — the client only supplies `sid`. This means a tampered client can't
// forge "Axel logged in from Antarctica"; it can only lie about which
// kid it is, and the IP/device/time will still tell the truth.
//
// Throttle: if the most recent entry for the same {sid, ipHash, uaHash}
// is < ACTIVITY_DEDUP_MS old, we just bump its timestamp instead of
// adding a new row. Stops a reload-spamming kid from filling the log.
const ACTIVITY_MAX_EVENTS = 100;
const ACTIVITY_DEDUP_MS = 30 * 60 * 1000; // 30min

// Tiny non-cryptographic hash (FNV-1a 32-bit). We only use it to dedup
// log entries, not for security — IP/UA in plaintext would bloat the
// blob and leak a bit more than necessary if the KV ever spilled.
function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Unsigned 8-char hex.
  return (h >>> 0).toString(16).padStart(8, '0');
}

// Parse a User-Agent into a friendly device label. Cheap heuristics —
// good enough for "is that the iPad or my phone?" which is all the log
// needs to communicate. Order matters (iPad UA also contains "Safari",
// so device is checked before browser).
function parseDeviceLabel(ua) {
  const u = (ua || '').toLowerCase();
  let device = 'Device';
  if (u.includes('ipad'))                              device = 'iPad';
  else if (u.includes('iphone'))                       device = 'iPhone';
  else if (u.includes('android') && u.includes('mobile')) device = 'Android phone';
  else if (u.includes('android'))                      device = 'Android tablet';
  else if (u.includes('cros'))                         device = 'Chromebook';
  else if (u.includes('mac os') || u.includes('macintosh')) device = 'Mac';
  else if (u.includes('windows'))                      device = 'Windows';
  else if (u.includes('linux'))                        device = 'Linux';
  let browser = '';
  // Edge / Opera contain "Chrome" too — check them first.
  if (u.includes('edg/'))                              browser = 'Edge';
  else if (u.includes('opr/') || u.includes('opera')) browser = 'Opera';
  else if (u.includes('firefox'))                      browser = 'Firefox';
  else if (u.includes('chrome'))                       browser = 'Chrome';
  else if (u.includes('safari'))                       browser = 'Safari';
  return browser ? `${device} (${browser})` : device;
}

async function handleActivityLogRoute(request, env, corsOrigin) {
  if (!env.KV) return json({ error: 'kv_not_bound' }, 500, corsOrigin);
  const code = (extractBearer(request) || '').toLowerCase();
  const tenant = await lookupTenantByCode(env, code);
  if (!tenant) return json({ error: 'invalid_code' }, 401, corsOrigin);

  let payload;
  try { payload = await request.json(); } catch (e) {
    return json({ error: 'bad_body' }, 400, corsOrigin);
  }
  // sid = student id ("axel"), or "_teacher" for a teacher login, or a
  // free-form short string for future "tutor switched profiles" events.
  // Cap length defensively — KV keys / log rows shouldn't grow unbounded
  // because a misbehaving client passed a 1MB string.
  let sid = (payload && typeof payload.sid === 'string') ? payload.sid : '';
  sid = sid.slice(0, 64).replace(/[^a-zA-Z0-9_\-]/g, '');
  if (!sid) return json({ error: 'missing_sid' }, 400, corsOrigin);

  const now = Date.now();
  const ua = (request.headers.get('user-agent') || '').slice(0, 500);
  const cf = request.cf || {};
  // Cloudflare gives us city + region + country without a 3rd-party API.
  // All three are best-effort — colo/dev requests may have nulls.
  const city    = (cf.city || '').slice(0, 60);
  const region  = (cf.region || cf.regionCode || '').slice(0, 40);
  const country = (cf.country || '').slice(0, 4);
  // IP — used only for hashing (dedup); never stored in plaintext.
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || '';
  const ipHash = fnv1a32(ip || 'no-ip');
  const uaHash = fnv1a32(ua || 'no-ua');
  const device = parseDeviceLabel(ua);

  const key = `tenant:${tenant.id}:activity`;
  const existing = await env.KV.get(key);
  let blob = { events: [], updatedAt: 0 };
  if (existing) {
    try {
      const parsed = JSON.parse(existing);
      if (parsed && Array.isArray(parsed.events)) blob = parsed;
    } catch { /* corrupt — start over rather than fail */ }
  }

  // Dedup: if the most recent matching entry is fresh enough, just
  // bump its timestamp. This keeps a spam-reloading kid from filling
  // the visible log with 47 identical rows.
  const head = blob.events[0];
  if (head && head.sid === sid && head.ipHash === ipHash && head.uaHash === uaHash &&
      (now - (head.at || 0)) < ACTIVITY_DEDUP_MS) {
    head.at = now;
  } else {
    blob.events.unshift({
      at: now,
      sid,
      device,
      city,
      region,
      country,
      ipHash,
      uaHash,
    });
  }
  if (blob.events.length > ACTIVITY_MAX_EVENTS) {
    blob.events.length = ACTIVITY_MAX_EVENTS;
  }
  blob.updatedAt = now;

  await env.KV.put(key, JSON.stringify(blob));
  return json({ ok: true }, 200, corsOrigin);
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
  // Phase B — real handlers.
  'POST /generate-questions': { flag: 'FEATURE_GENERATE_QUESTIONS', fn: handleGenerateQuestions },
  'POST /generate-lesson':    { flag: 'FEATURE_GENERATE_QUESTIONS', fn: handleGenerateLesson },
  'POST /worked-example':     { flag: 'FEATURE_WORKED_EXAMPLE',     fn: handleWorkedExample },
  // Phase C — partially scaffolded.
  'POST /teacher-summary':    { flag: 'FEATURE_TEACHER_SUMMARY',    fn: notYetImplemented('teacher-summary') },
  'POST /parent-report':      { flag: 'FEATURE_PARENT_REPORT',      fn: handleParentReport },
  'POST /voice-clone':        { flag: 'FEATURE_VOICE_CLONE',        fn: notYetImplemented('voice-clone') },
  // Phase D — scaffolded.
  'POST /sidekick':           { flag: 'FEATURE_SIDEKICK',           fn: handleSidekick },
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
      return json(await buildHealthPayload(env), 200, corsOrigin);
    }

    // Origin gate. An empty corsOrigin means the Origin header didn't
    // match the allow-list — block it so nobody can point a random
    // site at our Worker and drain API credits.
    //
    // EXCEPTION: server-to-server callers that don't send a browser
    // Origin header. Stripe's webhook is the canonical case — it
    // proves authenticity via HMAC signature on the raw body
    // (see handleStripeWebhookRoute), so CORS gating would only
    // create a false 403 without adding security.
    if (!corsOrigin && !(url.pathname === '/stripe/webhook' && request.method === 'POST')) {
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
      // One-shot maintenance — backfill the email→tenant index that
      // the duplicate-signup guard reads. Idempotent; safe to re-run.
      if (routeKey === 'POST /admin/backfill-email-index') return await handleAdminBackfillEmailIndexRoute(request, env, corsOrigin);
      // Global maintenance gate — operator-controlled site-wide hold screen.
      if (routeKey === 'GET /admin/global-maintenance')  return await handleAdminGetGlobalMaintenanceRoute(request, env, corsOrigin);
      if (routeKey === 'POST /admin/global-maintenance') return await handleAdminGlobalMaintenanceRoute(request, env, corsOrigin);
      // Global prize catalog — single operator-administered list of
      // physical rewards. Public read for kids; admin-token gate for
      // edits. The app falls back to a hardcoded seed if the public
      // read 404s, so a fresh install still has a working Shop.
      if (routeKey === 'GET /store/catalog')             return await handleStoreCatalogRoute(request, env, corsOrigin);
      if (routeKey === 'GET /admin/store/catalog')       return await handleAdminGetStoreCatalogRoute(request, env, corsOrigin);
      if (routeKey === 'POST /admin/store/catalog')      return await handleAdminSetStoreCatalogRoute(request, env, corsOrigin);
      // Global curriculum overrides — operator-edited fixes for the
      // bundled WEEKS data. Public read fuels the app's merge layer;
      // single-activity PUT/DELETE keep edits conflict-resistant.
      if (routeKey === 'GET /curriculum/global-overrides')          return await handleCurriculumGlobalOverridesPublicRoute(request, env, corsOrigin);
      if (routeKey === 'GET /admin/curriculum/global-overrides')    return await handleAdminCurriculumGetOverridesRoute(request, env, corsOrigin);
      if (routeKey === 'PUT /admin/curriculum/global-override')     return await handleAdminCurriculumPutOverrideRoute(request, env, corsOrigin);
      if (routeKey === 'DELETE /admin/curriculum/global-override')  return await handleAdminCurriculumDeleteOverrideRoute(request, env, corsOrigin);
      // Demo PIN admin routes (list active, manually generate). The
      // /admin/demo-pins prefix is matched before the generic
      // /admin/tenant/ block below so the order matters — keep these
      // above any startsWith('/admin/') catchalls.
      if (routeKey === 'GET /admin/demo-pins')           return await handleAdminListDemoPinsRoute(request, env, corsOrigin);
      if (routeKey === 'POST /admin/demo-pins/generate') return await handleAdminGenerateDemoPinRoute(request, env, corsOrigin);
      // Reward orders — operator-administered prize fulfillment.
      // Aggregates orders across every tenant + lets the operator
      // mark fulfilled / cancelled on each one. See handler block above
      // for the data model + why we don't auto-refund coins.
      if (routeKey === 'GET /admin/orders')              return await handleAdminListOrdersRoute(request, env, corsOrigin);
      if (request.method === 'POST' && url.pathname.startsWith('/admin/orders/') && url.pathname.endsWith('/status')) {
        return await handleAdminUpdateOrderStatusRoute(request, env, corsOrigin);
      }
      // Public demo-PIN request (visitor on the marketing page).
      if (routeKey === 'POST /demo/request') return await handleDemoRequestRoute(request, env, corsOrigin);
      // GET /admin/tenant/<id>/charges — list refundable charges. Match
      // BEFORE the catch-all GET below so it doesn't get swallowed.
      if (request.method === 'GET' && url.pathname.startsWith('/admin/tenant/') && url.pathname.endsWith('/charges')) {
        return await handleAdminListChargesRoute(request, env, corsOrigin);
      }
      if (request.method === 'GET' && url.pathname.startsWith('/admin/tenant/') && !url.pathname.includes('/suspend') && !url.pathname.includes('/unsuspend') && !url.pathname.includes('/resend-code') && !url.pathname.includes('/charges') && !url.pathname.includes('/refund')) {
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
      // POST /admin/tenant/<id>/refund — execute a refund. Money-out;
      // see handleAdminRefundRoute for the safety guarantees.
      if (request.method === 'POST' && url.pathname.startsWith('/admin/tenant/') && url.pathname.endsWith('/refund')) {
        return await handleAdminRefundRoute(request, env, corsOrigin);
      }
      if (routeKey === 'POST /auth')         return await handleAuthRoute(request, env, corsOrigin);
      if (routeKey === 'GET /tenant')        return await handleTenantInfoRoute(request, env, corsOrigin);
      if (routeKey === 'POST /teacher-auth') return await handleTeacherAuthRoute(request, env, corsOrigin);
      if (routeKey === 'POST /teacher-set-initial-password') return await handleTeacherSetInitialPasswordRoute(request, env, corsOrigin);
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
      // Activity log writes go through their own handler (it computes
      // IP/geo/UA server-side from request.cf). Reads use the generic
      // DATA_ROUTES path so they share the same auth + KV plumbing.
      if (routeKey === 'POST /activity') return await handleActivityLogRoute(request, env, corsOrigin);
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
      gradeContext: String(body.gradeContext || '').slice(0, 40),
      availableKeys: Array.isArray(body.availableKeys)
        ? body.availableKeys.filter(k => typeof k === 'string').slice(0, 20)
        : ['shortSessions','earlyBridge','noTimer','alwaysTTS','activeReading','autoStretch','simpleLanguage'],
    }),
    validate: ({ notes }) => notes ? null : { error: 'missing_notes' },
    // v2 cache key — Apr 2026 the schema changed (avoidPassages →
    // activeReading) AND we added gradeOffsets output. Old cached
    // responses don't match the new shape; bumping invalidates them.
    cacheKey: ({ notes, gradeContext }) => hashKey('plan-parse-v2', notes, gradeContext),
    cacheTtlSeconds: 7 * 24 * 3600, // 7 days — tutor notes rarely re-parse before a plan edit
    maxTokens: 420,
    buildSystemPrompt: () => (
      'You translate free-form tutor notes / IEP excerpts / parent letters about a student into a small set of structured accommodations for a kids\' learning app.\n\n' +
      'Output STRICT JSON ONLY, no prose, no markdown fences. Shape:\n' +
      '{\n' +
      '  "toggles": {\n' +
      '    "shortSessions": boolean,\n' +
      '    "earlyBridge":   boolean,\n' +
      '    "noTimer":       boolean,\n' +
      '    "alwaysTTS":     boolean,\n' +
      '    "activeReading": boolean,\n' +
      '    "autoStretch":   boolean,\n' +
      '    "simpleLanguage":boolean\n' +
      '  },\n' +
      '  "extendedTime": number,            // one of 1.0, 1.2, 1.3, 1.5, 2.0\n' +
      '  "gradeOffsets": {                   // OPTIONAL. Per-subject grade offset relative to the student\'s home grade. Each value is an integer in [-3, +3]. Only include subjects the notes specifically mention.\n' +
      '    "reading"?:  number, "writing"?: number, "spelling"?: number,\n' +
      '    "math"?:     number, "logic"?:   number, "french"?:  number,\n' +
      '    "science"?:  number, "social"?:  number, "coding"?:  number\n' +
      '  },\n' +
      '  "reasoning": string                 // one short sentence, plain English\n' +
      '}\n\n' +
      'Toggle meanings:\n' +
      '- shortSessions: cap activities at 3 questions. Use for focus/stamina/ADHD notes.\n' +
      '- earlyBridge: drop to easier questions after 1 wrong (instead of waiting for 2). Use for fragile learners or kids who spiral on misses.\n' +
      '- noTimer: remove the per-question countdown. Use for anxiety/timer-stress notes.\n' +
      '- alwaysTTS: auto-enable read-aloud. Use for ESL/early reader/decoding notes.\n' +
      '- activeReading: present long passages in chunks with auto-narration (instead of as one block). Use for kids who can\'t sit and read long text.\n' +
      '- autoStretch: unlock harder questions after any completion (not just perfect). Use for gifted/bored/advanced notes.\n' +
      '- simpleLanguage: rewrite prompts in simpler words (when FEATURE_SIMPLIFY is on). Use for ESL notes.\n\n' +
      'extendedTime values: 1.0 standard, 1.2 mild ESL/processing, 1.3 typical IEP, 1.5 significant IEP, 2.0 severe.\n\n' +
      'gradeOffsets: only include a subject if the notes specifically describe the student working below or above grade in that area. Examples:\n' +
      '  notes mention "reading at a Grade 1 level" and student is in Grade 3 → "reading": -2\n' +
      '  notes mention "math is two grades ahead" → "math": +2\n' +
      '  notes are silent on a subject → omit it (do NOT include 0s).\n\n' +
      'Omit any toggle you are not confident the notes support. Do not invent concerns.'
      // Kid-safety: these notes are written BY a tutor ABOUT a student, so the
      // output still reaches a shared dashboard. Same banned-topic rules apply
      // to the `reasoning` string we echo back. No CURRICULUM_ALIGNMENT_RULES
      // here — this endpoint parses prose about a learner, not lesson content.
      + KID_SAFE_RULES
    ),
    buildUserPrompt: ({ notes, gradeContext, availableKeys }) => (
      'Student\'s home grade: ' + (gradeContext || '(not provided)') + '\n' +
      'Available toggle keys: ' + availableKeys.join(', ') + '\n\n' +
      'Tutor notes / parent letter / IEP excerpt:\n"""\n' + notes + '\n"""\n\n' +
      'Return the JSON now.'
    ),
    postProcess: (text) => {
      const parsed = parseJsonFromText(text);
      if (!parsed || typeof parsed !== 'object') {
        return { error: 'parse_failed', raw: text.slice(0, 200) };
      }
      // Normalise: only allow known keys through, coerce to boolean.
      const KNOWN_TOGGLES = new Set(['shortSessions','earlyBridge','noTimer','alwaysTTS','activeReading','autoStretch','simpleLanguage']);
      const KNOWN_SUBJECTS = new Set(['reading','writing','spelling','math','logic','french','science','social','coding']);
      const toggles = {};
      if (parsed.toggles && typeof parsed.toggles === 'object') {
        for (const k of Object.keys(parsed.toggles)) {
          if (KNOWN_TOGGLES.has(k)) toggles[k] = !!parsed.toggles[k];
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
      // Grade offsets — clamp to [-3, +3] integers, drop unknown subjects
      // and zero values (the editor treats absence-of-offset as "at grade",
      // so we don't need to explicitly send 0s back).
      if (parsed.gradeOffsets && typeof parsed.gradeOffsets === 'object') {
        const offsets = {};
        for (const k of Object.keys(parsed.gradeOffsets)) {
          if (!KNOWN_SUBJECTS.has(k)) continue;
          const v = Number(parsed.gradeOffsets[k]);
          if (!Number.isFinite(v) || v === 0) continue;
          offsets[k] = Math.max(-3, Math.min(3, Math.round(v)));
        }
        if (Object.keys(offsets).length) out.gradeOffsets = offsets;
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

// ---- /parent-report ----------------------------------------------------
// Generates a friendly, parent-facing weekly summary for ONE student
// from a compact stats payload sent by the client. The frontend builds
// the payload from the tenant-local progress blob (no PII beyond first
// name + grade), so parents tapping "Generate this week's report" get
// fresh prose without us ever shipping their kid's full activity log
// to the model.
//
// Output is a structured JSON object the frontend renders into a card —
// not raw markdown — so we can format consistently and pull individual
// pieces (e.g. just the "this week try" suggestion) into other surfaces
// later (email, SMS, calendar).
async function handleParentReport(request, env, ctx, corsOrigin) {
  return runStandardHandler({
    request, env, ctx, corsOrigin,
    endpoint: '/parent-report',
    readInputs: async (body) => ({
      // Compact stats payload from the frontend. Anonymised — no last
      // name, no email, no exact ids — but first name is fine for a
      // parent-facing report (it's their own kid).
      firstName: String(body.firstName || 'Your kid').trim().slice(0, 40),
      grade: String(body.grade || '').slice(0, 40),
      weekLabel: String(body.weekLabel || 'this week').slice(0, 40),
      coinsEarned: Number(body.coinsEarned) || 0,
      coinsTotal:  Number(body.coinsTotal)  || 0,
      streakDays:  Number(body.streakDays)  || 0,
      activitiesCompleted: Number(body.activitiesCompleted) || 0,
      firstTryPerfect:     Number(body.firstTryPerfect)     || 0,
      stretchesAttempted:  Number(body.stretchesAttempted)  || 0,
      // Per-subject summary array: [{ subject, completed, accuracyPct }, ...]
      subjects: Array.isArray(body.subjects)
        ? body.subjects.slice(0, 10).map(s => ({
            subject: String((s && s.subject) || '').slice(0, 30),
            completed: Number(s && s.completed) || 0,
            accuracyPct: Number(s && s.accuracyPct) || 0,
          }))
        : [],
      // Top struggle topics (lessonTitle strings) seen in wrongAnswers
      // this week. Already truncated client-side.
      struggleTopics: Array.isArray(body.struggleTopics)
        ? body.struggleTopics.slice(0, 5).map(s => String(s).slice(0, 80))
        : [],
      // Wins — first-try-perfect or stretch-perfect lesson titles.
      winTopics: Array.isArray(body.winTopics)
        ? body.winTopics.slice(0, 5).map(s => String(s).slice(0, 80))
        : [],
      // Plan context so the report can be sensitive to accommodations.
      // ("Maya is on Active Reading mode — she's chunking long passages
      //  and that's actually why her reading time looks lower this week.")
      activeAccommodations: Array.isArray(body.activeAccommodations)
        ? body.activeAccommodations.slice(0, 8).map(s => String(s).slice(0, 40))
        : [],
    }),
    validate: ({ firstName }) => firstName ? null : { error: 'missing_first_name' },
    // 24h cache — same kid + same stats = same report. Stats change as
    // soon as the kid finishes another activity, so the key naturally
    // freshens. We don't include firstName in the cache key because the
    // model behavior shouldn't depend on it (only the personalised
    // string output does, and that's deterministic from the same prompt).
    cacheKey: ({ firstName, grade, weekLabel, coinsEarned, activitiesCompleted, firstTryPerfect, struggleTopics, winTopics }) =>
      hashKey('parent-report', firstName, grade, weekLabel, String(coinsEarned), String(activitiesCompleted), String(firstTryPerfect),
        (struggleTopics || []).slice(0, 3).join('|'), (winTopics || []).slice(0, 3).join('|')),
    cacheTtlSeconds: 24 * 3600,
    maxTokens: 600,
    buildSystemPrompt: () => (
      'You write short, warm weekly progress reports for a parent about their child\'s learning on a tutoring app. Reply with STRICT JSON ONLY (no prose, no markdown fences):\n' +
      '{\n' +
      '  "opening":      string,    // one warm sentence summarising the week\n' +
      '  "highlights":   [string]   // 2 to 3 specific WINS, one sentence each\n' +
      '  "areasToWatch": [string]   // 1 to 3 honest growth areas, one sentence each\n' +
      '  "thisWeekTry":  string     // one concrete thing the parent can do AT HOME this week (5-15 minutes), specific and gentle\n' +
      '}\n\n' +
      'Tone: warm, plain English, like a friendly tutor talking to a parent at pickup. NOT corporate. NOT alarmist. NOT cheerleader.\n' +
      'Specificity: when you have data (a number of activities, a topic name, an accuracy %), use it. When you don\'t, write softer general copy — never invent a number.\n' +
      'Use the kid\'s first name 1–2 times max (over-use feels artificial). Refer to them as "your child" or "they" otherwise.\n' +
      'Highlights and areas should be CONCRETE — name a topic or skill, not "did well in math." If only generic data exists, focus on effort/streak/total activities.\n' +
      'thisWeekTry: a real, doable suggestion the parent can act on. 5-15 minutes. Tied to one of the areas to watch when possible.\n' +
      'NEVER use clinical or labelling language: don\'t say "ADHD," "behind," "struggling," "weak." Soft framing only: "still building," "wants more practice with," "could use a little extra support."\n' +
      'NEVER mention specific medical conditions, diagnoses, or family situations even if the accommodations list hints at them.\n' +
      'If a piece of data is missing, omit that piece — don\'t hallucinate.'
      + KID_SAFE_RULES
    ),
    buildUserPrompt: (inp) => {
      let p = 'Student first name: ' + inp.firstName + '\n';
      p += 'Grade: ' + (inp.grade || '(unknown)') + '\n';
      p += 'Week: ' + inp.weekLabel + '\n';
      p += '\n— Numbers this week —\n';
      p += 'Coins earned: ' + inp.coinsEarned + ' (total: ' + inp.coinsTotal + ')\n';
      p += 'Streak: ' + inp.streakDays + ' day' + (inp.streakDays === 1 ? '' : 's') + '\n';
      p += 'Activities completed: ' + inp.activitiesCompleted + '\n';
      p += 'First-try perfect: ' + inp.firstTryPerfect + '\n';
      p += 'Stretch challenges attempted: ' + inp.stretchesAttempted + '\n';
      if (inp.subjects.length) {
        p += '\n— Per subject —\n';
        for (const s of inp.subjects) {
          p += '  ' + s.subject + ': ' + s.completed + ' done, ' + s.accuracyPct + '% accuracy\n';
        }
      }
      if (inp.winTopics.length) {
        p += '\n— Wins (lessons aced first try or stretch-perfect) —\n';
        for (const t of inp.winTopics) p += '  • ' + t + '\n';
      }
      if (inp.struggleTopics.length) {
        p += '\n— Recurring miss topics —\n';
        for (const t of inp.struggleTopics) p += '  • ' + t + '\n';
      }
      if (inp.activeAccommodations.length) {
        p += '\n— Active accommodations (so you can be sensitive in framing) —\n';
        for (const a of inp.activeAccommodations) p += '  • ' + a + '\n';
      }
      p += '\nReturn the JSON report now.';
      return p;
    },
    postProcess: (text) => {
      const parsed = parseJsonFromText(text);
      if (!parsed || typeof parsed !== 'object') {
        return { error: 'parse_failed', raw: (text || '').slice(0, 200) };
      }
      const out = {};
      if (typeof parsed.opening === 'string') out.opening = parsed.opening.trim().slice(0, 400);
      if (Array.isArray(parsed.highlights)) {
        out.highlights = parsed.highlights
          .filter(s => typeof s === 'string')
          .map(s => s.trim().slice(0, 240))
          .filter(Boolean)
          .slice(0, 4);
      }
      if (Array.isArray(parsed.areasToWatch)) {
        out.areasToWatch = parsed.areasToWatch
          .filter(s => typeof s === 'string')
          .map(s => s.trim().slice(0, 240))
          .filter(Boolean)
          .slice(0, 3);
      }
      if (typeof parsed.thisWeekTry === 'string') {
        out.thisWeekTry = parsed.thisWeekTry.trim().slice(0, 320);
      }
      // Need at least an opening + one highlight to count as a usable
      // report. Otherwise let the client fall back to generic stats card.
      if (!out.opening || !out.highlights || !out.highlights.length) {
        return { error: 'incomplete_report' };
      }
      return out;
    },
    auditSummary: (inputs) => `parent-report → ${inputs.firstName}, ${inputs.activitiesCompleted} activities`,
  });
}

// ---- /sidekick ---------------------------------------------------------
// Locked-down chatbox where kids can ask Nova about the CURRENT question.
// This is the highest-stakes AI surface in the app (free-form input from
// a child) so the guardrails are layered:
//
//   1. The system prompt declares the model is glued to the current
//      question. Off-topic → polite redirect, NEVER engage.
//   2. The correct answer is passed in and explicitly banned (same trick
//      as /worked-example) — Nova can't be coaxed into "is it B?".
//   3. KID_SAFE_RULES + the existing post-output CONTENT_BLOCKLIST
//      (applied by runStandardHandler) catch anything the prompt missed.
//   4. Per-question turn limit on the client (4 turns) caps abuse +
//      keeps cost bounded. Each turn still counts toward the daily cap.
//   5. No cache — every conversation is unique.
//   6. Output is STRICT JSON with `onTopic` flag so the client can show
//      kids a soft "let's get back to your question" cue when Nova
//      redirected.
async function handleSidekick(request, env, ctx, corsOrigin) {
  return runStandardHandler({
    request, env, ctx, corsOrigin,
    endpoint: '/sidekick',
    readInputs: async (body) => ({
      // Current question context. Identical shape to /worked-example
      // so the schema is familiar.
      questionType: String(body.questionType || 'unknown').slice(0, 40),
      prompt: String(body.prompt || '').trim().slice(0, 600),
      choices: Array.isArray(body.choices) ? body.choices.slice(0, 6).map(c => String(c).slice(0, 120)) : null,
      correctAnswer: (typeof body.correctAnswer === 'number' || typeof body.correctAnswer === 'string') ? body.correctAnswer : null,
      gradeContext: String(body.gradeContext || '').slice(0, 40),
      curriculum: (body.curriculum && typeof body.curriculum === 'object') ? body.curriculum : null,
      // Conversation history — array of { role: 'kid'|'nova', text: string }.
      // Capped at 8 entries (4 round trips) to keep the prompt small + match
      // the client-side turn limit.
      history: Array.isArray(body.history)
        ? body.history.slice(-8).map(t => ({
            role: (t && t.role === 'nova') ? 'nova' : 'kid',
            text: String((t && t.text) || '').slice(0, 280),
          })).filter(t => t.text)
        : [],
      // Kid's new message. Hard char cap so a paste-bomb can't run up
      // the bill (the model still sees only what's here).
      message: String(body.message || '').trim().slice(0, 280),
    }),
    validate: ({ message, prompt }) => {
      if (!message) return { error: 'missing_message' };
      if (!prompt)  return { error: 'missing_question_context' };
      return null;
    },
    // No caching — chat is conversational; every message is unique.
    cacheKey: null,
    maxTokens: 240,
    buildSystemPrompt: () => (
      'You are Nova, an AI tutor for a child (ages 4-12). The child is currently working on a quiz question. They have opened a chat with you to ask for help. ' +
      'Reply with STRICT JSON ONLY (no prose, no markdown fences):\n' +
      '{\n' +
      '  "reply":   string,    // your reply to the kid. Max 2 short sentences.\n' +
      '  "onTopic": boolean    // true if the kid asked about the question/lesson; false if you redirected.\n' +
      '}\n\n' +
      'CRITICAL RULES — these are non-negotiable:\n\n' +
      'STAY ON TOPIC. You ONLY discuss the current question and how to think about it. If the kid asks about ANYTHING else (your day, games, sports, family, food, weekend, music, you, other lessons, the weather, what time it is, jokes, random stuff) — kindly redirect with one short sentence and set onTopic:false. Examples of redirect lines: "Let\'s focus on this question — what part feels tricky?", "I can only help with this lesson right now. What\'s puzzling you about it?", "We can chat about that another time! Right now, let\'s figure out this question together."\n\n' +
      'NEVER REVEAL THE ANSWER. Even if the kid asks "is it B?" or "is the answer 12?" — don\'t confirm or deny a specific choice. Redirect them to the method: "I can\'t tell you which one — but try reading it out loud and listen for what sounds right." Same for math: don\'t state the final number; walk them through the steps but stop one short.\n\n' +
      'KID-FRIENDLY LANGUAGE. Match the grade level: K-2 very simple words, 3-5 friendly, 6+ solid. Be warm. Never scold. Never say "no" harshly — always redirect kindly.\n\n' +
      'BREVITY. Max 2 short sentences per reply. No lectures.\n\n' +
      'BANNED TOPICS — auto-redirect, never engage even briefly:\n' +
      '- Anything about violence, weapons, injury, scary things, horror.\n' +
      '- Anything about drugs, alcohol, smoking.\n' +
      '- Anything about romance, dating, the body, bathroom topics.\n' +
      '- Personal info: names of family, where they live, what school they go to.\n' +
      '- Politics, religion, current events.\n' +
      '- Anything that makes you uncomfortable as a tutor — redirect with: "That\'s not something we chat about here. Let\'s get back to your question!"\n\n' +
      'IF THE KID JUST VENTS or says they\'re frustrated/sad/tired: one short empathetic sentence, then bring them back to the question. Don\'t become a therapist. Example: "That\'s okay — every kid feels stuck sometimes. Let\'s break this question into a tiny piece. What\'s the first word that jumps out?"\n\n' +
      'NEVER claim to be a person or have a body / family / age. You are Nova, a friendly tutor character.\n' +
      'NEVER mention the student\'s name (you don\'t know it).'
      + KID_SAFE_RULES
      + CURRICULUM_ALIGNMENT_RULES
    ),
    buildUserPrompt: ({ questionType, prompt, choices, correctAnswer, gradeContext, curriculum, history, message }) => {
      let p = buildCurriculumBlock(curriculum || { grade: gradeContext }) + '\n\n';
      p += '— THE CURRENT QUESTION (this is the ONLY topic you may discuss) —\n';
      p += 'Question type: ' + questionType + '\n';
      p += 'Question: ' + prompt + '\n';
      if (choices && choices.length) {
        p += 'Choices:\n';
        choices.forEach((c, i) => { p += '  ' + i + '. ' + c + '\n'; });
      }
      const correctText = (typeof correctAnswer === 'number' && choices && choices[correctAnswer] !== undefined)
        ? String(choices[correctAnswer])
        : (correctAnswer != null ? String(correctAnswer) : '');
      if (correctText) {
        p += '\nCorrect answer (NEVER reveal): ' + correctText + '\n';
      }
      if (history.length) {
        p += '\n— Conversation so far —\n';
        for (const t of history) {
          p += (t.role === 'kid' ? 'Kid' : 'Nova') + ': ' + t.text + '\n';
        }
      }
      p += '\n— New message from the kid —\n';
      p += 'Kid: ' + message + '\n\n';
      p += 'Now write your reply as JSON. Stay on this question. Never reveal the answer. Max 2 sentences.';
      return p;
    },
    postProcess: (text, inputs) => {
      const parsed = parseJsonFromText(text);
      if (!parsed || typeof parsed !== 'object' || typeof parsed.reply !== 'string') {
        return { error: 'parse_failed', raw: (text || '').slice(0, 200) };
      }
      const reply = parsed.reply.trim();
      if (!reply) return { error: 'empty_reply' };
      const out = {
        reply: reply.slice(0, 320),
        onTopic: parsed.onTopic !== false,
      };
      // Belt-and-suspenders leak check (same pattern as /worked-example).
      // If the correct answer text appears in the reply, drop it.
      //
      // EXCEPTION: single-character answers. JK / SK letter-matching
      // questions like "Match BIG H with its little buddy" have the
      // correct answer 'h'. Nova literally cannot help the kid without
      // saying the letter ("the little buddy is the same letter in
      // lowercase form — h"). Same goes for tiny-number math: "What
      // comes after 4?" with answer '5'. The strict word-boundary
      // check fired on every reasonable reply, so the kid saw the
      // offline "I can't chat right now" fallback instead of help.
      // For single-character answers we trust the system prompt's
      // "NEVER REVEAL THE ANSWER" instruction + the fact that the kid
      // still has to identify which TILE shows the letter even after
      // Nova names it (the four choices include both cases of two
      // letters, so naming "h" doesn't bypass picking the right cell).
      try {
        const inp = inputs || {};
        const choices = Array.isArray(inp.choices) ? inp.choices : null;
        const correctText = (typeof inp.correctAnswer === 'number' && choices && choices[inp.correctAnswer] !== undefined)
          ? String(choices[inp.correctAnswer])
          : (inp.correctAnswer != null ? String(inp.correctAnswer) : '');
        const correctTrim = correctText ? correctText.trim() : '';
        if (correctTrim.length > 1) {  // skip leak check for 1-char answers
          const haystack = out.reply.toLowerCase();
          const needle = correctTrim.toLowerCase();
          let leaked = false;
          if (needle.length <= 3) {
            const re = new RegExp('(?:^|[^\\w])' + needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:[^\\w]|$)');
            leaked = re.test(haystack);
          } else {
            leaked = haystack.indexOf(needle) !== -1;
          }
          if (leaked) return { error: 'answer_leaked' };
        }
      } catch (_) {}
      return out;
    },
    auditSummary: (inputs) => `sidekick → "${(inputs.message||'').slice(0, 40)}" Q="${(inputs.prompt||'').slice(0, 30)}"`,
  });
}

// ---- /worked-example ---------------------------------------------------
// "Show me how" — Nova walks the kid through HOW to approach a question
// step-by-step BEFORE they answer it, without revealing the answer.
// Distinct from /explain (which fires AFTER a wrong answer to explain
// what they missed): this is proactive guidance for kids who don't know
// where to start.
//
// Cache key: question + choices + curriculum + grade. Same question
// always yields the same walkthrough. 30-day TTL same as /explain.
//
// Output shape: { steps: [string, ...], finalNudge: string }
//   - 2-4 steps, each <= 1 sentence
//   - finalNudge points kid back to the choices ("Now you can pick!")
async function handleWorkedExample(request, env, ctx, corsOrigin) {
  return runStandardHandler({
    request, env, ctx, corsOrigin,
    endpoint: '/worked-example',
    readInputs: async (body) => ({
      questionType: String(body.questionType || 'unknown').slice(0, 40),
      prompt: String(body.prompt || '').trim().slice(0, 600),
      choices: Array.isArray(body.choices) ? body.choices.slice(0, 6).map(c => String(c).slice(0, 120)) : null,
      // correctAnswer (Apr 2026): we now PASS the correct answer to the
      // model so it knows EXACTLY what string/number to avoid revealing
      // in its steps. Hiding it didn't work — for math the model just
      // computed the answer itself and put it in the counting sequence
      // ("count: 8, 9, 10, 11, 12"). Telling the model "do not say 12"
      // is far more reliable than hoping it doesn't infer 12.
      correctAnswer: (typeof body.correctAnswer === 'number' || typeof body.correctAnswer === 'string') ? body.correctAnswer : null,
      gradeContext: String(body.gradeContext || '').slice(0, 40),
      curriculum: (body.curriculum && typeof body.curriculum === 'object') ? body.curriculum : null,
    }),
    validate: ({ prompt }) => prompt ? null : { error: 'missing_prompt' },
    cacheKey: ({ prompt, choices, gradeContext, curriculum }) =>
      hashKey(
        // v3 (Apr 2026): stricter prompt that passes correctAnswer to the
        // model + post-validates the response for leaks. Bumped from v2
        // so previously-cached leaky responses get rebuilt.
        'worked-example-v3',
        prompt,
        JSON.stringify(choices || []),
        gradeContext,
        curriculum ? JSON.stringify({g:curriculum.grade, s:curriculum.strand, c:curriculum.codes}) : ''
      ),
    cacheTtlSeconds: 30 * 24 * 3600,
    maxTokens: 360,
    buildSystemPrompt: () => (
      'You are Nova, a warm AI tutor for a child stuck on a quiz question. Walk them through HOW to find the answer in 2-4 easy steps. The kid should be able to FIGURE OUT the answer from your steps without you ever stating it.\n\n' +
      'REPLY WITH STRICT JSON ONLY (no prose, no markdown fences):\n' +
      '{\n' +
      '  "steps": [string, ...]   // 2 to 4 short steps. Each step is one sentence.\n' +
      '  "finalNudge": string     // one short sentence — encouragement to pick now\n' +
      '}\n\n' +
      'CRITICAL — never reveal the answer:\n' +
      '- DO NOT say "the answer is X" or "X is correct" or "pick X" or "choose X."\n' +
      '- DO NOT name a specific choice by number, letter, or its full text. No "option 2", no "B", no "the third one."\n' +
      '- DO NOT compute the final numeric answer. Stop ONE step short — let the kid do the last hop.\n' +
      '- DO NOT quote back the exact correct choice as a "good example."\n\n' +
      'BUT — make the answer obvious through the method:\n' +
      '- For multiple choice: rule OUT clearly wrong choices ("\'in park we the played\' has the words mixed up like a puzzle"). It is fine to point at the structural pattern of one or two wrong choices — the kid eliminates them and the right one is left.\n' +
      '- For math: walk the operation one tiny step at a time, STOPPING JUST BEFORE the final number. Example: "First add 8 + 4 = 12. Now take away 5. What\'s left?"\n' +
      '- For reading comprehension: point to the EXACT sentence or phrase in the passage that holds the answer, without saying what the answer is. Example: "Look at the part that says \'because she was scared\'. What word comes right before that?"\n' +
      '- For vocabulary: give the meaning in different words, without using the word itself. The kid maps it to the right choice.\n\n' +
      'EXAMPLES OF GOOD vs BAD output:\n\n' +
      'Q: "What is 7 + 5?" Correct answer: 12\n' +
      '  BAD:  ["Now count up 5 more: 8, 9, 10, 11, 12.", "What number did you land on?"]   ← leaks 12 inside the count\n' +
      '  BAD:  ["7 + 5 equals 12.", "The answer is 12."]   ← states it directly\n' +
      '  GOOD: ["Start at 7 in your head.", "Count up four numbers: 8, 9, 10, 11.", "Now say one more — that\'s your answer."]\n\n' +
      'Q: "Which sentence has the BEST word order? a) Park the in played we. b) We played in the park. c) Played we park the in. d) In park we the played." Correct answer: "We played in the park."\n' +
      '  BAD:  ["Pick the one that says \'We played in the park.\'"]   ← quotes the correct choice text\n' +
      '  GOOD: ["Read each one out loud in your head.", "Some have the words shuffled like a puzzle — those don\'t sound like real English.", "Find the one that sounds like a sentence you would actually say."]\n\n' +
      'Q: "Why did Maya go to the park?" Passage mentions "to meet Jamie." Correct answer: "To meet Jamie"\n' +
      '  BAD:  ["She went to meet Jamie."]   ← states the answer\n' +
      '  GOOD: ["Find the part of the passage that mentions the park.", "Look at the words that come right after — they tell you why.", "Match those words to one of the choices."]\n\n' +
      'OTHER RULES:\n' +
      '- Match the grade level: K-2 very simple words, 3-5 friendly, 6+ solid.\n' +
      '- Be warm and concise. No lectures. No "you got this!" filler in the steps — save warmth for finalNudge.\n' +
      '- Never mention the student\'s name or any identifying detail.\n' +
      '- finalNudge: ~1 short encouraging sentence. Examples: "Now pick the one that fits!", "Which one matches?", "You can do it — give it a try."'
      + KID_SAFE_RULES
      + CURRICULUM_ALIGNMENT_RULES
    ),
    buildUserPrompt: ({ questionType, prompt, choices, correctAnswer, gradeContext, curriculum }) => {
      let p = buildCurriculumBlock(curriculum || { grade: gradeContext }) + '\n\n';
      p += 'Question type: ' + questionType + '\n';
      p += 'Question the child sees: ' + prompt + '\n';
      if (choices && choices.length) {
        p += 'Choices the child sees:\n';
        choices.forEach((c, i) => { p += '  ' + i + '. ' + c + '\n'; });
      }
      // Tell the model the correct answer and ban it explicitly. Far more
      // reliable than hoping the model won't infer it (which it always does
      // for math). The instruction "DO NOT MENTION THIS" is a much harder
      // signal than any general rule about avoiding spoilers.
      const correctText = (typeof correctAnswer === 'number' && choices && choices[correctAnswer] !== undefined)
        ? String(choices[correctAnswer])
        : (correctAnswer != null ? String(correctAnswer) : '');
      if (correctText) {
        p += '\nThe correct answer is: ' + correctText + '\n';
        p += 'DO NOT WRITE THIS ANSWER ANYWHERE in your steps or finalNudge — not as a number, not as text, not inside a list or counting sequence. The kid must figure it out from your method.\n';
      }
      p += '\nNow write the JSON walkthrough — strategy only, no answer reveal.';
      return p;
    },
    postProcess: (text, inputs) => {
      const parsed = parseJsonFromText(text);
      if (!parsed || typeof parsed !== 'object') {
        return { error: 'parse_failed', raw: (text || '').slice(0, 200) };
      }
      const out = {};
      if (Array.isArray(parsed.steps)) {
        out.steps = parsed.steps
          .filter(s => typeof s === 'string')
          .map(s => s.trim().slice(0, 280))
          .filter(Boolean)
          .slice(0, 4);
      }
      if (typeof parsed.finalNudge === 'string' && parsed.finalNudge.trim()) {
        out.finalNudge = parsed.finalNudge.trim().slice(0, 160);
      }
      if (!out.steps || out.steps.length === 0) {
        return { error: 'no_steps' };
      }
      // Belt-and-suspenders leak check: scan steps + finalNudge for the
      // correct answer text. If it shows up, treat the response as
      // contaminated and return an error so the client falls back to a
      // soft generic nudge instead of leaking. This catches both direct
      // ("the answer is 12") and indirect leaks ("count: 8, 9, 10, 11, 12").
      //
      // EXCEPTION: single-character answers (see /sidekick for the
      // full rationale). JK letter-matching questions and tiny-number
      // math have answers like 'h' or '5' — Nova literally cannot
      // walk the kid through HOW without naming them. For single-char
      // answers we trust the system prompt's "never reveal" instruction
      // and the structural fact that the kid still has to pick the
      // right tile even after the letter / digit has been named.
      try {
        const inp = inputs || {};
        const choices = Array.isArray(inp.choices) ? inp.choices : null;
        const correctText = (typeof inp.correctAnswer === 'number' && choices && choices[inp.correctAnswer] !== undefined)
          ? String(choices[inp.correctAnswer])
          : (inp.correctAnswer != null ? String(inp.correctAnswer) : '');
        const correctTrim = correctText ? correctText.trim() : '';
        if (correctTrim.length > 1) {  // skip leak check for 1-char answers
          // Build the haystack from all output text the kid will see.
          const haystack = (out.steps.join(' ') + ' ' + (out.finalNudge || '')).toLowerCase();
          const needle = correctTrim.toLowerCase();
          // For very short answers (2-3 chars, e.g. "12", "no"), do a
          // word-boundary check so "1234" doesn't trip on "12". For longer
          // answers, substring match is fine — they're distinctive.
          let leaked = false;
          if (needle.length <= 3) {
            // Match as a standalone token (digit run or word).
            const re = new RegExp('(?:^|[^\\w])' + needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:[^\\w]|$)');
            leaked = re.test(haystack);
          } else {
            leaked = haystack.indexOf(needle) !== -1;
          }
          if (leaked) {
            return { error: 'answer_leaked', leaked: needle };
          }
        }
      } catch (_) {}
      return out;
    },
    auditSummary: (inputs) => `worked-example → Q="${(inputs.prompt||'').slice(0, 60)}"`,
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

// ---- /generate-lesson --------------------------------------------------
// Build a COMPLETE Solvix activity object for a given grade × subject
// slot. Returned JSON includes title, emoji, curriculum tag (Ontario
// strand + codes + description), lesson{title,intro,example,hint},
// 5 main questions (with optional passage block on reading lessons),
// and 5 stretch questions one tier harder.
//
// Used by tools/bulk_fill_week2.py to seed Week 2+ rosters when
// authored content runs out. The operator reviews the output JSON
// (which gets patched into app/index.html as a `{ id:..., title:...,
// questions:[...], stretchQuestions:[...] }` activity literal) before
// committing — so the AI hallucination floor doesn't ship to kids
// without human eyes on it.
//
// NOT cached: each lesson should be unique even for the same grade/
// subject. We don't want every operator running the script to get
// identical "Cause and Effect" lessons.
async function handleGenerateLesson(request, env, ctx, corsOrigin) {
  return runStandardHandler({
    request, env, ctx, corsOrigin,
    endpoint: '/generate-lesson',
    readInputs: async (body) => ({
      grade:        String(body.grade || '').trim().slice(0, 40),
      subject:      String(body.subject || '').trim().slice(0, 40),
      week:         Math.max(1, Math.min(20, Number(body.week) || 2)),
      // Optional topic suggestion. If omitted, the AI picks a topic
      // appropriate for the grade × subject × week-of-curriculum.
      suggestedTopic: String(body.suggestedTopic || '').slice(0, 120),
      // Optional priorTopics: an array of topic names from prior weeks
      // so the AI doesn't repeat what the kid already covered. Empty
      // array → AI picks freely.
      priorTopics:  Array.isArray(body.priorTopics)
        ? body.priorTopics.slice(0, 12).map(t => String(t).slice(0, 80))
        : [],
      // Whether the lesson should include a reading passage. Default
      // true for reading subject, false otherwise.
      needsPassage: typeof body.needsPassage === 'boolean'
        ? body.needsPassage
        : (String(body.subject || '').toLowerCase() === 'reading'),
    }),
    validate: ({ grade, subject }) => {
      if (!grade) return { error: 'missing_grade' };
      if (!subject) return { error: 'missing_subject' };
      return null;
    },
    cacheKey: null, // never cache — see comment above
    maxTokens: 2400,
    buildSystemPrompt: () => (
      'You generate a COMPLETE grade-level lesson for the Solvix learning app. ' +
      'Output STRICT JSON ONLY (no prose, no markdown fences). Shape:\n' +
      '{\n' +
      '  "title": string,                    // ≤ 40 chars, kid-friendly\n' +
      '  "emoji": string,                    // ONE emoji that captures the topic\n' +
      '  "curriculum": {\n' +
      '    "grade": string,                  // matches input grade exactly\n' +
      '    "strand": string,                 // Ontario strand and substrand, e.g. "Language — C. Comprehension: Understanding Texts"\n' +
      '    "codes":  [string],               // 1-3 Ontario expectation codes (e.g. "C1.5", "B3.2"). Use real Ontario Curriculum codes.\n' +
      '    "description": string             // ≤ 200 chars. The Ontario expectation in plain English.\n' +
      '  },\n' +
      '  "lesson": {\n' +
      '    "title": string,                  // teaching-card heading, ≤ 40 chars\n' +
      '    "intro": string,                  // 2-3 sentences explaining the concept in kid words\n' +
      '    "example": string,                // 1 concrete worked example\n' +
      '    "hint":   string                  // 1 short anchor phrase the kid can repeat to themselves\n' +
      '  },\n' +
      '  "questions": [                       // EXACTLY 5 entries\n' +
      '    // For READING lessons, the FIRST entry MUST be:\n' +
      '    // { "type":"passage", "passage": string (~50-100 words for the grade), "q": string, "choices": [4 strings], "answer": int 0-3 },\n' +
      '    // For non-reading lessons, ALL 5 are MCQs with the shape below:\n' +
      '    { "type":"mcq", "q": string, "choices": [4 strings], "answer": int 0-3 }\n' +
      '  ],\n' +
      '  "stretchQuestions": [                // EXACTLY 5 entries, all type:"mcq", ONE tier harder than questions\n' +
      '    { "type":"mcq", "q": string, "choices": [4 strings], "answer": int 0-3 }\n' +
      '  ]\n' +
      '}\n\n' +
      'Hard rules:\n' +
      '- Match the grade level rigorously: K-2 simple sentences, 3-5 friendly + concrete, 6-8 academic.\n' +
      '- Strand + codes MUST be real Ontario Curriculum (Ontario Ministry of Education).\n' +
      '- Distractors (wrong choices) must be PLAUSIBLE for the grade — no "obviously silly" wrong answers.\n' +
      '- All 4 choices in a question should be similar LENGTH — avoid the "longest = correct" giveaway.\n' +
      '- Answer indices should VARY across the 5 questions (not all 1, not all 2).\n' +
      '- Stretch questions test the SAME skill at a slightly harder level (more abstract, longer reading load, two-step reasoning).\n' +
      '- Reading passage should be self-contained — kids must be able to answer all 5 main questions from the passage alone.\n' +
      '- Never include the student\'s real name. Use generic kid names (Maya, Liam, Sara, Ben, Aria, etc.).\n'
      + KID_SAFE_RULES
      + CURRICULUM_ALIGNMENT_RULES
    ),
    buildUserPrompt: ({ grade, subject, week, suggestedTopic, priorTopics, needsPassage }) => (
      'Generate ONE complete lesson for:\n' +
      '  Grade: ' + grade + '\n' +
      '  Subject: ' + subject + '\n' +
      '  Week: ' + week + ' (so the topic should progress beyond Week 1 of this subject for this grade)\n' +
      (suggestedTopic ? '  Suggested topic: ' + suggestedTopic + '\n' : '  Suggested topic: (you pick a Week-' + week + '-appropriate topic)\n') +
      (priorTopics.length
        ? '  Prior weeks already covered: ' + priorTopics.join(', ') + '\n  Pick a topic that BUILDS on these without repeating them.\n'
        : '') +
      '  Reading passage required? ' + (needsPassage ? 'YES — first question MUST be type:"passage"' : 'NO — all 5 questions are type:"mcq"') + '\n\n' +
      'Return the JSON now.'
    ),
    postProcess: (text, inputs) => {
      const parsed = parseJsonFromText(text);
      if (!parsed || typeof parsed !== 'object') {
        return { error: 'parse_failed', raw: (text || '').slice(0, 200) };
      }
      // Defensive shape validation. We don't fix the AI's mistakes here —
      // we surface them so the operator script can retry. But we DO
      // truncate string fields so a runaway AI can't blow up the source
      // file.
      const out = {};
      if (typeof parsed.title === 'string')  out.title = parsed.title.slice(0, 60);
      if (typeof parsed.emoji === 'string')  out.emoji = parsed.emoji.slice(0, 8);
      if (parsed.curriculum && typeof parsed.curriculum === 'object') {
        out.curriculum = {
          grade: String(parsed.curriculum.grade || inputs.grade).slice(0, 40),
          strand: String(parsed.curriculum.strand || '').slice(0, 200),
          codes: Array.isArray(parsed.curriculum.codes)
            ? parsed.curriculum.codes.slice(0, 4).map(c => String(c).slice(0, 20))
            : [],
          description: String(parsed.curriculum.description || '').slice(0, 280),
        };
      }
      if (parsed.lesson && typeof parsed.lesson === 'object') {
        out.lesson = {
          title:   String(parsed.lesson.title || '').slice(0, 60),
          intro:   String(parsed.lesson.intro || '').slice(0, 600),
          example: String(parsed.lesson.example || '').slice(0, 400),
          hint:    String(parsed.lesson.hint || '').slice(0, 200),
        };
      }
      const sanitizeQuestions = (arr, allowPassage) => {
        if (!Array.isArray(arr)) return [];
        return arr.slice(0, 6).map(q => {
          if (!q || typeof q !== 'object') return null;
          const t = String(q.type || 'mcq');
          const cleanType = (t === 'passage' && allowPassage) ? 'passage' : 'mcq';
          const ans = (typeof q.answer === 'number' && q.answer >= 0 && q.answer <= 5) ? q.answer : 0;
          const out = {
            type: cleanType,
            q: String(q.q || '').slice(0, 320),
            choices: Array.isArray(q.choices)
              ? q.choices.slice(0, 6).map(c => String(c).slice(0, 160))
              : [],
            answer: ans,
          };
          if (cleanType === 'passage' && typeof q.passage === 'string') {
            out.passage = q.passage.slice(0, 1200);
          }
          return out;
        }).filter(q => q && q.choices.length >= 2 && q.q);
      };
      out.questions = sanitizeQuestions(parsed.questions, true);
      out.stretchQuestions = sanitizeQuestions(parsed.stretchQuestions, false);
      // Final validation: must have at least 3 main questions to be
      // worth shipping. Stretch is optional but expected.
      if (out.questions.length < 3) {
        return { error: 'parse_failed', raw: 'Too few main questions (' + out.questions.length + ')' };
      }
      return out;
    },
    auditSummary: (inputs, out) => {
      const t = (out && out.title) || '?';
      return `generate-lesson → ${inputs.grade}/${inputs.subject} W${inputs.week}: ${t}`;
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
  // Admin bulk-fill bypass: when the operator presents X-Admin-Token
  // matching env.ADMIN_TOKEN, skip the per-student daily cap. This is
  // for offline tooling like tools/bulk-fill-stretch.mjs that needs to
  // generate stretch-question pools across hundreds of lessons in a
  // single run — far past any kid's reasonable daily budget. The token
  // check is server-side only; ADMIN_TOKEN never ships to the browser.
  // Audit entries still attribute to the requested studentId (or
  // '_admin_bulk' if anon) so we can audit who/what hit the API.
  const adminTokenHeader = request.headers.get('X-Admin-Token') || '';
  const isAdminBypass = !!(env.ADMIN_TOKEN && adminTokenHeader && adminTokenHeader === env.ADMIN_TOKEN);
  // Cache lookup FIRST — a hit is free so it shouldn't count against
  // the kid's daily budget. NOTE: hashKey() is async (uses crypto.subtle
  // .digest), so the cacheKey function returns a Promise<string>. We
  // MUST await it — otherwise the template literal in cacheGet stringifies
  // the Promise as "[object Promise]" and EVERY call across every
  // endpoint reads/writes the same KV key, returning whatever any prior
  // call happened to store there. (Bug surfaced when /generate-questions
  // started returning /explain-shaped responses on cache hit.)
  const keyResult = typeof cacheKey === 'function' ? cacheKey(inputs) : null;
  const key = keyResult ? await keyResult : null;
  if (key) {
    const cached = await cacheGet(env, key);
    if (cached) {
      return json({ ok: true, cached: true, data: cached }, 200, corsOrigin);
    }
  }
  // Daily cap. Now increment — cache missed, we're about to spend.
  // Admin bypass skips the cap but still goes through audit below.
  if (!isAdminBypass) {
    const gate = await checkDailyCap(env, studentId);
    if (!gate.ok) {
      return json({ error: 'rate_limited', reason: gate.reason, used: gate.used, cap: gate.cap }, 429, corsOrigin);
    }
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
  // Handler-specific post-processing. We pass `inputs` as a second arg
  // so handlers that need to validate the response against the original
  // request (e.g. /worked-example checking the steps don't leak the
  // correct answer) can do so. Existing single-arg postProcess fns
  // ignore the extra parameter cleanly.
  const out = postProcess(modelText, inputs);
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

async function buildHealthPayload(env) {
  const features = {};
  for (const flag of FEATURE_FLAGS) {
    features[flag] = isFlagOn(env, flag);
  }
  // Global maintenance is intentionally surfaced here (an unauthenticated
  // endpoint) so clients can check the gate state BEFORE they have a
  // tenant code. Anyone — visitor on the marketing page, kid loading
  // the app shell, parent typing a code — can see whether the gate is
  // up. The flag is non-sensitive (just a "site is being updated" bool +
  // a short user-facing message); the actual flip requires ADMIN_TOKEN.
  const gm = await getGlobalMaintenance(env);
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
    global_maintenance: gm,
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
