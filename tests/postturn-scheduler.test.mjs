import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import LosslessCompaction, { summaryFailureCode } from '../agent.js';

function fixture(run) {
 const engine=Object.create(LosslessCompaction.prototype);
 engine.settings={configFile:{value:{enabled:true,automatic:true,compressionTiming:'after-turn'}},tasks:new Set()};
 engine.pendingTurnEnds=new Map();
 engine.postTurnAgents=new Map();
 engine.postTurnBusyRetries=new Map();
 engine.postTurnRetryAt=new Map();
 engine.postTurnTask=null;
 engine.postTurnTimer=null;
 engine.postTurnAbort=null;
 engine.postTurnAgent=null;
 engine.idleTimer=null;
 engine.idleTask=null;
 engine.diagnostics=()=>{};
 engine.runPostTurn=run;
 return engine;
}
function agent(id,phase='idle') {
 return {status:'idle',phase:{kind:phase},inbox:{hasPending:false},session:{id}};
}
function shutdown(engine) {
 if(engine.postTurnTimer)clearTimeout(engine.postTurnTimer);
 engine.postTurnTimer=null;
}

test('an apparently idle agent in maintenance does not enter a competing transaction',async()=>{
 let calls=0;
 const engine=fixture(async()=>{calls++;});
 const a=agent('maintenance','maintenance');
 engine.pendingTurnEnds.set(a.session.id,10);
 engine.queuePostTurn(a,1);
 await sleep(35);
 assert.equal(calls,0);
 assert.equal(engine.pendingTurnEnds.get(a.session.id),10);
 a.phase.kind='idle';
 shutdown(engine); // emulate maintenance-release wakeup instead of waiting for fallback
 engine.queuePostTurn(a,1);
 await sleep(35);
 assert.equal(calls,1);
 assert.equal(engine.pendingTurnEnds.size,0);
 shutdown(engine);
});

test('pending sessions drain sequentially after another session has completed',async()=>{
 let release;
 const first=new Promise(resolve=>release=resolve);
 const observed=[];
 const engine=fixture(async(a)=>{
  observed.push(a.session.id);
  if(a.session.id==='one')await first;
 });
 const a=agent('one'),b=agent('two');
 engine.pendingTurnEnds.set(a.session.id,1);
 engine.queuePostTurn(a,1);
 await sleep(25);
 engine.pendingTurnEnds.set(b.session.id,2);
 engine.queuePostTurn(b,1);
 await sleep(25);
 assert.deepEqual(observed,['one']);
 release();
 await sleep(210);
 assert.deepEqual(observed,['one','two']);
 assert.equal(engine.pendingTurnEnds.size,0);
 assert.equal(engine.settings.tasks.size,0);
 shutdown(engine);
});

test('new inbox work during granted compression does not abort the active compression',async()=>{
 let release;
 const done=new Promise(resolve=>release=resolve);
 let activeSignal,completed=false;
 const engine=fixture(async(_a,signal)=>{
  activeSignal=signal;
  await done;
  completed=true;
 });
 const a=agent('queued-message');
 engine.pendingTurnEnds.set(a.session.id,10);
 engine.queuePostTurn(a,1);
 await sleep(25);
 a.inbox.hasPending=true;
 assert.equal(activeSignal.aborted,false);
 release();
 await sleep(25);
 assert.equal(completed,true);
 assert.equal(activeSignal.aborted,false);
 assert.equal(engine.settings.tasks.size,0);
 shutdown(engine);
});

test('maintenance busy is not discarded after three attempts',async()=>{
 let calls=0;
 const engine=fixture(async()=>{
  calls++;
  if(calls<=4)throw Object.assign(new Error('temporarily leased'),{code:'busy'});
 });
 const a=agent('busy');
 engine.pendingTurnEnds.set(a.session.id,8);
 engine.queuePostTurn(a,1);
 for(let i=1;i<=5;i++){
  await sleep(30);
  assert.equal(calls,i);
  if(i<=4){
   assert.equal(engine.pendingTurnEnds.get(a.session.id),8);
   assert.equal(engine.postTurnBusyRetries.get(a.session.id),i);
   engine.postTurnRetryAt.set(a.session.id,0);
   shutdown(engine);
   engine.schedulePostTurns(1);
  }
 }
 assert.equal(engine.pendingTurnEnds.size,0);
 assert.equal(engine.postTurnBusyRetries.size,0);
 assert.equal(engine.postTurnTask,null);
 shutdown(engine);
});

test('busy completion preserves a newer turn/end instead of restoring an older seq',async()=>{
 let release;
 const gate=new Promise(resolve=>release=resolve);
 let calls=0;
 const engine=fixture(async()=>{
  if(++calls===1){
   await gate;
   throw Object.assign(new Error('busy'),{code:'busy'});
  }
 });
 const a=agent('newer');
 engine.pendingTurnEnds.set(a.session.id,5);
 engine.queuePostTurn(a,1);
 await sleep(20);
 assert(engine.postTurnTask);
 engine.pendingTurnEnds.set(a.session.id,9);
 engine.queuePostTurn(a,1);
 release();
 await sleep(35);
 assert.equal(engine.pendingTurnEnds.get(a.session.id),9);
 engine.postTurnRetryAt.set(a.session.id,0);
 shutdown(engine);
 engine.schedulePostTurns(1);
 await sleep(30);
 assert.equal(calls,2);
 assert.equal(engine.pendingTurnEnds.size,0);
 shutdown(engine);
});

test('summary diagnostics classify failure stage without persisting provider error text',()=>{
 assert.equal(summaryFailureCode(Object.assign(new Error('private data'),{code:'MAX_TOKENS'})),'MAX_TOKENS');
 assert.equal(summaryFailureCode(new Error('summarization produced no text summary content')),'SUMMARY_EMPTY');
 assert.equal(summaryFailureCode(new Error('unrecognized sensitive model response')),'SUMMARY_UNKNOWN');
 assert.equal(summaryFailureCode({code:'invalid key with secret',message:'private'}),'SUMMARY_UNKNOWN');
});
