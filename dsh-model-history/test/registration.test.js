import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply, inject, name } from '../index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('the plugin registers only the model history projection', async () => {
  const projections = [];
  const ctx = { sessionProjections: { register: projection => projections.push(projection) } };
  await apply(ctx);
  assert.deepEqual(inject, ['sessionProjections']);
  assert.equal(name, 'local-model-history');
  assert.equal(projections.length, 1);
  assert.equal(projections[0].key, 'localModelRequestHistory');
});

/** Load the browser half in a sandbox and return its plugin object. */
async function loadClient() {
  const source = await readFile(path.join(here, '..', 'client.js'), 'utf8');
  let loaded;
  const context = {
    window: { __ModuleLoader__: { load(value) { loaded = value; } } },
    navigator: { language: 'zh-CN' },
    document: {},
    console,
  };
  vm.runInNewContext(source, context, { filename: 'client.js' });

  const React = {
    Fragment: Symbol.for('react.fragment'),
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat() };
    },
  };
  const MenuItemButton = function MenuItemButton() { return null; };
  const IconFlatListOutlineRegular = function IconFlatListOutlineRegular() { return null; };
  const plugin = loaded.factory(request => {
    if (request === 'react') return React;
    if (request === '@deepseek-ai/dsh-client-ui-primitives') return { MenuItemButton, IconFlatListOutlineRegular };
    throw new Error(`unexpected require: ${request}`);
  });
  return { plugin, React, MenuItemButton };
}

/** Register the client half against a recording context. */
function applyClient(plugin) {
  const registrations = [];
  const ctx = {
    locale: {
      register() { return () => {}; },
      bind() { return key => key; },
    },
    effect(callback) {
      const cleanup = callback();
      return () => cleanup?.();
    },
    slots: {
      inject(key, callback) { callback(); },
      register(options, component) {
        registrations.push({ options, component });
        return () => {};
      },
    },
  };
  plugin.apply(ctx);
  return registrations;
}

/** Expand function components into their element tree, like React would. */
function render(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(render);
  if (typeof node.type === 'function') return render(node.type(node.props));
  return { type: node.type, props: node.props, children: (node.children ?? []).map(render) };
}

/** Collect every element of one type in a rendered tree. */
function findAll(node, type, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, type, found);
    return found;
  }
  if (node.type === type) found.push(node);
  for (const child of node.children ?? []) findAll(child, type, found);
  return found;
}

test('the client contributes a conversation View and a More menu row', async () => {
  const { plugin } = await loadClient();
  const registrations = applyClient(plugin);
  assert.deepEqual(registrations.map(entry => entry.options.name), [
    'conversation.view',
    'conversation.session.header.views.actions',
  ]);
  const view = registrations[0].options;
  assert.equal(view.id, 'model-history');
  assert.equal(view.order, 30);
  assert.equal(view.label(), 'view');
  const row = registrations[1].options;
  assert.equal(row.id, 'model-history');
  assert.equal(row.label(), 'menu');
});

test('the view lists one row per recorded configuration', async () => {
  const { plugin, React } = await loadClient();
  const registrations = applyClient(plugin);
  const view = registrations[0].component;
  const entries = [
    { provider: 'acme', model: 'acme/a', reasoningEffort: 'high', effortDefaulted: false, reason: 'initial', turn: 1, step: 1, time: 1, seq: 1 },
    { provider: 'acme', model: 'acme/b', reasoningEffort: null, effortDefaulted: true, reason: 'change', turn: 2, step: 1, time: 2, seq: 2 },
  ];
  const tree = render(view({
    t: key => key,
    useProjection: (key, selector) => selector(entries),
  }));
  const rows = findAll(tree, 'tr');
  assert.equal(rows.length, 3);
  const cells = findAll(rows[1], 'td');
  assert.equal(cells.length, 8);
  assert.equal(cells[0].children[0], '1');
  assert.match(cells[1].children[0], /^\d{2}:\d{2}:\d{2}$/);
  assert.equal(cells[2].children[0], '1 / 1');
  assert.equal(cells[3].children[0], 'acme');
  assert.equal(cells[4].children[0], 'acme/a');
  assert.equal(cells[5].children[0], 'high');
  assert.equal(cells[6].children[0].children[0], 'reasonInitial');
  assert.equal(cells[7].children[0], '0s');
  assert.equal(findAll(tree, 'table').length, 1);
  assert.equal(React.Fragment, Symbol.for('react.fragment'));
});

test('the More menu row opens the view and hides itself once the view is folded', async () => {
  const { plugin, MenuItemButton } = await loadClient();
  const registrations = applyClient(plugin);
  const row = registrations[1].component;
  let opened = null;
  let dismissed = 0;
  const props = {
    t: key => key,
    entries: [],
    onOpen(id) { opened = id; },
    onDismiss() { dismissed += 1; },
  };
  const rendered = row(props);
  assert.equal(rendered.type, MenuItemButton);
  assert.equal(rendered.children[0], 'menu');
  rendered.props.onSelect();
  assert.equal(dismissed, 1);
  assert.equal(opened, 'model-history');

  assert.equal(row({ ...props, entries: [{ id: 'model-history', label: 'Model History' }] }), null);
  assert.notEqual(row({ ...props, entries: [{ id: 'other', label: 'Other' }] }), null);
});
