import type { ArchEdge, ArchNode, Diagram } from './model';
import { emptyDiagram, makeId } from './model';
import type { IacFile } from './iac-shared';
import { asArray, isRecord } from './iac-shared';
import { iconForResourceType } from './terraform';

/**
 * Terraform / OpenTofu JSON -> architecture diagram.
 *
 * Reads the machine-readable output of `terraform show -json` (and `tofu show -json`), both for a
 * saved plan (`planned_values`, `resource_changes`, `configuration`, `prior_state`) and for state
 * (`values.root_module`), plus raw `terraform.tfstate` files (`"version": 4`, `resources[]` with
 * `instances[].attributes`).
 *
 * Unlike the HCL importer it sees real attribute values, so references are found by matching
 * values: a subnet whose `vpc_id` equals a VPC's `id` sits in that VPC, an Azure resource whose
 * `resource_group_name` equals a resource group's `name` sits in that group. When the plan carries
 * the `configuration` block, its expression `references` are used instead, since they are exact.
 *
 * Modules become groups, `count`/`for_each` instances collapse into one node (`web ×3`) unless
 * `expandInstances` is set, data sources are not drawn, and resources the plan destroys are left
 * out unless `includeAll` is set.
 */

export interface TerraformJsonOptions {
  /** Keep plumbing resources (policies, attachments, rules...) and resources being destroyed. */
  includeAll?: boolean;
  /** Draw each `count` / `for_each` instance as its own node instead of one `name ×N` node. */
  expandInstances?: boolean;
}

interface Instance {
  /** Full instance address, e.g. `module.vpc.aws_subnet.private["a"]`. */
  address: string;
  /** Address without the trailing instance index: `module.vpc.aws_subnet.private`. */
  base: string;
  /** Module instance address (`module.vpc`), empty for the root module. */
  module: string;
  type: string;
  name: string;
  index?: string | number;
  data: boolean;
  values: Record<string, unknown>;
  destroy?: boolean;
  /** Exact references (index-free bases) from `configuration` or state `dependencies`. */
  exact?: Set<string>;
  /** References found by matching attribute values, as instance addresses. */
  valueRefs: Set<string>;
}

const MAX_DEPTH = 8;

// Replicated from terraform.ts (not exported there): containment and plumbing rules.
const SUBNET_TYPES = /(_subnet|_subnetwork)$/;
const BRIDGE_TYPES =
  /(_linux_bridge|_linux_vlan|_sdn_vnet|_network_switch|_distributed_port_group|_host_port_group)$/;
const NETWORK_TYPES =
  /(_vpc|_virtual_network|_compute_network|_network|_distributed_virtual_switch|^ovirt_networks)$/;
const RESOURCE_GROUP_TYPES = /_resource_group$/;
const HOST_TYPES =
  /^(vsphere_host|vsphere_resource_pool|xenorchestra_host|proxmox_virtual_environment_node|ovirt_hosts?)$/;
const CLUSTER_TYPES =
  /^(vsphere_compute_cluster|xenorchestra_pool|nutanix_clusters?|ovirt_clusters?|rancher2_cluster|harvester_clusternetwork)$/;
const DATACENTER_TYPES = /^(vsphere_datacenter|ovirt_datacenters?)$/;
const PLUMBING =
  /(policy|attach|associat|permission|_role|iam_|_rule|_route(?!r)|route_table|_record|_version|_alias|_tag|_key_pair|mapping|_member|_binding|_assignment|_listener|_target_group$|_nic$|_vnic$|network_interface$|download_file|_snippet|cloud_?init|networking_port$|(lxd|incus)_profile$|vnic_profile$|router_interface|machine_config|node_template|cloud_credential|ssh_key|vlanconfig)|^(random|null|local|tls|time|terraform)_/;
/** Hidden resources something uses to join a network: their referrers inherit their references. */
const LINK_TYPES =
  /(networking_port|network_interface|_nic|_vnic|(lxd|incus)_profile|vnic_profile)$/;

/** Attributes whose values identify a resource everywhere (ids, ARNs, URLs). */
const ID_KEYS = new Set(['id', 'arn', 'self_link']);
/** Attributes holding the platform name of a resource. */
const NAME_KEYS = new Set(['name', 'name_label']);
/** Attributes that refer to another resource by its name rather than by id. */
const NAME_REF_KEY = /(_name|^network|^subnetwork|^bridge|^resource_group)$/;
/** Value maps that never hold references. */
const SKIP_KEYS = new Set(['tags', 'tags_all', 'labels', 'user_data', 'metadata_startup_script']);

const baseType = (type: string) => type.replace(/_v\d+$/, '');

/** Containment rank: lower is more specific (subnet < network < resource group < host...). */
function rankOf(type: string): number | undefined {
  const t = baseType(type);
  if (SUBNET_TYPES.test(t) || BRIDGE_TYPES.test(t)) return 0;
  if (HOST_TYPES.test(t)) return 3;
  if (CLUSTER_TYPES.test(t)) return 4;
  if (DATACENTER_TYPES.test(t)) return 5;
  if (RESOURCE_GROUP_TYPES.test(t)) return 2;
  if (NETWORK_TYPES.test(t) && !/(_peering|_interface)/.test(t)) return 1;
  return undefined;
}

function groupIcon(type: string): string {
  const t = baseType(type);
  if (HOST_TYPES.test(t)) return 'lucide:server-cog';
  if (DATACENTER_TYPES.test(t)) return 'lucide:building-2';
  if (CLUSTER_TYPES.test(t) && !/network/.test(t)) return 'lucide:boxes';
  if (RESOURCE_GROUP_TYPES.test(t)) return 'lucide:folder';
  return 'lucide:network';
}

/** Removes every `[...]` index: `module.a[0].aws_x.y["k"]` -> `module.a.aws_x.y`. */
const stripIndexes = (address: string) => address.replace(/\[(?:"(?:[^"\\]|\\.)*"|[^\]]*)\]/g, '');

const indexSuffix = (index: unknown): string =>
  typeof index === 'number'
    ? `[${index}]`
    : typeof index === 'string'
      ? `[${JSON.stringify(index)}]`
      : '';

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Recognizes a JSON document this importer reads (plan, state or raw `.tfstate`). */
export function isTerraformJson(content: string): boolean {
  if (!/"terraform_version"|"format_version"/.test(content)) return false;
  if (/"format_version"/.test(content) && /"(planned_values|values|root_module)"/.test(content))
    return true;
  return /"terraform_version"/.test(content) && /"(resources|values|planned_values)"/.test(content);
}

export function parseTerraformJson(files: IacFile[], options: TerraformJsonOptions = {}): Diagram {
  const instances = new Map<string, Instance>();
  const modules = new Set<string>();
  const configRefs = new Map<string, Set<string>>();
  const destroyed = new Set<string>();
  /** Raw state `dependencies` per instance address. */
  const rawDeps = new Map<string, Set<string>>();

  for (const f of files) {
    let doc: unknown;
    try {
      doc = JSON.parse(f.content);
    } catch {
      continue;
    }
    if (!isRecord(doc)) continue;
    if (Array.isArray(doc.resources)) readRawState(doc.resources);
    if (isRecord(doc.values)) readModule(doc.values.root_module, false);
    if (isRecord(doc.prior_state) && isRecord(doc.prior_state.values))
      readModule(doc.prior_state.values.root_module, true);
    if (isRecord(doc.planned_values)) readModule(doc.planned_values.root_module, false);
    for (const rc of asArray(doc.resource_changes)) readChange(rc);
    if (isRecord(doc.configuration)) readConfiguration(doc.configuration.root_module);
  }
  for (const a of destroyed) {
    const inst = instances.get(a);
    if (inst) inst.destroy = true;
  }
  for (const inst of instances.values()) {
    const exact = configRefs.get(stripIndexes(inst.base));
    if (exact) inst.exact = new Set([...(inst.exact ?? []), ...exact]);
  }

  resolveValueReferences();
  return build();

  function addInstance(inst: Omit<Instance, 'valueRefs'>, priorOnly: boolean) {
    const existing = instances.get(inst.address);
    if (existing) {
      // planned_values win over prior_state; fill in values the plan does not know yet.
      if (!priorOnly) existing.values = { ...existing.values, ...inst.values };
      else existing.values = { ...inst.values, ...existing.values };
      return;
    }
    instances.set(inst.address, { ...inst, valueRefs: new Set() });
    if (inst.module) addModule(inst.module);
  }

  function addModule(address: string) {
    // `module.a.module.b["x"]` -> also `module.a`.
    const parts = splitModules(address);
    for (let i = 1; i <= parts.length; i++) modules.add(parts.slice(0, i).join('.'));
  }

  function readModule(mod: unknown, priorOnly: boolean, depth = 0) {
    if (!isRecord(mod) || depth > 32) return;
    const moduleAddr = str(mod.address) ?? '';
    for (const r of asArray(mod.resources)) {
      if (!isRecord(r)) continue;
      const type = str(r.type);
      const name = str(r.name);
      if (!type || !name) continue;
      const data = r.mode === 'data';
      const prefix = moduleAddr ? `${moduleAddr}.` : '';
      const base = `${prefix}${data ? 'data.' : ''}${type}.${name}`;
      const index =
        typeof r.index === 'number' || typeof r.index === 'string' ? r.index : undefined;
      const address = str(r.address) ?? `${base}${indexSuffix(index)}`;
      addInstance(
        {
          address,
          base,
          module: moduleAddr,
          type,
          name,
          index,
          data,
          values: isRecord(r.values) ? r.values : {},
        },
        priorOnly,
      );
    }
    for (const child of asArray(mod.child_modules)) readModule(child, priorOnly, depth + 1);
  }

  function readChange(rc: unknown) {
    if (!isRecord(rc) || !isRecord(rc.change)) return;
    const address = str(rc.address);
    const type = str(rc.type);
    const name = str(rc.name);
    if (!address || !type || !name || rc.deposed) return;
    const actions = asArray(rc.change.actions);
    if (!(actions.includes('delete') && !actions.includes('create'))) return;
    destroyed.add(address);
    if (instances.has(address)) return;
    // A destroyed resource is not in planned_values; take it from the change itself.
    const moduleAddr = str(rc.module_address) ?? '';
    const data = rc.mode === 'data';
    const index =
      typeof rc.index === 'number' || typeof rc.index === 'string' ? rc.index : undefined;
    addInstance(
      {
        address,
        base: `${moduleAddr ? `${moduleAddr}.` : ''}${data ? 'data.' : ''}${type}.${name}`,
        module: moduleAddr,
        type,
        name,
        index,
        data,
        values: isRecord(rc.change.before) ? rc.change.before : {},
      },
      true,
    );
  }

  function readRawState(resources: unknown[]) {
    for (const r of resources) {
      if (!isRecord(r)) continue;
      const type = str(r.type);
      const name = str(r.name);
      if (!type || !name) continue;
      const moduleAddr = str(r.module) ?? '';
      const data = r.mode === 'data';
      const base = `${moduleAddr ? `${moduleAddr}.` : ''}${data ? 'data.' : ''}${type}.${name}`;
      for (const i of asArray(r.instances)) {
        if (!isRecord(i) || i.deposed) continue;
        const index =
          typeof i.index_key === 'number' || typeof i.index_key === 'string'
            ? i.index_key
            : undefined;
        const address = `${base}${indexSuffix(index)}`;
        addInstance(
          {
            address,
            base,
            module: moduleAddr,
            type,
            name,
            index,
            data,
            values: isRecord(i.attributes) ? i.attributes : {},
          },
          false,
        );
        const deps = asArray(i.dependencies).filter((d): d is string => typeof d === 'string');
        // State dependencies are transitive, so they only stand in when values match nothing.
        if (deps.length) rawDeps.set(address, new Set(deps.map(stripIndexes)));
      }
    }
  }

  /**
   * Walks the configuration tree and records, per resource (index-free absolute address), the
   * resources its expressions reference. `var.x` follows the module call's argument, and
   * `module.m.out` follows the output's expression inside the module.
   */
  function readConfiguration(root: unknown) {
    interface Scope {
      prefix: string;
      mod: Record<string, unknown>;
      parent?: Scope;
      call?: Record<string, unknown>;
    }
    const resolve = (ref: string, scope: Scope, depth: number): string[] => {
      if (depth > 16) return [];
      const parts = ref.replace(/\[[^\]]*\]/g, '').split('.');
      if (parts[0] === 'var' && parts[1]) {
        const expr = isRecord(scope.call?.expressions)
          ? scope.call.expressions[parts[1]]
          : undefined;
        return scope.parent
          ? refsIn(expr, 0).flatMap((r) => resolve(r, scope.parent!, depth + 1))
          : [];
      }
      if (parts[0] === 'module' && parts[1]) {
        const calls = isRecord(scope.mod.module_calls) ? scope.mod.module_calls : {};
        const call = calls[parts[1]];
        if (!isRecord(call) || !isRecord(call.module)) return [];
        const child: Scope = {
          prefix: `${scope.prefix}module.${parts[1]}.`,
          mod: call.module,
          parent: scope,
          call,
        };
        const outputs = isRecord(call.module.outputs) ? call.module.outputs : {};
        const names = parts[2] ? [parts[2]] : Object.keys(outputs);
        return names.flatMap((o) => {
          const out = outputs[o];
          return isRecord(out)
            ? refsIn(out.expression, 0).flatMap((r) => resolve(r, child, depth + 1))
            : [];
        });
      }
      if (parts[0] === 'data' && parts[1] && parts[2])
        return [`${scope.prefix}data.${parts[1]}.${parts[2]}`];
      if (parts[0] && parts[1] && /^[a-z][a-z0-9]*_[a-z0-9_]+$/.test(parts[0]))
        return [`${scope.prefix}${parts[0]}.${parts[1]}`];
      return [];
    };
    const walk = (scope: Scope, depth: number) => {
      if (depth > 32) return;
      for (const r of asArray(scope.mod.resources)) {
        if (!isRecord(r)) continue;
        const address = str(r.address);
        if (!address) continue;
        const key = stripIndexes(`${scope.prefix}${address}`);
        const refs = configRefs.get(key) ?? new Set<string>();
        const exprs = [r.expressions, r.count_expression, r.for_each_expression];
        for (const ref of exprs.flatMap((e) => refsIn(e, 0)))
          for (const target of resolve(ref, scope, 0)) if (target !== key) refs.add(target);
        configRefs.set(key, refs);
      }
      const calls = isRecord(scope.mod.module_calls) ? scope.mod.module_calls : {};
      for (const [name, call] of Object.entries(calls)) {
        if (!isRecord(call) || !isRecord(call.module)) continue;
        walk(
          { prefix: `${scope.prefix}module.${name}.`, mod: call.module, parent: scope, call },
          depth + 1,
        );
      }
    };
    if (isRecord(root)) walk({ prefix: '', mod: root }, 0);
  }

  function resolveValueReferences() {
    // Index identifying values -> instance addresses. Managed resources win over data sources.
    const byId = new Map<string, Set<string>>();
    const byName = new Map<string, Set<string>>();
    const put = (map: Map<string, Set<string>>, value: string, address: string) => {
      if (value.length < 3) return;
      const set = map.get(value) ?? new Set<string>();
      set.add(address);
      map.set(value, set);
    };
    const ordered = [...instances.values()].sort((a, b) => Number(a.data) - Number(b.data));
    for (const inst of ordered)
      for (const [k, v] of Object.entries(inst.values)) {
        if (typeof v !== 'string') continue;
        if (ID_KEYS.has(k)) put(byId, v, inst.address);
        else if (NAME_KEYS.has(k)) put(byName, v, inst.address);
      }
    const pick = (set: Set<string> | undefined, self: Instance): string[] => {
      if (!set) return [];
      const all = [...set].filter((a) => a !== self.address);
      const managed = all.filter((a) => !instances.get(a)!.data);
      const pool = managed.length ? managed : all;
      return pool.length <= 1 ? pool : [];
    };
    for (const inst of instances.values()) {
      const visit = (value: unknown, key: string, depth: number) => {
        if (depth > MAX_DEPTH) return;
        if (typeof value === 'string') {
          if (depth === 0 && (ID_KEYS.has(key) || NAME_KEYS.has(key))) return;
          for (const a of pick(byId.get(value), inst)) inst.valueRefs.add(a);
          if (NAME_REF_KEY.test(key)) {
            // Names are ambiguous: prefer containers (resource groups, networks).
            const named = [...(byName.get(value) ?? [])].filter((a) => a !== inst.address);
            const groups = named.filter((a) => rankOf(instances.get(a)!.type) !== undefined);
            const hits = pick(new Set(groups.length ? groups : named), inst);
            for (const a of hits) inst.valueRefs.add(a);
          }
        } else if (Array.isArray(value)) {
          for (const v of value) visit(v, key, depth + 1);
        } else if (isRecord(value)) {
          for (const [k, v] of Object.entries(value)) if (!SKIP_KEYS.has(k)) visit(v, k, depth + 1);
        }
      };
      for (const [k, v] of Object.entries(inst.values)) if (!SKIP_KEYS.has(k)) visit(v, k, 0);
      if (!inst.exact && inst.valueRefs.size === 0) {
        const deps = rawDeps.get(inst.address);
        if (deps) inst.exact = deps;
      }
    }
  }

  function build(): Diagram {
    const diagram = emptyDiagram();
    const all = [...instances.values()];
    const managed = all.filter((i) => !i.data);
    const byBase = new Map<string, Instance[]>();
    for (const i of managed) {
      const key = stripIndexes(i.base);
      byBase.set(key, [...(byBase.get(key) ?? []), i]);
    }

    /** Instance-level references: exact bases narrowed by value matches, else value matches. */
    const refsOf = (i: Instance): string[] => {
      if (i.exact && i.exact.size) {
        const out: string[] = [];
        for (const b of i.exact) {
          const targets = byBase.get(b) ?? [];
          const narrowed = targets.filter((t) => i.valueRefs.has(t.address));
          out.push(...(narrowed.length ? narrowed : targets).map((t) => t.address));
        }
        return out.filter((a) => a !== i.address);
      }
      return [...i.valueRefs].filter((a) => instances.has(a) && !instances.get(a)!.data);
    };

    const isGroupType = (type: string) => rankOf(type) !== undefined;
    const shown = (i: Instance) =>
      (!i.destroy || !!options.includeAll) &&
      (isGroupType(i.type) || !!options.includeAll || !PLUMBING.test(baseType(i.type)));
    const keptInstances = managed.filter(shown);
    const hidden = managed.filter((i) => !shown(i));

    // Instance -> node key.
    const keyOf = (i: Instance) => (options.expandInstances ? i.address : i.base);
    const nodeInstances = new Map<string, Instance[]>();
    for (const i of keptInstances)
      nodeInstances.set(keyOf(i), [...(nodeInstances.get(keyOf(i)) ?? []), i]);
    const nodeOfAddress = new Map<string, string>();
    for (const i of keptInstances) nodeOfAddress.set(i.address, keyOf(i));

    // Node-level references, following hidden link resources (NICs, ports) transitively.
    const linkRefs = (address: string, seen: Set<string>): string[] => {
      if (seen.has(address)) return [];
      seen.add(address);
      const out: string[] = [];
      for (const r of refsOf(instances.get(address)!)) {
        if (nodeOfAddress.has(r)) out.push(nodeOfAddress.get(r)!);
        else if (LINK_TYPES.test(baseType(instances.get(r)!.type))) out.push(...linkRefs(r, seen));
      }
      return out;
    };
    const nodeRefs = new Map<string, Set<string>>();
    for (const [key, insts] of nodeInstances) {
      const set = new Set<string>();
      for (const i of insts) for (const r of linkRefs(i.address, new Set())) set.add(r);
      set.delete(key);
      nodeRefs.set(key, set);
    }
    const rank = (key: string) => rankOf(nodeInstances.get(key)![0]!.type);

    // Ids: modules first, then resources (short names when unique).
    const ids = new Map<string, string>();
    const taken = () => ids.values();
    const usedModules = new Set<string>();
    for (const i of keptInstances) if (i.module) addUsed(i.module);
    function addUsed(m: string) {
      const parts = splitModules(m);
      for (let n = 1; n <= parts.length; n++) usedModules.add(parts.slice(0, n).join('.'));
    }
    const moduleList = [...modules].filter((m) => usedModules.has(m)).sort();
    for (const m of moduleList) ids.set(m, makeId(moduleLabel(m), taken()));
    // Resources (not instances) sharing a name get qualified ids.
    const basesByName = new Map<string, Set<string>>();
    const firstOf = (key: string) => nodeInstances.get(key)![0]!;
    for (const key of nodeInstances.keys()) {
      const { name, base } = firstOf(key);
      basesByName.set(name, (basesByName.get(name) ?? new Set()).add(base));
    }
    for (const key of nodeInstances.keys()) {
      const i = firstOf(key);
      let base = i.name;
      if (basesByName.get(i.name)!.size > 1)
        base = i.module ? `${moduleLabel(i.module)}_${i.name}` : `${i.type}_${i.name}`;
      if (options.expandInstances && i.index !== undefined) base = `${base}_${i.index}`;
      ids.set(key, makeId(base, taken()));
    }

    // Parents: the most specific network-like container referenced, else the module group.
    const parentOf = new Map<string, string>();
    const chainHas = (start: string, target: string) => {
      for (let p: string | undefined = start, n = 0; p && n < 64; p = parentOf.get(p), n++)
        if (p === target) return true;
      return false;
    };
    const keysByRank = [...nodeInstances.keys()].sort((a, b) => (rank(b) ?? -1) - (rank(a) ?? -1));
    for (const key of keysByRank) {
      const own = rank(key);
      const candidates = [...nodeRefs.get(key)!]
        .filter((r) => rank(r) !== undefined && (own === undefined || rank(r)! > own))
        .filter((r) => !chainHas(r, key))
        .sort((a, b) => rank(a)! - rank(b)!);
      const mod = firstOf(key).module;
      const parent = candidates[0] ?? (mod || undefined);
      if (parent) parentOf.set(key, parent);
    }
    for (const m of moduleList) {
      const parts = splitModules(m);
      if (parts.length > 1) parentOf.set(m, parts.slice(0, -1).join('.'));
    }

    for (const m of moduleList) {
      const node: ArchNode = {
        id: ids.get(m)!,
        kind: 'group',
        label: moduleLabel(m),
        icon: 'lucide:package',
      };
      const p = parentOf.get(m);
      if (p) node.parent = ids.get(p);
      diagram.nodes.push(node);
    }
    for (const [key, insts] of nodeInstances) {
      const i = insts[0]!;
      const group = isGroupType(i.type);
      let label = i.name;
      if (options.expandInstances) {
        if (i.index !== undefined) label = `${i.name} (${i.index})`;
      } else if (insts.length > 1) label = `${i.name} ×${insts.length}`;
      if (insts.every((x) => x.destroy)) label += ' (destroy)';
      const node: ArchNode = {
        id: ids.get(key)!,
        kind: group ? 'group' : 'service',
        label,
        icon: group ? groupIcon(i.type) : iconForResourceType(i.type),
      };
      const p = parentOf.get(key);
      if (p) node.parent = ids.get(p);
      diagram.nodes.push(node);
    }

    const seen = new Set<string>();
    const addEdge = (a: string, z: string) => {
      if (a === z) return;
      const [x, y] = [ids.get(a)!, ids.get(z)!];
      const k = [x, y].sort().join('|');
      if (seen.has(k)) return;
      seen.add(k);
      const e: ArchEdge = { from: x, to: y, fromSide: 'R', toSide: 'L', arrowEnd: true };
      diagram.edges.push(e);
    };
    for (const [key, refs] of nodeRefs) {
      if (rank(key) !== undefined) continue;
      for (const r of refs) if (rank(r) === undefined && !chainHas(key, r)) addEdge(key, r);
    }
    // Hidden connector resources (attachments, mappings) link the services they reference.
    for (const h of hidden) {
      if (LINK_TYPES.test(baseType(h.type))) continue;
      const services = [
        ...new Set(linkRefs(h.address, new Set()).filter((r) => rank(r) === undefined)),
      ];
      for (let n = 1; n < services.length; n++) addEdge(services[n]!, services[0]!);
    }
    // Module groups whose resources all moved into networks are dropped.
    const moduleIds = new Set(moduleList.map((m) => ids.get(m)));
    for (let before = -1; before !== diagram.nodes.length;) {
      before = diagram.nodes.length;
      const parents = new Set(diagram.nodes.map((n) => n.parent));
      diagram.nodes = diagram.nodes.filter((n) => !moduleIds.has(n.id) || parents.has(n.id));
    }
    return diagram;
  }
}

/** `module.a.module.b["x"]` -> [`module.a`, `module.b["x"]`]. */
function splitModules(address: string): string[] {
  const out: string[] = [];
  for (const m of address.matchAll(/module\.[A-Za-z_][\w-]*(?:\[(?:"(?:[^"\\]|\\.)*"|[^\]]*)\])?/g))
    out.push(m[0]);
  return out;
}

/** `module.a.module.b["x"]` -> `b (x)`. */
function moduleLabel(address: string): string {
  const last = splitModules(address).pop() ?? address;
  const m = /^module\.([^[]+)(?:\[(.*)\])?$/.exec(last);
  if (!m) return last;
  const index = m[2]?.replace(/^"|"$/g, '');
  return index !== undefined ? `${m[1]} (${index})` : m[1]!;
}

/** Every `references` string inside an expression tree. */
function refsIn(expr: unknown, depth: number): string[] {
  if (depth > MAX_DEPTH * 2) return [];
  if (Array.isArray(expr)) return expr.flatMap((e) => refsIn(e, depth + 1));
  if (!isRecord(expr)) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(expr)) {
    if (k === 'references') {
      const refs = asArray(v).filter((r): r is string => typeof r === 'string');
      // `module.vpc.vpc_id` comes with an implied `module.vpc`; keep only the longest steps.
      const implied = (r: string) =>
        refs.some((o) => o !== r && (o.startsWith(`${r}.`) || o.startsWith(`${r}[`)));
      out.push(...refs.filter((r) => !implied(r)));
    } else if (k !== 'constant_value') out.push(...refsIn(v, depth + 1));
  }
  return out;
}
