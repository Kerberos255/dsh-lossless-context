import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import LosslessCompaction from '../agent.js';
import { schema, nativeConfig } from '../config.js';

function fixture(){
 const value={...schema.defaults,summaryConcurrency:3,condenseFanout:3};
 const agent={session:{id:'parallel-fixture',requestHeader:()=>({config:{provider:'test',model:'small'}})},options:{}};
 const input={tools:[],messages:[{role:'system',content:[{type:'text',text:'system instruction'}]}]};
 const groups=Array.from({length:8},(_,i)=>({start:i,end:i+1,tokens:10,messages:[{role:'user',content:[{type:'text',text:'piece-'+i}]}]}));
 const plan={system:input.messages[0],groups};
 let saved=null,active=0,peak=0;
 const index={sync:()=>{},active:()=> 'native-compaction-id',auxiliary:()=>{},plan:(_id,_compaction,dag)=>{saved=dag;}};
 const engine=Object.create(LosslessCompaction.prototype);
 engine.settings={index,configFile:{value}};
 engine.config=nativeConfig(value);
 engine.ctx={tokenMeter:{estimateMessage:message=>JSON.stringify(message).length}};
 engine.warmStats={leafRequests:0,leafHits:0,hits:0};
 engine.warmed=new Map();
 engine.diagnostics=()=>{};
 engine.prepare=async()=>({plan,available:10000,input});
 engine.cached=()=>null;
 engine.remember=()=>{};
 engine.completeSummary=async(payload,_agent,signal,_value,_onTruncated,kind)=>{
  active++;peak=Math.max(peak,active);
  try{
   await sleep(15,undefined,{signal});
   const body=payload.messages.at(-1).content[0].text;
   return {summary:[{type:'text',text:kind==='leaf'?body:'merged '+body}],provider:'test',model:'small',maxTokens:512};
  }finally{active--;}
 };
 return {engine,index,agent,input,plan,get saved(){return saved;},get active(){return active;},get peak(){return peak;}};
}

test('full DAG summarization is concurrent but parents and source order are deterministic',async()=>{
 const f=fixture();
 const result=await f.engine.summarizeLossless(f.input,f.agent,new AbortController().signal,f.engine.settings,f.engine.settings.configFile.value);
 assert.equal(f.peak,3);
 assert.equal(f.active,0);
 assert.deepEqual(f.saved.leaves.map(leaf=>leaf.summary),Array.from({length:8},(_,i)=>'piece-'+i));
 assert.deepEqual(f.saved.rootChildren,['branch:0','branch:1','branch:2']);
 assert.equal(f.saved.branches.length,3);
 assert.match(result.summary[0].text,/kind="condensed"/);
});

test('failed leaf leaves native DAG uncommitted and aborts other in-flight leaves',async()=>{
 const f=fixture();let calls=0;
 f.engine.completeSummary=async(payload,_agent,signal)=>{
  calls++;
  const body=payload.messages.at(-1).content[0].text;
  if(body==='piece-0'){await sleep(20);throw Object.assign(new Error('model failure'),{code:'TRANSPORT'});}
  await sleep(500,undefined,{signal});
  return {summary:[{type:'text',text:body}],provider:'test',model:'small',maxTokens:512};
 };
 await assert.rejects(f.engine.summarizeLossless(f.input,f.agent,new AbortController().signal,f.engine.settings,f.engine.settings.configFile.value),{code:'TRANSPORT'});
 assert.equal(calls,3);
 assert.equal(f.saved,null,'partial summaries must not publish an incomplete native root');
});
