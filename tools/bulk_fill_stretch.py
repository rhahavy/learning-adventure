#!/usr/bin/env python3
"""
bulk_fill_stretch.py — generate stretchQuestions[] pools for every real
                       activity in app/index.html that doesn't already have
                       one, by calling the kidquest-ai-proxy worker's
                       /generate-questions endpoint with the admin bypass
                       token. Idempotent: re-running skips activities that
                       already got patched.

Phases:
  1. Scan app/index.html → list activities (id, title, intro, curriculum,
     existing MCQs) that NEED a stretch pool.
  2. Call /generate-questions for each. Results are written incrementally
     to /tmp/stretch_pools.json so a crash mid-run resumes cleanly.
  3. Patch app/index.html in place: for every activity that got a fresh
     pool, inject `stretchQuestions:[...]` right after the `questions:[...]`
     block in the same activity object.

Throttling:
  Up to 4 calls in flight at once, ~250ms stagger. Worker has no per-IP
  cap once X-Admin-Token bypasses the per-student daily cap, but Anthropic
  itself rate-limits ~50rps on Haiku — well clear at our pace.

Inputs:
  --token-file workers/ai-proxy/.admin-token  (default; chmod 600)
  --backend    https://kidquest-ai-proxy.rhahavy-b.workers.dev (default)
  --app        app/index.html (default)
  --dry-run    parse + report scope, don't call API
  --resume     skip activities already in /tmp/stretch_pools.json
"""

import argparse, concurrent.futures, json, os, re, sys, time
from urllib import request as urlreq
from urllib import error as urlerror

DEFAULT_BACKEND = "https://kidquest-ai-proxy.rhahavy-b.workers.dev"
DEFAULT_APP     = "app/index.html"
DEFAULT_TOKEN   = "workers/ai-proxy/.admin-token"
RESULTS_FILE    = "/tmp/stretch_pools.json"
COUNT_PER_POOL  = 5
MAX_PARALLEL    = 2
ORIGIN          = "https://kidquest.fun"

# ---- parsing helpers (shared shape from earlier audits) -------------------

def find_balanced(s, i, open_c, close_c):
    """Walk forward from index i (which must be at open_c) to its matching close."""
    depth = 0; in_str = None; esc = False
    j = i
    while j < len(s):
        c = s[j]
        if esc: esc = False
        elif in_str:
            if c == '\\': esc = True
            elif c == in_str: in_str = None
        else:
            if c in "\"'`": in_str = c
            elif c == open_c: depth += 1
            elif c == close_c:
                depth -= 1
                if depth == 0: return j
        j += 1
    return -1

def split_top(s):
    """Top-level comma split honouring brackets/parens/braces and quoted strings."""
    parts, cur = [], ''
    depth = 0; in_str = None; esc = False
    for c in s:
        if esc: cur += c; esc = False; continue
        if in_str:
            cur += c
            if c == '\\': esc = True
            elif c == in_str: in_str = None
            continue
        if c in "\"'`": in_str = c; cur += c; continue
        if c in '([{': depth += 1; cur += c; continue
        if c in ')]}': depth -= 1; cur += c; continue
        if c == ',' and depth == 0: parts.append(cur); cur = ''; continue
        cur += c
    if cur.strip(): parts.append(cur)
    return parts

def unwrap_str(s):
    s = s.strip()
    if not s: return s
    if s[0] in "\"'`":
        end_q = s[0]; i = 1; esc = False
        while i < len(s):
            c = s[i]
            if esc: esc = False
            elif c == '\\': esc = True
            elif c == end_q:
                inner = s[1:i]
                inner = (inner.replace("\\'","'").replace('\\"','"')
                              .replace("\\\\","\\").replace("\\n","\n").replace("\\t","\t"))
                return inner
            i += 1
    return s

def find_object_literal_activities(src):
    """
    Find every `{ id:'w...', ... }` activity block in the WEEKS section.
    Returns list of dicts with absolute start/end positions in src + parsed
    bits (id, title, intro, has_stretch, mcq_questions).
    """
    out = []
    # Match `{ id: 'w<…>'` or `{ id:'w...'` — the opening brace is what we
    # walk from to find the matching close. We require id starts with 'w'
    # so we don't catch every random object literal.
    for m in re.finditer(r'\{\s*id\s*:\s*[\'"](w[A-Za-z0-9_-]+)[\'"]', src):
        brace_pos = src.rfind('{', 0, m.end())  # the opening { we just saw
        # Actually: m.start() is at the `{`. Confirm.
        # m matches `{ id:'w...'` so m.start() is `{`.
        brace_pos = m.start()
        end = find_balanced(src, brace_pos, '{', '}')
        if end < 0: continue
        body = src[brace_pos:end+1]
        aid = m.group(1)
        out.append({
            'aid': aid,
            'start': brace_pos,
            'end': end,  # inclusive
            'body': body,
        })
    return out

def parse_activity(act):
    """Extract curriculum, title, intro, MCQ questions, has_stretch."""
    body = act['body']
    info = {'aid': act['aid']}
    # title
    tm = re.search(r"title\s*:\s*['\"]([^'\"]+)['\"]", body)
    info['title'] = tm.group(1) if tm else ''
    # has stretchQuestions (any non-empty array)
    sm = re.search(r"stretchQuestions\s*:\s*\[", body)
    info['has_stretch'] = False
    if sm:
        bs = body.index('[', sm.start())
        be = find_balanced(body, bs, '[', ']')
        if be > bs and re.search(r'\S', body[bs+1:be]):
            info['has_stretch'] = True
    # questions:[...] block
    qm = re.search(r"questions\s*:\s*\[", body)
    if not qm:
        info['questions_block'] = None
        info['mcqs'] = []
        return info
    qs = body.index('[', qm.start())
    qe = find_balanced(body, qs, '[', ']')
    if qe < 0:
        info['questions_block'] = None; info['mcqs'] = []; return info
    info['questions_block'] = (qs, qe)  # local to body
    qcontent = body[qs+1:qe]
    # Walk top-level question objects
    j = 0; depth = 0; in_str = None; esc = False
    starts = []
    qobjs = []
    while j < len(qcontent):
        c = qcontent[j]
        if esc: esc = False
        elif in_str:
            if c == '\\': esc = True
            elif c == in_str: in_str = None
        else:
            if c in "\"'`": in_str = c
            elif c == '{':
                if depth == 0: starts.append(j)
                depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0 and starts:
                    qobjs.append(qcontent[starts[-1]:j+1])
                    starts.pop()
        j += 1
    mcqs = []
    for qsrc in qobjs:
        # Treat both type:'mcq' and type:'passage' as bootstrap-shaped — both
        # carry the same { q, choices, answer } skeleton the AI needs as a
        # difficulty/topic anchor. (Passage Qs ALSO have a passage:'...' field
        # but we don't need to pass that through; we just need shape + answer.)
        if not re.search(r"type\s*:\s*['\"](?:mcq|passage)['\"]", qsrc): continue
        am = re.search(r"answer\s*:\s*(\d+)", qsrc)
        if not am: continue
        ans = int(am.group(1))
        # Question text
        qtm = re.search(r"q\s*:\s*", qsrc)
        if not qtm: continue
        rest = qsrc[qtm.end():].lstrip()
        if not rest or rest[0] not in "\"'`": continue
        quote = rest[0]; jj = 1; ee = False
        while jj < len(rest):
            cc = rest[jj]
            if ee: ee = False
            elif cc == '\\': ee = True
            elif cc == quote: break
            jj += 1
        qtext = unwrap_str(rest[:jj+1])
        # choices
        cm = re.search(r"choices\s*:\s*\[", qsrc)
        if not cm: continue
        cs = qsrc.index('[', cm.start())
        ce = find_balanced(qsrc, cs, '[', ']')
        if ce < 0: continue
        choices = [unwrap_str(c) for c in split_top(qsrc[cs+1:ce])]
        if ans >= len(choices): continue
        mcqs.append({'q': qtext, 'choices': choices, 'answer': ans})
    info['mcqs'] = mcqs
    # curriculum: grab the oc(...) call as a string we'll use to derive grade/strand/codes.
    # The frontend's oc() helper is `oc('Grade 3', 'Math — strand', ['B2.1'], 'description')`.
    cm2 = re.search(r"curriculum\s*:\s*oc\(", body)
    info['curriculum'] = None
    if cm2:
        op = body.index('(', cm2.start())
        cp = find_balanced(body, op, '(', ')')
        if cp > op:
            args = split_top(body[op+1:cp])
            if len(args) >= 3:
                grade  = unwrap_str(args[0])
                strand = unwrap_str(args[1])
                codes_arg = args[2].strip()
                codes = []
                if codes_arg.startswith('['):
                    codes = [unwrap_str(x) for x in split_top(codes_arg[1:-1])]
                desc = unwrap_str(args[3]) if len(args) >= 4 else ''
                info['curriculum'] = {
                    'grade': grade, 'strand': strand,
                    'codes': codes, 'description': desc
                }
    # lesson intro
    lm = re.search(r"lesson\s*:\s*\{", body)
    info['lesson_title'] = info['title']
    info['lesson_intro'] = ''
    if lm:
        lo = body.index('{', lm.start())
        le = find_balanced(body, lo, '{', '}')
        if le > lo:
            lcontent = body[lo+1:le]
            ltitle = re.search(r"title\s*:\s*['\"]([^'\"]+)['\"]", lcontent)
            if ltitle: info['lesson_title'] = ltitle.group(1)
            # intro can be a long string with embedded apostrophes — match the whole literal.
            qtm = re.search(r"intro\s*:\s*", lcontent)
            if qtm:
                rest = lcontent[qtm.end():].lstrip()
                if rest and rest[0] in "\"'`":
                    quote = rest[0]; jj = 1; ee = False
                    while jj < len(rest):
                        cc = rest[jj]
                        if ee: ee = False
                        elif cc == '\\': ee = True
                        elif cc == quote: break
                        jj += 1
                    info['lesson_intro'] = unwrap_str(rest[:jj+1])[:600]
    return info

# ---- network -------------------------------------------------------------

def call_generate(backend, admin_token, payload, retries=3):
    url = backend.rstrip('/') + '/generate-questions'
    body = json.dumps(payload).encode('utf-8')
    last_err = None
    for attempt in range(retries):
        req = urlreq.Request(url, data=body, method='POST')
        req.add_header('Content-Type', 'application/json')
        # Cloudflare's bot-fight rejects requests with a "Python-urllib/x.y"
        # User-Agent (HTTP 403, error code 1010). A vanilla browser-shaped
        # UA gets us past the edge — we're a legitimate operator tool.
        req.add_header('User-Agent', 'kidquest-bulk-fill-stretch/1.0 (admin tooling)')
        req.add_header('X-Admin-Token', admin_token)
        req.add_header('X-Student-Id', '_admin_bulk')
        req.add_header('Origin', ORIGIN)
        try:
            with urlreq.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        except urlerror.HTTPError as e:
            try: detail = e.read().decode('utf-8', 'ignore')
            except Exception: detail = ''
            last_err = f"HTTP {e.code}: {detail[:200]}"
            if e.code in (429, 502, 503, 504):
                # 502s wrapping a Claude 429 mean Anthropic itself is throttling
                # us. Back off harder than other transient codes — exponential.
                is_claude_429 = 'rate_limit_error' in detail or '"429"' in detail
                wait = (8 if is_claude_429 else 2) * (attempt + 1)
                time.sleep(wait)
                continue
            return {'error': 'http_error', 'detail': last_err}
        except Exception as e:
            last_err = str(e)
            time.sleep(1 + attempt)
            continue
    return {'error': 'retry_exhausted', 'detail': last_err}

# ---- main ---------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--app', default=DEFAULT_APP)
    ap.add_argument('--backend', default=DEFAULT_BACKEND)
    ap.add_argument('--token-file', default=DEFAULT_TOKEN)
    ap.add_argument('--results', default=RESULTS_FILE)
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--limit', type=int, default=0,
                    help='Stop after generating N pools (0 = no limit)')
    args = ap.parse_args()

    # Load source
    with open(args.app) as f: src = f.read()

    # Load existing results (resume support)
    results = {}
    if os.path.exists(args.results):
        try:
            with open(args.results) as f: results = json.load(f)
            print(f"Loaded {len(results)} existing pools from {args.results}")
        except Exception as e:
            print(f"⚠️  Could not parse {args.results}: {e} — starting fresh")
            results = {}

    activities = find_object_literal_activities(src)
    print(f"Found {len(activities)} object-literal activities")

    needed = []
    skipped_demo = skipped_has_stretch = skipped_no_mcq = skipped_no_curr = 0
    for act in activities:
        info = parse_activity(act)
        if info.get('has_stretch'):
            skipped_has_stretch += 1
            continue
        if 'demoOnly:true' in act['body'] or 'demoOnly: true' in act['body']:
            skipped_demo += 1
            continue
        if len(info['mcqs']) < 2:
            skipped_no_mcq += 1
            continue
        if not info.get('curriculum'):
            skipped_no_curr += 1
            continue
        needed.append(info)

    print(f"Already have stretch pool: {skipped_has_stretch}")
    print(f"Demo-only (skipped): {skipped_demo}")
    print(f"No MCQ to learn from (skipped): {skipped_no_mcq}")
    print(f"No curriculum tag (skipped): {skipped_no_curr}")
    print(f"Need a stretch pool: {len(needed)}")

    if args.dry_run:
        for a in needed[:10]:
            print(f"  - {a['aid']:30s} {a['curriculum']['grade']:8s} {a['title']}")
        if len(needed) > 10:
            print(f"  ... and {len(needed)-10} more")
        return

    # Filter out ones already in results
    todo = [a for a in needed if a['aid'] not in results]
    if args.limit > 0:
        todo = todo[:args.limit]
    print(f"To generate now: {len(todo)} (cached: {len(needed) - len(todo)})")
    if not todo:
        print("Nothing to do.")
        return

    # Token
    with open(args.token_file) as f:
        admin_token = f.read().strip()
    if not admin_token:
        print(f"❌  Admin token at {args.token_file} is empty. Aborting.")
        sys.exit(1)

    # Generate in parallel
    def task(info):
        payload = {
            'curriculum': {
                'grade': info['curriculum']['grade'],
                'strand': info['curriculum']['strand'],
                'codes': info['curriculum']['codes'],
                'description': info['curriculum']['description'],
            },
            'existingQuestions': info['mcqs'][:5],
            'count': COUNT_PER_POOL,
            'lessonTitle': info['lesson_title'][:160],
            'lessonIntro': info['lesson_intro'][:600],
            'difficulty': 'stretch',
        }
        result = call_generate(args.backend, admin_token, payload)
        return info['aid'], result

    started = 0
    succeeded = 0
    failed_examples = []
    t0 = time.time()
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_PARALLEL) as ex:
        futures = {ex.submit(task, info): info['aid'] for info in todo}
        for fut in concurrent.futures.as_completed(futures):
            aid = futures[fut]
            try:
                rid, result = fut.result()
            except Exception as e:
                print(f"  ❌  {aid:30s} exception: {e}")
                continue
            started += 1
            if result.get('error'):
                if len(failed_examples) < 8:
                    failed_examples.append((rid, result.get('error'), result.get('detail', '')[:120]))
                print(f"  ❌  {rid:30s} {result.get('error')}")
                continue
            data = result.get('data') or {}
            qs = data.get('questions') or []
            if not isinstance(qs, list) or not qs:
                print(f"  ❌  {rid:30s} no questions in response")
                continue
            # Normalize each question into the source-shape we'll patch:
            # {type:'mcq', q:..., choices:[...], answer:N}
            clean = []
            for q in qs:
                qt = q.get('q')
                ch = q.get('choices')
                an = q.get('answer')
                if not isinstance(qt, str) or not isinstance(ch, list) or not isinstance(an, int):
                    continue
                if an < 0 or an >= len(ch):
                    continue
                clean.append({
                    'type': 'mcq',
                    'q': qt,
                    'choices': [str(c) for c in ch],
                    'answer': an,
                })
            if not clean:
                print(f"  ❌  {rid:30s} response had no usable MCQs")
                continue
            results[rid] = clean
            succeeded += 1
            # Persist after every result so a crash mid-run is recoverable
            with open(args.results, 'w') as f: json.dump(results, f, indent=1)
            print(f"  ✅  {rid:30s} {len(clean)} stretch q's ({result.get('cached', False) and 'cache' or 'fresh'})")

    elapsed = time.time() - t0
    print(f"\nDone in {elapsed:.1f}s — {succeeded} succeeded / {started} attempts")
    if failed_examples:
        print("Sample failures:")
        for aid, err, det in failed_examples:
            print(f"  {aid:30s} {err}: {det}")
    print(f"All results saved to {args.results} ({len(results)} total)")
    print("Next step: run tools/patch_stretch.py to inject into app/index.html")

if __name__ == '__main__':
    main()
