import type { Diagram } from './model';
import { emptyDiagram, makeId } from './model';
import type { IacFile, IacImportOptions } from './iac-shared';
import { parseTerraformWithWarnings } from './terraform';
import { parseCloudFormation } from './cloudformation';
import { parseKubernetes } from './kubernetes';
import { parseCompose } from './compose';
import { detectClusterConfig, parseClusterConfig } from './clusterconfig';
import { parseAnsibleInventory } from './ansible';
import { parseNomad } from './nomad';
import { isTerraformJson, parseTerraformJson } from './tfjson';

export type { IacFile, IacImportOptions } from './iac-shared';

/** File extensions that may hold infrastructure code (used when walking directories). */
export const IAC_EXTENSIONS = [
  '.tf',
  '.tofu',
  '.yaml',
  '.yml',
  '.json',
  '.template',
  '.tfstate',
  '.ini',
  '.nomad',
  '.hcl',
] as const;
/** Ansible inventories are often extension-less files with these names. */
export const IAC_BARE_NAMES = ['hosts', 'inventory'] as const;

export type IacKind =
  | 'terraform'
  | 'tfjson'
  | 'cloudformation'
  | 'kubernetes'
  | 'compose'
  | 'clusterconfig'
  | 'ansible'
  | 'nomad';

export interface IacImportResult {
  diagram: Diagram;
  /** Kinds that were detected and imported, in a stable order. */
  kinds: IacKind[];
  /** Paths of files that were not recognized as any supported format. */
  skipped: string[];
  /** `.tf` files ignored because a `.tofu` file with the same name exists (OpenTofu rule). */
  overridden: string[];
  /** Non-fatal problems, such as Terraform modules whose source isn't among the files. */
  warnings: string[];
}

const KINDS: IacKind[] = [
  'terraform',
  'tfjson',
  'cloudformation',
  'kubernetes',
  'compose',
  'clusterconfig',
  'ansible',
  'nomad',
];
const PREFIX: Record<IacKind, string> = {
  terraform: 'tf',
  tfjson: 'tfjson',
  cloudformation: 'cfn',
  kubernetes: 'k8s',
  compose: 'compose',
  clusterconfig: 'cluster',
  ansible: 'ansible',
  nomad: 'nomad',
};
const IMPORTERS: Record<IacKind, (files: IacFile[], options?: IacImportOptions) => Diagram> = {
  terraform: (files, options) => parseTerraformWithWarnings(files, options).diagram,
  tfjson: parseTerraformJson,
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
  // OpenTofu reads the same HCL; `.tofu` files (OpenTofu 1.8+) are OpenTofu-only.
  if (/\.(tf|tofu)$/i.test(path)) return 'terraform';
  if (NOMAD_NAME.test(path)) return 'nomad';
  if (/\.hcl$/i.test(path) && NOMAD_JOB.test(content) && /\b(group|task)\s+"/.test(content))
    return 'nomad';
  if (INVENTORY_NAME.test(path) || /\.ini$/i.test(path)) {
    if (/^\s*\[[^\]\n]+\]\s*$/m.test(content) || /(^|\n)all\s*:/.test(content)) return 'ansible';
  }
  // `terraform show -json` / `tofu show -json` output and raw state files.
  if (/\.(json|tfstate)$/i.test(path) || /(^|[/\\])terraform\.tfstate(\.backup)?$/i.test(path)) {
    if (isTerraformJson(content)) return 'tfjson';
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

/**
 * OpenTofu loads `foo.tofu` instead of `foo.tf` when both are in the same directory; apply the
 * same rule so the diagram shows what `tofu` would deploy.
 */
export function applyTofuOverrides(files: IacFile[]): { files: IacFile[]; overridden: string[] } {
  const key = (path: string) =>
    path
      .replace(/\\/g, '/')
      .replace(/\.(tf|tofu)$/i, '')
      .toLowerCase();
  const tofu = new Set(files.filter((f) => /\.tofu$/i.test(f.path)).map((f) => key(f.path)));
  const overridden = files
    .filter((f) => /\.tf$/i.test(f.path) && tofu.has(key(f.path)))
    .map((f) => f.path);
  return { files: files.filter((f) => !overridden.includes(f.path)), overridden };
}

/** Detects each file's format, runs the matching importers and merges their diagrams. */
export function importIac(input: IacFile[], options: IacImportOptions = {}): IacImportResult {
  const { files, overridden } = applyTofuOverrides(input);
  const byKind = new Map<IacKind, IacFile[]>();
  const skipped: string[] = [];
  for (const f of files) {
    const kind = detectIac(f.path, f.content);
    if (!kind) skipped.push(f.path);
    else byKind.set(kind, [...(byKind.get(kind) ?? []), f]);
  }
  const kinds = KINDS.filter((k) => byKind.has(k));
  const warnings: string[] = [];
  const parts = kinds.map((k) => {
    if (k !== 'terraform') return [k, IMPORTERS[k](byKind.get(k)!, options)] as const;
    const r = parseTerraformWithWarnings(byKind.get(k)!, options);
    warnings.push(...r.warnings);
    return [k, r.diagram] as const;
  });
  if (parts.length === 1) return { diagram: parts[0]![1], kinds, skipped, overridden, warnings };

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
  return { diagram, kinds, skipped, overridden, warnings };
}
