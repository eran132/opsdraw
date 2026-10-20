import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArchitecture, serializeArchitecture } from '@opsdraw/core';
import * as tools from '../src/tools';

let root: string;
let ctx: tools.ToolContext;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'opsdraw-mcp-'));
  ctx = { root };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const fileText = (p: string) => readFileSync(path.join(root, p), 'utf8');

describe('create / read', () => {
  it('creates nested directories and a valid empty diagram', async () => {
    const r = await tools.createDiagram(ctx, { path: 'docs/arch/system.mmd', title: 'System' });
    expect(r.path).toBe('docs/arch/system.mmd');
    expect(fileText('docs/arch/system.mmd')).toContain('architecture-beta');
    const read = await tools.readDiagram(ctx, { path: 'docs/arch/system.mmd' });
    expect(read.summary.title).toBe('System');
    expect(read.summary.nodes).toEqual([]);
  });

  it('refuses to overwrite unless asked', async () => {
    await tools.createDiagram(ctx, { path: 'a.mmd' });
    await expect(tools.createDiagram(ctx, { path: 'a.mmd' })).rejects.toThrow(/already exists/);
    await expect(
      tools.createDiagram(ctx, { path: 'a.mmd', overwrite: true }),
    ).resolves.toBeTruthy();
  });

  it('reports parse errors with line numbers when reading', async () => {
    writeFileSync(
      path.join(root, 'bad.mmd'),
      'architecture-beta\n  service a[A]\n  nonsense here\n',
    );
    await expect(tools.readDiagram(ctx, { path: 'bad.mmd' })).rejects.toThrow(/line 3/);
  });
});

describe('editing', () => {
  beforeEach(async () => {
    await tools.createDiagram(ctx, { path: 'd.mmd' });
  });

  it('adds groups and services, derives ids, and lays out', async () => {
    const g = await tools.addGroup(ctx, { path: 'd.mmd', label: 'My VPC' });
    expect(g.id).toBe('my_vpc');
    const api = await tools.addService(ctx, {
      path: 'd.mmd',
      label: 'API',
      icon: 'server',
      parent: g.id,
    });
    const db = await tools.addService(ctx, { path: 'd.mmd', label: 'API', icon: 'database' });
    expect(api.id).toBe('api');
    expect(db.id).toBe('api2');
    expect(db.laidOut).toBe(true);

    const { diagram, errors } = parseArchitecture(fileText('d.mmd'));
    expect(errors).toEqual([]);
    expect(diagram.nodes.find((n) => n.id === 'api')?.parent).toBe('my_vpc');
    for (const n of diagram.nodes) expect(diagram.layout[n.id]).toBeDefined();
  });

  it('keeps positions when layout is false', async () => {
    await tools.addService(ctx, { path: 'd.mmd', label: 'A' });
    const before = parseArchitecture(fileText('d.mmd')).diagram.layout.A;
    const r = await tools.addService(ctx, { path: 'd.mmd', label: 'B', layout: false });
    expect(r.laidOut).toBe(false);
    const d = parseArchitecture(fileText('d.mmd')).diagram;
    expect(d.layout.A).toEqual(before);
    expect(d.layout.B).toBeUndefined();
  });

  it('validates parents, ids and icons', async () => {
    await tools.addService(ctx, { path: 'd.mmd', id: 'svc', label: 'Svc' });
    await expect(
      tools.addService(ctx, { path: 'd.mmd', label: 'X', parent: 'nope' }),
    ).rejects.toThrow(/does not exist/);
    await expect(
      tools.addService(ctx, { path: 'd.mmd', label: 'X', parent: 'svc' }),
    ).rejects.toThrow(/not a group/);
    await expect(tools.addService(ctx, { path: 'd.mmd', id: 'svc', label: 'X' })).rejects.toThrow(
      /already used/,
    );
    await expect(tools.addService(ctx, { path: 'd.mmd', id: '1bad', label: 'X' })).rejects.toThrow(
      /Invalid id/,
    );
    await expect(
      tools.addService(ctx, { path: 'd.mmd', label: 'X', icon: 'bad)icon' }),
    ).rejects.toThrow(/Invalid icon/);
  });

  it('rejects unknown icons with suggestions, but accepts vendor prefixes', async () => {
    await expect(
      tools.addService(ctx, { path: 'd.mmd', label: 'X', icon: 'lucide:servr' }),
    ).rejects.toThrow(/Unknown icon "lucide:servr": did you mean lucide:server/);
    await expect(tools.addGroup(ctx, { path: 'd.mmd', label: 'G', icon: 'cpu' })).rejects.toThrow(
      /did you mean .*lucide:cpu/,
    );
    await expect(
      tools.addService(ctx, { path: 'd.mmd', label: 'P', icon: 'postgres' }),
    ).rejects.toThrow(/did you mean database/);
    const ok = await tools.addService(ctx, { path: 'd.mmd', label: 'L', icon: 'aws:lambda' });
    expect(ok.diff).toEqual({ added: ['l'] });
    await tools.addService(ctx, { path: 'd.mmd', label: 'C', icon: 'lucide:container' });
    await expect(
      tools.updateNode(ctx, { path: 'd.mmd', id: 'c', icon: 'lucide:databse' }),
    ).rejects.toThrow(/did you mean lucide:database/);
    expect(parseArchitecture(fileText('d.mmd')).diagram.nodes.map((n) => n.icon)).toEqual([
      'aws:lambda',
      'lucide:container',
    ]);
  });

  it('returns compact diffs from mutating tools', async () => {
    await tools.addService(ctx, { path: 'd.mmd', id: 'a', label: 'A' });
    await tools.addService(ctx, { path: 'd.mmd', id: 'b', label: 'B' });
    expect((await tools.connect(ctx, { path: 'd.mmd', from: 'a', to: 'b' })).diff).toEqual({
      addedEdges: ['a->b'],
    });
    expect((await tools.updateNode(ctx, { path: 'd.mmd', id: 'a', label: 'AA' })).diff).toEqual({
      changed: ['a'],
    });
    expect((await tools.removeNode(ctx, { path: 'd.mmd', id: 'b' })).diff).toEqual({
      removed: ['b'],
      removedEdges: ['a->b'],
    });
  });

  it('connects with arrows, labels and position-based sides, then disconnects', async () => {
    await tools.addService(ctx, { path: 'd.mmd', id: 'web', label: 'Web' });
    await tools.addService(ctx, { path: 'd.mmd', id: 'db', label: 'DB', icon: 'database' });
    await tools.addJunction(ctx, { path: 'd.mmd', id: 'j' });
    const c = await tools.connect(ctx, { path: 'd.mmd', from: 'web', to: 'db', label: 'SQL' });
    expect(c.edge?.arrow).toBe('forward');
    expect(['L', 'R', 'T', 'B']).toContain(c.edge?.fromSide);
    await tools.connect(ctx, {
      path: 'd.mmd',
      from: 'db',
      to: 'j',
      arrow: 'both',
      fromSide: 'T',
      toSide: 'B',
    });

    const text = fileText('d.mmd');
    expect(text).toMatch(/web:[TBLR] -\[SQL\]-> [TBLR]:db/);
    expect(text).toContain('db:T <--> B:j');

    const read = await tools.readDiagram(ctx, { path: 'd.mmd' });
    expect(read.summary.edges).toHaveLength(2);

    const r = await tools.disconnect(ctx, { path: 'd.mmd', from: 'db', to: 'web' });
    expect(r.removed).toBe(1);
    await expect(tools.disconnect(ctx, { path: 'd.mmd', from: 'db', to: 'web' })).rejects.toThrow(
      /No edge/,
    );
    await expect(tools.connect(ctx, { path: 'd.mmd', from: 'web', to: 'ghost' })).rejects.toThrow(
      /No node/,
    );
  });

  it('rejects groups as edge endpoints', async () => {
    await tools.addGroup(ctx, { path: 'd.mmd', id: 'g', label: 'G' });
    await tools.addService(ctx, { path: 'd.mmd', id: 's', label: 'S' });
    await expect(tools.connect(ctx, { path: 'd.mmd', from: 'g', to: 's' })).rejects.toThrow(
      /is a group/,
    );
  });

  it('updates label, icon, parent and renames everywhere', async () => {
    await tools.addGroup(ctx, { path: 'd.mmd', id: 'vpc', label: 'VPC' });
    await tools.addService(ctx, { path: 'd.mmd', id: 'a', label: 'A', parent: 'vpc' });
    await tools.addService(ctx, { path: 'd.mmd', id: 'b', label: 'B' });
    await tools.connect(ctx, { path: 'd.mmd', from: 'a', to: 'b' });

    const r = await tools.updateNode(ctx, {
      path: 'd.mmd',
      id: 'a',
      label: 'Alpha',
      icon: 'lucide:cpu',
      newId: 'alpha',
    });
    expect(r.changed).toEqual(['label', 'icon', 'id']);
    let d = parseArchitecture(fileText('d.mmd')).diagram;
    expect(d.nodes.find((n) => n.id === 'alpha')).toMatchObject({
      label: 'Alpha',
      icon: 'lucide:cpu',
      parent: 'vpc',
    });
    expect(d.edges[0]).toMatchObject({ from: 'alpha', to: 'b' });
    expect(d.layout.alpha).toBeDefined();

    await tools.updateNode(ctx, { path: 'd.mmd', id: 'alpha', parent: null, icon: null });
    d = parseArchitecture(fileText('d.mmd')).diagram;
    const alpha = d.nodes.find((n) => n.id === 'alpha')!;
    expect(alpha.parent).toBeUndefined();
    expect(alpha.icon).toBeUndefined();
    expect(d.layout.alpha).toBeDefined();

    await expect(
      tools.updateNode(ctx, { path: 'd.mmd', id: 'vpc', parent: 'vpc' }),
    ).rejects.toThrow(/itself/);
    await expect(tools.updateNode(ctx, { path: 'd.mmd', id: 'b', newId: 'vpc' })).rejects.toThrow(
      /already used/,
    );
    await expect(tools.updateNode(ctx, { path: 'd.mmd', id: 'b' })).rejects.toThrow(/Nothing/);
  });

  it('removes a group with its children and edges', async () => {
    await tools.addGroup(ctx, { path: 'd.mmd', id: 'vpc', label: 'VPC' });
    await tools.addService(ctx, { path: 'd.mmd', id: 'a', label: 'A', parent: 'vpc' });
    await tools.addService(ctx, { path: 'd.mmd', id: 'b', label: 'B' });
    await tools.connect(ctx, { path: 'd.mmd', from: 'a', to: 'b' });
    const r = await tools.removeNode(ctx, { path: 'd.mmd', id: 'vpc' });
    expect(r.removedNodes.sort()).toEqual(['a', 'vpc']);
    expect(r.removedEdges).toBe(1);
    const d = parseArchitecture(fileText('d.mmd')).diagram;
    expect(d.nodes.map((n) => n.id)).toEqual(['b']);
    expect(fileText('d.mmd')).not.toMatch(/@pos (a|vpc) /);
  });

  it('auto_layout positions every node', async () => {
    await tools.addService(ctx, { path: 'd.mmd', id: 'a', label: 'A', layout: false });
    await tools.addService(ctx, { path: 'd.mmd', id: 'b', label: 'B', layout: false });
    await tools.autoLayoutFile(ctx, { path: 'd.mmd', direction: 'DOWN' });
    const read = await tools.readDiagram(ctx, { path: 'd.mmd' });
    expect(read.summary.unpositioned).toEqual([]);
  });
});

describe('write_diagram / validate', () => {
  it('rejects invalid mermaid without writing', async () => {
    const r = await tools.writeDiagram(ctx, {
      path: 'x.mmd',
      mermaid: 'architecture-beta\n  service a[A]\n  a:R --> L:missing\n',
    });
    expect(r.written).toBe(false);
    expect(r.errors?.[0]).toMatchObject({ line: 3 });
    expect(existsSync(path.join(root, 'x.mmd'))).toBe(false);
  });

  it('converts a flowchart and lays it out', async () => {
    const r = await tools.writeDiagram(ctx, {
      path: 'flow.mmd',
      mermaid: 'flowchart LR\n  subgraph cloud\n    a[Web] --> b[(DB)]\n  end\n',
    });
    expect(r.written).toBe(true);
    expect(r.convertedFromFlowchart).toBe(true);
    expect(r.laidOut).toBe(true);
    const { diagram, errors } = parseArchitecture(fileText('flow.mmd'));
    expect(errors).toEqual([]);
    expect(diagram.nodes.length).toBe(3);
  });

  it('validates text and files', async () => {
    const good = await tools.validate(ctx, {
      mermaid: 'architecture-beta\n  service a(server)[A]\n',
    });
    expect(good).toMatchObject({ valid: true, kind: 'architecture', nodes: 1 });
    const bad = await tools.validate(ctx, { mermaid: 'architecture-beta\n  ???\n' });
    expect(bad.valid).toBe(false);
    expect(bad.errors[0]?.line).toBe(2);
    await tools.createDiagram(ctx, { path: 'v.mmd' });
    expect((await tools.validate(ctx, { path: 'v.mmd' })).valid).toBe(true);
    await expect(tools.validate(ctx, {})).rejects.toThrow(/exactly one/);
  });

  it('returns lint issues alongside parse errors', async () => {
    const r = await tools.validate(ctx, {
      mermaid: [
        'architecture-beta',
        '  service lb(lucide:servr)[LB]',
        '  service a(server)[A]',
        '  service b(server)[B]',
        '  lb:R --> L:a',
        '  lb:R --> L:b',
        '',
      ].join('\n'),
    });
    expect(r.valid).toBe(true);
    const byCode = Object.fromEntries(r.issues.map((i) => [i.code, i]));
    expect(byCode['port-conflict']).toMatchObject({ severity: 'warning', nodeId: 'lb', line: 2 });
    expect(byCode['unknown-icon']?.message).toMatch(/did you mean lucide:server/);
    expect(byCode['github-icons']).toMatchObject({ severity: 'info' });
    const clean = await tools.validate(ctx, {
      mermaid: 'architecture-beta\n  service a(server)[A]\n',
    });
    expect(clean.issues).toEqual([]);
  });
});

describe('import_terraform', () => {
  const TF = `
resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
}
resource "aws_subnet" "private" {
  vpc_id = aws_vpc.main.id
}
resource "aws_instance" "app" {
  subnet_id = aws_subnet.private.id
}
resource "aws_db_instance" "db" {
  db_subnet_group_name = "x"
}
resource "aws_security_group_rule" "allow" {
  description = "\${aws_instance.app.id} \${aws_db_instance.db.id}"
}
`;

  it('imports a directory into a laid-out diagram', async () => {
    mkdirSync(path.join(root, 'infra'));
    writeFileSync(path.join(root, 'infra', 'main.tf'), TF);
    writeFileSync(path.join(root, 'infra', 'notes.txt'), 'ignored');
    const r = await tools.importTerraform(ctx, { source: 'infra', output: 'out/infra.mmd' });
    expect(r.files).toEqual(['infra/main.tf']);
    const { diagram, errors } = parseArchitecture(fileText('out/infra.mmd'));
    expect(errors).toEqual([]);
    expect(diagram.nodes.find((n) => n.id === 'app')?.parent).toBe('private');
    expect(diagram.nodes.find((n) => n.id === 'allow')).toBeUndefined();
    expect(diagram.edges.some((e) => [e.from, e.to].sort().join() === 'app,db')).toBe(true);
    for (const n of diagram.nodes) expect(diagram.layout[n.id]).toBeDefined();

    // Re-importing over an existing file merges instead of failing.
    const again = await tools.importTerraform(ctx, { source: 'infra', output: 'out/infra.mmd' });
    expect(again).toMatchObject({ merged: true, unchanged: true, added: [], removed: [] });
  });

  it('reads subdirectories only when recursive', async () => {
    mkdirSync(path.join(root, 'infra', 'mod'), { recursive: true });
    writeFileSync(path.join(root, 'infra', 'mod', 'main.tf'), TF);
    await expect(tools.importTerraform(ctx, { source: 'infra', output: 'a.mmd' })).rejects.toThrow(
      'No .tf/.tofu files',
    );
    const r = await tools.importTerraform(ctx, {
      source: 'infra',
      output: 'a.mmd',
      recursive: true,
    });
    expect(r.files).toEqual(['infra/mod/main.tf']);
  });

  it('only reads .tf files', async () => {
    writeFileSync(path.join(root, 'main.txt'), TF);
    await expect(
      tools.importTerraform(ctx, { source: 'main.txt', output: 'a.mmd' }),
    ).rejects.toThrow(/extensions/);
  });
});

describe('list_icons', () => {
  it('returns the curated catalog without a query', () => {
    const r = tools.listIcons();
    expect(r.icons.length).toBeGreaterThan(0);
    expect(r.icons.every((i) => i.source !== 'lucide')).toBe(true);
  });

  it('ranks curated keyword matches first and searches lucide', () => {
    const r = tools.listIcons({ query: 'cache' });
    expect(r.icons[0]).toMatchObject({ ref: 'lucide:zap', source: 'curated' });
    const arrows = tools.listIcons({ query: 'arrow', limit: 5 });
    expect(arrows.icons).toHaveLength(5);
    expect(arrows.icons.every((i) => i.ref.startsWith('lucide:'))).toBe(true);
    expect(arrows.total).toBeGreaterThan(5);
    expect(tools.listIcons({ query: 'database' }).icons[0]?.ref).toBe('database');
  });

  it('gives curated icons a display title and matches it', () => {
    const r = tools.listIcons({ query: 'firewall' });
    expect(r.icons[0]).toMatchObject({ ref: 'lucide:brick-wall', title: 'Firewall' });
    const lb = tools.listIcons({ query: 'load balancer' });
    expect(lb.icons[0]).toMatchObject({ ref: 'lucide:split', title: 'Load balancer' });
    expect(tools.listIcons().icons.every((i) => i.source !== 'curated' || !!i.title)).toBe(true);
  });
});

describe('path safety', () => {
  it('rejects paths escaping the root', async () => {
    await expect(tools.createDiagram(ctx, { path: '../evil.mmd' })).rejects.toThrow(/outside/);
    await expect(tools.createDiagram(ctx, { path: 'a/../../evil.mmd' })).rejects.toThrow(/outside/);
    const elsewhere = path.join(os.tmpdir(), 'opsdraw-elsewhere.mmd');
    await expect(tools.createDiagram(ctx, { path: elsewhere })).rejects.toThrow(/outside/);
    await expect(tools.readDiagram(ctx, { path: '../../etc/passwd.mmd' })).rejects.toThrow(
      /outside/,
    );
    await expect(tools.importTerraform(ctx, { source: '..', output: 'a.mmd' })).rejects.toThrow(
      /outside/,
    );
    expect(existsSync(elsewhere)).toBe(false);
  });

  it('allows absolute paths inside the root', async () => {
    const r = await tools.createDiagram(ctx, { path: path.join(root, 'abs.mmd') });
    expect(r.path).toBe('abs.mmd');
  });

  it('only allows diagram extensions', async () => {
    await expect(tools.createDiagram(ctx, { path: 'notes.txt' })).rejects.toThrow(/extensions/);
    await expect(
      tools.writeDiagram(ctx, { path: 'x.js', mermaid: 'architecture-beta\n' }),
    ).rejects.toThrow(/extensions/);
    await expect(tools.createDiagram(ctx, { path: 'ok.mermaid' })).resolves.toBeTruthy();
  });
});

describe('import_iac', () => {
  const write = (p: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    writeFileSync(path.join(root, p), text);
  };

  it('detects and merges Kubernetes, Compose and Proxmox Terraform from one directory', async () => {
    write(
      'infra/k8s.yaml',
      `apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  selector: { matchLabels: { app: api } }
  template: { metadata: { labels: { app: api } }, spec: { containers: [{ name: api, image: api:1 }] } }
---
apiVersion: v1
kind: Service
metadata: { name: api-svc }
spec: { selector: { app: api }, ports: [{ port: 80 }] }
`,
    );
    write('infra/docker-compose.yml', 'services:\n  db:\n    image: postgres:16\n');
    write(
      'infra/pve.tf',
      'resource "proxmox_vm_qemu" "runner" {\n  target_node = "pve1"\n  network { bridge = "vmbr0" }\n}\n',
    );
    write('infra/notes.json', '{"hello": "world"}');

    const r = await tools.importIacFiles(ctx, { source: 'infra', output: 'out/all.mmd' });
    expect(r.kinds.sort()).toEqual(['compose', 'kubernetes', 'terraform']);
    expect(r.skipped).toEqual(['infra/notes.json']);
    const parsed = parseArchitecture(fileText('out/all.mmd'));
    expect(parsed.errors).toEqual([]);
    const ids = parsed.diagram.nodes.map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining(['tf_runner', 'compose_db']));
    expect(ids.some((id) => id.startsWith('k8s_'))).toBe(true);
    expect(parsed.diagram.edges.length).toBeGreaterThan(0);
    // Everything got a position from the automatic layout.
    for (const id of ids) expect(parsed.diagram.layout[id]).toBeDefined();
  });

  it('reads extension-less Ansible inventories and Nomad jobs', async () => {
    write('ops/hosts', '[db]\ndb01 ansible_host=10.0.0.5\n\n[web]\nweb[1:2]\n');
    write(
      'ops/shop.nomad',
      'job "shop" {\n  group "api" {\n    task "server" {\n      driver = "docker"\n      config { image = "nginx" }\n    }\n  }\n}\n',
    );
    write('ops/ignored.cfg', 'x');
    const r = await tools.importIacFiles(ctx, { source: 'ops', output: 'ops.mmd' });
    expect(r.kinds.sort()).toEqual(['ansible', 'nomad']);
    expect(r.files.sort()).toEqual(['ops/hosts', 'ops/shop.nomad']);
    expect(parseArchitecture(fileText('ops.mmd')).errors).toEqual([]);
  });

  it('merges into an existing diagram, keeping hand-made positions', async () => {
    write('net/compose.yml', 'services:\n  web:\n    image: nginx\n  db:\n    image: postgres\n');
    await tools.importIacFiles(ctx, { source: 'net', output: 'net.mmd' });
    const first = parseArchitecture(fileText('net.mmd')).diagram;
    const moved = { ...first, layout: { ...first.layout, web: { x: 900, y: 700 } } };
    writeFileSync(path.join(root, 'net.mmd'), serializeArchitecture(moved));

    write(
      'net/compose.yml',
      'services:\n  web:\n    image: nginx\n  db:\n    image: postgres\n  cache:\n    image: redis\n',
    );
    const r = await tools.importIacFiles(ctx, { source: 'net', output: 'net.mmd' });
    expect(r).toMatchObject({ merged: true, added: ['cache'], removed: [], changed: [] });
    const after = parseArchitecture(fileText('net.mmd')).diagram;
    expect(after.layout.web).toEqual({ x: 900, y: 700 });
    expect(after.layout.db).toEqual(first.layout.db);
    expect(after.layout.cache).toBeDefined();

    const replaced = await tools.importIacFiles(ctx, {
      source: 'net',
      output: 'net.mmd',
      overwrite: true,
    });
    expect(replaced.merged).toBe(false);
    expect(parseArchitecture(fileText('net.mmd')).diagram.layout.web).not.toEqual({
      x: 900,
      y: 700,
    });
  });

  it('fails clearly when nothing is recognized, and respects the root', async () => {
    write('misc/a.json', '{"a": 1}');
    await expect(tools.importIacFiles(ctx, { source: 'misc', output: 'x.mmd' })).rejects.toThrow(
      /looked like Terraform/,
    );
    await expect(tools.importIacFiles(ctx, { source: '..', output: 'x.mmd' })).rejects.toThrow(
      /outside/,
    );
    expect(existsSync(path.join(root, 'x.mmd'))).toBe(false);
  });
});
