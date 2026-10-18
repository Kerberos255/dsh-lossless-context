import test from 'node:test';
import assert from 'node:assert/strict';
import {installRecall} from '../recall.js';
const session={id:'session-owner',eventAt:seq=>seq===1?{type:'user/message',data:{content:[{type:'text',text:'历史原文包含中文词语'}]}}:undefined};
const index={sync(){},search:(_id,query)=>query==='中文'? [{seq:1}]:[],sources:()=>[1],node:(_id,id)=>({id,kind:'leaf',sourceSeqs:[1],children:[]}),list:()=>[{id:'n1'}]};
test('one LCM recall tool supports search/describe/expand and Session scope',async()=>{
 const registered=[];
 installRecall({inject(_deps,callback){callback({tools:{register(t){registered.push(t)}}})}},()=>index,()=>({enabled:true,recall:true,maxRecallChars:1000}));
 assert.deepEqual(registered.map(t=>t.name),['lcm_recall']);
 const tool=registered[0],exec={signal:new AbortController().signal,agent:{session}};
 const search=await tool.execute({query:'中文'},exec);
 assert.equal(search.matches.length,1);
 assert.equal((await tool.execute({action:'search',query:'中文'},exec)).matches[0].seq,1);
 const tree=await tool.execute({action:'describe'},exec);assert.deepEqual(tree.nodes,[{id:'n1'}]);
 const raw=await tool.execute({action:'expand',seq:1},exec);assert.match(raw.items[0].text,/中文词语/);
 for(const bad of [{action:'search'},{action:'describe',query:'x'},{action:'expand'},
  {action:'expand',seq:1,id:'n1'}, {action:'search',query:'中文',offset:1}]){
  await assert.rejects(tool.execute(bad,exec));
 }
 const cancelled=new AbortController();cancelled.abort();
 await assert.rejects(tool.execute({action:'search',query:'中文'},{...exec,signal:cancelled.signal}),{name:'AbortError'});
});
