import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { mapBounded } from '../parallel-map.js';

test('three calls at once return results in original source order',async()=>{
 let active=0,peak=0;
 const values=await mapBounded([0,1,2,3,4,5,6],3,async n=>{
  active++;peak=Math.max(peak,active);await sleep((6-n)*3);active--;return 'result-'+n;
 });
 assert.equal(peak,3);
 assert.deepEqual(values,Array.from({length:7},(_,i)=>'result-'+i));
});
test('failure aborts peers, blocks pending calls and settles them',async()=>{
 let started=0,active=0;
 const failure=Object.assign(new Error('provider refused'),{code:'RATE_LIMIT'});
 await assert.rejects(mapBounded(Array.from({length:12},(_,i)=>i),3,async(n,_i,signal)=>{
  started++;active++;
  try{if(n===0){await sleep(15);throw failure;}await sleep(500,undefined,{signal});}
  finally{active--;}
 }),error=>error===failure);
 assert.equal(started,3);assert.equal(active,0);
});
test('upstream cancellation prevents admission without partial success',async()=>{
 const abort=new AbortController();let started=0;
 const pending=mapBounded([1,2,3,4,5],2,async(_n,_i,signal)=>{
  started++;await sleep(500,undefined,{signal});
 },abort.signal);
 await sleep(10);abort.abort(new DOMException('cancelled','AbortError'));
 await assert.rejects(pending,{name:'AbortError'});assert.equal(started,2);
});
test('reject invalid capacity and allow empty batches',async()=>{
 assert.deepEqual(await mapBounded([],3,async()=>{throw Error('unexpected');}),[]);
 await assert.rejects(mapBounded([1],0,async()=>1),RangeError);
});
