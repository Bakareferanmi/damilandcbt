import { Hono } from 'hono';
import { liveExamOnly, requireRole, scope, type Env } from './auth';

// Question bank routes. Mounted at /api/admin/questions (admins only).
// Each subject holds at most 50 questions: the exam shows exactly 50 per subject.

const MAX_PER_SUBJECT = 50;
const MAX_IMPORT_ROWS = 500;
const LETTERS = ['A', 'B', 'C', 'D'] as const;

type Clean = { subjectId: string; body: string; a: string; b: string; c: string; d: string; correct: string };
type Checked = { ok: true; v: Omit<Clean, 'subjectId'> } | { ok: false; error: string };

// Checks one question (used by the form and by every row of a CSV upload).
function check(input: { body?: unknown; a?: unknown; b?: unknown; c?: unknown; d?: unknown; correct?: unknown }): Checked {
  const s = (x: unknown) => (typeof x === 'string' ? x.trim().replace(/\s+/g, ' ') : '');
  const body = s(input.body);
  const opts = [s(input.a), s(input.b), s(input.c), s(input.d)];
  const correct = s(input.correct).toUpperCase().slice(0, 1);

  if (body.length < 3) return { ok: false, error: 'Write the question.' };
  if (body.length > 1000) return { ok: false, error: 'The question is too long (1000 characters at most).' };
  if (opts.some((o) => !o)) return { ok: false, error: 'Fill in all four options, A to D.' };
  if (opts.some((o) => o.length > 300)) return { ok: false, error: 'An option is too long (300 characters at most).' };
  if (new Set(opts.map((o) => o.toLowerCase())).size < 4) return { ok: false, error: 'Two options are identical.' };
  if (!(LETTERS as readonly string[]).includes(correct)) return { ok: false, error: 'The correct answer must be A, B, C or D.' };
  return { ok: true, v: { body, a: opts[0], b: opts[1], c: opts[2], d: opts[3], correct } };
}

const questions = new Hono<Env>();
questions.use('*', requireRole('admin'), scope, liveExamOnly);

// Every subject with how many questions it has (for the "n / 50" progress bars).
questions.get('/subjects', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.name, COUNT(q.id) AS count
       FROM subjects s LEFT JOIN questions q ON q.subject_id = s.id AND q.exam_id = ?
      GROUP BY s.id ORDER BY s.rowid`,
  )
    .bind(c.get('examId'))
    .all();
  return c.json({ subjects: results, max: MAX_PER_SUBJECT });
});

// Questions of one subject.
questions.get('/', async (c) => {
  const subject = c.req.query('subject');
  if (!subject) return c.json({ error: 'Choose a subject.' }, 400);
  const { results } = await c.env.DB.prepare(
    `SELECT id, subject_id AS subjectId, body, option_a AS a, option_b AS b, option_c AS c, option_d AS d, correct
       FROM questions WHERE subject_id = ? AND exam_id = ? ORDER BY id`,
  )
    .bind(subject, c.get('examId'))
    .all();
  return c.json({ questions: results });
});

// Add one question.
questions.post('/', async (c) => {
  const input = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const subjectId = typeof input.subjectId === 'string' ? input.subjectId : '';
  const subject = await c.env.DB.prepare('SELECT id, name FROM subjects WHERE id = ?').bind(subjectId).first<{ id: string; name: string }>();
  if (!subject) return c.json({ error: 'Choose a subject.' }, 400);

  const r = check(input);
  if (!r.ok) return c.json({ error: r.error }, 400);

  // The "fewer than 50" test runs inside the INSERT itself, so two admins adding at the same moment cannot pass 50.
  const res = await c.env.DB.prepare(
    `INSERT INTO questions (subject_id, body, option_a, option_b, option_c, option_d, correct, session_id, exam_id)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
      WHERE (SELECT COUNT(*) FROM questions WHERE subject_id = ?1 AND exam_id = ?9) < ${MAX_PER_SUBJECT}`,
  )
    .bind(subject.id, r.v.body, r.v.a, r.v.b, r.v.c, r.v.d, r.v.correct, c.get('sessionId'), c.get('examId'))
    .run();
  if (!res.meta.changes) return c.json({ error: `${subject.name} already has ${MAX_PER_SUBJECT} questions.` }, 409);
  return c.json({ ok: true, id: res.meta.last_row_id }, 201);
});

// Edit a question.
questions.put('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const input = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const r = check(input);
  if (!r.ok) return c.json({ error: r.error }, 400);
  const res = await c.env.DB.prepare(
    'UPDATE questions SET body = ?, option_a = ?, option_b = ?, option_c = ?, option_d = ?, correct = ? WHERE id = ? AND exam_id = ?',
  )
    .bind(r.v.body, r.v.a, r.v.b, r.v.c, r.v.d, r.v.correct, id, c.get('examId'))
    .run();
  return res.meta.changes ? c.json({ ok: true }) : c.json({ error: 'Question not found.' }, 404);
});

// Delete a question (not allowed once a student has answered it).
questions.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const used = await c.env.DB.prepare('SELECT 1 AS x FROM answers WHERE question_id = ? LIMIT 1').bind(id).first();
  if (used) return c.json({ error: 'A student has already answered this question, so it cannot be deleted.' }, 409);
  const res = await c.env.DB.prepare('DELETE FROM questions WHERE id = ? AND exam_id = ?').bind(id, c.get('examId')).run();
  return res.meta.changes ? c.json({ ok: true }) : c.json({ error: 'Question not found.' }, 404);
});

// Bulk upload. The page reads the CSV and sends the rows here as JSON.
// Rows that are wrong, or that would push a subject past 50, are skipped and reported. The rest are saved together.
questions.post('/import', async (c) => {
  const body = await c.req
    .json<{ rows?: { row?: number; subject?: string; question?: string; a?: string; b?: string; c?: string; d?: string; correct?: string }[] }>()
    .catch(() => ({}) as { rows?: [] });
  const rows = body.rows;
  if (!Array.isArray(rows) || rows.length === 0) return c.json({ error: 'The file has no questions in it.' }, 400);
  if (rows.length > MAX_IMPORT_ROWS) return c.json({ error: `Upload at most ${MAX_IMPORT_ROWS} questions at a time.` }, 400);

  const { results: subjectRows } = await c.env.DB.prepare(
    `SELECT s.id, s.name, COUNT(q.id) AS count FROM subjects s LEFT JOIN questions q ON q.subject_id = s.id AND q.exam_id = ? GROUP BY s.id`,
  )
    .bind(c.get('examId'))
    .all<{ id: string; name: string; count: number }>();
  const bySubject = new Map<string, { id: string; name: string; count: number }>();
  for (const s of subjectRows) {
    bySubject.set(s.id.toLowerCase(), s);
    bySubject.set(s.name.toLowerCase(), s);
  }

  const skipped: { row: number; reason: string }[] = [];
  const statements: D1PreparedStatement[] = [];
  const addedBySubject: Record<string, number> = {};

  rows.forEach((r, i) => {
    const rowNo = r.row ?? i + 2;
    const subject = bySubject.get(String(r.subject ?? '').trim().toLowerCase());
    if (!subject) return skipped.push({ row: rowNo, reason: `Unknown subject "${r.subject ?? ''}".` });
    const checked = check(r);
    if (!checked.ok) return skipped.push({ row: rowNo, reason: checked.error });
    if (subject.count >= MAX_PER_SUBJECT) return skipped.push({ row: rowNo, reason: `${subject.name} already has ${MAX_PER_SUBJECT} questions.` });

    subject.count++;
    addedBySubject[subject.name] = (addedBySubject[subject.name] ?? 0) + 1;
    const v = checked.v;
    statements.push(
      c.env.DB.prepare(
        'INSERT INTO questions (subject_id, body, option_a, option_b, option_c, option_d, correct, session_id, exam_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(subject.id, v.body, v.a, v.b, v.c, v.d, v.correct, c.get('sessionId'), c.get('examId')),
    );
  });

  if (statements.length) await c.env.DB.batch(statements); // all saved together, or none
  return c.json({ ok: true, added: statements.length, addedBySubject, skipped });
});

export default questions;
