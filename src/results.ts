import { Hono } from 'hono';
import { requireRole, scope, type Env } from './auth';

// Admin results: every submitted exam, with scores, and the switch that lets a student see theirs.
const results = new Hono<Env>();
results.use('*', requireRole('admin'), scope);

results.get('/', async (c) => {
  const { results: rows } = await c.env.DB.prepare(
    `SELECT a.id AS attemptId, s.code, s.full_name AS fullName, s.class_name AS className, a.group_no AS groupNo,
            a.submitted_at AS submittedAt, a.released
       FROM attempts a JOIN students s ON s.id = a.student_id
      WHERE a.submitted_at IS NOT NULL AND s.session_id = ? ORDER BY s.seq`,
  )
    .bind(c.get('sessionId'))
    .all<{ attemptId: number; code: string; fullName: string; className: string; groupNo: number; submittedAt: string; released: number }>();

  const { results: sc } = await c.env.DB.prepare(
    `SELECT sc.attempt_id AS attemptId, sub.name AS subject, sc.score,
            (SELECT COUNT(*) FROM questions q WHERE q.subject_id = sub.id AND q.session_id = ?) AS total
       FROM scores sc JOIN subjects sub ON sub.id = sc.subject_id ORDER BY (sub.id = 'eng') DESC, sub.rowid`,
  )
    .bind(c.get('sessionId'))
    .all<{ attemptId: number; subject: string; score: number; total: number }>();

  const out = rows.map(({ attemptId, ...r }) => {
    const scores = sc.filter((x) => x.attemptId === attemptId).map(({ attemptId, ...x }) => x);
    return { ...r, released: !!r.released, scores, total: scores.reduce((n, x) => n + x.score, 0), outOf: scores.reduce((n, x) => n + x.total, 0) };
  });
  return c.json({ results: out });
});

// { code, released } for one student, or { all: true, released } for everyone who has submitted.
results.post('/release', async (c) => {
  const b = await c.req.json<{ code?: string; all?: boolean; released?: boolean }>().catch(() => ({}) as { code?: string; all?: boolean; released?: boolean });
  const value = b.released === false ? 0 : 1;
  const res = b.all
    ? await c.env.DB.prepare('UPDATE attempts SET released = ? WHERE submitted_at IS NOT NULL AND student_id IN (SELECT id FROM students WHERE session_id = ?)').bind(value, c.get('sessionId')).run()
    : b.code
      ? await c.env.DB.prepare('UPDATE attempts SET released = ? WHERE submitted_at IS NOT NULL AND student_id = (SELECT id FROM students WHERE code = ? AND session_id = ?)').bind(value, b.code.trim().toUpperCase(), c.get('sessionId')).run()
      : null;
  if (!res) return c.json({ error: 'Say which student, or choose all.' }, 400);
  return c.json({ ok: true, changed: res.meta.changes });
});

export default results;
