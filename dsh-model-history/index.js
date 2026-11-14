import { modelHistoryProjection } from './contracts.js';

export const name = 'local-model-history';

/**
 * The Model History bundle owns one read-only surface: the model and
 * reasoning effort the requests of a conversation actually used. It reads the
 * session log through a projection and never selects a model itself.
 */
export const inject = ['sessionProjections'];

export async function apply(ctx) {
  // The registration belongs to this fiber: unloading the plugin releases it.
  // Do not return the registration itself — an async function must not hand a
  // registration back to Cordis.
  await ctx.sessionProjections.register(modelHistoryProjection);
}
