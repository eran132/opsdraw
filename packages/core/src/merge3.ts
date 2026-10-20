import type { ArchEdge, ArchNode, Diagram, NodeLayout, NodeStyle } from './model';
import { emptyDiagram } from './model';
import { parseArchitecture, serializeArchitecture } from './mermaid';
import { STYLE_KEYS, sanitizeStyle } from './style';

/**
 * Semantic three-way merge of two versions of a diagram, for use as a git merge driver.
 *
 * Structure (nodes, edges, title) merges like source code: a change made on one side wins, and
 * the same field changed differently on both sides is a conflict (ours is kept). Layout never
 * conflicts: each node keeps the position (and, separately, the size) of the side that moved it,
 * and ours wins when both moved it. Edge sides and routes count as layout, and so do node
 * styles (`%% @style`), merged per color key.
 *
 * `%% @<word> <id...> ...` lines the model does not understand (layout extensions written by
 * newer versions) are merged as opaque lines keyed by the word and the ids that follow it.
 */

export type Merge3ConflictKind = 'parse' | 'title' | 'node' | 'edge';

export interface Merge3Conflict {
  kind: Merge3ConflictKind;
  /** Node id, or edge key (`from->to`, plus `[label]` when a pair has parallel edges). */
  id?: string;
  /** The field both sides changed differently, when there is one. */
  field?: string;
  /** For `parse`: the input that failed to parse. */
  side?: 'base' | 'ours' | 'theirs';
  /** One line, human readable; also what the merge driver writes into the file. */
  message: string;
}

export interface Merge3Result {
  text: string;
  conflicts: Merge3Conflict[];
}

type Side = 'ours' | 'theirs';

const KNOWN_DIAGRAM_KEYS = new Set(['title', 'nodes', 'edges', 'layout', 'comments']);
/** Edge fields that are presentation, not structure: never a conflict. */
const EDGE_LAYOUT_FIELDS = new Set(['fromSide', 'toSide', 'route']);
/** Node fields that are presentation: `%% @style` colors. */
const NODE_LAYOUT_FIELDS = new Set(['style']);

/** JSON with sorted keys and undefined members dropped, for equality checks. */
function canon(v: unknown): string {
  const s = JSON.stringify(v, (_k, x: unknown) => {
    if (x && typeof x === 'object' && !Array.isArray(x)) {
      return Object.fromEntries(
        Object.entries(x as Record<string, unknown>)
          .filter(([, y]) => y !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return x;
  });
  return s ?? '<undefined>';
}

/** Three-way pick of one value. On a real conflict ours is returned and `conflict` is set. */
function pick<T>(base: T, ours: T, theirs: T): { value: T; conflict: boolean } {
  const b = canon(base);
  const o = canon(ours);
  const t = canon(theirs);
  if (o === b) return { value: theirs, conflict: false };
  if (t === b || t === o) return { value: ours, conflict: false };
  return { value: ours, conflict: true };
}

const show = (v: unknown) => (v === undefined ? '(none)' : JSON.stringify(v));
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ');

interface EntityMerge<T> {
  merged: Map<string, T>;
  /** Cleanly deleted entities, with the other side's (unchanged) version, for restoring. */
  deleted: Map<string, { by: Side; version: T }>;
}

/**
 * Merges keyed entities (nodes or edges). `layoutFields` merge without conflicts; the rest are
 * structural. Deleting an entity wins unless the other side changed it structurally.
 */
function mergeEntities<T extends object>(
  kind: 'node' | 'edge',
  base: Map<string, T>,
  ours: Map<string, T>,
  theirs: Map<string, T>,
  layoutFields: ReadonlySet<string>,
  conflicts: Merge3Conflict[],
): EntityMerge<T> {
  const structural = (e: T | undefined) =>
    e === undefined
      ? undefined
      : Object.fromEntries(Object.entries(e).filter(([k]) => !layoutFields.has(k)));
  const merged = new Map<string, T>();
  const deleted = new Map<string, { by: Side; version: T }>();
  const label = kind === 'node' ? 'Node' : 'Edge';
  const keys = [...ours.keys(), ...[...theirs.keys()].filter((k) => !ours.has(k))];

  for (const key of keys) {
    const b = base.get(key);
    const o = ours.get(key);
    const t = theirs.get(key);
    if (o && t) {
      merged.set(key, mergeFields(kind, key, b, o, t, layoutFields, conflicts));
      continue;
    }
    const present = (o ?? t)!;
    const side: Side = o ? 'ours' : 'theirs';
    const other: Side = o ? 'theirs' : 'ours';
    if (!b) {
      merged.set(key, { ...present });
      continue;
    }
    if (canon(structural(present)) === canon(structural(b))) {
      deleted.set(key, { by: other, version: present });
      continue;
    }
    merged.set(key, { ...present });
    conflicts.push({
      kind,
      id: key,
      message: `${label} "${key}" was deleted in ${other} but changed in ${side}; kept the ${side} version`,
    });
  }
  return { merged, deleted };
}

function mergeFields<T extends object>(
  kind: 'node' | 'edge',
  key: string,
  b: T | undefined,
  o: T,
  t: T,
  layoutFields: ReadonlySet<string>,
  conflicts: Merge3Conflict[],
): T {
  const rec = (x: T | undefined) => (x ?? {}) as Record<string, unknown>;
  const fields = [...new Set([...Object.keys(o), ...Object.keys(t), ...Object.keys(rec(b))])];
  const out: Record<string, unknown> = {};
  const label = kind === 'node' ? 'Node' : 'Edge';
  for (const f of fields) {
    if (f === 'style' && layoutFields.has(f)) {
      const s = mergeStyle(rec(b)[f], rec(o)[f], rec(t)[f]);
      if (s) out[f] = s;
      continue;
    }
    const r = pick(rec(b)[f], rec(o)[f], rec(t)[f]);
    if (r.value !== undefined) out[f] = r.value;
    if (r.conflict && !layoutFields.has(f)) {
      conflicts.push({
        kind,
        id: key,
        field: f,
        message: b
          ? `${label} "${key}" ${f} changed on both sides: ours ${show(rec(o)[f])}, theirs ${show(rec(t)[f])} (base ${show(rec(b)[f])}); kept ours`
          : `${label} "${key}" was added on both sides with different ${f}: ours ${show(rec(o)[f])}, theirs ${show(rec(t)[f])}; kept ours`,
      });
    }
  }
  return out as T;
}

/** Styles merge per key (one side may change the fill while the other changes the text). */
function mergeStyle(b: unknown, o: unknown, t: unknown): NodeStyle | undefined {
  const rec = (x: unknown) => (x ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of STYLE_KEYS) {
    const v = pick(rec(b)[k], rec(o)[k], rec(t)[k]).value;
    if (v !== undefined) out[k] = v;
  }
  return sanitizeStyle(out);
}

const pairKey = (e: ArchEdge) => `${e.from}->${e.to}`;

/**
 * Keys edges by `from->to`. Pairs with parallel edges (in any version) are keyed by
 * `from->to[label]` instead, with `#n` for repeats of the same label.
 */
function edgeMap(edges: ArchEdge[], parallel: ReadonlySet<string>): Map<string, ArchEdge> {
  const out = new Map<string, ArchEdge>();
  for (const e of edges) {
    const pair = pairKey(e);
    let key = parallel.has(pair) ? `${pair}[${e.label ?? ''}]` : pair;
    if (out.has(key)) {
      let n = 2;
      while (out.has(`${key}#${n}`)) n++;
      key = `${key}#${n}`;
    }
    out.set(key, e);
  }
  return out;
}

function parallelPairs(...diagrams: Diagram[]): Set<string> {
  const out = new Set<string>();
  for (const d of diagrams) {
    const seen = new Set<string>();
    for (const e of d.edges) {
      const k = pairKey(e);
      if (seen.has(k)) out.add(k);
      seen.add(k);
    }
  }
  return out;
}

/** Comments: base comments survive unless a side removed them; both sides' additions are kept. */
function mergeComments(base: string[], ours: string[], theirs: string[]): string[] {
  const b = new Set(base);
  const o = new Set(ours);
  const t = new Set(theirs);
  const out = ours.filter((c) => !b.has(c) || t.has(c));
  for (const c of theirs) if (!b.has(c) && !o.has(c)) out.push(c);
  return [...new Set(out)];
}

const posOf = (l: NodeLayout | undefined) => (l ? { x: l.x, y: l.y } : undefined);
const sizeOf = (l: NodeLayout | undefined) =>
  l && l.w !== undefined && l.h !== undefined ? { w: l.w, h: l.h } : undefined;

/** Position and size merge independently: one side may move a group while the other resizes it. */
function mergeNodeLayout(
  b: NodeLayout | undefined,
  o: NodeLayout | undefined,
  t: NodeLayout | undefined,
): NodeLayout | undefined {
  const pos = pick(posOf(b), posOf(o), posOf(t)).value;
  if (!pos) return undefined;
  const size = pick(sizeOf(b), sizeOf(o), sizeOf(t)).value;
  return size ? { ...pos, ...size } : { ...pos };
}

/** Diagram fields added by newer model versions: merged per key (records) or whole, ours wins. */
function mergeExtraFields(base: Diagram, ours: Diagram, theirs: Diagram, out: Diagram): void {
  const rec = (d: Diagram) => d as unknown as Record<string, unknown>;
  const keys = new Set(
    [base, ours, theirs].flatMap((d) => Object.keys(d)).filter((k) => !KNOWN_DIAGRAM_KEYS.has(k)),
  );
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  for (const k of keys) {
    const [b, o, t] = [rec(base)[k], rec(ours)[k], rec(theirs)[k]];
    if (
      (b === undefined || isRecord(b)) &&
      (o === undefined || isRecord(o)) &&
      (t === undefined || isRecord(t))
    ) {
      const sub: Record<string, unknown> = {};
      const subKeys = new Set([
        ...Object.keys(o ?? {}),
        ...Object.keys(t ?? {}),
        ...Object.keys(b ?? {}),
      ]);
      for (const sk of subKeys) {
        const v = pick(b?.[sk], o?.[sk], t?.[sk]).value;
        if (v !== undefined) sub[sk] = v;
      }
      if (o !== undefined || t !== undefined) rec(out)[k] = sub;
    } else {
      const v = pick(b, o, t).value;
      if (v !== undefined) rec(out)[k] = v;
    }
  }
}

const AT_RE = /^%%\s*@([A-Za-z][\w-]*)(.*)$/;
const ID_TOKEN = /^[A-Za-z_][\w-]*$/;

interface AtLine {
  word: string;
  ids: string[];
  line: string;
}

/** `%% @word id... rest` lines of a file, keyed by `word id...`. `@layout` headers are skipped. */
function atLines(text: string): Map<string, AtLine> {
  const out = new Map<string, AtLine>();
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const m = AT_RE.exec(raw.trim());
    if (!m || m[1] === 'layout') continue;
    const word = m[1]!;
    const tokens = m[2]!.trim().split(/\s+/).filter(Boolean);
    const ids: string[] = [];
    for (const tok of tokens) {
      if (!ID_TOKEN.test(tok)) break;
      ids.push(tok);
    }
    out.set([word, ...ids].join(' '), {
      word,
      ids,
      line: `%% @${word}${tokens.length ? ` ${tokens.join(' ')}` : ''}`,
    });
  }
  return out;
}

const atWords = (text: string) => new Set([...atLines(text).values()].map((l) => l.word));

function parseSide(text: string, side: 'base' | 'ours' | 'theirs'): Diagram | Merge3Conflict {
  // Git passes an empty base when the file was added on both branches.
  if (side === 'base' && !text.trim()) return emptyDiagram();
  const { diagram, errors } = parseArchitecture(text);
  if (!errors.length) return diagram;
  const first = [...errors].sort((a, b) => a.line - b.line)[0]!;
  return {
    kind: 'parse',
    side,
    message: `${side} does not parse (line ${first.line}: ${oneLine(first.message)}); no semantic merge was done`,
  };
}

export function merge3(base: string, ours: string, theirs: string): Merge3Result {
  const parsed = [parseSide(base, 'base'), parseSide(ours, 'ours'), parseSide(theirs, 'theirs')];
  const failures = parsed.filter((p): p is Merge3Conflict => 'kind' in p);
  if (failures.length) return { text: ours, conflicts: failures };
  const [b, o, t] = parsed as Diagram[];
  const conflicts: Merge3Conflict[] = [];

  // Nodes.
  const nodeMap = (d: Diagram) => new Map(d.nodes.map((n) => [n.id, n]));
  const [bN, oN, tN] = [nodeMap(b!), nodeMap(o!), nodeMap(t!)];
  const nodes = mergeEntities('node', bN, oN, tN, NODE_LAYOUT_FIELDS, conflicts);

  // Edges.
  const parallel = parallelPairs(b!, o!, t!);
  const [bE, oE, tE] = [
    edgeMap(b!.edges, parallel),
    edgeMap(o!.edges, parallel),
    edgeMap(t!.edges, parallel),
  ];
  const edges = mergeEntities('edge', bE, oE, tE, EDGE_LAYOUT_FIELDS, conflicts);

  // A node deleted on one side that the other side still needs (a child was added to the group,
  // or an edge to it was added or changed) comes back, as a conflict.
  const restore = (id: string, why: string): boolean => {
    const gone = nodes.deleted.get(id);
    if (!gone) return false;
    nodes.deleted.delete(id);
    nodes.merged.set(id, { ...gone.version });
    const keeper: Side = gone.by === 'ours' ? 'theirs' : 'ours';
    conflicts.push({
      kind: 'node',
      id,
      message: `Node "${id}" was deleted in ${gone.by} but ${why} in ${keeper}; kept the node`,
    });
    return true;
  };
  for (let grew = true; grew;) {
    grew = false;
    for (const n of [...nodes.merged.values()]) {
      if (n.parent && !nodes.merged.has(n.parent)) {
        if (restore(n.parent, `"${n.id}" is inside it`)) grew = true;
        else nodes.merged.set(n.id, { ...n, parent: undefined });
      }
    }
    for (const [key, e] of [...edges.merged]) {
      for (const end of [e.from, e.to]) {
        if (nodes.merged.has(end)) continue;
        if (restore(end, `edge "${key}" uses it`)) grew = true;
        else edges.merged.delete(key);
      }
    }
  }

  // Layout: per node, the side that moved it (ours if both). A side without the node counts as
  // unchanged. When the parent came from theirs, theirs' relative position goes with it.
  const layout: Record<string, NodeLayout> = {};
  for (const [id, n] of nodes.merged) {
    const bl = b!.layout[id];
    const ol = oN.has(id) ? o!.layout[id] : bl;
    const tl = tN.has(id) ? t!.layout[id] : bl;
    const oursParent = oN.get(id)?.parent;
    const l =
      oN.has(id) && tN.has(id) && (n.parent ?? '') !== (oursParent ?? '')
        ? tl
        : mergeNodeLayout(bl, ol, tl);
    if (l) layout[id] = { ...l };
  }

  const title = pick(b!.title, o!.title, t!.title);
  if (title.conflict) {
    conflicts.push({
      kind: 'title',
      field: 'title',
      message: `Title changed on both sides: ours ${show(o!.title)}, theirs ${show(t!.title)}; kept ours`,
    });
  }

  const diagram: Diagram = {
    nodes: [...nodes.merged.values()].map((n) => {
      const c: ArchNode = { ...n };
      if (c.parent === undefined) delete c.parent;
      return c;
    }),
    edges: [...edges.merged.values()],
    layout,
    comments: mergeComments(b!.comments, o!.comments, t!.comments),
  };
  if (title.value !== undefined) diagram.title = title.value;
  mergeExtraFields(b!, o!, t!, diagram);

  let text = serializeArchitecture(diagram);
  text = appendUnknownAtLines(text, diagram, [b!, o!, t!], [base, ours, theirs]);
  return { text, conflicts };
}

/** Merges `%% @word` lines the serializer doesn't write, so newer layout data survives. */
function appendUnknownAtLines(
  text: string,
  merged: Diagram,
  diagrams: Diagram[],
  sources: string[],
): string {
  const understood = new Set(['pos', 'layout', ...atWords(text)]);
  for (const d of diagrams) for (const w of atWords(serializeArchitecture(d))) understood.add(w);
  const [bl, ol, tl] = sources.map((s) => {
    const all = atLines(s);
    return new Map([...all].filter(([, l]) => !understood.has(l.word)));
  });
  if (!ol!.size && !tl!.size) return text;

  const knownIds = new Set(diagrams.flatMap((d) => d.nodes.map((n) => n.id)));
  const live = new Set(merged.nodes.map((n) => n.id));
  const keys = [...ol!.keys(), ...[...tl!.keys()].filter((k) => !ol!.has(k))];
  const lines: string[] = [];
  for (const k of keys) {
    const v = pick(bl!.get(k)?.line, ol!.get(k)?.line, tl!.get(k)?.line).value;
    if (v === undefined) continue;
    const ids = (ol!.get(k) ?? tl!.get(k))!.ids;
    if (ids.some((id) => knownIds.has(id) && !live.has(id))) continue;
    lines.push(`  ${v}`);
  }
  if (!lines.length) return text;
  const body = text.replace(/\n+$/, '');
  return `${body}\n${/%%\s*@/.test(body) ? '' : '\n'}${lines.join('\n')}\n`;
}

/**
 * Adds a `%% CONFLICT: <message>` comment line per conflict right after the header, so the file
 * still parses (and renders) while showing what needs a decision.
 */
export function annotateConflicts(text: string, conflicts: Merge3Conflict[]): string {
  if (!conflicts.length) return text;
  const notes = conflicts.map((c) => `  %% CONFLICT: ${oneLine(c.message)}`);
  const lines = text.split('\n');
  const header = lines.findIndex((l) => /^\s*architecture(-beta)?\s*$/.test(l));
  if (header === -1) return [...notes.map((n) => n.trim()), ...lines].join('\n');
  lines.splice(header + 1, 0, ...notes);
  return lines.join('\n');
}
