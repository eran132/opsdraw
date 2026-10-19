import type { Diagram } from './model';
import { emptyDiagram, makeId } from './model';
import type { IacFile, IacImportOptions } from './iac-shared';
import { parseTerraform } from './terraform';
import { parseCloudFormation } from './cloudformation';
import { parseKubernetes } from './kubernetes';
import { parseCompose } from './compose';

export type { IacFile, IacImportOptions } from './iac-shared';

export type IacKind = 'terraform' | 'cloudformation' | 'kubernetes' | 'compose';

export interface IacImportResult {
  diagram: Diagram;
  /** Kinds that were detected and imported, in a stable order. */
  kinds: IacKind[];
  /** Paths of files that were not recognized as any supported format. */
  skipped: string[];
}

const KINDS: IacKind[] = ['terraform', 'cloudformation', 'kubernetes', 'compose'];
const PREFIX: Record<IacKind, string> = {
  terraform: 'tf',
  cloudformation: 'cfn',
  kubernetes: 'k8s',
  compose: 'compose',
};
const IMPORTERS: Record<IacKind, (files: IacFile[], options?: IacImportOptions) => Diagram> = {
  terraform: parseTerraform,
  cloudformation: parseCloudFormation,
  kubernetes: parseKubernetes,
  compose: parseCompose,
};

const COMPOSE_NAME = /(^|[/\\])(docker-)?compose(\.[\w-]+)*\.ya?ml$/i;

/** Guesses the format of one file from its name and content. */
export function detectIac(path: string, content: string): IacKind | null {
  if (/\.tf$/i.test(path)) return 'terraform';
  if (COMPOSE_NAME.test(path)) return 'compose';
  if (/\.(tf\.json|tfvars|hcl|md|txt|ts|js|py)$/i.test(path)) return null;
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
