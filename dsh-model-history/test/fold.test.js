import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldHistory, historyStateSchema, historyViewSchema, modelHistoryProjection, selectionOfHeader } from '../contracts.js';

/** Fold a list of events into the history state, validating every step. */
function foldAll(events) {
  let state = modelHistoryProjection.init();
  for (const event of events) {
    state = foldHistory(state, event);
    historyStateSchema.parse(state);
  }
  return state;
}

/** One `request/header` event carrying the given configuration. */
function header(seq, config, reason = 'change', extra = {}) {
  return { type: 'request/header', seq, time: 1_700_000_000_000 + seq * 1000, data: { header: { config }, reason, ...extra } };
}

test('a header records the model and effort the requests used', () => {
  const state = foldAll([header(1, { provider: 'acme', model: 'acme/model-pro', reasoningEffort: 'high' }, 'initial')]);
  assert.equal(state.entries.length, 1);
  assert.deepEqual(state.entries[0], {
    provider: 'acme',
    model: 'acme/model-pro',
    reasoningEffort: 'high',
    effortDefaulted: false,
    reason: 'initial',
    turn: null,
    step: null,
    time: 1_700_000_001_000,
    seq: 1,
  });
});

test('an unchanged configuration is not recorded again', () => {
  const state = foldAll([
    header(1, { provider: 'acme', model: 'm', reasoningEffort: 'high' }, 'initial'),
    header(2, { provider: 'acme', model: 'm', reasoningEffort: 'high' }, 'series'),
    header(3, { provider: 'acme', model: 'm', reasoningEffort: 'high' }, 'change'),
  ]);
  assert.equal(state.entries.length, 1);
});

test('a changed model, provider, or effort each records one row', () => {
  const state = foldAll([
    header(1, { provider: 'acme', model: 'a', reasoningEffort: 'high' }, 'initial'),
    header(2, { provider: 'acme', model: 'b', reasoningEffort: 'high' }),
    header(3, { provider: 'acme', model: 'b', reasoningEffort: 'max' }),
    header(4, { provider: 'other', model: 'b', reasoningEffort: 'max' }),
  ]);
  assert.deepEqual(state.entries.map(entry => [entry.provider, entry.model, entry.reasoningEffort]), [
    ['acme', 'a', 'high'],
    ['acme', 'b', 'high'],
    ['acme', 'b', 'max'],
    ['other', 'b', 'max'],
  ]);
});

test('switching back to an earlier configuration records the change again', () => {
  const state = foldAll([
    header(1, { provider: 'p', model: 'a', reasoningEffort: 'high' }, 'initial'),
    header(2, { provider: 'p', model: 'b', reasoningEffort: 'high' }),
    header(3, { provider: 'p', model: 'a', reasoningEffort: 'high' }),
  ]);
  assert.deepEqual(state.entries.map(entry => entry.model), ['a', 'b', 'a']);
});

test('an adapter-defaulted effort reads as unspecified', () => {
  const state = foldAll([{
    type: 'request/header', seq: 1, time: 5,
    data: { header: { config: { provider: 'p', model: 'm' }, adapterDefaults: { reasoningEffort: true } }, reason: 'initial' },
  }]);
  assert.equal(state.entries[0].reasoningEffort, null);
  assert.equal(state.entries[0].effortDefaulted, true);
});

test('the turn and step of the request are recorded with the row', () => {
  const state = foldAll([
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 3 } },
    { type: 'step/start', seq: 2, time: 2, data: { turn: 3, step: 2 } },
    header(3, { provider: 'p', model: 'm' }, 'initial'),
    { type: 'step/start', seq: 4, time: 4, data: { turn: 3, step: 3 } },
  ]);
  assert.equal(state.entries[0].turn, 3);
  assert.equal(state.entries[0].step, 2);
});

test('unrelated events keep the state reference so nothing is published', () => {
  const state = modelHistoryProjection.init();
  assert.equal(foldHistory(state, { type: 'tool/call', seq: 1, data: {} }), state);
  assert.equal(foldHistory(state, { type: 'assistant/message', seq: 2, data: {} }), state);
  assert.equal(foldHistory(state, { type: 'request/header', seq: 3, data: { header: {} } }), state);
});

test('a header without a usable configuration is ignored', () => {
  const state = modelHistoryProjection.init();
  assert.equal(foldHistory(state, { type: 'request/header', seq: 1, data: { header: { config: { provider: 'p' } } } }), state);
  assert.equal(selectionOfHeader(undefined), null);
  assert.equal(selectionOfHeader({ config: { provider: '', model: 'm' } }), null);
});

test('the history keeps only the newest rows so a long Session cannot grow the host heap', () => {
  const events = [];
  for (let index = 0; index < 400; index += 1) {
    events.push(header(index + 1, { provider: 'p', model: `m${index}` }, 'change'));
  }
  const state = foldAll(events);
  assert.ok(state.entries.length <= 200, `expected at most 200 rows, found ${state.entries.length}`);
  assert.equal(state.entries.at(-1).model, 'm399', 'the newest row survives');
  assert.ok(!state.entries.some(entry => entry.model === 'm0'), 'the oldest row is dropped');
});

test('the wire view is the entry array and validates against the view schema', () => {
  const state = foldAll([header(1, { provider: 'p', model: 'm', reasoningEffort: 'high' }, 'initial')]);
  const view = modelHistoryProjection.wire.view(state);
  assert.equal(view, state.entries);
  assert.equal(historyViewSchema.parse(view).length, 1);
  assert.equal(modelHistoryProjection.key, 'localModelRequestHistory');
  assert.equal(modelHistoryProjection.wire.summary, false);
});

test('the view reference only changes when a row is appended', () => {
  const first = modelHistoryProjection.init();
  const afterHeader = foldHistory(first, header(1, { provider: 'p', model: 'm' }, 'initial'));
  const view = modelHistoryProjection.wire.view(afterHeader);
  const afterStep = foldHistory(afterHeader, { type: 'step/start', seq: 2, time: 2, data: { turn: 1, step: 1 } });
  assert.equal(modelHistoryProjection.wire.view(afterStep), view);
  const afterChange = foldHistory(afterStep, header(3, { provider: 'p', model: 'n' }));
  assert.notEqual(modelHistoryProjection.wire.view(afterChange), view);
});
