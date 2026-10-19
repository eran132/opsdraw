import type { Diagram } from './model';
import { emptyDiagram, makeId } from './model';
import type { IacFile, IacImportOptions } from './iac-shared';
import { parseTerraform } from './terraform';
import { parseCloudFormation } from './cloudformation';
import { parseKubernetes } from './kubernetes';
import { parseCompose } from './compose';
import { detectClusterConfig, parseClusterConfig } from './clusterconfig';
import { parseAnsibleInventory } from './ansible';
import { parseNomad } from './nomad';

export type { IacFile, IacImportOptions } from './iac-shared';

export type IacKind =
  'terraform' | 'cloudformation' | 'kubernetes' | 'compose' | 'clusterconfig' | 'ansible' | 'nomad';

export interface IacImportResult {
  diagram: Diagram;
  /** Kinds that were detected and imported, in a stable order. */
  kinds: IacKind[];
  /** Paths of files that were not recognized as any supported format. */
  skipped: string[];
}

const KINDS: IacKind[] = [
  'terraform',
  'cloudformation',
  'kubernetes',
  'compose',
  'clusterconfig',
  'ansible',
  'nomad',
];
const PREFIX: Record<IacKind, string> = {
  terraform: 'tf',
  cloudformation: 'cfn',
  kubernetes: 'k8s',
  compose: 'compose',
  clusterconfig: 'cluster',
  ansible: 'ansible',
  nomad: 'nomad',
};
const IMPORTERS: Record<IacKind, (files: IacFile[], options?: IacImportOptions) => Diagram> = {
  terraform: parseTerraform,
  cloudformation: parseCloudFormation,
  kubernetes: parseKubernetes,
  compose: parseCompose,
  clusterconfig: parseClusterConfig,
  ansible: parseAnsibleInventory,
  nomad: parseNomad,
};

const COMPOSE_NAME = /(^|[/\\])(docker-)?compose(\.[\w-]+)*\.ya?ml$/i;
const NOMAD_NAME = /\.nomad(\.hcl)?$/i;
const NOMAD_JOB = /(^|\n)\s*job\s+"[^"]+"\s*\{/;
const INVENTORY_NAME =
  /(^|[/\\])(hosts|inventory)(\.(ini|ya?ml))?$|(^|[/\\])inventor(y|ies)[/\\][^/\\]+$/i;
const YAML_INVENTORY = /(^|\n)all\s*:\s*(\r?\n)+\s+(hosts|children|vars)\s*:/;

/** Guesses the format of one file from its name and content. */
export function detectIac(path: string, content: string): IacKind | null {
  if (/\.tf$/i.test(path)) return 'terraform';
  if (NOMAD_NAME.test(path)) return 'nomad';
  if (/\.hcl$/i.test(path) && NOMAD_JOB.test(content) && /\b(group|task)\s+"/.test(content))
    return 'nomad';
  if (INVENTORY_NAME.test(path) || /\.ini$/i.test(path)) {
    if (/^\s*\[[^\]\n]+\]\s*$/m.test(content) || /(^|\n)all\s*:/.test(content)) return 'ansible';
  }
  if (COMPOSE_NAME.test(path)) return 'compose';
  if (/\.(tf\.json|tfvars|hcl|md|txt|ts|js|py)$/i.test(path)) return null;
  // Before CloudFormation/Kubernetes: k0sctl and Talos files also have apiVersion/kind keys.
  if (detectClusterConfig(path, content)) return 'clusterconfig';
  if (YAML_INVENTORY.test(content)) return 'ansible';
  if (/AWSTemplateFormatVersion/.test(content)) return 'cloudformation';
  if (
    /(^|[\n{,])\s*["']?Resources["']?\s*:/.test(content) &&
    /["']?Type["']?\s*:\s*["']?AWS::/.test(content)
  ) {
    return 'cloudformation';
  }
  if (
    /(^|\n)\s*["']?apiVersion["']?\s*:/.test(content) &&
    /(^|\n)\s*["']?kind["']?\s*:/.test(content)
  ) {
    return 'kubernetes';
  }
  if (/(^|\n)services\s*:/.test(content) || /^\s*\{[\s\S]*"services"\s*:\s*\{/.test(content))
    return 'compose';
  return null;
}

/** Detects each file's format, runs the matching importers and merges their diagrams. */
export function importIac(files: IacFile[], options: IacImportOptions = {}): IacImportResult {
  const byKind = new Map<IacKind, IacFile[]>();
  const skipped: string[] = [];
  for (const f of files) {
    const kind = detectIac(f.path, f.content);
    if (!kind) skipped.push(f.path);
    else byKind.set(kind, [...(byKind.get(kind) ?? []), f]);
  }
  const kinds = KINDS.filter((k) => byKind.has(k));
  const parts = kinds.map((k) => [k, IMPORTERS[k](byKind.get(k)!, options)] as const);
  if (parts.length === 1) return { diagram: parts[0]![1], kinds, skipped };

  const diagram = emptyDiagram();
  const taken: string[] = [];
  for (const [kind, d] of parts) {
    const rename = new Map<string, string>();
    for (const n of d.nodes) {
      const id = makeId(`${PREFIX[kind]}_${n.id}`, taken);
      taken.push(id);
      rename.set(n.id, id);
    }
    for (const n of d.nodes) {
      const node = { ...n, id: rename.get(n.id)! };
      if (n.parent) node.parent = rename.get(n.parent);
      diagram.nodes.push(node);
    }
    for (const e of d.edges)
      diagram.edges.push({ ...e, from: rename.get(e.from)!, to: rename.get(e.to)! });
  }
  return { diagram, kinds, skipped };
}
