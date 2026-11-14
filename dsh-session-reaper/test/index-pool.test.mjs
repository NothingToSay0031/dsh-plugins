/** Regression coverage for the stable-handle, bounded heavy-index pool. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { createLogIndexPool } from '../index-pool.mjs';
import { clearHydration, lazyEvent, substituteLog } from '../lazy.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-index-pool-test-'));
test.after(() => {
  clearHydration();
  assert.equal(path.dirname(root), os.tmpdir());
  assert.ok(path.basename(root).startsWith('dsh-index-pool-test-'));
  fs.rmSync(root, { recursive: true, force: true });
});
let counter = 0;
function fixture(text, count = 10) {
  const dir = path.join(root, String(++counter));
  fs.mkdirSync(dir);
  const file = path.join(dir, 'session.zstd');
  const cacheFile = path.join(dir, 'table.idx');
  const events = Array.from({ length: count }, (_, seq) => ({ type: 'tool/result', seq, time: seq, data: { text: `${text}-${seq}` } }));
  const frame = (obj) => zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(obj)}\n`));
  fs.writeFileSync(file, frame({ type: 'session', id: text, createdAt: 1 }));
  for (const event of events) fs.appendFileSync(file, frame(event));
  return { file, cacheFile, events, frame };
}
function ready(pool, source) {
  const handle = pool.createHandle(source.file, { cacheFile: source.cacheFile });
  pool.use(handle, index => { index.advance(Infinity); index.saveCache(); });
  return handle;
}

test('old lazy views read identical payloads after their heavy index is evicted', () => {
  const a = fixture('A'), b = fixture('B');
  const pool = createLogIndexPool({ maxEntries: 1, maxBytes: 2 ** 24 });
  try {
    const owner = ready(pool, a);
    const view = lazyEvent(a.events[0], 0, owner.hydrate);
    ready(pool, b);
    assert.equal(pool.has(owner), false);
    assert.deepEqual(view.data, a.events[0].data);
    assert.equal(view.__owner, owner.hydrate);
    assert.equal(pool.stats().entries, 1);
  } finally { pool.close(); clearHydration(); }
});

test('each incremental pass keeps the same owner across repeated LRU eviction', () => {
  const a = fixture('growing', 60), b = fixture('other');
  const pool = createLogIndexPool({ maxEntries: 1, maxBytes: 2 ** 24 });
  try {
    const owner = ready(pool, a), other = ready(pool, b);
    const log = a.events.map(e => structuredClone(e));
    let from = 0;
    for (let end = 10; end <= log.length; end += 10) {
      pool.use(owner, index => {
        if (!index.has(end - 1)) index.advance(Infinity);
        substituteLog(log, index, { keepFrom: end, from, types: '*', hydrate: owner.hydrate });
      });
      pool.use(other, () => {});
      from = end;
    }
    assert.equal(new Set(log.map(e => e.__owner)).size, 1);
    assert.equal(log[0].__owner, owner.hydrate);
    assert.equal(log.at(-1).__owner, owner.hydrate);
    assert.deepEqual(log[59].data, a.events[59].data, 'the held-back final frame is acquired on a cold read');
  } finally { pool.close(); clearHydration(); }
});

test('different sessions with the same sequence never share a hydrated payload', () => {
  const a = fixture('alpha'), b = fixture('beta');
  const pool = createLogIndexPool({ maxEntries: 1, maxBytes: 2 ** 24 });
  try {
    const ha = ready(pool, a), hb = ready(pool, b);
    const va = lazyEvent(a.events[3], 3, ha.hydrate), vb = lazyEvent(b.events[3], 3, hb.hydrate);
    assert.equal(va.data.text, 'alpha-3');
    assert.equal(vb.data.text, 'beta-3');
    assert.equal(va.data.text, 'alpha-3');
  } finally { pool.close(); clearHydration(); }
});

test('close releases every warm table but residual lazy views remain readable', () => {
  const a = fixture('unloaded');
  const pool = createLogIndexPool({ maxEntries: 4, maxBytes: 2 ** 24 });
  const handle = ready(pool, a);
  const view = lazyEvent(a.events[8], 8, handle.hydrate);
  pool.close();
  clearHydration();
  assert.deepEqual(view.data, a.events[8].data);
  assert.equal(pool.stats().entries, 0);
  assert.equal(pool.stats().bytes, 0);
  assert.equal(pool.stats().coldOnly, true);
  clearHydration();
});

test('a table exceeding the byte budget is served ephemerally, not retained', () => {
  const a = fixture('oversize');
  const pool = createLogIndexPool({ maxEntries: 4, maxBytes: 1 });
  try {
    const handle = ready(pool, a);
    assert.equal(pool.stats().entries, 0);
    assert.equal(handle.hydrate(7).data.text, 'oversize-7');
    assert.equal(pool.stats().entries, 0);
    assert.equal(pool.stats().bytes, 0);
  } finally { pool.close(); }
});

test('invalidating an owner also removes its already hydrated payload', () => {
  const a = fixture('stale');
  const pool = createLogIndexPool({ maxEntries: 1, maxBytes: 2 ** 24 });
  try {
    const owner = ready(pool, a);
    const view = lazyEvent(a.events[0], 0, owner.hydrate);
    assert.equal(view.data.text, 'stale-0');
    pool.invalidate(owner);
    assert.throws(() => view.data, /stale/);
    assert.equal(pool.stats().entries, 0);
  } finally { pool.close(); clearHydration(); }
});

test('a cold owner rejects a file rewritten in place, even when it is longer', () => {
  const a = fixture('original'), b = fixture('eviction');
  const pool = createLogIndexPool({ maxEntries: 1, maxBytes: 2 ** 24 });
  try {
    const owner = ready(pool, a);
    const view = lazyEvent(a.events[0], 0, owner.hydrate);
    ready(pool, b);
    const altered = fixture('different-file-with-longer-name', 40);
    fs.writeFileSync(a.file, fs.readFileSync(altered.file));
    assert.throws(() => view.data, /rewritten|stale/);
    assert.equal(pool.isInvalid(owner), true);
  } finally { pool.close(); clearHydration(); }
});

test('a cold owner accepts appended frames without changing its identity', () => {
  const a = fixture('append'), b = fixture('eviction');
  const pool = createLogIndexPool({ maxEntries: 1, maxBytes: 2 ** 24 });
  try {
    const owner = ready(pool, a);
    ready(pool, b);
    const next = { type: 'tool/result', seq: a.events.length, time: 100, data: { text: 'new-tail' } };
    fs.appendFileSync(a.file, a.frame(next));
    assert.deepEqual(owner.hydrate(next.seq).data, next.data);
  } finally { pool.close(); clearHydration(); }
});

test('synchronous nested leases pin the outer entry until its callback returns', () => {
  const a = fixture('outer'), b = fixture('inner');
  const pool = createLogIndexPool({ maxEntries: 1, maxBytes: 2 ** 24 });
  try {
    const ha = ready(pool, a), hb = ready(pool, b);
    pool.use(ha, index => {
      pool.use(hb, other => other.hydrate(0));
      assert.equal(pool.has(ha), true);
      assert.equal(index.hydrate(2).data.text, 'outer-2');
    });
    assert.equal(pool.stats().entries, 1);
    assert.throws(() => pool.use(ha, () => Promise.resolve()), /synchronous/);
  } finally { pool.close(); clearHydration(); }
});
