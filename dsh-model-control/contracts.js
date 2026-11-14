import { z } from 'zod';

export const PACKAGE = '@local/dsh-model-control';
export const PROVENANCE = 'localModelReplyProvenance';

export const replyMetaSchema = z.object({
  provider: z.string(), model: z.string(), reasoningEffort: z.string().nullable(),
  effortKnown: z.boolean(), requestSeq: z.number().nullable(), messageSeq: z.number(), turn: z.number(), step: z.number(),
});

export const provenanceStateSchema = z.object({
  currentRequest: z.object({ provider:z.string(), model:z.string(), reasoningEffort:z.string().nullable(), seq:z.number() }).nullable(),
  replies: z.record(z.string(), replyMetaSchema),
});

/** Newest replies kept in the provenance projection. */
export const MAX_REPLIES = 500;

/** Entries tolerated above the cap before the record is compacted, so compaction is amortized. */
export const REPLIES_SLACK = 100;

/**
 * Insertion order of one `replies` object, so eviction never has to read the keys back.
 *
 * The projection state has to stay immutable for change detection — the registry compares state
 * references — but *the record of replies does not*: it is folded in place and a new outer state
 * object is returned. The obvious alternative, a fresh `{ ...replies, [id]: entry }` per event, is a
 * full table copy: measured on a 286,789-event Session with 19,284 assistant replies, one cold read
 * spent 20.0 s of CPU inside `foldProvenance` at a 500-entry cap (V8 sampling profiler: 16.4 s self
 * time). Copying stays correct but cannot be paid per event, hence the in-place fold.
 */
const REPLY_ORDER = new WeakMap();

/**
 * The wire record for one state, built on demand.
 *
 * A view must be a detached object: the client holds it, and `drive` compares view references to
 * decide whether listeners fire. Caching it per state means the copy happens once per *change*,
 * not once per event, and never while a log is folded cold (no listener, no view).
 */
const REPLY_VIEW = new WeakMap();

/** Fold the request header and assistant source so each historical reply keeps its own model and effort. */
export function foldProvenance(state, event) {
  if (event.type === 'request/header') {
    const config = event.data.header.config;
    const next = { currentRequest: { provider:config.provider, model:config.model, reasoningEffort:config.reasoningEffort ?? null, seq:event.seq }, replies: state.replies };
    // The reply map did not change, so the view must not either: a fresh view reference here would
    // tell every projection listener that the replies changed on each request.
    const view = REPLY_VIEW.get(state);
    if (view !== undefined) REPLY_VIEW.set(next, view);
    return next;
  }
  if (event.type !== 'assistant/message') return state;
  const message = event.data.message, source = message.source;
  if (!message.id || source?.kind !== 'model') return state;
  // `__proto__` is not an own key under plain assignment; no runtime reply id is, so skip it rather
  // than turning one message into a prototype write.
  if (message.id === '__proto__') return state;
  const request = state.currentRequest;
  const sameRoute = !!request && request.provider === source.provider && request.model === source.model;
  const entry = {
    provider:source.provider, model:source.model, reasoningEffort:sameRoute ? request.reasoningEffort : null,
    effortKnown:sameRoute, requestSeq:sameRoute ? request.seq : null,
    messageSeq:event.seq, turn:event.data.turn, step:event.data.step,
  };
  const replies = state.replies;
  let ids = REPLY_ORDER.get(replies);
  if (ids === undefined) {
    // A restored state comes back from its checkpoint without the side table: seed it once.
    ids = Object.keys(replies);
    REPLY_ORDER.set(replies, ids);
  }
  if (!Object.hasOwn(replies, message.id)) ids.push(message.id);
  replies[message.id] = entry;
  if (ids.length <= MAX_REPLIES + REPLIES_SLACK) return { currentRequest: state.currentRequest, replies };
  // One entry per assistant reply would otherwise keep the whole Session's replies alive in the
  // Plugin Host for as long as the Session lives. Compacting here rather than deleting one entry per
  // event keeps the record in shape mode between compactions, so `REPLY_VIEW` stays a shape copy.
  const kept = ids.slice(ids.length - MAX_REPLIES);
  const compacted = {};
  for (const id of kept) compacted[id] = replies[id];
  REPLY_ORDER.set(compacted, kept);
  return { currentRequest: state.currentRequest, replies: compacted };
}

export const provenanceProjection = {
  key: PROVENANCE, stateVersion: 1, stateSchema: provenanceStateSchema,
  init: () => ({ currentRequest:null, replies:{} }), apply:foldProvenance,
  wire: { viewSchema:z.record(z.string(), replyMetaSchema), view:state=>{
    let view = REPLY_VIEW.get(state);
    if (view === undefined) {
      view = { ...state.replies };
      REPLY_VIEW.set(state, view);
    }
    return view;
  } },
};
