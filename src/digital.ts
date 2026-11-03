import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { sign, verify } from 'hono/jwt';
import { bodyLimit } from 'hono/body-limit';
import { currentSessionId, requireRole, VIEW_COOKIE, type Env } from './auth';
import { hashPassword, verifyPassword, randomPassword, encryptSecret, decryptSecret } from './crypto';
import { lockedMinutes, lockMessage, recordFail, clearFails } from './limits';

type Paper = { id: number; session_id: number; cohort: string; name: string; minutes: number; state: string; locked_at: number | null; results_released: number };
type Learner = { id: number; session_id: number; cohort: string; code: string; full_name: string; auth_version: number };
type Sitting = { id: number; exam_id: number; started_at: number; ends_at: number; submitted_at: number | null; score: number | null; answered: number; focus_count: number };
type DigitalEnv = { Bindings: Env['Bindings']; Variables: Env['Variables'] & { digitalPaper: Paper | null; digitalStudent: Learner; digitalCohort: string } };
type Ctx = Context<DigitalEnv>;
const COOKIE = 'digital_session', COOKIE_PATH = '/api/digital', TOTAL = 30, MAX = 70, GRACE = 10;
const now = () => Math.floor(Date.now() / 1000);
const text = (x: unknown) => typeof x === 'string' ? x.trim().replace(/\s+/g, ' ') : '';
const positive = (x: unknown) => (typeof x === 'number' || (typeof x === 'string' && /^\d+$/.test(x))) && Number.isSafeInteger(Number(x)) && Number(x) > 0;
const secret = (c: Ctx) => c.env.PASSWORD_KEY || c.env.JWT_SECRET;
const body = async (c: Ctx): Promise<Record<string, unknown>> => { const parsed=await c.req.json<unknown>().catch(()=>null); return parsed && typeof parsed==='object' && !Array.isArray(parsed) ? parsed as Record<string,unknown> : {}; };
function csv(v: unknown) { return '"' + String(v ?? '').replace(/^[=+@\-\t\r]/, "'$&").replace(/"/g, '""') + '"'; }
function download(c: Ctx, name: string, rows: unknown[][]) {
 c.header('Content-Type', 'text/csv; charset=utf-8'); c.header('Content-Disposition', `attachment; filename="${name}"`);
 return c.body('\uFEFF' + rows.map(row => row.map(csv).join(',')).join('\r\n'));
}
function paper(c: Ctx) { const e = c.get('digitalPaper'); if (!e) throw new Error('DIGITAL_NO_PAPER'); return e; }
function cleanQuestion(input: Record<string, unknown>) {
 const q = { body: text(input.question ?? input.body), a: text(input.a), b: text(input.b), c: text(input.c), d: text(input.d), correct: text(input.correct).toUpperCase() };
 if (q.body.length < 3 || q.body.length > 1000) return { error: 'Write a question between 3 and 1000 characters.' } as const;
 const options = [q.a, q.b, q.c, q.d];
 if (options.some(x => !x || x.length > 300)) return { error: 'Each of the four options must contain 1 to 300 characters.' } as const;
 if (new Set(options.map(x => x.toLowerCase())).size !== 4) return { error: 'The four options must be different.' } as const;
 if (!['A','B','C','D'].includes(q.correct)) return { error: 'Correct must be A, B, C or D.' } as const;
 return { value: q } as const;
}
const scoreSQL = `UPDATE digital_attempts AS a SET submitted_at=unixepoch(), score=(
 SELECT COUNT(*) FROM digital_answers w JOIN digital_questions q ON q.id=w.question_id
 WHERE w.attempt_id=a.id AND w.chosen=q.correct) WHERE submitted_at IS NULL`;
async function finalize(db: D1Database, id: number) { await db.prepare(scoreSQL + ' AND id=?').bind(id).run(); }
async function expire(db: D1Database, examId: number) {
 await db.prepare(scoreSQL + ' AND exam_id=? AND ends_at<?').bind(examId, now()-GRACE).run();
}
async function sitting(db: D1Database, studentId: number, examId: number) {
 return db.prepare('SELECT id,exam_id,started_at,ends_at,submitted_at,score,answered,focus_count FROM digital_attempts WHERE student_id=? AND exam_id=?').bind(studentId,examId).first<Sitting>();
}
const dt = new Hono<DigitalEnv>();
dt.use('*', bodyLimit({ maxSize: 1024*1024, onError: c => c.json({ error: 'This upload is too large. Upload at most 70 questions at once.' },413) }));
dt.use('*', async (c,next) => {
 if (!['GET','HEAD'].includes(c.req.method)) {
  const origin = c.req.header('Origin');
  if ((origin && origin !== new URL(c.req.url).origin) || c.req.header('Sec-Fetch-Site') === 'cross-site') return c.json({ error: 'Request origin could not be verified.' },403);
 }
 await next();
});
dt.onError((err,c) => {
 const errors: Record<string,string> = {
  DIGITAL_NO_PAPER:'Create an exam for this class first.', DIGITAL_BANK_NOT_READY:'Add at least 30 questions before opening the exam.',
  DIGITAL_BANK_FULL:'This paper already has 70 questions.', DIGITAL_PAPER_LOCKED:'A student has started this paper. Create a new exam to change its questions or duration.',
  DIGITAL_SPACE_BUSY:'Close the other open paper and let its students finish before opening this one.', DIGITAL_EXAM_CHANGED:'This exam is not open for your class. Refresh and contact your teacher.',
  DIGITAL_FINISHED:'Your exam has finished. Refresh to see the saved submission.'
 };
 const key = Object.keys(errors).find(key => err.message.includes(key));
 if (key) return c.json({ error: errors[key], ...(key==='DIGITAL_FINISHED'?{finished:true}:{}) },409);
 if (err.message.includes('UNIQUE constraint failed')) return c.json({ error: 'This class already has an exam with that name, or a paper is already open.' },409);
 console.error(err); return c.json({ error: 'Could not complete this request. Try again or contact your teacher.' },500);
});

// Admins use their existing login. These spaces do not use or change the SS3 live-exam selection.
dt.use('/admin/*', requireRole('admin'));
dt.use('/admin/:cohort/*', async (c,next) => {
 const cohort = c.req.param('cohort'); if (!['SS1','SS2'].includes(cohort)) return c.json({ error: 'Choose SS1 or SS2.' },400);
 const current = await currentSessionId(c.env.DB); let sid = Number(getCookie(c,VIEW_COOKIE)) || current;
 if (sid !== current && !(await c.env.DB.prepare('SELECT 1 FROM sessions WHERE id=?').bind(sid).first())) sid=current;
 if (sid !== current && c.req.method!=='GET') return c.json({ error: 'Past sessions are read-only.' },403);
 c.set('sessionId',sid); c.set('currentSessionId',current); c.set('digitalCohort',cohort);
 const selected = c.req.query('examId');
 if (selected && !positive(selected)) return c.json({ error: 'Invalid exam.' },400);
 const e = selected
  ? await c.env.DB.prepare('SELECT * FROM digital_exams WHERE id=? AND session_id=? AND cohort=?').bind(Number(selected),sid,cohort).first<Paper>()
  : await c.env.DB.prepare('SELECT * FROM digital_exams WHERE session_id=? AND cohort=? ORDER BY id DESC LIMIT 1').bind(sid,cohort).first<Paper>();
 if (selected && !e) return c.json({ error: 'This exam does not belong to this class and session.' },404);
 c.set('digitalPaper',e); await next();
});
dt.get('/admin/:cohort/exams', async c => {
 const {results} = await c.env.DB.prepare(`SELECT e.id,e.name,e.minutes,e.state,e.locked_at AS lockedAt,e.results_released AS released,
 (SELECT COUNT(*) FROM digital_questions q WHERE q.exam_id=e.id) AS questions,
 (SELECT COUNT(*) FROM digital_attempts a WHERE a.exam_id=e.id) AS attempts
 FROM digital_exams e WHERE e.session_id=? AND e.cohort=? ORDER BY e.id DESC`).bind(c.get('sessionId'),c.get('digitalCohort')).all();
 const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM digital_students WHERE session_id=? AND cohort=?').bind(c.get('sessionId'),c.get('digitalCohort')).first<{n:number}>();
 return c.json({ exams:results, selected:c.get('digitalPaper')?.id??null, cohort:c.get('digitalCohort'), students:count?.n??0, total:TOTAL, max:MAX, readOnly:c.get('sessionId')!==c.get('currentSessionId') });
});
dt.post('/admin/:cohort/exams', async c => {
 const b=await body(c), name=text(b.name), minutes=Number(b.minutes??30), copyFrom=Number(b.copyFrom||0);
 if (name.length<2||name.length>60||!Number.isInteger(minutes)||minutes<10||minutes>180) return c.json({error:'Enter an exam name (2–60 characters) and a duration from 10 to 180 minutes.'},400);
 if (b.copyFrom && !positive(b.copyFrom)) return c.json({error:'Choose a valid paper to copy.'},400);
 if (copyFrom && !(await c.env.DB.prepare('SELECT 1 FROM digital_exams WHERE id=? AND cohort=? AND session_id=?').bind(copyFrom,c.get('digitalCohort'),c.get('sessionId')).first())) return c.json({error:'Copy questions only from this class and session.'},400);
 const row=await c.env.DB.prepare('INSERT INTO digital_exams(session_id,cohort,name,minutes) VALUES(?,?,?,?) RETURNING id').bind(c.get('sessionId'),c.get('digitalCohort'),name,minutes).first<{id:number}>();
 if(copyFrom) await c.env.DB.prepare('INSERT INTO digital_questions(exam_id,body,option_a,option_b,option_c,option_d,correct) SELECT ?,body,option_a,option_b,option_c,option_d,correct FROM digital_questions WHERE exam_id=? ORDER BY id').bind(row!.id,copyFrom).run();
 return c.json({ok:true,id:row!.id},201);
});
dt.patch('/admin/:cohort/settings', async c => {
 const e=paper(c),b=await body(c),steps:D1PreparedStatement[]=[];
 if(b.state!==undefined&&!['open','closed'].includes(String(b.state)))return c.json({error:'Choose open or closed.'},400);
 if(b.released!==undefined&&typeof b.released!=='boolean')return c.json({error:'Invalid result setting.'},400);
 if (b.minutes!==undefined || b.name!==undefined) {
  const name=b.name===undefined?e.name:text(b.name),minutes=b.minutes===undefined?e.minutes:Number(b.minutes);
  if(name.length<2||name.length>60||!Number.isInteger(minutes)||minutes<10||minutes>180) return c.json({error:'Use a name of 2–60 characters and a duration from 10 to 180 minutes.'},400);
  steps.push(c.env.DB.prepare('UPDATE digital_exams SET name=?,minutes=? WHERE id=?').bind(name,minutes,e.id));
 }
 if(b.state==='open')steps.push(c.env.DB.prepare(scoreSQL+` AND ends_at<? AND exam_id IN(SELECT id FROM digital_exams WHERE session_id=? AND cohort=?)`).bind(now()-GRACE,e.session_id,e.cohort));
 if(b.state!==undefined)steps.push(c.env.DB.prepare('UPDATE digital_exams SET state=? WHERE id=?').bind(b.state,e.id));
 if(b.released!==undefined){steps.push(c.env.DB.prepare(scoreSQL+' AND exam_id=? AND ends_at<?').bind(e.id,now()-GRACE));steps.push(c.env.DB.prepare('UPDATE digital_exams SET results_released=? WHERE id=?').bind(b.released?1:0,e.id))}
 if(steps.length)await c.env.DB.batch(steps);
 return c.json({ok:true});
});
dt.get('/admin/:cohort/questions', async c => {
 const e=paper(c); const {results}=await c.env.DB.prepare('SELECT id,body,option_a AS a,option_b AS b,option_c AS c,option_d AS d,correct FROM digital_questions WHERE exam_id=? ORDER BY id').bind(e.id).all();
 return c.json({questions:results,max:MAX,total:TOTAL,locked:!!e.locked_at});
});
dt.post('/admin/:cohort/questions/import', async c => {
 const e=paper(c); if(e.locked_at)throw new Error('DIGITAL_PAPER_LOCKED'); const b=await body(c);
 if(!Array.isArray(b.rows)||!b.rows.length||b.rows.length>200) return c.json({error:'Upload between 1 and 200 rows. A paper can hold up to 70 questions.'},400);
 const n=await c.env.DB.prepare('SELECT COUNT(*) AS n FROM digital_questions WHERE exam_id=?').bind(e.id).first<{n:number}>();
 let count=n?.n??0; const skipped:{row:number;reason:string}[]=[],statements:D1PreparedStatement[]=[];
 b.rows.forEach((raw,i)=>{
  const r=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Record<string,unknown>:{}; const checked=cleanQuestion(r),row=Number.isSafeInteger(r.row)?Number(r.row):i+2;
  const rowClass=text(r.cohort??r.class).toUpperCase(),subject=text(r.subject).toLowerCase();
  if(rowClass&&rowClass!==e.cohort){skipped.push({row,reason:'This row is for '+rowClass+', not '+e.cohort+'.'});return}
  if(subject&&!['digital technologies','digital technology','digital','dt'].includes(subject)){skipped.push({row,reason:'This space accepts Digital Technologies questions only.'});return}
  if('error' in checked){skipped.push({row,reason:checked.error!});return}
  if(count>=MAX){skipped.push({row,reason:'The 70-question bank is full.'});return}
  count++;const q=checked.value;
  statements.push(c.env.DB.prepare(`INSERT INTO digital_questions(exam_id,body,option_a,option_b,option_c,option_d,correct)
   SELECT ?1,?2,?3,?4,?5,?6,?7 WHERE (SELECT COUNT(*) FROM digital_questions WHERE exam_id=?1)<70`).bind(e.id,q.body,q.a,q.b,q.c,q.d,q.correct));
 });
 const saved=statements.length?await c.env.DB.batch(statements):[]; const added=saved.reduce((n,r)=>n+r.meta.changes,0);
 return c.json({ok:true,added,skipped,warning:added<statements.length?'Another upload filled the bank. Refresh to check its questions.':null});
});
dt.put('/admin/:cohort/questions/:id', async c=>{
 const e=paper(c),checked=cleanQuestion(await body(c));if('error' in checked)return c.json({error:checked.error},400);const q=checked.value;
 const r=await c.env.DB.prepare('UPDATE digital_questions SET body=?,option_a=?,option_b=?,option_c=?,option_d=?,correct=? WHERE id=? AND exam_id=?').bind(q.body,q.a,q.b,q.c,q.d,q.correct,Number(c.req.param('id')),e.id).run();
 return r.meta.changes?c.json({ok:true}):c.json({error:'Question not found in this paper.'},404);
});
dt.delete('/admin/:cohort/questions/:id', async c=>{
 const r=await c.env.DB.prepare('DELETE FROM digital_questions WHERE id=? AND exam_id=?').bind(Number(c.req.param('id')),paper(c).id).run();
 return r.meta.changes?c.json({ok:true}):c.json({error:'Question not found in this paper.'},404);
});
dt.get('/admin/:cohort/students', async c=>{
 const e=c.get('digitalPaper');const {results}=await c.env.DB.prepare(`SELECT s.id,s.code,s.full_name AS name,a.id AS attemptId,a.submitted_at AS submittedAt,a.answered,a.focus_count AS tabSwitches
 FROM digital_students s LEFT JOIN digital_attempts a ON a.student_id=s.id AND a.exam_id=?
 WHERE s.session_id=? AND s.cohort=? ORDER BY s.full_name COLLATE NOCASE,s.id LIMIT 501`).bind(e?.id??0,c.get('sessionId'),c.get('digitalCohort')).all();
 return c.json({students:results.slice(0,500),limited:results.length>500});
});
dt.post('/admin/:cohort/students', async c=>{
 const b=await body(c),first=text(b.firstName),last=text(b.lastName);
 if(first.length<2||last.length<2||first.length+last.length>119)return c.json({error:'Enter the student’s first and last name (up to 120 characters combined).'},400);
 const password=randomPassword(),hash=await hashPassword(password),enc=await encryptSecret(password,secret(c));
 const row=await c.env.DB.prepare(`INSERT INTO digital_students(session_id,cohort,seq,code,full_name,password_hash,password_enc)
 SELECT ?1,?2,n,?2||'-DT-'||printf('%03d',n),?3,?4,?5 FROM (SELECT COALESCE(MAX(seq),0)+1 n FROM digital_students WHERE session_id=?1 AND cohort=?2)
 RETURNING id,code`).bind(c.get('sessionId'),c.get('digitalCohort'),first+' '+last,hash,enc).first<{id:number;code:string}>();
 return c.json({id:row!.id,code:row!.code,name:first+' '+last,password},201);
});
dt.get('/admin/:cohort/logins.csv', async c=>{
 const {results}=await c.env.DB.prepare('SELECT code,full_name,password_enc FROM digital_students WHERE session_id=? AND cohort=? ORDER BY full_name COLLATE NOCASE,id LIMIT 500').bind(c.get('sessionId'),c.get('digitalCohort')).all<{code:string;full_name:string;password_enc:string}>();
 const rows=await Promise.all(results.map(async s=>[s.full_name,c.get('digitalCohort'),s.code,(await decryptSecret(s.password_enc,secret(c)))??'Contact admin to reset',new URL('/digital',c.req.url).href+'?class='+c.get('digitalCohort')]));
 return download(c,c.get('digitalCohort')+'-digital-logins.csv',[['Name','Class','Student code','Password','Login URL'],...rows]);
});
dt.post('/admin/:cohort/students/:id/reset-password', async c=>{
 const password=randomPassword(),hash=await hashPassword(password),enc=await encryptSecret(password,secret(c));
 const r=await c.env.DB.prepare('UPDATE digital_students SET password_hash=?,password_enc=?,auth_version=auth_version+1 WHERE id=? AND session_id=? AND cohort=?').bind(hash,enc,Number(c.req.param('id')),c.get('sessionId'),c.get('digitalCohort')).run();
 return r.meta.changes?c.json({ok:true,password}):c.json({error:'Student not found in this class.'},404);
});
dt.get('/admin/:cohort/results', async c=>{
 const e=paper(c);await expire(c.env.DB,e.id);
 const {results}=await c.env.DB.prepare(`SELECT s.id,s.code,s.full_name AS name,a.id AS attemptId,a.started_at AS startedAt,a.ends_at AS endsAt,a.submitted_at AS submittedAt,a.score,a.answered,a.focus_count AS tabSwitches
 FROM digital_students s LEFT JOIN digital_attempts a ON a.student_id=s.id AND a.exam_id=?
 WHERE s.session_id=? AND s.cohort=? ORDER BY s.full_name COLLATE NOCASE,s.id LIMIT 501`).bind(e.id,c.get('sessionId'),c.get('digitalCohort')).all();
 return c.json({students:results.slice(0,500),limited:results.length>500,total:TOTAL,released:!!e.results_released,asOf:now()});
});
dt.get('/admin/:cohort/results.csv', async c=>{
 const e=paper(c);await expire(c.env.DB,e.id);const {results}=await c.env.DB.prepare(`SELECT s.full_name,s.code,a.submitted_at,a.score FROM digital_students s JOIN digital_attempts a ON a.student_id=s.id AND a.exam_id=? WHERE s.session_id=? AND s.cohort=? AND a.submitted_at IS NOT NULL ORDER BY s.full_name COLLATE NOCASE`).bind(e.id,c.get('sessionId'),c.get('digitalCohort')).all<{full_name:string;code:string;submitted_at:number;score:number}>();
 return download(c,c.get('digitalCohort')+'-digital-results.csv',[['Name','Class','Student code','Exam','Score','Total','Percentage','Submitted (UTC)'],...results.map(r=>[r.full_name,c.get('digitalCohort'),r.code,e.name,r.score,TOTAL,Math.round(r.score/TOTAL*100),new Date(r.submitted_at*1000).toISOString()])]);
});

// A separate signed cookie prevents SS1/SS2 identities being mistaken for SS3 students.
dt.post('/student/login', async c=>{
 const b=await body(c),cohort=text(b.cohort),code=text(b.code).toUpperCase(),password=text(b.password).toUpperCase();
 if(!['SS1','SS2'].includes(cohort)||!code||code.length>40||!password||password.length>128)return c.json({error:'Choose your class and enter your student code and password.'},400);
 const sid=await currentSessionId(c.env.DB),key='dt:'+sid+':'+cohort+':'+code+':'+(c.req.header('CF-Connecting-IP')??'local');const wait=await lockedMinutes(c.env.DB,key);
 if(wait)return c.json({error:lockMessage(wait)},429);
 const s=await c.env.DB.prepare('SELECT id,auth_version,password_hash FROM digital_students WHERE session_id=? AND cohort=? AND code=?').bind(sid,cohort,code).first<{id:number;auth_version:number;password_hash:string}>();
 if(!s||!(await verifyPassword(password,s.password_hash))){if(s)await recordFail(c.env.DB,key);return c.json({error:'Student code or password is not correct for this class.'},401)}
 await clearFails(c.env.DB,key);
 const jwt=await sign({role:'digital-student',id:s.id,v:s.auth_version,exp:now()+8*3600},c.env.JWT_SECRET);
 setCookie(c,COOKIE,jwt,{path:COOKIE_PATH,sameSite:'Lax',httpOnly:true,secure:new URL(c.req.url).protocol==='https:',maxAge:8*3600});
 return c.json({ok:true,cohort});
});
dt.post('/student/logout', c=>{deleteCookie(c,COOKIE,{path:COOKIE_PATH});return c.json({ok:true})});
dt.use('/student/*',async(c,next)=>{
 let jwt:Record<string,unknown>;
 try{jwt=await verify(getCookie(c,COOKIE)||'',c.env.JWT_SECRET,'HS256')}catch{return c.json({error:'Please log in to Digital Technologies.'},401)}
 if(jwt.role!=='digital-student'||!Number.isSafeInteger(jwt.id))return c.json({error:'Please log in to Digital Technologies.'},401);
 const s=await c.env.DB.prepare(`SELECT id,session_id,cohort,code,full_name,auth_version FROM digital_students WHERE id=? AND session_id=(SELECT CAST(value AS INTEGER) FROM settings WHERE key='current_session_id')`).bind(jwt.id).first<Learner>();
 if(!s||s.auth_version!==jwt.v)return c.json({error:'Your login has expired. Log in again or contact your teacher.'},401);
 c.set('digitalStudent',s);await next();
});
dt.get('/student/exam',async c=>{
 const s=c.get('digitalStudent'),db=c.env.DB;
 const active=await db.prepare(`SELECT e.* FROM digital_attempts a JOIN digital_exams e ON e.id=a.exam_id WHERE a.student_id=? AND a.submitted_at IS NULL ORDER BY a.id DESC LIMIT 1`).bind(s.id).first<Paper>();
 const e=active??await db.prepare(`SELECT e.* FROM digital_exams e WHERE e.session_id=? AND e.cohort=? ORDER BY (e.state='open') DESC,(EXISTS(SELECT 1 FROM digital_attempts a WHERE a.exam_id=e.id AND a.student_id=?)) DESC,e.id DESC LIMIT 1`).bind(s.session_id,s.cohort,s.id).first<Paper>();
 const student={id:s.id,name:s.full_name,code:s.code,cohort:s.cohort};
 if(!e)return c.json({status:'waiting',student,total:TOTAL});
 let a=await sitting(db,s.id,e.id);
 if(a&&!a.submitted_at&&now()>a.ends_at+GRACE){await finalize(db,a.id);a=await sitting(db,s.id,e.id)}
 const common={student,examId:e.id,examName:e.name,minutes:e.minutes,total:TOTAL};
 if(!a)return c.json({...common,status:e.state==='open'?'ready':'waiting'});
 if(a.submitted_at){
  const [{results:allocated},{results:saved}]=await Promise.all([
   db.prepare('SELECT question_id AS id FROM digital_attempt_questions WHERE attempt_id=? ORDER BY position').bind(a.id).all<{id:number}>(),
   db.prepare('SELECT question_id AS id,chosen,revision FROM digital_answers WHERE attempt_id=?').bind(a.id).all<{id:number;chosen:string;revision:number}>()
  ]);
  return c.json({...common,status:'submitted',attemptId:a.id,questionIds:allocated.map(q=>q.id),answers:Object.fromEntries(saved.map(w=>[w.id,w.chosen])),answerRevisions:Object.fromEntries(saved.map(w=>[w.id,w.revision])),released:!!e.results_released,...(e.results_released?{score:a.score,percentage:Math.round((a.score??0)/TOTAL*100)}:{})});
 }
 const {results:questions}=await db.prepare(`SELECT q.id,q.body,q.option_a AS a,q.option_b AS b,q.option_c AS c,q.option_d AS d FROM digital_attempt_questions aq JOIN digital_questions q ON q.id=aq.question_id WHERE aq.attempt_id=? ORDER BY aq.position`).bind(a.id).all();
 const {results:answers}=await db.prepare('SELECT question_id AS id,chosen,revision FROM digital_answers WHERE attempt_id=?').bind(a.id).all<{id:number;chosen:string;revision:number}>();
 return c.json({...common,status:'in_progress',attemptId:a.id,secondsLeft:Math.max(0,a.ends_at-now()),questions,answers:Object.fromEntries(answers.map(w=>[w.id,w.chosen])),answerRevisions:Object.fromEntries(answers.map(w=>[w.id,w.revision]))});
});
dt.post('/student/exam/start',async c=>{
 const s=c.get('digitalStudent'),b=await body(c);if(!positive(b.examId))return c.json({error:'Refresh and choose the current exam.'},400);
 const e=await c.env.DB.prepare('SELECT * FROM digital_exams WHERE id=? AND session_id=? AND cohort=?').bind(Number(b.examId),s.session_id,s.cohort).first<Paper>();
 if(!e)return c.json({error:'This exam is not assigned to your class.'},403);
 const prior=await sitting(c.env.DB,s.id,e.id);if(prior)return c.json({ok:true,attemptId:prior.id});
 if(e.state!=='open')throw new Error('DIGITAL_EXAM_CHANGED');
 const stamp=now();const row=await c.env.DB.prepare('INSERT OR IGNORE INTO digital_attempts(student_id,exam_id,started_at,ends_at) VALUES(?,?,?,?) RETURNING id').bind(s.id,e.id,stamp,stamp+e.minutes*60).first<{id:number}>();
 return c.json({ok:true,attemptId:row?.id??(await sitting(c.env.DB,s.id,e.id))!.id},row?201:200);
});
dt.put('/student/exam/answer',async c=>{
 const s=c.get('digitalStudent'),b=await body(c);
 if(!positive(b.attemptId)||!positive(b.questionId)||!Number.isSafeInteger(b.revision)||Number(b.revision)<1||!['A','B','C','D'].includes(String(b.chosen)))return c.json({error:'Invalid answer.'},400);
 const a=await c.env.DB.prepare('SELECT id,ends_at,submitted_at FROM digital_attempts WHERE id=? AND student_id=?').bind(b.attemptId,s.id).first<{id:number;ends_at:number;submitted_at:number|null}>();
 if(!a)return c.json({error:'This attempt belongs to another student.',attemptChanged:true},409);
 if(a.submitted_at||now()>a.ends_at+GRACE){if(!a.submitted_at)await finalize(c.env.DB,a.id);return c.json({error:'Your exam has finished.',finished:true},409)}
 const assigned=await c.env.DB.prepare('SELECT 1 FROM digital_attempt_questions WHERE attempt_id=? AND question_id=?').bind(a.id,b.questionId).first();
 if(!assigned)return c.json({error:'That question is not in your assigned paper.'},400);
 await c.env.DB.prepare(`INSERT INTO digital_answers(attempt_id,question_id,chosen,revision) VALUES(?,?,?,?)
 ON CONFLICT(attempt_id,question_id) DO UPDATE SET chosen=excluded.chosen,revision=excluded.revision WHERE excluded.revision>digital_answers.revision`).bind(a.id,b.questionId,b.chosen,b.revision).run();
 const ack=await c.env.DB.prepare('SELECT chosen,revision FROM digital_answers WHERE attempt_id=? AND question_id=?').bind(a.id,b.questionId).first<{chosen:string;revision:number}>();
 if(ack?.chosen!==b.chosen||ack?.revision!==b.revision)return c.json({error:'An answer changed in another request. Refresh to reconcile it.',conflict:true},409);
 return c.json({ok:true,...ack});
});
dt.post('/student/exam/focus-event',async c=>{
 const s=c.get('digitalStudent'),b=await body(c);
 if(!positive(b.attemptId)||typeof b.eventId!=='string'||!/^[a-zA-Z0-9-]{16,80}$/.test(b.eventId)||!Number.isSafeInteger(b.occurredAt)||Number(b.occurredAt)<0||Number(b.occurredAt)>now()+60)return c.json({error:'Invalid focus event.'},400);
 await c.env.DB.prepare(`INSERT OR IGNORE INTO digital_focus_events(attempt_id,event_id,occurred_at)
 SELECT id,?2,?3 FROM digital_attempts WHERE id=?1 AND student_id=?4 AND ?3>=started_at AND ?3<=ends_at AND (submitted_at IS NULL OR ?3<=submitted_at) AND focus_count<500`).bind(b.attemptId,b.eventId,b.occurredAt,s.id).run();
 return c.json({ok:true});
});
dt.post('/student/exam/submit',async c=>{
 const b=await body(c);const a=await c.env.DB.prepare('SELECT id FROM digital_attempts WHERE id=? AND student_id=?').bind(Number(b.attemptId)||0,c.get('digitalStudent').id).first<{id:number}>();
 if(!a)return c.json({error:'This attempt was not found for your account.',attemptChanged:true},409);
 await finalize(c.env.DB,a.id);return c.json({ok:true,attemptId:a.id});
});
export default dt;
