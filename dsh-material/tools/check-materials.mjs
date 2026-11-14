#!/usr/bin/env node
/**
 * Static audit of the dsh-material token layer against the real dsh stylesheets.
 *
 * Answers the six questions a theme plugin cannot answer by eye:
 *   1. does this variable name exist at all (a renamed token silently stops applying);
 *   2. can a body-inline override reach it (`body *` re-declarations beat inheritance);
 *   3. does every consumer accept the value kind we write (a gradient in `background-color` is invalid);
 *   4. does the resulting fill still clear WCAG AA against the built-in label colors;
 *   5. does a floating surface over a translucent panel still hold its content back;
 *   6. is every translucent value classified for `prefers-reduced-transparency`, blur included.
 *
 * Usage: node tools/check-materials.mjs [path/to/deepseek-harness]
 *        node tools/check-materials.mjs --tokens [name-substring]
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ARGS = process.argv.slice(2);
/** `--tokens [filter]` is a lookup mode and takes no repo path; the audit takes the repo as $1. */
const TOKENS_MODE = ARGS[0] === '--tokens';
const TOKEN_FILTER = TOKENS_MODE ? (ARGS[1] ?? '') : '';
/** `--coverage` is the reverse lookup: what a token layer could still reach but does not. */
const COVERAGE_MODE = ARGS[0] === '--coverage';
const REPO = resolve(TOKENS_MODE || COVERAGE_MODE ? 'F:/AIZoo/deepseek-harness' : (ARGS[0] ?? 'F:/AIZoo/deepseek-harness'));
const THEME_STYLES = join(REPO, 'packages/client/ui-theme/src/styles');
const CLIENT_DIR = join(REPO, 'packages/client');
/**
 * The session packages ship client surfaces of their own — the quote button that appears next to a
 * selection lives here, not under `packages/client` — and this layer reaches them through the compat
 * stylesheet, so their sheets belong in the scan.
 */
const SESSION_DIR = join(REPO, 'packages/session');

/* ---------- materials under test ---------- */

const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const block = clientSource.match(/\/\* __MATERIALS_START__ \*\/([\s\S]*?)\/\* __MATERIALS_END__ \*\//);
if (!block) throw new Error('MATERIALS markers not found in client.js');
const { MATERIALS, FROST_SURFACES, FROST_SOLID, FROST_BLUR, FROST_MIN_ALPHA, FROSTED_FLOATERS, HOVER_CARD_INK, frostify, captionSafe, buildLayer } = new Function(
  `${block[1]}\nreturn { MATERIALS, FROST_SURFACES, FROST_SOLID, FROST_BLUR, FROST_MIN_ALPHA, FROSTED_FLOATERS, HOVER_CARD_INK, frostify, captionSafe, buildLayer };`,
)();

/* ---------- stylesheet scan ---------- */

/** Source stylesheets only: installed trees repeat the sheets and can symlink-loop into themselves. */
const SKIPPED_DIRS = new Set(['node_modules', 'lib', 'dist']);

function cssFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIPPED_DIRS.has(name)) cssFiles(full, out);
    } else if (name.endsWith('.css')) out.push(full);
  }
  return out;
}

/** Strip comments and blank runs, remembering each declaration's line number. */
function parseRules(path) {
  const raw = readFileSync(path, 'utf8');
  const text = raw.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '));
  const rules = [];
  let cursor = 0;
  let selectorStart = 0;
  const lineAt = offset => text.slice(0, offset).split('\n').length;
  while (cursor < text.length) {
    const ch = text[cursor];
    if (ch === '{') {
      const selector = text.slice(selectorStart, cursor).trim().replace(/\s+/g, ' ');
      const bodyStart = cursor + 1;
      let depth = 1;
      cursor = bodyStart;
      while (cursor < text.length && depth > 0) {
        if (text[cursor] === '{') depth += 1;
        else if (text[cursor] === '}') depth -= 1;
        cursor += 1;
      }
      const body = text.slice(bodyStart, cursor - 1);
      if (selector.startsWith('@')) rules.push(...parseAtRule(path, selector, body, bodyStart, lineAt));
      else rules.push({ path, selector, declarations: parseDeclarations(body, bodyStart, lineAt) });
      selectorStart = cursor;
      continue;
    }
    if (ch === '}') {
      selectorStart = cursor + 1;
      cursor += 1;
      continue;
    }
    cursor += 1;
  }
  return rules;
}

/** Nested blocks keep their wrapper in the recorded selector so `body *` stays visible. */
function parseAtRule(path, wrapper, body, offset, lineAt) {
  const inner = [];
  let cursor = 0;
  let selectorStart = 0;
  while (cursor < body.length) {
    if (body[cursor] === '{') {
      const selector = body.slice(selectorStart, cursor).trim().replace(/\s+/g, ' ');
      const bodyStart = cursor + 1;
      let depth = 1;
      cursor = bodyStart;
      while (cursor < body.length && depth > 0) {
        if (body[cursor] === '{') depth += 1;
        else if (body[cursor] === '}') depth -= 1;
        cursor += 1;
      }
      inner.push({
        path,
        selector: `${wrapper} → ${selector}`,
        declarations: parseDeclarations(body.slice(bodyStart, cursor - 1), offset + bodyStart, lineAt),
      });
      selectorStart = cursor;
      continue;
    }
    if (body[cursor] === '}') { selectorStart = cursor + 1; cursor += 1; continue; }
    cursor += 1;
  }
  return inner;
}

/** Split a rule body on top-level `;` — gradients carry commas and parens but never a semicolon. */
function parseDeclarations(body, offset, lineAt) {
  const out = [];
  let buffer = '';
  let depth = 0;
  let segmentStart = offset;
  const flush = () => {
    const declaration = buffer.trim();
    buffer = '';
    if (declaration === '') return;
    const colon = declaration.indexOf(':');
    if (colon < 0) return;
    out.push({
      property: declaration.slice(0, colon).trim(),
      value: declaration.slice(colon + 1).trim(),
      line: lineAt(segmentStart),
    });
  };
  for (const ch of body) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ';' && depth === 0) { flush(); segmentStart += 1; continue; }
    segmentStart += 1;
    buffer += ch;
  }
  flush();
  return out;
}

const themeRules = cssFiles(THEME_STYLES).flatMap(parseRules);

/** The client's own sheets plus the session packages' client surfaces. */
const clientRules = [
  ...cssFiles(CLIENT_DIR),
  ...(existsSync(SESSION_DIR) ? cssFiles(SESSION_DIR) : []),
].flatMap(parseRules);

/** name → where ui-theme declares it. */
const declared = new Map();
for (const rule of themeRules) {
  for (const declaration of rule.declarations) {
    if (!declaration.property.startsWith('--')) continue;
    const list = declared.get(declaration.property) ?? [];
    list.push({ selector: rule.selector, ...declaration });
    declared.set(declaration.property, list);
  }
}

/** name → every CSS property that reads it, with the reading selector. */
const consumed = new Map();
const scanConsumers = rules => {
  for (const rule of rules) {
    for (const declaration of rule.declarations) {
      for (const name of new Set([...declaration.value.matchAll(/var\((--[a-z0-9-]+)/gi)].map(m => m[1]))) {
        const list = consumed.get(name) ?? [];
        // A custom property that only forwards `var()` is a chain link, not a paint site.
        const property = declaration.property.startsWith('--') ? `(chain) ${declaration.property}` : declaration.property;
        list.push({ property, selector: rule.selector, path: rule.path, line: declaration.line });
        consumed.set(name, list);
      }
    }
  }
};
scanConsumers(themeRules);
scanConsumers(clientRules.filter(rule => !rule.path.startsWith(THEME_STYLES)));

/* ---------- value kinds ---------- */

const GRADIENT = /^(linear-gradient|radial-gradient|conic-gradient|repeating-linear-gradient|repeating-radial-gradient|paint\(|url\()/i;
const COLOR_ONLY = new Set([
  'background-color', 'color', 'fill', 'stroke', 'outline-color', 'accent-color', 'caret-color',
  'text-decoration-color', 'column-rule-color', 'border', 'border-top', 'border-right',
  'border-bottom', 'border-left', 'border-color', '-webkit-text-fill-color', '-webkit-tap-highlight-color',
]);

function classify(property) {
  const name = property.trim();
  if (name === 'box-shadow' || name === 'text-shadow') return 'shadow';
  if (name === 'backdrop-filter' || name === 'filter') return 'filter';
  if (/^(border|outline|text-decoration|column-rule)(-(top|right|bottom|left))?-color$/.test(name)) return 'color';
  if (COLOR_ONLY.has(name)) return 'color';
  if (/^(background|background-image|mask|mask-image|list-style-image)$/.test(name)) return 'image';
  if (/^(border|border-radius|outline-offset|width|height|gap|padding|margin|offset|top|right|bottom|left|line-height|letter-spacing)(-(top|right|bottom|left))?$/.test(name)) return 'length';
  if (name.startsWith('--')) return 'variable';
  return 'other';
}

/** Which value kinds one consumer slot actually accepts. `var()` always passes: the chain is walked separately. */
const ACCEPTS = {
  color: new Set(['color', 'var']),
  image: new Set(['color', 'gradient', 'var']),
  shadow: new Set(['color', 'shadow-list', 'none', 'var']),
  filter: new Set(['filter', 'none', 'var']),
  length: new Set(['length', 'var']),
  other: null, // unknown slot: only the ui-theme declaration check applies
  variable: null,
};

const SHADOW_SEGMENT = /^(?:inset\s+)?(?:-?[\d.]+(?:px|em|rem|%)?\s+){1,4}(?:-?[\d.]+(?:px|em|rem|%)?\s*)?(?:[a-z]+\(.*\)|#[0-9a-f]{3,8})$/i;

function valueKind(value) {
  const text = value.trim();
  if (text === 'none') return 'none';
  if (GRADIENT.test(text)) return 'gradient';
  if (parseColor(text)) return 'color';
  if (/^(blur|saturate|brightness|contrast|opacity|grayscale|hue-rotate|invert|sepia|drop-shadow)\(/i.test(text)) return 'filter';
  if (/^-?[\d.]+(px|em|rem|%|vh|vw|deg)$/i.test(text)) return 'length';
  if (text.startsWith('var(') || /(^|\s)var\(/.test(text)) return 'var';
  if (text.split(/,\s*(?![^(]*\))/).every(segment => SHADOW_SEGMENT.test(segment.trim()))) return 'shadow-list';
  return 'other';
}

/**
 * Every real CSS property slot a token reaches, following `var()` through intermediate custom
 * properties. ui-theme forwards most material aliases (`--dsw-elevation-*`, `--dsw-alias-bg-*`)
 * through one or two hops before a component paints them, so scanning only direct readers misses
 * the slots that actually reject a gradient.
 */
function paintSites(name, seen = new Set()) {
  if (seen.has(name)) return [];
  const next = new Set(seen);
  next.add(name);
  const sites = [];
  for (const reader of consumed.get(name) ?? []) {
    if (!reader.property.startsWith('(chain) ')) {
      sites.push({ ...reader, via: null });
      continue;
    }
    const forwarded = reader.property.slice(8);
    for (const nested of paintSites(forwarded, next)) sites.push({ ...nested, via: name });
  }
  return sites;
}

/* ---------- color math (WCAG AA over the built-in label colors) ---------- */

function hexToRgb(hex) {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? [...value].map(c => c + c) : value;
  return [0, 2, 4].map(i => Number.parseInt(full.slice(i, i + 2), 16));
}

function parseColor(text) {
  const value = text.trim();
  const hex = /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.exec(value);
  if (hex) return { rgb: hexToRgb(hex[0]), alpha: 1 };
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(value);
  if (rgb) {
    const parts = rgb[1].split(/[,/\s]+/).filter(Boolean);
    if (parts.length >= 3) {
      return { rgb: [Number.parseFloat(parts[0]), Number.parseFloat(parts[1]), Number.parseFloat(parts[2])], alpha: parts[3] === undefined ? 1 : Number.parseFloat(parts[3]) };
    }
  }
  return null;
}

function over(foreground, background) {
  const a = foreground.alpha;
  return { rgb: foreground.rgb.map((c, i) => c * a + background.rgb[i] * (1 - a)), alpha: 1 };
}

function luminance(color) {
  const rgb = Array.isArray(color) ? color : color.rgb;
  const [r, g, b] = rgb.map(c => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground, background) {
  const [a, b] = [luminance(foreground), luminance(background)];
  const [light, dark] = a > b ? [a, b] : [b, a];
  return (light + 0.05) / (dark + 0.05);
}

function rgbHex(color) {
  return `#${color.rgb.map(c => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}

/** Resolve ui-theme's own alias chain for one palette mode so labels are compared to real pixels. */
function builtinTokens(mode) {
  const map = new Map();
  const wanted = selector => (mode === 'dark'
    ? /data-ds-dark-theme/.test(selector)
    : !/data-ds-dark-theme/.test(selector) && /(^|,|\s)(body|:root)/.test(selector));
  for (const rule of themeRules) {
    if (!wanted(rule.selector)) continue;
    for (const declaration of rule.declarations) {
      if (declaration.property.startsWith('--')) map.set(declaration.property, declaration.value);
    }
  }
  const resolveValue = (name, depth = 0) => {
    if (depth > 8 || !map.has(name)) return undefined;
    const raw = map.get(name);
    const direct = parseColor(raw);
    if (direct) return direct;
    const chain = [...raw.matchAll(/var\((--[a-z0-9-]+)(?:,[^)]*)?\)/gi)];
    for (const match of chain) {
      const nested = resolveValue(match[1], depth + 1);
      if (nested) return nested;
    }
    return undefined;
  };
  return { map, resolveValue };
}

/* ---------- report ---------- */

const shortPath = path => path.replace(`${REPO}\\`, '').replace(`${REPO}/`, '…/');

/**
 * Component-level rebinds of a name: they win over a body-inline value inside their own subtree, so
 * they decide whether an override is reachable at all. Both the coverage listing and the audit read
 * this, which is why it is built before either of them runs.
 */
const localRebinds = new Map();
for (const rule of clientRules) {
  if (rule.path.startsWith(THEME_STYLES)) continue;
  for (const declaration of rule.declarations) {
    if (!declaration.property.startsWith('--')) continue;
    const list = localRebinds.get(declaration.property) ?? [];
    list.push({ selector: rule.selector, path: rule.path, line: declaration.line });
    localRebinds.set(declaration.property, list);
  }
}

/**
 * `node tools/check-materials.mjs --tokens [substring]`
 * Lists every token ui-theme declares, what its own value holds, and whether a gradient survives
 * all the slots that read it. Used to pick wash candidates instead of guessing token by token.
 */
if (TOKENS_MODE) {
  const rows = [];
  for (const name of [...declared.keys()].sort()) {
    if (!name.includes(TOKEN_FILTER)) continue;
    const sites = paintSites(name);
    const blocked = new Set();
    for (const site of sites) {
      const accepted = ACCEPTS[classify(site.property)];
      if (accepted && !accepted.has('gradient') && !accepted.has('image')) blocked.add(site.property);
    }
    rows.push({
      name,
      holds: declaredKind(name),
      reach: sites.length,
      gradient: blocked.size === 0 ? (sites.length > 0 ? 'safe' : 'unpainted') : `rejected by ${[...blocked].join(', ')}`,
    });
  }
  for (const row of rows) console.log(`${row.gradient.padEnd(34)} ${row.holds.padEnd(12)} ${String(row.reach).padStart(3)}  ${row.name}`);
  console.log(`${rows.length} token(s)`);
  process.exit(0);
}

/**
 * `node tools/check-materials.mjs --coverage`
 * The reverse of the audit: every paintable token ui-theme declares that this layer does NOT write,
 * grouped by what it paints and marked by whether a body-inline override can reach it at all.
 * Coverage claims come from this list, not from looking for surfaces in a screenshot.
 */
if (COVERAGE_MODE) {
  const covered = new Set(Object.values(MATERIALS).flatMap(layer => Object.keys(layer)));
  /** ui-theme declares light at the root scope and dark under a `[data-ds-dark-theme]` selector. */
  const lightValue = name => (declared.get(name) ?? []).find(entry => !/dark/.test(entry.selector))?.value ?? '';
  const rows = [];
  for (const name of [...declared.keys()].sort()) {
    const holds = declaredKind(name);
    if (holds !== 'color' && holds !== 'gradient' && holds !== 'mixed') continue;
    const sites = paintSites(name);
    if (sites.length === 0) continue;
    const kinds = new Set(sites.map(site => classify(site.property)));
    const onlyColor = [...kinds].every(kind => kind === 'color');
    const paints = kinds.has('image') ? 'surface'
      : kinds.has('shadow') ? 'shadow'
      : kinds.has('filter') ? 'filter'
      : onlyColor && sites.some(site => /^(border|outline)/.test(site.property)) ? 'border'
      : onlyColor ? 'text' : 'other';
    const shadowed = (declared.get(name) ?? []).some(entry => /(^|[\s,])body\s+\*|body \*/.test(entry.selector))
      || (localRebinds.get(name) ?? []).length > 0;
    rows.push({
      name, paints, holds, reach: sites.length, covered: covered.has(name), shadowed,
      light: lightValue(name).slice(0, 30),
      where: shortPath((sites[0]?.path ?? '').toString()),
    });
  }
  const uncovered = rows.filter(row => !row.covered);
  for (const group of ['surface', 'border', 'shadow', 'filter', 'text', 'other']) {
    const list = uncovered.filter(row => row.paints === group).sort((a, b) => b.reach - a.reach);
    if (list.length === 0) continue;
    console.log(`\n== ${group} (${list.length} uncovered) ==`);
    for (const row of list) {
      console.log(`${row.shadowed ? 'UNREACHABLE' : 'reachable  '} ${String(row.reach).padStart(3)}  ${row.holds.padEnd(8)} ${row.name.padEnd(44)} ${row.light}`);
    }
  }
  console.log(`\n${rows.length} paintable token(s) read by packages/client, ${covered.size} covered, ${uncovered.filter(row => !row.shadowed).length} reachable and uncovered.`);
  process.exit(0);
}

/**
 * Modal scrims composite over the transcript, not over the canvas, and never host their own text,
 * so a WCAG text ratio against them is meaningless. Everything else here is a surface real labels
 * sit on and must clear AA.
 */
const SCRIM_TOKENS = new Set(['--dsw-alias-bg-mask-1', '--dsw-alias-bg-mask-2', '--dsw-alias-bg-mask-overlay']);

/**
 * Surface name → the label tokens that legitimately sit on it. Skeleton shimmer blocks carry no
 * text of their own, so they are deliberately absent. A `#` entry is a literal ink colour, used for
 * the chips whose text colour is hardcoded in the component rather than taken from an alias.
 */
const TEXT_ON = [
  {
    surface: /^--dsw-alias-(bg-base|bg-layer-1|bg-layer-2|bg-overlay|bg-layer-3|bg-module-platform|interactive-bg-hover-solid|document-preview|code-diff-(added|deleted)|file-diff-(added|deleted)-(bg|gutter)|state-(business|success|warn)-tertiary)$/,
    labels: ['--dsw-alias-label-primary', '--dsw-alias-label-secondary'],
  },
  {
    surface: /^--dsw-(specific-sidebar-fill|specific-bubble|specific-input-major|specific-selector|menu-surface-fill)$/,
    labels: ['--dsw-alias-label-primary', '--dsw-alias-label-secondary'],
  },
  {
    surface: /^--dsw-alias-(markdown-code-block|markdown-code-block-banner|markdown-inline-code|markdown-tag|turn-trigger-bg|turn-trigger-bg-hover|menu-group-header-fill)$/,
    labels: ['--dsw-alias-label-primary', '--dsw-alias-label-secondary'],
  },
  {
    surface: /^--dsw-alias-button-(elevated-fill|floating-fill|floating-hover|ghost-active-fill)$/,
    labels: ['--dsw-alias-label-primary'],
  },
  {
    // The delivery / plan / schedule cards and the changed-files header band: they paint ui-theme's
    // static palette directly, so the material layer writes those names instead of an alias.
    surface: /^--dsw-static-neutral-(50|100|800|850)$/,
    labels: ['--dsw-alias-label-primary', '--dsw-alias-label-secondary'],
  },
  {
    // The Sidebar session hover card: the compat stylesheet hands the card's own surface back to
    // the body layer, so the card carries this layer's glass and the same ink as every other
    // themed surface. The card's status line keeps the tertiary step — the app's dimmed metadata
    // step, which no light surface in this table pairs with either.
    surface: /^--dsw-hovercard-bg$/,
    labels: ['--dsw-alias-label-primary', '--dsw-alias-label-secondary'],
  },
  {
    surface: /^--dsw-alias-(brand-primary|button-primary-(fill|hover)|button-(info-fill|info-hover|contrast-fill))$/,
    labels: ['--dsw-alias-label-primary-foreground'],
  },
  {
    // The tooltip follows the theme now: the bubble's surface is this layer's glass and its ink is
    // the theme's primary label, which the compat stylesheet hands back from the literal white
    // `Tooltip.module.css:18` writes. The keycap inherits that ink.
    surface: /^--dsw-alias-tooltip-bg$/,
    labels: ['--dsw-alias-label-primary'],
  },
  {
    surface: /^--dsw-alias-tooltip-key-bg$/,
    labels: ['--dsw-alias-label-primary'],
  },
  {
    // The toast's label is this layer's own token, so the label colours are read from the layer.
    surface: /^--dsw-alias-toast-bg$/,
    labels: ['--dsw-alias-toast-label'],
  },
];

const COLOR_TOKEN = /#[0-9a-f]{3}(?:[0-9a-f]{3})?\b|rgba?\([^)]+\)/gi;

/**
 * Known floating-over-panel stacks, with the largest share of what sits behind that may reach the eye.
 * One translucent surface floats over solid structure; two half-opaque layers composite into a mush no
 * blur recovers, so the pair is measured instead of judged from a screenshot.
 */
const STACKED_PAIRS = [
  ['--dsw-menu-surface-fill', '--dsw-alias-bg-layer-1', 0.20],
  ['--dsw-specific-selector', '--dsw-alias-bg-layer-1', 0.20],
  ['--dsw-alias-bg-overlay', '--dsw-alias-bg-layer-2', 0.15],
  ['--dsw-alias-menu-group-header-fill', '--dsw-menu-surface-fill', 0.20],
  ['--dsw-alias-button-floating-fill', '--dsw-alias-bg-layer-2', 0.15],
  ['--dsw-alias-bg-module-platform', '--dsw-alias-bg-layer-1', 0.20],
  ['--dsw-alias-markdown-code-block-banner', '--dsw-alias-markdown-code-block', 0.20],
];

/**
 * Translucent on purpose, so the frost step must leave them alone: these never host a line of text
 * the reader is meant to track, they tint or dim something already solid underneath.
 */
const FROST_EXEMPT = new Map([
  ['--dsw-alias-bg-skeleton', 'shimmer block: no text of its own'],
  ['--dsw-alias-bg-mask-1', 'modal scrim over the page'],
  ['--dsw-alias-interactive-bg-hover', 'hover wash over a surface'],
  ['--dsw-alias-interactive-bg-active', 'press wash over a surface'],
  ['--dsw-alias-interactive-bg-hover-accent', 'accent hover wash over a surface'],
  ['--dsw-specific-sidebar-nav-item-active', 'selection wash over the sidebar'],
  ['--dsw-specific-sidebar-nav-item-active-accent', 'selection accent wash over the sidebar'],
  ['--dsw-alias-scrollbar-bg-l1', 'scrollbar thumb tint'],
  ['--dsw-alias-scrollbar-hover-l1', 'scrollbar thumb hover tint'],
  ['--dsw-alias-scrollbar-bg-l2', 'elevated scrollbar thumb tint'],
  ['--dsw-alias-scrollbar-hover-l2', 'elevated scrollbar hover tint'],
  ['--dsw-alias-turn-trigger-bg-hover', 'hover wash over the turn trigger row'],
  ['--dsw-alias-interactive-bg-hover-danger', 'danger hover wash over a surface'],
  ['--dsw-alias-button-tool-bar-fill', 'icon toolbar over media, hosts no text'],
  ['--dsw-alias-button-tool-bar-hover', 'icon toolbar hover over media'],
  ['--dsw-alias-bg-document-selection', 'text-selection wash over the document canvas'],
]);

/** The lowest alpha a value can present — one per colour stop, gradients included. */
function lowestAlpha(modes) {
  const alphas = [];
  for (const mode of ['light', 'dark']) {
    const value = modes?.[mode];
    if (typeof value !== 'string') continue;
    const direct = parseColor(value);
    if (direct) { alphas.push(direct.alpha); continue; }
    for (const match of value.matchAll(COLOR_TOKEN)) {
      const parsed = parseColor(match[0]);
      if (parsed) alphas.push(parsed.alpha);
    }
  }
  return alphas.length > 0 ? Math.min(...alphas) : null;
}

/** Whether every slot a token reaches paints a surface, rather than a stroke, shadow or filter. */
function paintsSurface(name) {
  const sites = paintSites(name);
  if (sites.length === 0) return false;
  return sites.every(site => /^background(-(color|image))?$/.test(site.property.trim()));
}

/** How much of what sits behind survives both translucent layers, worst stop of each. */
function surfaceTransmission(tokens, top, backing, mode) {
  const pair = [tokens[top], tokens[backing]];
  if (pair.some(modes => !modes)) return null;
  const [upper, lower] = pair.map(modes => lowestAlpha({ light: modes[mode], dark: modes[mode] }));
  if (upper === null || lower === null) return null;
  return (1 - upper) * (1 - lower);
}

/** The solid pixels a value can produce over one backing colour — one per gradient end stop. */
function flatten(value, backing) {
  const direct = parseColor(value);
  if (direct) return [over(direct, backing)];
  if (!GRADIENT.test(value)) return [];
  return [...value.matchAll(COLOR_TOKEN)]
    .map(match => over(parseColor(match[0]), backing))
    .filter(Boolean);
}

/**
 * The colours one label token can present in one mode. This package paints the ink of the notices
 * it re-themes, so a label token the layer writes is read from the layer; every other label keeps
 * the built-in theme's value. A gradient contributes each of its stops.
 */
function labelColors(label, mode, table, builtin) {
  if (label.startsWith('#')) {
    const parsed = parseColor(label);
    return parsed ? [parsed] : [];
  }
  const own = table[label]?.[mode];
  if (typeof own === 'string') {
    const direct = parseColor(own);
    if (direct) return [direct];
    const stops = [...own.matchAll(COLOR_TOKEN)].map(match => parseColor(match[0])).filter(Boolean);
    if (stops.length > 0) return stops;
  }
  const resolved = builtin.resolveValue(label);
  return resolved ? [resolved] : [];
}

/**
 * Variables that are not theme tokens: the component declares them on the element it paints, so
 * the body layer cannot reach them and this package reaches them through its compat stylesheet
 * instead. Each entry names where the app declares it and how it is reached.
 */
const COMPONENT_LOCAL = new Map([
  [
    '--dsw-hovercard-bg',
    'ui-primitives/HoverCard.module.css declares it on the card element (a fixed #2C2C2E); the compat stylesheet hands it back to the body layer with `--dsw-hovercard-bg: inherit`',
  ],
]);

/**
 * Variables this package owns end to end: the platform declares no such token, and nothing in
 * `packages/client` reads it — the rule that uses it lives in this package's compat stylesheet, and
 * the theme presenter writes it on the body like any other overridden token. Each entry names the
 * rule that consumes it.
 */
const PLUGIN_LOCAL = new Map([
  [
    '--dsw-material-selection',
    'the text-selection wash: the platform has no selection token, so this package writes its own and the compat stylesheet applies it to `::selection`',
  ],
]);

/** The class tokens a selector names, however the CSS modules hashed them. */
function selectorClasses(selector) {
  return [...(selector ?? '').matchAll(/\.(-?[_A-Za-z][\w-]*)/g)].map(match => match[1]);
}

const problems = [];
const seenProblems = new Set();
const notes = [];
const seenNotes = new Set();
const track = (level, message) => {
  if (seenProblems.has(message)) return;
  seenProblems.add(message);
  problems.push({ level, message });
};
const note = message => {
  if (seenNotes.has(message)) return;
  seenNotes.add(message);
  notes.push(message);
};

/** ui-theme's own value for a name, used as the ground truth for what the slot holds. */
function declaredKind(name) {
  const kinds = new Set((declared.get(name) ?? []).map(entry => valueKind(entry.value)));
  kinds.delete('var');
  if (kinds.has('color')) return 'color';
  return kinds.size === 1 ? [...kinds][0] : 'mixed';
}

/**
 * The component-local variables this package writes. They are not theme tokens, so the audit skips
 * ui-theme's declaration check for them — but the app must still mention them, and the compat
 * stylesheet that reaches them must still be there, or the layer paints nothing.
 */
for (const [name, where] of COMPONENT_LOCAL) {
  const declaredByComponent = (localRebinds.get(name) ?? []).length > 0;
  const readByComponent = (consumed.get(name) ?? []).length > 0;
  if (!declaredByComponent && !readByComponent) {
    track('P1', `${name}: the app no longer mentions it — the compat stylesheet has nothing to override, and the surface stays the built-in one`);
  } else if (!clientSource.includes('compatSheet')) {
    track('P1', `${name}: the layer writes it, but client.js has no compat stylesheet — the body value never reaches the element that paints it`);
  } else {
    note(`${name}: ${where}`);
  }
}

/**
 * The two notices re-themed through the compat stylesheet: the tooltip's ink and the toast's action
 * link are literal colours in the component, so the stylesheet has to hand them back to the theme.
 * A component that stops naming them means the stylesheet's rule for them no longer lands. The
 * tooltip and the toast are reached through the frosted-floaters list, so that list is the proof.
 */
for (const needle of ['--dsw-alias-tooltip-bg', '--dsw-alias-toast-bg']) {
  if ((FROSTED_FLOATERS ?? []).includes(needle)) continue;
  track('P1', `${needle}: client.js no longer reaches for it — the notice keeps the built-in ink`);
}
if (!clientSource.includes('var(--dsw-static-deepseek-400)')) {
  track('P1', "the toast's action link: client.js no longer reaches for `var(--dsw-static-deepseek-400)` — the notice keeps the built-in ink");
}

/**
 * The hover card's ink: the app names its parts in the CSS modules, and this package matches those
 * names to restore the hierarchy. A name that disappeared is not fatal — the card's own blanket rule
 * still gives every line inside it the theme's primary ink — but the hierarchy is gone with it.
 */
for (const entry of HOVER_CARD_INK) {
  const pattern = new RegExp(`(?:^|_)${entry.local}(?:_|$)`);
  const named = clientRules.some(rule => selectorClasses(rule.selector).some(token => pattern.test(token)));
  if (!named) {
    note(`hover card: the app no longer names a \`${entry.local}\` class — that line falls back to the primary ink`);
  }
}

/**
 * The selection colour and the frosted floaters live in the compat stylesheet, which is plain CSS
 * the tool cannot read as a stylesheet, so the client's own source is the only proof that the rules
 * are still there. A refactor that drops either rule brings the browser's hard blue selection and
 * the see-through quote button back, and neither of them shows up in a token audit.
 */
if (!/::selection\s*\{/.test(clientSource)) {
  track('P1', 'client.js no longer styles `::selection` — the browser default blue comes back');
}
if (!clientSource.includes('var(--dsw-material-selection)')) {
  track('P1', 'client.js no longer applies the palette-owned selection wash — the browser default blue comes back');
}
if (!clientSource.includes('found.floaters')) {
  track('P1', "client.js no longer applies the material's blur to the discovered floaters — a see-through surface over text is only a film");
}
for (const name of FROSTED_FLOATERS ?? []) {
  const readers = (consumed.get(name) ?? []).filter(entry => !entry.property.startsWith('(chain)'));
  if (readers.length === 0) {
    track('P2', `the app no longer reads \`${name}\` — the frosted floaters name a surface that does not exist`);
  } else {
    note(`${name}: frosted by the compat stylesheet (${readers.length} paint site(s), e.g. ${shortPath(readers[0].path)}:${readers[0].line})`);
  }
}

/**
 * The composer takeover cards: the ask-user card, the plan review and the
 * approval takeover all replace the input card in the composer seat, float over
 * the transcript with a surface of their own, and need the material's blur. Each
 * card is found by what it declares — it paints the input surface, takes the
 * shared chat width and declares one signal of its own — so the app has to keep
 * declaring exactly that, and client.js has to keep looking for it.
 */
const TAKEOVER_SURFACE = '--dsw-specific-input-major';
const TAKEOVER_CARDS = [
  {
    what: 'the ask-user card and the plan review',
    signal: '--dsw-elevation-stroke-color',
    match: rule => rule.declarations.some(declaration => declaration.property === '--dsw-elevation-stroke-color'),
  },
  {
    what: 'the approval takeover',
    signal: 'var(--dsw-alias-state-warn-secondary)',
    match: rule => rule.declarations.some(declaration => declaration.value.includes('var(--dsw-alias-state-warn-secondary)')),
  },
];
const paintsInputSurface = rule =>
  rule.declarations.some(declaration => declaration.property === 'background' && declaration.value.includes(`var(${TAKEOVER_SURFACE})`))
  && rule.declarations.some(declaration => declaration.value.includes('var(--dsh-chat-content-width)'));
for (const card of TAKEOVER_CARDS) {
  const found = clientRules.some(rule => paintsInputSurface(rule) && card.match(rule));
  if (!found) {
    track('P1', `the app no longer ships ${card.what} — the compat stylesheet has no card to frost, and it stays a translucent film over the transcript`);
  } else {
    note(`${card.what}: frosted by the compat stylesheet (it paints the input surface, takes the chat width and declares ${card.signal})`);
  }
}
if (!clientSource.includes('TAKEOVER_CARDS')) {
  track('P1', 'client.js no longer discovers the composer takeover cards — they stay a translucent film over the transcript');
}

/**
 * The selection is the palette's own accent washed over the surface it sits on, with the theme's
 * own ink on top. The wash is what the compat stylesheet writes, so the tool can compose it exactly
 * and check the one thing that matters: the selected text still reads against its own highlight.
 */
for (const [preset, tokens] of Object.entries(MATERIALS)) {
  for (const mode of ['light', 'dark']) {
    const builtin = builtinTokens(mode);
    const canvas = builtin.resolveValue('--dsw-alias-bg-base');
    const wash = parseColor(tokens['--dsw-material-selection']?.[mode]);
    const ink = builtin.resolveValue('--dsw-alias-label-primary');
    if (!canvas || !wash || !ink) continue;
    const highlight = over(wash, canvas);
    const ratio = contrast(ink, highlight);
    const detail = `${ratio.toFixed(2)}:1 on ${rgbHex(highlight)}`;
    if (ratio < 4.5) {
      track('P0', `${preset} selection (${mode}): --dsw-alias-label-primary drops to ${detail} (AA body text needs 4.5:1)`);
    } else {
      note(`${preset} selection (${mode}): ${detail}`);
    }
  }
}

for (const [preset, tokens] of Object.entries(MATERIALS)) {
  if (!tokens['--dsw-material-selection']) {
    track('P1', `${preset}: no selection wash — the browser's hard blue selection comes back`);
  }
  for (const [name, modes] of Object.entries(tokens)) {
    if (typeof modes !== 'object' || modes === null || typeof modes.light !== 'string' || typeof modes.dark !== 'string') {
      track('P0', `${preset} ${name}: value is not a { light, dark } pair — the runtime throws at registration`);
      continue;
    }

    const declarations = declared.get(name) ?? [];
    if (declarations.length === 0) {
      if (!COMPONENT_LOCAL.has(name) && !PLUGIN_LOCAL.has(name)) {
        track('P1', `${preset} ${name}: ui-theme declares no such variable (typo, removed, or never existed)`);
      }
    } else if (declarations.some(entry => /(^|[\s,])body\s+\*|body \*/.test(entry.selector))) {
      track('P1', `${preset} ${name}: re-declared on \`body *\` (${declarations.map(d => d.selector).join(' | ')}) — a body-inline override cannot reach the element that consumes it`);
    }

    const sites = paintSites(name);
    if (sites.length === 0 && !PLUGIN_LOCAL.has(name)) {
      track('P2', `${preset} ${name}: nothing in packages/client reads it — the override paints nothing`);
    }
    if (name === '--dsw-material-selection' && PLUGIN_LOCAL.has(name)) {
      note(`${name}: ${PLUGIN_LOCAL.get(name)}`);
    }
    const rebinds = localRebinds.get(name) ?? [];
    if (rebinds.length > 0) {
      note(`${name}: ${rebinds.length} component rebind(s) shadow the body layer inside their own subtree, e.g. ${shortPath(rebinds[0].path)}:${rebinds[0].line} (${rebinds[0].selector})`);
    }

    for (const mode of ['light', 'dark']) {
      const value = modes[mode];
      const kind = valueKind(value);
      if (kind === 'other') {
        track('P1', `${preset} ${name} (${mode}): \`${value}\` is not a recognised value kind (ui-theme declares it as ${declaredKind(name)})`);
        continue;
      }
      for (const site of sites) {
        const accepted = ACCEPTS[classify(site.property)];
        if (accepted === null) continue;
        if (accepted.has(kind)) continue;
        const reached = site.via ? `\`${site.via}\` → ${site.property}` : site.property;
        track('P0', `${preset} ${name} (${mode}): ${kind} value lands in ${reached} at ${shortPath(site.path)}:${site.line} (${site.selector}) — invalid there, so the declaration falls back and the surface looks untouched`);
      }
    }
  }

  // Legibility: every fill we set must keep the labels that sit on it at AA. The frosted reading runs
  // through the same pass, because reduced transparency is how most Windows users will see this layer.
  const perMode = { light: builtinTokens('light'), dark: builtinTokens('dark') };
  const legibility = (variant, table) => {
    for (const mode of ['light', 'dark']) {
      const tokens2 = perMode[mode];
      const builtInCanvas = tokens2.resolveValue('--dsw-alias-bg-base');
      if (!builtInCanvas) continue;
      // The wash replaces the document canvas, so it becomes the backing for every layer above it.
      const canvases = flatten(table['--dsw-alias-bg-base']?.[mode] ?? `rgb(${builtInCanvas.rgb.join(',')})`, builtInCanvas);
      for (const [name, modes] of Object.entries(table)) {
        const value = modes[mode];
        if (SCRIM_TOKENS.has(name)) {
          notes.push(`${variant} ${name} (${mode}): scrim over content, alpha ${parseColor(value)?.alpha ?? 'n/a'} — no AA text check applies`);
          continue;
        }
        const pairing = TEXT_ON.find(entry => entry.surface.test(name));
        if (!pairing) continue;
        for (const label of pairing.labels) {
          let worst = null;
          for (const labelColor of labelColors(label, mode, table, tokens2)) {
            for (const canvas of canvases) {
              for (const surface of flatten(value, canvas)) {
                const ratio = contrast(over(labelColor, surface), surface);
                if (worst === null || ratio < worst.ratio) worst = { ratio, surface };
              }
            }
          }
          if (worst === null) continue;
          const detail = `${worst.ratio.toFixed(2)}:1 over ${rgbHex(worst.surface)}`;
          if (worst.ratio < 4.5) {
            track('P0', `${variant} ${name} (${mode}): ${label} drops to ${detail} (AA body text needs 4.5:1)`);
          } else {
            notes.push(`${variant} ${name} (${mode}) vs ${label}: worst ${detail}`);
          }
        }
      }
    }
  };
  legibility(preset, tokens);
  legibility(`${preset} frosted`, frostify(tokens));

  // The tuning sliders move every glass alpha, so AA is proved at both ends of their range as well.
  for (const [label, tuning] of [
    ['transparent', { opacity: 0, blurPx: 0, saturatePct: 0 }],
    ['dense', { opacity: 2, blurPx: 160, saturatePct: 400 }],
  ]) {
    const tuned = buildLayer(preset, tuning);
    if (tuned === null) continue;
    legibility(`${preset} ${label}`, tuned);
    legibility(`${preset} ${label} frosted`, frostify(tuned));
  }

  // Windows paints the caption bar from a probe div styled with `--dsw-specific-sidebar-fill`; whatever
  // the browser computes there is shipped to `setTitleBarOverlay`. A gradient is invalid in a
  // `background-color` slot, so the probe resolves to transparent and the caption goes clear — which is
  // why `captionSafe` flattens this one token on that platform. The symbol colour riding on the result
  // is `--dsw-alias-label-primary`, untouched by this layer, so it has to stay AA against it.
  for (const [variant, table] of [[preset, tokens], [`${preset} frosted`, frostify(tokens)]]) {
    const caption = captionSafe(table)['--dsw-specific-sidebar-fill'];
    if (!caption) {
      track('P1', `${variant}: --dsw-specific-sidebar-fill missing, so the Windows caption probe has nothing to read`);
      continue;
    }
    for (const mode of ['light', 'dark']) {
      const value = String(caption[mode] ?? '');
      if (/gradient\(/i.test(value)) {
        track('P0', `${variant} --dsw-specific-sidebar-fill (${mode}): captionSafe left a gradient in a background-color slot — the Windows title bar renders transparent`);
        continue;
      }
      const fill = parseColor(value);
      if (!fill) {
        track('P1', `${variant} --dsw-specific-sidebar-fill (${mode}): ${value || '<empty>'} is not a colour the caption probe can rasterise`);
        continue;
      }
      const canvas = perMode[mode].resolveValue('--dsw-alias-bg-base');
      const pixels = fill.alpha === 1 ? fill : over(fill, canvas ?? fill);
      const label = perMode[mode].resolveValue('--dsw-alias-label-primary');
      if (!label) continue;
      const ratio = contrast(over(label, pixels), pixels);
      const detail = `${ratio.toFixed(2)}:1, caption ${rgbHex(pixels)}`;
      if (ratio < 4.5) {
        track('P0', `${variant} Windows caption (${mode}): --dsw-alias-label-primary drops to ${detail} (AA text needs 4.5:1)`);
      } else {
        notes.push(`${variant} Windows caption (${mode}): ${detail}`);
      }
    }
  }

  // Stacking: a floating surface over a translucent panel lets the content behind show through twice.
  for (const [top, backing, limit] of STACKED_PAIRS) {
    for (const mode of ['light', 'dark']) {
      const transmission = surfaceTransmission(tokens, top, backing, mode);
      if (transmission === null) continue;
      const detail = `${(transmission * 100).toFixed(1)}% of the content behind reaches the eye (limit ${(limit * 100).toFixed(0)}%)`;
      if (transmission > limit) {
        track('P1', `${preset} ${top} over ${backing} (${mode}): ${detail} — two translucent surfaces stacked read as mush`);
      } else {
        notes.push(`${preset} ${top} over ${backing} (${mode}): ${detail}`);
      }
    }
  }

  // Reduced transparency: every glass surface must be classified, or the frost step misses it.
  for (const name of [...FROST_SURFACES, ...FROST_SOLID]) {
    if (!tokens[name]) track('P2', `${preset}: ${name} is listed in the frost step but the preset never writes it`);
  }
  for (const [name, modes] of Object.entries(tokens)) {
    const alpha = lowestAlpha(modes);
    if (alpha === null || alpha >= FROST_MIN_ALPHA) continue;
    if (!paintsSurface(name)) continue;
    if (FROST_BLUR.includes(name) || FROST_SURFACES.includes(name) || FROST_SOLID.includes(name) || FROST_EXEMPT.has(name)) continue;
    track('P1', `${preset} ${name}: translucent surface (${alpha.toFixed(2)}) in none of FROST_SURFACES, FROST_SOLID or FROST_EXEMPT — it stays glassy under prefers-reduced-transparency`);
  }
  for (const [name, modes] of Object.entries(tokens)) {
    const isFilter = [modes.light, modes.dark].some(value => /^(blur|saturate)\(/i.test(value.trim()));
    if (isFilter && !FROST_BLUR.includes(name)) {
      track('P1', `${preset} ${name}: writes a filter value but is not in FROST_BLUR — blur survives prefers-reduced-transparency`);
    }
  }
}

const order = { P0: 0, P1: 1, P2: 2 };
problems.sort((a, b) => order[a.level] - order[b.level]);
for (const problem of problems) console.log(`${problem.level} ${problem.message}`);
if (notes.length > 0 && process.env.QUIET !== '1') for (const note of notes) console.log(`· ${note}`);
console.log(`${problems.length} problem(s): ${problems.filter(p => p.level === 'P0').length} P0, ${problems.filter(p => p.level === 'P1').length} P1, ${problems.filter(p => p.level === 'P2').length} P2`);
process.exitCode = problems.some(p => p.level === 'P0' || p.level === 'P1') ? 1 : 0;
