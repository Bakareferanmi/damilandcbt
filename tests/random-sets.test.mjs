import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture } from './helpers.mjs';

test('80-question banks allocate stable distinct sets of 50, reject unassigned answers and mark out of 50', async (t) => {
 const f = fixture({ perSubject: 80 }); t.after(f.close);
 const first = await f.start(1), second = await f.start(2);
 for (const s of first.subjects) {
  assert.equal(s.questions.length, 50);
  assert.equal(new Set(s.questions.map(q => q.id)).size, 50);
  assert.notDeepEqual(s.questions.map(q => q.id).sort((a,b)=>a-b), second.subjects.find(x=>x.id===s.id).questions.map(q=>q.id).sort((a,b)=>a-b));
 }
 assert.deepEqual((await f.request('/api/student/exam')).body.subjects, first.subjects);
 const assigned = first.subjects.flatMap(s=>s.questions.map(q=>q.id));
 const outside = f.sql.prepare("SELECT q.id FROM questions q WHERE q.subject_id = 'eng' AND NOT EXISTS (SELECT 1 FROM attempt_questions aq WHERE aq.attempt_id = ? AND aq.question_id = q.id) LIMIT 1").get(first.attemptId).id;
 const save = (questionId) => f.request('/api/student/exam/answer', {method:'PUT',body:{attemptId:first.attemptId,questionId,chosen:'A',revision:1}});
 assert.equal((await save(outside)).status, 400);
 for (const id of assigned) assert.equal((await save(id)).status,200);
 assert.equal((await f.request('/api/student/exam/submit',{method:'POST',body:{attemptId:first.attemptId}})).status,200);
 const scores = f.sql.prepare('SELECT score,total FROM scores WHERE attempt_id = ?').all(first.attemptId);
 assert.equal(scores.length,4); assert.ok(scores.every(s=>s.score===50 && s.total===50));
 assert.deepEqual(new Set((await f.request('/api/student/exam')).body.questionIds),new Set(assigned));
 const retake = await f.request('/api/admin/students/TEST1/retake',{role:'admin',method:'POST',body:{attemptId:first.attemptId,reason:'Test authorised retake'}});
 assert.equal(retake.status,200);
 assert.deepEqual(new Set(JSON.parse(f.sql.prepare('SELECT attempt_json FROM attempt_archives').get().attempt_json).questionIds),new Set(assigned));
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM attempt_questions WHERE attempt_id=?').get(first.attemptId).n,0);
 assert.equal((await f.start(1)).subjects.flatMap(s=>s.questions).length,200);
});

test('migration keeps all questions of earlier attempts', async (t) => {
 const f=fixture({through:11}); t.after(f.close);
 await f.request('/api/student/exam/start',{method:'POST',body:{groupNo:2,examId:1}});
 f.sql.exec(readFileSync('migrations/0012_random_question_sets.sql','utf8'));
 assert.equal((await f.request('/api/student/exam')).body.subjects.flatMap(s=>s.questions).length,200);
 assert.deepEqual(f.sql.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('expiry and admin closure score random papers out of 50', async(t)=>{
 const f=fixture({perSubject:80});t.after(f.close);
 await f.start(1);await f.start(2);
 f.sql.exec('UPDATE attempts SET ends_at=1 WHERE student_id=1');
 await f.request('/api/student/exam');
 f.sql.exec("INSERT INTO exams(session_id,name,minutes) VALUES(1,'Next',120)");
 assert.equal((await f.request('/api/admin/exams/2/make-live',{role:'admin',method:'POST',body:{confirm:true}})).status,200);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM scores WHERE total=50').get().n,8);
});
