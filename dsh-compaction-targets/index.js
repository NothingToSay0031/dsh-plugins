import { applyTargets, getSnapshot, TargetError } from './compaction-patch.js';

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
    const presets = [];
    for (const row of rows || []) {
      if (!row || typeof row.id !== 'string') continue;
      let document;
      try {
        document = typeof service.readDocument === 'function'
          ? await service.readDocument(row.id)
          : undefined;
      } catch {
        document = undefined;
      }
      presets.push({
        id: row.id,
        ...(row.name ? { name: row.name } : {}),
        ...(row.description ? { description: row.description } : {}),
        ...(row.order === undefined ? {} : { order: row.order }),
        isDefault: row.id === defaultId,
        ...(row.broken ? { broken: row.broken } : {}),
        ...(document && typeof document.content === 'string' ? { content: document.content } : {}),
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
          return jsonResponse(await getSnapshot({ patchPath: profilePatchPath(), presets }));
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
          return jsonResponse(await applyTargets(body, { patchPath: profilePatchPath(), presets }));
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
