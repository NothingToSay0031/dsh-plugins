// Memory bounds of collaboration delivery state: the Plugin Host runs every plugin
// in one process, so an unbounded collection or an unbounded parallel read of
// a multi-megabyte Session log ends the whole host with an out-of-memory abort.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Collaboration } from '../core.js';
import { requestSchema, receiptFold, receiptProjection, MAX_RECEIPTS, RECEIPTS_SLACK } from '../contracts.js';

function table(schema) {
  const records = new Map();
  return {
    get: key => records.get(key),
    entries: () => records.entries(),
    keys: () => records.keys(),
    get size() { return records.size; },
    put: async (key, value) => { records.set(key, schema ? schema.parse(structuredClone(value)) : structuredClone(value)); },
    delete: async key => records.delete(key),
    deleteMany: async keys => {
      const present = [...new Set(keys)].filter(key => records.has(key));
      for (const key of present) records.delete(key);
      return present.length;
    },
    update: async (key, fn) => {
      if (!records.has(key)) throw new Error('missing-key');
      const next = fn(records.get(key));
      records.set(key, schema ? schema.parse(structuredClone(next)) : structuredClone(next));
      return next;
    },
  };
}

/**
 * A host whose Sessions are all closed: every acceptance read therefore has
 * to open a log on disk, which is the expensive path the bounds protect.
 */
function fixture({ logs = new Map() } = {}) {
  const requests = table(requestSchema);
  const domain = {
    global: { get: () => ({ version: 2, active: [], inactive: [], revision: 0 }), set: async () => {} },
    table: name => (name === 'requests' ? requests : table()),
    close: async () => {},
  };
  const stats = { opened: 0, open: 0, peak: 0 };
  const ctx = {
    agents: { get: () => undefined, list: () => [] },
    sessions: { get: () => undefined, flush: async () => true },
    sessionProjections: { stateOf: () => undefined },
    sessionQuery: {
      readTitleSnapshots: async ids => ids.map(sessionId => ({ sessionId, status: 'fulfilled', value: { title: { title: sessionId } } })),
      observeSession: async sessionId => {
        stats.opened += 1; stats.open += 1; stats.peak = Math.max(stats.peak, stats.open);
        const events = logs.get(sessionId) ?? [];
        await new Promise(resolve => setTimeout(resolve, 1));
        stats.open -= 1;
        return { events, [Symbol.dispose]() {} };
      },
    },
    get: () => undefined,
  };
  return { ctx, requests, stats, service: new Collaboration(ctx, domain) };
}

function record(index, target) {
  const id = `collab-message-${index}`;
  return {
    id: `collab-send-${index}`, kind: 'send', from: 'a', to: target, fingerprint: 'fp',
    state: 'accepted', createdAt: 1000 + index, updatedAt: 1000 + index,
    body: 'body', threadId: 'thread',
    message: { id, role: 'user', content: [{ type: 'text', text: 'body' }] },
  };
}

test('history output does not read target Session logs for delivery evidence', async () => {
  const logs = new Map();
  for (let index = 0; index < 20; index += 1) {
    const target = `closed-${index}`;
    logs.set(target, [{ type: 'agent/inbox/spliced', seq: 1, data: { inserted: [{ id: `collab-message-${index}` }] } }]);
  }
  const f = fixture({ logs });
  const records = Array.from({ length: 20 }, (_, index) => record(index, `closed-${index}`));
  const page = f.service.historyEntries(records, 'caller');
  assert.equal(page.length, 20);
  assert.equal(f.stats.opened, 0);
});

test('delivery evidence reconciliation still batches log reads by target', async () => {
  const logs = new Map([['closed-1', [
    { type: 'agent/inbox/spliced', seq: 1, data: { inserted: [{ id: 'collab-message-0' }, { id: 'collab-message-1' }] } },
  ]]]);
  const f = fixture({ logs });
  const records = [record(0, 'closed-1'), record(1, 'closed-1')];
  await f.service.resolveEvidence(records);
  assert.equal(f.stats.opened, 1);
  assert.equal(f.service.evidence.get(records[0].id).evidence.acceptedSeq, 1);
  assert.equal(f.service.evidence.get(records[1].id).evidence.acceptedSeq, 1);
});

test('the acceptance evidence of a read log is remembered instead of read again', async () => {
  const logs = new Map([['closed-1', [{ type: 'agent/inbox/spliced', seq: 1, data: { inserted: [{ id: 'collab-message-0' }] } }]]]);
  const f = fixture({ logs });
  const records = [record(0, 'closed-1')];
  await f.requests.put(records[0].id, records[0]);
  await f.service.resolveEvidence(records);
  await f.service.resolveEvidence(records);
  assert.equal(f.stats.opened, 1);
  const stored = f.requests.get(records[0].id);
  assert.equal(stored.evidence.acceptedSeq, 1);
});

test('the durable delivery state keeps only the newest records', async () => {
  const f = fixture();
  for (let index = 0; index < 2100; index += 1) {
    const item = record(index, 'closed-1');
    await f.requests.put(item.id, item);
  }
  assert.equal(f.requests.size, 2100);
  await f.service.pruneRequests();
  assert.ok(f.requests.size <= 2000, `expected the delivery state to shrink, it holds ${f.requests.size}`);
  assert.ok(f.requests.get('collab-send-2099'), 'the newest record survives');
  assert.equal(f.requests.get('collab-send-0'), undefined, 'the oldest record is pruned');
});

test('the delivery receipt projection keeps only the newest receipts', () => {
  let state = { receipts: {} };
  for (let index = 0; index < 1200; index += 1) {
    state = receiptFold(state, { type: 'agent/inbox/spliced', seq: index, data: { inserted: [{ id: `collab-message-${index}` }] } });
  }
  // The fold compacts in batches, so the record may hold one batch over the cap, never more.
  const count = Object.keys(state.receipts).length;
  assert.ok(count <= MAX_RECEIPTS + RECEIPTS_SLACK, `expected at most ${MAX_RECEIPTS + RECEIPTS_SLACK} receipts, found ${count}`);
  assert.ok(state.receipts['collab-message-1199'], 'the newest receipt survives');
  assert.equal(state.receipts['collab-message-0'], undefined, 'the oldest receipt is dropped');
});

test('the receipt projection still reports an admission that follows the splice', () => {
  let state = receiptFold({ receipts: {} }, { type: 'agent/inbox/spliced', seq: 2, data: { inserted: [{ id: 'collab-message-x' }] } });
  assert.equal(state.receipts['collab-message-x'].admittedSeq, null);
  state = receiptFold(state, { type: 'user/message', seq: 5, data: { id: 'collab-message-x' } });
  assert.equal(state.receipts['collab-message-x'].admittedSeq, 5);
  assert.equal(state.receipts['collab-message-x'].acceptedSeq, 2);
  assert.equal(receiptProjection.key, 'localSessionCollabReceipts');
});
