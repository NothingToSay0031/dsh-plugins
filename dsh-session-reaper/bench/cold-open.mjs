// Fair eager-vs-lazy COLD OPEN comparison on a real session log. Read-only experiment.
//
// usage: node --expose-gc bench/cold-open.mjs <log.zstd> <eager|lazy-cold|lazy-warm>
//
// "open" = decode/index + a full fold pass that reads type/seq/surfaceOp/data on every event,
// which is what the Host's validation + surface fold touch. Each mode runs in its own process so
// the eager resident set and the lazy working set never stack.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { readSessionEvents } from '../../tools/dsh-heap-guard/tools/session-log-reader.mjs';
import {
  createLogIndex, createLogIndexSync, lazyOpenEvent, makeEventGuard, clearHydration, setHydrationLimit,
} from '../lazy.mjs';

const file = process.argv[2];
const mode = process.argv[3] ?? 'eager';
if (!file) { console.error('usage: cold-open.mjs <log.zstd> <eager|lazy-cold|lazy-warm>'); process.exit(2); }
const mb = (n) => (n / 1048576).toFixed(1);
const ms = (t) => Number(process.hrtime.bigint() - t) / 1e6;
const gc = () => { if (globalThis.gc) { globalThis.gc(); globalThis.gc(); } };
const heap = () => { gc(); return process.memoryUsage().heapUsed; };
setHydrationLimit(256, 64 * 1048576);

// The fold reads the fields the Host touches. `type` first (validation), then surfaceOp/data (fold).
function fold(events) {
  let sink = 0;
  for (const e of events) {
    const t = e.type;
    const s = e.seq;
    const so = e.surfaceOp;
    const d = e.data;
    if (t !== undefined && s !== undefined) sink += 1;
    if (so !== undefined) sink += 1;
    if (d !== undefined) sink += 1;
  }
  return sink;
}

// Faithful eager decode: mirrors the Host's decodeCurrentGeneration — walk frames by bytesWritten
// (NOT magic-scan), decompress each, JSON.parse every line, retain all events.
function eagerDecodeFaithful(file) {
  const buf = fs.readFileSync(file);
  const events = [];
  let pos = 0;
  while (pos < buf.length) {
    let out;
    try { out = zlib.zstdDecompressSync(buf.subarray(pos), { info: true }); } catch { break; }
    const consumed = out.engine.bytesWritten;
    if (!consumed) break;
    for (const line of out.buffer.toString('utf8').split('\n')) {
      if (line.length === 0) continue;
      try { events.push(JSON.parse(line)); } catch { /* skip */ }
    }
    pos += consumed;
  }
  return events;
}

console.log(`log   ${path.basename(file)} (${mb(fs.statSync(file).size)} MB)  mode=${mode}`);

if (mode === 'eager' || mode === 'eager-faithful') {
  const h0 = heap();
  let t = process.hrtime.bigint();
  let events;
  let failed = 0;
  if (mode === 'eager-faithful') {
    events = eagerDecodeFaithful(file);
  } else {
    const { events: stream, stats } = readSessionEvents(file);
    events = [...stream];
    failed = stats.failed;
  }
  const decodeMs = ms(t);
  const h1 = heap();
  t = process.hrtime.bigint();
  const sink = fold(events);
  const foldMs = ms(t);
  console.log(`decode  ${decodeMs.toFixed(0)} ms  (${events.length.toLocaleString()} events, ${failed} failed frames)`);
  console.log(`fold    ${foldMs.toFixed(0)} ms  (memory reads, sink=${sink})`);
  console.log(`TOTAL   ${(decodeMs + foldMs).toFixed(0)} ms   heap ${mb(h1)} MB (+${mb(h1 - h0)})`);
} else {
  const cacheFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cold-open-')), 'idx.bin');
  const guard = makeEventGuard({ known: null, adopt: null }, file); // freezeDeep, no vocab refusal
  const hydrate = (seq) => guard(index.hydrate(seq));
  let index;
  let indexMs;
  if (mode === 'lazy-warm') {
    // Build the disk cache once (untimed), then time only the adopt + views + fold.
    const seed = createLogIndex(file, { cacheFile });
    seed.advance(Infinity);
    seed.close(true);
    const t = process.hrtime.bigint();
    index = createLogIndex(file, { cacheFile });
    indexMs = ms(t);
    console.log(`index   ${indexMs.toFixed(0)} ms  (adopt disk cache, adopted=${index.adopted}, ${index.frameCount.toLocaleString()} frames)`);
  } else {
    const t = process.hrtime.bigint();
    index = createLogIndexSync(file);
    indexMs = ms(t);
    console.log(`index   ${indexMs.toFixed(0)} ms  (full cold scan, ${index.frameCount.toLocaleString()} frames)`);
  }
  const h1 = heap();
  let t = process.hrtime.bigint();
  const views = new Array(index.events);
  for (let seq = 0; seq < index.events; seq += 1) views[seq] = lazyOpenEvent(seq, hydrate);
  const viewsMs = ms(t);
  t = process.hrtime.bigint();
  const sink = fold(views);
  const foldMs = ms(t);
  const h2 = heap();
  console.log(`views   ${viewsMs.toFixed(0)} ms  (${views.length.toLocaleString()} lazy views)`);
  console.log(`fold    ${foldMs.toFixed(0)} ms  (hydrate-on-read, sink=${sink})`);
  console.log(`TOTAL   ${(indexMs + viewsMs + foldMs).toFixed(0)} ms   heap ${mb(h2)} MB`);
  clearHydration();
  index.close(false);
  fs.rmSync(path.dirname(cacheFile), { recursive: true, force: true });
}