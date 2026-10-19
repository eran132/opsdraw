import type { ArchEdge, ArchNode, ParseError, ParseResult, Side } from './model';
import { emptyDiagram, isValidId, makeId } from './model';

/**
 * One-way import of a Mermaid flowchart (`flowchart` / `graph`) into an architecture diagram.
 * Subgraphs become groups, nodes become services, and cylinder nodes get a database icon.
 * Styling statements (classDef, style, click, ...) are ignored.
 */

const IGNORED = /^(classDef|class|style|linkStyle|click|direction|accTitle|accDescr)\b/;
const EDGE_OP = /\s*(<)?(?:-{2,}|={2,}|-\.+-)(>|[ox](?=\s))?(?:\|([^|]*)\|)?\s*/g;

interface EdgeOp {
  arrowStart: boolean;
  arrowEnd: boolean;
  label?: string;
}
const SIDES: Record<string, [Side, Side]> = {
  TD: ['B', 'T'],
  TB: ['B', 'T'],
  BT: ['T', 'B'],
  LR: ['R', 'L'],
  RL: ['L', 'R'],
};

export function parseFlowchart(source: string): ParseResult {
  const diagram = emptyDiagram();
  const errors: ParseError[] = [];
  const nodes = new Map<string, ArchNode>();
  // Flowchart ids like "LB" or "Backend" are fine in flowcharts but not in architecture diagrams
  // (a leading uppercase T/B/L/R reads as an edge side), so they are mapped to safe ids.
  const safeIds = new Map<string, string>();
  const safe = (raw: string) => {
    let id = safeIds.get(raw);
    if (!id) {
      const taken = new Set(safeIds.values());
      id = isValidId(raw) && !taken.has(raw) ? raw : makeId(raw, taken);
      safeIds.set(raw, id);
    }
    return id;
  };
  const groupStack: string[] = [];
  let sides: [Side, Side] = SIDES.TD!;
  let sawHeader = false;
  let anonGroups = 0;

  const statements: { text: string; line: number }[] = [];
  source
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .forEach((raw, idx) => {
      for (const part of raw.split(';')) statements.push({ text: part.trim(), line: idx + 1 });
    });

  for (const { text, line } of statements) {
    if (!text || text.startsWith('%%')) continue;
    if (!sawHeader) {
      const m = /^(?:flowchart|graph)(?:\s+(TD|TB|BT|LR|RL))?$/.exec(text);
      if (!m) {
        errors.push({ line, message: 'Expected "flowchart" or "graph" header' });
        return { diagram, errors };
      }
      sides = SIDES[m[1] ?? 'TD']!;
      sawHeader = true;
      continue;
    }
    if (IGNORED.test(text)) continue;

    const sub = /^subgraph\s+(.+)$/.exec(text);
    if (sub) {
      const m = /^([A-Za-z_][\w-]*)\s*\[(.*)\]$/.exec(sub[1]!.trim());
      let id: string;
      let label: string;
      if (m) {
        id = safe(m[1]!);
        label = unquote(m[2]!);
      } else if (/^[A-Za-z_][\w-]*$/.test(sub[1]!.trim())) {
        label = sub[1]!.trim();
        id = safe(label);
      } else {
        id = `group${++anonGroups}`;
        label = unquote(sub[1]!.trim());
      }
      upsert({ id, kind: 'group', label, parent: groupStack.at(-1) });
      groupStack.push(id);
      continue;
    }
    if (text === 'end') {
      if (!groupStack.pop()) errors.push({ line, message: '"end" without "subgraph"' });
      continue;
    }

    // Normalize `A -- text --> B` into `A -->|text| B`.
    const normalized = text.replace(
      /(--|==|-\.)\s+([^|>-][^>]*?)\s+(-->|==>|-\.->|---)/g,
      (all, _op: string, label: string, arrow: string, at: number) =>
        insideBrackets(text, at) ? all : `${arrow}|${label}|`,
    );
    const parts = splitEdges(normalized);
    if (!parts) {
      errors.push({ line, message: `Unrecognized statement: ${text}` });
      continue;
    }
    let prev: string[] | null = null;
    let pendingEdge: EdgeOp | null = null;
    for (const part of parts) {
      if (typeof part === 'string') {
        const ids: string[] = [];
        for (const tok of part.split('&')) {
          const id = nodeFromToken(tok.trim());
          if (!id) {
            errors.push({ line, message: `Invalid node: ${tok.trim()}` });
            return { diagram, errors };
          }
          ids.push(id);
        }
        if (prev && pendingEdge) {
          for (const a of prev) for (const b of ids) diagram.edges.push(edge(a, b, pendingEdge));
        }
        prev = ids;
      } else {
        pendingEdge = part;
      }
    }
  }
  if (!sawHeader) errors.push({ line: 1, message: 'Missing flowchart header' });
  diagram.nodes = [...nodes.values()];
  return { diagram, errors };

  function edge(a: string, b: string, op: EdgeOp) {
    const e: ArchEdge = { from: a, to: b, fromSide: sides[0], toSide: sides[1] };
    if (op.arrowStart) e.arrowStart = true;
    if (op.arrowEnd) e.arrowEnd = true;
    if (op.label) e.label = op.label;
    return e;
  }

  function upsert(n: ArchNode) {
    const existing = nodes.get(n.id);
    if (!existing) {
      nodes.set(n.id, n);
      return;
    }
    if (n.label !== undefined && n.label !== n.id) existing.label = n.label;
    if (n.icon) existing.icon = n.icon;
    if (n.kind === 'group') existing.kind = 'group';
    if (n.parent && !existing.parent) existing.parent = n.parent;
  }

  function nodeFromToken(tok: string): string | null {
    const m = /^([A-Za-z_][\w-]*)(.*)$/.exec(tok);
    if (!m) return null;
    const raw = m[1]!;
    const id = safe(raw);
    const shape = m[2]!.trim();
    const node: ArchNode = { id, kind: 'service', parent: groupStack.at(-1) };
    if (shape) {
      node.label = unquote(shape.replace(/^[[({>/\\]+/, '').replace(/[\])}/\\]+$/, ''));
      node.icon = shape.startsWith('[(') ? 'database' : 'lucide:box';
    } else if (!nodes.has(id)) {
      node.label = raw;
      node.icon = 'lucide:box';
    }
    // A bare reference inside a subgraph should not move a node declared elsewhere.
    if (!shape && nodes.has(id)) delete node.parent;
    upsert(node);
    return id;
  }

  function splitEdges(s: string): (string | EdgeOp)[] | null {
    const out: (string | EdgeOp)[] = [];
    let start = 0;
    for (const m of s.matchAll(EDGE_OP)) {
      // Operator-looking text inside a label, like A[a -- b], is not an edge.
      if (m.index < start || insideBrackets(s, m.index)) continue;
      out.push(s.slice(start, m.index));
      out.push({ arrowStart: !!m[1], arrowEnd: m[2] === '>', label: m[3]?.trim() || undefined });
      start = m.index + m[0].length;
    }
    out.push(s.slice(start));
    return out.every((p) => typeof p !== 'string' || p.trim()) ? out : null;
  }
}

function insideBrackets(s: string, at: number): boolean {
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < at; i++) {
    const c = s[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && '[({'.includes(c!)) depth++;
    else if (!quoted && '])}'.includes(c!)) depth--;
  }
  return depth > 0 || quoted;
}

const unquote = (s: string) =>
  s
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .trim();
