import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {installAutoRotation} from '../auto-rotation.js';

function setup(){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-rotation-backoff-'));
 const id='session-backoff';let runs=0;
 const events={},records=[];
 const conf={enabled:true,rotationMode:'auto',rotationFileMiB:20,rotationEventLimit:1};
 const dreamConfig={enabled:true,ownerIdentityId:'owner',autoPromote:true,agentPreset:'agent'};
 const session={id,header:{id,cwd:home,agentPreset:'agent'}};
 const agent={session,status:'idle',inbox:{hasPending(){return false}}};
 const core={configFile:{value:{sharedDM:true}},store:{db:{prepare(){return{get(){return 1}}}}},trustedMemorySession(){return true},controller:{async create(){}},async rotateTrustedDM(){}};
 const dream={configFile:{value:dreamConfig},memory:{async run(){runs++;throw Object.assign(new Error('temporary timeout'),{code:'ETIMEDOUT'})}}};
 const query={async observeSession(){return{events:[{seq:1}],[Symbol.dispose](){}}}};
 const services={channelCore:core,memoryDreaming:dream,sessionQuery:query,sessionProjections:{stateOf(){return 'agent'}},agents:{get(){return agent}},pluginDiagnostics:{record(...args){records.push(args)}}};
 const ctx={dshHomePath(){return home},get(k){return services[k]},on(k,fn){events[k]=fn},effect(){}};
 const next=async()=>{events['session/event'](session,{type:'turn/end',seq:1});await new Promise(resolve=>setTimeout(resolve,20))};
 return {home,conf,ctx,events,records,next,get runs(){return runs},close(){fs.rmSync(home,{force:true,recursive:true})}};
}
test('rotation transient failure persists 3-minute cooldown, blocks immediate retry, survives reinstall',async()=>{
 const h=setup();try{
  const service=installAutoRotation(h.ctx,{value:h.conf});
  await h.next();assert.equal(h.runs,1);
  const state=service.status('session-backoff').backoff;
  assert.equal(state.reason,'transient');assert.equal(state.count,1);
  assert.ok(state.nextAt>Date.now()+170000);
  await h.next();assert.equal(h.runs,1);
  const again=installAutoRotation(h.ctx,{value:h.conf});
  assert.equal(again.status('session-backoff').backoff.count,1);
  await h.next();assert.equal(h.runs,1);
  service.close();again.close();
 }finally{h.close()}
});
test('cooldown expires, then next normal idle turn retries with 10-minute backoff',async()=>{
 const h=setup();try{
  const service=installAutoRotation(h.ctx,{value:h.conf});await h.next();
  const filename=path.join(h.home,'lossless-context','rotation-backoff.json');
  const states=JSON.parse(fs.readFileSync(filename,'utf8'));states['session-backoff'].nextAt=Date.now()-1;fs.writeFileSync(filename,JSON.stringify(states));
  service.close();const again=installAutoRotation(h.ctx,{value:h.conf});await h.next();
  assert.equal(h.runs,2);
  const state=again.status('session-backoff').backoff;
  assert.equal(state.count,2);assert.ok(state.nextAt>Date.now()+580000);
  again.close();
 }finally{h.close()}
});
