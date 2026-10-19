import { parse } from '@mermaid-js/parser';
import { describe, expect, it } from 'vitest';
import {
  autoLayout,
  emptyDiagram,
  importIac,
  makeId,
  parseArchitecture,
  parseFlowchart,
  serializeArchitecture,
  type Diagram,
} from '../src';

/**
 * Everything OpsDraw writes must be accepted by Mermaid itself, so files render on GitHub, GitLab
 * and docs sites. These tests run Mermaid's own grammar over our output.
 */

async function mermaidAccepts(text: string): Promise<string | null> {
  try {
    await parse('architecture', text);
    return null;
  } catch (e) {
    return String((e as Error).message);
  }
}

async function expectMermaidAccepts(d: Diagram) {
  const text = serializeArchitecture(d);
  expect(await mermaidAccepts(text), text).toBeNull();
  expect(parseArchitecture(text).errors).toEqual([]);
}

const TRICKY_NAMES = [
  'Router',
  'Backend',
  'LB',
  'T',
  'Load Balancer',
  'API-Gateway',
  'TaskRole',
  'RDSInstance',
  '9lives',
  'שרת ראשי',
  'خادم',
  '数据库',
  'web app!',
  '__init__',
  'x.y.z',
];

describe('Mermaid accepts what OpsDraw writes', () => {
  it('generated ids, for any input name', async () => {
    const d = emptyDiagram();
    for (const name of TRICKY_NAMES) {
      const id = makeId(
        name,
        d.nodes.map((n) => n.id),
      );
      d.nodes.push({ id, kind: 'service', icon: 'server', label: name });
    }
    await expectMermaidAccepts(d);
  });

  it('labels with punctuation, quotes, brackets, RTL and CJK text', async () => {
    const labels = [
      'GET /api, v2',
      'a "quoted" (name)',
      'brackets [inside]',
      'a{b}|c<d>',
      '10.0.0.1:443',
      'שרת ראשי',
      'خادم الويب',
      '数据库',
      'emoji 🚀',
      'multi\nline',
    ];
    const d = emptyDiagram();
    d.nodes.push({ id: 'g', kind: 'group', icon: 'cloud', label: 'Group: prod [eu]' });
    labels.forEach((label, i) =>
      d.nodes.push({ id: `n${i}`, kind: 'service', icon: 'lucide:server', label, parent: 'g' }),
    );
    labels.slice(1).forEach((label, i) =>
      d.edges.push({
        from: 'n0',
        to: `n${i + 1}`,
        fromSide: 'R',
        toSide: 'L',
        arrowEnd: true,
        label,
      }),
    );
    d.title = 'Prod: EU [v2]';
    await expectMermaidAccepts(d);
  });

  it('every edge form, groups, junctions and positions', async () => {
    const { diagram } = parseArchitecture(`architecture-beta
  group outer(cloud)[Outer]
  group inner(lucide:network)[Inner] in outer
  service a(server)[A] in inner
  service b(database)[B] in inner
  service c(disk)[C]
  junction j in outer
  a:R -- L:b
  a:B --> T:j
  j:R <-- L:c
  a{group}:L <--> R:c
  b:R -[sql]-> L:c
`);
    await expectMermaidAccepts(await autoLayout(diagram));
  });

  it('flowchart conversions', async () => {
    const { diagram } = parseFlowchart(`flowchart LR
  User((User)) --> LB[Load balancer]
  subgraph Backend [Back end]
    API[API] -->|SQL| DB[(Postgres)]
  end
  LB --> API
`);
    // Flowchart ids such as LB are kept as written, so the converter must make them safe.
    await expectMermaidAccepts(diagram);
  });

  it('infrastructure imports in every format', async () => {
    const { diagram } = importIac([
      {
        path: 'main.tf',
        content: `
          resource "aws_vpc" "Main" {}
          resource "aws_subnet" "Private" { vpc_id = aws_vpc.Main.id }
          resource "aws_instance" "Backend" { subnet_id = aws_subnet.Private.id }
          resource "proxmox_vm_qemu" "Runner" { target_node = "PVE1" network { bridge = "vmbr0" } }
        `,
      },
      {
        path: 'stack.yaml',
        content: `AWSTemplateFormatVersion: '2010-09-09'
Resources:
  LoadBalancer:
    Type: AWS::ElasticLoadBalancingV2::LoadBalancer
  TaskRole:
    Type: AWS::IAM::Role
  Bucket:
    Type: AWS::S3::Bucket
    Properties:
      Tags: [{ Key: lb, Value: !Ref LoadBalancer }]
`,
      },
      {
        path: 'k8s.yaml',
        content: `apiVersion: apps/v1
kind: Deployment
metadata: { name: Router }
spec:
  selector: { matchLabels: { app: r } }
  template: { metadata: { labels: { app: r } }, spec: { containers: [{ name: r, image: r }] } }
`,
      },
      { path: 'compose.yml', content: 'services:\n  Redis:\n    image: redis:7\n' },
    ]);
    await expectMermaidAccepts(await autoLayout(diagram));
  });
});

describe('the OpsDraw parser rejects what Mermaid rejects', () => {
  it.each(['Lb', 'T1', 'Backend', 'Router'])('id %s', async (id) => {
    const text = `architecture-beta\n  service ${id}(server)[X]\n`;
    expect(await mermaidAccepts(text)).not.toBeNull();
    expect(parseArchitecture(text).errors[0]?.message).toMatch(/uppercase T, B, L or R/);
  });

  it('icon names with dots', async () => {
    const text = 'architecture-beta\n  service n(a.b:c)[N]\n';
    expect(await mermaidAccepts(text)).not.toBeNull();
    expect(parseArchitecture(text).errors[0]?.message).toMatch(/Invalid icon/);
  });
});
