import lucide from '@iconify-json/lucide/icons.json';
import {
  BUILTIN_TO_LUCIDE,
  GENERIC_CATALOG,
  MERMAID_BUILTIN_ICONS,
  parseIconRef,
} from '@archidraw/core';
import { createStore, del, entries, set } from 'idb-keyval';
import mermaid from 'mermaid';

/** Iconify JSON subset; this is also the format Mermaid's registerIconPacks accepts. */
export interface IconPack {
  prefix: string;
  /** Human name shown in the UI, e.g. the zip file name. */
  name: string;
  width?: number;
  height?: number;
  icons: Record<string, { body: string; width?: number; height?: number }>;
  /** Extra search text per icon (original file name and folder). */
  keywords?: Record<string, string>;
}

const lucidePack = lucide as unknown as IconPack;
const RESERVED = new Set(['lucide', ...MERMAID_BUILTIN_ICONS]);
const packStore = createStore('archidraw', 'icon-packs');
const userPacks = new Map<string, IconPack>();
const listeners = new Set<() => void>();

export const isReservedPrefix = (prefix: string) => RESERVED.has(prefix);

export function onPacksChanged(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export const installedPacks = () => [...userPacks.values()];

export async function loadPacks() {
  try {
    for (const [, pack] of await entries<string, IconPack>(packStore))
      userPacks.set(pack.prefix, pack);
  } catch {
    // IndexedDB unavailable (private window): vendor packs just won't persist.
  }
  registerMermaidPacks();
  listeners.forEach((fn) => fn());
}

export async function savePack(pack: IconPack) {
  userPacks.set(pack.prefix, pack);
  try {
    await set(pack.prefix, pack, packStore);
  } catch {
    // Keep it for this session even if it cannot be stored.
  }
  registerMermaidPacks();
  listeners.forEach((fn) => fn());
}

export async function removePack(prefix: string) {
  userPacks.delete(prefix);
  try {
    await del(prefix, packStore);
  } catch {
    // Nothing stored to remove.
  }
  registerMermaidPacks();
  listeners.forEach((fn) => fn());
}

function registerMermaidPacks() {
  mermaid.registerIconPacks([
    { name: 'lucide', icons: lucidePack as never },
    ...[...userPacks.values()].map((p) => ({ name: p.prefix, icons: p as never })),
  ]);
}

export interface ResolvedIcon {
  body: string;
  width: number;
  height: number;
}

/** Looks up an icon reference for drawing on the canvas. */
export function resolveIcon(ref: string | undefined): ResolvedIcon | null {
  if (!ref) return null;
  const { prefix, name } = parseIconRef(ref);
  const pack =
    prefix === null ? lucidePack : prefix === 'lucide' ? lucidePack : userPacks.get(prefix);
  if (!pack) return null;
  const key = prefix === null ? BUILTIN_TO_LUCIDE[name] : name;
  if (!key) return null;
  const aliases = (pack as { aliases?: Record<string, { parent: string }> }).aliases;
  const icon = pack.icons[key] ?? (aliases?.[key] ? pack.icons[aliases[key].parent] : undefined);
  if (!icon) return null;
  return {
    body: icon.body,
    width: icon.width ?? pack.width ?? 24,
    height: icon.height ?? pack.height ?? 24,
  };
}

export interface SearchHit {
  ref: string;
  title: string;
}

const lucideNames = Object.keys(lucidePack.icons);

/** Searches the curated set first, then every Lucide icon, then imported packs. */
export function searchIcons(query: string, limit = 60): SearchHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const matches = (text: string) => terms.every((t) => text.includes(t));
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const push = (ref: string, title: string) => {
    if (seen.has(ref) || hits.length >= limit) return;
    seen.add(ref);
    hits.push({ ref, title });
  };
  for (const cat of GENERIC_CATALOG)
    for (const icon of cat.icons)
      if (matches(`${icon.ref} ${icon.keywords}`)) push(icon.ref, icon.ref);
  for (const pack of userPacks.values())
    for (const name of Object.keys(pack.icons))
      if (matches(`${name} ${pack.keywords?.[name] ?? ''}`.toLowerCase()))
        push(`${pack.prefix}:${name}`, name);
  for (const name of lucideNames) if (matches(name)) push(`lucide:${name}`, name);
  return hits;
}
