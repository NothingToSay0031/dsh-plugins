import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

async function loadClient(fetchImpl) {
  const source = await readFile(path.join(here, '..', 'client.js'), 'utf8');
  let loaded;
  const context = {
    window: {
      __ModuleLoader__: {
        load(value) {
          loaded = value;
        },
      },
      location: { href: 'http://127.0.0.1:8155/' },
    },
    document: { baseURI: 'http://127.0.0.1:8155/' },
    navigator: { language: 'zh-CN' },
    console: { log() {}, error() {} },
    URL,
    fetch: fetchImpl || (async () => ({ ok: false, status: 500, json: async () => ({}) })),
  };
  vm.runInNewContext(source, context, { filename: 'client.js' });
  return { source, loaded };
}

function fakeReact(states = []) {
  let index = 0;
  return {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children };
    },
    useState(initial) {
      const value = index < states.length
        ? states[index]
        : (typeof initial === 'function' ? initial() : initial);
      index += 1;
      return [value, () => {}];
    },
    useEffect() {},
  };
}

function fakeRequire(react) {
  return name => {
    if (name === 'react') return react;
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      return {
        IconCompactOutlineRegular: function IconCompactOutlineRegular() { return null; },
        MenuItemButton: function MenuItemButton() { return null; },
      };
    }
    throw new Error(`unexpected require: ${name}`);
  };
}

function textOf(node) {
  if (node === null || node === undefined) return [];
  if (typeof node === 'string' || typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(textOf);
  return textOf(node.children);
}

function locale() {
  return {
    register(ns, dicts) {
      assert.equal(ns, 'compactionTargets');
      assert.equal(typeof dicts.zh.tab, 'string');
      assert.equal(typeof dicts.en.tab, 'string');
      assert.match(dicts.zh.prunerNote, /tool-result-pruner/);
      assert.match(dicts.en.prunerNote, /tool-result-pruner/);
      assert.match(dicts.zh.prunerNote, /disabled: true/);
      assert.match(dicts.en.prunerNote, /disabled: true/);
      return () => {};
    },
    bind(ns) {
      assert.equal(ns, 'compactionTargets');
      return key => (key === 'tab' ? '压缩点' : key);
    },
  };
}

function fakeContext(registrations, panel, options = {}) {
  const withLocale = options.withLocale !== false;
  return {
    layout: {
      panelInfo: { getSnapshot: () => ({ activePanelId: panel.activePanelId ?? null }) },
      selectPanel(id) { panel.selected = id; },
    },
    get(name) {
      return name === 'locale' && withLocale ? locale() : undefined;
    },
    effect(callback) {
      const cleanup = callback();
      return () => cleanup?.();
    },
    slots: {
      inject(name, callback) {
        assert.ok(name === 'main' || name === 'sidebar.panellist.actions');
        callback();
      },
      register(options, component) {
        registrations.push({ options, component });
        return () => {};
      },
    },
  };
}

test('client bundle registers a main panel and a More-menu row, not a settings tab', async () => {
  const { source, loaded } = await loadClient();
  assert.equal(source.includes('actualReserve'), false);
  assert.equal(source.includes('reserveTokens'), false);
  assert.equal(source.includes('reserveHidden'), true);
  assert.equal(source.includes("t('prunerNote')"), true);
  assert.equal(source.includes('settings.plugins.tab'), false);
  assert.equal(loaded.id, '@local/dsh-compaction-targets');
  assert.equal(typeof loaded.factory, 'function');

  const plugin = loaded.factory(fakeRequire(fakeReact()));
  const registrations = [];
  const panel = { selected: null, activePanelId: null };
  plugin.apply(fakeContext(registrations, panel));

  assert.deepEqual(registrations.map(entry => entry.options.name).sort(), [
    'main',
    'sidebar.panellist.actions',
  ]);
  const main = registrations.find(entry => entry.options.name === 'main');
  assert.equal(main.options.key, 'compaction-targets');
  assert.equal(main.options.locale, 'compactionTargets');

  const actions = registrations.find(entry => entry.options.name === 'sidebar.panellist.actions');
  assert.equal(actions.options.id, 'compaction-targets');
  assert.equal(typeof actions.component, 'function');

  let dismissed = 0;
  const row = actions.component({ onDismiss: () => { dismissed += 1; } });
  assert.equal(row.children[0], '压缩点');
  assert.equal(typeof row.props.icon.type, 'function');
  assert.equal(row.props.icon.props.size, 16);
  row.props.onSelect();
  assert.equal(dismissed, 1);
  assert.equal(panel.selected, 'compaction-targets');

  const outer = main.component({ t: key => key });
  assert.equal(typeof outer.type, 'function');
  const element = outer.type(outer.props);
  assert.equal(element.type, 'div');
  assert.equal(element.props.style.height, '100%');
  assert.equal(element.props.style.overflow, 'auto');
  assert.equal(element.children[0].type, 'p');
});

test('main panel tells the user that saving disables tool-result-pruner', async () => {
  const { loaded } = await loadClient();
  const snapshot = {
    models: [],
    global: { retainTokens: 30000, headroomTokens: 8192, summarizerMaxTokens: 20000 },
    presets: [],
  };
  const result = {
    changed: true,
    patchPath: 'C:/profile/cordis.patch.yml',
    backupPath: 'C:/profile/cordis.patch.yml.bak-1',
    presets: ['standard'],
    models: [],
    reserveNotes: [],
    jsonSnapshot: null,
  };
  const states = [
    snapshot,
    [],
    { retainTokens: '30000', headroomTokens: '8192', summarizerMaxTokens: '20000' },
    false,
    false,
    null,
    null,
    result,
    [],
    [],
  ];
  const plugin = loaded.factory(fakeRequire(fakeReact(states)));
  const registrations = [];
  const panel = { selected: null, activePanelId: null };
  plugin.apply(fakeContext(registrations, panel, { withLocale: false }));
  const main = registrations.find(entry => entry.options.name === 'main');
  const outer = main.component({});
  const element = outer.type(outer.props);
  assert.equal(element.type, 'div');
  assert.equal(element.children[0].props.style.display, 'grid');
  const text = textOf(element).join('\n');
  assert.match(text, /tool-result-pruner/);
  assert.match(text, /disabled: true/);
  assert.match(text, /保存除了写入压缩值/);
  assert.match(text, /勾选的预设中存在该项的都已关闭/);
});

function nodesOfType(node, type, out = []) {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) {
    for (const item of node) nodesOfType(item, type, out);
    return out;
  }
  if (typeof node !== 'object') return out;
  if (node.type === type) out.push(node);
  nodesOfType(node.children, type, out);
  return out;
}

function flatChildren(node) {
  const out = [];
  const visit = value => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value === null || value === undefined) return;
    out.push(value);
  };
  visit(node.children);
  return out;
}

const ROUTE_SNAPSHOT = {
  models: [
    {
      provider: 'demo',
      model: 'model-a',
      name: 'model-a',
      window: 1000000,
      compactAtTokens: 300000,
      enabled: true,
      efforts: ['high', 'max'],
    },
    {
      provider: 'demo',
      model: 'model-b',
      name: 'model-b',
      window: 1000000,
      compactAtTokens: 300000,
      enabled: false,
      efforts: [],
    },
  ],
  global: { retainTokens: 30000, headroomTokens: 8192, summarizerMaxTokens: 20000, summarizerUnlimited: false },
  presets: [{ id: 'standard', name: 'Standard', isDefault: true }],
  modelSelection: {
    policy: { declared: true, enabled: true, allowedModels: [{ provider: 'demo', model: 'model-a' }] },
    presets: [
      {
        id: 'standard',
        tool: {
          id: 'tool-subagent',
          modelSelection: true,
          modelDiscovery: true,
          disabled: false,
          agentOptions: { provider: 'demo', model: 'model-a', reasoningEffort: 'max' },
        },
        source: 'row',
        declaredRoute: { provider: 'demo', model: 'model-b' },
      },
      { id: 'minimal', source: 'row' },
    ],
    checks: [{ level: 'info', code: 'preset-no-delegation-tool', preset: 'minimal' }],
  },
  patchPath: 'C:/home/cordis.patch.yml',
};

function routeStates(routes, selectedPresets = ['standard']) {
  return [
    ROUTE_SNAPSHOT,
    (ROUTE_SNAPSHOT.models || []).map(model => ({
      provider: model.provider,
      model: model.model,
      name: model.name,
      window: model.window,
      compactAtTokens: String(model.compactAtTokens),
      enabled: model.enabled,
    })),
    { retainTokens: '30000', headroomTokens: '8192', summarizerMaxTokens: '20000', summarizerUnlimited: false },
    false,
    false,
    null,
    null,
    null,
    ROUTE_SNAPSHOT.presets,
    selectedPresets,
    false,
    routes,
  ];
}

function renderPage(loaded, states) {
  const plugin = loaded.factory(fakeRequire(fakeReact(states)));
  const registrations = [];
  plugin.apply(fakeContext(registrations, { selected: null, activePanelId: null }, { withLocale: false }));
  const main = registrations.find(entry => entry.options.name === 'main');
  const outer = main.component({});
  return outer.type(outer.props);
}

test('the child default route is editable and explains the allowlist and the overlay', async () => {
  const { loaded } = await loadClient();
  const element = renderPage(loaded, routeStates({
    standard: { provider: 'demo', model: 'model-a', reasoningEffort: 'max' },
  }));

  const selects = nodesOfType(element, 'select');
  assert.equal(selects.length, 2, 'one route select and one effort select for the standard row');
  const [routeSelect, effortSelect] = selects;
  assert.equal(routeSelect.props.value, 'demo\u0000model-a');
  assert.deepEqual(flatChildren(routeSelect).map(option => option.children[0]), [
    '继承父会话路由',
    'demo/model-a',
    'demo/model-b',
  ]);
  assert.equal(effortSelect.props.value, 'max');
  assert.deepEqual(flatChildren(effortSelect).map(option => option.props.value), ['', 'high', 'max']);

  const text = textOf(element).join('\n');
  assert.match(text, /子代理默认路由/);
  assert.match(text, /profile 的 presetOverrides\.standard 仍声明了默认路由 demo\/model-b/);
  assert.equal(text.includes('不在允许清单里'), false, 'demo/model-a is authorized');
  assert.match(text, /没有委派工具/, 'the minimal row carries no route editor');
});

test('saving sends the route of every checked preset and no route for the rest', async () => {
  const calls = [];
  const { loaded } = await loadClient(async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method, body: options.body });
    return { ok: false, status: 500, json: async () => ({}) };
  });
  const element = renderPage(loaded, routeStates({
    standard: { provider: 'demo', model: 'model-a', reasoningEffort: 'high' },
    minimal: null,
  }));
  const buttons = nodesOfType(element, 'button');
  assert.equal(buttons.length, 2, 'save and reload');
  const save = buttons[0];
  save.props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  const body = JSON.parse(calls[0].body);
  assert.deepEqual(body.subagentRoutes, {
    standard: { provider: 'demo', model: 'model-a', reasoningEffort: 'high' },
  });
  assert.deepEqual(body.presets, ['standard']);
});
