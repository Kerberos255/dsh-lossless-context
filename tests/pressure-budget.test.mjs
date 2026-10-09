import test from 'node:test';
import assert from 'node:assert/strict';
import {adaptiveHeadroom,pressureBudget,warmBudget,scopedNativeConfig} from '../pressure.js';
import {leafPlan} from '../planner.js';

test('small and large windows get independent automatic headroom',()=>{
 assert.equal(adaptiveHeadroom(65536),6553);
 assert.equal(adaptiveHeadroom(131072),13107);
 assert.equal(adaptiveHeadroom(1048576),65536);
 const policy={headroomTokens:65536,modelPolicies:[]};
 const a=scopedNativeConfig(policy,{window:65536,cap:65536,provider:'p',model:'a'});
 const b=scopedNativeConfig(policy,{window:1048576,cap:65536,provider:'p',model:'b'});
 assert.equal(a.headroomTokens,6553);
 assert.equal(b.headroomTokens,65536);
 assert.equal(policy.headroomTokens,65536);
});
test('per-model override and fixed mode still win',()=>{
 const override={provider:'p',model:'m',headroomTokens:5000};
 const native={headroomTokens:65536,modelPolicies:[override]};
 assert.equal(scopedNativeConfig(native,{window:65536,provider:'p',model:'m'}),native);
 assert.equal(pressureBudget({window:65536,output:8192,headroomMode:'auto',override}).safety,5000);
 assert.equal(pressureBudget({window:65536,output:8192,headroomMode:'fixed'}).safety,65536);
});
test('prewarming is safely earlier than native pressure on all sizes',()=>{
 for(const window of [65536,131072,1048576]){
  const budget=warmBudget({window,output:16384,thresholdRatio:.8,headroomTokens:65536,headroomMode:'auto',deferredRatio:.75,leafChunkTokens:8000});
  assert(budget.trigger>0&&budget.trigger<budget.threshold);
  assert(budget.threshold<=window*.8);
 }
});
test('leaf planner preserves each event and complete tool pairs without input overflow',()=>{
 const messages=[];
 for(let i=0;i<100;i++){
  messages.push({id:'a'+i,role:'assistant',content:[{type:'tool-call',id:'t'+i}]});
  messages.push({id:'t'+i,role:'tool',toolCallId:'t'+i,content:[{type:'text',text:'result '+('x'.repeat(80))}]});
 }
 const meter={estimateMessage:message=>Math.ceil(JSON.stringify(message).length/4)};
 const counts=[];
 for(const budget of [8000,12000,16000]){
  const {groups}=leafPlan({messages},meter,budget);
  assert.deepEqual(groups.flatMap(group=>group.messages.map(message=>message.id)),messages.map(message=>message.id));
  for(const group of groups){
   assert(group.tokens<=budget);
   const pending=new Set();
   for(const m of group.messages){
    for(const block of m.content??[])if(block.type==='tool-call')pending.add(block.id);
    if(m.role==='tool')pending.delete(m.toolCallId);
   }
   assert.equal(pending.size,0);
  }
  counts.push(groups.length);
 }
 assert(counts[0]>=counts[1]&&counts[1]>=counts[2]);
});
