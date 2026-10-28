import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.mjs';

async function archived(f) {
 const p=await f.start();
 const q=p.subjects[0].questions[0].id;
 await f.request('/api/student/exam/answer',{method:'PUT',body:{attemptId:p.attemptId,questionId:q,chosen:'A',revision:2}});
 const now=Math.floor(Date.now()/1000);
 await f.request('/api/student/exam/focus-event',{method:'POST',body:{attemptId:p.attemptId,eventId:'test-focus-event-123456',occurredAt:now}});
 await f.request('/api/student/exam/submit',{method:'POST',body:{attemptId:p.attemptId}});
 const original={attempt:f.sql.prepare('SELECT * FROM attempts').get(),answers:f.sql.prepare('SELECT * FROM answers').all(),scores:f.sql.prepare('SELECT * FROM scores ORDER BY subject_id').all(),questions:f.sql.prepare('SELECT * FROM attempt_questions ORDER BY question_id').all(),events:f.sql.prepare('SELECT * FROM exam_focus_events').all()};
 await f.request('/api/admin/students/TEST1/retake',{role:'admin',method:'POST',body:{attemptId:p.attemptId,reason:'Mistaken retake'}});
 return {p,original};
}
const restore=(f,id,role='admin',code='TEST1')=>f.request(`/api/admin/students/${code}/restore-attempt`,{role,method:'POST',body:{attemptId:id}});

test('restores exact submitted archive, answers, questions, scores, events and hidden release state',async t=>{
 const f=fixture({perSubject:80});t.after(f.close);
 const {p,original}=await archived(f);
 const result=await restore(f,p.attemptId);
 assert.equal(result.status,200);assert.equal(result.body.score,2);assert.equal(result.body.total,400);
 assert.deepEqual(f.sql.prepare('SELECT * FROM attempts').get(),original.attempt);
 assert.deepEqual(f.sql.prepare('SELECT * FROM answers').all(),original.answers);
 assert.deepEqual(f.sql.prepare('SELECT * FROM scores ORDER BY subject_id').all(),original.scores);
 assert.deepEqual(f.sql.prepare('SELECT * FROM attempt_questions ORDER BY question_id').all(),original.questions);
 assert.deepEqual(f.sql.prepare('SELECT * FROM exam_focus_events').all(),original.events);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM attempt_archives').get().n,1);
 assert.equal((await f.request('/api/admin/results',{role:'admin'})).body.results.length,1);
 assert.equal((await f.request('/api/student/exam')).body.released,false);
 assert.equal((await restore(f,p.attemptId)).status,409);
 assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='restore-attempt'").get().n,1);
 assert.deepEqual(f.sql.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('refuses students, wrong identities and overwriting a newer sitting',async t=>{
 const f=fixture();t.after(f.close);const {p}=await archived(f);
 assert.equal((await restore(f,p.attemptId,'student')).status,401);
 assert.equal((await restore(f,p.attemptId,'admin','TEST2')).status,404);
 const newer=await f.start();
 assert.equal((await restore(f,p.attemptId)).status,409);
 assert.equal(f.sql.prepare('SELECT id FROM attempts').get().id,newer.attemptId);
});

test('bad archived question reference rolls back the entire restoration',async t=>{
 t.mock.method(console, 'error', () => {});
 const f=fixture();t.after(f.close);const {p}=await archived(f);
 const a=JSON.parse(f.sql.prepare('SELECT attempt_json FROM attempt_archives').get().attempt_json);
 a.questionIds.push(99999999);
 f.sql.prepare('UPDATE attempt_archives SET attempt_json=?').run(JSON.stringify(a));
 assert.equal((await restore(f,p.attemptId)).status,500);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM attempts').get().n,0);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM attempt_questions').get().n,0);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM answers').get().n,0);
});
