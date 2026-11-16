// Tests for the on-demand payload layer.
//
// Run with: node --test test/lazy.test.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import {
  byteWindow,
  clearHydration,
  estimateBytes,
  eventBytes,
  surfaceFloor,
  createLogIndex,
  createLogIndexSync,
  createTelemetryWriter,
  hydrationStats,
  isHydrated,
  lazyEvent,
  measuredParse,
  measuredSizeOf,
  setHydrationLimit,
  substituteLog,
} from '../lazy.mjs';

test('the parse-time bound never undercounts the full walk', () => {
  const shapes = [
    {},
    [1, 'x', null, true],
    { a: 'x', b: { c: [1, 2, { d: 'y' }] }, '': { e: '' } },
    { list: Array.from({ length: 40 }, (_, i) => ({ i, s: 's'.repeat(i) })) },
    { unicode: '中文'.repeat(50), nested: { arr: [[[]]] } },
    { rows: Array.from({ length: 2000 }, (_, i) => ({ i, s: 'abcdefghij' })) },
  ];
  for (const shape of shapes) {
    const line = JSON.stringify(shape);
    const bound = measuredSizeOf(measuredParse(line));
    assert.ok(bound >= estimateBytes(shape), `bound ${bound} covers walk ${estimateBytes(shape)}: ${line.slice(0, 40)}`);
    assert.ok(bound <= 44 * line.length + 64);
  }
});

/** Build a session log: a header record, then `count` events spread over `frames` zstd frames. */
function buildLog(dir, { count = 120, frames = 6, payload = 300 } = {}) {
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  const events = [];
  for (let seq = 0; seq < count; seq += 1) {
    const type = seq % 3 === 0 ? 'tool/result' : seq % 3 === 1 ? 'assistant/message' : 'user/message';
    events.push({
      type,
      seq,
      time: 1_700_000_000_000 + seq,
      data: {
        turn: Math.floor(seq / 10),
        step: seq % 10,
        message: { role: 'assistant', content: [{ type: 'text', text: `${seq}:`.padEnd(payload, 'x') }] },
      },
    });
  }
  const header = JSON.stringify({ type: 'session', id: 'test', createdAt: 1 });
  const lines = [header, ...events.map((event) => JSON.stringify(event))];
  const perFrame = Math.ceil(lines.length / frames);
  const chunks = [];
  for (let at = 0; at < lines.length; at += perFrame) {
    const slice = lines.slice(at, at + perFrame);
    chunks.push(zlib.zstdCompressSync(Buffer.from(`${slice.join('\n')}\n`, 'utf8')));
  }
  fs.writeFileSync(file, Buffer.concat(chunks));
  // `all` mirrors what a log rehydrated from disk contains: the seq-less header record first, so
  // array position and event seq differ by one from the very first event.
  return { file, events, all: [{ type: 'session', id: 'test', createdAt: 1 }, ...events], frames: chunks.length };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reaper-lazy-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('indexes every event across independent zstd frames', () => {
  const { file, events, frames } = buildLog(tmp, { count: 120, frames: 6 });
  const index = createLogIndexSync(file);
  assert.equal(index.frameCount, frames, 'one index entry per frame');
  assert.equal(index.events, events.length, 'every event is indexed');
  assert.equal(index.scannedTo, fs.statSync(file).size, 'the whole file is consumed');
  assert.equal(index.complete, true);
  index.close();
});

test('hydrates each event byte-identically from its own frame', () => {
  const { file, events } = buildLog(tmp, { count: 120, frames: 6 });
  const index = createLogIndexSync(file);
  for (const expected of events) {
    assert.equal(JSON.stringify(index.hydrate(expected.seq)), JSON.stringify(expected), `seq ${expected.seq}`);
  }
  index.close();
});

test('hydration survives payloads far larger than one frame boundary case', () => {
  const { file, events } = buildLog(path.join(tmp), { count: 12, frames: 1, payload: 20000 });
  const index = createLogIndexSync(file);
  assert.equal(JSON.stringify(index.hydrate(7)), JSON.stringify(events[7]));
  index.close();
});

test('substituted events stay identical through their getters', () => {
  const { file, events } = buildLog(tmp, { count: 60, frames: 4 });
  const index = createLogIndexSync(file);
  const log = events.map((event) => structuredClone(event));
  const keepFrom = 40;
  const result = substituteLog(log, index, { keepFrom, types: ['tool/result', 'assistant/message'] });
  assert.equal(result.failures, 0);
  assert.ok(result.substituted > 0, 'something was substituted');
  for (let seq = 0; seq < keepFrom; seq += 1) {
    assert.equal(JSON.stringify(log[seq]), JSON.stringify(events[seq]), `seq ${seq}`);
  }
  for (let seq = keepFrom; seq < log.length; seq += 1) {
    assert.notEqual(log[seq].__lazy, true, 'recent events stay resident');
  }
  index.close();
});

test('the hydration cache holds exactly its bound', () => {
  const { file, events } = buildLog(tmp, { count: 60, frames: 4 });
  const index = createLogIndexSync(file);
  setHydrationLimit(8);
  clearHydration();
  const log = events.map((event) => structuredClone(event));
  substituteLog(log, index, { keepFrom: 50, types: ['tool/result', 'assistant/message'] });
  for (let seq = 0; seq < 50; seq += 1) void log[seq].data;
  assert.equal(hydrationStats().cached, 8, 'the cache holds exactly its bound after a sequential pass');
  setHydrationLimit(256);
  clearHydration();
  index.close();
});

test('a second substitution over the same index skips the views it owns', () => {
  const { file, events } = buildLog(tmp, { count: 60, frames: 4 });
  const index = createLogIndexSync(file);
  const log = events.map((event) => structuredClone(event));
  const first = substituteLog(log, index, { keepFrom: 50, types: ['tool/result', 'assistant/message'] });
  const view = log[3];
  void view.data;
  const again = substituteLog(log, index, { keepFrom: 50, types: ['tool/result', 'assistant/message'] });
  assert.equal(again.substituted, 0, 'nothing is re-wrapped on a repeat pass');
  assert.equal(again.skipped, first.substituted, 'every owned view is skipped');
  assert.equal(log[3], view, 'the view object survives, so no closure generation is leaked');
  assert.equal(JSON.stringify(log[3]), JSON.stringify(events[3]));
  index.close();
});

test('a reload rebinds existing views to the new index', () => {
  const { file, events } = buildLog(tmp, { count: 60, frames: 4 });
  const index = createLogIndexSync(file);
  const log = events.map((event) => structuredClone(event));
  substituteLog(log, index, { keepFrom: 50, types: ['tool/result', 'assistant/message'] });
  const view = log[3];
  void view.data;
  clearHydration();
  // A plugin reload builds a fresh index, so its `hydrate` is a different function: the owner token
  // must differ and the views must be rebuilt, or the old module's cache keeps what it hydrated.
  const reloaded = createLogIndexSync(file);
  const out = substituteLog(log, reloaded, { keepFrom: 50, types: ['tool/result', 'assistant/message'] });
  assert.ok(out.substituted > 0, 'views bound to the previous index are rebuilt');
  assert.equal(out.skipped, 0);
  assert.notEqual(log[3], view, 'the stale view is replaced');
  assert.equal(hydrationStats().cached, 0, 'hydration starts empty for the new index');
  assert.equal(JSON.stringify(log[3]), JSON.stringify(events[3]));
  assert.equal(hydrationStats().cached, 1, 'the rebuilt view hydrates through the new index');
  clearHydration();
  reloaded.close();
  index.close();
});

test('a log that starts with a seq-less header still hydrates the right event', () => {
  const { file, all } = buildLog(tmp, { count: 40, frames: 3 });
  const index = createLogIndexSync(file);
  const log = all.map((event) => structuredClone(event));
  const out = substituteLog(log, index, { keepFrom: log.length, types: ['tool/result', 'assistant/message'] });
  assert.ok(out.substituted > 0, 'the message events were substituted');
  // Before keying on `event.seq` this hydrated the neighbouring event for every slot: the header
  // record has no seq, so position and seq differ by one for the whole log.
  for (let i = 1; i < log.length; i += 1) {
    assert.equal(JSON.stringify(log[i]), JSON.stringify(all[i]), `slot ${i} must hold seq ${all[i].seq}`);
  }
  index.close();
});

test('two sessions with the same seq never share a payload', () => {
  const dirA = fs.mkdtempSync(path.join(tmp, 'a-'));
  const dirB = fs.mkdtempSync(path.join(tmp, 'b-'));
  const a = buildLog(dirA, { count: 30, frames: 3, payload: 120 });
  const b = buildLog(dirB, { count: 30, frames: 3, payload: 120 });
  const indexA = createLogIndexSync(a.file);
  const indexB = createLogIndexSync(b.file);
  clearHydration();
  const logA = a.events.map((event) => structuredClone(event));
  const logB = b.events.map((event) => structuredClone(event));
  substituteLog(logA, indexA, { keepFrom: logA.length, types: ['tool/result', 'assistant/message'] });
  substituteLog(logB, indexB, { keepFrom: logB.length, types: ['tool/result', 'assistant/message'] });
  // Every session numbers its events from zero, so a seq-only cache key answered one session's
  // read with the other session's bytes: valid JSON, right schema, wrong content.
  assert.equal(JSON.stringify(logA[4]), JSON.stringify(a.events[4]), 'session A read first');
  assert.equal(JSON.stringify(logB[4]), JSON.stringify(b.events[4]), 'session B must not see A');
  clearHydration();
  assert.equal(JSON.stringify(logB[4]), JSON.stringify(b.events[4]), 'session B read first');
  assert.equal(JSON.stringify(logA[4]), JSON.stringify(a.events[4]), 'session A must not see B');
  clearHydration();
  indexA.close();
  indexB.close();
  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
});

test('unknown top-level fields survive substitution', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'x-'));
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  const events = [
    { type: 'tool/result', seq: 0, time: 5, data: { text: 'a'.repeat(400) }, surfaceOp: 'append', ignorable: true, futureField: { n: 1 } },
    { type: 'assistant/message', seq: 1, time: 6, data: { text: 'b'.repeat(400) } },
  ];
  const lines = [JSON.stringify({ type: 'session', id: 'x', createdAt: 1 }), ...events.map((e) => JSON.stringify(e))];
  fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(`${lines.join('\n')}\n`, 'utf8')));
  const index = createLogIndexSync(file);
  const log = events.map((event) => structuredClone(event));
  substituteLog(log, index, { keepFrom: log.length, types: ['tool/result', 'assistant/message'] });
  // Key order, `ignorable`, and a field this module has never heard of must all survive: dropping
  // `ignorable` alone makes a reader refuse the session instead of skipping the record.
  assert.deepEqual(Object.keys(log[0]), Object.keys(events[0]));
  assert.equal(JSON.stringify(log[0]), JSON.stringify(events[0]));
  assert.equal(log[0].ignorable, true);
  assert.deepEqual(log[0].futureField, { n: 1 });
  index.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a cold scan spreads across advances and finishes the same table', () => {
  const { file } = buildLog(tmp, { count: 400, frames: 200 });
  const stepwise = createLogIndex(file);
  const first = stepwise.advance(0);
  assert.equal(first.complete, false, 'the budget stopped the scan');
  assert.ok(first.added > 0 && first.added < 200, `advanced a slice (${first.added} frames)`);
  let guard = 0;
  while (!stepwise.complete && guard < 200) {
    stepwise.advance(0);
    guard += 1;
  }
  assert.equal(stepwise.complete, true, 'resuming finishes the scan');
  const oneShot = createLogIndexSync(file);
  assert.equal(stepwise.frameCount, oneShot.frameCount);
  assert.equal(stepwise.lastSeq, oneShot.lastSeq);
  assert.equal(JSON.stringify(stepwise.hydrate(17)), JSON.stringify(oneShot.hydrate(17)));
  stepwise.close();
  oneShot.close();
});

test('the frame table round-trips through the cache file', () => {
  const { file } = buildLog(tmp, { count: 300, frames: 120 });
  const cacheFile = path.join(tmp, 'index.cache');
  const first = createLogIndexSync(file, { cacheFile });
  assert.equal(first.adopted, false, 'nothing to adopt on the first open');
  assert.equal(first.saveCache(), true);
  const count = first.frameCount;
  const reopened = createLogIndex(file, { cacheFile });
  // The point of the cache: a Host restart re-reads a 3 MB table instead of the whole log.
  assert.equal(reopened.adopted, true, 'the second open adopts the cached table');
  // All but the record that ended at the end of the file: that one was accepted on structure alone,
  // so it is re-read rather than trusted.
  assert.equal(reopened.frameCount, count - 1, 'without rescanning');
  reopened.advance(Infinity);
  assert.equal(reopened.frameCount, count, 'the re-read tail frame comes back');
  assert.equal(JSON.stringify(reopened.hydrate(9)), JSON.stringify(first.hydrate(9)));
  first.close();
  reopened.close();
});

test('a log that grew is extended instead of rescanned', () => {
  const { file, events } = buildLog(tmp, { count: 40, frames: 8 });
  const cacheFile = path.join(tmp, 'grow.cache');
  const index = createLogIndexSync(file, { cacheFile });
  const before = index.frameCount;
  index.saveCache();
  // Append the way the Host does: new independent zstd frames after the existing ones.
  const extra = events.slice(36).map((event, k) => ({
    ...event,
    seq: 40 + k,
    time: 2_000 + k,
    data: { text: `tail-${k}`.padEnd(200, 'y') },
  }));
  fs.appendFileSync(file, zlib.zstdCompressSync(Buffer.from(`${extra.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8')));
  const advanced = index.advance(Infinity);
  assert.ok(advanced.added > 0, 'only the appended frames are decoded');
  assert.ok(index.frameCount > before, 'the table grew');
  assert.equal(index.lastSeq, 43, 'the tail is now addressable');
  assert.equal(JSON.stringify(index.hydrate(43).data.text).includes('tail-3'), true);
  index.close();
});

test('a finished table keeps up with frames appended by a running session', () => {
  const { file, events } = buildLog(tmp, { count: 40, frames: 8 });
  const index = createLogIndexSync(file);
  assert.equal(index.complete, true, 'the cold scan consumed the whole file');
  assert.equal(index.scanState(), 'idle', 'nothing to do while the log is unchanged');

  const extra = { ...events[0], seq: 40, time: 3_000, data: { text: 'late'.padEnd(200, 'z') } };
  fs.appendFileSync(file, zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(extra)}\n`, 'utf8')));
  // Before this the scheduler asked only `!index.complete`, so a table that had reached end of file
  // was never extended again: every event written after that point stayed a resident object until
  // the Host restarted.
  assert.equal(index.scanState(), 'advance', 'growth is work even for a finished table');

  const added = index.advance(Infinity);
  assert.ok(added.added > 0, 'the appended frame is decoded, not the whole file');
  assert.equal(index.scanState(), 'idle', 'the table now covers the file again');
  assert.equal(index.lastSeq, 40, 'the new event is addressable');
  assert.match(index.hydrate(40).data.text, /^late/);
  assert.equal(JSON.stringify(index.hydrate(7)), JSON.stringify(events[7]), 'old frames still decode');
  index.close();
});

test('a table whose log shrank is rejected instead of trusted', () => {
  const { file } = buildLog(tmp, { count: 40, frames: 8 });
  const index = createLogIndexSync(file);
  const size = fs.statSync(file).size;
  // A rewritten or cleared log keeps the file name but moves every byte the table points at.
  fs.truncateSync(file, Math.floor(size / 3));
  assert.equal(index.scanState(), 'rewound');
  assert.equal(index.has(20), false, 'a stale table must not claim a frame');
  assert.throws(() => index.hydrate(20), /rewritten: the frame table is stale/);
  index.close();
});

test('events that are not on disk yet are left resident', () => {
  const { file, events } = buildLog(tmp, { count: 20, frames: 4 });
  const index = createLogIndexSync(file);
  const log = events.map((event) => structuredClone(event));
  // The runtime log runs ahead of the file: pretend two events were appended in this tick and the
  // writer has not flushed a frame for them yet.
  log.push({ type: 'tool/result', seq: 20, time: 1, data: { text: 'not flushed' } });
  log.push({ type: 'assistant/message', seq: 21, time: 2, data: { text: 'not flushed either' } });
  const out = substituteLog(log, index, { keepFrom: log.length, types: ['tool/result', 'assistant/message'] });
  // Substituting them would hand out a view that throws on first read.
  assert.equal(out.pending, 2, 'the unpersisted tail is reported, not substituted');
  assert.notEqual(log[20].__lazy, true);
  assert.equal(log[20].data.text, 'not flushed');
  index.close();
});

test('a resumed pass only scans what became eligible', () => {
  const { file, events } = buildLog(tmp, { count: 60, frames: 4 });
  const index = createLogIndexSync(file);
  const log = events.map((event) => structuredClone(event));
  const types = ['tool/result', 'assistant/message'];
  const first = substituteLog(log, index, { keepFrom: 40, types });
  assert.equal(first.scanned, 40, 'the first pass scans the whole eligible range');
  const second = substituteLog(log, index, { keepFrom: 50, types, from: 40 });
  // Rescanning the decided prefix was ~270 ms of loop time per tick across nine real sessions.
  assert.equal(second.scanned, 10, 'only the newly eligible range is scanned');
  assert.equal(second.skipped, 0, 'the substituted prefix is not revisited');
  assert.ok(second.substituted > 0, 'the new range is still substituted');
  assert.equal(JSON.stringify(log[45]), JSON.stringify(events[45]));
  index.close();
});

test('the floor is the oldest surface node, and the system head does not count', () => {
  // The surface of a real compacted session: the retained head, then unshadowed conversation nodes.
  // A summary appended at the tail shadows only its own range, so the tail seq says nothing about
  // what is still readable — the nodes start at 10,731 while the newest summary sits near 13,600.
  assert.equal(surfaceFloor([0, 10_731, 10_800, 13_126, 13_587], true), 10_731);
  // A rewritten head keeps node 0 but carries a newer seq; it must not raise the floor either.
  assert.equal(surfaceFloor([13_900, 10_731, 13_126], true), 10_731);
});

test('without a system head the first node is the floor', () => {
  assert.equal(surfaceFloor([7, 9, 11], false), 7);
});

test('an empty or unreadable surface has no floor', () => {
  assert.equal(surfaceFloor([], true), null);
  assert.equal(surfaceFloor(undefined, true), null);
  assert.equal(surfaceFloor([12], true), null, 'only a head left means nothing to keep for compaction');
  assert.equal(surfaceFloor([12, 'x', 14], false), 12, 'non-integer entries are ignored');
});

test('the window starts at the surface floor, so compaction reads resident nodes', () => {
  const { file, events } = buildLog(tmp, { count: 60, frames: 4 });
  const index = createLogIndexSync(file);
  const log = events.map((event) => structuredClone(event));
  // keepLastEvents 5 would start residency at 55, but the surface still holds nodes from seq 30 on:
  // those are exactly what the next compaction summarizes and what the next prompt reads.
  const keepFrom = Math.min(log.length - 5, surfaceFloor([30, 31, 40, 58, 59], false));
  assert.equal(keepFrom, 30);
  substituteLog(log, index, { keepFrom, types: '*' });
  assert.equal(log[29].__lazy, true, 'below every surface node: released');
  assert.equal(log[30].__lazy, undefined, 'a surface node stays resident');
  assert.equal(log[59].__lazy, undefined);
  index.close();
});

test("types '*' releases a payload the default list leaves resident", () => {
  const { file, events } = buildLog(tmp, { count: 30, frames: 3 });
  const index = createLogIndexSync(file);
  const log = events.map((event) => structuredClone(event));
  const out = substituteLog(log, index, { keepFrom: log.length, types: '*' });
  const user = log.find((event) => event.type === 'user/message');
  assert.equal(user.__lazy, true, 'every type is eligible');
  assert.ok(out.substituted > 0);
  const plain = events.map((event) => structuredClone(event));
  substituteLog(plain, index, { keepFrom: plain.length, types: ['tool/result', 'assistant/message'] });
  assert.notEqual(plain.find((event) => event.type === 'user/message').__lazy, true, 'the list still filters');
  index.close();
});

test('lazyEvent keeps identity fields readable without hydrating', () => {
  const { file, events } = buildLog(tmp, { count: 20, frames: 2 });
  const index = createLogIndexSync(file);
  clearHydration();
  const view = lazyEvent(events[5], 5, index.hydrate);
  assert.equal(view.type, events[5].type);
  assert.equal(view.seq, 5);
  assert.equal(view.time, events[5].time);
  assert.equal(hydrationStats().cached, 0, 'identity reads must not load the payload');
  assert.equal(isHydrated(5, index.hydrate), false);
  void view.data;
  assert.equal(isHydrated(5, index.hydrate), true);
  index.close();
});

// ---- frames that are not fully on disk, and tables that outlive their log ----------------------

/** One frame holding `lines`, newline-terminated, exactly as the Host writes them. */
function frameOf(lines) {
  return zlib.zstdCompressSync(Buffer.from(`${lines.join('\n')}\n`, 'utf8'));
}

function scratch(name) {
  const dir = fs.mkdtempSync(path.join(tmp, `${name}-`));
  return { dir, file: path.join(dir, 'session.v4.jsonl.zstd') };
}

function plainEvents(count, size = 400) {
  return Array.from({ length: count }, (_, seq) => ({
    type: 'tool/result',
    seq,
    time: 1_700_000_000_000 + seq,
    data: { text: `${seq}:`.padEnd(size, 'z') },
  }));
}

test('a frame that is only half on disk is not indexed, and lands when the rest arrives', () => {
  const { dir, file } = scratch('torn');
  const events = plainEvents(6);
  const frames = [
    frameOf([JSON.stringify({ type: 'session', id: 'torn' })]),
    frameOf([JSON.stringify(events[0]), JSON.stringify(events[1])]),
    frameOf([JSON.stringify(events[2]), JSON.stringify(events[3])]),
    frameOf([JSON.stringify(events[4]), JSON.stringify(events[5])]),
  ];
  fs.writeFileSync(file, Buffer.concat(frames.slice(0, 3)));
  // zstd decompresses a truncated frame WITHOUT an error: it returns the text it could produce. So
  // this half frame is indistinguishable from a complete one unless the table checks structure.
  const half = frames[3].subarray(0, Math.floor(frames[3].length / 2));
  fs.appendFileSync(file, half);
  const index = createLogIndex(file);
  const out = index.advance(Infinity);
  assert.equal(out.blocked, true, 'the scan stops at the half-written frame');
  assert.equal(index.complete, false, 'the table must not claim to cover the file');
  assert.equal(index.lastSeq, 3, 'only events from complete frames are indexed');
  assert.equal(index.has(4), false, 'an event in the torn frame is not readable yet');
  // The rest of the frame arrives. The pass must resume at the frame start, not inside it: resuming
  // mid-frame used to record a frame with no events and strand every later event for good.
  fs.appendFileSync(file, frames[3].subarray(half.length));
  index.advance(Infinity);
  assert.equal(index.complete, true);
  assert.equal(index.lastSeq, 5);
  assert.equal(JSON.stringify(index.hydrate(4)), JSON.stringify(events[4]));
  index.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a torn frame on a line boundary is refused or repaired when the rest lands', () => {
  const { dir, file } = scratch('healed');
  // Raw Zstd blocks avoid compressor-version-dependent cut points. Each block ends on a newline.
  const line = (seq) => {
    const event = { type: 'tool/result', seq, time: 1, data: { text: '' } };
    event.data.text = 'z'.repeat(4096 - 1 - JSON.stringify(event).length);
    const json = JSON.stringify(event);
    assert.equal(json.length + 1, 4096);
    return json;
  };
  const lines = Array.from({ length: 66 }, (_, seq) => line(seq));
  const plain = Buffer.from(`${lines.slice(2, 66).join('\n')}\n`);
  const frameHeader = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0x40]);
  const rawBlock = Buffer.from([0, 0, 0x10]); // 128 KiB, raw, not last
  const lastBlock = Buffer.from([1, 0, 0x10]);
  const wideFrame = Buffer.concat([frameHeader, rawBlock, plain.subarray(0, 131072), lastBlock, plain.subarray(131072)]);
  assert.deepEqual(zlib.zstdDecompressSync(wideFrame), plain);
  const frames = [
    frameOf([JSON.stringify({ type: 'session', id: 'heal' })]),
    frameOf(lines.slice(0, 2)),
    wideFrame,
    frameOf([JSON.stringify({ type: 'tool/result', seq: 66, time: 1, data: { text: 'last' } })]),
  ];
  const cut = frameHeader.length + rawBlock.length + 131072;
  let acceptsPartial = false;
  try {
    const text = zlib.zstdDecompressSync(wideFrame.subarray(0, cut)).toString('utf8');
    assert.equal(text.length, 131072);
    assert.ok(text.endsWith('\n'));
    acceptsPartial = true;
  } catch (error) {
    assert.equal(error.code, 'Z_BUF_ERROR', 'strict decoders must reject this truncated frame');
  }
  fs.writeFileSync(file, Buffer.concat([frames[0], frames[1], frames[2].subarray(0, cut)]));
  const index = createLogIndex(file);
  const first = index.advance(Infinity);
  assert.equal(first.complete, acceptsPartial, 'strict decoders refuse; tolerant decoders provisionally accept');
  const bogusEnd = index.scannedTo;
  assert.equal(index.lastSeq, acceptsPartial ? 33 : 1, 'only decodable complete lines are indexed');

  // Everything else arrives. The bytes at the old end do not begin with a frame, so the boundary is
  // refuted and the table is rebuilt: without that, every later frame stays unreachable for good.
  fs.appendFileSync(file, frames[2].subarray(cut));
  fs.appendFileSync(file, frames[3]);
  const second = index.advance(Infinity);
  // The repair must be local: undoing one record and rescanning it, not throwing the table away.
  assert.ok(second.added <= 2, `rescanned ${second.added} frames, expected the last one or two`);
  assert.equal(index.scannedTo, fs.statSync(file).size);
  assert.equal(index.complete, true);
  assert.ok(index.scannedTo > bogusEnd);
  assert.equal(index.lastSeq, 66, 'the rebuilt table covers the frame that was cut');
  // The decoder may merge the tail into the previous record, so count records rather than frames:
  // three records (header, first frame, the rest) is as valid as four.
  assert.ok(index.frameCount >= 3 && index.frameCount <= 4, `records ${index.frameCount}`);
  assert.equal(index.events, 67, 'every event is indexed once');
  assert.equal(index.hydrate(9).data.text.length, 4096 - 1 - JSON.stringify({ type: 'tool/result', seq: 9, time: 1, data: { text: '' } }).length);
  assert.equal(index.hydrate(66).data.text, 'last');
  index.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a log that spells the seq before the type is still indexed', () => {  const { dir, file } = scratch('reordered');
  const events = plainEvents(3);
  const lines = [JSON.stringify({ type: 'session', id: 'reordered' })];
  for (const event of events) {
    const { seq, type, time, data } = event;
    lines.push(JSON.stringify({ seq, type, time, data }));
  }
  fs.writeFileSync(file, frameOf(lines));
  const index = createLogIndexSync(file);
  assert.equal(index.events, events.length, 'key order is not part of the contract');
  assert.equal(index.lastSeq, 2);
  assert.equal(index.hydrate(1).data.text.length, 400);
  index.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a frame that carries no event is skipped instead of breaking the seq range', () => {
  const { dir, file } = scratch('emptyframe');
  const events = plainEvents(2);
  fs.writeFileSync(
    file,
    Buffer.concat([
      frameOf([JSON.stringify({ type: 'session', id: 'gap' })]),
      frameOf([JSON.stringify(events[0])]),
      frameOf([JSON.stringify({ type: 'session/note', text: 'no seq here' })]),
      frameOf([JSON.stringify(events[1])]),
    ]),
  );
  const index = createLogIndexSync(file);
  // The header frame is recorded (it is index 0); the event-less frame after it is not.
  assert.equal(index.frameCount, 3, 'the event-less frame is not recorded');
  assert.equal(index.lastSeq, 1);
  assert.equal(JSON.stringify(index.hydrate(1)), JSON.stringify(events[1]));
  index.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a cached table is rejected when the log was rewritten to the same length', () => {
  const { dir, file } = scratch('rewritten');
  const cacheFile = path.join(dir, 'table.idx');
  fs.writeFileSync(file, frameOf([JSON.stringify({ type: 'session', id: 'first' }), JSON.stringify(plainEvents(1)[0])]));
  const first = createLogIndex(file, { cacheFile });
  first.advance(Infinity);
  first.saveCache();
  first.close();

  // Same byte length, different bytes: every check the table had (`covered <= size`) still passed.
  const bytes = fs.readFileSync(file);
  const original = Buffer.from(bytes);
  bytes[20] ^= 0xff;
  fs.writeFileSync(file, bytes);
  const second = createLogIndex(file, { cacheFile });
  assert.equal(second.adopted, false, 'the offsets do not describe these bytes any more');
  assert.equal(second.frameCount, 0, 'nothing from the old table survives');
  second.close();
  fs.writeFileSync(file, original);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a cached table whose header disagrees with its records is rejected', () => {
  const { dir, file } = scratch('shape');
  const cacheFile = path.join(dir, 'table.idx');
  const events = plainEvents(4);
  fs.writeFileSync(file, Buffer.concat([frameOf([JSON.stringify(events[0])]), frameOf([JSON.stringify(events[1])]), frameOf([JSON.stringify(events[2])])]));
  const first = createLogIndex(file, { cacheFile });
  first.advance(Infinity);
  assert.equal(first.saveCache(), true);
  const frames = first.frameCount;
  first.close();

  // The header is written in a separate `write` from the records it claims, so a crash can leave the
  // two describing different tables. Resuming at a `covered` that is not the last record's end would
  // start the scan mid-frame, find no boundary there, and stall that session for good.
  const raw = fs.readFileSync(cacheFile);
  raw.writeDoubleLE(raw.readDoubleLE(8) - 1, 8);
  fs.writeFileSync(cacheFile, raw);
  const second = createLogIndex(file, { cacheFile });
  assert.equal(second.adopted, false, 'a header that does not match its records is not a table');
  assert.equal(second.frameCount, 0);
  second.advance(Infinity);
  assert.equal(second.frameCount, frames, 'a full rescan rebuilds it');
  second.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a table adopted onto a mid-frame offset is rebuilt instead of stalling', () => {
  const { dir, file } = scratch('midframe');
  const cacheFile = path.join(dir, 'table.idx');
  const events = plainEvents(5);
  fs.writeFileSync(file, Buffer.concat([0, 1, 2, 3, 4].map((k) => frameOf([JSON.stringify(events[k])]))));
  const first = createLogIndex(file, { cacheFile });
  first.advance(Infinity);
  const frames = first.frameCount;
  const lastSeq = first.lastSeq;
  assert.equal(first.saveCache(), true);
  first.close();

  // A table can reach disk while the log is being written, so its final offset may point inside a
  // frame rather than at the start of one. Nothing about the bytes there ever becomes decodable: a
  // scan resumed at that offset would sit in front of it forever, and every event after it would be
  // unreachable. The record keeps its shape (frames stay contiguous), so only decoding disproves it.
  const raw = fs.readFileSync(cacheFile);
  const count = raw.readUInt32LE(24);
  assert.ok(count >= 3, 'enough records to bend the tail of the table');
  const covered = raw.readDoubleLE(8);
  const record = (i) => 36 + i * 24;
  const broken = covered - 3;
  raw.writeDoubleLE(broken, record(count - 1));
  raw.writeDoubleLE(broken, record(count - 1) + 8);
  raw.writeDoubleLE(broken, record(count - 2) + 8);
  raw.writeDoubleLE(broken, 8);
  fs.writeFileSync(cacheFile, raw);

  const second = createLogIndex(file, { cacheFile });
  assert.equal(second.adopted, true, 'the offsets and the fingerprint still hold up');
  second.advance(Infinity);
  assert.equal(second.frameCount, frames, 'the bytes at the adopted offset do not decode, so it rescan');
  assert.equal(second.lastSeq, lastSeq);
  assert.equal(second.complete, true);
  second.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a log truncated under a live table stops claiming its events', () => {
  const { dir, file } = scratch('truncated');
  const cacheFile = path.join(dir, 'table.idx');
  // Incompressible payloads: the log must be larger than the 256 KB read window the cache digest
  // warms, otherwise the read is answered from a buffer read before the truncation and never fails.
  const events = plainEvents(40).map((event) => ({ ...event, data: { text: crypto.randomBytes(15_000).toString('base64') } }));
  const frames = [];
  for (let at = 0; at < events.length; at += 10) frames.push(frameOf(events.slice(at, at + 10).map((line) => JSON.stringify(line))));
  fs.writeFileSync(file, Buffer.concat(frames));
  const index = createLogIndex(file, { cacheFile });
  index.advance(Infinity);
  index.saveCache();
  const last = index.lastSeq;
  assert.ok(fs.statSync(file).size > 400_000, 'the log is larger than the read window');
  assert.ok(index.has(last));
  fs.truncateSync(file, Math.floor(fs.statSync(file).size / 3));
  // The read now finds fewer bytes than the table covers. That verdict has to retire the table:
  // otherwise `has` keeps saying yes and `close` persists offsets into a file that no longer has them.
  assert.throws(() => index.hydrate(last), /short read|stale/u);
  assert.equal(index.has(last), false, 'a failed read retires the table');
  index.close();
  const again = createLogIndex(file, { cacheFile });
  assert.equal(again.adopted, false, 'a retired table must not be adopted again');
  again.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('frames appended by a running session are appended to the cache file', () => {
  const { dir, file } = scratch('append');
  const cacheFile = path.join(dir, 'table.idx');
  const events = plainEvents(4);
  fs.writeFileSync(file, Buffer.concat([frameOf([JSON.stringify(events[0]), JSON.stringify(events[1])]), frameOf([JSON.stringify(events[2])])]));
  const first = createLogIndex(file, { cacheFile });
  first.advance(Infinity);
  first.saveCache();
  const before = fs.statSync(cacheFile).size;
  first.close();

  fs.appendFileSync(file, frameOf([JSON.stringify(events[3])]));
  const second = createLogIndex(file, { cacheFile });
  assert.equal(second.adopted, true);
  second.advance(Infinity);
  second.saveCache();
  // A 3.3 MB table used to be rewritten every 30 s to record a handful of frames. The record that
  // ends at the end of the file is held back (it cannot be re-verified), so one frame is one record.
  assert.equal(fs.statSync(cacheFile).size - before, 24, 'one frame is one appended record');
  second.close();

  const third = createLogIndex(file, { cacheFile });
  assert.equal(third.adopted, true);
  assert.equal(third.lastSeq, 2, 'the appended record was adopted');
  assert.equal(third.hydrate(2).data.text.length, 400);
  third.advance(Infinity);
  assert.equal(third.lastSeq, 3, 'the held-back tail frame is re-read');
  assert.equal(third.hydrate(3).data.text.length, 400);
  third.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- the hydration cache is bounded by bytes ---------------------------------------------------

test('the hydration cache stays inside its byte budget, not just its entry count', () => {
  clearHydration();
  setHydrationLimit(256, 1024 * 1024);
  const { dir, file } = scratch('bytes');
  const events = plainEvents(30, 100_000);
  fs.writeFileSync(file, frameOf(events.map((event) => JSON.stringify(event))));
  const index = createLogIndexSync(file);
  const log = events.map((event) => structuredClone(event));
  const types = ['tool/result'];
  for (let round = 0; round < 2; round += 1) {
    substituteLog(log, index, { keepFrom: log.length, types });
    for (const view of log) assert.equal(view.data.text.length, 100_000);
  }
  const stats = hydrationStats();
  // Each payload is ~200 KB of UTF-16, so the 1 MB budget holds a handful, not all 30.
  assert.ok(stats.bytes <= 1_200_000, `resident bytes ${stats.bytes} must stay near the budget`);
  assert.ok(stats.cached < 30, `only ${stats.cached} of 30 payloads stay resident`);
  index.close();
  setHydrationLimit(256, 64 * 1024 * 1024);
  clearHydration();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a single payload larger than the per-entry ceiling is served but never cached', () => {
  clearHydration();
  setHydrationLimit(8, 4 * 1024 * 1024); // ceiling: a quarter of the budget, 1 MB
  const { dir, file } = scratch('oversized');
  const events = plainEvents(2).map((event, seq) => (seq === 0 ? { ...event, data: { text: 'q'.repeat(600_000) } } : event));
  fs.writeFileSync(file, frameOf(events.map((event) => JSON.stringify(event))));
  const index = createLogIndexSync(file);
  const view = lazyEvent(events[0], 0, index.hydrate);
  assert.equal(view.data.text.length, 600_000, 'the read still returns the whole payload');
  assert.equal(isHydrated(0, index.hydrate), false, 'but it does not stay resident');
  assert.equal(hydrationStats().bytes, 0, 'and it does not count against the budget');
  index.close();
  setHydrationLimit(256, 64 * 1024 * 1024);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a payload of many medium children is bounded above, never undercounted', () => {
  clearHydration();
  setHydrationLimit(256, 8 * 1024 * 1024); // ceiling 2 MB
  const { dir, file } = scratch('manychildren');
  const rows = Array.from({ length: 15_000 }, (_, i) => ({ i, s: 'abcdefghij' }));
  const events = [{ type: 'tool/result', seq: 0, time: 1, data: { rows } }];
  fs.writeFileSync(file, frameOf(events.map((event) => JSON.stringify(event))));
  const index = createLogIndexSync(file);
  const view = lazyEvent(events[0], 0, index.hydrate);
  assert.equal(view.data.rows.length, 15_000);
  // The O(1) bound (44x line chars) exceeds the 2 MB ceiling for this ~375 KB line, so the payload
  // is served through the oversized single slot: never undercounted, never retained past budget.
  const stats = hydrationStats();
  assert.equal(stats.cached, 0);
  assert.equal(stats.bytes, 0);
  assert.equal(view.data.rows.length, 15_000, 'the single slot still serves repeat reads');
  index.close();
  setHydrationLimit(256, 64 * 1024 * 1024);
  clearHydration();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('consecutive reads of one oversized payload reuse a single parse', () => {
  clearHydration();
  setHydrationLimit(8, 4 * 1024 * 1024); // ceiling 1 MB
  const real = { type: 'tool/result', seq: 0, time: 1, data: { text: 'q'.repeat(600_000) } };
  let calls = 0;
  const hydrate = (seq) => { calls += 1; assert.equal(seq, 0); return structuredClone(real); };
  const view = lazyEvent(real, 0, hydrate);
  assert.equal(view.data.text.length, 600_000);
  assert.equal(view.data.text.length, 600_000, 'a second read of the same oversized event');
  assert.equal(view.type, 'tool/result', 'another key of the same event');
  assert.equal(calls, 1, 'the oversized single slot served every key from one parse');
  assert.equal(isHydrated(0, hydrate), false, 'it is still not in the bounded LRU');
  setHydrationLimit(256, 64 * 1024 * 1024);
  clearHydration();
});



// The telemetry file is append-only and outlives every instance that writes it, so its rows have to
// stay in call order and a rotation must never swallow a row that was already queued.
test('telemetry rows land in call order even when every write is in flight at once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-telemetry-'));
  const file = path.join(dir, 'ticks.jsonl');
  let clock = 1_700_000_000_000;
  const write = createTelemetryWriter(file, { now: () => new Date((clock += 1000)).toISOString() });
  for (let index = 0; index < 40; index += 1) write({ tick: index, heapMB: 1000 + index });
  await write.flush();
  const rows = fs.readFileSync(file, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows.length, 40);
  assert.deepEqual(rows.map((row) => row.tick), Array.from({ length: 40 }, (_, index) => index));
  // The timestamp is the row's own clock, not the moment the write got its turn on disk.
  assert.deepEqual(rows.map((row) => row.at), Array.from({ length: 40 }, (_, index) => new Date(1_700_000_001_000 + index * 1000).toISOString()));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('telemetry rotates to a single previous generation without losing a queued row', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-telemetry-'));
  const file = path.join(dir, 'ticks.jsonl');
  const payload = { blob: 'x'.repeat(200) };
  // 2600 bytes puts exactly one rotation in the middle of this 20-row burst (each row is ~230 B).
  const write = createTelemetryWriter(file, { maxBytes: 2600 });
  for (let index = 0; index < 20; index += 1) write({ tick: index, ...payload });
  await write.flush();
  const current = fs.readFileSync(file, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
  const previous = fs.readFileSync(`${file}.1`, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
  assert.equal(fs.existsSync(`${file}.2`), false, 'rotation keeps one previous generation');
  assert.equal(current.length + previous.length, 20, 'every row is in exactly one generation');
  const ordered = [...previous, ...current].map((row) => row.tick);
  assert.deepEqual(ordered, Array.from({ length: 20 }, (_, index) => index), 'rotation keeps the call order');
  assert.ok(previous.length > 0 && current.length > 0, 'the burst straddled the rotation');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('eventBytes counts the payload and measures each event once', () => {
  const event = { type: 'tool/result', seq: 1, data: { text: 'x'.repeat(1000) } };
  const first = eventBytes(event);
  assert.ok(first >= 2000, 'a 1000-character payload is at least two bytes per character');
  // The answer is remembered: a tick re-measuring the same window must not walk it again.
  event.data.text = 'y';
  assert.equal(eventBytes(event), first);
});

test('byteWindow trims the start until the tail fits the budget', () => {
  const log = Array.from({ length: 10 }, (_, seq) => ({ type: 'user/message', seq, data: { text: 'x'.repeat(100) } }));
  const full = byteWindow(log, 0, Infinity);
  assert.equal(full.from, 0, 'no budget, no trim');
  assert.ok(full.bytes >= 2000, 'ten 100-character payloads');
  const half = byteWindow(log, 0, Math.floor(full.bytes / 2));
  assert.ok(half.from > 0, 'the window starts later than the count alone would');
  assert.ok(half.bytes <= full.bytes / 2, 'and fits the budget');
});

test('byteWindow keeps the newest event even when it alone exceeds the budget', () => {
  const log = [{ type: 'tool/result', seq: 0, data: { text: 'x'.repeat(100000) } }];
  const fit = byteWindow(log, 0, 1000);
  assert.equal(fit.from, 0, 'an empty window would cost a disk read per write');
  assert.ok(fit.bytes > 1000);
});

test('a released event answers with the size measured before it was released', () => {
  const { file, events } = buildLog(tmp, { count: 12, frames: 3, payload: 200 });
  const index = createLogIndexSync(file);
  const log = events.map((event) => structuredClone(event));
  const before = eventBytes(log[3]);
  substituteLog(log, index, { keepFrom: 12, types: ['tool/result', 'assistant/message'], from: 0 });
  assert.equal(log[3].__lazy, true);
  assert.equal(eventBytes(log[3]), before, 'measuring a view must not hydrate it');
  index.close();
});
