import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyTargets, getSnapshot, TargetError, __test } from '../compaction-patch.js';

const FIXTURE = `- id: llm-pi-ai
  config:
    providers:
      demo:
        models:
          - id: model-a
            name: model-a
            contextWindow: 1000000
            maxTokens: 128000
          - id: model-b
            name: model-b
            contextWindow: 1000000
            maxTokens: 64000
- id: preset-standard
  config:
    id: standard
    plugins:
      - id: before
        name: '@deepseek-ai/dsh-persona'
        config:
          prefix: hi
      - id: compaction
        name: cordis:group
        group: true
        config:
          - id: compaction-basic
            name: '@deepseek-ai/dsh-compaction-basic'
            config:
              thresholdRatio: 0.3
              headroomTokens: 8192
              maxTokens: 20000
              retainTokens: 30000
              modelPolicies:
                - provider: demo
                  model: model-a
                  thresholdRatio: 0.3
          - id: after
            name: '@deepseek-ai/dsh-command-compact'
      - id: tool-bash
        name: '@deepseek-ai/dsh-tool-bash'
        disabled: !!js process.platform === 'win32'
- id: agent-default-model
  config:
    provider: demo
    model: deepseek-flash
`;

const CORDIS_BASE = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: You are a coding agent.
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'
- id: compaction
  name: cordis:group
  group: true
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'
    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'
    - id: tool-result-pruner
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
      config:
        thresholdChars: 8192
        headChars: 4096
        tailChars: 1024
`;

const PRESET_SOURCES = [
  { id: 'standard', name: 'Standard', order: 1, isDefault: true },
  { id: 'cordis', name: 'Cordis', order: 4, content: CORDIS_BASE },
];

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'compaction-targets-'));
  const profile = path.join(root, 'profiles', 'desktop');
  const home = path.join(root, 'home');
  await mkdir(profile, { recursive: true });
  await mkdir(home, { recursive: true });
  const patchPath = path.join(profile, 'cordis.patch.yml');
  await writeFile(patchPath, FIXTURE, 'utf8');
  return {
    root,
    profile,
    home,
    patchPath,
    env: { DSH_PROFILE_DIR: profile, DSH_HOME: home },
  };
}

function backupsIn(files) {
  return files.filter(name => /^cordis\.patch\.yml\.bak-\d{8}-\d{6}(?:-\d+)?$/.test(name));
}

function bodyFor(snapshot, overrides = {}) {
  return {
    models: snapshot.models.map(model => ({
      provider: model.provider,
      model: model.model,
      enabled: model.enabled,
      compactAtTokens: model.compactAtTokens,
      reserveTokens: model.reserveTokens,
      ...overrides[model.model],
    })),
    retainTokens: snapshot.global.retainTokens,
    headroomTokens: snapshot.global.headroomTokens,
    summarizerMaxTokens: snapshot.global.summarizerMaxTokens,
  };
}

test('boot read is zero-write and keeps the dynamic model table', async () => {
  const fixture = await setup();
  const before = await readFile(fixture.patchPath, 'utf8');
  const filesBefore = await readdir(fixture.profile);
  const snapshot = await getSnapshot({ env: fixture.env });
  assert.deepEqual(snapshot.models.map(model => model.model), ['model-a', 'model-b']);
  assert.equal(snapshot.models[0].enabled, true);
  assert.equal(snapshot.models[0].compactAtTokens, 300000);
  assert.equal(snapshot.models[1].enabled, false);
  assert.equal(snapshot.models[1].compactAtTokens, 300000);
  assert.deepEqual(snapshot.profilePresets, ['standard']);
  assert.equal(await readFile(fixture.patchPath, 'utf8'), before);
  assert.deepEqual(await readdir(fixture.profile), filesBefore);
  assert.deepEqual(backupsIn(await readdir(fixture.profile)), []);
  assert.equal(existsSync(path.join(fixture.home, 'compaction-targets.json')), false);
});

test('same values are a no-op and do not create backup or JSON', async () => {
  const fixture = await setup();
  const snapshot = await getSnapshot({ env: fixture.env });
  const before = await readFile(fixture.patchPath, 'utf8');
  const result = await applyTargets(bodyFor(snapshot), { env: fixture.env });
  assert.equal(result.changed, false);
  assert.equal(result.backupPath, null);
  assert.equal(result.restartNotice, '需要重启客户端才生效');
  assert.equal(await readFile(fixture.patchPath, 'utf8'), before);
  assert.deepEqual(backupsIn(await readdir(fixture.profile)), []);
  assert.equal(existsSync(path.join(fixture.home, 'compaction-targets.json')), false);
});

test('multi-preset save appends a full override and disables the pruner', async () => {
  const fixture = await setup();
  const snapshot = await getSnapshot({ env: fixture.env, presets: PRESET_SOURCES });
  assert.equal(snapshot.presets.find(preset => preset.id === 'standard').hasOverride, true);
  assert.equal(snapshot.presets.find(preset => preset.id === 'cordis').hasOverride, false);
  assert.deepEqual(snapshot.profilePresets, ['standard']);

  const before = await readFile(fixture.patchPath, 'utf8');
  const body = bodyFor(snapshot, {
    'model-a': { enabled: true, compactAtTokens: 280000, reserveTokens: 128000 },
  });
  body.presets = ['standard', 'cordis'];
  const result = await applyTargets(body, { env: fixture.env, presets: PRESET_SOURCES });
  assert.equal(result.changed, true);
  assert.deepEqual(result.presets, ['standard', 'cordis']);
  assert.match(result.backupPath, /cordis\.patch\.yml\.bak-\d{8}-\d{6}(?:-\d+)?$/);

  const after = await readFile(fixture.patchPath, 'utf8');
  assert.equal(after.includes('- id: preset-cordis'), true);
  assert.equal(after.includes("disabled: !!js process.platform === 'win32'"), true);
  assert.deepEqual(
    backupsIn(await readdir(fixture.profile)),
    [path.basename(result.backupPath)],
  );
  const docs = __test.parseDocuments(after);
  const cordis = docs.find(entry => entry.id === 'preset-cordis');
  assert.ok(cordis);
  const group = cordis.config.plugins.find(entry => entry.id === 'compaction');
  const basic = group.config.find(entry => entry.id === 'compaction-basic');
  const pruner = group.config.find(entry => entry.id === 'tool-result-pruner');
  assert.equal(basic.config.retainTokens, 30000);
  assert.equal(basic.config.headroomTokens, 8192);
  assert.equal(basic.config.maxTokens, 20000);
  assert.equal(pruner.disabled, true);
  assert.equal(basic.config.modelPolicies.find(policy => policy.model === 'model-a').thresholdRatio, 0.28);
  assert.equal(after.includes('thresholdRatio: 0.28'), true);
  assert.equal(after.slice(0, after.indexOf('- id: compaction-basic')).includes('maxTokens: 128000'), true);

  const again = await applyTargets(body, { env: fixture.env, presets: PRESET_SOURCES });
  assert.equal(again.changed, false);
  assert.equal(again.backupPath, null);
  assert.equal(await readFile(fixture.patchPath, 'utf8'), after);
  assert.deepEqual(
    backupsIn(await readdir(fixture.profile)),
    [path.basename(result.backupPath)],
  );
});

test('changes only the compaction block, writes backup and JSON, then is idempotent', async () => {
  const fixture = await setup();
  const snapshot = await getSnapshot({ env: fixture.env });
  const before = await readFile(fixture.patchPath, 'utf8');
  const body = bodyFor(snapshot, {
    'model-a': { enabled: true, compactAtTokens: 280000, reserveTokens: 128000 },
    'model-b': { enabled: true, compactAtTokens: 276000, reserveTokens: 64000 },
  });
  const result = await applyTargets(body, { env: fixture.env });
  assert.equal(result.changed, true);
  assert.equal(result.restartRequired, true);
  assert.equal(result.models.find(row => row.model === 'model-a').targetTokens, 280000);
  assert.equal(result.models.find(row => row.model === 'model-a').actualTokens, 280000);
  assert.equal(result.models.find(row => row.model === 'model-b').actualTokens, 276000);
  assert.ok(result.backupPath);
  assert.equal(await readFile(result.backupPath, 'utf8'), before);

  const after = await readFile(fixture.patchPath, 'utf8');
  assert.notEqual(after, before);
  const rangeBefore = __test.findBlockRange(before);
  const rangeAfter = __test.findBlockRange(after);
  assert.equal(__test.outsideText(before, rangeBefore), __test.outsideText(after, rangeAfter));
  assert.equal(after.includes('thresholdRatio: 0.28'), true);
  assert.equal(after.includes('thresholdRatio: 0.276'), true);

  const json = JSON.parse(await readFile(path.join(fixture.home, 'compaction-targets.json'), 'utf8'));
  assert.deepEqual(json.models, [
    { provider: 'demo', model: 'model-a', compactAtTokens: 280000 },
    { provider: 'demo', model: 'model-b', compactAtTokens: 276000 },
  ]);
  assert.equal(json.retainTokens, 30000);
  assert.equal(json.headroomTokens, 8192);
  assert.equal(json.summarizerMaxTokens, 20000);

  const backupCount = backupsIn(await readdir(fixture.profile)).length;
  assert.equal(backupCount, 1);
  const again = await applyTargets(body, { env: fixture.env });
  assert.equal(again.changed, false);
  assert.equal(await readFile(fixture.patchPath, 'utf8'), after);
  assert.equal(backupsIn(await readdir(fixture.profile)).length, backupCount);
});

test('hard failures leave the patch untouched and name the three numbers', async () => {
  const fixture = await setup();
  const snapshot = await getSnapshot({ env: fixture.env });
  const before = await readFile(fixture.patchPath, 'utf8');

  await assert.rejects(
    applyTargets(bodyFor(snapshot, {
      'model-a': { enabled: true, compactAtTokens: 863809, reserveTokens: 128000 },
    }), { env: fixture.env }),
    error => error instanceof TargetError
      && /model-a/.test(error.message)
      && /1000000/.test(error.message)
      && /128000/.test(error.message)
      && /8192/.test(error.message)
      && /863808/.test(error.message),
  );
  await assert.rejects(
    applyTargets({
      ...bodyFor(snapshot, {
        'model-a': { enabled: true, compactAtTokens: 280000, reserveTokens: 128000 },
      }),
      retainTokens: 280000,
    }, { env: fixture.env }),
    /retainTokens 280000 >= 压缩点 280000/,
  );
  await assert.rejects(
    applyTargets(bodyFor(snapshot, {
      'model-a': { enabled: true, compactAtTokens: 880000, reserveTokens: 100000 },
    }), { env: fixture.env }),
    error => /880000/.test(error.message)
      && /actual reserve 128000/.test(error.message)
      && /128000/.test(JSON.stringify(error.details)),
  );
  assert.equal(await readFile(fixture.patchPath, 'utf8'), before);
  assert.equal(existsSync(`${fixture.patchPath}.bak-compaction-targets`), false);
});

test('reserve mismatch is validated and reported without writing llm-pi-ai', async () => {
  const fixture = await setup();
  const snapshot = await getSnapshot({ env: fixture.env });
  const before = await readFile(fixture.patchPath, 'utf8');
  const result = await applyTargets(bodyFor(snapshot, {
    'model-a': { enabled: true, compactAtTokens: 800000, reserveTokens: 100000 },
  }), { env: fixture.env });
  assert.equal(result.changed, true);
  assert.equal(result.models.find(row => row.model === 'model-a').targetTokens, 800000);
  assert.equal(result.models.find(row => row.model === 'model-a').actualReserve, 128000);
  assert.equal(result.reserveNotes.length, 1);
  assert.match(result.reserveNotes[0], /llm-pi-ai:providers\.demo\.models\[model-a\]\.maxTokens = 128000/);
  const after = await readFile(fixture.patchPath, 'utf8');
  assert.equal(after.match(/maxTokens: 128000/g)?.length, 1);
  assert.equal(after.match(/maxTokens: 800000/g), null);
  assert.equal(after.includes('model-a'), true);
  assert.ok(before.includes('model-b'));
});

test('a model with no policy stays unmanaged unless its row is enabled', async () => {
  const fixture = await setup();
  const snapshot = await getSnapshot({ env: fixture.env });
  const result = await applyTargets(bodyFor(snapshot, {
    'model-a': { enabled: true, compactAtTokens: 280000, reserveTokens: 128000 },
    'model-b': { enabled: false, compactAtTokens: 300000, reserveTokens: 64000 },
  }), { env: fixture.env });
  assert.equal(result.changed, true);
  assert.equal(result.models.find(row => row.model === 'model-b').enabled, false);
  const after = await getSnapshot({ env: fixture.env });
  assert.equal(after.models.find(row => row.model === 'model-b').enabled, false);
  const text = await readFile(fixture.patchPath, 'utf8');
  const block = text.slice(text.indexOf('- id: compaction-basic'));
  assert.equal(block.includes('model-b'), false);
});

test('arbitrary token targets round-trip exactly through the stored ratio', async () => {
  const fixture = await setup();
  const snapshot = await getSnapshot({ env: fixture.env });
  const result = await applyTargets(bodyFor(snapshot, {
    'model-a': { enabled: true, compactAtTokens: 277777, reserveTokens: 128000 },
  }), { env: fixture.env });
  assert.equal(result.changed, true);
  assert.equal(result.models.find(row => row.model === 'model-a').actualTokens, 277777);
  const after = await getSnapshot({ env: fixture.env });
  assert.equal(after.models.find(row => row.model === 'model-a').compactAtTokens, 277777);
});

test('explicit patchPath works when DSH_PROFILE_DIR is absent', async () => {
  const fixture = await setup();
  const snapshot = await getSnapshot({ patchPath: fixture.patchPath, env: {} });
  assert.equal(snapshot.models.length, 2);
  assert.equal(snapshot.global.retainTokens, 30000);
  const before = await readFile(fixture.patchPath, 'utf8');
  const result = await applyTargets(bodyFor(snapshot), {
    patchPath: fixture.patchPath,
    env: {},
  });
  assert.equal(result.changed, false);
  assert.equal(await readFile(fixture.patchPath, 'utf8'), before);
});

test('post-write mismatch rolls the patch back to its exact original bytes', async () => {
  const fixture = await setup();
  const snapshot = await getSnapshot({ env: fixture.env });
  const before = await readFile(fixture.patchPath, 'utf8');
  await assert.rejects(
    applyTargets(bodyFor(snapshot, {
      'model-a': { enabled: true, compactAtTokens: 280000, reserveTokens: 128000 },
    }), {
      env: fixture.env,
      testHooks: {
        async afterWrite({ patchPath }) {
          const current = await readFile(patchPath, 'utf8');
          await writeFile(patchPath, current.replace('thresholdRatio: 0.28', 'thresholdRatio: 0.281'), 'utf8');
        },
      },
    }),
    /已回滚原文件/,
  );
  assert.equal(await readFile(fixture.patchPath, 'utf8'), before);
  assert.equal(backupsIn(await readdir(fixture.profile)).length, 1);
});

test('CRLF patches keep their line endings outside the replaced block', async () => {
  const fixture = await setup();
  await writeFile(fixture.patchPath, FIXTURE.replace(/\n/g, '\r\n'), 'utf8');
  const snapshot = await getSnapshot({ env: fixture.env });
  const before = await readFile(fixture.patchPath, 'utf8');
  const result = await applyTargets(bodyFor(snapshot, {
    'model-a': { enabled: true, compactAtTokens: 280000, reserveTokens: 128000 },
  }), { env: fixture.env });
  assert.equal(result.changed, true);
  const after = await readFile(fixture.patchPath, 'utf8');
  assert.equal(after.includes('\r\n'), true);
  const rangeBefore = __test.findBlockRange(before);
  const rangeAfter = __test.findBlockRange(after);
  assert.equal(__test.outsideText(before, rangeBefore), __test.outsideText(after, rangeAfter));
});

const MULTI_PROVIDER_FIXTURE = `- id: llm-pi-ai
  config:
    providers:
      alpha:
        models:
          - id: model-a
            name: Model A
            contextWindow: 200000
            maxTokens: 8000
      beta:
        models:
          - id: model-a
            contextWindow: 100000
            maxTokens: 4000
      gamma:
        models: []
      delta:
        displayName: Delta declares no models key
- id: preset-standard
  config:
    id: standard
    plugins:
      - id: compaction
        name: cordis:group
        group: true
        config:
          - id: compaction-basic
            name: '@deepseek-ai/dsh-compaction-basic'
            config:
              thresholdRatio: 0.3
              headroomTokens: 8192
              maxTokens: 20000
              retainTokens: 30000
`;

async function multiProviderFixture() {
  const fixture = await setup();
  await writeFile(fixture.patchPath, MULTI_PROVIDER_FIXTURE, 'utf8');
  return fixture;
}

test('the model table enumerates every provider that declares models', async () => {
  const fixture = await multiProviderFixture();
  const before = await readFile(fixture.patchPath, 'utf8');
  const snapshot = await getSnapshot({ env: fixture.env });
  assert.deepEqual(
    snapshot.models.map(model => `${model.provider}/${model.model}`),
    ['alpha/model-a', 'beta/model-a'],
  );
  assert.deepEqual(snapshot.models.map(model => model.window), [200000, 100000]);
  assert.equal(snapshot.models[1].name, 'model-a', 'falls back to the id when the model has no name');
  assert.equal(await readFile(fixture.patchPath, 'utf8'), before, 'reading stays zero-write');
});

test('the same model id under two providers keeps two separate policies', async () => {
  const fixture = await multiProviderFixture();
  const snapshot = await getSnapshot({ env: fixture.env });
  const result = await applyTargets({
    models: snapshot.models.map((model, index) => ({
      provider: model.provider,
      model: model.model,
      enabled: true,
      compactAtTokens: index === 0 ? 150000 : 60000,
    })),
    retainTokens: snapshot.global.retainTokens,
    headroomTokens: snapshot.global.headroomTokens,
    summarizerMaxTokens: snapshot.global.summarizerMaxTokens,
  }, { env: fixture.env });
  assert.equal(result.changed, true);
  const docs = __test.parseDocuments(await readFile(fixture.patchPath, 'utf8'));
  const basic = docs.find(entry => entry.id === 'preset-standard').config.plugins
    .find(entry => entry.id === 'compaction').config
    .find(entry => entry.id === 'compaction-basic');
  assert.deepEqual(
    basic.config.modelPolicies.map(policy => `${policy.provider}/${policy.model}`).sort(),
    ['alpha/model-a', 'beta/model-a'],
  );
  assert.deepEqual(
    basic.config.modelPolicies.map(policy => `${policy.provider}=${policy.thresholdRatio}`).sort(),
    ['alpha=0.75', 'beta=0.6'],
  );
});
