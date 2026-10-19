import { describe, expect, it } from 'vitest';
import { parse } from '@mermaid-js/parser';
import { detectIac, importIac, serializeArchitecture } from '../src';

const K0SCTL = `apiVersion: k0sctl.k0sproject.io/v1beta1
kind: Cluster
metadata: { name: lab }
spec:
  hosts:
    - role: controller
      ssh: { address: 10.0.0.1 }
    - role: worker
      ssh: { address: 10.0.0.2 }
`;
const TALOS = `version: v1alpha1
machine:
  type: controlplane
cluster:
  clusterName: home
  controlPlane: { endpoint: https://10.0.0.10:6443 }
`;
const K3S_AGENT = `server: https://10.0.0.1:6443
token: secret
node-name: agent-1
`;
const INI = `[web]
web[01:02].example.com

[db]
db01 ansible_host=10.0.0.5

[prod:children]
web
db
`;
const YAML_INV = `all:
  children:
    web:
      hosts:
        web1:
`;
const NOMAD = `job "shop" {
  group "api" {
    task "server" {
      driver = "docker"
      config { image = "shop:1" }
    }
  }
}
`;
const K8S = `apiVersion: v1
kind: Service
metadata: { name: web }
spec: { selector: { app: web } }
`;

describe('format detection', () => {
  it.each([
    ['cluster.yaml', K0SCTL, 'clusterconfig'],
    ['controlplane.yaml', TALOS, 'clusterconfig'],
    ['config.yaml', K3S_AGENT, 'clusterconfig'],
    ['hosts', INI, 'ansible'],
    ['inventory.ini', INI, 'ansible'],
    ['inventory/prod.yml', YAML_INV, 'ansible'],
    ['group_vars.yml', YAML_INV, 'ansible'],
    ['shop.nomad', NOMAD, 'nomad'],
    ['jobs/shop.hcl', NOMAD, 'nomad'],
    ['web.yaml', K8S, 'kubernetes'],
    ['main.tf', 'resource "a_b" "c" {}', 'terraform'],
    ['main.tofu', 'resource "a_b" "c" {}', 'terraform'],
    ['docker-compose.yml', 'services:\n  a:\n    image: x\n', 'compose'],
    ['settings.ini', 'just text', null],
    ['vars.hcl', 'region = "eu"', null],
    ['README.md', K8S, null],
  ])('%s → %s', (path, content, kind) => {
    expect(detectIac(path, content)).toBe(kind);
  });

  it('imports a mixed on-prem repository into one Mermaid-valid diagram', async () => {
    const { diagram, kinds, skipped } = importIac([
      { path: 'cluster.yaml', content: K0SCTL },
      { path: 'inventory/hosts', content: INI },
      { path: 'shop.nomad', content: NOMAD },
      { path: 'k8s/web.yaml', content: K8S },
      { path: 'notes.txt', content: 'hello' },
    ]);
    expect(kinds).toEqual(['kubernetes', 'clusterconfig', 'ansible', 'nomad']);
    expect(skipped).toEqual(['notes.txt']);
    const ids = diagram.nodes.map((n) => n.id);
    for (const prefix of ['cluster_', 'ansible_', 'nomad_', 'k8s_'])
      expect(ids.some((id) => id.startsWith(prefix))).toBe(true);
    await expect(parse('architecture', serializeArchitecture(diagram))).resolves.toBeTruthy();
  });
});

describe('OpenTofu', () => {
  it('loads foo.tofu instead of foo.tf in the same directory, like tofu does', () => {
    const { diagram, overridden } = importIac([
      { path: 'infra/main.tf', content: 'resource "aws_instance" "terraform_only" {}' },
      { path: 'infra/main.tofu', content: 'resource "aws_instance" "tofu_only" {}' },
      { path: 'infra/db.tf', content: 'resource "aws_db_instance" "db" {}' },
      { path: 'other/main.tf', content: 'resource "aws_instance" "elsewhere" {}' },
    ]);
    expect(overridden).toEqual(['infra/main.tf']);
    expect(diagram.nodes.map((n) => n.id).sort()).toEqual(['db', 'elsewhere', 'tofu_only']);
  });
});
