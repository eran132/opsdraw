/** Side of a node an edge attaches to, as in Mermaid architecture diagrams. */
export type Side = 'T' | 'B' | 'L' | 'R';

export type NodeKind = 'service' | 'group' | 'junction';

export interface ArchNode {
  id: string;
  kind: NodeKind;
  /** Display title. Junctions have none. */
  label?: string;
  /** Icon reference: a Mermaid built-in (`server`) or an Iconify-style `prefix:name`. */
  icon?: string;
  /** Id of the containing group, if any. */
  parent?: string;
}

export interface ArchEdge {
  from: string;
  to: string;
  fromSide: Side;
  toSide: Side;
  /** `{group}` modifier: the edge attaches to the group boundary of `from`. */
  fromGroup?: boolean;
  toGroup?: boolean;
  arrowStart?: boolean;
  arrowEnd?: boolean;
  label?: string;
}

/** Canvas geometry. Positions are relative to the parent group, like the canvas uses them. */
export interface NodeLayout {
  x: number;
  y: number;
  w?: number;
  h?: number;
}

export interface Diagram {
  title?: string;
  nodes: ArchNode[];
  edges: ArchEdge[];
  layout: Record<string, NodeLayout>;
  /** Free-form `%%` comment lines, kept so a round trip does not drop them. */
  comments: string[];
}

export interface ParseError {
  line: number;
  message: string;
}

export interface ParseResult {
  diagram: Diagram;
  errors: ParseError[];
}

export const emptyDiagram = (): Diagram => ({ nodes: [], edges: [], layout: {}, comments: [] });

const ID_RE = /^[A-Za-z_][\w-]*$/;

export const isValidId = (id: string): boolean => ID_RE.test(id);

/** Turns arbitrary text into a valid, unused node id. */
export function makeId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let id = base.replace(/[^\w-]+/g, '_').replace(/^[^A-Za-z_]+/, '');
  if (!id) id = 'node';
  if (!used.has(id)) return id;
  for (let i = 2; ; i++) {
    const candidate = `${id}${i}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Ids of `groupId` and every group nested inside it. */
export function descendantsOf(diagram: Diagram, groupId: string): Set<string> {
  const out = new Set<string>([groupId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of diagram.nodes) {
      if (n.parent && out.has(n.parent) && !out.has(n.id)) {
        out.add(n.id);
        grew = true;
      }
    }
  }
  return out;
}

/** Removes a node, its edges, and (for groups) everything inside it. */
export function removeNode(diagram: Diagram, id: string): Diagram {
  const gone = descendantsOf(diagram, id);
  const layout = { ...diagram.layout };
  for (const g of gone) delete layout[g];
  return {
    ...diagram,
    nodes: diagram.nodes.filter((n) => !gone.has(n.id)),
    edges: diagram.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to)),
    layout,
  };
}

/** Renames a node id everywhere it is referenced. */
export function renameNode(diagram: Diagram, from: string, to: string): Diagram {
  const swap = (v: string | undefined) => (v === from ? to : v);
  const layout = { ...diagram.layout };
  if (layout[from]) {
    layout[to] = layout[from];
    delete layout[from];
  }
  return {
    ...diagram,
    nodes: diagram.nodes.map((n) => ({ ...n, id: swap(n.id)!, parent: swap(n.parent) })),
    edges: diagram.edges.map((e) => ({ ...e, from: swap(e.from)!, to: swap(e.to)! })),
    layout,
  };
}
