import type { Context, Next } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { sign, verify } from 'hono/jwt';

// PASSWORD_KEY (optional) encrypts the saved student passwords. If it is not set, JWT_SECRET is used instead.
export type Bindings = { DB: D1Database; JWT_SECRET: string; PASSWORD_KEY?: string };
export type Session = { role: 'admin' | 'student'; id: number; exp: number };
export type Env = { Bindings: Bindings; Variables: { session: Session; sessionId: number; currentSessionId: number; examId: number; currentExamId: number } };

const SESSION_HOURS = 8;
export const COOKIE = 'session';

export async function startSession(c: Context<Env>, role: Session['role'], id: number) {
  if (!c.env.JWT_SECRET) throw new Error('JWT_SECRET is not set. See README: create .dev.vars (local) or run `wrangler secret put JWT_SECRET` (live).');
  const exp = Math.floor(Date.now() / 1000) + SESSION_HOURS * 3600;
  const token = await sign({ role, id, exp }, c.env.JWT_SECRET);
  setCookie(c, COOKIE, token, {
    httpOnly: true, // JavaScript on the page cannot read it
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_HOURS * 3600,
  });
}

export async function readSession(c: Context<Env>): Promise<Session | null> {
  const token = getCookie(c, COOKIE);
  if (!token || !c.env.JWT_SECRET) return null;
  try {
    return (await verify(token, c.env.JWT_SECRET, 'HS256')) as unknown as Session;
  } catch {
    return null;
  }
}

export const requireRole = (role: Session['role']) => async (c: Context<Env>, next: Next) => {
  const session = await readSession(c);
  if (!session || session.role !== role) return c.json({ error: 'Please log in first.' }, 401);
  // A removed admin loses access straight away (the signed cookie alone would stay valid for 8 hours).
  if (role === 'admin' && !(await c.env.DB.prepare('SELECT 1 AS x FROM admins WHERE id = ?').bind(session.id).first())) {
    return c.json({ error: 'Please log in first.' }, 401);
  }
  c.set('session', session);
  await next();
};

// ---------- academic sessions ----------

export const VIEW_COOKIE = 'viewSession';

export async function currentSessionId(db: D1Database) {
  const row = await db.prepare(`SELECT value FROM settings WHERE key = 'current_session_id'`).first<{ value: string }>();
  return Number(row?.value) || 1;
}

export const VIEW_EXAM_COOKIE = 'viewExam';

export async function currentExamId(db: D1Database) {
  const row = await db.prepare(`SELECT value FROM settings WHERE key = 'current_exam_id'`).first<{ value: string }>();
  return Number(row?.value) || 1;
}

// For admin pages: works out which session AND which exam the admin is looking at (their choice, else the live ones).
// Past sessions are read-only, except releasing results.
export const scope = async (c: Context<Env>, next: Next) => {
  const current = await currentSessionId(c.env.DB);
  const liveExam = await currentExamId(c.env.DB);
  let id = Number(getCookie(c, VIEW_COOKIE)) || current;
  if (id !== current) {
    const ok = await c.env.DB.prepare('SELECT 1 AS x FROM sessions WHERE id = ?').bind(id).first();
    if (!ok) id = current;
  }
  // The exam must belong to the session being viewed; otherwise use the live exam (current session) or the latest one.
  let exam = Number(getCookie(c, VIEW_EXAM_COOKIE)) || 0;
  const okExam = exam ? await c.env.DB.prepare('SELECT 1 AS x FROM exams WHERE id = ? AND session_id = ?').bind(exam, id).first() : null;
  if (!okExam) {
    exam = id === current
      ? liveExam
      : (await c.env.DB.prepare('SELECT MAX(id) AS id FROM exams WHERE session_id = ?').bind(id).first<{ id: number | null }>())?.id ?? liveExam;
  }
  c.set('sessionId', id);
  c.set('currentSessionId', current);
  c.set('examId', exam);
  c.set('currentExamId', liveExam);
  if (c.req.method !== 'GET' && id !== current && !c.req.path.endsWith('/release')) {
    return c.json({ error: 'This is a past session and is read-only. Switch to the current session to make changes.' }, 403);
  }
  await next();
};

// For routes that change exam content (questions, retakes): only the LIVE exam can be changed.
export const liveExamOnly = async (c: Context<Env>, next: Next) => {
  if (c.req.method !== 'GET' && c.get('examId') !== c.get('currentExamId') && !c.req.path.endsWith('/release')) {
    return c.json({ error: 'This exam is not the live one, so it is read-only. Choose the live exam in the sidebar, or make this one live in Settings.' }, 403);
  }
  await next();
};
