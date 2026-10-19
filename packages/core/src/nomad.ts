import type { ArchNode, Diagram } from './model';
import { emptyDiagram, makeId } from './model';
import type { IacFile, IacImportOptions } from './iac-shared';
import { edgeAdder, iconForImage } from './iac-shared';

/**
 * Best-effort Nomad job spec (HCL) -> architecture diagram.
 *
 * Each job becomes a group, each task group a nested group (labelled `name ×N` when count > 1)
 * and each task a service, with an icon picked from its image or driver. Consul Connect upstreams
 * and `{{ service "x" }}` lookups in templates become edges to the tasks that register service x.
 * This is not a full HCL parser: it matches blocks by braces, aware of strings, comments and
 * heredocs, which is enough for job specs.
 */

export type NomadImportOptions = IacImportOptions;

/** A parsed HCL block: `type "label" ... { attrs; blocks }`. Attribute values are raw text. */
export interface HclBlock {
  type: string;
  labels: string[];
  attrs: Record<string, string>;
  blocks: HclBlock[];
}

class Cursor {
  i = 0;
  constructor(readonly s: string) {}
  get done() {
    return this.i >= this.s.length;
  }
  peek(offset = 0) {
    return this.s[this.i + offset] ?? '';
  }
  /** Skips spaces, and newlines too when `newlines` is set, plus comments. */
  skip(newlines: boolean) {
    while (!this.done) {
      const c = this.peek();
      if (c === ' ' || c === '\t' || c === '\r' || (newlines && (c === '\n' || c === ';'))) {
        this.i++;
      } else if (c === '#' || (c === '/' && this.peek(1) === '/')) {
        while (!this.done && this.peek() !== '\n') this.i++;
      } else if (c === '/' && this.peek(1) === '*') {
        const end = this.s.indexOf('*/', this.i + 2);
        this.i = end < 0 ? this.s.length : end + 2;
      } else {
        return;
      }
    }
  }
  /** Reads a quoted string starting at `"`, returning its raw text (without quotes). */
  string(): string {
    const start = ++this.i;
    let depth = 0;
    while (!this.done) {
      const c = this.peek();
      if (c === '\\') this.i += 2;
      else if (c === '$' && this.peek(1) === '{') {
        depth++;
        this.i += 2;
      } else if (c === '}' && depth > 0) {
        depth--;
        this.i++;
      } else if (c === '"' && depth === 0) break;
      else if (c === '\n' && depth === 0) break;
      else this.i++;
    }
    const out = this.s.slice(start, Math.min(this.i, this.s.length));
    if (this.peek() === '"') this.i++;
    return out;
  }
  /** Reads a heredoc starting at `<<`, returning its body. */
  heredoc(): string | null {
    const m = /^<<-?([A-Za-z_][\w]*)[ \t]*\r?\n/.exec(this.s.slice(this.i, this.i + 200));
    if (!m) return null;
    const marker = m[1]!;
    this.i += m[0].length;
    const lines: string[] = [];
    while (!this.done) {
      let end = this.s.indexOf('\n', this.i);
      if (end < 0) end = this.s.length;
      const line = this.s.slice(this.i, end).replace(/\r$/, '');
      this.i = end;
      if (line.trim() === marker) return lines.join('\n');
      lines.push(line);
      this.i++;
    }
    return lines.join('\n');
  }
  ident(): string | null {
    const m = /^[A-Za-z_][\w-]*/.exec(this.s.slice(this.i, this.i + 256));
    if (!m) return null;
    this.i += m[0].length;
    return m[0];
  }
  /** Reads an attribute value up to the end of the line, across brackets, strings and heredocs. */
  value(): string {
    const start = this.i;
    let depth = 0;
    let body: string | null = null;
    while (!this.done) {
      const c = this.peek();
      if (c === '"') this.string();
      else if (c === '<' && this.peek(1) === '<') {
        const h = this.heredoc();
        if (h === null) this.i += 2;
        else {
          body = h;
          if (depth === 0) break;
        }
      } else if (c === '#' || (c === '/' && (this.peek(1) === '/' || this.peek(1) === '*'))) {
        if (depth === 0) break;
        this.skip(false);
      } else if (c === '[' || c === '{' || c === '(') {
        depth++;
        this.i++;
      } else if (c === ']' || c === '}' || c === ')') {
        if (depth === 0) break;
        depth--;
        this.i++;
      } else if ((c === '\n' || c === ',') && depth === 0) break;
      else this.i++;
    }
    return body ?? this.s.slice(start, this.i).trim();
  }
}

function parseBody(c: Cursor, depth: number): Omit<HclBlock, 'type' | 'labels'> {
  const attrs: Record<string, string> = {};
  const blocks: HclBlock[] = [];
  while (true) {
    c.skip(true);
    if (c.done) break;
    if (c.peek() === '}') {
      c.i++;
      break;
    }
    if (c.peek() === ',') {
      c.i++;
      continue;
    }
    const name = c.peek() === '"' ? c.string() : c.ident();
    if (name === null) {
      c.i++;
      continue;
    }
    c.skip(false);
    if ((c.peek() === '=' && c.peek(1) !== '=') || c.peek() === ':') {
      c.i++;
      c.skip(false);
      attrs[name] = c.value();
      continue;
    }
    const labels: string[] = [];
    while (!c.done) {
      c.skip(false);
      const ch = c.peek();
      if (ch === '"') labels.push(c.string());
      else if (/[A-Za-z_]/.test(ch)) labels.push(c.ident()!);
      else break;
    }
    if (c.peek() === '{') {
      c.i++;
      const body = depth < 64 ? parseBody(c, depth + 1) : (skipBlock(c), { attrs: {}, blocks: [] });
      blocks.push({ type: name, labels, ...body });
    } else {
      // Not something we understand: skip the rest of the line.
      while (!c.done && c.peek() !== '\n') c.i++;
    }
  }
  return { attrs, blocks };
}

function skipBlock(c: Cursor) {
  let depth = 1;
  while (!c.done && depth > 0) {
    const ch = c.peek();
    if (ch === '"') c.string();
    else if (ch === '<' && c.peek(1) === '<' && c.heredoc() !== null) continue;
    else {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      c.i++;
    }
  }
}

/** Parses HCL text into its top-level blocks (attributes at the top level are dropped). */
export function parseHclBlocks(content: string): HclBlock[] {
  return parseBody(new Cursor(content), 0).blocks;
}

/** The literal value of a raw attribute: an unquoted string or number, else undefined. */
function literal(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(raw.trim());
  if (m) return m[1]!.replace(/\\(.)/g, '$1');
  return /^[\w.-]+$/.test(raw.trim()) ? raw.trim() : undefined;
}

const child = (b: HclBlock, type: string) => b.blocks.filter((x) => x.type === type);

/** Every descendant block of a given type. */
function deep(b: HclBlock, type: string, out: HclBlock[] = []): HclBlock[] {
  for (const x of b.blocks) {
    if (x.type === type) out.push(x);
    deep(x, type, out);
  }
  return out;
}

const hasInterpolation = (s: string) => /\$\{/.test(s);

function serviceName(svc: HclBlock, fallback: string): string {
  const raw = literal(svc.attrs.name) ?? (svc.labels[0] && !svc.attrs.name ? svc.labels[0] : '');
  return raw && !hasInterpolation(raw) ? raw : fallback;
}

/** Service names a template looks up with `service "x"` / `nomadService "x"`. */
function templateServices(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b(?:service|nomadService|connect)\s+\\?"([^"\\]+)\\?"/g)) {
    // Consul queries look like `tag.name@datacenter`.
    const name = m[1]!.split('@')[0]!.split('.').pop()!;
    if (name) out.push(name);
  }
  return out;
}

function iconForTask(task: HclBlock): string {
  const driver = literal(task.attrs.driver) ?? '';
  if (/^(exec|exec2|raw_exec|java)$/.test(driver)) return 'server';
  const config = child(task, 'config')[0];
  const image = literal(config?.attrs.image);
  return iconForImage(image ?? task.labels[0] ?? '');
}

interface TaskRef {
  id: string;
  block: HclBlock;
}

export function parseNomad(files: IacFile[], _options: NomadImportOptions = {}): Diagram {
  const diagram = emptyDiagram();
  const taken: string[] = [];
  const take = (base: string) => {
    const id = makeId(base, taken);
    taken.push(id);
    return id;
  };
  /** Service name -> task ids that register it. */
  const providers = new Map<string, string[]>();
  const provide = (name: string, ids: string[]) =>
    providers.set(name, [...(providers.get(name) ?? []), ...ids]);
  /** Wanted links: source task ids -> service name. */
  const wants: [string[], string][] = [];

  for (const f of files) {
    for (const job of parseHclBlocks(f.content).filter((b) => b.type === 'job')) {
      const jobName = job.labels[0] ?? 'job';
      const jobId = take(jobName);
      diagram.nodes.push({ id: jobId, kind: 'group', label: jobName, icon: 'cloud' });

      for (const group of child(job, 'group')) {
        const groupName = group.labels[0] ?? 'group';
        const count = Number(literal(group.attrs.count) ?? 1);
        const groupId = take(groupName === jobName ? `${groupName}_group` : groupName);
        diagram.nodes.push({
          id: groupId,
          kind: 'group',
          label: Number.isFinite(count) && count > 1 ? `${groupName} ×${count}` : groupName,
          icon: 'lucide:layers',
          parent: jobId,
        });

        const tasks: TaskRef[] = child(group, 'task').map((block) => {
          const name = block.labels[0] ?? 'task';
          const node: ArchNode = {
            id: take(taken.includes(makeId(name, [])) ? `${groupName}_${name}` : name),
            kind: 'service',
            label: name,
            icon: iconForTask(block),
            parent: groupId,
          };
          diagram.nodes.push(node);
          return { id: node.id, block };
        });
        const groupTaskIds = tasks.map((t) => t.id);

        // Group-level services are served by the group's tasks; task-level ones by that task.
        const register = (svc: HclBlock, ids: string[], fallback: string) => {
          provide(serviceName(svc, fallback), ids);
          for (const up of deep(svc, 'upstreams')) {
            const dest = literal(up.attrs.destination_name);
            if (dest) wants.push([ids, dest]);
          }
        };
        for (const svc of child(group, 'service'))
          register(svc, groupTaskIds, `${jobName}-${groupName}`);
        for (const t of tasks) {
          for (const svc of child(t.block, 'service'))
            register(svc, [t.id], `${jobName}-${groupName}-${t.block.labels[0] ?? 'task'}`);
          for (const tpl of child(t.block, 'template')) {
            for (const name of templateServices(tpl.attrs.data ?? '')) wants.push([[t.id], name]);
          }
        }
      }
    }
  }

  const addEdge = edgeAdder(diagram);
  for (const [sources, name] of wants) {
    const targets = providers.get(name) ?? [];
    for (const from of sources) for (const to of targets) addEdge(from, to);
  }
  return diagram;
}
