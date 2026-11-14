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
    name: Standard
    order: 1
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
    model: model-flash
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

// The upstream declaration of a preset: the bundle layer behind the profile
// row. The plugin never reads the effective declaration as its baseline,
// because that one already carries the profile's own row.
function upstreamOf(id, order, text) {
  return { id, order, plugins: __test.parseEntryList(text, id) };
}

const PRESET_SOURCES = [
  { id: 'standard', name: 'Standard', order: 1, isDefault: true },
  { id: 'cordis', name: 'Cordis', order: 4, upstream: upstreamOf('cordis', 4, CORDIS_BASE) },
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
  assert.equal(result.restartNotice, '无需重启客户端，新建会话即可生效；已有会话沿用创建时的预设设置');
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
  assert.equal(result.restartRequired, false);
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

// The Loader dialect lets a top-level row carry no `id` of its own: `- insert:`
// rows keep their real ids inside `insert`. The real desktop profile has two of
// them, and matching those rows by id made every save report "patch 中非目标预设
// (unknown) 发生了变化" and roll back.
const INSERT_FIXTURE = `${FIXTURE}
# Loader rows without a top-level id: the real ids live inside \`insert\`.
- insert:
    - id: "hook-bridge"
      name: "@deepseek-ai/dsh-hooks-claude-code"
      config:
        configPath: "/home/user/.dsh/hooks.json"
- insert:
    - id: "example-bridge"
      name: "@local/dsh-example-bridge"
- id: local-material
  name: "@local/dsh-material"
  config:
    preset: vivid
`;

async function insertFixture() {
  const fixture = await setup();
  await writeFile(fixture.patchPath, INSERT_FIXTURE, 'utf8');
  return fixture;
}

test('id-less insert rows are matched by position, not by id', () => {
  const docs = __test.parseDocuments(INSERT_FIXTURE);
  const index = __test.indexRows(docs);
  assert.deepEqual(
    [...index.keys()].filter(key => key.startsWith('anonymous:')),
    ['anonymous:0', 'anonymous:1'],
  );
  assert.equal(index.get('anonymous:0').length, 1);
  assert.equal(index.get('anonymous:1')[0].insert[0].id, 'example-bridge');
  assert.equal(__test.rowLabel('anonymous:0'), '(unknown)');
  assert.equal(__test.rowLabel('id:local-material'), 'local-material');
});

test('a save leaves id-less insert rows untouched', async () => {
  const fixture = await insertFixture();
  const snapshot = await getSnapshot({ env: fixture.env });
  const result = await applyTargets(bodyFor(snapshot, {
    'model-a': { enabled: true, compactAtTokens: 280000, reserveTokens: 128000 },
  }), { env: fixture.env });
  assert.equal(result.changed, true);

  const after = await readFile(fixture.patchPath, 'utf8');
  assert.equal(after.includes('- id: "hook-bridge"'), true);
  assert.equal(after.includes('- id: "example-bridge"'), true);
  assert.equal(after.includes('- id: local-material'), true);
  const docs = __test.parseDocuments(after);
  assert.equal(docs.filter(row => !row.id).length, 2);
  assert.deepEqual(
    docs.filter(row => !row.id).map(row => row.insert[0].id),
    ['hook-bridge', 'example-bridge'],
  );
});

test('a genuinely changed id-less insert row is still rejected and rolled back', async () => {
  const fixture = await insertFixture();
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
          await writeFile(patchPath, current.replace('"example-bridge"', '"example-bridge-v2"'), 'utf8');
        },
      },
    }),
    error => error.code === 'compaction-targets/outside-structure-changed'
      && /已回滚原文件/.test(error.message),
  );
  assert.equal(await readFile(fixture.patchPath, 'utf8'), before);
});

test('a dropped id-less insert row is rejected and rolled back', async () => {
  const fixture = await insertFixture();
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
          await writeFile(patchPath, current.replace('- id: "example-bridge"\n', ''), 'utf8');
        },
      },
    }),
    error => error.code === 'compaction-targets/outside-structure-changed',
  );
  assert.equal(await readFile(fixture.patchPath, 'utf8'), before);
});

// The Host renders a preset's child list as entry-list YAML. Once a config
// block has been written, the row's own `name:` sits behind that block, and a
// rewrite that treated the block as running to the next plugin row swallowed
// that name: the preset then failed to load with "row N names no plugin" and
// the client showed that diagnostic instead of the preset.
const HOST_RENDERED = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: You are a coding agent powered by the {{model}} model.
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
  config:
    - id: compaction-basic
      config:
        thresholdRatio: 0.3
        headroomTokens: 8192
        maxTokens: 20000
        retainTokens: 30000
      name: '@deepseek-ai/dsh-compaction-basic'
    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'
    - id: tool-result-pruner
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
      config:
        thresholdChars: 8192
`;

const MANAGED_CONFIG = {
  thresholdRatio: 0.3,
  headroomTokens: 8192,
  maxTokens: 20000,
  retainTokens: 30000,
  modelPolicies: [{ provider: 'demo', model: 'model-a', thresholdRatio: 0.28 }],
};

function everyRowNamesAPlugin(rows) {
  for (const row of rows) {
    if (typeof row?.name !== 'string' || row.name === '') return false;
    if (row.group === true && !everyRowNamesAPlugin(row.config)) return false;
  }
  return true;
}

test('a preset row that carries its name behind the config keeps the name', () => {
  const row = __test.buildPresetRow({ id: 'ptc' }, MANAGED_CONFIG, '\n', { baseline: HOST_RENDERED });
  assert.equal(row.includes("name: '@deepseek-ai/dsh-compaction-basic'"), true);
  assert.equal(row.includes('thresholdRatio: 0.28'), true);
  const written = __test.parseDocuments(row)[0];
  assert.equal(everyRowNamesAPlugin(written.config.plugins), true);
});

test('a save keeps every plugin row named, so the preset still mounts', async () => {
  const fixture = await setup();
  const presets = [
    ...PRESET_SOURCES,
    { id: 'ptc', name: 'PTC', order: 2, upstream: upstreamOf('ptc', 2, HOST_RENDERED) },
  ];
  const snapshot = await getSnapshot({ env: fixture.env, presets });
  const body = bodyFor(snapshot, {
    'model-a': { enabled: true, compactAtTokens: 280000, reserveTokens: 128000 },
  });
  body.presets = ['standard', 'ptc'];
  const result = await applyTargets(body, { env: fixture.env, presets });
  assert.equal(result.changed, true);

  const docs = __test.parseDocuments(await readFile(fixture.patchPath, 'utf8'));
  const ptc = docs.find(entry => entry.id === 'preset-ptc');
  assert.ok(ptc);
  assert.equal(everyRowNamesAPlugin(ptc.config.plugins), true);
  const basic = ptc.config.plugins
    .find(entry => entry.id === 'compaction')
    .config.find(entry => entry.id === 'compaction-basic');
  assert.equal(basic.name, '@deepseek-ai/dsh-compaction-basic');
  assert.equal(basic.config.retainTokens, 30000);
  assert.equal(basic.config.modelPolicies[0].thresholdRatio, 0.28);
});

test('a preset whose row lost its name gets the canonical name back', () => {
  const broken = HOST_RENDERED.replace("      name: '@deepseek-ai/dsh-compaction-basic'\n", '');
  const row = __test.buildPresetRow(
    { id: 'ptc' },
    MANAGED_CONFIG,
    '\n',
    { baseline: broken, compactionBasicName: '@deepseek-ai/dsh-compaction-basic' },
  );
  const written = __test.parseDocuments(row)[0];
  assert.equal(everyRowNamesAPlugin(written.config.plugins), true);
  const basic = written.config.plugins
    .find(entry => entry.id === 'compaction')
    .config.find(entry => entry.id === 'compaction-basic');
  assert.equal(basic.name, '@deepseek-ai/dsh-compaction-basic');
});

test('a rewrite that drops the plugin name is refused', () => {
  const dropped = HOST_RENDERED.replace("      name: '@deepseek-ai/dsh-compaction-basic'\n", '');
  assert.throws(
    () => __test.assertOnlyManagedFieldsChanged(HOST_RENDERED, dropped, 'ptc'),
    error => error.code === 'compaction-targets/preset-fields-changed',
  );
});

test('a rewrite that changes another plugin field is refused', () => {
  const changed = HOST_RENDERED.replace(
    'prefix: You are a coding agent powered by the {{model}} model.',
    'prefix: something else',
  );
  assert.throws(
    () => __test.assertOnlyManagedFieldsChanged(HOST_RENDERED, changed, 'ptc'),
    error => error.code === 'compaction-targets/preset-fields-changed',
  );
});

test('a rewrite that only changes the managed fields is accepted', () => {
  const managed = HOST_RENDERED.replace('retainTokens: 30000', 'retainTokens: 10000');
  assert.doesNotThrow(() => __test.assertOnlyManagedFieldsChanged(HOST_RENDERED, managed, 'ptc'));
});

test('a sequence value at the config key indent stays inside the block', () => {
  const text = [
    '- id: compaction-basic',
    '  config:',
    '  - a',
    '  - b',
    '  name: keep-me',
  ].join('\n');
  const range = __test.findBlockRange(text);
  assert.equal(range.cfgIdx, 1);
  assert.equal(range.end, 4);
});

// The upstream declaration of the standard preset. It names the key the Host
// uses today, `modelSelection`, and it carries a plugin row the profile does
// not have yet.
const STANDARD_UPSTREAM = `- id: before
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: hi
- id: compaction
  name: cordis:group
  group: true
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'
    - id: after
      name: '@deepseek-ai/dsh-command-compact'
    - id: tool-result-pruner
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
      config:
        thresholdChars: 8192
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'
- id: delegation
  name: cordis:group
  group: true
  config:
    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: subagent
        modelSelection: true
        modelDiscovery: true
`;

// The profile row is a copy of an older upstream: it still names the key the
// Host used before it renamed `modelSelectionSettings` to `modelSelection`,
// and it carries a customisation of its own.
const STALE_DELEGATION = `      - id: delegation
        name: cordis:group
        group: true
        config:
          - id: tool-subagent
            name: '@deepseek-ai/dsh-tool-subagent'
            config:
              provider: spawn
              toolName: subagent
              modelSelectionSettings: true
              agentOptions:
                provider: demo
                model: model-b
`;

function staleFixture(extra = '') {
  return FIXTURE.replace(
    `- id: agent-default-model`,
    `${STALE_DELEGATION}- id: agent-default-model`,
  ) + extra;
}

const STANDARD_SOURCES = [{
  id: 'standard',
  name: 'Standard',
  order: 1,
  isDefault: true,
  upstream: upstreamOf('standard', 1, STANDARD_UPSTREAM),
}];

test('the preset row is rebuilt from the upstream declaration, not from its own copy', async () => {
  const fixture = await setup();
  await writeFile(fixture.patchPath, staleFixture(), 'utf8');
  const snapshot = await getSnapshot({ env: fixture.env, presets: STANDARD_SOURCES });
  const body = bodyFor(snapshot, {
    'model-a': { enabled: true, compactAtTokens: 280000, reserveTokens: 128000 },
  });
  body.dropUndeclared = true;
  const result = await applyTargets(body, { env: fixture.env, presets: STANDARD_SOURCES });
  assert.equal(result.changed, true);

  const after = await readFile(fixture.patchPath, 'utf8');
  assert.equal(after.includes('modelSelectionSettings'), false, 'the stale key is gone');
  assert.equal(after.includes('modelSelection: true'), true, 'the upstream key is in place');
  assert.equal(after.includes('modelDiscovery: true'), true);
  // The child default route belongs to the page now, so a rebuild keeps it
  // even while it drops the other undeclared customisations of the copy.
  assert.equal(after.includes('agentOptions'), true, 'the page-managed route survives the rebuild');
  assert.equal(result.drift.length, 1);
  assert.equal(result.drift[0].preset, 'standard');
  assert.equal(result.drift[0].entries.some(entry => entry.path.includes('modelSelectionSettings')), true);
});

test('a preset row that already is the upstream declaration keeps its own wording', async () => {
  const fixture = await setup();
  const presets = STANDARD_SOURCES;
  const snapshot = await getSnapshot({ env: fixture.env, presets });
  const body = bodyFor(snapshot, {
    'model-a': { enabled: true, compactAtTokens: 280000, reserveTokens: 128000 },
  });
  const result = await applyTargets(body, { env: fixture.env, presets });
  assert.equal(result.changed, true);

  const after = await readFile(fixture.patchPath, 'utf8');
  assert.equal(after.includes('modelSelection: true'), true);
  const rangeBefore = __test.findBlockRange(await readFile(fixture.patchPath, 'utf8'));
  assert.ok(rangeBefore);
});

test('an undeclared customisation blocks the rewrite and leaves the file alone', async () => {
  const fixture = await setup();
  await writeFile(fixture.patchPath, staleFixture(), 'utf8');
  const before = await readFile(fixture.patchPath, 'utf8');
  const snapshot = await getSnapshot({ env: fixture.env, presets: STANDARD_SOURCES });
  const body = bodyFor(snapshot, {
    'model-a': { enabled: true, compactAtTokens: 280000, reserveTokens: 128000 },
  });
  await assert.rejects(
    applyTargets(body, { env: fixture.env, presets: STANDARD_SOURCES }),
    error => error.code === 'compaction-targets/preset-drift'
      && /modelSelectionSettings/.test(error.message),
  );
  assert.equal(await readFile(fixture.patchPath, 'utf8'), before);
});

test('a declared customisation survives the rewrite', async () => {
  const fixture = await setup();
  const declared = `- id: compaction-targets
  config:
    presetOverrides:
      standard:
        - id: tool-subagent
          config:
            agentOptions:
              provider: demo
              model: model-b
`;
  await writeFile(fixture.patchPath, staleFixture(declared), 'utf8');
  const snapshot = await getSnapshot({ env: fixture.env, presets: STANDARD_SOURCES });
  const body = bodyFor(snapshot, {
    'model-a': { enabled: true, compactAtTokens: 280000, reserveTokens: 128000 },
  });
  body.dropUndeclared = true;
  const result = await applyTargets(body, { env: fixture.env, presets: STANDARD_SOURCES });
  assert.equal(result.changed, true);

  const after = await readFile(fixture.patchPath, 'utf8');
  assert.equal(after.includes('agentOptions'), true, 'the declared customisation is kept');
  assert.equal(after.includes('model: model-b'), true);
  assert.equal(after.includes('modelSelectionSettings'), false, 'the stale key is still gone');
});

test('the snapshot reports the drift between the profile row and the upstream', async () => {
  const fixture = await setup();
  await writeFile(fixture.patchPath, staleFixture(), 'utf8');
  const snapshot = await getSnapshot({ env: fixture.env, presets: STANDARD_SOURCES });
  const standard = snapshot.presets.find(preset => preset.id === 'standard');
  assert.equal(standard.upstream, true);
  assert.equal(standard.inSync, false);
  assert.equal(standard.drift.length > 0, true);
  assert.equal(standard.drift.some(entry => entry.path.includes('modelSelectionSettings')), true);
});

test('a profile without a preset row reports no drift and no upstream', async () => {
  const fixture = await setup();
  const snapshot = await getSnapshot({ env: fixture.env, presets: [] });
  const standard = snapshot.presets.find(preset => preset.id === 'standard');
  assert.equal(standard.upstream, false);
  assert.equal(standard.drift.length, 0);
});

// The hand written profile file and the machine maintained home layer. The
// home layer is applied after the profile layer and wins over it, so the
// generated preset rows belong there and the profile file stays untouched.
const HAND_WRITTEN_PROFILE = `- id: llm-pi-ai
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
- id: agent-default-model
  config:
    provider: demo
    model: model-flash
`;

const HOME_LAYER = `- id: llm-deepseek
  disabled: true
- id: preset-standard
  config:
    id: standard
    name: Standard
    order: 1
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
`;

test('the generated rows live in the home layer and the profile file is never written', async () => {
  const fixture = await setup();
  const homePatchPath = path.join(fixture.home, 'cordis.patch.yml');
  await writeFile(fixture.patchPath, HAND_WRITTEN_PROFILE, 'utf8');
  await writeFile(homePatchPath, HOME_LAYER, 'utf8');
  const options = { env: fixture.env, homePatchPath, presets: PRESET_SOURCES };
  const profileBefore = await readFile(fixture.patchPath, 'utf8');

  const snapshot = await getSnapshot(options);
  assert.equal(snapshot.presets.find(preset => preset.id === 'standard').hasOverride, true);
  assert.deepEqual(snapshot.profilePresets, ['standard']);

  const body = bodyFor(snapshot, {
    'model-a': { enabled: true, compactAtTokens: 280000, reserveTokens: 128000 },
  });
  body.presets = ['standard'];
  const result = await applyTargets(body, options);
  assert.equal(result.changed, true);

  // The hand written file is byte identical: the plugin only writes the layer
  // it owns.
  assert.equal(await readFile(fixture.patchPath, 'utf8'), profileBefore);
  // The home layer keeps the rows it does not own and holds the generated one.
  const homeAfter = await readFile(homePatchPath, 'utf8');
  assert.equal(homeAfter.includes('- id: llm-deepseek'), true);
  assert.equal(homeAfter.includes('- id: preset-standard'), true);
  assert.match(result.backupPath, /cordis\.patch\.yml\.bak-\d{8}-\d{6}(?:-\d+)?$/);
  assert.equal(path.dirname(result.backupPath), fixture.home);
  // The managed values reached the home layer.
  const docs = __test.parseDocuments(homeAfter);
  const preset = docs.find(entry => entry.id === 'preset-standard');
  const group = preset.config.plugins.find(entry => entry.id === 'compaction');
  const basic = group.config.find(entry => entry.id === 'compaction-basic');
  assert.equal(basic.config.headroomTokens, 8192);
});

test('the home layer wins over the profile layer', async () => {
  const fixture = await setup();
  const homePatchPath = path.join(fixture.home, 'cordis.patch.yml');
  // The profile still carries an old copy of the preset row.
  await writeFile(fixture.patchPath, FIXTURE, 'utf8');
  await writeFile(homePatchPath, HOME_LAYER.replace('retainTokens: 30000', 'retainTokens: 12345'), 'utf8');
  const snapshot = await getSnapshot({ env: fixture.env, homePatchPath, presets: PRESET_SOURCES });
  assert.equal(snapshot.global.retainTokens, 12345, 'the home layer is the effective one');
});

const MODEL_SELECTION_PROFILE = `- id: llm-pi-ai
  config:
    providers:
      demo:
        models:
          - id: model-a
            name: model-a
            contextWindow: 1000000
            maxTokens: 128000
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
      - id: delegation
        name: cordis:group
        group: true
        config:
          - id: tool-subagent
            name: '@deepseek-ai/dsh-tool-subagent'
            config:
              provider: spawn
              toolName: subagent
              modelSelection: true
              modelDiscovery: true
              agentOptions:
                provider: acme
                model: acme/model-flash
                reasoningEffort: max
          - id: tool-subagent-fork
            name: '@deepseek-ai/dsh-tool-subagent'
            config:
              provider: fork
              toolName: subagent_fork
- id: subagent-model-selection-settings
  name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
  config:
    enabled: true
    allowedModels:
      - provider: acme
        model: acme/model-mini
      - provider: acme
        model: acme/model-flash
`;

test('the snapshot reports how child model selection is configured', async () => {
  const fixture = await setup();
  await writeFile(fixture.patchPath, MODEL_SELECTION_PROFILE, 'utf8');
  const snapshot = await getSnapshot({ env: fixture.env, presets: PRESET_SOURCES });

  const report = snapshot.modelSelection;
  assert.equal(report.policy.declared, true);
  assert.equal(report.policy.enabled, true);
  assert.deepEqual(report.policy.allowedModels, [
    { provider: 'acme', model: 'acme/model-mini' },
    { provider: 'acme', model: 'acme/model-flash' },
  ]);

  const standard = report.presets.find(preset => preset.id === 'standard');
  assert.equal(standard.tool.modelSelection, true);
  assert.equal(standard.tool.modelDiscovery, true);
  assert.deepEqual(standard.tool.agentOptions, {
    provider: 'acme',
    model: 'acme/model-flash',
    reasoningEffort: 'max',
  });
  // The fork instance keeps its own configuration.
  assert.equal(standard.forkTool.modelSelection, false);

  const codes = report.checks.map(check => check.code);
  assert.equal(codes.includes('policy-missing'), false);
  assert.equal(codes.includes('policy-disabled'), false);
  assert.equal(codes.includes('preset-model-selection-off'), false);
  assert.equal(codes.includes('default-route-not-allowed'), false);
});

test('a missing authorization row is reported instead of failing', async () => {
  const fixture = await setup();
  await writeFile(fixture.patchPath, MODEL_SELECTION_PROFILE.replace(/- id: subagent-model-selection-settings[\s\S]*$/, ''), 'utf8');
  const snapshot = await getSnapshot({ env: fixture.env, presets: PRESET_SOURCES });
  const report = snapshot.modelSelection;
  assert.equal(report.policy.declared, false);
  assert.equal(report.policy.enabled, false);
  assert.equal(report.checks.some(check => check.code === 'policy-missing'), true);
});


test('no separate limit gives every model its own declared output cap', async () => {
  const fixture = await setup();
  const snapshot = await getSnapshot({ env: fixture.env });
  assert.equal(snapshot.global.summarizerUnlimited, false, 'a number in the file means a real limit');

  const body = { ...bodyFor(snapshot), summarizerMaxTokens: 'model' };
  const result = await applyTargets(body, { env: fixture.env });
  assert.equal(result.changed, true);
  // The global value is the smallest cap so a model the page does not manage can
  // never be handed more than its own ceiling; managed rows carry their own.
  assert.equal(result.global.summarizerMaxTokens, 64000);
  assert.equal(result.global.summarizerUnlimited, true);

  const after = await readFile(fixture.patchPath, 'utf8');
  // The fixture's model table already names 128000 and 64000; the policy row and
  // the global fallback add one occurrence each.
  assert.equal((after.match(/maxTokens: 128000/g) ?? []).length, 2, 'model-a keeps its 128000');
  assert.equal((after.match(/maxTokens: 64000/g) ?? []).length, 2, 'the global fallback is the smallest cap');

  const json = JSON.parse(await readFile(path.join(fixture.home, 'compaction-targets.json'), 'utf8'));
  assert.equal(json.summarizerMaxTokens, 64000);
  assert.equal(json.summarizerUnlimited, true);

  const again = await getSnapshot({ env: fixture.env });
  assert.equal(again.global.summarizerUnlimited, true, 'the mode survives a re-read');
  assert.equal(again.global.summarizerMaxTokens, 64000);

  const repeat = await applyTargets({ ...bodyFor(again), summarizerMaxTokens: 'model' }, { env: fixture.env });
  assert.equal(repeat.changed, false, 'saving the same mode again is a no-op');
  assert.equal(await readFile(fixture.patchPath, 'utf8'), after);
});

test('a number turns the per-model caps back off', async () => {
  const fixture = await setup();
  const snapshot = await getSnapshot({ env: fixture.env });
  await applyTargets({ ...bodyFor(snapshot), summarizerMaxTokens: 'model' }, { env: fixture.env });

  const unlimited = await getSnapshot({ env: fixture.env });
  const result = await applyTargets({ ...bodyFor(unlimited), summarizerMaxTokens: 48000 }, { env: fixture.env });
  assert.equal(result.changed, true);
  assert.equal(result.global.summarizerMaxTokens, 48000);
  assert.equal(result.global.summarizerUnlimited, false);

  const after = await readFile(fixture.patchPath, 'utf8');
  assert.equal(after.includes('maxTokens: 48000'), true);
  assert.equal((after.match(/maxTokens: 128000/g) ?? []).length, 1, 'the per-model caps are gone');
});

test('no separate limit needs at least one enabled model', async () => {
  const fixture = await setup();
  const snapshot = await getSnapshot({ env: fixture.env });
  const body = {
    ...bodyFor(snapshot),
    summarizerMaxTokens: 'model',
    models: bodyFor(snapshot).models.map(model => ({ ...model, enabled: false })),
  };
  await assert.rejects(
    () => applyTargets(body, { env: fixture.env }),
    error => error instanceof TargetError && /至少启用一个模型/.test(error.message),
  );
});

test('an unmanaged policy row does not break the per-model mode', async () => {
  const fixture = await setup();
  // A model that left the provider table keeps its policy row; the mode is
  // detected from the rows the page manages, not from every row in the file.
  const withGone = FIXTURE.replace(
    '                  model: model-a\n                  thresholdRatio: 0.3\n',
    '                  model: model-a\n                  thresholdRatio: 0.3\n                - provider: demo\n                  model: model-gone\n                  thresholdRatio: 0.3\n',
  );
  await writeFile(fixture.patchPath, withGone, 'utf8');
  const snapshot = await getSnapshot({ env: fixture.env });
  assert.equal(snapshot.global.summarizerUnlimited, false);

  await applyTargets({ ...bodyFor(snapshot), summarizerMaxTokens: 'model' }, { env: fixture.env });
  const again = await getSnapshot({ env: fixture.env });
  assert.equal(again.global.summarizerUnlimited, true, 'the gone model row does not hide the mode');

  const after = await readFile(fixture.patchPath, 'utf8');
  assert.equal(after.includes('model: model-gone'), true, 'the unmanaged row survives the rewrite');
});


// ---------------------------------------------------------------------------
// Child default route (tool-subagent.config.agentOptions)
// ---------------------------------------------------------------------------

// The same shape as STANDARD_UPSTREAM, plus the fork instance the real
// presets declare, so a profile row can be in sync with it and stay in the
// in-place branch of a rewrite.
const ROUTE_UPSTREAM = `- id: before
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: hi
- id: compaction
  name: cordis:group
  group: true
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'
    - id: after
      name: '@deepseek-ai/dsh-command-compact'
    - id: tool-result-pruner
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
      config:
        thresholdChars: 8192
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'
- id: delegation
  name: cordis:group
  group: true
  config:
    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: subagent
        modelSelection: true
        modelDiscovery: true
    - id: tool-subagent-fork
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: fork
        toolName: subagent_fork
`;

const ROUTE_PROFILE = `- id: llm-pi-ai
  config:
    providers:
      demo:
        models:
          - id: model-a
            name: model-a
            contextWindow: 1000000
            maxTokens: 128000
            reasoningEfforts:
              high: high
              max: max
          - id: model-b
            name: model-b
            contextWindow: 1000000
            maxTokens: 64000
- id: preset-standard
  config:
    id: standard
    name: Standard
    order: 1
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
          - id: tool-result-pruner
            name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
            config:
              thresholdChars: 8192
      - id: tool-bash
        name: '@deepseek-ai/dsh-tool-bash'
        disabled: !!js process.platform === 'win32'
      - id: delegation
        name: cordis:group
        group: true
        config:
          - id: tool-subagent
            name: '@deepseek-ai/dsh-tool-subagent'
            config:
              provider: spawn
              toolName: subagent
              modelSelection: true
              modelDiscovery: true
              agentOptions:
                provider: demo
                model: model-a
                reasoningEffort: max
          - id: tool-subagent-fork
            name: '@deepseek-ai/dsh-tool-subagent'
            config:
              provider: fork
              toolName: subagent_fork
- id: preset-minimal
  config:
    id: minimal
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
- id: subagent-model-selection-settings
  name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
  config:
    enabled: true
    allowedModels:
      - provider: demo
        model: model-a
`;

const ROUTE_SOURCES = [
  {
    id: 'standard',
    name: 'Standard',
    order: 1,
    isDefault: true,
    upstream: upstreamOf('standard', 1, ROUTE_UPSTREAM),
  },
  { id: 'minimal', name: 'Minimal', order: 3 },
];

async function routeFixture(profile = ROUTE_PROFILE) {
  const fixture = await setup();
  await writeFile(fixture.patchPath, profile, 'utf8');
  return fixture;
}

test('the snapshot reports the child default route and each model\'s efforts', async () => {
  const fixture = await routeFixture();
  const snapshot = await getSnapshot({ env: fixture.env, presets: ROUTE_SOURCES });
  assert.deepEqual(snapshot.models.map(model => model.efforts), [['high', 'max'], []]);

  const report = snapshot.modelSelection;
  const standard = report.presets.find(preset => preset.id === 'standard');
  assert.equal(standard.source, 'row');
  assert.deepEqual(standard.route, { provider: 'demo', model: 'model-a', reasoningEffort: 'max' });
  assert.deepEqual(standard.tool.agentOptions, standard.route);
  // The declaration behind the row is the same route here.
  // The declaration behind the row does not carry the route; the row does.
  assert.equal(standard.declaredRoute, undefined);

  const minimal = report.presets.find(preset => preset.id === 'minimal');
  assert.equal(minimal.tool, undefined);
  assert.equal(minimal.route, undefined);
  assert.equal(report.checks.some(check => check.code === 'preset-no-delegation-tool' && check.preset === 'minimal'), true);
});

test('a save writes the route into the row and keeps every other field', async () => {
  const fixture = await routeFixture();
  const snapshot = await getSnapshot({ env: fixture.env, presets: ROUTE_SOURCES });
  const body = {
    ...bodyFor(snapshot),
    presets: ['standard'],
    subagentRoutes: { standard: { provider: 'demo', model: 'model-b' } },
  };
  const result = await applyTargets(body, { env: fixture.env, presets: ROUTE_SOURCES });
  assert.equal(result.changed, true);
  assert.deepEqual(result.subagentRoutes, [{ preset: 'standard', provider: 'demo', model: 'model-b' }]);

  const after = await readFile(fixture.patchPath, 'utf8');
  assert.equal((after.match(/agentOptions/g) ?? []).length, 1, 'the block is replaced, not duplicated');
  assert.match(after, /\n {14}agentOptions:\n {16}provider: demo\n {16}model: model-b\n {10}- id: tool-subagent-fork/);
  const block = /\n {14}agentOptions:\n([\s\S]*?)\n {10}- id: tool-subagent-fork/.exec(after);
  assert.ok(block);
  assert.equal(block[1].includes('model: model-a'), false, 'the old model is gone');
  assert.equal(block[1].includes('reasoningEffort'), false, 'an omitted effort is not written');
  assert.equal(after.includes('modelSelection: true'), true, 'the upstream keys stay');
  assert.equal(after.includes('disabled: true'), true, 'the pruner is still disabled');
  assert.equal(after.includes("disabled: !!js process.platform === 'win32'"), true);

  const again = await getSnapshot({ env: fixture.env, presets: ROUTE_SOURCES });
  const standard = again.modelSelection.presets.find(preset => preset.id === 'standard');
  assert.deepEqual(standard.route, { provider: 'demo', model: 'model-b' });

  const repeat = await applyTargets({
    ...bodyFor(again),
    presets: ['standard'],
    subagentRoutes: { standard: { provider: 'demo', model: 'model-b' } },
  }, { env: fixture.env, presets: ROUTE_SOURCES });
  assert.equal(repeat.changed, false, 'saving the same route again is a no-op');
  assert.equal(await readFile(fixture.patchPath, 'utf8'), after);
});

test('inheriting the parent route removes the block', async () => {
  const fixture = await routeFixture();
  const snapshot = await getSnapshot({ env: fixture.env, presets: ROUTE_SOURCES });
  const result = await applyTargets({
    ...bodyFor(snapshot),
    presets: ['standard'],
    subagentRoutes: { standard: null },
  }, { env: fixture.env, presets: ROUTE_SOURCES });
  assert.equal(result.changed, true);
  assert.deepEqual(result.subagentRoutes, [{ preset: 'standard', inherited: true }]);

  const after = await readFile(fixture.patchPath, 'utf8');
  assert.equal(after.includes('agentOptions'), false);
  assert.equal(after.includes('modelSelection: true'), true, 'the rest of the delegation row stays');

  const again = await getSnapshot({ env: fixture.env, presets: ROUTE_SOURCES });
  const standard = again.modelSelection.presets.find(preset => preset.id === 'standard');
  assert.equal(standard.route, undefined);
});

test('a route outside llm-pi-ai or an undeclared effort is refused', async () => {
  const fixture = await routeFixture();
  const snapshot = await getSnapshot({ env: fixture.env, presets: ROUTE_SOURCES });
  const before = await readFile(fixture.patchPath, 'utf8');

  await assert.rejects(
    applyTargets({
      ...bodyFor(snapshot),
      presets: ['standard'],
      subagentRoutes: { standard: { provider: 'demo', model: 'model-gone' } },
    }, { env: fixture.env, presets: ROUTE_SOURCES }),
    error => error.code === 'compaction-targets/route-unknown' && /demo\/model-gone/.test(error.message),
  );
  await assert.rejects(
    applyTargets({
      ...bodyFor(snapshot),
      presets: ['standard'],
      subagentRoutes: { standard: { provider: 'demo', model: 'model-a', reasoningEffort: 'xhigh' } },
    }, { env: fixture.env, presets: ROUTE_SOURCES }),
    error => error.code === 'compaction-targets/route-effort' && /xhigh/.test(error.message),
  );
  // model-b declares no reasoningEfforts at all.
  await assert.rejects(
    applyTargets({
      ...bodyFor(snapshot),
      presets: ['standard'],
      subagentRoutes: { standard: { provider: 'demo', model: 'model-b', reasoningEffort: 'max' } },
    }, { env: fixture.env, presets: ROUTE_SOURCES }),
    error => error.code === 'compaction-targets/route-effort',
  );
  assert.equal(await readFile(fixture.patchPath, 'utf8'), before, 'nothing was written');
});

test('a preset without a delegation tool cannot receive a route', async () => {
  const fixture = await routeFixture();
  const snapshot = await getSnapshot({ env: fixture.env, presets: ROUTE_SOURCES });
  await assert.rejects(
    applyTargets({
      ...bodyFor(snapshot),
      presets: ['minimal'],
      subagentRoutes: { minimal: { provider: 'demo', model: 'model-a' } },
    }, { env: fixture.env, presets: ROUTE_SOURCES }),
    error => error.code === 'compaction-targets/no-delegation-tool' && /minimal/.test(error.message),
  );
});

test('a route for a preset outside the save is refused', async () => {
  const fixture = await routeFixture();
  const snapshot = await getSnapshot({ env: fixture.env, presets: ROUTE_SOURCES });
  await assert.rejects(
    applyTargets({
      ...bodyFor(snapshot),
      presets: ['standard'],
      subagentRoutes: { minimal: null },
    }, { env: fixture.env, presets: ROUTE_SOURCES }),
    error => error.code === 'compaction-targets/route-preset',
  );
});

test('the route edit keeps keys the page does not manage', async () => {
  const fixture = await routeFixture(ROUTE_PROFILE.replace(
    '                reasoningEffort: max\n',
    '                reasoningEffort: max\n                maxTokens: 4096\n',
  ));
  const snapshot = await getSnapshot({ env: fixture.env, presets: ROUTE_SOURCES });
  await applyTargets({
    ...bodyFor(snapshot),
    presets: ['standard'],
    subagentRoutes: { standard: { provider: 'demo', model: 'model-b' } },
  }, { env: fixture.env, presets: ROUTE_SOURCES });

  const after = await readFile(fixture.patchPath, 'utf8');
  assert.match(after, /\n {16}model: model-b\n {16}maxTokens: 4096\n/);
  const block = /\n {14}agentOptions:\n([\s\S]*?)\n {10}- id: tool-subagent-fork/.exec(after);
  assert.ok(block);
  assert.equal(block[1].includes('reasoningEffort'), false);
  assert.equal(block[1].includes('maxTokens: 4096'), true, 'the key the page does not manage is kept');
});

test('a page-managed route wins over the profile overlay and is not drift', async () => {
  const declared = ROUTE_PROFILE + `- id: compaction-targets
  config:
    presetOverrides:
      standard:
        - id: tool-subagent
          config:
            agentOptions:
              provider: demo
              model: model-b
`;
  const fixture = await routeFixture(declared);
  const snapshot = await getSnapshot({ env: fixture.env, presets: ROUTE_SOURCES });
  const standard = snapshot.modelSelection.presets.find(preset => preset.id === 'standard');
  assert.deepEqual(standard.route, { provider: 'demo', model: 'model-a', reasoningEffort: 'max' });
  assert.deepEqual(standard.declaredRoute, { provider: 'demo', model: 'model-b' });
  assert.equal(snapshot.presets.find(preset => preset.id === 'standard').drift.length, 0);

  // Saving without touching the route keeps the row's value, not the overlay's.
  const result = await applyTargets({
    ...bodyFor(snapshot),
    presets: ['standard'],
    subagentRoutes: { standard: { provider: 'demo', model: 'model-a', reasoningEffort: 'max' } },
  }, { env: fixture.env, presets: ROUTE_SOURCES });
  assert.equal(result.changed, false);
  assert.equal(await readFile(fixture.patchPath, 'utf8'), declared);
});

test('a preset row without an upstream declaration can change its route', async () => {
  const custom = `${ROUTE_PROFILE}
- id: preset-custom
  config:
    id: custom
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
      - id: delegation
        name: cordis:group
        group: true
        config:
          - id: tool-subagent
            name: '@deepseek-ai/dsh-tool-subagent'
            config:
              provider: spawn
              toolName: subagent
              agentOptions:
                provider: demo
                model: model-a
`;
  const fixture = await routeFixture(custom);
  const sources = [...ROUTE_SOURCES, { id: 'custom', name: 'Custom', order: 9 }];
  const snapshot = await getSnapshot({ env: fixture.env, presets: sources });
  const result = await applyTargets({
    ...bodyFor(snapshot),
    presets: ['custom'],
    subagentRoutes: { custom: { provider: 'demo', model: 'model-b' } },
  }, { env: fixture.env, presets: sources });
  assert.equal(result.changed, true);
  const after = await readFile(fixture.patchPath, 'utf8');
  const row = after.slice(after.indexOf('- id: preset-custom'));
  assert.match(row, /agentOptions:\n {16}provider: demo\n {16}model: model-b/);
  const customBlock = /agentOptions:\n([\s\S]*)$/.exec(row);
  assert.ok(customBlock);
  assert.equal(customBlock[1].includes('model: model-a'), false);
});

test('CRLF patches keep CRLF in the written route block', async () => {
  const fixture = await routeFixture(ROUTE_PROFILE.replace(/\n/g, '\r\n'));
  const snapshot = await getSnapshot({ env: fixture.env, presets: ROUTE_SOURCES });
  await applyTargets({
    ...bodyFor(snapshot),
    presets: ['standard'],
    subagentRoutes: { standard: { provider: 'demo', model: 'model-a', reasoningEffort: 'high' } },
  }, { env: fixture.env, presets: ROUTE_SOURCES });

  const after = await readFile(fixture.patchPath, 'utf8');
  assert.equal(after.includes('\n'), true);
  const routeLines = after.split('\r\n').filter(line => /^ {14}agentOptions:$|^ {16}(provider: demo|model: model-a|reasoningEffort: high)$/.test(line));
  assert.equal(routeLines.length, 4);
  assert.equal(after.replace(/\r\n/g, '').includes('\n'), false, 'no bare LF was introduced');
});

test('the route writer inserts, replaces and removes the block in place', () => {
  const source = `- id: tool-subagent
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent
- id: tool-subagent-fork
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: fork
    toolName: subagent_fork
`;
  const inserted = __test.writeToolRoute(source, { provider: 'demo', model: 'model-b' }, '\n');
  assert.match(inserted, /toolName: subagent\n    agentOptions:\n      provider: demo\n      model: model-b\n- id: tool-subagent-fork/);
  const replaced = __test.writeToolRoute(inserted, { provider: 'demo', model: 'model-a', reasoningEffort: 'max' }, '\n');
  assert.equal((replaced.match(/agentOptions/g) ?? []).length, 1);
  assert.match(replaced, /      provider: demo\n      model: model-a\n      reasoningEffort: max\n/);
  assert.equal(replaced.includes('model-b'), false);
  const removed = __test.writeToolRoute(replaced, null, '\n');
  assert.equal(removed, source);
  // The fork instance is never touched.
  assert.equal(inserted.includes('provider: fork'), true);
});


