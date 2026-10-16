import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { currentSessionId, requireRole, VIEW_COOKIE, type Env } from './auth';
import { hashPassword, verifyPassword } from './crypto';

// Admin-only: exam length, other administrators, and your own password. Mounted at /api/admin.
const settings = new Hono<Env>();
const admin = requireRole('admin');

export const DEFAULT_EXAM_MINUTES = 120;
export async function getExamMinutes(db: D1Database) {
  const row = await db.prepare(`SELECT value FROM settings WHERE key = 'exam_minutes'`).first<{ value: string }>();
  const n = Number(row?.value);
  return Number.isInteger(n) && n >= 10 && n <= 360 ? n : DEFAULT_EXAM_MINUTES;
}

settings.get('/settings', admin, async (c) => c.json({ examMinutes: await getExamMinutes(c.env.DB) }));

settings.put('/settings', admin, async (c) => {
  const { examMinutes } = await c.req.json<{ examMinutes?: number }>().catch(() => ({}) as { examMinutes?: number });
  const n = Number(examMinutes);
  if (!Number.isInteger(n) || n < 10 || n > 360) return c.json({ error: 'Enter a whole number of minutes between 10 and 360.' }, 400);
  await c.env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('exam_minutes', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .bind(String(n))
    .run();
  return c.json({ ok: true, examMinutes: n });
});

// ---- administrators ----

settings.get('/admins', admin, async (c) => {
  const me = c.get('session').id;
  const { results } = await c.env.DB.prepare('SELECT id, email, created_at AS createdAt FROM admins ORDER BY id').all<{ id: number; email: string; createdAt: string }>();
  return c.json({ admins: results.map((a) => ({ ...a, you: a.id === me })) });
});

settings.post('/admins', admin, async (c) => {
  const { email, password } = await c.req.json<{ email?: string; password?: string }>().catch(() => ({}) as { email?: string; password?: string });
  const mail = String(email ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) return c.json({ error: 'Enter a valid email address.' }, 400);
  if (!password || password.length < 8) return c.json({ error: 'The password must be at least 8 characters.' }, 400);
  try {
    await c.env.DB.prepare('INSERT INTO admins (email, password_hash) VALUES (?, ?)').bind(mail, await hashPassword(password)).run();
  } catch {
    return c.json({ error: 'An admin with that email already exists.' }, 409);
  }
  return c.json({ ok: true, email: mail }, 201);
});

settings.delete('/admins/:id', admin, async (c) => {
  const id = Number(c.req.param('id'));
  if (id === c.get('session').id) return c.json({ error: 'You cannot remove your own account.' }, 400);
  const res = await c.env.DB.prepare('DELETE FROM admins WHERE id = ?').bind(id).run();
  return res.meta.changes ? c.json({ ok: true }) : c.json({ error: 'Admin not found.' }, 404);
});

// Change your own password.
settings.put('/password', admin, async (c) => {
  const { currentPassword, newPassword } = await c.req.json<{ currentPassword?: string; newPassword?: string }>().catch(() => ({}) as { currentPassword?: string; newPassword?: string });
  if (!newPassword || newPassword.length < 8) return c.json({ error: 'The new password must be at least 8 characters.' }, 400);
  const id = c.get('session').id;
  const row = await c.env.DB.prepare('SELECT password_hash FROM admins WHERE id = ?').bind(id).first<{ password_hash: string }>();
  if (!row || !currentPassword || !(await verifyPassword(currentPassword, row.password_hash))) return c.json({ error: 'Your current password is not correct.' }, 400);
  await c.env.DB.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').bind(await hashPassword(newPassword), id).run();
  return c.json({ ok: true });
});

// ---- academic sessions (2026/2027, 2027/2028, ...) ----
// Each session has its own students, questions and results. Exam length and admins are shared.

function sessionName(x: unknown) {
  const n = String(x ?? '').trim().replace(/\s+/g, ' ');
  return n.length >= 3 && n.length <= 20 ? n : null;
}
function setView(c: any, id: number) {
  setCookie(c, VIEW_COOKIE, String(id), { path: '/', sameSite: 'Lax', httpOnly: true, secure: new URL(c.req.url).protocol === 'https:', maxAge: 365 * 24 * 3600 });
}

settings.get('/sessions', admin, async (c) => {
  const current = await currentSessionId(c.env.DB);
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.name,
            (SELECT COUNT(*) FROM students WHERE session_id = s.id) AS students,
            (SELECT COUNT(*) FROM questions WHERE session_id = s.id) AS questions
       FROM sessions s ORDER BY s.id DESC`,
  ).all<{ id: number; name: string; students: number; questions: number }>();
  let viewing = Number(getCookie(c, VIEW_COOKIE)) || current;
  if (!results.some((r) => r.id === viewing)) viewing = current;
  return c.json({ sessions: results.map((r) => ({ ...r, current: r.id === current })), current, viewing });
});

// Choose which session the admin pages show.
settings.post('/sessions/view', admin, async (c) => {
  const { id } = await c.req.json<{ id?: number }>().catch(() => ({}) as { id?: number });
  const ok = await c.env.DB.prepare('SELECT 1 AS x FROM sessions WHERE id = ?').bind(Number(id)).first();
  if (!ok) return c.json({ error: 'Session not found.' }, 404);
  setView(c, Number(id));
  return c.json({ ok: true });
});

// Start a new session. It becomes the current one: only its students can log in from now on.
settings.post('/sessions', admin, async (c) => {
  const { name, copyQuestions } = await c.req.json<{ name?: string; copyQuestions?: boolean }>().catch(() => ({}) as { name?: string; copyQuestions?: boolean });
  const n = sessionName(name);
  if (!n) return c.json({ error: 'Enter the session name, for example 2027/2028.' }, 400);
  const previous = await currentSessionId(c.env.DB);
  let id: number;
  try {
    const row = await c.env.DB.prepare('INSERT INTO sessions (name) VALUES (?) RETURNING id').bind(n).first<{ id: number }>();
    id = row!.id;
  } catch {
    return c.json({ error: 'A session with that name already exists.' }, 409);
  }
  const steps = [c.env.DB.prepare(`UPDATE settings SET value = ? WHERE key = 'current_session_id'`).bind(String(id))];
  if (copyQuestions) {
    steps.push(
      c.env.DB.prepare(
        `INSERT INTO questions (subject_id, body, option_a, option_b, option_c, option_d, correct, session_id)
         SELECT subject_id, body, option_a, option_b, option_c, option_d, correct, ? FROM questions WHERE session_id = ? ORDER BY id`,
      ).bind(id, previous),
    );
  }
  await c.env.DB.batch(steps);
  setView(c, id);
  return c.json({ ok: true, id, name: n }, 201);
});

settings.put('/sessions/:id', admin, async (c) => {
  const n = sessionName((await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string })).name);
  if (!n) return c.json({ error: 'Enter the session name, for example 2027/2028.' }, 400);
  try {
    const res = await c.env.DB.prepare('UPDATE sessions SET name = ? WHERE id = ?').bind(n, Number(c.req.param('id'))).run();
    return res.meta.changes ? c.json({ ok: true }) : c.json({ error: 'Session not found.' }, 404);
  } catch {
    return c.json({ error: 'A session with that name already exists.' }, 409);
  }
});

export default settings;
