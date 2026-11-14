/**
 * dsh-material — a MATERIAL layer (gradients, translucency, blur) over dsh's built-in palettes.
 *
 * It never registers a theme id and never writes the Appearance preference: it stacks one
 * `ctx.theme.overrideTokens` layer over whatever the user already chose, so `light`, `dark` and
 * `system` keep working and every value supplies both modes. `flat` disposes the layer and the
 * built-in sheets show through untouched.
 *
 * Every token written here is an alias. The platform's derived `--dsh-scrollbar-thumb` and
 * `--dsw-elevation-stroke-color` are rebound by elevated surfaces to the alias behind them, so a
 * body-inline value for those is shadowed inside exactly the subtrees that matter; `tools/check-materials.mjs`
 * proves which names a body override can reach.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-material',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useState } = React;
    const { IconSparkleRegular, MenuItemButton, Pill, Switch } = require('@deepseek-ai/dsh-client-ui-primitives');

    const NS = 'local-dsh-material';
    const RPC_METHOD = 'dsh-material';
    const PANEL_ID = 'dsh-material';
    /** One override layer per source identity; re-calling replaces this package's whole layer. */
    const SOURCE = '@local/dsh-material';
    const DEFAULT_PRESET = 'soft';
    /** Hand-tuned palettes first, then the recoloured ones, then the layer-off choice. */
    const PRESET_ORDER = [
      'soft', 'vivid', 'latte', 'rose', 'sage', 'nord', 'solar',
      'one', 'github', 'flexoki', 'gruvbox', 'ayu', 'kanagawa', 'tokyo', 'flat',
    ];

    /* __MATERIALS_START__ */
    /**
     * Every token here is one `tools/check-materials.mjs` has proven reachable from a body-inline
     * override and safe for the value kind written. Three platform facts decide the shape of the layer:
     * the document canvas (`--dsw-alias-bg-base`) is read by `background-color`, so it takes a solid
     * tint and the wash lives on the surfaces above it; `--dsw-alias-bg-layer-1/-2` also feed
     * `box-shadow` in ui-trajectory, so panels stay translucent solids; gradients go where only
     * `background`/`background-image` reads them — sidebar, menus, overlays, composer, bubble.
     *
     * Most names are aliases, but the file cards read ui-theme's *static* palette directly
     * (`--dsw-static-neutral-50/-100/-850/-800`). Those are declared on `body` too, so a body-inline
     * value reaches them just as well; they are written here because no alias stands in front of
     * them, and a card that keeps the built-in #fafafa reads as paper white on a tinted canvas.
     */
    const HAND_TUNED = {
      /** Cool wash, hairline rim, frosted menus and composer. */
      soft: {
        '--dsw-alias-bg-base': { light: '#f4f6fb', dark: '#12141a' },
        '--dsw-alias-bg-layer-1': { light: 'rgba(250, 252, 255, 0.55)', dark: 'rgba(33, 38, 51, 0.62)' },
        '--dsw-alias-bg-layer-2': { light: 'rgba(250, 252, 255, 0.72)', dark: 'rgba(42, 48, 64, 0.76)' },
        '--dsw-alias-bg-overlay': {
          light: 'linear-gradient(168deg, rgba(252, 253, 255, 0.94) 0%, rgba(242, 246, 253, 0.88) 100%)',
          dark: 'linear-gradient(168deg, rgba(37, 42, 57, 0.94) 0%, rgba(26, 30, 41, 0.92) 100%)',
        },
        '--dsw-specific-sidebar-fill': {
          light: 'linear-gradient(175deg, rgba(236, 241, 251, 0.82) 0%, rgba(228, 235, 249, 0.92) 100%)',
          dark: 'linear-gradient(175deg, rgba(24, 28, 38, 0.72) 0%, rgba(18, 21, 29, 0.80) 100%)',
        },
        '--dsw-menu-surface-fill': {
          light: 'linear-gradient(180deg, rgba(250, 252, 255, 0.74) 0%, rgba(241, 245, 252, 0.68) 100%)',
          dark: 'linear-gradient(180deg, rgba(50, 55, 68, 0.66) 0%, rgba(40, 44, 56, 0.62) 100%)',
        },
        '--dsw-specific-input-major': {
          light: 'linear-gradient(180deg, rgba(252, 253, 255, 0.82) 0%, rgba(246, 249, 254, 0.74) 100%)',
          dark: 'linear-gradient(180deg, rgba(40, 45, 60, 0.80) 0%, rgba(32, 36, 49, 0.74) 100%)',
        },
        '--dsw-specific-bubble': {
          light: 'linear-gradient(170deg, rgba(240, 245, 253, 0.95) 0%, rgba(232, 240, 252, 0.90) 100%)',
          dark: 'linear-gradient(170deg, rgba(36, 42, 58, 0.92) 0%, rgba(30, 35, 49, 0.88) 100%)',
        },
        '--dsw-specific-selector': {
          light: 'linear-gradient(180deg, rgba(238, 242, 250, 0.90) 0%, rgba(231, 237, 249, 0.86) 100%)',
          dark: 'linear-gradient(180deg, rgba(34, 39, 53, 0.88) 0%, rgba(27, 31, 43, 0.86) 100%)',
        },
        '--dsw-alias-bg-skeleton': {
          light: 'linear-gradient(100deg, rgba(0, 0, 0, 0.03) 0%, rgba(60, 90, 170, 0.07) 50%, rgba(0, 0, 0, 0.03) 100%)',
          dark: 'linear-gradient(100deg, rgba(255, 255, 255, 0.05) 0%, rgba(150, 180, 255, 0.10) 50%, rgba(255, 255, 255, 0.05) 100%)',
        },
        '--dsw-alias-border-l1': { light: 'rgba(38, 54, 92, 0.08)', dark: 'rgba(255, 255, 255, 0.09)' },
        '--dsw-alias-border-l2': { light: 'rgba(38, 54, 92, 0.14)', dark: 'rgba(255, 255, 255, 0.16)' },
        '--dsw-alias-border-l3': { light: 'rgba(38, 54, 92, 0.18)', dark: 'rgba(255, 255, 255, 0.15)' },
        '--dsw-alias-border-l4': { light: 'rgba(38, 54, 92, 0.24)', dark: 'rgba(255, 255, 255, 0.20)' },
        '--dsw-alias-interactive-bg-hover': { light: 'rgba(60, 90, 170, 0.09)', dark: 'rgba(150, 180, 255, 0.12)' },
        '--dsw-alias-interactive-bg-active': { light: 'rgba(60, 90, 170, 0.16)', dark: 'rgba(150, 180, 255, 0.20)' },
        '--dsw-alias-interactive-bg-hover-accent': { light: 'rgba(60, 90, 170, 0.14)', dark: 'rgba(150, 180, 255, 0.22)' },
        /**
         * The text selection. The browser's own selection is a hard, fully saturated blue that belongs
         * to no palette here, so it reads as a system artefact dropped on top of the material rather
         * than as part of it. This is the palette's own accent washed over whatever is selected, so
         * the selection stays in the colour family — and because the recolour step maps this exact
         * accent pair, the twelve derived palettes carry their own hue for free.
         *
         * It is the one token here that the platform does not know: nothing in `packages/client`
         * reads it, because the rule that uses it lives in this package's compat stylesheet.
         */
        '--dsw-material-selection': { light: 'rgba(60, 90, 170, 0.34)', dark: 'rgba(150, 180, 255, 0.36)' },
        '--dsw-specific-sidebar-nav-item-active': { light: 'rgba(60, 90, 170, 0.13)', dark: 'rgba(150, 180, 255, 0.14)' },
        '--dsw-specific-sidebar-nav-item-active-accent': { light: 'rgba(60, 90, 170, 0.10)', dark: 'rgba(150, 180, 255, 0.12)' },
        '--dsw-menu-backdrop-filter': { light: 'blur(34px) saturate(180%)', dark: 'blur(34px) saturate(170%)' },
        '--dsw-alias-scrollbar-bg-l1': { light: 'rgba(60, 90, 170, 0.22)', dark: 'rgba(150, 180, 255, 0.22)' },
        '--dsw-alias-scrollbar-hover-l1': { light: 'rgba(60, 90, 170, 0.38)', dark: 'rgba(150, 180, 255, 0.40)' },
        '--dsw-alias-scrollbar-bg-l2': { light: 'rgba(60, 90, 170, 0.28)', dark: 'rgba(150, 180, 255, 0.28)' },
        '--dsw-alias-scrollbar-hover-l2': { light: 'rgba(60, 90, 170, 0.46)', dark: 'rgba(150, 180, 255, 0.48)' },
        /**
         * The surfaces outside the panel shell. Each is here because `tools/check-materials.mjs`
         * found a real paint site a body-inline override reaches; the value kind follows the slot, so
         * the code block and the inline chip stay solid (`background-color` rejects a gradient) while
         * the tab track and the tag chip take one.
         */
        '--dsw-alias-bg-layer-3': { light: '#fafcff', dark: '#242b39' },
        /**
         * The file cards are the one family the alias layer cannot reach: `ui-deliverables`,
         * `ui-plan` and `ui-schedule` paint `--dsw-static-neutral-50` (light) / `-850` (dark)
         * directly and their hover state reads `-100` / `-800`. Those four names are declared on
         * `body` in ui-theme's design platform, so a body-inline value does reach them — but they
         * are not aliases, so a layer that only writes `--dsw-alias-*` leaves the delivery cards,
         * the changed-files header band, the plan card and the schedule card as built-in paper
         * white (#fafafa) on top of a tinted canvas. The values mirror the material's own card
         * glass (`bg-layer-2`), so those cards read like every other card in the UI.
         */
        '--dsw-static-neutral-50': { light: 'rgba(250, 252, 255, 0.72)', dark: 'rgba(42, 48, 64, 0.76)' },
        '--dsw-static-neutral-100': { light: 'rgba(250, 252, 255, 0.86)', dark: 'rgba(52, 58, 76, 0.88)' },
        '--dsw-static-neutral-850': { light: 'rgba(250, 252, 255, 0.72)', dark: 'rgba(42, 48, 64, 0.76)' },
        '--dsw-static-neutral-800': { light: 'rgba(250, 252, 255, 0.86)', dark: 'rgba(52, 58, 76, 0.88)' },
        /**
         * The Sidebar session hover card is the one floating surface the body layer cannot reach on
         * its own: `ui-primitives`' HoverCard declares `--dsw-hovercard-bg: #2C2C2E` on the card
         * element itself, and an element's own declaration beats every inherited value, so the card
         * ignores the token written here until the compat stylesheet hands the decision back to the
         * body (`--dsw-hovercard-bg: inherit`). The value mirrors the material's own card glass
         * (`bg-layer-2`), so the card reads like every other card instead of a black slab.
         */
        '--dsw-hovercard-bg': { light: 'rgba(250, 252, 255, 0.72)', dark: 'rgba(42, 48, 64, 0.76)' },
        '--dsw-alias-bg-module-platform': {
          light: 'linear-gradient(180deg, rgba(234, 240, 250, 0.86) 0%, rgba(227, 235, 248, 0.80) 100%)',
          dark: 'linear-gradient(180deg, rgba(31, 36, 49, 0.84) 0%, rgba(25, 29, 40, 0.80) 100%)',
        },
        '--dsw-alias-interactive-bg-hover-solid': { light: '#eaeff8', dark: '#232838' },
        '--dsw-alias-markdown-code-block': { light: '#f2f6fc', dark: '#161a22' },
        '--dsw-alias-markdown-code-block-banner': {
          light: 'linear-gradient(180deg, rgba(247, 250, 254, 0.94) 0%, rgba(240, 245, 252, 0.90) 100%)',
          dark: 'linear-gradient(180deg, rgba(30, 35, 47, 0.92) 0%, rgba(24, 28, 38, 0.88) 100%)',
        },
        '--dsw-alias-markdown-inline-code': { light: 'rgba(60, 90, 170, 0.07)', dark: 'rgba(150, 180, 255, 0.10)' },
        '--dsw-alias-markdown-tag': {
          light: 'linear-gradient(180deg, rgba(232, 238, 250, 0.88) 0%, rgba(226, 234, 248, 0.82) 100%)',
          dark: 'linear-gradient(180deg, rgba(38, 44, 60, 0.86) 0%, rgba(31, 36, 50, 0.82) 100%)',
        },
        '--dsw-alias-turn-trigger-bg': {
          light: 'linear-gradient(180deg, rgba(242, 246, 252, 0.92) 0%, rgba(235, 241, 250, 0.88) 100%)',
          dark: 'linear-gradient(180deg, rgba(32, 37, 50, 0.90) 0%, rgba(26, 30, 41, 0.86) 100%)',
        },
        '--dsw-alias-turn-trigger-bg-hover': { light: 'rgba(60, 90, 170, 0.10)', dark: 'rgba(150, 180, 255, 0.18)' },
        '--dsw-alias-menu-group-header-fill': { light: 'rgba(243, 246, 252, 0.92)', dark: 'rgba(43, 48, 62, 0.92)' },
        '--dsw-alias-button-elevated-fill': { light: 'rgba(250, 252, 255, 0.72)', dark: 'rgba(46, 52, 68, 0.78)' },
        '--dsw-alias-button-floating-fill': { light: 'rgba(250, 252, 255, 0.78)', dark: 'rgba(50, 56, 74, 0.80)' },
        '--dsw-alias-button-floating-hover': { light: 'rgba(244, 247, 254, 0.84)', dark: 'rgba(60, 67, 88, 0.84)' },
        '--dsw-alias-button-ghost-active-fill': { light: 'rgba(60, 90, 170, 0.13)', dark: 'rgba(150, 180, 255, 0.16)' },
        '--dsw-alias-button-contrast-fill': { light: '#39424f', dark: '#cfd6e6' },
        '--dsw-alias-button-info-fill': { light: '#3f6cc4', dark: '#8ab8ff' },
        '--dsw-alias-button-info-hover': { light: '#315aa8', dark: '#6aa0f0' },
        /**
         * The floating notices follow the theme. The platform paints the tooltip in a fixed dark
         * chip (`--dsw-static-neutral-bluish-850`) and the toast in a fixed dark banner, so a light
         * palette used to carry two black islands; here the light palette gets a light glass chip
         * and the theme's own ink, and the dark palette keeps its dark glass. The tooltip's ink is
         * a literal white in `ui-primitives` and the toast's action link a literal deepseek-400,
         * so the compat stylesheet hands both back to the theme — see `compatSheet`.
         */
        '--dsw-alias-tooltip-bg': { light: 'rgba(252, 253, 255, 0.94)', dark: 'rgba(44, 51, 69, 0.96)' },
        '--dsw-alias-tooltip-key-bg': { light: 'rgba(38, 54, 92, 0.12)', dark: 'rgba(59, 68, 96, 0.90)' },
        '--dsw-alias-toast-bg': { light: 'rgba(252, 253, 255, 0.96)', dark: 'rgba(51, 59, 83, 0.96)' },
        '--dsw-alias-toast-label': { light: 'rgb(38, 54, 92)', dark: 'rgb(255, 255, 255)' },
        '--dsw-alias-bg-document-preview': {
          light: 'linear-gradient(180deg, #f7f9fd 0%, #eef2f9 100%)',
          dark: 'linear-gradient(180deg, #191d26 0%, #12151c 100%)',
        },
        '--dsw-alias-bg-document-selection': { light: 'rgba(60, 90, 170, 0.22)', dark: 'rgba(150, 180, 255, 0.26)' },
        /** Status and diff fills keep their semantic hue and only gain the wash, at the platform's own lightness. */
        '--dsw-alias-state-business-tertiary': { light: 'rgba(65, 118, 230, 0.10)', dark: 'rgba(122, 170, 255, 0.13)' },
        '--dsw-alias-state-success-tertiary': { light: 'rgba(34, 197, 94, 0.10)', dark: 'rgba(65, 201, 119, 0.13)' },
        '--dsw-alias-state-warn-tertiary': { light: 'rgba(217, 119, 6, 0.10)', dark: 'rgba(250, 176, 80, 0.13)' },
        '--dsw-alias-code-diff-added': { light: 'rgba(34, 197, 94, 0.10)', dark: 'rgba(65, 201, 119, 0.12)' },
        '--dsw-alias-code-diff-deleted': { light: 'rgba(236, 19, 19, 0.09)', dark: 'rgba(250, 66, 62, 0.12)' },
        '--dsw-alias-file-diff-added-bg': { light: 'rgba(34, 197, 94, 0.11)', dark: 'rgba(65, 201, 119, 0.13)' },
        '--dsw-alias-file-diff-added-gutter': { light: 'rgba(34, 197, 94, 0.07)', dark: 'rgba(65, 201, 119, 0.09)' },
        '--dsw-alias-file-diff-deleted-bg': { light: 'rgba(236, 19, 19, 0.10)', dark: 'rgba(250, 66, 62, 0.13)' },
        '--dsw-alias-file-diff-deleted-gutter': { light: 'rgba(236, 19, 19, 0.06)', dark: 'rgba(250, 66, 62, 0.09)' },
        '--dsw-alias-interactive-bg-hover-danger': { light: 'rgba(236, 19, 19, 0.07)', dark: 'rgba(250, 66, 62, 0.10)' },
        '--dsw-alias-button-tool-bar-fill': { light: 'rgba(31, 38, 54, 0.52)', dark: 'rgba(31, 38, 54, 0.56)' },
        '--dsw-alias-button-tool-bar-hover': { light: 'rgba(31, 38, 54, 0.64)', dark: 'rgba(31, 38, 54, 0.68)' },
        '--dsw-shadow-lv2': {
          light: '0 4px 14px 0 rgba(28, 40, 72, 0.05), 0 2px 8px 0 rgba(28, 40, 72, 0.07)',
          dark: '0 4px 14px 0 rgba(0, 0, 0, 0.32), 0 2px 8px 0 rgba(0, 0, 0, 0.40)',
        },
        '--dsw-shadow-lv3': {
          light: '0 0 1px 0 rgba(28, 40, 72, 0.22), 0 0 4px 0 rgba(28, 40, 72, 0.04), 0 14px 34px 0 rgba(28, 40, 72, 0.10)',
          dark: '0 0 1px 0 rgba(0, 0, 0, 0.60), 0 0 6px 0 rgba(0, 0, 0, 0.24), 0 14px 34px 0 rgba(0, 0, 0, 0.48)',
        },
      },
      /** Thicker glass: violet-blue tint, blurred modal mask, saturated accents. */
      vivid: {
        '--dsw-alias-bg-base': { light: '#edf0fa', dark: '#101219' },
        '--dsw-alias-bg-layer-1': { light: 'rgba(255, 255, 255, 0.62)', dark: 'rgba(40, 38, 60, 0.58)' },
        '--dsw-alias-bg-layer-2': { light: 'rgba(255, 255, 255, 0.78)', dark: 'rgba(48, 45, 72, 0.74)' },
        '--dsw-alias-bg-overlay': {
          light: 'linear-gradient(165deg, rgba(255, 255, 255, 0.92) 0%, rgba(240, 238, 252, 0.86) 100%)',
          dark: 'linear-gradient(165deg, rgba(46, 42, 72, 0.92) 0%, rgba(26, 29, 46, 0.90) 100%)',
        },
        '--dsw-specific-sidebar-fill': {
          light: 'linear-gradient(170deg, rgba(226, 232, 250, 0.86) 0%, rgba(233, 228, 248, 0.90) 100%)',
          dark: 'linear-gradient(170deg, rgba(26, 25, 46, 0.70) 0%, rgba(15, 17, 27, 0.80) 100%)',
        },
        '--dsw-menu-surface-fill': {
          light: 'linear-gradient(180deg, rgba(253, 253, 255, 0.62) 0%, rgba(240, 238, 252, 0.58) 100%)',
          dark: 'linear-gradient(180deg, rgba(58, 53, 88, 0.60) 0%, rgba(40, 42, 62, 0.56) 100%)',
        },
        '--dsw-specific-input-major': {
          light: 'linear-gradient(180deg, rgba(255, 255, 255, 0.78) 0%, rgba(242, 240, 253, 0.70) 100%)',
          dark: 'linear-gradient(180deg, rgba(48, 44, 74, 0.76) 0%, rgba(32, 33, 52, 0.72) 100%)',
        },
        '--dsw-specific-bubble': {
          light: 'linear-gradient(170deg, rgba(235, 238, 253, 0.92) 0%, rgba(234, 228, 250, 0.88) 100%)',
          dark: 'linear-gradient(170deg, rgba(44, 41, 72, 0.88) 0%, rgba(32, 30, 52, 0.86) 100%)',
        },
        '--dsw-specific-selector': {
          light: 'linear-gradient(180deg, rgba(236, 238, 250, 0.88) 0%, rgba(228, 226, 246, 0.84) 100%)',
          dark: 'linear-gradient(180deg, rgba(44, 43, 68, 0.88) 0%, rgba(32, 33, 50, 0.86) 100%)',
        },
        '--dsw-alias-bg-skeleton': {
          light: 'linear-gradient(100deg, rgba(0, 0, 0, 0.03) 0%, rgba(96, 78, 214, 0.09) 50%, rgba(0, 0, 0, 0.03) 100%)',
          dark: 'linear-gradient(100deg, rgba(255, 255, 255, 0.05) 0%, rgba(168, 156, 255, 0.13) 50%, rgba(255, 255, 255, 0.05) 100%)',
        },
        '--dsw-alias-border-l1': { light: 'rgba(58, 52, 120, 0.11)', dark: 'rgba(190, 200, 255, 0.12)' },
        '--dsw-alias-border-l2': { light: 'rgba(58, 52, 120, 0.19)', dark: 'rgba(190, 200, 255, 0.22)' },
        '--dsw-alias-border-l3': { light: 'rgba(58, 52, 120, 0.24)', dark: 'rgba(190, 200, 255, 0.24)' },
        '--dsw-alias-border-l4': { light: 'rgba(58, 52, 120, 0.30)', dark: 'rgba(190, 200, 255, 0.30)' },
        '--dsw-alias-interactive-bg-hover': { light: 'rgba(96, 78, 214, 0.11)', dark: 'rgba(168, 156, 255, 0.14)' },
        '--dsw-alias-interactive-bg-active': { light: 'rgba(96, 78, 214, 0.19)', dark: 'rgba(168, 156, 255, 0.24)' },
        '--dsw-alias-interactive-bg-hover-accent': { light: 'rgba(96, 78, 214, 0.17)', dark: 'rgba(168, 156, 255, 0.26)' },
        '--dsw-specific-sidebar-nav-item-active': { light: 'rgba(96, 78, 214, 0.15)', dark: 'rgba(168, 156, 255, 0.16)' },
        '--dsw-specific-sidebar-nav-item-active-accent': { light: 'rgba(96, 78, 214, 0.12)', dark: 'rgba(168, 156, 255, 0.14)' },
        '--dsw-menu-backdrop-filter': { light: 'blur(46px) saturate(200%)', dark: 'blur(46px) saturate(190%)' },
        '--dsw-mask-blur': { light: 'blur(18px) saturate(150%)', dark: 'blur(18px) saturate(140%)' },
        '--dsw-alias-bg-mask-1': { light: 'rgba(30, 25, 70, 0.24)', dark: 'rgba(8, 6, 24, 0.58)' },
        '--dsw-alias-scrollbar-bg-l1': { light: 'rgba(96, 78, 214, 0.24)', dark: 'rgba(168, 156, 255, 0.24)' },
        '--dsw-alias-scrollbar-hover-l1': { light: 'rgba(96, 78, 214, 0.42)', dark: 'rgba(168, 156, 255, 0.44)' },
        '--dsw-alias-scrollbar-bg-l2': { light: 'rgba(96, 78, 214, 0.30)', dark: 'rgba(168, 156, 255, 0.30)' },
        '--dsw-alias-scrollbar-hover-l2': { light: 'rgba(96, 78, 214, 0.50)', dark: 'rgba(168, 156, 255, 0.52)' },
        '--dsw-alias-brand-primary': { light: '#4b43d8', dark: '#a99cff' },
        '--dsw-alias-button-primary-fill': { light: '#4b43d8', dark: '#a99cff' },
        '--dsw-alias-button-primary-hover': { light: '#3d36b8', dark: '#8f83e6' },
        /** The same selection wash as `soft`, in this palette's violet. */
        '--dsw-material-selection': { light: 'rgba(96, 78, 214, 0.34)', dark: 'rgba(168, 156, 255, 0.36)' },
        /** The same surface set as `soft`, pushed further: violet wash, cooler chips, thicker glass. */
        '--dsw-alias-bg-layer-3': { light: '#fdfcff', dark: '#232236' },
        /** The same four static card fills as `soft`, on glass that matches this palette's cards. */
        '--dsw-static-neutral-50': { light: 'rgba(255, 255, 255, 0.78)', dark: 'rgba(48, 45, 72, 0.74)' },
        '--dsw-static-neutral-100': { light: 'rgba(255, 255, 255, 0.92)', dark: 'rgba(60, 56, 88, 0.88)' },
        '--dsw-static-neutral-850': { light: 'rgba(255, 255, 255, 0.78)', dark: 'rgba(48, 45, 72, 0.74)' },
        '--dsw-static-neutral-800': { light: 'rgba(255, 255, 255, 0.92)', dark: 'rgba(60, 56, 88, 0.88)' },
        /** The hover card's own surface, on this palette's glass. */
        '--dsw-hovercard-bg': { light: 'rgba(255, 255, 255, 0.78)', dark: 'rgba(48, 45, 72, 0.74)' },
        '--dsw-alias-bg-module-platform': {
          light: 'linear-gradient(180deg, rgba(234, 235, 250, 0.86) 0%, rgba(230, 230, 248, 0.80) 100%)',
          dark: 'linear-gradient(180deg, rgba(34, 32, 54, 0.84) 0%, rgba(26, 25, 42, 0.80) 100%)',
        },
        '--dsw-alias-interactive-bg-hover-solid': { light: '#e9e7f8', dark: '#262440' },
        '--dsw-alias-markdown-code-block': { light: '#f1f0fa', dark: '#15141f' },
        '--dsw-alias-markdown-code-block-banner': {
          light: 'linear-gradient(180deg, rgba(246, 245, 253, 0.94) 0%, rgba(238, 237, 250, 0.90) 100%)',
          dark: 'linear-gradient(180deg, rgba(32, 30, 50, 0.92) 0%, rgba(24, 23, 40, 0.88) 100%)',
        },
        '--dsw-alias-markdown-inline-code': { light: 'rgba(96, 78, 214, 0.07)', dark: 'rgba(168, 156, 255, 0.14)' },
        '--dsw-alias-markdown-tag': {
          light: 'linear-gradient(180deg, rgba(236, 235, 251, 0.90) 0%, rgba(230, 229, 248, 0.86) 100%)',
          dark: 'linear-gradient(180deg, rgba(44, 41, 72, 0.86) 0%, rgba(34, 32, 56, 0.82) 100%)',
        },
        '--dsw-alias-turn-trigger-bg': {
          light: 'linear-gradient(180deg, rgba(241, 240, 252, 0.92) 0%, rgba(233, 232, 250, 0.88) 100%)',
          dark: 'linear-gradient(180deg, rgba(36, 34, 58, 0.90) 0%, rgba(28, 26, 46, 0.86) 100%)',
        },
        '--dsw-alias-turn-trigger-bg-hover': { light: 'rgba(96, 78, 214, 0.09)', dark: 'rgba(168, 156, 255, 0.20)' },
        '--dsw-alias-menu-group-header-fill': { light: 'rgba(242, 241, 252, 0.92)', dark: 'rgba(46, 43, 70, 0.92)' },
        '--dsw-alias-button-elevated-fill': { light: 'rgba(255, 255, 255, 0.78)', dark: 'rgba(52, 48, 78, 0.78)' },
        '--dsw-alias-button-floating-fill': { light: 'rgba(255, 255, 255, 0.82)', dark: 'rgba(56, 52, 84, 0.80)' },
        '--dsw-alias-button-floating-hover': { light: 'rgba(240, 238, 252, 0.88)', dark: 'rgba(68, 63, 100, 0.84)' },
        '--dsw-alias-button-ghost-active-fill': { light: 'rgba(96, 78, 214, 0.14)', dark: 'rgba(168, 156, 255, 0.18)' },
        '--dsw-alias-button-contrast-fill': { light: '#3a3555', dark: '#d8d3f0' },
        '--dsw-alias-button-info-fill': { light: '#3f57c8', dark: '#8f9dff' },
        '--dsw-alias-button-info-hover': { light: '#3346a8', dark: '#7a89f5' },
        '--dsw-alias-tooltip-bg': { light: 'rgba(253, 253, 255, 0.94)', dark: 'rgba(43, 47, 74, 0.96)' },
        '--dsw-alias-tooltip-key-bg': { light: 'rgba(58, 52, 120, 0.12)', dark: 'rgba(58, 63, 96, 0.90)' },
        '--dsw-alias-toast-bg': { light: 'rgba(253, 253, 255, 0.96)', dark: 'rgba(48, 52, 81, 0.96)' },
        '--dsw-alias-toast-label': { light: 'rgb(58, 52, 120)', dark: 'rgb(255, 255, 255)' },
        '--dsw-alias-bg-document-preview': {
          light: 'linear-gradient(180deg, #f6f5fd 0%, #eceaf8 100%)',
          dark: 'linear-gradient(180deg, #191727 0%, #111020 100%)',
        },
        '--dsw-alias-bg-document-selection': { light: 'rgba(96, 78, 214, 0.20)', dark: 'rgba(168, 156, 255, 0.26)' },
        '--dsw-alias-state-business-tertiary': { light: 'rgba(79, 70, 224, 0.07)', dark: 'rgba(150, 145, 255, 0.14)' },
        '--dsw-alias-state-success-tertiary': { light: 'rgba(22, 163, 74, 0.11)', dark: 'rgba(74, 222, 128, 0.13)' },
        '--dsw-alias-state-warn-tertiary': { light: 'rgba(217, 119, 6, 0.11)', dark: 'rgba(251, 191, 36, 0.13)' },
        '--dsw-alias-code-diff-added': { light: 'rgba(22, 163, 74, 0.11)', dark: 'rgba(74, 222, 128, 0.12)' },
        '--dsw-alias-code-diff-deleted': { light: 'rgba(220, 38, 38, 0.07)', dark: 'rgba(248, 113, 113, 0.12)' },
        '--dsw-alias-file-diff-added-bg': { light: 'rgba(22, 163, 74, 0.12)', dark: 'rgba(74, 222, 128, 0.13)' },
        '--dsw-alias-file-diff-added-gutter': { light: 'rgba(22, 163, 74, 0.07)', dark: 'rgba(74, 222, 128, 0.09)' },
        '--dsw-alias-file-diff-deleted-bg': { light: 'rgba(220, 38, 38, 0.08)', dark: 'rgba(248, 113, 113, 0.13)' },
        '--dsw-alias-file-diff-deleted-gutter': { light: 'rgba(220, 38, 38, 0.06)', dark: 'rgba(248, 113, 113, 0.09)' },
        '--dsw-alias-interactive-bg-hover-danger': { light: 'rgba(220, 38, 38, 0.07)', dark: 'rgba(248, 113, 113, 0.10)' },
        '--dsw-alias-button-tool-bar-fill': { light: 'rgba(28, 30, 52, 0.52)', dark: 'rgba(28, 30, 52, 0.56)' },
        '--dsw-alias-button-tool-bar-hover': { light: 'rgba(28, 30, 52, 0.64)', dark: 'rgba(28, 30, 52, 0.68)' },
        '--dsw-shadow-lv2': {
          light: '0 6px 18px 0 rgba(46, 36, 110, 0.08), 0 2px 8px 0 rgba(46, 36, 110, 0.10)',
          dark: '0 6px 18px 0 rgba(0, 0, 0, 0.36), 0 2px 8px 0 rgba(0, 0, 0, 0.46)',
        },
        '--dsw-shadow-lv3': {
          light: '0 0 1px 0 rgba(46, 36, 110, 0.26), 0 0 6px 0 rgba(46, 36, 110, 0.06), 0 18px 40px 0 rgba(46, 36, 110, 0.14)',
          dark: '0 0 1px 0 rgba(0, 0, 0, 0.70), 0 0 8px 0 rgba(0, 0, 0, 0.28), 0 18px 40px 0 rgba(0, 0, 0, 0.54)',
        },
      },
    };

    /**
     * Colour rotas for the palette families beyond the two hand-tuned ones. `buildPalette` recolours
     * `soft`'s structure — every angle, alpha and token slot stays identical — so a new family is a
     * dozen role colours rather than another 60-row table, and the value-kind discipline the validator
     * proved for `soft` carries over unchanged. `soft`'s cool literals are the reference points: pure
     * white is glass, `60, 90, 170` is wash, `38, 54, 92` is ink, and every near-white between them is
     * a tint mix whose distance from white is preserved on the new rota.
     */
    const PALETTES = {
      /** Catppuccin Latte: cream base, lavender wash. */
      latte: {
        canvas: '#eff1f5', glass: [255, 255, 255], tint: [228, 232, 246], accent: [126, 146, 253],
        ink: [76, 79, 105], shadow: [54, 50, 78], toolbar: [52, 48, 70], wash: 0.8,
        contrast: '#4c4f69', brand: '#6e62d9', brandHover: '#5a4fc0',
        maskBlur: 18,
        dark: { canvas: '#11111b', tint: [58, 54, 84], accent: [180, 190, 254], brand: '#b4befc', brandHover: '#9aa6f0' },
      },
      /** Rosé Pine Dawn: warm paper, iris wash. */
      rose: {
        canvas: '#faf4ed', glass: [255, 250, 243], tint: [242, 233, 225], accent: [144, 122, 169],
        ink: [87, 82, 121], shadow: [70, 62, 88], toolbar: [64, 57, 82],
        contrast: '#575279', brand: '#7d5f9a', brandHover: '#694d84',
        maskBlur: 16,
        dark: { canvas: '#191724', tint: [60, 54, 74], accent: [196, 167, 231], brand: '#c4a7e7', brandHover: '#ad8fd6' },
      },
      /** Everforest light: paper-green base, moss wash. */
      sage: {
        canvas: '#f4f0d9', glass: [253, 250, 236], tint: [234, 230, 210], accent: [53, 167, 124],
        ink: [92, 106, 114], shadow: [62, 74, 66], toolbar: [58, 70, 62], wash: 0.7,
        contrast: '#4a5a4a', brand: '#5b7f55', brandHover: '#4b6b46',
        maskBlur: 16,
        dark: { canvas: '#14170f', tint: [52, 60, 48], accent: [167, 192, 150], brand: '#a7c096', brandHover: '#90aa80' },
      },
      /** Nord snow storm: arctic grey base, frost-blue wash. */
      nord: {
        canvas: '#eceff4', glass: [255, 255, 255], tint: [230, 234, 240], accent: [94, 129, 172],
        ink: [76, 86, 106], shadow: [54, 62, 78], toolbar: [50, 58, 74], wash: 0.7,
        contrast: '#434c5e', brand: '#4f739e', brandHover: '#436290',
        maskBlur: 18,
        dark: { canvas: '#10141b', tint: [52, 60, 72], accent: [136, 192, 208], brand: '#88c0d0', brandHover: '#6caab9' },
      },
      /** Solarized Light: warm paper, deep cyan-blue wash. */
      solar: {
        canvas: '#fdf6e3', glass: [255, 251, 240], tint: [238, 232, 213], accent: [56, 125, 165],
        ink: [88, 110, 117], shadow: [60, 78, 84], toolbar: [56, 72, 78],
        contrast: '#586e75', brand: '#2c7aa1', brandHover: '#256687',
        maskBlur: 16,
        dark: { canvas: '#0f1416', tint: [48, 58, 60], accent: [130, 180, 210], brand: '#82b4d2', brandHover: '#6a9cba' },
      },
      /** Atom One Light: near-white paper, cobalt wash. */
      one: {
        canvas: '#fafafa', glass: [255, 255, 255], tint: [235, 236, 240], accent: [64, 120, 242],
        ink: [56, 58, 66], shadow: [44, 46, 54], toolbar: [42, 44, 52],
        contrast: '#383a42', brand: '#2f63d4', brandHover: '#2653b8',
        maskBlur: 16,
        dark: { canvas: '#16181d', tint: [54, 58, 68], accent: [140, 170, 255], brand: '#9db4ff', brandHover: '#82a0f5' },
      },
      /** GitHub Primer Light: cool grey-white, link blue. */
      github: {
        canvas: '#f6f8fa', glass: [255, 255, 255], tint: [231, 237, 243], accent: [9, 105, 218],
        ink: [36, 41, 47], shadow: [52, 60, 68], toolbar: [40, 46, 53],
        contrast: '#24292f', brand: '#0969da', brandHover: '#0757b8',
        maskBlur: 18,
        dark: { canvas: '#0d1117', tint: [48, 54, 61], accent: [88, 166, 255], brand: '#79c0ff', brandHover: '#58a6ff' },
      },
      /** Flexoki Light: ink-on-paper, burnt-orange primary. */
      flexoki: {
        canvas: '#f2f0e5', glass: [255, 252, 240], tint: [230, 228, 217], accent: [58, 120, 190],
        ink: [40, 39, 38], shadow: [54, 52, 50], toolbar: [46, 44, 42], wash: 0.7,
        contrast: '#282726', brand: '#bc5215', brandHover: '#a3450f',
        maskBlur: 16,
        dark: { canvas: '#100f0f', tint: [48, 46, 43], accent: [102, 144, 213], brand: '#8ab4f8', brandHover: '#6690d5' },
      },
      /** Gruvbox Light: retro cream, deep orange and teal. */
      gruvbox: {
        canvas: '#f9f5d7', glass: [255, 252, 235], tint: [240, 228, 192], accent: [69, 133, 136],
        ink: [60, 56, 54], shadow: [70, 62, 50], toolbar: [58, 54, 50], wash: 0.85,
        contrast: '#3c3836', brand: '#af3a03', brandHover: '#953003',
        maskBlur: 16,
        dark: { canvas: '#1d2021', tint: [60, 56, 54], accent: [131, 165, 152], brand: '#fabd2f', brandHover: '#d79921' },
      },
      /** Ayu Light: clear white, sky blue. */
      ayu: {
        canvas: '#fafafa', glass: [255, 255, 255], tint: [236, 240, 244], accent: [54, 163, 217],
        ink: [92, 103, 115], shadow: [60, 70, 80], toolbar: [52, 62, 72],
        contrast: '#3f4a55', brand: '#21709b', brandHover: '#1a5a7d',
        maskBlur: 16,
        dark: { canvas: '#0f1419', tint: [45, 55, 66], accent: [89, 194, 255], brand: '#59c2ff', brandHover: '#39a8e0' },
      },
      /** Kanagawa Lotus: rice-paper yellow, indigo ink. */
      kanagawa: {
        canvas: '#f6f1d5', glass: [250, 246, 222], tint: [236, 230, 196], accent: [125, 145, 185],
        ink: [84, 84, 100], shadow: [72, 68, 78], toolbar: [66, 64, 76], wash: 0.7,
        contrast: '#43436c', brand: '#4d699b', brandHover: '#3f5680',
        maskBlur: 16,
        dark: { canvas: '#1f1f28', tint: [47, 46, 58], accent: [126, 156, 214], brand: '#7e9cd8', brandHover: '#6a88c4' },
      },
      /** Tokyo Night Day: blue-grey daylight, night-blue ink. */
      tokyo: {
        canvas: '#f4f5f9', glass: [252, 253, 255], tint: [223, 228, 240], accent: [46, 125, 233],
        ink: [55, 96, 191], shadow: [60, 70, 110], toolbar: [52, 60, 92], wash: 0.85,
        contrast: '#2f3b63', brand: '#1f63c9', brandHover: '#1752ab',
        maskBlur: 20,
        dark: { canvas: '#1a1b26', tint: [41, 46, 66], accent: [122, 162, 247], brand: '#7aa2f7', brandHover: '#5f8ae0' },
      },
    };

    const SEMANTIC_LIGHT = new Set(['65,118,230', '34,197,94', '217,119,6', '236,19,19']);
    const SEMANTIC_DARK = new Set(['122,170,255', '65,201,119', '250,176,80', '250,66,62']);
    /** White ink in the built-in dark sheets is a hairline on dark glass; every new dark rota keeps it neutral. */
    const DARK_INK = [232, 236, 246];

    /** Parse `#rgb`, `#rrggbb`, `rgb()` or `rgba()` into channels plus alpha; null for anything else. */
    function channels(literal) {
      const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(literal);
      if (hex) {
        const digits = hex[1].length === 3 ? [...hex[1]].map(c => c + c) : hex[1];
        return { rgb: [0, 2, 4].map(i => Number.parseInt(digits.slice(i, i + 2), 16)), alpha: 1 };
      }
      const func = /^rgba?\(([^)]+)\)$/i.exec(literal);
      if (!func) return null;
      const parts = func[1].split(/[,/\s]+/).filter(Boolean);
      if (parts.length < 3) return null;
      return {
        rgb: parts.slice(0, 3).map(Number.parseFloat),
        alpha: parts[3] === undefined ? 1 : Number.parseFloat(parts[3]),
      };
    }

    function paint(rgb, alpha) {
      const rounded = rgb.map(channel => Math.round(Math.min(255, Math.max(0, channel))));
      return alpha >= 1 ? `rgb(${rounded.join(', ')})` : `rgba(${rounded.join(', ')}, ${Math.round(alpha * 1000) / 1000})`;
    }

    function blend(from, to, k) {
      return from.map((channel, index) => channel + (to[index] - channel) * k);
    }

    /** Soft's cool tint as a scalar, so a near-white literal can be read back as "glass mixed with k of tint". */
    const SOFT_TINT_AVG = 237.33;

    function recolorLight(value, rota) {
      const solids = {
        '#f4f6fb': rota.canvas,
        '#fafcff': paint(blend(rota.glass, rota.tint, 0.14), 1),
        '#fcfdff': paint(blend(rota.glass, rota.tint, 0.10), 1),
        '#eaeff8': paint(blend(rota.glass, rota.tint, 0.66), 1),
        '#f2f6fc': paint(blend(rota.glass, rota.tint, 0.32), 1),
        '#f7f9fd': paint(blend(rota.glass, rota.tint, 0.22), 1),
        '#eef2f9': paint(blend(rota.glass, rota.tint, 0.42), 1),
        '#39424f': rota.contrast,
        '#3f6cc4': rota.brand,
        '#315aa8': rota.brandHover,
      };
      return value.replace(/#[0-9a-f]{3,8}|rgba?\([^)]*\)/gi, (literal) => {
        const parsed = channels(literal);
        if (!parsed) return literal;
        const key = parsed.rgb.map(Math.round).join(',');
        if (key === '255,255,255') return paint(rota.glass, parsed.alpha);
        if (key === '60,90,170') return paint(rota.accent, parsed.alpha);
        if (key === '38,54,92') return paint(rota.ink, parsed.alpha);
        if (key === '28,40,72') return paint(rota.shadow, parsed.alpha);
        if (key === '31,38,54') return paint(rota.toolbar, parsed.alpha);
        if (key === '0,0,0') return literal;
        if (SEMANTIC_LIGHT.has(key)) return paint(parsed.rgb, parsed.alpha * (rota.wash ?? 1));
        const exact = solids[literal.toLowerCase()];
        if (exact) return exact;
        const [r, g, b] = parsed.rgb;
        if (r >= 214 && g >= 214 && b >= 208) {
          const k = Math.min(1, Math.max(0, (255 - (r + g + b) / 3) / (255 - SOFT_TINT_AVG)));
          return paint(blend(rota.glass, rota.tint, k), parsed.alpha);
        }
        return literal;
      });
    }

    function recolorDark(value, rota) {
      return value.replace(/#[0-9a-f]{3,8}|rgba?\([^)]*\)/gi, (literal) => {
        const parsed = channels(literal);
        if (!parsed) return literal;
        const key = parsed.rgb.map(Math.round).join(',');
        if (key === '150,180,255') return paint(rota.dark.accent, parsed.alpha);
        if (key === '255,255,255') return paint(DARK_INK, parsed.alpha);
        if (key === '0,0,0' || SEMANTIC_DARK.has(key)) return literal;
        if (literal.toLowerCase() === '#12141a') return paint(channels(rota.dark.canvas).rgb, 1);
        const [r, g, b] = parsed.rgb;
        if (r < 130 && g < 130 && b < 130) return paint(blend(parsed.rgb, rota.dark.tint, 0.32), parsed.alpha);
        return literal;
      });
    }

    /** One palette: `soft`'s structure recoloured, plus the accent tokens `soft` deliberately leaves alone. */
    function buildPalette(rota) {
      const layer = {};
      for (const [name, modes] of Object.entries(HAND_TUNED.soft)) {
        layer[name] = { light: recolorLight(modes.light, rota), dark: recolorDark(modes.dark, rota) };
      }
      layer['--dsw-alias-brand-primary'] = { light: rota.brand, dark: rota.dark.brand };
      layer['--dsw-alias-button-primary-fill'] = { light: rota.brand, dark: rota.dark.brand };
      layer['--dsw-alias-button-primary-hover'] = { light: rota.brandHover, dark: rota.dark.brandHover };
      layer['--dsw-mask-blur'] = {
        light: `blur(${rota.maskBlur}px) saturate(150%)`,
        dark: `blur(${rota.maskBlur}px) saturate(140%)`,
      };
      layer['--dsw-alias-bg-mask-1'] = { light: paint(rota.ink, 0.20), dark: 'rgba(8, 8, 14, 0.55)' };
      return layer;
    }

    const MATERIALS = { soft: HAND_TUNED.soft, vivid: HAND_TUNED.vivid };
    for (const [name, rota] of Object.entries(PALETTES)) MATERIALS[name] = buildPalette(rota);

    /** Canvas-to-accent pairs for the preset chips; `flat` shows the untouched neutral instead. */
    const SWATCHES = {
      soft: ['#f4f6fb', '#3c5aaa'],
      vivid: ['#edf0fa', '#4b43d8'],
      latte: ['#f2f3f8', '#7e92fd'],
      rose: ['#faf4ed', '#907aa9'],
      sage: ['#f4f0d9', '#35a77c'],
      nord: ['#eceff4', '#5e81ac'],
      solar: ['#fdf6e3', '#387da5'],
      one: ['#fafafa', '#4078f2'],
      github: ['#f6f8fa', '#0969da'],
      flexoki: ['#f2f0e5', '#bc5215'],
      gruvbox: ['#f9f5d7', '#af3a03'],
      ayu: ['#fafafa', '#36a3d9'],
      kanagawa: ['#f2ecbc', '#4d699b'],
      tokyo: ['#e1e2e7', '#2e7de9'],
      flat: ['#eef0f4', '#b9bfcc'],
    };

    /* __FROST_START__ */
    /**
     * `prefers-reduced-transparency: reduce` asks for less transparency, not for the material to
     * disappear, so the layer thickens instead of switching off and the blur tokens fall to `none`.
     * Two readings of "thicken" are needed, because the surfaces are not all the same colour:
     * a near-white glass panel is raised to at least `FROST_MIN_ALPHA` and stays a panel, while a
     * pale tint that carries text is composited over the preset's own canvas so the pixels it showed
     * before are kept exactly and only the see-through goes away. Hover washes, selection tints,
     * skeleton shimmer and the modal scrims keep their values — they tint something already solid.
     */
    const FROST_MIN_ALPHA = 0.96;
    const FROST_SURFACES = [
      '--dsw-alias-bg-layer-1',
      '--dsw-alias-bg-layer-2',
      '--dsw-alias-bg-overlay',
      '--dsw-specific-sidebar-fill',
      '--dsw-menu-surface-fill',
      '--dsw-specific-input-major',
      '--dsw-specific-bubble',
      '--dsw-specific-selector',
      '--dsw-alias-bg-module-platform',
      '--dsw-alias-markdown-code-block-banner',
      '--dsw-alias-markdown-tag',
      '--dsw-alias-turn-trigger-bg',
      '--dsw-alias-menu-group-header-fill',
      '--dsw-alias-button-elevated-fill',
      '--dsw-alias-button-floating-fill',
      '--dsw-alias-button-floating-hover',
      '--dsw-static-neutral-50',
      '--dsw-static-neutral-100',
      '--dsw-static-neutral-850',
      '--dsw-static-neutral-800',
      '--dsw-hovercard-bg',
    ];
    const FROST_SOLID = [
      '--dsw-alias-markdown-inline-code',
      '--dsw-alias-button-ghost-active-fill',
      '--dsw-alias-state-business-tertiary',
      '--dsw-alias-state-success-tertiary',
      '--dsw-alias-state-warn-tertiary',
      '--dsw-alias-code-diff-added',
      '--dsw-alias-code-diff-deleted',
      '--dsw-alias-file-diff-added-bg',
      '--dsw-alias-file-diff-added-gutter',
      '--dsw-alias-file-diff-deleted-bg',
      '--dsw-alias-file-diff-deleted-gutter',
      // The floating notices carry their own text over whatever the page puts behind them, so they
      // are flattened onto the canvas rather than thickened: a notice that stays see-through reads
      // as a smudge on top of the content it covers.
      '--dsw-alias-tooltip-bg',
      '--dsw-alias-tooltip-key-bg',
      '--dsw-alias-toast-bg',
    ];
    const FROST_BLUR = ['--dsw-menu-backdrop-filter', '--dsw-mask-blur'];

    /** Raise every `rgba()` alpha in a value to at least `FROST_MIN_ALPHA`, leaving the hue alone. */
    function thicken(value) {
      return value.replace(/rgba\(([^)]*)\)/gi, (match, body) => {
        const parts = body.split(/[,/\s]+/).filter(Boolean);
        if (parts.length < 4) return match;
        const alpha = Math.max(Number.parseFloat(parts[3]) || 0, FROST_MIN_ALPHA);
        return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`;
      });
    }

    /** `#rrggbb` or `rgb(...)` as channels; the canvas is always a solid colour, so no alpha. */
    function canvasRgb(value) {
      const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
      if (hex) {
        const digits = hex[1].length === 3 ? [...hex[1]].map(c => c + c) : hex[1];
        return [0, 2, 4].map(i => Number.parseInt(digits.slice(i, i + 2), 16));
      }
      const rgb = /^rgb\(([^)]+)\)$/i.exec(value.trim());
      if (rgb) return rgb[1].split(/[,/\s]+/).filter(Boolean).slice(0, 3).map(Number.parseFloat);
      return [255, 255, 255];
    }

    /** Composite every tint stop over `backing`, so the frosted reading shows the same pixels opaquely. */
    function flattenOnto(value, backing) {
      return value.replace(/rgba\(([^)]*)\)/gi, (match, body) => {
        const parts = body.split(/[,/\s]+/).filter(Boolean);
        if (parts.length < 4) return match;
        const alpha = Number.parseFloat(parts[3]);
        if (!(alpha >= 0) || alpha >= 1) return match;
        const mixed = parts.slice(0, 3).map((channel, i) => Math.round((Number.parseFloat(channel) || 0) * alpha + backing[i] * (1 - alpha)));
        return `rgb(${mixed[0]}, ${mixed[1]}, ${mixed[2]})`;
      });
    }

    /** The frosted reading of one preset: same tokens, opaque surfaces, no blur. */
    function frostify(tokens) {
      const canvas = {};
      for (const mode of ['light', 'dark']) canvas[mode] = canvasRgb(tokens['--dsw-alias-bg-base'][mode]);
      const frosted = {};
      for (const [name, modes] of Object.entries(tokens)) {
        if (FROST_BLUR.includes(name)) frosted[name] = { light: 'none', dark: 'none' };
        else if (FROST_SURFACES.includes(name)) frosted[name] = { light: thicken(modes.light), dark: thicken(modes.dark) };
        else if (FROST_SOLID.includes(name)) frosted[name] = { light: flattenOnto(modes.light, canvas.light), dark: flattenOnto(modes.dark, canvas.dark) };
        else frosted[name] = modes;
      }
      return frosted;
    }
    /* __FROST_END__ */

    /* __HOVERCARD_START__ */
    /**
     * Three floating surfaces are out of the token layer's reach, and one stylesheet reaches all of
     * them.
     *
     * The Sidebar session hover card is the one surface the token layer cannot reach on its own.
     * `ui-primitives`' HoverCard declares `--dsw-hovercard-bg: #2C2C2E` on the card element
     * itself, and an element's own declaration of a custom property beats every inherited value —
     * so a body-inline token, `!important` or not, never repaints that card (measured in the
     * browser; `tools/check-materials.mjs` records the reach). The card's ink is the same story:
     * `ui-workspace` and `ui-schedule` write literal light greys (#FFFFFF, #CFD3D6, #ADB2B8),
     * because the card was a fixed dark surface in both themes.
     *
     * The tooltip and the toast are reachable by token, but only half of each: the tooltip's ink
     * is a literal white in both palettes (`--dsw-static-neutral-bluish-00`) and the toast's action
     * link a literal deepseek-400, tuned for the dark banner the platform paints. Both notices
     * follow the theme now, so their ink has to follow it as well.
     *
     * So this package themes them through one stylesheet that lives and dies with its effect.
     * The selectors are read from the live stylesheets — the CSS modules hash their local names
     * per build, so a name written here would be wrong on the next release — and the surface and
     * the ink flip together: the fill is applied only once the card's own rule was found, and
     * every text inside the card follows the theme's primary ink, so a part this package does not
     * know still reads against the new surface.
     */
    /**
     * The surfaces that float over content and are painted with a see-through fill.
     *
     * The platform paints them solid — the quote button that appears next to a selection, the tooltip
     * bubble and the toast banner — so they were readable. This layer makes them translucent, and a
     * translucent panel with no blur is only a film over the text it covers: the quote button lands
     * exactly on the words it belongs to, so the words read through the button and the button's own
     * label competes with them. The compat stylesheet hands these surfaces the material's blur, so
     * the opacity slider can go down without the page bleeding through the surface.
     */
    const FROSTED_FLOATERS = [
      '--dsw-alias-button-floating-fill',
      '--dsw-alias-tooltip-bg',
      '--dsw-alias-toast-bg',
    ];

    /**
     * The composer takeover cards: the ask-user card (the question card), the
     * plan review that stands in for it, and the approval takeover. All three
     * paint the input surface token, which this layer makes translucent, and
     * all three float over the transcript — so all three need the frost.
     */
    const TAKEOVER_SURFACE = '--dsw-specific-input-major';

    /**
     * What tells the takeover cards apart from every other surface that reads
     * the input surface token. Each card is the one rule that paints the input
     * surface, takes the shared chat width AND declares one more thing of its
     * own: the ask-user card and the plan review draw their rim through the
     * elevation stroke, the approval takeover draws a warning rim of its own.
     * The input card itself takes the composer's own width instead, so it is
     * never caught here — it sits at the bottom of the column, not over it.
     */
    const TAKEOVER_CARDS = [
      ['var(--dsh-chat-content-width)', '--dsw-elevation-stroke-color'],
      ['var(--dsh-chat-content-width)', 'var(--dsw-alias-state-warn-secondary)'],
    ];

    const HOVER_CARD_INK = [
      { local: 'hoverTitle', ink: '--dsw-alias-label-primary' },
      { local: 'hoverPath', ink: '--dsw-alias-label-secondary' },
      { local: 'hoverTime', ink: '--dsw-alias-label-secondary' },
      { local: 'hoverStatus', ink: '--dsw-alias-label-tertiary' },
      { local: 'taskName', ink: '--dsw-alias-label-primary' },
      { local: 'taskTiming', ink: '--dsw-alias-label-secondary' },
      { local: 'taskRelative', ink: '--dsw-alias-label-tertiary' },
      { local: 'taskIcon', ink: '--dsw-alias-label-secondary' },
      { local: 'omitted', ink: '--dsw-alias-label-tertiary' },
      { local: 'copied', ink: '--dsw-alias-label-primary' },
    ];

    /** The class tokens a selector's subject names, without its pseudo-classes. */
    function selectorClasses(selector) {
      const subject = selector.split(/\s*[>+~]\s*|\s+/).filter(Boolean).pop() ?? '';
      return [...subject.matchAll(/\.(-?[_A-Za-z][\w-]*)/g)].map(match => match[1]);
    }

    /** Whether a built class token carries a local name: `YDXeBa_hoverTitle` carries `hoverTitle`. */
    function carriesLocal(token, local) {
      return new RegExp(`(?:^|_)${local}(?:_|$)`).test(token);
    }

    /**
     * The CSS module a built class token belongs to. Two shapes are in use: `[hash]_[local]` and
     * `_[local]_[hash]_[index]`. The module is what tells the toast's own action link apart from
     * every other rule in the app that reaches for the same colour.
     */
    function moduleOf(token) {
      const prefixed = /^([A-Za-z0-9]+)_/.exec(token);
      if (prefixed) return prefixed[1];
      const hashed = /_([A-Za-z0-9]+)_\d+$/.exec(token);
      return hashed ? hashed[1] : null;
    }

    /**
     * Read the hover card's own selector, the selectors of its ink, the tooltip's bubble and the
     * toast's action link out of the live stylesheets. The card is found by what it declares — the
     * one rule that owns `--dsw-hovercard-bg` — the ink by the local names the app's CSS modules
     * give them, the two notices by the surface they paint.
     */
    function readSurfaces() {
      const rules = [];
      for (const sheet of document.styleSheets) {
        let list;
        try { list = sheet.cssRules; } catch { continue; }
        for (const rule of list) {
          const selector = rule.selectorText;
          if (!selector) continue;
          rules.push({ classes: selectorClasses(selector), text: rule.cssText ?? '' });
        }
      }
      const card = new Set();
      const ink = new Map();
      const floaters = new Map(FROSTED_FLOATERS.map(name => [name, []]));
      const takeover = new Set();
      const deepseek = [];
      for (const { classes, text } of rules) {
        if (text.includes('--dsw-hovercard-bg')) {
          for (const token of classes) card.add(token);
        }
        /**
         * The composer takeover cards: each paints the input surface, takes the
         * shared chat width AND declares one signal of its own (see
         * `TAKEOVER_CARDS`). The approval takeover draws a warning rim, the
         * ask-user card and the plan review declare the elevation stroke — so
         * the three are found without naming any of them.
         */
        if (text.includes(`var(${TAKEOVER_SURFACE})`)
          && TAKEOVER_CARDS.some(signals => signals.every(signal => text.includes(signal)))) {
          for (const token of classes) takeover.add(token);
        }
        for (const name of FROSTED_FLOATERS) {
          if (!text.includes(`var(${name})`)) continue;
          const list = floaters.get(name);
          for (const token of classes) if (!list.includes(token)) list.push(token);
        }
        if (!/color\s*:/.test(text)) continue;
        for (const entry of HOVER_CARD_INK) {
          const tokens = classes.filter(token => carriesLocal(token, entry.local));
          if (tokens.length === 0) continue;
          const list = ink.get(entry.local) ?? [];
          for (const token of tokens) if (!list.includes(token)) list.push(token);
          ink.set(entry.local, list);
        }
        if (text.includes('var(--dsw-static-deepseek-400)')) deepseek.push(classes);
      }
      // The card's own module also holds the `preview` and `media` variants, which paint a surface
      // of their own; the card's rim, blur and elevation stay off them.
      const cardModule = [...card].map(moduleOf).find(Boolean) ?? null;
      const variants = new Set();
      if (cardModule !== null) {
        for (const { classes, text } of rules) {
          if (!/(^|[;{])\s*background(-color|-image)?\s*:/.test(text)) continue;
          for (const token of classes) {
            if (card.has(token)) continue;
            if (moduleOf(token) === cardModule) variants.add(token);
          }
        }
      }
      // The toast's action link: the one rule inside the toast's own module that reaches for the
      // hardcoded deepseek-400, so every other rule in the app that uses the colour is left alone.
      const toastModule = floaters.get('--dsw-alias-toast-bg').map(moduleOf).find(Boolean) ?? null;
      const action = new Set();
      if (toastModule !== null) {
        for (const classes of deepseek) {
          for (const token of classes) if (moduleOf(token) === toastModule) action.add(token);
        }
      }
      return {
        card: [...card],
        ink,
        tooltip: floaters.get('--dsw-alias-tooltip-bg'),
        floaters,
        variants: [...variants],
        action: [...action],
        takeover: [...takeover],
      };
    }

    /**
     * The composer seat, the stack it holds, and the band the seat's input mask paints.
     *
     * The seat paints an input mask: a fixed band at the seat's top that fades the transcript out,
     * opaque below it, so the text dissolves as it slides under the composer. The dock cards — the
     * task panel, the queue panel, the context meter — sit ABOVE the input card inside that same
     * seat, so the opaque part of the mask lands behind THEM: a translucent dock card then has a
     * flat colour to frost instead of the transcript, and its blur survives only in the band's
     * first stretch — which is exactly the collapsed height of the task panel. Expanded, every row
     * below that height has nothing left to blur, and the card reads as glass at the top and as
     * cardboard below.
     *
     * The mask belongs to the input card, not to the seat. So the seat stops painting it and the
     * input bar's root carries the opaque base and the same band instead; the dock cards are left
     * with the transcript behind them. The band keeps its place relative to the input card, so a
     * seat without dock cards looks exactly as it did.
     *
     * All three selectors are read from the live stylesheets — the CSS modules hash their local
     * names per build, so a name written here would be wrong on the next release. The seat is found
     * by the mask it paints, the stack by the gap it lays its children out with, and the input
     * bar's root by the side clearance and the bottom pad it declares. The input bar's root is the
     * input card's parent, and it is the one box that can hold the opaque base the seat used to
     * paint: the slot wraps it in a `display: contents` element, so the seat's last child is not it.
     *
     * @returns the seat's selector list, the stack's and the input bar's class tokens, and the
     *          band's height; null when the app's composer is not shaped as this package expects.
     */
    function readComposer() {
      let seat = null;
      let mask = null;
      let band = 0;
      const stack = new Set();
      const input = new Set();
      for (const sheet of document.styleSheets) {
        let list;
        try { list = sheet.cssRules; } catch { continue; }
        for (const rule of list) {
          const selector = rule.selectorText;
          if (!selector) continue;
          const text = rule.cssText ?? '';
          if (seat === null && text.includes('color-mix(in srgb, var(--dsw-alias-bg-base)')) {
            const background = /background(?:-image)?\s*:\s*([^;]+)/i.exec(text)?.[1] ?? '';
            const pixels = [...background.matchAll(/(\d+(?:\.\d+)?)px/g)].map(match => Number(match[1]));
            if (pixels.length > 0) {
              seat = selector;
              mask = background.trim();
              band = Math.max(...pixels);
            }
          }
          if (/(^|[;\s])gap:\s*var\(--dsh-composer-stack-gap\)/.test(text)) {
            for (const token of selectorClasses(selector)) stack.add(token);
          }
          if (/padding:\s*0\s+var\(--dsh-composer-side-clearance\)\s+4px/.test(text)) {
            for (const token of selectorClasses(selector)) input.add(token);
          }
        }
      }
      if (seat === null || stack.size === 0 || input.size === 0) return null;
      return { seat, stack: [...stack], input: [...input], mask, band };
    }

    /** A selector list's alternatives, split on top-level commas only. */
    function selectorParts(selectorText) {
      const parts = [];
      let depth = 0;
      let start = 0;
      for (let index = 0; index < selectorText.length; index += 1) {
        const char = selectorText[index];
        if (char === '(') depth += 1;
        else if (char === ')') depth -= 1;
        else if (char === ',' && depth === 0) {
          parts.push(selectorText.slice(start, index).trim());
          start = index + 1;
        }
      }
      parts.push(selectorText.slice(start).trim());
      return parts.filter(Boolean);
    }

    /**
     * The compat stylesheet: the card's surface hands the decision back to the body layer, the
     * card's text follows the theme's label tokens, the two notices get the ink their new
     * surfaces no longer carry, and the see-through floaters get the material's blur. `inherit` is
     * what makes the body token land — the card's own `#2C2C2E` declaration is what a body value
     * could never beat.
     *
     * Every part stands on its own: the card is found by the rule that owns `--dsw-hovercard-bg`, and
     * a build that stopped shipping that card must not take the notices, the floaters or the
     * selection down with it. So the sheet is assembled from parts, and a part with no target is
     * simply left out.
     */
    function compatSheet() {
      const found = readSurfaces();
      const rules = [
        // The browser's own selection is a hard, fully saturated blue that belongs to no palette
        // here: it reads as a system artefact dropped on top of the material, not as part of it.
        // The palette's own accent, washed over whatever is selected, keeps the selection in the
        // colour family, and the theme's ink on top keeps the selected text readable.
        '::selection { background-color: var(--dsw-material-selection); color: var(--dsw-alias-label-primary); }',
      ];
      if (found.card.length > 0) {
        const card = found.card.map(token => `.${token}`).join(', ');
        const notVariant = found.variants.map(token => `:not(.${token})`).join('');
        const surface = found.card.map(token => `.${token}${notVariant}`).join(', ');
        rules.push(
          `${card} { --dsw-hovercard-bg: inherit !important; }`,
          // The card was a bare slab on a tinted canvas. A rim gives it an edge, the material's own
          // blur gives it the frosted read of every other card, and the inset highlight is the light
          // that lands on a top edge.
          `${surface} { border: 1px solid var(--dsw-alias-border-l3) !important; backdrop-filter: var(--dsw-menu-backdrop-filter) !important; -webkit-backdrop-filter: var(--dsw-menu-backdrop-filter) !important; }`,
          `${surface} { box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.55), var(--dsw-shadow-lv3) !important; }`,
          `body[data-ds-dark-theme] ${surface} { box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06), var(--dsw-shadow-lv3) !important; }`,
          // Every line inside the card reads as the theme's primary ink, so a part this package does
          // not know still reads against the new surface. `:where()` leaves this rule at the same
          // specificity as the part rules below it, and the later rule wins — without it the blanket
          // rule would outrank every part and flatten the card's three ink steps into one.
          `${card} :where(*:not(svg)) { color: var(--dsw-alias-label-primary) !important; }`,
        );
        // The card's own variants paint a surface of their own, so the rim and the elevation stay off
        // them — but they are see-through surfaces too, and a translucent panel with no blur is only a
        // smudge over the text it covers. The wide preview (the changed-files list) reads the
        // composer's own placeholder through it, and without the blur the two overlap.
        if (found.variants.length > 0) {
          const variants = found.variants.map(token => `.${token}`).join(', ');
          rules.push(`${variants} { backdrop-filter: var(--dsw-menu-backdrop-filter) !important; -webkit-backdrop-filter: var(--dsw-menu-backdrop-filter) !important; }`);
        }
        for (const entry of HOVER_CARD_INK) {
          const tokens = found.ink.get(entry.local);
          if (!tokens || tokens.length === 0) continue;
          rules.push(`${tokens.map(token => `.${token}`).join(', ')} { color: var(${entry.ink}) !important; }`);
        }
        const title = found.ink.get('hoverTitle');
        if (title && title.length > 0) {
          rules.push(`${title.map(token => `.${token}`).join(', ')} { font-weight: 600 !important; }`);
        }
      }
      if (found.tooltip.length > 0) {
        const bubble = found.tooltip.map(token => `.${token}`).join(', ');
        rules.push(`${bubble} { color: var(--dsw-alias-label-primary) !important; }`);
        rules.push(`${bubble} { box-shadow: var(--dsw-shadow-lv2) !important; }`);
      }
      if (found.action.length > 0) {
        rules.push(`${found.action.map(token => `.${token}`).join(', ')} { color: var(--dsw-alias-brand-primary) !important; }`);
      }
      // The floaters this layer made see-through get the material's blur, so the page behind them
      // stops bleeding through their own label: the quote button that appears next to a selection
      // lands on the selected words, and without the blur those words read through the button.
      const frosted = [];
      for (const tokens of found.floaters.values()) {
        for (const token of tokens) if (!frosted.includes(token)) frosted.push(token);
      }
      if (frosted.length > 0) {
        rules.push(`${frosted.map(token => `.${token}`).join(', ')} { backdrop-filter: var(--dsw-menu-backdrop-filter) !important; -webkit-backdrop-filter: var(--dsw-menu-backdrop-filter) !important; }`);
      }
      // The composer takeover cards float over the transcript with a surface of
      // their own, and this layer makes that surface translucent: without a blur
      // a card is only a film over the words it covers, so its own copy and the
      // transcript read on top of each other. The platform's own frost token gives
      // them the same treatment the menus, the hover card and the dock cards get.
      if (found.takeover.length > 0) {
        rules.push(`${found.takeover.map(token => `.${token}`).join(', ')} { backdrop-filter: var(--dsw-menu-backdrop-filter) !important; -webkit-backdrop-filter: var(--dsw-menu-backdrop-filter) !important; }`);
      }
      // The composer seat's input mask, moved onto the input card it belongs to. The seat keeps its
      // geometry; only the background moves, so the dock cards above the input card get the
      // transcript behind them and can frost it over their whole height.
      const composer = readComposer();
      if (composer !== null) {
        const stack = composer.stack.map(token => `.${token}`).join('');
        const input = composer.input.map(token => `.${token}`).join('');
        const parts = selectorParts(composer.seat);
        const seat = parts.join(', ');
        const inputBar = parts.map(part => `${part} ${input}`);
        const docked = parts.map(part => `${part} ${stack}:has(> :nth-child(2)) ${input}`);
        rules.push(`${seat} { background: none !important; }`);
        // The mask becomes the input bar's own background: the same gradient, the same px stops, so
        // the fade sits where the seat's sat and the base stays as wide as the seat. A background
        // paints below the bar's content, where the seat's background painted below the whole
        // composer — the draft, the notices and the status strip keep their ink.
        rules.push(`${inputBar.join(', ')} { background: ${composer.mask} !important; }`);
        // A docked card pushes the input bar down by exactly one stack gap, so the input bar's own
        // box is lifted back over that gap: the canvas covers the strip between the card and the
        // input bar instead of the transcript showing through it. The padding puts the content back
        // where it was, so the seat's height and the card's place do not move.
        rules.push(`${docked.join(', ')} { margin-top: calc(-1 * var(--dsh-composer-stack-gap, 6px)) !important; padding-top: var(--dsh-composer-stack-gap, 6px) !important; }`);
      }
      return rules.join('\n');
    }
    /* __HOVERCARD_END__ */

    /**
     * Windows Desktop paints the window caption from exactly one of these tokens: `preload-windows.ts`
     * probes `background-color: var(--dsw-specific-sidebar-fill)`, rasterises whatever the browser
     * computes and ships it to `setTitleBarOverlay`. A gradient is invalid in a `background-color` slot,
     * so the probe computes to transparent and the title bar goes clear — measured, not assumed. On that
     * platform the sidebar takes its own top stop flattened over the canvas, which is the pixel the
     * caption actually sits on; every other surface keeps the gradient.
     */
    function captionSafe(tokens) {
      const fill = tokens['--dsw-specific-sidebar-fill'];
      if (!fill) return tokens;
      const solid = {};
      for (const mode of ['light', 'dark']) {
        const flat = flattenOnto(fill[mode], canvasRgb(tokens['--dsw-alias-bg-base'][mode]));
        solid[mode] = /rgba?\([^)]*\)|#[0-9a-f]{3,8}/i.exec(flat)?.[0] ?? flat;
      }
      return { ...tokens, '--dsw-specific-sidebar-fill': solid };
    }

    /**
     * The sliders speak in real units instead of ratios: opacity is a percentage of each surface's
     * designed alpha, blur is the menu's own pixel radius, saturation is the menu's own percentage.
     * A `null` blur/saturation means "follow the palette" — the panel starts there, so a fresh
     * profile keeps each palette's intended depth.
     */
    const TUNING_LIMITS = {
      opacity: { min: 0, max: 2, step: 0.01 },
      blurPx: { min: 0, max: 160, step: 1 },
      saturatePct: { min: 0, max: 400, step: 5 },
    };
    const DEFAULT_TUNING = { opacity: 1, blurPx: null, saturatePct: null };

    /** The palette's own filter numbers, parsed from the token it writes. */
    function filterBase(tokens) {
      const match = /blur\(\s*([\d.]+)px\s*\)(?:\s*saturate\(\s*([\d.]+)%\s*\))?/i.exec(tokens?.['--dsw-menu-backdrop-filter']?.light ?? '');
      return { blur: match ? Number(match[1]) : 0, saturate: match?.[2] === undefined ? 100 : Number(match[2]) };
    }

    /** Multiply every glass surface's alpha; solids (`background-color` slots) keep their opaque reading. */
    function scaleGlass(tokens, factor) {
      const scaled = {};
      for (const [name, modes] of Object.entries(tokens)) {
        if (!FROST_SURFACES.includes(name)) { scaled[name] = modes; continue; }
        const next = {};
        for (const mode of ['light', 'dark']) {
          next[mode] = String(modes[mode]).replace(/rgba\(([^)]*)\)/gi, (match, body) => {
            const parts = body.split(/[,/\s]+/).filter(Boolean);
            if (parts.length < 4) return match;
            const alpha = Math.min(0.985, Math.max(0, (Number.parseFloat(parts[3]) || 0) * factor));
            return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${Math.round(alpha * 1000) / 1000})`;
          });
        }
        scaled[name] = next;
      }
      return scaled;
    }

    /** Rebuild both backdrop filters from the menu's radius; the mask keeps its ratio to the menu. */
    function retuneFilters(tokens, blurScale, saturateScale) {
      const retuned = { ...tokens };
      for (const name of FROST_BLUR) {
        const modes = tokens[name];
        if (!modes) continue;
        retuned[name] = {};
        for (const mode of ['light', 'dark']) {
          retuned[name][mode] = String(modes[mode]).replace(/blur\(\s*([\d.]+)px\s*\)(?:\s*saturate\(\s*([\d.]+)%\s*\))?/i, (match, radius, saturation) => {
            const px = Math.round(Number.parseFloat(radius) * blurScale * 10) / 10;
            if (saturation === undefined) return `blur(${px}px)`;
            const percent = Math.round(Number.parseFloat(saturation) * saturateScale);
            return `blur(${px}px) saturate(${percent}%)`;
          });
        }
      }
      return retuned;
    }

    /** The palette with the user's tuning applied; `flat` has no layer, hence null. */
    function buildLayer(preset, tuning = DEFAULT_TUNING) {
      const tokens = MATERIALS[preset];
      if (!tokens) return null;
      const base = filterBase(tokens);
      const blurPx = tuning.blurPx ?? base.blur;
      const saturatePct = tuning.saturatePct ?? base.saturate;
      let layer = tokens;
      if (tuning.opacity !== 1) layer = scaleGlass(layer, tuning.opacity);
      if (blurPx !== base.blur || saturatePct !== base.saturate) {
        layer = retuneFilters(layer, base.blur > 0 ? blurPx / base.blur : 1, base.saturate > 0 ? saturatePct / base.saturate : 1);
      }
      return layer;
    }
    /* __MATERIALS_END__ */

    const zh = {
      title: '材质',
      tab: '材质',
      intro: '在内置配色之上叠一层渐变、半透明与模糊。浅色、深色、跟随系统的选择不受影响，随时可以回到原始材质。',
      presetLabel: '配色',
      soft: '柔和',
      vivid: '玻璃',
      latte: '拿铁',
      rose: '玫瑰',
      sage: '鼠尾草',
      nord: '极地',
      solar: '日光',
      one: '简白',
      github: '墨白',
      flexoki: '纸墨',
      gruvbox: '暖阳',
      ayu: '晴空',
      kanagawa: '莲花',
      tokyo: '东京',
      flat: '原始',
      softHint: '薄薄一层冷调玻璃：菜单和输入框带轻微磨砂。',
      vividHint: '更厚的玻璃：紫蓝色调、更强的模糊与投影，弹窗背后也会雾化。',
      latteHint: '奶咖底色配薰衣草洗色，取自 Catppuccin Latte。',
      roseHint: '暖纸色与灰紫，取自 Rosé Pine Dawn。',
      sageHint: '雾绿与米白，像 Everforest 的浅色。',
      nordHint: '雪原冷灰蓝，取自 Nord 的 Snow Storm。',
      solarHint: '暖米纸与深青蓝，Solarized Light 的纸感。',
      oneHint: '近白底配钴蓝，Atom One Light 的克制。',
      githubHint: '冷灰白与链接蓝，GitHub Primer 的工程感。',
      flexokiHint: '暖纸底、墨色文字、焦橙主按钮，Flexoki 的纸墨。',
      gruvboxHint: '复古奶油黄与深橙，Gruvbox 的暖。',
      ayuHint: '清透白底与天蓝，Ayu Light 的通透。',
      kanagawaHint: '宣纸黄底与靛蓝，Kanagawa Lotus。',
      tokyoHint: '蓝灰日光与夜蓝，Tokyo Night Day。',
      flatHint: '不叠任何材质层，内置样式原样显示。',
      flatTuning: '原始档没有材质层；选一套配色后滑杆才会生效。',
      tuningLabel: '细节',
      opacityLabel: '不透明度',
      blurLabel: '模糊',
      saturateLabel: '饱和',
      resetTuning: '重置滑杆',
      respectReduced: '跟随系统「降低透明效果」',
      reducedIgnored: '已忽略系统的降低透明度请求，模糊与饱和按滑杆生效。',
      previewLabel: '实时预览',
      previewHint: '拖动下面的滑杆，这块演示会立刻变化。',
      previewMenu: '菜单',
      previewItem: '普通项',
      previewHover: '悬停项',
      previewTag: '标签',
      previewCardTitle: '玻璃卡片',
      previewCardText: '半透明表面、描边与阴影都来自当前材质。',
      previewInline: '行内代码',
      previewButton: '主按钮',
      previewComposer: '输入消息…',
      previewCode: 'const material = "gradient + blur";',
      previewDiff: '+ material: gradient, translucency, blur',
      current: '当前生效：{preset}',
      frosted: '系统要求降低透明度（Windows「透明效果」已关闭），材质已加厚、模糊已关闭；关掉下面的开关可强制启用。',
      persistFailed: '材质偏好未能保存，本次会话仍然生效。',
    };
    const en = {
      title: 'Material',
      tab: 'Material',
      intro: 'A gradient, translucency and blur layer stacked over the built-in palettes. Your light, dark and system choice is untouched, and you can return to the original material at any time.',
      presetLabel: 'Palette',
      soft: 'Soft',
      vivid: 'Glass',
      latte: 'Latte',
      rose: 'Rosé',
      sage: 'Sage',
      nord: 'Nordic',
      solar: 'Daylight',
      one: 'One',
      github: 'GitHub',
      flexoki: 'Flexoki',
      gruvbox: 'Gruvbox',
      ayu: 'Ayu',
      kanagawa: 'Lotus',
      tokyo: 'Tokyo',
      flat: 'Original',
      softHint: 'A thin cool glass: menus and the composer get a light frost.',
      vividHint: 'Thicker glass — violet-blue tint, stronger blur and shadows, and a frosted modal backdrop.',
      latteHint: 'Cream base with a lavender wash, after Catppuccin Latte.',
      roseHint: 'Warm paper and dusky iris, after Rosé Pine Dawn.',
      sageHint: 'Misty green and off-white, after Everforest light.',
      nordHint: 'Arctic grey-blue, after Nord Snow Storm.',
      solarHint: 'Warm paper with deep cyan-blue, after Solarized Light.',
      oneHint: 'Near-white paper and cobalt, after Atom One Light.',
      githubHint: 'Cool grey-white and link blue, after GitHub Primer.',
      flexokiHint: 'Ink on warm paper with a burnt-orange primary, after Flexoki.',
      gruvboxHint: 'Retro cream and deep orange, after Gruvbox Light.',
      ayuHint: 'Clear white and sky blue, after Ayu Light.',
      kanagawaHint: 'Rice-paper yellow and indigo ink, after Kanagawa Lotus.',
      tokyoHint: 'Blue-grey daylight and night blue, after Tokyo Night Day.',
      flatHint: 'No layer at all; the built-in styles show through.',
      flatTuning: 'Original has no layer; pick a palette to make the sliders take effect.',
      tuningLabel: 'Details',
      opacityLabel: 'Opacity',
      blurLabel: 'Blur',
      saturateLabel: 'Saturation',
      resetTuning: 'Reset sliders',
      respectReduced: 'Respect reduced transparency',
      reducedIgnored: 'Reduced transparency is ignored; blur and saturation follow the sliders.',
      previewLabel: 'Live preview',
      previewHint: 'Drag the sliders below; this demo changes immediately.',
      previewMenu: 'Menu',
      previewItem: 'Item',
      previewHover: 'Hovered',
      previewTag: 'Tag',
      previewCardTitle: 'Glass card',
      previewCardText: 'Translucent surfaces, borders and shadows come from this layer.',
      previewInline: 'inline code',
      previewButton: 'Primary',
      previewComposer: 'Write a message…',
      previewCode: 'const material = "gradient + blur";',
      previewDiff: '+ material: gradient, translucency, blur',
      current: 'In effect: {preset}',
      frosted: 'The system asks for reduced transparency (Windows transparency effects are off), so the layer is thickened and blur is off. Turn the switch below off to force it.',
      persistFailed: 'Could not save the material choice; it still applies for this session.',
    };

    /** Panel chrome only; every colour it reads is a theme token. */
    const PAGE = {
      page: {
        boxSizing: 'border-box',
        height: '100%',
        minHeight: 0,
        overflow: 'auto',
        padding: 'calc(var(--dsh-frame-top-clearance, 24px) + 10px) 28px 36px',
        paddingLeft: 'max(28px, var(--dsh-frame-leading-clearance, 0px))',
        color: 'inherit',
        fontSize: '13px',
        lineHeight: 1.45,
      },
      content: { display: 'grid', gap: '16px', maxWidth: '620px', margin: '0 auto' },
      title: { margin: 0, fontSize: '18px', fontWeight: 600 },
      intro: { margin: '6px 0 0', opacity: 0.75 },
      section: { display: 'grid', gap: '10px', paddingTop: '4px' },
      groupTitle: { margin: 0, fontSize: '11px', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', opacity: 0.55 },
      pills: { display: 'flex', flexWrap: 'wrap', gap: '8px' },
      swatch: { width: '8px', height: '8px', borderRadius: '50%', boxShadow: 'inset 0 0 0 1px rgba(0, 0, 0, 0.14)' },
      sliderRow: { display: 'grid', gap: '6px' },
      sliderHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: '12px' },
      sliderValue: { opacity: 0.7, fontVariantNumeric: 'tabular-nums' },
      slider: { width: '100%', margin: 0, accentColor: 'var(--dsw-alias-brand-primary)' },
      tuningHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' },
      switchRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', fontSize: '12px' },
      reset: {
        padding: '4px 12px', borderRadius: 'var(--dsw-radius-sm)', border: '1px solid var(--dsw-alias-border-l3)',
        background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
        font: 'inherit', fontSize: '12px', cursor: 'pointer',
      },
      hint: { margin: 0, fontSize: '12px', opacity: 0.75 },
      warn: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-state-warn-primary, #d29922)' },
      status: { margin: 0, fontSize: '12px', opacity: 0.7 },
      /** A deliberately loud wallpaper: sharp stripes are what make blur and saturation visible at a glance. */
      wall: {
        position: 'relative', overflow: 'hidden', display: 'flex', flexWrap: 'wrap', gap: '14px',
        alignItems: 'center', justifyContent: 'space-between',
        padding: '16px', minHeight: '168px', boxSizing: 'border-box',
        border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 'var(--dsw-radius-lg)',
        background: 'linear-gradient(135deg, #ff9a3c 0%, #ff5f6d 24%, #7b61ff 52%, #1fa2ff 74%, #00c9a7 100%)',
      },
      stripes: {
        position: 'absolute', inset: 0, pointerEvents: 'none',
        background: 'repeating-linear-gradient(115deg, rgba(255, 255, 255, 0.62) 0 10px, rgba(255, 255, 255, 0) 10px 26px, rgba(0, 0, 0, 0.30) 26px 33px, rgba(0, 0, 0, 0) 33px 58px)',
      },
      demoMenu: {
        position: 'relative', width: '220px', padding: '8px', display: 'grid', gap: '2px',
        border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 'var(--dsw-radius-md)',
        background: 'var(--dsw-menu-surface-fill)',
        backdropFilter: 'var(--dsw-menu-backdrop-filter)',
        WebkitBackdropFilter: 'var(--dsw-menu-backdrop-filter)',
        boxShadow: 'var(--dsw-shadow-lv2)',
      },
      demoMenuRow: { padding: '2px 8px 4px', fontSize: '11px', opacity: 0.65 },
      demoItem: {
        padding: '6px 8px', borderRadius: 'var(--dsw-radius-sm)', fontSize: '12px',
        color: 'var(--dsw-alias-label-secondary)',
      },
      demoItemActive: { background: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-label-primary)' },
      demoTag: {
        justifySelf: 'start', margin: '4px 8px 2px', padding: '1px 6px', borderRadius: '999px',
        fontSize: '10px', background: 'var(--dsw-alias-markdown-tag)', color: 'var(--dsw-alias-label-secondary)',
      },
      demoCard: {
        position: 'relative', width: '240px', padding: '12px', display: 'grid', gap: '8px',
        border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 'var(--dsw-radius-lg)',
        background: 'var(--dsw-alias-bg-layer-1)', boxShadow: 'var(--dsw-shadow-lv2)',
      },
      demoCardTitle: { fontSize: '13px', fontWeight: 600 },
      demoCardText: { fontSize: '12px', lineHeight: 1.4, color: 'var(--dsw-alias-label-secondary)' },
      demoInline: {
        justifySelf: 'start', padding: '1px 6px', borderRadius: '4px', fontSize: '11px',
        background: 'var(--dsw-alias-markdown-inline-code)',
      },
      demoButton: {
        justifySelf: 'start', padding: '4px 10px', borderRadius: 'var(--dsw-radius-sm)', fontSize: '12px',
        background: 'var(--dsw-alias-button-primary-fill)', color: 'var(--dsw-alias-label-primary-foreground)',
      },
      previewRow: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '10px' },
      demoInput: {
        display: 'flex', alignItems: 'center', minHeight: '38px', padding: '0 12px',
        borderRadius: 'var(--dsw-radius-lg)', border: '1px solid var(--dsw-alias-border-l3)',
        background: 'var(--dsw-specific-input-major)', color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px',
      },
      demoCode: {
        display: 'grid', gap: '4px', minWidth: 0, padding: '8px 0', overflow: 'hidden',
        borderRadius: 'var(--dsw-radius-md)', background: 'var(--dsw-alias-markdown-code-block)',
        fontFamily: 'var(--dsh-font-family-code, monospace)', fontSize: '11px',
      },
      demoCodeLine: { padding: '1px 12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      demoDiff: { padding: '1px 12px', background: 'var(--dsw-alias-file-diff-added-bg)' },
    };

    function DemoItem({ style, children }) {
      return h('div', { style: { ...PAGE.demoItem, ...style } }, children);
    }

    /** A miniature of the surfaces every palette has to carry: menu, card, composer and code. */
    function Preview({ t }) {
      return h('section', { style: PAGE.section },
        h('h3', { style: PAGE.groupTitle }, t('previewLabel')),
        h('p', { style: PAGE.hint }, t('previewHint')),
        h('div', { style: PAGE.wall },
          h('span', { 'aria-hidden': true, style: PAGE.stripes }),
          h('div', { style: PAGE.demoMenu },
            h('div', { style: PAGE.demoMenuRow }, t('previewMenu')),
            h(DemoItem, null, t('previewItem')),
            h(DemoItem, { style: PAGE.demoItemActive }, t('previewHover')),
            h('span', { style: PAGE.demoTag }, t('previewTag'))),
          h('div', { style: PAGE.demoCard },
            h('div', { style: PAGE.demoCardTitle }, t('previewCardTitle')),
            h('div', { style: PAGE.demoCardText }, t('previewCardText')),
            h('span', { style: PAGE.demoInline }, t('previewInline')),
            h('span', { style: PAGE.demoButton }, t('previewButton')))),
        h('div', { style: PAGE.previewRow },
          h('div', { style: PAGE.demoInput }, t('previewComposer')),
          h('div', { style: PAGE.demoCode },
            h('div', { style: PAGE.demoCodeLine }, t('previewCode')),
            h('div', { style: { ...PAGE.demoCodeLine, ...PAGE.demoDiff } }, t('previewDiff')))));
    }

    function Slider({ label, value, min, max, step, readout, onChange, disabled = false }) {
      return h('label', { style: { ...PAGE.sliderRow, opacity: disabled ? 0.5 : 1 } },
        h('span', { style: PAGE.sliderHead },
          h('span', null, label),
          h('span', { style: PAGE.sliderValue }, readout)),
        h('input', {
          type: 'range',
          min: String(min),
          max: String(max),
          step: String(step),
          value: String(value),
          'aria-label': label,
          style: PAGE.slider,
          disabled,
          onChange: event => onChange(Number(event.target.value)),
        }));
    }

    /** `flat` is a choice without a layer, so the order list — not `MATERIALS` — is the domain. */
    const PRESETS = new Set(PRESET_ORDER);

    /** Read-through props: the chosen preset, the tuning, and whatever the layer could not deliver. */
    function Page(props) {
      const { t, read, subscribe, setPreset, setTuning, resetTuning, setRespectReduced } = props;
      const [state, setState] = useState(read);
      useEffect(() => subscribe(() => setState(read())), [read, subscribe]);
      const { tuning } = state;
      const layer = state.intent === 'flat' ? null : MATERIALS[state.intent];
      const base = filterBase(layer ?? MATERIALS.soft);
      const blurPx = tuning.blurPx ?? base.blur;
      const saturatePct = tuning.saturatePct ?? base.saturate;
      const tuned = tuning.opacity !== 1
        || (tuning.blurPx !== null && tuning.blurPx !== base.blur)
        || (tuning.saturatePct !== null && tuning.saturatePct !== base.saturate);
      const live = state.intent !== 'flat';
      return h('div', { style: PAGE.page },
        h('div', { style: PAGE.content },
          h('div', null,
            h('h2', { style: PAGE.title }, t('title')),
            h('p', { style: PAGE.intro }, t('intro'))),
          h('section', { style: PAGE.section },
            h('h3', { style: PAGE.groupTitle }, t('presetLabel')),
            h('div', { role: 'tablist', 'aria-label': t('presetLabel'), style: PAGE.pills },
              PRESET_ORDER.map(preset => h(Pill, {
                key: preset,
                id: `${PANEL_ID}-${preset}`,
                role: 'tab',
                'aria-selected': state.intent === preset,
                active: state.intent === preset,
                title: t(`${preset}Hint`),
                onClick: () => setPreset(preset),
              }, h('span', {
                style: { ...PAGE.swatch, background: `linear-gradient(135deg, ${SWATCHES[preset][0]}, ${SWATCHES[preset][1]})` },
              }), t(preset)))),
            h('p', { style: PAGE.hint }, t(`${state.intent}Hint`)),
            state.notice ? h('p', { style: PAGE.warn }, state.notice) : null),
          h(Preview, { t }),
          h('section', { style: PAGE.section },
            h('div', { style: PAGE.tuningHead },
              h('h3', { style: PAGE.groupTitle }, t('tuningLabel')),
              h('button', {
                type: 'button',
                style: { ...PAGE.reset, opacity: tuned && live ? 1 : 0.45, cursor: tuned && live ? 'pointer' : 'default' },
                disabled: !tuned || !live,
                onClick: resetTuning,
              }, t('resetTuning'))),
            h(Slider, {
              label: t('opacityLabel'),
              value: tuning.opacity,
              ...TUNING_LIMITS.opacity,
              readout: `${Math.round(tuning.opacity * 100)}%`,
              disabled: !live,
              onChange: next => setTuning('opacity', next),
            }),
            h(Slider, {
              label: t('blurLabel'),
              value: blurPx,
              ...TUNING_LIMITS.blurPx,
              readout: `${Math.round(blurPx)}px`,
              disabled: !live,
              onChange: next => setTuning('blurPx', next),
            }),
            h(Slider, {
              label: t('saturateLabel'),
              value: saturatePct,
              ...TUNING_LIMITS.saturatePct,
              readout: `${Math.round(saturatePct)}%`,
              disabled: !live,
              onChange: next => setTuning('saturatePct', next),
            }),
            live ? h('div', { style: PAGE.switchRow },
              h('span', null, t('respectReduced')),
              h(Switch, { checked: state.respectReduced, label: t('respectReduced'), onChange: setRespectReduced })) : null,
            state.systemReduced ? h('p', { style: PAGE.hint }, state.respectReduced ? t('frosted') : t('reducedIgnored')) : null,
            live ? null : h('p', { style: PAGE.hint }, t('flatTuning'))),
          h('p', { style: PAGE.status }, t('current', { preset: t(state.intent) }))));
    }

    return {
      inject: ['slots', 'locale', 'theme', 'connection', 'layout'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-material: locale');
        const t = ctx.locale.bind(NS);

        /** The one layer this package owns; `flat` leaves it null so the built-in sheets stand alone. */
        let disposeLayer = null;
        /** The compat stylesheet; it exists only while this package's layer is on. */
        let compatStyle = null;
        let compatSheetText = '';
        let intent = DEFAULT_PRESET;
        let tuning = { ...DEFAULT_TUNING };
        let respectReduced = true;
        let persistNotice = null;
        let persistTimer = null;
        const listeners = new Set();

        const reduce = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-transparency: reduce)') : undefined;
        const isReduced = () => respectReduced && reduce?.matches === true;

        function notify() {
          for (const listener of listeners) listener();
        }

        /**
         * The Desktop preload writes `data-platform` on `<html>` at DOMContentLoaded, which can land
         * after this module has painted its first layer. One attribute change settles the caption; the
         * web client never sets it, so the observer there stays idle.
         */
        function paintsWindowsCaption() {
          return document.documentElement.dataset.platform === 'win32';
        }

        /**
         * The compat stylesheet. It is rebuilt whenever the app's own stylesheets change, because
         * the CSS modules load their chunks lazily: the card's rule is in the main bundle, but the
         * ink rules only arrive with the sidebar. The sheet is created and removed inside this
         * package's effect, so nothing survives an unload.
         */
        function applyCompat() {
          const text = disposeLayer === null ? null : compatSheet();
          if (text === compatSheetText) return;
          compatSheetText = text;
          if (text === null) {
            compatStyle?.remove();
            compatStyle = null;
            return;
          }
          if (compatStyle === null) {
            compatStyle = document.createElement('style');
            compatStyle.dataset.dshMaterial = 'compat';
            document.head.appendChild(compatStyle);
          }
          compatStyle.textContent = text;
        }

        function repaint() {
          if (disposeLayer !== null) {
            disposeLayer();
            disposeLayer = null;
          }
          const layer = buildLayer(intent, tuning);
          if (layer !== null) {
            const painted = isReduced() ? frostify(layer) : layer;
            disposeLayer = ctx.theme.overrideTokens(SOURCE, paintsWindowsCaption() ? captionSafe(painted) : painted);
          }
          applyCompat();
          notify();
        }

        /** Everything the Host entry stores; an untouched slider is omitted so the palette keeps its own value. */
        function durable() {
          const payload = { preset: intent, opacity: tuning.opacity, respectReduced };
          if (tuning.blurPx !== null) payload.blurPx = tuning.blurPx;
          if (tuning.saturatePct !== null) payload.saturatePct = tuning.saturatePct;
          return payload;
        }

        function persist() {
          persistTimer = null;
          // The layer already applied in-process; a refused write is a durability failure, reported in place.
          void ctx.connection.rpc.call('/api', RPC_METHOD, { action: 'persist', ...durable() }, new AbortController().signal)
            .then((result) => {
              persistNotice = result && result.ok === false ? t('persistFailed') : null;
              notify();
            })
            .catch(() => {
              persistNotice = t('persistFailed');
              notify();
            });
        }

        /** Sliders fire per pixel; apply at once, write the profile once the hand stops moving. */
        function schedulePersist() {
          if (persistTimer !== null) clearTimeout(persistTimer);
          persistTimer = setTimeout(persist, 450);
        }

        function setPreset(preset) {
          if (!PRESETS.has(preset) || preset === intent) return;
          intent = preset;
          repaint();
          if (persistTimer !== null) {
            clearTimeout(persistTimer);
            persistTimer = null;
          }
          persist();
        }

        function setTuning(key, raw) {
          const limit = TUNING_LIMITS[key];
          if (limit === undefined || !Number.isFinite(raw)) return;
          const clamped = Math.min(limit.max, Math.max(limit.min, raw));
          const value = key === 'opacity' ? Math.round(clamped * 100) / 100 : Math.round(clamped);
          if (tuning[key] === value) return;
          tuning = { ...tuning, [key]: value };
          repaint();
          schedulePersist();
        }

        function setRespectReduced(next) {
          if (respectReduced === next) return;
          respectReduced = next;
          repaint();
          if (persistTimer !== null) {
            clearTimeout(persistTimer);
            persistTimer = null;
          }
          persist();
        }

        function resetTuning() {
          const layer = intent === 'flat' ? null : MATERIALS[intent];
          const base = layer === null ? { blur: 0, saturate: 100 } : filterBase(layer);
          if (tuning.opacity === 1 && tuning.blurPx === base.blur && tuning.saturatePct === base.saturate) return;
          tuning = { opacity: 1, blurPx: base.blur, saturatePct: base.saturate };
          repaint();
          if (persistTimer !== null) {
            clearTimeout(persistTimer);
            persistTimer = null;
          }
          persist();
        }

        /** Trust the Host reply only as far as it is a usable value; anything else keeps the defaults. */
        function adopt(value) {
          if (!value || typeof value !== 'object') return;
          if (PRESETS.has(value.preset)) intent = value.preset;
          const opacity = value.opacity;
          if (typeof opacity === 'number' && Number.isFinite(opacity)) {
            tuning.opacity = Math.min(TUNING_LIMITS.opacity.max, Math.max(TUNING_LIMITS.opacity.min, opacity));
          }
          for (const key of ['blurPx', 'saturatePct']) {
            const next = value[key];
            tuning[key] = typeof next === 'number' && Number.isFinite(next)
              ? Math.min(TUNING_LIMITS[key].max, Math.max(TUNING_LIMITS[key].min, next))
              : null;
          }
          if (typeof value.respectReduced === 'boolean') respectReduced = value.respectReduced;
        }

        ctx.effect(() => {
          if (reduce === undefined) return undefined;
          const onChange = () => repaint();
          reduce.addEventListener('change', onChange);
          return () => { reduce.removeEventListener('change', onChange); };
        }, 'dsh-material: reduced-transparency listener');

        ctx.effect(() => {
          let windows = paintsWindowsCaption();
          const observer = new MutationObserver(() => {
            if (paintsWindowsCaption() === windows) return;
            windows = !windows;
            repaint();
          });
          observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-platform'] });
          return () => { observer.disconnect(); };
        }, 'dsh-material: windows caption guard');

        ctx.effect(() => {
          let queued = false;
          const observer = new MutationObserver(() => {
            if (queued) return;
            queued = true;
            requestAnimationFrame(() => {
              queued = false;
              applyCompat();
            });
          });
          observer.observe(document.head, { childList: true });
          applyCompat();
          return () => { observer.disconnect(); };
        }, 'dsh-material: compat stylesheet');

        ctx.effect(() => () => {
          if (persistTimer !== null) clearTimeout(persistTimer);
          if (disposeLayer !== null) disposeLayer();
          compatStyle?.remove();
          compatStyle = null;
          compatSheetText = '';
          listeners.clear();
        }, 'dsh-material: override layer');

        // The durable default is the Host entry's config; the browser has no storage of its own.
        void ctx.connection.rpc.call('/api', RPC_METHOD, { action: 'read' }, new AbortController().signal)
          .then((result) => {
            adopt(result && result.ok ? result.value : undefined);
            repaint();
          })
          .catch(() => { repaint(); });

        /** Plain data plus callbacks: the page never sees `ctx` or the layer handle. */
        const read = () => ({
          intent, tuning: { ...tuning }, reduced: isReduced(),
          systemReduced: reduce?.matches === true, respectReduced, notice: persistNotice,
        });
        const subscribe = (fn) => {
          listeners.add(fn);
          return () => { listeners.delete(fn); };
        };

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: PANEL_ID, locale: NS,
        }, () => h(Page, { t, read, subscribe, setPreset, setTuning, resetTuning, setRespectReduced })));

        // Desktop already carries 会话协作 (-20) and 压缩目标 (-10) ahead of the two built-in rows (0),
        // so -5 puts Material third there; on the web the two built-ins register first (0), so 10 lands third.
        const panelOrder = navigator.userAgent.includes("Electron/") ? -5 : 10;
        ctx.slots.inject('sidebar.panellist.actions', () => ctx.slots.register({
          name: 'sidebar.panellist.actions', id: PANEL_ID, order: panelOrder, locale: NS,
        }, ({ onDismiss }) => h(MenuItemButton, {
          icon: h(IconSparkleRegular, { size: 16 }),
          current: ctx.layout.panelInfo.getSnapshot().activePanelId === PANEL_ID,
          onSelect: () => {
            onDismiss();
            ctx.layout.selectPanel(PANEL_ID);
          },
        }, t('tab'))));
      },
    };
  },
});
