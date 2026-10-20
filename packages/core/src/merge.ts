import type { ArchEdge, ArchNode, Diagram, NodeLayout } from './model';
import { descendantsOf } from './model';
import type { LayoutDirection } from './layout';
import { GROUP_PADDING, JUNCTION_SIZE, SERVICE_SIZE, assignPorts, autoLayout } from './layout';
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

/** Edge keys with an occurrence number, so duplicate `from->to` pairs pair up in order. */
function occurrenceKeys(edges: readonly ArchEdge[]): string[] {
  const seen = new Map<string, number>();
  return edges.map((e) => {
    const k = edgeKey(e);
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return `${k}#${n}`;
  });
}

const isPlainLink = (e: ArchEdge) =>
  !e.label && !e.arrowStart && !e.arrowEnd && !e.fromGroup && !e.toGroup;

/**
 * Junctions that layout added for fan-out (`assignPorts` hubs) are not in a freshly imported
 * diagram. Puts them back, with the same edges going through them, so a re-import of an
 * unchanged source is structurally equal to the file that was written.
 */
function restoreHubs(previous: Diagram, nodes: ArchNode[], edges: ArchEdge[]) {
  const ids = new Set(nodes.map((n) => n.id));
  // Hubs of the previous diagram: junctions the new one lacks, linked from the node they serve.
  const links = new Map<string, ArchEdge>();
  for (const hub of previous.nodes) {
    if (hub.kind !== 'junction' || ids.has(hub.id) || !/_hub\d*$/.test(hub.id)) continue;
    const link = previous.edges.find((e) => e.to === hub.id && isPlainLink(e));
    if (link) links.set(hub.id, link);
  }
  // The far ends a hub (and the hubs hanging off it) carries edges to and from.
  const reach = (hub: string, depth = 0): { out: Set<string>; in: Set<string> } => {
    const out = new Set<string>();
    const inn = new Set<string>();
    for (const e of previous.edges) {
      if (e === links.get(hub)) continue;
      if (e.from === hub) {
        if (links.get(e.to) === e && depth < 64) {
          const sub = reach(e.to, depth + 1);
          sub.out.forEach((x) => out.add(x));
          sub.in.forEach((x) => inn.add(x));
        } else out.add(e.to);
      } else if (e.to === hub) inn.add(e.from);
    }
    return { out, in: inn };
  };
  for (const [hub, link] of links) {
    const owner = link.from;
    if (!ids.has(owner)) continue;
    const { out, in: inn } = reach(hub);
    let moved = 0;
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i]!;
      if (e.from === owner && !e.fromGroup && e.to !== hub && out.has(e.to)) {
        edges[i] = { ...e, from: hub };
        moved++;
      } else if (e.to === owner && !e.toGroup && e.from !== hub && inn.has(e.from)) {
        edges[i] = { ...e, to: hub };
        moved++;
      }
    }
    if (!moved) continue;
    const parent = nodes.find((n) => n.id === owner)?.parent;
    nodes.push(parent ? { id: hub, kind: 'junction', parent } : { id: hub, kind: 'junction' });
    ids.add(hub);
    edges.push({ from: owner, to: hub, fromSide: link.fromSide, toSide: link.toSide });
  }
}

/** Ids of a node and all its ancestors. */
function chain(byId: ReadonlyMap<string, ArchNode>, id: string): string[] {
  const out: string[] = [];
  for (let p: string | undefined = id; p && out.length < 64; p = byId.get(p)?.parent) out.push(p);
  return out;
}

/**
 * Takes the structure of `next` and the layout of `previous`.
 *
 * - A node that exists in both keeps its previous position (and group size), unless its parent
 *   changed: positions are relative to the parent, so a moved node gets a fresh position.
 * - An edge whose `from->to` pair exists in both keeps its previous sides, and its route when
 *   neither end (nor any group around them) moved.
 * - A node that exists in both keeps its previous `%% @style` colors.
 * - Hub junctions that layout added for fan-out are kept, with their edges.
 * - The previous diagram's free-form comments are kept, and so is its title when `next` has none.
 *
 * Nodes without a position afterwards (new or re-parented) can be placed with `layoutNewNodes`.
 */
export function mergeLayout(previous: Diagram, next: Diagram): MergeResult {
  const prevStyles = new Map(previous.nodes.map((n) => [n.id, n.style]));
  // Colors are presentation, like positions: a re-import keeps them (unless next sets its own).
  const nodes = next.nodes.map((n) => {
    const style = n.style ?? prevStyles.get(n.id);
    return style && n.kind !== 'junction' ? { ...n, style: { ...style } } : { ...n };
  });
  const nextEdges = next.edges.map(({ route: _route, ...e }) => e as ArchEdge);
  restoreHubs(previous, nodes, nextEdges);

  const prevNodes = new Map(previous.nodes.map((n) => [n.id, n]));
  const layout: Record<string, NodeLayout> = {};
  const kept: string[] = [];
  for (const n of nodes) {
    const prev = prevNodes.get(n.id);
    const pos = previous.layout[n.id];
    if (!prev || !pos || (prev.parent ?? '') !== (n.parent ?? '')) continue;
    layout[n.id] = { ...pos };
    kept.push(n.id);
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const keptSet = new Set(kept);
  const stayed = (id: string) => chain(byId, id).every((x) => keptSet.has(x));
  const prevByKey = new Map<string, ArchEdge>();
  const prevByOccurrence = new Map<string, ArchEdge>();
  const prevKeys = occurrenceKeys(previous.edges);
  previous.edges.forEach((e, i) => {
    if (!prevByKey.has(edgeKey(e))) prevByKey.set(edgeKey(e), e);
    prevByOccurrence.set(prevKeys[i]!, e);
  });
  const nextKeys = occurrenceKeys(nextEdges);
  const keptEdges = new Set<string>();
  const edges = nextEdges.map((e, i) => {
    const same = prevByOccurrence.get(nextKeys[i]!);
    const prev = same ?? prevByKey.get(edgeKey(e));
    if (!prev) return e;
    keptEdges.add(edgeKey(e));
    const out: ArchEdge = { ...e, fromSide: prev.fromSide, toSide: prev.toSide };
    if (same?.route && stayed(e.from) && stayed(e.to))
      out.route = same.route.map((p) => ({ ...p }));
    return out;
  });

  const diagram: Diagram = {
    nodes,
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

/** True for ids in both diagrams whose absolute rectangle (position and size) is unchanged. */
function sameRect(prev: Diagram, next: Diagram): (id: string) => boolean {
  const before = absoluteRects(prev);
  const after = absoluteRects(next);
  return (id) => {
    const a = before.get(id);
    const b = after.get(id);
    return !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
  };
}

/**
 * Ids of the nodes that are in both diagrams but sit somewhere else in `next`: moved or resized,
 * directly or because a group around them moved (positions are compared in absolute terms).
 */
export function movedNodes(prev: Diagram, next: Diagram): Set<string> {
  const same = sameRect(prev, next);
  const before = new Set(prev.nodes.map((n) => n.id));
  return new Set(next.nodes.filter((n) => before.has(n.id) && !same(n.id)).map((n) => n.id));
}

/**
 * For a canvas edit that moved nodes (drag, align, nudge, group resize): re-picks the sides of
 * every edge with an end that moved, so two nodes lined up get a straight edge, and drops routes
 * that no longer fit. Other edges keep their sides (they still occupy them), Mermaid's one edge
 * per side holds, and no hub junctions are added: a node with more than four edges keeps its
 * sides. An edit that moved nothing only has its stale routes dropped.
 */
export function repickMovedSides(prev: Diagram, next: Diagram): Diagram {
  const moved = movedNodes(prev, next);
  const touches = (e: ArchEdge) => moved.has(e.from) || moved.has(e.to);
  if (!moved.size || !next.edges.some(touches)) return dropStaleRoutes(prev, next);
  const ported = assignPorts(next, undefined, { fixed: (e) => !touches(e), hubs: false });
  return dropStaleRoutes(prev, ported);
}

/**
 * Drops the stored route of every edge that no longer fits `next`: one of its ends moved or
 * was resized (directly, or because a group around it moved), or its sides changed. Use it when
 * applying an edit to `prev`; such edges fall back to the default drawing.
 */
export function dropStaleRoutes(prev: Diagram, next: Diagram): Diagram {
  if (!next.edges.some((e) => e.route)) return next;
  const same = sameRect(prev, next);
  const prevEdges = new Map<string, ArchEdge>();
  const prevKeys = occurrenceKeys(prev.edges);
  prev.edges.forEach((e, i) => prevEdges.set(prevKeys[i]!, e));
  const keys = occurrenceKeys(next.edges);
  let changed = false;
  const edges = next.edges.map((e, i) => {
    if (!e.route) return e;
    const p = prevEdges.get(keys[i]!);
    if (p && p.fromSide === e.fromSide && p.toSide === e.toSide && same(e.from) && same(e.to))
      return e;
    changed = true;
    const { route: _route, ...rest } = e;
    return rest;
  });
  return changed ? { ...next, edges } : next;
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
/** Size the canvas and exports give a group without a stored size. */
const GROUP_DEFAULT = { w: 320, h: 220 };
/** Minimum free space kept around a newly placed node. */
const MARGIN = 24;
const MAX_RING = 200;

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.w + MARGIN &&
  b.x < a.x + a.w + MARGIN &&
  a.y < b.y + b.h + MARGIN &&
  b.y < a.y + a.h + MARGIN;

/**
 * Gives every node outside `pinned` a position, leaving pinned nodes where they are.
 *
 * When nothing is pinned this is a full ELK `autoLayout`. Otherwise placement is incremental:
 * each container (the root or a group) is handled innermost first, and each new node goes inside
 * its parent, to the right of (`DOWN`: below) an already placed node it connects to, at the first
 * free spot of a grid scan that keeps clear of existing boxes. New nodes with no placed
 * neighbour go at the free end of the container (below its content; `DOWN`: to the right). A new
 * group is sized to its children; pinned groups grow (never shrink or move) to fit theirs.
 *
 * Edge sides are then spread with `assignPorts`, keeping `pinnedEdges` as they are. Routes are
 * kept only for edges whose ends (and the groups around them) didn't move.
 *
 * When every node is pinned (and, if `pinnedEdges` is given, every edge too) the diagram is
 * returned unchanged, so a no-op re-import is byte-stable.
 */
export async function layoutNewNodes(
  diagram: Diagram,
  pinned: Set<string>,
  options: LayoutNewNodesOptions = {},
): Promise<Diagram> {
  const direction = options.direction ?? 'RIGHT';
  const isPinned = (id: string) => pinned.has(id) && !!diagram.layout[id];
  const free = diagram.nodes.filter((n) => !isPinned(n.id));
  const repick = (e: ArchEdge) => !options.pinnedEdges?.has(edgeKey(e));
  if (!free.length && !(options.pinnedEdges && diagram.edges.some(repick))) return diagram;
  if (free.length === diagram.nodes.length) return autoLayout(diagram, direction);

  const byId = new Map(diagram.nodes.map((n) => [n.id, n]));
  const scopeOf = (n: ArchNode) => (n.parent && byId.has(n.parent) ? n.parent : '');
  const kids = new Map<string, ArchNode[]>();
  for (const n of diagram.nodes) {
    const s = scopeOf(n);
    kids.set(s, [...(kids.get(s) ?? []), n]);
  }
  const layout: Record<string, NodeLayout> = {};
  for (const n of diagram.nodes) if (isPinned(n.id)) layout[n.id] = { ...diagram.layout[n.id]! };
  const placed = new Set(diagram.nodes.filter((n) => isPinned(n.id)).map((n) => n.id));
  /** Sizes of new groups, known once their children are placed. */
  const sizes = new Map<string, { w: number; h: number }>();
  const sizeOf = (n: ArchNode) => {
    if (n.kind === 'junction') return JUNCTION_SIZE;
    if (n.kind === 'service') return SERVICE_SIZE;
    const l = layout[n.id];
    return sizes.get(n.id) ?? { w: l?.w ?? GROUP_DEFAULT.w, h: l?.h ?? GROUP_DEFAULT.h };
  };
  const box = (id: string): Box => {
    const l = layout[id]!;
    return { x: l.x, y: l.y, ...sizeOf(byId.get(id)!) };
  };

  const neighbours = new Map<string, string[]>();
  for (const e of diagram.edges) {
    if (e.from === e.to) continue;
    neighbours.set(e.from, [...(neighbours.get(e.from) ?? []), e.to]);
    neighbours.set(e.to, [...(neighbours.get(e.to) ?? []), e.from]);
  }
  /** The child of `scope` that contains `id` (or is it), if any. */
  const inScope = (id: string, scope: string): string | undefined => {
    const c = chain(byId, id);
    return c.find((x) => byId.has(x) && scopeOf(byId.get(x)!) === scope);
  };
  /** A placed sibling that `n` (or something inside it) connects to. */
  const anchorFor = (n: ArchNode, scope: string): Box | undefined => {
    const inside = n.kind === 'group' ? descendantsOf(diagram, n.id) : new Set([n.id]);
    for (const id of inside) {
      for (const other of neighbours.get(id) ?? []) {
        const rep = inScope(other, scope);
        if (rep && rep !== n.id && placed.has(rep)) return box(rep);
      }
    }
    return undefined;
  };

  const findSpot = (
    size: { w: number; h: number },
    anchor: Box | undefined,
    boxes: Box[],
    scope: string,
  ) => {
    const minX = scope ? GROUP_PADDING.side : -Infinity;
    const minY = scope ? GROUP_PADDING.top : -Infinity;
    const stepX = size.w + MARGIN;
    const stepY = size.h + MARGIN;
    let base: { x: number; y: number };
    // Directions the scan may move in from `base`, along the flow and across it.
    let along: 'x' | 'y';
    let bothWays: boolean;
    if (anchor) {
      along = direction === 'RIGHT' ? 'x' : 'y';
      bothWays = true;
      base =
        direction === 'RIGHT'
          ? { x: anchor.x + anchor.w + GAP, y: anchor.y + anchor.h / 2 - size.h / 2 }
          : { x: anchor.x + anchor.w / 2 - size.w / 2, y: anchor.y + anchor.h + GAP };
    } else if (boxes.length) {
      // The free end: below the content (DOWN: to the right of it), scanning across.
      along = direction === 'RIGHT' ? 'y' : 'x';
      bothWays = false;
      base =
        direction === 'RIGHT'
          ? {
              x: Math.min(...boxes.map((b) => b.x)),
              y: Math.max(...boxes.map((b) => b.y + b.h)) + GAP,
            }
          : {
              x: Math.max(...boxes.map((b) => b.x + b.w)) + GAP,
              y: Math.min(...boxes.map((b) => b.y)),
            };
    } else {
      return scope ? { x: GROUP_PADDING.side, y: GROUP_PADDING.top } : { x: 0, y: 0 };
    }
    base = { x: Math.max(base.x, minX), y: Math.max(base.y, minY) };
    const fits = (p: { x: number; y: number }) =>
      p.x >= minX && p.y >= minY && !boxes.some((b) => overlaps({ ...p, ...size }, b));
    for (let ring = 0; ring <= MAX_RING; ring++) {
      // Cells `ring` steps away (Manhattan): first further along the flow, then across it.
      for (let a = 0; a <= ring; a++) {
        const c = ring - a;
        const across = bothWays && c ? [c, -c] : [c];
        for (const k of across) {
          const p =
            along === 'x'
              ? { x: base.x + a * stepX, y: base.y + k * stepY }
              : { x: base.x + k * stepX, y: base.y + a * stepY };
          if (fits(p)) return p;
        }
      }
    }
    return base;
  };

  const fitGroup = (g: ArchNode, boxes: Box[]) => {
    const needW = boxes.length ? Math.max(...boxes.map((b) => b.x + b.w)) + GROUP_PADDING.side : 0;
    const needH = boxes.length ? Math.max(...boxes.map((b) => b.y + b.h)) + GROUP_PADDING.side : 0;
    if (placed.has(g.id)) {
      const l = layout[g.id]!;
      const cur = sizeOf(g);
      if (needW > cur.w || needH > cur.h)
        layout[g.id] = { ...l, w: Math.max(cur.w, needW), h: Math.max(cur.h, needH) };
    } else {
      sizes.set(g.id, {
        w: Math.max(needW, SERVICE_SIZE.w * 2),
        h: Math.max(needH, SERVICE_SIZE.h + GROUP_PADDING.top),
      });
    }
  };

  /** Places the new nodes of a container; returns whether anything in it was placed. */
  const placeScope = (scope: string, depth: number): boolean => {
    const children = kids.get(scope) ?? [];
    let changed = false;
    if (depth < 64)
      for (const c of children)
        if (c.kind === 'group' && placeScope(c.id, depth + 1)) changed = true;
    const boxes = children.filter((c) => placed.has(c.id)).map((c) => box(c.id));
    const pending = children.filter((c) => !placed.has(c.id));
    if (pending.length) changed = true;
    while (pending.length) {
      // Nodes connected to something already placed go first, so chains grow outwards.
      let at = 0;
      let anchor: Box | undefined;
      for (let i = 0; i < pending.length; i++) {
        anchor = anchorFor(pending[i]!, scope);
        if (anchor) {
          at = i;
          break;
        }
      }
      const n = pending.splice(at, 1)[0]!;
      const size = sizeOf(n);
      const p = findSpot(size, anchor, boxes, scope);
      layout[n.id] = n.kind === 'group' ? { ...p, w: size.w, h: size.h } : { ...p };
      placed.add(n.id);
      boxes.push({ ...p, ...size });
    }
    const g = byId.get(scope);
    if (g && (changed || !placed.has(g.id))) fitGroup(g, boxes);
    return changed;
  };
  placeScope('', 0);

  // Routes stay only where neither end, nor a group around it, moved.
  const stayed = (id: string) => chain(byId, id).every(isPinned);
  const edges = diagram.edges.map((e) => {
    if (!e.route || (stayed(e.from) && stayed(e.to))) return e;
    const { route: _route, ...rest } = e;
    return rest;
  });
  const out: Diagram = { ...diagram, layout, edges };
  return assignPorts(out, absoluteRects(out), { fixed: (e) => !repick(e) });
}
