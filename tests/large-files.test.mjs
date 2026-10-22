import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileIdFor, externalizeLargeBlocks, fileReference, makeFilePreview } from '../planner.js';
import { LosslessIndex } from '../index-store.js';
import { recall } from '../recall.js';

const big = 'A'.repeat(100);
const small = 'ok';

test('oversized text blocks become a reference, and ids are content-addressed', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: small }, { type: 'text', text: big }] },
    { role: 'assistant', content: [{ type: 'text', text: small }] },
  ];
  const one = externalizeLargeBlocks(messages, { thresholdChars: 50 });
  assert.equal(one.files.length, 1);
  assert.equal(one.files[0].chars, 100);
  assert.equal(one.files[0].id, fileIdFor(big));
  assert.equal(one.messages[0].content[0].text, small, 'small blocks are untouched');
  assert.equal(one.messages[0].content[1].text, fileReference({ id: one.files[0].id, chars: 100, preview: makeFilePreview(big) }));
  assert.equal(one.messages[1].content[0].text, small);

  const two = externalizeLargeBlocks(messages, { thresholdChars: 50 });
  assert.equal(two.files[0].id, one.files[0].id, 'the same content always maps to the same id');
});

test('a disabled threshold leaves the payload untouched', () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: big }] }];
  const result = externalizeLargeBlocks(messages, { thresholdChars: 0 });
  assert.equal(result.files.length, 0);
  assert.equal(result.messages, messages, 'returns the original array, not a copy');
});

test('externalised files are stored, described and expanded through the existing tool', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcm-files-'));
  const index = new LosslessIndex(path.join(dir, 'index.sqlite'));
  try {
    const session = { id: 'session-1' };
    index.sync = () => {};   // 本用例只验证文件通路，不构造完整 transcript
    const id = fileIdFor(big);
    const target = path.join(index.fileDir(session.id), id + '.txt');
    fs.writeFileSync(target, big, 'utf8');
    index.putFile({ sessionId: session.id, id, chars: big.length, filePath: target, excerpt: big.slice(0, 64) });

    const listed = index.files(session.id);
    assert.deepEqual(listed.map(item => item.id), [id]);
    const searched = index.searchFiles(session.id, 'AAAA');
    assert.equal(searched.length, 1, 'the excerpt is searchable');

    const described = recall(index, session, 'describe', { id, limit: 5 });
    assert.equal(described.file.chars, 100);
    assert.match(described.file.excerpt, /^A+/);

    const expanded = recall(index, session, 'expand', { id, limit: 5 }, { maxRecallChars: 40 });
    assert.equal(expanded.items[0].text.length, 40);
    assert.equal(expanded.truncated, true);
    assert.equal(expanded.nextOffset, 40);

    const whole = recall(index, session, 'expand', { id, limit: 5, offset: 90 }, { maxRecallChars: 40 });
    assert.equal(whole.items[0].text.length, 10);
    assert.equal(whole.truncated, false);
    assert.equal(whole.nextOffset, null);
  } finally {
    index.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('externalized input preserves a bounded deterministic overview with head, middle and end',()=>{
 const content='HEADER: start\n'+'x'.repeat(8000)+'CRITICAL_DECISION_IN_MIDDLE'+'y'.repeat(8000)+'\nEND: done';
 const preview=makeFilePreview(content);
 const one=externalizeLargeBlocks([{role:'user',content:[{type:'text',text:content}]}],{thresholdChars:1000});
 assert.equal(one.files.length,1);
 assert(preview.includes('CRITICAL_DECISION_IN_MIDDLE'));
 assert(preview.includes('HEADER: start'));
 assert(preview.includes('END: done'));
 assert(one.messages[0].content[0].text.includes('CRITICAL_DECISION_IN_MIDDLE'));
 assert(one.messages[0].content[0].text.length<1800,'does not negate context savings');
 assert.deepEqual(one,externalizeLargeBlocks([{role:'user',content:[{type:'text',text:content}]}],{thresholdChars:1000}));
});

test('file search finds content after the 8k excerpt without leaking another session',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lcm-deepsearch-'));
 const index=new LosslessIndex(path.join(dir,'index.sqlite'));
 try{
  const text='a'.repeat(16000)+'RELEVANT_MIDDLE_TOKEN'+'b'.repeat(16000);
  const id=fileIdFor(text),target=path.join(index.fileDir('s1'),id+'.txt');
  fs.writeFileSync(target,text);
  index.putFile({sessionId:'s1',id,chars:text.length,filePath:target,excerpt:text.slice(0,8192)});
  assert.equal(index.searchFiles('s1','RELEVANT_MIDDLE_TOKEN').length,1);
  assert.match(index.searchFiles('s1','RELEVANT_MIDDLE_TOKEN')[0].excerpt,/RELEVANT_MIDDLE_TOKEN/);
  assert.deepEqual(index.searchFiles('s2','RELEVANT_MIDDLE_TOKEN'),[]);
 }finally{index.close();fs.rmSync(dir,{recursive:true,force:true});}
});
