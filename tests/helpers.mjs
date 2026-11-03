import { DatabaseSync } from 'node:sqlite';
import { createHmac, pbkdf2Sync } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { build } from 'esbuild';

// Run the actual bundled API against SQLite. This adapter tests SQL/route correctness,
// not Cloudflare's distributed latency, quotas or D1 billing metadata.
const built = await build({ entryPoints: ['src/index.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { default: app } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
const secret = 'synthetic-test-key-never-used-in-production';
const salt = Buffer.alloc(16, 1);
const hash = 'pbkdf2$100000$' + salt.toString('base64') + '$' + pbkdf2Sync('TESTPASS', salt, 100000, 32, 'sha256').toString('base64');

export function fixture({ students = 2, perSubject = 50, through = Infinity } = {}) {
  const sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys = ON');
  for (const file of readdirSync('migrations').sort()) {
    if (Number(file.slice(0, 4)) <= through) sql.exec(readFileSync('migrations/' + file, 'utf8'));
  }
  sql.prepare('INSERT INTO admins (email, password_hash) VALUES (?, ?)').run('audit@example.test', hash);
  for (let i = 1; i <= students; i++) sql.prepare('INSERT INTO students (session_id, seq, code, full_name, class_name, password_hash) VALUES (1, ?, ?, ?, ?, ?)').run(i, 'TEST' + i, 'Student ' + i, 'SS3 Science', hash);
  for (const { id } of sql.prepare('SELECT id FROM subjects ORDER BY rowid').all()) {
    for (let i = 0; i < perSubject; i++) sql.prepare("INSERT INTO questions (subject_id, body, option_a, option_b, option_c, option_d, correct, session_id, exam_id) VALUES (?, ?, 'One', 'Two', 'Three', 'Four', 'A', 1, 1)").run(id, 'Question ' + i);
  }

  class Statement {
    constructor(query, args = []) { this.query = query; this.args = args; }
    bind(...args) { return new Statement(this.query, args); }
    first(column) { const row = sql.prepare(this.query).get(...this.args); return row ? column ? row[column] : row : null; }
    all() { return { success: true, results: sql.prepare(this.query).all(...this.args), meta: {} }; }
    run() { const r = sql.prepare(this.query).run(...this.args); return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; }
  }
  const DB = {
    prepare: (query) => new Statement(query),
    batch(statements) {
      sql.exec('BEGIN');
      try { const rows = statements.map((statement) => statement.run()); sql.exec('COMMIT'); return Promise.resolve(rows); }
      catch (err) { sql.exec('ROLLBACK'); return Promise.reject(err); }
    },
  };
  function cookie(role = 'student', id = 1, version = 0) {
    const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify({ role, id, v: version, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
    return 'session=' + h + '.' + p + '.' + createHmac('sha256', secret).update(h + '.' + p).digest('base64url');
  }
  async function request(path, { role = 'student', id = 1, version = 0, method = 'GET', body, cookies, headers = {} } = {}) {
    const response = await app.request('https://example.test' + path, {
      method, headers: { cookie: cookies ?? cookie(role, id, version), 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, { DB, JWT_SECRET: secret });
    return { status: response.status, headers: response.headers, body: response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text() };
  }
  async function start(id = 1, groupNo = 2) {
    const r = await request('/api/student/exam/start', { id, method: 'POST', body: { groupNo, examId: 1 } });
    if (r.status !== 201) throw new Error(JSON.stringify(r));
    return (await request('/api/student/exam', { id })).body;
  }
  return { sql, request, start, cookie, close: () => sql.close() };
}

export function memoryStorage() {
  const values = new Map();
  return { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: (k) => values.delete(k) };
}

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
