import { createRequire } from 'node:module';
import { BUILTIN_TO_LUCIDE, parseIconRef } from '@opsdraw/core';
import type { IconData } from '@opsdraw/core';

interface IconSet {
  width?: number;
  height?: number;
  icons: Record<string, { body: string; width?: number; height?: number }>;
  aliases?: Record<string, { parent: string }>;
}

let lucide: IconSet | null | undefined;

function loadLucide(): IconSet | null {
  if (lucide !== undefined) return lucide;
  try {
    lucide = createRequire(import.meta.url)('@iconify-json/lucide/icons.json') as IconSet;
  } catch {
    lucide = null;
  }
  return lucide;
}

/**
 * Resolves icon references for SVG export: Mermaid built-ins and `lucide:*` come from the
 * bundled Lucide set. Anything else (vendor packs such as `aws:`) is recorded in `unresolved`
 * and drawn as a placeholder.
 */
export function createIconResolver(): {
  resolve: (ref: string) => IconData | null;
  unresolved: Set<string>;
} {
  const unresolved = new Set<string>();
  const resolve = (ref: string): IconData | null => {
    const { prefix, name } = parseIconRef(ref);
    const set = loadLucide();
    const key = prefix === null ? BUILTIN_TO_LUCIDE[name] : prefix === 'lucide' ? name : null;
    const icon =
      set && key ? (set.icons[key] ?? set.icons[set.aliases?.[key]?.parent ?? '']) : null;
    if (!icon || !set) {
      unresolved.add(ref);
      return null;
    }
    return {
      body: icon.body,
      width: icon.width ?? set.width ?? 24,
      height: icon.height ?? set.height ?? 24,
    };
  };
  return { resolve, unresolved };
}

/**
 * Icon checks for `validate`: bare names must be Mermaid built-ins and `lucide:` names must exist
 * in the bundled set. Other prefixes are user-imported packs and are accepted. Returns no
 * checker when the Lucide set can't be loaded.
 */
export function createIconChecker(): {
  knownIcons: (ref: string) => boolean;
  candidates: string[];
} | null {
  const set = loadLucide();
  if (!set) return null;
  const names = [...Object.keys(set.icons), ...Object.keys(set.aliases ?? {})];
  const lucideNames = new Set(names);
  const knownIcons = (ref: string) => {
    const { prefix, name } = parseIconRef(ref);
    if (prefix === null) return Object.hasOwn(BUILTIN_TO_LUCIDE, name);
    return prefix !== 'lucide' || lucideNames.has(name);
  };
  return {
    knownIcons,
    candidates: [...Object.keys(BUILTIN_TO_LUCIDE), ...names.map((n) => `lucide:${n}`)],
  };
}
