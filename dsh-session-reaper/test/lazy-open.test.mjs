// Tests for open-time lazy loading: marker tracking, frozen views, and the decode wrapper.
//
// Run with: node --test test/lazy-open.test.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import {
  clearHydration,
  createLogIndex,
  createLogIndexSync,
  freezeDeep,
  hydrationStats,
  lazyOpenEvent,
  makeEventGuard,
  setHydrationLimit,
  substituteLog,
} from '../lazy.mjs';
import { createLogIndexPool } from '../index-pool.mjs';
import { installLazyOpen, sessionIdOfLogPath } from '../lazy-open.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reaper-lazy-open-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const SESSION_ID = 'session-lazy-open-test';

/** Write one zstd session log under <dir>/<id>/session.v4.jsonl.zstd and return its path. */
function writeLog(dir, { id = SESSION_ID, header, lines, frames = 4 } = {}) {
  const sessionDir = path.join(dir, id);
  fs.mkdirSync(sessionDir, { recursive: true });
  const file = path.join(sessionDir, 'session.v4.jsonl.zstd');
  const all = [JSON.stringify(header ?? { type: 'session', version: 4, id, createdAt: 1, isSeeded: false, delegationDepth: 0 }), ...lines.map((line) => JSON.stringify(line))];
  const perFrame = Math.ceil(all.length / frames);
  const chunks = [];
  for (let at = 0; at < all.length; at += perFrame) {
    chunks.push(zlib.zstdCompressSync(Buffer.from(`${all.slice(at, at + perFrame).join('\n')}\n`, 'utf8')));
  }
  fs.writeFileSync(file, Buffer.concat(chunks));
  return file;
}

/** Events with enough INCOMPRESSIBLE payload to push the log past the wrapper's 1 MB floor.
 * Random base64 survives zstd at ~75% of its size; repeated text would compress to nothing. */
function bigEvents(count, { payload = 40000, startSeq = 0 } = {}) {
  const events = [];
  for (let i = 0; i < count; i += 1) {
    const seq = startSeq + i;
    events.push({
      type: 'tool/result',
      seq,
      time: 1_700_000_000_000 + seq,
      data: { turn: 1, step: 1, message: { role: 'tool', content: [{ type: 'text', text: crypto.randomBytes(payload).toString('base64') }] } },
    });
  }
  return events;
}

// ---- marker tracking and the v3 cache ----------------------------------------------------------

test('the scan records end-seed markers and the cache round-trips them', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'markers-'));
  const marker = (seq, inherited) => ({ type: 'session/end-seed', seq, time: 1, data: inherited ? { inherited: true } : {} });
  const events = [marker(0, true), marker(1, false), ...bigEvents(6, { payload: 200, startSeq: 2 })];
  const file = writeLog(dir, { lines: events });
  const cacheFile = path.join(dir, 'table.idx');
  const index = createLogIndex(file, { cacheFile });
  index.advance(Infinity);
  assert.deepEqual(index.endSeedMarkers.map(({ seq, inherited }) => ({ seq, inherited })), [
    { seq: 0, inherited: true },
    { seq: 1, inherited: false },
  ]);
  index.close();

  const adopted = createLogIndex(file, { cacheFile });
  assert.equal(adopted.adopted, true, 'the v3 table is adopted');
  assert.deepEqual(adopted.endSeedMarkers.map(({ seq, inherited }) => ({ seq, inherited })), [
    { seq: 0, inherited: true },
    { seq: 1, inherited: false },
  ]);
  // The last frame was accepted on structure alone, so the cache holds it back; one advance re-reads it.
  adopted.advance(Infinity);
  assert.equal(adopted.events, events.length);
  assert.equal(adopted.hydrate(4).seq, 4, 'an adopted table still hydrates');
  adopted.close();
});

test('a v2 cache file is rejected and rescanned once', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'v2-'));
  const file = writeLog(dir, { lines: bigEvents(4, { payload: 200 }) });
  const cacheFile = path.join(dir, 'table.idx');
  const first = createLogIndex(file, { cacheFile });
  first.advance(Infinity);
  first.close();
  // Rewrite the version word to 2: the layout is otherwise identical, but adoption must refuse it.
  const buffer = fs.readFileSync(cacheFile);
  buffer.writeUInt32LE(2, 4);
  fs.writeFileSync(cacheFile, buffer);
  const second = createLogIndex(file, { cacheFile });
  assert.equal(second.adopted, false);
  second.advance(Infinity);
  assert.equal(second.complete, true);
  second.close();
});

// ---- the open-time view ------------------------------------------------------------------------

test('lazyOpenEvent hydrates every envelope key, answers absent keys undefined, and stays frozen', () => {
  const real = { type: 'user/message', seq: 7, time: 42, data: { text: 'hi' } };
  let calls = 0;
  const hydrate = (seq) => {
    calls += 1;
    assert.equal(seq, 7);
    return freezeDeep(JSON.parse(JSON.stringify(real)));
  };
  const view = lazyOpenEvent(7, hydrate);
  assert.equal(Object.isFrozen(view), true);
  assert.equal(view.seq, 7, 'seq is resident, not a getter');
  assert.equal(calls, 0, 'construction hydrates nothing');
  assert.equal(view.type, 'user/message');
  assert.equal(view.time, 42);
  assert.deepEqual(view.data, { text: 'hi' });
  assert.equal(view.surfaceOp, undefined, 'absent keys answer undefined');
  assert.equal(view.ignorable, undefined);
  assert.equal(Object.isFrozen(view.data), true, 'hydrated payloads are deeply frozen');
  assert.throws(() => { view.data.text = 'changed'; }, TypeError);
  assert.equal(calls, 1, 'the LRU serves every key of one event from a single hydration');
  assert.deepEqual(Object.keys(view).sort(), ['data', 'ignorable', 'seq', 'sourceEventSeqs', 'surfaceOp', 'time', 'type']);
});

test('freezeDeep freezes nested objects and arrays', () => {
  const value = freezeDeep({ a: [1, { b: 'c' }], d: null });
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.a), true);
  assert.equal(Object.isFrozen(value.a[1]), true);
  assert.throws(() => { value.a[1].b = 'x'; }, TypeError);
});

// ---- the decode wrapper ------------------------------------------------------------------------

/** The event vocabulary the fake host understands; mirrors the role of KNOWN_SESSION_EVENT_TYPES. */
const TEST_KNOWN = new Set([
  'tool/result', 'assistant/message', 'user/message', 'system/message', 'developer/message',
  'request/header', 'session/end-seed', 'turn/start', 'turn/end', 'step/start', 'step/end',
]);

/** One fake jsonl backend plus the pool/handle wiring the wrapper needs. */
function harness(dir, { original, known = TEST_KNOWN } = {}) {
  const cacheDir = path.join(dir, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const pool = createLogIndexPool({ maxEntries: 4, maxBytes: 64 * 1048576 });
  const rows = [];
  const memoized = [];
  const backend = {
    name: 'session-persistence-jsonl',
    decodeStoredLog: original ?? (async () => ({ eager: true })),
    readStoredLog: async () => ({ eager: true }),
    assertStoredIdentity: async () => {},
    memoizeStoredLog: (id, stored) => memoized.push({ id, stored }),
  };
  const ctx = { get: (key) => (key === 'sessionPersistence' ? backend : undefined) };
  // The shared guard stands in for the host vocabulary the real wrapper resolves at runtime.
  // With no vocabulary, leave resolution pending so the wrapper attempts (and fails) it, exactly as
  // it would in a foreign environment, and records the empty-vocabulary telemetry row.
  const guard = { known, adopt: null, resolved: known != null };
  // One handle per file, cached exactly as index.js does, so the open-time views and a later tick
  // acquire the SAME handle and therefore the same hydrate owner.
  const handles = new Map();
  const handleForFile = (file, id) => {
    let handle = handles.get(file);
    if (handle && !pool.isInvalid(handle)) return handle;
    handle = pool.createHandle(file, {
      cacheFile: path.join(cacheDir, `${id}.idx`),
      validate: makeEventGuard(guard, file),
    });
    handles.set(file, handle);
    return handle;
  };
  const uninstall = installLazyOpen({
    ctx,
    cfg: { lazyOpenMinMB: 1, lazyOpenBudgetMs: 250 },
    pool,
    handleForFile,
    record: (row) => rows.push(row),
    guard,
  });
  return { backend, pool, rows, memoized, uninstall, cacheDir, guard, handleForFile };
}

test('a large complete log opens as frozen lazy views with the right meta and cut', async () => {
  clearHydration();
  setHydrationLimit(16, 4 * 1048576);
  const dir = fs.mkdtempSync(path.join(tmp, 'open-'));
  const events = bigEvents(40);
  const file = writeLog(dir, { lines: events });
  const { backend, rows, memoized, uninstall, pool } = harness(dir);
  assert.equal(typeof uninstall, 'function');

  const buffer = fs.readFileSync(file);
  const stored = await backend.decodeStoredLog(file, SESSION_ID, buffer, 'rev-1', undefined);
  assert.equal(stored.status, 'current');
  assert.equal(stored.eventState, 'shared-frozen');
  assert.equal(stored.tornTruncateTo, undefined);
  assert.deepEqual(stored.recoveredTail, []);
  assert.equal(stored.inheritedEventCount, 0);
  assert.equal(stored.revision, 'rev-1');
  assert.equal(stored.meta.id, SESSION_ID);
  assert.equal(stored.meta.version, 4);
  assert.equal(stored.meta.isSeeded, false);
  assert.equal(stored.events.length, events.length);
  assert.equal(Object.isFrozen(stored.events), true);
  assert.equal(memoized.length, 1, 'the lazy log is handed to the cold memo');

  // Host-shaped consumption: the seed validation reads every envelope field of every event.
  for (const [index, view] of stored.events.entries()) {
    assert.equal(view.__lazy, true);
    assert.equal(Object.isFrozen(view), true);
    assert.equal(view.seq, index);
    assert.equal(view.type, 'tool/result');
    assert.equal(view.time, 1_700_000_000_000 + index);
    assert.equal(typeof view.data.message.content[0].text, 'string');
    assert.ok(view.data.message.content[0].text.length > 0);
    assert.equal(Object.isFrozen(view.data), true);
  }
  const stats = hydrationStats();
  assert.ok(stats.cached <= 16, `the LRU stayed bounded during a full pass (${stats.cached})`);
  assert.ok(stats.bytes <= 4 * 1048576, 'the byte budget held during the full pass');
  assert.ok(rows.some((row) => row.event === 'lazy-open' && row.events === events.length));

  // A second decode at the same revision rebuilds from the adopted disk cache and still serves.
  const again = await backend.decodeStoredLog(file, SESSION_ID, buffer, 'rev-2', undefined);
  assert.equal(again.events.length, events.length);
  assert.equal(again.events[3].seq, 3);
  assert.ok(again.events[3].data.message.content[0].text.length > 0, 'the second decode still hydrates');

  uninstall();
  pool.close();
  clearHydration();
  setHydrationLimit(256, 64 * 1048576);
});

test('a seeded log derives its cut from the last inherited end-seed marker', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'seeded-'));
  const lines = [
    { type: 'session/end-seed', seq: 0, time: 1, data: { inherited: true } },
    ...bigEvents(30, { startSeq: 1 }),
    { type: 'session/end-seed', seq: 31, time: 2, data: { inherited: true } },
    ...bigEvents(10, { startSeq: 32 }),
  ];
  const file = writeLog(dir, {
    header: { type: 'session', version: 4, id: SESSION_ID, createdAt: 1, isSeeded: true, delegationDepth: 0 },
    lines,
  });
  const { backend, uninstall, pool } = harness(dir);
  const stored = await backend.decodeStoredLog(file, SESSION_ID, fs.readFileSync(file), 'rev-1', undefined);
  assert.equal(stored.inheritedEventCount, 31, 'the LAST inherited marker wins');
  assert.equal(stored.meta.isSeeded, true);
  assert.equal(stored.events.length, 42);
  uninstall();
  pool.close();
});

test('guards fall back to the original decode', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'fallback-'));
  const events = bigEvents(40);
  const file = writeLog(dir, { lines: events });
  const { backend, uninstall, pool } = harness(dir);
  const buffer = fs.readFileSync(file);

  // Below the size floor.
  const smallFile = writeLog(path.join(dir, 'small'), { id: 'session-small', lines: bigEvents(2, { payload: 100 }) });
  assert.deepEqual(await backend.decodeStoredLog(smallFile, 'session-small', fs.readFileSync(smallFile), 'r', undefined), { eager: true });

  // Not a zstd artifact.
  const plain = path.join(path.dirname(file), 'session.v4.jsonl');
  fs.copyFileSync(file, plain);
  assert.deepEqual(await backend.decodeStoredLog(plain, SESSION_ID, buffer, 'r', undefined), { eager: true });

  // The snapshot no longer matches the file (it grew between read and decode).
  assert.deepEqual(await backend.decodeStoredLog(file, SESSION_ID, buffer.subarray(0, buffer.length - 100), 'r', undefined), { eager: true });

  // A torn final frame: the original decoder owns the recovery.
  const tornDir = fs.mkdtempSync(path.join(tmp, 'torn-'));
  const tornFile = writeLog(tornDir, { id: 'session-torn', lines: bigEvents(40) });
  const partial = zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(bigEvents(1, { startSeq: 40 })[0])}\n`, 'utf8'));
  fs.appendFileSync(tornFile, partial.subarray(0, Math.floor(partial.length / 2)));
  assert.deepEqual(await backend.decodeStoredLog(tornFile, 'session-torn', fs.readFileSync(tornFile), 'r', undefined), { eager: true });

  // A seeded header without an inherited marker disagrees with the codec rule.
  const badSeedDir = fs.mkdtempSync(path.join(tmp, 'badseed-'));
  const badSeedFile = writeLog(badSeedDir, {
    id: 'session-badseed',
    header: { type: 'session', version: 4, id: 'session-badseed', createdAt: 1, isSeeded: true, delegationDepth: 0 },
    lines: bigEvents(40),
  });
  assert.deepEqual(await backend.decodeStoredLog(badSeedFile, 'session-badseed', fs.readFileSync(badSeedFile), 'r', undefined), { eager: true });

  // A header id that names another session.
  assert.deepEqual(await backend.decodeStoredLog(file, 'session-other', buffer, 'r', undefined), { eager: true });

  uninstall();
  pool.close();
});

test('the retired request/header fallback reason is refused at first read', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'retired-'));
  const lines = [
    { type: 'request/header', seq: 0, time: 1, data: { reason: 'fallback' } },
    ...bigEvents(40, { startSeq: 1 }),
  ];
  const file = writeLog(dir, { lines });
  const { backend, uninstall, pool } = harness(dir);
  const stored = await backend.decodeStoredLog(file, SESSION_ID, fs.readFileSync(file), 'r', undefined);
  assert.throws(() => stored.events[0].data, /fallback/);
  uninstall();
  pool.close();
});

test('uninstall restores the original, and a superseded install survives an older dispose', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'reload-'));
  const file = writeLog(dir, { lines: bigEvents(40) });
  const buffer = fs.readFileSync(file);
  const first = harness(dir);
  const lazyResult = await first.backend.decodeStoredLog(file, SESSION_ID, buffer, 'r', undefined);
  assert.equal(lazyResult.status, 'current');

  // A reload installs a second wrapper over the same backend.
  const rows2 = [];
  const second = installLazyOpen({
    ctx: { get: () => first.backend },
    cfg: { lazyOpenMinMB: 1, lazyOpenBudgetMs: 250 },
    pool: first.pool,
    handleForFile: (f, id) => first.pool.createHandle(f, {
      cacheFile: path.join(first.cacheDir, `${id}.idx`),
      validate: makeEventGuard(first.guard, f),
    }),
    record: (row) => rows2.push(row),
    guard: first.guard,
  });
  // The older instance disposes first: it must NOT restore over the newer wrapper.
  first.uninstall();
  const stillLazy = await first.backend.decodeStoredLog(file, SESSION_ID, buffer, 'r', undefined);
  assert.equal(stillLazy.status, 'current', 'the newer wrapper is still installed');
  second();
  assert.deepEqual(await first.backend.decodeStoredLog(file, SESSION_ID, buffer, 'r', undefined), { eager: true }, 'the true original is restored');
  first.pool.close();
});

test('an absent or foreign backend is left untouched', () => {
  const rows = [];
  const pool = createLogIndexPool({ maxEntries: 1, maxBytes: 1048576 });
  const deps = { cfg: { lazyOpenMinMB: 1, lazyOpenBudgetMs: 250 }, pool, handleForFile: () => {}, record: (r) => rows.push(r) };
  assert.equal(installLazyOpen({ ...deps, ctx: { get: () => undefined } }), null);
  assert.equal(installLazyOpen({ ...deps, ctx: { get: () => { throw new Error('inactive'); } } }), null);
  const foreign = { name: 'session-persistence-other', decodeStoredLog: async () => {}, readStoredLog: async () => {} };
  assert.equal(installLazyOpen({ ...deps, ctx: { get: () => foreign } }), null);
  pool.close();
});

test('sessionIdOfLogPath reads the id from the artifact directory', () => {
  assert.equal(sessionIdOfLogPath(path.join('root', 'sessions', 'group', 'session-abc', 'session.v4.jsonl.zstd')), 'session-abc');
});

// ---- the vocabulary gate the eager decoder owns --------------------------------------------------

test('an unknown required event type is refused at first read, like the eager decoder', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'unknown-'));
  const lines = [...bigEvents(40), { type: 'campaign/unknown', seq: 40, time: 1, data: {} }];
  const file = writeLog(dir, { lines });
  const { backend, uninstall, pool } = harness(dir);
  const stored = await backend.decodeStoredLog(file, SESSION_ID, fs.readFileSync(file), 'r', undefined);
  assert.equal(stored.status, 'current', 'the scan itself serves the log lazily');
  assert.equal(stored.events[0].type, 'tool/result', 'known events read normally');
  assert.throws(() => stored.events[40].type, /unknown to this harness/, 'the unknown required type is refused');
  uninstall();
  pool.close();
});

test('an unknown ignorable event type is accepted and stays opaque', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'ignorable-'));
  const lines = [...bigEvents(40), { type: 'campaign/unknown', seq: 40, time: 1, data: { opaque: 1 }, ignorable: true }];
  const file = writeLog(dir, { lines });
  const { backend, uninstall, pool } = harness(dir);
  const stored = await backend.decodeStoredLog(file, SESSION_ID, fs.readFileSync(file), 'r', undefined);
  assert.equal(stored.events[40].type, 'campaign/unknown');
  assert.deepEqual(stored.events[40].data, { opaque: 1 });
  assert.equal(stored.events[40].ignorable, true);
  uninstall();
  pool.close();
});

test('without a host vocabulary the wrapper falls back to the eager decode', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'novocab-'));
  const file = writeLog(dir, { lines: bigEvents(40) });
  const { backend, uninstall, pool, rows } = harness(dir, { known: null });
  const stored = await backend.decodeStoredLog(file, SESSION_ID, fs.readFileSync(file), 'r', undefined);
  assert.deepEqual(stored, { eager: true }, 'no vocabulary => no unvalidated lazy views');
  assert.ok(rows.some((row) => row.event === 'lazy-open-vocabulary' && row.known === 0));
  uninstall();
  pool.close();
});

// ---- owner identity: the tick must skip open-time views without hydrating them -------------------

test('open-time views share the handle owner and the tick skips them without reading type', async () => {
  clearHydration();
  const dir = fs.mkdtempSync(path.join(tmp, 'owner-'));
  const file = writeLog(dir, { lines: bigEvents(40) });
  const { backend, uninstall, pool, handleForFile } = harness(dir);
  const stored = await backend.decodeStoredLog(file, SESSION_ID, fs.readFileSync(file), 'r', undefined);
  const handle = handleForFile(file, SESSION_ID);
  assert.equal(stored.events[0].__owner, handle.hydrate, 'the view owner IS the handle hydrate the tick uses');
  clearHydration();
  const log = [...stored.events];
  const index = createLogIndexSync(file);
  // The tick filters on type, but a same-owner lazy view must be skipped before any type read.
  const out = substituteLog(log, index, { keepFrom: log.length, types: ['tool/result'], hydrate: handle.hydrate });
  assert.equal(out.skipped, log.length, 'every open-time view is skipped');
  assert.equal(out.substituted, 0, 'none is re-wrapped');
  assert.equal(hydrationStats().cached, 0, 'skipping hydrates nothing');
  index.close();
  uninstall();
  pool.close();
  clearHydration();
});

// ---- header strictness and seq density -----------------------------------------------------------

test('a header with an extra key falls back to the eager decode', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'hdr-'));
  const file = writeLog(dir, {
    header: { type: 'session', version: 4, id: SESSION_ID, createdAt: 1, isSeeded: false, delegationDepth: 0, sandboxMode: 'workspace-write' },
    lines: bigEvents(40),
  });
  const { backend, uninstall, pool } = harness(dir);
  assert.deepEqual(await backend.decodeStoredLog(file, SESSION_ID, fs.readFileSync(file), 'r', undefined), { eager: true });
  uninstall();
  pool.close();
});

test('a log with a duplicate seq is refused by the density guard and falls back', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'dense-'));
  // seq 2 appears twice and seq 3 is missing: the aggregate count still equals lastSeq + 1.
  const lines = bigEvents(40).map((event) => (event.seq === 3 ? { ...event, seq: 2 } : event));
  const file = writeLog(dir, { lines });
  const { backend, uninstall, pool } = harness(dir);
  assert.deepEqual(await backend.decodeStoredLog(file, SESSION_ID, fs.readFileSync(file), 'r', undefined), { eager: true });
  uninstall();
  pool.close();
});

// ---- real-host integration (runs only where the host Session module is resolvable) ---------------

test('real host: lazy views construct a Session and the vocabulary gate closes the unknown-type gap', async (t) => {
  let Session;
  let known;
  try {
    const mod = await import('@deepseek-ai/dsh-session');
    Session = mod.Session;
    known = mod.KNOWN_SESSION_EVENT_TYPES;
  } catch {
    // The test runner cannot resolve the host by bare specifier; an explicit host module anchor
    // (e.g. run under Electron-as-node with DSH_HOST_ANCHOR pointing at a host lib file) lets the
    // real-composition case execute instead of skipping.
    const anchor = process.env.DSH_HOST_ANCHOR;
    if (anchor) {
      try {
        const { createRequire } = await import('node:module');
        const { pathToFileURL } = await import('node:url');
        const resolved = createRequire(anchor).resolve('@deepseek-ai/dsh-session');
        const mod = await import(pathToFileURL(resolved).href);
        Session = mod.Session;
        known = mod.KNOWN_SESSION_EVENT_TYPES;
      } catch {
        /* anchor did not resolve; skip below */
      }
    }
    if (!Session) {
      t.skip('host @deepseek-ai/dsh-session is not resolvable from the test runner');
      return;
    }
  }
  const dir = fs.mkdtempSync(path.join(tmp, 'real-'));
  const id = 'session-real-host';
  const header = { type: 'session', version: 4, id, createdAt: 1, isSeeded: false, delegationDepth: 0 };
  // Host-valid message shapes: an identified message with role, source and content array.
  const system = {
    type: 'system/message', seq: 0, time: 1, surfaceOp: 'append',
    data: { message: { id: 'm0', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'hi' }] } },
  };
  const tools = Array.from({ length: 30 }, (_, i) => {
    const seq = i + 1;
    const callId = `c${seq}`;
    return {
      type: 'tool/result', seq, time: 1 + seq, surfaceOp: 'append',
      data: { turn: 1, step: 1, message: { id: `m${seq}`, role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content: [{ type: 'text', text: crypto.randomBytes(40000).toString('base64') }] } },
    };
  });
  const lines = [system, ...tools];
  const file = writeLog(dir, { id, header, lines });
  const { backend, uninstall, pool } = harness(dir, { known });
  const stored = await backend.decodeStoredLog(file, id, fs.readFileSync(file), 'r', undefined);
  assert.equal(stored.status, 'current');
  // The real constructor validates every envelope and folds the surface from the lazy views, then
  // appends its own resume `session/end-seed` marker (hence one more event than the seed).
  const session = Session.fromRestore(id, stored.events, stored.meta, stored.inheritedEventCount, stored.eventState);
  assert.equal(session.seq, lines.length + 1);
  assert.equal(session.eventAt(1).type, 'tool/result');
  assert.equal(session.eventAt(lines.length).type, 'session/end-seed');
  // A foreign required type the host vocabulary does not know must be refused by the lazy guard,
  // even though Session.fromRestore alone would not reject it.
  const foreign = writeLog(path.join(dir, 'foreign'), { id, header, lines: [...lines, { type: 'campaign/unknown', seq: lines.length, time: 1, data: {} }] });
  const foreignStored = await backend.decodeStoredLog(foreign, id, fs.readFileSync(foreign), 'r', undefined);
  assert.throws(() => foreignStored.events[lines.length].type, /unknown to this harness/);
  uninstall();
  pool.close();
});