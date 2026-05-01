#!/usr/bin/env python3
"""
bulk_fill_week2.py — generate complete Week 2 lessons for one or more
                     grades, by calling the kidquest-ai-proxy worker's
                     /generate-lesson endpoint with the admin bypass
                     token. Output JSON is saved to /tmp/week2_lessons.json
                     so a re-run resumes cleanly. Patching into the source
                     happens via tools/patch_week2.py — this script just
                     populates the JSON cache.

Default behavior: generate 5 lessons for every subject the target grade-
master kid has in Week 1.

Usage:
  # One grade, one subject (proof of concept):
  python3 tools/bulk_fill_week2.py --sid rushan --subject reading

  # One grade, all subjects:
  python3 tools/bulk_fill_week2.py --sid rushan

  # All grades, all subjects (the big run):
  python3 tools/bulk_fill_week2.py --all

  # Dry-run shows the work plan:
  python3 tools/bulk_fill_week2.py --sid rushan --dry-run

Throttling:
  Up to 2 calls in flight at once with Claude-429-aware exponential
  backoff. Each /generate-lesson call is heavier than /generate-questions
  (full 5+5 question lesson at maxTokens 2400) so we stay polite.
"""

import argparse, concurrent.futures, json, os, re, sys, time
from urllib import request as urlreq, error as urlerror

DEFAULT_BACKEND = "https://kidquest-ai-proxy.rhahavy-b.workers.dev"
DEFAULT_APP     = "app/index.html"
DEFAULT_TOKEN   = "workers/ai-proxy/.admin-token"
RESULTS_FILE    = "/tmp/week2_lessons.json"
LESSONS_PER_SUBJECT = 5
MAX_PARALLEL    = 2
ORIGIN          = "https://kidquest.fun"

# Grade-master roster — must match GRADE_MASTERS in admin/index.html
# and DEMO_GRADES_TEACHER in app/index.html. Order = grade order.
GRADE_MASTERS = [
    {'sid':'theo',     'grade':'Junior Kindergarten'},
    {'sid':'nishan',   'grade':'Senior Kindergarten'},
    {'sid':'akaran',   'grade':'Grade 1'},
    {'sid':'rushan',   'grade':'Grade 2'},
    {'sid':'akshayan', 'grade':'Grade 3'},
    {'sid':'lily',     'grade':'Grade 4'},
    {'sid':'isaiah',   'grade':'Grade 5'},
    {'sid':'jasper',   'grade':'Grade 6'},
    {'sid':'evan',     'grade':'Grade 7'},
    {'sid':'nora',     'grade':'Grade 8'},
]
GRADE_BY_SID = {g['sid']: g['grade'] for g in GRADE_MASTERS}

# Subject ID → activity-letter (matches the WEEKS structure in app/index.html).
SUBJECTS = ['reading','writing','math','logic','french','science','social','coding']
SUBJECT_LETTER = {
    'reading':'r', 'writing':'w', 'math':'m', 'logic':'l',
    'french':'f', 'science':'s', 'social':'c', 'coding':'p',
}
SUBJECTS_NEEDING_PASSAGE = {'reading'}

# ----- Source parsing: pull Week 1 titles per sid × subject ---------------
def find_week1_titles(src):
    """Walk source for `push('<sid>','<subject>',[ ... { id:'w1-...', title:'...', ...} ... ])`
    and produce { (sid, subject) -> [titles...] } so the script can pass
    priorTopics to the AI for progression."""
    out = {}
    pat = re.compile(r"push\(\s*'([a-z]+)'\s*,\s*'([a-z]+)'\s*,\s*\[")
    for m in pat.finditer(src):
        sid, subj = m.group(1), m.group(2)
        # Walk balanced [ from m.end()-1
        i = src.index('[', m.start()); depth = 0; in_str = None; esc = False; j = i
        while j < len(src):
            c = src[j]
            if esc: esc = False
            elif in_str:
                if c == '\\': esc = True
                elif c == in_str: in_str = None
            else:
                if c in "\"'`": in_str = c
                elif c == '[': depth += 1
                elif c == ']':
                    depth -= 1
                    if depth == 0: break
            j += 1
        block = src[i+1:j]
        titles = re.findall(r"title\s*:\s*'([^']+)'", block)
        out[(sid, subj)] = titles
    return out

# ----- Network call --------------------------------------------------------
def call_generate_lesson(backend, admin_token, payload, retries=3):
    url = backend.rstrip('/') + '/generate-lesson'
    body = json.dumps(payload).encode('utf-8')
    last_err = None
    for attempt in range(retries):
        req = urlreq.Request(url, data=body, method='POST')
        req.add_header('Content-Type', 'application/json')
        req.add_header('User-Agent', 'kidquest-bulk-week2/1.0 (admin tooling)')
        req.add_header('X-Admin-Token', admin_token)
        req.add_header('X-Student-Id', '_admin_bulk')
        req.add_header('Origin', ORIGIN)
        try:
            with urlreq.urlopen(req, timeout=120) as r:
                return json.loads(r.read())
        except urlerror.HTTPError as e:
            try: detail = e.read().decode('utf-8','ignore')
            except: detail = ''
            last_err = f"HTTP {e.code}: {detail[:200]}"
            if e.code in (429, 502, 503, 504):
                is_claude_429 = 'rate_limit_error' in detail or '"429"' in detail
                wait = (10 if is_claude_429 else 3) * (attempt + 1)
                time.sleep(wait); continue
            return {'error':'http_error','detail':last_err}
        except Exception as e:
            last_err = str(e); time.sleep(2 + attempt); continue
    return {'error':'retry_exhausted','detail':last_err}

# ----- Main ----------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--app', default=DEFAULT_APP)
    ap.add_argument('--backend', default=DEFAULT_BACKEND)
    ap.add_argument('--token-file', default=DEFAULT_TOKEN)
    ap.add_argument('--results', default=RESULTS_FILE)
    ap.add_argument('--sid', help='single sid (e.g. rushan). omit to use --all.')
    ap.add_argument('--subject', help='single subject (e.g. reading). omit = all subjects of sid.')
    ap.add_argument('--all', action='store_true', help='process every grade-master sid')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--limit', type=int, default=0, help='Stop after generating N lessons (0=no limit)')
    args = ap.parse_args()

    if not args.sid and not args.all:
        print("usage: --sid <sid> [--subject <subj>]  OR  --all")
        sys.exit(1)

    # Load source for priorTopics
    with open(args.app) as f: src = f.read()
    prior_titles = find_week1_titles(src)

    # Existing results (resume)
    results = {}
    if os.path.exists(args.results):
        try:
            with open(args.results) as f: results = json.load(f)
            print(f"Loaded {len(results)} existing lessons from {args.results}")
        except Exception as e:
            print(f"⚠️  Could not parse {args.results}: {e} — starting fresh")
            results = {}

    # Build target list: [(sid, subject, lesson_index 6..10)]
    targets_sids = [args.sid] if args.sid else [g['sid'] for g in GRADE_MASTERS]
    targets = []
    for sid in targets_sids:
        if sid not in GRADE_BY_SID:
            print(f"⚠️  unknown sid {sid!r}, skipping"); continue
        subjs = [args.subject] if args.subject else list(SUBJECTS)
        for subj in subjs:
            # Skip if this sid has no Week 1 content for this subject (can't be progression)
            week1_titles = prior_titles.get((sid, subj), [])
            if not week1_titles and subj != 'french':
                # most kids have french; if they don't, skip silently
                pass
            for n in range(6, 6 + LESSONS_PER_SUBJECT):
                aid = f'w2-{sid}-{SUBJECT_LETTER[subj]}{n}'
                targets.append({'aid':aid, 'sid':sid, 'subject':subj, 'lesson_n':n,
                                'priorTopics':week1_titles[:6]})
    print(f"Total target lessons: {len(targets)}")

    # Filter resume
    todo = [t for t in targets if t['aid'] not in results]
    if args.limit > 0: todo = todo[:args.limit]
    print(f"To generate now: {len(todo)} (cached: {len(targets) - len(todo)})")

    if args.dry_run:
        for t in todo[:10]:
            print(f"  - {t['aid']:30s} {GRADE_BY_SID[t['sid']]:25s} {t['subject']}")
        if len(todo) > 10: print(f"  ... and {len(todo)-10} more")
        return

    if not todo:
        print("Nothing to do."); return

    with open(args.token_file) as f: admin_token = f.read().strip()
    if not admin_token:
        print(f"❌  Admin token empty at {args.token_file}"); sys.exit(1)

    def task(t):
        payload = {
            'grade':       GRADE_BY_SID[t['sid']],
            'subject':     t['subject'],
            'week':        2,
            'priorTopics': t['priorTopics'],
            'needsPassage': t['subject'] in SUBJECTS_NEEDING_PASSAGE,
        }
        result = call_generate_lesson(args.backend, admin_token, payload)
        return t, result

    succeeded = 0; failed_examples = []
    t0 = time.time()
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_PARALLEL) as ex:
        futures = {ex.submit(task, t): t['aid'] for t in todo}
        for fut in concurrent.futures.as_completed(futures):
            aid = futures[fut]
            try:
                t, result = fut.result()
            except Exception as e:
                print(f"  ❌  {aid:30s} exception: {e}"); continue
            if result.get('error'):
                if len(failed_examples) < 8:
                    failed_examples.append((aid, result.get('error'), result.get('detail','')[:120]))
                print(f"  ❌  {aid:30s} {result.get('error')}: {result.get('detail','')[:100]}")
                continue
            data = result.get('data') or {}
            # Sanity check minimal shape
            if not data.get('title') or not isinstance(data.get('questions'), list) or len(data['questions']) < 3:
                print(f"  ❌  {aid:30s} bad shape: {list(data.keys())}")
                continue
            data['_meta'] = {'sid':t['sid'], 'subject':t['subject'], 'lesson_n':t['lesson_n']}
            results[aid] = data
            succeeded += 1
            with open(args.results, 'w') as f: json.dump(results, f, indent=1)
            print(f"  ✅  {aid:30s} {data.get('title','?')[:40]}")

    elapsed = time.time() - t0
    print(f"\nDone in {elapsed:.1f}s — {succeeded} succeeded, total cached: {len(results)}")
    if failed_examples:
        print("Sample failures:")
        for aid, err, det in failed_examples:
            print(f"  {aid:30s} {err}: {det}")
    print(f"All results saved to {args.results}")
    print("Next: run tools/patch_week2.py to inject WEEKS[2].sid into app/index.html")

if __name__ == '__main__':
    main()
