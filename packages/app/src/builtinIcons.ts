import { parseIconRef, type Diagram } from '@opsdraw/core';

/** Lucide icons and the closest of the five icons GitHub's and GitLab's Mermaid draw. */
const LUCIDE_TO_BUILTIN: [RegExp, string][] = [
  [/^(server(-.*)?|cpu|microchip|container|computer|rack)$/, 'server'],
  [/^database(-.*)?$/, 'database'],
  [/^(hard-drive(-.*)?|archive(-.*)?|disc(-.*)?|save|drive)$/, 'disk'],
  [/^(globe(-.*)?|earth(-.*)?|waypoints|internet|world)$/, 'internet'],
  [/^cloud(-(cog|upload|download|check|alert|off))?$/, 'cloud'],
];

/** True when the reference needs an icon pack (anything other than a Mermaid built-in). */
export const isPrefixedIcon = (ref: string | undefined): boolean =>
  !!ref && parseIconRef(ref).prefix !== null;

/** The built-in icon closest to a Lucide reference, or null when there is no good match. */
export function builtinFor(ref: string | undefined): string | null {
  if (!ref) return null;
  const { prefix, name } = parseIconRef(ref);
  if (prefix !== 'lucide') return null;
  for (const [re, builtin] of LUCIDE_TO_BUILTIN) if (re.test(name)) return builtin;
  return null;
}

/** Swaps every mappable Lucide icon for its built-in; other icons are left alone. */
export function toBuiltinIcons(diagram: Diagram): { diagram: Diagram; changed: number } {
  let changed = 0;
  const nodes = diagram.nodes.map((n) => {
    const builtin = builtinFor(n.icon);
    if (!builtin) return n;
    changed++;
    return { ...n, icon: builtin };
  });
  return { diagram: changed ? { ...diagram, nodes } : diagram, changed };
}
