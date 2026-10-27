import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';

test('stored question counts become double marks consistently for admin and released student results', async (t) => {
  const f = fixture(); t.after(f.close);
  const paper = await f.start();
  // English: 50 correct; next subject: 25 correct; remaining subjects: zero.
  for (const q of [...paper.subjects[0].questions, ...paper.subjects[1].questions.slice(0, 25)]) {
    await f.request('/api/student/exam/answer', { method: 'PUT', body: { attemptId: paper.attemptId, questionId: q.id, chosen: 'A', revision: 1 } });
  }
  await f.request('/api/student/exam/submit', { method: 'POST', body: { attemptId: paper.attemptId } });
  const raw = f.sql.prepare('SELECT SUM(score) AS score, SUM(total) AS total FROM scores').get();
  assert.equal(raw.score, 75); assert.equal(raw.total, 200);
  for (let i = 0; i < 2; i++) {
    const admin = (await f.request('/api/admin/results', { role: 'admin' })).body.results[0];
    assert.equal(admin.total, 150); assert.equal(admin.outOf, 400);
    assert.deepEqual(admin.scores.map(s => s.score), [100, 50, 0, 0]);
    assert.ok(admin.scores.every(s => s.total === 100));
    await f.request('/api/admin/results/release', { role: 'admin', method: 'POST', body: { all: true } });
    const student = (await f.request('/api/student/exam')).body;
    assert.deepEqual(student.results, admin.scores);
  }
});
