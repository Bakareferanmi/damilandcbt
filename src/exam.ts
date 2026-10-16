import { Hono } from 'hono';
import { requireRole, type Env } from './auth';
import { getExamMinutes } from './settings';

// Student exam routes. Mounted at /api/student/exam (students only).
// The clock is the SERVER's clock: the page only displays it, so changing the computer's time does nothing.

// Exam length is a setting the admin changes on the Settings page (see settings.ts).
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
  await next();
});

async function attemptOf(db: D1Database, studentId: number) {
  return db.prepare('SELECT id, group_no, submitted_at, ends_at, released FROM attempts WHERE student_id = ?').bind(studentId).first<Attempt>();
}

// Closes the exam and marks it. Safe to call twice: the second call changes nothing.
async function finalize(db: D1Database, attemptId: number) {
  await db.batch([
    db.prepare(`UPDATE attempts SET submitted_at = datetime('now') WHERE id = ? AND submitted_at IS NULL`).bind(attemptId),
    db.prepare(
      `INSERT OR IGNORE INTO scores (attempt_id, subject_id, score)
       SELECT a.id, s.id,
              (SELECT COUNT(*) FROM answers w JOIN questions q ON q.id = w.question_id
                WHERE w.attempt_id = a.id AND q.subject_id = s.id AND w.chosen = q.correct)
         FROM attempts a JOIN subjects s ON s.id IN ${SUBJECTS_OF}
        WHERE a.id = ?`,
    ).bind(attemptId),
  ]);
}

async function results(db: D1Database, attemptId: number, sessionId: number) {
  const { results: rows } = await db
    .prepare(
      `SELECT s.name AS subject, sc.score AS score,
              (SELECT COUNT(*) FROM questions q WHERE q.subject_id = s.id AND q.session_id = ?) AS total
         FROM scores sc JOIN subjects s ON s.id = sc.subject_id
        WHERE sc.attempt_id = ? ORDER BY (s.id = 'eng') DESC, s.rowid`,
    )
    .bind(sessionId, attemptId)
    .all<{ subject: string; score: number; total: number }>();
  return rows;
}

exam.get('/', async (c) => {
  const studentId = c.get('session').id;
  const db = c.env.DB;
  let attempt = await attemptOf(db, studentId);

  if (!attempt) {
    const me = await db.prepare('SELECT class_name FROM students WHERE id = ?').bind(studentId).first<{ class_name: string }>();
    return c.json({
      status: 'none',
      minutes: await getExamMinutes(db),
      recommended: RECOMMENDED[me?.class_name ?? ''] ?? [],
      groups: Object.entries(GROUPS).map(([no, subjects]) => ({ no: Number(no), subjects })),
    });
  }

  if (!attempt.submitted_at && nowSec() > attempt.ends_at + GRACE_SECONDS) {
    await finalize(db, attempt.id); // time ran out while the student was away
    attempt = (await attemptOf(db, studentId))!;
  }

  if (attempt.submitted_at) {
    // Scores stay hidden until an admin releases them.
    return attempt.released
      ? c.json({ status: 'submitted', released: true, results: await results(db, attempt.id, c.get('sessionId')) })
      : c.json({ status: 'submitted', released: false });
  }

  // In progress: send the questions WITHOUT the correct answers.
  const { results: qs } = await db
    .prepare(
      `SELECT q.id, q.subject_id AS subjectId, q.body, q.option_a AS a, q.option_b AS b, q.option_c AS c, q.option_d AS d
         FROM attempts a JOIN questions q ON q.subject_id IN ${SUBJECTS_OF} AND q.session_id = ?2
        WHERE a.id = ?1 ORDER BY q.id`,
    )
    .bind(attempt.id, c.get('sessionId'))
    .all<{ id: number; subjectId: string; body: string; a: string; b: string; c: string; d: string }>();
  const { results: subs } = await db
    .prepare(`SELECT s.id, s.name FROM attempts a JOIN subjects s ON s.id IN ${SUBJECTS_OF} WHERE a.id = ? ORDER BY (s.id = 'eng') DESC, s.rowid`)
    .bind(attempt.id)
    .all<{ id: string; name: string }>();
  const { results: ans } = await db
    .prepare('SELECT question_id AS q, chosen FROM answers WHERE attempt_id = ?')
    .bind(attempt.id)
    .all<{ q: number; chosen: string }>();

  return c.json({
    status: 'in_progress',
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
  });
});

exam.post('/start', async (c) => {
  const studentId = c.get('session').id;
  const { groupNo } = await c.req.json<{ groupNo?: number }>().catch(() => ({}) as { groupNo?: number });
  const group = Number(groupNo);
  if (!GROUPS[group]) return c.json({ error: 'Choose your subject group.' }, 400);
  if (await attemptOf(c.env.DB, studentId)) return c.json({ error: 'You have already started your exam.' }, 409);

  // Every subject must have questions, otherwise the exam is not ready.
  const empty = await c.env.DB
    .prepare(
      `SELECT s.name FROM subjects s
        WHERE (s.id = 'eng' OR s.id IN (SELECT subject_id FROM group_subjects WHERE group_no = ?))
          AND NOT EXISTS (SELECT 1 FROM questions q WHERE q.subject_id = s.id AND q.session_id = ?)`,
    )
    .bind(group, c.get('sessionId'))
    .all<{ name: string }>();
  if (empty.results.length) {
    return c.json({ error: `The exam is not ready yet (no questions for ${empty.results.map((r) => r.name).join(', ')}). Please tell your teacher.` }, 409);
  }

  try {
    await c.env.DB.prepare('INSERT INTO attempts (student_id, group_no, ends_at) VALUES (?, ?, ?)')
      .bind(studentId, group, nowSec() + (await getExamMinutes(c.env.DB)) * 60)
      .run();
  } catch {
    return c.json({ error: 'You have already started your exam.' }, 409); // unique index: only one sitting per student
  }
  return c.json({ ok: true }, 201);
});

// Saves one answer as soon as the student picks it.
exam.put('/answer', async (c) => {
  const studentId = c.get('session').id;
  const { questionId, chosen } = await c.req.json<{ questionId?: number; chosen?: string }>().catch(() => ({}) as { questionId?: number; chosen?: string });
  if (!Number.isInteger(questionId) || !['A', 'B', 'C', 'D'].includes(String(chosen))) return c.json({ error: 'Invalid answer.' }, 400);

  const attempt = await attemptOf(c.env.DB, studentId);
  if (!attempt) return c.json({ error: 'Start your exam first.' }, 409);
  if (attempt.submitted_at) return c.json({ error: 'Your exam has been submitted.', finished: true }, 409);

  const res = await c.env.DB
    .prepare(
      `INSERT INTO answers (attempt_id, question_id, chosen)
       SELECT a.id, q.id, ?3
         FROM attempts a JOIN questions q ON q.id = ?2
        WHERE a.id = ?1 AND a.submitted_at IS NULL AND ?4 <= a.ends_at + ${GRACE_SECONDS}
          AND q.subject_id IN ${SUBJECTS_OF} AND q.session_id = ?5
       ON CONFLICT (attempt_id, question_id) DO UPDATE SET chosen = excluded.chosen`,
    )
    .bind(attempt.id, questionId, chosen, nowSec(), c.get('sessionId'))
    .run();

  if (!res.meta.changes) {
    if (nowSec() > attempt.ends_at + GRACE_SECONDS) {
      await finalize(c.env.DB, attempt.id);
      return c.json({ error: 'Time is up. Your exam has been submitted.', finished: true }, 409);
    }
    return c.json({ error: 'That question is not in your exam.' }, 400);
  }
  return c.json({ ok: true });
});

exam.post('/submit', async (c) => {
  const attempt = await attemptOf(c.env.DB, c.get('session').id);
  if (!attempt) return c.json({ error: 'Start your exam first.' }, 409);
  await finalize(c.env.DB, attempt.id);
  return c.json({ ok: true });
});

export default exam;
