import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const html=readFileSync('public/monitor.html','utf8');
function harness(){
 const h={calls:0,now:100000,hidden:false};
 const elements=new Map();
 const c=vm.createContext({Date:{now:()=>h.now},document:{get hidden(){return h.hidden;}},$:(id)=>{if(!elements.has(id))elements.set(id,{});return elements.get(id);},fetch:()=>{h.calls++;return new Promise(resolve=>{h.resolve=resolve;});},diff(){},draw(){},setUpd(){}});
 vm.runInContext(html.slice(html.indexOf('let loading ='),html.indexOf('let prev =')),c);
 vm.runInContext(html.slice(html.indexOf('async function load()'),html.indexOf('function counts(')),c);
 h.eval=s=>vm.runInContext(s,c);
 h.load=()=>h.eval('load()');
 h.ok=()=>h.resolve({ok:true,json:async()=>({exam:'Exam',minutes:120,live:true,students:[{status:'in_progress',tabSwitches:0}]})});
 return h;
}
test('monitor prevents overlapping and repeated refreshes; pauses and hidden tabs make no requests',async()=>{
 const h=harness();const first=h.load();await h.load();assert.equal(h.calls,1);
 h.ok();await first;await h.load();assert.equal(h.calls,1);
 h.now+=15000;h.hidden=true;await h.load();assert.equal(h.calls,1);
 h.hidden=false;h.eval('paused=true');await h.load();assert.equal(h.calls,1);
 h.eval('paused=false');const next=h.load();assert.equal(h.calls,2);h.ok();await next;
 assert.equal(h.eval('pollDelay()'),15000);
 h.eval('students=[]');assert.equal(h.eval('pollDelay()'),60000);
});
test('monitor failures back off and successful recovery restores the normal polling interval',async()=>{
 const h=harness();h.eval("students=[{status:'in_progress'}]");
 const first=h.load();h.resolve({ok:false});await first;
 assert.equal(h.eval('pollDelay()'),30000);
 h.now+=15000;await h.load();assert.equal(h.calls,1);
 h.now+=15000;const second=h.load();h.resolve({ok:false});await second;
 assert.equal(h.eval('pollDelay()'),60000);
 h.eval('failedPolls=10');assert.equal(h.eval('pollDelay()'),120000);
 h.now+=120000;const recovery=h.load();h.ok();await recovery;
 assert.equal(h.eval('failedPolls'),0);assert.equal(h.eval('pollDelay()'),15000);
});
