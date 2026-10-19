import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(pkgDir, '../..');
const entry = path.join(pkgDir, 'dist', 'index.js');

let root: string;
let client: Client;

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

async function callOk<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const r = await call(name, args);
  expect(r.isError, r.content[0]?.text).toBeFalsy();
  return JSON.parse(r.content[0]!.text) as T;
}

beforeAll(async () => {
  if (!existsSync(entry)) {
    execSync('npm run build -w opsdraw-mcp', { cwd: repoRoot, stdio: 'inherit' });
  }
  root = mkdtempSync(path.join(os.tmpdir(), 'opsdraw-mcp-stdio-'));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.OPSDRAW_ROOT = root;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: pkgDir,
    env,
    stderr: 'pipe',
  });
  client = new Client({ name: 'opsdraw-stdio-test', version: '0.0.0' });
  await client.connect(transport);
}, 180_000);

afterAll(async () => {
  await client?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('opsdraw MCP server over stdio', () => {
  it('identifies itself', () => {
    expect(client.getServerVersion()?.name).toBe('opsdraw');
  });

  it('lists all tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const name of [
      'create_diagram',
      'read_diagram',
      'write_diagram',
      'add_service',
      'add_group',
      'connect',
      'update_node',
      'remove',
      'disconnect',
      'auto_layout',
      'import_terraform',
      'import_iac',
      'describe_format',
      'list_icons',
      'validate',
    ]) {
      expect(names).toContain(name);
    }
  });

  it('builds a diagram end to end', async () => {
    await callOk('create_diagram', { path: 'arch/system.mmd', title: 'System' });
    const vpc = await callOk<{ id: string }>('add_group', {
      path: 'arch/system.mmd',
      id: 'vpc',
      label: 'VPC',
      icon: 'cloud',
    });
    expect(vpc.id).toBe('vpc');
    await callOk('add_service', {
      path: 'arch/system.mmd',
      id: 'api',
      label: 'API',
      icon: 'server',
      parent: 'vpc',
    });
    await callOk('add_service', {
      path: 'arch/system.mmd',
      id: 'db',
      label: 'Database',
      icon: 'database',
    });
    await callOk('connect', { path: 'arch/system.mmd', from: 'api', to: 'db', label: 'sql' });

    const read = await callOk<{ mermaid: string }>('read_diagram', { path: 'arch/system.mmd' });
    expect(read.mermaid).toContain('architecture-beta');
    expect(read.mermaid).toMatch(/service api\(server\)\[API\] in vpc/);
    expect(read.mermaid).toMatch(/api:[TBLR] -\[sql\]-> [TBLR]:db/);
  });

  it('converts a flowchart written with write_diagram', async () => {
    const r = await callOk<{ written: boolean; convertedFromFlowchart: boolean; mermaid: string }>(
      'write_diagram',
      {
        path: 'flow.mmd',
        mermaid: 'flowchart LR\n  subgraph cloud\n    a[Web] --> b[(DB)]\n  end\n',
      },
    );
    expect(r.written).toBe(true);
    expect(r.convertedFromFlowchart).toBe(true);
    expect(r.mermaid).toContain('architecture-beta');
    const read = await callOk<{ mermaid: string }>('read_diagram', { path: 'flow.mmd' });
    expect(read.mermaid).toMatch(/group cloud/);
  });

  it('reports invalid mermaid with a line number', async () => {
    // write_diagram reports errors in its result without writing...
    const w = await callOk<{ written: boolean; errors: { line: number }[] }>('write_diagram', {
      path: 'bad.mmd',
      mermaid: 'architecture-beta\n  service a[A]\n  nonsense here\n',
    });
    expect(w.written).toBe(false);
    expect(w.errors[0]?.line).toBe(3);
    expect(existsSync(path.join(root, 'bad.mmd'))).toBe(false);

    // ...while reading an invalid file is a tool error.
    writeFileSync(
      path.join(root, 'bad.mmd'),
      'architecture-beta\n  service a[A]\n  nonsense here\n',
    );
    const r = await call('read_diagram', { path: 'bad.mmd' });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/line 3/);
  });

  it('refuses paths outside the root', async () => {
    const r = await call('create_diagram', { path: '../x.mmd' });
    expect(r.isError).toBe(true);
    expect(existsSync(path.join(root, '..', 'x.mmd'))).toBe(false);
  });
});
