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

/** Fold the request header and assistant source so each historical reply keeps its own model and effort. */
export function foldProvenance(state, event) {
  if (event.type === 'request/header') {
    const config = event.data.header.config;
    return { ...state, currentRequest: { provider:config.provider, model:config.model, reasoningEffort:config.reasoningEffort ?? null, seq:event.seq } };
  }
  if (event.type !== 'assistant/message') return state;
  const message = event.data.message, source = message.source;
  if (!message.id || source?.kind !== 'model') return state;
  const request = state.currentRequest;
  const sameRoute = !!request && request.provider === source.provider && request.model === source.model;
  return { ...state, replies: { ...state.replies, [message.id]: {
    provider:source.provider, model:source.model, reasoningEffort:sameRoute ? request.reasoningEffort : null,
    effortKnown:sameRoute, requestSeq:sameRoute ? request.seq : null,
    messageSeq:event.seq, turn:event.data.turn, step:event.data.step,
  } } };
}

export const provenanceProjection = {
  key: PROVENANCE, stateVersion: 1, stateSchema: provenanceStateSchema,
  init: () => ({ currentRequest:null, replies:{} }), apply:foldProvenance,
  wire: { viewSchema:z.record(z.string(), replyMetaSchema), view:state=>state.replies },
};
