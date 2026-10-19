import type { ArchNode, Diagram } from './model';
import { emptyDiagram, makeId } from './model';
import type { IacFile, IacImportOptions } from './iac-shared';
import { asString, isRecord, loadYamlDocuments } from './iac-shared';

/**
 * Best-effort Ansible inventory -> architecture diagram.
 *
 * Reads INI and YAML inventories. Groups become (nested) groups and hosts become services. A host
 * listed in several groups is drawn once, in its most specific (deepest) group, the first one it
 * appeared in on ties. `all` and `ungrouped` are not drawn. Inventories describe no connections, so
 * the diagram has no edges.
 */

export type AnsibleImportOptions = IacImportOptions;

/** Hosts expanded from one range pattern are capped so `web[1:100000]` cannot blow up. */
const MAX_RANGE_HOSTS = 200;
const IMPLICIT = new Set(['all', 'ungrouped']);

interface Inventory {
  /** Group name -> child group names, in order of appearance. */
  children: Map<string, string[]>;
  /** Group name -> host names, in order of appearance. */
  hosts: Map<string, string[]>;
  /** Host name -> ansible_host, when set. */
  address: Map<string, string>;
  /** Every host, in order of first appearance. */
  hostOrder: string[];
  /** Every group, in order of first appearance. */
  groupOrder: string[];
  /** Order in which (group, host) memberships were declared, for tie-breaking. */
  membership: Map<string, number>;
}

const newInventory = (): Inventory => ({
  children: new Map(),
  hosts: new Map(),
  address: new Map(),
  hostOrder: [],
  groupOrder: [],
  membership: new Map(),
});

function touchGroup(inv: Inventory, group: string) {
  if (!inv.children.has(group)) {
    inv.children.set(group, []);
    inv.hosts.set(group, []);
    inv.groupOrder.push(group);
  }
}

function addChild(inv: Inventory, parent: string, child: string) {
  touchGroup(inv, parent);
  touchGroup(inv, child);
  const list = inv.children.get(parent)!;
  if (!list.includes(child) && parent !== child) list.push(child);
}

function addHost(inv: Inventory, group: string, host: string, address?: string) {
  touchGroup(inv, group);
  if (!inv.hostOrder.includes(host)) inv.hostOrder.push(host);
  const list = inv.hosts.get(group)!;
  if (!list.includes(host)) {
    list.push(host);
    inv.membership.set(`${group}\u0000${host}`, inv.membership.size);
  }
  if (address && !inv.address.has(host)) inv.address.set(host, address);
}

/** Expands Ansible host ranges: `web[01:03].x`, `db-[a:c]`, `n[0:10:2]`. */
export function expandHostPattern(pattern: string, limit = MAX_RANGE_HOSTS): string[] {
  const m = /\[([^\]:]+):([^\]:]+)(?::(\d+))?\]/.exec(pattern);
  if (!m) return [pattern];
  const [whole, startText, endText, stepText] = m;
  const head = pattern.slice(0, m.index);
  const tail = pattern.slice(m.index + whole!.length);
  const step = Math.max(1, Number(stepText ?? 1));
  const values: string[] = [];
  if (/^\d+$/.test(startText!) && /^\d+$/.test(endText!)) {
    const width = startText!.startsWith('0') ? startText!.length : 0;
    const start = Number(startText);
    const end = Number(endText);
    for (let i = start; i <= end && values.length < limit; i += step)
      values.push(String(i).padStart(width, '0'));
  } else if (/^[a-z]$/i.test(startText!) && /^[a-z]$/i.test(endText!)) {
    const start = startText!.charCodeAt(0);
    const end = endText!.charCodeAt(0);
    for (let c = start; c <= end && values.length < limit; c += step)
      values.push(String.fromCharCode(c));
  } else {
    return [pattern];
  }
  const out: string[] = [];
  for (const v of values) {
    for (const h of expandHostPattern(head + v + tail, limit)) {
      if (out.length >= limit) return out;
      out.push(h);
    }
  }
  return out;
}

/** Splits `key=value key2="quoted value"` host variables. */
function parseHostVars(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const re = /([\w.-]+)=("(?:[^"\\]|\\.)*"|'[^']*'|\S+)/g;
  for (const m of text.matchAll(re)) {
    let v = m[2]!;
    if (/^["'].*["']$/.test(v)) v = v.slice(1, -1);
    vars[m[1]!] = v;
  }
  return vars;
}

function readIni(content: string, inv: Inventory) {
  let group = 'ungrouped';
  let mode: 'hosts' | 'children' | 'vars' = 'hosts';
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      const [name, suffix] = header[1]!.trim().split(':');
      group = name!.trim();
      mode = suffix === 'children' ? 'children' : suffix === 'vars' ? 'vars' : 'hosts';
      if (mode !== 'vars') touchGroup(inv, group);
      continue;
    }
    if (mode === 'vars') continue;
    const text = line.replace(/\s[#;].*$/, '');
    const first = text.split(/\s+/)[0]!;
    if (mode === 'children') {
      addChild(inv, group, first);
      continue;
    }
    const vars = parseHostVars(text.slice(first.length));
    const pattern = first.replace(/:\d+$/, ''); // `host:2222` sets a port
    for (const host of expandHostPattern(pattern)) addHost(inv, group, host, vars.ansible_host);
  }
}

function readYamlGroup(inv: Inventory, name: string, body: unknown, depth: number) {
  touchGroup(inv, name);
  if (!isRecord(body) || depth > 50) return;
  if (isRecord(body.hosts)) {
    for (const [pattern, vars] of Object.entries(body.hosts)) {
      const address = isRecord(vars) ? asString(vars.ansible_host) : undefined;
      for (const host of expandHostPattern(pattern)) addHost(inv, name, host, address);
    }
  }
  if (isRecord(body.children)) {
    for (const [child, childBody] of Object.entries(body.children)) {
      addChild(inv, name, child);
      readYamlGroup(inv, child, childBody, depth + 1);
    }
  }
}

function readYaml(content: string, inv: Inventory): boolean {
  let found = false;
  for (const doc of loadYamlDocuments(content)) {
    if (!isRecord(doc)) continue;
    for (const [name, body] of Object.entries(doc)) {
      if (!isRecord(body) && body !== null) continue;
      found = true;
      readYamlGroup(inv, name, body, 0);
    }
  }
  return found;
}

/** YAML inventories start with `group:` (or `---`); INI ones with a host or a `[section]`. */
function looksLikeYamlInventory(content: string): boolean {
  const first = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'));
  return !!first && (first === '---' || /^[\w.-]+\s*:(\s|$)/.test(first));
}

/** Rules for the icon of a group or host name; the first that matches a word wins. */
const ICON_RULES: [string[], string][] = [
  [
    [
      'db',
      'database',
      'postgres',
      'postgresql',
      'pg',
      'mysql',
      'mariadb',
      'mongo',
      'mongodb',
      'sql',
      'mssql',
    ],
    'database',
  ],
  [['redis', 'cache', 'memcache', 'memcached', 'valkey'], 'lucide:zap'],
  [['lb', 'haproxy', 'nginx', 'proxy', 'traefik', 'balancer', 'loadbalancer'], 'lucide:split'],
  [['k8s', 'kube', 'kubernetes', 'master', 'control', 'controlplane'], 'lucide:boxes'],
  [['worker', 'node'], 'server'],
  [['monitor', 'monitoring', 'prometheus', 'grafana'], 'lucide:activity'],
  [['mq', 'rabbit', 'rabbitmq', 'kafka'], 'lucide:radio-tower'],
];
const WORD_SUFFIXES = [
  '',
  's',
  'es',
  'server',
  'servers',
  'host',
  'hosts',
  'node',
  'nodes',
  'cluster',
];

/**
 * Words of a name: split on non-alphanumerics and camelCase, plus each word split again at
 * letter/digit boundaries (so `db01` yields `db` while `k8s` stays a word too).
 */
function wordsOf(name: string): string[] {
  const words = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const parts = words.flatMap((w) => w.split(/(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])/));
  return [...new Set([...words, ...parts])];
}

/** Icon for an inventory group or host name, or undefined when nothing matches. */
export function iconForInventoryName(name: string): string | undefined {
  const words = wordsOf(name);
  for (const [keys, icon] of ICON_RULES) {
    for (const w of words) {
      if (keys.some((k) => WORD_SUFFIXES.some((s) => w === k + s))) return icon;
    }
  }
  return undefined;
}

export function parseAnsibleInventory(
  files: IacFile[],
  _options: AnsibleImportOptions = {},
): Diagram {
  const inv = newInventory();
  for (const f of files) {
    const yamlish =
      /\.ya?ml$/i.test(f.path) || (!/\.ini$/i.test(f.path) && looksLikeYamlInventory(f.content));
    if (!(yamlish && readYaml(f.content, inv))) readIni(f.content, inv);
  }

  // Each drawn group gets one parent: the first group (by appearance) that lists it as a child.
  const parentOf = new Map<string, string>();
  for (const g of inv.groupOrder) {
    for (const child of inv.children.get(g) ?? []) {
      if (IMPLICIT.has(child) || parentOf.has(child)) continue;
      if (!IMPLICIT.has(g) && !createsCycle(parentOf, g, child)) parentOf.set(child, g);
    }
  }
  const depth = (g: string): number => {
    let d = 0;
    for (let p = parentOf.get(g); p && d < 100; p = parentOf.get(p)) d++;
    return d + 1;
  };

  // Home group of each host: deepest group listing it, first declared membership on ties.
  const home = new Map<string, string>();
  for (const host of inv.hostOrder) {
    let best: string | undefined;
    let bestDepth = -1;
    let bestOrder = Infinity;
    for (const g of inv.groupOrder) {
      if (IMPLICIT.has(g) || !inv.hosts.get(g)!.includes(host)) continue;
      const d = depth(g);
      const order = inv.membership.get(`${g}\u0000${host}`)!;
      if (d > bestDepth || (d === bestDepth && order < bestOrder)) {
        best = g;
        bestDepth = d;
        bestOrder = order;
      }
    }
    if (best) home.set(host, best);
  }

  // Only groups that end up containing a host (directly or below) are drawn.
  const used = new Set<string>();
  for (const g of home.values()) {
    for (let p: string | undefined = g; p && !used.has(p); p = parentOf.get(p)) used.add(p);
  }

  const diagram = emptyDiagram();
  const taken: string[] = [];
  const take = (base: string) => {
    const id = makeId(base, taken);
    taken.push(id);
    return id;
  };
  const groupIds = new Map<string, string>();
  for (const g of inv.groupOrder) if (used.has(g)) groupIds.set(g, take(g));
  for (const g of inv.groupOrder) {
    if (!used.has(g)) continue;
    const node: ArchNode = {
      id: groupIds.get(g)!,
      kind: 'group',
      label: g,
      icon: iconForInventoryName(g) ?? 'server',
    };
    const parent = parentOf.get(g);
    if (parent) node.parent = groupIds.get(parent);
    diagram.nodes.push(node);
  }

  for (const host of inv.hostOrder) {
    const address = inv.address.get(host);
    const group = home.get(host);
    let icon = iconForInventoryName(host);
    for (let g = group; !icon && g; g = parentOf.get(g)) icon = iconForInventoryName(g);
    const node: ArchNode = {
      id: take(host),
      kind: 'service',
      label: address && address !== host ? `${host} (${address})` : host,
      icon: icon ?? 'server',
    };
    if (group) node.parent = groupIds.get(group);
    diagram.nodes.push(node);
  }
  return diagram;
}

function createsCycle(parentOf: Map<string, string>, parent: string, child: string): boolean {
  for (let p: string | undefined = parent, i = 0; p && i < 1000; p = parentOf.get(p), i++) {
    if (p === child) return true;
  }
  return false;
}
