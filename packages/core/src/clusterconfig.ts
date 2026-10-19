import type { ArchNode, Diagram } from './model';
import { emptyDiagram, makeId } from './model';
import type { IacFile, IacImportOptions } from './iac-shared';
import { asArray, asString, edgeAdder, isRecord, loadYamlDocuments } from './iac-shared';

/**
 * Cluster topology files -> architecture diagram.
 *
 * - k0sctl (`apiVersion: k0sctl.k0sproject.io/...`, `kind: Cluster`): one group per cluster, its
 *   `spec.hosts[]` split into "Control plane" and "Workers" subgroups.
 * - Talos machine configs (`machine.type: controlplane|worker|init`, from `talosctl gen config`):
 *   one node per config, grouped by `cluster.clusterName`, with the `cluster.controlPlane.endpoint`
 *   as a node in front of the control plane.
 * - RKE2 / k3s per-node `config.yaml`: one node per file in a single cluster group; nodes that join
 *   through `server: https://...` link to that registration address, which fronts the servers.
 *
 * Unknown fields are ignored and odd documents are skipped, so a partial diagram comes back rather
 * than an exception.
 */

export type ClusterConfigOptions = IacImportOptions;

export type ClusterConfigFlavor = 'k0sctl' | 'talos' | 'rke2';

type Role = 'controlplane' | 'worker';

interface HostSpec {
  label: string;
  role: Role;
  /** Registration / API URL this host joins through, when it is not the first server. */
  joins?: string;
}

interface ClusterSpec {
  flavor: ClusterConfigFlavor;
  /** Key used to merge clusters that span several files. */
  key: string;
  label: string;
  hosts: HostSpec[];
  /** API endpoint / registration URL in front of the control plane. */
  endpoints: string[];
}

const K0SCTL_RE = /(^|\n)\s*["']?apiVersion["']?\s*:\s*["']?k0sctl\.k0sproject\.io\//;
const TALOS_MACHINE_RE = /(^|\n)["']?machine["']?\s*:/;
const TALOS_TYPE_RE = /(^|\n)\s+["']?type["']?\s*:\s*["']?(controlplane|worker|init)\b/;
const RKE2_KEYS_RE =
  /(^|\n)["']?(cluster-init|tls-san|node-name|node-label|node-taint|node-ip|write-kubeconfig-mode|agent-token|etcd-snapshot-schedule-cron|disable-cloud-controller)["']?\s*:/;
const RKE2_SERVER_RE = /(^|\n)["']?server["']?\s*:\s*["']?https?:\/\/[^\s"']+:(6443|9345)\b/;

/** Keys only a server (control-plane) node of RKE2 / k3s sets. */
const RKE2_SERVER_KEYS = [
  'cluster-init',
  'tls-san',
  'write-kubeconfig-mode',
  'write-kubeconfig',
  'cluster-cidr',
  'service-cidr',
  'cluster-dns',
  'cluster-domain',
  'cni',
  'disable',
  'disable-cloud-controller',
  'disable-kube-proxy',
  'disable-scheduler',
  'disable-apiserver',
  'disable-etcd',
  'disable-controller-manager',
  'etcd-expose-metrics',
  'etcd-snapshot-schedule-cron',
  'etcd-snapshot-retention',
  'agent-token',
  'kube-apiserver-arg',
  'kube-controller-manager-arg',
  'kube-scheduler-arg',
  'flannel-backend',
  'datastore-endpoint',
];
/** Keys that only appear in RKE2 / k3s node configs (not in other YAML formats we import). */
const RKE2_MARKERS = [
  'cluster-init',
  'tls-san',
  'node-name',
  'node-label',
  'node-taint',
  'node-ip',
  'node-external-ip',
  'write-kubeconfig-mode',
  'agent-token',
  'etcd-snapshot-schedule-cron',
  'disable-cloud-controller',
  'selinux',
  'profile',
  'kubelet-arg',
];

/** Guesses whether one file is a cluster topology config, and which kind. */
export function detectClusterConfig(path: string, content: string): ClusterConfigFlavor | null {
  if (/\.(tf|tf\.json|tfvars|hcl|md|txt|ts|js|py)$/i.test(path)) return null;
  if (K0SCTL_RE.test(content)) return 'k0sctl';
  if (TALOS_MACHINE_RE.test(content) && TALOS_TYPE_RE.test(content)) return 'talos';
  if (
    !/(^|\n)["']?(apiVersion|kind|services|resources|Resources)["']?\s*:/.test(content) &&
    (RKE2_SERVER_RE.test(content) || RKE2_KEYS_RE.test(content))
  )
    return 'rke2';
  return null;
}

export function parseClusterConfig(files: IacFile[], options: ClusterConfigOptions = {}): Diagram {
  void options;
  const clusters: ClusterSpec[] = [];
  const clusterFor = (flavor: ClusterConfigFlavor, key: string, label: string): ClusterSpec => {
    let c = clusters.find((x) => x.flavor === flavor && x.key === key);
    if (!c) {
      c = { flavor, key, label, hosts: [], endpoints: [] };
      clusters.push(c);
    }
    return c;
  };

  for (const file of files) {
    let docs: unknown[];
    try {
      docs = loadYamlDocuments(file.content);
    } catch {
      continue;
    }
    try {
      readK0sctl(docs, clusterFor);
      readTalos(file, docs, clusterFor);
      readRke2(file, docs, clusterFor);
    } catch {
      // Keep whatever was collected so far.
    }
  }
  return buildDiagram(clusters);
}

type ClusterFor = (flavor: ClusterConfigFlavor, key: string, label: string) => ClusterSpec;

function readK0sctl(docs: unknown[], clusterFor: ClusterFor) {
  for (const doc of docs) {
    if (!isRecord(doc) || !/^k0sctl\.k0sproject\.io\//.test(asString(doc.apiVersion) ?? ''))
      continue;
    if (asString(doc.kind) !== 'Cluster') continue;
    const meta = isRecord(doc.metadata) ? doc.metadata : {};
    const name = asString(meta.name) ?? 'k0s-cluster';
    const cluster = clusterFor('k0sctl', name, name);
    const spec = isRecord(doc.spec) ? doc.spec : {};
    asArray(spec.hosts).forEach((h, i) => {
      if (!isRecord(h)) return;
      const ssh = isRecord(h.ssh) ? h.ssh : isRecord(h.winRM) ? h.winRM : {};
      const label =
        asString(ssh.address) ??
        asString(h.hostname) ??
        (isRecord(h.openSSH) ? asString(h.openSSH.address) : undefined) ??
        `host ${i + 1}`;
      const role = (asString(h.role) ?? 'worker').toLowerCase();
      cluster.hosts.push({
        label,
        role: role.startsWith('controller') || role === 'single' ? 'controlplane' : 'worker',
      });
    });
    // spec.k0s.config is a k0s ClusterConfig; its API external address fronts the controllers.
    const k0s = isRecord(spec.k0s) ? spec.k0s : {};
    const cfg = isRecord(k0s.config) ? k0s.config : {};
    const cfgSpec = isRecord(cfg.spec) ? cfg.spec : {};
    const api = isRecord(cfgSpec.api) ? cfgSpec.api : {};
    const ext = asString(api.externalAddress);
    if (ext && !cluster.endpoints.includes(ext)) cluster.endpoints.push(ext);
  }
}

function readTalos(file: IacFile, docs: unknown[], clusterFor: ClusterFor) {
  // Talos 1.12+ multi-doc configs move the hostname into a `kind: HostnameConfig` document.
  let hostnameDoc: string | undefined;
  for (const doc of docs) {
    if (isRecord(doc) && asString(doc.kind) === 'HostnameConfig')
      hostnameDoc = asString(doc.hostname);
  }
  const machines = docs.filter(
    (d): d is Record<string, unknown> =>
      isRecord(d) && isRecord(d.machine) && typeof d.machine.type === 'string',
  );
  machines.forEach((doc, i) => {
    const machine = doc.machine as Record<string, unknown>;
    const type = (asString(machine.type) ?? '').toLowerCase();
    if (!['controlplane', 'worker', 'init'].includes(type)) return;
    const cl = isRecord(doc.cluster) ? doc.cluster : {};
    const clusterName = asString(cl.clusterName) ?? 'talos';
    const cluster = clusterFor('talos', clusterName, clusterName);
    const cp = isRecord(cl.controlPlane) ? cl.controlPlane : {};
    const endpoint = asString(cp.endpoint);
    if (endpoint && !cluster.endpoints.includes(endpoint)) cluster.endpoints.push(endpoint);

    const network = isRecord(machine.network) ? machine.network : {};
    let address: string | undefined;
    for (const iface of asArray(network.interfaces)) {
      if (!isRecord(iface)) continue;
      address = asString(asArray(iface.addresses)[0]);
      if (address) break;
    }
    const fallback = fileLabel(file.path);
    const label =
      asString(network.hostname) ??
      (machines.length === 1 ? hostnameDoc : undefined) ??
      address?.replace(/\/\d+$/, '') ??
      (machines.length > 1 ? `${fallback} ${i + 1}` : fallback);
    const role: Role = type === 'worker' ? 'worker' : 'controlplane';
    cluster.hosts.push({ label, role, joins: role === 'worker' ? endpoint : undefined });
  });
}

function readRke2(file: IacFile, docs: unknown[], clusterFor: ClusterFor) {
  for (const doc of docs) {
    if (!isRecord(doc) || 'apiVersion' in doc || 'kind' in doc || 'machine' in doc) continue;
    const server = asString(doc.server);
    const serverUrl = server && /^https?:\/\//.test(server) ? server : undefined;
    const hasMarker = RKE2_MARKERS.some((k) => k in doc);
    if (!hasMarker && !(serverUrl && /:(6443|9345)\b/.test(serverUrl))) continue;

    const isRke2 =
      /rke2/i.test(file.path) ||
      (serverUrl !== undefined && /:9345\b/.test(serverUrl)) ||
      'profile' in doc;
    const cluster = clusterFor('rke2', 'rke2', 'k3s cluster');
    if (isRke2) cluster.label = 'RKE2 cluster';

    const pathRole = /agent|worker/i.test(file.path)
      ? 'worker'
      : /server|control|master/i.test(file.path)
        ? 'controlplane'
        : undefined;
    const serverOnly = RKE2_SERVER_KEYS.some((k) => k in doc);
    const role: Role =
      !serverUrl || doc['cluster-init'] === true || serverOnly
        ? 'controlplane'
        : (pathRole ?? 'worker');

    const label =
      asString(doc['node-name']) ??
      asString(firstOf(doc['node-ip'])) ??
      asString(firstOf(doc['node-external-ip'])) ??
      fileLabel(file.path);
    cluster.hosts.push({ label, role, joins: serverUrl });
    if (serverUrl && !cluster.endpoints.includes(serverUrl)) cluster.endpoints.push(serverUrl);
  }
}

const firstOf = (v: unknown): unknown =>
  Array.isArray(v) ? v[0] : typeof v === 'string' ? v.split(',')[0] : v;

/** A readable name for a file: its basename, or its directory for generic names like config.yaml. */
function fileLabel(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  const base = (parts[parts.length - 1] ?? 'node').replace(/\.(ya?ml|json)$/i, '');
  if (/^(config|machine|node)$/i.test(base) && parts.length > 1) return parts[parts.length - 2]!;
  return base;
}

function buildDiagram(clusters: ClusterSpec[]): Diagram {
  const diagram = emptyDiagram();
  const taken: string[] = [];
  const addEdge = edgeAdder(diagram);
  const add = (base: string, node: Omit<ArchNode, 'id'>): string => {
    const id = makeId(base, taken);
    taken.push(id);
    diagram.nodes.push({ id, ...node });
    return id;
  };

  for (const c of clusters) {
    if (!c.hosts.length && !c.endpoints.length) continue;
    const groupId = add(`cluster_${c.key}`, {
      kind: 'group',
      label: c.label,
      icon: 'lucide:boxes',
    });
    const controllers = c.hosts.filter((h) => h.role === 'controlplane');
    const workers = c.hosts.filter((h) => h.role === 'worker');

    const endpointIds = new Map<string, string>();
    for (const url of c.endpoints) {
      endpointIds.set(
        url,
        add(`endpoint_${hostOf(url)}`, {
          kind: 'service',
          label: url,
          icon: 'lucide:split',
          parent: groupId,
        }),
      );
    }

    const hostIds = new Map<HostSpec, string>();
    const subgroup = (hosts: HostSpec[], base: string, label: string, icon: string) => {
      if (!hosts.length) return;
      const parent = add(`${c.key}_${base}`, { kind: 'group', label, icon, parent: groupId });
      for (const h of hosts) {
        hostIds.set(
          h,
          // Ids from bare IPs would lose their leading digits; prefix them instead.
          add(/^[a-z_]/i.test(h.label) ? h.label : `node_${h.label}`, {
            kind: 'service',
            label: h.label,
            icon: h.role === 'controlplane' ? 'lucide:server-cog' : 'server',
            parent,
          }),
        );
      }
    };
    subgroup(controllers, 'control_plane', 'Control plane', 'lucide:server-cog');
    subgroup(workers, 'workers', 'Workers', 'server');

    // Endpoint -> the control plane it fronts (first servers, not ones that join through it).
    for (const endpointId of endpointIds.values()) {
      for (const h of controllers) if (!h.joins) addEdge(endpointId, hostIds.get(h)!);
    }
    // Nodes that join through an address link to it.
    for (const h of c.hosts) {
      const target = h.joins ? endpointIds.get(h.joins) : undefined;
      if (target) addEdge(hostIds.get(h)!, target);
    }
  }
  return diagram;
}

function hostOf(url: string): string {
  const m = /^(?:[a-z]+:\/\/)?(\[[^\]]+\]|[^/:]+)/i.exec(url);
  return m?.[1] ?? url;
}
