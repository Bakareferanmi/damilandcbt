import { Hono } from 'hono';
import { deleteCookie } from 'hono/cookie';
import { COOKIE, currentSessionId, liveExamOnly, readSession, requireRole, scope, startSession, type Env } from './auth';
import { decryptSecret, encryptSecret, hashPassword, randomPassword, verifyPassword } from './crypto';
import { clearFails, lockedMinutes, lockMessage, recordFail } from './limits';
import exam from './exam';
import exams from './exams';
import questions from './questions';
import results from './results';
import settings from './settings';

const CLASSES = ['SS3 Art', 'SS3 Commercial', 'SS3 Science'] as const;


// "ada okafor-eze" -> "Ada Okafor-Eze". Also tidies spaces.
function properName(x: unknown) {
  return String(x ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/(^|[\s\-'’])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

// Reads first + last name from the request (older clients may send fullName).
function readName(b: { firstName?: string; lastName?: string; fullName?: string }) {
  if (b.firstName !== undefined || b.lastName !== undefined) {
    const first = properName(b.firstName), last = properName(b.lastName);
    if (first.length < 2) return { error: 'Enter the student’s first name.' };
    if (last.length < 2) return { error: 'Enter the student’s last name.' };
    return { name: `${first} ${last}` };
  }
  const full = properName(b.fullName);
  return full.length < 3 ? { error: 'Enter the student’s name.' } : { name: full };
}

// The key that locks the saved student passwords (PASSWORD_KEY, or JWT_SECRET when that is not set).
const pwKey = (env: { PASSWORD_KEY?: string; JWT_SECRET: string }) => {
  const k = env.PASSWORD_KEY || env.JWT_SECRET;
  if (!k) throw new Error('JWT_SECRET is not set. See README.');
  return k;
};

const app = new Hono<Env>();

// API replies hold names and answers: never let a browser or proxy keep a copy.
app.use('/api/*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
});

// Lock-out keys include the caller's IP, so one person typing wrong passwords locks THEMSELVES out, not the real student.
const ipOf = (c: { req: { header: (n: string) => string | undefined } }) => c.req.header('cf-connecting-ip') ?? 'local';

// Show a clear message (instead of a blank "Internal Server Error") when something unexpected breaks.
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'Something went wrong. Please try again. If it keeps happening, tell your teacher or the administrator.' }, 500);
});

// ---------- health ----------

app.get('/api/health', async (c) => {
  const row = await c.env.DB.prepare('SELECT COUNT(*) AS subjects FROM subjects').first<{ subjects: number }>();
  return c.json({ ok: true, subjects: row?.subjects ?? 0 });
});

// ---------- login / logout ----------

app.post('/api/admin/login', async (c) => {
  const { email, password } = await c.req.json<{ email?: string; password?: string }>().catch(() => ({}) as any);
  if (!email || !password) return c.json({ error: 'Enter your email address and password.' }, 400);

  const key = 'a:' + email.trim().toLowerCase() + ':' + ipOf(c);
  const wait = await lockedMinutes(c.env.DB, key);
  if (wait) return c.json({ error: lockMessage(wait) }, 429);

  const admin = await c.env.DB.prepare('SELECT id, email, password_hash FROM admins WHERE email = ?')
    .bind(email.trim().toLowerCase())
    .first<{ id: number; email: string; password_hash: string }>();

  if (!admin || !(await verifyPassword(password, admin.password_hash))) {
    if (admin) await recordFail(c.env.DB, key); // wrong guesses for emails that do not exist write nothing
    return c.json({ error: 'Email or password is not correct.' }, 401);
  }
  await clearFails(c.env.DB, key);
  await startSession(c, 'admin', admin.id);
  return c.json({ ok: true, role: 'admin', email: admin.email });
});

app.post('/api/student/login', async (c) => {
  const { code, password } = await c.req.json<{ code?: string; password?: string }>().catch(() => ({}) as any);
  if (!code || !password) return c.json({ error: 'Enter your student code and password.' }, 400);

  const key = 's:' + code.trim().toUpperCase() + ':' + ipOf(c);
  const wait = await lockedMinutes(c.env.DB, key);
  if (wait) return c.json({ error: lockMessage(wait) }, 429);

  const student = await c.env.DB.prepare(
    'SELECT id, code, full_name, class_name, password_hash FROM students WHERE code = ? AND session_id = ?',
  )
    .bind(code.trim().toUpperCase(), await currentSessionId(c.env.DB))
    .first<{ id: number; code: string; full_name: string; class_name: string; password_hash: string }>();

  if (!student || !(await verifyPassword(password.trim().toUpperCase(), student.password_hash))) {
    if (student) await recordFail(c.env.DB, key); // codes that do not exist write nothing
    return c.json({ error: 'Student code or password is not correct.' }, 401);
  }
  await clearFails(c.env.DB, key);
  await startSession(c, 'student', student.id);
  return c.json({ ok: true, role: 'student', name: student.full_name, code: student.code, className: student.class_name });
});

app.post('/api/logout', (c) => {
  deleteCookie(c, COOKIE, { path: '/' });
  return c.json({ ok: true });
});

app.get('/api/me', async (c) => {
  const session = await readSession(c);
  if (!session) return c.json({ error: 'Not logged in.' }, 401);

  if (session.role === 'admin') {
    const admin = await c.env.DB.prepare('SELECT email FROM admins WHERE id = ?').bind(session.id).first<{ email: string }>();
    return admin ? c.json({ role: 'admin', email: admin.email }) : c.json({ error: 'Not logged in.' }, 401);
  }
  const s = await c.env.DB.prepare('SELECT code, full_name, class_name FROM students WHERE id = ? AND session_id = ?')
    .bind(session.id, await currentSessionId(c.env.DB))
    .first<{ code: string; full_name: string; class_name: string }>();
  return s
    ? c.json({ role: 'student', name: s.full_name, code: s.code, className: s.class_name })
    : c.json({ error: 'Not logged in.' }, 401);
});

// ---------- admin: students ----------

app.get('/api/admin/students', requireRole('admin'), scope, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT s.code, s.full_name AS fullName, s.class_name AS className, (s.password_enc IS NOT NULL) AS hasPassword,
            CASE WHEN a.id IS NULL THEN 'none' WHEN a.submitted_at IS NULL THEN 'in_progress' ELSE 'submitted' END AS status
       FROM students s LEFT JOIN attempts a ON a.student_id = s.id AND a.exam_id = ? WHERE s.session_id = ? ORDER BY s.seq ASC`,
  )
    .bind(c.get('examId'), c.get('sessionId'))
    .all();
  return c.json({ students: results });
});

app.put('/api/admin/students/:code', requireRole('admin'), scope, async (c) => {
  const body = await c.req.json<{ firstName?: string; lastName?: string; fullName?: string; className?: string }>().catch(() => ({}) as any);
  const parsed = readName(body);
  if ('error' in parsed) return c.json({ error: parsed.error }, 400);
  const name = parsed.name, className = body.className;
  if (!CLASSES.includes(className as (typeof CLASSES)[number])) return c.json({ error: 'Select the student’s class.' }, 400);
  const res = await c.env.DB.prepare('UPDATE students SET full_name = ?, class_name = ? WHERE code = ? AND session_id = ?')
    .bind(name, className, (c.req.param('code') ?? '').toUpperCase(), c.get('sessionId'))
    .run();
  return res.meta.changes ? c.json({ ok: true }) : c.json({ error: 'Student not found.' }, 404);
});

// Shows a student's current password to an admin (for a student who forgot it and did not write it down).
// Only students whose password was created or reset after this feature was added have one saved.
app.get('/api/admin/students/:code/password', requireRole('admin'), scope, async (c) => {
  const row = await c.env.DB.prepare('SELECT password_enc FROM students WHERE code = ? AND session_id = ?')
    .bind((c.req.param('code') ?? '').toUpperCase(), c.get('sessionId'))
    .first<{ password_enc: string | null }>();
  if (!row) return c.json({ error: 'Student not found.' }, 404);
  const password = await decryptSecret(row.password_enc, pwKey(c.env));
  if (!password) return c.json({ error: 'This password was not saved, so it cannot be shown. Use “Reset password” to give the student a new one.' }, 404);
  return c.json({ ok: true, password });
});

// Gives a student a new password (the old one stops working). Also saved (encrypted) so an admin can view it again.
app.post('/api/admin/students/:code/reset-password', requireRole('admin'), scope, async (c) => {
  const password = randomPassword(6);
  const res = await c.env.DB.prepare('UPDATE students SET password_hash = ?, password_enc = ? WHERE code = ? AND session_id = ?')
    .bind(await hashPassword(password), await encryptSecret(password, pwKey(c.env)), (c.req.param('code') ?? '').toUpperCase(), c.get('sessionId'))
    .run();
  return res.meta.changes ? c.json({ ok: true, password }) : c.json({ error: 'Student not found.' }, 404);
});

// Lets a student sit again: erases their attempt (answers and score) so they can start fresh.
app.post('/api/admin/students/:code/retake', requireRole('admin'), scope, liveExamOnly, async (c) => {
  const row = await c.env.DB.prepare('SELECT a.id AS attemptId FROM students s JOIN attempts a ON a.student_id = s.id AND a.exam_id = ? WHERE s.code = ? AND s.session_id = ?')
    .bind(c.get('examId'), (c.req.param('code') ?? '').toUpperCase(), c.get('sessionId'))
    .first<{ attemptId: number }>();
  if (!row) return c.json({ error: 'This student has not started this exam.' }, 404);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM scores WHERE attempt_id = ?').bind(row.attemptId),
    c.env.DB.prepare('DELETE FROM answers WHERE attempt_id = ?').bind(row.attemptId),
    c.env.DB.prepare('DELETE FROM attempts WHERE id = ?').bind(row.attemptId),
  ]);
  return c.json({ ok: true });
});

// Deletes a student who has not started the exam (for registration mistakes).
app.delete('/api/admin/students/:code', requireRole('admin'), scope, async (c) => {
  const res = await c.env.DB.prepare(
    'DELETE FROM students WHERE code = ? AND session_id = ? AND NOT EXISTS (SELECT 1 FROM attempts WHERE student_id = students.id)',
  )
    .bind((c.req.param('code') ?? '').toUpperCase(), c.get('sessionId'))
    .run();
  if (res.meta.changes) return c.json({ ok: true });
  return c.json({ error: 'This student has started the exam, so they cannot be deleted. Use “Allow retake” first if you need to reset them.' }, 409);
});

app.post('/api/admin/students', requireRole('admin'), scope, async (c) => {
  const body = await c.req.json<{ firstName?: string; lastName?: string; fullName?: string; className?: string }>().catch(() => ({}) as any);
  const parsed = readName(body);
  if ('error' in parsed) return c.json({ error: parsed.error }, 400);
  const name = parsed.name, className = body.className;
  if (!CLASSES.includes(className as (typeof CLASSES)[number])) return c.json({ error: 'Select the student’s class.' }, 400);

  const password = randomPassword(6);
  const passwordHash = await hashPassword(password);
  const passwordEnc = await encryptSecret(password, pwKey(c.env));

  // The next number (per session: every session starts again at 001) is worked out inside the same SQL
  // statement, so two admins registering at the same moment cannot receive the same code.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const row = await c.env.DB.prepare(
        `INSERT INTO students (session_id, seq, code, full_name, class_name, password_hash, password_enc)
         SELECT ?4, n, 'DAMILANDCBT' || printf('%03d', n), ?1, ?2, ?3, ?5
           FROM (SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM students WHERE session_id = ?4)
         RETURNING code`,
      )
        .bind(name, className, passwordHash, c.get('sessionId'), passwordEnc)
        .first<{ code: string }>();
      // Login uses the hash. An encrypted copy is kept too, so an admin can view the password later.
      return c.json({ ok: true, code: row!.code, fullName: name, className, password }, 201);
    } catch (err) {
      if (attempt === 2) throw err;
    }
  }
});

// ---------- admin: question bank ----------

app.route('/api/admin/questions', questions);

// ---------- admin: results ----------

app.route('/api/admin/results', results);

// ---------- admin: exams inside a session ----------

app.route('/api/admin/exams', exams);

// ---------- admin: settings, other admins, own password ----------

app.route('/api/admin', settings);

// ---------- student: exam ----------

app.route('/api/student/exam', exam);

// Anything else under /api is a 404 (static pages are served by Cloudflare itself).
app.all('/api/*', (c) => c.json({ error: 'Not found.' }, 404));

export default app;
