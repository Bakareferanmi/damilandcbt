import {api,note} from './digital-common.js';
import {AnswerQueue} from './answer-queue.js';
import {FocusTracker} from './focus-tracker.js';
const $=id=>document.getElementById(id),base='/api/digital/student';
let state=null,queue=null,focus=null,index=0,tick=null,deadline=0,submitting=false,expired=false,retryAt=0,loading=false;
let storage;try{storage=localStorage}catch{storage={getItem(){throw Error('Browser storage unavailable')},setItem(){throw Error('Browser storage unavailable')},removeItem(){throw Error('Browser storage unavailable')}}}
function error(message){note($('dt-error'),message,true)}
function panel(name){for(const key of ['loading','login','waiting','ready','writing','submitted'])$('dt-'+key).hidden=key!==name;clearInterval(tick);$('dt-logout').hidden=['login','loading'].includes(name)}
function active(){return !!state&&state.status==='in_progress'&&!submitting&&!expired}
function queueFor(data){
 const key=`digital-answer:${data.student.cohort}:${data.student.id}:${data.examId}:${data.attemptId}`;
 return new AnswerQueue({key,storage,answers:data.answers||{},revisions:data.answerRevisions||{},allowed:data.questions?.map(q=>q.id)||data.questionIds||[],onChange:updateSave,
  send:async(questionId,chosen,revision)=>{try{return await api(base+'/exam/answer',{method:'PUT',body:{attemptId:data.attemptId,questionId,chosen,revision}})}catch(e){if([401,403,409].includes(e.status))e.terminal=true;throw e}}
 });
}
function updateSave(q){
 if(!q)return;const n=q.count,el=$('dt-save-status');el.className='dt-save-status'+(n||q.storageError||q.terminal?' is-error':'');
 el.textContent=q.terminal?'Saving needs attention. Refresh saved answers before continuing.':n?`${n} answer${n===1?'':'s'} waiting to save. Keep this page open.`:'All answers saved.';
 if(q.storageError)el.textContent+=' Browser recovery storage is unavailable. Keep this page open and tell your teacher.';
 if(q.conflicts)el.textContent+=' An answer changed in another tab. Check your choices.';
 $('dt-resync').hidden=!q.terminal;
 const chosen=Object.keys(q.answers).length;$('dt-answered').textContent=chosen+' / 30 answered';
 for(const button of $('dt-question-nav').querySelectorAll('button'))button.classList.toggle('is-answered',!!q.answers[state?.questions?.[Number(button.dataset.index)]?.id]);
}
function question(moveFocus=false){
 if(!state?.questions?.length)return;const q=state.questions[index];
 $('dt-position').textContent=`Question ${index+1} of ${state.questions.length}`;$('dt-question-heading').innerHTML=window.fmt(q.body);
 $('dt-answer-options').innerHTML=['a','b','c','d'].map(letter=>`<label class="dt-choice"><input type="radio" name="answer" value="${letter.toUpperCase()}" ${queue.answers[q.id]===letter.toUpperCase()?'checked':''}><span><b>${letter.toUpperCase()}.</b> ${window.fmt(q[letter])}</span></label>`).join('');
 $('dt-answer-options').disabled=submitting||expired;$('dt-previous').disabled=index===0;$('dt-next').disabled=index===state.questions.length-1;
 for(const button of $('dt-question-nav').querySelectorAll('button'))button.setAttribute('aria-current',String(Number(button.dataset.index)===index));
 if(moveFocus)$('dt-question-heading').focus();updateSave(queue);
}
async function flush(){if(!queue||!queue.count)return;try{await queue.flush();error('')}catch(e){if(e.finished){await load();return}if(e.terminal){$('dt-resync').hidden=false;error(e.message)}else updateSave(queue)}}
function paint(){
 const d=state;if(!d)return;
 if(d.status==='waiting'){panel('waiting');$('dt-wait-class').textContent=d.student.cohort+' · '+d.student.name;return}
 if(d.status==='ready'){panel('ready');$('dt-ready-class').textContent=d.student.cohort+' · Digital Technologies';$('dt-ready-name').textContent=d.examName;$('dt-ready-student').textContent=d.student.name+' · '+d.student.code;$('dt-ready-details').textContent=`30 questions · ${d.minutes} minutes · scored out of 30`;return}
 if(d.status==='submitted'){
  panel('submitted');focus=null;queue=queueFor(d);$('dt-submitted-class').textContent=d.student.cohort+' · '+d.examName;$('dt-submitted-student').textContent=d.student.name+' · '+d.student.code;
  $('dt-result-copy').textContent=d.released?'Your result has been released.':'Your school will release your result.';$('dt-score').hidden=!d.released;$('dt-score').textContent=d.released?`${d.score} / 30 · ${d.percentage}%`:'';
  const pending=queue.count;$('dt-submission-warning').hidden=!pending;$('dt-submission-warning').textContent=pending?`${pending} locally queued answer${pending===1?' was':'s were'} not confirmed by the server before submission. Tell your teacher. Only saved answers were marked.`:'';return;
 }
 panel('writing');expired=false;submitting=false;retryAt=0;queue=queueFor(d);index=Math.min(index,d.questions.length-1);
 $('dt-writing-class').textContent=d.student.cohort+' · '+d.examName;$('dt-writing-student').textContent=d.student.name+' · '+d.student.code;
 $('dt-question-nav').innerHTML=d.questions.map((q,i)=>`<button type="button" data-index="${i}" aria-label="Question ${i+1}">${i+1}</button>`).join('');
 question();deadline=performance.now()+d.secondsLeft*1000;
 focus=new FocusTracker({storage,key:`digital-focus:${d.student.id}:${d.examId}:${d.attemptId}`,send:async event=>{const response=await fetch(base+'/exam/focus-event',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({attemptId:d.attemptId,...event})});return response.status}});
 focus.hidden=document.hidden;focus.flush();tick=setInterval(clock,500);clock();flush();
}
function clock(){
 const seconds=Math.max(0,Math.ceil((deadline-performance.now())/1000));$('dt-timer').textContent=String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');$('dt-timer').classList.toggle('is-low',seconds<120);
 if(seconds===0){expired=true;$('dt-answer-options').disabled=true;if(!submitting&&performance.now()>retryAt)submit(true)}
}
async function load(){
 if(loading)return;loading=true;try{const data=await api(base+'/exam');state=data;error('');paint()}catch(e){if(e.status===401){state=null;queue=null;focus=null;panel('login')}else{error(e.message);if(!state){panel('waiting');$('dt-wait-class').textContent='Could not open your exam. Try again.'}}}finally{loading=false}
}
async function submit(automatic=false){
 if(submitting||!state?.attemptId)return;if(!automatic&&!confirm(`Submit your exam? You have answered ${Object.keys(queue.answers).length} of 30 questions.`))return;
 submitting=true;$('dt-submit').disabled=true;$('dt-answer-options').disabled=true;
 try{
  await queue.flush();await api(base+'/exam/submit',{method:'POST',body:{attemptId:state.attemptId}});await load();
 }catch(e){
  if(e.finished)await load();else if(automatic){error('Time is up. Submission has not been confirmed yet. Keep this page open; it will retry when connected.');retryAt=performance.now()+15000}
  else error('Submission is not confirmed. '+e.message+' Keep this page open and try again.');
 }finally{submitting=false;$('dt-submit').disabled=false;if(state?.status==='in_progress')$('dt-answer-options').disabled=expired}
}
const loginForm=$('dt-login-form'),chosenClass=new URLSearchParams(location.search).get('class');loginForm.elements.cohort.value=chosenClass==='SS2'?'SS2':'SS1';
loginForm.elements.cohort.onchange=()=>{loginForm.elements.code.placeholder=loginForm.elements.cohort.value+'-DT-001'};loginForm.elements.cohort.onchange();
$('dt-show-password').onclick=()=>{const input=loginForm.elements.password,show=input.type==='password';input.type=show?'text':'password';$('dt-show-password').textContent=show?'Hide':'Show';$('dt-show-password').setAttribute('aria-label',show?'Hide password':'Show password')};
loginForm.onsubmit=async event=>{event.preventDefault();const button=event.submitter;button.disabled=true;error('');try{await api(base+'/login',{method:'POST',body:Object.fromEntries(new FormData(loginForm))});loginForm.elements.password.value='';await load()}catch(e){error(e.message)}finally{button.disabled=false}};
$('dt-start').onclick=async()=>{const button=$('dt-start');button.disabled=true;error('');try{await api(base+'/exam/start',{method:'POST',body:{examId:state.examId}});await load()}catch(e){error(e.message)}finally{button.disabled=false}};
$('dt-answer-options').onchange=event=>{if(!active())return;queue.choose(state.questions[index].id,event.target.value);updateSave(queue);flush()};
$('dt-previous').onclick=()=>{if(index>0){index--;question(true)}};$('dt-next').onclick=()=>{if(index<state.questions.length-1){index++;question(true)}};
$('dt-question-nav').onclick=event=>{const button=event.target.closest('[data-index]');if(button){index=Number(button.dataset.index);question(true)}};
$('dt-submit').onclick=()=>submit();$('dt-resync').onclick=load;for(const id of ['dt-wait-refresh','dt-result-refresh'])$(id).onclick=load;
$('dt-logout').onclick=async()=>{if(queue?.count&&state?.status==='in_progress'){error('Save your pending answers before logging out. Keep this page open and tell your teacher.');return}try{await api(base+'/logout',{method:'POST',body:{}});state=null;queue=null;focus=null;panel('login');error('')}catch(e){error(e.message)}};
function network(){$('dt-network').hidden=navigator.onLine}network();addEventListener('offline',network);addEventListener('online',async()=>{network();if(queue?.running)await queue.running.catch(()=>{});await flush();focus?.flush();if(expired)retryAt=0});
addEventListener('beforeunload',event=>{if(state?.status==='in_progress'&&queue?.count){event.preventDefault();event.returnValue=''}});
document.addEventListener('visibilitychange',()=>{focus?.change(document.hidden,state?.status==='in_progress');if(!document.hidden)flush()});
setInterval(()=>{if(state?.status==='in_progress'){flush();focus?.flush()}},15000);
load();
