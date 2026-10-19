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
  /** Key prefix of the module instance the block belongs to (`module.vpc.`); empty at the root. */
  scope?: string;
  /** Key of the module group the block is drawn in, when it comes from a local module. */
  module?: string;
  /** A module call whose source is among the files: drawn as a group of its resources. */
  moduleGroup?: boolean;
}

export interface TerraformImportResult {
  diagram: Diagram;
  /** Things the importer could not draw faithfully (missing module sources, unknown types...). */
  warnings: string[];
}

/** Files read as HCL when collecting a module directory (OpenTofu `.tofu` files included). */
const HCL_FILE = /\.(tf|tofu)$/i;

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

/** Resources hidden by default: policies, attachments, rules, records, helper providers... */
export function isPlumbingType(type: string): boolean {
  return PLUMBING.test(baseType(normalizeResourceType(type)));
}

/**
 * Resources drawn as containment groups: networks, subnets, bridges and switches, resource groups,
 * hypervisor hosts, clusters and datacenters.
 */
export function isNetworkGroupType(type: string): boolean {
  return isGroupType(type.toLowerCase());
}

/** ` ×3`, ` ×N` or ` (for_each)` for a block with `count` / `for_each`; empty when conditional. */
function multiplicity(body: string): string {
  const top = topLevel(body);
  if (/^\s*for_each\s*=/m.test(top)) return ' (for_each)';
  const count = /^\s*count\s*=\s*([^\n]+)/m.exec(top)?.[1]?.trim().replace(/,$/, '');
  if (!count || count.includes('?')) return '';
  if (/^\d+$/.test(count)) return Number(count) > 1 ? ` ×${Number(count)}` : '';
  return ' ×N';
}

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
  return parseTerraformWithWarnings(files, options).diagram;
}

/**
 * Like {@link parseTerraform}, and also reports what could not be drawn faithfully.
 *
 * Local modules (`source = "./modules/vpc"`) whose files are among `files` are drawn as groups of
 * their resources, recursively; `module.vpc.<output>` references resolve through the module's
 * `output` blocks to the resource they name. Remote modules become a single node, unless
 * `.terraform/modules/modules.json` is among the files and maps them to a directory that is.
 */
export function parseTerraformWithWarnings(
  files: TerraformFile[],
  options: TerraformImportOptions = {},
): TerraformImportResult {
  const warnings: string[] = [];
  const warn = (w: string) => {
    if (!warnings.includes(w)) warnings.push(w);
  };
  const { blocks, outputs, expanded } = loadModules(files, warn);
  const byKey = new Map(blocks.map((b) => [b.key, b]));
  const ctx: RefContext = { byKey, outputs, expanded, warn };
  const refsOf = new Map(
    blocks.map((b) => [
      b.key,
      // A module group's inputs would nest it by what it is given; only its contents place it.
      b.moduleGroup ? new Set<string>() : findRefs(b.body, ctx, b.key, b.scope),
    ]),
  );
  addNameReferences(blocks, byKey, refsOf);

  const isGroup = (b: Block) => !!b.moduleGroup || isGroupType(b.type);
  const isShown = (b: Block) =>
    isGroup(b) ||
    (b.data
      ? !!options.includeAll && STORAGE_DATA.test(baseType(b.type))
      : options.includeAll || !PLUMBING.test(baseType(b.type)));
  const kept = blocks.filter(isShown);
  const keptKeys = new Set(kept.map((b) => b.key));
  // Module groups are the outermost containers of what they hold.
  const rank = (key: string) => {
    const b = byKey.get(key)!;
    return b.moduleGroup ? 10 : (rankOf(b.type) ?? -1);
  };

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
  const scopedName = (b: Block) => `${b.scope ?? ''}|${b.name}`;
  for (const b of kept) nameCounts.set(scopedName(b), (nameCounts.get(scopedName(b)) ?? 0) + 1);
  // Root resources get the shortest ids; module contents are prefixed by their module's name.
  const depth = (b: Block) => (b.scope ?? '').split('module.').length;
  for (const b of [...kept].sort((x, y) => depth(x) - depth(y))) {
    // Short ids when names are unique; type-qualified when two resources share a name.
    const own = nameCounts.get(scopedName(b)) === 1 ? b.name : `${b.type}_${b.name}`;
    const owner = b.module ? byKey.get(b.module)?.name : undefined;
    ids.set(b.key, makeId(owner ? `${owner}_${own}` : own, ids.values()));
  }

  const nodeOf = new Map<string, ArchNode>();
  for (const b of kept) {
    const label = b.moduleGroup
      ? `${b.name}${multiplicity(b.body)}`
      : b.type === 'module'
        ? `${b.name}${multiplicity(b.body)} (module)`
        : b.data
          ? (nameAttr(b) ?? b.name)
          : `${b.name}${multiplicity(b.body)}`;
    const node: ArchNode = {
      id: ids.get(b.key)!,
      kind: isGroup(b) ? 'group' : 'service',
      label,
      icon:
        b.moduleGroup || b.type === 'module'
          ? 'lucide:package'
          : isGroup(b)
            ? groupIcon(b.type)
            : iconOf(b),
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
      for (const r of findRefs(pool, ctx, b.key, b.scope)) if (keptKeys.has(r)) addEdge(key, r);
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
  const unknown = kept.filter(
    (b) => !isGroup(b) && !b.data && b.type !== 'module' && iconOf(b) === 'lucide:box',
  ).length;
  if (unknown)
    warn(
      `${unknown} ${unknown === 1 ? 'resource' : 'resources'} of unknown type shown with a generic icon`,
    );
  return { diagram, warnings };

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
    const best = groups.sort((x, y) => rank(x.key) - rank(y.key))[0]?.key;
    // Otherwise inside the module it comes from.
    return best ?? (b.module && keptKeys.has(b.module) ? b.module : undefined);
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
    const groups = kept
      .filter((g) => isGroup(g) && !g.moduleGroup)
      .sort((x, y) => rank(x.key) - rank(y.key));
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

/** Index just after the quoted string opening at `i`, honoring `${ ... }` nesting. */
function skipString(src: string, i: number): number {
  i++;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\\') i += 2;
    else if (c === '"') return i + 1;
    // `$${` and `%%{` are escapes for a literal `${` / `%{`.
    else if ((c === '$' || c === '%') && src[i + 1] === c) i += 2;
    else if ((c === '$' || c === '%') && src[i + 1] === '{') i = skipInterpolation(src, i + 2);
    // Quoted strings end at the line; an unterminated one must not swallow the file.
    else if (c === '\n') return i;
    else i++;
  }
  return i;
}

/** Index just after the `}` closing an interpolation whose body starts at `i`. */
function skipInterpolation(src: string, i: number): number {
  let depth = 1;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '"') {
      i = skipString(src, i);
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
    i++;
  }
  return i;
}

/** The text of the interpolations in a heredoc, without braces or quotes, so refs survive. */
function heredocRefs(body: string): string {
  const out: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if ((c === '$' || c === '%') && body[i + 1] === c) i++;
    else if ((c === '$' || c === '%') && body[i + 1] === '{') {
      const end = skipInterpolation(body, i + 2);
      out.push(body.slice(i + 2, end - 1).replace(/[{}"\\\r\n]/g, ' '));
      i = end - 1;
    }
  }
  return out.join(' ');
}

const HEREDOC = /<<-?([A-Za-z_][\w-]*)[ \t]*\r?\n/y;

/**
 * Drops comments and turns heredocs into one-line strings that keep only their interpolations, so
 * braces in comments, heredocs and strings cannot unbalance block matching.
 */
function cleanSource(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '"') {
      const end = skipString(src, i);
      out += src.slice(i, end);
      i = end;
    } else if (c === '#' || (c === '/' && src[i + 1] === '/')) {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
    } else if (c === '<' && src[i + 1] === '<' && ((HEREDOC.lastIndex = i), HEREDOC.test(src))) {
      const start = HEREDOC.lastIndex;
      const id = /<<-?([A-Za-z_][\w-]*)/.exec(src.slice(i))![1]!;
      const close = new RegExp(`^[ \\t]*${id}[ \\t]*\\r?$`, 'gm');
      close.lastIndex = start;
      const m = close.exec(src);
      const end = m ? m.index : src.length;
      out += `"${heredocRefs(src.slice(start, end))}"`;
      i = m ? m.index + m[0].length : src.length;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The body of the block whose `{` is just before `start` (on comment-free source). */
function blockBody(src: string, start: number): string {
  let depth = 1;
  let i = start;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '"') {
      i = skipString(src, i);
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(start, i);
    i++;
  }
  return src.slice(start);
}

/** A block body without its nested blocks and objects: only its own attributes. */
function topLevel(body: string): string {
  let out = '';
  let i = 0;
  while (i < body.length) {
    const c = body[i]!;
    if (c === '"') {
      const end = skipString(body, i);
      out += body.slice(i, end);
      i = end;
    } else if (c === '{') {
      i += blockBody(body, i + 1).length + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Bodies of nested blocks named `name` (`machine_pools { ... }`), at any depth. */
function subBlocks(body: string, name: string): string[] {
  const re = new RegExp(`\\b${name}\\s*\\{`, 'g');
  return [...body.matchAll(re)].map((m) => blockBody(body, m.index + m[0].length));
}

interface RawBlock {
  kind: 'resource' | 'data' | 'module' | 'output';
  key: string;
  type: string;
  name: string;
  body: string;
}

const BLOCK_HEAD = /([A-Za-z_][\w-]*)((?:\s+(?:"[^"\n]*"|[A-Za-z_][\w-]*))*)\s*\{/y;

/**
 * Top-level `resource`, `data`, `module` and `output` blocks of cleaned HCL. Everything else
 * (`terraform`, `provider`, `variable`, `locals`, `moved`, `import`, `removed`, `check`...) is
 * skipped.
 */
function extractBlocks(src: string): RawBlock[] {
  const out: RawBlock[] = [];
  let i = 0;
  while (i < src.length) {
    if (/\s/.test(src[i]!)) {
      i++;
      continue;
    }
    BLOCK_HEAD.lastIndex = i;
    const m = BLOCK_HEAD.exec(src);
    if (m) {
      const start = i + m[0].length;
      const body = blockBody(src, start);
      i = start + body.length + 1;
      const labels = [...m[2]!.matchAll(/"([^"]*)"|([A-Za-z_][\w-]*)/g)].map((l) => l[1] ?? l[2]!);
      const [a, b] = labels;
      if (m[1] === 'resource' && a && b)
        out.push({ kind: 'resource', key: `${a}.${b}`, type: a, name: b, body });
      else if (m[1] === 'data' && a && b)
        out.push({ kind: 'data', key: `data.${a}.${b}`, type: a, name: b, body });
      else if (m[1] === 'module' && a)
        out.push({ kind: 'module', key: `module.${a}`, type: 'module', name: a, body });
      else if (m[1] === 'output' && a)
        out.push({ kind: 'output', key: a, type: 'output', name: a, body });
      continue;
    }
    // Not a block: skip the rest of the line (strings and objects included).
    while (i < src.length && src[i] !== '\n') {
      if (src[i] === '"') i = skipString(src, i);
      else if (src[i] === '{') i += blockBody(src, i + 1).length + 2;
      else i++;
    }
  }
  return out;
}

interface RefContext {
  byKey: Map<string, Block>;
  /** Output name -> output body, per expanded module instance. */
  outputs: Map<string, Map<string, string>>;
  /** Keys of module calls drawn as groups. */
  expanded: Set<string>;
  warn: (w: string) => void;
}

/** `module.network.module.subnet` -> `network.subnet`. */
const modulePath = (key: string) => key.replace(/(^|\.)module\./g, '$1');

function findRefs(
  body: string,
  ctx: RefContext,
  self: string,
  scope = '',
  seen = new Set<string>(),
): Set<string> {
  const refs = new Set<string>();
  for (const m of body.matchAll(
    /\b(data\.)?(module|[a-z][a-z0-9]*_[a-z0-9_]+)\.([A-Za-z_][\w-]*)/g,
  )) {
    if (m[2] === 'module' && !m[1]) {
      const rest = body.slice(m.index + m[0].length);
      const output = /^(?:\[[^\]]*\])?\.([A-Za-z_][\w-]*)/.exec(rest)?.[1];
      for (const r of moduleRef(`${scope}module.${m[3]}`, output, ctx, seen))
        if (r !== self) refs.add(r);
      continue;
    }
    const key = `${scope}${m[1] ?? ''}${m[2]}.${m[3]}`;
    if (key !== self && ctx.byKey.has(key)) refs.add(key);
  }
  return refs;
}

/**
 * What `module.x.output` stands for: the collapsed module node itself, or, for a module drawn as a
 * group, the resources its `output "output"` block names (groups can't be edge ends in Mermaid).
 */
function moduleRef(
  key: string,
  output: string | undefined,
  ctx: RefContext,
  seen: Set<string>,
): string[] {
  if (!ctx.expanded.has(key)) return ctx.byKey.has(key) ? [key] : [];
  if (!output) return [];
  const id = `${key}.${output}`;
  if (seen.has(id)) return [];
  seen.add(id);
  const body = ctx.outputs.get(key)?.get(output);
  if (body === undefined) {
    ctx.warn(`module "${modulePath(key)}": output "${output}" not found`);
    return [];
  }
  const value = topLevel(body).replace(/^\s*(description|sensitive|depends_on)\s*=.*$/gm, '');
  return [...findRefs(value, ctx, id, `${key}.`, seen)];
}

const normPath = (p: string) =>
  p
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^(\.\/)+/, '');
const dirOf = (p: string) => p.slice(0, Math.max(p.lastIndexOf('/'), 0));

/** `infra` + `./modules/../vpc` -> `infra/vpc`. */
function joinPath(dir: string, rel: string): string {
  const out: string[] = [];
  for (const s of [...dir.split('/'), ...normPath(rel).split('/')]) {
    if (!s || s === '.') continue;
    if (s === '..' && out.length && out[out.length - 1] !== '..') out.pop();
    else out.push(s);
  }
  return (dir.startsWith('/') ? '/' : '') + out.join('/');
}

const isLocalSource = (src: string) => /^\.\.?([/\\]|$)/.test(src);
const sourceOf = (body: string) =>
  /^\s*source\s*=\s*"([^"]*)"/m.exec(topLevel(body))?.[1]?.replace(/\\/g, '/');
const MANIFEST = /(^|\/)\.terraform\/modules\/modules\.json$/;

interface Manifest {
  /** The root module directory the manifest belongs to. */
  root: string;
  /** Module key (`vpc`, `network.subnet`) -> directory, relative to the files' paths. */
  dirs: Map<string, string>;
}

/** `.terraform/modules/modules.json` files written by `terraform init`. */
function readManifests(files: { path: string; content: string }[], warn: (w: string) => void) {
  const out: Manifest[] = [];
  for (const f of files) {
    if (!MANIFEST.test(f.path)) continue;
    const root = dirOf(dirOf(dirOf(f.path)));
    const dirs = new Map<string, string>();
    try {
      const json = JSON.parse(f.content) as { Modules?: { Key?: string; Dir?: string }[] };
      for (const m of json.Modules ?? [])
        if (m.Key && typeof m.Dir === 'string') dirs.set(m.Key, joinPath(root, m.Dir));
    } catch {
      warn(`${f.path}: could not be read as JSON`);
    }
    out.push({ root, dirs });
  }
  return out;
}

/**
 * Reads every file into blocks, expanding module calls whose source directory is among the files
 * into scoped copies of that directory's blocks (`module.vpc.aws_subnet.private`).
 */
function loadModules(input: TerraformFile[], warn: (w: string) => void) {
  const files = input.map((f) => {
    const path = normPath(f.path);
    return { path, dir: dirOf(path), content: f.content };
  });
  type File = (typeof files)[number];
  const manifests = readManifests(files, warn);
  const cache = new Map<File, RawBlock[]>();
  const rawOf = (f: File) => {
    if (!cache.has(f)) cache.set(f, extractBlocks(cleanSource(f.content)));
    return cache.get(f)!;
  };
  const hcl = files.filter((f) => !/\.json$/i.test(f.path));
  const filesIn = (dir: string) => hcl.filter((f) => f.dir === dir && HCL_FILE.test(f.path));

  // Directories called as modules hold module contents, not root resources.
  const moduleDirs = new Set<string>();
  for (const f of hcl)
    for (const r of rawOf(f)) {
      const src = r.kind === 'module' ? sourceOf(r.body) : undefined;
      const dir = src && isLocalSource(src) ? joinPath(f.dir, src) : undefined;
      if (dir !== undefined && dir !== f.dir) moduleDirs.add(dir);
    }
  for (const m of manifests) for (const d of m.dirs.values()) if (d !== m.root) moduleDirs.add(d);
  const rootFiles = hcl.filter(
    (f) => !moduleDirs.has(f.dir) && !/(^|\/)\.terraform\//.test(f.path),
  );

  const blocks: Block[] = [];
  const outputs = new Map<string, Map<string, string>>();
  const expanded = new Set<string>();
  const load = (
    scopeFiles: File[],
    prefix: string,
    module: string | undefined,
    stack: string[],
  ) => {
    for (const f of scopeFiles)
      for (const r of rawOf(f)) {
        if (r.kind === 'output') {
          if (module) outputs.get(module)!.set(r.name, r.body);
          continue;
        }
        const block: Block = {
          key: prefix + r.key,
          type: r.type,
          name: r.name,
          body: r.body,
          scope: prefix,
          module,
        };
        if (r.kind === 'data') block.data = true;
        blocks.push(block);
        if (r.kind !== 'module') continue;
        const label = `module "${modulePath(block.key)}"`;
        const src = sourceOf(r.body);
        if (!src) {
          warn(`${label}: no source, shown as a single node`);
          continue;
        }
        const dir = isLocalSource(src)
          ? joinPath(f.dir, src)
          : manifests.map((m) => m.dirs.get(modulePath(block.key))).find((d) => d !== undefined);
        if (dir === undefined) {
          warn(`${label}: remote source "${src}" shown as a single node`);
          continue;
        }
        const contents = filesIn(dir);
        if (!contents.length) {
          warn(`${label}: source not found among files`);
          continue;
        }
        if (stack.includes(dir)) {
          warn(`${label}: recursive module call skipped`);
          continue;
        }
        block.moduleGroup = true;
        expanded.add(block.key);
        outputs.set(block.key, new Map());
        load(contents, `${block.key}.`, block.key, [...stack, dir]);
      }
  };
  load(rootFiles, '', undefined, [...new Set(rootFiles.map((f) => f.dir))]);
  return { blocks, outputs, expanded };
}
