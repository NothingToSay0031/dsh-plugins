import path from 'node:path';
import { applyTargets, getSnapshot, TargetError } from './compaction-patch.js';
import { readUpstreamPresets } from './preset-baseline.js';

export const name = 'compaction-targets';
export const inject = ['connection', 'agentPresets'];

const ROUTE = '/api/compaction-targets';

function jsonResponse(value, status = 200) {
  return Response.json(value, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

function errorResponse(error) {
  if (error instanceof TargetError) {
    return jsonResponse({
      ok: false,
      changed: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    }, 400);
  }
  return jsonResponse({
    ok: false,
    changed: false,
    error: {
      code: 'compaction-targets/internal',
      message: error instanceof Error ? error.message : String(error),
      details: {},
    },
  }, 500);
}

export function apply(ctx) {
  function profilePatchPath() {
    try {
      const editor = ctx.get('configEditor');
      if (editor && typeof editor.documentPath === 'string') return editor.documentPath;
      const profile = ctx.get('profileContext');
      if (profile && typeof profile.patchPath === 'string') return profile.patchPath;
      return undefined;
    } catch {
      return undefined;
    }
  }

  // The home layer. It is applied after the profile layer and wins over it,
  // so the generated preset rows live there and the profile file keeps only
  // what a person wrote.
  function homePatchPath() {
    try {
      const profile = ctx.get('profileContext');
      if (profile && typeof profile.home === 'string') return path.join(profile.home, 'cordis.patch.yml');
      return undefined;
    } catch {
      return undefined;
    }
  }

  function patchOptions(presets) {
    return {
      patchPath: profilePatchPath(),
      homePatchPath: homePatchPath(),
      presets,
    };
  }

  async function presetCatalog() {
    const service = ctx.get('agentPresets');
    if (!service || typeof service.list !== 'function') return undefined;
    const rows = await service.list();
    let defaultId;
    try {
      defaultId = (await service.resolve()).id;
    } catch {
      defaultId = undefined;
    }
    // The bundle declaration behind every profile row, read through the
    // config editor's inherited layer. The effective declaration is not read
    // here: it already carries the profile's own row, so using it as the
    // baseline of a rewrite would freeze that copy and an upstream rename
    // would never reach the profile.
    const upstream = new Map(readUpstreamPresets(ctx).map(preset => [preset.id, preset.config]));
    const presets = [];
    for (const row of rows || []) {
      if (!row || typeof row.id !== 'string') continue;
      presets.push({
        id: row.id,
        ...(row.name ? { name: row.name } : {}),
        ...(row.description ? { description: row.description } : {}),
        ...(row.order === undefined ? {} : { order: row.order }),
        isDefault: row.id === defaultId,
        ...(row.broken ? { broken: row.broken } : {}),
        ...(upstream.has(row.id) ? { upstream: upstream.get(row.id) } : {}),
      });
    }
    return presets;
  }

  const route = {
    path: ROUTE,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        const presets = await presetCatalog();
        if (request.method === 'GET') {
          return jsonResponse(await getSnapshot(patchOptions(presets)));
        }
        if (request.method === 'POST') {
          let body;
          try {
            body = await request.json();
          } catch {
            return jsonResponse({
              ok: false,
              changed: false,
              error: {
                code: 'compaction-targets/body',
                message: 'SAVE 请求体必须是 JSON',
                details: {},
              },
            }, 400);
          }
          return jsonResponse(await applyTargets(body, patchOptions(presets)));
        }
        return new Response('method not allowed', { status: 405 });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };

  ctx.effect(() => {
    const dispose = ctx.connection.fetch.register(route);
    return () => {
      void dispose();
    };
  }, 'compaction-targets: /api route');
}
