import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileIdFor, externalizeLargeBlocks, fileReference } from '../planner.js';
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
  assert.equal(one.messages[0].content[1].text, fileReference({ id: one.files[0].id, chars: 100 }));
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
