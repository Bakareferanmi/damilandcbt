import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { requireRole, scope, VIEW_EXAM_COOKIE, type Env } from './auth';

// Exams inside an academic session (First Term, Mock, ...). Mounted at /api/admin/exams (admins only).
// Students belong to the session. Questions, attempts and results belong to an exam.
// Exactly one exam is LIVE (settings.current_exam_id): the one students can sit.

const GRACE_SECONDS = 10;
const SUBJECTS_OF = `(SELECT id FROM subjects WHERE id = 'eng' OR id IN (SELECT subject_id FROM group_subjects WHERE group_no = a.group_no))`;

// Marks and submits attempts that are still open. With onlyExpired, only those whose time has run out
// (students who closed the page); otherwise every open attempt (used when another exam goes live).
export async function closeOpenAttempts(db: D1Database, examId: number, onlyExpired: boolean) {
  // The time limit is worked out here (not inside the SQL) so the index (exam_id, submitted_at, ends_at)
  // can answer "is anything expired?" without reading the attempts themselves.
  const cond = (t: string) => `${t}.exam_id = ?1 AND ${t}.submitted_at IS NULL` + (onlyExpired ? ` AND ${t}.ends_at < ?2` : '');
  const binds: unknown[] = onlyExpired ? [examId, Math.floor(Date.now() / 1000) - GRACE_SECONDS] : [examId];

  // The Monitor calls this on every refresh and usually nothing has expired: one cheap look, then stop.
  const any = await db.prepare(`SELECT 1 AS x FROM attempts a WHERE ${cond('a')} LIMIT 1`).bind(...binds).first();
  if (!any) return;

  await db.batch([
    // Marks each student in one pass over their answers (see finalize in exam.ts).
    db.prepare(
      `INSERT OR IGNORE INTO scores (attempt_id, subject_id, score)
       SELECT a.id, s.id, COALESCE(t.n, 0)
         FROM attempts a JOIN subjects s ON s.id IN ${SUBJECTS_OF}
         LEFT JOIN (SELECT w.attempt_id AS aid, q.subject_id AS sid, COUNT(*) AS n
                      FROM answers w JOIN questions q ON q.id = w.question_id
                     WHERE w.chosen = q.correct AND w.attempt_id IN (SELECT x.id FROM attempts x WHERE ${cond('x')})
                     GROUP BY w.attempt_id, q.subject_id) t ON t.aid = a.id AND t.sid = s.id
        WHERE ${cond('a')}`,
    ).bind(...binds),
    db.prepare(`UPDATE attempts AS a SET submitted_at = datetime('now') WHERE ${cond('a')}`).bind(...binds),
  ]);
}

// How many students are still writing this exam right now.
export async function writingCount(db: D1Database, examId: number) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE exam_id = ? AND submitted_at IS NULL').bind(examId).first<{ n: number }>();
  return row?.n ?? 0;
}
// Ending a running exam submits everyone still writing. The server refuses unless the admin has confirmed it, with the number of students.
export const needsConfirm = (n: number) => ({ error: `${n} student${n === 1 ? ' is' : 's are'} still writing. This will submit ${n === 1 ? 'their' : 'their'} exam now.`, needsConfirm: true, writing: n });

function examName(x: unknown) {
  const n = String(x ?? '').trim().replace(/\s+/g, ' ');
  return n.length >= 2 && n.length <= 40 ? n : null;
}
function minutesOf(x: unknown) {
  const n = Number(x);
  return Number.isInteger(n) && n >= 10 && n <= 360 ? n : null;
}
function setView(c: any, id: number) {
  setCookie(c, VIEW_EXAM_COOKIE, String(id), { path: '/', sameSite: 'Lax', httpOnly: true, secure: new URL(c.req.url).protocol === 'https:', maxAge: 365 * 24 * 3600 });
}

const exams = new Hono<Env>();
const admin = requireRole('admin');

// Exams of the session being viewed.
exams.get('/', admin, scope, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT e.id, e.name, e.minutes,
            (SELECT COUNT(*) FROM attempts a WHERE a.exam_id = e.id) AS attempts,
            (SELECT COUNT(*) FROM questions q WHERE q.exam_id = e.id) AS questions
       FROM exams e WHERE e.session_id = ? ORDER BY e.id DESC`,
  )
    .bind(c.get('sessionId'))
    .all<{ id: number; name: string; minutes: number; attempts: number; questions: number }>();
  return c.json({ exams: results.map((e) => ({ ...e, live: e.id === c.get('currentExamId') })), viewing: c.get('examId'), live: c.get('currentExamId') });
});

// Choose which exam the admin pages show (allowed even in a past session: it only changes the view).
exams.post('/view', admin, async (c) => {
  const { id } = await c.req.json<{ id?: number }>().catch(() => ({}) as { id?: number });
  const ok = await c.env.DB.prepare('SELECT 1 AS x FROM exams WHERE id = ?').bind(Number(id)).first();
  if (!ok) return c.json({ error: 'Exam not found.' }, 404);
  setView(c, Number(id));
  return c.json({ ok: true });
});

// Start a new exam in the current session. It becomes the live exam; the previous one is closed
// (anyone still sitting it is submitted and marked).
exams.post('/', admin, scope, async (c) => {
  const b = await c.req.json<{ name?: string; minutes?: number; copyFrom?: number | null; confirm?: boolean }>().catch(() => ({}) as { name?: string; minutes?: number; copyFrom?: number | null; confirm?: boolean });
  const name = examName(b.name);
  if (!name) return c.json({ error: 'Give the exam a name, for example First Term Exam.' }, 400);
  const minutes = minutesOf(b.minutes);
  if (!minutes) return c.json({ error: 'Enter a whole number of minutes between 10 and 360.' }, 400);
  const sid = c.get('sessionId'), previous = c.get('currentExamId');
  let copyFrom: number | null = null;
  if (b.copyFrom) {
    const src = await c.env.DB.prepare('SELECT id FROM exams WHERE id = ?').bind(Number(b.copyFrom)).first<{ id: number }>();
    if (!src) return c.json({ error: 'The exam to copy questions from was not found.' }, 400);
    copyFrom = src.id;
  }
  const writing = await writingCount(c.env.DB, previous);
  if (writing && !b.confirm) return c.json(needsConfirm(writing), 409);
  let id: number;
  try {
    const row = await c.env.DB.prepare('INSERT INTO exams (session_id, name, minutes) VALUES (?, ?, ?) RETURNING id').bind(sid, name, minutes).first<{ id: number }>();
    id = row!.id;
  } catch {
    return c.json({ error: 'This session already has an exam with that name.' }, 409);
  }
  await closeOpenAttempts(c.env.DB, previous, false);
  const steps = [c.env.DB.prepare(`UPDATE settings SET value = ? WHERE key = 'current_exam_id'`).bind(String(id))];
  if (copyFrom) {
    steps.push(
      c.env.DB.prepare(
        `INSERT INTO questions (subject_id, body, option_a, option_b, option_c, option_d, correct, session_id, exam_id)
         SELECT subject_id, body, option_a, option_b, option_c, option_d, correct, ?, ? FROM questions WHERE exam_id = ? ORDER BY id`,
      ).bind(sid, id, copyFrom),
    );
  }
  await c.env.DB.batch(steps);
  setView(c, id);
  return c.json({ ok: true, id, name }, 201);
});

// Rename an exam / change its length (the length applies to students who start after the change).
exams.put('/:id', admin, scope, async (c) => {
  const id = Number(c.req.param('id'));
  const b = await c.req.json<{ name?: string; minutes?: number }>().catch(() => ({}) as { name?: string; minutes?: number });
  const name = examName(b.name), minutes = minutesOf(b.minutes);
  if (!name) return c.json({ error: 'Give the exam a name, for example First Term Exam.' }, 400);
  if (!minutes) return c.json({ error: 'Enter a whole number of minutes between 10 and 360.' }, 400);
  try {
    const res = await c.env.DB.prepare('UPDATE exams SET name = ?, minutes = ? WHERE id = ? AND session_id = ?').bind(name, minutes, id, c.get('sessionId')).run();
    return res.meta.changes ? c.json({ ok: true }) : c.json({ error: 'Exam not found.' }, 404);
  } catch {
    return c.json({ error: 'This session already has an exam with that name.' }, 409);
  }
});

// Make another exam of the current session the live one (the one students sit).
exams.post('/:id/make-live', admin, scope, async (c) => {
  const id = Number(c.req.param('id'));
  const ok = await c.env.DB.prepare('SELECT 1 AS x FROM exams WHERE id = ? AND session_id = ?').bind(id, c.get('sessionId')).first();
  if (!ok) return c.json({ error: 'Exam not found.' }, 404);
  if (id !== c.get('currentExamId')) {
    const writing = await writingCount(c.env.DB, c.get('currentExamId'));
    const body = await c.req.json<{ confirm?: boolean }>().catch(() => ({}) as { confirm?: boolean });
    if (writing && !body.confirm) return c.json(needsConfirm(writing), 409);
    await closeOpenAttempts(c.env.DB, c.get('currentExamId'), false);
    await c.env.DB.prepare(`UPDATE settings SET value = ? WHERE key = 'current_exam_id'`).bind(String(id)).run();
  }
  setView(c, id);
  return c.json({ ok: true });
});

export default exams;
