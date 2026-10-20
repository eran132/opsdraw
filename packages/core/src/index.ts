export * from './model';
export * from './mermaid';
export * from './flowchart';
export * from './terraform';
export * from './cloudformation';
export * from './kubernetes';
export * from './compose';
export * from './iac';
export * from './clusterconfig';
export * from './ansible';
export * from './nomad';
export * from './tfjson';
export * from './icons';
export * from './layout';
export * from './svg';
export * from './style';
export * from './png';

import { parseArchitecture } from './mermaid';
import { parseFlowchart } from './flowchart';
import type { ParseResult } from './model';

/** Parses either an architecture diagram or a flowchart, based on the header. */
export function parseMermaid(source: string): ParseResult & { kind: 'architecture' | 'flowchart' } {
  const header = source
    .replace(/^---[\s\S]*?\n---\s*\n/, '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('%%'));
  if (header && /^(flowchart|graph)\b/.test(header)) {
    return { ...parseFlowchart(source), kind: 'flowchart' };
  }
  return { ...parseArchitecture(source), kind: 'architecture' };
}
export * from './merge';
export * from './lint';
export * from './merge3';
