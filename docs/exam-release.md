# Exam release and rehearsal

## What this change protects

- Exactly 50 questions are required in each subject of a student's group before they can start.
- The **first start permanently locks the whole paper**, including its name and duration. Finish uploading every intended subject before distributing logins. Copy the questions into a new exam to change a locked paper. Retakes do not unlock it.
- Pending choices are stored on the same browser, separately for each student and attempt. A choice is labelled saved only after the server acknowledges its revision. Refresh and lost-response recovery reconcile with the server.
- Requests from an old sitting cannot change or submit a replacement sitting. Delayed old revisions cannot overwrite newer choices.
- Voluntary submission waits for saves and stops if saving fails. Submission retries are safe. At expiry, the server marks only accepted answers; remaining local choices stay on the device and the student sees a warning.
- **The timer never pauses during an outage.** The existing ten-second server grace remains. Browser storage does not authorise accepting late answers. Invigilators must decide an accommodation/retake policy before the exam.
- Retakes retain the old answers, score, totals, timing, authorising admin ID and reason. Staff can download them from **Students → Attempt history**. Archived students cannot be deleted.
- Password changes/resets revoke earlier login cookies. Admin password lookup is recorded in `audit_events`. Retake authorisation is recorded with the archived attempt.

Browser storage can be disabled or cleared. The page warns if it cannot persist pending choices. Use one tab per student and do not clear browser data during an exam. A different device cannot recover choices which never reached the server.

## Validation commands

Use Node 24 LTS (minimum 22.13):

```sh
npm ci
npm run typecheck
npm test
npm run test:exam-simulation
npx wrangler deploy --dry-run
```

The regression suite executes the actual API against an isolated SQLite adapter and exercises the browser queue/submission functions. The simulation uses 70 distinct students and 200 questions per student, revisions, delayed retries and duplicate submissions. Neither measures Cloudflare latency, CPU usage or D1 quotas. Page scripts are syntax-checked; real-browser and venue checks below are still required.

## Approved release sequence

Do not merge or deploy this change during a sitting. Main automatically deploys through the existing Cloudflare integration. Review the PR and schedule a maintenance window first.

1. Record the current production Worker version. Export the production database and retain the SQL file in two restricted locations, one outside Cloudflare. Record a D1 Time Travel bookmark too.
2. Restore an export into a **separate test database**. Verify students, attempts, answers and scores and inspect sample released result slips. Test backups with pre-existing data, not only empty tables.
3. Apply migration `0011_exam_integrity.sql` on staging before deploying the matching staging code. Run the rehearsal below.
4. Once release is approved, take a fresh production export, then apply the migrations **before** merging/deploying the API. Do not change encryption secrets as part of this release.
5. Confirm schema migration 0011, the deployed commit, successful logins, a complete synthetic exam, result release, archived retake history and printing. Reload browsers that had the older exam page open; old clients receive a refresh error on saves.
6. After the real exam, export the database and results again. Retain dated backups by academic session and test restores periodically.

Example commands below target production and must only be run in the approved maintenance window:

```sh
npx wrangler d1 export damiland-cbt --remote --output pre-release-backup.sql
npx wrangler d1 time-travel info damiland-cbt
npx wrangler d1 migrations apply damiland-cbt --remote
```

Migration 0011 retains existing data and locks papers with earlier attempts. It freezes the existing totals at migration time; it cannot reconstruct papers or answer keys already edited before this fix. If an old paper had fewer than 50 questions, its records remain readable, but a new sitting requires a correctly prepared new exam.

The migration adds columns and triggers. Rolling back only the Worker does not remove those safeguards. Restore a database backup only with a deliberate recovery plan: restoring overwrites newer exam activity. Export the current database before any restore, keep both exports, and verify the chosen recovery point.

## 70-student Cloudflare rehearsal

Use a separate Worker and D1 database. Confirm the staging binding points to a different database ID before creating synthetic students. Never run a load generator against production without separate approval.

Prepare 70 unique synthetic accounts, all four groups, 50 questions per intended subject, and a known answer key. No real student details or passwords belong in test files. Keep the same indexes, migrations, exam duration and Cloudflare plan as production.

| Phase | Workload | Required evidence |
| --- | --- | --- |
| Start burst | All 70 log in and start within 10–20 seconds. | One attempt each; no missing questions; no authentication or CPU-limit failures. |
| Sustained sitting | 70 distinct cookie sessions over the intended duration; about 200 initial choices each plus 10% revisions. | Save p50/p95/p99, error rate and exact acknowledged choices. At 120 minutes the baseline is about two saves per second across the class, with bursts above that. |
| Monitor | One active invigilator monitor; repeat with the expected number of monitors. | Stale indicator on disconnect; D1 read usage and query duration remain within budget. |
| Reconnect | Disconnect a subset for 30–60 seconds and reconnect together. Also refresh a browser with pending work. | Pending choices recover on the same browser; requests remain bounded; old revisions cannot overwrite new choices. |
| Finish burst | Submit all 70 within five seconds, duplicate selected requests and drop a submit response. | Exactly one completed sitting and four score rows per student; retries return confirmation. |
| Deadline | Place selected attempts just before expiry; lose connectivity until after the grace period. | Late choices rejected, accepted answers marked correctly, pending-loss warning shown. |
| Integrity | Compare the final stored choices, known answer key and scores. | Zero lost acknowledged choices, exact scores and fixed totals, no duplicate sitting. |
| Venue | Use representative real devices on the school network, including weak coverage areas. | Stable Wi-Fi, usable screens and printing, a power/network contingency and a designated invigilator. |

Initial performance target: save p95 below two seconds and no persistent server, overload or quota errors. Correctness targets are mandatory even if latency targets pass. Review Worker request/CPU metrics and D1 rows read/written before and after each phase; save requests are not the same as billable rows. Leave headroom for retries, monitoring and other traffic on the account. Capture logs without credentials or answer payloads.

Use the regression tests' failure scenarios in real browsers. A Node/SQLite simulation passing does not establish a Wi-Fi device limit or production capacity. Launch only after the staging rehearsal and backup restore pass.
