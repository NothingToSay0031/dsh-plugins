import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldProvenance, provenanceStateSchema, provenanceProjection } from '../contracts.js';

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

test('projection wire view exposes only the reply map', () => {
  const state = { currentRequest: { provider: 'p', model: 'm', reasoningEffort: null, seq: 1 }, replies: { a: { provider: 'p', model: 'm', reasoningEffort: null, effortKnown: true, requestSeq: 1, messageSeq: 2, turn: 1, step: 1 } } };
  assert.deepEqual(provenanceProjection.wire.view(state), state.replies);
  assert.equal(provenanceProjection.key, 'localModelReplyProvenance');
});
