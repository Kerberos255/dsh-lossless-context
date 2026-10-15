import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeComplete } from '../summarizer.js';

function harness() {
  const captured = [];
  const ctx = {
    llm: {
      resolveModelInfo: async () => ({ context: { contextWindow: 1000000, maxOutputTokens: 65536 } }),
      stream: async function* () {
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
    tokenMeter: { estimateMessage: () => 100 },
  };
  const agent = { session: { requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }, options: {} };
  const nativeSummarize = async function (input) { captured.push(input); return { summary: 'ok' }; };
  return { ctx, agent, nativeSummarize, captured };
}

const baseInput = { messages: [{ role: 'user', content: [{ type: 'text', text: '被压缩的对话' }] }] };
const native = { modelPolicies: [] };

test('a leaf summary is asked for the leaf target length', async () => {
  const { ctx, agent, nativeSummarize, captured } = harness();
  await summarizeComplete(nativeSummarize, ctx, native, baseInput, agent, null,
    { maxTokens: 16384, summaryRetryMaxTokens: 32768, summaryRetries: 2, kind: 'leaf', leafTargetTokens: 2400, condensedTargetTokens: 2000 });
  const last = captured[0].messages.at(-1);
  assert.equal(last.role, 'user');
  assert.equal(last.content[0].text, 'Target length: about 2400 tokens or less.');
});

test('a condensed summary is asked for the condensed target length', async () => {
  const { ctx, agent, nativeSummarize, captured } = harness();
  await summarizeComplete(nativeSummarize, ctx, native, baseInput, agent, null,
    { maxTokens: 16384, summaryRetryMaxTokens: 32768, summaryRetries: 2, kind: 'condensed', leafTargetTokens: 2400, condensedTargetTokens: 2000 });
  assert.equal(captured[0].messages.at(-1).content[0].text, 'Target length: about 2000 tokens or less.');
});

test('the original messages are preserved ahead of the instruction', async () => {
  const { ctx, agent, nativeSummarize, captured } = harness();
  await summarizeComplete(nativeSummarize, ctx, native, baseInput, agent, null,
    { maxTokens: 16384, summaryRetryMaxTokens: 32768, summaryRetries: 2, kind: 'leaf', leafTargetTokens: 2400, condensedTargetTokens: 2000 });
  assert.equal(captured[0].messages.length, 2, 'original message plus the target instruction');
  assert.equal(captured[0].messages[0].content[0].text, '被压缩的对话');
});

test('a missing or zero target leaves the input untouched', async () => {
  const { ctx, agent, nativeSummarize, captured } = harness();
  await summarizeComplete(nativeSummarize, ctx, native, baseInput, agent, null,
    { maxTokens: 16384, summaryRetryMaxTokens: 32768, summaryRetries: 2, kind: 'leaf', leafTargetTokens: 0, condensedTargetTokens: 2000 });
  assert.equal(captured[0].messages.length, 1);
  assert.equal(captured[0].messages[0].content[0].text, '被压缩的对话');
});

test('other input fields such as tools survive the injection', async () => {
  const { ctx, agent, nativeSummarize, captured } = harness();
  const withTools = { ...baseInput, tools: [{ name: 'read' }] };
  await summarizeComplete(nativeSummarize, ctx, native, withTools, agent, null,
    { maxTokens: 16384, summaryRetryMaxTokens: 32768, summaryRetries: 2, kind: 'leaf', leafTargetTokens: 2400, condensedTargetTokens: 2000 });
  assert.deepEqual(captured[0].tools, [{ name: 'read' }]);
});

test('custom summary guidance preserves the native target instruction and leaves source messages intact',async()=>{
 const {ctx,agent,nativeSummarize,captured}=harness();
 await summarizeComplete(nativeSummarize,ctx,native,baseInput,agent,null,{
  maxTokens:16384,summaryRetryMaxTokens:32768,summaryRetries:2,kind:'leaf',
  leafTargetTokens:2400,condensedTargetTokens:2000,summaryGuidance:'记住原始来源与最新任务状态。'
 });
 assert.equal(captured[0].messages.length,2);
 assert.equal(captured[0].messages[0].content[0].text,'被压缩的对话');
 assert.match(captured[0].messages.at(-1).content[0].text,/Target length: about 2400 tokens or less/);
 assert.match(captured[0].messages.at(-1).content[0].text,/记住原始来源与最新任务状态/);
});
