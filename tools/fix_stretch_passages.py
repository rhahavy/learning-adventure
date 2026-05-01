#!/usr/bin/env python3
"""
fix_stretch_passages.py — for every activity that hits the
                          stretch-drops-passage lint warning, transform
                          the first stretch question into a
                          type:'passage' carrying the SAME passage as
                          the main pool's passage block.

Why: stretch mode renders only the stretch pool. Reading-comprehension
activities with passage-anchored stretch Qs ("Why did Kira knock
politely?") leave the kid with no story to look at. Cloning the main
passage into stretchQuestions[0] re-anchors the pool — renderQ's
walk-back then carries the passage forward to stretch Qs 2-5.

Strategy:
  1. Walk every `{ id:'w<...>'` object literal in app/index.html
  2. For each, find its main-pool questions:[...] and locate the
     first {type:'passage', passage:'...', ...} block — capture the
     passage text (and visual emoji if present)
  3. Find its stretchQuestions:[...] and locate the first object
  4. If main has passage AND stretch doesn't:
     - Build a new passage block: same passage text, but use the
       existing stretch[0]'s q + choices + answer
     - Replace stretch[0] entirely with the new block
  5. Atomic write to app/index.html

Idempotent — running twice is a no-op (rule looks for "stretch has
NO passage", which is false after first patch).
"""

import argparse, re, sys

DEFAULT_APP = "app/index.html"

def find_balanced(s, i, open_c, close_c):
    """Walk forward from i (position of open_c) to its matching close."""
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

def parse_string_literal_at(s, i):
    """Parse a JS string literal starting at index i (which must be at
    the opening quote). Returns (decoded_text, end_index_inclusive)
    or (None, i) on failure."""
    if i >= len(s): return (None, i)
    quote = s[i]
    if quote not in "\"'`": return (None, i)
    j = i + 1; esc = False
    while j < len(s):
        c = s[j]
        if esc:
            esc = False
        elif c == '\\':
            esc = True
        elif c == quote:
            raw = s[i+1:j]
            return (raw, j)
        j += 1
    return (None, i)

def find_top_level_objects(block_str):
    """Inside a [...] block body (no surrounding brackets), find the
    indices of each top-level { ... } object. Returns [(start, end)] —
    end is the index of the closing brace inclusive."""
    out = []
    j = 0; depth = 0; in_str = None; esc = False; obj_start = None
    while j < len(block_str):
        c = block_str[j]
        if esc: esc = False
        elif in_str:
            if c == '\\': esc = True
            elif c == in_str: in_str = None
        else:
            if c in "\"'`": in_str = c
            elif c == '{':
                if depth == 0: obj_start = j
                depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0 and obj_start is not None:
                    out.append((obj_start, j))
                    obj_start = None
        j += 1
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--app', default=DEFAULT_APP)
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    with open(args.app) as f: src = f.read()

    # We walk back-to-front on absolute offsets so earlier offsets stay
    # valid as we splice. Collect all transformations first.
    edits = []  # list of (replace_start, replace_end_inclusive, replacement_text)
    aid_re = re.compile(r"\{\s*id\s*:\s*['\"](w\d+-[a-z]+-[a-z]\d+)['\"]")
    skipped_no_pool = 0
    skipped_already_has_passage = 0
    skipped_no_main_passage = 0

    for m in aid_re.finditer(src):
        aid = m.group(1)
        brace_start = m.start()
        brace_end = find_balanced(src, brace_start, '{', '}')
        if brace_end < 0: continue
        body = src[brace_start:brace_end+1]
        body_offset = brace_start  # absolute offset of body[0]

        # Find main-pool passage text + visual.
        qm = re.search(r'questions\s*:\s*\[', body)
        if not qm: continue
        qs_start = body.index('[', qm.start())
        qs_end = find_balanced(body, qs_start, '[', ']')
        if qs_end < 0: continue
        main_block = body[qs_start+1:qs_end]
        main_qs = find_top_level_objects(main_block)
        main_passage = None
        main_visual = None
        for (qs2, qe2) in main_qs:
            qsrc = main_block[qs2:qe2+1]
            tm = re.search(r"type\s*:\s*['\"]passage['\"]", qsrc)
            if not tm: continue
            # Find passage:'...'
            pm = re.search(r"passage\s*:\s*", qsrc)
            if not pm: continue
            text, _ = parse_string_literal_at(qsrc, qsrc.index("'", pm.end()) if "'" in qsrc[pm.end():pm.end()+10] else qsrc.index('"', pm.end()) if '"' in qsrc[pm.end():pm.end()+10] else -1)
            # Robust fallback: regex
            pm2 = re.search(r"passage\s*:\s*(['\"])((?:\\.|(?!\1).)*)\1", qsrc, re.S)
            if pm2:
                main_passage = pm2.group(2)
                # Decode minimal escapes
                main_passage = main_passage.replace("\\'", "'").replace('\\"','"').replace("\\\\","\\").replace("\\n","\n")
            vm = re.search(r"visual\s*:\s*(['\"])((?:\\.|(?!\1).)*)\1", qsrc)
            if vm: main_visual = vm.group(2)
            break

        if not main_passage:
            skipped_no_main_passage += 1
            continue

        # Find stretchQuestions block.
        sm = re.search(r'stretchQuestions\s*:\s*\[', body)
        if not sm:
            skipped_no_pool += 1
            continue
        ss = body.index('[', sm.start())
        se = find_balanced(body, ss, '[', ']')
        if se < 0: continue
        stretch_block = body[ss+1:se]
        stretch_qs = find_top_level_objects(stretch_block)
        if not stretch_qs: continue
        # Does stretch already have a passage?
        already = False
        for (qs2, qe2) in stretch_qs:
            qsrc = stretch_block[qs2:qe2+1]
            if re.search(r"type\s*:\s*['\"]passage['\"]", qsrc):
                already = True; break
        if already:
            skipped_already_has_passage += 1
            continue

        # Transform stretch[0]: pull its q/choices/answer, build a new
        # passage-typed object using the main passage text.
        first_obj_start, first_obj_end = stretch_qs[0]
        first_src = stretch_block[first_obj_start:first_obj_end+1]

        q_match = re.search(r"q\s*:\s*(['\"])((?:\\.|(?!\1).)*)\1", first_src, re.S)
        ch_match = re.search(r"choices\s*:\s*\[", first_src)
        ans_match = re.search(r"answer\s*:\s*(\d+)", first_src)
        if not q_match or not ch_match or not ans_match:
            continue
        ch_start = first_src.index('[', ch_match.start())
        ch_end = find_balanced(first_src, ch_start, '[', ']')
        if ch_end < 0: continue
        choices_lit = first_src[ch_start:ch_end+1]
        q_text_raw = first_src[q_match.start():q_match.end()]  # the entire `q:'...'` portion
        # We keep the existing JS-encoded forms verbatim (q text + choices)
        # so we don't risk lossy round-trips through Python's escape model.
        # Build the new object: type:'passage' + passage + (visual?) + q + choices + answer
        # JS-escape the passage text for single-quote literal.
        def js_quote_single(s):
            t = s.replace('\\','\\\\').replace("'","\\'").replace('\n','\\n').replace('\r','\\r').replace('\t','\\t')
            return "'" + t + "'"
        new_pieces = [
            "type:'passage'",
            "passage:" + js_quote_single(main_passage),
        ]
        if main_visual:
            new_pieces.append("visual:" + js_quote_single(main_visual))
        # Use the existing q literal verbatim — already includes "q:'...'"
        new_pieces.append(q_text_raw)
        new_pieces.append("choices:" + choices_lit)
        new_pieces.append("answer:" + ans_match.group(1))
        new_obj = "{" + ",".join(new_pieces) + "}"

        # Compute absolute offsets for splicing.
        abs_start = body_offset + ss + 1 + first_obj_start
        abs_end   = body_offset + ss + 1 + first_obj_end  # inclusive
        edits.append((abs_start, abs_end, new_obj, aid))

    print(f"Activities to patch: {len(edits)}")
    print(f"  skipped (no stretch pool): {skipped_no_pool}")
    print(f"  skipped (stretch already has passage): {skipped_already_has_passage}")
    print(f"  skipped (no main-pool passage): {skipped_no_main_passage}")
    if not edits:
        return

    if args.dry_run:
        for (s, e, repl, aid) in edits[:5]:
            print(f"  - {aid} would replace {e - s + 1} chars with {len(repl)}-char passage block")
        return

    # Splice back-to-front so offsets stay valid.
    new_src = src
    for (s, e, repl, _aid) in sorted(edits, key=lambda x: x[0], reverse=True):
        new_src = new_src[:s] + repl + new_src[e+1:]

    # Sanity guard.
    before_passages = len(re.findall(r"type\s*:\s*['\"]passage['\"]", src))
    after_passages  = len(re.findall(r"type\s*:\s*['\"]passage['\"]", new_src))
    delta = after_passages - before_passages
    if delta != len(edits):
        print(f"⚠️  passage count delta {delta} != edits {len(edits)} — review carefully")
    if abs(len(new_src) - len(src)) > 5_000_000:
        print(f"❌  size delta too large ({len(new_src) - len(src)}) — aborting"); sys.exit(1)

    with open(args.app, 'w') as f: f.write(new_src)
    print(f"✅  Patched {len(edits)} activities. Passage blocks: {before_passages} → {after_passages} (+{delta}).")

if __name__ == '__main__':
    main()
