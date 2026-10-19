/** Side of a node an edge attaches to, as in Mermaid architecture diagrams. */
export type Side = 'T' | 'B' | 'L' | 'R';

export type NodeKind = 'service' | 'group' | 'junction';

export interface Point {
  x: number;
  y: number;
}

/** An absolute rectangle in canvas space. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

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
  /**
   * Orthogonal bend points between the two attachment sides, in absolute canvas coordinates
   * (stored as `%% @route`). Only valid while both ends stay where they were when it was routed.
   */
  route?: Point[];
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
/** Mermaid's lexer reads a leading uppercase T/B/L/R as an edge side, so such ids fail to parse. */
const SIDE_PREFIX_RE = /^[TBLR]/;

export const isValidId = (id: string): boolean => ID_RE.test(id) && !SIDE_PREFIX_RE.test(id);

/** Why an id is rejected, or null when Mermaid accepts it. */
export function idProblem(id: string): string | null {
  if (!ID_RE.test(id))
    return `Invalid id "${id}": use letters, digits, _ or -, starting with a letter or _`;
  if (SIDE_PREFIX_RE.test(id))
    return `Invalid id "${id}": Mermaid does not accept ids starting with uppercase T, B, L or R (try "${id.charAt(0).toLowerCase()}${id.slice(1)}")`;
  return null;
}

const ICON_RE = /^[A-Za-z0-9_-]+(:[A-Za-z0-9_-]+)?$/;

/** Icon references Mermaid can parse: `name` or `prefix:name` with letters, digits, _ and -. */
export const isValidIconRef = (ref: string): boolean => ICON_RE.test(ref);

/** Turns arbitrary text into a valid, unused node id. Generated ids are lowercase. */
export function makeId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let id = base
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^\w-]+/g, '_')
    .replace(/^[^a-z_]+/, '')
    .replace(/_+$/, '');
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
