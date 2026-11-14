import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

test('client opens the page from the More menu instead of owning a sidebar row', async () => {
  const source = await readFile(path.join(here, '..', 'client.js'), 'utf8');
  let loaded;
  const context = {
    window: { __ModuleLoader__: { load(value) { loaded = value; } } },
    navigator: { language: 'zh-CN' },
    document: {},
    console,
    AbortController,
  };
  vm.runInNewContext(source, context, { filename: 'client.js' });

  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children };
    },
    useState(value) {
      return [typeof value === 'function' ? value() : value, () => {}];
    },
    useEffect() {},
    useRef(value) {
      return { current: value };
    },
    useCallback(callback) {
      return callback;
    },
  };
  const MenuItemButton = function MenuItemButton() { return null; };
  const plugin = loaded.factory(name => {
    if (name === 'react') return React;
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { MenuItemButton };
    throw new Error(`unexpected require: ${name}`);
  });

  const registrations = [];
  let selected = null;
  let dismissed = 0;
  const ctx = {
    locale: {
      register() { return () => {}; },
      bind() { return key => key; },
    },
    connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
    layout: {
      panelInfo: { getSnapshot: () => ({ activePanelId: null }) },
      selectPanel(id) { selected = id; },
    },
    effect(callback) {
      const cleanup = callback();
      return () => cleanup?.();
    },
    slots: {
      inject(name, callback) {
        callback();
      },
      register(options, component) {
        registrations.push({ options, component });
        return () => {};
      },
    },
  };

  plugin.apply(ctx);

  assert.ok(plugin.inject.includes('layout'));
  assert.deepEqual(registrations.map(entry => entry.options.name), [
    'main',
    'sidebar.panellist.actions',
  ]);
  const main = registrations.find(entry => entry.options.name === 'main');
  assert.equal(main.options.key, 'session-collab');

  const actions = registrations.find(entry => entry.options.name === 'sidebar.panellist.actions');
  assert.equal(actions.options.id, 'session-collab');
  assert.equal(actions.options.order, -20);

  const row = actions.component({ onDismiss: () => { dismissed += 1; } });
  assert.equal(row.type, MenuItemButton);
  assert.equal(row.children[0], 'panel');
  row.props.onSelect();
  assert.equal(dismissed, 1);
  assert.equal(selected, 'session-collab');
});

test('the communication-log page and its endpoint stay removed', async () => {
  const source = await readFile(path.join(here, '..', 'client.js'), 'utf8');
  for (const marker of ['LogList', 'sessionLabel', 'sc-tabs', 'sc-log', '通信日志', 'Communication log', "api('logs'"]) {
    assert.ok(!source.includes(marker), `client.js must not reference the removed log UI: ${marker}`);
  }
  const host = await readFile(path.join(here, '..', 'index.js'), 'utf8');
  assert.ok(!host.includes("method === 'logs'"), 'the logs endpoint must stay removed');
  const core = await readFile(path.join(here, '..', 'core.js'), 'utf8');
  assert.ok(!core.includes('logPage'), 'the UI log pager must stay removed');
  assert.ok(!/logs:\s/.test(core), 'the snapshot must not carry a logs field');
});
