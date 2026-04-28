#!/usr/bin/env node
/* Solvix — Week-2 lesson generator
   ----------------------------------------------------------------------
   One-shot operator tool. Generates a draft `WEEKS[2][sid][subjectId]`
   array (5 activities, lessons 6-10) by calling Claude Haiku 4.5 with
   the student's existing Week-1 lessons as shape/style/difficulty
   context. Output is a reviewable JS snippet at /tmp/week2-<sid>-<subj>.js
   that the operator pastes into app/index.html.

   Why a Node script and not the AI proxy:
     • Prompt iteration speed — edit script + re-run, no redeploy
     • Operator-only tool — no need to plumb auth through the proxy
     • Aligns with how the existing operator scripts (provision-tenant,
       maintenance.sh) work: bash/Node, runs locally, hits APIs directly

   Usage:
     ANTHROPIC_API_KEY=sk-ant-... node tools/gen-week2.js <sid> <subject>
     ANTHROPIC_API_KEY=sk-ant-... node tools/gen-week2.js akshayan reading

   Output:
     /tmp/week2-<sid>-<subject>.js   ← review this, then paste into WEEKS[2]

   Cost:
     ~$0.001 per activity at Haiku 4.5 prices (~3k in / ~2k out tokens).
     Full 5-activity run for one student×subject: ~$0.005, ~30 sec wall time.
*/

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP_HTML = path.join(ROOT, 'app/index.html');
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_KEY = process.env.ANTHROPIC_API_KEY;

// Letter codes used inside activity ids: w1-isaiah-r3 → 'r' = reading.
// Mirrors the SUBJECTS table in app/index.html (line ~3000).
const SUBJECT_LETTERS = {
  reading:  'r',
  writing:  'w',
  math:     'm',
  science:  's',
  spelling: 'p',  // 'p' kept for legacy; renamed to spelling in UI
  language: 'l',
  french:   'f',
  coding:   'c',
};

function die(msg) { console.error('✗ ' + msg); process.exit(1); }

if (!API_KEY) die('ANTHROPIC_API_KEY env var required. Use the same key wrangler is configured with.');
const [, , sidArg, subjArg] = process.argv;
if (!sidArg || !subjArg) die('Usage: node tools/gen-week2.js <sid> <subject>\n  e.g. node tools/gen-week2.js akshayan reading');
const sid = sidArg.toLowerCase();
const subj = subjArg.toLowerCase();
const subjLetter = SUBJECT_LETTERS[subj];
if (!subjLetter) die(`Unknown subject "${subj}". Known: ${Object.keys(SUBJECT_LETTERS).join(', ')}`);

// ---- Step 1: extract Week-1 context for this student × subject -------
// We don't try to fully parse the JS file (it's 27k lines of mixed code
// + data); instead we slice out the student's reading: [...] block by
// brace-counting from the per-subject array marker. Crude but reliable
// for our shape.
const html = fs.readFileSync(APP_HTML, 'utf8');

function extractStudentSubjectActivities(html, sid, subj) {
  // Line-based extraction. Brace-counting fails because the file has
  // JS line comments (// foo) with apostrophes that look like strings,
  // and properly handling //, /* */, regex literals, and template
  // strings is a real JS parser's job. The data is structured enough
  // to read by indentation: top-level student blocks open with
  //   "<sid>: {"   at column 0 ─ no leading whitespace
  // and close with
  //   "},"         at column 0
  // Inside, each subject array opens with a 2-space indent:
  //   "  <subj>: [" and closes with "  ],"
  // We find these markers by line scan instead of char scan.
  const lines = html.split('\n');
  const sidOpenRe = new RegExp(`^${sid}:\\s*\\{\\s*$`);
  const blockCloseRe = /^\},?\s*$/;
  let sidStartLine = -1, sidEndLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (sidStartLine < 0) {
      if (sidOpenRe.test(lines[i])) sidStartLine = i;
    } else {
      if (blockCloseRe.test(lines[i])) { sidEndLine = i; break; }
    }
  }
  if (sidStartLine < 0 || sidEndLine < 0) return null;
  // Find the subj: [ ... ] block within these lines.
  const subjOpenRe = new RegExp(`^\\s+${subj}:\\s*\\[\\s*$`);
  // Subject closer: a line that's just "]," (or "]") at the same depth.
  // We search inside the student range, finding the matching close by
  // bracket-counting LINES (each "[" alone or at line end opens, each
  // "]," or "]" alone closes). For this file's formatting, the subject
  // array closer is a line that's ONLY "],".
  const subjCloseRe = /^\s+\],?\s*$/;
  let subjStartLine = -1, subjEndLine = -1;
  for (let i = sidStartLine + 1; i < sidEndLine; i++) {
    if (subjStartLine < 0) {
      if (subjOpenRe.test(lines[i])) subjStartLine = i;
    } else {
      if (subjCloseRe.test(lines[i])) { subjEndLine = i; break; }
    }
  }
  if (subjStartLine < 0 || subjEndLine < 0) return null;
  return lines.slice(subjStartLine, subjEndLine + 1).join('\n');
}

const week1Block = extractStudentSubjectActivities(html, sid, subj);
if (!week1Block) die(`Could not find WEEKS[1].${sid}.${subj} in app/index.html. Verify sid + subject spelling.`);

// Extract grade from the student's persona block. We need this for the
// curriculum tag — the model can't be trusted to guess a kid's grade.
function extractGrade(html, sid) {
  // Persona blocks live in the STUDENTS array, shape:
  //   { id:'isaiah', name:'Isaiah', grade:'Grade 4', ...
  const re = new RegExp(`id:\\s*['"]${sid}['"][^}]*?grade:\\s*['"]([^'"]+)['"]`, 's');
  const m = re.exec(html);
  return m ? m[1] : null;
}
const grade = extractGrade(html, sid);
if (!grade) die(`Could not find grade for student "${sid}" in STUDENTS array.`);

// Pull the plan/notes (IEP, ESL, etc.) so the generator respects supports.
function extractPlanNotes(html, sid) {
  const re = new RegExp(`id:\\s*['"]${sid}['"][\\s\\S]*?plan:\\s*\\{[^}]*?notes:\\s*['"]([^'"]+)['"]`, 's');
  const m = re.exec(html);
  return m ? m[1] : '';
}
const planNotes = extractPlanNotes(html, sid);

console.log(`✓ Found Week-1 ${subj} for ${sid} (${grade}). ${week1Block.length} chars of context.`);
if (planNotes) console.log(`  Plan: ${planNotes.slice(0, 100)}…`);

// ---- Step 2: build the prompts (subject-aware) -----------------------

const KID_SAFE_RULES = `
KID-SAFE RULES (non-negotiable):
- No violence, weapons, injury, blood, death, disturbing imagery.
- No scary themes (monsters chasing kids, abandonment, getting lost forever, kidnapping).
- No commercial brand mentions (Disney, Marvel, YouTube, TikTok, etc.).
- No real-person names (politicians, celebrities, athletes).
- No religion-specific references; use neutral cultural touchstones.
- No food allergies as plot points; no medical emergencies.
- Endings must be positive or at least neutral. No sad endings, no losses.
- Diverse names that don't favor one culture (Mia, Leo, Kai, Sara, Jaden, Ravi, Maya, etc.).
`;

const READING_SYSTEM = `You are an expert elementary-school reading teacher writing a single comprehension activity for a ${grade} student. The activity is ONE LESSON of ~5-7 minutes' worth of work.

OUTPUT STRICT JSON. NO PROSE. NO MARKDOWN FENCES. Exact shape:
{
  "title": "Short story-flavored title (e.g. 'The Lost Kite')",
  "emoji": "ONE topical emoji",
  "curriculum": {
    "grade": "${grade}",
    "strand": "Language — C. Comprehension: Understanding Texts",
    "codes": ["C1.3"],
    "notes": "One-sentence Ontario-style expectation summary."
  },
  "lesson": {
    "title": "Skill name (e.g. 'Finding Cause and Effect')",
    "intro": "1-2 sentence plain-English intro to the skill.",
    "example": "One concrete sentence-length example.",
    "hint": "One strategy tip the kid can apply."
  },
  "questions": [
    { "type": "passage", "passage": "PASSAGE TEXT — see length guide below.", "q": "First comprehension question.", "choices": ["A","B","C","D"], "answer": 0 },
    { "type": "mcq", "q": "Second question about the same passage.", "choices": ["A","B","C","D"], "answer": 0 },
    { "type": "mcq", "q": "Third question.", "choices": ["A","B","C","D"], "answer": 0 },
    { "type": "mcq", "q": "Fourth question.", "choices": ["A","B","C","D"], "answer": 0 },
    { "type": "mcq", "q": "Fifth question.", "choices": ["A","B","C","D"], "answer": 0 }
  ]
}

PASSAGE LENGTH BY GRADE:
- JK / SK: 3-4 short sentences, repetitive sight words, one idea per sentence.
- Grade 1-2: 4-6 sentences, simple narrative, concrete vocabulary.
- Grade 3-4: 6-9 sentences, single clear arc or 2-3 connected facts.
- Grade 5-6: 9-12 sentences, light figurative language ok, layered details.
- Grade 7-8: 12-15 sentences, denser vocab, ESL-friendly clarity if marked.

QUESTION RULES:
- Question 1 MUST be type:"passage" with the passage attached.
- Questions 2-5 MUST be type:"mcq" — they reference the SAME passage from Q1.
- Vary skills across the 5: literal recall, inference, vocabulary in context, main idea, character feeling, sequence.
- Each question has EXACTLY 4 choices, 0-indexed answer.
- DOUBLE-CHECK each answer against the passage before writing it.
- Distractors must be plausible (a kid skim-reading might pick them) — no random text.
- No questions about details NOT in the passage.

CURRICULUM ALIGNMENT:
- Stay inside ${grade} expectations. Do not drift up or down.
- Match the strand: Comprehension / Understanding Texts / Reading Strategies / Vocabulary.

PERSONALIZATION:
${planNotes ? `- This student has a learning plan note: "${planNotes}". Honor it: passage length, vocabulary complexity, and instruction wording must reflect this plan.` : '- No specific plan notes — use a balanced, neutral approach for the grade.'}
${KID_SAFE_RULES}`;

const GENERIC_SYSTEM = `You are an expert elementary teacher authoring ONE ${subj} lesson for a ${grade} student.

OUTPUT STRICT JSON. NO PROSE. NO MARKDOWN FENCES. Exact shape:
{
  "title": "Short, kid-friendly title.",
  "emoji": "ONE topical emoji",
  "curriculum": {
    "grade": "${grade}",
    "strand": "(Subject — appropriate Ontario strand)",
    "codes": ["..."],
    "notes": "One-sentence expectation summary."
  },
  "lesson": {
    "title": "Skill name",
    "intro": "1-2 sentence plain-English intro.",
    "example": "One concrete worked example.",
    "hint": "One strategy tip."
  },
  "questions": [
    { "type": "mcq", "q": "...", "choices": ["A","B","C","D"], "answer": 0 },
    { "type": "mcq", "q": "...", "choices": ["A","B","C","D"], "answer": 0 },
    { "type": "mcq", "q": "...", "choices": ["A","B","C","D"], "answer": 0 },
    { "type": "mcq", "q": "...", "choices": ["A","B","C","D"], "answer": 0 },
    { "type": "mcq", "q": "...", "choices": ["A","B","C","D"], "answer": 0 }
  ]
}

QUESTION RULES:
- Exactly 5 questions, all type:"mcq", exactly 4 choices each.
- DOUBLE-CHECK each answer (do the math, look up the fact). Wrong answers are unacceptable.
- Distractors must be plausible (off-by-one for math, near-synonyms for vocabulary, common misconceptions for science).
- Stay inside ${grade} expectations.

PERSONALIZATION:
${planNotes ? `- Student plan: "${planNotes}". Honor it.` : '- No specific plan notes.'}
${KID_SAFE_RULES}`;

const SYSTEM_PROMPT = subj === 'reading' ? READING_SYSTEM : GENERIC_SYSTEM;

// ---- Step 3: per-lesson user prompt ----------------------------------
function buildUserPrompt(lessonNumber, alreadyGenerated) {
  let p = `Generate Week-2 lesson #${lessonNumber} (the ${['1st','2nd','3rd','4th','5th'][lessonNumber - 6]} of 5 Week-2 lessons).\n\n`;
  p += `For shape, style, and difficulty calibration, here are this student's existing Week-1 lessons:\n`;
  p += '```\n' + week1Block + '\n```\n\n';
  if (alreadyGenerated.length) {
    p += `You have already generated these Week-2 lessons in this run. DO NOT REPEAT their topics or skill focus — pick a fresh angle:\n`;
    alreadyGenerated.forEach((a, i) => {
      p += `  Lesson ${i + 6}: "${a.title}" — skill: ${a.lesson && a.lesson.title}\n`;
    });
    p += '\n';
  }
  p += `Week-2 should PROGRESS in difficulty and skill from Week-1, not repeat it. The 5 Week-2 lessons together should cover a broader skill spread than the 5 Week-1 lessons did.\n\n`;
  p += `Output the ONE activity now. Strict JSON only.`;
  return p;
}

// ---- Step 4: Claude call --------------------------------------------
async function callClaude(systemPrompt, userPrompt) {
  const r = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2400,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`anthropic ${r.status}: ${detail.slice(0, 300)}`);
  }
  const j = await r.json();
  const block = (j.content || []).find(b => b.type === 'text');
  if (!block) throw new Error('no text block in response');
  return block.text;
}

function parseJson(text) {
  if (!text) return null;
  let t = text.trim();
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  // Pull the first {...} balanced span.
  const start = t.indexOf('{');
  if (start < 0) return null;
  let depth = 0, end = -1, inString = false, stringChar = '', escape = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (inString) { if (ch === stringChar) inString = false; continue; }
    if (ch === '"' || ch === "'") { inString = true; stringChar = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}

function validateActivity(a, expectedSubject) {
  if (!a || typeof a !== 'object') return 'not an object';
  if (typeof a.title !== 'string' || !a.title) return 'missing title';
  if (typeof a.emoji !== 'string' || !a.emoji) return 'missing emoji';
  if (!a.curriculum || typeof a.curriculum !== 'object') return 'missing curriculum';
  if (!a.lesson || typeof a.lesson !== 'object') return 'missing lesson';
  if (!Array.isArray(a.questions)) return 'questions not an array';
  if (a.questions.length !== 5) return `expected 5 questions, got ${a.questions.length}`;
  for (let i = 0; i < a.questions.length; i++) {
    const q = a.questions[i];
    if (!q || typeof q !== 'object') return `q${i + 1}: not an object`;
    if (typeof q.q !== 'string' || !q.q) return `q${i + 1}: missing q text`;
    if (!Array.isArray(q.choices) || q.choices.length !== 4) return `q${i + 1}: needs exactly 4 choices`;
    if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer > 3) return `q${i + 1}: bad answer index`;
    if (expectedSubject === 'reading' && i === 0) {
      if (q.type !== 'passage') return `q1 must be type:passage`;
      if (typeof q.passage !== 'string' || q.passage.length < 30) return `q1 passage too short`;
    }
  }
  return null;
}

// ---- Step 5: main loop -----------------------------------------------
(async () => {
  const generated = [];
  for (let lessonNum = 6; lessonNum <= 10; lessonNum++) {
    const id = `w2-${sid}-${subjLetter}${lessonNum}`;
    process.stdout.write(`  [${lessonNum - 5}/5] generating ${id}… `);
    let activity = null;
    let attempt = 0;
    let lastErr = null;
    while (!activity && attempt < 3) {
      attempt++;
      try {
        const text = await callClaude(SYSTEM_PROMPT, buildUserPrompt(lessonNum, generated));
        const parsed = parseJson(text);
        const err = parsed ? validateActivity(parsed, subj) : 'JSON parse failed';
        if (err) {
          lastErr = err;
          process.stdout.write(`(retry: ${err}) `);
          continue;
        }
        activity = { id, ...parsed };
      } catch (e) {
        lastErr = e.message;
        process.stdout.write(`(retry: ${e.message}) `);
      }
    }
    if (!activity) die(`Lesson ${lessonNum} failed after 3 attempts. Last error: ${lastErr}`);
    generated.push(activity);
    console.log('✓');
  }
  // Write the draft. Format as a JS array literal so the operator can
  // copy/paste it straight into a WEEKS[2] = { sid: { subj: [...] } } block.
  const outFile = `/tmp/week2-${sid}-${subj}.js`;
  const banner = `// Solvix Week-2 draft — ${sid} × ${subj} (${grade})\n` +
                 `// Generated ${new Date().toISOString()} by tools/gen-week2.js\n` +
                 `// REVIEW BEFORE MERGING. Verify: passages match grade level,\n` +
                 `// MCQ answers are correct, questions reference the right passage,\n` +
                 `// and content is kid-safe. Then paste into WEEKS[2].${sid}.${subj}.\n\n`;
  const body = `[\n${generated.map(a => '  ' + JSON.stringify(a, null, 2).replace(/\n/g, '\n  ')).join(',\n')}\n]`;
  fs.writeFileSync(outFile, banner + body + '\n');
  console.log(`\n✓ Wrote 5 activities to ${outFile}`);
  console.log(`  Total chars: ${body.length}`);
  console.log(`\nReview, then paste into app/index.html under WEEKS[2].${sid}.${subj}.`);
})().catch(err => { console.error('\n✗', err); process.exit(1); });
