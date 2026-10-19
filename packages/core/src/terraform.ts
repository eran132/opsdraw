import type { ArchEdge, ArchNode, Diagram } from './model';
import { emptyDiagram, makeId } from './model';

/**
 * Best-effort Terraform (HCL) -> architecture diagram.
 *
 * It reads `resource`, `module` and `data` blocks, follows references between them, nests
 * resources inside the networks they reference (VPC/VNet/subnet/resource group), and hides
 * plumbing resources such as IAM policies or route table associations. It does not evaluate HCL.
 *
 * Data sources are only looked up, not drawn, except network-like ones (`data "vsphere_network"`)
 * and datacenter/cluster/host-like ones (`data "vsphere_compute_cluster"`), which become groups,
 * and storage ones (`data "vsphere_datastore"`), which are drawn as disks with `includeAll`.
 *
 * On-prem virtualization and private clouds are handled too: Proxmox VE (bpg/proxmox,
 * Telmate/proxmox), VergeOS, Hyper-V, VirtualBox, VMware vSphere, Xen Orchestra / XCP-ng, Nutanix,
 * oVirt, OpenStack, libvirt/KVM, LXD/Incus, Harvester and Rancher. Hypervisor nodes named by
 * `node_name` / `target_node` become host groups, and bridges/switches become groups inside them;
 * VMs that name a bridge, switch or network (`bridge = "vmbr0"`, `switch_name`, `host_interface`,
 * `network_name`, LXD `properties = { network = "lxdbr0" }`, OpenStack `network { name = "x" }`) are
 * nested in it, because those providers link by name strings rather than by references. Networks
 * that are named but not managed by Terraform still get a group. Ports and profiles (OpenStack
 * ports, LXD/Incus profiles, oVirt vNIC profiles) are hidden, but whatever uses them is nested in
 * the networks they attach to.
 */

export interface TerraformFile {
  path: string;
  content: string;
}

export interface TerraformImportOptions {
  /** Keep plumbing resources (policies, attachments, rules...) as nodes. */
  includeAll?: boolean;
}

interface Block {
  key: string;
  type: string;
  name: string;
  body: string;
  /** A `data` block (data source). */
  data?: boolean;
}

/** Synthetic block type for a hypervisor host (Proxmox node). */
const HOST = 'host';

const GROUP_TYPES =
  /(_vpc|_virtual_network|_compute_network|_subnet|_subnetwork|_resource_group|_network|_distributed_virtual_switch|^ovirt_networks)$/;
const BRIDGE_TYPES =
  /(_linux_bridge|_linux_vlan|_sdn_vnet|_network_switch|_distributed_port_group|_host_port_group|^named_network)$/;
const SUBNET_TYPES = /(_subnet|_subnetwork)$/;
/** Host-like groups: a hypervisor host or a resource pool on it. */
const HOST_TYPES =
  /^(vsphere_host|vsphere_resource_pool|xenorchestra_host|proxmox_virtual_environment_node|ovirt_hosts?)$/;
/** Cluster-like groups: hypervisor clusters and pools, Kubernetes clusters managed by Rancher. */
const CLUSTER_TYPES =
  /^(vsphere_compute_cluster|xenorchestra_pool|nutanix_clusters?|ovirt_clusters?|rancher2_cluster|harvester_clusternetwork)$/;
const DATACENTER_TYPES = /^(vsphere_datacenter|ovirt_datacenters?)$/;
/** Storage data sources, drawn as disks only with `includeAll`. */
const STORAGE_DATA =
  /(datastore|datastore_cluster|_sr|storage_containers?|storagedomains?|storage_pool|storageclass)$/;
/** Attributes naming the hypervisor node a VM or container runs on. */
const HOST_ATTR = /^\s*(?:node_name|target_node)\s*=\s*"([^"$]+)"/m;
/** Attributes naming a bridge or network by its name rather than by reference. */
const BRIDGE_ATTR = /\b(?:bridge|network_name|switch_name|host_interface)\s*=\s*"([^"$]+)"/g;
/** Synthetic block type for a network known only by name (e.g. an unmanaged `vmbr0`). */
const NAMED_NETWORK = 'named_network';
const PLUMBING =
  /(policy|attach|associat|permission|_role|iam_|_rule|_route(?!r)|route_table|_record|_version|_alias|_tag|_key_pair|mapping|_member|_binding|_assignment|_listener|_target_group$|_nic$|_vnic$|download_file|_snippet|cloud_?init|networking_port$|(lxd|incus)_profile$|vnic_profile$|router_interface|machine_config|node_template|cloud_credential|ssh_key|vlanconfig)|^(random|null|local|tls|time|terraform)_/;
/**
 * Hidden resources that something uses to join a network: whatever references them is nested in
 * the networks they reference (`openstack_networking_port_v2`, `lxd_profile`, oVirt vNIC profiles).
 */
const LINK_TYPES = /(networking_port|(lxd|incus)_profile|vnic_profile)$/;

/** Ordered keyword -> icon rules, matched against the resource type. */
const ICON_RULES: [RegExp, string][] = [
  [/rancher2_app|rancher2_catalog|helm_release/, 'lucide:package'],
  [/sfn|step_?functions?|state_?machine/, 'lucide:workflow'],
  [/lambda|function|cloud_run|cloudfunctions|app_service|web_app/, 'lucide:square-function'],
  [/eks|aks|gke|kubernetes|container_cluster|ecs_cluster/, 'lucide:boxes'],
  [
    /ecs_service|ecs_task|(?<!storage_)container|pod|deployment|lxc|(lxd|incus)_instance/,
    'lucide:container',
  ],
  [/elasticache|redis|memcache|cache/, 'lucide:zap'],
  [
    /dynamodb|cosmos|firestore|bigtable|spanner|_db_|rds|sql|database|aurora|postgres|mysql/,
    'database',
  ],
  [/s3_bucket|storage_bucket|storage_account|blob|bucket/, 'lucide:archive'],
  [
    /ebs|disk|volume|drive|vhd|datastore|storage_pool|storagedomain|libvirt_pool|xenorchestra_sr/,
    'disk',
  ],
  [/efs|file_share|filestore/, 'lucide:folder-tree'],
  [/sqs|queue|servicebus/, 'lucide:list-ordered'],
  [/sns|pubsub|eventbridge|event_hub|eventgrid|kinesis|kafka|msk/, 'lucide:radio-tower'],
  [/sfn|step_function|logic_app|workflow/, 'lucide:workflow'],
  [/(^|_)(lb|alb|elb|nlb)(_|$)|load_?balancer|application_gateway|forwarding_rule/, 'lucide:split'],
  [/api_gateway|apigateway|api_management|apigw/, 'lucide:webhook'],
  [/cloudfront|cdn|front_door|route53|dns/, 'lucide:waypoints'],
  [/(^|_)nat(_|$)|gateway|router|vpn/, 'lucide:router'],
  [/waf|firewall|security_group|secgroup|network_security/, 'lucide:shield'],
  [/kms|secret|key_vault|vault/, 'lucide:key-round'],
  [/cognito|identity|iam|active_directory/, 'lucide:fingerprint'],
  [/cloudwatch|monitor|(^|_)logs?(_|$)|logging|log_analytics|insights/, 'lucide:activity'],
  [/vpc|virtual_network|compute_network|subnet|network/, 'lucide:network'],
  [
    /instance|virtual_?machine|machine|compute|vm|server|autoscaling|libvirt_domain|node_pool/,
    'server',
  ],
];

/**
 * `AWS::Lambda::Function` -> `aws_lambda_function aws_lambda_function`, `AWS::RDS::DBInstance` ->
 * `aws_rds_dbinstance aws_rds_db_instance`: both the squashed and the snake_case spelling, so the
 * Terraform-style rules match CloudFormation (and other `Vendor::Service::Type`) names too.
 */
export function normalizeResourceType(type: string): string {
  if (!type.includes('::')) return type.toLowerCase();
  const parts = type.split('::');
  const squashed = parts.map((p) => p.toLowerCase()).join('_');
  const snake = parts
    .map((p) =>
      p
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase(),
    )
    .join('_');
  return squashed === snake ? squashed : `${squashed} ${snake}`;
}

export function iconForResourceType(type: string): string {
  const t = normalizeResourceType(type);
  for (const [re, icon] of ICON_RULES) if (re.test(t)) return icon;
  return 'lucide:box';
}

/** `openstack_networking_network_v2` -> `openstack_networking_network`. */
const baseType = (type: string) => type.replace(/_v\d+$/, '');

/** Containment rank: lower is more specific (subnet/bridge < network < host < cluster < DC). */
function rankOf(type: string): number | undefined {
  const t = baseType(type);
  if (SUBNET_TYPES.test(t) || BRIDGE_TYPES.test(t)) return 0;
  if (t === HOST || HOST_TYPES.test(t)) return 2;
  if (CLUSTER_TYPES.test(t)) return 3;
  if (DATACENTER_TYPES.test(t)) return 4;
  if (GROUP_TYPES.test(t) && !/(_peering|_interface)/.test(t)) return 1;
  return undefined;
}

const isGroupType = (type: string) => rankOf(type) !== undefined;

function groupIcon(type: string): string {
  const t = baseType(type);
  if (t === HOST || HOST_TYPES.test(t)) return 'lucide:server-cog';
  if (DATACENTER_TYPES.test(t)) return 'lucide:building-2';
  if (CLUSTER_TYPES.test(t) && !/network/.test(t)) return 'lucide:boxes';
  return 'lucide:network';
}

/** The name a block has in the platform (`name`, Xen Orchestra `name_label`, ...). */
const nameAttr = (b: Block) =>
  /^\s*(?:name|name_label|subnet_name|cluster_name)\s*=\s*"([^"$]+)"/m.exec(b.body)?.[1];

export function parseTerraform(
  files: TerraformFile[],
  options: TerraformImportOptions = {},
): Diagram {
  const blocks = files.flatMap((f) => extractBlocks(stripComments(f.content)));
  const byKey = new Map(blocks.map((b) => [b.key, b]));
  const refsOf = new Map(blocks.map((b) => [b.key, findRefs(b.body, byKey, b.key)]));
  addNameReferences(blocks, byKey, refsOf);

  const isGroup = (b: Block) => isGroupType(b.type);
  const isShown = (b: Block) =>
    isGroup(b) ||
    (b.data
      ? !!options.includeAll && STORAGE_DATA.test(baseType(b.type))
      : options.includeAll || !PLUMBING.test(baseType(b.type)));
  const kept = blocks.filter(isShown);
  const keptKeys = new Set(kept.map((b) => b.key));
  const rank = (key: string) => rankOf(byKey.get(key)!.type) ?? -1;

  // Hidden ports/profiles: what uses them joins the networks they attach to.
  const linkedGroups = (key: string, seen = new Set<string>()): string[] => {
    if (seen.has(key)) return [];
    seen.add(key);
    const out: string[] = [];
    for (const r of refsOf.get(key) ?? []) {
      const rb = byKey.get(r)!;
      if (keptKeys.has(r) && isGroup(rb)) out.push(r);
      else if (!keptKeys.has(r) && !rb.data && LINK_TYPES.test(baseType(rb.type)))
        out.push(...linkedGroups(r, seen));
    }
    return out;
  };
  for (const b of kept) {
    if (isGroup(b)) continue;
    const refs = refsOf.get(b.key)!;
    for (const r of [...refs]) {
      const rb = byKey.get(r)!;
      if (!keptKeys.has(r) && !rb.data && LINK_TYPES.test(baseType(rb.type)))
        for (const g of linkedGroups(r)) refs.add(g);
    }
  }

  const diagram = emptyDiagram();
  const ids = new Map<string, string>();
  const nameCounts = new Map<string, number>();
  for (const b of kept) nameCounts.set(b.name, (nameCounts.get(b.name) ?? 0) + 1);
  for (const b of kept) {
    // Short ids when names are unique; type-qualified when two resources share a name.
    const base = nameCounts.get(b.name) === 1 ? b.name : `${b.type}_${b.name}`;
    ids.set(b.key, makeId(base, ids.values()));
  }

  const nodeOf = new Map<string, ArchNode>();
  for (const b of kept) {
    const node: ArchNode = {
      id: ids.get(b.key)!,
      kind: isGroup(b) ? 'group' : 'service',
      label: b.type === 'module' ? `${b.name} (module)` : b.data ? (nameAttr(b) ?? b.name) : b.name,
      icon: isGroup(b) ? groupIcon(b.type) : b.type === 'module' ? 'lucide:package' : iconOf(b),
    };
    const parent = pickParent(b);
    if (parent) node.parent = ids.get(parent);
    diagram.nodes.push(node);
    nodeOf.set(b.key, node);
  }

  const seen = new Set<string>();
  const addEdge = (a: string, z: string) => {
    if (a === z) return;
    const [x, y] = [ids.get(a)!, ids.get(z)!];
    const key = [x, y].sort().join('|');
    if (seen.has(key)) return;
    seen.add(key);
    const e: ArchEdge = { from: x, to: y, fromSide: 'R', toSide: 'L', arrowEnd: true };
    diagram.edges.push(e);
  };

  // Rancher machine pools are nested blocks of the cluster; draw each as a node inside it.
  for (const b of kept) {
    if (baseType(b.type) !== 'rancher2_cluster') continue;
    for (const pool of subBlocks(b.body, 'machine_pools')) {
      const poolName = /^\s*name\s*=\s*"([^"$]+)"/m.exec(pool)?.[1];
      if (!poolName) continue;
      const key = `${b.key}#${poolName}`;
      const id = makeId(`${b.name}_${poolName}`, ids.values());
      ids.set(key, id);
      const node: ArchNode = {
        id,
        kind: 'service',
        label: poolName,
        icon: 'server',
        parent: ids.get(b.key),
      };
      diagram.nodes.push(node);
      nodeOf.set(key, node);
      for (const r of findRefs(pool, byKey, b.key)) if (keptKeys.has(r)) addEdge(key, r);
    }
  }

  for (const b of blocks) {
    const refs = [...(refsOf.get(b.key) ?? [])].filter((r) => keptKeys.has(r));
    if (keptKeys.has(b.key)) {
      if (isGroup(byKey.get(b.key)!)) continue;
      // Containment is shown by nesting, so skip edges to the node's own networks.
      const containers = containersOf(b);
      for (const r of refs) if (!containers.has(r) && !isGroup(byKey.get(r)!)) addEdge(b.key, r);
    } else if (!b.data) {
      // A hidden "connector" resource (e.g. an event source mapping) links what it references.
      const services = refs.filter((r) => !isGroup(byKey.get(r)!));
      for (let i = 1; i < services.length; i++) addEdge(services[i]!, services[0]!);
    }
  }
  // A hidden NIC-like resource that joins services to one network places them inside it
  // (VergeOS `vergeio_nic`, oVirt `ovirt_vnic`, for example), unless they already sit in a more
  // specific group.
  for (const b of blocks) {
    if (keptKeys.has(b.key) || b.data || LINK_TYPES.test(baseType(b.type))) continue;
    const refs = [...(refsOf.get(b.key) ?? [])].filter((r) => keptKeys.has(r));
    const groups = [...new Set(linkedGroups(b.key))];
    if (groups.length !== 1) continue;
    for (const r of refs) {
      if (/secgroup|security_group|firewall/.test(byKey.get(r)!.type)) continue;
      const node = nodeOf.get(r);
      const current = node?.parent && [...ids].find(([, id]) => id === node.parent)?.[0];
      if (node && node.kind === 'service' && (!current || rank(current) >= 2))
        node.parent = ids.get(groups[0]!);
    }
  }
  refineGroups();
  return diagram;

  function iconOf(b: Block): string {
    if (/^(lxd|incus)_instance$/.test(b.type))
      return /^\s*type\s*=\s*"virtual-machine"/m.test(b.body) ? 'server' : 'lucide:container';
    return iconForResourceType(b.type);
  }

  function containersOf(b: Block): Set<string> {
    const out = new Set<string>();
    for (let p = pickParent(b); p; p = pickParent(byKey.get(p)!)) {
      if (out.has(p)) break;
      out.add(p);
    }
    return out;
  }

  function pickParent(b: Block): string | undefined {
    const groups = [...(refsOf.get(b.key) ?? [])]
      .map((r) => byKey.get(r)!)
      .filter((r) => keptKeys.has(r.key) && isGroup(r) && r.key !== b.key);
    // Prefer the most specific container: subnet or bridge, then network, host, cluster, DC.
    return groups.sort((x, y) => rank(x.key) - rank(y.key))[0]?.key;
  }

  /**
   * A network that only references its datacenter (vSphere port groups, for example) moves into
   * the cluster or host inside that datacenter when every VM in it runs there.
   */
  function refineGroups() {
    const keyOfId = new Map([...ids].map(([k, id]) => [id, k]));
    const parentKey = (key: string) => {
      const p = nodeOf.get(key)?.parent;
      return p ? keyOfId.get(p) : undefined;
    };
    const ancestors = (key: string) => {
      const out: string[] = [];
      for (let p = parentKey(key); p && !out.includes(p); p = parentKey(p)) out.push(p);
      return out;
    };
    const groups = kept.filter(isGroup).sort((x, y) => rank(x.key) - rank(y.key));
    for (const g of groups) {
      const services = [...nodeOf].filter(
        ([k, n]) => n.kind === 'service' && ancestors(k).includes(g.key),
      );
      if (services.length === 0) continue;
      let common: string[] | undefined;
      for (const [k] of services) {
        const refs = [...(refsOf.get(k) ?? [])].filter(
          (r) => keptKeys.has(r) && isGroup(byKey.get(r)!) && rank(r) > rank(g.key),
        );
        common = common ? common.filter((c) => refs.includes(c)) : refs;
      }
      const current = parentKey(g.key);
      const above = ancestors(g.key);
      const target = (common ?? [])
        .filter((c) => !above.includes(c) && !ancestors(c).includes(g.key))
        .filter((c) => !current || ancestors(c).includes(current))
        .sort((x, y) => rank(x) - rank(y))[0];
      if (target) nodeOf.get(g.key)!.parent = ids.get(target);
    }
  }
}

/**
 * Adds references expressed as names: a synthetic host block per `node_name`/`target_node`, and a
 * bridge/switch/network reference (`bridge = "vmbr0"`) pointing at the managed resource with that
 * name on the same host, or at a synthetic network group when Terraform doesn't manage it.
 */
function addNameReferences(
  blocks: Block[],
  byKey: Map<string, Block>,
  refsOf: Map<string, Set<string>>,
) {
  const hostOf = (b: Block) => HOST_ATTR.exec(b.body)?.[1];
  const isHostBlock = (b: Block) => HOST_TYPES.test(baseType(b.type));
  const managed = blocks.filter((b) => {
    const r = rankOf(b.type);
    return r === 0 || r === 1;
  });
  const nameOf = (b: Block) => nameAttr(b) ?? b.name;
  const namesOf = (b: Block) => {
    const ns = /^\s*namespace\s*=\s*"([^"$]+)"/m.exec(b.body)?.[1];
    return ns ? [nameOf(b), `${ns}/${nameOf(b)}`] : [nameOf(b)];
  };
  // Data sources for a host (`data "proxmox_virtual_environment_node"`) stand in for its group.
  const hostBlocks = new Map<string, string>();
  for (const b of blocks) {
    const host = isHostBlock(b) ? hostOf(b) : undefined;
    if (host) hostBlocks.set(host, b.key);
  }
  const synth = (key: string, type: string, name: string, parent?: string) => {
    if (!byKey.has(key)) {
      const block = { key, type, name, body: '' };
      blocks.push(block);
      byKey.set(key, block);
      refsOf.set(key, new Set(parent ? [parent] : []));
    }
    return key;
  };
  const profiles = blocks.filter((b) => /^(lxd|incus)_profile$/.test(b.type));
  for (const b of [...blocks]) {
    if (isHostBlock(b)) continue;
    const host = hostOf(b);
    const hostKey = host
      ? (hostBlocks.get(host) ?? synth(`${HOST}.${host}`, HOST, host))
      : undefined;
    if (hostKey) refsOf.get(b.key)!.add(hostKey);
    if (b.data || rankOf(b.type) === 0) continue;
    for (const name of networkNames(b)) {
      const named = managed.filter((br) => namesOf(br).includes(name));
      const match = named.find((br) => hostOf(br) === host) ?? named[0];
      // Bridges like vmbr0 exist on every Proxmox node, so unmanaged ones are scoped per host.
      const key =
        match?.key ??
        synth(`${NAMED_NETWORK}.${host ? `${host}/` : ''}${name}`, NAMED_NETWORK, name, hostKey);
      if (key !== b.key) refsOf.get(b.key)!.add(key);
    }
    // LXD/Incus instances name their profiles: `profiles = ["default", "web"]`.
    const list = /\bprofiles\s*=\s*\[([^\]]*)\]/.exec(b.body)?.[1];
    for (const m of list?.matchAll(/"([^"$]+)"/g) ?? []) {
      const p = profiles.find((pr) => nameOf(pr) === m[1] && pr.key !== b.key);
      if (p) refsOf.get(b.key)!.add(p.key);
    }
  }
}

/** Networks a block names by string rather than by reference. */
function networkNames(b: Block): string[] {
  const out = [...b.body.matchAll(BRIDGE_ATTR)].map((m) => m[1]!);
  // LXD/Incus NIC devices: `properties = { network = "lxdbr0" }` or `nictype` + `parent`.
  for (const m of b.body.matchAll(/\bproperties\s*=\s*\{([^{}]*)\}/g)) {
    const props = m[1]!;
    const net = /\bnetwork\s*=\s*"([^"$]+)"/.exec(props)?.[1];
    const parent = /\bnictype\b/.test(props)
      ? /\bparent\s*=\s*"([^"$]+)"/.exec(props)?.[1]
      : undefined;
    if (net) out.push(net);
    else if (parent) out.push(parent);
  }
  // libvirt (v0.9+): `source = { network = { network = "default" } }`.
  for (const m of b.body.matchAll(/\bnetwork\s*=\s*\{[^{}]*?\bnetwork\s*=\s*"([^"$]+)"/g))
    out.push(m[1]!);
  // OpenStack: `network { name = "private" }`.
  if (/^openstack_compute_instance/.test(b.type))
    for (const m of b.body.matchAll(/\bnetwork\s*\{([^{}]*)\}/g)) {
      const name = /\bname\s*=\s*"([^"$]+)"/.exec(m[1]!)?.[1];
      if (name) out.push(name);
    }
  return [...new Set(out)];
}

function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < src.length) {
    const c = src[i]!;
    if (inString) {
      out += c;
      if (c === '\\') out += src[++i] ?? '';
      else if (c === '"') inString = false;
      i++;
    } else if (c === '"') {
      inString = true;
      out += c;
      i++;
    } else if (c === '#' || (c === '/' && src[i + 1] === '/')) {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The body of the block whose `{` is just before `start`. */
function blockBody(src: string, start: number): string {
  let depth = 1;
  let i = start;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
  }
  return src.slice(start, i - 1);
}

/** Bodies of nested blocks named `name` (`machine_pools { ... }`), at any depth. */
function subBlocks(body: string, name: string): string[] {
  const re = new RegExp(`\\b${name}\\s*\\{`, 'g');
  return [...body.matchAll(re)].map((m) => blockBody(body, m.index + m[0].length));
}

function extractBlocks(src: string): Block[] {
  const out: Block[] = [];
  const re = /^\s*(resource|module|data)\s+"([^"]+)"(?:\s+"([^"]+)")?\s*\{/gm;
  for (const m of src.matchAll(re)) {
    const body = blockBody(src, m.index + m[0].length);
    if (m[1] === 'module') out.push({ key: `module.${m[2]}`, type: 'module', name: m[2]!, body });
    else if (m[1] === 'data' && m[3])
      out.push({ key: `data.${m[2]}.${m[3]}`, type: m[2]!, name: m[3], body, data: true });
    else if (m[3]) out.push({ key: `${m[2]}.${m[3]}`, type: m[2]!, name: m[3], body });
  }
  return out;
}

function findRefs(body: string, known: Map<string, Block>, self: string): Set<string> {
  const refs = new Set<string>();
  for (const m of body.matchAll(
    /\b(data\.)?(module|[a-z][a-z0-9]*_[a-z0-9_]+)\.([A-Za-z_][\w-]*)/g,
  )) {
    const key = `${m[1] ?? ''}${m[2]}.${m[3]}`;
    if (key !== self && known.has(key)) refs.add(key);
  }
  return refs;
}
