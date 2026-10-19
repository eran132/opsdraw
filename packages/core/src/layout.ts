import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode } from 'elkjs/lib/elk-api';
import type { Diagram, NodeLayout, Side } from './model';
import { sidesFor } from './mermaid';

export const SERVICE_SIZE = { w: 96, h: 88 };
export const JUNCTION_SIZE = { w: 16, h: 16 };
export const GROUP_PADDING = { top: 40, side: 24 };

export type LayoutDirection = 'RIGHT' | 'DOWN';

const elk = new ELK();

/**
 * Lays out the whole diagram with ELK's layered algorithm, nesting groups.
 * Positions come back relative to the parent group, which is what the canvas and file store.
 * Edge sides are then re-picked from the geometry so Mermaid renders a similar picture.
 */
export async function autoLayout(
  diagram: Diagram,
  direction: LayoutDirection = 'RIGHT',
): Promise<Diagram> {
  const children = new Map<string | undefined, ElkNode[]>();
  const elkNodes = new Map<string, ElkNode>();
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

  const root: ElkNode = {
    id: '__root__',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.spacing.nodeNode': '48',
      'elk.layered.spacing.nodeNodeBetweenLayers': '72',
    },
    children: children.get(undefined) ?? [],
    edges: diagram.edges
      .filter((e) => elkNodes.has(e.from) && elkNodes.has(e.to))
      .map((e, i) => ({ id: `e${i}`, sources: [e.from], targets: [e.to] })),
  };

  const result = await elk.layout(root);
  const layout: Record<string, NodeLayout> = {};
  const absolute = new Map<string, { x: number; y: number; w: number; h: number }>();
  const walk = (node: ElkNode, ox: number, oy: number) => {
    for (const c of node.children ?? []) {
      const x = c.x ?? 0;
      const y = c.y ?? 0;
      const w = c.width ?? SERVICE_SIZE.w;
      const h = c.height ?? SERVICE_SIZE.h;
      const isGroup = diagram.nodes.find((n) => n.id === c.id)?.kind === 'group';
      layout[c.id] = isGroup ? { x, y, w, h } : { x, y };
      absolute.set(c.id, { x: ox + x, y: oy + y, w, h });
      walk(c, ox + x, oy + y);
    }
  };
  walk(result, 0, 0);

  const center = (id: string) => {
    const a = absolute.get(id)!;
    return { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  };
  const edges = diagram.edges.map((e) => {
    if (!absolute.has(e.from) || !absolute.has(e.to)) return e;
    const sides: { fromSide: Side; toSide: Side } = sidesFor(center(e.from), center(e.to));
    return { ...e, ...sides };
  });

  return { ...diagram, layout, edges };
}
