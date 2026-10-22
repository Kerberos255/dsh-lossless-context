import test from 'node:test';
import assert from 'node:assert/strict';
import { condensedLabel, condensedPayload, groupLayer, leafPayload, notFitError } from '../agent.js';

const plan = { system: { role: 'system', content: [{ type: 'text', text: 'SYS' }] }, groups: [] };
const input = { tools: [{ name: 'read' }], messages: [{ role: 'user', content: [] }] };
const estimate = item => item.text.length;

test('a single leaf group reuses the original input so the cache key cannot drift', () => {
  const single = { ...plan, groups: [{ messages: [{ role: 'user', content: [] }] }] };
  assert.equal(leafPayload(input, single, single.groups[0]), input, 'single-group compaction keeps the original payload object');
});

test('multi-group leaf payloads put the system message first, exactly like compaction', () => {
  const group = { messages: [{ role: 'user', content: [{ type: 'text', text: 'A' }] }] };
  const payload = leafPayload(input, { ...plan, groups: [group, group] }, group);
  assert.deepEqual(payload.messages.map(message => message.role), ['system', 'user']);
  assert.deepEqual(payload.tools, input.tools, 'tools stay available for summary calls');
  assert.equal(payload.messages[0].content[0].text, 'SYS');
});

test('condensed payloads label leaves with the shared 摘要 N format', () => {
  assert.equal(condensedLabel(['甲', '乙']), '摘要 1:\n甲\n\n摘要 2:\n乙');
  const payload = condensedPayload(input, plan, ['甲', '乙']);
  assert.equal(payload.messages[0].role, 'system');
  assert.equal(payload.messages[1].content[0].text, '摘要 1:\n甲\n\n摘要 2:\n乙');
});

test('grouping honours fanout and the remaining token budget', () => {
  const layer = ['aa', 'bb', 'cc', 'dd', 'ee'].map(text => ({ text }));
  const groups = groupLayer(layer, { fanout: 2, available: 100, estimate });
  assert.deepEqual(groups.map(group => group.map(item => item.text)), [['aa', 'bb'], ['cc', 'dd'], ['ee']]);

  const tight = groupLayer(layer, { fanout: 3, available: 2, estimate });
  assert.deepEqual(tight.map(group => group.length), [1, 1, 1, 1, 1], 'a tight budget never merges');

  const wide = groupLayer(layer, { fanout: 3, available: 100, estimate });
  assert.deepEqual(wide.map(group => group.map(item => item.text)), [['aa', 'bb', 'cc'], ['dd', 'ee']]);
});

test('a layer that cannot shrink reports a structural code instead of a generic failure', () => {
  const error = notFitError();
  assert.equal(error.code, 'lcm-condensed-summary-does-not-fit');
  assert.match(error.message, /does not shrink/);
});
