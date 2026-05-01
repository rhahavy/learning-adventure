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
    'reading':'r', 'writing':'w', 'spelling':'sp', 'math':'m', 'logic':'l',
    'french':'f', 'science':'s', 'social':'c', 'coding':'p',
}
SUBJECT_ORDER = ['reading','writing','spelling','math','logic','french','science','social','coding']

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

def find_top_level_kv_blocks(text):
    """Walk `text` and return every top-level `key: { ... }` or
    `key: [ ... ]` pair as (key, open_idx, close_idx) — both indices
    relative to `text`, both inclusive of the brace/bracket.

    Used by the merge path: we scan WEEKS[2]'s body to find sid blocks,
    then scan each sid's inner body to find subject arrays. Skips strings
    so colons inside passage text don't get mistaken for keys."""
    out = []
    j = 0; d = 0; in_s = None; esc = False
    n = len(text)
    while j < n:
        c = text[j]
        if esc: esc = False
        elif in_s:
            if c == '\\': esc = True
            elif c == in_s: in_s = None
        else:
            if c in "\"'`": in_s = c
            elif c in '{[': d += 1
            elif c in '}]': d -= 1
            elif d == 0 and c == ':':
                # Walk back to capture the JS identifier acting as the key.
                k = j - 1
                while k >= 0 and text[k] in ' \t\n': k -= 1
                end = k + 1
                while k >= 0 and (text[k].isalnum() or text[k] == '_'):
                    k -= 1
                key = text[k+1:end].strip()
                if key:
                    # Walk forward to the value's opening brace/bracket.
                    m = j + 1
                    while m < n and text[m] in ' \t\n': m += 1
                    if m < n and text[m] in '{[':
                        opener = text[m]
                        closer = '}' if opener == '{' else ']'
                        close_idx = find_balanced(text, m, opener, closer)
                        if close_idx > 0:
                            out.append((key, m, close_idx))
                            j = close_idx  # jump past the value to avoid re-entering it
        j += 1
    return out

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
    # Walk WEEKS[2]'s body once to capture each existing sid → its
    # inner-brace range. We need the range (not just the name) so we
    # can MERGE missing subjects into the existing sid block instead
    # of skipping it. (rushan/akshayan landed with reading-only on the
    # first pass; the rest of the subjects are in /tmp/week2_partial.json
    # and need to slot into the same sid block — not a new one, which
    # would produce a duplicate key the JS parser would silently keep
    # only the second of.)
    sid_kv = find_top_level_kv_blocks(block_body)
    existing_sid_info = {key: (op, cl) for (key, op, cl) in sid_kv}
    print(f"WEEKS[2] currently has sids: {sorted(existing_sid_info.keys())}")

    # Plan two kinds of edits:
    #   - new_sid_blocks  → full sid blocks to append before WEEKS[2]'s `}`
    #   - merge_edits     → (abs_pos, text) inserts before an EXISTING sid's `}`
    new_sid_blocks = []
    merge_edits = []
    skipped_fully_present = []

    for sid in by_sid:
        if sid not in existing_sid_info:
            new_sid_blocks.append(render_sid_block(sid, by_sid[sid]))
            continue
        # Sid already exists — find its current subjects and figure out
        # what we still need to inject.
        sid_open_bb, sid_close_bb = existing_sid_info[sid]
        sid_inner = block_body[sid_open_bb+1:sid_close_bb]
        existing_subjects = {k for (k, _, _) in find_top_level_kv_blocks(sid_inner)}
        missing = [s for s in SUBJECT_ORDER if s in by_sid[sid] and s not in existing_subjects]
        already = [s for s in by_sid[sid] if s in existing_subjects]
        if already:
            print(f"  ↪️  {sid}: keeping existing {sorted(already)}; will not clobber")
        if not missing:
            skipped_fully_present.append(sid)
            continue
        print(f"  ➕  {sid}: merging {missing}")
        rendered = '\n'.join(render_subject(subj, by_sid[sid][subj]) for subj in missing)
        # Absolute insertion position = before the sid's closing `}`.
        # block_body[i] sits at src[open_brace+1+i].
        insertion_pos = open_brace + 1 + sid_close_bb
        merge_edits.append((insertion_pos, '\n' + rendered + '\n  '))

    for sid in skipped_fully_present:
        print(f"  ⚠️  {sid} already has every subject we wanted — nothing to do")

    if not new_sid_blocks and not merge_edits:
        print("Nothing new to inject."); return

    if args.dry_run:
        print(f"\n=== Would inject {len(new_sid_blocks)} new sid block(s) and merge into {len(merge_edits)} existing sid(s) ===\n")
        for blk in new_sid_blocks:
            print(blk[:600])
            print("  ... (truncated)" if len(blk) > 600 else "")
        for (pos, repl) in merge_edits:
            print(f"  merge @ src[{pos}]:")
            print(repl[:400])
            print("  ... (truncated)" if len(repl) > 400 else "")
        return

    # Apply ALL edits back-to-front so earlier offsets stay valid.
    # Append-new-sids at close_brace is the rightmost insert; merge edits
    # land at sid-internal positions BEFORE close_brace. Sorting by pos
    # descending preserves correctness.
    all_edits = list(merge_edits)
    if new_sid_blocks:
        all_edits.append((close_brace, '\n' + '\n'.join(new_sid_blocks) + '\n'))
    new_src = src
    for (pos, repl) in sorted(all_edits, key=lambda x: -x[0]):
        new_src = new_src[:pos] + repl + new_src[pos:]

    if new_src == src:
        print("No change."); return

    # Sanity: activity-id count should INCREASE by len(lessons_by_aid)
    before = len(re.findall(r"\bid\s*:\s*'(w\d+-[a-z]+-[a-z]+\d+)'", src))
    after  = len(re.findall(r"\bid\s*:\s*'(w\d+-[a-z]+-[a-z]+\d+)'", new_src))
    delta = after - before
    if delta < 1:
        print(f"❌  Activity count delta is {delta} (expected ≥ 1). Aborting write."); sys.exit(1)

    with open(args.app, 'w') as f: f.write(new_src)
    print(f"✅  Patched WEEKS[2] — {len(new_sid_blocks)} new sid block(s), {len(merge_edits)} merged into existing sid(s). Activity count: {before} → {after} (+{delta}).")

if __name__ == '__main__':
    main()
