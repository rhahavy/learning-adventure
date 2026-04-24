# Weekly Parent Reports — Setup Guide

This repo ships with an automated weekly-email pipeline that sends each
student's parent a Solvix progress report every Sunday. Everything runs
from GitHub Actions; nothing needs to live on your laptop.

**Pipeline at a glance**

```
GitHub Actions (Sunday cron)
    → scripts/send-weekly-reports.mjs
        → GET    textdb.dev  (read current student state)
        → POST   api.resend.com/emails  (send one email per due student)
        → POST   textdb.dev  (stamp lastReportSentAt, merged into fresh state)
```

The script is self-contained — no `npm install`, no `package.json`, no
dependencies beyond Node 20's built-in `fetch`.

---

## 1. One-time setup

### 1a. Sign up for Resend (free tier is plenty)

1. Go to <https://resend.com>, create an account.
2. **Add your domain** (e.g. `kidquest.fun`) and verify it by adding the DNS
   records Resend shows you. Until the domain is verified, Resend will only
   let you send to the email you signed up with.
3. Under **API Keys**, create a new key scoped to "Send emails". Copy the
   value — you won't be able to see it again.

You can skip the custom domain and use Resend's sandbox domain
(`onboarding@resend.dev`) for testing, but deliverability to real Gmail
inboxes will be spotty.

### 1b. Add secrets and vars on GitHub

Go to **Settings → Secrets and variables → Actions** on this repo.

**Secrets** (sensitive — blurred in logs):

| Name             | Example value                                    | Required? |
| ---------------- | ------------------------------------------------ | --------- |
| `RESEND_API_KEY` | `re_xxxxxxxxxxxxxxxxxxxxxxxx`                    | **Yes**   |
| `FROM_EMAIL`     | `Solvix Reports <admin@kidquest.fun>`        | Optional  |
| `CC_EMAIL`       | `admin@kidquest.fun`                            | Optional  |

- `RESEND_API_KEY` is the only truly required one. Without it the script
  runs in forced dry-run mode.
- `FROM_EMAIL` defaults to `Solvix Reports <admin@kidquest.fun>`.
  Override it if you haven't verified that domain on Resend — use something
  like `Solvix <onboarding@resend.dev>` while testing.
- `CC_EMAIL` defaults to `admin@kidquest.fun`. Set to an empty value to
  disable the CC.

**Variables** (non-sensitive — visible in logs):

| Name            | Default                              | What it does                              |
| --------------- | ------------------------------------ | ----------------------------------------- |
| `DASHBOARD_URL` | `https://kidquest.fun`               | Link in the email "Open the dashboard" CTA |
| `CLOUD_BUCKET`  | `kidquest-dca83c70e20a70f247b6`      | textdb.dev bucket ID (must match web app) |

You only need to set these if you want to override the defaults (e.g.
pointing at a staging bucket).

---

## 2. Test it (safely)

The first run should always be a dry run. The script will log exactly what
it *would* send, without actually emailing anyone.

1. Go to the **Actions** tab on this repo.
2. Pick **Weekly Parent Reports** in the left sidebar.
3. Click **Run workflow**.
4. Leave **Dry run** checked (it defaults to `true`).
5. Click the green **Run workflow** button.

Open the run when it finishes and expand the "Send reports" step. You'll see
lines like:

```
[weekly-reports] Fetching cloud state: https://textdb.dev/api/data/kidquest-…
[weekly-reports] Will process 2 student(s): isaiah, akshayan
[weekly-reports] isaiah: Solvix weekly report — Isaiah (…) → parent@example.com
[weekly-reports]   (dry-run) preview:
  Solvix — Weekly Progress Report
  Student: Isaiah (Grade 5)
  …
```

If the list of students is empty, it just means nobody is currently due — see
the "When does a student get an email?" section below.

---

## 3. Send a real report (manual)

Same flow as the dry run, but **uncheck the "Dry run" box** before clicking
"Run workflow". Emails go out immediately through Resend. The script only
stamps `lastReportSentAt` on students it actually emailed successfully — if
Resend rejects one parent's address, the rest of the batch still sends.

---

## 3b. Test mode (send yourself a sample email)

Useful before the `kidquest.fun` domain has finished verifying, or any time
you want to confirm the Resend wiring end-to-end without waiting for a real
student to have 7 days of history.

1. **Actions** → **Weekly Parent Reports** → **Run workflow**
2. Uncheck **Dry run**
3. Fill in **Test recipient** with your own email address (the one you used
   to sign up for Resend — e.g. `admin@kidquest.fun`)
4. **Run workflow**

The script sends ONE sample email with demo data, using
`Solvix Test <onboarding@resend.dev>` as the From. This works before your
domain is verified because `onboarding@resend.dev` is Resend's pre-verified
sandbox address.

Test mode **bypasses** the `parentEmail` requirement, the 7-day gate, and
the `MIN_ACTIVITIES` check. It does **not** touch any real student's
`lastReportSentAt`, so it can't interfere with the real weekly cadence.

Once the domain is verified, leave the "Test recipient" box empty on future
runs and the normal batch logic takes over.

### Test-mode env overrides
Inside the workflow, `TEST_RECIPIENT` and `TEST_FROM` control this mode. You
can also run it locally:

```bash
RESEND_API_KEY=re_... TEST_RECIPIENT=you@example.com \
  node scripts/send-weekly-reports.mjs
```

---

## 4. Let the cron take over

Once the manual dry run looks right, you don't need to do anything else.
The workflow is scheduled for **every Sunday at 14:00 UTC** (10:00 EDT /
09:00 EST). It runs whether your laptop is on or off, whether you're awake
or not. That's the whole point.

To change the schedule, edit the `cron:` line in
`.github/workflows/weekly-reports.yml`. GitHub uses standard 5-field cron
syntax, in UTC.

> **Note:** GitHub sometimes delays scheduled runs when the Actions system
> is under load — a ±15 minute drift is normal. The report window is in
> days, so this doesn't matter.

---

## When does a student get an email?

A student is included in a run when **all** of these are true:

1. `user.parentEmail` is set on their profile.
2. `user.joinedAt` is set (they have logged in at least once after the
   `joinedAt` field shipped).
3. `max(lastReportSentAt, joinedAt) + 7 days ≤ now`.
4. If `MIN_ACTIVITIES` is set in the workflow env, they've completed at
   least that many activities this week.

That means:

- A student who just created a login gets their first report **7 days
  later**, not the next Sunday after.
- A student with no parent email is silently skipped (no error).
- If the cron fires but nobody is due, the workflow finishes cleanly with
  "Nothing to send this run."

---

## Troubleshooting

### "Resend 403: domain not verified"
You set `FROM_EMAIL` to an address on a domain that isn't verified on
Resend yet. Either finish verification, or temporarily set `FROM_EMAIL` to
`Solvix <onboarding@resend.dev>` for testing.

### "No RESEND_API_KEY in env — forcing dry-run" in every run
The secret isn't set, or the workflow can't read it. Secrets are
case-sensitive; make sure it's named exactly `RESEND_API_KEY`.

### Parent didn't get the email, but the action succeeded
- Check the Resend dashboard **Logs** tab — Resend tells you if Gmail/Yahoo
  bounced, greylisted, or filed the message to spam.
- Have the parent add the From address to their contacts.

### Emails going out but stats look wrong
The script reads only what the web app wrote to `textdb.dev`. If the teacher
dashboard looks fine but the email doesn't, force a sync from the web app
first (wait ~30s after any change) and re-run.

### I want to skip a week
Disable the workflow temporarily: **Actions → Weekly Parent Reports → …
menu → Disable workflow**. Re-enable when you want it back.

---

## Local testing (optional)

You can run the script from your laptop without touching GitHub Actions:

```bash
# Dry run — no email sent, just logs
DRY_RUN=true node scripts/send-weekly-reports.mjs

# Real send — needs a Resend key with a verified sender
RESEND_API_KEY=re_... FROM_EMAIL="Solvix <onboarding@resend.dev>" \
  node scripts/send-weekly-reports.mjs
```

Node 20+ is required (for built-in `fetch`).
