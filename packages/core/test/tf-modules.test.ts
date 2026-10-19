import { parse } from '@mermaid-js/parser';
import { describe, expect, it } from 'vitest';
import {
  isNetworkGroupType,
  isPlumbingType,
  parseArchitecture,
  parseTerraform,
  parseTerraformWithWarnings,
  serializeArchitecture,
  type Diagram,
  type TerraformFile,
} from '../src';

async function expectValidMermaid(d: Diagram) {
  const text = serializeArchitecture(d);
  await expect(parse('architecture', text), text).resolves.toBeDefined();
  expect(parseArchitecture(text).errors).toEqual([]);
}

const nodesOf = (d: Diagram) => Object.fromEntries(d.nodes.map((n) => [n.id, n]));
const edgesOf = (d: Diagram) => d.edges.map((e) => `${e.from}->${e.to}`).sort();
const files = (map: Record<string, string>): TerraformFile[] =>
  Object.entries(map).map(([path, content]) => ({ path, content }));

const REPO = files({
  'infra/main.tf': `
    resource "aws_vpc" "main" { cidr_block = "10.0.0.0/16" }
    module "network" {
      source = "./modules/network"
      vpc_id = aws_vpc.main.id
    }
    resource "aws_instance" "web" { subnet_id = module.network.subnet_id }
    resource "aws_lambda_function" "fn" {
      environment { variables = { QUEUE = module.network.queue_url } }
    }
  `,
  'infra/modules/network/main.tf': `
    variable "vpc_id" {}
    resource "aws_sqs_queue" "jobs" {}
    module "subnet" { source = "./modules/subnet" }
  `,
  'infra/modules/network/outputs.tf': `
    output "subnet_id" { value = module.subnet.id }
    output "queue_url" {
      description = "Queue for aws_instance.web jobs"
      value       = aws_sqs_queue.jobs.url
    }
  `,
  'infra\\modules\\network\\modules\\subnet\\main.tf': `
    resource "aws_subnet" "private" { vpc_id = var.vpc_id }
    resource "aws_route_table_association" "a" { subnet_id = aws_subnet.private.id }
  `,
  'infra/modules/network/modules/subnet/outputs.tf': `
    output "id" { value = aws_subnet.private.id }
  `,
});

describe('Terraform modules', () => {
  it('draws local modules as nested groups and resolves outputs', async () => {
    const { diagram: d, warnings } = parseTerraformWithWarnings(REPO);
    const n = nodesOf(d);
    expect(Object.keys(n).sort()).toEqual(
      ['fn', 'main', 'network', 'network_jobs', 'network_subnet', 'subnet_private', 'web'].sort(),
    );
    expect(n.network).toMatchObject({ kind: 'group', label: 'network', icon: 'lucide:package' });
    expect(n.network!.parent).toBeUndefined();
    expect(n.network_jobs).toMatchObject({ kind: 'service', parent: 'network' });
    expect(n.network_subnet).toMatchObject({ kind: 'group', label: 'subnet', parent: 'network' });
    expect(n.subnet_private).toMatchObject({ kind: 'group', parent: 'network_subnet' });
    // module.network.subnet_id -> module.subnet.id -> aws_subnet.private: web nests in it.
    expect(n.web).toMatchObject({ kind: 'service', parent: 'subnet_private' });
    // Edges go to the resource an output names, never to a module group.
    expect(edgesOf(d)).toEqual(['fn->network_jobs']);
    expect(warnings).toEqual([]);
    await expectValidMermaid(d);
  });

  it('module files are not also read as root resources', () => {
    const d = parseTerraform(REPO);
    expect(d.nodes.filter((n) => n.label === 'jobs')).toHaveLength(1);
    expect(d.nodes.filter((n) => n.label === 'private')).toHaveLength(1);
  });

  it('the same module called twice gives two groups with their own ids', async () => {
    const d = parseTerraform(
      files({
        'main.tf': `
          module "blue" { source = "./modules/app" }
          module "green" {
            source = "./modules/app"
            count  = 2
          }
          resource "aws_lb" "front" { targets = [module.blue.id, module.green[0].id] }
        `,
        'modules/app/main.tf': 'resource "aws_instance" "app" { ami = "x" }',
        'modules/app/outputs.tf': 'output "id" { value = aws_instance.app.id }',
      }),
    );
    const n = nodesOf(d);
    expect(n.blue).toMatchObject({ kind: 'group', label: 'blue' });
    expect(n.green).toMatchObject({ kind: 'group', label: 'green ×2' });
    expect(n.blue_app).toMatchObject({ parent: 'blue', icon: 'server' });
    expect(n.green_app).toMatchObject({ parent: 'green', icon: 'server' });
    expect(edgesOf(d)).toEqual(['front->blue_app', 'front->green_app']);
    await expectValidMermaid(d);
  });

  it('reads module directories of OpenTofu .tofu files', async () => {
    const { diagram: d, warnings } = parseTerraformWithWarnings(
      files({
        'main.tofu': `
          module "db" { source = "./db" }
          resource "aws_instance" "api" { db = module.db.endpoint }
        `,
        'db/main.tofu': 'resource "aws_db_instance" "pg" { engine = "postgres" }',
        'db/outputs.tf': 'output "endpoint" { value = aws_db_instance.pg.address }',
      }),
    );
    const n = nodesOf(d);
    expect(n.db).toMatchObject({ kind: 'group', icon: 'lucide:package' });
    expect(n.db_pg).toMatchObject({ parent: 'db', icon: 'database' });
    expect(edgesOf(d)).toEqual(['api->db_pg']);
    expect(warnings).toEqual([]);
    await expectValidMermaid(d);
  });

  it('collapses remote registry modules into one node', async () => {
    const { diagram: d, warnings } = parseTerraformWithWarnings(
      files({
        'main.tf': `
          module "vpc" {
            source  = "terraform-aws-modules/vpc/aws"
            version = "~> 5.0"
          }
          resource "aws_instance" "x" { subnet_id = module.vpc.private_subnets[0] }
        `,
      }),
    );
    const n = nodesOf(d);
    expect(n.vpc).toMatchObject({ kind: 'service', label: 'vpc (module)', icon: 'lucide:package' });
    expect(edgesOf(d)).toEqual(['x->vpc']);
    expect(warnings).toEqual([
      'module "vpc": remote source "terraform-aws-modules/vpc/aws" shown as a single node',
    ]);
    await expectValidMermaid(d);
  });

  it('expands remote modules through .terraform/modules/modules.json', async () => {
    const manifest = JSON.stringify({
      Modules: [
        { Key: '', Source: '', Dir: '.' },
        {
          Key: 'vpc',
          Source: 'registry.terraform.io/terraform-aws-modules/vpc/aws',
          Version: '5.1.0',
          Dir: '.terraform/modules/vpc',
        },
        {
          Key: 'eks',
          Source: 'git::https://example.com/eks.git',
          Dir: '.terraform\\modules\\eks',
        },
      ],
    });
    const { diagram: d, warnings } = parseTerraformWithWarnings(
      files({
        'live/main.tf': `
          module "vpc" { source = "terraform-aws-modules/vpc/aws" }
          module "eks" { source = "git::https://example.com/eks.git" }
          resource "aws_instance" "x" { subnet_id = module.vpc.private_subnets[0] }
        `,
        'live/.terraform/modules/modules.json': manifest,
        'live/.terraform/modules/vpc/main.tf': `
          resource "aws_vpc" "this" {}
          resource "aws_subnet" "private" {
            count  = 3
            vpc_id = aws_vpc.this.id
          }
        `,
        'live/.terraform/modules/vpc/outputs.tf':
          'output "private_subnets" { value = aws_subnet.private[*].id }',
        'live/.terraform/modules/eks/main.tf': 'resource "aws_eks_cluster" "this" {}',
      }),
    );
    const n = nodesOf(d);
    expect(n.vpc).toMatchObject({ kind: 'group', label: 'vpc' });
    expect(n.vpc_this).toMatchObject({ kind: 'group', parent: 'vpc' });
    expect(n.vpc_private).toMatchObject({ kind: 'group', label: 'private ×3', parent: 'vpc_this' });
    expect(n.x).toMatchObject({ parent: 'vpc_private' });
    expect(n.eks).toMatchObject({ kind: 'group' });
    expect(n.eks_this).toMatchObject({ icon: 'lucide:boxes', parent: 'eks' });
    expect(warnings).toEqual([]);
    await expectValidMermaid(d);
  });

  it('labels count and for_each', async () => {
    const d = parseTerraform(
      files({
        'main.tf': `
          resource "aws_instance" "web" { count = 3 }
          resource "aws_instance" "api" { count = var.n }
          resource "aws_instance" "worker" { count = length(var.zones) }
          resource "aws_instance" "each" { for_each = toset(var.names) }
          resource "aws_instance" "opt" { count = var.enabled ? 1 : 0 }
          resource "aws_instance" "zero" { count = 0 }
          resource "aws_instance" "one" { count = 1 }
          resource "google_compute_instance" "gpu" {
            guest_accelerator {
              type  = "nvidia-tesla-t4"
              count = 2
            }
          }
          module "svc" {
            source   = "./svc"
            for_each = var.services
          }
        `,
        'svc/main.tf': 'resource "aws_ecs_service" "s" {}',
      }),
    );
    const label = Object.fromEntries(d.nodes.map((x) => [x.id, x.label]));
    expect(label).toMatchObject({
      web: 'web ×3',
      api: 'api ×N',
      worker: 'worker ×N',
      each: 'each (for_each)',
      opt: 'opt',
      zero: 'zero',
      one: 'one',
      gpu: 'gpu',
      svc: 'svc (for_each)',
    });
    await expectValidMermaid(d);
  });

  it('survives heredocs, interpolation braces and braces in comments', async () => {
    const d = parseTerraform(
      files({
        'main.tf': `
          # a comment with a stray } brace
          /* and { another */
          resource "aws_db_instance" "db" { engine = "postgres" } // trailing }
          resource "aws_instance" "web" {
            user_data = <<EOF
          #!/bin/bash
          echo "{ unbalanced" > /etc/app.conf
          echo DB=\${aws_db_instance.db.address}
          resource "aws_instance" "ghost" {
          EOF
            tags = { Name = "\${lookup({ a = "}" }, "a")}-web", Note = "#not a comment {" }
          }
          resource "aws_instance" "after" {
            policy = <<-JSON
              { "Statement": [ { "Effect": "Allow" ] }
              JSON
          }
          resource "aws_sqs_queue" "q" { name = "$\${literal}" }
        `,
      }),
    );
    const n = nodesOf(d);
    expect(Object.keys(n).sort()).toEqual(['after', 'db', 'q', 'web']);
    // The reference inside the heredoc still links the instance to its database.
    expect(edgesOf(d)).toEqual(['web->db']);
    await expectValidMermaid(d);
  });

  it('ignores moved, import, removed, check and other non-resource blocks', async () => {
    const d = parseTerraform(
      files({
        'main.tf': `
          terraform {
            required_providers { aws = { source = "hashicorp/aws" } }
            backend "s3" { bucket = "state" }
          }
          provider "aws" { region = "eu-west-1" }
          variable "n" { default = 1 }
          locals { name = "x" }
          moved {
            from = aws_instance.old
            to   = aws_instance.web
          }
          import {
            to = aws_instance.web
            id = "i-123"
          }
          removed {
            from = aws_instance.gone
            lifecycle { destroy = false }
          }
          check "health" {
            data "http" "probe" { url = "https://example.com" }
            assert {
              condition     = data.http.probe.status_code == 200
              error_message = "down"
            }
          }
          output "ip" { value = aws_instance.web.public_ip }
          resource "aws_instance" "web" {}
        `,
      }),
    );
    expect(d.nodes.map((x) => x.id)).toEqual(['web']);
    expect(d.edges).toEqual([]);
    await expectValidMermaid(d);
  });

  it('reports what it could not draw', async () => {
    const { diagram: d, warnings } = parseTerraformWithWarnings(
      files({
        'main.tf': `
          module "gone" { source = "./modules/gone" }
          module "inline" { origin = "x" }
          module "self" { source = "./" }
          module "network" { source = "./net" }
          resource "acme_widget" "a" {}
          resource "acme_widget" "b" {}
          resource "aws_instance" "web" { subnet = module.network.nope }
        `,
        'net/main.tf': 'resource "acme_gizmo" "g" {}',
      }),
    );
    expect(warnings).toEqual([
      'module "gone": source not found among files',
      'module "inline": no source, shown as a single node',
      'module "self": recursive module call skipped',
      'module "network": output "nope" not found',
      '3 resources of unknown type shown with a generic icon',
    ]);
    const n = nodesOf(d);
    expect(n.gone).toMatchObject({ kind: 'service', label: 'gone (module)' });
    expect(n.network_g).toMatchObject({ icon: 'lucide:box', parent: 'network' });
    await expectValidMermaid(d);
  });

  it('exports type helpers for other importers', () => {
    expect(isPlumbingType('aws_iam_role_policy')).toBe(true);
    expect(isPlumbingType('aws_instance')).toBe(false);
    expect(isNetworkGroupType('aws_subnet')).toBe(true);
    expect(isNetworkGroupType('openstack_networking_network_v2')).toBe(true);
    expect(isNetworkGroupType('aws_instance')).toBe(false);
  });
});
