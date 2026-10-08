import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {rotationInput,rotateWithVerifiedMemory} from '../auto-rotation.js';

const sha=s=>createHash('sha256').update(s).digest('hex');
function harness(overrides={}){
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'lcm-automatic-'));
 const session={id:'session-aaaaaaaaaaaa',header:{id:'session-aaaaaaaaaaaa',cwd,agentPreset:'agent'}};
 let seq=100,created=0,switched=0,calls=0;
 const memorySettings={enabled:true,autoPromote:true,ownerIdentityId:'owner',agentPreset:'agent',workspace:''};
 const core={closed:false, trustedMemorySession:()=>true,
  controller:{async create(req){created++;assert.equal(req.cwd,cwd);assert.equal(req.agentPreset,'agent');}},
  async rotateTrustedDM(req){switched++;assert.equal(req.expectedSeq,100);assert.equal(req.memoryRunId,'memory-run-1234');assert.match(req.artifactHash,/^[a-f0-9]{64}$/);return{rotated:true,bindings:2,...req};}};
 const dream={configFile:{value:memorySettings},memory:{
  async run(workspace,kind,{sourceSessionId,draftOnly}){
   calls++;assert.equal(workspace,cwd);assert.equal(kind,'dream');assert.equal(sourceSessionId,session.id);assert.equal(draftOnly,false);
   if(overrides.changedDuringRun)seq++;
   if(overrides.badArtifact)return{state:'completed',staged:0,promoted:0,artifacts:[]};
   const content='verified dream checkpoint\n';fs.writeFileSync(path.join(cwd,'DREAMS.md'),content);
   return{id:'memory-run-1234',state:'completed',staged:0,promoted:0,rejected:0,artifacts:[{path:'DREAMS.md',hash:sha(content)}]};
  }
 }};
 const query={
  async observeSession(sessionId){return{header:{id:sessionId,cwd,agentPreset:'agent'},projections:{values:{agentPreset:'agent'}},events:[{seq}], [Symbol.dispose](){} };},
  async listSessions(){return[];}
 };
 const services={channelCore:core,memoryDreaming:dream,sessionQuery:query,sessionProjections:{stateOf(){return'agent';}},agents:{get(){return{status:'idle',inbox:{hasPending(){return false;}}};}}};
 const ctx={get(name){return services[name];}};
 return{cwd,session,ctx,core,dream,get created(){return created;},get switched(){return switched;},get calls(){return calls;},
  close(){fs.rmSync(cwd,{force:true,recursive:true})}};
}
test('threshold requires an actual event or compressed file threshold',()=>{
 const h=harness();
 try{
  const f=path.join(h.cwd,'sessions','x','session-aaaaaaaaaaaa');
  fs.mkdirSync(f,{recursive:true});
  fs.writeFileSync(path.join(f,'session.v4.jsonl.zstd'),Buffer.alloc(1024));
  const config={rotationFileMiB:20,rotationEventLimit:100};
  assert.equal(rotationInput(h.cwd,h.session.id,97,config).exceeded,false);
  assert.equal(rotationInput(h.cwd,h.session.id,99,config).exceeded,true);
 }finally{h.close();}
});
test('verified Dream is committed before creating target and rebinding all aliases',async()=>{
 const h=harness();
 try{
  const result=await rotateWithVerifiedMemory({ctx:h.ctx,session:h.session,expectedSeq:100,signal:new AbortController().signal});
  assert.equal(result.rotated,true);
  assert.equal(h.calls,1);assert.equal(h.created,1);assert.equal(h.switched,1);
  assert.match(result.next,/^session-[a-f0-9]{32}$/);
 }finally{h.close();}
});
test('missing owner identity fails closed without invoking Dream or creating a session',async()=>{
 const h=harness();
 try{
  h.dream.configFile.value.ownerIdentityId='';
  await assert.rejects(rotateWithVerifiedMemory({ctx:h.ctx,session:h.session,expectedSeq:100}),/主人身份/);
  assert.equal(h.calls,0);assert.equal(h.created,0);assert.equal(h.switched,0);
 }finally{h.close();}
});
test('untrusted channel sessions are never rotated',async()=>{
 const h=harness();
 try{
  h.core.trustedMemorySession=()=>false;
  await assert.rejects(rotateWithVerifiedMemory({ctx:h.ctx,session:h.session,expectedSeq:100}),/主人身份/);
  assert.equal(h.calls,0);assert.equal(h.created,0);
 }finally{h.close();}
});
test('incomplete Dream artifacts never cause target creation or switch',async()=>{
 const h=harness({badArtifact:true});
 try{
  await assert.rejects(rotateWithVerifiedMemory({ctx:h.ctx,session:h.session,expectedSeq:100}),/交接文件/);
  assert.equal(h.calls,1);assert.equal(h.created,0);assert.equal(h.switched,0);
 }finally{h.close();}
});
test('new events during Dream stop any switch',async()=>{
 const h=harness({changedDuringRun:true});
 try{
  await assert.rejects(rotateWithVerifiedMemory({ctx:h.ctx,session:h.session,expectedSeq:100}),/发生了变化/);
  assert.equal(h.calls,1);assert.equal(h.created,0);assert.equal(h.switched,0);
 }finally{h.close();}
});
