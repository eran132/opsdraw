import type { ArchNode, Diagram } from './model';
import { emptyDiagram, makeId } from './model';
import type { IacFile, IacImportOptions } from './iac-shared';
import {
  asArray,
  asString,
  edgeAdder,
  iconForImage,
  isRecord,
  loadYamlDocuments,
} from './iac-shared';

/**
 * Best-effort Docker Compose -> architecture diagram.
 *
 * Services become nodes (icon picked from the image), `depends_on` and `links` become edges, and
 * named networks become groups when any service uses one (a service on several networks goes in
 * the first). Named volumes are hidden unless `includeAll` is set. Several files (an override
 * file next to the base one) are merged by service name.
 */

export type ComposeImportOptions = IacImportOptions;

export function parseCompose(files: IacFile[], options: ComposeImportOptions = {}): Diagram {
  const services = new Map<string, Record<string, unknown>>();
  const topVolumes = new Set<string>();
  for (const f of files) {
    for (const doc of loadYamlDocuments(f.content)) {
      if (!isRecord(doc)) continue;
      if (isRecord(doc.services)) {
        for (const [name, s] of Object.entries(doc.services)) {
          services.set(name, { ...(services.get(name) ?? {}), ...(isRecord(s) ? s : {}) });
        }
      }
      if (isRecord(doc.volumes)) for (const v of Object.keys(doc.volumes)) topVolumes.add(v);
    }
  }

  const diagram = emptyDiagram();
  const taken: string[] = [];
  const take = (base: string) => {
    const id = makeId(base, taken);
    taken.push(id);
    return id;
  };
  const serviceIds = new Map<string, string>();
  for (const name of services.keys()) serviceIds.set(name, take(name));

  // Groups only for named networks; everything on `default` alone stays top-level.
  const firstNetwork = new Map<string, string>();
  for (const [name, s] of services) {
    const net = networksOf(s)[0];
    if (net && net !== 'default') firstNetwork.set(name, net);
  }
  const groupIds = new Map<string, string>();
  for (const net of new Set(firstNetwork.values())) {
    const id = take(services.has(net) ? `${net}_net` : net);
    groupIds.set(net, id);
    diagram.nodes.push({ id, kind: 'group', label: net, icon: 'lucide:network' });
  }

  for (const [name, s] of services) {
    const image = asString(s.image);
    const node: ArchNode = {
      id: serviceIds.get(name)!,
      kind: 'service',
      label: name,
      icon: iconForImage(image ?? name),
    };
    const net = firstNetwork.get(name);
    if (net) node.parent = groupIds.get(net);
    diagram.nodes.push(node);
  }

  const addEdge = edgeAdder(diagram);
  for (const [name, s] of services) {
    const from = serviceIds.get(name)!;
    const deps = Array.isArray(s.depends_on)
      ? s.depends_on.map(asString)
      : isRecord(s.depends_on)
        ? Object.keys(s.depends_on)
        : [];
    const links = asArray(s.links).map((l) => asString(l)?.split(':')[0]);
    for (const dep of [...deps, ...links]) {
      const to = dep && serviceIds.get(dep);
      if (to) addEdge(from, to);
    }
  }

  if (options.includeAll) {
    const volumeIds = new Map<string, string>();
    const volumeId = (v: string) => {
      let id = volumeIds.get(v);
      if (!id) {
        id = take(services.has(v) || groupIds.has(v) ? `${v}_vol` : v);
        volumeIds.set(v, id);
        diagram.nodes.push({ id, kind: 'service', label: v, icon: 'disk' });
      }
      return id;
    };
    for (const v of topVolumes) volumeId(v);
    for (const [name, s] of services) {
      for (const v of namedVolumesOf(s, topVolumes)) addEdge(serviceIds.get(name)!, volumeId(v));
    }
  }
  return diagram;
}

function networksOf(s: Record<string, unknown>): string[] {
  if (Array.isArray(s.networks)) return s.networks.map(asString).filter((n): n is string => !!n);
  if (isRecord(s.networks)) return Object.keys(s.networks);
  return [];
}

/** Named volumes a service mounts (bind mounts and anonymous volumes are skipped). */
function namedVolumesOf(s: Record<string, unknown>, declared: Set<string>): string[] {
  const out: string[] = [];
  for (const v of asArray(s.volumes)) {
    let source: string | undefined;
    if (typeof v === 'string') {
      const parts = v.split(':');
      if (parts.length > 1) source = parts[0];
    } else if (isRecord(v) && (v.type === undefined || v.type === 'volume')) {
      source = asString(v.source);
    }
    // Compose requires named volumes to be declared at the top level; anything else is a path.
    if (source && declared.has(source)) out.push(source);
  }
  return out;
}
