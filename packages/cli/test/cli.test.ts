import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseArchitecture, serializeArchitecture } from '@opsdraw/core';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(pkgDir, '../..');
const entry = path.join(pkgDir, 'dist', 'index.js');

let dir: string;

const TF = `resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
}
resource "aws_subnet" "app" {
  vpc_id = aws_vpc.main.id
}
resource "aws_instance" "web" {
  subnet_id = aws_subnet.app.id
}
`;

const K8S = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  selector:
    matchLabels: { app: api }
  template:
    metadata:
      labels: { app: api }
    spec:
      containers:
        - name: api
          image: nginx
---
apiVersion: v1
kind: Service
metadata:
  name: api
spec:
  selector: { app: api }
  ports: [{ port: 80 }]
`;

function cli(...args: string[]) {
  const r = spawnSync(process.execPath, [entry, ...args], { cwd: dir, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const read = (p: string) => readFileSync(path.join(dir, p), 'utf8');
const write = (p: string, text: string) => {
  mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
  writeFileSync(path.join(dir, p), text);
};

beforeAll(() => {
  if (!existsSync(entry)) execSync('npm run build -w opsdraw', { cwd: repoRoot, stdio: 'inherit' });
  dir = mkdtempSync(path.join(os.tmpdir(), 'opsdraw-cli-'));
  write('infra/main.tf', TF);
  write('infra/k8s/app.yaml', K8S);
  write('infra/node_modules/ignored.tf', 'resource "aws_instance" "nope" {}\n');
  write('infra/.hidden/ignored.tf', 'resource "aws_instance" "nope2" {}\n');
}, 120_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('opsdraw --help / --version', () => {
  it('prints help and the package version', () => {
    const help = cli('--help');
    expect(help.code).toBe(0);
    expect(help.stdout).toMatch(/opsdraw import <path\.\.\.> -o <out\.mmd>/);
    expect(help.stdout).toMatch(/PNG is not supported/);
    const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(cli('--version').stdout.trim()).toBe(pkg.version);
  });

  it('exits 2 on usage errors', () => {
    expect(cli('frobnicate').code).toBe(2);
    expect(cli('import', 'infra').code).toBe(2);
    expect(cli('import', 'infra', '-o', 'x.txt').code).toBe(2);
    expect(cli('import', 'nowhere', '-o', 'x.mmd').code).toBe(2);
    expect(cli('import', 'infra', '-o', 'x.mmd', '--bogus').code).toBe(2);
  });
});

describe('opsdraw import', () => {
  it('writes a valid diagram from Terraform and Kubernetes files', () => {
    const r = cli('import', 'infra', '--recursive', '-o', 'docs/arch.mmd', '--title', 'Demo');
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Imported terraform, kubernetes from 2 file\(s\)/);
    const { diagram, errors } = parseArchitecture(read('docs/arch.mmd'));
    expect(errors).toEqual([]);
    expect(diagram.title).toBe('Demo');
    const ids = diagram.nodes.map((n) => n.id);
    expect(ids).toContain('tf_web');
    expect(ids.some((id) => id.startsWith('k8s_'))).toBe(true);
    expect(ids.join(' ')).not.toMatch(/nope/);
    for (const n of diagram.nodes) expect(diagram.layout[n.id]).toBeDefined();
  });

  it('applies the OpenTofu rule: foo.tofu replaces foo.tf, and reports it', () => {
    write('tofu/main.tf', 'resource "aws_instance" "terraform_only" {}\n');
    write('tofu/main.tofu', 'resource "aws_instance" "tofu_only" {}\n');
    write('tofu/db.tf', 'resource "aws_db_instance" "db" {}\n');
    const r = cli('import', 'tofu', '-o', 'tofu.mmd');
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Ignored tofu[/\\]main\.tf \(a \.tofu file/);
    const ids = parseArchitecture(read('tofu.mmd')).diagram.nodes.map((n) => n.id);
    expect(ids.sort()).toEqual(['db', 'tofu_only']);
  });

  it('prints importer warnings on stderr', () => {
    write('mods/main.tf', 'module "net" { source = "./modules/missing" }\n');
    const r = cli('import', 'mods', '-o', 'mods.mmd');
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain('warning: module "net": source not found among files');
  });

  it('keeps a hand-moved node where it was on re-import', () => {
    const before = parseArchitecture(read('docs/arch.mmd')).diagram;
    before.layout.tf_web = { x: 777, y: 555 };
    write('docs/arch.mmd', serializeArchitecture(before));
    const r = cli('import', 'infra', '-r', '-o', 'docs/arch.mmd');
    expect(r.code, r.stderr).toBe(0);
    const after = parseArchitecture(read('docs/arch.mmd')).diagram;
    expect(after.layout.tf_web).toEqual({ x: 777, y: 555 });
    expect(after.title).toBe('Demo');
  });

  it('is deterministic: two fresh imports and a re-import are byte-identical', () => {
    expect(cli('import', 'infra', '-r', '-o', 'det/a.mmd').code).toBe(0);
    expect(cli('import', 'infra', '-r', '-o', 'det/b.mmd').code).toBe(0);
    expect(read('det/a.mmd')).toBe(read('det/b.mmd'));
    const first = read('det/a.mmd');
    const again = cli('import', 'infra', '-r', '-o', 'det/a.mmd');
    expect(again.stdout).toMatch(/already up to date/);
    expect(read('det/a.mmd')).toBe(first);
  });

  it('lays out new nodes and keeps existing positions when the source grows', () => {
    expect(cli('import', 'infra', '-r', '-o', 'grow.mmd').code).toBe(0);
    const before = parseArchitecture(read('grow.mmd')).diagram;
    write('infra/main.tf', `${TF}resource "aws_s3_bucket" "logs" {\n  bucket = "logs"\n}\n`);
    try {
      const r = cli('import', 'infra', '-r', '-o', 'grow.mmd');
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/\+ service tf_logs/);
      const after = parseArchitecture(read('grow.mmd')).diagram;
      for (const id of Object.keys(before.layout))
        expect(after.layout[id], id).toEqual(before.layout[id]);
      expect(after.layout.tf_logs).toBeDefined();
    } finally {
      write('infra/main.tf', TF);
    }
  });
});

describe('opsdraw import --check', () => {
  it('exits 0 when the diagram is up to date, ignoring layout', () => {
    expect(cli('import', 'infra', '-r', '-o', 'check.mmd').code).toBe(0);
    const d = parseArchitecture(read('check.mmd')).diagram;
    d.layout = {};
    write('check.mmd', serializeArchitecture(d));
    const r = cli('import', 'infra', '-r', '-o', 'check.mmd', '--check');
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/up to date/);
  });

  it('exits 1 with a readable diff when the source drifted, without writing', () => {
    const before = read('check.mmd');
    write('infra/main.tf', `${TF}resource "aws_s3_bucket" "logs" {\n  bucket = "logs"\n}\n`);
    try {
      const r = cli('import', 'infra', '-r', '-o', 'check.mmd', '--check');
      expect(r.code).toBe(1);
      expect(r.stdout).toMatch(/out of date: 1 added/);
      expect(r.stdout).toMatch(/\+ service tf_logs \[logs\]/);
      expect(r.stdout).toMatch(/To fix: run `opsdraw import infra --recursive -o check.mmd`/);
      expect(read('check.mmd')).toBe(before);
    } finally {
      write('infra/main.tf', TF);
    }
  });

  it('exits 2 when the diagram does not exist', () => {
    const r = cli('import', 'infra', '-r', '-o', 'missing.mmd', '--check');
    expect(r.code).toBe(2);
    expect(existsSync(path.join(dir, 'missing.mmd'))).toBe(false);
  });
});

describe('opsdraw export', () => {
  it('writes a well-formed SVG with labels, icons and vendor placeholders', () => {
    write(
      'exp.mmd',
      `architecture-beta
  group vpc(cloud)[My VPC]
  service web(server)[Web & API] in vpc
  service q(lucide:mail)[Queue]
  service ec2(aws:ec2)[Instance]
  web:R --> L:q
  %% @pos vpc 0 0 200 200
  %% @pos web 24 40
`,
    );
    const r = cli('export', 'exp.mmd', '-o', 'out/exp.svg', '--theme', 'dark');
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/placeholders: aws:ec2/);
    expect(r.stderr.match(/Note:/g)).toHaveLength(1);
    const svg = read('out/exp.svg');
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    expect(svg).toContain('Web &amp; API');
    expect(svg).toContain('My VPC');
    expect(svg).toContain('Queue');
    expect(svg).toContain('stroke-dasharray'); // placeholder for aws:ec2
    // Every opening tag is closed (cheap well-formedness check without an XML parser).
    const body = svg
      .replace(/<metadata[\s\S]*?<\/metadata>/, '')
      .replace(/<style>[\s\S]*?<\/style>/, '');
    const opens = (body.match(/<[a-zA-Z][\w-]*(\s[^>]*)?(?<!\/)>/g) ?? []).length;
    const closes = (body.match(/<\/[a-zA-Z]+>/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it('adds a legend with --legend and draws %% @style colors', () => {
    write(
      'legend.mmd',
      `architecture-beta
  group vpc(cloud)[My VPC]
  service web(server)[Web] in vpc
  service db(database)[Orders]
  web:R --> L:db
  %% @pos vpc 0 0 200 200
  %% @pos web 24 40
  %% @pos db 300 40
  %% @style vpc fill=teal stroke=teal
`,
    );
    expect(cli('export', 'legend.mmd', '-o', 'plain.svg').code).toBe(0);
    const plain = read('plain.svg');
    expect(plain).not.toContain('class="legend"');
    expect(plain).toContain('stroke:#0d9488');
    const r = cli('export', 'legend.mmd', '-o', 'legend.svg', '--legend');
    expect(r.code, r.stderr).toBe(0);
    const svg = read('legend.svg');
    expect(svg).toContain('class="legend"');
    expect(svg).toContain('>Legend</text>');
    expect(svg).toContain('>Orders</text>');
    expect(svg).toMatch(/style="fill:#0f766e">My VPC<\/text>|>My VPC<\/text>/);
  });

  it('refuses PNG and missing files', () => {
    const png = cli('export', 'exp.mmd', '-o', 'x.png');
    expect(png.code).toBe(2);
    expect(png.stderr).toMatch(/PNG export is not supported/);
    expect(cli('export', 'none.mmd', '-o', 'x.svg').code).toBe(2);
  });
});

describe('opsdraw validate', () => {
  it('reports file:line: message and exits 1 on errors', () => {
    write(
      'bad.mmd',
      'architecture-beta\n  service a(server)[A]\n  a:R --> L:zz\n  nonsense here\n',
    );
    const r = cli('validate', 'bad.mmd', 'exp.mmd');
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^bad\.mmd:3: .*zz/m);
    expect(r.stderr).toMatch(/^bad\.mmd:4: /m);
    expect(r.stdout).toMatch(/exp\.mmd: ok/);
  });

  it('exits 0 for valid files and 2 for missing ones', () => {
    expect(cli('validate', 'exp.mmd').code).toBe(0);
    expect(cli('validate', 'gone.mmd').code).toBe(2);
  });

  it('prints lint issues, and fails on warnings only with --strict', () => {
    write(
      'lint.mmd',
      [
        'architecture-beta',
        '  service lb(lucide:servr)[LB]',
        '  service a(server)[A]',
        '  service b(server)[B]',
        '  lb:R --> L:a',
        '  lb:R --> L:b',
        '',
      ].join('\n'),
    );
    const r = cli('validate', 'lint.mmd');
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/lint\.mmd: ok/);
    expect(r.stderr).toMatch(/^lint\.mmd:2: warning \[port-conflict\] /m);
    expect(r.stderr).toMatch(
      /^lint\.mmd:2: warning \[unknown-icon\] .*did you mean lucide:server/m,
    );
    expect(r.stderr).toMatch(/^lint\.mmd: info \[github-icons\] .*opsdraw export/m);
    expect(cli('validate', '--strict', 'lint.mmd').code).toBe(1);

    write('info.mmd', 'architecture-beta\n  group g(cloud)[G]\n  service a(lucide:cpu)[A]\n');
    const info = cli('validate', '--strict', 'info.mmd');
    expect(info.code).toBe(0);
    expect(info.stderr).toMatch(/info \[empty-group\]/);
  });
});
