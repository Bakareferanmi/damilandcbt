import test from 'node:test';
import assert from 'node:assert/strict';
import {cardSheets,loadCardPasswords} from '../public/login-cards.js';
const students = Array.from({length:17},(_,i)=>({fullName:'Student '+i,className:'SS3 Science',code:'TEST'+i,password:'PASS'+i}));
test('A4 sheets contain eight cards each with a final partial sheet',()=>{
 const html=cardSheets(students,{section:'SS3 Science',session:'2026/2027',website:'https://school.test'});
 const pages=html.split('<section class="card-sheet">').slice(1);
 assert.equal(pages.length,3);assert.deepEqual(pages.map(p=>(p.match(/<article /g)||[]).length),[8,8,1]);
 for(const s of students){assert.ok(html.includes(s.code));assert.ok(html.includes(s.password));}
 assert.ok(html.includes('Sheet 3 of 3'));
 assert.equal(cardSheets([],{section:'Science'}),'');
});
test('card text is escaped including names, passwords and website',()=>{
 const html=cardSheets([{fullName:'<script>',className:'<img>',code:'<b>',password:'<secret>'}],{section:'<section>',session:'<session>',website:'<url>'});
 for(const value of ['script','img','b','secret','section','session','url']) assert.ok(html.includes('&lt;'+value+'&gt;'));
});
test('password loading preserves order, limits concurrency and reports missing saved passwords',async()=>{
 let active=0,max=0;
 const result=await loadCardPasswords(students,async code=>{
  active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,1));active--;
  return code==='TEST4'?{status:404,ok:false,data:{}}:{status:200,ok:true,data:{password:'NEW'+code}};
 });
 assert.ok(max<=3);assert.equal(result.missing[0].code,'TEST4');
 assert.deepEqual(result.cards.map(s=>s.code),students.filter(s=>s.code!=='TEST4').map(s=>s.code));
 assert.equal(result.cards[0].password,'NEWTEST0');
});
test('failed password retrieval blocks preparation instead of silently printing incomplete cards',async()=>{
 await assert.rejects(loadCardPasswords(students,async()=>({status:401,ok:false,data:{error:'Sign in again'}})),/Sign in again/);
});

import { fixture } from './helpers.mjs';
test('print password retrieval remains admin-only, uncached and audited', async t=>{
 const f=fixture(); t.after(f.close);
 const reset=await f.request('/api/admin/students/TEST1/reset-password',{role:'admin',method:'POST',body:{}});
 const r=await f.request('/api/admin/students/TEST1/password',{role:'admin'});
 assert.equal(r.status,200);assert.equal(r.body.password,reset.body.password);
 assert.equal(r.headers.get('cache-control'),'no-store');
 assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='view_student_password'").get().n,1);
 assert.equal((await f.request('/api/admin/students/TEST1/password')).status,401);
});
