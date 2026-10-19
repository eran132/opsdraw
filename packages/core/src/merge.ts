import type { ArchEdge, ArchNode, Diagram, NodeLayout } from './model';
import type { LayoutDirection } from './layout';
import { GROUP_PADDING, JUNCTION_SIZE, SERVICE_SIZE, autoLayout } from './layout';
import { sidesFor } from './mermaid';
import { absoluteRects } from './svg';

/**
 * Re-import support: carry hand-made layout from a previous version of a diagram over to a
 * freshly generated one, and describe what changed structurally between the two.
 *
 * "Structure" is everything except layout: node ids, kinds, labels, icons, parents, edges with
 * their arrows/labels/{group} modifiers, and the title. Positions, sizes, edge sides, free-form
 * comments and declaration order are layout or presentation and are ignored.
 */

/** Stable key for an edge's endpoints, as shown in reports: `from->to`. */
export const edgeKey = (e: Pick<ArchEdge, 'from' | 'to'>): string => `${e.from}->${e.to}`;

export interface StructuralDiff {
  /** Node ids present only in the second diagram. */
  added: string[];
  /** Node ids present only in the first diagram. */
  removed: string[];
  /** Node ids present in both whose kind, label, icon or parent differ. */
  changed: string[];
  /** `from->to` keys of edges present only in the second diagram. */
  addedEdges: string[];
  /** `from->to` keys of edges present only in the first diagram. */
  removedEdges: string[];
  /** `from->to` keys of edges present in both whose arrows, label or {group} modifiers differ. */
  changedEdges: string[];
  /** Whether the titles differ. */
  titleChanged: boolean;
}

export interface MergeResult extends StructuralDiff {
  diagram: Diagram;
  /** Ids whose stored position (and group size) was carried over from the previous diagram. */
  kept: string[];
  /** `from->to` keys of edges whose sides were carried over. */
  keptEdges: string[];
}

const NODE_FIELDS = ['kind', 'label', 'icon', 'parent'] as const;

/** Names of the structural fields that differ between two versions of a node. */
export function nodeChanges(a: ArchNode, b: ArchNode): (typeof NODE_FIELDS)[number][] {
  return NODE_FIELDS.filter((f) => (a[f] ?? '') !== (b[f] ?? ''));
}

const edgeShape = (e: ArchEdge): string =>
  JSON.stringify([!!e.arrowStart, !!e.arrowEnd, e.label ?? '', !!e.fromGroup, !!e.toGroup]);

/** Groups edges by `from->to`, each with a sorted list of shapes (handles duplicate pairs). */
function edgeIndex(edges: ArchEdge[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of edges) {
    const k = edgeKey(e);
    out.set(k, [...(out.get(k) ?? []), edgeShape(e)]);
  }
  for (const v of out.values()) v.sort();
  return out;
}

const sorted = (xs: Iterable<string>) => [...xs].sort();

/** Structural differences going from `a` to `b`. Every list is sorted, so output is stable. */
export function diffStructure(a: Diagram, b: Diagram): StructuralDiff {
  const aNodes = new Map(a.nodes.map((n) => [n.id, n]));
  const bNodes = new Map(b.nodes.map((n) => [n.id, n]));
  const aEdges = edgeIndex(a.edges);
  const bEdges = edgeIndex(b.edges);
  const changed: string[] = [];
  for (const [id, n] of bNodes) {
    const prev = aNodes.get(id);
    if (prev && nodeChanges(prev, n).length) changed.push(id);
  }
  const changedEdges: string[] = [];
  for (const [k, shapes] of bEdges) {
    const prev = aEdges.get(k);
    if (prev && prev.join('\n') !== shapes.join('\n')) changedEdges.push(k);
  }
  return {
    added: sorted([...bNodes.keys()].filter((id) => !aNodes.has(id))),
    removed: sorted([...aNodes.keys()].filter((id) => !bNodes.has(id))),
    changed: sorted(changed),
    addedEdges: sorted([...bEdges.keys()].filter((k) => !aEdges.has(k))),
    removedEdges: sorted([...aEdges.keys()].filter((k) => !bEdges.has(k))),
    changedEdges: sorted(changedEdges),
    titleChanged: (a.title ?? '') !== (b.title ?? ''),
  };
}

/** True when the diagrams differ only in layout, comments, edge sides or declaration order. */
export function structurallyEqual(a: Diagram, b: Diagram): boolean {
  const d = diffStructure(a, b);
  return (
    !d.titleChanged &&
    !d.added.length &&
    !d.removed.length &&
    !d.changed.length &&
    !d.addedEdges.length &&
    !d.removedEdges.length &&
    !d.changedEdges.length
  );
}

/**
 * Takes the structure of `next` and the layout of `previous`.
 *
 * - A node that exists in both keeps its previous position (and group size), unless its parent
 *   changed: positions are relative to the parent, so a moved node gets a fresh position.
 * - An edge whose `from->to` pair exists in both keeps its previous sides.
 * - The previous diagram's free-form comments are kept, and so is its title when `next` has none.
 *
 * Nodes without a position afterwards (new or re-parented) can be placed with `layoutNewNodes`.
 */
export function mergeLayout(previous: Diagram, next: Diagram): MergeResult {
  const prevNodes = new Map(previous.nodes.map((n) => [n.id, n]));
  const layout: Record<string, NodeLayout> = {};
  const kept: string[] = [];
  for (const n of next.nodes) {
    const prev = prevNodes.get(n.id);
    const pos = previous.layout[n.id];
    if (!prev || !pos || (prev.parent ?? '') !== (n.parent ?? '')) continue;
    layout[n.id] = { ...pos };
    kept.push(n.id);
  }

  const prevSides = new Map<string, ArchEdge>();
  for (const e of previous.edges) if (!prevSides.has(edgeKey(e))) prevSides.set(edgeKey(e), e);
  const keptEdges = new Set<string>();
  const edges = next.edges.map((e) => {
    const prev = prevSides.get(edgeKey(e));
    if (!prev) return { ...e };
    keptEdges.add(edgeKey(e));
    return { ...e, fromSide: prev.fromSide, toSide: prev.toSide };
  });

  const diagram: Diagram = {
    nodes: next.nodes.map((n) => ({ ...n })),
    edges,
    layout,
    comments: next.comments.length ? [...next.comments] : [...previous.comments],
  };
  const title = next.title ?? previous.title;
  if (title !== undefined) diagram.title = title;

  return {
    ...diffStructure(previous, diagram),
    diagram,
    kept: sorted(kept),
    keptEdges: sorted(keptEdges),
  };
}

export interface LayoutNewNodesOptions {
  direction?: LayoutDirection;
  /** `from->to` keys of edges whose sides must not be re-picked (e.g. `MergeResult.keptEdges`). */
  pinnedEdges?: Set<string>;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const GAP = 48;

/**
 * Gives every node outside `pinned` a position, leaving pinned nodes where they are.
 *
 * This is deliberately simple: ELK lays out the whole diagram, then pinned positions are put
 * back. Within each container, newly placed nodes keep their ELK arrangement but are moved as
 * a block below the pinned siblings so they don't land on top of them, and pinned groups grow
 * to fit their children. Edge sides are re-picked from the final geometry, except for
 * `pinnedEdges`. A true incremental layout (ELK with fixed nodes) is future work.
 *
 * When every node is pinned (and, if `pinnedEdges` is given, every edge too) the diagram is
 * returned unchanged, so a no-op re-import is byte-stable.
 */
export async function layoutNewNodes(
  diagram: Diagram,
  pinned: Set<string>,
  options: LayoutNewNodesOptions = {},
): Promise<Diagram> {
  const isPinned = (id: string) => pinned.has(id) && !!diagram.layout[id];
  const free = diagram.nodes.filter((n) => !isPinned(n.id));
  const repick = (e: ArchEdge) => !options.pinnedEdges?.has(edgeKey(e));
  if (!free.length && !(options.pinnedEdges && diagram.edges.some(repick))) return diagram;

  const elk = free.length ? await autoLayout(diagram, options.direction ?? 'RIGHT') : diagram;
  const layout: Record<string, NodeLayout> = {};
  for (const n of diagram.nodes) {
    const l = isPinned(n.id) ? diagram.layout[n.id] : elk.layout[n.id];
    if (l) layout[n.id] = { ...l };
  }

  const byId = new Map(diagram.nodes.map((n) => [n.id, n]));
  const box = (n: ArchNode): Box => {
    const l = layout[n.id] ?? { x: 0, y: 0 };
    const size = n.kind === 'junction' ? JUNCTION_SIZE : SERVICE_SIZE;
    return { x: l.x, y: l.y, w: l.w ?? size.w, h: l.h ?? size.h };
  };
  const depth = (n: ArchNode) => {
    let d = 0;
    for (let p = n.parent; p && byId.has(p) && d < 64; p = byId.get(p)?.parent) d++;
    return d;
  };
  const scopeOf = (n: ArchNode) => (n.parent && byId.has(n.parent) ? n.parent : '');

  // Move each container's new nodes, as one block, below its pinned nodes.
  const scopes = new Map<string, ArchNode[]>();
  for (const n of diagram.nodes) {
    const s = scopeOf(n);
    scopes.set(s, [...(scopes.get(s) ?? []), n]);
  }
  for (const kids of scopes.values()) {
    const old = kids.filter((n) => isPinned(n.id)).map(box);
    const fresh = kids.filter((n) => !isPinned(n.id));
    if (!old.length || !fresh.length) continue;
    const freshBoxes = fresh.map(box);
    const left = Math.min(...old.map((b) => b.x));
    const bottom = Math.max(...old.map((b) => b.y + b.h));
    const dx = left - Math.min(...freshBoxes.map((b) => b.x));
    const dy = bottom + GAP - Math.min(...freshBoxes.map((b) => b.y));
    for (const n of fresh) {
      const l = layout[n.id];
      if (l) layout[n.id] = { ...l, x: l.x + dx, y: l.y + dy };
    }
  }

  // Grow pinned groups (innermost first) so their children fit.
  const groups = diagram.nodes
    .filter((n) => n.kind === 'group' && isPinned(n.id))
    .sort((a, b) => depth(b) - depth(a));
  for (const g of groups) {
    const kids = scopes.get(g.id) ?? [];
    const l = layout[g.id];
    if (!kids.length || !l) continue;
    const boxes = kids.map(box);
    const needW = Math.max(...boxes.map((b) => b.x + b.w)) + GROUP_PADDING.side;
    const needH = Math.max(...boxes.map((b) => b.y + b.h)) + GROUP_PADDING.side;
    const cur = box(g);
    if (needW > cur.w || needH > cur.h) {
      layout[g.id] = { ...l, w: Math.max(cur.w, needW), h: Math.max(cur.h, needH) };
    }
  }

  const out: Diagram = { ...diagram, layout };
  const rects = absoluteRects(out);
  const center = (id: string) => {
    const r = rects.get(id)!;
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  };
  out.edges = diagram.edges.map((e) => {
    if (!repick(e)) return e;
    if (!rects.has(e.from) || !rects.has(e.to)) return e;
    return { ...e, ...sidesFor(center(e.from), center(e.to)) };
  });
  return out;
}
