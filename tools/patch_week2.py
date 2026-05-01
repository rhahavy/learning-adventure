#!/usr/bin/env python3
"""
patch_week2.py — read /tmp/week2_lessons.json (produced by
                 bulk_fill_week2.py) and inject the lessons into the
                 WEEKS[2] block in app/index.html.

Strategy:
  1. Load the cached lesson JSON. Group by sid → subject → [lessons].
  2. For each sid, build a JS literal like:
       rushan: {
         reading: [ {...}, {...}, ... ],
         math:    [ ... ],
         ...
       },
  3. Inject into the existing WEEKS[2] = { ... } block:
       - If WEEKS[2] already has the sid, skip with a warning (won't
         clobber operator-authored content).
       - Otherwise add the sid block as a new top-level key.

Idempotent — running twice is a no-op for sids that already landed.
Single atomic write at the end. Refuses to write if the activity
count would drop.
"""

import argparse, json, os, re, sys

DEFAULT_APP    = "app/index.html"
RESULTS_FILE   = "/tmp/week2_lessons.json"

SUBJECT_LETTER = {
    'reading':'r', 'writing':'w', 'math':'m', 'logic':'l',
    'french':'f', 'science':'s', 'social':'c', 'coding':'p',
}
SUBJECT_ORDER = ['reading','writing','math','logic','french','science','social','coding']

def js_str(s):
    """Single-quoted JS string literal, escaping backslashes and quotes."""
    out = str(s).replace('\\','\\\\').replace("'","\\'")
    out = out.replace('\n','\\n').replace('\r','\\r').replace('\t','\\t')
    return "'" + out + "'"

def render_question(q):
    """Render one question dict as a JS object literal one-liner."""
    t = q.get('type','mcq')
    parts = ["type:" + js_str(t)]
    if t == 'passage' and q.get('passage'):
        parts.append("passage:" + js_str(q['passage']))
    parts.append("q:" + js_str(q.get('q','')))
    choices = q.get('choices', [])
    parts.append("choices:[" + ','.join(js_str(c) for c in choices) + "]")
    parts.append("answer:" + str(int(q.get('answer', 0))))
    return "{" + ",".join(parts) + "}"

def render_lesson(aid, lesson):
    """Render one full activity object as a JS literal."""
    title  = lesson.get('title','Untitled')
    emoji  = lesson.get('emoji','📘')
    curr   = lesson.get('curriculum') or {}
    lsn    = lesson.get('lesson') or {}
    qs     = lesson.get('questions') or []
    sqs    = lesson.get('stretchQuestions') or []
    out = []
    out.append("      { id:" + js_str(aid) + ", title:" + js_str(title) + ", emoji:" + js_str(emoji) + ",")
    # Curriculum tag — use oc(grade, strand, [codes], description) to
    # match the existing source style.
    grade  = curr.get('grade','')
    strand = curr.get('strand','')
    codes  = curr.get('codes') or []
    desc   = curr.get('description','')
    out.append("        curriculum: oc(" + js_str(grade) + ", " + js_str(strand) + ", [" +
               ','.join(js_str(c) for c in codes) + "], " + js_str(desc) + "),")
    # Lesson card.
    out.append("        lesson:{title:" + js_str(lsn.get('title', title)) +
               ",intro:" + js_str(lsn.get('intro','')) +
               ",example:" + js_str(lsn.get('example','')) +
               ",hint:" + js_str(lsn.get('hint','')) + "},")
    out.append("        questions:[")
    for q in qs: out.append("          " + render_question(q) + ",")
    out.append("        ],")
    if sqs:
        out.append("        stretchQuestions:[")
        for q in sqs: out.append("          " + render_question(q) + ",")
        out.append("        ]")
    out.append("      },")
    return '\n'.join(out)

def render_subject(subject, lessons):
    """Render one subject's array of lesson objects."""
    out = ["    " + subject + ": ["]
    for aid, lesson in lessons:
        out.append(render_lesson(aid, lesson))
    out.append("    ],")
    return '\n'.join(out)

def render_sid_block(sid, by_subject):
    """Render one sid's full WEEKS[2] entry."""
    out = ["  " + sid + ": {"]
    for subj in SUBJECT_ORDER:
        if subj in by_subject:
            out.append(render_subject(subj, by_subject[subj]))
    out.append("  },")
    return '\n'.join(out)

def find_balanced(s, i, open_c, close_c):
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

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--app', default=DEFAULT_APP)
    ap.add_argument('--results', default=RESULTS_FILE)
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    with open(args.app) as f: src = f.read()
    if not os.path.exists(args.results):
        print(f"❌  No results at {args.results}. Run bulk_fill_week2.py first."); sys.exit(1)
    with open(args.results) as f: lessons_by_aid = json.load(f)
    print(f"Loaded {len(lessons_by_aid)} lessons from {args.results}")

    # Group by sid → subject → [(aid, lesson)] (preserve numeric order)
    by_sid = {}
    for aid, lesson in lessons_by_aid.items():
        meta = lesson.get('_meta') or {}
        sid = meta.get('sid')
        subj = meta.get('subject')
        n = meta.get('lesson_n', 0)
        if not sid or not subj: continue
        by_sid.setdefault(sid, {}).setdefault(subj, []).append((n, aid, lesson))
    # Sort within each subject by lesson_n
    for sid in by_sid:
        for subj in by_sid[sid]:
            by_sid[sid][subj].sort(key=lambda x: x[0])
            by_sid[sid][subj] = [(aid, lesson) for _n, aid, lesson in by_sid[sid][subj]]

    # Locate WEEKS[2] block
    m = re.search(r'^WEEKS\[2\] = \{', src, re.M)
    if not m:
        print("❌  WEEKS[2] = {...} block not found in source"); sys.exit(1)
    open_brace = m.end() - 1
    close_brace = find_balanced(src, open_brace, '{', '}')
    if close_brace < 0:
        print("❌  Could not find matching close brace for WEEKS[2]"); sys.exit(1)
    block_body = src[open_brace+1:close_brace]
    # Existing top-level sids in WEEKS[2]
    existing_sids = set()
    j = 0; d = 0; in_s = None; esc = False
    while j < len(block_body):
        c = block_body[j]
        if esc: esc = False
        elif in_s:
            if c == '\\': esc = True
            elif c == in_s: in_s = None
        else:
            if c in "\"'`": in_s = c
            elif c in '{[': d += 1
            elif c in '}]': d -= 1
            elif d == 0 and c == ':':
                k = j - 1
                while k >= 0 and block_body[k] in ' \t\n': k -= 1
                end = k + 1
                while k >= 0 and (block_body[k].isalnum() or block_body[k] == '_'):
                    k -= 1
                key = block_body[k+1:end].strip()
                if key: existing_sids.add(key)
        j += 1
    print(f"WEEKS[2] currently has sids: {sorted(existing_sids)}")

    # Compose insertions
    to_inject = []
    for sid in by_sid:
        if sid in existing_sids:
            print(f"  ⚠️  {sid} already in WEEKS[2] — skipping (delete the existing block first if you want to overwrite)")
            continue
        to_inject.append(render_sid_block(sid, by_sid[sid]))
    if not to_inject:
        print("Nothing new to inject."); return

    if args.dry_run:
        print("\n=== Would inject ===\n")
        for blk in to_inject:
            print(blk[:600])
            print("  ... (truncated)" if len(blk) > 600 else "")
        return

    # Insert before the closing brace of WEEKS[2].
    # Find a clean insertion point: just before close_brace, after the
    # last existing top-level entry. We append at close_brace position
    # with a leading newline.
    insertion = '\n' + '\n'.join(to_inject) + '\n'
    new_src = src[:close_brace] + insertion + src[close_brace:]

    if new_src == src:
        print("No change."); return

    # Sanity: activity-id count should INCREASE by len(lessons_by_aid)
    before = len(re.findall(r"\bid\s*:\s*'(w\d+-[a-z]+-[a-z]\d+)'", src))
    after  = len(re.findall(r"\bid\s*:\s*'(w\d+-[a-z]+-[a-z]\d+)'", new_src))
    delta = after - before
    if delta < 1:
        print(f"❌  Activity count delta is {delta} (expected ≥ 1). Aborting write."); sys.exit(1)

    with open(args.app, 'w') as f: f.write(new_src)
    print(f"✅  Patched WEEKS[2] with {len(to_inject)} new sid block(s). Activity count: {before} → {after} (+{delta}).")

if __name__ == '__main__':
    main()
