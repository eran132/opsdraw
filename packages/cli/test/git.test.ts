import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseArchitecture } from '@opsdraw/core';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(pkgDir, '../..');
const entry = path.join(pkgDir, 'dist', 'index.js');

let dir: string;

const BASE = `architecture-beta
  group vpc(cloud)[VPC]
  service x(server)[X] in vpc
  service z(database)[Z] in vpc

  x:R -[reads]-> L:z
  %% @pos vpc 0 0 500 300
  %% @pos x 20 40
  %% @pos z 300 40
`;

function cli(cwd: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [entry, ...args], { cwd, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

const at = (...p: string[]) => path.join(dir, ...p);
const write = (p: string, text: string) => {
  mkdirSync(path.dirname(at(p)), { recursive: true });
  writeFileSync(at(p), text);
};
const read = (p: string) => readFileSync(at(p), 'utf8');
const parse = (text: string) => {
  const { diagram, errors } = parseArchitecture(text);
  expect(errors).toEqual([]);
  return diagram;
};

function newRepo(name: string): string {
  const repo = at(name);
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'OpsDraw Test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.autocrlf', 'false');
  return repo;
}

beforeAll(() => {
  // Run `npm run build -w opsdraw` first after changing the CLI; a stale bundle is not rebuilt
  // here because cli.test.ts spawns the same bundle concurrently.
  if (!existsSync(entry)) execSync('npm run build -w opsdraw', { cwd: repoRoot, stdio: 'inherit' });
  dir = mkdtempSync(path.join(os.tmpdir(), 'opsdraw-git-'));
}, 120_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('opsdraw merge-driver', () => {
  it('writes a clean merge into <ours> and exits 0', () => {
    write('clean/base.mmd', BASE);
    write('clean/ours.mmd', BASE.replace('@pos x 20 40', '@pos x 60 90'));
    write(
      'clean/theirs.mmd',
      BASE.replace('  service z', '  service y(disk)[Y] in vpc\n  service z'),
    );
    const r = cli(at('clean'), 'merge-driver', 'base.mmd', 'ours.mmd', 'theirs.mmd', 'arch.mmd');
    expect(r.code, r.stderr).toBe(0);
    const d = parse(read('clean/ours.mmd'));
    expect(d.layout.x).toEqual({ x: 60, y: 90 });
    expect(d.nodes.map((n) => n.id).sort()).toEqual(['vpc', 'x', 'y', 'z']);
    expect(read('clean/ours.mmd')).not.toContain('CONFLICT');
  });

  it('exits 1 with %% CONFLICT lines and a still-parseable file on conflicts', () => {
    write('conf/base.mmd', BASE);
    write('conf/ours.mmd', BASE.replace('[X]', '[Ours X]'));
    write(
      'conf/theirs.mmd',
      BASE.replace('[X]', '[Theirs X]').replace('@pos z 300 40', '@pos z 1 1'),
    );
    const r = cli(
      at('conf'),
      'merge-driver',
      'base.mmd',
      'ours.mmd',
      'theirs.mmd',
      'docs/arch.mmd',
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('docs/arch.mmd: 1 conflict(s)');
    const text = read('conf/ours.mmd');
    expect(text).toContain(
      '  %% CONFLICT: Node "x" label changed on both sides: ours "Ours X", theirs "Theirs X" (base "X"); kept ours',
    );
    const d = parse(text);
    expect(d.nodes.find((n) => n.id === 'x')!.label).toBe('Ours X');
    expect(d.layout.z).toEqual({ x: 1, y: 1 });
  });

  it('falls back to a line-based merge when a version does not parse', () => {
    write('bad/base.mmd', BASE);
    write('bad/ours.mmd', BASE.replace('[X]', '[Ours X]'));
    write('bad/theirs.mmd', BASE.replace('x:R -[reads]-> L:z', 'x ==> z'));
    const r = cli(at('bad'), 'merge-driver', 'base.mmd', 'ours.mmd', 'theirs.mmd');
    expect(r.stderr).toMatch(/theirs does not parse/);
    expect(r.code).toBe(0);
    const text = read('bad/ours.mmd');
    expect(text).toContain('[Ours X]');
    expect(text).toContain('x ==> z');
  });

  it('exits 2 on usage errors', () => {
    expect(cli(dir, 'merge-driver', 'a.mmd').code).toBe(2);
    expect(cli(dir, 'merge-driver', 'missing1', 'missing2', 'missing3').code).toBe(2);
  });
});

describe('opsdraw diff', () => {
  it('prints added, removed and changed nodes and edges, and moved counts', () => {
    write('diff/old.mmd', BASE);
    write(
      'diff/new.mmd',
      BASE.replace('[X]', '[X2]')
        .replace('  service z', '  service y(disk)[Y]\n  service z')
        .replace('  x:R -[reads]-> L:z\n', '  x:R -[reads]-> L:z\n  y:T --> B:z\n')
        .replace('@pos z 300 40', '@pos z 310 50'),
    );
    const r = cli(at('diff'), 'diff', 'old.mmd', 'new.mmd');
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe(
      [
        'old.mmd -> new.mmd',
        '1 added, 0 removed, 1 changed nodes; 1 added, 0 removed, 0 changed edges',
        '  + service y [Y]',
        '  ~ x (label: "X" -> "X2")',
        '  + edge y->z',
        'Layout: 1 moved, 0 resized nodes',
        '',
      ].join('\n'),
    );
    const same = cli(at('diff'), 'diff', 'old.mmd', 'old.mmd');
    expect(same.code).toBe(0);
    expect(same.stdout).toContain('No structural changes');
  });

  it('exits 2 on usage errors and 1 on a broken diagram', () => {
    expect(cli(at('diff'), 'diff', 'old.mmd').code).toBe(2);
    expect(cli(at('diff'), 'diff', 'old.mmd', 'nope.mmd').code).toBe(2);
    write('diff/broken.mmd', 'architecture-beta\n  what is this\n');
    expect(cli(at('diff'), 'diff', 'old.mmd', 'broken.mmd').code).toBe(1);
  });
});

describe('opsdraw git-setup', () => {
  it('prints the setup commands, with a local driver when run from a checkout', () => {
    const r = cli(dir, 'git-setup');
    expect(r.code, r.stderr).toBe(0);
    const local = entry.replace(/\\/g, '/');
    expect(r.stdout).toContain(`git config merge.opsdraw.name 'OpsDraw diagram merge'`);
    expect(r.stdout).toContain(
      `git config merge.opsdraw.driver 'node "${local}" merge-driver %O %A %B %P'`,
    );
    expect(r.stdout).toContain(`echo '*.mmd merge=opsdraw' >> .gitattributes`);
    expect(cli(dir, 'git-setup', '--driver', 'npx').stdout).toContain(
      `git config merge.opsdraw.driver 'npx --yes opsdraw merge-driver %O %A %B %P'`,
    );
  });

  it('--apply writes git config and .gitattributes idempotently', () => {
    const repo = newRepo('setup');
    writeFileSync(path.join(repo, '.gitattributes'), '*.png binary');
    mkdirSync(path.join(repo, 'sub'));
    for (let i = 0; i < 2; i++) {
      const r = cli(path.join(repo, 'sub'), 'git-setup', '--apply');
      expect(r.code, r.stderr).toBe(0);
    }
    expect(git(repo, 'config', 'merge.opsdraw.name').trim()).toBe('OpsDraw diagram merge');
    expect(git(repo, 'config', 'merge.opsdraw.driver').trim()).toMatch(
      /^node ".*\/dist\/index\.js" merge-driver %O %A %B %P$/,
    );
    expect(readFileSync(path.join(repo, '.gitattributes'), 'utf8')).toBe(
      '*.png binary\n*.mmd merge=opsdraw\n*.mermaid merge=opsdraw\n',
    );
    expect(existsSync(path.join(repo, 'sub', '.gitattributes'))).toBe(false);
  });

  it('--apply fails outside a git repository', () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), 'opsdraw-nogit-'));
    try {
      const r = cli(outside, 'git-setup', '--apply');
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/inside a git repository/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('git merge with the opsdraw driver', () => {
  it('merges layout and structure changes from two branches without conflict markers', () => {
    const repo = newRepo('e2e');
    expect(cli(repo, 'git-setup', '--apply').code).toBe(0);
    writeFileSync(path.join(repo, 'arch.mmd'), BASE);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base diagram');

    // Branch a: move x, add y. Both edits sit next to branch b's edits, so a line-based merge
    // would conflict.
    git(repo, 'checkout', '-q', '-b', 'a');
    writeFileSync(
      path.join(repo, 'arch.mmd'),
      BASE.replace('  service z', '  service y(disk)[Y] in vpc\n  service z')
        .replace('@pos x 20 40', '@pos x 25 140')
        .replace('  %% @pos z', '  %% @pos y 160 200\n  %% @pos z'),
    );
    git(repo, 'commit', '-q', '-am', 'move x, add y');

    // Branch b: move z, rename x's label and the edge label.
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'checkout', '-q', '-b', 'b');
    writeFileSync(
      path.join(repo, 'arch.mmd'),
      BASE.replace('[X]', '[Frontend]')
        .replace('-[reads]->', '-[queries]->')
        .replace('@pos z 300 40', '@pos z 320 60'),
    );
    git(repo, 'commit', '-q', '-am', 'move z, relabel');

    // Sanity check: git's line-based merge cannot merge these versions cleanly.
    const versions = ['main', 'a', 'b'].map((rev) => {
      const p = at(`e2e-${rev}.mmd`);
      writeFileSync(p, git(repo, 'show', `${rev}:arch.mmd`));
      return p;
    });
    const plain = spawnSync('git', ['merge-file', '-p', versions[2]!, versions[0]!, versions[1]!], {
      encoding: 'utf8',
    });
    expect(plain.status).toBeGreaterThan(0);

    const r = spawnSync('git', ['merge', '--no-edit', 'a'], { cwd: repo, encoding: 'utf8' });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const text = readFileSync(path.join(repo, 'arch.mmd'), 'utf8');
    expect(text).not.toMatch(/^(<<<<<<<|=======|>>>>>>>)/m);
    expect(text).not.toContain('CONFLICT');
    const d = parse(text);
    expect(d.nodes.find((n) => n.id === 'x')!.label).toBe('Frontend');
    expect(d.nodes.find((n) => n.id === 'y')).toMatchObject({ label: 'Y', parent: 'vpc' });
    expect(d.edges.find((e) => e.from === 'x' && e.to === 'z')!.label).toBe('queries');
    expect(d.layout.x).toEqual({ x: 25, y: 140 });
    expect(d.layout.y).toEqual({ x: 160, y: 200 });
    expect(d.layout.z).toEqual({ x: 320, y: 60 });
    expect(git(repo, 'status', '--porcelain').trim()).toBe('');
    expect(git(repo, 'log', '--oneline', '-1')).toMatch(/Merge branch 'a'/);
  });
});
