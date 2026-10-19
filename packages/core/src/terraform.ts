import type { ArchEdge, ArchNode, Diagram } from './model';
import { emptyDiagram, makeId } from './model';

/**
 * Best-effort Terraform (HCL) -> architecture diagram.
 *
 * It reads `resource` and `module` blocks, follows references between them, nests resources
 * inside the networks they reference (VPC/VNet/subnet/resource group), and hides plumbing
 * resources such as IAM policies or route table associations. It does not evaluate HCL.
 *
 * On-prem virtualization is handled too: Proxmox VE (bpg/proxmox, Telmate/proxmox), VergeOS
 * (verge-io/vergeio), Hyper-V (taliesins/hyperv) and VirtualBox (terra-farm/virtualbox). Hypervisor nodes named by `node_name` / `target_node` become host
 * groups, and bridges/switches become groups inside them; VMs that name a bridge, switch or
 * host-only network (`bridge = "vmbr0"`, `switch_name`, `host_interface`) are nested in it, because
 * those providers link by name strings rather than by references. Networks that are named but not
 * managed by Terraform still get a group.
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
}

/** Synthetic block type for a hypervisor host (Proxmox node). */
const HOST = 'host';

const GROUP_TYPES =
  /(_vpc|_virtual_network|_compute_network|_subnet|_subnetwork|_resource_group|_network)$/;
const BRIDGE_TYPES = /(_linux_bridge|_linux_vlan|_sdn_vnet|_network_switch|^named_network)$/;
const SUBNET_TYPES = /(_subnet|_subnetwork)$/;
/** Attributes naming the hypervisor node a VM or container runs on. */
const HOST_ATTR = /^\s*(?:node_name|target_node)\s*=\s*"([^"$]+)"/m;
/** Attributes naming a bridge or network by its name rather than by reference. */
const BRIDGE_ATTR = /\b(?:bridge|network_name|switch_name|host_interface)\s*=\s*"([^"$]+)"/g;
/** Synthetic block type for a network known only by name (e.g. an unmanaged `vmbr0`). */
const NAMED_NETWORK = 'named_network';
const PLUMBING =
  /(policy|attachment|association|permission|_role|iam_|_rule|_route|route_table|_record|_version|_alias|_tag|_key_pair|mapping|_member|_binding|_assignment|_listener|_target_group$|_nic$|download_file|_snippet|cloud_init)|^(random|null|local|tls|time|terraform)_/;

/** Ordered keyword -> icon rules, matched against the resource type. */
const ICON_RULES: [RegExp, string][] = [
  [/sfn|step_?functions?|state_?machine/, 'lucide:workflow'],
  [/lambda|function|cloud_run|cloudfunctions|app_service|web_app/, 'lucide:square-function'],
  [/eks|aks|gke|kubernetes|container_cluster|ecs_cluster/, 'lucide:boxes'],
  [/ecs_service|ecs_task|container|pod|deployment|lxc/, 'lucide:container'],
  [/elasticache|redis|memcache|cache/, 'lucide:zap'],
  [
    /dynamodb|cosmos|firestore|bigtable|spanner|_db_|rds|sql|database|aurora|postgres|mysql/,
    'database',
  ],
  [/s3_bucket|storage_bucket|storage_account|blob|bucket/, 'lucide:archive'],
  [/ebs|disk|volume|drive|vhd/, 'disk'],
  [/efs|file_share|filestore/, 'lucide:folder-tree'],
  [/sqs|queue|servicebus/, 'lucide:list-ordered'],
  [/sns|pubsub|eventbridge|event_hub|eventgrid|kinesis|kafka|msk/, 'lucide:radio-tower'],
  [/sfn|step_function|logic_app|workflow/, 'lucide:workflow'],
  [/(^|_)(lb|alb|elb|nlb)(_|$)|load_?balancer|application_gateway|forwarding_rule/, 'lucide:split'],
  [/api_gateway|apigateway|api_management|apigw/, 'lucide:webhook'],
  [/cloudfront|cdn|front_door|route53|dns/, 'lucide:waypoints'],
  [/(^|_)nat(_|$)|gateway|router|vpn/, 'lucide:router'],
  [/waf|firewall|security_group|network_security/, 'lucide:shield'],
  [/kms|secret|key_vault|vault/, 'lucide:key-round'],
  [/cognito|identity|iam|active_directory/, 'lucide:fingerprint'],
  [/cloudwatch|monitor|(^|_)logs?(_|$)|logging|log_analytics|insights/, 'lucide:activity'],
  [/vpc|virtual_network|compute_network|subnet|network/, 'lucide:network'],
  [/instance|virtual_machine|machine|compute|vm|server|autoscaling/, 'server'],
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

export function parseTerraform(
  files: TerraformFile[],
  options: TerraformImportOptions = {},
): Diagram {
  const blocks = files.flatMap((f) => extractBlocks(stripComments(f.content)));
  const byKey = new Map(blocks.map((b) => [b.key, b]));
  const refsOf = new Map(blocks.map((b) => [b.key, findRefs(b.body, byKey, b.key)]));
  addNameReferences(blocks, byKey, refsOf);

  const isGroup = (b: Block) =>
    b.type === HOST ||
    BRIDGE_TYPES.test(b.type) ||
    (GROUP_TYPES.test(b.type) && !/(_peering|_interface)/.test(b.type));
  const kept = blocks.filter((b) => isGroup(b) || options.includeAll || !PLUMBING.test(b.type));
  const keptKeys = new Set(kept.map((b) => b.key));

  const diagram = emptyDiagram();
  const ids = new Map<string, string>();
  const nameCounts = new Map<string, number>();
  for (const b of kept) nameCounts.set(b.name, (nameCounts.get(b.name) ?? 0) + 1);
  for (const b of kept) {
    // Short ids when names are unique; type-qualified when two resources share a name.
    const base = nameCounts.get(b.name) === 1 ? b.name : `${b.type}_${b.name}`;
    ids.set(b.key, makeId(base, ids.values()));
  }

  for (const b of kept) {
    const node: ArchNode = {
      id: ids.get(b.key)!,
      kind: isGroup(b) ? 'group' : 'service',
      label: b.type === 'module' ? `${b.name} (module)` : b.name,
      icon:
        b.type === HOST
          ? 'lucide:server-cog'
          : isGroup(b)
            ? 'lucide:network'
            : b.type === 'module'
              ? 'lucide:package'
              : iconForResourceType(b.type),
    };
    const parent = pickParent(b);
    if (parent) node.parent = ids.get(parent);
    diagram.nodes.push(node);
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

  for (const b of blocks) {
    const refs = [...(refsOf.get(b.key) ?? [])].filter((r) => keptKeys.has(r));
    if (keptKeys.has(b.key)) {
      if (isGroup(byKey.get(b.key)!)) continue;
      // Containment is shown by nesting, so skip edges to the node's own networks.
      const containers = containersOf(b);
      for (const r of refs) if (!containers.has(r) && !isGroup(byKey.get(r)!)) addEdge(b.key, r);
    } else {
      // A hidden "connector" resource (e.g. an event source mapping) links what it references.
      const services = refs.filter((r) => !isGroup(byKey.get(r)!));
      for (let i = 1; i < services.length; i++) addEdge(services[i]!, services[0]!);
    }
  }
  // A hidden NIC-like resource that joins services to one network places them inside it
  // (VergeOS `vergeio_nic`, for example), unless they already sit in a more specific group.
  for (const b of blocks) {
    if (keptKeys.has(b.key)) continue;
    const refs = [...(refsOf.get(b.key) ?? [])].filter((r) => keptKeys.has(r));
    const groups = refs.filter((r) => isGroup(byKey.get(r)!));
    if (groups.length !== 1) continue;
    for (const r of refs) {
      const node = diagram.nodes.find((n) => n.id === ids.get(r));
      const current = node?.parent && [...ids].find(([, id]) => id === node.parent)?.[0];
      if (node && node.kind === 'service' && (!current || byKey.get(current)?.type === HOST))
        node.parent = ids.get(groups[0]!);
    }
  }
  return diagram;

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
    // Prefer the most specific container: subnet or bridge, then network, then host.
    const rank = (g: Block) =>
      SUBNET_TYPES.test(g.type) || BRIDGE_TYPES.test(g.type) ? 0 : g.type === HOST ? 2 : 1;
    return groups.sort((x, y) => rank(x) - rank(y))[0]?.key;
  }
}

/**
 * Adds references expressed as names: a synthetic host block per `node_name`/`target_node`, and a
 * bridge/switch/host-only network reference (`bridge = "vmbr0"`) pointing at the managed resource
 * with that name on the same host, or at a synthetic network group when Terraform doesn't manage it.
 */
function addNameReferences(
  blocks: Block[],
  byKey: Map<string, Block>,
  refsOf: Map<string, Set<string>>,
) {
  const hostOf = (b: Block) => HOST_ATTR.exec(b.body)?.[1];
  const managed = blocks.filter((b) => BRIDGE_TYPES.test(b.type));
  const nameOf = (b: Block) => /^\s*name\s*=\s*"([^"$]+)"/m.exec(b.body)?.[1] ?? b.name;
  const synth = (key: string, type: string, name: string, parent?: string) => {
    if (!byKey.has(key)) {
      const block = { key, type, name, body: '' };
      blocks.push(block);
      byKey.set(key, block);
      refsOf.set(key, new Set(parent ? [parent] : []));
    }
    return key;
  };
  for (const b of [...blocks]) {
    const host = hostOf(b);
    const hostKey = host ? synth(`${HOST}.${host}`, HOST, host) : undefined;
    if (hostKey) refsOf.get(b.key)!.add(hostKey);
    if (BRIDGE_TYPES.test(b.type)) continue;
    for (const m of b.body.matchAll(BRIDGE_ATTR)) {
      const name = m[1]!;
      const named = managed.filter((br) => nameOf(br) === name);
      const match = named.find((br) => hostOf(br) === host) ?? named[0];
      // Bridges like vmbr0 exist on every Proxmox node, so unmanaged ones are scoped per host.
      const key =
        match?.key ??
        synth(`${NAMED_NETWORK}.${host ? `${host}/` : ''}${name}`, NAMED_NETWORK, name, hostKey);
      refsOf.get(b.key)!.add(key);
    }
  }
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

function extractBlocks(src: string): Block[] {
  const out: Block[] = [];
  const re = /^\s*(resource|module)\s+"([^"]+)"(?:\s+"([^"]+)")?\s*\{/gm;
  for (const m of src.matchAll(re)) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
    }
    const body = src.slice(start, i - 1);
    if (m[1] === 'module') out.push({ key: `module.${m[2]}`, type: 'module', name: m[2]!, body });
    else if (m[3]) out.push({ key: `${m[2]}.${m[3]}`, type: m[2]!, name: m[3], body });
  }
  return out;
}

function findRefs(body: string, known: Map<string, Block>, self: string): Set<string> {
  const refs = new Set<string>();
  for (const m of body.matchAll(/\b(module|[a-z][a-z0-9]*_[a-z0-9_]+)\.([A-Za-z_][\w-]*)/g)) {
    const key = `${m[1]}.${m[2]}`;
    if (key !== self && known.has(key)) refs.add(key);
  }
  return refs;
}
