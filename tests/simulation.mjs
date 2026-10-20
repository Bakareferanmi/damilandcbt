import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';

test('70 students each complete 200 questions, revise answers and submit concurrently with exact scores', async (t) => {
  const f = fixture({ students: 70 }); t.after(f.close);
  const papers = await Promise.all(Array.from({ length: 70 }, (_, i) => f.start(i + 1, i % 4 + 1)));
  await Promise.all(papers.map(async (paper, i) => {
    const id = i + 1;
    const questions = paper.subjects.flatMap((s) => s.questions);
    assert.equal(questions.length, 200);
    for (const q of questions) {
      const result = await f.request('/api/student/exam/answer', { id, method: 'PUT', body: { attemptId: paper.attemptId, questionId: q.id, chosen: 'A', revision: 1 } });
      assert.equal(result.status, 200, JSON.stringify(result.body));
    }
    // Change ten answers, then simulate delayed retries of the old choices.
    for (const q of questions.slice(0, 10)) {
      assert.equal((await f.request('/api/student/exam/answer', { id, method: 'PUT', body: { attemptId: paper.attemptId, questionId: q.id, chosen: 'B', revision: 2 } })).status, 200);
      assert.equal((await f.request('/api/student/exam/answer', { id, method: 'PUT', body: { attemptId: paper.attemptId, questionId: q.id, chosen: 'A', revision: 1 } })).status, 409);
    }
  }));
  await Promise.all(papers.flatMap((p, i) => [1, 2].map(() => f.request('/api/student/exam/submit', { id: i + 1, method: 'POST', body: { attemptId: p.attemptId } }).then((r) => assert.equal(r.status, 200)))));
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM answers').get().n, 14000);
  assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM attempts WHERE submitted_at IS NOT NULL AND answered = 200').get().n, 70);
  const scores = f.sql.prepare('SELECT attempt_id, SUM(score) AS score, SUM(total) AS total FROM scores GROUP BY attempt_id').all();
  assert.equal(scores.length, 70);
  for (const row of scores) { assert.equal(row.score, 190); assert.equal(row.total, 200); }
  assert.deepEqual(f.sql.prepare('PRAGMA foreign_key_check').all(), []);
  console.log('SQLite correctness simulation: 70 attempts, 14,000 stored answers, 280 score rows. This is not a Cloudflare load test.');
});
