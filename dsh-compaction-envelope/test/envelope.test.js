import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, installEnvelope, WRAPPED } from '../envelope.js';

const ROUTE = { provider: 'demo', model: 'gpt-6.1-sol', reasoningEffort: 'max' };
const COMPACTION = {
  purpose: 'compaction',
  provider: 'demo',
  model: 'gpt-6.1-sol',
  sessionId: 'session-1',
  messages: [],
  maxTokens: 20000,
};

test('decide injects only for a compaction call lacking its own effort', () => {
  assert.deepEqual(decide(COMPACTION, ROUTE), { inject: true, effort: 'max', reason: 'injected' });
});

test('decide ignores non-compaction calls', () => {
  assert.equal(decide({ ...COMPACTION, purpose: undefined }, ROUTE).reason, 'other-purpose');
  assert.equal(decide({ ...COMPACTION, purpose: 'step' }, ROUTE).reason, 'other-purpose');
});

test('decide never overrides an effort the caller already set', () => {
  assert.equal(decide({ ...COMPACTION, reasoningEffort: 'high' }, ROUTE).reason, 'already-set');
});

test('decide skips when the routed effort is unknown', () => {
  assert.equal(decide(COMPACTION, undefined).reason, 'no-route');
  assert.equal(decide(COMPACTION, { provider: 'demo', model: 'x' }).reason, 'no-routed-effort');
  assert.equal(decide(COMPACTION, { ...ROUTE, reasoningEffort: '' }).reason, 'no-routed-effort');
});

test('decide skips a summarizer routed to a different model', () => {
  const elsewhere = { ...COMPACTION, model: 'deepseek-flash' };
  assert.equal(decide(elsewhere, ROUTE).reason, 'route-mismatch');
  assert.equal(decide(elsewhere, ROUTE, { requireSameRoute: false }).inject, true);
});

test('decide tolerates junk options', () => {
  assert.equal(decide(undefined, ROUTE).reason, 'no-options');
  assert.equal(decide(null, ROUTE).reason, 'no-options');
});

function fakeLlm() {
  const seen = [];
  return {
    seen,
    async *stream(options) {
      seen.push(options);
      yield { type: 'text', text: 'ok' };
    },
  };
}

const resolveFrom = (route) => (sessionId) => (sessionId === 'session-1' ? route : undefined);

test('installEnvelope rewrites only the compaction call', async () => {
  const llm = fakeLlm();
  const installed = installEnvelope(llm, resolveFrom(ROUTE));
  assert.equal(installed.status, 'installed');

  for await (const _ of llm.stream(COMPACTION)) void _;
  for await (const _ of llm.stream({ ...COMPACTION, purpose: 'step' })) void _;
  for await (const _ of llm.stream({ ...COMPACTION, reasoningEffort: 'high' })) void _;
  for await (const _ of llm.stream({ ...COMPACTION, model: 'deepseek-flash' })) void _;
  for await (const _ of llm.stream({ ...COMPACTION, sessionId: 'unknown' })) void _;

  assert.equal(llm.seen[0].reasoningEffort, 'max', 'compaction call inherits the routed effort');
  assert.equal(llm.seen[1].reasoningEffort, undefined, 'routed call untouched');
  assert.equal(llm.seen[2].reasoningEffort, 'high', 'explicit effort untouched');
  assert.equal(llm.seen[3].reasoningEffort, undefined, 'mismatched route untouched');
  assert.equal(llm.seen[4].reasoningEffort, undefined, 'unknown session untouched');
  assert.equal(installed.stats.injected, 1);
  assert.equal(installed.stats.skipped['other-purpose'], 1);
  assert.equal(installed.stats.skipped['already-set'], 1);
  assert.equal(installed.stats.skipped['route-mismatch'], 1);
  assert.equal(installed.stats.skipped['no-route'], 1);
  assert.equal(installed.stats.lastInjection.sessionId, 'session-1');
  assert.equal(installed.stats.lastInjection.effort, 'max');
});

test('installEnvelope hands over a copy and leaves the caller object alone', async () => {
  const llm = fakeLlm();
  const installed = installEnvelope(llm, resolveFrom(ROUTE));
  const call = { ...COMPACTION };
  const signal = new AbortController().signal;
  for await (const _ of llm.stream({ ...call, signal })) void _;
  assert.notEqual(llm.seen[0], call);
  assert.equal(llm.seen[0].signal, signal, 'signal is forwarded by identity');
  assert.equal('reasoningEffort' in call, false);
  installed.dispose();
});

test('installEnvelope restores the service on dispose', async () => {
  const llm = fakeLlm();
  const original = llm.stream;
  const installed = installEnvelope(llm, resolveFrom(ROUTE));
  assert.notEqual(llm.stream, original);
  assert.equal(llm.stream[WRAPPED], true);
  installed.dispose();
  assert.equal(llm.stream, original);
});

test('installEnvelope refuses to stack two wrappers', () => {
  const llm = fakeLlm();
  const first = installEnvelope(llm, resolveFrom(ROUTE));
  assert.equal(first.status, 'installed');
  const second = installEnvelope(llm, resolveFrom(ROUTE));
  assert.equal(second.status, 'already');
  first.dispose();
});

test('installEnvelope reports an unusable service instead of throwing', () => {
  assert.equal(installEnvelope(undefined, resolveFrom(ROUTE)).status, 'no-stream');
  assert.equal(installEnvelope({}, resolveFrom(ROUTE)).status, 'no-stream');
  const frozen = Object.freeze({ async *stream() {} });
  const installed = installEnvelope(frozen, resolveFrom(ROUTE));
  assert.ok(['not-writable', 'no-stream'].includes(installed.status));
});

test('a failing route resolver degrades to a plain call', async () => {
  const llm = fakeLlm();
  const installed = installEnvelope(llm, () => {
    throw new Error('boom');
  });
  for await (const _ of llm.stream(COMPACTION)) void _;
  assert.equal(llm.seen[0].reasoningEffort, undefined);
  assert.equal(installed.stats.injected, 0);
});

test('installEnvelope shadows a class method, like the real service', async () => {
  class LlmLike {
    constructor() {
      this.seen = [];
    }
    async *stream(options) {
      this.seen.push(options);
      yield { type: 'text', text: 'ok' };
    }
  }
  const llm = new LlmLike();
  const installed = installEnvelope(llm, resolveFrom(ROUTE));
  assert.equal(installed.status, 'installed');
  for await (const _ of llm.stream(COMPACTION)) void _;
  assert.equal(llm.seen[0].reasoningEffort, 'max');
  assert.equal(Object.hasOwn(llm, 'stream'), true);
  installed.dispose();
  assert.equal(Object.hasOwn(llm, 'stream'), false);
  assert.equal(typeof llm.stream, 'function');
});

test('a summarized route mismatch is left alone and reported', async () => {
  const llm = fakeLlm();
  const warnings = [];
  const installed = installEnvelope(llm, resolveFrom(ROUTE), { logger: { info() {}, warn: (m) => warnings.push(m) } });
  for await (const _ of llm.stream({ ...COMPACTION, model: 'deepseek-flash' })) void _;
  assert.equal(llm.seen[0].reasoningEffort, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /routed to demo\/gpt-6.1-sol/);
  installed.dispose();
});

test('concurrent sessions keep their own effort while interleaving', async () => {
  const started = [];
  const llm = {
    async *stream(options) {
      started.push(options);
      for (const step of [1, 2, 3]) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        yield { type: 'text', text: `step-${step}` };
      }
    },
  };
  const routes = {
    'session-a': { provider: 'demo', model: 'gpt-6.1-sol', reasoningEffort: 'max' },
    'session-b': { provider: 'demo', model: 'deepseek-flash', reasoningEffort: 'high' },
  };
  const installed = installEnvelope(llm, (id) => routes[id]);

  const call = (sessionId) => ({ ...COMPACTION, sessionId, provider: routes[sessionId].provider, model: routes[sessionId].model });
  const a = llm.stream(call('session-a'))[Symbol.asyncIterator]();
  const b = llm.stream(call('session-b'))[Symbol.asyncIterator]();
  const c = llm.stream(call('session-a'))[Symbol.asyncIterator]();
  // Interleave the three streams so any shared "current session" state would show up.
  for (const iterator of [a, b, c, a, b, c, a, b, c]) await iterator.next();

  assert.equal(started[0].reasoningEffort, 'max');
  assert.equal(started[1].reasoningEffort, 'high');
  assert.equal(started[2].reasoningEffort, 'max');
  assert.equal(new Set(started).size, 3, 'each call gets its own options object');
  assert.equal(installed.stats.injected, 3);
  assert.equal(installed.stats.lastInjection.sessionId, 'session-a');
  installed.dispose();
});

test('a wrapper failure never fails the model call', async () => {
  const llm = fakeLlm();
  const warnings = [];
  const installed = installEnvelope(llm, resolveFrom(ROUTE), {
    logger: { warn: (m) => warnings.push(m), info() {} },
  });
  // Break the decision path by making the options object explode on property access.
  const hostile = new Proxy({}, {
    get(target, key) {
      if (key === 'purpose') throw new Error('hostile');
      return undefined;
    },
  });
  for await (const _ of llm.stream(hostile)) void _;
  assert.equal(llm.seen.length, 1, 'the call still reached the service');
  assert.equal(warnings.length, 1);
  installed.dispose();
});
