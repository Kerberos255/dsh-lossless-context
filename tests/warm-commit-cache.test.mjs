import test from 'node:test';
import assert from 'node:assert/strict';
import { schema, nativeConfig } from '../config.js';
import LosslessCompaction, { condensedPayload, groupLayer, leafPayload } from '../agent.js';

const defaults = schema.defaults;
const makeAgent = () => ({
  status: 'idle', inbox: { hasPending: false },
  session: { id: 'warm-session', requestHeader: () => ({ config: { provider: 'test', model: 'summary', maxTokens: 4096 } }) },
  options: {},
});

// A plan with three leaf groups forces both leaf summaries and one condensed layer.
function makeEngine(calls) {
  const value = { ...defaults, deferred: true, compressionTiming: 'after-turn', condenseFanout: 2 };
  const engine = Object.create(LosslessCompaction.prototype);
  engine.config = nativeConfig(value);
  engine.settings = { configFile: { value }, tasks: new Set() };
  engine.warmStats = { prepared: 0, cacheHits: 0, warmHits: 0, failures: 0, cancelled: 0, attempts: 0 };
  engine.warmed = new Map();
  engine.ctx = {
    tokenMeter: {
      estimateMessage: message => JSON.stringify(message).length,
      measure: () => ({ totalTokens: 1 }),
    },
  };
  engine.diagnostics = () => {};
  engine.completeSummary = async (payload, _agent, _signal, _value, _meta, kind) => {
    calls.push({ kind, payload });
    return { summary: [{ type: 'text', text: `${kind}-${calls.length}` }], provider: 'test', model: 'summary', maxTokens: 16, usage: null, rawOutput: '' };
  };
  // prepare() returns a fixed three-group plan so the test does not need a real transcript.
  engine.prepare = async () => ({
    available: 4096,
    plan: {
      system: { role: 'system', content: [{ type: 'text', text: 'SYS' }] },
      groups: [
        { start: 0, end: 1, tokens: 10, messages: [{ role: 'user', content: [{ type: 'text', text: 'A' }] }] },
        { start: 1, end: 2, tokens: 10, messages: [{ role: 'user', content: [{ type: 'text', text: 'B' }] }] },
        { start: 2, end: 3, tokens: 10, messages: [{ role: 'user', content: [{ type: 'text', text: 'C' }] }] },
      ],
    },
  });
  engine.index = { auxiliary: () => {}, plan: () => {} };
  return engine;
}

const input = { tools: [], messages: [] };

test('idle preparation primes every key the commit will look up', async () => {
  const calls = [];
  const engine = makeEngine(calls);
  const agent = makeAgent();
  const result = await engine.warmPrepared(input, agent, new AbortController().signal, engine.settings.configFile.value, engine.index, 'warm:1', 8);

  assert.equal(result.pending, false);
  // 3 leaves with fanout 2 condense twice: (leaf1+leaf2) then (condensed+leaf3).
  assert.equal(result.prepared, 5, 'three leaves plus two condensation rounds');
  assert.equal(calls.filter(call => call.kind === 'leaf').length, 3);
  assert.equal(calls.filter(call => call.kind === 'condensed').length, 2);

  // Everything the commit path builds through the shared helpers must already be cached.
  const { plan } = await engine.prepare(input, agent, new AbortController().signal, engine.settings.configFile.value);
  for (const group of plan.groups) {
    const key = engine.cacheKey(leafPayload(input, plan, group), agent, 'leaf');
    assert.ok(engine.cached(key, agent.session.id), 'leaf payload is cached');
  }
  // Round one condenses the first two leaves, round two condenses that result with the third.
  const firstRound = condensedPayload(input, plan, ['leaf-1', 'leaf-2']);
  const secondRound = condensedPayload(input, plan, ['condensed-4', 'leaf-3']);
  assert.ok(engine.cached(engine.cacheKey(firstRound, agent, 'condensed'), agent.session.id), 'first condensation is cached');
  assert.ok(engine.cached(engine.cacheKey(secondRound, agent, 'condensed'), agent.session.id), 'second condensation is cached');

  const before = calls.length;
  await engine.warmPrepared(input, agent, new AbortController().signal, engine.settings.configFile.value, engine.index, 'warm:2', 8);
  assert.equal(calls.length, before, 'a second pass reuses the cache instead of calling the model again');
});

test('the token budget limits how many leaves a single pass may summarise', async () => {
  const calls = [];
  const engine = makeEngine(calls);
  const agent = makeAgent();
  const result = await engine.warmPrepared(input, agent, new AbortController().signal, engine.settings.configFile.value, engine.index, 'warm:3', 2);
  assert.equal(result.pending, true, 'the pass stops once its two model calls are spent');
  assert.equal(calls.length, 2);
});

test('grouping the prepared layer matches the grouping the commit would use', async () => {
  const engine = makeEngine([]);
  const agent = makeAgent();
  const { plan } = await engine.prepare(input, agent, new AbortController().signal, engine.settings.configFile.value);
  const layer = ['甲', '乙', '丙'].map((text, index) => ({ id: 'leaf:' + index, text }));
  const groups = groupLayer(layer, {
    fanout: 2,
    available: 4096,
    estimate: item => engine.ctx.tokenMeter.estimateMessage({ role: 'user', content: [{ type: 'text', text: item.text }] }),
  });
  assert.deepEqual(groups.map(group => group.map(item => item.id)), [['leaf:0', 'leaf:1'], ['leaf:2']]);
  assert.deepEqual(condensedPayload(input, plan, ['甲', '乙']).messages.map(message => message.role), ['system', 'user']);
});
