import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, inject, name } from '../index.js';

const ROUTE_HEADER = {
  config: { provider: 'demo', model: 'gpt-6.1-sol', reasoningEffort: 'max' },
};

function harness({ header = ROUTE_HEADER } = {}) {
  const seen = [];
  const disposers = [];
  const logs = [];
  const llm = {
    async *stream(options) {
      seen.push(options);
      yield { type: 'text', text: 'ok' };
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
