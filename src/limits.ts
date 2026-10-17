// Login attempt limiting: 5 wrong tries in 15 minutes locks that account (student code or admin email) for 5 minutes.
const MAX_FAILS = 5;
const WINDOW_SECONDS = 15 * 60;
const LOCK_SECONDS = 5 * 60;
const now = () => Math.floor(Date.now() / 1000);

export async function lockedMinutes(db: D1Database, key: string): Promise<number> {
  const row = await db.prepare('SELECT locked_until AS until FROM login_attempts WHERE key = ?').bind(key).first<{ until: number }>();
  return row && row.until > now() ? Math.ceil((row.until - now()) / 60) : 0;
}

export async function recordFail(db: D1Database, key: string) {
  const t = now();
  await db
    .prepare(
      `INSERT INTO login_attempts (key, fails, locked_until, last_at) VALUES (?1, 1, 0, ?2)
       ON CONFLICT (key) DO UPDATE SET
         fails        = CASE WHEN last_at < ?2 - ${WINDOW_SECONDS} THEN 1 ELSE fails + 1 END,
         locked_until = CASE WHEN (CASE WHEN last_at < ?2 - ${WINDOW_SECONDS} THEN 1 ELSE fails + 1 END) >= ${MAX_FAILS} THEN ?2 + ${LOCK_SECONDS} ELSE 0 END,
         last_at      = ?2`,
    )
    .bind(key, t)
    .run();
}

export async function clearFails(db: D1Database, key: string) {
  await db.prepare('DELETE FROM login_attempts WHERE key = ?').bind(key).run();
}

export const lockMessage = (m: number) => `Too many wrong attempts. Please try again in ${m} minute${m === 1 ? '' : 's'}.`;
