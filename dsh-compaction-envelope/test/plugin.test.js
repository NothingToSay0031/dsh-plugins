import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, inject, name } from '../index.js';

const ROUTE_HEADER = {
  config: { provider: 'demo', model: 'gpt-6.1-sol', reasoningEffort: 'max' },
};

function harness({ header = ROUTE_HEADER, chunks = [{ type: 'text', text: 'ok' }] } = {}) {
  const seen = [];
  const disposers = [];
  const logs = [];
  const llm = {
    async *stream(options) {
      seen.push(options);
      for (const chunk of chunks) yield chunk;
    },
  };
  const sessions = {
    get(id) {
      if (id !== 'session-1') return undefined;
      return { requestHeader: () => header };
    },
  };
  const ctx = {
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    get: (service) => ({ llm, sessions })[service],
    effect: (factory) => {
      disposers.push(factory());
    },
  };
  return { ctx, llm, seen, logs, dispose: () => disposers.forEach((fn) => fn()) };
}

const COMPACTION = {
  purpose: 'compaction',
  provider: 'demo',
  model: 'gpt-6.1-sol',
  sessionId: 'session-1',
  messages: [],
  maxTokens: 20000,
};

test('plugin declares the services it needs', () => {
  assert.equal(name, 'compaction-envelope');
  assert.deepEqual(inject, ['llm', 'sessions']);
});

test('apply() gives a real compaction call the routed effort', async () => {
  const { ctx, llm, seen, logs, dispose } = harness();
  apply(ctx);
  for await (const _ of llm.stream(COMPACTION)) void _;
  assert.equal(seen[0].reasoningEffort, 'max');
  assert.equal(seen[0].maxTokens, 20000, 'everything else is preserved');
  assert.equal(seen[0].messages, COMPACTION.messages);
  assert.equal(logs.some((line) => line.includes('reasoningEffort=max')), true);
  dispose();
});

test('apply() leaves a session with no routed effort alone', async () => {
  const { ctx, llm, seen, dispose } = harness({
    header: { config: { provider: 'demo', model: 'gpt-6.1-sol' } },
  });
  apply(ctx);
  for await (const _ of llm.stream(COMPACTION)) void _;
  assert.equal(seen[0].reasoningEffort, undefined);
  dispose();
});

test('apply() tolerates a session that is gone', async () => {
  const { ctx, llm, seen, dispose } = harness();
  apply(ctx);
  for await (const _ of llm.stream({ ...COMPACTION, sessionId: 'deleted' })) void _;
  assert.equal(seen[0].reasoningEffort, undefined);
  dispose();
});

test('apply() restores the service when the extension unloads', async () => {
  const { ctx, llm, dispose } = harness();
  const original = llm.stream;
  apply(ctx);
  assert.notEqual(llm.stream, original);
  dispose();
  assert.equal(llm.stream, original);
});

test('apply() honours enabled: false', async () => {
  const { ctx, llm, logs } = harness();
  const original = llm.stream;
  apply(ctx, { enabled: false });
  assert.equal(llm.stream, original);
  assert.equal(logs.some((line) => line.includes('disabled')), true);
});

const STATS = Symbol.for('@local/dsh-compaction-envelope.stats');

test('a compaction stream is counted and passes through unchanged', async () => {
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'thinking' },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: 'summary' },
    { type: 'usage', usage: { completionTokens: 42 } },
    { type: 'finish', reason: 'stop' },
  ];
  const { ctx, llm, logs, dispose } = harness({ chunks });
  apply(ctx);
  const received = [];
  for await (const chunk of llm.stream(COMPACTION)) received.push(chunk);
  // Same objects, same order: the wrapper may not rebuild the stream it observes.
  assert.deepEqual(received, chunks);
  const tally = llm[STATS].lastStream;
  assert.equal(tally.textChars, 7);
  assert.equal(tally.reasoningChars, 8);
  assert.equal(tally.finish, 'stop');
  assert.equal(tally.usage.completionTokens, 42);
  assert.equal(tally.effort, 'max');
  assert.equal(logs.some((line) => line.includes('text=7 reasoning=8') && line.includes('finish=stop')), true);
  dispose();
});

test('a stream that ends without any text is reported as empty', async () => {
  // The shape the empty-summary failure needs ruled in or out: reasoning only, stopped by length.
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'x'.repeat(500) },
    { type: 'finish', reason: 'length' },
  ];
  const { ctx, llm, logs, dispose } = harness({ chunks });
  apply(ctx);
  for await (const _ of llm.stream(COMPACTION)) void _;
  assert.equal(llm[STATS].lastStream.textChars, 0);
  assert.equal(llm[STATS].lastStream.finish, 'length');
  assert.equal(
    logs.some((line) => line.includes('produced no text') && line.includes('reasoning=500') && line.includes('finish=length')),
    true,
  );
  dispose();
});

test('a stream with no finish chunk is reported as finish=none', async () => {
  // `BlockAssembler.finish` defaults to {kind: 'stop'} when no finish chunk arrived, so a stream
  // cut before the finish reaches the "no text" check rather than a transport error.
  const { ctx, llm, logs, dispose } = harness({ chunks: [{ type: 'block-start', index: 0, blockType: 'text' }] });
  apply(ctx);
  for await (const _ of llm.stream(COMPACTION)) void _;
  assert.equal(llm[STATS].lastStream.finish, undefined);
  assert.equal(
    logs.some((line) => line.includes('finish=none') && line.includes('tokens=none') && line.includes('produced no text')),
    true,
  );
  dispose();
});

test('diagnose: false keeps the stream but records nothing', async () => {
  const { ctx, llm, dispose } = harness();
  apply(ctx, { diagnose: false });
  for await (const _ of llm.stream(COMPACTION)) void _;
  assert.equal(llm[STATS].lastStream, undefined);
  dispose();
});
