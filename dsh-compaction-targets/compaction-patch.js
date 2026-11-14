// Compaction target persistence for the DSH desktop profile.
//
// This module is deliberately read-only except for `applyTargets()`: loading the
// Host plugin must never create, normalize, or "repair" a file. The only write
// entry point is a SAVE request from the Settings page.
import { existsSync } from 'node:fs';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ENTRY_LIST_SCHEMA, dumpEntryList } from './preset-baseline.js';

const require = createRequire(import.meta.url);
const yaml = require('./vendor/js-yaml.cjs');

// The profile patch is read the way the Host reads it: the Loader's own
// entry-list dialect, so a `!!js` condition compares equal on both sides of
// a rewrite and a written declaration reads back exactly as it was declared.
const SCHEMA = ENTRY_LIST_SCHEMA;

const PATCH_BASENAME = 'cordis.patch.yml';
const BACKUP_SUFFIX = '.bak';
const SNAPSHOT_BASENAME = 'compaction-targets.json';
// The profile row of this plugin. It carries the customisations the profile
// owner keeps on top of the upstream declaration of a preset.
const PLUGIN_ROW_ID = 'compaction-targets';
const KNOWN_CONFIG_KEYS = new Set([
  'thresholdRatio',
  'headroomTokens',
  'maxTokens',
  'retainTokens',
  'modelPolicies',
]);

export class TargetError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'TargetError';
    this.code = details.code || 'compaction-targets/invalid';
    this.details = details;
  }
}

function fail(message, details = {}) {
  throw new TargetError(message, details);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function integer(value, field, min = 0) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < min) {
    fail(`${field} 必须是大于等于 ${min} 的整数，收到 ${JSON.stringify(value)}`, { field, value });
  }
  return number;
}

function ratio(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 1) {
    fail(`${field} 必须是 (0, 1] 内的比例，收到 ${JSON.stringify(value)}`, { field, value });
  }
  return number;
}

function normalizeText(text) {
  return String(text).replace(/\r\n/g, '\n');
}

function parseDocuments(text, options = {}) {
  if (normalizeText(text).trim() === '') {
    if (options.allowEmpty) return [];
    fail('cordis.patch.yml 的顶层必须是至少包含一个条目的 YAML 数组', {
      code: 'compaction-targets/patch-shape',
    });
  }
  let docs;
  try {
    docs = yaml.load(normalizeText(text), { schema: SCHEMA });
  } catch (error) {
    fail(`cordis.patch.yml 解析失败：${error instanceof Error ? error.message : String(error)}`, {
      code: 'compaction-targets/patch-parse',
    });
  }
  if (!Array.isArray(docs) || docs.length === 0) {
    if (options.allowEmpty) return [];
    fail('cordis.patch.yml 的顶层必须是至少包含一个条目的 YAML 数组', {
      code: 'compaction-targets/patch-shape',
    });
  }
  return docs;
}

function findEntry(docs, id) {
  const entry = docs.find(candidate => candidate && candidate.id === id);
  if (!entry) fail(`cordis.patch.yml 缺少条目 ${JSON.stringify(id)}`, { id });
  return entry;
}

function currentModels(docs) {
  const entry = findEntry(docs, 'llm-pi-ai');
  if (!isRecord(entry.config) || !isRecord(entry.config.providers)) {
    fail('llm-pi-ai 缺少 config.providers', { entry: 'llm-pi-ai' });
  }
  const models = [];
  for (const [providerName, providerConfig] of Object.entries(entry.config.providers)) {
    if (!isRecord(providerConfig) || !Array.isArray(providerConfig.models) || providerConfig.models.length === 0) continue;
    for (const [index, model] of providerConfig.models.entries()) {
      if (!isRecord(model)) {
        fail(`providers.${providerName}.models[${index}] 不是对象`, {
          entry: 'llm-pi-ai',
          provider: providerName,
          index,
        });
      }
      const modelId = typeof model.id === 'string' ? model.id.trim() : '';
      if (!modelId) {
        fail(`providers.${providerName}.models[${index}] 缺少 id`, {
          entry: 'llm-pi-ai',
          provider: providerName,
          index,
        });
      }
      const label = `llm-pi-ai ${providerName}/${modelId}`;
      models.push({
        provider: providerName,
        model: modelId,
        name: typeof model.name === 'string' && model.name.trim() ? model.name.trim() : modelId,
        window: integer(model.contextWindow, `${label} contextWindow`, 1),
        actualReserve: integer(model.maxTokens, `${label} maxTokens`, 0),
        // The levels this model accepts as `reasoningEffort`. `false` declares
        // a non-reasoning model, so no level can be configured for it.
        efforts: isRecord(model.reasoningEfforts) ? Object.keys(model.reasoningEfforts) : [],
      });
    }
  }
  if (models.length === 0) {
    fail('llm-pi-ai 的 config.providers 里没有任何带非空 models 的 provider', {
      entry: 'llm-pi-ai',
      providers: Object.keys(entry.config.providers),
    });
  }
  return models;
}

function currentCompaction(docs, fallbackDocs = []) {
  // The generated preset rows live in the home layer; a profile that still
  // carries them is read as the fallback so the first save can migrate.
  const preset = docs.find(candidate => candidate && candidate.id === 'preset-standard')
    ?? fallbackDocs.find(candidate => candidate && candidate.id === 'preset-standard');
  if (!preset) {
    fail('缺少 preset-standard 覆盖：profile 层与 home 层都没有该条目', { id: 'preset-standard' });
  }
  if (!isRecord(preset.config) || !Array.isArray(preset.config.plugins)) {
    fail('preset-standard 缺少 config.plugins', { entry: 'preset-standard' });
  }
  const group = preset.config.plugins.find(candidate => candidate && candidate.id === 'compaction');
  if (!group) fail('preset-standard 的 config.plugins 缺少 compaction 组', { entry: 'preset-standard' });
  if (!Array.isArray(group.config)) {
    fail('preset-standard 的 compaction 组缺少 config 数组', { entry: 'preset-standard' });
  }
  const row = group.config.find(candidate => candidate && candidate.id === 'compaction-basic');
  if (!row) fail('preset-standard 的 compaction 组缺少 compaction-basic 行', { entry: 'preset-standard' });
  if (!isRecord(row.config)) {
    fail('compaction-basic 缺少 config 对象', { entry: 'preset-standard' });
  }
  return { preset, group, row, config: row.config };
}

function parsePolicies(config, field = 'compaction-basic.config.modelPolicies') {
  if (config.modelPolicies === undefined) return [];
  if (!Array.isArray(config.modelPolicies)) fail(`${field} 必须是数组`, { field });
  const policies = [];
  for (const [index, policy] of config.modelPolicies.entries()) {
    if (!isRecord(policy)) fail(`${field}[${index}] 不是对象`, { field, index });
    const provider = typeof policy.provider === 'string' ? policy.provider.trim() : '';
    const model = typeof policy.model === 'string' ? policy.model.trim() : '';
    if (!provider || !model) fail(`${field}[${index}] 缺少 provider 或 model`, { field, index });
    policies.push({
      provider,
      model,
      thresholdRatio: ratio(policy.thresholdRatio, `${field}[${index}].thresholdRatio`),
      // Absent means "the global cap applies". A row carrying its own number is
      // how the summarizer runs without a limit the plugin invented: the value
      // is that model's declared output cap.
      ...(policy.maxTokens === undefined
        ? {}
        : { maxTokens: integer(policy.maxTokens, `${field}[${index}].maxTokens`, 1) }),
    });
  }
  return policies;
}

function policyKey(provider, model) {
  return `${provider}/${model}`;
}

function effectivePoint(thresholdRatio, window, pressure) {
  return Math.floor(Math.min(window * thresholdRatio, pressure));
}

function pressureOf(model, headroom) {
  return model.window - model.actualReserve - headroom;
}

function reserveSource(model) {
  return `llm-pi-ai:providers.${model.provider}.models[${model.model}].maxTokens`;
}

function buildSnapshot(profileText, homeText, paths) {
  // Two files, two owners: the profile file holds what a person wrote (the
  // model table and the overlay row); the home layer holds what the plugin
  // generates (the preset rows). The home layer is applied last and wins.
  const docs = parseDocuments(profileText);
  const homeDocs = parseDocuments(homeText, { allowEmpty: true });
  const models = currentModels(docs);
  const compaction = currentCompaction(homeDocs, docs);
  const config = compaction.config;
  const headroomTokens = integer(config.headroomTokens, 'compaction-basic.config.headroomTokens', 0);
  const retainTokens = integer(config.retainTokens, 'compaction-basic.config.retainTokens', 1);
  const summarizerMaxTokens = integer(config.maxTokens, 'compaction-basic.config.maxTokens', 1);
  const fallbackRatio = ratio(config.thresholdRatio, 'compaction-basic.config.thresholdRatio');
  const policies = parsePolicies(config);
  const policyByKey = new Map(policies.map(policy => [policyKey(policy.provider, policy.model), policy]));
  // "No limit of its own" needs no extra flag in the file: every managed policy
  // row carries the model's own output cap, so the page can tell that apart
  // from a number somebody typed. One row without it means the number is real.
  const ownMaxByKey = new Map(models.map(model => [policyKey(model.provider, model.model), model.actualReserve]));
  const managedPolicies = policies.filter(policy => ownMaxByKey.has(policyKey(policy.provider, policy.model)));
  const summarizerUnlimited = managedPolicies.length > 0 && managedPolicies.every((policy) => {
    const own = ownMaxByKey.get(policyKey(policy.provider, policy.model));
    return own !== undefined && policy.maxTokens === own;
  });
  const presentKeys = new Set(models.map(model => policyKey(model.provider, model.model)));
  const unmanagedPolicies = policies.filter(policy => !presentKeys.has(policyKey(policy.provider, policy.model)));

  const resolvedModels = models.map(model => {
    const pressure = pressureOf(model, headroomTokens);
    if (pressure <= 0) {
      fail(
        `${model.provider}/${model.model}: window ${model.window} - reserve ${model.actualReserve} - headroom ${headroomTokens} <= 0`,
        { model: model.model, provider: model.provider },
      );
    }
    const policy = policyByKey.get(policyKey(model.provider, model.model));
    const enabled = policy !== undefined;
    const thresholdRatio = enabled ? policy.thresholdRatio : fallbackRatio;
    const compactAtTokens = effectivePoint(thresholdRatio, model.window, pressure);
    return {
      ...model,
      enabled,
      thresholdRatio,
      compactAtTokens,
      reserveTokens: model.actualReserve,
      reserveSource: reserveSource(model),
    };
  });

  return {
    docs,
    homeDocs,
    compaction,
    config,
    models: resolvedModels,
    policies,
    unmanagedPolicies,
    global: {
      retainTokens,
      headroomTokens,
      summarizerMaxTokens,
      summarizerUnlimited,
      fallbackRatio,
    },
    paths,
  };
}

function findBlockRange(text) {
  const lines = String(text).split('\n');
  const stripped = lines.map(line => line.replace(/\r$/, ''));
  const itemIdx = stripped.findIndex(line => line.trim() === '- id: compaction-basic');
  if (itemIdx < 0) fail('cordis.patch.yml 中找不到 compaction-basic 行');
  const itemIndent = /^\s*/.exec(stripped[itemIdx])[0].length;
  let itemEnd = itemIdx + 1;
  while (itemEnd < stripped.length) {
    if (stripped[itemEnd].trim() === '') {
      itemEnd += 1;
      continue;
    }
    if (/^\s*/.exec(stripped[itemEnd])[0].length <= itemIndent) break;
    itemEnd += 1;
  }
  const cfgIdx = stripped.findIndex((line, index) => index > itemIdx && index < itemEnd && /^\s*config:\s*$/.test(line));
  if (cfgIdx < 0) {
    // Base presets declare compaction-basic without a config block. Append the
    // generated block after the row's own keys, so a sibling key such as
    // `name:` keeps its place and its order.
    let insertAt = itemEnd;
    while (insertAt > itemIdx + 1 && stripped[insertAt - 1].trim() === '') insertAt -= 1;
    return { lines, cfgIdx: insertAt, cfgIndent: itemIndent + 2, end: insertAt };
  }
  const cfgIndent = /^\s*/.exec(stripped[cfgIdx])[0].length;
  let end = cfgIdx + 1;
  while (end < stripped.length) {
    const line = stripped[end];
    if (line.trim() === '') {
      end += 1;
      continue;
    }
    const indent = /^\s*/.exec(line)[0].length;
    // The block ends at the next sibling key of `config:`, not at the next
    // plugin row. A row may carry keys after its config block - the Host
    // renders a preset's child list as entry-list YAML, and a written config
    // block pushes the row's own `name:` behind it - and a block that ran to
    // the next row would swallow that sibling key and drop it from the file.
    // A sequence may sit at the key's own indent and still be its value.
    const isSequenceItem = /^\s*-\s/.test(line);
    if (indent < cfgIndent) break;
    if (indent === cfgIndent && !isSequenceItem) break;
    end += 1;
  }
  while (end > cfgIdx + 1 && stripped[end - 1].trim() === '') end -= 1;
  return { lines, cfgIdx, cfgIndent, end };
}

function indent(text, spaces) {
  const pad = ' '.repeat(spaces);
  return String(text)
    .split('\n')
    .map(line => `${pad}${line}`)
    .join('\n');
}

function findPresetRowRange(text, presetId) {
  const lines = String(text).split('\n');
  const stripped = lines.map(line => line.replace(/\r$/, ''));
  const start = stripped.findIndex(line => line.trim() === `- id: preset-${presetId}`);
  if (start < 0) return null;
  let end = start + 1;
  while (end < stripped.length) {
    if (/^- \s*/.test(stripped[end])) break;
    end += 1;
  }
  return { start, end };
}

function profilePresetIds(text) {
  const ids = [];
  for (const line of String(text).split('\n')) {
    const match = /^- id: preset-([^\s#]+)\s*(?:#.*)?$/.exec(line.replace(/\r$/, ''));
    if (match && !ids.includes(match[1])) ids.push(match[1]);
  }
  return ids;
}

function findToolPrunerRange(text, from = 0, to = Infinity) {
  const lines = String(text).split('\n');
  const stripped = lines.map(line => line.replace(/\r$/, ''));
  const itemIdx = stripped.findIndex((line, index) => index >= from && index < to
    && line.trim() === '- id: tool-result-pruner');
  if (itemIdx < 0) return null;
  const itemIndent = /^\s*/.exec(stripped[itemIdx])[0].length;
  let end = itemIdx + 1;
  while (end < stripped.length) {
    if (stripped[end].trim() === '') {
      end += 1;
      continue;
    }
    if (/^\s*/.exec(stripped[end])[0].length <= itemIndent) break;
    end += 1;
  }
  return { lines, itemIdx, itemIndent, end };
}

function disableToolPruner(text, from = 0, to = Infinity) {
  const range = findToolPrunerRange(text, from, to);
  if (!range) return text;
  const lines = range.lines;
  const pad = ' '.repeat(range.itemIndent + 2);
  let disabledAt = -1;
  for (let index = range.itemIdx + 1; index < range.end; index += 1) {
    if (/^\s*disabled:\s*/.test(lines[index])) {
      disabledAt = index;
      break;
    }
  }
  if (disabledAt >= 0) {
    const suffix = lines[disabledAt].endsWith('\r') ? '\r' : '';
    lines[disabledAt] = `${pad}disabled: true${suffix}`;
  } else {
    const suffix = lines[range.itemIdx].endsWith('\r') ? '\r' : '';
    lines.splice(range.itemIdx + 1, 0, `${pad}disabled: true${suffix}`);
  }
  return lines.join('\n');
}

function indentOf(line) {
  return /^\s*/.exec(line)[0].length;
}

// One `- id: <itemId>` row inside a list, from its line to the next row at the
// same or a shallower indent.
function findListItemRange(lines, itemId) {
  const itemIdx = lines.findIndex(line => line.replace(/\r$/, '').trim() === `- id: ${itemId}`);
  if (itemIdx < 0) return null;
  const itemIndent = indentOf(lines[itemIdx]);
  let end = itemIdx + 1;
  while (end < lines.length) {
    if (lines[end].trim() === '') {
      end += 1;
      continue;
    }
    if (indentOf(lines[end]) <= itemIndent) break;
    end += 1;
  }
  while (end > itemIdx + 1 && lines[end - 1].trim() === '') end -= 1;
  return { itemIdx, itemIndent, end };
}

// The block introduced by `key:` at exactly `keyIndent`, up to the next key at
// the same or a shallower indent.
function findKeyBlockRange(lines, from, to, key, keyIndent) {
  for (let start = from; start < to; start += 1) {
    const line = lines[start].replace(/\r$/, '');
    if (indentOf(line) !== keyIndent) continue;
    if (!new RegExp(`^\\s*${key}:`).test(line)) continue;
    let end = start + 1;
    while (end < to) {
      if (lines[end].trim() === '') {
        end += 1;
        continue;
      }
      if (indentOf(lines[end]) <= keyIndent) break;
      end += 1;
    }
    while (end > start + 1 && lines[end - 1].trim() === '') end -= 1;
    return { start, end };
  }
  return null;
}

// Write, replace or remove the `agentOptions` block of the delegation tool in
// a generated preset row. The edit is applied textually so the rest of the row
// keeps its wording; the caller re-parses the row afterwards and compares the
// structure against its source.
function writeToolRoute(text, edit, newline) {
  if (edit === undefined) return text;
  const lines = String(text).split('\n');
  const item = findListItemRange(lines, DELEGATION_TOOL_ID);
  if (!item) {
    fail(`生成的预设行里没有 ${DELEGATION_TOOL_ID}，无法写入子代理默认路由`, {
      code: 'compaction-targets/no-delegation-tool',
    });
  }
  const configIndent = item.itemIndent + 2;
  const config = findKeyBlockRange(lines, item.itemIdx + 1, item.end, 'config', configIndent);
  if (!config) {
    fail(`${DELEGATION_TOOL_ID} 行没有 config 块，无法写入子代理默认路由`, {
      code: 'compaction-targets/no-delegation-config',
    });
  }
  if (lines[config.start].replace(/\r$/, '').trim() !== 'config:') {
    fail(`${DELEGATION_TOOL_ID} 行的 config 是行内写法，无法安全写入子代理默认路由`, {
      code: 'compaction-targets/inline-config',
    });
  }
  const keyIndent = configIndent + 2;
  const existing = findKeyBlockRange(lines, config.start + 1, config.end, 'agentOptions', keyIndent);
  if (edit === null) {
    if (!existing) return text;
    lines.splice(existing.start, existing.end - existing.start);
    return lines.join('\n');
  }
  const pad = ' '.repeat(keyIndent);
  const eol = newline === '\r\n' ? '\r' : '';
  const body = yaml
    .dump(edit, { lineWidth: -1, noRefs: true, sortKeys: false })
    .replace(/\n$/, '')
    .split('\n');
  const block = [`${pad}agentOptions:${eol}`, ...body.map(line => `${pad}  ${line}${eol}`)];
  if (existing) lines.splice(existing.start, existing.end - existing.start, ...block);
  else lines.splice(config.end, 0, ...block);
  return lines.join('\n');
}

function modifyPresetContent(content, config, newline, options = {}) {
  const range = findBlockRange(content);
  const withConfig = replaceBlock(
    content,
    range,
    generateBlock(config, range, newline),
  );
  const withName = typeof options.compactionBasicName === 'string' && options.compactionBasicName
    ? ensureCompactionBasicNames(withConfig, options.compactionBasicName)
    : withConfig;
  const withPruner = disableToolPruner(withName);
  return writeToolRoute(withPruner, options.toolRoute, newline);
}

// A declaration whose plugin row lost its `name:` cannot be mounted by the
// Host - the preset then reads as "row N names no plugin" and the client
// shows that diagnostic instead of the preset. The canonical name is taken
// from the preset that still carries it and written back onto the row.
function ensureCompactionBasicNames(text, name) {
  const lines = String(text).split('\n');
  const stripped = lines.map(line => line.replace(/\r$/, ''));
  const itemIdxs = stripped
    .map((line, index) => (line.trim() === '- id: compaction-basic' ? index : -1))
    .filter(index => index >= 0);
  // Insert from the last row backwards, so the earlier indices stay valid.
  for (const itemIdx of itemIdxs.reverse()) {
    const itemIndent = /^\s*/.exec(stripped[itemIdx])[0].length;
    let itemEnd = itemIdx + 1;
    while (itemEnd < stripped.length) {
      if (stripped[itemEnd].trim() === '') {
        itemEnd += 1;
        continue;
      }
      if (/^\s*/.exec(stripped[itemEnd])[0].length <= itemIndent) break;
      itemEnd += 1;
    }
    const hasName = stripped.slice(itemIdx + 1, itemEnd).some(line => /^\s*name:\s*/.test(line));
    if (hasName) continue;
    const suffix = lines[itemIdx].endsWith('\r') ? '\r' : '';
    lines.splice(itemIdx + 1, 0, `${' '.repeat(itemIndent + 2)}name: ${JSON.stringify(name)}${suffix}`);
  }
  return lines.join('\n');
}

function parseEntryList(text, label) {
  let docs;
  try {
    docs = yaml.load(normalizeText(text), { schema: SCHEMA });
  } catch (error) {
    fail(`${label} 解析失败：${error instanceof Error ? error.message : String(error)}`, {
      code: 'compaction-targets/preset-parse',
    });
  }
  if (!Array.isArray(docs)) {
    fail(`${label} 必须是插件行数组`, { code: 'compaction-targets/preset-parse' });
  }
  return docs;
}

// The two things this plugin owns inside a child list: the config of the
// compaction-basic row and the enablement of the tool-result-pruner row.
// A preset row keeps its child list under `config.plugins`, so the walk
// follows that list too and the same comparison works on a whole row and on
// a bare child list.
function stripManagedFields(rows) {
  const clone = structuredClone(rows);
  const visit = list => {
    if (!Array.isArray(list)) return;
    for (const row of list) {
      if (!isRecord(row)) continue;
      if (row.id === 'compaction-basic') {
        delete row.config;
        continue;
      }
      if (row.id === 'tool-result-pruner') {
        delete row.disabled;
        continue;
      }
      if (row.id === DELEGATION_TOOL_ID) {
        // The page owns the child default route; every other key of the row
        // (provider, toolName, modelSelection, ...) still belongs upstream.
        if (isRecord(row.config)) {
          delete row.config.agentOptions;
          if (Object.keys(row.config).length === 0) delete row.config;
        }
        continue;
      }
      if (row.group === true) {
        visit(row.config);
        continue;
      }
      if (isRecord(row.config) && Array.isArray(row.config.plugins)) visit(row.config.plugins);
    }
  };
  visit(clone);
  return clone;
}

function findRow(rows, id) {
  if (!Array.isArray(rows)) return undefined;
  for (const row of rows) {
    if (!isRecord(row)) continue;
    if (row.id === id) return row;
    if (row.group === true) {
      const nested = findRow(row.config, id);
      if (nested) return nested;
    }
    if (isRecord(row.config) && Array.isArray(row.config.plugins)) {
      const nested = findRow(row.config.plugins, id);
      if (nested) return nested;
    }
  }
  return undefined;
}

// The baseline of a preset row.
//
// A preset row in the profile replaces the whole `config` of the preset it
// names, so a profile that carries one has to restate the whole child list.
// The baseline of that restatement is the bundle declaration behind the row,
// never the effective declaration: the effective one already carries the
// profile's own row, so reading it back freezes the copy and an upstream
// rename is never absorbed.
//
// The customisations the profile owner wants to keep are declared in this
// plugin's own profile row, so a preset row stays a pure derivative of the
// upstream declaration plus the declared customisations plus the two fields
// this plugin manages.

// The declared customisations of one preset, read from this plugin's row.
function presetOverrides(docs, presetId) {
  const row = (docs || []).find(entry => entry && entry.id === PLUGIN_ROW_ID);
  const all = row?.config?.presetOverrides;
  if (all === undefined) return [];
  if (!isRecord(all)) {
    fail(`${PLUGIN_ROW_ID} 的 config.presetOverrides 必须是对象`, {
      code: 'compaction-targets/preset-overrides',
    });
  }
  const list = all[presetId];
  if (list === undefined) return [];
  if (!Array.isArray(list)) {
    fail(`${PLUGIN_ROW_ID} 的 config.presetOverrides.${presetId} 必须是数组`, {
      code: 'compaction-targets/preset-overrides',
      preset: presetId,
    });
  }
  return list;
}

// Apply the declared customisations to an upstream child list.
function applyPresetOverrides(plugins, overrides, presetId) {
  const rows = structuredClone(plugins);
  for (const [index, override] of overrides.entries()) {
    if (!isRecord(override)) {
      fail(`预设 ${presetId} 的覆盖项 ${index} 不是对象`, {
        code: 'compaction-targets/preset-overrides',
        preset: presetId,
        index,
      });
    }
    const id = typeof override.id === 'string' ? override.id.trim() : '';
    if (!id) {
      fail(`预设 ${presetId} 的覆盖项 ${index} 缺少 id`, {
        code: 'compaction-targets/preset-overrides',
        preset: presetId,
        index,
      });
    }
    const target = findRow(rows, id);
    if (!target) {
      rows.push({
        id,
        ...(override.name === undefined ? {} : { name: override.name }),
        ...(override.config === undefined ? {} : { config: structuredClone(override.config) }),
        ...(override.disabled === undefined ? {} : { disabled: override.disabled }),
      });
      continue;
    }
    if (override.name !== undefined) target.name = override.name;
    if (override.disabled !== undefined) target.disabled = override.disabled;
    if (override.config !== undefined) {
      if (!isRecord(override.config)) {
        fail(`预设 ${presetId} 的覆盖项 ${id} 的 config 必须是对象`, {
          code: 'compaction-targets/preset-overrides',
          preset: presetId,
          index,
        });
      }
      target.config = {
        ...(isRecord(target.config) ? target.config : {}),
        ...structuredClone(override.config),
      };
    }
  }
  return rows;
}

// The upstream declaration of a preset with the declared customisations
// applied. `null` when the Host does not expose a declaration.
function presetBaseline(source, overrides) {
  const upstream = source?.upstream;
  if (!isRecord(upstream) || !Array.isArray(upstream.plugins)) return null;
  const name = upstream.name ?? source.name;
  const description = upstream.description ?? source.description;
  return {
    id: typeof upstream.id === 'string' ? upstream.id : source.id,
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(upstream.order === undefined ? {} : { order: upstream.order }),
    plugins: applyPresetOverrides(upstream.plugins, overrides, source.id),
  };
}

// The differences between the profile's own preset row and the declaration it
// should be derived from. A difference the profile holds and the upstream
// does not is a customisation a rewrite would drop, so it has to be declared
// in this plugin's row before the row may be rewritten. A difference the
// upstream holds and the profile does not is an outdated copy: the rewrite
// restores it and nothing is lost.
function presetDrift(current, baseline) {
  const drift = [];
  const sameValue = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
  const visit = (currentRows, baselineRows, prefix) => {
    const baselineById = new Map();
    for (const row of baselineRows || []) {
      if (isRecord(row)) baselineById.set(row.id, row);
    }
    for (const row of currentRows || []) {
      if (!isRecord(row)) continue;
      const label = prefix ? `${prefix}.${row.id}` : String(row.id);
      const other = baselineById.get(row.id);
      if (!other) {
        drift.push({ path: label, kind: 'extra-row' });
        continue;
      }
      for (const key of Object.keys(row)) {
        if (key === 'config') continue;
        if (row.id === 'tool-result-pruner' && key === 'disabled') continue;
        if (!(key in other)) {
          drift.push({ path: `${label}.${key}`, kind: 'extra' });
          continue;
        }
        if (!sameValue(row[key], other[key])) {
          drift.push({ path: `${label}.${key}`, kind: 'changed' });
        }
      }
      if (row.id === 'compaction-basic') continue;
      if (row.group === true) {
        if (Array.isArray(row.config) && Array.isArray(other.config)) {
          visit(row.config, other.config, label);
        } else if (!sameValue(row.config, other.config)) {
          drift.push({ path: `${label}.config`, kind: 'changed' });
        }
        continue;
      }
      const currentConfig = isRecord(row.config) ? row.config : {};
      const baselineConfig = isRecord(other.config) ? other.config : {};
      for (const key of Object.keys(currentConfig)) {
        // The page owns the delegation tool's default route, so a value here
        // that the declaration does not name is not a dropped customisation.
        if (row.id === DELEGATION_TOOL_ID && key === 'agentOptions') continue;
        if (!(key in baselineConfig)) {
          drift.push({ path: `${label}.config.${key}`, kind: 'extra' });
          continue;
        }
        if (!sameValue(currentConfig[key], baselineConfig[key])) {
          drift.push({ path: `${label}.config.${key}`, kind: 'changed' });
        }
      }
    }
  };
  visit(current, baseline, '');
  return drift;
}

// The profile's own row for a preset, as text.
function currentPresetRow(text, presetId) {
  const range = findPresetRowRange(text, presetId);
  if (!range) return null;
  const lines = String(text).split('\n').slice(range.start, range.end);
  return { range, text: lines.join('\n') };
}

// The child list of the profile's own row for a preset.
function currentPresetPlugins(text, presetId) {
  const row = currentPresetRow(text, presetId);
  if (!row) return null;
  const entry = parseDocuments(row.text)[0];
  if (!isRecord(entry?.config) || !Array.isArray(entry.config.plugins)) return null;
  return entry.config.plugins;
}

// The effective row for a preset across both layers: the home layer is applied
// last and wins over the profile layer, so a row in the home file shadows the
// same row in the profile file.
function effectivePresetRow(profileText, homeText, presetId) {
  return currentPresetRow(homeText, presetId) ?? currentPresetRow(profileText, presetId);
}

function effectivePresetPlugins(profileText, homeText, presetId) {
  const row = effectivePresetRow(profileText, homeText, presetId);
  if (!row) return null;
  const entry = parseDocuments(row.text)[0];
  if (!isRecord(entry?.config) || !Array.isArray(entry.config.plugins)) return null;
  return entry.config.plugins;
}

// The Host-level row that authorizes explicit child LLM routes. It belongs to
// the hand written layer; the home layer wins when both declare it.
const MODEL_SELECTION_ROW_ID = 'subagent-model-selection-settings';

// Find one row in a child list, descending into the nested lists of groups.
function findNestedRow(rows, id) {
  if (!Array.isArray(rows)) return undefined;
  for (const row of rows) {
    if (!isRecord(row)) continue;
    if (row.id === id) return row;
    const nested = findNestedRow(row.config, id);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

// The authorization a fresh top-level Session records for explicit selection.
function readModelSelectionPolicy(profileDocs, homeDocs) {
  const row = homeDocs.find(candidate => candidate && candidate.id === MODEL_SELECTION_ROW_ID)
    ?? profileDocs.find(candidate => candidate && candidate.id === MODEL_SELECTION_ROW_ID);
  const config = isRecord(row?.config) ? row.config : {};
  const allowedModels = Array.isArray(config.allowedModels)
    ? config.allowedModels
      .filter(route => isRecord(route) && typeof route.provider === 'string' && typeof route.model === 'string')
      .map(route => ({ provider: route.provider, model: route.model }))
    : [];
  return {
    declared: row !== undefined,
    enabled: config.enabled === true,
    allowedModels,
  };
}

// One delegation tool instance, read from a preset's child list.
function readDelegationTool(plugins, id) {
  const row = findNestedRow(plugins, id);
  if (!isRecord(row)) return undefined;
  const config = isRecord(row.config) ? row.config : {};
  const options = isRecord(config.agentOptions) ? config.agentOptions : undefined;
  return {
    id,
    ...(typeof config.toolName === 'string' ? { toolName: config.toolName } : {}),
    disabled: row.disabled === true,
    modelSelection: config.modelSelection === true,
    modelDiscovery: config.modelDiscovery === true,
    ...(options === undefined ? {} : {
      agentOptions: {
        ...(typeof options.provider === 'string' ? { provider: options.provider } : {}),
        ...(typeof options.model === 'string' ? { model: options.model } : {}),
        ...(typeof options.reasoningEffort === 'string' ? { reasoningEffort: options.reasoningEffort } : {}),
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// Child default route: tool-subagent.config.agentOptions
//
// The default route belongs to the generated preset row, next to the
// compaction values: the page owns it, the hand written profile file is never
// written. Only these three keys are the page's: any other key the row already
// carries (for example maxTokens) is preserved.
// ---------------------------------------------------------------------------
const DELEGATION_TOOL_ID = 'tool-subagent';

// The page's view of a route: provider and model, plus the effort when the
// row names one. A row without provider/model has no route at all.
function routeOf(options) {
  if (!isRecord(options)) return undefined;
  const provider = typeof options.provider === 'string' && options.provider.trim()
    ? options.provider.trim()
    : undefined;
  const model = typeof options.model === 'string' && options.model.trim()
    ? options.model.trim()
    : undefined;
  if (provider === undefined || model === undefined) return undefined;
  return {
    provider,
    model,
    ...(typeof options.reasoningEffort === 'string' && options.reasoningEffort.trim()
      ? { reasoningEffort: options.reasoningEffort.trim() }
      : {}),
  };
}

function rawAgentOptions(row) {
  return isRecord(row?.config) && isRecord(row.config.agentOptions)
    ? row.config.agentOptions
    : undefined;
}

function routeOfPlugins(plugins) {
  return routeOf(rawAgentOptions(findNestedRow(plugins, DELEGATION_TOOL_ID)));
}

// The edit one generated row needs for a requested route: `undefined` leaves
// the block alone, `null` removes it (inherit the parent route), an object is
// written as the whole block. The merge keeps keys the page does not manage.
function planRouteEdit(plugins, request) {
  if (request === undefined) return undefined;
  const raw = rawAgentOptions(findNestedRow(plugins, DELEGATION_TOOL_ID));
  const existing = routeOf(raw);
  if (request === null) return raw === undefined ? undefined : null;
  const unchanged = existing !== undefined
    && existing.provider === request.provider
    && existing.model === request.model
    && existing.reasoningEffort === request.reasoningEffort;
  if (unchanged) return undefined;
  const merged = { ...(raw ?? {}), provider: request.provider, model: request.model };
  if (request.reasoningEffort === undefined) delete merged.reasoningEffort;
  else merged.reasoningEffort = request.reasoningEffort;
  return merged;
}


// How the two blocks that govern child model selection are configured now.
// The tool flags stay read only here; the default route is shown so the page
// can edit it, and the authorization row belongs to the hand written file.
function modelSelectionReport(policy, presets) {
  const checks = [];
  if (!policy.declared) checks.push({ level: 'warn', code: 'policy-missing' });
  else if (!policy.enabled) checks.push({ level: 'warn', code: 'policy-disabled' });
  for (const preset of presets) {
    if (!preset.tool) {
      checks.push({ level: 'info', code: 'preset-no-delegation-tool', preset: preset.id });
      continue;
    }
    if (!preset.tool.modelSelection) {
      checks.push({ level: 'warn', code: 'preset-model-selection-off', preset: preset.id });
    }
    if (!preset.tool.modelDiscovery) {
      checks.push({ level: 'info', code: 'preset-model-discovery-off', preset: preset.id });
    }
    const options = preset.tool.agentOptions;
    if (policy.enabled && options?.provider && options?.model) {
      const allowed = policy.allowedModels.some(route => route.provider === options.provider && route.model === options.model);
      if (!allowed) {
        checks.push({
          level: 'info',
          code: 'default-route-not-allowed',
          preset: preset.id,
          route: `${options.provider}/${options.model}`,
        });
      }
    }
  }
  return { policy, presets, checks };
}

// Whether two child lists agree outside the two fields this plugin manages.
function sameExceptManagedFields(current, baseline) {
  return JSON.stringify(canonical(stripManagedFields(current)))
    === JSON.stringify(canonical(stripManagedFields(baseline)));
}

// Replace the profile's own row for a preset, keeping its place in the file.
function replacePresetRow(text, presetId, rowText) {
  const range = findPresetRowRange(text, presetId);
  if (!range) return null;
  const lines = String(text).split('\n');
  return [
    ...lines.slice(0, range.start),
    ...String(rowText).split('\n'),
    ...lines.slice(range.end),
  ].join('\n');
}

// A rewritten child list must differ from the source declaration in the two
// managed fields only. A text edit that drops, moves or renames any other
// field would write a preset the Host refuses to mount, so the rewrite is
// compared against its source before anything is written.
function assertOnlyManagedFieldsChanged(sourceText, modifiedText, presetId) {
  const label = `预设 ${presetId} 的插件行`;
  const before = stripManagedFields(parseEntryList(sourceText, label));
  const after = stripManagedFields(parseEntryList(modifiedText, label));
  const beforeRow = findRow(before, 'compaction-basic');
  const afterRow = findRow(after, 'compaction-basic');
  // The plugin restores the row's plugin name when the source lost it, so the
  // name is compared instead of ignored.
  if (beforeRow && afterRow && beforeRow.name === undefined && afterRow.name !== undefined) {
    beforeRow.name = afterRow.name;
  }
  if (JSON.stringify(canonical(before)) !== JSON.stringify(canonical(after))) {
    fail(`预设 ${presetId} 的覆盖改动了 compaction-basic 与 tool-result-pruner 之外的插件字段，拒绝写入`, {
      code: 'compaction-targets/preset-fields-changed',
      preset: presetId,
    });
  }
}

// Build the profile's own row for a preset from the upstream declaration.
// The row carries no `name:` of its own: the name belongs to the bundle
// declaration, and a copy of it in the profile would shadow the bundle when
// the plugin behind the preset is renamed.
function buildPresetRow(source, config, newline, options = {}) {
  const baseline = options.baseline;
  if (typeof baseline !== 'string' || !baseline.trim()) {
    fail(`缺少预设 ${source?.id || ''} 的上游声明，无法生成覆盖`, {
      code: 'compaction-targets/preset-source',
    });
  }
  const plugins = modifyPresetContent(baseline, config, newline, options);
  assertOnlyManagedFieldsChanged(baseline, plugins, source.id);
  const meta = isRecord(options.meta) ? options.meta : {};
  const lines = [
    `- id: preset-${source.id}`,
    '  config:',
    `    id: ${JSON.stringify(meta.id ?? source.id)}`,
  ];
  if (meta.name) lines.push(`    name: ${JSON.stringify(meta.name)}`);
  if (meta.description) lines.push(`    description: ${JSON.stringify(meta.description)}`);
  if (Number.isFinite(Number(meta.order))) lines.push(`    order: ${Number(meta.order)}`);
  lines.push('    plugins:');
  lines.push(indent(plugins, 6));
  return lines.join(newline);
}

function removePresetRow(text, presetId) {
  const range = findPresetRowRange(text, presetId);
  if (!range) return text;
  const lines = String(text).split('\n');
  return [...lines.slice(0, range.start), ...lines.slice(range.end)].join('\n');
}

function appendPresetRow(text, row, newline) {
  const base = String(text).endsWith(newline) ? String(text) : `${text}${newline}`;
  return `${base}${row}${newline}`;
}

function selectedPresetIds(body, options) {
  const sources = Array.isArray(options.presets) ? options.presets : [];
  const known = new Set(sources.map(preset => preset.id).filter(Boolean));
  const requested = Array.isArray(body.presets) && body.presets.length > 0
    ? body.presets
    : (known.size > 0 ? [...known] : ['standard']);
  const selected = [];
  for (const raw of requested) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!id) fail('presets 中的预设 id 不能为空');
    if (known.size > 0 && !known.has(id)) fail(`未知 Agent 预设：${id}`);
    if (known.size === 0 && id !== 'standard') {
      fail(`当前 Host 无法读取预设 ${id}；只支持 standard`, { preset: id });
    }
    if (!selected.includes(id)) selected.push(id);
  }
  if (selected.length === 0) fail('至少选择一个 Agent 预设');
  return selected;
}

// The child default route the page asked for, per preset. A route may name a
// model the current llm-pi-ai table does not declare, or an effort the model
// does not offer: that is only allowed while the row already carries exactly
// that route, so an existing file stays saveable but a new mistake is refused.
function normalizeSubagentRoutes(body, plans, snapshot) {
  const routes = new Map();
  const changed = new Set();
  const notes = [];
  const requested = body?.subagentRoutes;
  if (requested === undefined) return { routes, changed, notes };
  if (!isRecord(requested)) fail('subagentRoutes 必须是对象', { code: 'compaction-targets/route-shape' });
  const byId = new Map(plans.map(plan => [plan.presetId, plan]));
  const modelByKey = new Map(snapshot.models.map(model => [policyKey(model.provider, model.model), model]));
  for (const [presetId, value] of Object.entries(requested)) {
    const plan = byId.get(presetId);
    if (!plan) {
      fail(`subagentRoutes 里的预设 ${presetId} 不在本次保存范围内`, {
        code: 'compaction-targets/route-preset',
        preset: presetId,
      });
    }
    const plugins = plan.current ?? plan.baseline?.plugins ?? [];
    const tool = findNestedRow(plugins, DELEGATION_TOOL_ID);
    const existing = routeOf(rawAgentOptions(tool));
    if (tool === undefined) {
      if (value === null || value === undefined) continue;
      fail(`预设 ${presetId} 没有 ${DELEGATION_TOOL_ID} 行，无法设置子代理默认路由`, {
        code: 'compaction-targets/no-delegation-tool',
        preset: presetId,
      });
    }
    if (value === null || value === undefined) {
      if (existing === undefined) continue;
      routes.set(presetId, null);
      changed.add(presetId);
      continue;
    }
    if (!isRecord(value)) {
      fail(`subagentRoutes.${presetId} 必须是对象或 null`, {
        code: 'compaction-targets/route-shape',
        preset: presetId,
      });
    }
    const provider = typeof value.provider === 'string' ? value.provider.trim() : '';
    const model = typeof value.model === 'string' ? value.model.trim() : '';
    if (!provider || !model) {
      fail(`subagentRoutes.${presetId} 必须同时给出 provider 与 model`, {
        code: 'compaction-targets/route-shape',
        preset: presetId,
      });
    }
    let reasoningEffort;
    if (value.reasoningEffort !== undefined && value.reasoningEffort !== null) {
      reasoningEffort = typeof value.reasoningEffort === 'string' ? value.reasoningEffort.trim() : '';
      if (!reasoningEffort) {
        fail(`subagentRoutes.${presetId}.reasoningEffort 必须是非空字符串`, {
          code: 'compaction-targets/route-shape',
          preset: presetId,
        });
      }
    }
    const route = { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) };
    const unchanged = existing !== undefined
      && existing.provider === provider
      && existing.model === model
      && existing.reasoningEffort === reasoningEffort;
    const key = policyKey(provider, model);
    const modelInfo = modelByKey.get(key);
    if (modelInfo === undefined) {
      if (!unchanged) {
        fail(`默认路由 ${key} 不在 llm-pi-ai 的模型清单中`, {
          code: 'compaction-targets/route-unknown',
          preset: presetId,
          route: key,
        });
      }
      notes.push(`预设 ${presetId}: 默认路由 ${key} 不在 llm-pi-ai 的模型清单中，按原样保留。`);
    } else if (reasoningEffort !== undefined && !modelInfo.efforts.includes(reasoningEffort)) {
      if (!unchanged) {
        fail(`模型 ${key} 没有声明 reasoningEffort ${reasoningEffort}`
          + (modelInfo.efforts.length > 0
            ? `（可选：${modelInfo.efforts.join('、')}）`
            : '（该模型没有声明 reasoningEfforts，只能不指定 effort）'), {
          code: 'compaction-targets/route-effort',
          preset: presetId,
          model: key,
          effort: reasoningEffort,
          efforts: modelInfo.efforts,
        });
      }
      notes.push(`预设 ${presetId}: 模型 ${key} 没有声明 reasoningEffort ${reasoningEffort}，按原样保留。`);
    }
    routes.set(presetId, route);
    if (!unchanged) changed.add(presetId);
  }
  return { routes, changed, notes };
}

function presetConfig(docs, presetId) {
  const entry = docs.find(row => row && row.id === `preset-${presetId}`);
  if (!entry) fail(`patch 中缺少 preset-${presetId} 覆盖`);
  const plugins = entry.config?.plugins;
  if (!Array.isArray(plugins)) fail(`preset-${presetId} 缺少 config.plugins`);
  const group = plugins.find(row => row && row.id === 'compaction');
  if (!group) fail(`preset-${presetId} 缺少 compaction 组`);
  if (!Array.isArray(group.config)) fail(`preset-${presetId} 的 compaction 组缺少 config`);
  const basic = group.config.find(row => row && row.id === 'compaction-basic');
  if (!basic || !isRecord(basic.config)) fail(`preset-${presetId} 缺少 compaction-basic.config`);
  const pruner = group.config.find(row => row && row.id === 'tool-result-pruner');
  return { basic: basic.config, pruner };
}

function routeLabel(route) {
  if (route === null) return '继承父会话路由';
  return `${route.provider}/${route.model}`
    + (route.reasoningEffort === undefined ? '' : `（reasoningEffort: ${route.reasoningEffort}）`);
}

// The default route a save asked for is the route the generated row must
// carry. Only the three fields the page owns are compared; a key such as
// maxTokens stays with whoever put it there.
function verifyPresetRoute(docs, presetId, route) {
  const entry = docs.find(row => row && row.id === `preset-${presetId}`);
  const tool = entry ? findNestedRow(entry.config?.plugins, DELEGATION_TOOL_ID) : undefined;
  const actual = routeOf(rawAgentOptions(tool));
  if (route === null) {
    if (actual === undefined) return;
    fail(`preset-${presetId}: 子代理默认路由应为继承父会话路由，回读为 ${routeLabel(actual)}`, {
      code: 'compaction-targets/route-readback',
      preset: presetId,
      actual,
    });
  }
  if (actual === undefined
    || actual.provider !== route.provider
    || actual.model !== route.model
    || actual.reasoningEffort !== route.reasoningEffort) {
    fail(`preset-${presetId}: 子代理默认路由回读为 ${actual === undefined ? '继承父会话路由' : routeLabel(actual)}，期望 ${routeLabel(route)}`, {
      code: 'compaction-targets/route-readback',
      preset: presetId,
      expected: route,
      actual,
    });
  }
}

function verifyPresetConfigs(docs, selected, normalized, snapshot, routes) {
  const modelByKey = new Map(snapshot.models.map(model => [policyKey(model.provider, model.model), model]));
  for (const presetId of selected) {
    if (routes?.has(presetId)) verifyPresetRoute(docs, presetId, routes.get(presetId));
    const { basic, pruner } = presetConfig(docs, presetId);
    if (pruner && pruner.disabled !== true) {
      fail(`preset-${presetId}: tool-result-pruner 未关闭`, {
        code: 'compaction-targets/pruner-enabled',
        preset: presetId,
      });
    }
    const policies = parsePolicies(basic, `preset-${presetId}.compaction-basic.modelPolicies`);
    const policyByKey = new Map(policies.map(policy => [policyKey(policy.provider, policy.model), policy]));
    for (const row of normalized.rows) {
      if (!row.enabled) continue;
      const model = modelByKey.get(policyKey(row.provider, row.model));
      const policy = policyByKey.get(policyKey(row.provider, row.model));
      if (!policy) fail(`preset-${presetId}: ${row.provider}/${row.model} 缺少 policy`, {
        code: 'compaction-targets/readback-mismatch',
        preset: presetId,
      });
      const pressure = model.window - model.actualReserve - normalized.headroomTokens;
      const actual = effectivePoint(policy.thresholdRatio, model.window, pressure);
      if (actual !== row.compactAtTokens) {
        fail(`preset-${presetId}: ${row.provider}/${row.model} 实际落点 ${actual}，目标 ${row.compactAtTokens}`, {
          code: 'compaction-targets/readback-mismatch',
          preset: presetId,
          target: row.compactAtTokens,
          actual,
        });
      }
      if (normalized.summarizerUnlimited && policy.maxTokens !== model.actualReserve) {
        fail(`preset-${presetId}: ${row.provider}/${row.model} 的压缩输出上限回读为 ${policy.maxTokens}，应为模型自身 ${model.actualReserve}`, {
          code: 'compaction-targets/readback-mismatch',
          preset: presetId,
          actual: policy.maxTokens,
          expected: model.actualReserve,
        });
      }
    }
    if (basic.retainTokens !== normalized.retainTokens
      || basic.headroomTokens !== normalized.headroomTokens
      || basic.maxTokens !== normalized.summarizerMaxTokens) {
      fail(`preset-${presetId}: 全局值回读不一致`, {
        code: 'compaction-targets/readback-mismatch',
        preset: presetId,
      });
    }
  }
}

// A top-level patch row does not have to carry an `id`: the Loader dialect also
// accepts `- insert:` rows whose real ids live inside `insert`. Matching those
// rows by id compares every id-less row against the *first* id-less row, so a
// patch with two `insert:` rows reports an untouched file as changed. Id-less
// rows are therefore matched by their position among the other id-less rows,
// and rows that do carry an id keep being matched by that id.
function rowId(row) {
  const id = typeof row?.id === 'string' ? row.id.trim() : '';
  return id;
}

function indexRows(rows) {
  const index = new Map();
  let anonymous = 0;
  for (const row of rows) {
    const id = rowId(row);
    const key = id ? `id:${id}` : `anonymous:${anonymous}`;
    if (!id) anonymous += 1;
    const bucket = index.get(key);
    if (bucket) bucket.push(row);
    else index.set(key, [row]);
  }
  return index;
}

function rowLabel(key) {
  return key.startsWith('id:') ? key.slice(3) : '(unknown)';
}

function assertNonselectedRowsUnchanged(originalDocs, candidateDocs, selected, baselines) {
  const selectedIds = new Set(selected.map(id => `preset-${id}`));
  const isSelected = row => selectedIds.has(rowId(row));
  const originalIndex = indexRows(originalDocs.filter(row => !isSelected(row)));
  const candidateIndex = indexRows(candidateDocs.filter(row => !isSelected(row)));

  for (const [key, originals] of originalIndex) {
    const candidates = candidateIndex.get(key) || [];
    if (candidates.length !== originals.length) {
      fail(`patch 中非目标预设 ${rowLabel(key)} 消失了`, {
        code: 'compaction-targets/outside-structure-changed',
        key,
      });
    }
    for (const [index, original] of originals.entries()) {
      if (JSON.stringify(canonical(candidates[index])) !== JSON.stringify(canonical(original))) {
        fail(`patch 中非目标预设 ${rowLabel(key)} 发生了变化`, {
          code: 'compaction-targets/outside-structure-changed',
          key,
        });
      }
    }
  }
  for (const key of candidateIndex.keys()) {
    if (originalIndex.has(key)) continue;
    fail(`patch 中出现了新的非目标条目 ${rowLabel(key)}`, {
      code: 'compaction-targets/outside-structure-changed',
      key,
    });
  }

  // A selected preset is rewritten from the upstream declaration, so its
  // content outside the compaction group may change - but only into that
  // declaration plus the two managed fields. A preset without an upstream
  // declaration keeps its own content and only the compaction group changes.
  const selectedDocs = new Map(
    originalDocs.filter(row => isSelected(row)).map(row => [row.id, row]),
  );
  for (const [id, original] of selectedDocs) {
    const candidate = candidateDocs.find(item => item?.id === id);
    if (!candidate) fail(`preset ${id} 在写入后消失`);
    const baseline = baselines?.get(id.replace(/^preset-/, ''));
    // Without an upstream declaration the row keeps its own content; the
    // compaction group and the default route this save may have changed are
    // the managed parts, and the delegation tool sits inside a group.
    const stripPlugins = list => list
      .filter(plugin => plugin?.id !== 'compaction')
      .map(plugin => {
        if (!isRecord(plugin)) return plugin;
        if (plugin.group === true && Array.isArray(plugin.config)) {
          plugin.config = stripPlugins(plugin.config);
          return plugin;
        }
        if (plugin.id === DELEGATION_TOOL_ID && isRecord(plugin.config)) {
          delete plugin.config.agentOptions;
          if (Object.keys(plugin.config).length === 0) delete plugin.config;
        }
        return plugin;
      });
    const strip = row => {
      const plugins = row?.config?.plugins;
      if (Array.isArray(plugins)) row.config.plugins = stripPlugins(plugins);
      return row;
    };
    if (baseline) {
      const meta = config => {
        const copy = structuredClone(config ?? {});
        delete copy.plugins;
        return canonical(copy);
      };
      const before = stripManagedFields(structuredClone(baseline.plugins));
      const after = stripManagedFields(structuredClone(candidate.config?.plugins ?? []));
      if (JSON.stringify(canonical(before)) !== JSON.stringify(canonical(after))
        || JSON.stringify(meta(baseline)) !== JSON.stringify(meta(candidate.config))) {
        fail(`preset ${id} 与上游声明不一致，拒绝写入`, {
          code: 'compaction-targets/outside-structure-changed',
        });
      }
      continue;
    }
    const before = structuredClone(original);
    const after = structuredClone(candidate);
    if (JSON.stringify(canonical(strip(before))) !== JSON.stringify(canonical(strip(after)))) {
      fail(`preset ${id} 的 compaction 之外内容发生了变化`, {
        code: 'compaction-targets/outside-structure-changed',
      });
    }
  }
}

function publicSnapshot(snapshot, presetSources = [], profileText = '', homeText = '') {
  const sources = (presetSources.length > 0 ? presetSources : [{
    id: 'standard',
    name: 'Standard',
    isDefault: true,
  }]).filter(preset => preset && preset.id);
  // One record per preset: the row that is effective now, the declaration it
  // is rebuilt from, and the difference between the two. Both the compaction
  // overview and the child-model report read the same record, so the page
  // cannot show one preset twice with two different answers.
  const records = sources.map(preset => {
    const baseline = presetBaseline(preset, presetOverrides(snapshot.docs, preset.id));
    const current = effectivePresetPlugins(profileText, homeText, preset.id);
    const drift = baseline && current ? presetDrift(current, baseline.plugins) : [];
    // A preset without a row yet is shown from the declaration the first save
    // would generate, so its tool and route are visible before that save.
    const plugins = current ?? baseline?.plugins;
    return {
      preset,
      baseline,
      current,
      drift,
      plugins,
      route: plugins ? routeOfPlugins(plugins) : undefined,
      declaredRoute: baseline?.plugins ? routeOfPlugins(baseline.plugins) : undefined,
    };
  });
  const presets = records.map(({ preset, baseline, current, drift }) => ({
    id: preset.id,
    ...(preset.name ? { name: preset.name } : {}),
    ...(preset.description ? { description: preset.description } : {}),
    ...(preset.order === undefined ? {} : { order: preset.order }),
    isDefault: preset.isDefault === true,
    ...(preset.broken ? { broken: preset.broken } : {}),
    hasOverride: Boolean(effectivePresetRow(profileText, homeText, preset.id)),
    // The upstream declaration the profile row is derived from, and the
    // differences between the two. An empty drift with an upstream means the
    // row is the upstream declaration; a drift means the profile holds
    // customisations the upstream does not, and a rewrite would drop them.
    upstream: Boolean(baseline),
    drift,
    inSync: baseline
      ? Boolean(current) && sameExceptManagedFields(current, baseline.plugins)
      : true,
  }));
  return {
    patchPath: snapshot.paths.patchPath,
    profilePatchPath: snapshot.paths.profilePatchPath,
    backupBase: snapshot.paths.backupBase,
    snapshotPath: snapshot.paths.snapshotPath,
    fallbackRatio: snapshot.global.fallbackRatio,
    presets,
    modelSelection: modelSelectionReport(
      readModelSelectionPolicy(snapshot.docs, snapshot.homeDocs),
      records.map(record => ({
        id: record.preset.id,
        tool: record.plugins ? readDelegationTool(record.plugins, 'tool-subagent') : undefined,
        forkTool: record.plugins ? readDelegationTool(record.plugins, 'tool-subagent-fork') : undefined,
        // Where the shown tool comes from: the generated row, or the
        // declaration the next save would write when there is no row yet.
        source: record.current ? 'row' : (record.baseline ? 'upstream' : undefined),
        route: record.route,
        // What the profile's own presetOverrides still declares. It is the
        // baseline of a rewrite, so an edit on this page wins over it.
        ...(record.declaredRoute === undefined ? {} : { declaredRoute: record.declaredRoute }),
      })),
    ),
    profilePresets: profilePresetIds(homeText).length > 0
      ? profilePresetIds(homeText)
      : profilePresetIds(profileText),
    global: {
      retainTokens: snapshot.global.retainTokens,
      headroomTokens: snapshot.global.headroomTokens,
      summarizerMaxTokens: snapshot.global.summarizerMaxTokens,
      summarizerUnlimited: snapshot.global.summarizerUnlimited,
    },
    models: snapshot.models.map(model => ({
      provider: model.provider,
      model: model.model,
      name: model.name,
      window: model.window,
      actualReserve: model.actualReserve,
      reserveTokens: model.actualReserve,
      reserveSource: model.reserveSource,
      enabled: model.enabled,
      compactAtTokens: model.compactAtTokens,
      thresholdRatio: model.thresholdRatio,
      efforts: model.efforts,
    })),
  };
}

function normalizeRequest(body, snapshot) {
  if (!isRecord(body)) fail('SAVE 请求体必须是 JSON 对象');
  if (!Array.isArray(body.models)) fail('SAVE 请求体缺少 models 数组');
  const modelKeys = new Set(snapshot.models.map(model => policyKey(model.provider, model.model)));
  const rowsByKey = new Map();
  for (const [index, row] of body.models.entries()) {
    if (!isRecord(row)) fail(`models[${index}] 不是对象`);
    const provider = typeof row.provider === 'string' ? row.provider.trim() : '';
    const model = typeof row.model === 'string' ? row.model.trim() : '';
    const key = policyKey(provider, model);
    if (!modelKeys.has(key)) {
      fail(`models[${index}] 不在当前 llm-pi-ai 的模型清单中：${key}`);
    }
    if (rowsByKey.has(key)) fail(`models[${index}] 重复：${key}`);
    if (typeof row.enabled !== 'boolean') fail(`models[${index}] 的 enabled 必须是布尔值`);
    rowsByKey.set(key, {
      provider,
      model,
      enabled: row.enabled,
      compactAtTokens: row.compactAtTokens,
      reserveTokens: row.reserveTokens,
    });
  }

  const headroomTokens = body.headroomTokens === undefined
    ? snapshot.global.headroomTokens
    : integer(body.headroomTokens, 'headroomTokens', 0);
  const retainTokens = body.retainTokens === undefined
    ? snapshot.global.retainTokens
    : integer(body.retainTokens, 'retainTokens', 1);
  const summarizerUnlimited = body.summarizerMaxTokens === 'model' || body.summarizerUnlimited === true;
  const requestedSummarizerMaxTokens = body.summarizerMaxTokens === undefined
    ? snapshot.global.summarizerMaxTokens
    : summarizerUnlimited
      ? undefined
      : integer(body.summarizerMaxTokens, 'summarizerMaxTokens', 1);

  const rows = [];
  const reserveNotes = [];
  for (const model of snapshot.models) {
    const key = policyKey(model.provider, model.model);
    const input = rowsByKey.get(key) || {
      enabled: model.enabled,
      compactAtTokens: model.compactAtTokens,
      reserveTokens: model.actualReserve,
    };
    const reserveTokens = input.reserveTokens === undefined
      ? model.actualReserve
      : integer(input.reserveTokens, `${key} reserveTokens`, 0);
    const actualPressure = pressureOf(model, headroomTokens);
    const requestedPressure = model.window - reserveTokens - headroomTokens;
    if (actualPressure <= 0) {
      fail(
        `${key}: window ${model.window} - actual reserve ${model.actualReserve} - headroom ${headroomTokens} = ${actualPressure}，无法压缩`,
        { model: model.model, provider: model.provider, window: model.window, reserve: model.actualReserve, headroom: headroomTokens },
      );
    }
    if (requestedPressure <= 0) {
      fail(
        `${key}: window ${model.window} - requested reserve ${reserveTokens} - headroom ${headroomTokens} = ${requestedPressure}，无法压缩`,
        { model: model.model, provider: model.provider, window: model.window, reserve: reserveTokens, headroom: headroomTokens },
      );
    }

    let target;
    if (input.enabled) {
      target = integer(input.compactAtTokens, `${key} compactAtTokens`, 1);
    } else {
      target = effectivePoint(snapshot.global.fallbackRatio, model.window, actualPressure);
    }

    if (target > actualPressure) {
      fail(
        `${key}: 压缩点 ${target} > window ${model.window} - actual reserve ${model.actualReserve} - headroom ${headroomTokens} = ${actualPressure}`,
        {
          model: model.model,
          provider: model.provider,
          window: model.window,
          reserve: model.actualReserve,
          requestedReserve: reserveTokens,
          headroom: headroomTokens,
          target,
          actualPressure,
          requestedPressure,
        },
      );
    }
    if (target > requestedPressure) {
      fail(
        `${key}: 压缩点 ${target} > window ${model.window} - requested reserve ${reserveTokens} - headroom ${headroomTokens} = ${requestedPressure}`,
        {
          model: model.model,
          provider: model.provider,
          window: model.window,
          reserve: reserveTokens,
          actualReserve: model.actualReserve,
          headroom: headroomTokens,
          target,
          actualPressure,
          requestedPressure,
        },
      );
    }
    if (retainTokens >= target) {
      fail(
        `${key}: retainTokens ${retainTokens} >= 压缩点 ${target}（window ${model.window}, reserve ${model.actualReserve}, headroom ${headroomTokens}）`,
        {
          model: model.model,
          provider: model.provider,
          window: model.window,
          reserve: model.actualReserve,
          headroom: headroomTokens,
          retainTokens,
          target,
        },
      );
    }

    const thresholdRatio = input.enabled
      ? ratioForPoint(target, model.window, actualPressure)
      : null;
    if (reserveTokens !== model.actualReserve) {
      reserveNotes.push(
        `${key}: 预留值 ${reserveTokens} 仅用于本次校验；实际生效值来自 ${reserveSource(model)} = ${model.actualReserve}，本次不会写入该行。`,
      );
    }
    rows.push({
      provider: model.provider,
      model: model.model,
      window: model.window,
      enabled: input.enabled,
      compactAtTokens: target,
      thresholdRatio,
      reserveTokens,
      actualReserve: model.actualReserve,
      ownMaxTokens: model.actualReserve,
      reserveSource: reserveSource(model),
      retainTokens,
    });
  }

  for (const key of rowsByKey.keys()) {
    if (!modelKeys.has(key)) fail(`models 中的模型不在当前清单：${key}`);
  }

  const enabledRows = rows.filter(row => row.enabled);
  if (summarizerUnlimited && enabledRows.length === 0) {
    fail('summarizerMaxTokens = model 需要至少启用一个模型', { field: 'summarizerMaxTokens' });
  }
  // Without a cap of its own the summarizer gets the model's declared output
  // ceiling. The global value is the smallest ceiling in the whole table — not
  // just the enabled rows — so a model the page does not manage can never be
  // handed more than its own limit by the fallback.
  const capRows = rows.filter(row => Number.isInteger(row.ownMaxTokens) && row.ownMaxTokens > 0);
  if (summarizerUnlimited && capRows.length === 0) {
    fail('模型清单里没有声明 maxTokens 的模型，无法用模型自己的输出上限', { field: 'summarizerMaxTokens' });
  }
  const summarizerMaxTokens = summarizerUnlimited
    ? Math.min(...capRows.map(row => row.ownMaxTokens))
    : requestedSummarizerMaxTokens;

  return {
    rows,
    headroomTokens,
    retainTokens,
    summarizerMaxTokens,
    summarizerUnlimited,
    reserveNotes,
  };
}

// Pick a ratio whose effective floor is exactly the requested token target.
// A plain point/window value can floor one token low because of binary floating
// point; the small upward correction is checked again after rounding.
function ratioForPoint(point, window, pressure) {
  let candidate = point / window;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const landed = Math.floor(Math.min(window * candidate, pressure));
    if (landed === point) {
      for (const digits of [6, 9, 12]) {
        const rounded = Number(candidate.toFixed(digits));
        if (Number.isFinite(rounded) && Math.floor(Math.min(window * rounded, pressure)) === point) {
          return rounded;
        }
      }
      return candidate;
    }
    candidate += (point - landed) / window;
  }
  fail(`无法为 ${point} token 找到精确的 thresholdRatio（window ${window}）`, {
    point,
    window,
    pressure,
  });
}

function buildNextConfig(snapshot, normalized) {
  const policies = normalized.rows
    .filter(row => row.enabled)
    .map(row => ({
      provider: row.provider,
      model: row.model,
      thresholdRatio: row.thresholdRatio,
      ...(normalized.summarizerUnlimited ? { maxTokens: row.ownMaxTokens } : {}),
    }));
  const presentKeys = new Set(snapshot.models.map(model => policyKey(model.provider, model.model)));
  for (const policy of snapshot.unmanagedPolicies) {
    if (presentKeys.has(policyKey(policy.provider, policy.model))) continue;
    policies.push(policy);
  }
  const unknown = {};
  for (const [key, value] of Object.entries(snapshot.config)) {
    if (!KNOWN_CONFIG_KEYS.has(key)) unknown[key] = value;
  }
  return {
    thresholdRatio: snapshot.global.fallbackRatio,
    headroomTokens: normalized.headroomTokens,
    maxTokens: normalized.summarizerMaxTokens,
    retainTokens: normalized.retainTokens,
    modelPolicies: policies,
    ...unknown,
  };
}

function generateBlock(config, range, newline) {
  const body = yaml
    .dump(config, { lineWidth: -1, noRefs: true, sortKeys: false })
    .replace(/\n$/, '')
    .split('\n');
  const comments = [
    '# Managed by @local/dsh-compaction-targets from the Compaction targets page.',
    '# DSH stores ratios only; absolute token targets live in ~/.dsh/compaction-targets.json.',
  ];
  const lines = [
    `${' '.repeat(range.cfgIndent)}config:`,
    ...comments.map(comment => `${' '.repeat(range.cfgIndent + 2)}${comment}`),
    ...body.map(line => `${' '.repeat(range.cfgIndent + 2)}${line}`),
  ];
  return lines.join(newline);
}

function replaceBlock(text, range, blockText) {
  const lines = String(text).split('\n');
  const blockLines = blockText.split('\n');
  // A CRLF document keeps CRLF at the seam: the generated block carries CRLF
  // between its lines but not after the last one, and joining it to the next
  // line with a bare LF would leave one mixed ending behind.
  if (range.end < lines.length
    && lines[range.end].endsWith('\r')
    && !blockLines[blockLines.length - 1].endsWith('\r')) {
    blockLines[blockLines.length - 1] = `${blockLines[blockLines.length - 1]}\r`;
  }
  return [...lines.slice(0, range.cfgIdx), ...blockLines, ...lines.slice(range.end)].join('\n');
}

function outsideText(text, range) {
  const lines = String(text).split('\n');
  return [...lines.slice(0, range.cfgIdx), ...lines.slice(range.end)].join('\n');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value)) {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = canonical(value[key]);
    return result;
  }
  return value;
}

function stripCompactionConfig(docs) {
  const clone = globalThis.structuredClone(docs);
  const preset = clone.find(candidate => candidate && candidate.id === 'preset-standard');
  const group = preset?.config?.plugins?.find(candidate => candidate && candidate.id === 'compaction');
  const row = group?.config?.find(candidate => candidate && candidate.id === 'compaction-basic');
  if (row) row.config = { __omitted: true };
  return clone;
}

function assertOnlyBlockChanged(originalText, candidateText, originalDocs, candidateDocs) {
  const range = findBlockRange(originalText);
  const before = outsideText(originalText, range);
  const afterRange = findBlockRange(candidateText);
  const after = outsideText(candidateText, afterRange);
  if (before !== after) {
    fail('候选 patch 在 compaction-basic 配置块之外发生了文本变化，拒绝写入', {
      code: 'compaction-targets/outside-block-changed',
    });
  }
  const beforeStructure = JSON.stringify(canonical(stripCompactionConfig(originalDocs)));
  const afterStructure = JSON.stringify(canonical(stripCompactionConfig(candidateDocs)));
  if (beforeStructure !== afterStructure) {
    fail('候选 patch 在 compaction-basic 配置块之外的顶层结构发生变化，拒绝写入', {
      code: 'compaction-targets/outside-structure-changed',
    });
  }
}

function verifySnapshot(snapshot, normalized, label) {
  if (snapshot.global.summarizerUnlimited !== normalized.summarizerUnlimited) {
    fail(`${label}: 压缩输出上限的"不单独限制"模式回读为 ${snapshot.global.summarizerUnlimited}，期望 ${normalized.summarizerUnlimited}`, {
      code: 'compaction-targets/readback-mismatch',
      expected: normalized.summarizerUnlimited,
      actual: snapshot.global.summarizerUnlimited,
    });
  }
  if (snapshot.global.retainTokens !== normalized.retainTokens
    || snapshot.global.headroomTokens !== normalized.headroomTokens
    || snapshot.global.summarizerMaxTokens !== normalized.summarizerMaxTokens) {
    fail(`${label}: 全局配置回读不一致`, {
      code: 'compaction-targets/readback-mismatch',
      expected: {
        retainTokens: normalized.retainTokens,
        headroomTokens: normalized.headroomTokens,
        summarizerMaxTokens: normalized.summarizerMaxTokens,
      },
      actual: snapshot.global,
    });
  }
  const byKey = new Map(snapshot.models.map(model => [policyKey(model.provider, model.model), model]));
  for (const row of normalized.rows) {
    const key = policyKey(row.provider, row.model);
    const actual = byKey.get(key);
    if (!actual) fail(`${label}: ${key} 回读时消失`, { code: 'compaction-targets/readback-mismatch', key });
    if (actual.enabled !== row.enabled) {
      fail(`${label}: ${key} 的 policy 状态回读为 ${actual.enabled}，期望 ${row.enabled}`, {
        code: 'compaction-targets/readback-mismatch',
        key,
      });
    }
    if (actual.compactAtTokens !== row.compactAtTokens) {
      fail(`${label}: ${key} 实际落点 ${actual.compactAtTokens}，目标 ${row.compactAtTokens}`, {
        code: 'compaction-targets/readback-mismatch',
        key,
        target: row.compactAtTokens,
        actual: actual.compactAtTokens,
      });
    }
    if (actual.actualReserve !== row.actualReserve) {
      fail(`${label}: ${key} 实际 maxTokens 回读为 ${actual.actualReserve}，期望 ${row.actualReserve}`, {
        code: 'compaction-targets/readback-mismatch',
        key,
      });
    }
  }
  return true;
}

function sameSemantic(snapshot, normalized) {
  if (snapshot.global.retainTokens !== normalized.retainTokens
    || snapshot.global.headroomTokens !== normalized.headroomTokens
    || snapshot.global.summarizerMaxTokens !== normalized.summarizerMaxTokens) {
    return false;
  }
  if (snapshot.models.length !== normalized.rows.length) return false;
  const byKey = new Map(normalized.rows.map(row => [policyKey(row.provider, row.model), row]));
  for (const model of snapshot.models) {
    const row = byKey.get(policyKey(model.provider, model.model));
    if (!row) return false;
    if (row.enabled !== model.enabled) return false;
    if (row.compactAtTokens !== model.compactAtTokens) return false;
  }
  return true;
}

async function readPatch(patchPath, options = {}) {
  try {
    return await readFile(patchPath, 'utf8');
  } catch (error) {
    // The home layer is created by the first save, so a missing file is not an
    // error there.
    if (options.optional && error?.code === 'ENOENT') return '';
    fail(`读取 profile patch 失败：${patchPath}：${error instanceof Error ? error.message : String(error)}`, {
      code: 'compaction-targets/patch-read',
      patchPath,
    });
  }
}

async function writeAtomic(target, text) {
  const temp = `${target}.tmp-compaction-targets-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(temp, text, 'utf8');
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

function backupStamp(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  const day = [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('');
  const time = [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
  return `${day}-${time}`;
}

async function chooseBackupPath(base) {
  const stamp = backupStamp();
  let candidate = `${base}-${stamp}`;
  for (let index = 1; existsSync(candidate); index += 1) {
    candidate = `${base}-${stamp}-${index}`;
  }
  return candidate;
}

async function restoreOriginal(patchPath, originalText) {
  await writeAtomic(patchPath, originalText);
}

async function writeJsonSnapshot(snapshotPath, snapshot, normalized) {
  const maxWindow = Math.max(...snapshot.models.map(model => model.window));
  const fallbackCompactAtTokens = Math.floor(maxWindow * snapshot.global.fallbackRatio);
  const document = {
    _comment: 'Generated by @local/dsh-compaction-targets from the Compaction targets page. '
      + 'compactAtTokens / retainTokens are absolute tokens; DSH stores ratios in the profile patch.',
    fallbackCompactAtTokens,
    models: normalized.rows
      .filter(row => row.enabled)
      .map(row => ({
        provider: row.provider,
        model: row.model,
        compactAtTokens: row.compactAtTokens,
      })),
    retainTokens: normalized.retainTokens,
    headroomTokens: normalized.headroomTokens,
    summarizerMaxTokens: normalized.summarizerMaxTokens,
    summarizerUnlimited: normalized.summarizerUnlimited,
  };
  const text = `${JSON.stringify(document, null, 2)}\n`;
  let existing;
  try {
    existing = await readFile(snapshotPath, 'utf8');
  } catch {
    existing = null;
  }
  if (existing === text) return { updated: false, path: snapshotPath, reason: 'unchanged' };
  await writeAtomic(snapshotPath, text);
  return { updated: true, path: snapshotPath };
}

function publicApplyResult({ changed, patchPath, backupPath, snapshotPath, snapshot, normalized, actualByKey, jsonSnapshot, presets = [], drift = [], routes = new Map(), routeNotes = [] }) {
  return {
    ok: true,
    changed,
    patchPath,
    backupPath,
    snapshotPath,
    presets,
    // The customisations the rewrite dropped because the request declared them
    // disposable. Every other save refuses to write while they are undeclared.
    drift,
    // The child default route each selected preset carries after this save.
    subagentRoutes: [...routes.entries()].map(([preset, route]) => ({
      preset,
      ...(route === null ? { inherited: true } : route),
    })),
    routeNotes,
    // The home patch is watched by HMR and recomposed live, so no client
    // restart is needed. A preset revision is fixed when a session is created
    // (and a child joins its parent's exact revision), so the new values reach
    // new sessions right away; existing sessions keep the settings they
    // started with.
    restartRequired: false,
    restartNotice: '无需重启客户端，新建会话即可生效；已有会话沿用创建时的预设设置',
    global: {
      retainTokens: normalized.retainTokens,
      headroomTokens: normalized.headroomTokens,
      summarizerMaxTokens: normalized.summarizerMaxTokens,
      summarizerUnlimited: normalized.summarizerUnlimited,
    },
    models: normalized.rows.map(row => {
      const key = policyKey(row.provider, row.model);
      const actual = actualByKey.get(key);
      return {
        provider: row.provider,
        model: row.model,
        window: row.window,
        enabled: row.enabled,
        targetTokens: row.compactAtTokens,
        actualTokens: actual ? actual.compactAtTokens : row.compactAtTokens,
        thresholdRatio: row.thresholdRatio,
        reserveTokens: row.reserveTokens,
        actualReserve: row.actualReserve,
        reserveSource: row.reserveSource,
        retainTokens: row.retainTokens,
      };
    }),
    reserveNotes: normalized.reserveNotes,
    jsonSnapshot,
  };
}

function pathsFromOptions(options = {}) {
  const env = options.env || process.env;
  const envPatchPath = env.DSH_PROFILE_DIR
    ? path.join(env.DSH_PROFILE_DIR, PATCH_BASENAME)
    : undefined;
  const profilePatchPath = options.patchPath || envPatchPath;
  if (!profilePatchPath) {
    fail('无法定位 profile patch：DSH_PROFILE_DIR 未设置，且 Host 没有提供 configEditor.documentPath', {
      code: 'compaction-targets/profile',
    });
  }
  const resolvedProfilePath = path.resolve(profilePatchPath);
  const profileDir = options.profileDir || path.dirname(resolvedProfilePath);
  const dshHome = options.snapshotPath
    ? path.dirname(path.resolve(options.snapshotPath))
    : (env.DSH_HOME || path.dirname(path.dirname(profileDir)));
  // The home layer is applied after the profile layer and wins over it, so the
  // generated preset rows live there: the profile file keeps only what a person
  // wrote. Without a home path the plugin writes the profile file itself.
  const resolvedHomePath = options.homePatchPath
    ? path.resolve(options.homePatchPath)
    : resolvedProfilePath;
  return {
    profileDir,
    profilePatchPath: resolvedProfilePath,
    patchPath: resolvedHomePath,
    backupBase: `${resolvedHomePath}${BACKUP_SUFFIX}`,
    snapshotPath: options.snapshotPath
      ? path.resolve(options.snapshotPath)
      : path.join(dshHome, SNAPSHOT_BASENAME),
  };
}

/**
 * Read the current profile patch and return the editable model table.
 * This function performs no writes.
 */
export async function getSnapshot(options = {}) {
  const paths = pathsFromOptions(options);
  const profileText = await readPatch(paths.profilePatchPath);
  const homeText = await readPatch(paths.patchPath, { optional: true });
  const snapshot = buildSnapshot(profileText, homeText, paths);
  return publicSnapshot(snapshot, options.presets, profileText, homeText);
}

/**
 * Validate and persist one SAVE request. No caller outside this function writes
 * the profile patch or the JSON snapshot.
 */
export async function applyTargets(body, options = {}) {
  const paths = pathsFromOptions(options);
  const profileText = await readPatch(paths.profilePatchPath);
  const originalText = await readPatch(paths.patchPath, { optional: true });
  const snapshot = buildSnapshot(profileText, originalText, paths);
  const normalized = normalizeRequest(body, snapshot);
  const actualByKey = new Map(snapshot.models.map(model => [policyKey(model.provider, model.model), model]));
  const selected = selectedPresetIds(body, options);
  const presetSources = Array.isArray(options.presets) ? options.presets : [];
  const dropUndeclared = isRecord(body) && body.dropUndeclared === true;

  // The baseline of every selected preset: the bundle declaration behind the
  // profile row, plus the customisations this plugin's own row declares. The
  // effective declaration is never used as a baseline, because it already
  // carries the profile's own row and would freeze the copy.
  const plans = [];
  for (const presetId of selected) {
    const source = presetSources.find(preset => preset.id === presetId);
    const overrides = presetOverrides(snapshot.docs, presetId);
    const baseline = source ? presetBaseline(source, overrides) : null;
    const current = effectivePresetPlugins(profileText, originalText, presetId);
    if (!baseline && !current) {
      fail(`缺少 Agent 预设 ${presetId} 的上游声明与 profile 覆盖，无法生成覆盖`, {
        code: 'compaction-targets/preset-source',
        preset: presetId,
      });
    }
    const drift = baseline && current ? presetDrift(current, baseline.plugins) : [];
    if (drift.length > 0 && !dropUndeclared) {
      const detail = drift
        .map(entry => `${entry.path}（${entry.kind === 'changed' ? '取值不同' : '仅存在于 profile'}）`)
        .join('、');
      fail(
        `预设 ${presetId} 的 profile 覆盖与上游声明不一致：${detail}。请把这些定制写进 ${PLUGIN_ROW_ID} 的 config.presetOverrides.${presetId}，或声明丢弃它们。`,
        { code: 'compaction-targets/preset-drift', preset: presetId, drift },
      );
    }
    plans.push({ presetId, source, baseline, current, drift });
  }
  const driftReport = plans
    .filter(plan => plan.drift.length > 0)
    .map(plan => ({ preset: plan.presetId, entries: plan.drift }));
  const baselines = new Map(
    plans.filter(plan => plan.baseline).map(plan => [plan.presetId, plan.baseline]),
  );

  // The child default routes the page asked for. They are part of the
  // generated preset rows, so they travel with the same save and are verified
  // the same way; a preset the request says nothing about keeps its route.
  const routePlan = normalizeSubagentRoutes(body, plans, snapshot);

  const inSync = plans.every(plan => !plan.baseline
    || (plan.current && sameExceptManagedFields(plan.current, plan.baseline.plugins)));

  if (selected.length === 1 && selected[0] === 'standard'
    && sameSemantic(snapshot, normalized) && inSync && routePlan.changed.size === 0) {
    return publicApplyResult({
      changed: false,
      patchPath: paths.patchPath,
      backupPath: null,
      snapshotPath: paths.snapshotPath,
      snapshot,
      normalized,
      actualByKey,
      presets: selected,
      drift: driftReport,
      routes: routePlan.routes,
      routeNotes: routePlan.notes,
      jsonSnapshot: { updated: false, path: paths.snapshotPath, reason: 'patch unchanged; JSON snapshot not touched' },
    });
  }

  const newline = originalText.includes('\r\n') ? '\r\n' : '\n';
  const nextConfig = buildNextConfig(snapshot, normalized);
  let candidateText = originalText;

  // The canonical plugin name of the compaction-basic row, taken from the
  // preset that still carries it. A preset whose row lost the name cannot be
  // mounted by the Host, so a rebuilt row gets the name back.
  const standardRow = currentCompaction(snapshot.homeDocs, snapshot.docs).row;
  const compactionBasicName = typeof standardRow.name === 'string' && standardRow.name.trim()
    ? standardRow.name.trim()
    : undefined;

  for (const plan of plans) {
    const { presetId, source, baseline, current } = plan;
    const routeRequest = routePlan.routes.get(presetId);
    // A save that does not mention a preset keeps the route that preset has
    // now - including "inherit". Only a preset without any row yet keeps
    // whatever its declaration carries, because there is nothing else to
    // preserve.
    const keepRoute = routeRequest === undefined
      ? (current ? routeOfPlugins(current) ?? null : undefined)
      : routeRequest;
    // The home layer owns the generated row; a row that still sits in the
    // profile file is carried over into the home layer by this save.
    const homeRow = currentPresetRow(candidateText, presetId);
    const row = homeRow ?? currentPresetRow(profileText, presetId);
    // The default route is edited in the text of the row that is actually
    // written: the existing row when it is kept, the declaration dump when
    // the row is rebuilt from upstream.
    const rowPlugins = text => parseEntryList(text, `preset-${presetId} 覆盖`)[0]?.config?.plugins ?? [];
    if (!baseline) {
      // No upstream declaration: the profile's own row stays the baseline and
      // only the two managed fields change.
      if (!row) {
        fail(`缺少 Agent 预设 ${presetId} 的上游声明与 profile 覆盖，无法生成覆盖`, {
          code: 'compaction-targets/preset-source',
          preset: presetId,
        });
      }
      const toolRoute = planRouteEdit(rowPlugins(row.text), keepRoute);
      const updated = modifyPresetContent(row.text, nextConfig, newline, { compactionBasicName, toolRoute });
      assertOnlyManagedFieldsChanged(row.text, updated, presetId);
      candidateText = homeRow
        ? replacePresetRow(candidateText, presetId, updated)
        : appendPresetRow(candidateText, updated, newline);
      continue;
    }
    if (row && current && sameExceptManagedFields(current, baseline.plugins)) {
      // The row already is the upstream declaration: only the managed fields
      // change, so the row keeps its own wording and the diff stays small.
      const toolRoute = planRouteEdit(rowPlugins(row.text), keepRoute);
      const updated = modifyPresetContent(row.text, nextConfig, newline, { compactionBasicName, toolRoute });
      assertOnlyManagedFieldsChanged(row.text, updated, presetId);
      candidateText = homeRow
        ? replacePresetRow(candidateText, presetId, updated)
        : appendPresetRow(candidateText, updated, newline);
      continue;
    }
    // The row drifted from the upstream declaration: it is rewritten from it,
    // so an upstream rename or a new plugin row reaches the profile instead
    // of freezing the previous copy.
    const built = buildPresetRow(source, nextConfig, newline, {
      compactionBasicName,
      baseline: dumpEntryList(baseline.plugins),
      meta: baseline,
      toolRoute: planRouteEdit(baseline.plugins, keepRoute),
    });
    candidateText = replacePresetRow(candidateText, presetId, built)
      ?? appendPresetRow(candidateText, built, newline);
  }

  if (candidateText === originalText) {
    return publicApplyResult({
      changed: false,
      patchPath: paths.patchPath,
      backupPath: null,
      snapshotPath: paths.snapshotPath,
      snapshot,
      normalized,
      actualByKey,
      presets: selected,
      drift: driftReport,
      routes: routePlan.routes,
      routeNotes: routePlan.notes,
      jsonSnapshot: { updated: false, path: paths.snapshotPath, reason: 'patch unchanged; JSON snapshot not touched' },
    });
  }

  const candidateDocs = parseDocuments(candidateText, { allowEmpty: true });
  assertNonselectedRowsUnchanged(snapshot.homeDocs, candidateDocs, selected, baselines);
  verifyPresetConfigs(candidateDocs, selected, normalized, snapshot, routePlan.routes);
  const candidateSnapshot = buildSnapshot(profileText, candidateText, paths);
  verifySnapshot(candidateSnapshot, normalized, '写入前候选校验');

  const backupPath = await chooseBackupPath(paths.backupBase);
  await writeFile(backupPath, originalText, 'utf8');
  let jsonSnapshot;
  try {
    await writeAtomic(paths.patchPath, candidateText);
    if (options.testHooks?.afterWrite) await options.testHooks.afterWrite({ patchPath: paths.patchPath, backupPath });
    const afterText = await readPatch(paths.patchPath);
    const afterDocs = parseDocuments(afterText, { allowEmpty: true });
    assertNonselectedRowsUnchanged(snapshot.homeDocs, afterDocs, selected, baselines);
    verifyPresetConfigs(afterDocs, selected, normalized, snapshot, routePlan.routes);
    const afterSnapshot = buildSnapshot(profileText, afterText, paths);
    verifySnapshot(afterSnapshot, normalized, '写入后回读校验');
    const afterByKey = new Map(afterSnapshot.models.map(model => [policyKey(model.provider, model.model), model]));
    jsonSnapshot = await writeJsonSnapshot(paths.snapshotPath, snapshot, normalized)
      .catch(error => ({
        updated: false,
        path: paths.snapshotPath,
        error: error instanceof Error ? error.message : String(error),
      }));
    return publicApplyResult({
      changed: true,
      patchPath: paths.patchPath,
      backupPath,
      snapshotPath: paths.snapshotPath,
      snapshot: afterSnapshot,
      normalized,
      actualByKey: afterByKey,
      presets: selected,
      drift: driftReport,
      routes: routePlan.routes,
      routeNotes: routePlan.notes,
      jsonSnapshot,
    });
  } catch (error) {
    let rollbackError = null;
    try {
      await restoreOriginal(paths.patchPath, originalText);
    } catch (restoreError) {
      rollbackError = restoreError;
    }
    const message = error instanceof Error ? error.message : String(error);
    fail(
      rollbackError
        ? `${message}；回滚失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}；请用 ${backupPath} 手工恢复`
        : `${message}；已回滚原文件；备份：${backupPath}`,
      {
        code: error instanceof TargetError ? error.code : 'compaction-targets/save-failed',
        rollback: rollbackError ? 'failed' : 'restored',
        backupPath,
      },
    );
  }
}

export const __test = {
  SCHEMA,
  parseDocuments,
  buildSnapshot,
  normalizeRequest,
  sameSemantic,
  findBlockRange,
  ratioForPoint,
  effectivePoint,
  assertOnlyBlockChanged,
  outsideText,
  stripCompactionConfig,
  pathsFromOptions,
  pathsFromEnv: pathsFromOptions,
  findPresetRowRange,
  profilePresetIds,
  disableToolPruner,
  buildPresetRow,
  selectedPresetIds,
  verifyPresetConfigs,
  rowId,
  indexRows,
  rowLabel,
  assertNonselectedRowsUnchanged,
  ensureCompactionBasicNames,
  assertOnlyManagedFieldsChanged,
  stripManagedFields,
  parseEntryList,
  presetOverrides,
  applyPresetOverrides,
  presetBaseline,
  presetDrift,
  currentPresetRow,
  currentPresetPlugins,
  sameExceptManagedFields,
  replacePresetRow,
  findListItemRange,
  findKeyBlockRange,
  writeToolRoute,
  routeOf,
  routeOfPlugins,
  planRouteEdit,
  normalizeSubagentRoutes,
  verifyPresetRoute,
};


