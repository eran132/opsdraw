import type { ArchEdge, Diagram, Side } from './model';
import { GENERIC_CATALOG, MERMAID_BUILTIN_ICONS, parseIconRef } from './icons';

/**
 * Lint checks for diagrams that parse fine but will render badly or not as intended:
 * icons that other Mermaid renderers can't draw, edges sharing a node side, unknown icons and
 * leftovers such as empty groups or unconnected services.
 */

export interface LintIssue {
  severity: 'warning' | 'info';
  /** Stable machine-readable code, e.g. `port-conflict`. */
  code: string;
  message: string;
  nodeId?: string;
  /** 1-based line of the node's declaration, when `source` was given. */
  line?: number;
}

export interface LintOptions {
  /** Returns false for icon references that don't exist. Enables `unknown-icon`. */
  knownIcons?: (ref: string) => boolean;
  /** Icon references to draw suggestions from (default: built-ins and the curated catalog). */
  iconCandidates?: readonly string[];
  /** The diagram's Mermaid text, used to attach line numbers to node issues. */
  source?: string;
}

const BUILTINS = new Set<string>(MERMAID_BUILTIN_ICONS);

const DEFAULT_CANDIDATES = [
  ...MERMAID_BUILTIN_ICONS,
  ...GENERIC_CATALOG.flatMap((c) => c.icons.map((i) => i.ref)),
];

/** Classic Levenshtein edit distance. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * Up to `n` candidates closest to `ref`, by edit distance on the name part (`lucide:servr` is
 * compared as `servr`). Candidates with the same prefix win ties; names that contain the query
 * (or are contained in it) count as close. Far-off names are not suggested at all.
 */
export function suggestIcons(ref: string, candidates: Iterable<string>, n = 3): string[] {
  const want = parseIconRef(ref.trim().toLowerCase());
  if (!want.name) return [];
  const limit = Math.max(2, Math.floor(want.name.length / 2));
  const scored: { ref: string; score: number }[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c)) continue;
    seen.add(c);
    const have = parseIconRef(c.toLowerCase());
    let d = levenshtein(want.name, have.name);
    if (
      d &&
      want.name.length >= 3 &&
      (have.name.includes(want.name) || want.name.includes(have.name))
    )
      d = Math.min(d, 1 + Math.abs(have.name.length - want.name.length) / 100);
    if (d > limit) continue;
    const samePrefix = (have.prefix ?? '') === (want.prefix ?? '');
    scored.push({ ref: c, score: d + (samePrefix ? 0 : 0.5) });
  }
  scored.sort((x, y) => x.score - y.score || x.ref.localeCompare(y.ref));
  return scored.slice(0, Math.max(0, n)).map((s) => s.ref);
}

/** Line numbers of node declarations in Mermaid source. */
function declarationLines(source: string): Map<string, number> {
  const out = new Map<string, number>();
  source
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .forEach((l, i) => {
      const m = /^\s*(?:service|group|junction)\s+([A-Za-z_][\w-]*)/.exec(l);
      if (m && !out.has(m[1]!)) out.set(m[1]!, i + 1);
    });
  return out;
}

const SIDE_NAMES: Record<Side, string> = { T: 'top', B: 'bottom', L: 'left', R: 'right' };

const edgeText = (e: ArchEdge) => `${e.from}:${e.fromSide} -> ${e.toSide}:${e.to}`;

export function lintDiagram(diagram: Diagram, options: LintOptions = {}): LintIssue[] {
  const issues: LintIssue[] = [];
  const lines = options.source ? declarationLines(options.source) : new Map<string, number>();
  const at = (nodeId: string): Pick<LintIssue, 'nodeId' | 'line'> => {
    const line = lines.get(nodeId);
    return line === undefined ? { nodeId } : { nodeId, line };
  };

  // Icons GitHub/GitLab won't draw: anything that needs a registered icon pack.
  const packed = diagram.nodes.filter((n) => n.icon && !BUILTINS.has(n.icon));
  if (packed.length) {
    const ids = packed.map((n) => n.id);
    issues.push({
      severity: 'info',
      code: 'github-icons',
      message: `${ids.length} node(s) use icons that GitHub/GitLab's Mermaid can't draw (${ids.join(', ')}); export an SVG next to the file (opsdraw export) or use built-in icons (${MERMAID_BUILTIN_ICONS.join(', ')})`,
    });
  }

  if (options.knownIcons) {
    const candidates = options.iconCandidates ?? DEFAULT_CANDIDATES;
    for (const n of diagram.nodes) {
      if (!n.icon || options.knownIcons(n.icon)) continue;
      const tips = suggestIcons(n.icon, candidates, 3);
      issues.push({
        severity: 'warning',
        code: 'unknown-icon',
        message: `"${n.id}" uses unknown icon "${n.icon}"${tips.length ? `; did you mean ${tips.join(', ')}?` : ''}`,
        ...at(n.id),
      });
    }
  }

  // Mermaid architecture diagrams allow one edge per node side. Edges with a {group} modifier
  // attach to the group boundary instead, so they are left out.
  const ports = new Map<string, ArchEdge[]>();
  const use = (node: string, side: Side, e: ArchEdge) => {
    const k = `${node}\0${side}`;
    ports.set(k, [...(ports.get(k) ?? []), e]);
  };
  for (const e of diagram.edges) {
    if (!e.fromGroup) use(e.from, e.fromSide, e);
    if (!e.toGroup) use(e.to, e.toSide, e);
  }
  for (const [k, edges] of ports) {
    if (edges.length < 2) continue;
    const [node, side] = k.split('\0') as [string, Side];
    issues.push({
      severity: 'warning',
      code: 'port-conflict',
      message: `${edges.length} edges use the ${SIDE_NAMES[side]} (${side}) side of "${node}" (${edges.map(edgeText).join('; ')}); Mermaid allows one edge per side, so move one to another side or route them through a junction`,
      ...at(node),
    });
  }

  const parents = new Set(diagram.nodes.map((n) => n.parent).filter(Boolean));
  for (const n of diagram.nodes) {
    if (n.kind === 'group' && !parents.has(n.id)) {
      issues.push({
        severity: 'info',
        code: 'empty-group',
        message: `Group "${n.id}" is empty`,
        ...at(n.id),
      });
    }
  }

  if (diagram.edges.length >= 3) {
    const connected = new Set(diagram.edges.flatMap((e) => [e.from, e.to]));
    for (const n of diagram.nodes) {
      if (n.kind === 'service' && !connected.has(n.id)) {
        issues.push({
          severity: 'info',
          code: 'isolated-node',
          message: `Service "${n.id}" has no edges`,
          ...at(n.id),
        });
      }
    }
  }

  return issues;
}
