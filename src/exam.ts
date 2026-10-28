import { asMarks } from './scoring';
import { Hono } from 'hono';
import { currentExamId, requireRole, type Env } from './auth';

// Student exam routes. Mounted at /api/student/exam (students only).
// The clock is the SERVER's clock: the page only displays it, so changing the computer's time does nothing.

// Exam length belongs to the exam (the admin sets it on the Settings page).
const GRACE_SECONDS = 10; // an answer sent a few seconds after time is up is still accepted (slow network)

const GROUPS: Record<number, string[]> = {
  1: ['Government', 'Literature', 'CRS'],
  2: ['Mathematics', 'Physics', 'Chemistry'],
  3: ['Biology', 'Physics', 'Chemistry'],
  4: ['Mathematics', 'Economics', 'Account'],
};
const RECOMMENDED: Record<string, number[]> = { 'SS3 Art': [1], 'SS3 Science': [2, 3], 'SS3 Commercial': [4] };

// The subjects of an attempt: Use of English + the three subjects of the chosen group.
const SUBJECTS_OF = `(SELECT id FROM subjects WHERE id = 'eng' OR id IN (SELECT subject_id FROM group_subjects WHERE group_no = a.group_no))`;

type Attempt = { id: number; group_no: number; submitted_at: string | null; ends_at: number; released: number };
const nowSec = () => Math.floor(Date.now() / 1000);

// Stable pseudo-random number from (attempt, question): same inputs always give the same order.
function mix(attemptId: number, questionId: number) {
  let h = (attemptId * 73856093) ^ (questionId * 19349663);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}

const exam = new Hono<Env>();
exam.use('*', requireRole('student'));
// Only students of the CURRENT session can sit the exam (an old session's students are locked out).
exam.use('*', async (c, next) => {
  const row = await c.env.DB.prepare(
    `SELECT session_id AS sid FROM students WHERE id = ? AND session_id = (SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'current_session_id')`,
  )
    .bind(c.get('session').id)
    .first<{ sid: number }>();
  if (!row) return c.json({ error: 'Your exam session has ended. Please contact your school.' }, 403);
  c.set('sessionId', row.sid);
  c.set('examId', await currentExamId(c.env.DB)); // students always sit the LIVE exam
  await next();
});

async function attemptOf(db: D1Database, studentId: number, examId: number) {
  return db.prepare('SELECT id, group_no, submitted_at, ends_at, released FROM attempts WHERE student_id = ? AND exam_id = ?').bind(studentId, examId).first<Attempt>();
}

async function examInfo(db: D1Database, examId: number) {
  const e = await db.prepare('SELECT name, minutes FROM exams WHERE id = ?').bind(examId).first<{ name: string; minutes: number }>();
  return { name: e?.name ?? 'Exam', minutes: e?.minutes ?? 120 };
}

// Closes the exam and marks it. Safe to call twice: the second call changes nothing.
async function finalize(db: D1Database, attemptId: number) {
  await db.batch([
    db.prepare(`UPDATE attempts SET submitted_at = datetime('now') WHERE id = ? AND submitted_at IS NULL`).bind(attemptId),
    // Marks in ONE pass over the student's answers (it used to re-read all of them once per subject).
    // A subject with no right answers still gets a row, with 0.
    db.prepare(
      `INSERT OR IGNORE INTO scores (attempt_id, subject_id, score, total)
       SELECT a.id, s.id, COALESCE(t.n, 0), (SELECT COUNT(*) FROM attempt_questions aq JOIN questions q ON q.id = aq.question_id WHERE aq.attempt_id = a.id AND q.subject_id = s.id)
         FROM attempts a JOIN subjects s ON s.id IN ${SUBJECTS_OF}
         LEFT JOIN (SELECT q.subject_id AS sid, COUNT(*) AS n
                      FROM answers w JOIN attempt_questions aq ON aq.attempt_id = w.attempt_id AND aq.question_id = w.question_id JOIN questions q ON q.id = aq.question_id
                     WHERE w.attempt_id = ?1 AND w.chosen = q.correct
                     GROUP BY q.subject_id) t ON t.sid = s.id
        WHERE a.id = ?1`,
    ).bind(attemptId),
  ]);
}

async function results(db: D1Database, attemptId: number) {
  const { results: rows } = await db
    .prepare(
      `SELECT s.name AS subject, sc.score AS score,
              sc.total AS total
         FROM scores sc JOIN subjects s ON s.id = sc.subject_id
        WHERE sc.attempt_id = ? ORDER BY (s.id = 'eng') DESC, s.rowid`,
    )
    .bind(attemptId)
    .all<{ subject: string; score: number; total: number }>();
  return rows.map(asMarks);
}

exam.get('/', async (c) => {
  const studentId = c.get('session').id;
  const db = c.env.DB;
  const examId = c.get('examId');
  const info = await examInfo(db, examId);
  let attempt = await attemptOf(db, studentId, examId);

  if (!attempt) {
    const me = await db.prepare('SELECT class_name FROM students WHERE id = ?').bind(studentId).first<{ class_name: string }>();
    return c.json({
      status: 'none', examId, attemptId: null,
      examName: info.name,
      minutes: info.minutes,
      recommended: RECOMMENDED[me?.class_name ?? ''] ?? [],
      groups: Object.entries(GROUPS).map(([no, subjects]) => ({ no: Number(no), subjects })),
    });
  }

  if (!attempt.submitted_at && nowSec() > attempt.ends_at + GRACE_SECONDS) {
    await finalize(db, attempt.id); // time ran out while the student was away
    attempt = (await attemptOf(db, studentId, examId))!;
  }

  if (attempt.submitted_at) {
    const saved = await db.prepare('SELECT question_id AS q, chosen, revision FROM answers WHERE attempt_id = ?').bind(attempt.id).all<{ q: number; chosen: string; revision: number }>();
    const qs = await db.prepare('SELECT question_id AS id FROM attempt_questions WHERE attempt_id = ? ORDER BY question_id').bind(attempt.id).all<{ id: number }>();
    const identity = { questionIds: qs.results.map((q) => q.id), examId, attemptId: attempt.id, answers: Object.fromEntries(saved.results.map((x) => [x.q, x.chosen])), answerRevisions: Object.fromEntries(saved.results.map((x) => [x.q, x.revision])) };
    // Saved choices let the browser reconcile pending work even if a submit response was lost.
    if (!attempt.released) return c.json({ ...identity, status: 'submitted', examName: info.name, released: false });
    // Everything the printable result slip needs (same details as the admin's slip).
    const [rows, me, ses] = await Promise.all([
      results(db, attempt.id),
      db.prepare('SELECT code, full_name AS fullName, class_name AS className FROM students WHERE id = ?').bind(studentId).first<{ code: string; fullName: string; className: string }>(),
      db.prepare('SELECT name FROM sessions WHERE id = ?').bind(c.get('sessionId')).first<{ name: string }>(),
    ]);
    return c.json({
      ...identity, status: 'submitted', examName: info.name, released: true, results: rows,
      slip: { ...me, groupNo: attempt.group_no, submittedAt: attempt.submitted_at, sessionName: ses?.name ?? '' },
    });
  }

  // In progress: send the questions WITHOUT the correct answers.
  const { results: subs } = await db
    .prepare(`SELECT s.id, s.name FROM attempts a JOIN subjects s ON s.id IN ${SUBJECTS_OF} WHERE a.id = ? ORDER BY (s.id = 'eng') DESC, s.rowid`)
    .bind(attempt.id)
    .all<{ id: string; name: string }>();
  // Look the questions up by exam + subject (uses the index). The old query could not, so every page load
  // read EVERY question in the database, and that grew with each exam you stored.
  const { results: qs } = await db
    .prepare(
      `SELECT q.id, q.subject_id AS subjectId, q.body, q.option_a AS a, q.option_b AS b, q.option_c AS c, q.option_d AS d
         FROM attempt_questions aq JOIN questions q ON q.id = aq.question_id
        WHERE aq.attempt_id = ? AND q.subject_id IN (${subs.map(() => '?').join(',')})
        ORDER BY q.id`,
    )
    .bind(attempt.id, ...subs.map((s) => s.id))
    .all<{ id: number; subjectId: string; body: string; a: string; b: string; c: string; d: string }>();
  const { results: ans } = await db
    .prepare('SELECT question_id AS q, chosen, revision FROM answers WHERE attempt_id = ?')
    .bind(attempt.id)
    .all<{ q: number; chosen: string; revision: number }>();

  return c.json({
    status: 'in_progress', examId, attemptId: attempt.id,
    examName: info.name,
    secondsLeft: Math.max(0, attempt.ends_at - nowSec()),
    // Every student gets their own question order. It is fixed for that student (refreshing does not reshuffle).
    subjects: subs.map((s) => ({
      ...s,
      questions: qs
        .filter((q) => q.subjectId === s.id)
        .sort((x, y) => mix(attempt!.id, x.id) - mix(attempt!.id, y.id))
        .map(({ subjectId, ...q }) => q),
    })),
    answers: Object.fromEntries(ans.map((x) => [x.q, x.chosen])),
    answerRevisions: Object.fromEntries(ans.map((x) => [x.q, x.revision])),
  });
});

exam.post('/start', async (c) => {
  const studentId = c.get('session').id;
  const { groupNo, examId: expectedExamId } = await c.req.json<{ groupNo?: number; examId?: number }>().catch(() => ({} as { groupNo?: number; examId?: number }));
  const group = Number(groupNo);
  if (!GROUPS[group]) return c.json({ error: 'Choose your subject group.' }, 400);
  const examId = c.get('examId');
  if (await attemptOf(c.env.DB, studentId, examId)) return c.json({ error: 'You have already started your exam.' }, 409);

  if (expectedExamId !== examId) return c.json({ error: 'The live exam has changed. Refresh before starting.', attemptChanged: true }, 409);

  // A bank of 50–80 per subject; each attempt is allocated 50. A trigger repeats this check atomically with the INSERT.
  const empty = await c.env.DB
    .prepare(
      `SELECT s.name FROM subjects s
        WHERE (s.id = 'eng' OR s.id IN (SELECT subject_id FROM group_subjects WHERE group_no = ?))
          AND (SELECT COUNT(*) FROM questions q WHERE q.subject_id = s.id AND q.exam_id = ?) NOT BETWEEN 50 AND 80`,
    )
    .bind(group, examId)
    .all<{ name: string }>();
  if (empty.results.length) {
    return c.json({ error: `The exam is not ready yet (each subject needs 50–80 questions: ${empty.results.map((r) => r.name).join(', ')}). Please tell your teacher.` }, 409);
  }

  try {
    await c.env.DB.prepare('INSERT INTO attempts (student_id, exam_id, group_no, ends_at) VALUES (?, ?, ?, ?)')
      .bind(studentId, examId, group, nowSec() + (await examInfo(c.env.DB, examId)).minutes * 60)
      .run();
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (message.includes('EXAM_NOT_READY')) return c.json({ error: 'The exam is not ready. Each subject needs 50–80 questions.' }, 409);
    if (message.includes('EXAM_CHANGED')) return c.json({ error: 'The live exam has changed. Refresh before starting.', attemptChanged: true }, 409);
    if (message.includes('UNIQUE')) return c.json({ error: 'You have already started your exam.' }, 409);
    throw err;
  }
  return c.json({ ok: true }, 201);
});

// Saves one answer as soon as the student picks it.
exam.put('/answer', async (c) => {
  const studentId = c.get('session').id;
  const body = await c.req.json<{ questionId?: number; chosen?: string; attemptId?: number; revision?: number }>().catch(() => ({} as { questionId?: number; chosen?: string; attemptId?: number; revision?: number }));
  const { questionId, chosen, revision } = body;
  if (!Number.isSafeInteger(questionId) || !['A', 'B', 'C', 'D'].includes(String(chosen)) || !Number.isSafeInteger(revision) || revision! < 1) return c.json({ error: 'Invalid answer. Refresh the exam page if it was open before an update.' }, 400);

  const attempt = await attemptOf(c.env.DB, studentId, c.get('examId'));
  if (!attempt || body.attemptId !== attempt.id) return c.json({ error: 'This attempt has changed. Refresh before continuing.', attemptChanged: true }, 409);
  if (attempt.submitted_at) return c.json({ error: 'Your exam has been submitted.', finished: true }, 409);

  // One atomic batch: (1) add the answer if it is new, (2) if it WAS new, add 1 to the attempt's running count,
  // (3) otherwise change the existing answer. changes() is SQLite's "rows changed by the previous statement".
  const now = nowSec(), examId = c.get('examId');
  const valid = `a.id = ?1 AND a.submitted_at IS NULL AND ?4 <= a.ends_at + ${GRACE_SECONDS}`;
  // Is this question one of the student's subjects? English, or a subject of their group (a direct lookup,
  // instead of listing every subject on every save).
  const inMySubjects = `(q.subject_id = 'eng' OR EXISTS (SELECT 1 FROM group_subjects g WHERE g.group_no = a.group_no AND g.subject_id = q.subject_id))`;
  const [ins, , upd] = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO answers (attempt_id, question_id, chosen, revision)
       SELECT a.id, q.id, ?3, ?6 FROM attempts a JOIN questions q ON q.id = ?2
        WHERE ${valid} AND ${inMySubjects} AND q.exam_id = ?5 AND EXISTS (SELECT 1 FROM attempt_questions aq WHERE aq.attempt_id = a.id AND aq.question_id = q.id)`,
    ).bind(attempt.id, questionId, chosen, now, examId, revision),
    c.env.DB.prepare(`UPDATE attempts SET answered = answered + 1 WHERE id = ?1 AND changes() = 1`).bind(attempt.id),
    c.env.DB.prepare(
      `UPDATE answers SET chosen = ?3, revision = ?5 WHERE attempt_id = ?1 AND question_id = ?2 AND revision < ?5
          AND EXISTS (SELECT 1 FROM attempts a WHERE ${valid})`,
    ).bind(attempt.id, questionId, chosen, now, revision),
  ]);

  const saved = await c.env.DB.prepare('SELECT chosen, revision FROM answers WHERE attempt_id = ? AND question_id = ?').bind(attempt.id, questionId).first<{ chosen: string; revision: number }>();
  if (ins.meta.changes || upd.meta.changes || (saved && saved.chosen === chosen && saved.revision === revision)) {
    return c.json({ ok: true, chosen: saved?.chosen, revision: saved?.revision });
  }
  if (nowSec() > attempt.ends_at + GRACE_SECONDS) {
    await finalize(c.env.DB, attempt.id);
    return c.json({ error: 'Time is up. Only answers received before the deadline and grace period were accepted.', finished: true }, 409);
  }
  if (saved) return c.json({ error: 'This answer changed in another request. Refresh the page to reconcile your answers.', conflict: true }, 409);
  return c.json({ error: 'That question is not in your exam.' }, 400);
});

// Browser-reported tab departures are review flags, never proof of cheating.
exam.post('/focus-event', async (c) => {
  const b = await c.req.json<{ attemptId?: number; eventId?: string; occurredAt?: number }>().catch(() => ({} as { attemptId?: number; eventId?: string; occurredAt?: number }));
  if (typeof b.eventId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(b.eventId) || !Number.isSafeInteger(b.occurredAt) || b.occurredAt! < 0 || b.occurredAt! > nowSec() + 60) return c.json({ error: 'Invalid focus event.' }, 400);
  const a = await attemptOf(c.env.DB, c.get('session').id, c.get('examId'));
  if (!a || b.attemptId !== a.id) return c.json({ error: 'This attempt has changed.' }, 409);
  // Late delivery is allowed for offline events, only with a time inside this sitting.
  await c.env.DB.prepare(`INSERT OR IGNORE INTO exam_focus_events (attempt_id, event_id, occurred_at)
    SELECT id, ?2, ?3 FROM attempts WHERE id = ?1
      AND ?3 >= CAST(strftime('%s', started_at) AS INTEGER) AND ?3 <= ends_at
      AND (submitted_at IS NULL OR ?3 <= CAST(strftime('%s', submitted_at) AS INTEGER))
      AND focus_count < 500`)
    .bind(a.id, b.eventId, b.occurredAt).run();
  return c.json({ ok: true });
});

exam.post('/submit', async (c) => {
  const body = await c.req.json<{ attemptId?: number }>().catch(() => ({} as { attemptId?: number }));
  const attempt = await attemptOf(c.env.DB, c.get('session').id, c.get('examId'));
  if (!attempt || body.attemptId !== attempt.id) return c.json({ error: 'This attempt has changed. Refresh before continuing.', attemptChanged: true }, 409);
  await finalize(c.env.DB, attempt.id);
  return c.json({ ok: true, attemptId: attempt.id });
});

export default exam;
