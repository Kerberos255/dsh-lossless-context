import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rotationDecision,inspectRotation } from '../rotation-guard.js';

const base={rotationMode:'notify',rotationFileMiB:20,rotationEventLimit:10000};

test('warns at either threshold, not before',()=>{
 assert.equal(rotationDecision({bytes:19*1024**2,events:9999},base).exceeded,false);
 assert.equal(rotationDecision({bytes:20*1024**2,events:1000},base).fileExceeded,true);
 assert.equal(rotationDecision({bytes:100,events:10000},base).eventExceeded,true);
 assert.equal(rotationDecision({bytes:100,events:null},base).hasEventCount,false);
});

test('reports native files read-only, not session mutation or automatic reset',()=>{
 const home=mkdtempSync(path.join(os.tmpdir(),'lcm-rotation-'));
 try{
  const folder=path.join(home,'sessions','--test--','session-abc');
  mkdirSync(folder,{recursive:true});
  const original=Buffer.alloc(256,3);
  writeFileSync(path.join(folder,'session.v4.jsonl.zstd'),original);
  const index={db:{prepare(sql){
    assert.equal(sql,'SELECT session_id,next_seq FROM lcm_cursor');
    return {all:()=>[{session_id:'session-abc',next_seq:10003}]};
  }}};
  const result=inspectRotation(home,index,base);
  assert.equal(result.rotationSessionCount,1);
  assert.equal(result.rotationExceededCount,1);
  assert.match(result.rotationStatus,/记忆整理/);
  assert.match(result.rotationHandoff,/不自动重置/);
  const off=inspectRotation(home,index,{...base,rotationMode:'off'});
  assert.equal(off.rotationExceededCount,0);
  assert.equal(original.length,256);
 }finally{rmSync(home,{recursive:true,force:true});}
});

test('live seq overrides stale indexed cursor',()=>{
 const home=mkdtempSync(path.join(os.tmpdir(),'lcm-rotation-'));
 try{
  const folder=path.join(home,'sessions','ws','session-b');
  mkdirSync(folder,{recursive:true});writeFileSync(path.join(folder,'session.v4.jsonl.zstd'),'raw');
  const index={db:{prepare(){return {all:()=>[{session_id:'session-b',next_seq:10}]}}}};
  const result=inspectRotation(home,index,base,new Map([['session-b',10500]]));
  assert.equal(result.rotationExceededCount,1);
 }finally{rmSync(home,{recursive:true,force:true});}
});

test('missing session directory is supported',()=>{
 const home=mkdtempSync(path.join(os.tmpdir(),'lcm-rotation-'));
 try{const result=inspectRotation(home,null,base);assert.equal(result.rotationSessionCount,0);}
 finally{rmSync(home,{recursive:true,force:true});}
});
