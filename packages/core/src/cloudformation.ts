import type { ScalarTag, CollectionTag } from 'yaml';
import type { ArchNode, Diagram } from './model';
import { emptyDiagram, makeId } from './model';
import type { IacFile, IacImportOptions } from './iac-shared';
import { edgeAdder, isRecord, loadYamlDocuments } from './iac-shared';
import { iconForResourceType } from './terraform';

/**
 * Best-effort AWS CloudFormation (YAML or JSON, including SAM) -> architecture diagram.
 *
 * Resources become services; VPCs and subnets become groups and resources referencing them are
 * nested inside. `Ref`, `Fn::GetAtt` and `Fn::Sub` references become edges. Plumbing resources
 * (IAM, associations, attachments, permissions, routes...) are hidden, but those that connect two
 * resources (an event source mapping, a Lambda permission, an SNS subscription) still link them.
 */

export type CloudFormationImportOptions = IacImportOptions;

interface Resource {
  key: string;
  id: string;
  type: string;
  props: unknown;
}

const VPC_TYPE = 'AWS::EC2::VPC';
const SUBNET_TYPE = 'AWS::EC2::Subnet';
const PLUMBING =
  /^(AWS::IAM::|AWS::CDK::|AWS::SSM::Parameter$|AWS::CloudFormation::Wait)|(Association|Attachment|Permission|Policy|EventSourceMapping|Subscription|SecurityGroupIngress|SecurityGroupEgress|SubnetGroup|TargetGroup|Listener|ListenerRule|LayerVersion|RecordSet|RecordSetGroup)$|::(Route|RouteTable|Version|Alias|EIP|Deployment|Stage|Method|Resource|Integration|Authorizer|Model|RequestValidator|Account|ApiKey|UsagePlan|UsagePlanKey)$/;

const INTRINSICS = [
  'Ref',
  'GetAtt',
  'Sub',
  'Join',
  'Select',
  'Split',
  'If',
  'Equals',
  'And',
  'Or',
  'Not',
  'Condition',
  'FindInMap',
  'Base64',
  'Cidr',
  'GetAZs',
  'ImportValue',
  'Transform',
  'Length',
  'ToJsonString',
  'ForEach',
];

/** YAML short-form tags (`!Ref X`, `!GetAtt [A, B]`, ...) resolved to their long JSON form. */
const CFN_TAGS: (ScalarTag | CollectionTag)[] = INTRINSICS.flatMap((name) => {
  const key = name === 'Ref' || name === 'Condition' ? name : `Fn::${name}`;
  const scalar: ScalarTag = {
    tag: `!${name}`,
    resolve: (value: string) => ({ [key]: name === 'GetAtt' ? value.split('.') : value }),
  };
  const collection = (kind: 'seq' | 'map'): CollectionTag => ({
    tag: `!${name}`,
    collection: kind,
    resolve: (value) => ({ [key]: value.toJSON() }) as never,
  });
  return [scalar, collection('seq'), collection('map')];
});

/** Parses one template (JSON or YAML) into a plain object, or `undefined` if it is not one. */
function loadCloudFormationTemplate(content: string): Record<string, unknown> | undefined {
  if (/^\s*\{/.test(content)) {
    try {
      const v: unknown = JSON.parse(content);
      if (isRecord(v)) return v;
    } catch {
      // Fall through to YAML, which also accepts most JSON.
    }
  }
  const doc = loadYamlDocuments(content, { customTags: CFN_TAGS })[0];
  return isRecord(doc) ? doc : undefined;
}

export function parseCloudFormation(
  files: IacFile[],
  options: CloudFormationImportOptions = {},
): Diagram {
  const resources: Resource[] = [];
  files.forEach((f, fileIdx) => {
    const tpl = loadCloudFormationTemplate(f.content);
    const res = tpl?.Resources;
    if (!isRecord(res)) return;
    for (const [id, r] of Object.entries(res)) {
      if (!isRecord(r) || typeof r.Type !== 'string') continue;
      resources.push({ key: `${fileIdx}:${id}`, id, type: r.Type, props: r.Properties });
    }
  });
  const byKey = new Map(resources.map((r) => [r.key, r]));
  const refsOf = new Map(
    resources.map((r) => {
      const prefix = r.key.slice(0, r.key.indexOf(':') + 1);
      const refs = [...findRefs(r.props)]
        .map((id) => prefix + id)
        .filter((k) => k !== r.key && byKey.has(k));
      return [r.key, refs] as const;
    }),
  );

  const isGroup = (r: Resource) => r.type === VPC_TYPE || r.type === SUBNET_TYPE;
  const isPlumbing = (r: Resource) => PLUMBING.test(r.type);
  const kept = resources.filter((r) => isGroup(r) || options.includeAll || !isPlumbing(r));
  const keptKeys = new Set(kept.map((r) => r.key));

  const diagram = emptyDiagram();
  const ids = new Map<string, string>();
  for (const r of kept) ids.set(r.key, makeId(r.id, ids.values()));

  for (const r of kept) {
    const node: ArchNode = {
      id: ids.get(r.key)!,
      kind: isGroup(r) ? 'group' : 'service',
      label: r.id,
      icon: isGroup(r) ? 'lucide:network' : iconFor(r.type),
    };
    const parent = pickParent(r);
    if (parent) node.parent = ids.get(parent);
    diagram.nodes.push(node);
  }

  const addEdge = edgeAdder(diagram);
  const link = (a: string, z: string) => addEdge(ids.get(a)!, ids.get(z)!);
  for (const r of resources) {
    const refs = (refsOf.get(r.key) ?? []).filter((k) => keptKeys.has(k));
    if (keptKeys.has(r.key)) {
      if (isGroup(r)) continue;
      const containers = containersOf(r);
      for (const k of refs) if (!containers.has(k) && !isGroup(byKey.get(k)!)) link(r.key, k);
    } else {
      const services = refs.filter((k) => !isGroup(byKey.get(k)!));
      for (let i = 1; i < services.length; i++) link(services[i]!, services[0]!);
    }
  }
  return diagram;

  /** Group references, looking through hidden subnet groups (`DBSubnetGroupName: !Ref ...`). */
  function groupRefs(r: Resource): Resource[] {
    const out: Resource[] = [];
    for (const k of refsOf.get(r.key) ?? []) {
      const ref = byKey.get(k)!;
      if (isGroup(ref) && keptKeys.has(k)) out.push(ref);
      else if (/SubnetGroup$/.test(ref.type) && !keptKeys.has(k)) {
        for (const k2 of refsOf.get(k) ?? []) {
          const g = byKey.get(k2)!;
          if (isGroup(g) && keptKeys.has(k2)) out.push(g);
        }
      }
    }
    return out;
  }

  function pickParent(r: Resource): string | undefined {
    const groups = groupRefs(r).filter((g) => g.key !== r.key);
    return (groups.find((g) => g.type === SUBNET_TYPE) ?? groups[0])?.key;
  }

  function containersOf(r: Resource): Set<string> {
    const out = new Set<string>();
    for (let p = pickParent(r); p; p = pickParent(byKey.get(p)!)) {
      if (out.has(p)) break;
      out.add(p);
    }
    return out;
  }
}

function iconFor(type: string): string {
  if (/^AWS::Events::/.test(type)) return 'lucide:radio-tower';
  if (/^AWS::EC2::InternetGateway$/.test(type)) return 'internet';
  if (/^AWS::EC2::SecurityGroup$/.test(type)) return 'lucide:shield';
  return iconForResourceType(type);
}

/** Logical ids referenced by `Ref`, `Fn::GetAtt` and `Fn::Sub` anywhere in `value`. */
function findRefs(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) findRefs(v, out);
  } else if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'Ref' && typeof v === 'string') {
        if (!v.startsWith('AWS::')) out.add(v);
      } else if (k === 'Fn::GetAtt') {
        const target = Array.isArray(v)
          ? v[0]
          : typeof v === 'string'
            ? v.split('.')[0]
            : undefined;
        if (typeof target === 'string') out.add(target);
      } else if (k === 'Fn::Sub') {
        const [template, vars] = Array.isArray(v) ? v : [v, undefined];
        const local = isRecord(vars) ? new Set(Object.keys(vars)) : new Set<string>();
        if (typeof template === 'string') {
          for (const m of template.matchAll(/\$\{([^!}][^}]*)\}/g)) {
            const name = m[1]!.trim().split('.')[0]!;
            if (!name.startsWith('AWS::') && !local.has(name)) out.add(name);
          }
        }
        findRefs(vars, out);
      } else {
        findRefs(v, out);
      }
    }
  }
  return out;
}
