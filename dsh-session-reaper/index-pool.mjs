/** A count- and byte-bounded owner of heavy log indexes.
 * Lazy events retain a stable lightweight handle, never an index generation.
 * All leases are synchronous; close() releases warm entries but keeps old views readable.
 */
import fs from 'node:fs';
import { clearHydration, createLogIndex } from './lazy.mjs';

/** Preserve a bounded prefix proof across table evictions; append-only writes keep it unchanged. */
function sourceProof(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const head = Buffer.alloc(Math.min(256, stat.size));
    fs.readSync(fd, head, 0, head.length, 0);
    return { dev: stat.dev, ino: stat.ino, size: stat.size, head };
  } finally { fs.closeSync(fd); }
}
function matchesSource(file, proof) {
  const now = sourceProof(file);
  return now.dev === proof.dev && now.ino === proof.ino && now.size >= proof.size
    && now.head.subarray(0, proof.head.length).equals(proof.head);
}

/** Create a handle outside the acquisition scope, so it cannot capture a heavy index. */
function makeHandle(pool, file, options) {
  let handle;
  const proof = sourceProof(file);
  const hydrate = (seq) => pool.use(handle, (index) => {
    if (index.scanState() === 'rewound') {
      pool.invalidate(handle);
      throw new Error(`log was rewritten; stale lazy view: ${file}`);
    }
    // Disk caches deliberately hold back the final frame. A cold read may need that frame.
    if (!index.has(seq)) index.advance(Infinity);
    return index.hydrate(seq);
  });
  handle = Object.freeze({ file, proof, options: Object.freeze({ ...options }), hydrate });
  return handle;
}

/** Own every warm index, with no references to Sessions or their event arrays.
 * @param options.maxEntries - maximum warm table count.
 * @param options.maxBytes - conservative estimated warm retained-byte limit.
 * @returns synchronous acquire/release operations and stable lightweight handles.
 */
export function createLogIndexPool({ maxEntries, maxBytes }) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new RangeError('index pool maxEntries must be a positive integer');
  if (!Number.isFinite(maxBytes) || maxBytes < 1) throw new RangeError('index pool maxBytes must be positive');
  const entries = new Map();
  const invalid = new WeakSet();
  let coldOnly = false;
  let hits = 0, misses = 0, evictions = 0;

  function bytes() {
    let total = 0;
    for (const entry of entries.values()) total += entry.index.retainedBytes();
    return total;
  }
  function remove(handle, entry, save = true) {
    entries.delete(handle);
    entry.index.close(save);
    evictions++;
  }
  function trim() {
    let retained = bytes();
    for (const [handle, entry] of entries) {
      if (!coldOnly && entries.size <= maxEntries && retained <= maxBytes) break;
      if (entry.uses > 0) continue;
      retained -= entry.index.retainedBytes();
      remove(handle, entry);
    }
  }

  const pool = {
    /** One handle per Session incarnation; callers keep it in a WeakMap, never an id history. */
    createHandle(file, options = {}) { return makeHandle(pool, file, options); },
    has(handle) { return entries.has(handle); },
    isInvalid(handle) { return invalid.has(handle); },
    use(handle, operation) {
      if (invalid.has(handle)) throw new Error(`log index handle is stale: ${handle.file}`);
      let entry = entries.get(handle);
      if (entry === undefined) {
        if (!matchesSource(handle.file, handle.proof)) {
          pool.invalidate(handle);
          throw new Error(`log was rewritten; stale lazy view: ${handle.file}`);
        }
        entry = { index: createLogIndex(handle.file, handle.options), uses: 0, discard: false };
        entries.set(handle, entry);
        misses++;
      } else {
        entries.delete(handle);
        entries.set(handle, entry);
        hits++;
      }
      entry.uses++;
      try {
        const result = operation(entry.index);
        if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
          throw new TypeError('index pool leases must be synchronous');
        }
        return result;
      } finally {
        entry.uses--;
        if (entry.uses === 0 && entry.discard) remove(handle, entry, false);
        trim();
      }
    },
    /** A rewritten log must never answer an old view with plausible but different data. */
    invalidate(handle) {
      invalid.add(handle);
      // loadEvent consults the hydration LRU before calling a handle. Purge those hits too.
      clearHydration();
      const entry = entries.get(handle);
      if (entry !== undefined) {
        entry.discard = true;
        if (entry.uses === 0) remove(handle, entry, false);
      }
    },
    /** After unload, residual lazy views use ephemeral leases without rebuilding a warm cache. */
    close() { coldOnly = true; trim(); },
    stats() {
      let frames = 0;
      for (const entry of entries.values()) frames += entry.index.frameCount;
      return { entries: entries.size, frames, bytes: bytes(), limit: maxEntries, byteLimit: maxBytes, hits, misses, evictions, coldOnly };
    },
  };
  return pool;
}
