import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { schema,nativeConfig } from '../config.js';
import { adaptiveHeadroom,pressureBudget,warmBudget,scopedNativeConfig } from '../pressure.js';
import { leafPlan } from '../planner.js';
import LosslessCompaction from '../agent.js';
import { readShared, skipWithoutShared } from './shared-settings.mjs';
const config=schema.defaults;
const sizes=[65536,131072,1048576];
test('backward compatible configs enable auto headroom without clobbering saved 16k output',()=>{
 const previous={...config,summaryMaxTokens:16384,summaryRetryMaxTokens:32768};
 delete previous.headroomMode;
 const parsed=schema.validate(previous);
 assert.equal(parsed.headroomMode,'auto');assert.equal(parsed.summaryMaxTokens,16384);
 assert.equal(schema.defaults.summaryMaxTokens,16384);
 assert.equal(schema.defaults.deferredRatio,0.75);
 assert.throws(()=>schema.validate({...parsed,headroomMode:'arbitrary'}));
});
test('auto headroom scales with context window while preserving the cap',()=>{
 assert.equal(adaptiveHeadroom(65536),6553);
 assert.equal(adaptiveHeadroom(131072),13107);
 assert.equal(adaptiveHeadroom(1048576),65536);
 for(const window of sizes){
  const budget=pressureBudget({window,output:16384,thresholdRatio:.8,headroomTokens:65536,headroomMode:'auto'});
  assert(budget.threshold>0);
  assert(budget.threshold<=Math.floor(window*.8));
  assert(budget.threshold<=window-16384-budget.safety);
 }
});
test('explicit model headroom remains authoritative, fixed mode preserves legacy behavior',()=>{
 const base=nativeConfig(config);
 const override={provider:'provider',model:'small',headroomTokens:5000};
 const native={...base,modelPolicies:[override]};
 const scoped=scopedNativeConfig(native,{window:65536,cap:65536,headroomMode:'auto',provider:'provider',model:'small'});
 assert.equal(scoped,native);
 const manual=pressureBudget({window:65536,output:4096,thresholdRatio:.8,headroomTokens:65536,headroomMode:'auto',override});
 assert.equal(manual.safety,5000);
 const fixed=pressureBudget({window:131072,output:16384,thresholdRatio:.8,headroomTokens:65536,headroomMode:'fixed'});
 assert.equal(fixed.threshold,49152);
});
test('native model budgets are invocation scoped, never mutate a live engine shared by models',()=>{
 const original=Object.freeze({...nativeConfig(config),modelPolicies:[]});
 const small=scopedNativeConfig(original,{window:65536,cap:65536,headroomMode:'auto',provider:'a',model:'small'});
 const large=scopedNativeConfig(original,{window:1048576,cap:65536,headroomMode:'auto',provider:'b',model:'large'});
 assert.equal(small.headroomTokens,6553);
 assert.equal(large.headroomTokens,65536);
 assert.equal(original.headroomTokens,65536);
 assert.notEqual(small,large);
 const fixed=scopedNativeConfig(original,{window:65536,cap:65536,headroomMode:'fixed',provider:'a',model:'small'});
 assert.equal(fixed,original);
});
test('prewarm trigger is always earlier than the native effective pressure threshold',()=>{
 for(const window of sizes){
  const warm=warmBudget({window,output:16384,thresholdRatio:.8,headroomTokens:65536,headroomMode:'auto',deferredRatio:.75,leafChunkTokens:8000});
  assert(warm.trigger>0);
  assert(warm.trigger<warm.threshold,JSON.stringify(warm));
  assert(warm.threshold-warm.trigger>=Math.min(8000,Math.floor(warm.threshold*.2)));
  assert(warm.trigger<=Math.floor(window*.75));
 }
 // A narrow context where the old 65536-token idle guard would always skip.
 assert(warmBudget({window:65536,output:16384,thresholdRatio:.8,headroomTokens:65536,headroomMode:'auto',deferredRatio:.75,leafChunkTokens:8000}).trigger<65536);
});
test('cache identity excludes pressure-only headroom; changing actual summary policy still invalidates it',()=>{
 const engine={config:{...nativeConfig(config),headroomTokens:65536}};
 const agent={session:{id:'synthetic-session',requestHeader:()=>({config:{provider:'p',model:'m'}})},options:{}};
 const input={messages:[{role:'user',content:[{type:'text',text:'synthetic'}]}]};
 const key1=LosslessCompaction.prototype.cacheKey.call(engine,input,agent);
 engine.config={...engine.config,headroomTokens:6553};
 const key2=LosslessCompaction.prototype.cacheKey.call(engine,input,agent);
 assert.equal(key1,key2);
 engine.config={...engine.config,maxTokens:32768};
 assert.notEqual(LosslessCompaction.prototype.cacheKey.call(engine,input,agent),key2);
});
function sample(){
 // Same deterministic workload at every budget; each tool request and result is paired.
 const messages=[];let seq=0;
 for(let i=0;i<120;i++){
  messages.push({id:seq++,role:'user',content:[{type:'text',text:'PROJECT-'+(i%5)+' decision '+i+' '+('reason '.repeat(160))}]});
  messages.push({id:seq++,role:'assistant',content:[{type:'tool-call',id:'call-'+i,name:'inspect',arguments:{}}]});
  messages.push({id:seq++,role:'tool',toolCallId:'call-'+i,content:[{type:'text',text:'result '+i+' '+('source '.repeat(100))}]});
  messages.push({id:seq++,role:'assistant',content:[{type:'text',text:'Verified milestone '+i+'; remaining step '+i+' '+('detail '.repeat(65))}]});
 }
 return messages;
}
test('8K/12K/16K/24K offline replay compares call counts and preserves exact event coverage and tool pairs',()=>{
 const source=sample(),meter={estimateMessage:m=>Math.ceil(JSON.stringify(m).length/4)},results=[];
 for(const budget of [8000,12000,16000,24000]){
  const began=performance.now();
  const {groups}=leafPlan({messages:source},meter,budget);
  const visited=groups.flatMap(g=>g.messages.map(m=>m.id));
  assert.deepEqual(visited,source.map(m=>m.id));
  for(const group of groups){
   const active=new Set();
   for(const m of group.messages){
    for(const b of m.content??[])if(b.type==='tool-call')active.add(b.id);
    if(m.role==='tool')active.delete(m.toolCallId);
   }
   assert.equal(active.size,0);
  }
  results.push({budget,leafCalls:groups.length,planningMs:Number((performance.now()-began).toFixed(3)),sourceEvents:source.length});
 }
 assert(results[0].leafCalls>=results[1].leafCalls);
 assert(results[1].leafCalls>=results[2].leafCalls);
 assert(results[2].leafCalls>=results[3].leafCalls);
 console.log('LCM_OFFLINE_AB='+JSON.stringify(results));
});
test('narrow summary models can still plan a bounded leaf with 16k default output cap',async()=>{
 const engine=Object.create(LosslessCompaction.prototype);
 engine.config=nativeConfig(config);
 engine.ctx={llm:{resolveModelInfo:async()=>({context:{contextWindow:16384,maxOutputTokens:8192}})},tokenMeter:{estimateMessage:message=>Math.ceil(JSON.stringify(message).length/4)}};
 const agent={options:{provider:'test',model:'small'},session:{requestHeader:()=>({config:{provider:'test',model:'small'}})}};
 const body={messages:[{role:'system',content:[{type:'text',text:'System instruction'}]},
  ...Array.from({length:35},(_,i)=>({role:'user',content:[{type:'text',text:'Work note '+i+' '+('token '.repeat(130))}]}))],tools:[]};
 const {plan,available}=await engine.prepare(body,agent,new AbortController().signal,config);
 assert(available>512);
 assert(plan.groups.length>1);
 assert(plan.groups.every(g=>g.tokens<=available));
});
test('client and example expose actual native defaults and status details',{skip:skipWithoutShared},()=>{
 const page=JSON.parse(readShared('pages.json'))['dsh-lossless-context'];
 const keys=new Set(page.fields.map(f=>f.key));
 for(const key of ['headroomMode','headroomTokens','warmStatus','warmBudgetStatus','warmFailure'])assert(keys.has(key),key);
 const example=JSON.parse(fs.readFileSync(new URL('../config.example.json',import.meta.url),'utf8'));
 assert.equal(example.headroomMode,'auto');
 assert.equal(example.summaryMaxTokens,16384);
 assert.equal(example.summaryRetryMaxTokens,32768);
 assert.equal(example.deferredRatio,.75);
 const client=fs.readFileSync(new URL('../client.js',import.meta.url),'utf8');
 assert(client.includes('warmBudgetStatus'));
 assert(client.includes('headroomMode'));
});
