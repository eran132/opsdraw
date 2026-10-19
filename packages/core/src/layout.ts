import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkExtendedEdge, ElkNode, ElkPort } from 'elkjs/lib/elk-api';
import type { ArchEdge, ArchNode, Diagram, NodeLayout, Point, Rect, Side } from './model';
import { makeId } from './model';
import { absoluteRects } from './svg';

export const SERVICE_SIZE = { w: 96, h: 88 };
export const JUNCTION_SIZE = { w: 16, h: 16 };
export const GROUP_PADDING = { top: 40, side: 24 };

export type LayoutDirection = 'RIGHT' | 'DOWN';

const elk = new ELK();

const SIDES: readonly Side[] = ['R', 'B', 'L', 'T'];
const NORMALS: Record<Side, Point> = {
  R: { x: 1, y: 0 },
  B: { x: 0, y: 1 },
  L: { x: -1, y: 0 },
  T: { x: 0, y: -1 },
};
const OPPOSITE: Record<Side, Side> = { R: 'L', L: 'R', T: 'B', B: 'T' };
const ELK_SIDES: Record<Side, string> = { R: 'EAST', L: 'WEST', T: 'NORTH', B: 'SOUTH' };

export const oppositeSide = (s: Side): Side => OPPOSITE[s];

/** How far a hub junction sits from the node whose edges it gathers. */
const HUB_GAP = 40;
/** A node keeps an edge on a side at most this far (in radians) from facing the other end. */
const MAX_KEEP_ANGLE = (3 * Math.PI) / 4 + 1e-3;

const centerOf = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/**
 * Cost of leaving a node at `from` through each side towards `to`: the angle between the side's
 * outward normal and the direction. The smallest is the side `sidesFor` picks; vertical sides get
 * a hair more so 45° ties go horizontal, as there.
 */
function sideCosts(from: Point, to: Point): Record<Side, number> {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  const out = {} as Record<Side, number>;
  SIDES.forEach((s, i) => {
    if (!len) {
      out[s] = i;
      return;
    }
    const n = NORMALS[s];
    const cos = Math.max(-1, Math.min(1, (dx * n.x + dy * n.y) / len));
    out[s] = Math.acos(cos) + (s === 'T' || s === 'B' ? 1e-6 : 0);
  });
  return out;
}

const bySide = (costs: Record<Side, number>) =>
  [...SIDES].sort((a, b) => costs[a] - costs[b] || SIDES.indexOf(a) - SIDES.indexOf(b));

interface End {
  edge: number;
  which: 'from' | 'to';
  /** The node at the other end of the edge. */
  other: string;
}

export interface AssignPortsOptions {
  /** Edges whose sides must stay as they are (they still occupy their sides). */
  fixed?: (edge: ArchEdge, index: number) => boolean;
}

/**
 * Re-picks `fromSide`/`toSide` of every edge so no node side carries two edges, which Mermaid's
 * architecture diagrams don't allow. Each end prefers the side facing the other node, then the
 * next best side by angle. A node with more than four edges can't have one per side, so the
 * extra edges are routed through a new junction (`<node>_hub`) placed next to it.
 *
 * `rects` are absolute node rectangles (default: from the stored layout). Ends with a `{group}`
 * modifier attach to the group boundary, so they take the facing side and don't count. An edge
 * whose sides change loses its stored route. Deterministic: same input, same output.
 */
export function assignPorts(
  diagram: Diagram,
  rects?: ReadonlyMap<string, Rect>,
  options: AssignPortsOptions = {},
): Diagram {
  const boxes = new Map(rects ?? absoluteRects(diagram));
  const nodes: ArchNode[] = [...diagram.nodes];
  const edges: ArchEdge[] = [...diagram.edges];
  const fixed = edges.map((e, i) => !!options.fixed?.(e, i));
  const layout: Record<string, NodeLayout> = { ...diagram.layout };
  const ids = new Set(nodes.map((n) => n.id));
  const hubOwner = new Map<string, string>();
  let changedNodes = false;

  const counts = (e: ArchEdge, which: 'from' | 'to') =>
    e.from !== e.to && !(which === 'from' ? e.fromGroup : e.toGroup);
  const endsAt = (id: string): End[] => {
    const out: End[] = [];
    edges.forEach((e, i) => {
      if (e.from === id && counts(e, 'from')) out.push({ edge: i, which: 'from', other: e.to });
      if (e.to === id && counts(e, 'to')) out.push({ edge: i, which: 'to', other: e.from });
    });
    return out;
  };
  const sideOf = (end: End) =>
    end.which === 'from' ? edges[end.edge]!.fromSide : edges[end.edge]!.toSide;
  const costsFor = (id: string, end: End) => {
    const a = boxes.get(id);
    const b = boxes.get(end.other);
    return a && b ? sideCosts(centerOf(a), centerOf(b)) : null;
  };

  // 1. Junctions for nodes with more edges than sides.
  const degree = new Map<string, number>();
  edges.forEach((e) => {
    if (counts(e, 'from')) degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    if (counts(e, 'to')) degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  });
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    if (node.kind === 'group' || (degree.get(node.id) ?? 0) <= 4) continue;
    const r = boxes.get(node.id);
    if (!r) continue;
    const ends = endsAt(node.id);
    const pinned = ends.filter((e) => fixed[e.edge]);
    const movable = ends.filter((e) => !fixed[e.edge]);
    const best = new Map(
      movable.map((e) => [
        e,
        bySide(costsFor(node.id, e) ?? sideCosts({ x: 0, y: 0 }, { x: 1, y: 0 }))[0]!,
      ]),
    );
    const taken = new Set(pinned.map(sideOf));
    const open = SIDES.filter((s) => !taken.has(s));
    // The hub goes on the side most of the movable edges want.
    const hubSide = (open.length ? open : SIDES).reduce((acc, s) => {
      const n = movable.filter((e) => best.get(e) === s).length;
      const m = movable.filter((e) => best.get(e) === acc).length;
      return n > m ? s : acc;
    });
    // Each other free side keeps the edge that fits it best (greedily, cheapest pairs first), as
    // long as the edge doesn't have to leave (nearly) backwards; the rest go through the hub.
    const pairs: { e: End; s: Side; cost: number }[] = [];
    for (const e of movable) {
      const costs = costsFor(node.id, e);
      if (!costs) continue;
      for (const s of open) {
        if (s !== hubSide && costs[s] <= MAX_KEEP_ANGLE) pairs.push({ e, s, cost: costs[s] });
      }
    }
    pairs.sort(
      (a, b) => a.cost - b.cost || a.e.edge - b.e.edge || SIDES.indexOf(a.s) - SIDES.indexOf(b.s),
    );
    const keep = new Set<End>();
    const filled = new Set<Side>();
    for (const p of pairs) {
      if (keep.has(p.e) || filled.has(p.s)) continue;
      keep.add(p.e);
      filled.add(p.s);
    }
    const move = movable.filter((e) => !keep.has(e));
    if (move.length < 2) continue;

    // Hubs of hubs are named after the original node: api_hub, api_hub2, ...
    const owner = hubOwner.get(node.id) ?? node.id;
    const hubId = makeId(`${owner}_hub`, ids);
    hubOwner.set(hubId, owner);
    ids.add(hubId);
    const c = centerOf(r);
    const n = NORMALS[hubSide];
    const hc = {
      x: c.x + n.x * (r.w / 2 + HUB_GAP + JUNCTION_SIZE.w / 2),
      y: c.y + n.y * (r.h / 2 + HUB_GAP + JUNCTION_SIZE.h / 2),
    };
    const hubRect = {
      x: hc.x - JUNCTION_SIZE.w / 2,
      y: hc.y - JUNCTION_SIZE.h / 2,
      ...JUNCTION_SIZE,
    };
    boxes.set(hubId, { x: hubRect.x, y: hubRect.y, w: hubRect.w, h: hubRect.h });
    const own = layout[node.id];
    if (own) layout[hubId] = { x: own.x + hubRect.x - r.x, y: own.y + hubRect.y - r.y };
    const hub: ArchNode = { id: hubId, kind: 'junction' };
    if (node.parent) hub.parent = node.parent;
    nodes.push(hub);
    changedNodes = true;

    for (const end of move) {
      const { route: _route, ...e } = edges[end.edge]!;
      edges[end.edge] = end.which === 'from' ? { ...e, from: hubId } : { ...e, to: hubId };
    }
    edges.push({ from: node.id, to: hubId, fromSide: hubSide, toSide: OPPOSITE[hubSide] });
    // The link keeps the side the hub was put on.
    fixed.push(true);
    degree.set(hubId, move.length + 1);
  }

  // 2. One side per edge end, node by node: the cheapest conflict-free assignment.
  const fromSide = edges.map((e) => e.fromSide);
  const toSide = edges.map((e) => e.toSide);
  const set = (end: End, s: Side) => {
    if (end.which === 'from') fromSide[end.edge] = s;
    else toSide[end.edge] = s;
  };
  const all = new Map<string, End[]>();
  const groupEnds: { id: string; end: End }[] = [];
  edges.forEach((e, i) => {
    if (e.from === e.to) return;
    for (const which of ['from', 'to'] as const) {
      const id = which === 'from' ? e.from : e.to;
      const end: End = { edge: i, which, other: which === 'from' ? e.to : e.from };
      if (counts(e, which)) all.set(id, [...(all.get(id) ?? []), end]);
      else groupEnds.push({ id, end });
    }
  });
  for (const { id, end } of groupEnds) {
    const costs = fixed[end.edge] ? null : costsFor(id, end);
    if (costs) set(end, bySide(costs)[0]!);
  }
  for (const [id, ends] of all) {
    const taken = new Set(ends.filter((e) => fixed[e.edge]).map(sideOf));
    const movable = ends
      .filter((e) => !fixed[e.edge])
      .map((e) => ({ end: e, costs: costsFor(id, e) }))
      .filter((m): m is { end: End; costs: Record<Side, number> } => !!m.costs);
    if (!movable.length) continue;
    const open = SIDES.filter((s) => !taken.has(s));
    if (movable.length <= open.length) {
      let bestTotal = Infinity;
      let bestPick: Side[] = [];
      const pick: Side[] = [];
      const used = new Set<Side>();
      const search = (k: number, total: number) => {
        if (total >= bestTotal) return;
        if (k === movable.length) {
          bestTotal = total;
          bestPick = [...pick];
          return;
        }
        const { costs } = movable[k]!;
        for (const s of bySide(costs)) {
          if (used.has(s) || taken.has(s)) continue;
          used.add(s);
          pick.push(s);
          search(k + 1, total + costs[s]);
          pick.pop();
          used.delete(s);
        }
      };
      search(0, 0);
      movable.forEach((m, k) => set(m.end, bestPick[k]!));
    } else {
      // More edges than free sides (fixed edges in the way): best free side, else best side.
      const used = new Set(taken);
      for (const m of movable) {
        const ranked = bySide(m.costs);
        const s = ranked.find((x) => !used.has(x)) ?? ranked[0]!;
        used.add(s);
        set(m.end, s);
      }
    }
  }

  let changedEdges = false;
  const outEdges = edges.map((e, i) => {
    if (e.fromSide === fromSide[i] && e.toSide === toSide[i]) return e;
    changedEdges = true;
    const { route: _route, ...rest } = e;
    return { ...rest, fromSide: fromSide[i]!, toSide: toSide[i]! };
  });
  if (!changedNodes && !changedEdges && edges.every((e, i) => e === diagram.edges[i]))
    return diagram;
  return { ...diagram, nodes, edges: outEdges, layout };
}

interface ElkResult {
  layout: Record<string, NodeLayout>;
  rects: Map<string, Rect>;
  /** Bend points per edge index; absent for edges ELK did not route or routed straight. */
  routes: (Point[] | undefined)[];
}

/**
 * One ELK layered run. With `ports`, every edge end gets a port fixed at the middle of its
 * chosen side, so ELK routes the edge out of exactly the side Mermaid will use.
 */
async function runElk(
  diagram: Diagram,
  direction: LayoutDirection,
  ports: boolean,
): Promise<ElkResult> {
  const children = new Map<string | undefined, ElkNode[]>();
  const elkNodes = new Map<string, ElkNode>();
  const kinds = new Map(diagram.nodes.map((n) => [n.id, n.kind]));
  for (const n of diagram.nodes) {
    const size = n.kind === 'junction' ? JUNCTION_SIZE : SERVICE_SIZE;
    const node: ElkNode = { id: n.id };
    if (n.kind === 'group') {
      node.layoutOptions = {
        'elk.padding': `[top=${GROUP_PADDING.top},left=${GROUP_PADDING.side},bottom=${GROUP_PADDING.side},right=${GROUP_PADDING.side}]`,
      };
    } else {
      node.width = size.w;
      node.height = size.h;
    }
    elkNodes.set(n.id, node);
  }
  for (const n of diagram.nodes) {
    const parent = n.parent && elkNodes.has(n.parent) ? n.parent : undefined;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent)!.push(elkNodes.get(n.id)!);
  }
  for (const [parent, kids] of children) if (parent) elkNodes.get(parent)!.children = kids;
  // Empty groups still need a size.
  for (const n of diagram.nodes) {
    const e = elkNodes.get(n.id)!;
    if (n.kind === 'group' && !e.children?.length) {
      e.width = SERVICE_SIZE.w * 2;
      e.height = SERVICE_SIZE.h + GROUP_PADDING.top;
    }
  }

  const portFor = (id: string, side: Side, group: boolean | undefined): string => {
    if (!ports || group || kinds.get(id) === 'group') return id;
    const node = elkNodes.get(id)!;
    const portId = `${id}:${side}`;
    node.ports ??= [];
    if (!node.ports.some((p) => p.id === portId)) {
      const w = node.width!;
      const h = node.height!;
      const at = {
        R: { x: w, y: h / 2 },
        L: { x: 0, y: h / 2 },
        T: { x: w / 2, y: 0 },
        B: { x: w / 2, y: h },
      }[side];
      const port: ElkPort = {
        id: portId,
        width: 0,
        height: 0,
        ...at,
        layoutOptions: { 'elk.port.side': ELK_SIDES[side] },
      };
      node.ports.push(port);
      node.layoutOptions = { ...node.layoutOptions, 'elk.portConstraints': 'FIXED_POS' };
    }
    return portId;
  };

  const elkEdges: ElkExtendedEdge[] = [];
  const edgeIndex = new Map<string, number>();
  diagram.edges.forEach((e, i) => {
    if (!elkNodes.has(e.from) || !elkNodes.has(e.to)) return;
    const id = `e${i}`;
    edgeIndex.set(id, i);
    elkEdges.push({
      id,
      sources: [portFor(e.from, e.fromSide, e.fromGroup || e.from === e.to)],
      targets: [portFor(e.to, e.toSide, e.toGroup || e.from === e.to)],
    });
  });

  const root: ElkNode = {
    id: '__root__',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.json.edgeCoords': 'ROOT',
      'elk.spacing.nodeNode': '48',
      'elk.layered.spacing.nodeNodeBetweenLayers': '72',
    },
    children: children.get(undefined) ?? [],
    edges: elkEdges,
  };

  const result = await elk.layout(root);
  const layout: Record<string, NodeLayout> = {};
  const rects = new Map<string, Rect>();
  const walk = (node: ElkNode, ox: number, oy: number) => {
    for (const c of node.children ?? []) {
      const x = c.x ?? 0;
      const y = c.y ?? 0;
      const w = c.width ?? SERVICE_SIZE.w;
      const h = c.height ?? SERVICE_SIZE.h;
      layout[c.id] = kinds.get(c.id) === 'group' ? { x, y, w, h } : { x, y };
      rects.set(c.id, { x: ox + x, y: oy + y, w, h });
      walk(c, ox + x, oy + y);
    }
  };
  walk(result, 0, 0);

  const routes: (Point[] | undefined)[] = [];
  for (const e of result.edges ?? []) {
    const i = edgeIndex.get(e.id);
    if (i === undefined || !e.sections?.length) continue;
    const bends = e.sections.flatMap((s, k) => [
      ...(k ? [s.startPoint] : []),
      ...(s.bendPoints ?? []),
    ]);
    if (bends.length) routes[i] = bends.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
  }
  return { layout, rects, routes };
}

/**
 * Lays out the whole diagram with ELK's layered algorithm, nesting groups.
 * Positions come back relative to the parent group, which is what the canvas and file store.
 *
 * It runs twice: the first pass gives the geometry `assignPorts` picks one side per edge end
 * from (adding hub junctions where a node has more than four edges), and the second lays the
 * diagram out again with those sides fixed, so ELK's orthogonal edge routes leave and enter
 * exactly where Mermaid attaches the edges. The routes are kept as `edge.route`.
 */
export async function autoLayout(
  diagram: Diagram,
  direction: LayoutDirection = 'RIGHT',
): Promise<Diagram> {
  const first = await runElk(diagram, direction, false);
  const ported = assignPorts({ ...diagram, layout: first.layout }, first.rects);
  const second = await runElk(ported, direction, true);
  const edges = ported.edges.map((e, i) => {
    const { route: _route, ...rest } = e;
    const route = second.routes[i];
    return route ? { ...rest, route } : rest;
  });
  return { ...ported, layout: second.layout, edges };
}
