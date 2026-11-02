import { provenanceProjection } from './contracts.js';

export const name = 'local-model-control';

/**
 * The Model Control bundle owns two model-experience surfaces only:
 * the composer picker (which selects the target model's highest compatible
 * reasoning effort) and the per-reply model provenance badge. Context-window
 * budgets live in the upstream models proxy, not here.
 */
export const inject = ['sessionProjections'];

export function apply(ctx) {
  ctx.sessionProjections.register(provenanceProjection);
}
