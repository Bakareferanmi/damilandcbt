import {api,escapeHTML as esc,parseQuestionsCSV,note} from './digital-common.js';
const $=id=>document.getElementById(id);
let cohort=new URLSearchParams(location.search).get('class')==='SS2'?'SS2':'SS1',examId=null,papers=[],readOnly=false,tab='questions',questions=[],editing=null,fileRows=[],busy=false,detailsMode=false,sequence=0;
const path=suffix=>'/api/digital/admin/'+cohort+suffix+(examId?'?examId='+examId:'');
const current=()=>papers.find(e=>e.id===examId);
function feedback(message,bad=false){note($('dt-message'),message,bad);if(bad){$('dt-message').setAttribute('role','alert');$('dt-message').scrollIntoView({block:'nearest'})}else $('dt-message').setAttribute('role','status')}
async function action(button,fn){if(busy)return;busy=true;if(button)button.disabled=true;try{await fn()}catch(error){feedback(error.message,true);if(error.status===401)location.href='/admin'}finally{busy=false;if(button)button.disabled=false;paintDetails()}}
function resetQuestion(){editing=null;$('dt-question-form').reset();$('dt-question-title').textContent='Add a question';$('dt-cancel-edit').hidden=true}
function clearFile(){fileRows=[];$('dt-file').value='';$('dt-upload-button').disabled=true;$('dt-file-summary').hidden=true;$('dt-import-errors').hidden=true}
function paintDetails(){
 const e=current(),locked=!!e?.lockedAt;
 document.querySelectorAll('[data-cohort]').forEach(button=>{button.setAttribute('aria-pressed',String(button.dataset.cohort===cohort));button.disabled=busy});
 $('dt-student-link').href='/digital?class='+cohort;$('dt-student-link').textContent='Open '+cohort+' student login';$('dt-register-label').textContent='Registering into '+cohort+'.';$('dt-upload-button').textContent='Upload to '+cohort;
 $('dt-state').textContent=e?({draft:'Draft',open:'Open for entry',closed:'Entry closed'}[e.state]):'No exam yet';$('dt-state').className='pill'+(e?.state==='open'?' on':'');
 $('dt-details').textContent=e?`${cohort} · ${e.minutes} minutes · ${e.questions} questions in bank · ${e.attempts} attempts`:`${cohort} · Create an exam to start its question bank.`;
 $('dt-lock-note').textContent=locked?'Questions and duration are locked because a student has started. Create a new exam to make changes.':'Close entry stops new starts. Students already writing can finish their papers.';
 $('dt-open').textContent=e?.state==='open'?'Close entry':'Open exam';$('dt-open').disabled=busy||readOnly||!e||(e.state!=='open'&&e.questions<30);
 $('dt-duration').disabled=busy||readOnly||!e||locked;$('dt-new').disabled=busy||readOnly;$('dt-exam').disabled=busy||!papers.length;
 $('dt-upload-fields').disabled=readOnly||locked||!e;$('dt-question-fields').disabled=readOnly||locked||!e;$('dt-register-fields').disabled=readOnly;
 $('dt-upload-button').disabled=!fileRows.length||readOnly||locked||!e||busy;
 $('dt-readonly').hidden=!readOnly;$('dt-count').textContent=(e?.questions??0)+' / 70';$('dt-meter').style.width=(e?.questions??0)/70*100+'%';
 $('dt-logins-download').href=path('/logins.csv');$('dt-results-download').href=path('/results.csv');$('dt-release').textContent=e?.released?'Hide results':'Release results';$('dt-release').disabled=busy||readOnly||!e;
}
async function loadPapers(selected=examId){
 const seq=++sequence,space=cohort;const data=await api('/api/digital/admin/'+space+'/exams'+(selected?'?examId='+selected:''));if(seq!==sequence||space!==cohort)return false;
 papers=data.exams;examId=data.selected;readOnly=data.readOnly;
 $('dt-exam').innerHTML=papers.length?papers.map(e=>`<option value="${e.id}" ${e.id===examId?'selected':''}>${esc(e.name)}</option>`).join(''):'<option>No exams yet</option>';
 paintDetails();return true;
}
async function refresh(){const seq=sequence,space=cohort,id=examId,valid=()=>seq===sequence&&space===cohort&&id===examId;
 if(tab==='questions'){
  if(!examId){questions=[];$('dt-question-list').textContent='Create an exam before uploading questions.';return}
  const data=await api(path('/questions'));if(!valid())return;questions=data.questions;
  $('dt-question-list').innerHTML=questions.length?questions.map((q,i)=>`<article class="dt-question"><p><b>${i+1}.</b> ${esc(q.body)}</p><div class="dt-options">${['a','b','c','d'].map(key=>`<span class="${q.correct===key.toUpperCase()?'dt-correct':''}">${key.toUpperCase()}. ${esc(q[key])}${q.correct===key.toUpperCase()?' ✓':''}</span>`).join('')}</div>${data.locked||readOnly?'':`<div class="dt-question-actions dt-actions"><button type="button" data-edit="${q.id}">Edit</button><button type="button" data-remove="${q.id}">Delete</button></div>`}</article>`).join(''):'<p class="dt-muted">No questions yet. Upload a CSV or add the first question above.</p>';
 }else if(tab==='students'){
  const data=await api(path('/students'));if(!valid())return;$('dt-student-limit').hidden=!data.limited;
  $('dt-student-table').innerHTML=data.students.length?`<table class="dt-table"><thead><tr><th>Name</th><th>Student code</th><th>Current paper</th>${readOnly?'':'<th>Password</th>'}</tr></thead><tbody>${data.students.map(s=>`<tr><td>${esc(s.name)}</td><td>${esc(s.code)}</td><td>${s.submittedAt?'Submitted':s.attemptId?'Writing':'Not started'}</td>${readOnly?'':`<td><button type="button" data-reset="${s.id}">Reset password</button></td>`}</tr>`).join('')}</tbody></table>`:'<p class="dt-muted">No students registered for '+cohort+' yet.</p>';
 }else{
  if(!examId){$('dt-result-table').textContent='Create an exam first.';return}
  const data=await api(path('/results'));if(!valid())return;const rows=data.students,submitted=rows.filter(s=>s.submittedAt).length,writing=rows.filter(s=>s.attemptId&&!s.submittedAt).length;
  $('dt-updated').textContent='Updated '+new Date(data.asOf*1000).toLocaleTimeString('en-NG')+(data.limited?' · first 500 students shown':'');
  $('dt-summary').innerHTML=[[rows.length,'Registered'],[writing,'Writing'],[submitted,'Submitted']].map(([value,label])=>`<div><strong>${value}</strong><span>${label}</span></div>`).join('');
  $('dt-result-table').innerHTML=rows.length?`<table class="dt-table"><thead><tr><th>Name</th><th>Code</th><th>Status</th><th>Saved answers</th><th>Score</th><th>Tab flags</th></tr></thead><tbody>${rows.map(s=>`<tr><td>${esc(s.name)}</td><td>${esc(s.code)}</td><td>${s.submittedAt?'Submitted':s.attemptId?'Writing':'Not started'}</td><td>${s.answered??0} / 30</td><td>${s.submittedAt?s.score+' / 30':'—'}</td><td>${s.tabSwitches??0}</td></tr>`).join('')}</tbody></table>`:'<p class="dt-muted">No students registered yet.</p>';
 }
}
async function reload(){if(await loadPapers())await refresh()}
function showTab(next){tab=next;document.querySelectorAll('[data-tab]').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.tab===tab)));for(const key of ['questions','students','results'])$('dt-'+key).hidden=key!==tab;return refresh()}
document.querySelectorAll('[data-cohort]').forEach(button=>button.onclick=()=>action(button,async()=>{cohort=button.dataset.cohort;examId=null;sequence++;clearFile();resetQuestion();$('dt-new-login').hidden=true;feedback('');history.replaceState({},'','/digital-admin?class='+cohort);await reload()}));
document.querySelectorAll('[data-tab]').forEach(button=>button.onclick=()=>action(button,()=>showTab(button.dataset.tab)));
$('dt-exam').onchange=()=>action(null,async()=>{examId=Number($('dt-exam').value);clearFile();resetQuestion();feedback('');await reload()});
$('dt-cancel-edit').onclick=resetQuestion;
$('dt-file').onchange=async()=>{fileRows=[];$('dt-import-errors').hidden=true;const file=$('dt-file').files[0],targetClass=cohort,targetExam=examId;if(!file)return clearFile();try{if(file.size>1024*1024)throw Error('The file is too large. Keep it under 1 MB.');const contents=await file.text();if(cohort!==targetClass||examId!==targetExam||$('dt-file').files[0]!==file)return;fileRows=parseQuestionsCSV(contents);$('dt-file-summary').textContent=`${fileRows.length} rows selected for ${cohort} · ${current()?.name??'No exam'}. Review the class before uploading.`;$('dt-file-summary').hidden=false;paintDetails()}catch(error){if(cohort===targetClass&&examId===targetExam&&$('dt-file').files[0]===file){clearFile();feedback(error.message,true)}}};
$('dt-upload').onsubmit=event=>{event.preventDefault();action($('dt-upload-button'),async()=>{
 if(!fileRows.length)return;const data=await api(path('/questions/import'),{method:'POST',body:{rows:fileRows}});clearFile();
 feedback(`${data.added} questions added to ${cohort}. ${data.skipped.length} rows skipped.${data.warning?' '+data.warning:''}`,data.added===0);
 $('dt-import-errors').innerHTML=data.skipped.map(row=>`<li>Row ${row.row}: ${esc(row.reason)}</li>`).join('');$('dt-import-errors').hidden=!data.skipped.length;await reload();
})};
$('dt-question-form').onsubmit=event=>{event.preventDefault();action(event.submitter,async()=>{
 const fields=Object.fromEntries(new FormData(event.currentTarget)),data=editing?await api(path('/questions/'+editing),{method:'PUT',body:fields}):await api(path('/questions/import'),{method:'POST',body:{rows:[fields]}});
 if(data.skipped?.length)throw Error(data.skipped[0].reason);resetQuestion();feedback('Question saved to '+cohort+'.');await reload();
})};
$('dt-question-list').onclick=event=>{const edit=event.target.closest('[data-edit]'),remove=event.target.closest('[data-remove]');
 if(edit){const q=questions.find(q=>q.id===Number(edit.dataset.edit));if(!q)return;editing=q.id;const form=$('dt-question-form');for(const key of ['a','b','c','d','correct'])form.elements[key].value=q[key];form.elements.question.value=q.body;$('dt-question-title').textContent='Edit question';$('dt-cancel-edit').hidden=false;form.scrollIntoView({block:'start'});form.elements.question.focus()}
 if(remove&&confirm('Delete this question from '+cohort+'?'))action(remove,async()=>{await api(path('/questions/'+remove.dataset.remove),{method:'DELETE'});feedback('Question deleted.');await reload()});
};
$('dt-register').onsubmit=event=>{event.preventDefault();action(event.submitter,async()=>{const form=event.currentTarget,data=await api(path('/students'),{method:'POST',body:Object.fromEntries(new FormData(form))});form.reset();$('dt-new-login').innerHTML=`<strong>${esc(data.name)} · ${cohort}</strong><br>Code: ${esc(data.code)}<br>Password: ${esc(data.password)}`;$('dt-new-login').hidden=false;feedback('Student registered for '+cohort+'.');await reload()})};
$('dt-student-table').onclick=event=>{const button=event.target.closest('[data-reset]');if(!button||!confirm('Reset this student’s password? They will need the new password to sign in again.'))return;action(button,async()=>{const data=await api(path('/students/'+button.dataset.reset+'/reset-password'),{method:'POST',body:{}});$('dt-new-login').textContent='New password: '+data.password;$('dt-new-login').hidden=false;feedback('Password reset. Give the new password to this student privately.')})};
$('dt-open').onclick=()=>action($('dt-open'),async()=>{await api(path('/settings'),{method:'PATCH',body:{state:current().state==='open'?'closed':'open'}});feedback('Exam entry updated for '+cohort+'.');await reload()});
$('dt-release').onclick=()=>action($('dt-release'),async()=>{const released=!current().released;await api(path('/settings'),{method:'PATCH',body:{released}});feedback(released?'Submitted students can now see their scores.':'Results are hidden from students.');await reload()});
$('dt-refresh').onclick=()=>action($('dt-refresh'),reload);
const dialog=$('dt-exam-dialog'),examForm=$('dt-exam-form');let dialogFocus=null;
function showExam(details=false){detailsMode=details;dialogFocus=document.activeElement;examForm.reset();$('dt-dialog-error').hidden=true;$('dt-dialog-title').textContent=details?'Edit exam details':'New '+cohort+' exam';$('dt-copy-label').hidden=details;examForm.elements.copyFrom.innerHTML='<option value="">Empty question bank</option>'+papers.map(e=>`<option value="${e.id}">${esc(e.name)}</option>`).join('');if(details){examForm.elements.name.value=current().name;examForm.elements.minutes.value=current().minutes}dialog.showModal()}
$('dt-new').onclick=()=>showExam();$('dt-duration').onclick=()=>showExam(true);$('dt-dialog-cancel').onclick=()=>dialog.close();dialog.addEventListener('close',()=>dialogFocus?.focus());
examForm.onsubmit=event=>{event.preventDefault();const button=event.submitter;action(button,async()=>{try{const fields=Object.fromEntries(new FormData(examForm));fields.minutes=Number(fields.minutes);if(detailsMode)await api(path('/settings'),{method:'PATCH',body:fields});else{const data=await api('/api/digital/admin/'+cohort+'/exams',{method:'POST',body:fields});examId=data.id}dialog.close();clearFile();resetQuestion();feedback('Exam saved for '+cohort+'.');await reload()}catch(error){note($('dt-dialog-error'),error.message,true)}})};
setInterval(()=>{if(tab==='results'&&$('dt-auto').checked&&!document.hidden&&!busy)action(null,refresh)},15000);
function init(){action(null,reload)}if(document.body.classList.contains('shell'))init();else document.addEventListener('shell-ready',init,{once:true});
