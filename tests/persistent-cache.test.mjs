import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {LosslessIndex} from '../index-store.js';
import {leafPlan} from '../planner.js';
import LosslessCompaction from '../agent.js';
import {schema,nativeConfig} from '../config.js';

const sample=(text='complete summary')=>({provider:'opencode-go',model:'deepseek-v4.1-flash',maxTokens:16384,summary:[{type:'text',text}]});
function withIndex(fn){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lcm-stage-test-'));
 const file=path.join(dir,'index.sqlite');
 const finish=()=>fs.rmSync(dir,{recursive:true,force:true});
 try{const result=fn(file);if(result&&typeof result.then==='function')return result.finally(finish);finish();return result;}
 catch(error){finish();throw error;}
}

test('24k is the source input chunk default; old 8k setting remains valid on load',()=>{
 assert.equal(schema.defaults.leafChunkTokens,24000);
 assert.equal(schema.validate({...schema.defaults,leafChunkTokens:8000}).leafChunkTokens,8000);
 const msgs=Array.from({length:15},(_,id)=>({id,role:'user',content:[{type:'text',text:'statement '+id}]}));
 const meter={estimateMessage:()=>1000};
 assert.equal(leafPlan({messages:msgs},meter,schema.defaults.leafChunkTokens).groups.length,1);
 assert.equal(leafPlan({messages:msgs},meter,8000).groups.length,2);
});

test('complete leaf survives index close, process-style restart and reconnect',()=>withIndex(file=>{
 let db=new LosslessIndex(file);
 assert.equal(db.cachePut('session-A','sha256-key-1',sample(),'compression-1'),true);
 assert.equal(db.stats().cachedSummaries,1);
 db.close();
 db=new LosslessIndex(file);
 assert.deepEqual(db.cacheGet('session-A','sha256-key-1')?.result,sample());
 assert.equal(db.cacheGet('session-B','sha256-key-1'),null);
 assert.equal(db.cacheGet('session-A','missing'),null);
 db.close();
}));

test('reject partial, empty or oversized summary results without persistence',()=>withIndex(file=>{
 const db=new LosslessIndex(file);
 assert.equal(db.cachePut('a','invalid',{...sample(),summary:[]},'run'),false);
 assert.equal(db.cachePut('a','invalid',{...sample(),summary:[{type:'text',text:'   '}]},'run'),false);
 assert.equal(db.cachePut('a','invalid',{...sample(),summary:[{type:'text',text:'b'.repeat(133000)}]},'run'),false);
 assert.equal(db.cacheGet('a','invalid'),null);
 assert.equal(db.stats().cachedSummaries,0);
 db.close();
}));

test('tampered and expired persisted data fail closed',()=>withIndex(file=>{
 const db=new LosslessIndex(file);
 db.cachePut('s','tampered',sample(),'run');
 db.db.prepare('UPDATE lcm_summary_cache SET payload=? WHERE cache_key=?').run('{"oops":1}','tampered');
 assert.equal(db.cacheGet('s','tampered'),null);
 db.cachePut('s','expired',sample(),'run');
 db.db.prepare('UPDATE lcm_summary_cache SET cached_at=? WHERE cache_key=?').run(Date.now()-8*86400000,'expired');
 assert.equal(db.cacheGet('s','expired'),null);
 db.close();
}));

test('cache is bounded to 128 fragments per session, and reset removes only that session',()=>withIndex(file=>{
 const db=new LosslessIndex(file);
 for(let i=0;i<130;i++)assert(db.cachePut('s','k'+i,sample('a'+i),'p'+i));
 assert.equal(db.db.prepare('SELECT count(*) AS n FROM lcm_summary_cache WHERE session_id=?').get('s').n,128);
 assert.equal(db.cacheGet('s','k0'),null);
 assert(db.cachePut('other','other-key',sample(),'other-run'));
 db.reset('s');
 assert.equal(db.cacheGet('s','k129'),null);
 assert(db.cacheGet('other','other-key'));
 db.close();
}));

test('cache fingerprint isolates summary kind, prompt configuration and source text',()=>withIndex(file=>{
 const config={...schema.defaults};
 const engine=Object.create(LosslessCompaction.prototype);
 engine.config=nativeConfig(config);
 engine.settings={index:new LosslessIndex(file),configFile:{value:config}};
 engine.warmed=new Map();
 engine.diagnostics=()=>{};
 const agent={session:{id:'s',requestHeader:()=>({config:{provider:'opencode-go',model:'deepseek-v4.1-flash'}})},options:{}};
 const input={messages:[{role:'user',content:[{type:'text',text:'first input'}]}]};
 const key=engine.cacheKey(input,agent,'leaf');
 const branch=engine.cacheKey(input,agent,'condensed');
 assert.notEqual(key,branch);
 engine.remember(key,sample(),'run1','s');
 engine.settings.index.close();
 engine.settings.index=new LosslessIndex(file);
 engine.warmed=new Map();
 assert.deepEqual(engine.cached(key,'s')?.result,sample());
 assert.equal(engine.cached(branch,'s'),null);
 assert.notEqual(engine.cacheKey({...input,messages:[{role:'user',content:[{type:'text',text:'different input'}]}]},agent,'leaf'),key);
 engine.settings.configFile.value={...config,leafTargetTokens:2500};
 assert.notEqual(engine.cacheKey(input,agent,'leaf'),key);
 engine.settings.index.close();
}));

test('failed multi-leaf compaction resumes complete leaves after restart without committing partial root',()=>withIndex(file=>{
 const messages=['first leaf source','second leaf source'].map(text=>({role:'user',content:[{type:'text',text}]}));
 const input={messages,tools:[]};
 const session={id:'session-1',seq:0,requestHeader:()=>({config:{provider:'opencode-go',model:'deepseek-v4.1-flash'}})};
 const agent={session,options:{}};
 const signal=new AbortController().signal;
 let calls=[];
 const makeEngine=()=>{
  const index=new LosslessIndex(file);
  index.sync=()=>{};index.active=()=> 'mock-open-transaction';index.auxiliary=()=>{};index.plan=()=>{};
  const engine=Object.create(LosslessCompaction.prototype);
  const value={...schema.defaults,leafChunkTokens:24000};
  engine.config=nativeConfig(value);
  engine.settings={index,configFile:{value}};
  engine.warmed=new Map();engine.warmStats={leafRequests:0,leafHits:0,hits:0};
  engine.ctx={tokenMeter:{estimateMessage:()=>40}};
  engine.diagnostics=()=>{};
  engine.prepare=async()=>({available:200000,plan:{system:null,groups:[
    {messages:[messages[0]],tokens:30,start:0,end:1},
    {messages:[messages[1]],tokens:30,start:1,end:2}
  ]}});
  engine.completeSummary=async payload=>{
    const content=JSON.stringify(payload.messages);
    const tag=content.includes('first leaf source')?'first':content.includes('second leaf source')?'second':'condensed';
    calls.push(tag);
    if(tag==='second'&&calls.filter(x=>x==='second').length===1)throw Object.assign(new Error('stream lost'),{code:'TRANSPORT'});
    return sample('complete '+tag+' summary');
  };
  return engine;
 };
 let engine=makeEngine();
 return assert.rejects(engine.summarizeLossless(input,agent,signal,engine.settings.index?engine.settings:null,engine.settings.configFile.value),{code:'TRANSPORT'})
 .then(()=>{
  assert.deepEqual(calls,['first','second']);
  assert.equal(engine.settings.index.stats().cachedSummaries,1);
  engine.settings.index.close();
  engine=makeEngine();
  return engine.summarizeLossless(input,agent,signal,engine.settings,engine.settings.configFile.value);
 }).then(result=>{
  assert.deepEqual(calls,['first','second','second','condensed']);
  assert.equal(engine.warmStats.leafHits,1);
  assert.equal(result.summary[0].type,'text');
  engine.settings.index.close();
 });
}));
