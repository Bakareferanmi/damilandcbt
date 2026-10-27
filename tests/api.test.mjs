import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture } from './helpers.mjs';

const studentPath = '/api/student/exam';
const edit = { role: 'admin', method: 'PUT', body: { body: 'Changed question?', a: 'One', b: 'Two', c: 'Three', d: 'Four', correct: 'B' } };

test('incomplete papers cannot start, including direct inserts and start/edit races', async (t) => {
  const f = fixture({ perSubject: 1 }); t.after(f.close);
  const r = await f.request(studentPath + '/start', { method: 'POST', body: { examId: 1, groupNo: 2 } });
  assert.equal(r.status, 409); assert.match(r.body.error, /50–80/);
  assert.throws(() => f.sql.exec('INSERT INTO attempts(student_id, exam_id, group_no, ends_at) VALUES(1,1,2,9999999999)'), /EXAM_NOT_READY/);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM attempts').get().n, 0);
});

test('start locks the paper, returns 200 questions and never exposes correct answers', async (t) => {
  const f = fixture(); t.after(f.close); const paper = await f.start();
  assert.equal(paper.subjects.flatMap((s) => s.questions).length, 200);
  assert.ok(paper.subjects.every((s) => s.questions.every((q) => !('correct' in q))));
  assert.ok(f.sql.prepare('SELECT locked_at FROM exams').get().locked_at);
  assert.equal((await f.request('/api/admin/questions/1', edit)).status, 409);
  assert.equal((await f.request('/api/admin/questions/1', { role: 'admin', method: 'DELETE' })).status, 409);
  assert.equal((await f.request('/api/admin/exams/1', { role: 'admin', method: 'PUT', body: { name: 'Changed', minutes: 60 } })).status, 409);
  assert.throws(() => f.sql.exec("UPDATE questions SET correct = 'B' WHERE id = 1"), /PAPER_LOCKED/);
  assert.throws(() => f.sql.exec("DELETE FROM questions WHERE id = 1"), /PAPER_LOCKED/);
  assert.throws(() => f.sql.exec("INSERT INTO questions(subject_id,body,option_a,option_b,option_c,option_d,correct,session_id,exam_id) VALUES('eng','New','a','b','c','d','A',1,1)"), /PAPER_LOCKED/);
});

test('retries are idempotent and delayed old answers cannot overwrite a newer revision', async (t) => {
  const f = fixture(); t.after(f.close); const { attemptId } = await f.start();
  const save = (chosen, revision, questionId = 1) => f.request(studentPath + '/answer', { method: 'PUT', body: { attemptId, questionId, chosen, revision } });
  assert.equal((await save('C', 3)).status, 200);
  assert.equal((await save('A', 2)).status, 409);
  assert.equal((await save('C', 3)).status, 200);
  assert.equal((await save('D', 3)).status, 409);
  assert.equal((await save('A', 4)).status, 200);
  assert.equal(f.sql.prepare('SELECT answered FROM attempts').get().answered, 1);
  const row = f.sql.prepare('SELECT chosen, revision FROM answers').get();
  assert.equal(row.chosen, 'A'); assert.equal(row.revision, 4);
  assert.equal((await save('A', 1, 51)).status, 400); // Government is not in science group 2.
  assert.equal((await f.request(studentPath + '/answer', { id: 2, method: 'PUT', body: { attemptId, questionId: 1, chosen: 'A', revision: 1 } })).status, 409);
});

test('submission is idempotent, hides scores until release and blocks subsequent writes', async (t) => {
  const f = fixture(); t.after(f.close); const { attemptId } = await f.start();
  await f.request(studentPath + '/answer', { method: 'PUT', body: { attemptId, questionId: 1, chosen: 'A', revision: 1 } });
  for (let i = 0; i < 2; i++) assert.equal((await f.request(studentPath + '/submit', { method: 'POST', body: { attemptId } })).status, 200);
  let result = await f.request(studentPath); assert.equal(result.body.released, false); assert.equal(result.body.results, undefined);
  assert.equal(result.body.answers[1], 'A'); assert.equal(result.body.attemptId, attemptId);
  assert.equal((await f.request(studentPath + '/answer', { method: 'PUT', body: { attemptId, questionId: 1, chosen: 'B', revision: 2 } })).status, 409);
  await f.request('/api/admin/results/release', { role: 'admin', method: 'POST', body: { all: true } });
  result = await f.request(studentPath);
  assert.equal(result.body.results.length, 4);
  assert.equal(result.body.results.reduce((n, x) => n + x.score, 0), 2);
  assert.equal(result.body.results.reduce((n, x) => n + x.total, 0), 400);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM scores').get().n, 4);
});

test('answers beyond deadline plus grace are rejected and only earlier answers are marked', async (t) => {
  const f = fixture(); t.after(f.close); const { attemptId } = await f.start();
  await f.request(studentPath + '/answer', { method: 'PUT', body: { attemptId, questionId: 1, chosen: 'A', revision: 1 } });
  f.sql.prepare('UPDATE attempts SET ends_at = ?').run(Math.floor(Date.now() / 1000) - 20);
  const late = await f.request(studentPath + '/answer', { method: 'PUT', body: { attemptId, questionId: 2, chosen: 'A', revision: 1 } });
  assert.equal(late.status, 409); assert.equal(late.body.finished, true);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM answers').get().n, 1);
  assert.equal(f.sql.prepare('SELECT SUM(score) AS n FROM scores').get().n, 1);
});

test('retakes preserve the old sitting and cannot unlock papers or replay stale requests', async (t) => {
  const f = fixture(); t.after(f.close); const { attemptId } = await f.start();
  await f.request(studentPath + '/answer', { method: 'PUT', body: { attemptId, questionId: 1, chosen: 'A', revision: 1 } });
  await f.request(studentPath + '/submit', { method: 'POST', body: { attemptId } });
  const r = await f.request('/api/admin/students/TEST1/retake', { role: 'admin', method: 'POST', body: { attemptId, reason: 'Power failure at workstation' } });
  assert.equal(r.status, 200);
  const archive = f.sql.prepare('SELECT * FROM attempt_archives').get();
  assert.equal(JSON.parse(archive.answers_json)[0].chosen, 'A');
  assert.equal(JSON.parse(archive.scores_json).reduce((n, x) => n + x.score, 0), 1);
  assert.equal(archive.authorised_by, 1); assert.match(archive.reason, /Power/);
  const history = await f.request('/api/admin/students/TEST1/attempt-history', { role: 'admin' });
  assert.equal(history.body.history[0].scores.reduce((n, x) => n + x.total, 0), 400);
  assert.equal((await f.request('/api/admin/students/TEST1/attempt-history')).status, 401);
  assert.throws(() => f.sql.exec("UPDATE questions SET correct = 'B' WHERE id = 1"), /PAPER_LOCKED/);
  const next = await f.start(); assert.notEqual(next.attemptId, attemptId);
  assert.equal((await f.request(studentPath + '/submit', { method: 'POST', body: { attemptId } })).status, 409);
  assert.equal(f.sql.prepare('SELECT submitted_at FROM attempts').get().submitted_at, null);
  assert.equal((await f.request('/api/admin/students/TEST1', { role: 'admin', method: 'DELETE' })).status, 409);
});

test('password reset revokes existing student sessions and new login uses the new version', async (t) => {
  const f = fixture(); t.after(f.close);
  assert.equal((await f.request('/api/me')).status, 200);
  const reset = await f.request('/api/admin/students/TEST1/reset-password', { role: 'admin', method: 'POST', body: {} });
  assert.equal(reset.status, 200); assert.equal((await f.request('/api/me')).status, 401);
  const login = await f.request('/api/student/login', { method: 'POST', body: { code: 'TEST1', password: reset.body.password } });
  assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie'), /HttpOnly/);
  assert.equal((await f.request('/api/me', { cookies: login.headers.get('set-cookie').split(';')[0] })).status, 200);
});

test('admin password change revokes old cookies while retaining the changing browser session', async (t) => {
  const f = fixture(); t.after(f.close);
  const r = await f.request('/api/admin/password', { role: 'admin', method: 'PUT', body: { currentPassword: 'TESTPASS', newPassword: 'NEWTESTPASS' } });
  assert.equal(r.status, 200);
  assert.equal((await f.request('/api/admin/students', { role: 'admin' })).status, 401);
  assert.equal((await f.request('/api/admin/students', { cookies: r.headers.get('set-cookie').split(';')[0] })).status, 200);
});

test('migration preserves existing attempts, choices and results, backfills totals and locks old papers', (t) => {
  const f = fixture({ through: 10, perSubject: 1 }); t.after(f.close);
  f.sql.exec("INSERT INTO attempts(student_id,exam_id,group_no,ends_at,submitted_at) VALUES(1,1,2,9999999999,datetime('now')); INSERT INTO answers VALUES(1,1,'A'); INSERT INTO scores VALUES(1,'eng',1)");
  f.sql.exec(readFileSync('migrations/0011_exam_integrity.sql', 'utf8'));
  assert.equal(f.sql.prepare('SELECT chosen, revision FROM answers').get().chosen, 'A');
  assert.equal(f.sql.prepare('SELECT total FROM scores').get().total, 1);
  assert.equal(f.sql.prepare('SELECT score FROM scores').get().score, 1);
  assert.ok(f.sql.prepare('SELECT locked_at FROM exams').get().locked_at);
  assert.deepEqual(f.sql.prepare('PRAGMA foreign_key_check').all(), []);
});

test('switching exams needs confirmation and atomically marks the old sitting before the switch', async (t) => {
  const f = fixture(); t.after(f.close); const { attemptId } = await f.start();
  await f.request(studentPath + '/answer', { method: 'PUT', body: { attemptId, questionId: 1, chosen: 'A', revision: 1 } });
  f.sql.exec("INSERT INTO exams(session_id,name,minutes) VALUES(1,'Next Exam',120)");
  assert.equal((await f.request('/api/admin/exams/2/make-live', { role: 'admin', method: 'POST', body: {} })).status, 409);
  assert.throws(() => f.sql.exec("UPDATE settings SET value = '2' WHERE key = 'current_exam_id'"), /EXAM_STILL_WRITING/);
  const changed = await f.request('/api/admin/exams/2/make-live', { role: 'admin', method: 'POST', body: { confirm: true } });
  assert.equal(changed.status, 200);
  assert.ok(f.sql.prepare('SELECT submitted_at FROM attempts').get().submitted_at);
  assert.equal(f.sql.prepare('SELECT SUM(score) AS n FROM scores').get().n, 1);
  assert.equal(f.sql.prepare('SELECT SUM(total) AS n FROM scores').get().n, 200);
  assert.equal((await f.request(studentPath + '/submit', { method: 'POST', body: { attemptId } })).status, 409);
});

test('starting a new academic session preserves and marks the previous sitting', async (t) => {
  const f = fixture(); t.after(f.close); await f.start();
  const r = await f.request('/api/admin/sessions', { role: 'admin', method: 'POST', body: { name: '2027/2028', copyQuestions: true, confirm: true } });
  assert.equal(r.status, 201);
  assert.equal(f.sql.prepare("SELECT value FROM settings WHERE key = 'current_session_id'").get().value, '2');
  assert.ok(f.sql.prepare('SELECT submitted_at FROM attempts WHERE id = 1').get().submitted_at);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM questions WHERE exam_id = 2').get().n, 500);
  assert.equal((await f.request(studentPath)).status, 403);
});

test('parallel imports cannot exceed eighty questions in a subject', async (t) => {
  const f = fixture({ perSubject: 79 }); t.after(f.close);
  const body = { rows: [{ subject: 'eng', body: 'A new question?', a: 'One', b: 'Two', c: 'Three', d: 'Four', correct: 'A' }] };
  const results = await Promise.all([1, 2].map(() => f.request('/api/admin/questions/import', { role: 'admin', method: 'POST', body })));
  assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM questions WHERE subject_id = 'eng'").get().n, 80);
  assert.equal(results.reduce((n, x) => n + x.body.added, 0), 1);
});
