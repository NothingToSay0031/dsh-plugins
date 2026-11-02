import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';

test('host route registration is read-only at boot and GET reads the profile', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'compaction-route-'));
  const profile = path.join(root, 'profiles', 'desktop');
  const home = path.join(root, 'home');
  await mkdir(profile, { recursive: true });
  await mkdir(home, { recursive: true });
  const patchPath = path.join(profile, 'cordis.patch.yml');
  const text = `- id: llm-pi-ai
  config:
    providers:
      demo:
        models:
          - id: model-a
            contextWindow: 1000000
            maxTokens: 128000
- id: preset-standard
  config:
    plugins:
      - id: compaction
        config:
          - id: compaction-basic
            config:
              thresholdRatio: 0.3
              headroomTokens: 8192
              maxTokens: 20000
              retainTokens: 30000
              modelPolicies: []
`;
  await writeFile(patchPath, text, 'utf8');

  const oldProfile = process.env.DSH_PROFILE_DIR;
  const oldHome = process.env.DSH_HOME;
  const routeRef = { route: null };
  try {
    process.env.DSH_PROFILE_DIR = profile;
    process.env.DSH_HOME = home;
    const ctx = {
      get(name) {
        return name === 'configEditor' ? { documentPath: patchPath } : undefined;
      },
      effect(callback) {
        const cleanup = callback();
        return () => cleanup?.();
      },
      connection: {
        fetch: {
          register(route) {
            routeRef.route = route;
            return async () => {};
          },
        },
      },
    };
    apply(ctx);
    assert.equal(routeRef.route.path, '/api/compaction-targets');
    assert.deepEqual(routeRef.route.methods, ['GET', 'POST']);
    assert.equal(await readFile(patchPath, 'utf8'), text);
    assert.equal(existsSync(`${patchPath}.bak-compaction-targets`), false);
    assert.equal(existsSync(path.join(home, 'compaction-targets.json')), false);

    const response = await routeRef.route.fetch(new Request('http://127.0.0.1:8155/api/compaction-targets'));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.models.length, 1);
    assert.equal(payload.models[0].model, 'model-a');
    assert.equal(await readFile(patchPath, 'utf8'), text);
    assert.equal(existsSync(`${patchPath}.bak-compaction-targets`), false);
  } finally {
    if (oldProfile === undefined) delete process.env.DSH_PROFILE_DIR;
    else process.env.DSH_PROFILE_DIR = oldProfile;
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
  }
});
