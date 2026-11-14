/**
 * dsh-material — Host half.
 *
 * Owns two things the browser cannot: the durable default preset (the profile entry's `config.preset`)
 * and the write-through that saves a live switch. No color, gradient, or blur value lives here —
 * the material layer is entirely the browser package's `ctx.theme.overrideTokens` data.
 */
import z from '@deepseek-ai/schemastery';

export const name = 'local-dsh-material';
export const inject = ['connection'];

/**
 * The Host entry owns the durable preset and tuning, so it declares the config the settings service
 * writes: without a `Config` schema with volatile fields, `settings.update` refuses the namespace with
 * `No configurable plugin entry`. A volatile field resolves to a live box (`{ get() }`) rather than a
 * plain value, so values are read through it — never compared to it.
 */
export const Config = z.object({
  preset: z.union([
    'soft', 'vivid', 'latte', 'rose', 'sage', 'nord', 'solar',
    'one', 'github', 'flexoki', 'gruvbox', 'ayu', 'kanagawa', 'tokyo', 'flat',
  ]).default('soft').volatile(),
  opacity: z.number().min(0).max(2).default(1).volatile(),
  /** Absent means "follow the palette"; the panel writes a concrete value once its slider moves. */
  blurPx: z.number().min(0).max(160).volatile(),
  saturatePct: z.number().min(0).max(400).volatile(),
  /** Whether the OS reduced-transparency request still wins over the material. */
  respectReduced: z.boolean().default(true).volatile(),
});

/** Exact `/api` route the browser half calls; the `/api` transport owns browser authentication. */
export const ROUTE_PATH = '/api/dsh-material';
/** RPC method literal inside the `/api` client-request envelope. */
export const RPC_METHOD = 'dsh-material';
/** Profile entry id whose `config` is the durable choice. */
export const ENTRY_ID = 'local-dsh-material';

const PRESETS = new Set([
  'soft', 'vivid', 'latte', 'rose', 'sage', 'nord', 'solar',
  'one', 'github', 'flexoki', 'gruvbox', 'ayu', 'kanagawa', 'tokyo', 'flat',
]);
const DEFAULT_PRESET = 'soft';
/** The same windows the panel's sliders expose; a hand-written request outside them is refused. */
const TUNING = {
  opacity: { min: 0, max: 2, fallback: 1 },
  blurPx: { min: 0, max: 160, fallback: null },
  saturatePct: { min: 0, max: 400, fallback: null },
};

/** One config field as a plain value, whether the settings service handed back a volatile box or not. */
function fieldValue(raw, key) {
  const field = raw && typeof raw === 'object' ? raw[key] : undefined;
  return field && typeof field.get === 'function' ? field.get() : field;
}

/**
 * @returns the preset and tuning this process was configured with, falling back for unusable values.
 */
function normalizeConfig(raw) {
  const preset = fieldValue(raw, 'preset');
  const config = { preset: typeof preset === 'string' && PRESETS.has(preset) ? preset : DEFAULT_PRESET };
  for (const [key, limit] of Object.entries(TUNING)) {
    const value = fieldValue(raw, key);
    config[key] = typeof value === 'number' && Number.isFinite(value)
      ? Math.min(limit.max, Math.max(limit.min, value))
      : limit.fallback;
  }
  config.respectReduced = fieldValue(raw, 'respectReduced') !== false;
  return config;
}

/** A missing or null blur/saturation stays "follow the palette"; anything else must be in range. */
function decodeTuning(payload) {
  if (!PRESETS.has(payload.preset)) return null;
  const config = { preset: payload.preset };
  for (const [key, limit] of Object.entries(TUNING)) {
    const value = payload[key] === undefined || payload[key] === null ? limit.fallback : payload[key];
    if (value === null) {
      config[key] = null;
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < limit.min || value > limit.max) return null;
    config[key] = value;
  }
  config.respectReduced = payload.respectReduced === undefined ? true : payload.respectReduced;
  if (typeof config.respectReduced !== 'boolean') return null;
  return config;
}

/** Parse the `/api` client-request envelope; anything else is a hand-made request. */
function decodeRequest(body) {
  if (!body || typeof body !== 'object') return null;
  if (body.type !== 'client-request' || body.method !== RPC_METHOD) return null;
  if (typeof body.rpcId !== 'string' || body.rpcId === '') return null;
  const payload = body.payload && typeof body.payload === 'object' ? body.payload : {};
  if (payload.action === 'read') return { rpcId: body.rpcId, action: 'read' };
  if (payload.action === 'persist') {
    const config = decodeTuning(payload);
    if (config !== null) return { rpcId: body.rpcId, action: 'persist', config };
  }
  return null;
}

/**
 * Write the preset and tuning into the profile entry's config through the Host settings service.
 * @returns `{ ok: true }`, or `{ ok: false, error }` naming why the durable write did not land.
 */
async function persistConfig(ctx, config) {
  const settings = ctx.get('settings');
  if (!settings) return { ok: false, error: 'host settings service is not mounted' };
  try {
    await settings.update(ENTRY_ID, config);
    return { ok: true };
  } catch (error) {
    // A refusal is a durability failure only: the browser layer already applied for this session.
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * @param ctx - Host plugin context.
 * @param rawConfig - the profile entry's `config` row, as validated against `Config`.
 */
export function apply(ctx, rawConfig) {
  let current = normalizeConfig(rawConfig);
  ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE_PATH, methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response('Invalid material request', { status: 400 });
      }
      const decoded = decodeRequest(body);
      if (!decoded) return new Response('Invalid material request', { status: 400 });
      if (decoded.action === 'read') return Response.json({ type: 'server-response', rpcId: decoded.rpcId, result: { ok: true, value: current } });
      const result = await persistConfig(ctx, decoded.config);
      if (result.ok) current = decoded.config;
      return Response.json({ type: 'server-response', rpcId: decoded.rpcId, result });
    },
  }), 'dsh-material: /api route');
}
