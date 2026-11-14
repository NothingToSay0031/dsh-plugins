// The upstream (bundle) declaration of an Agent preset.
//
// The Loader replaces a `preset-*` row's `config` as a whole, so a profile
// that overrides one has to restate the whole child list. Restating it from
// the Host's *effective* declaration freezes that copy: the profile row
// shadows the bundle layer, so the next read returns the copy itself and an
// upstream rename is never absorbed. This module reads the declaration from
// the bundle layer behind the config editor's inherited layer instead, so the
// copy is re-derived from the current upstream on every write.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('./vendor/js-yaml.cjs');

// The Loader keeps `!!js` expressions as tagged scalars: the marker object
// survives parsing and is written back as `!!js <expression>`. This mirrors
// the Loader's own `entryListSchema`, so a declaration written here reads back
// exactly as the Host wrote it.
const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: data => typeof data === 'string',
  construct: data => ({ __jsExpr: data }),
  predicate: data => data instanceof Object && '__jsExpr' in data,
  represent: data => data['__jsExpr'],
});

/** YAML dialect preserving child-owned JavaScript expression nodes. */
export const ENTRY_LIST_SCHEMA = yaml.JSON_SCHEMA.extend(JsExpr);

/**
 * Serialize a structured declaration into the Loader's entry-list dialect.
 * @param value The declaration to write.
 * @returns YAML text the Loader can mount as-is.
 */
export function dumpEntryList(value) {
  return yaml.dump(value, { schema: ENTRY_LIST_SCHEMA, noRefs: true, lineWidth: -1 });
}

/**
 * Parse an entry-list document written in the Loader's dialect.
 * @param text The document to read.
 * @returns The structured declaration.
 */
export function parseEntryListText(text) {
  return yaml.load(text, { schema: ENTRY_LIST_SCHEMA });
}

/**
 * Read the upstream declaration of every Agent preset from the running Host.
 *
 * `configEditor.configuration()` reports, for every profile-owned entry, the
 * configuration it would carry without the profile's own override. That is the
 * bundle declaration: the layer a profile row shadows. Reading it here keeps
 * the plugin from reading its own previous output back as the baseline.
 *
 * @param ctx The plugin context.
 * @returns One `{ id, config }` entry per preset the Host declares.
 */
export function readUpstreamPresets(ctx) {
  let editor;
  try {
    editor = ctx.get('configEditor');
  } catch {
    return [];
  }
  if (!editor || typeof editor.configuration !== 'function') return [];
  let rows;
  try {
    rows = editor.configuration();
  } catch {
    return [];
  }
  const presets = [];
  for (const row of rows || []) {
    const entryId = row?.entry?.options?.id;
    if (typeof entryId !== 'string' || !entryId.startsWith('preset-')) continue;
    const config = row.inherited;
    if (!config || typeof config !== 'object' || !Array.isArray(config.plugins)) continue;
    presets.push({ id: entryId.slice('preset-'.length), config });
  }
  return presets;
}
