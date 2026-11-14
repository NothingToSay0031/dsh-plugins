/**
 * Session Reaper — reclaims resident session payloads from a RUNNING Host.
 *
 * Problem it targets (measured on a real session): a live Session keeps every historical event
 * as a JavaScript object, so heap is roughly 2x the on-disk log. One 847.8 MB log produced a
 * 1716 MB heap, and a 4192 MB heap ceiling therefore caps a single session at about 2.06 GB of
 * log. Compaction does not help: it only removes events from the model-visible surface and never
 * releases the bytes.
 *
 * What it does: for events older than a recent window, replace long payload strings inside
 * `tool/result` and `assistant/message` with empty strings, keeping every identity field. This is
 * the transform a real `Session` constructor accepted in an offline test (2626.0 MB -> 1876.4 MB
 * while two copies were held). Replacing `data` wholesale is rejected by that constructor with
 * "lacks an identified message", so only payload strings are touched.
 *
 * Scheduling uses the Cordis timer service (`ctx.interval`, provided by
 * `@deepseek-ai/cordis-plugin-timer`), not the global `setInterval`. Two reasons, both observed:
 *   - a global timer survives a plugin reload, leaving a callback bound to a disposed context that
 *     then fails every tick with "cannot get required service ... in inactive context";
 *   - `ctx.interval` wraps the timer in `ctx.effect`, so it is disposed with the plugin fiber.
 * A global timer is still used as a fallback when the service is absent, but then the returned
 * disposer is registered so a reload cannot accumulate timers.
 *
 * Failure policy: an exception escaping a timer callback terminates the Host process (observed
 * three times in one session). Every entry point here is wrapped, and telemetry writes are
 * best-effort.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { byteWindow, clearHydration, createTelemetryWriter, hydrationStats, isHydrated, setHydrationLimit, substituteLog, surfaceFloor } from './lazy.mjs';
import { createLogIndexPool } from './index-pool.mjs';
import v8 from 'node:v8';
import { runInNewContext } from 'node:vm';

export const name = 'local-session-reaper';

// A reload composes a NEW module instance, but the previous instance's timer keeps firing. Several
// instances then walk every session at once, which is pure cost and was visible as interleaved tick
// numbers in the telemetry. The registry lives on globalThis so it is shared across instances.
const REGISTRY = (globalThis.__dshSessionReaper ??= { seq: 0, active: 0 });
export const inject = ['sessions'];

const DEFAULTS = {
  /**
   * On by default: a row that only sets `dryRun: false` used to do nothing at all, because a missing
   * `enabled` read as false and `apply` returned before installing a timer.
   */
  enabled: true,
  /** Measure and report only. The plugin then replaces nothing and writes nothing but telemetry. */
  dryRun: true,
  intervalMs: 60000,
  triggerMB: 1500,
  /** Events kept fully resident at the tail, before the compaction floor is applied. */
  keepLastEvents: 20000,
  /**
   * Hard ceiling on how far back the surface floor may move the window, in events.
   *
   * The floor comes from the live surface, so a surface that keeps one very old node alive would
   * otherwise put an entire log back into memory. Clamping preserves the memory bound; the session
   * then pays one disk read per old node the next compaction touches, and the `floorClamped` flag in
   * telemetry makes that visible instead of silent.
   */
  floorMaxEvents: 20000,
  /**
   * Bytes one session's window may hold, or 0 for no byte budget.
   *
   * `keepLastEvents` is a count, and a count does not bound memory: 2000 events of tool results are a
   * few MB in one session and can be a few hundred in another, and that multiplies by however many
   * sessions are open. Measured on this machine the window was 5.5-12.7 MB per session, so the budget
   * is a ceiling that rarely binds rather than a routine trim; when it does bind, the window starts
   * later than the count alone and the row says `byteTrimmed`. A window cut below the surface floor
   * makes the next compaction read those nodes back from disk, which is why the row also says
   * `floorTrimmed` in that case.
   */
  keepLastMB: 48,
  /**
   * Event types whose payload is released below the window, or `'*'` for every type.
   *
   * The default list is the conservative subset. Measured on a 300k-event session, the payload bytes
   * left behind by this list are mostly `user/message` (50 MB), `tool/call` (43 MB),
   * `compaction/summary` (39 MB) and `request/header` (33 MB), so a deployment that wants the memory
   * back lists them here — `'*'` goes further and also releases the small bookkeeping types, whose
   * payload is cheaper than the view that replaces it. Either way the release starts at the newest
   * compaction boundary, so what the next compaction and the next turn read stays resident.
   */
  types: ['tool/result', 'assistant/message'],
  logFile: '',
  probe: false,
  /** Optional explicit log path for lazy mode; resolved from the sessions root when empty. */
  lazyLogFile: '',
  /** Walk the derived/projection structures and report their resident string volume. */
  measureDerived: false,
  /** Weigh every field of a loaded Session separately, to locate the resident bytes. */
  probeSession: false,
  /** How many hydrated payloads the lazy views keep at once. */
  hydrationCacheSize: 256,
  /**
   * Resident budget for those hydrated payloads, in MB.
   *
   * The count alone bounds nothing: the 256 largest lines of a real log are 21.4 MB of JSON while the
   * 99th percentile line is 30 KB, and a single captured file can be hundreds of megabytes. Entries
   * that alone exceed a quarter of this budget are handed to the caller without being cached.
   */
  hydrationCacheMB: 64,
  /**
   * How long a just-(re)opened session keeps its payloads resident before it is reaped.
   *
   * Opening a big session parses the whole log in the Host (6 s for 282k events here) and then the
   * client walks the events it just opened. Reaping inside that walk turns every read into a second
   * zstd decode, and the client can give up on the open first, which shows up as "Session reference
   * … is released". Two minutes of residency costs memory only for the one session a person is
   * looking at; the next tick after the window reaps it like any other cold session.
   */
  hotWindowMs: 120000,
  /**
   * Milliseconds per tick the lazy index may spend scanning a session log.
   *
   * A cold scan of the largest session here costs ~5 s and ~220 MB of reads. Doing that inside one
   * tick froze the Host — the pause a user reads as "the session is still loading". The scan is
   * resumable, so it is spread over ticks and the result is cached on disk for the next start.
   */
  indexBudgetMs: 250,
  /** Where those cached frame tables live. Empty means $DSH_HOME/cache/session-reaper-index. */
  indexCacheDir: '',
  /**
   * Cold scans started per tick. Starting ten at once would spend ten budgets in one tick, which is
   * the same freeze in a different shape.
   */
  indexBuildsPerTick: 1,
  /**
   * Maximum warm frame tables. Lazy views retain stable handles, so eviction releases the table;
   * a later read acquires another table within the same pool budget.
   */
  indexCacheSize: 16,
  /** Conservative byte budget for all warm frame tables and their I/O/decode caches. */
  indexCacheMB: 64,
  /**
   * Force a full GC every N ticks.
   *
   * A forced collection on a 1.4 GB heap frees ~290 MB and costs ~200 ms of loop time; doing it
   * every tick made the reaper itself the thing that stalls the Host. The floor is still sampled
   * whenever it matters (heap above `pressureMB` always collects), and every sample reports
   * `gc` so a reader can tell a floor from a peak.
   */
  gcEvery: 4,
  /**
   * Post-GC heap size at which every releasable cache is dropped regardless of the other flags.
   * This is the last line of defence before the 4192 MB ceiling ends the process.
   */
  pressureMB: 3200,
  /** Rank the largest reachable structures from globalThis and the sessions service. */
  probeGlobal: false,
  /** Weigh the agents service and each registered agent, where the non-session heap seems to live. */
  probeAgents: false,
  /**
   * Report what the surface fold state still holds. The fold captures event references in
   * `_state.nodes`, so substituting `session.log[i]` alone cannot free a payload the fold keeps.
   */
  probeFold: false,
  /** Write one heap snapshot to this path (once per process) for retainer analysis. */
  snapshotPath: '',
  /** Do not snapshot until the heap is at least this large, so a fresh Host is not dumped. */
  snapshotMinMB: 1000,
  /**
   * Evict unpinned entries from the session query engine's cold-observation cache.
   *
   * That cache (`SessionObservationReader.cache`) holds, per cold session, BOTH a prepared Session
   * and a frozen copy of its full event array, and keeps up to `preparedSessionCacheSize` (default 5)
   * of them. It is a pure cache: evicting an unpinned entry only makes the next read re-load the
   * session from its log, which is the on-demand behaviour we want. Pinned entries (refs > 0) are
   * skipped, so an in-flight observation is never invalidated.
   */
  evictObservationCache: false,
};

function normalizeConfig(raw) {
  const cfg = { ...DEFAULTS };
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(DEFAULTS)) {
      if (raw[key] !== undefined && raw[key] !== null) cfg[key] = raw[key];
    }
  }
  cfg.intervalMs = Math.max(Number(cfg.intervalMs) || DEFAULTS.intervalMs, 2000);
  cfg.triggerMB = Math.max(Number(cfg.triggerMB) || DEFAULTS.triggerMB, 64);
  cfg.keepLastEvents = Math.max(Number(cfg.keepLastEvents) || DEFAULTS.keepLastEvents, 0);
  cfg.floorMaxEvents = Math.max(Number(cfg.floorMaxEvents) || DEFAULTS.floorMaxEvents, 0);
  cfg.keepLastMB = Math.max(Number(cfg.keepLastMB ?? DEFAULTS.keepLastMB) || 0, 0);
  // `'*'` releases the payload of every type below the window instead of a fixed list. It is only
  // sound together with the compaction floor, which keeps the post-summary surface resident.
  cfg.types = cfg.types === '*' || cfg.types === true
    ? '*'
    : Array.isArray(cfg.types) && cfg.types.length > 0 ? cfg.types.map(String) : [...DEFAULTS.types];
  cfg.indexBudgetMs = Math.max(Number(cfg.indexBudgetMs) || DEFAULTS.indexBudgetMs, 20);
  cfg.indexBuildsPerTick = Math.max(Number(cfg.indexBuildsPerTick) || DEFAULTS.indexBuildsPerTick, 0);
  cfg.indexCacheSize = Math.max(Math.trunc(Number(cfg.indexCacheSize) || DEFAULTS.indexCacheSize), 1);
  cfg.indexCacheMB = Math.max(Number(cfg.indexCacheMB) || DEFAULTS.indexCacheMB, 1);
  cfg.gcEvery = Math.max(Number(cfg.gcEvery) || DEFAULTS.gcEvery, 1);
  cfg.hotWindowMs = Math.max(Number(cfg.hotWindowMs) || 0, 0);
  cfg.hydrationCacheMB = Math.max(Number(cfg.hydrationCacheMB) || DEFAULTS.hydrationCacheMB, 4);
  return cfg;
}

/**
 * Measure how much resident string text lives inside one derived structure.
 *
 * Why this exists: a full scan of the large session's `log` finds no string longer than 64 chars in
 * 57,591 `tool/result` events, while the same log offline holds 294 MB of them. The payload text is
 * therefore not in `log` at all in a running Host. The heap snapshot showed 1365 MB of strings, so
 * they must be held by the derived/projection structures — `derivedNodes`, `contextFold`,
 * `toolHistoryProjection`. This walker turns that from an inference into a number.
 */
function measureDeep(root, budget = 1500000) {
  const seen = new WeakSet();
  const stack = [{ value: root, depth: 0 }];
  let strings = 0;
  let chars = 0;
  let nodes = 0;
  let truncated = false;
  while (stack.length > 0) {
    const { value, depth } = stack.pop();
    if (++nodes > budget) {
      truncated = true;
      break;
    }
    if (typeof value === 'string') {
      strings += 1;
      chars += value.length;
      continue;
    }
    if (value === null || typeof value !== 'object' || depth > 24) continue;
    // A lazy view materialises its payload on first property access. Measuring must not do that,
    // or the measurement itself re-inflates everything the substitution just released.
    if (value.__lazy === true) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) stack.push({ value: item, depth: depth + 1 });
      continue;
    }
    for (const key of Object.keys(value)) stack.push({ value: value[key], depth: depth + 1 });
  }
  return { strings, chars, nodes, truncated };
}

/** Locate a session's log file without depending on the Host's storage layout beyond its root. */
function sessionLogFile(id, override) {
  if (override && existsSync(override)) return override;
  const root = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions');
  try {
    for (const group of readdirSync(root, { withFileTypes: true })) {
      if (!group.isDirectory()) continue;
      const candidate = join(root, group.name, id, 'session.v4.jsonl.zstd');
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    /* a missing sessions root just means lazy mode is unavailable */
  }
  return null;
}

export function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig);
  if (!cfg.enabled) return;
  const me = ++REGISTRY.seq;
  REGISTRY.active = me;
  setHydrationLimit(cfg.hydrationCacheSize, cfg.hydrationCacheMB * 1024 * 1024);

  const logFile = cfg.logFile || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'logs', 'session-reaper.jsonl');

  // Events retain a stable lightweight handle. Only this pool owns heavy frame tables, so an
  // eviction really releases the table instead of leaving a generation pinned by old getters.
  const indexCacheDir = cfg.indexCacheDir || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'cache', 'session-reaper-index');
  const indexPool = createLogIndexPool({ maxEntries: cfg.indexCacheSize, maxBytes: cfg.indexCacheMB * 1048576 });
  const indexHandles = new WeakMap();
  const DEFERRED = { deferred: true };
  let buildsThisTick = 0;
  // Cold scans only: adopting a cached table is cheap enough to do for every session in one tick.
  let scansThisTick = 0;
  let lastIndexSaveAt = 0;
  // How far each session's log has already been decided. Per fiber, so a reload (which rebinds every
  // view to a new index) starts from zero exactly once.
  const watermarks = new Map();
  /**
   * Read the live surface's oldest conversation node: the floor of the resident window.
   *
   * The surface is the only authority on what is still readable. `keepLastEvents` alone releases
   * nodes that the next compaction will summarize (`buildSummarizationInput` derives each shadowed
   * node of its region) and that building the next prompt reads, so the window starts at the oldest
   * node instead — anything older is shadowed and never read again.
   */
  const surfaceFloorOf = (session) => {
    try {
      const nodes = session?.surface?.nodes;
      if (!Array.isArray(nodes) || nodes.length === 0) return null;
      // Node 0 is the retained system prompt. It is rewritten in place, never summarized, and one
      // small event, so it is not a reason to keep the log it happens to sit in front of.
      const head = nodes.length > 1 ? session.eventAt(nodes[0]) : undefined;
      return surfaceFloor(nodes, head?.type === 'system/message');
    } catch {
      // A surface that cannot be read (a projection was removed, a detached session) is no reason to
      // fail the tick: fall back to the fixed tail window.
      return null;
    }
  };
  // A session whose log array was just replaced is being read right now: the Host parses the file for
  // the open and the client immediately walks the events. Substituting payloads during that walk makes
  // every event a second zstd decode — 4.5 s on top of the 6 s parse for a 282k-event session — and the
  // open can be abandoned first, which surfaces as "Session reference … is released". So a freshly
  // (re)opened session keeps its payloads for a short window and is reaped on a later tick, when no one
  // is walking it. First sighting (startup restore) is not "fresh": that is the case reaping exists for.
  const hotSessions = new Map();
  const lazyIndexFor = (session) => {
    const id = String(session?.id ?? '');
    if (!id) return null;
    let handle = indexHandles.get(session);
    if (handle && indexPool.isInvalid(handle)) return handle;
    if (handle && indexPool.has(handle)) return handle;
    const cacheFile = join(indexCacheDir, `${id}.idx`);
    // Only cold scans consume the build quota; adopting a persisted table is cheap.
    if (!existsSync(cacheFile)) {
      if (scansThisTick >= cfg.indexBuildsPerTick) return DEFERRED;
      scansThisTick += 1;
    }
    buildsThisTick += 1;
    if (!handle) {
      const file = sessionLogFile(id, cfg.lazyLogFile);
      if (!file) return null;
      handle = indexPool.createHandle(file, { cacheFile });
      indexHandles.set(session, handle);
    }
    return handle;
  };

  // Resolve the service now, inside the active context. Reading ctx.sessions later from a callback
  // whose fiber was disposed fails with "inactive context".
  let listSessions;
  try {
    listSessions = ctx.sessions.list.bind(ctx.sessions);
  } catch {
    listSessions = undefined;
  }
  if (!listSessions) return;

  let stopped = false;

  // One row per tick, forever: at a 30 s interval this file passes a gigabyte in a year, and nobody
  // reads the old half of it. Rotating once past this size keeps the recent history greppable.
  const TELEMETRY_MAX_BYTES = 8 * 1024 * 1024;
  // The log is append-only and shared by every instance that ever ran: a reload resets `tick` and
  // changes nothing else in a row, so without an instance id two runs cannot be told apart.
  const boot = randomUUID().slice(0, 8);
  const writeTelemetry = createTelemetryWriter(logFile, { maxBytes: TELEMETRY_MAX_BYTES });
  const record = (row) => { void writeTelemetry({ boot, ...row }); };

  // The Host is not started with --expose-gc, so a collector is obtained at runtime (this form works
  // in Electron's Node too). Kept local: assigning `global.gc` publishes a collector into the Host's
  // global object, where it outlives this plugin and a reload leaves the previous closure wired in.
  let collect = null;
  const resolveCollect = () => {
    if (collect !== null) return collect;
    if (typeof global.gc === 'function') {
      collect = global.gc;
      return collect;
    }
    try {
      v8.setFlagsFromString('--expose-gc');
      const injected = runInNewContext('gc');
      if (typeof injected === 'function') collect = injected;
    } catch {
      /* measuring without a collection is still useful */
    }
    return collect;
  };

  const reap = () => {
    const tickStartedAt = Date.now();
    // Report the floor, not the peak: without a collection heapUsed includes garbage that the next
    // GC reclaims, which is exactly the distinction the crash analysis needs.
    const gc = resolveCollect();
    const heapBeforeGC = Math.round(process.memoryUsage().heapUsed / 1048576);

    // One-shot snapshot for offline retainer analysis. A walker cannot see #private fields, and the
    // Host keeps most state that way, so the object graph itself is the only reliable source.
    if (cfg.snapshotPath && !existsSync(cfg.snapshotPath) && globalThis.__dshReaperSnapshot !== cfg.snapshotPath) {
      const heapForSnapshot = Math.round(process.memoryUsage().heapUsed / 1048576);
      if (heapForSnapshot >= cfg.snapshotMinMB) {
        globalThis.__dshReaperSnapshot = cfg.snapshotPath;
        // v8.writeHeapSnapshot blocks the loop for tens of seconds on a multi-GB heap. Say so before it
        // starts: without this row, the freeze looks like a hang in whatever the user was doing.
        record({ event: 'snapshot-start', path: cfg.snapshotPath, heapMB: heapForSnapshot });
        try {
          mkdirSync(dirname(cfg.snapshotPath), { recursive: true });
          v8.writeHeapSnapshot(cfg.snapshotPath);
        } catch (error) {
          globalThis.__dshReaperSnapshot = `failed:${String(error?.message ?? error)}`;
        }
      }
    }
    // A forced collection is the single largest cost of a tick on a large heap, so it runs on a
    // schedule and whenever the pre-GC number says the process is near the ceiling.
    const gcDue = ticks % Math.max(1, cfg.gcEvery) === 0 || heapBeforeGC >= cfg.pressureMB;
    const didGc = gcDue && typeof gc === 'function';
    if (didGc) gc();
    const usage = process.memoryUsage();
    const heapMB = Math.round(usage.heapUsed / 1048576);
    if (heapMB < cfg.triggerMB) {
      return { heapMB, belowTrigger: true, gc: didGc, ms: Math.round(Date.now() - tickStartedAt) };
    }

    const sessions = listSessions();
    const perSession = [];
    buildsThisTick = 0;
    scansThisTick = 0;

    /**
     * Everything one session needs, as a single row.
     *
     * Each session is isolated by the caller: a throw in here used to abort the rest of the tick, so
     * one unreadable log starved every later session of reaping for as long as it stayed broken.
     */
    const reapSession = (session, log, keepFrom, sessionId) => {
      // A dry run measures and reports; it never replaces an event. There used to be a second mode
      // that blanked long strings in place, which was the original attempt at this and did not free
      // anything: the surface fold and the query engine keep their own references to the same events,
      // so the strings stayed reachable (see ROOT-CAUSE-AND-FIX.md §11). Keeping a switch that rewrites
      // history in place, with no user and a failure mode that looks like success, is worse than not
      // having it.
      if (cfg.dryRun) return { id: sessionId, events: log.length, keepFrom, touched: 0, mode: 'dry-run' };
      // Runtime substitution: the event keeps its identity, the payload is re-read from the log
      // on first access. Nothing on disk changes.
      const handle = lazyIndexFor(session);
      if (handle === DEFERRED) {
        return { id: sessionId, events: log.length, keepFrom, touched: 0, mode: 'index-deferred' };
      }
      if (!handle) {
        return { id: sessionId, events: log.length, keepFrom, touched: 0, mode: 'lazy-unavailable' };
      }
      if (indexPool.isInvalid(handle)) {
        indexHandles.delete(session);
        watermarks.delete(sessionId);
        return { id: sessionId, events: log.length, keepFrom, touched: 0, mode: 'index-rewound' };
      }
      return indexPool.use(handle, (index) => {
        // A live session appends frames while it runs. Scanning only while the first pass is
        // unfinished froze the table at the end of that pass, and every event written afterwards kept
        // its payload resident until the next Host start. Measured on a 285,000-event session: the
        // table sat 2,476 events behind and 2-6 events per tick were reported `pending` forever.
        const scan = index.scanState();
        if (scan === 'rewound') {
          // The log is shorter than the covered range, so it was rewritten and every offset in the
          // table points at different bytes. Replace it instead of decoding the wrong frame. The
          // views that still point at the old table must be rebound to the new one, so the watermark
          // has to go: with it, the prefix is skipped and those views keep throwing "stale" forever.
          indexPool.invalidate(handle);
          indexHandles.delete(session);
          watermarks.delete(sessionId);
          return { id: sessionId, events: log.length, keepFrom, touched: 0, mode: 'index-rewound' };
        }
        let scanned = null;
        if (scan === 'advance') {
          scanned = index.advance(cfg.indexBudgetMs);
          // Persist progress so the next Host start resumes instead of rescanning.
          if (index.complete || Date.now() - lastIndexSaveAt >= 60000) {
            index.saveCache();
            lastIndexSaveAt = Date.now();
          }
        }
        // `blocked` means the next frame is not fully on disk yet — a torn tail from a crash mid-write.
        // Waiting for `complete` in that case would keep every event of the session resident forever,
        // and the events before the torn frame *are* readable: `substituteLog` never touches a seq past
        // `lastSeq`. So only an unfinished cold scan is a reason to skip substitution.
        const tornTail = scanned?.blocked === true;
        if (!index.complete && !tornTail) {
          return {
            id: sessionId,
            events: log.length,
            keepFrom,
            touched: 0,
            mode: 'indexing',
            frames: index.frameCount,
            scannedMB: Math.round(index.scannedTo / 1048576),
            eventsOnDisk: index.events,
          };
        }
        index.saveCache();
        const from = Math.min(watermarks.get(sessionId) ?? 0, keepFrom);
        const out = substituteLog(log, index, { keepFrom, types: cfg.types, from, hydrate: handle.hydrate });
        watermarks.set(sessionId, keepFrom);
        return {
          id: sessionId,
          events: log.length,
          keepFrom,
          touched: out.substituted,
          strings: out.substituted,
          scanned: out.scanned,
          mode: 'lazy',
          frames: index.frameCount,
          ...(index.complete ? {} : { tornTail: Math.max(0, index.fileSize() - index.scannedTo) }),
          ...(out.skipped > 0 ? { skipped: out.skipped } : {}),
          ...(out.pending > 0 ? { pending: out.pending } : {}),
          ...(out.failures > 0 ? { failures: out.failures } : {}),
        };
      });
    };

    for (const session of sessions) {
      const log = session?.log;
      if (!Array.isArray(log)) continue;
      const sessionId = String(session.id ?? '?');
      // The window starts at the older of the fixed tail and the surface floor. `keepFrom` is where
      // residency starts, so "keep more" means "start earlier"; the floor is the oldest node the next
      // compaction or the next prompt can still read.
      const floor = surfaceFloorOf(session);
      const tailFrom = Math.max(log.length - cfg.keepLastEvents, 0);
      // A surface that reaches implausibly far back (a projection kept an old node alive, or the head
      // is not what we think it is) must not hand the whole log back: clamp, and say so in telemetry.
      const capped = floor === null ? null : Math.max(floor, log.length - cfg.floorMaxEvents);
      const windowFrom = capped === null ? tailFrom : Math.min(tailFrom, capped);
      const floorClamped = capped !== null && capped !== floor;
      // A count is not a size: 2000 events of tool results can weigh a few MB in one session and a
      // few hundred in another, and that multiplies by however many sessions are open. Trimming from
      // the tail to `keepLastMB` is what gives the whole process a ceiling. Measured on this machine
      // the window was 5.5-12.7 MB per session, so the budget is a bound that rarely binds.
      const fit = byteWindow(log, windowFrom, cfg.keepLastMB > 0 ? cfg.keepLastMB * 1048576 : Infinity);
      const keepFrom = fit.from;
      const byteTrimmed = keepFrom > windowFrom;
      const floorFields = {
        ...(floor === null ? {} : { floor, ...(floorClamped ? { floorClamped: true } : {}) }),
        windowMB: Math.round((fit.bytes / 1048576) * 10) / 10,
        ...(byteTrimmed ? { byteTrimmed: true } : {}),
        // The budget won over the surface floor: the next compaction re-reads those nodes from disk.
        ...(byteTrimmed && floor !== null && keepFrom > floor ? { floorTrimmed: true } : {}),
      };
      if (keepFrom <= 0) continue;
      const seen = hotSessions.get(sessionId);
      if (seen === undefined) {
        // First sighting is the startup restore, which is the case reaping exists for, so no window.
        // A session that first appears later in the run is one the client just opened.
        hotSessions.set(sessionId, { ref: new WeakRef(log), at: ticks <= 1 ? 0 : Date.now() });
      } else if (seen.ref.deref() !== log) {
        // The log array was replaced: the Host just parsed this session for an open. Every event is
        // resident again, so the prefix this plugin decided earlier has to be decided again. Without
        // forgetting the watermark the re-parsed prefix stayed resident for the rest of the process —
        // the exact shape of a slow leak, and what a reopened session looked like on the heap.
        watermarks.delete(sessionId);
        seen.ref = new WeakRef(log);
        seen.at = Date.now();
      }
      const hotUntil = (hotSessions.get(sessionId)?.at ?? 0) + cfg.hotWindowMs;
      if (hotUntil > Date.now()) {
        perSession.push({
          id: sessionId,
          events: log.length,
          keepFrom,
          touched: 0,
          mode: 'hot',
          hotForSec: Math.ceil((hotUntil - Date.now()) / 1000),
          ...floorFields,
        });
        continue;
      }
      try {
        const row = reapSession(session, log, keepFrom, sessionId);
        perSession.push({ ...row, ...floorFields });
      } catch (error) {
        perSession.push({
          id: sessionId,
          events: log.length,
          keepFrom,
          touched: 0,
          mode: 'error',
          error: String(error?.message ?? error),
          ...floorFields,
        });
      }
    }

    // Forget sessions that no longer exist. Both maps were append-only: `hotSessions` held a strong
    // reference to the log array of every session ever seen (seven vanished sessions pinned 151,380
    // events, ~30-40 MB, until the Host restarted) and `watermarks` kept an entry per id forever.
    const liveIds = new Set(sessions.map((session) => String(session?.id ?? '?')));
    for (const [id, seen] of hotSessions) {
      if (!liveIds.has(id) || seen.ref.deref() === undefined) hotSessions.delete(id);
    }
    for (const id of [...watermarks.keys()]) {
      if (!liveIds.has(id)) watermarks.delete(id);
    }

    // Pressure is a peak question: use the pre-GC number so a tick that skipped the collection does
    // not look safe just because the garbage has not been swept yet.
    const underPressure = heapBeforeGC >= cfg.pressureMB;
    if (underPressure) {
      try {
        clearHydration();
      } catch {
        /* nothing hydrated */
      }
    }

    let foldProbe;
    if (cfg.probeFold) {
      foldProbe = {};
      for (const session of sessions) {
        const row = {};
        const log = session?.log;
        if (Array.isArray(log)) {
          let lazy = 0;
          let hydrated = 0;
          for (const event of log) {
            if (!event || event.__lazy !== true) continue;
            lazy += 1;
            if (isHydrated(event.seq, event.__owner)) hydrated += 1;
          }
          row.log = { events: log.length, lazy, hydrated };
        }
        const state = session?.surfaceManager?._state;
        if (state) {
          const nodes = state.nodes;
          let lazyNodes = 0;
          let sample;
          if (Array.isArray(nodes)) {
            for (const node of nodes) {
              if (node && node.__lazy === true) lazyNodes += 1;
              else if (sample === undefined && node && typeof node === 'object') sample = Object.keys(node).slice(0, 6);
            }
            row.nodes = { count: nodes.length, lazy: lazyNodes, sample };
          }
          const measured = measureDeep(state, 8000000);
          row.state = { mb: Math.round(measured.chars / 1048576), nodes: measured.nodes, ...(measured.truncated ? { truncated: true } : {}) };
        }
        foldProbe[String(session.id ?? '?')] = row;
      }
    }

    let agentsProbe;
    if (cfg.probeAgents) {
      agentsProbe = {};
      try {
        const agents = ctx.get('agents');
        const whole = measureDeep(agents, 8000000);
        agentsProbe.service = { mb: Math.round(whole.chars / 1048576), nodes: whole.nodes, ...(whole.truncated ? { truncated: true } : {}) };
        const store = agents?.store;
        if (store instanceof Map) {
          const rows = [];
          for (const [id, entry] of store) {
            const measured = measureDeep(entry?.agent, 8000000);
            rows.push({ id: String(id).slice(0, 30), mb: Math.round(measured.chars / 1048576), nodes: measured.nodes, ...(measured.truncated ? { truncated: true } : {}) });
          }
          rows.sort((a, b) => b.mb - a.mb);
          agentsProbe.agents = rows.slice(0, 8);
        } else {
          agentsProbe.store = typeof store;
        }
      } catch (error) {
        agentsProbe.error = String(error?.message ?? error).slice(0, 120);
      }
    }

    let observer;
    if (cfg.evictObservationCache || underPressure) {
      observer = {};
      try {
        const engine = ctx.get('sessionQuery');
        const reader = engine?._observations ?? engine?.observations;
        const cache = reader?.cache;
        if (cache instanceof Map) {
          observer.capacityBefore = reader.cacheCapacity;
          observer.entries = cache.size;
          let dropped = 0;
          let pinned = 0;
          let droppedEvents = 0;
          let droppedMB = 0;
          for (const [id, entry] of [...cache]) {
            if (entry && typeof entry.refs === 'number' && entry.refs > 0) {
              pinned += 1;
              continue;
            }
            try {
              droppedMB += measureDeep(entry?.events).chars / 1048576;
            } catch {
              /* measuring is best effort */
            }
            droppedEvents += Array.isArray(entry?.events) ? entry.events.length : 0;
            cache.delete(id);
            dropped += 1;
          }
          // Keep the cache from refilling five deep: one retained preparation is enough for reuse,
          // and every further entry is a full duplicate of a session's events. `cacheCapacity` is a
          // documented field of `SessionObservationReader` ("maximum unpinned cold observations
          // retained for reuse", default 5) whose own `evictPastCapacity` enforces it on every store,
          // so lowering it is the supported lever here — there is no setter, and evicting manually
          // without it just lets the reader refill on the next read.
          if (reader.cacheCapacity > 1) reader.cacheCapacity = 1;
          observer.dropped = dropped;
          observer.pinned = pinned;
          observer.droppedEvents = droppedEvents;
          observer.droppedMB = Math.round(droppedMB);
          observer.capacityAfter = reader.cacheCapacity;
        } else {
          observer.unavailable = true;
          observer.engine = typeof engine;
        }
      } catch (error) {
        observer.error = String(error?.message ?? error).slice(0, 120);
      }
    }

    let ranking;
    if (cfg.probeGlobal) {
      ranking = [];
      // Cordis throws on reading a service property that this plugin did not inject, so every
      // property read has to happen inside the guard, not in the argument list.
      const weigh = (label, get) => {
        let root;
        try {
          root = get();
        } catch (error) {
          ranking.push({ label, readError: String(error?.message ?? error).slice(0, 60) });
          return;
        }
        if (root === undefined || root === null) return;
        try {
          const measured = measureDeep(root, 3000000);
          if (measured.nodes < 200) return;
          ranking.push({
            label,
            nodes: measured.nodes,
            mb: Math.round((measured.chars / 1048576) * 10) / 10,
            ...(measured.truncated ? { truncated: true } : {}),
          });
        } catch (error) {
          ranking.push({ label, error: String(error?.message ?? error).slice(0, 60) });
        }
      };
      const candidates = [
        ['ctx', () => ctx],
        ['ctx.root', () => ctx.root],
        ['ctx.registry', () => ctx.registry],
        ['service.sessions', () => ctx.sessions],
      ];
      let root = null;
      try {
        root = ctx.root ?? ctx;
      } catch {
        root = null;
      }
      if (root && typeof root === 'object') {
        for (const key of Object.keys(root)) candidates.push([`root.${key}`, () => root[key]]);
      }
      for (const [label, get] of candidates) weigh(label, get);
      ranking.sort((a, b) => (b.nodes ?? 0) - (a.nodes ?? 0));
      ranking = ranking.slice(0, 15);
    }
    let fields;
    if (cfg.probeSession) {
      fields = {};
      for (const session of sessions) {
        const row = {};
        for (const key of Object.keys(session ?? {})) {
          const value = session[key];
          if (value === undefined || value === null) continue;
          try {
            // `log` gets a larger budget because it dominates; every other field is small.
            const measured = measureDeep(value, 8000000);
            if (measured.nodes === 0) continue;
            row[key] = {
              mb: Math.round((measured.chars / 1048576) * 10) / 10,
              nodes: measured.nodes,
              ...(measured.truncated ? { truncated: true } : {}),
            };
          } catch (error) {
            row[key] = { error: String(error?.message ?? error).slice(0, 80) };
          }
        }
        fields[String(session.id ?? '?')] = row;
      }
    }

    let derived;
    if (cfg.measureDerived) {
      derived = {};
      for (const session of sessions) {
        const targets = {
          // `log` is deliberately not measured: it is the largest structure, a full walk is
          // truncated anyway, and touching event fields risks materialising lazy payloads.
          derivedNodes: session?.derivedNodes,
          contextFold: session?.contextFold,
          headerFold: session?.headerFold,
          toolHistoryProjection: session?.toolHistoryProjection,
          eventsSnapshot: session?.eventsSnapshot,
        };
        const row = {};
        for (const [key, value] of Object.entries(targets)) {
          if (value === undefined || value === null) continue;
          try {
            const measured = measureDeep(value);
            if (measured.nodes === 0) continue;
            row[key] = {
              strings: measured.strings,
              mb: Math.round(measured.chars / 1048576),
              nodes: measured.nodes,
              ...(measured.truncated ? { truncated: true } : {}),
            };
          } catch (error) {
            row[key] = { error: String(error?.message ?? error) };
          }
        }
        derived[String(session.id ?? '?')] = row;
      }
    }

    // Diagnostic: the large session reports no long strings in the Host even though the same log
    // yields tens of thousands offline. Record one candidate event's actual shape so the difference
    // is visible instead of guessed.
    let shape;
    if (cfg.probe && shape === undefined) {
      for (const session of sessions) {
        const log = session?.log;
        if (!Array.isArray(log) || log.length <= cfg.keepLastEvents) continue;
        // Aggregate, not a single sample: the oldest event in the log is not representative, and a
        // one-event probe cannot tell "payload is absent" from "this event happened to be small".
        let events = 0;
        let strings = 0;
        let chars = 0;
        let le63 = 0;
        let le255 = 0;
        let le1023 = 0;
        let ge1024 = 0;
        let le63Chars = 0;
        let le255Chars = 0;
        let le1023Chars = 0;
        let ge1024Chars = 0;
        let emptyStrings = 0;
        const scan = (value, depth) => {
          if (depth > 8) return;
          if (typeof value === 'string') {
            strings += 1;
            chars += value.length;
            if (value.length === 0) {
              emptyStrings += 1;
            } else if (value.length <= 63) {
              le63 += 1;
              le63Chars += value.length;
            } else if (value.length <= 255) {
              le255 += 1;
              le255Chars += value.length;
            } else if (value.length <= 1023) {
              le1023 += 1;
              le1023Chars += value.length;
            } else {
              ge1024 += 1;
              ge1024Chars += value.length;
            }
            return;
          }
          if (Array.isArray(value)) {
            for (const item of value) scan(item, depth + 1);
            return;
          }
          if (value !== null && typeof value === 'object') {
            for (const key of Object.keys(value)) scan(value[key], depth + 1);
          }
        };
        const probeLimit = Math.min(keepFrom, 5000);
        for (let i = 0; i < probeLimit; i += 1) {
          const event = log[i];
          if (!event || typeof event !== 'object' || !keep.has(event.type)) continue;
          events += 1;
          scan(event, 0);
        }
        const sample = log.find((e) => e && typeof e === 'object' && keep.has(e.type));
        shape = {
          id: String(session.id ?? '?'),
          sampledEvents: events,
          strings,
          charsMB: Math.round(chars / 1048576),
          buckets: {
            '<=63': { n: le63, mb: Math.round(le63Chars / 1048576) },
            '64-255': { n: le255, mb: Math.round(le255Chars / 1048576) },
            '256-1023': { n: le1023, mb: Math.round(le1023Chars / 1048576) },
            '>=1024': { n: ge1024, mb: Math.round(ge1024Chars / 1048576) },
          },
          emptyStrings,
          sample: sample
            ? {
                type: sample.type,
                keys: Object.keys(sample).slice(0, 8),
                dataKeys: sample.data && typeof sample.data === 'object' ? Object.keys(sample.data).slice(0, 8) : null,
                frozen: Object.isFrozen(sample),
              }
            : null,
        };
        break;
      }
    }

    // Space layout separates "many small objects" from "a few huge ones"; the fix differs.
    let spaces;
    try {
      spaces = {};
      for (const space of v8.getHeapSpaceStatistics()) {
        const used = Math.round(space.space_used_size / 1048576);
        if (used < 1) continue;
        spaces[space.space_name] = { usedMB: used, sizeMB: Math.round(space.space_size / 1048576) };
      }
    } catch {
      spaces = null;
    }

    // How long this tick held the loop. A cold index scan used to happen in one call and pushed
    // this into the seconds; it is now bounded by indexBudgetMs, so the number belongs in the log.
    return {
      heapMB,
      heapBeforeGC,
      ms: Math.round(Date.now() - tickStartedAt),
      hydration: hydrationStats(),
      indexPool: indexPool.stats(),
      ...(spaces ? { spaces } : {}),
      gcAvailable: typeof resolveCollect() === 'function',
      gc: didGc,
      rssMB: Math.round(usage.rss / 1048576),
      externalMB: Math.round(usage.external / 1048576),
      arrayBuffersMB: Math.round(usage.arrayBuffers / 1048576),
      sessions: sessions.length,
      perSession,
      ...(shape ? { shape } : {}),
      ...(derived ? { derived } : {}),
      ...(fields ? { fields } : {}),
      ...(ranking ? { ranking } : {}),
      ...(observer ? { observer } : {}),
      ...(underPressure ? { underPressure: true } : {}),
      ...(agentsProbe ? { agentsProbe } : {}),
      ...(foldProbe ? { foldProbe } : {}),
    };
  };

  let ticks = 0;
  const tick = () => {
    if (stopped) return;
    // A superseded instance must stay silent: its timer survives the reload that created us.
    if (REGISTRY.active !== me) return;
    ticks += 1;
    try {
      record({ tick: ticks, dryRun: cfg.dryRun, ...reap() });
    } catch (error) {
      record({ tick: ticks, dryRun: cfg.dryRun, error: String(error?.message ?? error) });
    }
  };

  const guardedTick = () => {
    // The fatal boundary: nothing may escape into the Host's timer machinery.
    try {
      tick();
    } catch {
      /* swallowed on purpose */
    }
  };

  let stopTimer = null;
  try {
    if (typeof ctx.interval === 'function') {
      stopTimer = ctx.interval(guardedTick, cfg.intervalMs);
    } else if (typeof ctx.timer?.interval === 'function') {
      stopTimer = ctx.timer.interval(guardedTick, cfg.intervalMs);
    }
  } catch {
    stopTimer = null;
  }
  let usedGlobalTimer = false;
  if (typeof stopTimer !== 'function') {
    const timer = setInterval(guardedTick, cfg.intervalMs);
    stopTimer = () => clearInterval(timer);
    usedGlobalTimer = true;
  }

  try {
    ctx.on('dispose', () => {
      stopped = true;
      try {
        stopTimer?.();
      } catch {
        /* ignore */
      }
      // Residual lazy views remain readable through ephemeral leases, but no warm table survives.
      indexPool.close();
      clearHydration();
    });
  } catch {
    /* best-effort: ctx.interval already ties the timer to the fiber */
  }

  // `name` records which module build is live: the row id and this label are separate, and a reload
  // that silently kept an older instance would otherwise be invisible in the telemetry.
  record({ event: 'loaded', name, config: cfg, logFile, timer: usedGlobalTimer ? 'global' : 'cordis' });

  // First sample immediately: do not let the initial measurement depend on timer behaviour.
  try {
    tick();
  } catch {
    /* never let the first sample abort the mount */
  }
}
