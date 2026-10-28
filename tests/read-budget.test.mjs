import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture } from './helpers.mjs';

const migration = readFileSync('migrations/0014_monitor_read_budget.sql', 'utf8');
const source = readFileSync('src/results.ts', 'utf8');
const monitorSql = source.slice(source.indexOf("results.get('/monitor'")).match(/`(SELECT[\s\S]*?)`/)[1];

test('migration backfills old attempts without changing answers, scores or allocations', async t => {
  const f = fixture({through:13}); t.after(f.close);
  const paper = await f.start();
  const q = paper.subjects[0].questions[0].id;
  await f.request('/api/student/exam/answer', {method:'PUT',body:{attemptId:paper.attemptId,questionId:q,chosen:'A',revision:1}});
  f.sql.prepare('INSERT INTO exam_focus_events(attempt_id,event_id,occurred_at) VALUES(?,?,?)').run(paper.attemptId,'existing-event',123);
  const before = f.sql.prepare('SELECT * FROM answers').all();
  f.sql.exec(migration);
  const row = f.sql.prepare('SELECT assigned_total,focus_count,last_focus_at FROM attempts').get();
  assert.deepEqual({...row},{assigned_total:200,focus_count:1,last_focus_at:123});
  assert.deepEqual(f.sql.prepare('SELECT * FROM answers').all(),before);
  const response = await f.request('/api/admin/results/monitor',{role:'admin'});
  assert.equal(response.body.students[0].total,200);
  assert.equal(response.body.students[0].answered,1);
  assert.equal(response.body.students[0].tabSwitches,1);
  assert.deepEqual(f.sql.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('new allocations and idempotent out-of-order focus events maintain summaries', async t => {
 const f=fixture({perSubject:80});t.after(f.close);
 const p=await f.start();
 const ins=f.sql.prepare('INSERT OR IGNORE INTO exam_focus_events(attempt_id,event_id,occurred_at) VALUES(?,?,?)');
 ins.run(p.attemptId,'event1',200);ins.run(p.attemptId,'event1',200);ins.run(p.attemptId,'event2',100);
 const row=f.sql.prepare('SELECT assigned_total,focus_count,last_focus_at FROM attempts').get();
 assert.deepEqual({...row},{assigned_total:200,focus_count:2,last_focus_at:200});
 const plan=f.sql.prepare('EXPLAIN QUERY PLAN '+monitorSql).all(1,1).map(r=>r.detail).join('\n');
 assert.doesNotMatch(plan,/attempt_questions|exam_focus_events/);
 assert.match(plan,/idx_students_session_seq/);
 const r=await f.request('/api/admin/results/monitor',{role:'admin'});
 assert.equal(r.body.students[0].total,200);assert.equal(r.body.students[0].tabSwitches,2);
 assert.equal(r.body.students[1].total,0);assert.equal(r.body.students[1].tabSwitches,0);
});
