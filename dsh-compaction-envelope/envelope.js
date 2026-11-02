/**
 * Decide whether one `llm.stream()` call needs the conversation's routed
 * reasoning effort, and install the wrapper that supplies it.
 *
 * Background: `@deepseek-ai/dsh-compaction-basic` replays the conversation plus
 * a trailing directive so the summarizer call is a byte prefix of the routed
 * request. It forwards provider, model, messages, tools, toolHistory and
 * maxTokens, but drops `reasoningEffort`. The provider keys its prompt cache by
 * that parameter, so the summarizer lands in a different cache namespace and can
 * only reuse the static head (measured: 5% hit rate across 109 real calls, with
 * matches of exactly the system+tools block). Supplying the routed effort makes
 * the call a true prefix again (measured: 98% hit rate).
 *
 * @module @local/dsh-compaction-envelope/envelope
 */

/** Global marker so a hot reload recognizes its own wrapper. */
export const WRAPPED = Symbol.for('@local/dsh-compaction-envelope.wrapper');

/**
 * Decide whether to add the routed reasoning effort to one call.
 *
 * @param options - the options object handed to `llm.stream()`.
 * @param route - the conversation's routed envelope, when known.
 * @param config - `{ requireSameRoute }`; defaults to requiring the same route.
 * @returns an object with `inject`, the optional `effort`, and a `reason`.
 */
export function decide(options, route, config = {}) {
  const requireSameRoute = config.requireSameRoute !== false;
  if (options === null || typeof options !== 'object') return { inject: false, reason: 'no-options' };
  if (options.purpose !== 'compaction') return { inject: false, reason: 'other-purpose' };
  if (options.reasoningEffort !== undefined) return { inject: false, reason: 'already-set' };
  if (route === null || typeof route !== 'object') return { inject: false, reason: 'no-route' };
  const effort = route.reasoningEffort;
  if (typeof effort !== 'string' || effort.length === 0) return { inject: false, reason: 'no-routed-effort' };
  if (requireSameRoute) {
    if (options.provider !== route.provider || options.model !== route.model) {
      return { inject: false, reason: 'route-mismatch' };
    }
  }
  return { inject: true, effort, reason: 'injected' };
}

/**
 * Install the wrapper on a live LLM service.
 *
 * The wrapper is transparent: it only rewrites the options object of a
 * compaction call that lacks a reasoning effort, and it never throws into the
 * caller. Anything unexpected degrades to passing the original call through.
 *
 * @param llm - the LLM service exposing `stream(options)`.
 * @param resolveRoute - `(sessionId) => ({ provider, model, reasoningEffort }) | undefined`.
 * @param options - `{ config, logger, now }` for policy, logging and timestamps.
 * @returns `{ status, detail?, stats, dispose }`.
 */
export function installEnvelope(llm, resolveRoute, options = {}) {
  const { config = {}, logger = undefined, now = () => Date.now() } = options;
  const stats = {
    calls: 0,
    compactionCalls: 0,
    injected: 0,
    skipped: Object.create(null),
    lastInjection: undefined,
  };
  const count = (reason) => {
    stats.skipped[reason] = (stats.skipped[reason] ?? 0) + 1;
  };

  if (llm === null || typeof llm !== 'object' || typeof llm.stream !== 'function') {
    return { status: 'no-stream', detail: 'llm.stream is not a function', stats, dispose() {} };
  }
  if (llm.stream[WRAPPED] === true) {
    return { status: 'already', detail: 'another instance installed the wrapper', stats, dispose() {} };
  }

  const original = llm.stream;
  const originalWasOwn = Object.hasOwn(llm, 'stream');
  function stream(callOptions) {
    stats.calls += 1;
    try {
      const isCompaction = callOptions !== null && typeof callOptions === 'object' && callOptions.purpose === 'compaction';
      if (isCompaction) stats.compactionCalls += 1;
      const route = isCompaction ? routeOf(callOptions, resolveRoute) : undefined;
      const decision = decide(callOptions, route, config);
      if (decision.inject !== true) {
        count(decision.reason);
        // A silent no-op here would look like the optimisation simply not working,
        // so name the one skip that means "the summarizer targets another route".
        if (decision.reason === 'route-mismatch' && logger && typeof logger.warn === 'function') {
          logger.warn(
            `compaction-envelope: left compaction call for ${callOptions.provider}/${callOptions.model} untouched; ` +
            `the session is routed to ${route?.provider}/${route?.model}`,
          );
        }
        return original.call(this === undefined ? llm : this, callOptions);
      }
      stats.injected += 1;
      const replaced = { ...callOptions, reasoningEffort: decision.effort };
      stats.lastInjection = {
        at: now(),
        sessionId: typeof callOptions.sessionId === 'string' ? callOptions.sessionId : undefined,
        provider: callOptions.provider,
        model: callOptions.model,
        effort: decision.effort,
      };
      if (logger && typeof logger.info === 'function') {
        logger.info(
          `compaction-envelope: compaction call inherits reasoningEffort=${decision.effort} ` +
          `(${callOptions.provider}/${callOptions.model})`,
        );
      }
      return original.call(this === undefined ? llm : this, replaced);
    } catch (error) {
      // Never fail a model call because of this wrapper.
      try {
        if (logger && typeof logger.warn === 'function') {
          logger.warn(`compaction-envelope: wrapper error: ${error instanceof Error ? error.message : String(error)}`);
        }
      } catch {}
      return original.call(this === undefined ? llm : this, callOptions);
    }
  }
  Object.defineProperty(stream, WRAPPED, { value: true, enumerable: false });
  Object.defineProperty(stream, 'name', { value: 'stream', configurable: true });

  try {
    llm.stream = stream;
  } catch (error) {
    return {
      status: 'not-writable',
      detail: error instanceof Error ? error.message : String(error),
      stats,
      dispose() {},
    };
  }
  if (llm.stream !== stream) {
    return {
      status: 'not-writable',
      detail: 'assignment did not take effect (service proxy?)',
      stats,
      dispose() {},
    };
  }

  return {
    status: 'installed',
    stats,
    dispose() {
      if (llm.stream !== stream) return;
      if (originalWasOwn) llm.stream = original;
      else delete llm.stream;
    },
  };
}

/** Resolve a call's routed envelope, tolerating any failure. */
function routeOf(callOptions, resolveRoute) {
  if (typeof resolveRoute !== 'function') return undefined;
  if (callOptions === null || typeof callOptions !== 'object') return undefined;
  const { sessionId } = callOptions;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
  try {
    return resolveRoute(sessionId);
  } catch {
    return undefined;
  }
}
