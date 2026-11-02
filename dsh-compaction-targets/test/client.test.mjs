import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

async function loadClient() {
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
    fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
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

function textOf(node) {
  if (node === null || node === undefined) return [];
  if (typeof node === 'string' || typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(textOf);
  return textOf(node.children);
}

test('client bundle registers a settings tab and can render its loading state', async () => {
  const { source, loaded } = await loadClient();
  assert.equal(source.includes('actualReserve'), false);
  assert.equal(source.includes('reserveTokens'), false);
  assert.equal(source.includes('reserveHidden'), true);
  assert.equal(source.includes("t('prunerNote')"), true);
  assert.equal(loaded.id, '@local/dsh-compaction-targets');
  assert.equal(typeof loaded.factory, 'function');

  const plugin = loaded.factory((name) => {
    assert.equal(name, 'react');
    return fakeReact();
  });
  let registration;
  const locale = {
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
  const ctx = {
    get(name) {
      return name === 'locale' ? locale : undefined;
    },
    effect(callback) {
      const cleanup = callback();
      return () => cleanup?.();
    },
    slots: {
      inject(name, callback) {
        assert.equal(name, 'settings.plugins.tab');
        callback();
      },
      register(options, component) {
        registration = { options, component };
        return () => {};
      },
    },
  };
  plugin.apply(ctx);
  assert.equal(registration.options.name, 'settings.plugins.tab');
  assert.equal(registration.options.id, 'compaction-targets');
  assert.equal(registration.options.label(), '压缩点');
  assert.equal(typeof registration.component, 'function');

  const outer = registration.component({ t: key => key });
  assert.equal(typeof outer.type, 'function');
  const element = outer.type(outer.props);
  assert.equal(element.type, 'div');
  assert.equal(element.props.style.display, 'grid');
});

test('settings page tells the user that saving disables tool-result-pruner', async () => {
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
  const plugin = loaded.factory(() => fakeReact(states));
  let registration;
  const ctx = {
    get() {
      return undefined;
    },
    effect(callback) {
      const cleanup = callback();
      return () => cleanup?.();
    },
    slots: {
      inject(name, callback) {
        assert.equal(name, 'settings.plugins.tab');
        callback();
      },
      register(options, component) {
        registration = { options, component };
        return () => {};
      },
    },
  };
  plugin.apply(ctx);
  const outer = registration.component({});
  const element = outer.type(outer.props);
  assert.equal(element.type, 'div');
  const text = textOf(element).join('\n');
  assert.match(text, /tool-result-pruner/);
  assert.match(text, /disabled: true/);
  assert.match(text, /保存除了写入压缩值/);
  assert.match(text, /勾选的预设中存在该项的都已关闭/);
});
