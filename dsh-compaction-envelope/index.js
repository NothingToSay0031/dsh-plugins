/**
 * Give compaction summarizer calls the conversation's routed reasoning effort.
 *
 * `@deepseek-ai/dsh-compaction-basic` replays the routed conversation plus a
 * trailing directive so the auxiliary summarization call is a byte prefix of the
 * last routed request. It forwards the provider, model, messages, tools,
 * toolHistory and maxTokens of that request but omits `reasoningEffort`. The
 * provider keys its prompt cache by that parameter, so a conversation routed at
 * effort "max" and a summarizer call with no effort land in different cache
 * namespaces: the replay matches only the static system+tools head and every
 * message is billed uncached.
 *
 * This plugin wraps the LLM service's `stream()` and, for calls carrying
 * `purpose: "compaction"` with no effort of their own, supplies the effort the
 * conversation was actually routed with. Nothing else about the call changes.
 *
 * @module @local/dsh-compaction-envelope
 */
import { installEnvelope } from './envelope.js';

export const name = 'compaction-envelope';
export const inject = ['llm', 'sessions'];

export function apply(ctx, config = {}) {
  const settings = config !== null && typeof config === 'object' ? config : {};
  if (settings.enabled === false) {
    ctx.logger?.info?.('compaction-envelope: disabled by configuration');
    return;
  }

  const routedEnvelope = (sessionId) => {
    const sessions = ctx.get('sessions');
    const session = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined;
    if (!session || typeof session.requestHeader !== 'function') return undefined;
    const header = session.requestHeader();
    const route = header && header.config;
    if (!route || typeof route !== 'object') return undefined;
    return {
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
    };
  };

  ctx.effect(() => {
    const llm = ctx.get('llm');
    const installed = installEnvelope(llm, routedEnvelope, {
      config: { requireSameRoute: settings.requireSameRoute !== false },
      logger: ctx.logger,
    });
    if (installed.status !== 'installed') {
      ctx.logger?.warn?.(`compaction-envelope: not installed (${installed.status}${installed.detail === undefined ? '' : `: ${installed.detail}`})`);
    } else {
      ctx.logger?.info?.('compaction-envelope: installed; compaction calls inherit the routed reasoning effort');
    }
    // Expose the counters for diagnostics without a client bundle.
    try {
      if (llm !== null && typeof llm === 'object' && installed.status === 'installed') {
        Object.defineProperty(llm, Symbol.for('@local/dsh-compaction-envelope.stats'), {
          value: installed.stats,
          configurable: true,
        });
      }
    } catch {
      // Diagnostics only.
    }
    return () => {
      installed.dispose();
    };
  }, 'compaction-envelope: inherit the routed reasoning effort for compaction calls');
}
