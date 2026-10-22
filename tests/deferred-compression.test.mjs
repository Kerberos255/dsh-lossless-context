import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import { schema,nativeConfig } from '../config.js';
import { deferredPressureBudget,retainedTailTokens } from '../pressure.js';
import { summarizeComplete } from '../summarizer.js';
import LosslessCompaction from '../agent.js';
import { readShared, skipWithoutShared } from './shared-settings.mjs';

const defaults=schema.defaults;
const makeAgent=()=>({status:'idle',inbox:{hasPending:false},session:{id:'test-session',requestHeader:()=>({config:{provider:'test',model:'summary',maxTokens:4096}})},options:{}});

test('old config gains task-end compaction without overwriting user pressure thresholds',()=>{
 const saved={...defaults,thresholdRatio:0.5,deferredRatio:0.45};
 delete saved.compressionTiming;
 const value=schema.validate(saved);
 assert.equal(value.compressionTiming,'after-turn');
 assert.equal(value.thresholdRatio,0.5);
 assert.equal(value.deferredRatio,0.45);
 assert.equal(schema.validate({...value,compressionTiming:'during-turn'}).compressionTiming,'during-turn');
 assert.throws(()=>schema.validate({...value,compressionTiming:'sometime'}));
});

test('emergency pressure remains above routine 50% threshold and below usable capacity',()=>{
 for(const window of [65536,131072,262144]){
  const p=deferredPressureBudget({window,output:8192,thresholdRatio:0.5,headroomMode:'auto',headroomTokens:65536});
  assert(p.emergencyThreshold>p.threshold);
  assert(p.emergencyThreshold<=window-8192-p.safety);
 }
});

test('completed turn starts one idle compaction only after exceeding the routine threshold',async()=>{
 const agent=makeAgent();
 const value={...defaults,compressionTiming:'after-turn',thresholdRatio:0.5};
 const engine=Object.create(LosslessCompaction.prototype);
 engine.config=nativeConfig(value);
 let tokens=1000,compacted=0,requestedRetention=null;
 engine.settings={configFile:{value},tasks:new Set()};
 engine.ctx={llm:{resolveModelInfo:async()=>({context:{contextWindow:131072},defaultMaxTokens:4096})},tokenMeter:{measure:()=>({totalTokens:tokens})}};
 engine.compactNow=async(_agent,_signal,_command,retained)=>{requestedRetention=retained;compacted++;return {shadowedSeqs:[1,2]};};
 engine.diagnostics=()=>{};
 await engine.runPostTurn(agent,new AbortController().signal);
 assert.equal(compacted,0);
 tokens=75000;
 await engine.runPostTurn(agent,new AbortController().signal);
 assert.equal(compacted,1);
 assert.equal(requestedRetention,Math.floor((131072-4096)*0.16));
 assert.equal(engine.postTurnStatus,'任务结束后已完成压缩');
 agent.status='working';
 await engine.runPostTurn(agent,new AbortController().signal);
 assert.equal(compacted,1);
});

test('idle scheduler does nothing without turn/end, and processes each pending turn once',async()=>{
 const agent=makeAgent(),engine=Object.create(LosslessCompaction.prototype);
 engine.settings={configFile:{value:{enabled:true,automatic:true,compressionTiming:'after-turn'}},tasks:new Set()};
 engine.pendingTurnEnds=new Map();
 engine.idleTimer=null;engine.idleTask=null;engine.postTurnTimer=null;engine.postTurnTask=null;
 let work=0;engine.runPostTurn=async()=>{work++;};
 engine.queuePostTurn(agent);
 assert.equal(engine.postTurnTimer,null);
 engine.pendingTurnEnds.set(agent.session.id,7);
 engine.queuePostTurn(agent);
 await sleep(220);
 assert.equal(work,1);
 assert.equal(engine.pendingTurnEnds.size,0);
 assert.equal(engine.settings.tasks.size,0);
 engine.queuePostTurn(agent);
 await sleep(180);
 assert.equal(work,1);
});

function summaryOptions(overrides={}){return {summaryRetryMaxTokens:2048,summaryRetries:0,compressionTimeoutMs:2000,compressionMaxRetries:1,kind:'leaf',...overrides};}
const stubCtx={llm:{resolveModelInfo:async()=>({context:{contextWindow:100000,maxOutputTokens:8192}})},tokenMeter:{estimateMessage:()=>10}};
const stubAgent={options:{provider:'test',model:'summary'},session:{requestHeader:()=>({config:{provider:'test',model:'summary'}})}};
const stubInput={messages:[{role:'user',content:[{type:'text',text:'test data'}]}],tools:[]};
const native={modelPolicies:[],maxTokens:1024};

test('one transport error retries once and subsequent summary succeeds',async()=>{
 let calls=0,retries=0;
 const reply=await summarizeComplete(async()=>{
  calls++;
  if(calls===1)throw Object.assign(new Error('transient'),{code:'TRANSPORT'});
  return {summary:[{type:'text',text:'summary'}]};
 },stubCtx,native,stubInput,stubAgent,new AbortController().signal,summaryOptions({onTransient:()=>retries++}));
 assert.equal(calls,2);assert.equal(retries,1);assert.equal(reply.summary[0].text,'summary');
});

test('persistent transport errors stop after bounded retry attempts',async()=>{
 let calls=0;
 await assert.rejects(summarizeComplete(async()=>{calls++;throw Object.assign(new Error('transient'),{code:'TRANSPORT'});},
  stubCtx,native,stubInput,stubAgent,new AbortController().signal,summaryOptions()),{code:'TRANSPORT'});
 assert.equal(calls,2);
});

test('hard timeout ends a model request that ignores the abort signal',async()=>{
 const began=performance.now();
 await assert.rejects(summarizeComplete(async()=>new Promise(()=>{}),
  stubCtx,native,stubInput,stubAgent,new AbortController().signal,
  summaryOptions({compressionTimeoutMs:45,compressionMaxRetries:0})),{code:'LCM_TIMEOUT'});
 assert(performance.now()-began<1500);
});

test('explicit user cancellation stops without retrying',async()=>{
 const controller=new AbortController();
 let calls=0;
 const promise=summarizeComplete(async()=>{calls++;return new Promise(()=>{});},stubCtx,native,stubInput,stubAgent,controller.signal,summaryOptions());
 setTimeout(()=>controller.abort(new DOMException('cancelled','AbortError')),20);
 await assert.rejects(promise,{name:'AbortError'});
 assert.equal(calls,1);
});

test('settings UI exposes compaction timing and bounded transport controls',{skip:skipWithoutShared},()=>{
 const pages=JSON.parse(readShared('pages.json'));
 const keys=pages['dsh-lossless-context'].fields.map(x=>x.key);
 for(const name of ['compressionTiming','compressionTimeoutMs','compressionMaxRetries','postTurnStatus'])assert(keys.includes(name));
});

test('idle and in-turn compaction share the same tail retention policy',()=>{
 const window=131072,output=8192,config={retainRatio:0.16};
 assert.equal(retainedTailTokens({window,output,config}),Math.floor((window-output)*0.16));
 assert.equal(retainedTailTokens({window,output,config,override:{retainTokens:24000}}),24000);
 assert.equal(retainedTailTokens({window,output,config:{retainTokens:18000},override:{retainRatio:0.2}}),Math.floor((window-output)*0.2));
 assert.equal(retainedTailTokens({window,output,config:{retainTokens:18000}}),18000);
 assert.throws(()=>retainedTailTokens({window,output,config:{retainTokens:-1}}),RangeError);
});

test('native idle compaction respects retained tail and avoids opening a transaction when no safe prefix remains',async()=>{
 const engine=Object.create(LosslessCompaction.prototype);
 let appendCount=0,flushCount=0;
 engine.ctx={tokenMeter:{measure:()=>({nodes:[{seq:1,tokens:15},{seq:2,tokens:60},{seq:3,tokens:40}],totalTokens:115})},sessions:{flush:async()=>{flushCount++;}}};
 const session={id:'idle-test',surface:{nodes:[1,2,3]},eventAt:seq=>({seq,type:seq===1?'system/message':seq===2?'user/message':'assistant/message'}),append:()=>{appendCount++;throw Error('unexpected native compaction transaction')}};
 const agent={session,runMaintenance:callback=>callback(new AbortController().signal)};
 const result=await engine.compactNow(agent,new AbortController().signal,undefined,100);
 assert.equal(result,null);
 assert.equal(appendCount,0);
 assert.equal(flushCount,0);
 await assert.rejects(engine.compactNow(agent,new AbortController().signal,undefined,-1),RangeError);
});

test('a huge model maximum output does not make a 1M context emergency start at 51.7%',()=>{
 const p=deferredPressureBudget({window:1000000,output:384000,thresholdRatio:0.5,headroomMode:'auto',headroomTokens:65536});
 assert.equal(p.safety,65536);
 assert.equal(p.threshold,500000);
 assert.equal(p.emergencyOutputReserve,50000);
 assert.equal(p.emergencyThreshold,884464);
 assert(p.emergencyThreshold>880000);
});

test('post-turn busy native maintenance is retried after idle instead of discarded',async()=>{
 const agent=makeAgent();
 const engine=Object.create(LosslessCompaction.prototype);
 engine.settings={configFile:{value:{enabled:true,automatic:true,compressionTiming:'after-turn'}},tasks:new Set()};
 engine.pendingTurnEnds=new Map([[agent.session.id,7]]);
 engine.idleTimer=null;engine.idleTask=null;engine.postTurnTimer=null;engine.postTurnTask=null;
 engine.postTurnAbort=null;engine.postTurnAgent=null;
 const events=[];engine.diagnostics=ev=>events.push(ev);
 let attempts=0;
 engine.runPostTurn=async()=>{attempts++;if(attempts===1)throw Object.assign(new Error('native maintenance busy'),{code:'busy'});};
 engine.queuePostTurn(agent);
 await sleep(1750);
 assert.equal(attempts,2);
 assert.equal(engine.pendingTurnEnds.has(agent.session.id),false);
 assert.equal(engine.postTurnBusyRetries.size,0);
 assert.equal(engine.settings.tasks.size,0);
 assert(events.includes('compression.deferred-busy-retry'));
});


test('idle prewarm schedules at most three batches until the next inbox cycle',()=>{
 const engine=Object.create(LosslessCompaction.prototype),agent=makeAgent();
 engine.settings={configFile:{value:{enabled:true,automatic:true,deferred:true}},tasks:new Set()};
 engine.pendingTurnEnds=new Map();engine.warmCampaigns=new Map();
 engine.idleTimer=null;engine.idleTask=null;engine.postTurnTimer=null;engine.postTurnTask=null;
 for(let i=0;i<3;i++){
  engine.scheduleIdleWarm(agent,5000);
  assert.equal(engine.warmCampaigns.get(agent.session.id),i+1);
  assert(engine.idleTimer);
  clearTimeout(engine.idleTimer);engine.idleTimer=null;
 }
 engine.scheduleIdleWarm(agent,5000);
 assert.equal(engine.idleTimer,null,'the fourth idle batch is not scheduled');
 engine.warmCampaigns.delete(agent.session.id); // new inbox permits another campaign
 engine.scheduleIdleWarm(agent,5000);
 assert.equal(engine.warmCampaigns.get(agent.session.id),1);
 clearTimeout(engine.idleTimer);
});
