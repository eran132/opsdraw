import { parse } from '@mermaid-js/parser';
import { describe, expect, it } from 'vitest';
import { parseArchitecture, serializeArchitecture, type Diagram } from '../src';
import { expandHostPattern, iconForInventoryName, parseAnsibleInventory } from '../src/ansible';
import { parseHclBlocks, parseNomad } from '../src/nomad';

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

const INI = `# production inventory
mail.example.com

[webservers]
web[01:03].example.com ansible_user=deploy
lb1 ansible_host=10.0.0.5   ; front door

[dbservers]
db-[a:b].example.com ansible_host="10.0.1.10"
dbadmin.example.com

[db_replicas]
db-b.example.com

[redis]
cache1:2222

[monitoring]
prometheus01 ansible_host=10.0.9.1

[prod:children]
webservers
dbservers
redis

[dbservers:children]
db_replicas

[prod:vars]
ntp_server=ntp.example.com
`;

const YAML_INVENTORY = `all:
  hosts:
    bastion:
      ansible_host: 203.0.113.10
  children:
    k8s_cluster:
      children:
        kube_control_plane:
          hosts:
            master1: { ansible_host: 10.1.0.1 }
            master2:
        kube_node:
          hosts:
            worker[1:3]:
            master1:
    etcd:
      hosts:
        master1:
    ungrouped:
      hosts:
        lonely:
`;

describe('Ansible inventory import', () => {
  it('expands numeric, padded, alphabetic and stepped ranges, capped', () => {
    expect(expandHostPattern('web[01:03].x')).toEqual(['web01.x', 'web02.x', 'web03.x']);
    expect(expandHostPattern('db-[a:c]')).toEqual(['db-a', 'db-b', 'db-c']);
    expect(expandHostPattern('n[0:6:3]')).toEqual(['n0', 'n3', 'n6']);
    expect(expandHostPattern('r[1:2]c[1:2]')).toEqual(['r1c1', 'r1c2', 'r2c1', 'r2c2']);
    expect(expandHostPattern('big[1:100000]')).toHaveLength(200);
  });

  it('matches icon keywords as words only', () => {
    expect(iconForInventoryName('dbservers')).toBe('database');
    expect(iconForInventoryName('db-a.example.com')).toBe('database');
    expect(iconForInventoryName('dbadmin')).toBeUndefined();
    expect(iconForInventoryName('colb')).toBeUndefined();
    expect(iconForInventoryName('lb1')).toBe('lucide:split');
    expect(iconForInventoryName('kube_control_plane')).toBe('lucide:boxes');
    expect(iconForInventoryName('kafka-brokers')).toBe('lucide:radio-tower');
    expect(iconForInventoryName('prometheus01')).toBe('lucide:activity');
  });

  it('reads an INI inventory with children, ranges, ports and vars', async () => {
    const d = parseAnsibleInventory([{ path: 'inventory/hosts', content: INI }]);
    const n = byId(d);
    const groups = d.nodes.filter((x) => x.kind === 'group').map((x) => x.id);
    expect(groups).toEqual([
      'webservers',
      'dbservers',
      'db_replicas',
      'redis',
      'monitoring',
      'prod',
    ]);
    expect(n.webservers!.parent).toBe('prod');
    expect(n.dbservers!.parent).toBe('prod');
    expect(n.db_replicas!.parent).toBe('dbservers');
    expect(n.monitoring!.parent).toBeUndefined();

    expect(n.web01_example_com).toMatchObject({ parent: 'webservers', label: 'web01.example.com' });
    expect(n.web03_example_com).toBeDefined();
    expect(n.lb1).toMatchObject({ label: 'lb1 (10.0.0.5)', icon: 'lucide:split' });
    expect(n['db-a_example_com']).toMatchObject({
      parent: 'dbservers',
      icon: 'database',
      label: 'db-a.example.com (10.0.1.10)',
    });
    // Listed in dbservers and its child db_replicas: drawn once, in the deeper group.
    expect(n['db-b_example_com']!.parent).toBe('db_replicas');
    expect(d.nodes.filter((x) => x.label?.startsWith('db-b')).length).toBe(1);
    // "dbadmin" is not a db word, but the host inherits its group's icon.
    expect(n.dbadmin_example_com!.icon).toBe('database');
    expect(n.cache1).toMatchObject({ parent: 'redis', icon: 'lucide:zap' });
    expect(n.prometheus01!.icon).toBe('lucide:activity');
    expect(n.mail_example_com!.parent).toBeUndefined();
    expect(d.nodes.some((x) => x.label === 'ntp_server=ntp.example.com')).toBe(false);
    expect(d.edges).toEqual([]);
    await expectMermaidAccepts(d);
  });

  it('reads a YAML inventory, skipping all/ungrouped and placing shared hosts deepest', async () => {
    const d = parseAnsibleInventory([{ path: 'inventory.yml', content: YAML_INVENTORY }]);
    const n = byId(d);
    expect(n.all).toBeUndefined();
    expect(n.ungrouped).toBeUndefined();
    expect(n.k8s_cluster).toMatchObject({ kind: 'group', icon: 'lucide:boxes' });
    expect(n.kube_control_plane!.parent).toBe('k8s_cluster');
    expect(n.kube_node!.parent).toBe('k8s_cluster');
    // master1 is in kube_control_plane, kube_node (depth 2) and etcd (depth 1): first deepest wins.
    expect(n.master1).toMatchObject({ parent: 'kube_control_plane', label: 'master1 (10.1.0.1)' });
    expect(d.nodes.filter((x) => x.label?.startsWith('master1')).length).toBe(1);
    // etcd ends up empty, so it is not drawn.
    expect(n.etcd).toBeUndefined();
    expect(n.worker2).toMatchObject({ parent: 'kube_node', icon: 'server' });
    expect(n.bastion).toMatchObject({ label: 'bastion (203.0.113.10)' });
    expect(n.bastion!.parent).toBeUndefined();
    expect(n.lonely!.parent).toBeUndefined();
    await expectMermaidAccepts(d);
  });
});

const NOMAD = `# Two-tier app with Consul Connect
job "shop" {
  datacenters = ["dc1", "dc2"]
  type        = "service"

  group "api" {
    count = 3

    network {
      mode = "bridge"
      port "http" { to = 8080 }
    }

    service {
      name = "shop-api"
      port = "http"
      tags = ["web", "v1"]

      connect {
        sidecar_service {
          proxy {
            upstreams {
              destination_name = "shop-db"
              local_bind_port  = 5432
            }
            upstreams {
              destination_name = "shop-cache"
              local_bind_port  = 6379
            }
          }
        }
      }
    }

    task "server" {
      driver = "docker"
      config {
        image = "ghcr.io/acme/shop-api:1.4" // not a real image
        ports = ["http"]
      }
      template {
        data        = <<-EOF
          {{ range service "metrics.collector" }}
          METRICS={{ .Address }}:{{ .Port }}
          {{ end }}
          # a "}" inside a heredoc must not end the block
        EOF
        destination = "local/env"
        env         = true
      }
    }

    task "migrate" {
      driver = "exec"
      lifecycle { hook = "prestart" }
      config {
        command = "/bin/migrate"
        args    = ["--url", "\${NOMAD_UPSTREAM_ADDR_shop_db}"]
      }
    }
  }

  group "db" {
    network { mode = "bridge" }
    service {
      name = "shop-db"
      port = "5432"
      connect { sidecar_service {} }
    }
    task "postgres" {
      driver = "docker"
      config { image = "postgres:16" }
    }
    task "redis" {
      driver = "docker"
      config { image = "redis:7" }
      service { name = "shop-cache" }
    }
  }
}
`;

const METRICS = `job "metrics" {
  group "collector" {
    task "collector" {
      driver = "raw_exec"
      config { command = "otelcol" }
      service { name = "collector" }
    }
  }
}`;

describe('Nomad job import', () => {
  it('parses HCL blocks with strings, comments and heredocs', () => {
    const [job] = parseHclBlocks(NOMAD);
    expect(job).toMatchObject({ type: 'job', labels: ['shop'] });
    expect(job!.blocks.filter((b) => b.type === 'group').map((b) => b.labels[0])).toEqual([
      'api',
      'db',
    ]);
  });

  it('builds job and task-group groups, task services and Connect/template edges', async () => {
    const d = parseNomad([
      { path: 'shop.nomad.hcl', content: NOMAD },
      { path: 'metrics.nomad', content: METRICS },
    ]);
    const n = byId(d);
    expect(n.shop).toMatchObject({ kind: 'group', label: 'shop' });
    expect(n.api).toMatchObject({ kind: 'group', label: 'api ×3', parent: 'shop' });
    expect(n.db).toMatchObject({ kind: 'group', label: 'db', parent: 'shop' });
    expect(n.server).toMatchObject({ kind: 'service', parent: 'api', icon: 'lucide:container' });
    expect(n.migrate).toMatchObject({ parent: 'api', icon: 'server' });
    expect(n.postgres).toMatchObject({ parent: 'db', icon: 'database' });
    expect(n.redis).toMatchObject({ parent: 'db', icon: 'lucide:zap' });
    expect(n.metrics).toMatchObject({ kind: 'group' });
    expect(n.collector).toMatchObject({ kind: 'group', parent: 'metrics' });
    expect(n.collector_collector).toMatchObject({
      kind: 'service',
      parent: 'collector',
      icon: 'server',
    });

    expect(pairs(d)).toEqual(
      [
        // shop-db is a group-level service: every task of the db group provides it.
        'migrate->postgres',
        'migrate->redis',
        'server->postgres',
        'server->redis',
        // shop-cache is registered by the redis task only; already linked above.
        // template lookup of "metrics.collector" -> the collector service.
        'server->collector_collector',
      ].sort(),
    );
    await expectMermaidAccepts(d);
  });

  it('ignores files without jobs', () => {
    expect(parseNomad([{ path: 'x.hcl', content: 'variable "x" { default = 1 }' }]).nodes).toEqual(
      [],
    );
  });
});
