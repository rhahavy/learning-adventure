#!/usr/bin/env node
/**
 * who-is-due.mjs — a 30-second "who needs new content this week?" snapshot
 * -----------------------------------------------------------------------
 * The Saturday ritual (see WEEKLY_CONTENT_ROUTINE.md) asks: whose week
 * clock is about to roll over? This script prints a 5-column table so
 * you can glance and decide at the kitchen table.
 *
 * Columns:
 *   STUDENT     — display name
 *   WEEK        — their CAPPED week (what the app shows them, accounting
 *                 for MAX_AUTHORED_WEEK). Same number shows in both the
 *                 dashboard and the weekly-reports email.
 *   ROLLOVER    — days until their next week boundary. 7 means they just
 *                 started this week, 0 means today. Negative numbers can
 *                 appear if they're "ahead of the curriculum" (the app
 *                 caps them, but the raw clock keeps going).
 *   WRONG       — how many entries live in their wrongAnswers log (0-200).
 *                 High numbers mean the draft prompt will have rich
 *                 struggle-data to key off.
 *   STATUS      — 🟢 current, 🟡 rolls over within 2 days, 🔴 OVERDUE.
 *
 * Example:
 *
 *   STUDENT      WEEK  ROLLOVER  WRONG   STATUS
 *   Isaiah       1     0 days    42      🔴 OVERDUE — ship Week 2
 *   Akshayan     1     2 days    18      🟡 rolls over soon
 *   Akaran       1     5 days    31      🟢 current
 *   Nishan       1     6 days    8       🟢 current
 *   Rushan       1     4 days    12      🟢 current
 *   Evan         1     7 days    0       🟢 current (brand new)
 *
 * Usage:
 *   node scripts/who-is-due.mjs
 *   node scripts/who-is-due.mjs --bucket <override>
 *   node scripts/who-is-due.mjs --max-week 2   # override what's "authored"
 *
 * Flags:
 *   --bucket <id>   Override the textdb bucket (defaults to the prod one).
 *   --max-week <N>  Override the highest authored week number. Defaults to
 *                   1 because that's what ships today. Set this to match
 *                   whatever WEEKS[] keys exist in your live index.html.
 *   --json          Dump the raw rows as JSON (for piping into other
 *                   tools). The default is a human-readable table.
 *
 * Exit codes:
 *   0 — nothing overdue
 *   2 — at least one student is overdue (so the script can gate a cron)
 */

// Student roster — keep in sync with STUDENTS in index.html + draft-week.mjs.
const STUDENTS = [
  { id: 'isaiah',   name: 'Isaiah'   },
  { id: 'akshayan', name: 'Akshayan' },
  { id: 'axel',     name: 'Axel'     },
  { id: 'rushan',   name: 'Rushan'   },
  { id: 'akaran',   name: 'Akaran'   },
  { id: 'nishan',   name: 'Nishan'   },
  { id: 'evan',     name: 'Evan'     },
];

const DEFAULT_BUCKET = 'kidquest-dca83c70e20a70f247b6';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function parseArgs(argv){
  const args = {};
  for(let i = 2; i < argv.length; i++){
    const a = argv[i];
    if(a === '--bucket')       args.bucket   = argv[++i];
    else if(a === '--max-week')args.maxWeek  = parseInt(argv[++i], 10);
    else if(a === '--json')    args.json     = true;
    else if(a === '--help' || a === '-h') args.help = true;
    else if(!a.startsWith('--')) {
      // silently ignore — keeps forward compat
    }
  }
  return args;
}

function printHelp(){
  // Inline help — just re-show the header comment top of file for convenience.
  console.log([
    'who-is-due.mjs — which students are about to roll into a new week?',
    '',
    'Usage: node scripts/who-is-due.mjs [--bucket <id>] [--max-week <N>] [--json]',
    '',
    'Flags:',
    '  --bucket <id>    Override textdb bucket (default: prod).',
    '  --max-week <N>   Highest authored week number (default: 1).',
    '  --json           Emit JSON instead of the human table.',
    '',
    'Exit code 2 when at least one student is overdue.',
  ].join('\n'));
}

async function fetchCloud(bucket){
  const url = 'https://textdb.dev/api/data/' + bucket + '?_=' + Date.now();
  const res = await fetch(url, { cache: 'no-store' });
  if(!res.ok) throw new Error('Cloud fetch failed: HTTP '+res.status);
  const t = await res.text();
  if(!t) throw new Error('Cloud blob is empty');
  let d;
  try { d = JSON.parse(t); }
  catch(e){ throw new Error('Cloud blob is not JSON: '+e.message); }
  if(!d || typeof d !== 'object' || !d.users) throw new Error('Cloud blob has no users{}');
  return d;
}

// Mirror of computeWeekForUser in index.html, for a single student's raw
// + capped week count.
function computeWeek(joinedAtMs, maxAuthoredWeek){
  if(!joinedAtMs) return { raw: 1, capped: 1, daysToRollover: 7 };
  const now = Date.now();
  const elapsed = Math.max(0, now - joinedAtMs);
  const rawWeek = Math.floor(elapsed / WEEK_MS) + 1;
  const capped = Math.min(rawWeek, maxAuthoredWeek);
  // Days until the NEXT week boundary (regardless of cap).
  const msIntoWeek = elapsed % WEEK_MS;
  const msToNext = WEEK_MS - msIntoWeek;
  const daysToRollover = Math.ceil(msToNext / (24*60*60*1000));
  return { raw: rawWeek, capped, daysToRollover };
}

function statusFor(row, maxAuthoredWeek){
  if(row.rawWeek > maxAuthoredWeek) {
    return { emoji: '🔴', label: 'OVERDUE — ship Week '+(maxAuthoredWeek+1), overdue: true };
  }
  if(row.daysToRollover <= 2 && row.rawWeek === maxAuthoredWeek){
    return { emoji: '🟡', label: 'rolls over soon', overdue: false };
  }
  if(row.wrongCount === 0 && row.daysToRollover >= 6){
    return { emoji: '🟢', label: 'current (brand new)', overdue: false };
  }
  return { emoji: '🟢', label: 'current', overdue: false };
}

function padRight(s, width){ s = String(s); return s + ' '.repeat(Math.max(0, width - s.length)); }

function renderTable(rows){
  const headers = ['STUDENT','WEEK','ROLLOVER','WRONG','STATUS'];
  const widths = [12, 4, 10, 6, 40];
  // Widen student/status columns to the widest row value
  rows.forEach(r=>{
    widths[0] = Math.max(widths[0], r.name.length);
    widths[4] = Math.max(widths[4], r.status.label.length + 4);
  });
  const line = cols => cols.map((c,i)=>padRight(c, widths[i])).join('  ');
  console.log(line(headers));
  console.log(line(widths.map(w=>'-'.repeat(w))));
  rows.forEach(r=>{
    console.log(line([
      r.name,
      String(r.displayWeek),
      r.daysToRollover + ' day' + (r.daysToRollover===1?'':'s'),
      String(r.wrongCount),
      r.status.emoji + ' ' + r.status.label,
    ]));
  });
}

async function main(){
  const args = parseArgs(process.argv);
  if(args.help){ printHelp(); process.exit(0); }
  const bucket = args.bucket || DEFAULT_BUCKET;
  const maxAuthoredWeek = Number.isFinite(args.maxWeek) && args.maxWeek > 0 ? args.maxWeek : 1;

  let cloud;
  try { cloud = await fetchCloud(bucket); }
  catch(e){
    console.error('❌ Could not read cloud state: '+e.message);
    process.exit(1);
  }

  const rows = STUDENTS.map(s=>{
    const ud = cloud.users[s.id] || {};
    const joinedAt = ud.joinedAt || 0;
    const wk = computeWeek(joinedAt, maxAuthoredWeek);
    const wrongCount = Array.isArray(ud.wrongAnswers) ? ud.wrongAnswers.length : 0;
    const row = {
      id: s.id,
      name: s.name,
      joinedAt,
      rawWeek: wk.raw,
      cappedWeek: wk.capped,
      displayWeek: wk.capped,
      daysToRollover: wk.daysToRollover,
      wrongCount,
    };
    row.status = statusFor(row, maxAuthoredWeek);
    return row;
  });
  // Sort: overdue first, then rolls-over-soonest, then by wrong count desc.
  rows.sort((a,b)=>{
    if(a.status.overdue !== b.status.overdue) return a.status.overdue ? -1 : 1;
    if(a.daysToRollover !== b.daysToRollover) return a.daysToRollover - b.daysToRollover;
    return b.wrongCount - a.wrongCount;
  });

  if(args.json){
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.log('');
    console.log('Solvix — who\'s due for new content (MAX_AUTHORED_WEEK = '+maxAuthoredWeek+')');
    console.log('');
    renderTable(rows);
    console.log('');
    const overdue = rows.filter(r=>r.status.overdue);
    if(overdue.length){
      console.log('⚠️  '+overdue.length+' student'+(overdue.length===1?'':'s')+' OVERDUE. Run scripts/draft-week.mjs to get a draft:');
      console.log('     node scripts/draft-week.mjs --week '+(maxAuthoredWeek+1)+' --out-dir /tmp/kidquest-w'+(maxAuthoredWeek+1));
    } else {
      console.log('✅ Everyone current. Next check-in in a few days.');
    }
    console.log('');
  }

  process.exit(rows.some(r=>r.status.overdue) ? 2 : 0);
}

main().catch(e=>{ console.error(e); process.exit(1); });
