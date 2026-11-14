import { z } from 'zod';

export const PACKAGE = '@local/dsh-model-history';
export const PROJECTION = 'localModelRequestHistory';
/** Newest model configurations kept in the history projection. */
const MAX_HISTORY_ENTRIES = 200;

/**
 * Why the host wrote a request header. `initial` is the first header of a
 * session, `resume` a header restored after a pause, `change` a header whose
 * envelope (config or tools) differs from the previous one, and `series` a
 * header written for a new message series.
 */
export const headerReasonSchema = z.enum(['initial', 'resume', 'change', 'series']);

/** One recorded model configuration: what the requests actually used. */
export const historyEntrySchema = z.object({
  provider: z.string(),
  model: z.string(),
  /** The effort the request carried; null when the provider default applied. */
  reasoningEffort: z.string().nullable(),
  /** True when the adapter supplied the effort instead of the request. */
  effortDefaulted: z.boolean(),
  reason: headerReasonSchema,
  turn: z.number().nullable(),
  step: z.number().nullable(),
  time: z.number(),
  seq: z.number(),
});

export const historyStateSchema = z.object({
  entries: z.array(historyEntrySchema),
  turn: z.number().nullable(),
  step: z.number().nullable(),
});

export const historyViewSchema = z.array(historyEntrySchema);

/**
 * The selection a request header carried.
 *
 * The header config is the ground truth of what was sent: it is the route and
 * the controls the host dispatched. An effort the adapter defaulted is not a
 * user choice, so it reads as "unspecified" instead of a named level.
 * @param {unknown} header - The `request/header` payload.
 * @returns {{ provider: string, model: string, reasoningEffort: string | null, effortDefaulted: boolean } | null} The selection, or null when the header carries no usable config.
 */
export function selectionOfHeader(header) {
  if (typeof header !== 'object' || header === null) return null;
  const config = header.config;
  if (typeof config !== 'object' || config === null) return null;
  const { provider, model } = config;
  if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') return null;
  const defaults = typeof header.adapterDefaults === 'object' && header.adapterDefaults !== null ? header.adapterDefaults : null;
  const effortDefaulted = defaults?.reasoningEffort === true;
  const raw = typeof config.reasoningEffort === 'string' && config.reasoningEffort !== '' ? config.reasoningEffort : null;
  return { provider, model, reasoningEffort: effortDefaulted ? null : raw, effortDefaulted };
}

/**
 * Whether two selections describe the same request configuration.
 * @param {ReturnType<typeof selectionOfHeader>} left - First selection.
 * @param {ReturnType<typeof selectionOfHeader>} right - Second selection.
 * @returns {boolean} Whether both name the same provider, model, and effort.
 */
export function sameSelection(left, right) {
  if (!left || !right) return false;
  return left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort;
}

/**
 * Fold the session log into the model configuration history.
 *
 * The host writes a `request/header` only when the request envelope changes,
 * and every later request inherits the newest header. One row per change is
 * therefore the whole story of which model and effort the requests used: the
 * rows are the distinct configurations in the order they took effect.
 * @param {{ entries: historyEntry[], turn: number | null, step: number | null }} state - Folded state.
 * @param {{ type: string, seq: number, time: number, data: any }} event - One committed session event.
 * @returns {{ entries: historyEntry[], turn: number | null, step: number | null }} The next state; the same reference when the event changes nothing.
 */
export function foldHistory(state, event) {
  if (event.type === 'turn/start') {
    const turn = event.data?.turn;
    if (typeof turn !== 'number') return state;
    return state.turn === turn && state.step === null ? state : { ...state, turn, step: null };
  }
  if (event.type === 'step/start') {
    const turn = event.data?.turn;
    const step = event.data?.step;
    if (typeof turn !== 'number' || typeof step !== 'number') return state;
    return state.turn === turn && state.step === step ? state : { ...state, turn, step };
  }
  if (event.type !== 'request/header') return state;
  const selection = selectionOfHeader(event.data?.header);
  if (!selection) return state;
  const last = state.entries[state.entries.length - 1];
  if (last && last.provider === selection.provider && last.model === selection.model && last.reasoningEffort === selection.reasoningEffort) {
    return state;
  }
  const reason = headerReasonSchema.safeParse(event.data?.reason);
  const entry = {
    provider: selection.provider,
    model: selection.model,
    reasoningEffort: selection.reasoningEffort,
    effortDefaulted: selection.effortDefaulted,
    reason: reason.success ? reason.data : 'change',
    turn: state.turn,
    step: state.step,
    time: typeof event.time === 'number' ? event.time : 0,
    seq: typeof event.seq === 'number' ? event.seq : 0,
  };
  return { ...state, entries: [...state.entries, entry].slice(-MAX_HISTORY_ENTRIES) };
}

/**
 * The session projection carrying the model configuration history.
 *
 * The view is the entry array itself, so its reference only changes when a
 * row is appended and an event that only moves the turn cursor publishes
 * nothing.
 */
export const modelHistoryProjection = {
  key: PROJECTION,
  stateVersion: 1,
  stateSchema: historyStateSchema,
  init: () => ({ entries: [], turn: null, step: null }),
  apply: foldHistory,
  wire: { viewSchema: historyViewSchema, view: state => state.entries, summary: false },
};
