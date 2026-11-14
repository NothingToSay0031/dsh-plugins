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

/** The wrapper's own disposer, so a later load can take it down instead of stacking. */
export const CLEANUP = Symbol.for('@local/dsh-compaction-envelope.cleanup');

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
  // A reload re-applies this plugin while the previous instance may still own the call path. Take
  // that wrapper down instead of refusing: refusing kept the code from the *earlier* load installed
  // for the rest of the process, so every reload of this file was a silent no-op.
  if (llm.stream[WRAPPED] === true) {
    const cleanup = llm.stream[CLEANUP];
    if (typeof cleanup === 'function') {
      try {
        cleanup();
      } catch {
        // A disposer that throws leaves the marker for the check below to report.
      }
    }
    if (llm.stream[WRAPPED] === true) {
      if (typeof cleanup === 'function') {
        return {
          status: 'already',
          detail: `another instance installed the wrapper and it would not come down (${describeStream(llm)}; ${probeWrites(llm)})`,
          stats,
          dispose() {},
        };
      }
      // Installed by a build that predates the disposer marker: wrap it once rather than leave
      // stale code in the call path. The inner wrapper then finds the effort already set and only
      // forwards, so the compaction call is still rewritten exactly once.
      if (typeof logger?.info === 'function') {
        logger.info('compaction-envelope: replacing the wrapper installed by an earlier build');
      }
    }
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
      let outbound = callOptions;
      if (decision.inject === true) {
        stats.injected += 1;
        outbound = { ...callOptions, reasoningEffort: decision.effort };
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
      } else {
        count(decision.reason);
        // A silent no-op here would look like the optimisation simply not working,
        // so name the one skip that means "the summarizer targets another route".
        if (decision.reason === 'route-mismatch' && logger && typeof logger.warn === 'function') {
          logger.warn(
            `compaction-envelope: left compaction call for ${callOptions.provider}/${callOptions.model} untouched; ` +
            `the session is routed to ${route?.provider}/${route?.model}`,
          );
        }
      }
      const source = original.call(this === undefined ? llm : this, outbound);
      if (!isCompaction || config.diagnose === false) return source;
      // Pass every chunk through unchanged; only count what arrived. `dsh-compaction-basic` throws
      // "summarization produced no text summary content" when no text block survives, and the caller
      // cannot tell a reasoning-heavy run that stopped from a stream that carried no text at all.
      const effort = outbound.reasoningEffort;
      return observe(source, createObservation(), (result) =>
        reportStream({ ...result, effort }, logger, stats),
      );
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
  /** Whether the service currently exposes this exact function. */
  const isCurrent = (value) => {
    const own = Object.getOwnPropertyDescriptor(llm, 'stream');
    return own !== undefined && own.value === value ? true : llm.stream === value;
  };
  /**
   * Put `stream` in place of the service method, tolerating a service object that does not accept a
   * plain assignment (a proxy, or a getter-only accessor installed by another wrapper).
   *
   * A Cordis service proxy can answer the first read with the value from before the write, so the
   * own descriptor is the authoritative check; reading the property twice was how an install that
   * had actually landed was reported as `not-writable`.
   *
   * @param value - the function to install.
   * @returns true when the service now exposes `value`.
   */
  const setStream = (value) => {
    try {
      llm.stream = value;
    } catch {
      // Fall through to the descriptor write below.
    }
    if (isCurrent(value)) return true;
    try {
      Object.defineProperty(llm, 'stream', { value, configurable: true, writable: true, enumerable: false });
    } catch {
      return false;
    }
    return isCurrent(value);
  };
  function dispose() {
    if (!isCurrent(stream)) return;
    if (originalWasOwn) {
      setStream(original);
      return;
    }
    try {
      delete llm.stream;
    } catch {
      // Ignore.
    }
    if (isCurrent(stream)) setStream(original);
  }
  Object.defineProperty(stream, WRAPPED, { value: true, enumerable: false });
  Object.defineProperty(stream, CLEANUP, { value: dispose, enumerable: false });
  Object.defineProperty(stream, 'name', { value: 'stream', configurable: true });

  if (!setStream(stream)) {
    return {
      status: 'not-writable',
      detail: `the service does not accept the wrapper (${describeStream(llm)})`,
      stats,
      dispose() {},
    };
  }

  return { status: 'installed', stats, dispose };
}

/**
 * Try both ways of putting a property on a service and report which one the object accepts.
 *
 * @param service - the object the wrapper could not be installed on.
 * @returns `assign:ok` / `assign:no` / `assign:throws`, then the same for `defineProperty`.
 */
function probeWrites(service) {
  const key = Symbol.for('@local/dsh-compaction-envelope.probe');
  const attempt = (write) => {
    try {
      write();
      if (service[key] !== true) return 'no';
      delete service[key];
      return 'ok';
    } catch {
      return 'throws';
    }
  };
  const assign = attempt(() => {
    service[key] = true;
  });
  const define = attempt(() => {
    Object.defineProperty(service, key, { value: true, configurable: true, writable: true });
  });
  return `assign:${assign} define:${define}`;
}

/**
 * Describe how a service exposes `stream`, so a failed install names the actual obstacle.
 *
 * @param service - the object the wrapper could not be installed on.
 * @returns a short description of the property and the object.
 */
function describeStream(service) {
  const own = Object.getOwnPropertyDescriptor(service, 'stream');
  const shape = own === undefined
    ? 'no own property'
    : own.get === undefined && own.set === undefined
      ? `own data property${own.writable === false ? ', read-only' : ''}${own.configurable === false ? ', non-configurable' : ''}`
      : `own accessor${own.set === undefined ? ', getter only' : ''}`;
  const proto = Object.getPrototypeOf(service);
  const inherited = proto === null ? undefined : Object.getOwnPropertyDescriptor(proto, 'stream');
  const inheritedShape = inherited === undefined
    ? ''
    : `, inherited ${inherited.get === undefined ? 'data' : 'accessor'}${inherited.set === undefined ? (inherited.get === undefined ? '' : ' (getter only)') : ''}`;
  return `${shape}${inheritedShape}`;
}

/** Resolve a call's routed envelope, tolerating any failure. */
function routeOf(callOptions, resolveRoute) {  if (typeof resolveRoute !== 'function') return undefined;
  if (callOptions === null || typeof callOptions !== 'object') return undefined;
  const { sessionId } = callOptions;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
  try {
    return resolveRoute(sessionId);
  } catch {
    return undefined;
  }
}

/**
 * Count what one compaction stream actually delivered.
 *
 * `dsh-compaction-basic` throws `summarization produced no text summary content` when no text block
 * survives the stream, and from outside that error has two very different shapes: the model spent
 * its budget on reasoning and stopped before writing any text, or the stream ended for another
 * reason (`length`, `content-filter`, a provider quirk) with nothing to show. Counting chunks here
 * is what tells them apart without changing the call.
 *
 * @returns an accumulator with `push(chunk)` and `result()`.
 */
function createObservation() {
  const chunks = Object.create(null);
  let textChars = 0;
  let reasoningChars = 0;
  let toolArgumentChars = 0;
  let finish;
  let usage;
  return {
    push(chunk) {
      if (chunk === null || typeof chunk !== 'object') return;
      const type = typeof chunk.type === 'string' ? chunk.type : '?';
      chunks[type] = (chunks[type] ?? 0) + 1;
      if (type === 'text-delta') textChars += String(chunk.text ?? '').length;
      else if (type === 'reasoning-delta') reasoningChars += String(chunk.text ?? '').length;
      else if (type === 'tool-call-delta') toolArgumentChars += String(chunk.argumentsDelta ?? '').length;
      else if (type === 'finish') finish = finishKind(chunk.reason);
      else if (type === 'usage') usage = chunk.usage;
    },
    result() {
      return { textChars, reasoningChars, toolArgumentChars, finish, usage, chunks };
    },
  };
}

/**
 * The terminal finish reason as a word.
 *
 * The assembler's `finish` chunk carries `{kind}`, not a string (`{kind: 'stop'}` is also what a
 * stream that ended without any finish chunk looks like), so log the kind and keep the object.
 *
 * @param reason - the `finish` chunk's `reason` field.
 * @returns the kind when known, the raw string otherwise.
 */
function finishKind(reason) {
  if (reason === null || reason === undefined) return undefined;
  if (typeof reason === 'string') return reason;
  if (typeof reason === 'object' && typeof reason.kind === 'string') return reason.kind;
  return 'unknown';
}

/** The billed token count a provider reported, whichever field it used. */
function tokenCount(usage) {
  if (usage === null || typeof usage !== 'object') return undefined;
  for (const key of ['completionTokens', 'outputTokens', 'totalTokens']) {
    if (typeof usage[key] === 'number') return usage[key];
  }
  return undefined;
}

/** One line per compaction stream: the evidence the empty-summary failure needs. */
function reportStream(result, logger, stats) {
  stats.lastStream = result;
  const tokens = tokenCount(result.usage);
  const detail =
    `text=${result.textChars} reasoning=${result.reasoningChars} toolArgs=${result.toolArgumentChars}` +
    ` finish=${result.finish ?? 'none'}` +
    ` tokens=${tokens === undefined ? 'none' : String(tokens)}` +
    ` effort=${result.effort ?? 'none'}` +
    ` chunks=${Object.entries(result.chunks).map(([key, value]) => `${key}:${value}`).join(',')}`;
  if (result.textChars === 0) logger?.warn?.(`compaction-envelope: compaction stream produced no text (${detail})`);
  else logger?.info?.(`compaction-envelope: compaction stream (${detail})`);
}

/**
 * Pass a stream through while counting it.
 *
 * The consumer sees exactly the chunks the provider produced, in order; the tally is reported once,
 * in `finally`, so an early `break`, a thrown error and a normal end all report.
 */
async function* observe(source, observation, report) {
  try {
    for await (const chunk of source) {
      try {
        observation.push(chunk);
      } catch {
        // Diagnostics must never break the call it observes.
      }
      yield chunk;
    }
  } finally {
    try {
      report(observation.result());
    } catch {
      // Ignore.
    }
  }
}
