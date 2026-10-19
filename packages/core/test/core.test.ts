import { describe, expect, it } from 'vitest';
import {
  autoLayout,
  parseArchitecture,
  parseFlowchart,
  parseMermaid,
  parseTerraform,
  removeNode,
  renameNode,
  serializeArchitecture,
} from '../src';

const SAMPLE = `---
title: Web app
---
architecture-beta
  %% keep me
  group api(cloud)[API]

  service db(database)[Database] in api
  service disk1(disk)[Storage] in api
  service server(server)[Server] in api
  service fn(lucide:square-function)[Worker]
  junction j1 in api

  db:L -- R:server
  disk1:T --> B:server
  server{group}:R <-[calls]-> L:fn
  %% @pos db 10 20
  %% @pos api 0 0 400 300
`;

describe('architecture parser', () => {
  it('parses groups, services, junctions, edges and layout', () => {
    const { diagram, errors } = parseArchitecture(SAMPLE);
    expect(errors).toEqual([]);
    expect(diagram.title).toBe('Web app');
    expect(diagram.nodes.map((n) => n.id)).toEqual(['api', 'db', 'disk1', 'server', 'fn', 'j1']);
    expect(diagram.nodes.find((n) => n.id === 'fn')).toMatchObject({
      icon: 'lucide:square-function',
      label: 'Worker',
    });
    expect(diagram.edges[2]).toMatchObject({
      from: 'server',
      fromGroup: true,
      arrowStart: true,
      arrowEnd: true,
      label: 'calls',
    });
    expect(diagram.layout.api).toEqual({ x: 0, y: 0, w: 400, h: 300 });
    expect(diagram.comments).toEqual(['keep me']);
  });

  it('round-trips through serialize', () => {
    const first = parseArchitecture(SAMPLE).diagram;
    const text = serializeArchitecture(first);
    const second = parseArchitecture(text);
    expect(second.errors).toEqual([]);
    expect(second.diagram).toEqual(first);
    expect(serializeArchitecture(second.diagram)).toBe(text);
  });

  it('reports unknown references and bad statements with line numbers', () => {
    const { errors } = parseArchitecture(
      'architecture-beta\n  service a(server)[A] in nowhere\n  a:R -- L:b\n  what is this\n',
    );
    expect(errors).toEqual(
      expect.arrayContaining([
        { line: 2, message: 'Unknown group "nowhere"' },
        { line: 3, message: 'Unknown node "b"' },
        { line: 4, message: 'Unrecognized statement: what is this' },
      ]),
    );
  });

  it('rejects duplicate ids', () => {
    const { errors } = parseArchitecture('architecture-beta\nservice a[A]\nservice a[B]\n');
    expect(errors).toEqual([{ line: 3, message: 'Duplicate id "a"' }]);
  });

  it('removes and renames nodes with their references', () => {
    const d = parseArchitecture(SAMPLE).diagram;
    const renamed = renameNode(d, 'server', 'web');
    expect(renamed.edges.filter((e) => e.from === 'web' || e.to === 'web')).toHaveLength(3);
    const removed = removeNode(d, 'api');
    expect(removed.nodes.map((n) => n.id)).toEqual(['fn']);
    expect(removed.edges).toEqual([]);
    expect(removed.layout).toEqual({});
  });
});

describe('flowchart import', () => {
  it('converts subgraphs, shapes, chains and labels', () => {
    const { diagram, errors } = parseFlowchart(`flowchart LR
      user((User)) --> lb[Load balancer]
      subgraph backend [Backend]
        app1[App] & app2[App 2] -->|SQL| db[(Postgres)]
      end
      lb --> app1 & app2
      lb -- health --> app1
      classDef x fill:#f00
    `);
    expect(errors).toEqual([]);
    const byId = Object.fromEntries(diagram.nodes.map((n) => [n.id, n]));
    expect(byId.backend).toMatchObject({ kind: 'group', label: 'Backend' });
    expect(byId.db).toMatchObject({ icon: 'database', label: 'Postgres', parent: 'backend' });
    expect(byId.lb).toMatchObject({ label: 'Load balancer' });
    expect(byId.lb!.parent).toBeUndefined();
    expect(diagram.edges).toHaveLength(6);
    expect(diagram.edges.find((e) => e.label === 'SQL')).toMatchObject({
      fromSide: 'R',
      toSide: 'L',
    });
    expect(diagram.edges.find((e) => e.label === 'health')).toMatchObject({
      from: 'lb',
      to: 'app1',
    });
  });

  it('ignores operator-like text inside labels', () => {
    const { diagram, errors } = parseFlowchart('graph TD\n  a[x -- y] --> b');
    expect(errors).toEqual([]);
    expect(diagram.nodes.find((n) => n.id === 'a')!.label).toBe('x -- y');
    expect(diagram.edges).toHaveLength(1);
  });

  it('is picked by parseMermaid from the header', () => {
    expect(parseMermaid('%% c\nflowchart TD\nA-->B').kind).toBe('flowchart');
    expect(parseMermaid('architecture-beta\n').kind).toBe('architecture');
  });
});

describe('terraform import', () => {
  const tf = `
    # network
    resource "aws_vpc" "main" { cidr_block = "10.0.0.0/16" }
    resource "aws_subnet" "private" {
      vpc_id = aws_vpc.main.id /* inline */
    }
    resource "aws_instance" "web" {
      subnet_id = aws_subnet.private.id
      tags = { Name = "web-\${var.env}" }
    }
    resource "aws_db_instance" "db" { db_subnet_group_name = aws_subnet.private.id }
    resource "aws_sqs_queue" "jobs" {}
    resource "aws_lambda_function" "worker" { role = aws_iam_role.lambda.arn }
    resource "aws_iam_role" "lambda" {}
    resource "aws_lambda_event_source_mapping" "jobs" {
      event_source_arn = aws_sqs_queue.jobs.arn
      function_name    = aws_lambda_function.worker.arn
    }
    resource "aws_security_group_rule" "x" { from_port = 1 }
    module "cdn" { origin = aws_instance.web.public_ip }
  `;

  it('nests resources in networks, hides plumbing, links via connectors', () => {
    const d = parseTerraform([{ path: 'main.tf', content: tf }]);
    const byId = Object.fromEntries(d.nodes.map((n) => [n.id, n]));
    expect(Object.keys(byId).sort()).toEqual(
      ['cdn', 'db', 'main', 'private', 'web', 'worker', 'jobs'].sort(),
    );
    expect(byId.private).toMatchObject({ kind: 'group', parent: 'main' });
    expect(byId.web).toMatchObject({ parent: 'private', icon: 'server' });
    expect(byId.db).toMatchObject({ parent: 'private', icon: 'database' });
    expect(byId.worker!.icon).toBe('lucide:square-function');
    expect(byId.cdn!.label).toBe('cdn (module)');
    const pairs = d.edges.map((e) => `${e.from}->${e.to}`).sort();
    expect(pairs).toEqual(['cdn->web', 'worker->jobs']);
  });

  it('produces a valid Mermaid file', () => {
    const text = serializeArchitecture(parseTerraform([{ path: 'main.tf', content: tf }]));
    expect(parseArchitecture(text).errors).toEqual([]);
  });
});

describe('auto layout', () => {
  it('places every node, sizes groups and keeps children inside', async () => {
    const d = await autoLayout(parseArchitecture(SAMPLE).diagram);
    for (const n of d.nodes) expect(d.layout[n.id]).toBeDefined();
    const api = d.layout.api!;
    expect(api.w).toBeGreaterThan(0);
    for (const id of ['db', 'disk1', 'server']) {
      const c = d.layout[id]!;
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.x).toBeLessThan(api.w!);
    }
    expect(parseArchitecture(serializeArchitecture(d)).errors).toEqual([]);
  });
});
