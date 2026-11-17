/**
 * One-time normalization of persisted collab request records.
 *
 * Problem: targetSelector carried a deprecated `context` key that the current
 * requestSchema (.strict()) rejects, so the plugin fails to start.
 *
 * Fix per record (no legacy compatibility):
 *   1. delete targetSelector.context
 *   2. recompute `fingerprint` from the sanitized targetSelector, because the
 *      stored fingerprint was hashed WITH context. Leaving the old value would
 *      make retry of the same request_id throw IDEMPOTENCY_CONFLICT.
 *   3. validate against the current schema before writing.
 *
 * History/messages and all retry-relevant fields (id, kind, from, to, body,
 * replyTo, threadId, message, createdAt, updatedAt, state, evidence, ...) are
 * preserved byte-for-byte apart from JSON re-serialization.
 *
 * Usage:
 *   COLLAB_REQUESTS_DIR=<path> node dev/normalize-requests.mjs --dry-run  # report only
 *   COLLAB_REQUESTS_DIR=<path> node dev/normalize-requests.mjs --apply    # perform the rewrite
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { requestSchema } from '../contracts.js';

const DIR = process.env.COLLAB_REQUESTS_DIR;
if (!DIR) {
  console.error('Set COLLAB_REQUESTS_DIR to the requests storage directory before running.');
  process.exit(2);
}
const apply = process.argv.includes('--apply');
const dryRun = !apply;

const canonical = value => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]))
  : Array.isArray(value) ? value.map(canonical) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

const files = readdirSync(DIR).filter(f => f.endsWith('.json')).sort();
const stats = { total: 0, alreadyClean: 0, normalize: 0, ctxNull: 0, ctxText: 0 };
const verify = { fpWithCtxMatch: 0, fpWithCtxMismatch: 0, sampleMismatch: [] };
let writeErrors = 0;

for (const f of files) {
  stats.total++;
  const path = join(DIR, f);
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  const r = doc.record;
  const ts = r.targetSelector;
  if (!ts || !Object.hasOwn(ts, 'context')) { stats.alreadyClean++; continue; }

  if (typeof ts.context === 'string' && ts.context.length) stats.ctxText++;
  else stats.ctxNull++;

  // Sanitize: remove only the deprecated key.
  const cleanTs = { sessionId: ts.sessionId, name: ts.name, workspace: ts.workspace };

  // Precondition: stored fingerprint must equal hash with the OLD selector.
  const fpOld = hash({ targetSelector: ts, body: r.body, replyTo: r.replyTo ?? null });
  if (fpOld === r.fingerprint) verify.fpWithCtxMatch++;
  else {
    verify.fpWithCtxMismatch++;
    if (verify.sampleMismatch.length < 5) verify.sampleMismatch.push({ file: f, stored: r.fingerprint, recomputed: fpOld });
  }

  // Recompute fingerprint against the NEW selector so retry idempotency holds.
  const fpNew = hash({ targetSelector: cleanTs, body: r.body, replyTo: r.replyTo ?? null });
  doc.record = { ...r, targetSelector: cleanTs, fingerprint: fpNew };

  // Validate before writing.
  const parsed = requestSchema.safeParse(doc.record);
  if (!parsed.success) {
    writeErrors++;
    if (verify.sampleMismatch.length < 10) verify.sampleMismatch.push({ file: f, schemaError: parsed.error.issues });
    continue;
  }

  stats.normalize++;
  if (!dryRun) {
    try { writeFileSync(path, JSON.stringify(doc, null, 2) + '\n', 'utf8'); }
    catch (e) { writeErrors++; console.error('WRITE FAIL', f, e.message); }
  }
}

console.log(JSON.stringify({ mode: dryRun ? 'DRY-RUN' : 'APPLY', stats, verify, writeErrors }, null, 2));
if (verify.fpWithCtxMismatch > 0) {
  console.error('ABORT: stored fingerprints do not match hash-with-context; refusing to trust recomputation.');
  process.exit(2);
}
