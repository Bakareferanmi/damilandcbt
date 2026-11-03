import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fixture} from './helpers.mjs';
const base='/api/digital';
const rows=n=>Array.from({length:n},(_,i)=>({question:'Digital question '+i,a:'Correct option',b:'Second option',c:'Third option',d:'Fourth option',correct:'A'}));
const admin=(f,cohort,path,method='GET',body)=>f.request(`${base}/admin/${cohort}${path}`,{role:'admin',method,body});
async function setup(f,cohort='SS1',n=70){
 const papers=await admin(f,cohort,'/exams');assert.equal(papers.status,200,JSON.stringify(papers));const examId=papers.body.selected;
 if(n){const upload=await admin(f,cohort,'/questions/import','POST',{rows:rows(n)});assert.equal(upload.status,200,JSON.stringify(upload));assert.equal(upload.body.added,n)}
 return examId;
}
async function register(f,cohort='SS1',firstName='Akin',lastName='Sample'){
 const created=await admin(f,cohort,'/students','POST',{firstName,lastName});assert.equal(created.status,201,JSON.stringify(created));
 const login=await f.request(base+'/student/login',{method:'POST',cookies:'',body:{cohort,code:created.body.code,password:created.body.password}});assert.equal(login.status,200,JSON.stringify(login));
 return {...created.body,cookies:login.headers.get('set-cookie').split(';')[0],cohort};
}
const student=(f,s,path='',method='GET',body)=>f.request(base+'/student/exam'+path,{cookies:s.cookies,method,body});
async function open(f,cohort='SS1'){const r=await admin(f,cohort,'/settings','PATCH',{state:'open'});assert.equal(r.status,200,JSON.stringify(r))}
async function start(f,s,examId){const r=await student(f,s,'/start','POST',{examId});assert.equal(r.status,201,JSON.stringify(r));return (await student(f,s)).body}

test('SS1 and SS2 spaces each hold 70 questions, require 30 to open and allocate stable random papers of 30',async t=>{
 const f=fixture({perSubject:0});t.after(f.close);const id=await setup(f),s=await register(f),second=await register(f,'SS1','Bola');
 await open(f);const first=await start(f,s,id),next=await start(f,second,id);
 assert.equal(first.total,30);assert.equal(first.questions.length,30);assert.equal(new Set(first.questions.map(q=>q.id)).size,30);
 assert.notDeepEqual(first.questions.map(q=>q.id).sort((a,b)=>a-b),next.questions.map(q=>q.id).sort((a,b)=>a-b));
 assert.deepEqual((await student(f,s)).body.questions,first.questions);assert.ok(first.questions.every(q=>!Object.hasOwn(q,'correct')));
 assert.equal((await student(f,s,'/start','POST',{examId:id})).status,200);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM digital_attempts WHERE student_id=?').get(s.id).n,1);
 const ss2=await setup(f,'SS2',29);assert.equal((await admin(f,'SS2','/settings','PATCH',{state:'open'})).status,409);
 assert.equal((await admin(f,'SS2','/questions/import','POST',{rows:rows(1)})).body.added,1);await open(f,'SS2');const s2=await register(f,'SS2');assert.equal((await start(f,s2,ss2)).questions.length,30);
});
test('class, student and admin authentication boundaries prevent cross-class access and answer injection',async t=>{
 const f=fixture({perSubject:0});t.after(f.close);const id=await setup(f),id2=await setup(f,'SS2');await open(f);await open(f,'SS2');const s=await register(f),s2=await register(f,'SS2');
 assert.equal((await student(f,s,'/start','POST',{examId:id2})).status,403);const p=await start(f,s,id),p2=await start(f,s2,id2);
 assert.equal((await f.request(base+'/student/exam')).status,401,'SS3 cookie is not a digital identity');assert.equal((await f.request('/api/student/exam',{cookies:s.cookies})).status,401);
 assert.equal((await f.request(base+'/admin/SS1/questions',{cookies:s.cookies})).status,401);assert.equal((await admin(f,'SS1','/questions?examId='+id2)).status,404);
 const answer=(q,attemptId=p.attemptId)=>student(f,s,'/answer','PUT',{attemptId,questionId:q,chosen:'A',revision:1});
 assert.equal((await answer(p2.questions[0].id,p2.attemptId)).status,409);assert.equal((await answer(p2.questions[0].id)).status,400);
 const outside=f.sql.prepare('SELECT id FROM digital_questions WHERE exam_id=? AND id NOT IN (SELECT question_id FROM digital_attempt_questions WHERE attempt_id=?) LIMIT 1').get(id,p.attemptId).id;
 assert.equal((await answer(outside)).status,400);
 assert.equal((await f.request(base+'/student/login',{cookies:'',method:'POST',body:{cohort:'SS2',code:s.code,password:s.password}})).status,401);
});
test('answers save idempotently with monotonic revisions, score once out of 30 and remain hidden until release',async t=>{
 const f=fixture({perSubject:0});t.after(f.close);const id=await setup(f);await open(f);const s=await register(f),p=await start(f,s,id);
 const q=p.questions[0].id,save=(chosen,revision)=>student(f,s,'/answer','PUT',{attemptId:p.attemptId,questionId:q,chosen,revision});
 assert.equal((await save('B',2)).status,200);assert.equal((await save('A',1)).status,409);assert.equal((await save('B',2)).status,200);assert.equal((await save('A',3)).status,200);
 for(const question of p.questions.slice(1))assert.equal((await student(f,s,'/answer','PUT',{attemptId:p.attemptId,questionId:question.id,chosen:'A',revision:1})).status,200);
 assert.equal(f.sql.prepare('SELECT answered FROM digital_attempts WHERE id=?').get(p.attemptId).answered,30);
 assert.equal((await student(f,s,'/submit','POST',{attemptId:p.attemptId})).status,200);assert.equal((await student(f,s,'/submit','POST',{attemptId:p.attemptId})).status,200);
 assert.equal(f.sql.prepare('SELECT score FROM digital_attempts WHERE id=?').get(p.attemptId).score,30);
 const hidden=(await student(f,s)).body;assert.equal(hidden.status,'submitted');assert.equal(hidden.released,false);assert.equal(hidden.score,undefined);assert.equal(hidden.questions,undefined);
 await admin(f,'SS1','/settings','PATCH',{released:true});const shown=(await student(f,s)).body;assert.equal(shown.score,30);assert.equal(shown.total,30);assert.equal(shown.percentage,100);assert.equal((await save('B',4)).status,409);
});
test('closed entry preserves in-progress sittings, locked questions cannot change, and a new paper cannot displace writers',async t=>{
 const f=fixture({perSubject:0});t.after(f.close);const id=await setup(f);await open(f);const s=await register(f),p=await start(f,s,id);
 assert.equal((await admin(f,'SS1','/questions/import','POST',{rows:rows(1)})).status,409);
 assert.equal((await admin(f,'SS1','/questions/'+p.questions[0].id,'DELETE')).status,409);
 assert.equal((await admin(f,'SS1','/questions/'+p.questions[0].id,'PUT',rows(1)[0])).status,409);
 assert.equal((await admin(f,'SS1','/settings','PATCH',{minutes:40})).status,409);
 const close=await admin(f,'SS1','/settings','PATCH',{state:'closed'});assert.equal(close.status,200);assert.equal((await student(f,s)).body.status,'in_progress');
 const other=await register(f,'SS1','New');assert.equal((await student(f,other,'/start','POST',{examId:id})).status,409);
 const copy=await admin(f,'SS1','/exams','POST',{name:'Next paper',minutes:30,copyFrom:id});assert.equal(copy.status,201);
 assert.equal((await admin(f,'SS1','/settings?examId='+copy.body.id,'PATCH',{state:'open'})).status,409);
 assert.throws(()=>f.sql.prepare("UPDATE settings SET value='2' WHERE key='current_session_id'").run(),/DIGITAL_SESSION_BUSY/);
 await student(f,s,'/submit','POST',{attemptId:p.attemptId});assert.equal((await admin(f,'SS1','/settings?examId='+copy.body.id,'PATCH',{state:'open'})).status,200);
});
test('capacity and late-answer rules also hold at the database boundary and expired papers are marked by admin review',async t=>{
 const f=fixture({perSubject:0});t.after(f.close);const id=await setup(f);
 const overflow=await admin(f,'SS1','/questions/import','POST',{rows:rows(2)});assert.equal(overflow.body.added,0);assert.equal(overflow.body.skipped.length,2);
 assert.throws(()=>f.sql.prepare("INSERT INTO digital_questions(exam_id,body,option_a,option_b,option_c,option_d,correct) VALUES(?,'extra','A','B','C','D','A')").run(id),/DIGITAL_BANK_FULL/);
 await open(f);const s=await register(f),p=await start(f,s,id);
 await student(f,s,'/answer','PUT',{attemptId:p.attemptId,questionId:p.questions[0].id,chosen:'A',revision:1});
 f.sql.prepare('UPDATE digital_attempts SET ends_at=1 WHERE id=?').run(p.attemptId);
 assert.equal((await student(f,s,'/answer','PUT',{attemptId:p.attemptId,questionId:p.questions[1].id,chosen:'A',revision:1})).status,409);
 const reports=await admin(f,'SS1','/results');assert.equal(reports.body.students[0].score,1);assert.ok(reports.body.students[0].submittedAt);assert.equal(reports.body.total,30);
});
test('password reset revokes only the digital student identity; focus reports are idempotent and result CSV is scoped',async t=>{
 const f=fixture({perSubject:0});t.after(f.close);const id=await setup(f);await open(f);const s=await register(f),p=await start(f,s,id);
 const event={attemptId:p.attemptId,eventId:'01234567-89ab-cdef-0123-456789abcdef',occurredAt:Math.floor(Date.now()/1000)};
 assert.equal((await student(f,s,'/focus-event','POST',event)).status,200);assert.equal((await student(f,s,'/focus-event','POST',event)).status,200);
 assert.equal((await admin(f,'SS1','/results')).body.students[0].tabSwitches,1);
 assert.equal((await admin(f,'SS2','/students/'+s.id+'/reset-password','POST',{})).status,404);
 assert.equal((await admin(f,'SS1','/students/'+s.id+'/reset-password','POST',{})).status,200);assert.equal((await student(f,s)).status,401);
 assert.equal((await f.request('/api/admin/students',{role:'admin'})).status,200);
});
test('additive migration preserves all old questions, attempts, allocations, scores and monitor summaries',async t=>{
 const f=fixture({through:14,perSubject:80});t.after(f.close);const p=await f.start();await f.request('/api/student/exam/answer',{method:'PUT',body:{attemptId:p.attemptId,questionId:p.subjects[0].questions[0].id,chosen:'A',revision:1}});
 const tables=['questions','attempts','answers','attempt_questions','scores','settings','students'];const before=Object.fromEntries(tables.map(table=>[table,f.sql.prepare('SELECT * FROM '+table).all()]));
 f.sql.exec(readFileSync('migrations/0015_digital_technologies.sql','utf8'));
 for(const table of tables)assert.deepEqual(f.sql.prepare('SELECT * FROM '+table).all(),before[table],table);
 assert.equal((await f.request('/api/student/exam')).body.subjects.flatMap(s=>s.questions).length,200);assert.equal((await f.request('/api/admin/results/monitor',{role:'admin'})).body.students[0].total,200);
 assert.deepEqual(f.sql.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('imports report wrong class and subject rows; settings validation is atomic and downloaded results stay class-scoped',async t=>{
 const f=fixture({perSubject:0});t.after(f.close);const e=(await admin(f,'SS1','/exams')).body.selected;
 const upload=await admin(f,'SS1','/questions/import','POST',{rows:[{...rows(1)[0],class:'SS2'},{...rows(1)[0],subject:'Government'},...rows(30)]});assert.equal(upload.body.added,30);assert.equal(upload.body.skipped.length,2);
 assert.equal((await admin(f,'SS1','/settings','PATCH',{minutes:60,state:'invalid'})).status,400);assert.equal(f.sql.prepare('SELECT minutes FROM digital_exams WHERE id=?').get(e).minutes,30);
 const s=await register(f);await open(f);const p=await start(f,s,e);await student(f,s,'/submit','POST',{attemptId:p.attemptId});
 const export1=await admin(f,'SS1','/results.csv');assert.equal(export1.status,200);assert.match(export1.body,/Akin Sample/);assert.match(export1.body,/"0","30","0"/);assert.equal(export1.headers.get('cache-control'),'no-store');
 const export2=await admin(f,'SS2','/results.csv');assert.doesNotMatch(export2.body,/Akin Sample|SS1-DT/);
 const logins=await admin(f,'SS1','/logins.csv');assert.ok(logins.body.includes(s.password));assert.doesNotMatch(logins.body,/pbkdf2|password_hash/);
 const hostile=await f.request('/api/digital/admin/SS1/settings',{role:'admin',method:'PATCH',body:{released:true},headers:{Origin:'https://foreign.test'}});assert.equal(hostile.status,403);
});
