import { promises as fs, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  GENERIC_CATALOG,
  MERMAID_BUILTIN_ICONS,
  SERVICE_SIZE,
  JUNCTION_SIZE,
  autoLayout,
  descendantsOf,
  diffStructure,
  dropStaleRoutes,
  emptyDiagram,
  isValidId,
  layoutNewNodes,
  lintDiagram,
  makeId,
  mergeLayout,
  parseArchitecture,
  parseMermaid,
  importIac,
  parseTerraform,
  removeNode as coreRemoveNode,
  renameNode,
  serializeArchitecture,
  sidesFor,
  suggestIcons,
} from '@opsdraw/core';
import type {
  ArchEdge,
  ArchNode,
  Diagram,
  LayoutDirection,
  NodeKind,
  ParseError,
  Side,
  IacKind,
  LintIssue,
  TerraformFile,
} from '@opsdraw/core';

/**
 * Pure-ish tool implementations: each takes a context (the sandbox root) and plain arguments,
 * reads/writes diagram files on disk, and returns a JSON-serializable result. They throw
 * `ToolError` for anything the caller did wrong; the MCP layer turns that into `isError`.
 *
 * Layout policy for mutating tools that add nodes (`layout` option, default true): ELK
 * auto-layout runs over the WHOLE diagram, but only when at least one node has no stored
 * position. Diagrams where every node is already placed are never re-laid out implicitly.
 * Note that a full layout replaces existing positions too; pass `layout: false` to keep them
 * (the new node is then written without a position) and call `auto_layout` later.
 */

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export interface ToolContext {
  /** Absolute directory every path must stay inside. */
  root: string;
}

export const DIAGRAM_EXTENSIONS = ['.mmd', '.mermaid'] as const;
export const TERRAFORM_EXTENSIONS = ['.tf', '.tofu'] as const;
import { IAC_BARE_NAMES, IAC_EXTENSIONS } from '@opsdraw/core';

export { IAC_BARE_NAMES, IAC_EXTENSIONS };
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TF_FILES = 2000;
const ICON_RE = /^[A-Za-z0-9_-]+(:[A-Za-z0-9_-]+)?$/;

export function contextFromEnv(env: NodeJS.ProcessEnv = process.env): ToolContext {
  return { root: path.resolve(env.OPSDRAW_ROOT || process.cwd()) };
}

// ---------------------------------------------------------------------------------------------
// Path safety

const isInside = (root: string, target: string) => {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** Real path of `p`, or of its nearest existing ancestor joined with the missing tail. */
function realish(p: string): string {
  const tail: string[] = [];
  let cur = p;
  for (;;) {
    try {
      return path.join(realpathSync.native(cur), ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * Resolves `input` against the root and rejects anything outside it, both lexically
 * (`..`, absolute paths elsewhere, other drives) and after following symlinks.
 */
export function resolveSafe(
  ctx: ToolContext,
  input: string,
  extensions?: readonly string[],
): string {
  if (typeof input !== 'string' || !input.trim()) throw new ToolError('Path is required');
  if (input.includes('\0')) throw new ToolError('Path contains a NUL byte');
  const root = path.resolve(ctx.root);
  const target = path.resolve(root, input);
  if (!isInside(root, target) || !isInside(realish(root), realish(target))) {
    throw new ToolError(`Path "${input}" is outside the allowed root (${root})`);
  }
  if (extensions) {
    const ext = path.extname(target).toLowerCase();
    if (!extensions.includes(ext)) {
      throw new ToolError(
        `Path "${input}" must have one of these extensions: ${extensions.join(', ')}`,
      );
    }
  }
  return target;
}

const display = (ctx: ToolContext, abs: string) =>
  path.relative(ctx.root, abs).split(path.sep).join('/') || '.';

// ---------------------------------------------------------------------------------------------
// File helpers

async function readText(abs: string, label: string): Promise<string> {
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    throw new ToolError(`${label} not found`);
  }
  if (!stat.isFile()) throw new ToolError(`${label} is not a file`);
  if (stat.size > MAX_FILE_BYTES) throw new ToolError(`${label} is larger than 5 MB`);
  return fs.readFile(abs, 'utf8');
}

const formatErrors = (errors: ParseError[]) =>
  errors.map((e) => `  line ${e.line}: ${e.message}`).join('\n');

async function loadDiagram(
  ctx: ToolContext,
  file: string,
): Promise<{ abs: string; diagram: Diagram }> {
  const abs = resolveSafe(ctx, file, DIAGRAM_EXTENSIONS);
  const text = await readText(abs, `Diagram "${file}"`);
  const { diagram, errors } = parseArchitecture(text);
  if (errors.length) {
    throw new ToolError(`Diagram "${file}" has parse errors:\n${formatErrors(errors)}`);
  }
  return { abs, diagram };
}

/** Writes via a temp file + rename so watchers (the opsdraw app) never see half a file. */
async function writeText(abs: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, text, 'utf8');
  try {
    await fs.rename(tmp, abs);
  } catch {
    // Windows refuses the rename while another process holds the file; fall back.
    await fs.rm(tmp, { force: true });
    await fs.writeFile(abs, text, 'utf8');
  }
}

async function saveDiagram(abs: string, diagram: Diagram): Promise<string> {
  const text = serializeArchitecture(diagram);
  await writeText(abs, text);
  return text;
}

const needsLayout = (d: Diagram) => d.nodes.some((n) => !d.layout[n.id]);

async function maybeLayout(
  d: Diagram,
  layout: boolean | undefined,
  direction?: LayoutDirection,
): Promise<{ diagram: Diagram; laidOut: boolean }> {
  if (layout === false || !needsLayout(d)) return { diagram: d, laidOut: false };
  return { diagram: await autoLayout(d, direction ?? 'RIGHT'), laidOut: true };
}

// ---------------------------------------------------------------------------------------------
// Summaries

export interface DiagramSummary {
  title?: string;
  nodes: { id: string; kind: NodeKind; label?: string; icon?: string; parent?: string }[];
  edges: {
    from: string;
    to: string;
    fromSide: Side;
    toSide: Side;
    arrow: Arrow;
    label?: string;
    fromGroup?: boolean;
    toGroup?: boolean;
  }[];
  unpositioned: string[];
}

export type Arrow = 'none' | 'forward' | 'back' | 'both';

const arrowOf = (e: ArchEdge): Arrow =>
  e.arrowStart && e.arrowEnd ? 'both' : e.arrowEnd ? 'forward' : e.arrowStart ? 'back' : 'none';

export function summarize(d: Diagram): DiagramSummary {
  const s: DiagramSummary = {
    nodes: d.nodes.map((n) => {
      const out: DiagramSummary['nodes'][number] = { id: n.id, kind: n.kind };
      if (n.label !== undefined) out.label = n.label;
      if (n.icon) out.icon = n.icon;
      if (n.parent) out.parent = n.parent;
      return out;
    }),
    edges: d.edges.map((e) => {
      const out: DiagramSummary['edges'][number] = {
        from: e.from,
        to: e.to,
        fromSide: e.fromSide,
        toSide: e.toSide,
        arrow: arrowOf(e),
      };
      if (e.label) out.label = e.label;
      if (e.fromGroup) out.fromGroup = true;
      if (e.toGroup) out.toGroup = true;
      return out;
    }),
    unpositioned: d.nodes.filter((n) => !d.layout[n.id]).map((n) => n.id),
  };
  if (d.title) s.title = d.title;
  return s;
}

// ---------------------------------------------------------------------------------------------
// Validation helpers

function findNode(d: Diagram, id: string): ArchNode {
  const n = d.nodes.find((x) => x.id === id);
  if (!n)
    throw new ToolError(
      `No node with id "${id}". Existing ids: ${d.nodes.map((x) => x.id).join(', ') || '(none)'}`,
    );
  return n;
}

function checkParent(d: Diagram, parent: string | undefined): void {
  if (!parent) return;
  const p = d.nodes.find((x) => x.id === parent);
  if (!p) throw new ToolError(`Parent "${parent}" does not exist`);
  if (p.kind !== 'group') throw new ToolError(`Parent "${parent}" is a ${p.kind}, not a group`);
}

/**
 * Whether an icon reference is known: a Mermaid built-in, a Lucide icon (`lucide:<name>`), or
 * any other `prefix:name`, since vendor packs are imported by users and can't be checked here.
 * When the Lucide list can't be loaded, every `lucide:` name is accepted.
 */
export function isKnownIcon(ref: string): boolean {
  const i = ref.indexOf(':');
  if (i === -1) return (MERMAID_BUILTIN_ICONS as readonly string[]).includes(ref);
  if (ref.slice(0, i) !== 'lucide') return true;
  const names = loadLucide();
  return !names.length || lucideSet().has(ref.slice(i + 1));
}

let lucideLookup: Set<string> | undefined;
const lucideSet = () => (lucideLookup ??= new Set(loadLucide()));

/** Icon refs suggestions are drawn from: built-ins and every Lucide icon. */
const iconCandidates = (): string[] => [
  ...MERMAID_BUILTIN_ICONS,
  ...loadLucide().map((n) => `lucide:${n}`),
];

/** Up to three replacements for an unknown icon: keyword matches first, then close spellings. */
export function iconSuggestions(ref: string): string[] {
  const name = ref.slice(ref.indexOf(':') + 1);
  const byKeyword = name
    ? listIcons({ query: name.replace(/[-_]+/g, ' '), limit: 3 }).icons.map((h) => h.ref)
    : [];
  const out = [...new Set([...byKeyword, ...suggestIcons(ref, iconCandidates(), 3)])];
  return out.slice(0, 3);
}

function checkIcon(icon: string | undefined): void {
  if (icon === undefined || icon === '') return;
  if (!ICON_RE.test(icon)) {
    throw new ToolError(
      `Invalid icon "${icon}": use a built-in name (e.g. "server") or "prefix:name" (e.g. "lucide:database")`,
    );
  }
  if (!isKnownIcon(icon)) {
    const tips = iconSuggestions(icon);
    const hint = tips.length ? `did you mean ${tips.join(', ')}? ` : '';
    throw new ToolError(
      `Unknown icon "${icon}": ${hint}Use a Mermaid built-in (${MERMAID_BUILTIN_ICONS.join(', ')}), lucide:<name>, or a vendor prefix the user imported (aws:, azure:, ...). Search with list_icons.`,
    );
  }
}

/** Compact structural diff: only the non-empty lists of node ids and `from->to` edge keys. */
export function compactDiff(before: Diagram, after: Diagram) {
  const d = diffStructure(before, after);
  const out: Partial<
    Record<
      'added' | 'removed' | 'changed' | 'addedEdges' | 'removedEdges' | 'changedEdges',
      string[]
    >
  > = {};
  for (const k of [
    'added',
    'removed',
    'changed',
    'addedEdges',
    'removedEdges',
    'changedEdges',
  ] as const) {
    if (d[k].length) out[k] = d[k];
  }
  return out;
}

/** Lint issues for a diagram, with unknown-icon checks using the same rules as the tools. */
export function lint(diagram: Diagram, source?: string): LintIssue[] {
  return lintDiagram(diagram, {
    knownIcons: isKnownIcon,
    iconCandidates: iconCandidates(),
    source,
  });
}

function checkNewId(d: Diagram, id: string): void {
  if (!isValidId(id)) {
    throw new ToolError(
      `Invalid id "${id}": must start with a letter or "_" and contain only letters, digits, "_" or "-"`,
    );
  }
  if (d.nodes.some((n) => n.id === id)) throw new ToolError(`Id "${id}" is already used`);
}

// ---------------------------------------------------------------------------------------------
// Tools

export async function createDiagram(
  ctx: ToolContext,
  args: { path: string; title?: string; overwrite?: boolean },
) {
  const abs = resolveSafe(ctx, args.path, DIAGRAM_EXTENSIONS);
  if (!args.overwrite) {
    const exists = await fs
      .stat(abs)
      .then(() => true)
      .catch(() => false);
    if (exists)
      throw new ToolError(`"${args.path}" already exists (pass overwrite: true to replace it)`);
  }
  const d = emptyDiagram();
  if (args.title?.trim()) d.title = args.title.trim().replace(/[\r\n]+/g, ' ');
  const mermaid = await saveDiagram(abs, d);
  return { path: display(ctx, abs), mermaid };
}

export async function readDiagram(ctx: ToolContext, args: { path: string }) {
  const { abs, diagram } = await loadDiagram(ctx, args.path);
  return {
    path: display(ctx, abs),
    mermaid: serializeArchitecture(diagram),
    summary: summarize(diagram),
  };
}

export async function writeDiagram(
  ctx: ToolContext,
  args: { path: string; mermaid: string; layout?: boolean; direction?: LayoutDirection },
) {
  const abs = resolveSafe(ctx, args.path, DIAGRAM_EXTENSIONS);
  const parsed = parseMermaid(args.mermaid);
  if (parsed.errors.length) {
    return { written: false, kind: parsed.kind, errors: parsed.errors };
  }
  const { diagram, laidOut } = await maybeLayout(parsed.diagram, args.layout, args.direction);
  const before = await fs
    .readFile(abs, 'utf8')
    .then((t) => parseArchitecture(t))
    .catch(() => null);
  const mermaid = await saveDiagram(abs, diagram);
  return {
    written: true,
    path: display(ctx, abs),
    convertedFromFlowchart: parsed.kind === 'flowchart',
    laidOut,
    /** Omitted when the file is new or did not parse before. */
    diff: before && !before.errors.length ? compactDiff(before.diagram, diagram) : undefined,
    summary: summarize(diagram),
    mermaid,
  };
}

export interface AddNodeArgs {
  path: string;
  id?: string;
  label?: string;
  icon?: string;
  parent?: string;
  layout?: boolean;
}

async function addNode(ctx: ToolContext, kind: NodeKind, args: AddNodeArgs) {
  const { abs, diagram } = await loadDiagram(ctx, args.path);
  const label = args.label?.trim();
  if (kind !== 'junction' && !label && !args.id) throw new ToolError('label is required');
  const id =
    args.id ??
    makeId(
      label || kind,
      diagram.nodes.map((n) => n.id),
    );
  checkNewId(diagram, id);
  checkParent(diagram, args.parent);
  checkIcon(args.icon);
  const node: ArchNode = { id, kind };
  if (kind !== 'junction') {
    node.label = label || id;
    if (args.icon) node.icon = args.icon;
  }
  if (args.parent) node.parent = args.parent;
  const next = { ...diagram, nodes: [...diagram.nodes, node] };
  const { diagram: out, laidOut } = await maybeLayout(next, args.layout);
  await saveDiagram(abs, out);
  return { id, kind, laidOut, path: display(ctx, abs), diff: { added: [id] } };
}

export const addService = (ctx: ToolContext, args: AddNodeArgs & { label: string }) =>
  addNode(ctx, 'service', args);
export const addGroup = (ctx: ToolContext, args: AddNodeArgs & { label: string }) =>
  addNode(ctx, 'group', args);
export const addJunction = (ctx: ToolContext, args: Omit<AddNodeArgs, 'label' | 'icon'>) =>
  addNode(ctx, 'junction', args);

/** Absolute center of a node from the stored (parent-relative) layout, if it is placed. */
function centerOf(d: Diagram, id: string): { x: number; y: number } | undefined {
  const byId = new Map(d.nodes.map((n) => [n.id, n]));
  const node = byId.get(id);
  const own = d.layout[id];
  if (!node || !own) return undefined;
  let x = own.x;
  let y = own.y;
  const seen = new Set([id]);
  for (let p = node.parent; p && !seen.has(p); p = byId.get(p)?.parent) {
    seen.add(p);
    const l = d.layout[p];
    if (!l) return undefined;
    x += l.x;
    y += l.y;
  }
  const size = node.kind === 'junction' ? JUNCTION_SIZE : SERVICE_SIZE;
  return { x: x + (own.w ?? size.w) / 2, y: y + (own.h ?? size.h) / 2 };
}

export async function connect(
  ctx: ToolContext,
  args: {
    path: string;
    from: string;
    to: string;
    label?: string;
    arrow?: Arrow;
    fromSide?: Side;
    toSide?: Side;
    fromGroup?: boolean;
    toGroup?: boolean;
  },
) {
  const { abs, diagram } = await loadDiagram(ctx, args.path);
  const a = findNode(diagram, args.from);
  const b = findNode(diagram, args.to);
  if (a.id === b.id) throw new ToolError('Cannot connect a node to itself');
  for (const n of [a, b]) {
    if (n.kind === 'group') {
      throw new ToolError(
        `"${n.id}" is a group. Mermaid edges connect services or junctions; to attach to a group's boundary, connect a service inside it and set fromGroup/toGroup: true`,
      );
    }
  }
  if (args.fromGroup && !a.parent)
    throw new ToolError(`fromGroup needs "${a.id}" to be inside a group`);
  if (args.toGroup && !b.parent)
    throw new ToolError(`toGroup needs "${b.id}" to be inside a group`);

  let sides: { fromSide: Side; toSide: Side } = { fromSide: 'R', toSide: 'L' };
  const ca = centerOf(diagram, a.id);
  const cb = centerOf(diagram, b.id);
  if (ca && cb) sides = sidesFor(ca, cb);
  const arrow = args.arrow ?? 'forward';
  const edge: ArchEdge = {
    from: a.id,
    to: b.id,
    fromSide: args.fromSide ?? sides.fromSide,
    toSide: args.toSide ?? sides.toSide,
  };
  if (arrow === 'back' || arrow === 'both') edge.arrowStart = true;
  if (arrow === 'forward' || arrow === 'both') edge.arrowEnd = true;
  if (args.label?.trim()) edge.label = args.label.trim();
  if (args.fromGroup) edge.fromGroup = true;
  if (args.toGroup) edge.toGroup = true;
  const next = { ...diagram, edges: [...diagram.edges, edge] };
  await saveDiagram(abs, next);
  return {
    edge: summarize({ ...emptyDiagram(), edges: [edge] }).edges[0],
    path: display(ctx, abs),
    diff: compactDiff(diagram, next),
  };
}

export async function disconnect(
  ctx: ToolContext,
  args: { path: string; from: string; to: string },
) {
  const { abs, diagram } = await loadDiagram(ctx, args.path);
  const match = (e: ArchEdge) =>
    (e.from === args.from && e.to === args.to) || (e.from === args.to && e.to === args.from);
  const removed = diagram.edges.filter(match).length;
  if (!removed) throw new ToolError(`No edge between "${args.from}" and "${args.to}"`);
  const next = { ...diagram, edges: diagram.edges.filter((e) => !match(e)) };
  await saveDiagram(abs, next);
  return { removed, path: display(ctx, abs), diff: compactDiff(diagram, next) };
}

export async function updateNode(
  ctx: ToolContext,
  args: {
    path: string;
    id: string;
    label?: string;
    icon?: string | null;
    parent?: string | null;
    newId?: string;
    layout?: boolean;
  },
) {
  const { abs, diagram } = await loadDiagram(ctx, args.path);
  const node = findNode(diagram, args.id);
  let d: Diagram = diagram;
  const changes: string[] = [];

  if (args.label !== undefined) {
    if (node.kind === 'junction') throw new ToolError('Junctions have no label');
    if (!args.label.trim()) throw new ToolError('label cannot be empty');
    changes.push('label');
  }
  if (args.icon !== undefined) {
    if (node.kind === 'junction') throw new ToolError('Junctions have no icon');
    checkIcon(args.icon ?? undefined);
    changes.push('icon');
  }
  let moved = false;
  if (args.parent !== undefined && (args.parent ?? undefined) !== node.parent) {
    if (args.parent !== null) {
      checkParent(d, args.parent);
      if (node.kind === 'group' && descendantsOf(d, node.id).has(args.parent)) {
        throw new ToolError(`Cannot move group "${node.id}" into itself or one of its descendants`);
      }
    }
    moved = true;
    changes.push('parent');
  }

  d = {
    ...d,
    nodes: d.nodes.map((n) => {
      if (n.id !== node.id) return n;
      const out: ArchNode = { ...n };
      if (args.label !== undefined) out.label = args.label.trim();
      if (args.icon !== undefined) {
        if (args.icon) out.icon = args.icon;
        else delete out.icon;
      }
      if (moved) {
        if (args.parent) out.parent = args.parent;
        else delete out.parent;
      }
      return out;
    }),
  };
  if (moved) {
    // Positions are relative to the parent group, so the old one is meaningless now.
    const layout = { ...d.layout };
    delete layout[node.id];
    // Its stored edge routes (and those of anything inside it) no longer fit.
    d = dropStaleRoutes(diagram, { ...d, layout });
  }

  let id = node.id;
  if (args.newId !== undefined && args.newId !== node.id) {
    checkNewId(d, args.newId);
    d = renameNode(d, node.id, args.newId);
    id = args.newId;
    changes.push('id');
  }
  if (!changes.length) throw new ToolError('Nothing to update: pass label, icon, parent or newId');

  const { diagram: out, laidOut } = await maybeLayout(d, moved ? args.layout : false);
  await saveDiagram(abs, out);
  return {
    id,
    changed: changes,
    laidOut,
    path: display(ctx, abs),
    diff: compactDiff(diagram, out),
  };
}

export async function removeNode(ctx: ToolContext, args: { path: string; id: string }) {
  const { abs, diagram } = await loadDiagram(ctx, args.path);
  findNode(diagram, args.id);
  const next = coreRemoveNode(diagram, args.id);
  const left = new Set(next.nodes.map((n) => n.id));
  const removedNodes = diagram.nodes.filter((n) => !left.has(n.id)).map((n) => n.id);
  const removedEdges = diagram.edges.length - next.edges.length;
  await saveDiagram(abs, next);
  return { removedNodes, removedEdges, path: display(ctx, abs), diff: compactDiff(diagram, next) };
}

export async function autoLayoutFile(
  ctx: ToolContext,
  args: { path: string; direction?: LayoutDirection },
) {
  const { abs, diagram } = await loadDiagram(ctx, args.path);
  const out = await autoLayout(diagram, args.direction ?? 'RIGHT');
  const mermaid = await saveDiagram(abs, out);
  return { path: display(ctx, abs), direction: args.direction ?? 'RIGHT', mermaid };
}

async function collectSources(
  ctx: ToolContext,
  source: string,
  recursive: boolean,
  extensions: readonly string[],
  what: string,
  bareNames: readonly string[] = [],
) {
  const abs = resolveSafe(ctx, source);
  const isBare = (file: string) => bareNames.includes(path.basename(file).toLowerCase());
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    throw new ToolError(`${what} source "${source}" not found`);
  }
  const files: TerraformFile[] = [];
  const add = async (file: string) => {
    resolveSafe(ctx, file, isBare(file) ? undefined : extensions);
    if (files.length >= MAX_TF_FILES) throw new ToolError(`More than ${MAX_TF_FILES} files`);
    files.push({ path: display(ctx, file), content: await readText(file, display(ctx, file)) });
  };
  const wanted = (name: string) =>
    isBare(name) || extensions.some((ext) => name.toLowerCase().endsWith(ext));
  if (stat.isFile()) {
    resolveSafe(ctx, source, isBare(source) ? undefined : extensions);
    await add(abs);
  } else if (stat.isDirectory()) {
    const walk = async (dir: string) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      entries.sort((x, y) => x.name.localeCompare(y.name));
      for (const e of entries) {
        // Symlinks are skipped so a link cannot pull files from outside the root.
        if (e.isSymbolicLink()) continue;
        const full = path.join(dir, e.name);
        if (e.isFile() && wanted(e.name)) await add(full);
        else if (
          recursive &&
          e.isDirectory() &&
          !e.name.startsWith('.') &&
          e.name !== 'node_modules'
        ) {
          await walk(full);
        }
      }
    };
    await walk(abs);
  } else {
    throw new ToolError(`${what} source "${source}" is not a file or directory`);
  }
  if (!files.length)
    throw new ToolError(
      `No ${extensions.join('/')} files found in "${source}"${recursive ? '' : ' (try recursive: true)'}`,
    );
  return files;
}

const collectTerraform = (ctx: ToolContext, source: string, recursive: boolean) =>
  collectSources(ctx, source, recursive, TERRAFORM_EXTENSIONS, 'Terraform');

/**
 * Writes an imported diagram. A new file (or `overwrite: true`) is auto-laid out from scratch.
 * An existing file is merged like the CLI does: positions, group sizes and edge sides of nodes
 * that are still there are kept, and only new nodes are laid out.
 */
async function writeImported(
  out: string,
  name: string,
  imported: Diagram,
  direction: LayoutDirection | undefined,
  overwrite: boolean | undefined,
) {
  const dir = direction ?? 'RIGHT';
  const existing = overwrite ? null : await fs.readFile(out, 'utf8').catch(() => null);
  if (existing === null) {
    const diagram = await autoLayout(imported, dir);
    return { diagram, mermaid: await saveDiagram(out, diagram), merged: false as const };
  }
  const prev = parseArchitecture(existing);
  if (prev.errors.length)
    throw new ToolError(
      `"${name}" exists but has parse errors, so its layout can't be merged (fix it, or pass overwrite: true to replace it):\n${formatErrors(prev.errors)}`,
    );
  const m = mergeLayout(prev.diagram, imported);
  const diagram = await layoutNewNodes(m.diagram, new Set(m.kept), {
    direction: dir,
    pinnedEdges: new Set(m.keptEdges),
  });
  const text = serializeArchitecture(diagram);
  if (text !== existing) await writeText(out, text);
  return {
    diagram,
    mermaid: text,
    merged: true as const,
    unchanged: text === existing,
    added: m.added,
    removed: m.removed,
    changed: m.changed,
    addedEdges: m.addedEdges,
    removedEdges: m.removedEdges,
    kept: m.kept.length,
  };
}

const mergeInfo = ({
  diagram: _d,
  mermaid: _m,
  ...rest
}: Awaited<ReturnType<typeof writeImported>>) => rest;

export async function importIacFiles(
  ctx: ToolContext,
  args: {
    source: string;
    output: string;
    recursive?: boolean;
    includeAll?: boolean;
    direction?: LayoutDirection;
    title?: string;
    overwrite?: boolean;
  },
) {
  const out = resolveSafe(ctx, args.output, DIAGRAM_EXTENSIONS);
  const files = await collectSources(
    ctx,
    args.source,
    args.recursive ?? false,
    IAC_EXTENSIONS,
    'Infrastructure',
    IAC_BARE_NAMES,
  );
  const {
    diagram: parsed,
    kinds,
    skipped,
    overridden,
    warnings,
  } = importIac(files, { includeAll: args.includeAll });
  if (!kinds.length)
    throw new ToolError(
      `None of the ${files.length} file(s) looked like Terraform, CloudFormation, Kubernetes, Compose, a cluster config, an Ansible inventory or a Nomad job`,
    );
  if (args.title?.trim()) parsed.title = args.title.trim().replace(/[\r\n]+/g, ' ');
  const written = await writeImported(out, args.output, parsed, args.direction, args.overwrite);
  return {
    path: display(ctx, out),
    kinds: kinds as IacKind[],
    files: files.map((f) => f.path).filter((f) => !skipped.includes(f)),
    skipped,
    overridden,
    warnings,
    nodes: written.diagram.nodes.length,
    edges: written.diagram.edges.length,
    ...mergeInfo(written),
    mermaid: written.mermaid,
  };
}

export async function importTerraform(
  ctx: ToolContext,
  args: {
    source: string;
    output: string;
    recursive?: boolean;
    includeAll?: boolean;
    direction?: LayoutDirection;
    title?: string;
    overwrite?: boolean;
  },
) {
  const out = resolveSafe(ctx, args.output, DIAGRAM_EXTENSIONS);
  const files = await collectTerraform(ctx, args.source, args.recursive ?? false);
  const parsed = parseTerraform(files, { includeAll: args.includeAll });
  if (args.title?.trim()) parsed.title = args.title.trim().replace(/[\r\n]+/g, ' ');
  const written = await writeImported(out, args.output, parsed, args.direction, args.overwrite);
  return {
    path: display(ctx, out),
    files: files.map((f) => f.path),
    nodes: written.diagram.nodes.length,
    edges: written.diagram.edges.length,
    ...mergeInfo(written),
    mermaid: written.mermaid,
  };
}

// ---------------------------------------------------------------------------------------------
// Icons

export interface IconHit {
  ref: string;
  source: 'curated' | 'mermaid-builtin' | 'lucide';
  keywords?: string;
}

let lucideNames: string[] | undefined;

function loadLucide(): string[] {
  if (lucideNames) return lucideNames;
  try {
    const require = createRequire(import.meta.url);
    const set = require('@iconify-json/lucide/icons.json') as {
      icons: Record<string, unknown>;
      aliases?: Record<string, unknown>;
    };
    lucideNames = [...Object.keys(set.icons), ...Object.keys(set.aliases ?? {})].sort();
  } catch {
    lucideNames = [];
  }
  return lucideNames;
}

export function listIcons(args: { query?: string; limit?: number } = {}) {
  const limit = Math.max(1, Math.min(args.limit ?? 30, 500));
  const terms = (args.query ?? '')
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean);
  const hits: (IconHit & { score: number })[] = [];
  const seen = new Set<string>();
  const push = (hit: IconHit, score: number) => {
    if (seen.has(hit.ref)) return;
    seen.add(hit.ref);
    hits.push({ ...hit, score });
  };
  const scoreText = (text: string, words: string[]) => {
    if (!terms.length) return 1;
    let s = 0;
    for (const t of terms) {
      if (words.includes(t)) s += 3;
      else if (words.some((w) => w.startsWith(t))) s += 2;
      else if (text.includes(t)) s += 1;
      else return 0;
    }
    return s;
  };

  for (const cat of GENERIC_CATALOG) {
    for (const icon of cat.icons) {
      const text = `${icon.ref} ${icon.keywords} ${cat.id}`.toLowerCase();
      const s = scoreText(text, text.split(/[\s:-]+/));
      if (s) push({ ref: icon.ref, source: 'curated', keywords: icon.keywords }, s + 10);
    }
  }
  for (const name of MERMAID_BUILTIN_ICONS) {
    const s = scoreText(name, [name]);
    if (s) push({ ref: name, source: 'mermaid-builtin' }, s + 5);
  }
  const total = { curatedAndBuiltin: hits.length };
  if (terms.length) {
    for (const name of loadLucide()) {
      const s = scoreText(name, name.split('-'));
      if (s) push({ ref: `lucide:${name}`, source: 'lucide' }, s);
    }
  }
  hits.sort((x, y) => y.score - x.score);
  return {
    query: args.query ?? '',
    total: terms.length ? hits.length : total.curatedAndBuiltin,
    icons: hits.slice(0, limit).map((h): IconHit => {
      const out: IconHit = { ref: h.ref, source: h.source };
      if (h.keywords) out.keywords = h.keywords;
      return out;
    }),
    note: 'Use the "ref" value as the icon. Mermaid built-ins (cloud, database, disk, internet, server) render everywhere; lucide:<name> icons need the Lucide pack registered in other Mermaid renderers. Vendor packs (aws:, azure:, gcp:, ...) are imported by users in the opsdraw app and can be referenced by their prefix if the user has them.',
  };
}

// ---------------------------------------------------------------------------------------------
// Validate

export async function validate(ctx: ToolContext, args: { path?: string; mermaid?: string }) {
  if ((args.path === undefined) === (args.mermaid === undefined)) {
    throw new ToolError('Pass exactly one of "path" or "mermaid"');
  }
  const text =
    args.mermaid ??
    (await readText(resolveSafe(ctx, args.path!, DIAGRAM_EXTENSIONS), `Diagram "${args.path}"`));
  const parsed = parseMermaid(text);
  return {
    valid: parsed.errors.length === 0,
    kind: parsed.kind,
    errors: parsed.errors,
    nodes: parsed.diagram.nodes.length,
    edges: parsed.diagram.edges.length,
    issues: lint(parsed.diagram, parsed.kind === 'architecture' ? text : undefined),
    ...(parsed.kind === 'flowchart'
      ? { note: 'Flowcharts are accepted by write_diagram and converted to architecture-beta.' }
      : {}),
  };
}
