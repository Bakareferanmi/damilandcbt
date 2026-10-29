import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {setTimeout as delay} from 'node:timers/promises';
import {fixture} from './helpers.mjs';
import {parseQuestionsCSV} from '../public/digital-common.js';
const source=async name=>(await build({entryPoints:['public/'+name+'.js'],bundle:true,platform:'browser',format:'iife',write:false})).outputFiles[0].text;
const [adminScript,studentScript]=await Promise.all([source('digital-admin'),source('digital-student')]);
const rows=n=>Array.from({length:n},(_,i)=>({question:'Computer question '+i,a:'RAM',b:'ROM',c:'Printer',d:'Monitor',correct:'A'}));
async function until(check,message){for(let i=0;i<300;i++){if(check())return;await delay(5)}assert.fail(message)}
function browser(f,page,{admin=false}={}){
 const dom=new JSDOM(readFileSync('public/'+page+'.html','utf8'),{url:'https://example.test/'+page,runScripts:'outside-only'}),w=dom.window,requests=[],intervals=[];
 let digitalCookie='',offline=false;
 w.Response=Response;w.AbortSignal=AbortSignal;w.confirm=()=>true;w.HTMLElement.prototype.scrollIntoView=()=>{};
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'))};
 w.setInterval=(fn,ms)=>{intervals.push({fn,ms});return intervals.length};w.clearInterval=()=>{};
 w.fetch=async(path,options={})=>{requests.push({path,options});if(offline)throw Error('Offline test');const cookie=[admin?f.cookie('admin'):'',digitalCookie].filter(Boolean).join('; ');const r=await f.request(path,{cookies:cookie,method:options.method||'GET',body:options.body?JSON.parse(options.body):undefined});const set=r.headers.get('set-cookie');if(set?.startsWith('digital_session='))digitalCookie=set.split(';')[0];return Response.json(r.body,{status:r.status,headers:r.headers})};
 w.eval(readFileSync('public/format.js','utf8'));
 if(admin)w.document.body.classList.add('shell');
 w.eval(admin?adminScript:studentScript);
 const submit=id=>{const form=w.document.getElementById(id);form.dispatchEvent(new w.SubmitEvent('submit',{bubbles:true,cancelable:true,submitter:form.querySelector('button[type=submit]')}))};
 return {dom,w,requests,intervals,submit,offline(value){offline=value},close(){dom.window.close()}};
}
test('question CSV handles quoted punctuation and rejects missing columns, malformed quotes and broken rows',()=>{
 const parsed=parseQuestionsCSV('\uFEFFquestion,a,b,c,d,correct\r\n"Which device, when connected, stores files?",Disk,Monitor,Keyboard,Mouse,A\r\n');assert.equal(parsed.length,1);assert.equal(parsed[0].question,'Which device, when connected, stores files?');assert.equal(parsed[0].row,2);
 for(const bad of ['question,a,b,c,d\nWhat?,A,B,C,D','question,a,b,c,d,correct\n"unclosed,A,B,C,D,A','question,a,b,c,d,correct\nWhat?,A,B,C,D,A,extra'])assert.throws(()=>parseQuestionsCSV(bad));
});
test('admin screens exercise actual class-scoped uploads, registration, opening, switching and result monitoring',async t=>{
 const f=fixture({perSubject:0});const b=browser(f,'digital-admin',{admin:true});t.after(async()=>{b.close();await delay(30);f.close()});const d=b.w.document;
 await until(()=>d.getElementById('dt-details').textContent.includes('SS1'),'SS1 details render');
 const csv='question,a,b,c,d,correct\n'+rows(70).map(q=>[q.question,q.a,q.b,q.c,q.d,q.correct].join(',')).join('\n');
 const file={size:csv.length,text:async()=>csv};Object.defineProperty(d.getElementById('dt-file'),'files',{configurable:true,value:[file]});await d.getElementById('dt-file').onchange();
 assert.match(d.getElementById('dt-file-summary').textContent,/70 rows selected for SS1/);await until(()=>!d.getElementById('dt-upload-button').disabled,'upload becomes available');b.submit('dt-upload');
 await until(()=>d.getElementById('dt-count').textContent==='70 / 70','70-question bank rendered');await until(()=>d.querySelectorAll('.dt-question').length===70,'uploaded question list renders');await until(()=>!d.getElementById('dt-new').disabled,'upload refresh finishes');assert.equal(d.getElementById('dt-open').disabled,false);
 d.querySelector('[data-tab=students]').click();await until(()=>d.getElementById('dt-student-table').textContent.includes('No students'),'empty class roster renders');
 const form=d.getElementById('dt-register');form.elements.firstName.value='Akin';form.elements.lastName.value='Sample';b.submit('dt-register');
 await until(()=>d.getElementById('dt-new-login').textContent.includes('SS1-DT-001'),'registered login renders');await until(()=>d.getElementById('dt-student-table').textContent.includes('Akin Sample'),'registered student appears in roster');await until(()=>!d.getElementById('dt-new').disabled,'registration refresh finishes');
 d.getElementById('dt-open').click();await until(()=>d.getElementById('dt-state').textContent==='Open for entry','teacher can open the paper');await until(()=>!d.getElementById('dt-new').disabled,'opening refresh finishes');
 d.querySelector('[data-cohort=SS2]').click();await until(()=>d.getElementById('dt-details').textContent.includes('SS2'),'class switches to SS2');await until(()=>!d.getElementById('dt-new').disabled,'class refresh finishes');assert.equal(d.getElementById('dt-count').textContent,'0 / 70');assert.equal(d.getElementById('dt-open').disabled,true);assert.equal(d.getElementById('dt-new-login').hidden,true);
 d.querySelector('[data-tab=results]').click();await until(()=>d.getElementById('dt-updated').textContent.includes('Updated'),'scoped monitor renders');await until(()=>!d.getElementById('dt-new').disabled,'monitor refresh finishes');assert.match(d.getElementById('dt-result-table').textContent,/No students/);
 assert.ok(!b.requests.some(r=>r.path.includes('/api/admin/exams')),'SS3 live exam is not consulted or changed');
});
test('student UI logs in, starts 30 questions, saves through the API, resumes, submits and shows only released scores',async t=>{
 const f=fixture({perSubject:0});
 await f.request('/api/digital/admin/SS1/questions/import',{role:'admin',method:'POST',body:{rows:rows(70)}});
 const registration=await f.request('/api/digital/admin/SS1/students',{role:'admin',method:'POST',body:{firstName:'Akin',lastName:'Sample'}});
 await f.request('/api/digital/admin/SS1/settings',{role:'admin',method:'PATCH',body:{state:'open'}});
 const b=browser(f,'digital');t.after(async()=>{b.close();await delay(30);f.close()});const d=b.w.document;
 await until(()=>!d.getElementById('dt-login').hidden,'login renders');const form=d.getElementById('dt-login-form');form.elements.code.value=registration.body.code;form.elements.password.value=registration.body.password;b.submit('dt-login-form');
 await until(()=>!d.getElementById('dt-ready').hidden,'ready screen renders after authenticating');assert.match(d.getElementById('dt-ready-details').textContent,/30 questions · 30 minutes/);d.getElementById('dt-start').click();
 await until(()=>d.querySelectorAll('#dt-question-nav button').length===30,'30 assigned questions render');const first=d.getElementById('dt-question-heading').textContent;
 const choose=()=>{const radio=d.querySelector('#dt-answer-options input[value=A]');radio.checked=true;radio.dispatchEvent(new b.w.Event('change',{bubbles:true}))};
 choose();await until(()=>f.sql.prepare('SELECT COUNT(*) n FROM digital_answers').get().n===1,'first answer reaches database');
 d.getElementById('dt-next').click();assert.notEqual(d.getElementById('dt-question-heading').textContent,first);d.getElementById('dt-previous').click();assert.equal(d.getElementById('dt-question-heading').textContent,first);assert.equal(d.querySelector('#dt-answer-options input[value=A]').checked,true);
 // A failed save remains queued; an online event retries the same answer and revision.
 d.getElementById('dt-next').click();b.offline(true);choose();await until(()=>d.getElementById('dt-save-status').textContent.includes('waiting to save'),'offline answer remains visible');b.offline(false);b.w.dispatchEvent(new b.w.Event('online'));
 await until(()=>f.sql.prepare('SELECT COUNT(*) n FROM digital_answers').get().n===2,'offline choice is retried');await until(()=>d.getElementById('dt-save-status').textContent==='All answers saved.','saved feedback confirms acknowledgment');
 d.getElementById('dt-submit').click();await until(()=>!d.getElementById('dt-submitted').hidden,'submission confirmation renders');assert.equal(d.getElementById('dt-score').hidden,true);assert.equal(f.sql.prepare('SELECT score FROM digital_attempts').get().score,2);
 await f.request('/api/digital/admin/SS1/settings',{role:'admin',method:'PATCH',body:{released:true}});d.getElementById('dt-result-refresh').click();await until(()=>!d.getElementById('dt-score').hidden,'released result renders');assert.match(d.getElementById('dt-score').textContent,/2 \/ 30/);
 assert.ok(!b.requests.some(r=>r.path.startsWith('/api/student/exam')),'digital sitting never uses the SS3 exam API');
});
test('admin shell gives Digital Technologies its own entry and omits the SS3 exam selector there',async()=>{
 const dom=new JSDOM('<body><main>Digital page</main><script data-page="digital" data-title="Digital Technologies"></script></body>',{url:'https://example.test/digital-admin',runScripts:'outside-only'}),w=dom.window,calls=[];
 Object.defineProperty(w.document,'currentScript',{configurable:true,get:()=>w.document.querySelector('script')});w.fetch=async path=>{calls.push(path);return Response.json(path==='/api/me'?{role:'admin',email:'qa@example.test'}:{sessions:[{id:1,name:'2026/2027',current:true}],viewing:1,current:1})};
 w.eval(readFileSync('public/shell.js','utf8'));await until(()=>w.document.getElementById('shell-session'),'academic session selector renders');assert.equal(w.document.querySelector('#shell-exam'),null);assert.equal(w.document.querySelector('.nav a[aria-current=page]').getAttribute('href'),'/digital-admin');assert.ok(!calls.includes('/api/admin/exams'));dom.window.close();
});
