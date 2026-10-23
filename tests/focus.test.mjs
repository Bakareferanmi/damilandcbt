import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, memoryStorage } from './helpers.mjs';
import { FocusTracker } from '../public/focus-tracker.js';

test('tab flags are authenticated, idempotent, attempt-bound, persistent and archived on retake', async t => {
 const f=fixture({perSubject:80});t.after(f.close);
 const p=await f.start();
 const event={attemptId:p.attemptId,eventId:'01234567-89ab-cdef-0123-456789abcdef',occurredAt:Math.floor(Date.now()/1000)};
 const report=(body=event, id=1)=>f.request('/api/student/exam/focus-event',{id,method:'POST',body});
 assert.equal((await report()).status,200);assert.equal((await report()).status,200);
 assert.equal((await report(event,2)).status,409);
 assert.equal((await report({...event,eventId:'bad'})).status,400);
 assert.equal((await report({...event,occurredAt:Date.now()})).status,400);
 assert.equal((await f.request('/api/student/exam/focus-event',{cookies:'',method:'POST',body:event})).status,401);
 const monitor=await f.request('/api/admin/results/monitor',{role:'admin'});
 assert.equal(monitor.body.students[0].tabSwitches,1);
 assert.equal(monitor.body.students[0].lastTabSwitch,event.occurredAt);
 assert.equal(monitor.body.students[0].total,200);
 assert.equal(monitor.body.students[0].status,'in_progress');
 assert.equal((await f.request('/api/admin/results/monitor')).status,401);
 await f.request('/api/student/exam/submit',{method:'POST',body:{attemptId:p.attemptId}});
 assert.equal((await f.request('/api/admin/results/monitor',{role:'admin'})).body.students[0].tabSwitches,1);
 await f.request('/api/admin/students/TEST1/retake',{role:'admin',method:'POST',body:{attemptId:p.attemptId,reason:'Invigilator approved restart'}});
 const archive=JSON.parse(f.sql.prepare('SELECT attempt_json FROM attempt_archives').get().attempt_json);
 assert.equal(archive.focusEvents.length,1);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM exam_focus_events').get().n,0);
 await f.start(); assert.equal((await report()).status,409);
});

test('hidden transitions queue once, survive refresh and retry without changing event identity',async()=>{
 const storage=memoryStorage();let online=false;const sent=[];
 const options={storage,key:'attempt-1',clock:()=>123,uuid:()=> '01234567-89ab-cdef',send:async e=>{if(!online)throw Error('offline');sent.push(e);return 200;}};
 const tracker=new FocusTracker(options);
 await tracker.change(false,true);await tracker.change(true,true);await tracker.change(true,true);
 assert.equal(tracker.pending.length,1);
 const reloaded=new FocusTracker(options);assert.equal(reloaded.pending.length,1);
 online=true;await reloaded.flush();assert.equal(reloaded.pending.length,0);assert.equal(sent.length,1);
 assert.equal(sent[0].occurredAt,123);
 await reloaded.change(true,false);assert.equal(sent.length,1);
});

test('focus reporting handles storage errors and failed delivery without affecting exam answers', async()=>{
 const tracker=new FocusTracker({key:'x',storage:{getItem(){throw Error();},setItem(){throw Error();}},uuid:()=> '01234567-89ab-cdef',send:async()=>500});
 await tracker.change(true,true);assert.equal(tracker.pending.length,1);
 tracker.send=async()=>200;await tracker.flush();assert.equal(tracker.pending.length,0);
});
