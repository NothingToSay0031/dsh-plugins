// Compaction target persistence for the DSH desktop profile.
//
// This module is deliberately read-only except for `applyTargets()`: loading the
// Host plugin must never create, normalize, or "repair" a file. The only write
// entry point is a SAVE request from the Settings page.
import { existsSync } from 'node:fs';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('./vendor/js-yaml.cjs');

const JsTag = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: () => true,
  construct: data => ({ __js: data }),
});
const SCHEMA = yaml.DEFAULT_SCHEMA.extend([JsTag]);

const PATCH_BASENAME = 'cordis.patch.yml';
const BACKUP_SUFFIX = '.bak';
const SNAPSHOT_BASENAME = 'compaction-targets.json';
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

function parseDocuments(text) {
  let docs;
  try {
    docs = yaml.load(normalizeText(text), { schema: SCHEMA });
  } catch (error) {
    fail(`cordis.patch.yml 解析失败：${error instanceof Error ? error.message : String(error)}`, {
      code: 'compaction-targets/patch-parse',
    });
  }
  if (!Array.isArray(docs) || docs.length === 0) {
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

function currentCompaction(docs) {
  const preset = findEntry(docs, 'preset-standard');
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

function buildSnapshot(text, paths) {
  const docs = parseDocuments(text);
  const models = currentModels(docs);
  const compaction = currentCompaction(docs);
  const config = compaction.config;
  const headroomTokens = integer(config.headroomTokens, 'compaction-basic.config.headroomTokens', 0);
  const retainTokens = integer(config.retainTokens, 'compaction-basic.config.retainTokens', 1);
  const summarizerMaxTokens = integer(config.maxTokens, 'compaction-basic.config.maxTokens', 1);
  const fallbackRatio = ratio(config.thresholdRatio, 'compaction-basic.config.thresholdRatio');
  const policies = parsePolicies(config);
  const policyByKey = new Map(policies.map(policy => [policyKey(policy.provider, policy.model), policy]));
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
    config,
    models: resolvedModels,
    policies,
    unmanagedPolicies,
    global: {
      retainTokens,
      headroomTokens,
      summarizerMaxTokens,
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
    // Base presets declare compaction-basic without a config block. Insert the
    // generated block immediately after that row.
    return { lines, cfgIdx: itemIdx + 1, cfgIndent: itemIndent + 2, end: itemIdx + 1 };
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
    if (indent <= itemIndent) break;
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

function modifyPresetContent(content, config, newline) {
  const range = findBlockRange(content);
  const withConfig = replaceBlock(
    content,
    range,
    generateBlock(config, range, newline),
  );
  return disableToolPruner(withConfig);
}

function buildPresetRow(source, config, newline) {
  if (!source || typeof source.content !== 'string' || !source.content.trim()) {
    fail(`缺少预设 ${source?.id || ''} 的基础配置，无法生成覆盖`, {
      code: 'compaction-targets/preset-source',
    });
  }
  const plugins = modifyPresetContent(source.content, config, newline);
  const lines = [
    `- id: preset-${source.id}`,
    `  name: '@deepseek-ai/dsh-agent-preset'`,
    '  config:',
    `    id: ${JSON.stringify(source.id)}`,
  ];
  if (source.name) lines.push(`    name: ${JSON.stringify(source.name)}`);
  if (source.description) lines.push(`    description: ${JSON.stringify(source.description)}`);
  if (Number.isFinite(Number(source.order))) lines.push(`    order: ${Number(source.order)}`);
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

function verifyPresetConfigs(docs, selected, normalized, snapshot) {
  const modelByKey = new Map(snapshot.models.map(model => [policyKey(model.provider, model.model), model]));
  for (const presetId of selected) {
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

function assertNonselectedRowsUnchanged(originalDocs, candidateDocs, selected) {
  const selectedIds = new Set(selected.map(id => `preset-${id}`));
  const selectedDocs = new Map(
    originalDocs.filter(row => selectedIds.has(row?.id)).map(row => [row.id, row]),
  );
  for (const row of originalDocs) {
    if (selectedIds.has(row?.id)) continue;
    const candidate = candidateDocs.find(item => item?.id === row?.id);
    if (!candidate || JSON.stringify(canonical(candidate)) !== JSON.stringify(canonical(row))) {
      fail(`patch 中非目标预设 ${row?.id || '(unknown)'} 发生了变化`, {
        code: 'compaction-targets/outside-structure-changed',
      });
    }
  }
  // A selected preset may keep its non-compaction plugins untouched; compare a
  // detached copy with the compaction group removed.
  for (const [id, original] of selectedDocs) {
    const candidate = candidateDocs.find(item => item?.id === id);
    if (!candidate) fail(`preset ${id} 在写入后消失`);
    const before = structuredClone(original);
    const after = structuredClone(candidate);
    const strip = row => {
      const plugins = row?.config?.plugins;
      if (Array.isArray(plugins)) row.config.plugins = plugins.filter(plugin => plugin?.id !== 'compaction');
      return row;
    };
    if (JSON.stringify(canonical(strip(before))) !== JSON.stringify(canonical(strip(after)))) {
      fail(`preset ${id} 的 compaction 之外内容发生了变化`, {
        code: 'compaction-targets/outside-structure-changed',
      });
    }
  }
}

function publicSnapshot(snapshot, presetSources = [], text = '') {
  const presets = (presetSources.length > 0 ? presetSources : [{
    id: 'standard',
    name: 'Standard',
    isDefault: true,
  }]).filter(preset => preset && preset.id).map(preset => ({
    id: preset.id,
    ...(preset.name ? { name: preset.name } : {}),
    ...(preset.description ? { description: preset.description } : {}),
    ...(preset.order === undefined ? {} : { order: preset.order }),
    isDefault: preset.isDefault === true,
    ...(preset.broken ? { broken: preset.broken } : {}),
    hasOverride: Boolean(findPresetRowRange(text, preset.id)),
  }));
  return {
    patchPath: snapshot.paths.patchPath,
    backupBase: snapshot.paths.backupBase,
    snapshotPath: snapshot.paths.snapshotPath,
    fallbackRatio: snapshot.global.fallbackRatio,
    presets,
    profilePresets: profilePresetIds(text),
    global: {
      retainTokens: snapshot.global.retainTokens,
      headroomTokens: snapshot.global.headroomTokens,
      summarizerMaxTokens: snapshot.global.summarizerMaxTokens,
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
  const summarizerMaxTokens = body.summarizerMaxTokens === undefined
    ? snapshot.global.summarizerMaxTokens
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
      reserveSource: reserveSource(model),
      retainTokens,
    });
  }

  for (const key of rowsByKey.keys()) {
    if (!modelKeys.has(key)) fail(`models 中的模型不在当前清单：${key}`);
  }

  return {
    rows,
    headroomTokens,
    retainTokens,
    summarizerMaxTokens,
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
    '# Managed by @local/dsh-compaction-targets from Settings > Plugins.',
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

async function readPatch(patchPath) {
  try {
    return await readFile(patchPath, 'utf8');
  } catch (error) {
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
    _comment: 'Generated by @local/dsh-compaction-targets from the Settings > Plugins form. '
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

function publicApplyResult({ changed, patchPath, backupPath, snapshotPath, snapshot, normalized, actualByKey, jsonSnapshot, presets = [] }) {
  return {
    ok: true,
    changed,
    patchPath,
    backupPath,
    snapshotPath,
    presets,
    restartRequired: true,
    restartNotice: '需要重启客户端才生效',
    global: {
      retainTokens: normalized.retainTokens,
      headroomTokens: normalized.headroomTokens,
      summarizerMaxTokens: normalized.summarizerMaxTokens,
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
  const patchPath = options.patchPath || envPatchPath;
  if (!patchPath) {
    fail('无法定位 profile patch：DSH_PROFILE_DIR 未设置，且 Host 没有提供 configEditor.documentPath', {
      code: 'compaction-targets/profile',
    });
  }
  const resolvedPatchPath = path.resolve(patchPath);
  const profileDir = options.profileDir || path.dirname(resolvedPatchPath);
  const dshHome = options.snapshotPath
    ? path.dirname(path.resolve(options.snapshotPath))
    : (env.DSH_HOME || path.dirname(path.dirname(profileDir)));
  return {
    profileDir,
    patchPath: resolvedPatchPath,
    backupBase: `${resolvedPatchPath}${BACKUP_SUFFIX}`,
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
  const text = await readPatch(paths.patchPath);
  const snapshot = buildSnapshot(text, paths);
  return publicSnapshot(snapshot, options.presets, text);
}

/**
 * Validate and persist one SAVE request. No caller outside this function writes
 * the profile patch or the JSON snapshot.
 */
export async function applyTargets(body, options = {}) {
  const paths = pathsFromOptions(options);
  const originalText = await readPatch(paths.patchPath);
  const snapshot = buildSnapshot(originalText, paths);
  const normalized = normalizeRequest(body, snapshot);
  const actualByKey = new Map(snapshot.models.map(model => [policyKey(model.provider, model.model), model]));
  const selected = selectedPresetIds(body, options);
  const presetSources = Array.isArray(options.presets) ? options.presets : [];

  if (selected.length === 1 && selected[0] === 'standard'
    && sameSemantic(snapshot, normalized)) {
    return publicApplyResult({
      changed: false,
      patchPath: paths.patchPath,
      backupPath: null,
      snapshotPath: paths.snapshotPath,
      snapshot,
      normalized,
      actualByKey,
      presets: selected,
      jsonSnapshot: { updated: false, path: paths.snapshotPath, reason: 'patch unchanged; JSON snapshot not touched' },
    });
  }

  const newline = originalText.includes('\r\n') ? '\r\n' : '\n';
  const nextConfig = buildNextConfig(snapshot, normalized);
  let candidateText = originalText;

  if (selected.includes('standard')) {
    const range = findBlockRange(candidateText);
    candidateText = replaceBlock(candidateText, range, generateBlock(nextConfig, range, newline));
    candidateText = disableToolPruner(candidateText);
  }

  for (const presetId of selected) {
    if (presetId === 'standard') continue;
    const source = presetSources.find(preset => preset.id === presetId);
    if (!source) {
      fail(`缺少 Agent 预设 ${presetId} 的读取结果，无法生成覆盖`, {
        code: 'compaction-targets/preset-source',
        preset: presetId,
      });
    }
    candidateText = removePresetRow(candidateText, presetId);
    candidateText = appendPresetRow(
      candidateText,
      buildPresetRow(source, nextConfig, newline),
      newline,
    );
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
      jsonSnapshot: { updated: false, path: paths.snapshotPath, reason: 'patch unchanged; JSON snapshot not touched' },
    });
  }

  const candidateDocs = parseDocuments(candidateText);
  assertNonselectedRowsUnchanged(snapshot.docs, candidateDocs, selected);
  verifyPresetConfigs(candidateDocs, selected, normalized, snapshot);
  const candidateSnapshot = buildSnapshot(candidateText, paths);
  verifySnapshot(candidateSnapshot, normalized, '写入前候选校验');

  const backupPath = await chooseBackupPath(paths.backupBase);
  await writeFile(backupPath, originalText, 'utf8');
  let jsonSnapshot;
  try {
    await writeAtomic(paths.patchPath, candidateText);
    if (options.testHooks?.afterWrite) await options.testHooks.afterWrite({ patchPath: paths.patchPath, backupPath });
    const afterText = await readPatch(paths.patchPath);
    const afterDocs = parseDocuments(afterText);
    assertNonselectedRowsUnchanged(snapshot.docs, afterDocs, selected);
    verifyPresetConfigs(afterDocs, selected, normalized, snapshot);
    const afterSnapshot = buildSnapshot(afterText, paths);
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
};
