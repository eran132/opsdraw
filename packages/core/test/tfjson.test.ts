import { readFileSync } from 'node:fs';
import { parse } from '@mermaid-js/parser';
import { describe, expect, it } from 'vitest';
import { parseArchitecture, serializeArchitecture, type Diagram } from '../src';
import { isTerraformJson, parseTerraformJson, type TerraformJsonOptions } from '../src/tfjson';

const fixture = (name: string) => ({
  path: name,
  content: readFileSync(new URL(`./fixtures/tfjson/${name}`, import.meta.url), 'utf8'),
});
const load = (name: string, options?: TerraformJsonOptions) =>
  parseTerraformJson([fixture(name)], options);

const byId = (d: Diagram) => Object.fromEntries(d.nodes.map((n) => [n.id, n]));
const pairs = (d: Diagram) => d.edges.map((e) => `${e.from}->${e.to}`).sort();

async function expectMermaidAccepts(d: Diagram) {
  const text = serializeArchitecture(d);
  let error: string | null = null;
  try {
    await parse('architecture', text);
  } catch (e) {
    error = String((e as Error).message);
  }
  expect(error, text).toBeNull();
  expect(parseArchitecture(text).errors).toEqual([]);
}

describe('parseTerraformJson: plan JSON', () => {
  const d = load('plan.json');
  const n = byId(d);

  it('nests the module, the VPC and the subnet resolved from real ids', () => {
    expect(n.vpc).toMatchObject({ kind: 'group', label: 'vpc', icon: 'lucide:package' });
    expect(n.this).toMatchObject({ kind: 'group', label: 'this', parent: 'vpc' });
    expect(n.private).toMatchObject({ kind: 'group', label: 'private ×2', parent: 'this' });
  });

  it('collapses count and for_each instances into one node', () => {
    expect(n.aws_instance_web).toMatchObject({
      kind: 'service',
      label: 'web ×2',
      icon: 'server',
      parent: 'private',
    });
    expect(n.sessions).toMatchObject({ label: 'sessions ×3', icon: 'database' });
    expect(n.sessions!.parent).toBeUndefined();
  });

  it('follows module outputs to the VPC, not to every output of the module', () => {
    expect(n.aws_security_group_web).toMatchObject({ icon: 'lucide:shield', parent: 'this' });
  });

  it('draws edges from configuration references, skipping containers and data sources', () => {
    expect(pairs(d)).toEqual([
      'aws_instance_web->aws_security_group_web',
      'worker->jobs',
      'worker->sessions',
    ]);
  });

  it('hides data sources, plumbing and resources being destroyed', () => {
    const labels = d.nodes.map((x) => x.label);
    expect(labels).not.toContain('ubuntu');
    expect(labels.some((l) => l?.startsWith('legacy'))).toBe(false);
    expect(d.nodes).toHaveLength(8);
  });

  it('expands instances and keeps destroyed and plumbing resources with the options', () => {
    const all = load('plan.json', { expandInstances: true, includeAll: true });
    const m = byId(all);
    expect(m.aws_instance_web_0).toMatchObject({ label: 'web (0)', parent: 'vpc_private_a' });
    expect(m.aws_instance_web_1).toMatchObject({ label: 'web (1)', parent: 'vpc_private_a' });
    expect(m.vpc_private_b).toMatchObject({ kind: 'group', label: 'private (b)', parent: 'this' });
    expect(m.sessions_eu).toMatchObject({ label: 'sessions (eu)' });
    expect(m.legacy).toMatchObject({ label: 'legacy (destroy)', parent: 'vpc_private_b' });
    expect(m.vpc_private).toMatchObject({ kind: 'service', parent: 'this' }); // route table
    expect(pairs(all)).toContain('aws_lambda_event_source_mapping_jobs->worker');
    expect(pairs(all)).toContain('legacy->aws_security_group_web');
    expect(pairs(all).filter((p) => p.startsWith('worker->'))).toHaveLength(4);
  });

  it('expands instances without showing destroyed resources by default', () => {
    const labels = load('plan.json', { expandInstances: true }).nodes.map((x) => x.label);
    expect(labels).toContain('web (0)');
    expect(labels).not.toContain('legacy (destroy)');
  });
});

describe('parseTerraformJson: state JSON', () => {
  const d = load('state-azure.json');
  const n = byId(d);

  it('nests Azure resources by resource_group_name, virtual_network_name and NIC subnets', () => {
    expect(n.azurerm_resource_group_main).toMatchObject({ kind: 'group', icon: 'lucide:folder' });
    expect(n.azurerm_virtual_network_main).toMatchObject({
      kind: 'group',
      parent: 'azurerm_resource_group_main',
    });
    expect(n.azurerm_subnet_app).toMatchObject({
      kind: 'group',
      parent: 'azurerm_virtual_network_main',
    });
    expect(n.azurerm_linux_virtual_machine_app).toMatchObject({
      label: 'app ×2',
      parent: 'azurerm_subnet_app',
    });
    expect(n.azurerm_mssql_server_main).toMatchObject({
      icon: 'database',
      parent: 'azurerm_resource_group_main',
    });
  });

  it('hides NICs and data sources and links by id values', () => {
    expect(d.nodes.some((x) => x.label?.includes('current'))).toBe(false);
    expect(d.nodes).toHaveLength(6);
    expect(pairs(d)).toEqual(['orders->azurerm_mssql_server_main']);
  });

  it('reads raw terraform.tfstate files (version 4)', () => {
    const raw = load('terraform.tfstate');
    expect(byId(raw)).toMatchObject({
      main: { kind: 'group', icon: 'lucide:network' },
      app: { kind: 'group', parent: 'main' },
      api: { kind: 'service', label: 'api ×2', parent: 'app' },
      // No attribute matches, so the state `dependencies` place it.
      db: { kind: 'service', parent: 'main' },
    });
    // module.net only held the subnetwork, which moved into its network: no empty group.
    expect(raw.nodes.map((x) => x.id)).not.toContain('net');
    const expanded = byId(
      parseTerraformJson([fixture('terraform.tfstate')], { expandInstances: true }),
    );
    expect(expanded.api_blue).toMatchObject({ label: 'api (blue)', parent: 'app' });
  });
});

describe('parseTerraformJson: robustness', () => {
  it('never throws on partial or invalid input', () => {
    const inputs = [
      '',
      'not json',
      '[]',
      'null',
      '{}',
      '{"format_version":"1.0"}',
      '{"planned_values":{"root_module":{"resources":[null,1,{"type":5},{"type":"aws_vpc"}],"child_modules":[null,{}]}}}',
      '{"resource_changes":[{"change":null},{"address":"x","type":"aws_s3_bucket","name":"b","change":{"actions":"delete"}}]}',
      '{"configuration":{"root_module":{"resources":[{"address":"aws_s3_bucket.b","expressions":null}],"module_calls":{"m":null}}}}',
      '{"version":4,"terraform_version":"1.0.0","resources":[{"type":"aws_s3_bucket","name":"b","instances":[null,{"attributes":null}]}]}',
    ];
    for (const content of inputs)
      expect(() => parseTerraformJson([{ path: 'x.json', content }])).not.toThrow();
    const partial = parseTerraformJson([{ path: 'x.json', content: inputs[6]! }]);
    expect(partial.nodes).toEqual([]);
  });

  it('ignores values nested deeper than the size cap', () => {
    let deep: unknown = 'vpc-0deep';
    for (let i = 0; i < 12; i++) deep = { inner: deep };
    const plan = (subnetValue: unknown) =>
      JSON.stringify({
        format_version: '1.2',
        planned_values: {
          root_module: {
            resources: [
              {
                address: 'aws_vpc.main',
                mode: 'managed',
                type: 'aws_vpc',
                name: 'main',
                values: { id: 'vpc-0deep' },
              },
              {
                address: 'aws_instance.a',
                mode: 'managed',
                type: 'aws_instance',
                name: 'a',
                values: { x: subnetValue },
              },
            ],
          },
        },
      });
    const shallow = byId(
      parseTerraformJson([{ path: 'p.json', content: plan({ vpc: 'vpc-0deep' }) }]),
    );
    expect(shallow.a!.parent).toBe('main');
    const tooDeep = byId(parseTerraformJson([{ path: 'p.json', content: plan(deep) }]));
    expect(tooDeep.a!.parent).toBeUndefined();
  });
});

describe('isTerraformJson', () => {
  it('recognizes plan, state and raw state files', () => {
    for (const f of ['plan.json', 'state-azure.json', 'terraform.tfstate'])
      expect(isTerraformJson(fixture(f).content), f).toBe(true);
  });
  it('rejects other JSON', () => {
    expect(isTerraformJson('{"services":{"web":{"image":"nginx"}}}')).toBe(false);
    expect(isTerraformJson('{"apiVersion":"v1","kind":"Service"}')).toBe(false);
    expect(isTerraformJson('{"version":4,"resources":[]}')).toBe(false);
  });
});

describe('Mermaid accepts Terraform JSON diagrams', () => {
  const cases: [string, TerraformJsonOptions][] = [
    ['plan.json', {}],
    ['plan.json', { expandInstances: true, includeAll: true }],
    ['state-azure.json', {}],
    ['state-azure.json', { expandInstances: true, includeAll: true }],
    ['terraform.tfstate', {}],
    ['terraform.tfstate', { expandInstances: true }],
  ];
  for (const [name, options] of cases)
    it(`${name} ${JSON.stringify(options)}`, async () => {
      await expectMermaidAccepts(load(name, options));
    });
});
