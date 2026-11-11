import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { fixture } from './helpers.mjs';

function tokenFor(space, studentId, examId, version) {
  const payload = `DC1.${space}.${studentId}.${examId}.${version}`;
  const signature = createHmac('sha256', 'damiland-login-qr-v1:synthetic-test-key-never-used-in-production')
    .update(payload).digest('base64url');
  return payload + '.' + signature;
}

const cookie = response => response.headers.get('set-cookie').split(';')[0];

test('SS3 QR and manual login share one attempt, and resetting the password revokes the printed QR', async t => {
  const f = fixture({ perSubject: 100 });
  t.after(f.close);
  const reset = () => f.request('/api/admin/students/TEST1/reset-password', { role: 'admin', method: 'POST', body: {} });
  const { body: { password } } = await reset();
  const slip = '/api/admin/students/TEST1/password?qr=1';
  assert.equal((await f.request(slip)).status, 401);
  const card = await f.request(slip, { role: 'admin' });
  assert.match(card.body.qr, /^data:image\/gif;base64,/);
  assert.equal(card.body.password, password);

  const scan = token => f.request('/api/student/qr-login', { method: 'POST', cookies: '', body: { token } });
  const token = tokenFor('ss3', 1, 1, 1);
  assert.equal((await scan(tokenFor('ss3', 1, 2, 1))).status, 401);
  assert.equal((await scan(token.replace('ss3.1.', 'ss3.2.'))).status, 401);
  const qrLogin = await scan(token);
  assert.equal(qrLogin.status, 200);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM attempts').get().n, 0);

  const exam = (suffix = '', options = {}) => f.request('/api/student/exam' + suffix, options);
  const started = await exam('/start', { cookies: cookie(qrLogin), method: 'POST', body: { examId: 1, groupNo: 2 } });
  assert.equal(started.status, 201);
  const original = (await exam('', { cookies: cookie(qrLogin) })).body;
  const questionId = original.subjects[0].questions[0].id;
  assert.equal((await exam('/answer', { cookies: cookie(qrLogin), method: 'PUT', body: { attemptId: original.attemptId, questionId, chosen: 'A', revision: 1 } })).status, 200);

  const manual = await f.request('/api/student/login', { method: 'POST', cookies: '', body: { code: 'TEST1', password } });
  assert.equal(manual.status, 200);
  const resumed = (await exam('', { cookies: cookie(manual) })).body;
  assert.equal(resumed.attemptId, original.attemptId);
  assert.deepEqual(resumed.subjects, original.subjects);
  assert.equal(resumed.answers[questionId], 'A');
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM attempts').get().n, 1);
  assert.equal((await exam('/submit', { cookies: cookie(manual), method: 'POST', body: { attemptId: original.attemptId } })).status, 200);
  assert.equal((await exam('', { cookies: cookie(await scan(token)) })).body.status, 'submitted');
  await reset();
  assert.equal((await scan(token)).status, 401);
});

test('Digital Technologies QR activates with its paper and resumes a manually started attempt', async t => {
  const f = fixture({ perSubject: 0 });
  t.after(f.close);
  const admin = (path, method = 'GET', body) => f.request('/api/digital/admin/SS2' + path, { role: 'admin', method, body });
  const { body: { selected: examId } } = await admin('/exams');
  const { body: student } = await admin('/students', 'POST', { firstName: 'Test', lastName: 'Student' });
  const card = (await admin('/login-cards')).body.cards[0];
  assert.match(card.qr, /^data:image\/gif;base64,/);
  assert.equal(card.password, student.password);
  const token = tokenFor('digital', student.id, examId, 0);
  const login = (route, body) => f.request('/api/digital/student/' + route, { method: 'POST', cookies: '', body });
  assert.equal((await login('qr-login', { token })).status, 401);
  const rows = Array.from({ length: 100 }, (_, i) => ({ question: 'Test question ' + i, a: 'One', b: 'Two', c: 'Three', d: 'Four', correct: 'A' }));
  assert.equal((await admin('/questions/import', 'POST', { rows })).body.added, 100);
  assert.equal((await admin('/settings', 'PATCH', { state: 'open' })).status, 200);

  const manual = await login('login', { cohort: 'SS2', code: student.code, password: student.password });
  assert.equal(manual.status, 200);
  const exam = (suffix = '', options = {}) => f.request('/api/digital/student/exam' + suffix, options);
  assert.equal((await exam('/start', { cookies: cookie(manual), method: 'POST', body: { examId } })).status, 201);
  const original = (await exam('', { cookies: cookie(manual) })).body;
  const scan = await login('qr-login', { token });
  assert.equal(scan.status, 200);
  const resumed = (await exam('', { cookies: cookie(scan) })).body;
  assert.equal(resumed.attemptId, original.attemptId);
  assert.deepEqual(resumed.questions, original.questions);
  assert.equal(resumed.questions.length, 30);
  await admin('/students/' + student.id + '/reset-password', 'POST', {});
  assert.equal((await login('qr-login', { token })).status, 401);
});
