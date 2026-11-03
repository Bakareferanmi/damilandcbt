# SS1 and SS2 Digital Technologies

This adds two independent class spaces to the existing Damiland CBT application. The original SS3 student list, subject groups, question banks, attempts, scoring and released results remain in their existing tables and routes.

## Deploy

From the configured project folder, update the source, install the locked dependencies, apply migration `0015_digital_technologies.sql`, then deploy:

```powershell
git pull --ff-only origin main
npm ci
npm run typecheck
npm run db:migrate:remote
npm run deploy
```

Stop if any command fails. Apply the migration before allowing SS1/SS2 students to log in. No new Cloudflare database or secret is required. Existing `JWT_SECRET` and optional `PASSWORD_KEY` bindings are reused. Only new `digital_*` tables and triggers are introduced. The migration creates one draft Digital Technologies paper for each class in the currently selected academic session. It does not change the SS3 live-exam setting or copy its questions.

## Set up a class

1. Sign in as an admin and open **Digital Technologies** in the sidebar.
2. Choose **SS1** or **SS2**, then its exam. The academic session selector still applies; past sessions are read-only. The SS3 exam selector is intentionally absent here.
3. Upload the class's CSV using the on-page template, or add questions manually. Required columns are `question,a,b,c,d,correct`. `correct` must be A, B, C or D. An optional `class` or `cohort` column must match the selected class. An optional `subject` column must identify Digital Technologies. Invalid rows and rows beyond capacity are skipped with reasons. Quote question/option text containing commas, quotes or line breaks.
4. Each paper holds **at most 70 questions**. At least **30** are required before entry can open. Students receive exactly **30 distinct randomly selected questions**. Independently selected sets may overlap; unique papers for every student are not guaranteed. With only 30 questions, everyone receives the same set in a random order.
5. Set the duration before anyone starts. The default is **30 minutes**, configurable from 10 to 180 minutes. After the first start, the question bank, name and duration lock at the database boundary. For another sitting, create a new exam, optionally copying the existing class bank. This preserves the old results.
6. Register students in the selected class. Their codes look like `SS1-DT-001` or `SS2-DT-001`. Student records belong to the class and academic session; they can sit subsequent papers in that same class/session. Download login details as CSV and share each student's password privately. Admin password reset revokes the corresponding student's Digital Technologies sessions.
7. Press **Open exam**. **Close entry** stops new starts; students already writing can finish. One paper per class/session may be open at once. A different paper cannot displace writers, and the academic session cannot change while a Digital Technologies attempt remains unsubmitted. Review each class's Results tab to finalise any expired sittings before changing sessions.
8. **Results & monitor** shows saved answer counts, writing/submitted status, scores and tab departure flags. Refresh manually or opt into a 15-second refresh while visible. Release results when ready, or hide them again. Submitted results export as a class- and exam-scoped CSV.

## Student access

- `/digital?class=SS1` opens the SS1 login selection.
- `/digital?class=SS2` opens the SS2 login selection.
- The existing main student login links to the new Digital Technologies login. SS3 keeps its original login and `/exam` route.

Students choose their class and use the credentials supplied by their teacher. The signed identity, not the URL selector, determines their class and paper. The dedicated HttpOnly `digital_session` cookie is scoped to `/api/digital`; it cannot act as an SS3 student or administrator. Every server request checks the student and current academic session, and class boundaries are enforced again when a paper starts.

Starting an attempt and allocating its 30 questions happen together in SQLite triggers. Assigned questions and their random order are stored once. Refresh, reconnect and repeated start requests retain that paper and its server deadline. Student responses do not include correct-answer keys. Only assigned questions can be answered.

Each answer uses the existing revision-aware local recovery queue and is removed from pending storage only after a matching server acknowledgement. A failed save remains visible and retries on reconnect. Normal submission waits for pending saves. An expired paper is marked from the answers the server accepted; locally queued answers that were not acknowledged are reported to the student rather than represented as saved. The timer uses the server's remaining time and a monotonic browser clock. The server allows a 10-second network grace period, then rejects late saves. Refreshing does not restart the timer.

Each correct answer earns **one mark**, so Digital Technologies is scored **out of 30** with a percentage. The existing SS3 double-mark/JAMB scoring remains separate. Scores stay hidden from students until released by an admin. Submitting twice does not mark or change the score again. Tab departures use the existing retryable focus tracker; they are review flags, not proof of misconduct.

Passwords are hashed for login and encrypted for admin credential downloads using the existing application key. Neither password hashes nor encrypted values are returned in class lists. Credential downloads and API responses are no-store. Keep login CSV files private. Lists and monitor responses show at most 500 students and clearly indicate when limited.

## Verification

`npm run typecheck`, `npm test`, `npm run test:exam-simulation` and `npx wrangler deploy --dry-run` cover the code and Worker bundle. New SQLite-backed tests exercise both class banks, random allocation, persistence, access boundaries, answer revisions, expiry, scoring, result release, password revocation, CSV isolation, atomic validation, content locks, and preservation of existing SS3 rows. DOM integration tests run the actual admin/student scripts against the real API fixture, including upload, registration, starting, reconnect saves and released results. They do not measure browser layout, distributed D1 latency or production load.
