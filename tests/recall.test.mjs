import test from 'node:test';
import assert from 'node:assert/strict';
import { recall } from '../recall.js';

const events={
 3:{type:'user/message',data:{content:[{type:'text',text:'第三个事件的内容'}]}},
 5:{type:'assistant/message',data:{message:{content:[{type:'text',text:'第五个事件的内容'}]}}},
 7:{type:'user/message',data:{content:[{type:'text',text:'第七个事件的内容'}]}},
};
const session={id:'s1',eventAt:seq=>events[seq]??null};
const index={
 sync(){},
 search:(_id,query)=>query==='命中'?[{seq:3},{seq:5}]:[],
 sources:(_id,nodeId)=>nodeId==='n1'?[7]:[],
 node:(_id,id)=>({id,kind:'leaf',depth:0,children:[],sourceSeqs:[7]}),
 list:()=>[],
};

test('expand accepts a single event seq',()=>{
 const result=recall(index,session,'expand',{seq:3});
 assert.deepEqual(result.items.map(item=>item.seq),[3]);
 assert(result.items[0].text.includes('第三个事件'));
});

test('expand accepts a summary node id and follows its source events',()=>{
 const result=recall(index,session,'expand',{id:'n1'});
 assert.deepEqual(result.items.map(item=>item.seq),[7]);
 assert(result.items[0].text.includes('第七个事件'));
});

test('expand accepts a search term, the behaviour merged from lcm_expand_query',()=>{
 const result=recall(index,session,'expand',{query:'命中'});
 assert.deepEqual(result.items.map(item=>item.seq),[3,5]);
 assert(result.items[0].text.includes('第三个事件'));
 assert(result.items[1].text.includes('第五个事件'));
});

test('grep still returns excerpts only and never expands the原文',()=>{
 const result=recall(index,session,'grep',{query:'命中'});
 assert.equal(result.items,undefined);
 assert.deepEqual(result.matches.map(match=>match.seq),[3,5]);
 assert(result.matches[0].excerpt.includes('第三个事件'));
});

test('expand without any source fails closed',()=>{
 assert.throws(()=>recall(index,session,'expand',{}),/lcm-source-required/);
});

test('an over-long search term is rejected in both grep and expand',()=>{
 const long='x'.repeat(1001);
 assert.throws(()=>recall(index,session,'grep',{query:long}),/lcm-query-invalid/);
 assert.throws(()=>recall(index,session,'expand',{query:long}),/lcm-query-invalid/);
});
