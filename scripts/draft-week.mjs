#!/usr/bin/env node
/**
 * draft-week.mjs — build a "please draft next week's activities" prompt
 * --------------------------------------------------------------------
 * Tutor-facing helper for the weekly content routine. Reads the current
 * cloud state for a student, summarizes their progress + what they got
 * wrong, and prints a complete prompt you can paste into Claude (in the
 * Claude Code CLI, claude.ai, or the API) to get a first-draft WEEKS[N]
 * entry for that student.
 *
 * This script does NOT call any LLM — it just assembles the prompt. That
 * way you don't need an API key, and you stay in the review loop: Claude
 * drafts, you review + paste into index.html.
 *
 * Usage:
 *   node scripts/draft-week.mjs --student isaiah --week 2
 *   node scripts/draft-week.mjs --student akshayan --week 3 --grade "Grade 3"
 *   node scripts/draft-week.mjs --student isaiah --week 2 > /tmp/prompt.txt
 *
 * Flags:
 *   --student <id>   Required. One of: isaiah, akshayan, axel, rushan,
 *                    akaran, nishan. (If you add a new student to
 *                    index.html, add them to STUDENTS here too.)
 *   --week <N>       Required. Week number to author (e.g. 2, 3).
 *   --grade <name>   Optional override. Defaults to the grade in STUDENTS.
 *   --bucket <id>    Optional textdb.dev bucket override. Defaults to
 *                    the same one the web app + weekly-reports use.
 *   --no-cloud       Skip the cloud fetch — useful if you want a prompt
 *                    for a brand-new student with no history yet.
 *
 * Output: a big prompt on stdout. Copy it into Claude. Review + tweak
 * the draft Claude gives you, then paste into index.html under
 * WEEKS[<N>] = { ... }.
 */

// --- Student roster — mirror of STUDENTS in index.html. -------------------
const STUDENTS = [
  { id: 'isaiah',   name: 'Isaiah',   grade: 'Grade 5' },
  { id: 'akshayan', name: 'Akshayan', grade: 'Grade 3' },
  { id: 'axel',     name: 'Axel',     grade: 'Grade 3' },
  { id: 'rushan',   name: 'Rushan',   grade: 'Grade 2' },
  { id: 'akaran',   name: 'Akaran',   grade: 'Grade 1' },
  { id: 'nishan',   name: 'Nishan',   grade: 'Senior Kindergarten' },
];

const DEFAULT_BUCKET = 'kidquest-dca83c70e20a70f247b6';

// Subjects we author per week, in the order they should appear in WEEKS[N].
// Matches SUBJECTS in index.html so the draft slots cleanly into the file.
const SUBJECTS = [
  { id: 'reading',  name: 'Reading',        emoji: '📖', prefix: 'r'  },
  { id: 'writing',  name: 'Writing',        emoji: '✏️', prefix: 'w'  },
  { id: 'spelling', name: 'Spelling',       emoji: '🔤', prefix: 'sp' },
  { id: 'math',     name: 'Math',           emoji: '🔢', prefix: 'm'  },
  { id: 'logic',    name: 'Logic',          emoji: '🧩', prefix: 'l'  },
  { id: 'french',   name: 'French',         emoji: '🇫🇷', prefix: 'f'  },
  { id: 'science',  name: 'Science',        emoji: '🔬', prefix: 's'  },
  { id: 'social',   name: 'Social Studies', emoji: '🍁', prefix: 'c'  },
];

// ----- Arg parsing ------------------------------------------------------

function parseArgs(argv){
  const args = {};
  for(let i = 0; i < argv.length; i++){
    const a = argv[i];
    if(a.startsWith('--')){
      const key = a.slice(2);
      const next = argv[i+1];
      if(next && !next.startsWith('--')){ args[key] = next; i++; }
      else                               { args[key] = true; }
    }
  }
  return args;
}

function fail(msg){
  console.error('[draft-week] ' + msg);
  console.error('Usage: node scripts/draft-week.mjs --student <id> --week <N> [--grade "<name>"] [--bucket <id>] [--no-cloud]');
  process.exit(1);
}

// ----- Cloud fetch ------------------------------------------------------

async function fetchCloud(bucket){
  const url = `https://textdb.dev/api/data/${bucket}?_=${Date.now()}`;
  const r = await fetch(url, { cache: 'no-store' });
  if(!r.ok) throw new Error(`Cloud GET failed: ${r.status}`);
  const text = await r.text();
  try { return JSON.parse(text); }
  catch(e){ throw new Error('Cloud blob is not valid JSON: ' + e.message); }
}

// ----- Student history aggregation --------------------------------------

// Activity id pattern: w<N>-<studentId>-<subjPrefix><n>. Two-letter prefix
// (sp) checked first so spelling isn't misclassified as science.
function subjectForActivity(aid){
  const m = /^w\d+-[a-z]+-([a-z]+)\d+$/.exec(aid);
  if(!m) return null;
  const tok = m[1];
  for(const s of SUBJECTS){
    if(s.prefix === tok) return s;
  }
  for(const s of SUBJECTS){
    if(s.prefix === tok[0]) return s;
  }
  return null;
}

/**
 * Summarize a student's progress into bullets the prompt can hand to Claude:
 *   - which subjects they've touched
 *   - which lessons they aced (perfect on first try)
 *   - which lessons they struggled on (multiple attempts or <100% best)
 *   - which concepts they've been getting wrong lately
 */
function summarizeStudent(ud){
  const out = {
    subjectsTouched: [],       // [{id, name, emoji, done, perfect, attempts}]
    perfectedFirstTry: [],     // [aid]
    struggled: [],             // [{aid, attempts, bestPct}]
    recentWrongLessons: [],    // [{title, subject, count}] — last 14 days
  };
  if(!ud) return out;

  const completed = ud.completedActivities || {};
  const perfect   = ud.perfectActivities   || {};
  const progress  = ud.progress            || {};

  const subjectBuckets = {};
  const ensure = meta => {
    if(!subjectBuckets[meta.id]){
      subjectBuckets[meta.id] = { ...meta, done:0, perfect:0, attempts:0 };
    }
    return subjectBuckets[meta.id];
  };

  const aidSet = new Set([
    ...Object.keys(completed), ...Object.keys(perfect), ...Object.keys(progress)
  ]);
  for(const aid of aidSet){
    const meta = subjectForActivity(aid);
    if(!meta) continue;
    const b = ensure(meta);
    const p = progress[aid] || {};
    if(completed[aid]) b.done++;
    if(perfect[aid])   b.perfect++;
    b.attempts += (p.attempts || 0);
    if(p.firstTryPerfect){
      out.perfectedFirstTry.push(aid);
    } else if((p.attempts || 0) >= 2 || (!perfect[aid] && completed[aid])){
      const bestPct = (p.scorable && p.best) ? Math.round((p.best/p.scorable)*100) : null;
      out.struggled.push({ aid, attempts: p.attempts||0, bestPct });
    }
  }
  out.subjectsTouched = Object.values(subjectBuckets);

  // Recent wrong-answer concepts — dedupe by lessonTitle. lessonTitle was
  // added in a newer build; fall back to the aid stem if it's missing.
  const wrongs = Array.isArray(ud.wrongAnswers) ? ud.wrongAnswers : [];
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const recentBucket = new Map();
  for(const w of wrongs){
    if((w.at || 0) < cutoff) continue;
    const title = (w.lessonTitle && String(w.lessonTitle).trim()) || w.aid || 'Earlier practice';
    const subMeta = subjectForActivity(w.aid || '') || { name: w.subj || 'other' };
    const key = subMeta.name + '::' + title;
    const prev = recentBucket.get(key);
    if(prev) prev.count++;
    else     recentBucket.set(key, { title, subject: subMeta.name, count: 1 });
  }
  out.recentWrongLessons = [...recentBucket.values()].sort((a,b)=>b.count - a.count);

  return out;
}

// ----- Prompt assembly --------------------------------------------------

function bulletList(arr){
  if(!arr || !arr.length) return '  (none yet)';
  return arr.map(s => '  - ' + s).join('\n');
}

function buildPrompt({ student, weekN, summary }){
  const { name, grade, id: sid } = student;
  const subjectsTouchedLine = summary.subjectsTouched.length
    ? summary.subjectsTouched
        .map(s => `${s.emoji} ${s.name} (${s.done} done, ${s.perfect} perfect, ${s.attempts} attempts)`)
        .join('; ')
    : '(no activity yet — this is their first week)';

  const strengths = summary.perfectedFirstTry.length
    ? summary.perfectedFirstTry.slice(0, 12)
    : ['(none yet — first-try-perfect tracking kicks in from the first activity)'];

  const struggles = summary.struggled.length
    ? summary.struggled.slice(0, 10).map(x => {
        const pct = (x.bestPct != null) ? ` — best ${x.bestPct}%` : '';
        return `${x.aid} (${x.attempts} attempts${pct})`;
      })
    : ['(no struggle signals yet)'];

  const recentWrong = summary.recentWrongLessons.length
    ? summary.recentWrongLessons.slice(0, 12).map(l =>
        `${l.subject}: ${l.title} — missed ${l.count} question${l.count===1?'':'s'}`)
    : ['(no wrong-answers logged recently)'];

  // Activity id pattern to emit
  const idExamples = SUBJECTS
    .map(s => `w${weekN}-${sid}-${s.prefix}1 … w${weekN}-${sid}-${s.prefix}5`)
    .join('\n  ');

  return `You are helping the tutor (Rhahavy) author Week ${weekN} content for a KidQuest student.

STUDENT
  Name: ${name}
  Grade: ${grade}
  Internal id: ${sid}

HOW THEY'RE DOING (from the live cloud state)
  Subjects touched so far: ${subjectsTouchedLine}

  Aced (first-try-perfect) — keep the difficulty climbing on these concepts:
${bulletList(strengths)}

  Struggled (multiple attempts or <100% best) — re-teach the concept in Week ${weekN} with a fresh angle, not the same questions:
${bulletList(struggles)}

  Recent wrong-answer concepts (last 14 days) — top priority for Week ${weekN} review:
${bulletList(recentWrong)}

WHAT TO PRODUCE
Draft a complete WEEKS[${weekN}].${sid} entry in the EXACT shape used by WEEKS[1].${sid} in index.html.

Ship 5 activities per subject for ALL ${SUBJECTS.length} subjects: reading, writing, spelling, math, logic, french, science, social.

Activity id pattern (use exactly these formats, incrementing 1→5 in each):
  ${idExamples}

Each activity is an object with:
  { id, title, emoji, videoIds?: ['youtubeId', ...],
    lesson: { title, intro, example, hint },
    questions: [ ... 5 questions ... ],
    stretchQuestions?: [ ... optional 5-7 harder questions unlocked on a
                         first-try-perfect replay ... ]
  }

Question types to use (same ones the index.html renderer understands):
  - {type:'mcq',      q, choices:[...], answer: <index>}
  - {type:'passage',  passage, q, choices:[...], answer: <index>}
  - {type:'compare',  q, a, b, answer:'a'|'b'}
  - {type:'typing',   q, answer:'literal string'}

For MATH specifically, if the lesson covers multi-digit arithmetic, add
a \`stack:\` field on the lesson object instead of a flat example string:
  lesson: { title, intro, stack: {op:'+',top:'28',bottom:'17',carries:[1,''],answer:'45',note:'...'}, hint }
The renderer already supports this (see buildMathStack in index.html).

DESIGN RULES
  1. Level 1 should feel like a continuation of where ${name} is now — not
     a jarring jump. Scaffold up through Level 5.
  2. Re-teach the recent-wrong concepts at Level 1 or 2 of the relevant
     subject, with DIFFERENT questions than Week ${weekN-1}. Same concept,
     fresh framing (different numbers, different reading passages, etc.).
  3. Build on the first-try-perfect strengths — those kids are ready for
     harder variants or extensions of the same concept.
  4. Age-appropriate: this is ${grade}. No vocabulary or math beyond that
     level. If in doubt, keep it simpler — stretch questions exist for
     the kids who want more.
  5. French: brand-new vocabulary each week, but reuse prior weeks'
     patterns (greetings, colors, numbers) so they stick.
  6. Science + Social: pick themes that tie to things a ${grade} student
     would be curious about. One theme per subject for the whole week.

OUTPUT FORMAT
Return a single JavaScript object literal that can be dropped directly
into index.html as:
  WEEKS[${weekN}].${sid} = { reading:[...], writing:[...], ... };

Use double-quoted strings unless there's an apostrophe inside, then use
single-quoted with the apostrophe escaped. Keep each activity to ~5-8
lines when possible (the existing WEEKS[1] lessons are a good density
reference — don't bloat).

Start your answer with the object literal — no preamble. The tutor will
review, tweak, and paste.`;
}

// ----- Main -------------------------------------------------------------

async function main(){
  const args = parseArgs(process.argv.slice(2));

  const sid    = args.student;
  const weekN  = parseInt(args.week, 10);
  const bucket = args.bucket || DEFAULT_BUCKET;
  const noCloud= !!args['no-cloud'];

  if(!sid)        fail('Missing --student <id>.');
  if(!weekN || weekN < 2) fail('Missing --week <N>. Must be 2 or higher (Week 1 already exists).');

  const student = STUDENTS.find(s => s.id === sid);
  if(!student) fail(`Unknown student "${sid}". Known: ${STUDENTS.map(s=>s.id).join(', ')}`);
  if(args.grade) student.grade = args.grade;

  let ud = null;
  if(!noCloud){
    try {
      console.error(`[draft-week] Fetching cloud state for ${sid}…`);
      const blob = await fetchCloud(bucket);
      ud = (blob && blob.users && blob.users[sid]) || null;
      if(!ud){
        console.error(`[draft-week] No cloud record for ${sid} yet — treating as brand-new student.`);
      }
    } catch(e){
      console.error(`[draft-week] Cloud fetch failed (${e.message}). Proceeding without history.`);
    }
  }

  const summary = summarizeStudent(ud);
  const prompt  = buildPrompt({ student, weekN, summary });

  // stdout = prompt (for copy-paste or redirect); stderr = logs.
  process.stdout.write(prompt + '\n');
  console.error('[draft-week] Prompt ready. Pipe into a file with `> /tmp/prompt.txt` or pipe directly into Claude CLI.');
}

main().catch(err => { console.error('[draft-week] ERROR:', err.stack || err.message); process.exit(1); });
