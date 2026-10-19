import type {
  ArchEdge,
  ArchNode,
  Diagram,
  NodeLayout,
  ParseError,
  ParseResult,
  Point,
  Side,
} from './model';
import { emptyDiagram, idProblem, isValidIconRef } from './model';

/**
 * Mermaid `architecture-beta` <-> Diagram.
 *
 * Canvas positions are stored as `%% @pos <id> <x> <y> [<w> <h>]` comment lines, which Mermaid
 * ignores, so the file stays valid Mermaid that renders anywhere (GitHub, GitLab, docs sites).
 * Edge routes from auto-layout are stored the same way, as `%% @route <from> <to> x,y x,y ...`
 * (absolute bend points between the two attachment sides).
 */

const ID = '[A-Za-z_][\\w-]*';
const DECL_RE = new RegExp(
  `^(group|service)\\s+(${ID})\\s*(?:\\(([^)]*)\\))?\\s*(?:\\[([^\\]]*)\\])?(?:\\s+in\\s+(${ID}))?$`,
);
const JUNCTION_RE = new RegExp(`^junction\\s+(${ID})(?:\\s+in\\s+(${ID}))?$`);
const EDGE_RE = new RegExp(
  `^(${ID})(\\{group\\})?:([TBLR])\\s*(<)?-(?:\\[([^\\]]*)\\])?-(>)?\\s*([TBLR]):(${ID})(\\{group\\})?$`,
);
const POS_RE = new RegExp(
  `^%%\\s*@pos\\s+(${ID})\\s+(-?[\\d.]+)\\s+(-?[\\d.]+)(?:\\s+([\\d.]+)\\s+([\\d.]+))?\\s*$`,
);
const ROUTE_RE = new RegExp(
  `^%%\\s*@route\\s+(${ID})\\s+(${ID})((?:\\s+-?[\\d.]+,-?[\\d.]+)+)\\s*$`,
);

export function parseArchitecture(source: string): ParseResult {
  const diagram = emptyDiagram();
  const errors: ParseError[] = [];
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const declaredAt = new Map<string, number>();
  const edgeLines: number[] = [];
  const routes: { from: string; to: string; points: Point[] }[] = [];
  let route: RegExpExecArray | null;
  let i = 0;

  // Optional YAML front matter; only `title` is interpreted.
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, idx) => idx > 0 && l.trim() === '---');
    if (end === -1) {
      errors.push({ line: 1, message: 'Front matter is not closed with ---' });
    } else {
      for (const l of lines.slice(1, end)) {
        const m = /^title:\s*(.*)$/.exec(l.trim());
        if (m?.[1]) diagram.title = m[1].replace(/^["']|["']$/g, '');
      }
      i = end + 1;
    }
  }

  let sawHeader = false;
  for (; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i]!.trim();
    if (!line) continue;

    if (line.startsWith('%%')) {
      const pos = POS_RE.exec(line);
      if (pos) {
        const layout: NodeLayout = { x: Number(pos[2]), y: Number(pos[3]) };
        if (pos[4] && pos[5]) {
          layout.w = Number(pos[4]);
          layout.h = Number(pos[5]);
        }
        diagram.layout[pos[1]!] = layout;
      } else if ((route = ROUTE_RE.exec(line))) {
        const points = route[3]!
          .trim()
          .split(/\s+/)
          .map((p) => {
            const [x, y] = p.split(',');
            return { x: Number(x), y: Number(y) };
          });
        if (points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)))
          routes.push({ from: route[1]!, to: route[2]!, points });
      } else if (!/^%%\s*@/.test(line)) {
        diagram.comments.push(line.replace(/^%%\s?/, ''));
      }
      continue;
    }

    if (!sawHeader) {
      if (/^architecture(-beta)?$/.test(line)) {
        sawHeader = true;
        continue;
      }
      errors.push({ line: lineNo, message: 'Expected "architecture-beta" as the first statement' });
      return { diagram, errors };
    }

    const decl = DECL_RE.exec(line);
    if (decl) {
      const [, kind, id, icon, label, parent] = decl;
      addNode(
        { id: id!, kind: kind as 'group' | 'service', icon: icon || undefined, label, parent },
        lineNo,
      );
      continue;
    }
    const junction = JUNCTION_RE.exec(line);
    if (junction) {
      addNode({ id: junction[1]!, kind: 'junction', parent: junction[2] }, lineNo);
      continue;
    }
    const edge = EDGE_RE.exec(line);
    if (edge) {
      const [, from, fromGroup, fromSide, arrowStart, label, arrowEnd, toSide, to, toGroup] = edge;
      const e: ArchEdge = {
        from: from!,
        to: to!,
        fromSide: fromSide as Side,
        toSide: toSide as Side,
      };
      if (fromGroup) e.fromGroup = true;
      if (toGroup) e.toGroup = true;
      if (arrowStart) e.arrowStart = true;
      if (arrowEnd) e.arrowEnd = true;
      if (label) e.label = label.trim();
      diagram.edges.push(e);
      edgeLines.push(lineNo);
      continue;
    }
    errors.push({ line: lineNo, message: `Unrecognized statement: ${line}` });
  }

  if (!sawHeader && errors.length === 0) {
    errors.push({ line: 1, message: 'Missing "architecture-beta" header' });
  }

  // Reference checks happen after the whole file is read, so order of statements is free.
  for (const n of diagram.nodes) {
    if (!n.parent) continue;
    const p = diagram.nodes.find((x) => x.id === n.parent);
    if (!p) errors.push({ line: declaredAt.get(n.id)!, message: `Unknown group "${n.parent}"` });
    else if (p.kind !== 'group')
      errors.push({ line: declaredAt.get(n.id)!, message: `"${n.parent}" is not a group` });
  }
  diagram.edges.forEach((e, idx) => {
    for (const end of [e.from, e.to]) {
      if (!declaredAt.has(end))
        errors.push({ line: edgeLines[idx]!, message: `Unknown node "${end}"` });
    }
  });

  // Routes attach, in order, to the edges with the same ends. Routes for edges or nodes that no
  // longer exist are stale and dropped without an error.
  for (const r of routes) {
    if (!declaredAt.has(r.from) || !declaredAt.has(r.to)) continue;
    const edge = diagram.edges.find((e) => e.from === r.from && e.to === r.to && !e.route);
    if (edge) edge.route = r.points;
  }

  return { diagram, errors };

  function addNode(raw: ArchNode, lineNo: number) {
    if (declaredAt.has(raw.id)) {
      errors.push({ line: lineNo, message: `Duplicate id "${raw.id}"` });
      return;
    }
    declaredAt.set(raw.id, lineNo);
    const problem = idProblem(raw.id);
    if (problem) errors.push({ line: lineNo, message: problem });
    if (raw.icon && !isValidIconRef(raw.icon.trim()))
      errors.push({
        line: lineNo,
        message: `Invalid icon "${raw.icon.trim()}": use name or prefix:name with letters, digits, _ or -`,
      });
    const node: ArchNode = { id: raw.id, kind: raw.kind };
    if (raw.icon) node.icon = raw.icon.trim();
    if (raw.label !== undefined) node.label = raw.label.trim();
    if (raw.parent) node.parent = raw.parent;
    diagram.nodes.push(node);
  }
}

const cleanLabel = (s: string) => s.replace(/[[\]\n\r]/g, ' ').trim();
const round = (v: number) => Math.round(v);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function serializeArchitecture(diagram: Diagram): string {
  const out: string[] = [];
  if (diagram.title) out.push('---', `title: ${diagram.title}`, '---');
  out.push('architecture-beta');
  for (const c of diagram.comments) out.push(`  %% ${c}`);

  const byId = new Map(diagram.nodes.map((n) => [n.id, n]));
  const depth = (n: ArchNode): number => {
    let d = 0;
    for (let p = n.parent; p && d < 64; p = byId.get(p)?.parent) d++;
    return d;
  };
  // Parents before children keeps the file readable top-down.
  const groups = diagram.nodes
    .filter((n) => n.kind === 'group')
    .sort((a, b) => depth(a) - depth(b));
  const decl = (n: ArchNode) => {
    if (n.kind === 'junction') return `junction ${n.id}${n.parent ? ` in ${n.parent}` : ''}`;
    const icon = n.icon ? `(${n.icon})` : '';
    const label = `[${cleanLabel(n.label ?? n.id)}]`;
    return `${n.kind} ${n.id}${icon}${label}${n.parent ? ` in ${n.parent}` : ''}`;
  };

  const sections = [
    groups,
    diagram.nodes.filter((n) => n.kind === 'service'),
    diagram.nodes.filter((n) => n.kind === 'junction'),
  ];
  for (const section of sections) {
    if (!section.length) continue;
    out.push('');
    for (const n of section) out.push(`  ${decl(n)}`);
  }

  if (diagram.edges.length) {
    out.push('');
    for (const e of diagram.edges) {
      const lhs = `${e.from}${e.fromGroup ? '{group}' : ''}:${e.fromSide}`;
      const rhs = `${e.toSide}:${e.to}${e.toGroup ? '{group}' : ''}`;
      const mid = e.label ? `-[${cleanLabel(e.label)}]-` : '--';
      out.push(`  ${lhs} ${e.arrowStart ? '<' : ''}${mid}${e.arrowEnd ? '>' : ''} ${rhs}`);
    }
  }

  const positioned = diagram.nodes.filter((n) => diagram.layout[n.id]);
  // Sorted by ends (stable for duplicate pairs), so routes diff cleanly.
  const routed = diagram.edges
    .filter((e) => e.route?.length && byId.has(e.from) && byId.has(e.to))
    .sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to));
  if (positioned.length || routed.length) {
    out.push('', '  %% @layout opsdraw canvas positions (Mermaid ignores these lines)');
    for (const n of positioned) {
      const l = diagram.layout[n.id]!;
      const size = l.w !== undefined && l.h !== undefined ? ` ${round(l.w)} ${round(l.h)}` : '';
      out.push(`  %% @pos ${n.id} ${round(l.x)} ${round(l.y)}${size}`);
    }
    for (const e of routed) {
      const pts = e.route!.map((p) => `${round(p.x)},${round(p.y)}`).join(' ');
      out.push(`  %% @route ${e.from} ${e.to} ${pts}`);
    }
  }
  return out.join('\n') + '\n';
}

/** Picks attachment sides from the relative position of two nodes' centers. */
export function sidesFor(
  from: { x: number; y: number },
  to: { x: number; y: number },
): { fromSide: Side; toSide: Side } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { fromSide: 'R', toSide: 'L' } : { fromSide: 'L', toSide: 'R' };
  }
  return dy >= 0 ? { fromSide: 'B', toSide: 'T' } : { fromSide: 'T', toSide: 'B' };
}
