import { parseAllDocuments } from 'yaml';
import type { ArchEdge, Diagram } from './model';

/** A source file handed to an infrastructure-as-code importer. */
export interface IacFile {
  path: string;
  content: string;
}

export interface IacImportOptions {
  /** Keep plumbing resources (policies, config, secrets, volumes...) as nodes. */
  includeAll?: boolean;
}

/** Returns an `addEdge(from, to)` that skips self-loops and duplicate pairs (in either direction). */
export function edgeAdder(diagram: Diagram): (from: string, to: string) => void {
  const seen = new Set<string>();
  return (from, to) => {
    if (from === to) return;
    const key = [from, to].sort().join('|');
    if (seen.has(key)) return;
    seen.add(key);
    const e: ArchEdge = { from, to, fromSide: 'R', toSide: 'L', arrowEnd: true };
    diagram.edges.push(e);
  };
}

/** Parses every YAML document in `content`, dropping documents that fail to parse. */
export function loadYamlDocuments(
  content: string,
  options: Parameters<typeof parseAllDocuments>[1] = {},
): unknown[] {
  const out: unknown[] = [];
  for (const doc of parseAllDocuments(content, { merge: true, ...options })) {
    if (doc.errors.length) continue;
    const value: unknown = doc.toJS({ maxAliasCount: 1000 });
    if (value !== null && value !== undefined) out.push(value);
  }
  return out;
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export const asString = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;

/** Icon for a container image (or a service name when there is no image). */
export function iconForImage(text: string): string {
  const s = text.toLowerCase();
  if (
    /postgres|mysql|mariadb|mongo|cockroach|cassandra|couchdb|timescale|clickhouse|mssql|sqlserver/.test(
      s,
    )
  )
    return 'database';
  if (/redis|memcache|valkey|keydb|dragonfly/.test(s)) return 'lucide:zap';
  if (/nginx|traefik|haproxy|envoy|caddy/.test(s)) return 'lucide:split';
  if (/rabbitmq|kafka|nats|redpanda|activemq|mosquitto|pulsar/.test(s)) return 'lucide:radio-tower';
  if (/minio/.test(s)) return 'lucide:archive';
  return 'lucide:container';
}
