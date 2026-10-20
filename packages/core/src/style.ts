import type { NodeStyle } from './model';

/**
 * Per-node colors, stored as `%% @style <id> key=value ...` comment lines (Mermaid ignores them).
 *
 * Values are restricted to `#rgb` / `#rrggbb` hex or a small named palette whose colors follow
 * the light/dark theme. Anything else is dropped when parsing and again when rendering, so a
 * hand-edited file can never inject CSS or markup into an export.
 */

export const STYLE_KEYS = ['color', 'fill', 'stroke'] as const;
export type StyleKey = (typeof STYLE_KEYS)[number];

export const PALETTE_NAMES = [
  'blue',
  'green',
  'orange',
  'red',
  'purple',
  'gray',
  'teal',
  'yellow',
] as const;
export type PaletteName = (typeof PALETTE_NAMES)[number];

interface Swatch {
  fill: string;
  stroke: string;
  color: string;
}

/** Theme-aware palette: translucent tints for fills, saturated strokes, readable text. */
export const PALETTE: Record<PaletteName, { light: Swatch; dark: Swatch }> = {
  blue: {
    light: { fill: 'rgba(37,99,235,0.10)', stroke: '#2563eb', color: '#1d4ed8' },
    dark: { fill: 'rgba(96,165,250,0.16)', stroke: '#60a5fa', color: '#93c5fd' },
  },
  green: {
    light: { fill: 'rgba(22,163,74,0.10)', stroke: '#16a34a', color: '#15803d' },
    dark: { fill: 'rgba(74,222,128,0.14)', stroke: '#4ade80', color: '#86efac' },
  },
  orange: {
    light: { fill: 'rgba(234,88,12,0.10)', stroke: '#ea580c', color: '#c2410c' },
    dark: { fill: 'rgba(251,146,60,0.16)', stroke: '#fb923c', color: '#fdba74' },
  },
  red: {
    light: { fill: 'rgba(220,38,38,0.10)', stroke: '#dc2626', color: '#b91c1c' },
    dark: { fill: 'rgba(248,113,113,0.16)', stroke: '#f87171', color: '#fca5a5' },
  },
  purple: {
    light: { fill: 'rgba(147,51,234,0.10)', stroke: '#9333ea', color: '#7e22ce' },
    dark: { fill: 'rgba(192,132,252,0.16)', stroke: '#c084fc', color: '#d8b4fe' },
  },
  gray: {
    light: { fill: 'rgba(100,116,139,0.12)', stroke: '#64748b', color: '#475569' },
    dark: { fill: 'rgba(148,163,184,0.16)', stroke: '#94a3b8', color: '#cbd5e1' },
  },
  teal: {
    light: { fill: 'rgba(13,148,136,0.10)', stroke: '#0d9488', color: '#0f766e' },
    dark: { fill: 'rgba(45,212,191,0.14)', stroke: '#2dd4bf', color: '#5eead4' },
  },
  yellow: {
    light: { fill: 'rgba(202,138,4,0.14)', stroke: '#ca8a04', color: '#a16207' },
    dark: { fill: 'rgba(250,204,21,0.14)', stroke: '#facc15', color: '#fde047' },
  },
};

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/;
const NAMES = new Set<string>(PALETTE_NAMES);

export const isPaletteName = (v: string): v is PaletteName => NAMES.has(v);

/** A safe, normalized (lowercase) color value, or undefined when it is not allowed. */
export function sanitizeColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  return HEX_RE.test(v) || NAMES.has(v) ? v : undefined;
}

/** Keeps only known keys with allowed values; undefined when nothing is left. */
export function sanitizeStyle(style: unknown): NodeStyle | undefined {
  if (!style || typeof style !== 'object') return undefined;
  const out: NodeStyle = {};
  for (const k of STYLE_KEYS) {
    const v = sanitizeColor((style as Record<string, unknown>)[k]);
    if (v) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Parses the `key=value ...` part of a `%% @style` line. Unknown or unsafe pairs are dropped. */
export function parseStyleTokens(text: string): NodeStyle | undefined {
  const raw: Record<string, string> = {};
  for (const tok of text.trim().split(/\s+/).filter(Boolean)) {
    const eq = tok.indexOf('=');
    if (eq <= 0) continue;
    const key = tok.slice(0, eq).toLowerCase();
    if ((STYLE_KEYS as readonly string[]).includes(key)) raw[key] = tok.slice(eq + 1);
  }
  return sanitizeStyle(raw);
}

/** `key=value` pairs in sorted key order, or '' for an empty style. */
export function formatStyle(style: NodeStyle | undefined): string {
  const s = sanitizeStyle(style);
  if (!s) return '';
  return STYLE_KEYS.filter((k) => s[k])
    .map((k) => `${k}=${s[k]}`)
    .join(' ');
}

/**
 * The concrete color for a value: hex as is, palette names for the given theme. Returns
 * undefined for anything not allowed.
 */
export function resolveColor(
  value: string | undefined,
  role: StyleKey,
  theme: 'light' | 'dark',
): string | undefined {
  const v = sanitizeColor(value);
  if (!v) return undefined;
  return isPaletteName(v) ? PALETTE[v][theme][role] : v;
}

/** CSS custom properties for every palette color, `--<prefix>-<name>-<role>:<color>;`. */
export function paletteVars(theme: 'light' | 'dark', prefix = 'pal'): string {
  return PALETTE_NAMES.map((name) =>
    STYLE_KEYS.map((role) => `--${prefix}-${name}-${role}:${PALETTE[name][theme][role]};`).join(''),
  ).join('');
}

/**
 * A CSS color for a value that follows the theme through `paletteVars` custom properties:
 * hex as is, palette names as `var(--<prefix>-<name>-<role>)`.
 */
export function cssColor(
  value: string | undefined,
  role: StyleKey,
  prefix = 'pal',
): string | undefined {
  const v = sanitizeColor(value);
  if (!v) return undefined;
  return isPaletteName(v) ? `var(--${prefix}-${v}-${role})` : v;
}
