import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldProvenance, provenanceStateSchema, provenanceProjection, MAX_REPLIES, REPLIES_SLACK } from '../contracts.js';

test('each historical reply keeps the model and effort of its own logged request', () => {
  let state = { currentRequest: null, replies: {} };
  const apply = event => { state = foldProvenance(state, event); provenanceStateSchema.parse(state); };
  apply({ type: 'request/header', seq: 1, data: { header: { config: { provider: 'p', model: 'ds', reasoningEffort: 'max' } } } });
  apply({ type: 'assistant/message', seq: 3, data: { turn: 1, step: 1, message: { id: 'a', source: { kind: 'model', provider: 'p', model: 'ds' } } } });
  apply({ type: 'request/header', seq: 4, data: { header: { config: { provider: 'p', model: 'fable', reasoningEffort: 'xhigh' } } } });
  apply({ type: 'assistant/message', seq: 6, data: { turn: 2, step: 1, message: { id: 'b', source: { kind: 'model', provider: 'p', model: 'fable' } } } });
  assert.equal(state.replies.a.model, 'ds');
  assert.equal(state.replies.a.reasoningEffort, 'max');
  assert.equal(state.replies.b.reasoningEffort, 'xhigh');
  assert.equal(state.replies.b.requestSeq, 4);
});

test('missing historical request metadata never fabricates an effort', () => {
  const state = foldProvenance({ currentRequest: null, replies: {} }, {
    type: 'assistant/message', seq: 3, data: { turn: 1, step: 1, message: { id: 'a', source: { kind: 'model', provider: 'p', model: 'unknown' } } },
  });
  assert.equal(state.replies.a.effortKnown, false);
  assert.equal(state.replies.a.reasoningEffort, null);
});

test('non-model and non-message events pass through unchanged', () => {
  const state = { currentRequest: null, replies: {} };
  assert.equal(foldProvenance(state, { type: 'tool/call', seq: 1, data: {} }), state);
  const toolMessage = { type: 'assistant/message', seq: 2, data: { turn: 1, step: 1, message: { id: 'x', source: { kind: 'tool', callId: 'c' } } } };
  assert.equal(foldProvenance(state, toolMessage), state);
});

test('the reply map keeps only the newest replies so a long Session cannot grow the host heap', () => {
  let state = { currentRequest: null, replies: {} };
  for (let index = 0; index < 900; index += 1) {
    state = foldProvenance(state, {
      type: 'assistant/message', seq: index + 1, data: { turn: 1, step: 1, message: { id: `m${index}`, source: { kind: 'model', provider: 'p', model: 'ds' } } },
    });
  }
  provenanceStateSchema.parse(state);
  // The fold compacts in batches, so the map may hold one batch over the cap, never more.
  const count = Object.keys(state.replies).length;
  assert.ok(count <= MAX_REPLIES + REPLIES_SLACK, `expected at most ${MAX_REPLIES + REPLIES_SLACK} replies, found ${count}`);
  assert.ok(state.replies.m899, 'the newest reply survives');
  assert.equal(state.replies.m0, undefined, 'the oldest reply is dropped');
});

test('a wire view taken before a later fold keeps the values of its own state', () => {
  let state = { currentRequest: null, replies: {} };
  const apply = event => { state = foldProvenance(state, event); };
  apply({ type: 'assistant/message', seq: 1, data: { turn: 1, step: 1, message: { id: 'a', source: { kind: 'model', provider: 'p', model: 'ds' } } } });
  const first = provenanceProjection.wire.view(state);
  apply({ type: 'assistant/message', seq: 2, data: { turn: 1, step: 1, message: { id: 'b', source: { kind: 'model', provider: 'p', model: 'ds' } } } });
  const second = provenanceProjection.wire.view(state);
  assert.deepEqual(Object.keys(first), ['a'], 'the earlier view is detached from the in-place fold');
  assert.deepEqual(Object.keys(second), ['a', 'b']);
  assert.equal(provenanceProjection.wire.view(state), second, 'one view per state');
});

test('a request header changes the state but not the reply view', () => {
  let state = { currentRequest: null, replies: {} };
  state = foldProvenance(state, { type: 'assistant/message', seq: 1, data: { turn: 1, step: 1, message: { id: 'a', source: { kind: 'model', provider: 'p', model: 'ds' } } } });
  const before = provenanceProjection.wire.view(state);
  state = foldProvenance(state, { type: 'request/header', seq: 2, data: { header: { config: { provider: 'p', model: 'ds', reasoningEffort: 'max' } } } });
  assert.equal(provenanceProjection.wire.view(state), before, 'listeners must not see a reply change on a request header');
  assert.equal(state.currentRequest.reasoningEffort, 'max');
});

test('projection wire view exposes only the reply map', () => {
  const state = { currentRequest: { provider: 'p', model: 'm', reasoningEffort: null, seq: 1 }, replies: { a: { provider: 'p', model: 'm', reasoningEffort: null, effortKnown: true, requestSeq: 1, messageSeq: 2, turn: 1, step: 1 } } };
  assert.deepEqual(provenanceProjection.wire.view(state), state.replies);
  assert.equal(provenanceProjection.key, 'localModelReplyProvenance');
});
