/**
 * Open-time lazy loading for the jsonl persistence backend.
 *
 * The Host's `open()` decodes the ENTIRE stored log into resident events before the Session is
 * constructed, and keeps them alive for the session's lifetime: a 279 MB log becomes ~1.7 GB of
 * heap, and the Electron V8 ceiling (~4192 MB) kills the process somewhere around two such
 * sessions. This module wraps the backend's single decode choke point — `decodeStoredLog`, called
 * by both `open()` (via `requireStoredLog`) and every read-after-append (via `readStoredLog`) —
 * and returns a `CurrentStoredLog` whose events are lightweight views over the on-disk zstd frames.
 * A payload is decompressed and parsed only when something reads it, and the shared bounded LRU
 * (see lazy.mjs) evicts it afterwards, so a full validation/fold pass costs time but not residency.
 *
 * What stays honest:
 *   - Open TIME is not reduced. The Session constructor still validates and folds every event, so
 *     every payload is hydrated once per pass; the win is resident memory, not latency.
 *   - The full compressed file is still read once by the Host before the wrapper runs; the wrapper
 *     replaces the decode-and-retain step, not the read.
 *   - Any guard failure falls back to the original decode, so a torn tail, a rewritten file, a
 *     foreign format, or a small log behaves exactly as it does without the plugin.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { getHeapStatistics } from 'node:v8';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lazyOpenEvent } from './lazy.mjs';

/** The format generation this plugin's envelope assumptions are verified against. */
const SESSION_FORMAT_VERSION = 4;
/** The header line sits at the start of the first frame; a partial frame decode still yields it. */
const HEADER_READ_BYTES = 1024 * 1024;
/** One wrapper per backend across reloads: each install replaces the previous, and every wrapper
 * falls back to the TRUE original, so a superseded instance's dispose cannot clobber a newer one. */
const SLOT = Symbol.for('dsh-session-reaper.lazy-open');

/** Header keys the host's `isHeaderLine` accepts; any other key makes the header malformed. */
const HEADER_KEYS = new Set(['type', 'version', 'id', 'createdAt', 'isSeeded', 'delegationDepth', 'cwd', 'parentSession', 'origin', 'agentPreset']);

/**
 * Resolve the host's authoritative event vocabulary so the lazy path can refuse the same logs the
 * eager decoder refuses. The plugin cannot import `@deepseek-ai/dsh-session` by bare specifier (the
 * profile's node_modules holds only installed bundles), but the host caller's module URL is on the
 * stack at decode time; `createRequire` anchored there resolves the host package, and a dynamic
 * import loads it. Returns null when no anchor resolves — the caller then falls back to eager decode
 * rather than serving views it cannot validate.
 * @param stack - the call stack captured inside the wrapped decode.
 * @returns `{ known, adopt }` from the host, or null.
 */
async function resolveVocabulary(stack) {
  try {
    const mod = await import('@deepseek-ai/dsh-session');
    if (mod.KNOWN_SESSION_EVENT_TYPES) return { known: mod.KNOWN_SESSION_EVENT_TYPES, adopt: mod.adoptSessionEvent ?? null };
  } catch {
    /* bare specifier is not resolvable from the plugin; fall through to the host anchors */
  }
  const seen = new Set();
  for (const match of String(stack).matchAll(/file:\/\/[^\s)]+/g)) {
    const clean = match[0].replace(/:\d+(?::\d+)?$/, '');
    if (seen.has(clean)) continue;
    seen.add(clean);
    let resolved;
    try {
      resolved = createRequire(fileURLToPath(clean)).resolve('@deepseek-ai/dsh-session');
    } catch {
      continue; // this anchor cannot resolve the host package; try the next frame
    }
    // Node >= 22 can require an ESM module; older runtimes need a dynamic import. Try both so the
    // resolution works regardless of the host's Node version.
    try {
      const mod = createRequire(fileURLToPath(clean))(resolved);
      if (mod.KNOWN_SESSION_EVENT_TYPES) return { known: mod.KNOWN_SESSION_EVENT_TYPES, adopt: mod.adoptSessionEvent ?? null };
    } catch {
      /* require(ESM) unsupported here; fall through to import */
    }
    try {
      const mod = await import(pathToFileURL(resolved).href);
      if (mod.KNOWN_SESSION_EVENT_TYPES) return { known: mod.KNOWN_SESSION_EVENT_TYPES, adopt: mod.adoptSessionEvent ?? null };
    } catch {
      /* this anchor resolved but could not load; try the next frame */
    }
  }
  return null;
}

/** The session id is the directory name above the artifact: <root>/sessions/<group>/<id>/<file>. */
export function sessionIdOfLogPath(file) {
  return path.basename(path.dirname(file));
}

/**
 * Translate a parsed header line into the SessionHeader shape `fromHeaderLine` produces, or null
 * when the line is not a well-formed current header. Kept in sync with the backend's isHeaderLine
 * guard; a refusal here falls back to the original decode, which owns the exact diagnostic.
 */
function metaFromHeaderLine(line) {
  if (line === null || typeof line !== 'object' || Array.isArray(line)) return null;
  // Match the host's isHeaderLine + assertNoRetiredHeaderFields: a closed key set, no retired policy
  // fields, and no negative zero. A header the host would refuse must fall back, not be accepted.
  if (Object.keys(line).some(key => !HEADER_KEYS.has(key))) return null;
  if (Object.hasOwn(line, 'sandboxMode') || Object.hasOwn(line, 'approvalPolicy')) return null;
  if (line.type !== 'session' || line.version !== SESSION_FORMAT_VERSION) return null;
  if (typeof line.id !== 'string' || line.id.length === 0) return null;
  if (!Number.isSafeInteger(line.createdAt) || line.createdAt < 0 || Object.is(line.createdAt, -0)) return null;
  if (!Number.isSafeInteger(line.delegationDepth) || line.delegationDepth < 0 || Object.is(line.delegationDepth, -0)) return null;
  if (typeof line.isSeeded !== 'boolean') return null;
  if (line.cwd !== undefined && (typeof line.cwd !== 'string' || !path.isAbsolute(line.cwd))) return null;
  if (line.parentSession !== undefined && typeof line.parentSession !== 'string') return null;
  if (line.origin !== undefined && line.origin !== 'subagent') return null;
  if (line.agentPreset !== undefined && typeof line.agentPreset !== 'string') return null;
  return {
    version: SESSION_FORMAT_VERSION,
    id: line.id,
    createdAt: line.createdAt,
    ...line.cwd !== undefined ? { cwd: line.cwd } : {},
    ...line.parentSession !== undefined ? { parentSession: line.parentSession } : {},
    isSeeded: line.isSeeded,
    ...line.origin !== undefined ? { origin: line.origin } : {},
    delegationDepth: line.delegationDepth,
    ...line.agentPreset !== undefined ? { agentPreset: line.agentPreset } : {},
  };
}

/** Decompress the head of the log and return its first line (the session header). */
function readHeaderLine(file) {
  const fd = fs.openSync(file, 'r');
  let head;
  try {
    const size = fs.fstatSync(fd).size;
    const want = Math.min(HEADER_READ_BYTES, size);
    const buffer = Buffer.allocUnsafe(want);
    const read = fs.readSync(fd, buffer, 0, want, 0);
    head = buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
  // A truncated frame decodes to the plaintext it could produce; the header is the first line, so
  // even a first frame wider than the read window yields it.
  const text = zlib.zstdDecompressSync(head).toString('utf8');
  const newline = text.indexOf('\n');
  return JSON.parse(newline < 0 ? text : text.slice(0, newline));
}

/**
 * Install the lazy decode wrapper on the jsonl backend.
 * @param options.ctx - plugin context used to resolve the persistence service.
 * @param options.cfg - normalized plugin config (lazyOpenMinMB, lazyOpenBudgetMs).
 * @param options.pool - the shared log-index pool.
 * @param options.handleForFile - file-keyed handle registry shared with the post-open reaper.
 * @param options.record - telemetry writer.
 * @param options.guard - shared `{ known, adopt, resolved }` vocabulary ref, also used by the handles
 *   `handleForFile` creates so both paths validate identically. Created internally when omitted.
 * @returns an uninstall function, or null when the backend is absent or not the jsonl backend.
 */
export function installLazyOpen({ ctx, cfg, pool, handleForFile, record, guard }) {
  let backend;
  try {
    backend = ctx.get('sessionPersistence');
  } catch {
    backend = undefined;
  }
  if (!backend || backend.name !== 'session-persistence-jsonl') return null;
  if (typeof backend.decodeStoredLog !== 'function' || typeof backend.readStoredLog !== 'function') return null;

  const slot = backend[SLOT] ?? { original: backend.decodeStoredLog };
  backend[SLOT] = slot;
  const vocab = guard ?? { known: null, adopt: null, resolved: false };
  const minBytes = Math.max(1, cfg.lazyOpenMinMB) * 1048576;

  /**
   * Build one lazy CurrentStoredLog, or return null to fall back to the original decode.
   * Every refusal path is deliberately silent: the original decode owns the exact diagnostics.
   */
  const tryLazy = async (file, expectedId, buffer, revision, signal) => {
    // Resolve the host vocabulary once, from the host caller's module URL on this stack. Without it
    // the lazy path cannot reproduce the host's unknown-type refusal, so it must not serve at all.
    if (!vocab.resolved) {
      vocab.resolved = true;
      const resolved = await resolveVocabulary(new Error().stack);
      if (resolved) {
        vocab.known = resolved.known;
        vocab.adopt = resolved.adopt;
      }
      record({ event: 'lazy-open-vocabulary', known: vocab.known ? vocab.known.size : 0 });
    }
    if (!vocab.known) return null;
    const id = sessionIdOfLogPath(file);
    const handle = handleForFile(file, id);
    // Spread the cold scan over event-loop turns: one advance slice per budget, never a stall.
    let scan;
    for (;;) {
      signal?.throwIfAborted();
      scan = pool.use(handle, (index) => {
        if (index.scanState() === 'rewound') return { rewound: true };
        return index.advance(cfg.lazyOpenBudgetMs);
      });
      if (scan.rewound) {
        pool.invalidate(handle);
        return null;
      }
      if (scan.complete || scan.blocked) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    // A torn final frame needs the original decoder's recovery (real recovered-tail events and a
    // truncation point); the lazy path only serves physically complete logs.
    if (scan.blocked) return null;
    const shape = pool.use(handle, (index) => ({
      scannedTo: index.scannedTo,
      complete: index.complete,
      dense: index.dense,
      events: index.events,
      lastSeq: index.lastSeq,
      markers: index.endSeedMarkers,
    }));
    // The Host handed us a stable snapshot of the file. If the file grew or shrank since that read,
    // the table no longer describes exactly those bytes: decode the snapshot the original way.
    if (!shape.complete || shape.scannedTo !== buffer.byteLength) return null;
    // The codec enforces contiguous seqs from 0; a gap or duplicate (even one the aggregate count
    // below would miss) is a job for the full decoder.
    if (!shape.dense) return null;
    if (shape.events !== shape.lastSeq + 1) return null;

    const meta = metaFromHeaderLine(readHeaderLine(file));
    if (meta === null || meta.id !== expectedId) return null;
    // The inherited cut is the seq of the LAST `session/end-seed` marker tagged inherited, and the
    // header's isSeeded flag must agree with the markers' presence — the same rule the format
    // codec's finish() enforces. A disagreement falls back so the original refusal surfaces.
    let cut = 0;
    let hasInherited = false;
    for (const marker of shape.markers) {
      if (marker.inherited) {
        cut = marker.seq;
        hasInherited = true;
      }
    }
    if (meta.isSeeded !== hasInherited) return null;
    if (typeof backend.assertStoredIdentity === 'function') {
      await backend.assertStoredIdentity(file, SESSION_FORMAT_VERSION, meta, expectedId, signal);
    }

    // The handle's hydrate already applies the shared guard (vocabulary refusal, the retired shape,
    // host adoption, deep freeze). Using it directly as the views' owner is what lets the post-open
    // tick recognise these views as its own and skip re-wrapping them.
    const hydrate = handle.hydrate;
    // Memory-headroom-adaptive residency. The Host folds every event synchronously, so a payload
    // read during that fold blocks the loop. Keep as much of the log resident as available headroom
    // allows (decoded here, yielding, so the fold reads it cheaply) and serve only the uncovered
    // tail as lazy views. When the whole log fits, fall back to eager entirely (no freeze at all);
    // when headroom is tiny, serve (almost) all lazy to bound the peak instead of OOMing.
    const headroom = getHeapStatistics().heap_size_limit - process.memoryUsage().heapUsed
      - Math.max(0, Number(cfg.lazyOpenHeadroomMB) || 0) * 1048576;
    const residentEstimate = buffer.byteLength * 2;
    if (residentEstimate <= headroom) return null;
    const avgResident = residentEstimate / shape.events;
    const residentCut = Math.max(0, Math.min(shape.events, Math.floor(headroom / avgResident)));
    const events = new Array(shape.events);
    for (let seq = 0; seq < residentCut; seq += 1) {
      events[seq] = hydrate(seq);
      // Spread the resident pre-pass over event-loop turns; it must not stall the loop either.
      if ((seq & 1023) === 1023) {
        signal?.throwIfAborted();
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    for (let seq = residentCut; seq < shape.events; seq += 1) events[seq] = lazyOpenEvent(seq, hydrate);
    Object.freeze(events);
    const stored = {
      status: 'current',
      meta,
      eventState: 'shared-frozen',
      events,
      tornTruncateTo: undefined,
      recoveredTail: [],
      inheritedEventCount: cut,
      revision,
    };
    record({ event: 'lazy-open-resident', id: String(expectedId), residentCut, events: shape.events, headroomMB: Math.round(headroom / 1048576) });
    // Hand the next open at this revision the same views instead of a rebuild; every local
    // mutation invalidates the memo entry, exactly as for an eagerly decoded log.
    if (typeof backend.memoizeStoredLog === 'function') backend.memoizeStoredLog(expectedId, stored);
    return stored;
  };

  const wrapped = async function lazyDecodeStoredLog(file, expectedId, buffer, revision, signal) {
    if (buffer.byteLength >= minBytes && file.endsWith('.zstd')) {
      const startedAt = Date.now();
      try {
        const stored = await tryLazy(file, expectedId, buffer, revision, signal);
        if (stored !== null) {
          record({
            event: 'lazy-open',
            id: String(expectedId),
            events: stored.events.length,
            bytes: buffer.byteLength,
            cut: stored.inheritedEventCount,
            ms: Date.now() - startedAt,
          });
          return stored;
        }
      } catch (error) {
        if (signal?.aborted !== true) {
          record({ event: 'lazy-open-error', id: String(expectedId), error: String(error?.message ?? error).slice(0, 200) });
        }
      }
    }
    return slot.original.call(this, file, expectedId, buffer, revision, signal);
  };

  backend.decodeStoredLog = wrapped;
  slot.current = wrapped;
  record({ event: 'lazy-open-installed', minMB: cfg.lazyOpenMinMB });
  return () => {
    // A newer instance may have replaced us; its wrapper already falls back to the true original,
    // so restoring here would only clobber it.
    if (slot.current === wrapped) {
      backend.decodeStoredLog = slot.original;
      delete backend[SLOT];
    }
  };
}