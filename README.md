# Damiland CBT

A computer-based test (CBT) web app for SS3 students, built entirely on Cloudflare
(Workers + static assets + D1 database). No separate server to run or pay for.

## What it does

**Students** log in with their code (e.g. `DAMILANDCBT001`) and password, sit **Use of English + their
subject group**, 50 objective questions per subject (options A–D), with a server-controlled timer.
Questions are shuffled per student; answer options keep their A–D order. Science students get a
built-in calculator. Scores stay hidden until the admin releases them.

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
- **Students** – register (first + last name, class), edit, view or reset a password, allow retake, delete
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
migrations/    0001–0010 D1 migrations (run in order)
scripts/       make-admin.mjs  (create / reset an admin)
wrangler.jsonc Cloudflare config
```

## Run locally (Windows / PowerShell)

```powershell
npm install
echo JWT_SECRET=any-long-random-text-here > .dev.vars     # never commit this file
npx wrangler d1 migrations apply damiland-cbt --local
node scripts/make-admin.mjs --local you@example.com "a-strong-password"
npm run dev                                                # http://localhost:8787
```

Students log in at `/`, admins at `/admin`.

## Deploy

The GitHub repo (`Bakareferanmi/damilandcbt`) is connected to Cloudflare, so **pushing to the main
branch deploys automatically**. You can also deploy by hand with `npx wrangler deploy`.

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
  passwords can no longer be read (admins can still reset them). For students registered before migration `0010` the old
  password was never saved; **View password** then offers to create a new one (the old one stops working). Admin passwords are never viewable.
- 5 wrong logins in 15 minutes locks that account **for that device/network only** for 5 minutes (so nobody else can lock a student out). Wrong guesses for codes or emails that do not exist are not stored.
- A removed admin loses access immediately. API replies are never cached (`no-store`), and `public/_headers` adds a Content-Security-Policy and other browser protections.
- Ending a running exam (new exam, make live, new session) asks again with the number of students still writing; the server refuses without that confirmation.
- Login uses an httpOnly cookie valid for 8 hours.
- Never commit `.dev.vars`. Use a different, strong admin password on the live site.
- Back up the database before migrations and before each new session.

## Troubleshooting

- **"Something went wrong on the server"** – check the terminal running `npm run dev`.
- **`npm run dev` seems to hang** – it is the running server; leave it open.
- **Group says "not ready"** – that subject set has fewer than 50 questions in the current session.
