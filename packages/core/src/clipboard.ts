import type { ArchEdge, ArchNode, Diagram, NodeLayout, Point } from './model';
import { descendantsOf } from './model';
import { absoluteRects } from './svg';

/**
 * Copy, paste and duplicate for canvas selections. A copied selection is a self-contained
 * diagram (a "fragment"): the selected nodes, everything inside selected groups, and the edges
 * between them, positioned so the selection's top-left corner is at 0,0. It serializes to plain
 * Mermaid, so it can travel through the system clipboard into a text editor or another file.
 */

/** The selected ids plus everything inside selected groups, in diagram order. */
function expand(diagram: Diagram, ids: Iterable<string>): Set<string> {
  const known = new Set(diagram.nodes.map((n) => n.id));
  const out = new Set<string>();
  for (const id of ids) {
    if (!known.has(id)) continue;
    for (const d of descendantsOf(diagram, id)) out.add(d);
  }
  return out;
}

const copyEdge = (e: ArchEdge, from: string, to: string): ArchEdge => {
  const { route: _route, ...rest } = e;
  return { ...rest, from, to };
};

const copyNode = (n: ArchNode, id: string, parent: string | undefined): ArchNode => {
  const { parent: _parent, style, ...rest } = n;
  const out: ArchNode = { ...rest, id };
  if (parent) out.parent = parent;
  if (style) out.style = { ...style };
  return out;
};

/**
 * The part of `diagram` made of `ids` (a selected group brings everything inside it) and the
 * edges with both ends in it. Nodes whose parent is not copied become top-level, positioned in
 * absolute terms and shifted so the top-left of the selection is at 0,0. Routes are dropped.
 */
export function extractSubgraph(diagram: Diagram, ids: Iterable<string>): Diagram {
  const keep = expand(diagram, ids);
  const rects = absoluteRects(diagram);
  const nodes = diagram.nodes.filter((n) => keep.has(n.id));
  const isTop = (n: ArchNode) => !n.parent || !keep.has(n.parent);
  const tops = nodes.filter(isTop);
  const minX = Math.min(...tops.map((n) => rects.get(n.id)!.x));
  const minY = Math.min(...tops.map((n) => rects.get(n.id)!.y));
  const layout: Record<string, NodeLayout> = {};
  for (const n of nodes) {
    const stored = diagram.layout[n.id];
    if (isTop(n)) {
      const r = rects.get(n.id)!;
      const l: NodeLayout = { x: r.x - minX, y: r.y - minY };
      if (stored?.w !== undefined) l.w = stored.w;
      if (stored?.h !== undefined) l.h = stored.h;
      layout[n.id] = l;
    } else if (stored) {
      layout[n.id] = { ...stored };
    }
  }
  return {
    nodes: nodes.map((n) => copyNode(n, n.id, isTop(n) ? undefined : n.parent)),
    edges: diagram.edges
      .filter((e) => keep.has(e.from) && keep.has(e.to))
      .map((e) => copyEdge(e, e.from, e.to)),
    layout,
    comments: [],
  };
}

/**
 * A fresh id for `id`: itself when free, else the next free number on its base, so `api` gives
 * `api2` and a copy of `api2` gives `api3` (not `api22`).
 */
function freeId(id: string, taken: Set<string>): string {
  if (!taken.has(id)) return id;
  const base = id.replace(/\d+$/, '') || id;
  for (let i = 2; ; i++) if (!taken.has(`${base}${i}`)) return `${base}${i}`;
}

export interface InsertOptions {
  /** Absolute canvas point where the fragment's top-left corner goes (default 0,0). */
  at?: Point;
  /** Group the fragment's top-level nodes go into. Ignored when it is not a group of `target`. */
  parent?: string;
}

export interface InsertResult {
  diagram: Diagram;
  /** Fragment id -> id in the result (ids that collided get a number appended). */
  idMap: Record<string, string>;
  /** Result ids of the fragment's top-level nodes, for selecting what was inserted. */
  roots: string[];
}

/**
 * Adds a fragment (from `extractSubgraph`, or any parsed diagram) to `target`. Ids that are
 * already taken are renumbered (`api` -> `api2`) and edges follow. The fragment keeps its own
 * arrangement: its top-left corner lands on `at`, inside `parent` when given. Nodes of the
 * fragment without a position get one on the same grid the canvas uses.
 */
export function insertSubgraph(
  target: Diagram,
  fragment: Diagram,
  options: InsertOptions = {},
): InsertResult {
  const taken = new Set(target.nodes.map((n) => n.id));
  const idMap: Record<string, string> = {};
  for (const n of fragment.nodes) {
    idMap[n.id] = freeId(n.id, taken);
    taken.add(idMap[n.id]!);
  }
  const fragIds = new Set(fragment.nodes.map((n) => n.id));
  const isTop = (n: ArchNode) => !n.parent || !fragIds.has(n.parent);
  const group = target.nodes.find((n) => n.id === options.parent && n.kind === 'group');
  const groupRect = group ? absoluteRects(target).get(group.id) : undefined;
  const rects = absoluteRects(fragment);
  const tops = fragment.nodes.filter(isTop);
  const minX = tops.length ? Math.min(...tops.map((n) => rects.get(n.id)!.x)) : 0;
  const minY = tops.length ? Math.min(...tops.map((n) => rects.get(n.id)!.y)) : 0;
  const at = options.at ?? { x: 0, y: 0 };

  const layout: Record<string, NodeLayout> = { ...target.layout };
  const nodes: ArchNode[] = [];
  for (const n of fragment.nodes) {
    const id = idMap[n.id]!;
    const top = isTop(n);
    nodes.push(copyNode(n, id, top ? group?.id : idMap[n.parent!]));
    const r = rects.get(n.id)!;
    const stored = fragment.layout[n.id];
    let l: NodeLayout;
    if (top) {
      l = {
        x: Math.round(at.x + r.x - minX - (groupRect?.x ?? 0)),
        y: Math.round(at.y + r.y - minY - (groupRect?.y ?? 0)),
      };
    } else if (stored) {
      l = { x: stored.x, y: stored.y };
    } else {
      const p = rects.get(n.parent!)!;
      l = { x: r.x - p.x, y: r.y - p.y };
    }
    if (stored?.w !== undefined) l.w = stored.w;
    if (stored?.h !== undefined) l.h = stored.h;
    layout[id] = l;
  }
  const edges = fragment.edges
    .filter((e) => idMap[e.from] && idMap[e.to])
    .map((e) => copyEdge(e, idMap[e.from]!, idMap[e.to]!));
  return {
    diagram: {
      ...target,
      nodes: [...target.nodes, ...nodes],
      edges: [...target.edges, ...edges],
      layout,
    },
    idMap,
    roots: tops.map((n) => idMap[n.id]!),
  };
}

/** Default offset of a duplicate from its original. */
export const DUPLICATE_OFFSET: Point = { x: 24, y: 24 };

/**
 * Copies `ids` (a selected group brings everything inside it) next to the originals, in the same
 * parent, shifted by `offset`. Edges with both ends in the copied set are copied too; labels,
 * icons and colors stay; ids get a number appended (`api` -> `api2`).
 *
 * Without an explicit offset, single services are nudged by 24/24, but a selection that contains
 * a group is placed beside the originals: a copy of a whole group stacked 24px over it is
 * unreadable.
 */
export function duplicateNodes(
  diagram: Diagram,
  ids: Iterable<string>,
  offset?: Point,
): InsertResult {
  const keep = expand(diagram, ids);
  if (!offset) offset = besideOffset(diagram, keep) ?? DUPLICATE_OFFSET;
  const taken = new Set(diagram.nodes.map((n) => n.id));
  const idMap: Record<string, string> = {};
  for (const n of diagram.nodes) {
    if (!keep.has(n.id)) continue;
    idMap[n.id] = freeId(n.id, taken);
    taken.add(idMap[n.id]!);
  }
  const rects = absoluteRects(diagram);
  const byId = new Map(diagram.nodes.map((n) => [n.id, n]));
  const layout: Record<string, NodeLayout> = { ...diagram.layout };
  const nodes: ArchNode[] = [];
  const roots: string[] = [];
  for (const n of diagram.nodes) {
    if (!keep.has(n.id)) continue;
    const id = idMap[n.id]!;
    const top = !n.parent || !keep.has(n.parent);
    const parent = top ? (n.parent && byId.has(n.parent) ? n.parent : undefined) : idMap[n.parent!];
    nodes.push(copyNode(n, id, parent));
    if (top) roots.push(id);
    const stored = diagram.layout[n.id];
    let l: NodeLayout;
    if (stored) {
      l = { ...stored };
    } else {
      // Not placed yet: take where the canvas draws it, relative to its parent.
      const r = rects.get(n.id)!;
      const p = n.parent ? rects.get(n.parent) : undefined;
      l = { x: r.x - (p?.x ?? 0), y: r.y - (p?.y ?? 0) };
    }
    if (top) l = { ...l, x: l.x + offset.x, y: l.y + offset.y };
    layout[id] = l;
  }
  const edges = diagram.edges
    .filter((e) => keep.has(e.from) && keep.has(e.to))
    .map((e) => copyEdge(e, idMap[e.from]!, idMap[e.to]!));
  return {
    diagram: {
      ...diagram,
      nodes: [...diagram.nodes, ...nodes],
      edges: [...diagram.edges, ...edges],
      layout,
    },
    idMap,
    roots,
  };
}

/** Offset that puts a copy of a selection containing a group to the right of the originals. */
function besideOffset(diagram: Diagram, keep: Set<string>): Point | null {
  const byId = new Map(diagram.nodes.map((n) => [n.id, n]));
  const tops = [...keep].filter((id) => {
    const parent = byId.get(id)?.parent;
    return !parent || !keep.has(parent);
  });
  if (!tops.some((id) => byId.get(id)?.kind === 'group')) return null;
  const rects = absoluteRects(diagram);
  let minX = Infinity;
  let maxX = -Infinity;
  for (const id of tops) {
    const r = rects.get(id);
    if (!r) continue;
    minX = Math.min(minX, r.x);
    maxX = Math.max(maxX, r.x + r.w);
  }
  return Number.isFinite(minX) ? { x: maxX - minX + 24, y: 0 } : null;
}
