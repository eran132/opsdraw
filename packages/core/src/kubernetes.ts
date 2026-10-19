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
 * Best-effort Kubernetes manifests -> architecture diagram.
 *
 * Workloads, Services, Ingresses/Gateways and PVCs become services. Namespaces become groups when
 * more than one appears. Services link to the workloads their selector matches, Ingresses and
 * routes link to their backend Services, and workloads link to the claims they mount.
 * ConfigMaps, Secrets, RBAC, HPAs and similar are hidden unless `includeAll` is set.
 */

export type KubernetesImportOptions = IacImportOptions;

interface K8sObject {
  kind: string;
  name: string;
  namespace: string;
  raw: Record<string, unknown>;
}

const WORKLOADS = new Set([
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'ReplicaSet',
  'Job',
  'CronJob',
  'Pod',
]);
const ROUTES = new Set(['HTTPRoute', 'GRPCRoute', 'TLSRoute', 'TCPRoute', 'UDPRoute']);
/** Hidden unless `includeAll`. */
const PLUMBING = new Set([
  'ConfigMap',
  'Secret',
  'ServiceAccount',
  'Role',
  'ClusterRole',
  'RoleBinding',
  'ClusterRoleBinding',
  'NetworkPolicy',
  'PodDisruptionBudget',
  'HorizontalPodAutoscaler',
  'VerticalPodAutoscaler',
  'LimitRange',
  'ResourceQuota',
  'PriorityClass',
  'StorageClass',
  'Endpoints',
  'EndpointSlice',
  'CustomResourceDefinition',
  'MutatingWebhookConfiguration',
  'ValidatingWebhookConfiguration',
  'IngressClass',
  'GatewayClass',
  'ReferenceGrant',
]);

/** Flattens the documents of every file into Kubernetes objects (expanding `kind: List`). */
function loadKubernetesObjects(files: IacFile[]): K8sObject[] {
  const out: K8sObject[] = [];
  const visit = (v: unknown) => {
    if (!isRecord(v) || typeof v.kind !== 'string') return;
    if (/List$/.test(v.kind) && Array.isArray(v.items)) {
      for (const item of v.items) visit(item);
      return;
    }
    const meta = isRecord(v.metadata) ? v.metadata : {};
    const name = asString(meta.name);
    if (!name) return;
    out.push({ kind: v.kind, name, namespace: asString(meta.namespace) ?? 'default', raw: v });
  };
  for (const f of files) for (const doc of loadYamlDocuments(f.content)) visit(doc);
  return out;
}

export function parseKubernetes(files: IacFile[], options: KubernetesImportOptions = {}): Diagram {
  const all = loadKubernetesObjects(files);
  const namespaceObjects = all.filter((o) => o.kind === 'Namespace');
  const objects = all.filter((o) => o.kind !== 'Namespace');
  const kept = objects.filter((o) => options.includeAll || !PLUMBING.has(o.kind));

  const diagram = emptyDiagram();
  const taken: string[] = [];
  const namespaces = [
    ...new Set([...namespaceObjects.map((o) => o.name), ...kept.map((o) => o.namespace)]),
  ];
  const groupIds = new Map<string, string>();
  if (namespaces.length > 1) {
    for (const ns of namespaces) {
      const id = makeId(`ns_${ns}`, taken);
      taken.push(id);
      groupIds.set(ns, id);
      diagram.nodes.push({ id, kind: 'group', label: ns, icon: 'lucide:layers' });
    }
  }

  const keyOf = (o: { kind: string; namespace: string; name: string }) =>
    `${o.kind}/${o.namespace}/${o.name}`;
  const nameCounts = new Map<string, number>();
  for (const o of kept) nameCounts.set(o.name, (nameCounts.get(o.name) ?? 0) + 1);
  const ids = new Map<string, string>();
  for (const o of kept) {
    const key = keyOf(o);
    if (ids.has(key)) continue;
    // Short ids when names are unique; kind-qualified when e.g. a Service and a Deployment share one.
    const base = nameCounts.get(o.name) === 1 ? o.name : `${o.kind.toLowerCase()}_${o.name}`;
    const id = makeId(base, taken);
    taken.push(id);
    ids.set(key, id);
    const node: ArchNode = { id, kind: 'service', label: o.name, icon: iconFor(o) };
    const parent = groupIds.get(o.namespace);
    if (parent) node.parent = parent;
    diagram.nodes.push(node);
  }

  const addEdge = edgeAdder(diagram);
  const link = (
    from: K8sObject,
    kind: string,
    name: string | undefined,
    namespace = from.namespace,
  ) => {
    if (!name) return;
    const a = ids.get(keyOf(from));
    const z = ids.get(keyOf({ kind, namespace, name }));
    if (a && z) addEdge(a, z);
  };

  for (const o of kept) {
    const spec = isRecord(o.raw.spec) ? o.raw.spec : {};
    if (o.kind === 'Service' && isRecord(spec.selector)) {
      const selector = Object.entries(spec.selector);
      if (!selector.length) continue;
      for (const w of kept) {
        if (!WORKLOADS.has(w.kind) || w.namespace !== o.namespace) continue;
        const labels = podTemplate(w).labels;
        if (selector.every(([k, v]) => asString(labels[k]) === asString(v)))
          link(o, w.kind, w.name);
      }
    } else if (o.kind === 'Ingress') {
      for (const name of ingressBackends(spec)) link(o, 'Service', name);
    } else if (ROUTES.has(o.kind)) {
      for (const p of asArray(spec.parentRefs)) {
        if (!isRecord(p)) continue;
        const ns = asString(p.namespace) ?? o.namespace;
        const g = ids.get(
          keyOf({
            kind: asString(p.kind) ?? 'Gateway',
            namespace: ns,
            name: asString(p.name) ?? '',
          }),
        );
        const r = ids.get(keyOf(o));
        if (g && r) addEdge(g, r);
      }
      for (const rule of asArray(spec.rules)) {
        if (!isRecord(rule)) continue;
        for (const b of asArray(rule.backendRefs)) {
          if (isRecord(b))
            link(o, asString(b.kind) ?? 'Service', asString(b.name), asString(b.namespace));
        }
      }
    } else if (WORKLOADS.has(o.kind)) {
      const pod = podTemplate(o).spec;
      for (const v of asArray(pod.volumes)) {
        if (!isRecord(v)) continue;
        if (isRecord(v.persistentVolumeClaim))
          link(o, 'PersistentVolumeClaim', asString(v.persistentVolumeClaim.claimName));
      }
      if (options.includeAll) {
        for (const [kind, name] of configRefs(pod)) link(o, kind, name);
      }
    } else if (o.kind === 'HorizontalPodAutoscaler' && isRecord(spec.scaleTargetRef)) {
      link(
        o,
        asString(spec.scaleTargetRef.kind) ?? 'Deployment',
        asString(spec.scaleTargetRef.name),
      );
    }
  }
  return diagram;
}

function iconFor(o: K8sObject): string {
  if (WORKLOADS.has(o.kind)) {
    const images = containers(podTemplate(o).spec)
      .map((c) => asString(c.image) ?? '')
      .join(' ');
    const byImage = iconForImage(`${images} ${o.name}`);
    if (byImage !== 'lucide:container') return byImage;
    if (o.kind === 'Job') return 'lucide:timer';
    if (o.kind === 'CronJob') return 'lucide:calendar-clock';
    return byImage;
  }
  switch (o.kind) {
    case 'Service':
      return 'lucide:split';
    case 'Ingress':
    case 'Gateway':
      return 'internet';
    case 'PersistentVolumeClaim':
    case 'PersistentVolume':
      return 'disk';
    case 'ConfigMap':
      return 'lucide:file-cog';
    case 'Secret':
      return 'lucide:key-round';
    case 'HorizontalPodAutoscaler':
    case 'VerticalPodAutoscaler':
      return 'lucide:activity';
    case 'NetworkPolicy':
      return 'lucide:shield';
    case 'ServiceAccount':
    case 'Role':
    case 'ClusterRole':
    case 'RoleBinding':
    case 'ClusterRoleBinding':
      return 'lucide:fingerprint';
  }
  return ROUTES.has(o.kind) ? 'lucide:waypoints' : 'lucide:box';
}

/** Pod template labels and spec of a workload (a Pod is its own template). */
function podTemplate(o: K8sObject): {
  labels: Record<string, unknown>;
  spec: Record<string, unknown>;
} {
  let t: unknown = o.raw;
  if (o.kind !== 'Pod') {
    let spec = isRecord(o.raw.spec) ? o.raw.spec : {};
    if (o.kind === 'CronJob') {
      const job = isRecord(spec.jobTemplate) ? spec.jobTemplate : {};
      spec = isRecord(job.spec) ? job.spec : {};
    }
    t = spec.template;
  }
  const tpl = isRecord(t) ? t : {};
  const meta = isRecord(tpl.metadata) ? tpl.metadata : {};
  return {
    labels: isRecord(meta.labels) ? meta.labels : {},
    spec: isRecord(tpl.spec) ? tpl.spec : {},
  };
}

function containers(pod: Record<string, unknown>): Record<string, unknown>[] {
  return [...asArray(pod.containers), ...asArray(pod.initContainers)].filter(isRecord);
}

function ingressBackends(spec: Record<string, unknown>): string[] {
  const out: string[] = [];
  const add = (b: unknown) => {
    if (!isRecord(b)) return;
    const name = isRecord(b.service) ? asString(b.service.name) : asString(b.serviceName);
    if (name) out.push(name);
  };
  add(spec.defaultBackend ?? spec.backend);
  for (const rule of asArray(spec.rules)) {
    if (!isRecord(rule) || !isRecord(rule.http)) continue;
    for (const p of asArray(rule.http.paths)) if (isRecord(p)) add(p.backend);
  }
  return out;
}

/** `[kind, name]` of every ConfigMap and Secret a pod spec mounts or reads. */
function configRefs(pod: Record<string, unknown>): [string, string | undefined][] {
  const out: [string, string | undefined][] = [];
  const volumeSource = (v: Record<string, unknown>) => {
    if (isRecord(v.configMap)) out.push(['ConfigMap', asString(v.configMap.name)]);
    if (isRecord(v.secret)) out.push(['Secret', asString(v.secret.secretName ?? v.secret.name)]);
  };
  for (const v of asArray(pod.volumes)) {
    if (!isRecord(v)) continue;
    volumeSource(v);
    if (isRecord(v.projected))
      for (const s of asArray(v.projected.sources)) if (isRecord(s)) volumeSource(s);
  }
  for (const c of containers(pod)) {
    for (const e of asArray(c.envFrom)) {
      if (!isRecord(e)) continue;
      if (isRecord(e.configMapRef)) out.push(['ConfigMap', asString(e.configMapRef.name)]);
      if (isRecord(e.secretRef)) out.push(['Secret', asString(e.secretRef.name)]);
    }
    for (const e of asArray(c.env)) {
      if (!isRecord(e) || !isRecord(e.valueFrom)) continue;
      if (isRecord(e.valueFrom.configMapKeyRef))
        out.push(['ConfigMap', asString(e.valueFrom.configMapKeyRef.name)]);
      if (isRecord(e.valueFrom.secretKeyRef))
        out.push(['Secret', asString(e.valueFrom.secretKeyRef.name)]);
    }
  }
  return out;
}
