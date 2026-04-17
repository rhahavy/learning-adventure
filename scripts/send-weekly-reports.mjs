#!/usr/bin/env node
/**
 * send-weekly-reports.mjs — KidQuest automated weekly parent reports
 * -----------------------------------------------------------------
 * Runs from .github/workflows/weekly-reports.yml on a Sunday cron.
 *
 * Flow:
 *   1. GET the shared state blob from textdb.dev (same bucket the web app
 *      reads/writes).
 *   2. For each student: decide if they're due for a report, based on
 *      max(lastReportSentAt, joinedAt) + 7 days. Skip students who have
 *      never signed in, who don't have a parent email, or whose clock
 *      hasn't elapsed yet.
 *   3. Aggregate per-subject progress stats + a wrong-answer digest for the
 *      last 7 days, render an HTML + plaintext email, and POST to Resend.
 *   4. On a successful send, stamp user.lastReportSentAt with the send time.
 *      After the loop, POST the updated blob back to textdb.dev so the next
 *      run won't re-send.
 *
 * Env vars (see WEEKLY_REPORTS_SETUP.md for full docs):
 *   RESEND_API_KEY   — Resend API key. If absent, forces dry-run.
 *   FROM_EMAIL       — "Name <addr@verified-domain>" sender address.
 *   CC_EMAIL         — CC on every report (default: rhahavy.b@gmail.com).
 *   DASHBOARD_URL    — CTA link in the email (default: https://kidquest.fun).
 *   CLOUD_BUCKET     — textdb.dev bucket ID (default matches index.html).
 *   DRY_RUN          — "true" = log what would send, don't actually send.
 *                      Default: true on manual dispatch, false on schedule.
 *   MIN_ACTIVITIES   — skip students who completed fewer than this in the
 *                      report period. Default: 0 (always send if due).
 *   TEST_RECIPIENT   — if set, bypass all gates and send ONE sample email
 *                      (with demo data) to this address. Useful for smoke-
 *                      testing the Resend wiring before any student has
 *                      real 7-day history. Skips cloud write-back.
 *   TEST_FROM        — override From: specifically for test mode. If unset
 *                      and TEST_RECIPIENT is set, falls back to
 *                      "KidQuest Test <onboarding@resend.dev>" so the test
 *                      works before you've verified your own domain.
 *
 * This script is self-contained: no npm install, no package.json, no
 * external dependencies beyond Node 20's built-in fetch + standard lib.
 */

const REPORT_INTERVAL_DAYS = 7;
const REPORT_INTERVAL_MS   = REPORT_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
const DAY_MS               = 24 * 60 * 60 * 1000;

// Defaults — can be overridden via env.
const DEFAULT_BUCKET    = 'kidquest-dca83c70e20a70f247b6';
const DEFAULT_CC_EMAIL  = 'rhahavy.b@gmail.com';
const DEFAULT_FROM      = 'KidQuest Reports <reports@kidquest.fun>';
const DEFAULT_DASHBOARD = 'https://kidquest.fun';

// Student roster — mirror of STUDENTS in index.html. Only id + name + grade
// are used here (for the email greeting and subject). If you add a student
// to the web app, add them here too so their name renders correctly in the
// email header. If a student from the blob isn't in this list the script
// falls back to their raw id (still works, just less pretty).
const STUDENTS = [
  { id: 'isaiah',   name: 'Isaiah',   grade: 'Grade 5' },
  { id: 'akshayan', name: 'Akshayan', grade: 'Grade 3' },
  { id: 'axel',     name: 'Axel',     grade: 'Grade 3' },
  { id: 'rushan',   name: 'Rushan',   grade: 'Grade 2' },
  { id: 'akaran',   name: 'Akaran',   grade: 'Grade 1' },
  { id: 'nishan',   name: 'Nishan',   grade: 'Senior Kindergarten' },
];

// Activity ID pattern is `wN-<student>-<subjPrefix><n>` (e.g. w1-isaiah-m1).
// This maps prefix → subject metadata. Two-letter prefixes (sp) are checked
// before single-letter (s) so spelling doesn't get misclassified as science.
const SUBJECT_BY_PREFIX = {
  sp: { id: 'spelling', name: 'Spelling',       emoji: '🔤' },
  r:  { id: 'reading',  name: 'Reading',        emoji: '📖' },
  w:  { id: 'writing',  name: 'Writing',        emoji: '✏️' },
  m:  { id: 'math',     name: 'Math',           emoji: '🔢' },
  l:  { id: 'logic',    name: 'Logic',          emoji: '🧩' },
  f:  { id: 'french',   name: 'French',         emoji: '🇫🇷' },
  s:  { id: 'science',  name: 'Science',        emoji: '🔬' },
  c:  { id: 'social',   name: 'Social Studies', emoji: '🍁' },
};

const SUBJECT_ORDER = ['reading','writing','spelling','math','logic','french','science','social'];

// Reverse of SUBJECT_BY_PREFIX — look up the emoji/name from a subject id,
// which is what ends up stored in wrongAnswers[].subj. Lets the email render
// "🔢 Math" instead of a bare "math" token.
const SUBJECT_META_BY_ID = Object.fromEntries(
  Object.values(SUBJECT_BY_PREFIX).map(m => [m.id, m])
);
const subjectMeta = (id)=> SUBJECT_META_BY_ID[id] || { id, name: id, emoji: '📚' };

// ----- ID parsing -------------------------------------------------------

/** Returns the SUBJECT_BY_PREFIX entry for an activity id, or null. */
function subjectForActivity(aid){
  const m = /^w\d+-[a-z]+-([a-z]+)\d+$/.exec(aid);
  if(!m) return null;
  const tok = m[1];
  // Try longest-match first: 'sp' (spelling) before 's' (science).
  if(SUBJECT_BY_PREFIX[tok]) return SUBJECT_BY_PREFIX[tok];
  if(SUBJECT_BY_PREFIX[tok[0]]) return SUBJECT_BY_PREFIX[tok[0]];
  return null;
}

// ----- Cloud state ------------------------------------------------------

function cloudUrl(bucket){ return `https://textdb.dev/api/data/${bucket}`; }

async function fetchCloud(bucket){
  const url = cloudUrl(bucket) + '?_=' + Date.now();
  const r = await fetch(url, { cache: 'no-store' });
  if(!r.ok) throw new Error(`Cloud GET failed: ${r.status}`);
  const text = await r.text();
  try { return JSON.parse(text); }
  catch(e){ throw new Error('Cloud blob is not valid JSON: ' + e.message); }
}

async function postCloud(bucket, data){
  const r = await fetch(cloudUrl(bucket), {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(data),
  });
  if(!r.ok) throw new Error(`Cloud POST failed: ${r.status}`);
}

// ----- Stats ------------------------------------------------------------

/**
 * Aggregate a user's progress into per-subject buckets + overall totals.
 * Works off the blob alone — no WEEKS lookup needed because the activity
 * id prefix encodes the subject (see subjectForActivity).
 */
function computeStatsForUser(ud, sinceTs){
  const completed = ud.completedActivities || {};
  const perfect   = ud.perfectActivities   || {};
  const progress  = ud.progress            || {};

  // Per-subject counts. subjects is an object keyed by SUBJECT id.
  const subjects = {};
  const ensure = (meta) => {
    if(!subjects[meta.id]){
      subjects[meta.id] = {
        ...meta,
        completed: 0, perfect: 0, attempts: 0, correct: 0, scorable: 0,
        activities: [], // [{aid, done, perfect, attempts, best}]
      };
    }
    return subjects[meta.id];
  };

  // Build the full set of activity ids we know about (union of completed +
  // perfect + progress keys). Order is whatever Object.keys returns.
  const aidSet = new Set([
    ...Object.keys(completed),
    ...Object.keys(perfect),
    ...Object.keys(progress),
  ]);

  for(const aid of aidSet){
    const meta = subjectForActivity(aid);
    if(!meta) continue;
    const bucket = ensure(meta);
    const prog = progress[aid] || {};
    const isDone    = !!completed[aid];
    const isPerfect = !!perfect[aid];
    const attempts  = prog.attempts || 0;
    const best      = prog.best || 0;
    // Without the real question-count we can't compute accuracy exactly —
    // use best vs attempted-ratio as a rough proxy. Good enough for an
    // email summary where the numbers are illustrative, not authoritative.
    if(isDone)    bucket.completed++;
    if(isPerfect) bucket.perfect++;
    bucket.attempts += attempts;
    bucket.correct  += best;
    bucket.activities.push({ aid, done: isDone, perfect: isPerfect, attempts, best });
  }

  // Wrong-answer digest, filtered to the report window when we have `at`.
  const wrongs = Array.isArray(ud.wrongAnswers) ? ud.wrongAnswers : [];
  const recent = sinceTs
    ? wrongs.filter(w => (w.at || 0) >= sinceTs)
    : wrongs.slice(-10);
  const wrongBySubj = {};
  for(const w of recent){
    const sub = (w.subj && typeof w.subj === 'string') ? w.subj : 'other';
    (wrongBySubj[sub] = wrongBySubj[sub] || []).push(w);
  }

  // Overall rollup
  const totalCompleted = Object.values(subjects).reduce((a,s)=>a + s.completed, 0);
  const totalPerfect   = Object.values(subjects).reduce((a,s)=>a + s.perfect,   0);
  const totalAttempts  = Object.values(subjects).reduce((a,s)=>a + s.attempts,  0);

  return {
    subjects,
    totalCompleted, totalPerfect, totalAttempts,
    totalStars: ud.totalStars || 0,
    coins:      ud.coins      || 0,
    streak:     ud.streak     || 0,
    wrongBySubj,
    wrongCount: recent.length,
  };
}

// ----- Email rendering --------------------------------------------------

function escapeHtml(s){
  return String(s==null?'':s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

function formatDate(ts){
  try { return new Date(ts).toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' }); }
  catch(e){ return new Date(ts).toISOString().slice(0,10); }
}

// Trim long strings to keep the email readable. Works in characters not
// bytes — fine for English + French + emoji at this level.
function truncate(s, max){
  const str = String(s == null ? '' : s);
  if(str.length <= max) return str;
  return str.slice(0, max - 1).trimEnd() + '…';
}

// Max wrong-answer examples rendered per subject. More than this and the
// email becomes a wall of text — the "+N more" suffix carries the rest.
const MAX_WRONG_PER_SUBJECT = 3;

/**
 * Extract human-readable pieces from a single wrongAnswers[] entry.
 * Returns { question, chose, correct, when } — any field can be blank
 * if the log entry is missing that data (older sessions didn't record
 * all fields).
 */
function formatWrongEntry(w){
  const question = truncate(w.qText || '', 140);
  const choices  = Array.isArray(w.choices) ? w.choices : [];
  const choseIdx = (typeof w.choseIdx === 'number') ? w.choseIdx : -1;
  const corrIdx  = (typeof w.correctIdx === 'number') ? w.correctIdx : -1;
  const chose    = (choseIdx  >= 0 && choices[choseIdx] != null) ? truncate(String(choices[choseIdx]),  60) : '';
  const correct  = (corrIdx   >= 0 && choices[corrIdx]  != null) ? truncate(String(choices[corrIdx]),   60) : '';
  let when = '';
  if(w.at){
    const days = Math.floor((Date.now() - w.at) / (24*60*60*1000));
    if(days <= 0)      when = 'today';
    else if(days === 1) when = 'yesterday';
    else                when = `${days}d ago`;
  }
  return { question, chose, correct, when, qType: w.qType || 'mcq', aid: w.aid || '' };
}

/**
 * Build subject + HTML + plaintext for a student's weekly report.
 * `periodStartTs` is when the reporting window began (joinedAt for the
 * first report, lastReportSentAt thereafter).
 */
function buildReportEmail(student, stats, periodStartTs, dashboardUrl){
  const name  = student.name;
  const grade = student.grade;
  const today = formatDate(Date.now());
  const since = formatDate(periodStartTs);

  const subject = `KidQuest weekly report — ${name} (${formatDate(Date.now())})`;

  // Ordered subject rows, skipping subjects with no activity touched.
  const rows = SUBJECT_ORDER
    .map(id => stats.subjects[id])
    .filter(s => s && (s.completed > 0 || s.perfect > 0 || s.attempts > 0));

  // ----- Plain text (fallback / deliverability) -----
  const textLines = [];
  textLines.push(`KidQuest — Weekly Progress Report`);
  textLines.push(`Student: ${name} (${grade})`);
  textLines.push(`Report date: ${today}`);
  textLines.push(`Period since: ${since}`);
  textLines.push('');
  textLines.push(`Overall: ${stats.totalCompleted} activities completed · ${stats.totalPerfect} perfect · ${stats.totalStars} stars · ${stats.coins} coins · streak ${stats.streak}`);
  textLines.push('');
  if(rows.length){
    textLines.push('By subject:');
    for(const s of rows){
      textLines.push(`  ${s.emoji} ${s.name}: ${s.completed} completed, ${s.perfect} perfect (${s.attempts} total attempts)`);
    }
    textLines.push('');
  }
  if(stats.wrongCount > 0){
    textLines.push(`Concepts to practice this week (${stats.wrongCount} wrong-answer${stats.wrongCount===1?'':'s'} logged):`);
    textLines.push('');
    // Walk subjects in the global subject order so the email reads
    // consistently between sends. Unknown subjects fall to the end.
    const sortedSubs = Object.keys(stats.wrongBySubj).sort((a,b)=>{
      const ai = SUBJECT_ORDER.indexOf(a); const bi = SUBJECT_ORDER.indexOf(b);
      return (ai<0?99:ai) - (bi<0?99:bi);
    });
    for(const sub of sortedSubs){
      const arr  = stats.wrongBySubj[sub] || [];
      const meta = subjectMeta(sub);
      textLines.push(`  ${meta.emoji} ${meta.name} — ${arr.length} to review`);
      const shown = arr.slice(0, MAX_WRONG_PER_SUBJECT).map(formatWrongEntry);
      shown.forEach((e, i) => {
        const bullet = `    ${i+1}. `;
        if(e.question) textLines.push(`${bullet}Q: ${e.question}`);
        else           textLines.push(`${bullet}(question text unavailable)`);
        if(e.chose)    textLines.push(`       chose:   ${e.chose}`);
        if(e.correct)  textLines.push(`       correct: ${e.correct}`);
        if(e.when)     textLines.push(`       (${e.when})`);
      });
      const extra = arr.length - shown.length;
      if(extra > 0) textLines.push(`    …and ${extra} more in ${meta.name.toLowerCase()}`);
      textLines.push('');
    }
  } else {
    textLines.push('No wrong-answer entries logged this week — either a clean run or a quiet week.');
    textLines.push('');
  }
  textLines.push(`See the full dashboard at ${dashboardUrl}`);
  textLines.push('');
  textLines.push('— KidQuest');
  const text = textLines.join('\n');

  // ----- HTML -----
  const rowHtml = rows.map(s => `
    <tr>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;font-weight:600">${s.emoji} ${escapeHtml(s.name)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:right">${s.completed} done</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:right">${s.perfect} perfect</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:right;color:#666">${s.attempts} attempts</td>
    </tr>`).join('');

  // Wrong-answer section: per-subject cards, each listing up to
  // MAX_WRONG_PER_SUBJECT actual questions the student got wrong, with
  // their chosen answer and the correct one. Trimmed and escaped so a
  // weird question string can't break the email layout.
  let wrongHtml;
  if(stats.wrongCount > 0){
    const sortedSubs = Object.keys(stats.wrongBySubj).sort((a,b)=>{
      const ai = SUBJECT_ORDER.indexOf(a); const bi = SUBJECT_ORDER.indexOf(b);
      return (ai<0?99:ai) - (bi<0?99:bi);
    });
    const subSections = sortedSubs.map(sub => {
      const arr  = stats.wrongBySubj[sub] || [];
      const meta = subjectMeta(sub);
      const shown = arr.slice(0, MAX_WRONG_PER_SUBJECT).map(formatWrongEntry);
      const extra = arr.length - shown.length;
      const itemsHtml = shown.map(e => {
        // Each wrong answer renders as a small "card": question on top,
        // then a two-row mini-table of chose / correct. Empty fields are
        // omitted so older log entries without full data don't render as
        // blank rows.
        const chose   = e.chose   ? `<div style="display:flex;gap:8px;align-items:baseline;margin-top:4px">
          <span style="flex-shrink:0;min-width:62px;font-size:11px;font-weight:700;color:#d63031;letter-spacing:.04em;text-transform:uppercase">Chose</span>
          <span style="color:#333">${escapeHtml(e.chose)}</span>
        </div>` : '';
        const correct = e.correct ? `<div style="display:flex;gap:8px;align-items:baseline;margin-top:2px">
          <span style="flex-shrink:0;min-width:62px;font-size:11px;font-weight:700;color:#00b894;letter-spacing:.04em;text-transform:uppercase">Correct</span>
          <span style="color:#333;font-weight:600">${escapeHtml(e.correct)}</span>
        </div>` : '';
        const when = e.when ? `<div style="font-size:11px;color:#999;margin-top:4px">${escapeHtml(e.when)}</div>` : '';
        return `
          <div style="border-left:3px solid rgba(108,92,231,.3);padding:8px 0 8px 12px;margin-top:10px">
            <div style="font-size:13px;color:#1a1035;font-weight:600;line-height:1.45">${escapeHtml(e.question) || '<span style="color:#999;font-style:italic">question text unavailable</span>'}</div>
            ${chose}${correct}${when}
          </div>`;
      }).join('');
      const extraHtml = extra > 0
        ? `<div style="margin-top:10px;font-size:12px;color:#666;font-style:italic">…and ${extra} more in ${escapeHtml(meta.name.toLowerCase())}</div>`
        : '';
      return `
        <div style="background:rgba(108,92,231,.04);border:1px solid rgba(108,92,231,.12);border-radius:12px;padding:12px 14px;margin-bottom:12px">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
            <div style="font-weight:800;font-size:14px">${meta.emoji} ${escapeHtml(meta.name)}</div>
            <div style="font-size:11.5px;color:#6c5ce7;font-weight:700;background:rgba(108,92,231,.1);padding:3px 9px;border-radius:999px">${arr.length} to review</div>
          </div>
          ${itemsHtml}${extraHtml}
        </div>`;
    }).join('');
    wrongHtml = `
      <p style="margin:20px 0 10px;font-weight:700;font-size:14px">Concepts to practice this week</p>
      <p style="margin:0 0 12px;font-size:12px;color:#666;line-height:1.5">Here are the exact questions ${escapeHtml(name)} missed. Revisiting them together is the single highest-leverage thing you can do between sessions.</p>
      ${subSections}`;
  } else {
    wrongHtml = `<p style="margin:18px 0;font-size:13.5px;color:#666;font-style:italic">No wrong-answer entries logged this week — either a clean run or a quiet one.</p>`;
  }

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f6f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1035">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px">
    <div style="background:#fff;border-radius:16px;padding:24px 22px;box-shadow:0 4px 16px rgba(26,16,53,.08)">
      <div style="font-size:12px;font-weight:700;color:#6c5ce7;letter-spacing:.08em;text-transform:uppercase">KidQuest · Weekly Report</div>
      <h1 style="margin:6px 0 2px;font-size:24px;font-weight:800">${escapeHtml(name)}</h1>
      <div style="font-size:13.5px;color:#666;margin-bottom:18px">${escapeHtml(grade)} · ${today}</div>

      <div style="background:linear-gradient(135deg,#eef1ff,#f7e8ff);border-radius:12px;padding:14px 16px;margin-bottom:20px">
        <div style="font-size:12px;font-weight:700;color:#6c5ce7;letter-spacing:.05em;text-transform:uppercase;margin-bottom:4px">Overall since ${since}</div>
        <div style="font-size:15px;font-weight:700">
          ${stats.totalCompleted} activities · ${stats.totalPerfect} perfect · ${stats.totalStars} ⭐ · ${stats.coins} 💰 · streak ${stats.streak} 🔥
        </div>
      </div>

      ${rows.length ? `
        <p style="margin:0 0 8px;font-weight:700;font-size:14px">By subject</p>
        <table style="width:100%;border-collapse:collapse;font-size:13.5px">
          <tbody>${rowHtml}</tbody>
        </table>
      ` : `
        <p style="color:#666;font-style:italic;font-size:13.5px">No subject activity tracked in this window yet.</p>
      `}

      ${wrongHtml}

      <div style="margin-top:24px;text-align:center">
        <a href="${escapeHtml(dashboardUrl)}" style="display:inline-block;background:#6c5ce7;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:999px">
          Open the dashboard →
        </a>
      </div>

      <p style="margin-top:22px;font-size:11.5px;color:#999;text-align:center;line-height:1.5">
        You're receiving this because KidQuest is set to send weekly reports for ${escapeHtml(name)}.<br>
        This message was generated automatically. Reply to this email to reach the tutor directly.
      </p>
    </div>
  </div>
</body></html>`;

  return { subject, text, html };
}

// ----- Resend ----------------------------------------------------------

async function sendViaResend({ apiKey, from, to, cc, subject, html, text }){
  const body = {
    from,
    to: [to],
    subject,
    html,
    text,
  };
  if(cc) body.cc = [cc];
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if(!r.ok){
    const detail = await r.text().catch(()=>'<no body>');
    throw new Error(`Resend ${r.status}: ${detail}`);
  }
  return await r.json().catch(()=>({}));
}

// ----- Main orchestration ----------------------------------------------

function parseBoolEnv(name, def){
  const v = (process.env[name] || '').toLowerCase().trim();
  if(v === 'true')  return true;
  if(v === 'false') return false;
  return def;
}

function log(...args){ console.log('[weekly-reports]', ...args); }
function warn(...args){ console.warn('[weekly-reports]', ...args); }

async function main(){
  const apiKey       = process.env.RESEND_API_KEY || '';
  const fromEmail    = process.env.FROM_EMAIL     || DEFAULT_FROM;
  const ccEmail      = process.env.CC_EMAIL       || DEFAULT_CC_EMAIL;
  const dashboardUrl = process.env.DASHBOARD_URL  || DEFAULT_DASHBOARD;
  const bucket       = process.env.CLOUD_BUCKET   || DEFAULT_BUCKET;
  const minActs      = parseInt(process.env.MIN_ACTIVITIES || '0', 10);
  const testRecipient= (process.env.TEST_RECIPIENT || '').trim();
  const testFrom     = (process.env.TEST_FROM || '').trim()
                      || 'KidQuest Test <onboarding@resend.dev>';

  // Dry-run is forced when we lack an API key (can't actually send). Explicit
  // DRY_RUN=true also forces it. Otherwise default is false (cron sends).
  const dryRunEnv = parseBoolEnv('DRY_RUN', false);
  const dryRun = dryRunEnv || !apiKey;
  if(dryRun && !apiKey){
    log('No RESEND_API_KEY in env — forcing dry-run.');
  } else if(dryRun){
    log('DRY_RUN=true — will log what would send but not actually send.');
  }

  // ----- TEST MODE --------------------------------------------------------
  // Short-circuit: if TEST_RECIPIENT is set, build one demo email with fake
  // stats and send it to that address. Skip the cloud write-back entirely so
  // this can't corrupt the production lastReportSentAt stamps.
  if(testRecipient){
    log(`TEST MODE — sending ONE sample email to ${testRecipient}`);
    log(`  FROM: ${testFrom}  (override with TEST_FROM)`);
    const fakeStudent = { id: 'test-student', name: 'Demo Student', grade: 'Demo Grade' };
    // Realistic demo data — mirrors the shape of a real wrongAnswers[]
    // entry so the new per-question render path gets exercised.
    const _dayAgo = (d)=> Date.now() - d * DAY_MS;
    const fakeStats = {
      subjects: {
        reading: { id:'reading', name:'Reading',  emoji:'📖', completed:3, perfect:2, attempts:14, correct:12, scorable:3, activities:[] },
        math:    { id:'math',    name:'Math',     emoji:'🔢', completed:5, perfect:3, attempts:28, correct:24, scorable:5, activities:[] },
        spelling:{ id:'spelling',name:'Spelling', emoji:'🔤', completed:2, perfect:2, attempts:10, correct:10, scorable:2, activities:[] },
      },
      totalCompleted: 10, totalPerfect: 7, totalAttempts: 52,
      totalStars: 42, coins: 120, streak: 5,
      wrongBySubj: {
        math: [
          { aid:'w1-isaiah-m1', subj:'math', qType:'mcq', qText:'56 + 27 = ?',
            choices:['73','82','83','93'], choseIdx:1, correctIdx:2, at:_dayAgo(2) },
          { aid:'w1-isaiah-m1', subj:'math', qType:'mcq', qText:'When you add 38 + 45, the ones are 8 + 5 = 13. What do you do?',
            choices:['Write 13 in the ones','Write 3, carry 1 to the tens','Carry 3','Start over'],
            choseIdx:0, correctIdx:1, at:_dayAgo(3) },
          { aid:'w1-isaiah-m2', subj:'math', qType:'mcq', qText:'5 × 6 = ?',
            choices:['11','25','30','35'], choseIdx:3, correctIdx:2, at:_dayAgo(5) },
          { aid:'w1-isaiah-m2', subj:'math', qType:'mcq', qText:'10 × 7 = ?',
            choices:['17','70','77','107'], choseIdx:2, correctIdx:1, at:_dayAgo(6) },
        ],
        reading: [
          { aid:'w1-isaiah-r1', subj:'reading', qType:'mcq', qText:'What is the MAIN idea of the story?',
            choices:['The dog ran fast','Friendship takes work','It rained a lot','The park was empty'],
            choseIdx:0, correctIdx:1, at:_dayAgo(1) },
        ],
      },
      wrongCount: 5,
    };
    const periodStart = Date.now() - REPORT_INTERVAL_MS;
    const email = buildReportEmail(fakeStudent, fakeStats, periodStart, dashboardUrl);
    if(dryRun){
      log(`(dry-run) would send test email. Subject: ${email.subject}`);
      log(`(dry-run) text preview:\n  ${email.text.split('\n').slice(0,10).join('\n  ')}\n  ...`);
      return;
    }
    await sendViaResend({
      apiKey,
      from: testFrom,
      to: testRecipient,
      cc: ccEmail,
      subject: `[TEST] ${email.subject}`,
      html: email.html,
      text: email.text,
    });
    log(`✓ Test email sent to ${testRecipient}`);
    log('(test mode skips cloud write-back — no lastReportSentAt stamp)');
    return;
  }

  log(`Fetching cloud state: ${cloudUrl(bucket)}`);
  const blob = await fetchCloud(bucket);
  if(!blob || !blob.users) throw new Error('Blob is missing .users');

  const now = Date.now();
  const studentById = Object.fromEntries(STUDENTS.map(s => [s.id, s]));

  // Select students who are due for a report right now.
  const targets = [];
  for(const [sid, ud] of Object.entries(blob.users)){
    if(!ud) continue;
    const email = (ud.parentEmail || '').trim();
    if(!email){
      log(`skip ${sid}: no parentEmail`);
      continue;
    }
    if(!ud.joinedAt){
      log(`skip ${sid}: joinedAt not set (student has never logged in)`);
      continue;
    }
    const anchor = Math.max(ud.lastReportSentAt || 0, ud.joinedAt);
    const daysElapsed = Math.floor((now - anchor) / DAY_MS);
    if(daysElapsed < REPORT_INTERVAL_DAYS){
      log(`skip ${sid}: only ${daysElapsed}d since last anchor (need ≥ ${REPORT_INTERVAL_DAYS})`);
      continue;
    }
    // Activity-level gate: optional "did they do enough this week to justify
    // sending?" check. Defaults off (minActs=0). When set, we count
    // activities completed since the last anchor using completedActivities
    // keys (no per-activity timestamp, so this is a weak heuristic —
    // relies on the report window covering the last 7 days of usage).
    const stats = computeStatsForUser(ud, anchor);
    if(minActs > 0 && stats.totalCompleted < minActs){
      log(`skip ${sid}: only ${stats.totalCompleted} activities (< MIN_ACTIVITIES=${minActs})`);
      continue;
    }
    targets.push({ sid, ud, email, anchor, stats });
  }

  if(!targets.length){
    log('Nothing to send this run.');
    return;
  }

  log(`Will process ${targets.length} student(s): ${targets.map(t=>t.sid).join(', ')}`);

  // Process targets. Stamp lastReportSentAt into a side-dict so we only
  // write back once at the end (and only the successes).
  const stamps = {};
  for(const t of targets){
    const student = studentById[t.sid] || { id: t.sid, name: t.sid, grade: '' };
    const email = buildReportEmail(student, t.stats, t.anchor, dashboardUrl);
    log(`${t.sid}: ${email.subject}  →  ${t.email}`);
    if(dryRun){
      // Print a short preview so we can eyeball the content in action logs.
      const preview = email.text.split('\n').slice(0, 8).join('\n  ');
      log(`  (dry-run) preview:\n  ${preview}\n  ...`);
      continue;
    }
    try {
      await sendViaResend({
        apiKey, from: fromEmail, to: t.email, cc: ccEmail,
        subject: email.subject, html: email.html, text: email.text,
      });
      stamps[t.sid] = Date.now();
      log(`  ✓ sent`);
    } catch(e){
      warn(`  ✗ send failed for ${t.sid}: ${e.message}`);
      // Keep going — one parent's bad address shouldn't block the rest.
    }
  }

  if(!Object.keys(stamps).length){
    log('No successful sends — skipping cloud write-back.');
    return;
  }

  // Re-fetch the blob just before writing to catch any concurrent browser
  // updates (teacher might have edited a parentEmail while we were sending).
  // Only the lastReportSentAt stamps need to land; merge them onto fresh
  // state so we don't clobber other fields.
  log('Merging stamps into fresh cloud state and writing back...');
  const fresh = await fetchCloud(bucket);
  if(!fresh || !fresh.users){
    warn('Fresh blob is invalid — skipping write-back to avoid corruption.');
    return;
  }
  for(const [sid, ts] of Object.entries(stamps)){
    if(!fresh.users[sid]) fresh.users[sid] = { ...(blob.users[sid] || {}) };
    fresh.users[sid].lastReportSentAt = ts;
  }
  fresh.updatedAt = Date.now();
  await postCloud(bucket, fresh);
  log(`✓ Cloud updated with ${Object.keys(stamps).length} new lastReportSentAt stamp(s).`);
}

main().catch(err => {
  console.error('[weekly-reports] FATAL:', err);
  process.exit(1);
});
