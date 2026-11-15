// Runtime substitution with on-demand loading.
//
// The session log on disk is the single source of truth and is never rewritten. In memory, a
// historical event keeps only its identity (type, seq, time); its payload is re-read from the log
// the first time anything touches it. Consumers therefore observe byte-identical data while the
// bytes are absent from the heap.
//
// Frames: the log is a sequence of independent zstd frames. `zstdDecompressSync(raw, { info: true })`
// reports how many input bytes a frame consumed (`engine.bytesWritten`), which is the only reliable
// way to walk them — scanning for the zstd magic splits frames that merely contain those bytes and
// silently drops events, which made an early version hydrate a neighbouring event.
//
// A decode does not always stop after one frame: given two small concatenated frames it returned both
// and reported their combined length (measured: 329 + 68 bytes of input, 262,208 characters out,
// bytesWritten 397), while two 18-byte frames yielded only the first. Both outcomes are harmless here
// because a record only ever spans whole frames — `consumed` always lands on a frame boundary — so the
// table is coarser in that case, never wrong, and `framePayloads` decodes the same range the same way.
//
// Indexing must not stall the Host. A full pass over the largest session here (221 MB, 136,882
// frames) costs ~5 s and holds ~220 MB, and it used to run synchronously inside the tick for every
// session — the freeze a user feels as "the session is still loading". So:
//
//   * the scan is chunked: `advance(budgetMs)` decodes frames from a sliding window until the budget
//     is spent and returns, leaving the rest for the next tick;
//   * it is incremental: only bytes past the last scanned offset are ever read again;
//   * the result is cached on disk, so a Host restart re-reads a 3 MB table instead of 221 MB;
//   * lookup is a binary search over frame boundaries instead of a Map with one entry per event
//     (280k entries, ~40 MB); the table is four flat arrays, ~20 bytes per frame.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const HEAD = /^\{"type":"[^"]{1,48}","seq":(\d+),/u;
// Key order is not part of the contract, only that `type` precedes `seq` at the top level: a reader
// that spelled a line `{"seq":91,"type":"…"}` made every frame look empty, so the table covered the
// whole file with no events in it and every lookup threw. Fall back to the bare key rather than
// declaring the line event-less.
const SEQ_KEY = /"seq":(\d+)/u;

/** The event seq a log line carries, or -1 when the line is not an event (the session header). */
function seqOf(line) {
  const head = HEAD.exec(line);
  if (head !== null) return Number(head[1]);
  if (!line.startsWith('{"')) return -1;
  const loose = SEQ_KEY.exec(line);
  return loose === null ? -1 : Number(loose[1]);
}

/** Keys re-read on access. Everything else on an event is identity and stays resident. */
const PAYLOAD_KEYS = new Set(['data', 'sourceEventSeqs', 'surfaceOp']);

const CACHE_MAGIC = 'DSRI';
const CACHE_VERSION = 3;
// v2 adds an 8-byte fingerprint of the first frame's raw bytes. A rewritten log of exactly the same
// length passed every check v1 had (`covered <= size`), so a stale table was adopted and answered
// reads with whatever now sat at those offsets.
// v3 appends the `session/end-seed` marker records after the frame records, so an open-time lazy
// decode can derive the inherited cut without re-reading the log. A v2 table is rejected and
// rescanned once; the frame layout itself is unchanged.
const CACHE_HEADER = 36;
const CACHE_RECORD = 24;
const CACHE_DIGEST_AT = 28;
// Spare header word since v3: how many marker records follow the frame records.
const CACHE_MARKER_COUNT_AT = 32;
// seq (u32), inherited flag (u32), owning frame index (u32).
const CACHE_MARKER_RECORD = 12;
const CACHE_DIGEST_LEN = 256;
const NO_SEQ = 0xffffffff;
// The encoder writes `type` first, so a marker line is recognizable without parsing it. Only the
// matching lines (a handful per log, all near the head) pay a JSON.parse.
const END_SEED_HEAD = /^\{"type":"session\/end-seed","seq":(\d+),/u;
// Returned by `decodeAt` when the bytes at an offset are not the start of a frame at all, as opposed
// to a frame that is only partly written. Distinct from `null`, which means "wait for more bytes".
const GARBAGE = Symbol('not a frame start');

/** FNV-1a over the first bytes of the log: the session id and the first event are inside it. */
function fingerprint(buffer) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < buffer.length; i += 1) {
    hash ^= buffer[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * One index per session log.
 *
 * `cacheFile` is optional: when given, `advance` writes the frame table there and a later `create`
 * adopts it, which is what turns a restart from a full re-scan into a few milliseconds.
 */
export function createLogIndex(file, options = {}) {
  const cacheFile = options.cacheFile ?? null;
  const baseWindow = Math.max(64 * 1024, options.chunkBytes ?? 4 * 1024 * 1024);
  const maxWindow = 256 * 1024 * 1024;

  const starts = [];
  const ends = [];
  const firstSeqs = [];
  const lastSeqs = [];
  let events = 0;
  let lastSeq = -1;
  let scannedTo = 0;
  let complete = false;
  let savedFrames = 0;
  // Whether every event seq is dense (no gap, no duplicate) within and across frames. The open-time
  // lazy decode refuses a non-dense table so the original decoder owns the corruption diagnostic;
  // `saveCache` never persists one, so an adopted table is dense by construction.
  let dense = true;
  // The next seq a dense log must carry. A duplicate-and-missing pair keeps a frame's count equal to
  // its span, so only a per-event expectation catches it.
  let expectedSeq = 0;
  // `session/end-seed` markers found during the scan: { seq, inherited, frame }. The open-time lazy
  // decode derives the inherited cut from the last `inherited` one; the frame index lets a provisional
  // rollback drop exactly the markers of the undone frames.
  const markers = [];
  // Set when the log turns out to be shorter than the bytes this table covers: the file was
  // rewritten or cleared, so every recorded offset points somewhere else. Reads must fail loudly
  // rather than decode whatever now sits at that offset.
  let stale = false;

  let fd;
  const openFd = () => {
    if (fd === undefined) fd = fs.openSync(file, 'r');
    return fd;
  };

  // ---- sliding read window for the scan -------------------------------------------------------
  let window = null;
  let windowStart = 0;
  // Real frames reach 30 MB of plaintext from ~4.5 MB of input here, so a frame can easily be wider
  // than the read window. This is the point at which a frame is called torn rather than merely wide.
  const MAX_FRAME_WINDOW = 64 * 1024 * 1024;

  /**
   * Read at least `want` bytes at `pos` into the sliding window.
   *
   * The window holds the file's own bytes and is handed to zstd as a subarray, so it is not copied;
   * `advance` drops it as soon as the table covers the file.
   */
  function fill(pos, want) {
    const size = Math.min(maxWindow, Math.max(baseWindow, want));
    const buffer = Buffer.allocUnsafe(size);
    const read = fs.readSync(openFd(), buffer, 0, size, pos);
    window = buffer.subarray(0, read);
    windowStart = pos;
    return read;
  }

  /** Does a decodable frame start at `pos`? null when the window cannot answer (no bytes there). */
  function startsNewFrame(pos) {
    const offset = pos - windowStart;
    if (offset < 0 || offset >= window.length) return null;
    try {
      zlib.zstdDecompressSync(window.subarray(offset));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Decode the frame at `pos`; null at end of file, or when this frame is not fully on disk yet.
   *
   * Telling those two apart is the whole point. A frame that is only partly present decodes without
   * any error: zstd returns the plaintext it could produce and reports the input it consumed
   * (measured on a 400,959-byte frame cut at 128 KB: 131,072 characters, bytesWritten 131,072). It
   * looks exactly like a complete frame — one 48 MB log here decodes its second frame into 30 MB of
   * text after consuming precisely the 4 MB it was given. So the boundary has to be proven:
   *
   *   * the decoder stopped before the end of the bytes it was given — it saw a whole frame; or
   *   * it consumed everything it was given, and the bytes right after decode as a frame of their
   *     own — that is the boundary; or
   *   * it consumed everything and there is nothing after — the file ends here, and the frame is
   *     complete only if it ends on a line boundary, because every line the Host writes does.
   *
   * Without this a torn frame was recorded as a frame holding no events, `scannedTo` stopped at its
   * start, every later event became unreachable and unreapable, and the bogus table was cached and
   * re-adopted by the next Host start.
   */
  function decodeAt(pos, size) {
    let allThrew = true;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (window === null || pos < windowStart || pos >= windowStart + window.length) {
        if (fill(pos, 0) === 0) return null;
      }
      const available = windowStart + window.length - pos;
      let out = null;
      try {
        out = zlib.zstdDecompressSync(window.subarray(pos - windowStart), { info: true });
      } catch {
        out = null; // the frame crosses the window, or is larger than it: read more and retry
      }
      if (out !== null) {
        allThrew = false;
        const consumed = out.engine.bytesWritten;
        if (!consumed) return null;
        const end = pos + consumed;
        const atEnd = end >= size;
        // A trailing 0x0a cannot be a UTF-8 continuation byte, so this is the text ending in "\n".
        const endsOnLine = out.buffer.length > 0 && out.buffer[out.buffer.length - 1] === 0x0a;
        if (consumed < available || (atEnd ? endsOnLine : startsNewFrame(end) === true)) {
          return { end, text: out.buffer.toString('utf8') };
        }
      }
      // This frame needs more input. Give up when the window already reaches end of file, or when the
      // frame would have to be implausibly wide: either way the tail is only partly written.
      if (pos + available >= size) {
        // Every decode of the whole rest of the file threw: these bytes cannot begin a frame at all,
        // so whatever produced this offset was wrong rather than early. A torn frame never throws.
        return allThrew ? GARBAGE : null;
      }
      const want = Math.min(size - pos, Math.max(baseWindow, available * 2), MAX_FRAME_WINDOW);
      if (want <= available) return null;
      if (fill(pos, want) === 0) return null;
    }
    return null;
  }

  function record(start, end, text) {
    let first = -1;
    let last = -1;
    let count = 0;
    const frameMarkers = [];
    for (const line of text.split('\n')) {
      if (line.length === 0) continue;
      const seq = seqOf(line);
      if (seq < 0) continue;
      if (seq !== expectedSeq) dense = false;
      expectedSeq = seq + 1;
      if (first < 0) first = seq;
      last = seq;
      count += 1;
      const marker = END_SEED_HEAD.exec(line);
      if (marker !== null) {
        // A malformed marker line is left to the Host's decoder to refuse; the table only records
        // what parses, and a missing marker makes the lazy open fall back to the full decode.
        try {
          const parsed = JSON.parse(line);
          frameMarkers.push({ seq, inherited: parsed?.data?.inherited === true, frame: ends.length });
        } catch {
          /* unparseable marker: the full decode owns the refusal */
        }
      }
    }
    // An event-less frame is only legitimate as the first one: that is where the session header
    // lives. Recording one mid-file would break the monotonic `lastSeqs` the binary search needs.
    if (count === 0 && ends.length > 0) return;
    starts.push(start);
    ends.push(end);
    firstSeqs.push(first);
    lastSeqs.push(last);
    events += count;
    if (last > lastSeq) lastSeq = last;
    for (const marker of frameMarkers) markers.push(marker);
  }

  // Where the scan stopped because the frame there is not complete yet, and how big the file was:
  // retrying the same half-frame every tick re-decoded up to 60 MB of window for nothing.
  let blockedAt = -1;
  let blockedSize = -1;
  // The offset at which the table reached the end of the file. A frame that ends exactly there is
  // accepted on structure alone (see `decodeAt`), so this boundary is provisional: the next append
  // proves or refutes it. Real logs carry no decompressed-size field in the frame header (checked on
  // 40 frames of the 238 MB session: all `null`), so the bytes are the only evidence available.
  let eofBoundary = -1;
  // What the table looked like just before the record that ended at `eofBoundary`, so a refuted
  // boundary costs one frame's work instead of a rescan of the whole file.
  let provisional = null;
  // A table adopted from disk was never checked by this process: its last offset could have been
  // recorded while the log was being written (see `eofBoundary`). If the bytes there turn out not to
  // begin a frame, the table is rebuilt once — the cost of one rescan is worth never stalling a
  // session behind an offset that can never decode. A second such hit stops the scan in front of it
  // rather than rescanning forever: that would be real damage in the log, not a stale table.
  let adoptedFromCache = false;
  let rebuiltAfterAdopt = false;

  /** Can a frame be decoded at `pos` right now? Fills the window when it does not cover `pos`. */
  function frameStartsAt(pos) {
    if (window === null || pos < windowStart || pos >= windowStart + window.length) {
      if (fill(pos, 0) === 0) return false;
    }
    return startsNewFrame(pos) === true;
  }

  /**
   * Decode frames until `budgetMs` is spent or the log is exhausted.
   * Returns how far the table got, so a caller can spread a cold scan across ticks.
   */
  function advance(budgetMs = Infinity) {
    const startedAt = Date.now();
    const size = fs.statSync(file).size;
    // A write that stops exactly on a line boundary produces a last frame that looks complete: the
    // text ends with a newline because the truncation landed on one. Nothing in a real frame can
    // distinguish that (no content-size field, see `eofBoundary`), so the boundary is re-tested as
    // soon as more bytes land: if those bytes do not begin with a frame, the boundary was wrong and
    // every later frame would be unreachable. The file only ever grows by appending, so the whole
    // table is rebuilt rather than guessed at.
    if (eofBoundary > 0 && size > eofBoundary) {
      if (frameStartsAt(eofBoundary)) {
        eofBoundary = -1;
        provisional = null;
      } else if (provisional !== null && provisional.end === eofBoundary) {
        // Only the record that ended at the old end of file can be wrong: everything before it was
        // followed by a frame that decoded, which is proof. Undo that one record and rescan from its
        // start, where the window now holds the whole frame.
        starts.length = provisional.count;
        ends.length = provisional.count;
        firstSeqs.length = provisional.count;
        lastSeqs.length = provisional.count;
        events = provisional.events;
        lastSeq = provisional.lastSeq;
        expectedSeq = lastSeq + 1;
        scannedTo = provisional.start;
        eofBoundary = -1;
        // Markers of the undone frames go with them; a rescan re-records them.
        for (let i = markers.length - 1; i >= 0; i -= 1) {
          if (markers[i].frame >= provisional.count) markers.splice(i, 1);
        }
        provisional = null;
      } else {
        resetState();
      }
    }
    let added = 0;
    while (scannedTo < size) {
      if (scannedTo === blockedAt && size === blockedSize) break;
      const frame = decodeAt(scannedTo, size);
      if (frame === GARBAGE) {
        if (adoptedFromCache && !rebuiltAfterAdopt) {
          rebuiltAfterAdopt = true;
          resetState();
          continue;
        }
        blockedAt = scannedTo;
        blockedSize = size;
        break;
      }
      if (!frame) {
        blockedAt = scannedTo;
        blockedSize = size;
        break;
      }
      blockedAt = -1;
      blockedSize = -1;
      const start = scannedTo;
      const countBefore = ends.length;
      const eventsBefore = events;
      const lastSeqBefore = lastSeq;
      record(start, frame.end, frame.text);
      // Remember what this record replaced: if the bytes that follow later turn out not to begin a
      // frame, only this record has to be undone.
      if (frame.end >= size) provisional = { start, end: frame.end, count: countBefore, events: eventsBefore, lastSeq: lastSeqBefore };
      scannedTo = frame.end;
      added += 1;
      // Checking the clock every 64 frames assumed small frames. One frame here can be 4.5 MB of
      // input and 30 MB of text, so 64 of them would be gigabytes of work in a single tick before the
      // budget was consulted. A wide frame asks the clock every time.
      const wide = frame.end - start > 1 << 18;
      if ((wide || (added & 63) === 0) && Date.now() - startedAt >= budgetMs) break;
    }
    complete = scannedTo >= size;
    // The scan owns the bytes; the table does not need them once it covers the file. Keeping the
    // last window alive held up to `baseWindow` (4 MB) of log for the life of the process.
    if (complete) {
      window = null;
      if (scannedTo > 0) eofBoundary = scannedTo;
    }
    return { added, scannedTo, complete, blocked: blockedAt >= 0 };
  }

  function fileSize() {
    try {
      return fs.statSync(file).size;
    } catch {
      return -1;
    }
  }

  /**
   * What the scheduler should do with this table right now.
   *
   * 'advance' — undecoded frames remain at the end: the first cold scan, or a running session that
   * appended events since the last pass. A table that reached end of file is NOT finished for the
   * life of the process; a live session keeps writing, and those events stay resident objects until
   * the table covers them.
   * 'rewound' — the file is shorter than the covered range: it was rewritten, so the offsets are
   * stale and the table must be rebuilt rather than advanced.
   * 'idle' — the table covers the whole file.
   */
  function scanState() {
    const size = fileSize();
    if (size < 0) return 'idle';
    if (size < scannedTo) {
      stale = true;
      return 'rewound';
    }
    if (!complete || size > scannedTo) return 'advance';
    return 'idle';
  }

  // ---- binary search over the frame table ------------------------------------------------------
  function frameFor(seq) {
    let lo = 0;
    let hi = lastSeqs.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lastSeqs[mid] >= seq) {
        found = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    if (found >= 0 && firstSeqs[found] <= seq) return found;
    return -1;
  }

  // One decompressed frame is kept: sequential reads hit the same frame one to three times.
  let cachedIndex = -1;
  let cachedSeqs = null;
  let cachedLines = null;
  let cachedTextBytes = 0;

  // A frame is ~1.6 KB here, so reading one per hydration paid a syscall per 1.6 KB and dominated a
  // sequential pass (76,736 views took 9.2 s). Reading 256 KB at a time turns ~40k syscalls into
  // ~250 while adding 256 KB per warm index.
  const READ_WINDOW = 256 * 1024;
  // The retained window is bounded: a frame larger than this is read whole and then dropped, so the
  // resident bytes do not follow the largest payload in the log.
  const READ_CACHE_MAX = 512 * 1024;
  let readStart = -1;
  let readBuffer = null;

  function readRange(start, end) {
    const length = end - start;
    if (length <= 0) throw new Error(`frame at ${start} in ${file} covers no bytes`);
    if (readBuffer !== null && start >= readStart && end <= readStart + readBuffer.length) {
      return readBuffer.subarray(start - readStart, end - readStart);
    }
    const want = Math.max(READ_WINDOW, length);
    const buffer = Buffer.allocUnsafe(want);
    const read = fs.readSync(openFd(), buffer, 0, want, start);
    if (read < length) {
      // The log no longer holds the bytes this table covers, so every offset in it is suspect. Mark
      // the table unusable here rather than at the next scan: `has` must stop claiming events are
      // readable, and `close` must not persist a table that would be adopted again.
      stale = true;
      const error = new Error(`short read at ${start} in ${file}: the log is shorter than the frame table covers`);
      error.code = 'ESHORTREAD';
      throw error;
    }
    if (want <= READ_CACHE_MAX) {
      readBuffer = buffer.subarray(0, read);
      readStart = start;
    } else {
      readBuffer = null;
      readStart = -1;
    }
    return buffer.subarray(0, length);
  }

  function framePayloads(index) {
    if (cachedIndex === index) return;
    const buffer = readRange(starts[index], ends[index]);
    const text = zlib.zstdDecompressSync(buffer).toString('utf8');
    cachedTextBytes = text.length * 2;
    const seqs = [];
    const lines = [];
    for (const line of text.split('\n')) {
      if (line.length === 0) continue;
      const seq = seqOf(line);
      if (seq < 0) continue;
      seqs.push(seq);
      lines.push(line);
    }
    if (seqs.length === 0) throw new Error(`frame ${index} in ${file} carries no event`);
    cachedIndex = index;
    cachedSeqs = seqs;
    cachedLines = lines;
  }

  // ---- on-disk cache --------------------------------------------------------------------------
  // Whether the file on disk currently starts with a header this table owns. Only then may a save
  // append to it; otherwise the whole table is rewritten.
  let cacheUsable = false;

  function writeRecord(view, at, index) {
    view.setFloat64(at, starts[index], true);
    view.setFloat64(at + 8, ends[index], true);
    view.setUint32(at + 16, firstSeqs[index] < 0 ? NO_SEQ : firstSeqs[index], true);
    view.setUint32(at + 20, lastSeqs[index] < 0 ? NO_SEQ : lastSeqs[index], true);
  }

  function writeHeader(view, covered, count, digest, storedEvents, storedLastSeq, markerCount) {
    view.setUint32(4, CACHE_VERSION, true);
    view.setFloat64(8, covered, true);
    view.setUint32(16, storedEvents, true);
    view.setUint32(20, storedLastSeq < 0 ? NO_SEQ : storedLastSeq, true);
    view.setUint32(24, count, true);
    view.setUint32(CACHE_DIGEST_AT, digest, true);
    view.setUint32(CACHE_MARKER_COUNT_AT, markerCount, true);
  }

  function writeMarkers(view, at, list) {
    for (let i = 0; i < list.length; i += 1) {
      const off = at + i * CACHE_MARKER_RECORD;
      view.setUint32(off, list[i].seq, true);
      view.setUint32(off + 4, list[i].inherited ? 1 : 0, true);
      view.setUint32(off + 8, list[i].frame, true);
    }
  }

  /** Fingerprint of the bytes at the head of the log, recomputed on demand (one 256-byte read). */
  function cacheDigest() {
    if (ends.length === 0) return 0;
    const length = Math.min(CACHE_DIGEST_LEN, ends[0] - starts[0]);
    if (length <= 0) return 0;
    try {
      return fingerprint(readRange(starts[0], starts[0] + length));
    } catch {
      return 0;
    }
  }

  /** Drop everything this table knows, including the "stale" verdict, so a rescan can start over. */
  function resetState() {
    starts.length = 0;
    ends.length = 0;
    firstSeqs.length = 0;
    lastSeqs.length = 0;
    markers.length = 0;
    events = 0;
    lastSeq = -1;
    scannedTo = 0;
    savedFrames = 0;
    savedMarkerCount = 0;
    lastSavedOffset = -1;
    stale = false;
    complete = false;
    dense = true;
    expectedSeq = 0;
    blockedAt = -1;
    blockedSize = -1;
    eofBoundary = -1;
    provisional = null;
    // The table on disk describes offsets that this rescan replaces: rewrite it, never append.
    cacheUsable = false;
    window = null;
    readBuffer = null;
    readStart = -1;
    cachedIndex = -1;
    cachedSeqs = null;
    cachedLines = null;
    cachedTextBytes = 0;
  }

  function loadCache() {
    if (!cacheFile) return false;
    try {
      const buffer = fs.readFileSync(cacheFile);
      if (buffer.length < CACHE_HEADER || buffer.toString('latin1', 0, 4) !== CACHE_MAGIC) return false;
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      if (view.getUint32(4, true) !== CACHE_VERSION) return false;
      const covered = view.getFloat64(8, true);
      const count = view.getUint32(24, true);
      const markerCount = view.getUint32(CACHE_MARKER_COUNT_AT, true);
      if (count === 0 || buffer.length < CACHE_HEADER + count * CACHE_RECORD + markerCount * CACHE_MARKER_RECORD) return false;
      if (covered > fs.statSync(file).size) return false; // the log was rewritten: rescan
      for (let i = 0; i < count; i += 1) {
        const at = CACHE_HEADER + i * CACHE_RECORD;
        starts.push(view.getFloat64(at, true));
        ends.push(view.getFloat64(at + 8, true));
        const first = view.getUint32(at + 16, true);
        const last = view.getUint32(at + 20, true);
        firstSeqs.push(first === NO_SEQ ? -1 : first);
        lastSeqs.push(last === NO_SEQ ? -1 : last);
      }
      const markersAt = CACHE_HEADER + count * CACHE_RECORD;
      for (let i = 0; i < markerCount; i += 1) {
        const at = markersAt + i * CACHE_MARKER_RECORD;
        const seq = view.getUint32(at, true);
        const inherited = view.getUint32(at + 4, true) === 1;
        const frame = view.getUint32(at + 8, true);
        if (seq === NO_SEQ || frame >= count) {
          resetState();
          return false;
        }
        markers.push({ seq, inherited, frame });
      }
      // Frames are contiguous by construction. A table that is not cannot be resumed from: the header
      // and the records can be written in different runs, so check the shape before trusting it.
      let contiguous = ends[count - 1] === covered;
      for (let i = 1; contiguous && i < count; i += 1) contiguous = ends[i - 1] === starts[i];
      if (!contiguous || starts[0] !== 0) {
        resetState();
        return false;
      }
      // The offsets are only usable while the bytes they point at are the same bytes. A log rewritten
      // to exactly the same length satisfied every other check here.
      const head = readRange(starts[0], starts[0] + Math.min(CACHE_DIGEST_LEN, ends[0] - starts[0]));
      if (head.length === 0 || fingerprint(head) !== view.getUint32(CACHE_DIGEST_AT, true)) {
        resetState();
        return false;
      }
      events = view.getUint32(16, true);
      const storedLast = view.getUint32(20, true);
      lastSeq = storedLast === NO_SEQ ? -1 : storedLast;
      expectedSeq = lastSeq + 1;
      scannedTo = covered;
      savedFrames = count;
      savedMarkerCount = markerCount;
      lastSavedOffset = covered;
      cacheUsable = true;
      adoptedFromCache = true;
      return true;
    } catch {
      resetState();
      return false;
    }
  }

  function saveCache() {
    if (!cacheFile || ends.length === 0) return false;
    // A non-dense table describes a corrupt log; never persist it, so adoption can trust density.
    if (!dense) return false;
    // The record that ends at the end of the file was accepted on structure alone (see `decodeAt`),
    // so it is never written: a later start would adopt an offset nothing can re-verify. Holding it
    // back costs one frame's re-read next time, which is cheaper than a table that may be wrong.
    const holdBack = provisional !== null && provisional.end === ends[ends.length - 1] ? provisional : null;
    const count = holdBack === null ? ends.length : holdBack.count;
    const covered = holdBack === null ? scannedTo : holdBack.start;
    if (count === 0) return false;
    const storedMarkers = markers.filter(marker => marker.frame < count);
    if (count === savedFrames && covered === lastSavedOffset && storedMarkers.length === savedMarkerCount) return false;
    const digest = cacheDigest();
    if (digest === 0) return false;
    const storedEvents = holdBack === null ? events : holdBack.events;
    const storedLastSeq = holdBack === null ? lastSeq : holdBack.lastSeq;
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      const appendFrom = cacheUsable && savedFrames > 0 && savedFrames <= count ? savedFrames : 0;
      if (appendFrom === 0) {
        const buffer = Buffer.allocUnsafe(CACHE_HEADER + count * CACHE_RECORD + storedMarkers.length * CACHE_MARKER_RECORD);
        buffer.write(CACHE_MAGIC, 0, 'latin1');
        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        for (let i = 0; i < count; i += 1) writeRecord(view, CACHE_HEADER + i * CACHE_RECORD, i);
        writeMarkers(view, CACHE_HEADER + count * CACHE_RECORD, storedMarkers);
        writeHeader(view, covered, count, digest, storedEvents, storedLastSeq, storedMarkers.length);
        fs.writeFileSync(cacheFile, buffer);
      } else {
        // Only new frames arrived: append them instead of rewriting a multi-megabyte table every
        // time the session writes. The marker section follows the frame records, so the tail write
        // carries the new frames AND the (rewritten) markers; the header goes last, so a crash in
        // between leaves records the header does not claim (ignored by `loadCache`).
        const handle = fs.openSync(cacheFile, 'r+');
        try {
          const added = count - appendFrom;
          const tail = Buffer.allocUnsafe(added * CACHE_RECORD + storedMarkers.length * CACHE_MARKER_RECORD);
          const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
          for (let i = 0; i < added; i += 1) writeRecord(tailView, i * CACHE_RECORD, appendFrom + i);
          writeMarkers(tailView, added * CACHE_RECORD, storedMarkers);
          fs.writeSync(handle, tail, 0, tail.length, CACHE_HEADER + appendFrom * CACHE_RECORD);
          const header = Buffer.alloc(CACHE_HEADER);
          header.write(CACHE_MAGIC, 0, 'latin1');
          const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
          writeHeader(headerView, covered, count, digest, storedEvents, storedLastSeq, storedMarkers.length);
          fs.writeSync(handle, header, 0, header.length, 0);
        } finally {
          fs.closeSync(handle);
        }
      }
      savedFrames = count;
      savedMarkerCount = storedMarkers.length;
      lastSavedOffset = covered;
      cacheUsable = true;
      return true;
    } catch {
      // A half-written cache file is worse than none: stop appending to it until it is rewritten.
      cacheUsable = false;
      return false;
    }
  }

  let lastSavedOffset = -1;
  let savedMarkerCount = 0;
  const adopted = loadCache();

  const api = {
    file,
    cacheFile,
    adopted,
    /** Frame boundaries, kept flat: starts/ends are byte offsets, first/last are seq ranges. */
    get frameCount() {
      return ends.length;
    },
    get events() {
      return events;
    },
    get lastSeq() {
      return lastSeq;
    },
    /** `session/end-seed` markers in log order: { seq, inherited, frame }. */
    get endSeedMarkers() {
      return markers.slice();
    },
    get scannedTo() {
      return scannedTo;
    },
    get complete() {
      return complete;
    },
    /** Whether every indexed seq is dense (no gap, no duplicate) within and across frames. */
    get dense() {
      return dense;
    },
    // Four push-arrays including over-allocation and possible double elements. This is a
    // conservative cache weight, not a claim to measure V8's exact backing-store capacity.
    retainedBytes() {
      return ends.length * 64 + 4096 + (window?.buffer.byteLength ?? 0)
        + (readBuffer?.buffer.byteLength ?? 0) + cachedTextBytes
        + (cachedSeqs?.length ?? 0) * 96;
    },
    advance,
    fileSize,
    scanState,
    saveCache,
    /** Is `seq` durably on disk and inside the scanned region? */
    has(seq) {
      if (stale) return false;
      return seq >= 0 && seq <= lastSeq && frameFor(seq) >= 0;
    },
    hydrate(seq) {
      if (stale) throw new Error(`${file} was rewritten: the frame table is stale`);
      const index = frameFor(seq);
      if (index < 0) throw new Error(`seq ${seq} is not present in ${file}`);
      framePayloads(index);
      for (let i = 0; i < cachedSeqs.length; i += 1) {
        if (cachedSeqs[i] === seq) return JSON.parse(cachedLines[i]);
      }
      throw new Error(`seq ${seq} mapped to frame ${index} but absent from it`);
    },
    close(save = true) {
      // A stale table must not be persisted: the next start would adopt offsets that no longer match
      // the file. (`loadCache` would reject it, but the write is pointless.)
      if (save && !stale) saveCache();
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* already closed */
        }
        fd = undefined;
      }
      window = null;
      readBuffer = null;
      readStart = -1;
      cachedIndex = -1;
      cachedSeqs = null;
      cachedLines = null;
      cachedTextBytes = 0;
    },
  };
  return api;
}

/**
 * Build an index and scan the whole log now.
 *
 * The Host never uses this: it calls `advance` with a budget so the scan cannot stall a tick. Tests
 * and offline benches want the finished table in one call.
 */
export function createLogIndexSync(file, options = {}) {
  const index = createLogIndex(file, options);
  index.advance(Infinity);
  return index;
}

/**
 * Hydrated payloads live in a bounded LRU instead of a per-view closure.
 *
 * A view that cached its payload forever defeated the whole scheme: the surface fold walks every
 * event in order, so one pass re-materialises every payload that was just released and the heap
 * returns to where it started. A small bound keeps a hot working set without letting a full pass
 * become the new steady state.
 *
 * The key is the pair (index, seq), not seq alone. Every session numbers its events from zero, so a
 * seq-only key let one session's payload answer another session's read: the bytes were plausible
 * JSON from the same schema and only the content was wrong. Index ids come from a WeakMap over the
 * index's `hydrate` function, which is what a view already holds, so the composite stays numeric
 * and the LRU order stays global across sessions.
 */
const HYDRATED = new Map();
const HYDRATED_BYTES = new Map();
let hydratedBytes = 0;
// One oversized payload (above the per-entry ceiling) is remembered outside the LRU so consecutive
// getter reads of the SAME huge event reuse one parse instead of re-parsing it per key. It is a single
// slot, so it adds at most one payload to residency — the one currently being read.
let OVERSIZED = null;
let HYDRATION_LIMIT = 256;
// Counting entries bounds nothing: the 256 largest lines of a real log are 21.4 MB of JSON while the
// 99th percentile line is 30 KB, so one pass over a log with a few captured files resident hundreds
// of megabytes with the same 256-entry bound. The byte budget is what actually bounds the cache.
let HYDRATION_BYTES = 64 * 1024 * 1024;

const INDEX_IDS = new WeakMap();
let nextIndexId = 1;
const SEQ_STRIDE = 4_294_967_296;

function idOf(hydrate) {
  let id = INDEX_IDS.get(hydrate);
  if (id === undefined) {
    id = nextIndexId;
    nextIndexId += 1;
    INDEX_IDS.set(hydrate, id);
  }
  return id;
}

function cacheKey(seq, hydrate) {
  return idOf(hydrate) * SEQ_STRIDE + seq;
}

/** Clamp to a sane working set: below 8 a sequential pass degenerates into re-reading. */
export function setHydrationLimit(limit, bytes) {
  HYDRATION_LIMIT = Math.max(8, Math.trunc(limit) || 256);
  const wanted = Math.trunc(Number(bytes));
  // A floor rather than a policy: below this the cache cannot hold a working set, and a zero would
  // disable caching entirely through a config typo.
  if (Number.isFinite(wanted) && wanted > 0) HYDRATION_BYTES = Math.max(64 * 1024, wanted);
  evict();
}

export function hydrationStats() {
  return { cached: HYDRATED.size, limit: HYDRATION_LIMIT, bytes: hydratedBytes, byteLimit: HYDRATION_BYTES };
}

/** Drop every hydrated payload now; the next access re-reads it from the log. */
export function clearHydration() {
  const cached = HYDRATED.size;
  HYDRATED.clear();
  HYDRATED_BYTES.clear();
  hydratedBytes = 0;
  OVERSIZED = null;
  return cached;
}

/** Whether the payload of `seq` on this index is currently resident. */
export function isHydrated(seq, hydrate) {
  return HYDRATED.has(cacheKey(seq, hydrate));
}

/**
 * One getter per payload key, shared by every view of this module instance.
 *
 * The first version built the getters inside `lazyEvent`, so each view owned a fresh `load` closure
 * plus two to four getter closures. A heap snapshot at 1129 MB showed 593,427 closures named `get`
 * and 154,577 named `load` for 76,839 substituted events: the tick re-wrapped the whole log every
 * pass, so roughly 200k view generations were alive at once and the closures alone were 23.6 MB.
 * The getters read the view's own `__seq`/`__owner`, which is what lets one function serve all of
 * them without capturing anything.
 */
const GETTERS = new Map();

function getterFor(key) {
  let getter = GETTERS.get(key);
  if (getter === undefined) {
    getter = function readLazyPayload() {
      const seq = this.__seq;
      if (seq === undefined) throw new TypeError(`lazy view has no seq for "${key}"`);
      return loadEvent(seq, this.__owner)[key];
    };
    GETTERS.set(key, getter);
  }
  return getter;
}

/**
 * Resident size of a hydrated payload, walked in full.
 *
 * This is the number the byte budget enforces, so it must not undercount: an earlier version stopped
 * the walk at 1 MB and answered 64 for anything deeper than four levels, which let a payload of many
 * medium children (a parsed table, a long file listing) cache as ~1 MB while holding hundreds. The
 * budget then bounded the estimate, not the heap, and a handful of such payloads re-created the very
 * OOM this plugin exists to prevent. The walk is iterative (no recursion limit) and counts every
 * string at two bytes per UTF-16 character plus a header per string, key and object. It is O(payload),
 * the same order as the JSON.parse that produced the value.
 */
function estimateBytes(value) {
  const scalar = (item) => {
    if (typeof item === 'string') return 16 + item.length * 2;
    return 8;
  };
  if (value === null || typeof value !== 'object') return scalar(value);
  let total = 32;
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const item of current) {
        if (item !== null && typeof item === 'object') { total += 32; stack.push(item); }
        else total += scalar(item);
      }
    } else {
      for (const key of Object.keys(current)) {
        total += 16 + key.length * 2;
        const child = current[key];
        if (child !== null && typeof child === 'object') { total += 32; stack.push(child); }
        else total += scalar(child);
      }
    }
  }
  return total;
}

/** An entry larger than this is handed to the caller but kept out of the cache. */
function entryCeiling() {
  return Math.max(1 << 20, Math.floor(HYDRATION_BYTES / 4));
}

function forget(key) {
  if (!HYDRATED.delete(key)) return;
  const size = HYDRATED_BYTES.get(key) ?? 0;
  HYDRATED_BYTES.delete(key);
  hydratedBytes -= size;
}

function evict() {
  while (HYDRATED.size > HYDRATION_LIMIT || hydratedBytes > HYDRATION_BYTES) {
    const oldest = HYDRATED.keys().next();
    if (oldest.done) break;
    forget(oldest.value);
  }
}

function loadEvent(seq, hydrate) {
  const key = cacheKey(seq, hydrate);
  const hit = HYDRATED.get(key);
  if (hit !== undefined) {
    HYDRATED.delete(key);
    HYDRATED.set(key, hit);
    return hit;
  }
  if (OVERSIZED !== null && OVERSIZED.key === key) return OVERSIZED.value;
  const value = hydrate(seq);
  const size = estimateBytes(value);
  if (size <= entryCeiling()) {
    OVERSIZED = null;
    HYDRATED.set(key, value);
    HYDRATED_BYTES.set(key, size);
    hydratedBytes += size;
    evict();
  } else {
    OVERSIZED = { key, value };
  }
  return value;
}

/**
 * Replace one resident event with a view that re-reads itself from the log on first access.
 * Identity fields stay real so list/fold logic that only looks at type and seq keeps working.
 *
 * Every own key of the original is preserved, in the original order, and only the payload keys
 * become getters. An earlier version copied a fixed list of keys, which silently dropped anything
 * outside it — `ignorable`, for instance, whose absence tells a reader to refuse reconstruction.
 * Payload keys are never read here, so re-wrapping an existing view (a reload) does not hydrate it.
 */
export function lazyEvent(event, seq, hydrate) {
  const descriptors = {};
  // Record the size while the payload is still here. Reading it back later would hydrate the very
  // thing this view exists to release, and the byte budget has to be able to measure a released
  // window without pulling it into memory.
  const bytes = eventBytes(event);
  for (const key of Object.keys(event)) {
    if (PAYLOAD_KEYS.has(key)) {
      descriptors[key] = { get: getterFor(key), enumerable: true, configurable: true };
      continue;
    }
    descriptors[key] = { value: event[key], enumerable: true, writable: true, configurable: true };
  }
  const view = {};
  Object.defineProperties(view, descriptors);
  Object.defineProperties(view, {
    __seq: { value: seq, enumerable: false },
    __owner: { value: hydrate, enumerable: false },
    __lazy: { value: true, enumerable: false },
    __bytes: { value: bytes, enumerable: false },
  });
  return view;
}

/**
 * One open-time lazy view: the whole event lives on disk, including its identity fields.
 *
 * The post-open `lazyEvent` copies identity from a resident event; at open time no event is resident
 * yet, so every envelope key becomes a getter instead. That is faithful because the envelope is a
 * CLOSED key set — the Host's seed validation rejects any key outside these seven — so a fixed-key
 * view cannot drop a field. `seq` stays a real value: the frame index already knows it, and the
 * Host's contiguity check reads it for every event without paying a hydration.
 *
 * The view is frozen and its hydrate must return deeply frozen events: the persistence seam hands
 * these out as `shared-frozen`, and consumers rely on that immutability without copying.
 */
const OPEN_ENVELOPE_KEYS = ['type', 'time', 'data', 'surfaceOp', 'sourceEventSeqs', 'ignorable'];

export function lazyOpenEvent(seq, hydrate) {
  const view = {};
  const descriptors = {
    seq: { value: seq, enumerable: true, writable: false, configurable: false },
  };
  for (const key of OPEN_ENVELOPE_KEYS) {
    descriptors[key] = { get: getterFor(key), enumerable: true, configurable: false };
  }
  Object.defineProperties(view, descriptors);
  Object.defineProperties(view, {
    __seq: { value: seq, enumerable: false },
    __owner: { value: hydrate, enumerable: false },
    __lazy: { value: true, enumerable: false },
  });
  return Object.freeze(view);
}

/** Deep-freeze one freshly parsed JSON tree (no cycles by construction). */
export function freezeDeep(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) freezeDeep(value[key]);
  return value;
}

/**
 * Build the per-event guard shared by the open-time wrapper and the post-open tick.
 *
 * The host's eager decode refuses a stored log through a vocabulary gate (unknown event types that
 * are not `ignorable`), the retired `request/header` fallback shape, and per-event adoption. The lazy
 * path skips the eager decoder, so it must reproduce those refusals itself or it would silently
 * accept a log written by a newer harness — exactly what the host's fail-closed vocabulary exists to
 * prevent. `guard.known` is the HOST's own `KNOWN_SESSION_EVENT_TYPES` (resolved at runtime, never a
 * hardcoded copy that could drift); `guard.adopt` is the host's `adoptSessionEvent`. When the host
 * vocabulary could not be resolved, `guard.known` stays null and the open-time wrapper falls back to
 * the eager decode rather than serving unvalidated views.
 *
 * @param guard - shared mutable `{ known: ReadonlySet|null, adopt: function|null }`.
 * @param file - the log path, used only to name the session in refusal messages.
 * @returns a function that validates and deeply freezes one freshly parsed event.
 */
export function makeEventGuard(guard, file) {
  const id = file ? path.basename(path.dirname(file)) : 'session';
  return (event) => {
    if (event === null || typeof event !== 'object') return event;
    const known = guard?.known;
    if (known && !known.has(event.type) && event.ignorable !== true) {
      throw new Error(`session "${id}" contains event type "${event.type}" (seq ${event.seq}) unknown to this harness and not marked ignorable; refusing to interpret the log — it was likely written by a newer harness`);
    }
    if (event.type === 'request/header' && event.data !== null && typeof event.data === 'object'
      && event.data.reason === 'fallback') {
      throw new Error(`session "${id}" contains a request/header event (seq ${event.seq}) with the unsupported legacy reason "fallback"; refusing to interpret the log`);
    }
    if (typeof guard?.adopt === 'function') guard.adopt(event);
    return freezeDeep(event);
  };
}

/**
 * Where the resident window has to start for one session: the oldest surface node that the next
 * compaction or the next prompt can still read.
 *
 * A `compaction/summary` does not shadow everything before it. It shadows exactly the range it
 * summarized (`shadowedSeqs`) and the summary event itself is appended at the tail, so its seq says
 * nothing about what is still readable — on this machine a summary appended at seq 13,125 coexisted
 * with unshadowed surface nodes at seq 10,731, and the next compaction re-read exactly those.
 *
 * The surface node list is the authority instead. Anything below its oldest conversation node is
 * shadowed and will never be read again, so it may be released whatever its type; every node at or
 * after it is read by `buildSummarizationInput` and by building the next prompt.
 *
 * @param nodes - `session.surface.nodes`: surface event seqs in model-visible order.
 * @param skipHead - whether node 0 is the retained `system/message` head, which is never summarized.
 * @returns the oldest seq that must stay resident, or null when the surface exposes none.
 */
export function surfaceFloor(nodes, skipHead) {
  if (!Array.isArray(nodes)) return null;
  let floor = null;
  for (let i = skipHead === true ? 1 : 0; i < nodes.length; i += 1) {
    const seq = nodes[i];
    if (!Number.isInteger(seq)) continue;
    if (floor === null || seq < floor) floor = seq;
  }
  return floor;
}

/**
 * Substitute every event before `keepFrom` whose type is in `types`, or every such event when
 * `types` is `'*'`.
 * Returns counters instead of throwing: a half-applied substitution is still valid, because each
 * event is either fully resident or fully re-readable.
 *
 * A view already bound to this index is skipped. Re-wrapping it was the original bug: the getters
 * closed over `hydrate`, so they had to be rebuilt whenever the module reloaded, and rebuilding them
 * on every tick leaked a generation of views per pass. The owner token makes the two cases
 * distinguishable — same owner, keep the view; different owner (a reload), rebind it once.
 */
export function substituteLog(log, index, { keepFrom, types, from = 0, hydrate = index.hydrate }) {
  // `'*'` means every type. It is only safe together with a `keepFrom` that respects the newest
  // compaction boundary — see `compactionFloor` — because a type whose payload a fold reads again
  // turns every read into a disk read.
  const keep = types === '*' ? null : new Set(types);
  // Everything below `from` was decided by an earlier pass: it is either already a view of this
  // index or a type this pass never touches. Neither can change, so rescanning 280k events per tick
  // per session was pure loop time — ~270 ms a tick across nine sessions on this machine.
  const start = Math.max(0, Math.min(from, keepFrom));
  // Never substitute an event whose payload is not durably readable yet. The runtime log can be
  // ahead of the file: an event appended in the last second has no committed frame, and a view for
  // it would throw on first access instead of returning data.
  const ceiling = typeof index.lastSeq === 'number' ? index.lastSeq : -1;
  let substituted = 0;
  let skipped = 0;
  let pending = 0;
  let failures = 0;
  for (let i = start; i < keepFrom; i += 1) {
    const event = log[i];
    if (!event || typeof event !== 'object') continue;
    // Skip an already-lazy view of this index BEFORE reading its type: on an open-time view `type`
    // is a getter, so filtering on it first would hydrate every payload just to decide to skip it.
    if (event.__lazy === true && event.__owner === hydrate) {
      skipped += 1;
      continue;
    }
    if (keep !== null && !keep.has(event.type)) continue;
    // Key on the event's own seq, never on the array position. The index is built from the
    // `"seq":` field in each log line, and the file starts with records that carry no seq at all
    // (`session/header`), so position and seq diverge by at least one. Keying on `i` hydrated the
    // neighbouring event — byte-plausible, silently wrong, and invisible to a caller that only
    // checks that `data` is present.
    const key = Number.isInteger(event.seq) ? event.seq : i;
    if (key > ceiling) {
      pending += 1;
      continue;
    }
    try {
      log[i] = lazyEvent(event, key, hydrate);
      substituted += 1;
    } catch {
      failures += 1;
    }
  }
  return { substituted, skipped, pending, failures, scanned: keepFrom - start };
}

/** Per-event sizes, so a tick does not re-measure the window it measured last tick. */
const SIZES = new WeakMap();

/**
 * Estimate how many bytes one event holds, once.
 *
 * `keepLastEvents` is a count and a count says nothing about size: 2000 events of tool results can be
 * a few MB or a few hundred, and that multiplies by however many sessions are open. This is the
 * measurement the byte budget needs, kept cheap by three rules: a substituted event answers from the
 * size recorded when it was replaced (measuring it would hydrate the payload back into memory), a
 * plain event is measured once and remembered, and the walk never reads a payload through getters.
 *
 * A string counts as two bytes per character (payloads here are mostly ASCII, but Chinese session
 * text is stored as UTF-16), plus a header per string, key and object.
 *
 * @param event - a log entry, plain or substituted.
 * @returns approximate retained bytes.
 */
export function eventBytes(event) {
  if (event === null || typeof event !== 'object') return 0;
  if (event.__lazy === true) return typeof event.__bytes === 'number' ? event.__bytes : 128;
  const known = SIZES.get(event);
  if (known !== undefined) return known;
  const bytes = sizeOf(event, 0);
  SIZES.set(event, bytes);
  return bytes;
}

/** Recursive retained-size estimate; no early cap, because a budget needs the real number. */
function sizeOf(value, depth) {
  if (value === null || value === undefined) return 0;
  const kind = typeof value;
  if (kind === 'string') return 16 + value.length * 2;
  if (kind === 'number' || kind === 'boolean') return 8;
  if (kind !== 'object') return 0;
  if (depth > 6) return 64;
  let total = 32;
  if (Array.isArray(value)) {
    for (const item of value) total += sizeOf(item, depth + 1);
    return total;
  }
  for (const key of Object.keys(value)) total += 16 + key.length * 2 + sizeOf(value[key], depth + 1);
  return total;
}

/**
 * Move the window start forward until the events from there to the end fit a byte budget.
 *
 * Only ever releases more (the caller keeps the later of the two starts). The newest event is kept
 * even when it alone exceeds the budget: an empty window has no meaning and would make the session
 * pay a disk read for every write.
 *
 * @param log - the session's event array.
 * @param from - the earliest start the caller will accept.
 * @param budget - bytes to allow; `Infinity` only measures.
 * @returns `{ from, bytes }` for the window that fits.
 */
export function byteWindow(log, from, budget) {
  const start = Math.max(0, Math.min(from, log.length));
  let bytes = 0;
  let at = log.length;
  for (let i = log.length - 1; i >= start; i -= 1) {
    const size = eventBytes(log[i]);
    if (bytes + size > budget) break;
    bytes += size;
    at = i;
  }
  if (at === log.length && log.length > start) {
    at = log.length - 1;
    return { from: at, bytes: eventBytes(log[at]) };
  }
  return { from: at, bytes };
}

/**
 * Append-only telemetry writer, one row per call, in call order.
 *
 * The file is append-only and outlives every instance that writes to it, so two properties have to
 * hold for the file to stay analysable:
 *
 *   - **Call order.** A fire-and-forget `appendFile` per row let rows from two live instances land
 *     in promise-resolution order: measured on today's log, 6 rows shared a millisecond and a
 *     `loaded` row could appear after the first tick of the instance it announced. One promise chain
 *     fixes the order without blocking the caller.
 *   - **No append straddles the rotation.** The size check, the `rename` to `<file>.1` and the
 *     append happen inside that same chain, so a row can never be written into the renamed file.
 *
 * The timestamp is taken when the row is *created*, not when the write completes, so a delayed write
 * never makes a tick look later than it was.
 *
 * @param file - log path to append to.
 * @param options.maxBytes - rotate to `<file>.1` once the file is larger than this; 0 disables it.
 * @param options.now - clock used for the `at` field, injectable for tests.
 * @returns writer for one row; `writer.flush()` resolves when every queued row is on disk.
 */
export function createTelemetryWriter(file, options = {}) {
  const maxBytes = Math.max(0, Math.trunc(options.maxBytes ?? 8 * 1024 * 1024));
  const now = options.now ?? (() => new Date().toISOString());
  let directoryReady = false;
  let queue = Promise.resolve();
  const write = (row) => {
    const line = `${JSON.stringify({ at: now(), ...row })}\n`;
    queue = queue.then(async () => {
      try {
        if (!directoryReady) {
          await fs.promises.mkdir(path.dirname(file), { recursive: true });
          directoryReady = true;
        }
        if (maxBytes > 0) {
          const size = await fs.promises.stat(file).then((info) => info.size).catch(() => 0);
          if (size > maxBytes) await fs.promises.rename(file, `${file}.1`);
        }
        await fs.promises.appendFile(file, line);
      } catch {
        /* telemetry must never break the Host */
      }
    });
    return queue;
  };
  write.flush = () => queue;
  return write;
}
