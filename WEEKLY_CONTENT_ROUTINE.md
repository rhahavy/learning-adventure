# Weekly Content Routine — How to keep the levels fresh

Solvix's "week" clock is per-student — it starts the moment a kid first
logs in, and rolls forward every 7 days. So Isaiah might be on his Week 3
while Akaran is still on Week 1. Whenever anyone's clock advances past
the most recent WEEKS[N] you've authored, the app shows a "you're ahead,
more coming soon" banner and keeps them practicing the last authored
week until you ship the next one.

That means content authoring is the **one** ongoing operational task
that doesn't automate itself end-to-end. This doc is the ritual for
keeping up without burning out.

---

## The Saturday 30-minute ritual

Do this every Saturday. It sits naturally next to the weekly parent
email (which ships Sunday morning on cron).

### 1. Check who's rolling into a new week

```bash
# From the repo root
node scripts/who-is-due.mjs   # (optional — if you haven't built this yet,
                              #  just glance at the teacher dashboard)
```

Or just open the teacher dashboard on the live site — each student
shows their own week number + progress.

Anyone whose **raw** week (from joinedAt) is greater than their displayed
capped week is about to hit the "you're ahead" banner. They need fresh
content.

### 2. Draft next week's content — all students at once

One command builds a personalized prompt for every student:

```bash
node scripts/draft-week.mjs --week 2 --out-dir /tmp/kidquest-w2
```

This:
- Fetches the cloud blob ONCE (shared across students — no wasted requests).
- For each of the 6 students, summarizes their completed activities,
  first-try-perfects, struggles, and recent wrong-answer concepts.
- Writes a per-student Claude-ready prompt to
  `/tmp/kidquest-w2/<student-id>.prompt.txt`.
- Prints the file paths to stdout so you can see exactly what it wrote.

Why per-file instead of one mega-prompt: Claude gives better output when
it's focused on one kid at a time. Isaiah (Grade 5) and Akaran (Grade 1)
need completely different vocabulary and math — keep those conversations
separate so neither one is compromised by averaging.

**To use:** open each file, paste into its own Claude session (Claude
Code CLI, claude.ai, Claude Desktop — all work). Claude gives you a
draft `WEEKS[2].<student-id>` block.

You can still target a single student if you're patching in the middle
of the week:

```bash
node scripts/draft-week.mjs --student isaiah --week 2
```

> **Why not have Claude do this automatically from a GitHub Action?**
> Because educational content for a tutoring business is your product.
> You want eyes on every activity before it ships. The script + paste
> flow keeps you in the loop without making the work feel heavy.

### 3. Review + tweak

Skim the draft. Common tweaks:
- Age-appropriateness: "this math problem is too easy / too hard for Grade N"
- Cultural fit: swap a passage for one that resonates with the kid
- Concept emphasis: if the kid has been struggling on a specific concept
  you know about but isn't surfaced in wrong-answers (maybe they haven't
  attempted it yet), nudge Claude to include it

### 4. Paste into index.html

In `index.html`, find the `const WEEKS = { 1: { … } };` block. Add the
next week as a sibling:

```js
const WEEKS = {
  1: { /* existing */ },
  2: {
    isaiah:   { reading:[...], writing:[...], /* etc */ },
    akshayan: { /* ... */ },
    // ... all students who need Week 2 content
  },
};
```

A few plumbing rules the app already handles for you:
- `MAX_AUTHORED_WEEK` is computed at load time from `Object.keys(WEEKS)`,
  so just adding the `2:` key is enough. No version bump, no flag flip.
- The activity id pattern `w<N>-<student>-<subjPrefix><n>` is what the
  email grouper + subject parser keys off. Keep it consistent.
- Axel clones from Akshayan at load time (see `addAxelWeek1Spelling`
  and the Axel cloning block — line ~4381). If you want Axel to have
  HIS OWN Week 2 content, add it explicitly under `WEEKS[2].axel`.
  Otherwise add the same clone call for Week 2.

### 5. Test locally

```bash
python3 -m http.server 8080
# Open http://localhost:8080
```

- Log in as the student whose Week 2 you just added.
- If their joinedAt puts them in Week 2, they should see the new
  content on the dashboard. If they're still in Week 1, temporarily set
  their `joinedAt` to 10 days ago in DevTools:
  ```js
  // In the browser console, AS THE TEACHER
  allData.users.isaiah.joinedAt = Date.now() - 10 * 24 * 60 * 60 * 1000;
  saveState();
  ```
  Log out and back in as Isaiah — his dashboard should now say "Week 2".

### 6. Commit + push

```bash
git add index.html
git commit -m "Add Week 2 content for Isaiah, Akshayan, ..."
git push origin main
```

GitHub Pages deploys automatically. The live site updates within ~1 min.

---

## How much content to bank ahead

**Minimum:** stay 1 week ahead of your most-active student. If Isaiah
signs in daily and his joinedAt is April 10, he hits Week 2 on April 17.
Ship Week 2 by April 15 at the latest.

**Comfortable:** 2 weeks ahead of everyone. Gives you a buffer week
(vacations, busy weeks, sick days).

**Nice to have:** one full term (8–12 weeks) banked during a focused
weekend sprint. Refresh each quarter. The Saturday routine then becomes
"tweak + append" rather than "author from scratch."

---

## Troubleshooting

### "I forgot to ship Week N and a kid hit the boundary"
They see the "🎉 You're ahead of the curriculum!" banner and replay
the last authored week. No error, no blank screen. You have a grace
period — ship it by next session.

### "The draft Claude gave me doesn't match the JS format in index.html"
Most likely Claude wrapped strings that contain apostrophes in single
quotes without escaping. Easiest fix: do a find-and-replace on obvious
issues (`it's` → `it\'s` or switch the outer quotes to double), or ask
Claude to re-emit with "use double-quoted strings everywhere."

### "One student's history is much deeper than others'"
Run `draft-week.mjs` per-student. The history is embedded in each
prompt, so Isaiah's draft will look very different from Akaran's.
Don't try to author one combined prompt.

### "The kid's joinedAt is wrong — they logged in weeks ago but it says week 1"
`joinedAt` is lossy-backfilled when the field didn't exist yet, so old
accounts may have a joinedAt of whenever you rolled this out. You can
edit it directly in the teacher dashboard (or in DevTools) — any valid
epoch-ms timestamp works.

---

## Related docs
- `WEEKLY_REPORTS_SETUP.md` — automated parent email (Sundays 14:00 UTC)
- `scripts/draft-week.mjs` — the prompt builder (read the header for flags)
- `scripts/send-weekly-reports.mjs` — the email sender
