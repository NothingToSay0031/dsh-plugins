import { z } from 'zod';
import { Collaboration } from './core.js';
import { domainSpec, receiptProjection, toolSchemas, COLLAB_PROMPT, rankingSchema } from './contracts.js';

export const name = 'local-session-collab';
export const inject = ['agents', 'sessions', 'sessionController', 'sessionQuery', 'sessionProjections', 'workspaceRegistry', 'storageDomain', 'tools', 'systemPrompt', 'llm', 'agentPresets', 'connection', 'sessionTitle'];
const string = z.string().trim().min(1);
export const inputs = {
  collab_discover: z.object({ query: z.string().max(200).optional(), name: string.max(100).optional(), workspace: string.max(1000).optional() }).strict(),
  collab_send: z.object({ target_session_id: string.max(200).optional(), target_name: string.max(100).optional(), target_workspace: string.max(1000).optional(), target_context: string.max(1000).optional(), text: string.max(16000), request_id: string.max(160) }).strict()
    .refine(value => !!value.target_session_id || !!value.target_name, 'Supply target_name or target_session_id')
    .refine(value => !value.target_context || !!value.target_session_id, 'target_context requires an exact target_session_id'),
  collab_reply: z.object({ message_id: string.max(200), text: string.max(16000), request_id: string.max(160) }).strict(),
  collab_inbox: z.object({ before: string.optional(), thread_id: string.optional() }).strict(),
  collab_models: z.object({}).strict(),
  collab_create_session: z.object({ workspace_id: string.optional(), title: string.max(100), difficulty: z.number().int().min(1).max(5).optional(), model: string.max(300).optional(), reasoning_effort: string.max(100).optional(), request_id: string.max(160), prompt: string.max(16000).optional(), agent_preset: string.max(100).optional() }).strict()
    .refine(value => (value.difficulty === undefined) !== (value.model === undefined), 'Supply exactly one of difficulty or model'),
};
const methods = { collab_discover: 'discover', collab_send: 'send', collab_reply: 'reply', collab_inbox: 'inbox', collab_models: 'models', collab_create_session: 'createSession' };
const wire = value => JSON.parse(JSON.stringify(value));
const toolNames = toolSchemas.map(schema => schema.name);

export async function apply(ctx) {
  const domain = await ctx.storageDomain.open(domainSpec);
  const service = new Collaboration(ctx, domain);
  ctx.effect(() => () => service.close());
  ctx.provide('sessionCollaboration', service);
  await service.initialModels();
  ctx.sessionProjections.register(receiptProjection);
  ctx.systemPrompt.section({
    name: 'local:session-collaboration', order: 71,
    text: context => !context.agent || service.ordinary(context.agent) ? COLLAB_PROMPT : '',
  });
  ctx.on('agent/disposed', ({ agent }) => { service.handles.delete(agent.id); });
  // Subagents are not collaborators: hide these definitions from their scope instead of leaving tools
  // they can only call to be refused. A restriction is scoped to one agent context and dies with it.
  ctx.on('agent/created', ({ agent }) => {
    try {
      if (!agent || service.ordinary(agent)) return;
      if (typeof agent.ctx?.tools?.restrict === 'function') agent.ctx.tools.restrict({ deny: toolNames });
    } catch { /* Older host without scoped tool restrictions; every call path still refuses subagents. */ }
  });

  for (const schema of toolSchemas) ctx.tools.register({
    ...schema,
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(raw, exec) {
      return wire(await service.run(() => service[methods[schema.name]](exec.agent, inputs[schema.name].parse(raw), exec.signal)));
    },
    isConcurrencySafe: () => ['collab_discover', 'collab_models', 'collab_inbox'].includes(schema.name),
  });

  // Desktop and Web share the same authenticated owner-only /api exact-Fetch carrier.
  // No UI endpoint can send, reply, create, or edit participation. Humans only order models and inspect logs.
  ctx.connection.fetch.register({
    path: '/api/session-collab', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      let envelope;
      try { envelope = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
      const parsed = z.object({
        type: z.literal('client-request'), rpcId: string, method: z.literal('session-collab'),
        payload: z.object({ method: string, args: z.unknown() }).strict(),
      }).strict().safeParse(envelope);
      if (!parsed.success) return new Response('Invalid collaboration request', { status: 400 });
      const { method, args } = parsed.data.payload;
      const response = result => Response.json({ type: 'server-response', rpcId: parsed.data.rpcId, result });
      try {
        const value = await service.run(async () => {
          if (method === 'snapshot') { z.object({}).strict().parse(args); return service.snapshot(); }
          if (method === 'ranking') return service.saveRanking(rankingSchema.parse(args));
          if (method === 'logs') return service.logPage(z.object({ before: string.optional() }).strict().parse(args));
          throw new Error(`Unknown collaboration endpoint: ${method}`);
        });
        return response({ ok: true, value: wire(value) });
      } catch (error) {
        return response({ ok: false, error: { code: error.code ?? 'COLLAB_ERROR', message: error.message ?? String(error), details: {} } });
      }
    },
  });
}
