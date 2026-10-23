# Damiland CBT

A computer-based test (CBT) web app for SS3 students, built entirely on Cloudflare
(Workers + static assets + D1 database). No separate server to run or pay for.

## What it does

**Students** log in with their code (e.g. `DAMILANDCBT001`) and password, sit **Use of English + their
subject group**, 50 objective questions per subject (options A–D), with a server-controlled timer.
Questions are shuffled per student; answer options keep their A–D order. Science students get a
built-in calculator. Scores stay hidden until the admin releases them; once released, the student can **print their result slip, save it as a PDF, or download it as a CSV** from the result screen (same slip as the admin's).

| Group | Subjects (plus Use of English) |
|---|---|
| 1 | Government, Literature, CRS |
| 2 | Mathematics, Physics, Chemistry |
| 3 | Biology, Physics, Chemistry |
| 4 | Mathematics, Economics, Account |

**Admins** (separate login at `/admin`) can:

- **Overview** – charts of registrations, progress and scores
- **Monitor** – live, animated view of the running exam: a pulsing LIVE badge, class progress bar, a
  card per student with a progress ring and countdown (amber under 5 min, red and pulsing under 1 min),
  an activity feed (started, halfway, 5 min left, submitted), cards/table views, sorting, and a full-screen
  mode for a projector. Refreshes every 5 s; confetti when everyone has submitted
- **Students** – register (first + last name, class), edit, view or reset a password, allow an archived retake with a reason, download attempt history, delete
  (only if the student has not started), print login slips
- **Questions** – add/edit/delete, CSV import (template in `public/questions-template.csv`),
  symbols for maths/science
- **Results** – release or hide scores (one or all), filter by class, download CSV,
  **print a result slip per student or all slips in bulk** (one A4 page each, respects the class filter)
- **Settings** – exams of the session (name, length, make live), academic sessions, add/remove admins, change own password

### Exams inside a session
A session can hold several exams (First Term, Mock, Second Term…). **Students belong to the session;
questions, results and exam length belong to the exam.** Only one exam is **live** at a time, and it is the
one students sit. Create one in **Settings → Exams in this session → Start a new exam** (optionally copy the
questions of another exam). Starting a new exam makes it live, and anyone still writing the previous
exam is submitted and marked. Older exams stay viewable (read-only, results can still be released/hidden)
from the **Exam** menu in the sidebar, and **Make live** switches back to one. Students can sit each exam once.

### Academic sessions
Each session (e.g. `2026/2027`) has its own students and exams. Student codes restart at
`001` in each session. Only the **current** session can log in; older sessions are read-only (except
releasing results). Start a new year in **Settings → Academic sessions → New session** (you can copy
the live exam's questions across). The new session starts with one exam, "Exam 1" (rename it in Settings).

## Project layout

```
public/        pages (login, admin console, exam, monitor, results…) + app.css, shell.js, format.js
src/           Worker API (Hono): index.ts, auth.ts, exam.ts, exams.ts, questions.ts, results.ts, settings.ts, limits.ts, crypto.ts
migrations/    0001–0011 D1 migrations (run in order)
scripts/       make-admin.mjs  (create / reset an admin)
wrangler.jsonc Cloudflare config
```

## Exam integrity and release checks

Pending answers survive a refresh on the same browser when storage is available. Submission waits for acknowledgements, and delayed answer revisions cannot overwrite newer choices. Every chosen subject needs 50–80 bank questions. **The first student start locks the entire paper, name and duration permanently**; finish all intended uploads first. Copy a paper into a new exam for changes. Retakes preserve the original sitting.

Read [the release and 70-student rehearsal guide](docs/exam-release.md) before a live exam.

## Run locally (Windows / PowerShell)

Use Node 24 LTS (minimum 22.13 for the SQLite regression tests).

```powershell
npm ci
echo JWT_SECRET=any-long-random-text-here > .dev.vars     # never commit this file
npx wrangler d1 migrations apply damiland-cbt --local
node scripts/make-admin.mjs --local you@example.com "a-strong-password"
npm run dev                                                # http://localhost:8787
```

Students log in at `/`, admins at `/admin`.

## Deploy

The GitHub repo (`Bakareferanmi/damilandcbt`) is connected to Cloudflare, so **pushing to the main
branch deploys automatically**. You can also deploy by hand with `npx wrangler deploy`.

**Migration 0011 must be applied before deploying this version.** Existing attempts and scores are retained, earlier papers are locked, score totals are backfilled, and session versions support password-reset revocation. Schedule maintenance; do not update during a sitting.

First time / after any new migration, apply migrations to the live database **before** the deploy:

```powershell
npx wrangler d1 export damiland-cbt --remote --output backup.sql   # backup first
npx wrangler d1 migrations apply damiland-cbt --remote
```

One-time live setup:

```powershell
npx wrangler secret put JWT_SECRET                                 # long random text
node scripts/make-admin.mjs --remote you@example.com "a-strong-password"
```

Migration `0008_answered_counter.sql` adds a running "answered" count to each attempt so the Monitor no longer recounts every answer on every refresh (about 350 times fewer database reads). **Apply it to the live database BEFORE deploying the code that uses it.**

Migration `0009_attempts_expiry_index.sql` swaps one index so the Monitor's "has anyone run out of time?" check reads nothing when nobody has. It only affects speed, so it is safe to apply before or after deploying.

Migration `0010_student_password_enc.sql` adds a column for the encrypted student password (see Security notes). **Apply it to the live database BEFORE deploying the code that uses it.** Optionally set a separate key first: `npx wrangler secret put PASSWORD_KEY` (and add `PASSWORD_KEY=...` to `.dev.vars` locally).

Migration `0007_exams.sql` (exams inside sessions) rebuilds the attempts table. It keeps all existing
data (each session's existing questions and results become "Exam 1"), but **take the backup above first**.

### Custom domain (later)
When the domain is bought: Cloudflare dashboard → Workers & Pages → damiland-cbt → Settings →
Domains & Routes → Add custom domain. No code changes needed.

## Security notes

- Admin and student logins are checked against a PBKDF2 hash. For students, an **encrypted copy** of the password
  (AES-256-GCM) is also kept so an admin can click **View password** on the Students page when a student forgets it.
  The key comes from the Cloudflare secret `PASSWORD_KEY` (or `JWT_SECRET` if `PASSWORD_KEY` is not set), so a copy of
  the database alone cannot reveal passwords. **Do not change that secret** after students are registered, or the saved
  passwords can no longer be read (admins can still reset them). Students registered before migration `0010` have no
  saved password: reset it once and it becomes viewable. Admin passwords are never viewable.
- 5 wrong logins in 15 minutes locks that account **for that device/network only** for 5 minutes (so nobody else can lock a student out). Wrong guesses for codes or emails that do not exist are not stored.
- A removed admin loses access immediately. API replies are never cached (`no-store`), and `public/_headers` adds a Content-Security-Policy and other browser protections.
- Ending a running exam (new exam, make live, new session) asks again with the number of students still writing; the server refuses without that confirmation.
- Login uses an httpOnly cookie valid for 8 hours. Password changes/resets invalidate earlier cookies. Admin password lookups are audited; retake authorisations are retained with the archive.
- Never commit `.dev.vars`. Use a different, strong admin password on the live site.
- Back up the database before migrations, sessions and exams, and again after each exam. Verify a restore into a separate database.

## Troubleshooting

- **"Something went wrong on the server"** – check the terminal running `npm run dev`.
- **`npm run dev` seems to hang** – it is the running server; leave it open.
- **Group says "not ready"** – each subject of the chosen group must have 50–80 bank questions in the live exam.

### Random question banks (migration 0012)
Teachers/admins can add up to 80 questions per subject, manually or by CSV. At least 50 are required to start. Each new attempt gets 50 random questions per subject, persisted by the database atomically at start. Refreshing or reconnecting keeps that selection. Only assigned questions can be answered and marked; each subject is scored out of 50. Question order is also shuffled per attempt. With only 50 in a bank, everyone has the same set; upload 80 for variation. Some overlap is expected and independently random sets are not guaranteed unique. Existing attempts and results retain their original paper. Retake archives include allocated question IDs.

Apply `npm run db:migrate:remote` then deploy the matching API with `npm run deploy`, during a maintenance window with no new starts until deployment finishes. Migration 0012 and the API must both be installed before using larger banks. Existing locked papers remain locked; copy into a new exam to add more questions.

### Tab departure flags (migration 0013)
Apply `npm run db:migrate:remote` before deploying this API. The exam page reports hidden-tab transitions (including minimising the browser) and queues reports locally for retries after reconnect or refresh. The teacher's Monitor shows persistent counts and latest event times in cards/table, a flagged-student summary, and activity alerts on the next successful poll (normally 5 seconds). Keep Monitor open and unpaused. This does not send email, push or sound notifications.

Students see a notice before starting. A flag never submits or fails an exam. Browser reports can be blocked or manipulated and cannot identify what a student viewed, detect another device, or prove cheating. Page closure/reloading is not reliably detected. Event times come from the student's device and are labelled review evidence; the database also stores server receipt times. Up to 500 events per attempt are retained. Retakes archive reports before deleting the active attempt. Monitor progress uses allocated question totals, so an 80-question bank still shows 200 assigned questions.
