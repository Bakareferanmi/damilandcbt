import { asMarks } from './scoring';
import { Hono } from 'hono';
import { requireRole, scope, type Env } from './auth';
import { closeOpenAttempts } from './exams';

// Admin results: every submitted exam, with scores, and the switch that lets a student see theirs.
const results = new Hono<Env>();
results.use('*', requireRole('admin'), scope);

results.get('/', async (c) => {
  // Students who closed the page after time ran out are marked now, so this page is never behind.
  if (c.get('examId') === c.get('currentExamId')) await closeOpenAttempts(c.env.DB, c.get('examId'), true);
  const { results: rows } = await c.env.DB.prepare(
    `SELECT a.id AS attemptId, s.code, s.full_name AS fullName, s.class_name AS className, a.group_no AS groupNo,
            a.submitted_at AS submittedAt, a.released
       FROM attempts a JOIN students s ON s.id = a.student_id
      WHERE a.submitted_at IS NOT NULL AND a.exam_id = ? ORDER BY s.seq`,
  )
    .bind(c.get('examId'))
    .all<{ attemptId: number; code: string; fullName: string; className: string; groupNo: number; submittedAt: string; released: number }>();

  // Scores and denominators were frozen when this sitting was marked.
  const { results: sc } = await c.env.DB.prepare(
    `SELECT sc.attempt_id AS attemptId, sub.id AS subjectId, sub.name AS subject, sc.score, sc.total
       FROM scores sc JOIN attempts a ON a.id = sc.attempt_id AND a.exam_id = ?
       JOIN subjects sub ON sub.id = sc.subject_id ORDER BY (sub.id = 'eng') DESC, sub.rowid`,
  )
    .bind(c.get('examId'))
    .all<{ attemptId: number; subjectId: string; subject: string; score: number; total: number }>();

  const out = rows.map(({ attemptId, ...r }) => {
    const scores = sc.filter((x) => x.attemptId === attemptId).map((x) => asMarks({ subject: x.subject, score: x.score, total: x.total }));
    return { ...r, released: !!r.released, scores, total: scores.reduce((n, x) => n + x.score, 0), outOf: scores.reduce((n, x) => n + x.total, 0) };
  });
  return c.json({ results: out });
});

// Live view for invigilators: every student of the session with their progress in the viewed exam.
results.get('/monitor', async (c) => {
  const eid = c.get('examId'), sid = c.get('sessionId');
  const live = eid === c.get('currentExamId');
  if (live) await closeOpenAttempts(c.env.DB, eid, true); // students who left after time ran out are closed and marked
  const { results: rows } = await c.env.DB.prepare(
    `SELECT s.code, s.full_name AS fullName, s.class_name AS className,
            a.group_no AS groupNo, a.submitted_at AS submittedAt, a.ends_at AS endsAt, a.answered AS answered, a.id AS attemptId,
            (SELECT COUNT(*) FROM attempt_questions aq WHERE aq.attempt_id = a.id) AS assignedTotal,
            (SELECT COUNT(*) FROM exam_focus_events f WHERE f.attempt_id = a.id) AS tabSwitches,
            (SELECT MAX(occurred_at) FROM exam_focus_events f WHERE f.attempt_id = a.id) AS lastTabSwitch
       FROM students s LEFT JOIN attempts a ON a.student_id = s.id AND a.exam_id = ?1
      WHERE s.session_id = ?2 ORDER BY s.seq`,
  )
    .bind(eid, sid)
    .all<{ code: string; fullName: string; className: string; groupNo: number | null; submittedAt: string | null; endsAt: number | null; answered: number | null; attemptId: number | null; assignedTotal: number; tabSwitches: number; lastTabSwitch: number | null }>();
  const exam = await c.env.DB.prepare('SELECT name, minutes FROM exams WHERE id = ?').bind(eid).first<{ name: string; minutes: number }>();
  const now = Math.floor(Date.now() / 1000);
  return c.json({
    exam: exam?.name ?? '',
    minutes: exam?.minutes ?? 0,
    live,
    students: rows.map((r) => ({
      code: r.code, attemptId: r.attemptId, tabSwitches: r.tabSwitches, lastTabSwitch: r.lastTabSwitch,
      fullName: r.fullName,
      className: r.className,
      status: r.groupNo === null ? 'none' : r.submittedAt ? 'submitted' : 'in_progress',
      groupNo: r.groupNo,
      answered: r.groupNo === null ? 0 : r.answered ?? 0,
      total: r.groupNo === null ? 0 : r.assignedTotal,
      secondsLeft: r.groupNo !== null && !r.submittedAt && r.endsAt ? Math.max(0, r.endsAt - now) : null,
    })),
    now,
  });
});

// { code, released } for one student, or { all: true, released } for everyone who has submitted.
results.post('/release', async (c) => {
  const b = await c.req.json<{ code?: string; all?: boolean; released?: boolean }>().catch(() => ({}) as { code?: string; all?: boolean; released?: boolean });
  const value = b.released === false ? 0 : 1;
  const res = b.all
    ? await c.env.DB.prepare('UPDATE attempts SET released = ? WHERE submitted_at IS NOT NULL AND exam_id = ?').bind(value, c.get('examId')).run()
    : b.code
      ? await c.env.DB.prepare('UPDATE attempts SET released = ? WHERE submitted_at IS NOT NULL AND exam_id = ? AND student_id = (SELECT id FROM students WHERE code = ? AND session_id = ?)').bind(value, c.get('examId'), b.code.trim().toUpperCase(), c.get('sessionId')).run()
      : null;
  if (!res) return c.json({ error: 'Say which student, or choose all.' }, 400);
  return c.json({ ok: true, changed: res.meta.changes });
});

export default results;
