#!/usr/bin/env node
/**
 * Visual harness for the material layer: drives the running `dsh web` through the presets in both
 * palettes and writes screenshots. Needs a token URL from `dsh web --no-open --port <port>`.
 *
 * Usage: node tools/capture-web.mjs <token-url> [out-dir] [path/to/deepseek-harness]
 *
 * Playwright comes from the dsh checkout because that is where the browser binaries live, and the
 * installed Chrome is used because that build's own chromium revision is not downloaded here.
 *
 * The switch lives in the sidebar `更多` panel, so every scenario pays one menu open plus one tab
 * click. Each scenario also uses a fresh context — a fresh page load — so the preset the panel
 * reports before anything is clicked is the one the Host entry served back, and durability is read
 * once per scenario instead of only at the end.
 *
 * The host OS reports `prefers-reduced-transparency: reduce`, and neither `newContext` nor
 * `emulateMedia` overrides that feature in this Chrome. By default the init script below stubs only
 * that one query so the shots show the translucent layer; `NOSTUB=1` keeps the real answer, which
 * is how to see the frosted degradation instead. Either way the expected painted values are derived
 * from `client.js` itself, so the check follows the same function the plugin runs.
 */
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [urlArg, outArg, repoArg] = process.argv.slice(2);
if (!urlArg) {
  console.error('usage: node tools/capture-web.mjs <token-url> [out-dir] [repo]');
  process.exit(2);
}
const REPO = resolve(repoArg ?? 'F:/AIZoo/deepseek-harness');
const OUT = resolve(outArg ?? '.shots');
mkdirSync(OUT, { recursive: true });

const requireFromRepo = createRequire(`${REPO}/apps/web/index.js`);
const { chromium } = requireFromRepo('playwright');

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const block = SOURCE.match(/\/\* __MATERIALS_START__ \*\/([\s\S]*?)\/\* __MATERIALS_END__ \*\//);
if (!block) {
  console.error('client.js has no MATERIALS marker block');
  process.exit(2);
}
const { MATERIALS, frostify } = new Function(`${block[1]}\nreturn { MATERIALS, frostify };`)();

const STUB = `(() => {
  const real = window.matchMedia.bind(window);
  window.matchMedia = (query) => {
    const text = String(query);
    if (!text.includes('reduced-transparency')) return real(text);
    return { media: text, matches: false, onchange: null,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
      dispatchEvent() { return false; } };
  };
})();`;

const PRESET_LABEL = {
  soft: '柔和', vivid: '玻璃', latte: '拿铁', rose: '玫瑰', sage: '鼠尾草', nord: '极地', solar: '日光',
  one: '简白', github: '墨白', flexoki: '纸墨', gruvbox: '暖阳', ayu: '晴空', kanagawa: '莲花', tokyo: '东京',
  flat: '原始',
};
const TAB_PREFIX = 'dsh-material-';
/** What paints. `bg-base` is the applied-signal; the rest show the layer's character on real surfaces. */
const PROBE_TOKENS = [
  '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-menu-surface-fill',
  '--dsw-specific-sidebar-fill', '--dsw-menu-backdrop-filter', '--dsw-mask-blur',
  '--dsw-alias-scrollbar-bg-l2', '--dsw-alias-border-l4',
];
/** Every name either preset writes — the layer is verified as a whole, not by sample. */
const ALL_TOKENS = [...new Set(Object.values(MATERIALS).flatMap(layer => Object.keys(layer)))];

/**
 * Surfaces the harness knows are on screen in every view, so a zero there means the override never
 * reached the element that reads it rather than that the page happened not to show that panel. The
 * per-view lists are the same claim for surfaces that only exist in one view.
 */
const ALWAYS_PAINT = ['--dsw-alias-bg-base', '--dsw-specific-sidebar-fill'];
const PAINT_BY_SURFACE = {
  panel: ['--dsw-alias-bg-layer-1', '--dsw-alias-button-elevated-fill'],
  chat: ['--dsw-specific-input-major', '--dsw-alias-border-l1', '--dsw-alias-bg-module-platform'],
  menu: ['--dsw-menu-surface-fill'],
  settings: ['--dsw-alias-bg-module-platform'],
  plugins: ['--dsw-alias-bg-module-platform'],
  trajectory: ['--dsw-alias-bg-layer-2'],
  guide: ['--dsw-alias-bg-layer-1', '--dsw-alias-border-l3'],
};

/**
 * A value as Chrome reports it in a computed style: lowercased, single-spaced, hex expanded to
 * `rgb()`, and alphas stripped of trailing zeros. Both sides of the paint comparison go through this.
 */
function cssSignature(value) {
  const text = String(value).trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(text);
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map(c => c + c) : hex[1];
    return `rgb(${[0, 2, 4].map(i => Number.parseInt(digits.slice(i, i + 2), 16)).join(', ')})`;
  }
  return text
    .replace(/\s+/g, ' ')
    .replace(/rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/g,
      (_, r, g, b, a) => `rgba(${Number(r)}, ${Number(g)}, ${Number(b)}, ${Number(a)})`)
    .replace(/rgb\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/g, (_, r, g, b) => `rgb(${Number(r)}, ${Number(g)}, ${Number(b)})`)
    // A filter token keeps its text as the custom-property value but not as a used value: Chrome
    // reports `saturate(200%)` as `saturate(2)`, so both sides have to be folded to the same form.
    .replace(/\b(saturate|brightness|contrast|opacity)\(\s*([\d.]+)%\s*\)/g, (_, fn, pct) => `${fn}(${Number(pct) / 100})`);
}

/** Where a token's colour can show up on one element. */
const PAINT_PROPERTIES = [
  'backgroundColor', 'backgroundImage', 'color', 'borderColor', 'outlineColor', 'boxShadow',
  'backdropFilter', 'fill', 'scrollbarColor', 'textDecorationColor',
];

/**
 * Which rules on the live page read a token, and whether the elements they select are present with
 * the layer's colour substituted in. `paint` alone cannot tell a hover-only surface from an override
 * that never reaches anything: this walks the same selectors the browser matched its rule on, so
 * `readers` counts rules and `live` counts rules whose selector matches something on screen now.
 * For a rule nothing on screen matches, a hidden stand-in element carrying the same classes and
 * attributes is measured instead, which separates "this view does not open that surface" from
 * "the body-inline value never reached the consumer".
 */
async function readReach(page, signatures, preset, mode) {
  return page.evaluate(({ sigs, props, vals }) => {
    const bare = selector => selector.replace(/::?[a-z-]+(\([^)]*\))?/gi, ' ').replace(/\s+/g, ' ').trim();
    const normalizeInline = text => text.replace(/\s+/g, ' ').trim();
    const rules = [];
    for (const sheet of document.styleSheets) {
      let list;
      try { list = sheet.cssRules; } catch { continue; }
      for (const rule of list) {
        const text = rule.cssText ?? '';
        if (!rule.selectorText || !text.includes('var(--dsw')) continue;
        rules.push({ selector: rule.selectorText, text });
      }
    }
    // Style the app never sees: an off-screen node carrying the consumer's own class + attributes.
    const holder = document.createElement('div');
    holder.setAttribute('aria-hidden', 'true');
    holder.style.cssText = 'position:fixed;left:-99999px;top:0;width:240px;height:48px';
    document.body.appendChild(holder);
    const ghosts = [];
    /**
     * Stand in for a consumer no captured view happens to mount (a diff row, a market card, a hover
     * state). Class, attribute and tag are enough for a CSS-module rule to apply, so this proves the
     * body-inline value reaches that consumer without depending on which page was reachable. Rules
     * with a combinator need real context and are reported as un-synthesizable instead of guessed.
     */
    const ghostFor = (selector) => {
      const flat = bare(selector);
      if (/[ >+~]/.test(flat)) return null;
      const tag = /^([a-z][a-z0-9-]*)/i.exec(flat);
      const element = document.createElement(tag ? tag[1] : 'div');
      for (const match of flat.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)) element.classList.add(match[1]);
      for (const match of flat.matchAll(/\[([A-Za-z-]+)(?:=["']?([^"'\]]*?)["']?)?\]/g)) {
        element.setAttribute(match[1], match[2] ?? '');
      }
      if (element.classList.length === 0) return null;
      holder.appendChild(element);
      ghosts.push(element);
      return element;
    };
    const paints = (element, groups) => {
      const computed = getComputedStyle(element);
      const style = props.map(property => String(computed[property] ?? '')).join(' | ');
      return groups.some(group => group.every(literal => style.includes(literal)));
    };
    const reach = {};
    for (const [name, groups] of Object.entries(sigs)) {
      const readers = rules.filter(rule => rule.text.includes(`var(${name}`));
      const accepts = vals[name] ?? [];
      let live = 0;
      let painted = 0;
      let ghosted = 0;
      let mounted = 0;
      let resolves = 0;
      // A custom property inherits, so an element a reading rule targets reports the layer's own text
      // even when the declaration it would feed is a pseudo-element (`::-webkit-scrollbar-thumb`) or
      // gated on interaction (`:hover`) and therefore absent from every computed style the probe can
      // read. Substitution is the reach proof for those; `paints` stays the visible-surface proof.
      const resolvesHere = (element) => {
        const got = String(getComputedStyle(element).getPropertyValue(name) ?? '').trim().toLowerCase();
        return got !== '' && accepts.some(accepted => accepted === got || accepted === normalizeInline(got));
      };
      for (const rule of readers) {
        let matched;
        try { matched = document.querySelectorAll(bare(rule.selector)); } catch { continue; }
        if (matched.length > 0) {
          live += 1;
          mounted += matched.length;
          let hit = false;
          for (const element of [...matched].slice(0, 40)) {
            if (!hit && resolvesHere(element)) { hit = true; resolves += 1; }
            if (paints(element, groups)) { hit = true; painted += 1; break; }
          }
          continue;
        }
        const ghost = ghostFor(rule.selector);
        if (ghost === null) continue;
        if (resolvesHere(ghost)) resolves += 1;
        if (paints(ghost, groups)) ghosted += 1;
      }
      reach[name] = { readers: readers.length, live, painted, ghosted, mounted, resolves };
    }
    holder.remove();
    return { rules: rules.length, ghosts: ghosts.length, reach };
  }, { sigs: signatures, vals: valuesFor(preset, mode), props: PAINT_PROPERTIES });
}

/**
 * Windows paints the desktop caption from this one token: the preload probes a div styled with
 * `background-color: var(--dsw-specific-sidebar-fill)` and ships the computed pixels to
 * `setTitleBarOverlay`. A gradient is invalid in that slot, so the client flattens the token only when
 * `data-platform` says win32. This probe flips the attribute on the live page and reads the pixels the
 * caption would get, twice around the flip — before proves web still carries the layer's gradient,
 * after proves the observer put it back.
 */
async function readCaption(page) {
  return page.evaluate(async () => {
    const settle = () => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 150)));
    });
    const read = () => {
      const probe = document.createElement('div');
      probe.style.setProperty('position', 'fixed');
      probe.style.setProperty('left', '-9999px');
      probe.style.setProperty('background-color', 'var(--dsw-specific-sidebar-fill)');
      document.body.append(probe);
      const computed = getComputedStyle(probe).backgroundColor;
      const token = getComputedStyle(document.body).getPropertyValue('--dsw-specific-sidebar-fill').trim();
      probe.remove();
      return { computed, token, platform: document.documentElement.dataset.platform ?? null };
    };
    const before = read();
    document.documentElement.dataset.platform = 'win32';
    await settle();
    const windows = read();
    delete document.documentElement.dataset.platform;
    await settle();
    const after = read();
    return { before, windows, after };
  });
}

/**
 * Two names are excluded from the element-count assertion after dispose. `bg-layer-1`'s soft value
 * `rgba(255, 255, 255, 0.70)` is also what the platform's own `--dsw-alias-bg-mask-drop` holds. And
 * with fourteen palettes the canvas list now contains near-whites like `#fafafa` (One, Ayu), which
 * ordinary built-in cards also paint; a walk hit cannot tell the two apart. The custom-property read
 * in `verify` (`bg-base=#fff` after dispose) remains the authority for both.
 */
const FLAT_EXCLUDED = new Set(['--dsw-alias-bg-layer-1', '--dsw-alias-bg-base']);

const COLOR_LITERAL = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi;

/**
 * The strings that must all appear in one element's computed style for the token to count as painted
 * there. A gradient contributes every stop, because Chrome rewrites the shorthand it was written in
 * but keeps the colours; a value with no colour in it (a blur) contributes its whole text.
 */
function signaturesOf(value) {
  const literals = [...String(value).matchAll(COLOR_LITERAL)].map(match => cssSignature(match[0]));
  return literals.length > 0 ? [...new Set(literals)] : [cssSignature(value)];
}

/**
 * Accepted spellings of the layer's own value per token, for the substitution read: the text as the
 * plugin wrote it plus the same text run through `cssSignature`, because Chrome echoes a custom
 * property back verbatim but not always with the same whitespace.
 */
function valuesFor(preset, mode) {
  const layers = preset === 'flat' ? Object.values(MATERIALS) : [expectedPreset(preset, mode)];
  const accepted = {};
  for (const layer of layers) {
    for (const [name, modes] of Object.entries(layer)) {
      const value = String(modes[mode]).trim().toLowerCase();
      (accepted[name] ??= []).push(...new Set([value, cssSignature(value)]));
    }
  }
  return accepted;
}
/**
 * Literal sets to look for, one per token. `flat` disposes the layer, so there the check runs against
 * every preset's value at once: no element on screen may carry anything this package could write.
 */
function signaturesFor(preset, mode) {
  const layers = preset === 'flat' ? Object.values(MATERIALS) : [expectedPreset(preset, mode)];
  const alternatives = {};
  for (const layer of layers) {
    for (const [name, modes] of Object.entries(layer)) (alternatives[name] ??= []).push(signaturesOf(modes[mode]));
  }
  return alternatives;
}

/** `ONLY=light/soft` keeps a single family while iterating, so a full pass is not needed to smoke-test one case. */
const ONLY = process.env.ONLY ?? '';
const FROSTED = process.env.NOSTUB === '1';
const SCENARIOS = [
  { mode: 'light', preset: 'soft', surface: 'panel' },
  { mode: 'light', preset: 'soft', surface: 'chat' },
  { mode: 'light', preset: 'soft', surface: 'guide' },
  { mode: 'light', preset: 'soft', surface: 'menu' },
  { mode: 'light', preset: 'soft', surface: 'settings' },
  { mode: 'light', preset: 'soft', surface: 'plugins' },
  { mode: 'light', preset: 'vivid', surface: 'chat' },
  { mode: 'light', preset: 'vivid', surface: 'menu' },
  { mode: 'light', preset: 'vivid', surface: 'trajectory' },
  { mode: 'light', preset: 'vivid', surface: 'settings' },
  { mode: 'light', preset: 'vivid', surface: 'plugins' },
  { mode: 'light', preset: 'latte', surface: 'chat' },
  { mode: 'light', preset: 'rose', surface: 'chat' },
  { mode: 'light', preset: 'sage', surface: 'chat' },
  { mode: 'light', preset: 'nord', surface: 'chat' },
  { mode: 'light', preset: 'solar', surface: 'chat' },
  { mode: 'light', preset: 'latte', surface: 'menu' },
  { mode: 'light', preset: 'solar', surface: 'menu' },
  { mode: 'light', preset: 'one', surface: 'chat' },
  { mode: 'light', preset: 'github', surface: 'chat' },
  { mode: 'light', preset: 'flexoki', surface: 'chat' },
  { mode: 'light', preset: 'gruvbox', surface: 'chat' },
  { mode: 'light', preset: 'ayu', surface: 'chat' },
  { mode: 'light', preset: 'kanagawa', surface: 'chat' },
  { mode: 'light', preset: 'tokyo', surface: 'chat' },
  { mode: 'light', preset: 'kanagawa', surface: 'menu' },
  { mode: 'light', preset: 'flat', surface: 'panel' },
  { mode: 'light', preset: 'flat', surface: 'chat' },
  { mode: 'dark', preset: 'soft', surface: 'panel' },
  { mode: 'dark', preset: 'soft', surface: 'chat' },
  { mode: 'dark', preset: 'vivid', surface: 'chat' },
  { mode: 'dark', preset: 'vivid', surface: 'menu' },
  { mode: 'dark', preset: 'soft', surface: 'trajectory' },
  { mode: 'dark', preset: 'flat', surface: 'chat' },
];

const TARGETS = ONLY === '' ? SCENARIOS : SCENARIOS.filter(s => `${s.mode}/${s.preset}/${s.surface}`.startsWith(ONLY));

/** The layer the plugin should be holding for this scenario, computed by the plugin's own code. */
function expectedPreset(preset, mode) {
  if (preset === 'flat') return null;
  const layer = MATERIALS[preset];
  return FROSTED ? frostify(layer) : layer;
}

function sameValue(declared, painted) {
  const flat = (s) => String(s).replace(/\s+/g, ' ').trim();
  return flat(declared) === flat(painted);
}

/** Which tab is selected, plus the lines the plugin writes about itself. Only meaningful while the panel is open. */
async function readPanelText(page) {
  return page.evaluate((prefix) => {
    const text = document.body.innerText;
    const tabs = [...document.querySelectorAll('[role="tab"]')]
      .filter(t => t.id.startsWith(prefix))
      .map(t => `${t.id.replace(prefix, '')}:${t.getAttribute('aria-selected') === 'true'}`);
    return {
      tabs,
      current: (text.match(/当前生效：(\S+)/) ?? [])[1] ?? null,
      frosted: text.includes('材质已加厚'),
      persistFailed: text.includes('未能保存'),
    };
  }, TAB_PREFIX);
}

/** What is painted right now, independent of which view is on screen, and how many elements carry it. */
async function readState(page, signatures) {
  return page.evaluate(({ names, sigs, props }) => {
    const style = getComputedStyle(document.body);
    const inline = document.body.getAttribute('style') ?? '';
    const counts = Object.fromEntries(names.map(name => [name, 0]));
    const nodes = document.querySelectorAll('body, body *');
    for (const element of nodes) {
      const computed = getComputedStyle(element);
      const painted = props.map(property => String(computed[property] ?? '')).join(' | ');
      if (!painted.trim()) continue;
      for (const [name, groups] of Object.entries(sigs)) {
        if (groups.some(group => group.every(literal => painted.includes(literal)))) counts[name] += 1;
      }
    }
    return {
      dark: document.body.dataset.dsDarkTheme ?? null,
      reduce: matchMedia('(prefers-reduced-transparency: reduce)').matches,
      composerFields: document.querySelectorAll('[contenteditable="true"], textarea').length,
      overlays: document.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"]').length,
      layerTokensInline: names.filter(n => inline.includes(n)).length,
      hasInline: inline.includes('--dsw-alias-bg-base'),
      canvas: style.backgroundColor,
      tokens: Object.fromEntries(names.map(n => [n, style.getPropertyValue(n).trim()])),
      paint: counts,
      elements: nodes.length,
    };
  }, { names: ALL_TOKENS, sigs: signatures, props: PAINT_PROPERTIES });
}

/** The Host `read` reply repaints shortly after first paint; acting before that races it. */
async function waitForTabs(page) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await page.locator(`#${TAB_PREFIX}soft`).count() > 0) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

/**
 * A chat view renders several `更多` buttons (session rows, message actions), so the sidebar one is
 * found by asking which of them opens the menu that carries this package's panel entry.
 */
async function openSidebarMore(page) {
  const candidates = page.getByRole('button', { name: '更多' });
  const count = await candidates.count();
  for (let at = 0; at < count; at += 1) {
    await candidates.nth(at).click();
    await page.waitForTimeout(450);
    if (await page.getByRole('menuitem', { name: /材质|Material/ }).count() > 0) return true;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
  return false;
}

async function openPanel(page) {
  if (!await openSidebarMore(page)) throw new Error('no 更多 button opened the panel list');
  await page.getByRole('menuitem', { name: /材质|Material/ }).first().click();
  if (!await waitForTabs(page)) throw new Error('the panel did not render its segmented control');
}

/** Click the preset tab, then wait until the panel itself reports that preset as in force. */
async function selectPreset(page, preset) {
  const before = await readPanelText(page);
  if (before.current === PRESET_LABEL[preset]) return before;
  await page.locator(`#${TAB_PREFIX}${preset}`).click();
  for (let tick = 0; tick < 30; tick += 1) {
    await page.waitForTimeout(200);
    const now = await readPanelText(page);
    if (now.current === PRESET_LABEL[preset]) return now;
  }
  const stuck = await readPanelText(page);
  throw new Error(`could not reach preset ${preset} (panel says "${stuck.current}", tabs ${stuck.tabs.join(',')})`);
}

/** The only way out of a panel is to select content: the host exposes no back or close affordance. */
async function leaveToChat(page) {
  // An existing session already carries a transcript, so nothing is sent and no turn is spent. The
  // sidebar list is virtualised and its relative timestamps disappear as rows age, so a row that no
  // longer matches the time pattern is not a failure: any session row will do.
  const rows = page.locator('[role="treeitem"]');
  const timed = rows.filter({ hasText: /(分钟|小时|天|周)/ }).first();
  const target = (await timed.count()) > 0 ? timed : rows.first();
  try {
    await target.click({ timeout: 10_000 });
  } catch {
    await target.click({ timeout: 10_000, force: true });
  }
  // A fresh profile has sessions but no transcript yet; the composer is enough to prove the chat view.
  await page.waitForSelector('[class*="markdown"], [class*="bubble"], [contenteditable="true"]', { timeout: 45_000 });
  await page.evaluate(() => document.querySelector('[class*="markdown"]')?.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(1_200);
}

async function openSurface(page, surface) {
  if (surface === 'panel') {
    await page.waitForTimeout(300);
    return;
  }
  await leaveToChat(page);
  if (surface === 'menu') {
    if (!await openSidebarMore(page)) throw new Error('the sidebar 更多 menu did not open');
    return;
  }
  if (surface === 'settings' || surface === 'plugins') {
    // Settings is the densest ordinary view: cards, fields, segmented tracks, switches. The shell is
    // a modal opened by the `settings.open` chord (Ctrl+Alt+Comma on web/Windows), not a 更多 menu
    // row, and the section list is plain buttons. `内置插件` is the plugin manager page, which is the
    // heaviest reader of `--dsw-alias-bg-layer-3` (card fills, install field, badges).
    await page.keyboard.press('Control+Alt+Comma');
    const dialog = page.locator('[data-shortcut-modal="settings"]');
    try {
      await dialog.waitFor({ state: 'attached', timeout: 10_000 });
    } catch {
      throw new Error('the settings chord did not open the settings dialog');
    }
    await page.waitForTimeout(700);
    const section = dialog.getByRole('button', { name: surface === 'settings' ? /通用设置|General/ : /内置插件|Plugin/ });
    if (await section.count() === 0) throw new Error(`the settings dialog offers no ${surface} section`);
    try {
      await section.first().click({ timeout: 8_000 });
    } catch {
      await section.first().evaluate(element => element.click());
    }
    await page.waitForTimeout(900);
    return;
  }
  if (surface === 'trajectory') {
    // ui-trajectory is the consumer that reads `--dsw-alias-bg-layer-1` through `box-shadow`, so this
    // is the view where a gradient in that name would have broken, and where translucent solids show.
    const tab = page.getByRole('tab', { name: /轨迹/ });
    if (await tab.count() > 0) await tab.first().click();
    else await page.getByRole('button', { name: '轨迹' }).first().click();
    await page.waitForTimeout(1_500);
    return;
  }
  if (surface === 'guide') {
    // The guide capsules are plain buttons painted with `background: var(--dsw-alias-bg-layer-1)`;
    // they are the surface that read as plain white paper before the tinted-glass pass.
    await page.keyboard.press('Control+Shift+B');
    await page.waitForTimeout(1_500);
    return;
  }
}

function verify(scenario, panel, painted) {
  const problems = [];
  const expected = expectedPreset(scenario.preset, scenario.mode);
  if (panel.current !== PRESET_LABEL[scenario.preset]) problems.push(`panel says "${panel.current}"`);
  const selected = panel.tabs.filter(t => t.endsWith(':true'));
  if (selected.length !== 1 || !selected[0].startsWith(scenario.preset)) problems.push(`selected tabs ${selected.join(',') || 'none'}`);
  const must = [...ALWAYS_PAINT, ...(PAINT_BY_SURFACE[scenario.surface] ?? [])];
  const paintedBy = (name, source) => (source === 'walk' ? painted.paint[name] ?? 0 : painted.reach?.reach?.[name]?.painted ?? 0);
  const anywhere = name => paintedBy(name, 'walk') + paintedBy(name, 'reach') > 0;
  if (expected === null) {
    // `flat` disposes the layer, so no probed name may still paint a value this package declares.
    for (const [name, value] of Object.entries(painted.tokens)) {
      if (!value) continue;
      const claimed = Object.values(MATERIALS).some(layer => sameValue(layer[name]?.[scenario.mode] ?? '\n', value));
      if (claimed) problems.push(`${name} still paints a value (${value})`);
    }
    for (const name of must) {
      if (FLAT_EXCLUDED.has(name)) continue;
      if (anywhere(name)) problems.push(`${name} still reaches an element after dispose (${paintedBy(name, 'walk')} walked, ${paintedBy(name, 'reach')} by rule)`);
    }
  } else {
    for (const [name, value] of Object.entries(painted.tokens)) {
      if (expected[name] === undefined) continue;
      if (!sameValue(expected[name][scenario.mode], value)) problems.push(`${name} paints "${value}" not "${expected[name][scenario.mode]}"`);
    }
    if (!painted.hasInline) problems.push('no body-inline layer found');
    // A token the layer holds but no element on screen reads is a dead override, not a covered surface.
    for (const name of must) {
      if (!anywhere(name)) {
        const entry = painted.reach?.reach?.[name] ?? {};
        problems.push(`${name} paints no element on the ${scenario.surface} view (${entry.readers ?? '?'} rule(s) read it, ${entry.live ?? '?'} live, ${entry.resolves ?? '?'} carrying the layer's value)`);
      }
    }
  }
  // The Windows caption reads exactly one token through `background-color`, so it is checked on both
  // sides of the platform flip rather than assumed from the layer's text.
  const caption = painted.caption;
  if (!caption) {
    problems.push('caption probe did not run');
  } else if (expected === null) {
    for (const [label, reading] of [['web', caption.before], ['win32', caption.windows], ['restored', caption.after]]) {
      if (reading.token !== caption.before.token) problems.push(`flat ${label} caption token "${reading.token}" moved from "${caption.before.token}"`);
    }
  } else {
    if (caption.windows.platform !== 'win32' || caption.after.platform !== null) problems.push(`platform attribute not restored (windows=${caption.windows.platform}, after=${caption.after.platform})`);
    if (!painted.reduce && !/gradient\(/i.test(caption.before.token)) problems.push(`web sidebar-fill is "${caption.before.token}", not the layer's gradient`);
    if (/gradient\(/i.test(caption.windows.token)) problems.push(`win32 sidebar-fill still "${caption.windows.token}" — the caption probe computes it transparent`);
    else if (!/^(?:#[0-9a-f]{3,8}|rgba?\()/i.test(caption.windows.token)) problems.push(`win32 sidebar-fill "${caption.windows.token}" cannot be rasterised`);
    if (/rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*0\s*\)|^transparent$/i.test(caption.windows.computed)) problems.push(`win32 caption pixels are ${caption.windows.computed}`);
    if (caption.after.token !== caption.before.token) problems.push(`sidebar-fill not restored after leaving win32 ("${caption.after.token}")`);
  }
  // The panel only shows the degradation notice for a preset that actually has a layer.
  if (scenario.preset !== 'flat' && panel.frosted !== FROSTED) problems.push(`frosted notice=${panel.frosted} but the harness assumed ${FROSTED}`);
  return problems;
}

const browser = await chromium.launch({ channel: 'chrome' });
const results = [];
try {
  for (const scenario of TARGETS) {
    const context = await browser.newContext({
      viewport: { width: 1512, height: 950 },
      deviceScaleFactor: 2,
      colorScheme: scenario.mode,
    });
    const page = await context.newPage();
    const errors = [];
    const writes = [];
    const consoleLines = [];
    page.on('pageerror', error => errors.push(String(error.message)));
    page.on('console', (message) => {
      const text = message.text();
      if (message.type() === 'error' || message.type() === 'warning' || text.startsWith('DM-')) consoleLines.push(`${message.type()}: ${text}`.slice(0, 200));
    });
    // The POST reply is the ground truth for the durable write-back, independent of what the UI shows.
    page.on('response', async (response) => {
      if (!response.url().includes('/api/dsh-material')) return;
      writes.push(`${response.status()} ${await response.text().catch(() => '<unreadable>')}`);
    });
    // `NOSTUB=1` keeps the real OS answer, which is how to see the frosted degradation.
    if (process.env.NOSTUB !== '1') await page.addInitScript(STUB);
    // The client keeps a live socket, so `networkidle` never happens; the 更多 button is the real signal.
    await page.goto(urlArg, { waitUntil: 'domcontentloaded' });
    // A fresh profile opens the preview notice, then the login dialog; both sit above the app.
    // 继续 dismisses the notice; the login sheet is closed by its own X, because Escape leaves its
    // mask mounted and that mask keeps intercepting every click. Both can arrive late, so three
    // clean ticks 600ms apart are required before the app counts as interactive.
    for (let tick = 0, clean = 0; tick < 20 && clean < 3; tick += 1) {
      const notice = page.getByRole('button', { name: /^继续$|^Continue$/ });
      if (await notice.count() > 0) {
        await notice.first().click({ timeout: 5_000 }).catch(() => {});
        clean = 0;
        await page.waitForTimeout(500);
        continue;
      }
      const close = page.locator('[role="dialog"] button[aria-label="关闭"], [role="dialog"] button[aria-label="Close"]');
      if (await close.count() > 0) {
        await close.first().click({ timeout: 5_000 }).catch(() => {});
        clean = 0;
        await page.waitForTimeout(500);
        continue;
      }
      if (await page.locator('[role="dialog"]').count() > 0) {
        await page.keyboard.press('Escape').catch(() => {});
        clean = 0;
        await page.waitForTimeout(400);
        continue;
      }
      clean += 1;
      await page.waitForTimeout(600);
    }
    try {
      await page.getByRole('button', { name: '更多' }).waitFor({ timeout: 30_000 });
    } catch {
      errors.push('the sidebar 更多 button never appeared');
    }
    await page.waitForTimeout(800);
    let boot = null;
    let panel = { tabs: [], current: null, frosted: false, persistFailed: false };
    try {
      await openPanel(page);
      // Whatever the Host entry served back on this fresh load, before the scenario touches it.
      boot = await readPanelText(page);
    } catch (error) {
      errors.push(`panel open: ${String(error.message).split('\n')[0]}`);
    }
    try {
      panel = await selectPreset(page, scenario.preset);
    } catch (error) {
      // Keep going: a stuck control is itself a finding, and the shot below shows why.
      errors.push(String(error.message).split('\n')[0]);
      panel = await readPanelText(page);
    }
    // A previous run may have left tuning behind; every scenario is checked against the palette's
    // own design values, so the reset control is pressed before the surface is opened.
    try {
      const reset = page.getByRole('button', { name: /重置滑杆|Reset sliders/ });
      if (await reset.count() > 0 && await reset.first().isEnabled().catch(() => false)) {
        await reset.first().click({ timeout: 5_000 });
        await page.waitForTimeout(500);
      }
    } catch (error) {
      errors.push(`tuning reset: ${String(error.message).split('\n')[0]}`);
    }
    try {
      await openSurface(page, scenario.surface);
    } catch (error) {
      errors.push(`surface ${scenario.surface}: ${String(error.message).split('\n')[0]}`);
    }
    const signatures = signaturesFor(scenario.preset, scenario.mode);
    const state = await readState(page, signatures);
    try {
      state.reach = await readReach(page, signatures, scenario.preset, scenario.mode);
    } catch (error) {
      errors.push(`reach probe: ${String(error.message).split('\n')[0]}`);
    }
    try {
      state.caption = await readCaption(page);
    } catch (error) {
      errors.push(`caption probe: ${String(error.message).split('\n')[0]}`);
    }
    const problems = verify(scenario, panel, state);
    const file = `${OUT}/dsh-material-${scenario.mode}-${scenario.preset}-${scenario.surface}.png`;
    await page.screenshot({ path: file });
    results.push({ scenario, boot, panel, state, problems, writes, consoleLines, errors, file });
    await context.close();
  }
} finally {
  await browser.close();
  report(results);
}

function report(results) {
  for (const result of results) {
    const { mode, preset, surface } = result.scenario;
    const s = result.state;
    console.log(`${mode}/${preset}/${surface} boot-read="${result.boot?.current ?? '?'}" panel="${result.panel.current}" dark=${s.dark} reduce=${s.reduce} frosted=${result.panel.frosted} persistFailed=${result.panel.persistFailed} persist=${result.panel.persistFailed ? 'FAILED' : 'ok'} composer=${s.composerFields} overlays=${s.overlays} inline-layer=${s.hasInline ? 'on' : 'off'} canvas=${s.canvas}`);
    console.log(`  ${PROBE_TOKENS.map(k => `${k}=${(s.tokens[k] ?? '').slice(0, 52)}`).join(' | ')}`);
    const painted = Object.entries(s.paint ?? {}).filter(([, count]) => count > 0);
    const must = [...ALWAYS_PAINT, ...(PAINT_BY_SURFACE[surface] ?? [])];
    const core = must.map(name => `${name.replace('--dsw-alias-', '').replace('--dsw-', '')}=${s.paint[name] ?? 0}/${s.reach?.reach?.[name]?.painted ?? 0}`).join(', ');
    console.log(`  paint ${painted.length}/${ALL_TOKENS.length} token(s) over ${s.elements} node(s), ${s.reach?.rules ?? 0} themed rule(s) scanned; core ${core}`);
    if (s.caption) {
      const { before, windows, after } = s.caption;
      console.log(`  caption web="${before.token.slice(0, 44)}" win32="${windows.token.slice(0, 44)}" pixels=${windows.computed} restored=${after.token === before.token}`);
    }
    if (preset === 'flat' && painted.length > 0) {
      console.log(`  flat hits (a value this package could write, found on screen): ${painted.map(([name, count]) => `${name}=${count}`).join(', ')}`);
    }
    if (result.problems.length > 0) console.log(`  MISMATCH ${result.problems.join(' ; ')}`);
    if (result.errors.length > 0) console.log(`  ! ${result.errors.join(' ; ')}`);
    for (const write of result.writes) console.log(`  write-back: ${write}`);
    for (const line of result.consoleLines.slice(0, 12)) console.log(`  console: ${line}`);
    console.log(`  ${result.file}`);
  }
  const dirty = results.filter(r => r.problems.length > 0 || r.errors.length > 0);
  console.log(`\n${results.length} scenario(s), ${dirty.length} with findings.`);

  // Light-mode coverage table: how many rules read each token, how many of them match a live element,
  // whether the layer's own colour shows up there, and how many consumers only mount in a view this
  // run could not open but pick the colour up on a stood-in element. `readers: 0` means the sheet has
  // not loaded the chunk that reads it (document preview, market page) rather than a dead name.
  const best = new Map();
  for (const result of results) {
    if (result.scenario.mode !== 'light' || result.scenario.preset === 'flat') continue;
    for (const name of ALL_TOKENS) {
      const entry = result.state.reach?.reach?.[name] ?? { readers: 0, live: 0, painted: 0, ghosted: 0, resolves: 0 };
      const painted = Math.max(entry.painted, result.state.paint?.[name] ?? 0);
      const seen = best.get(name) ?? { readers: 0, live: 0, painted: 0, ghosted: 0, resolves: 0 };
      best.set(name, {
        readers: Math.max(seen.readers, entry.readers),
        live: Math.max(seen.live, entry.live),
        painted: Math.max(seen.painted, painted),
        ghosted: Math.max(seen.ghosted, entry.ghosted ?? 0),
        resolves: Math.max(seen.resolves, entry.resolves ?? 0),
      });
    }
  }
  const reaches = row => row.painted > 0 || row.ghosted > 0 || row.resolves > 0;
  const rows = [...best.entries()].sort((a, b) => b[1].painted - a[1].painted || b[1].resolves - a[1].resolves || b[1].ghosted - a[1].ghosted || b[1].live - a[1].live || a[0].localeCompare(b[0]));
  const covered = rows.filter(([, row]) => row.painted > 0).length;
  const reached = rows.filter(([, row]) => reaches(row)).length;
  const views = results.filter(r => r.scenario.mode === 'light' && r.scenario.preset !== 'flat').length;
  console.log(`\nlight-mode coverage across ${views} view(s): ${covered}/${ALL_TOKENS.length} token(s) show their own colour on a live element, ${reached}/${ALL_TOKENS.length} reach a consumer once stood-in elements and property substitution count.`);
  for (const [name, row] of rows) {
    console.log(`  ${reaches(row) ? ' ' : '!'} ${String(row.readers).padStart(3)} rule(s) ${String(row.live).padStart(3)} live ${String(row.painted).padStart(3)} painted ${String(row.resolves).padStart(3)} resolves ${String(row.ghosted).padStart(3)} stood-in  ${name}`);
  }
}
