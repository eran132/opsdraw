import { parse } from '@mermaid-js/parser';
import { describe, expect, it } from 'vitest';
import { detectClusterConfig, parseClusterConfig } from '../src/clusterconfig';
import { parseKubernetes } from '../src/kubernetes';
import { isValidId, parseArchitecture, serializeArchitecture, type Diagram } from '../src';

const byId = (d: Diagram) => Object.fromEntries(d.nodes.map((n) => [n.id, n]));
const byLabel = (d: Diagram) => Object.fromEntries(d.nodes.map((n) => [n.label ?? n.id, n]));
const pairs = (d: Diagram) => d.edges.map((e) => `${e.from}->${e.to}`).sort();
const labelPairs = (d: Diagram) => {
  const n = byId(d);
  return d.edges.map((e) => `${n[e.from]!.label}->${n[e.to]!.label}`).sort();
};

async function expectMermaidAccepts(d: Diagram) {
  for (const n of d.nodes) expect(isValidId(n.id), n.id).toBe(true);
  const text = serializeArchitecture(d);
  let error: string | null = null;
  try {
    await parse('architecture', text);
  } catch (e) {
    error = String((e as Error).message);
  }
  expect(error, text).toBeNull();
  expect(parseArchitecture(text).errors).toEqual([]);
}

const OPENSHIFT = `apiVersion: apps/v1
kind: Deployment
metadata: { name: Frontend, namespace: shop }
spec:
  selector: { matchLabels: { app: frontend } }
  template:
    metadata: { labels: { app: frontend } }
    spec: { containers: [{ name: web, image: quay.io/acme/frontend:1.4 }] }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: frontend-canary, namespace: shop }
spec:
  template:
    metadata: { labels: { app: frontend-canary } }
    spec: { containers: [{ name: web, image: quay.io/acme/frontend:1.5 }] }
---
apiVersion: v1
kind: Service
metadata: { name: Frontend-svc, namespace: shop }
spec:
  selector: { app: frontend }
  ports: [{ port: 8080 }]
---
apiVersion: v1
kind: Service
metadata: { name: canary-svc, namespace: shop }
spec:
  selector: { app: frontend-canary }
---
apiVersion: route.openshift.io/v1
kind: Route
metadata: { name: Storefront, namespace: shop }
spec:
  host: shop.apps.ocp.example.com
  to: { kind: Service, name: Frontend-svc, weight: 90 }
  alternateBackends:
    - { kind: Service, name: canary-svc, weight: 10 }
  port: { targetPort: 8080 }
  tls: { termination: edge }
`;

const KUBEVIRT = `apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: Legacy-ERP
  namespace: vms
spec:
  running: true
  template:
    metadata:
      labels: { kubevirt.io/domain: legacy-erp, app: erp }
    spec:
      domain:
        devices:
          disks: [{ name: rootdisk, disk: { bus: virtio } }]
        resources: { requests: { memory: 8Gi } }
      volumes:
        - name: rootdisk
          dataVolume: { name: erp-root }
---
apiVersion: cdi.kubevirt.io/v1beta1
kind: DataVolume
metadata: { name: erp-root, namespace: vms }
spec:
  source: { http: { url: "https://images.example.com/erp.qcow2" } }
  pvc: { accessModes: [ReadWriteOnce], resources: { requests: { storage: 40Gi } } }
---
apiVersion: kubevirt.io/v1
kind: VirtualMachineInstance
metadata:
  name: bastion
  namespace: vms
  labels: { app: bastion }
spec:
  domain: { devices: {} }
---
apiVersion: v1
kind: Service
metadata: { name: erp, namespace: vms }
spec:
  selector: { app: erp }
  ports: [{ port: 443 }]
---
apiVersion: v1
kind: Service
metadata: { name: bastion-ssh, namespace: vms }
spec:
  type: LoadBalancer
  selector: { app: bastion }
  ports: [{ port: 22 }]
`;

const GATEWAY_API = `apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata: { name: Edge, namespace: infra }
spec:
  gatewayClassName: cilium
  listeners: [{ name: https, protocol: HTTPS, port: 443 }]
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: { name: api-route, namespace: apps }
spec:
  parentRefs: [{ name: Edge, namespace: infra }]
  rules:
    - backendRefs: [{ name: api, port: 80 }]
---
apiVersion: gateway.networking.k8s.io/v1
kind: GRPCRoute
metadata: { name: grpc-route, namespace: apps }
spec:
  parentRefs: [{ name: Edge, namespace: infra }]
  rules:
    - backendRefs: [{ name: grpc, port: 9000 }]
---
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: TCPRoute
metadata: { name: db-route, namespace: apps }
spec:
  parentRefs: [{ name: Edge, namespace: infra }]
  rules:
    - backendRefs: [{ name: grpc, port: 5432 }]
---
apiVersion: v1
kind: Service
metadata: { name: api, namespace: apps }
spec: { selector: { app: api } }
---
apiVersion: v1
kind: Service
metadata: { name: grpc, namespace: apps }
spec: { selector: { app: grpc } }
`;

const PACKAGES = `apiVersion: helm.cattle.io/v1
kind: HelmChart
metadata: { name: traefik, namespace: kube-system }
spec:
  chart: traefik
  repo: https://traefik.github.io/charts
  targetNamespace: traefik
---
apiVersion: helm.cattle.io/v1
kind: HelmChart
metadata: { name: Monitoring, namespace: kube-system }
spec:
  chart: kube-prometheus-stack
  repo: https://prometheus-community.github.io/helm-charts
---
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata: { name: podinfo, namespace: kube-system }
spec:
  interval: 10m
  chart:
    spec:
      chart: podinfo
      sourceRef: { kind: HelmRepository, name: podinfo }
---
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata: { name: Redis, namespace: kube-system }
spec:
  chartRef: { kind: OCIRepository, name: bitnami-redis }
---
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata: { name: guestbook, namespace: kube-system }
spec:
  project: default
  source:
    repoURL: https://github.com/argoproj/argocd-example-apps.git
    path: helm-guestbook
  destination: { server: "https://kubernetes.default.svc", namespace: guestbook }
`;

describe('kubernetes distro extensions', () => {
  it('links OpenShift Routes to their target and alternate backends', async () => {
    const d = parseKubernetes([{ path: 'ocp.yaml', content: OPENSHIFT }]);
    const n = byLabel(d);
    expect(n.Storefront).toMatchObject({ kind: 'service', icon: 'lucide:waypoints' });
    expect(labelPairs(d)).toEqual([
      'Frontend-svc->Frontend',
      'Storefront->Frontend-svc',
      'Storefront->canary-svc',
      'canary-svc->frontend-canary',
    ]);
    expect(n.Storefront!.id).toBe('storefront');
    await expectMermaidAccepts(d);
  });

  it('treats KubeVirt / Harvester VMs as selectable workloads', async () => {
    const d = parseKubernetes([{ path: 'vms.yaml', content: KUBEVIRT }]);
    const n = byLabel(d);
    expect(n['Legacy-ERP']).toMatchObject({ icon: 'server', id: 'legacy-erp' });
    expect(n.bastion!.icon).toBe('server');
    expect(n['erp-root']!.icon).toBe('disk');
    expect(labelPairs(d)).toEqual([
      'Legacy-ERP->erp-root',
      'bastion-ssh->bastion',
      'erp->Legacy-ERP',
    ]);
    await expectMermaidAccepts(d);
  });

  it('links Gateways to routes and routes to backend Services', async () => {
    const d = parseKubernetes([{ path: 'gw.yaml', content: GATEWAY_API }]);
    const n = byLabel(d);
    expect(n.Edge).toMatchObject({ icon: 'lucide:router', id: 'edge', parent: 'ns_infra' });
    for (const r of ['api-route', 'grpc-route', 'db-route'])
      expect(n[r]!.icon).toBe('lucide:waypoints');
    expect(labelPairs(d)).toEqual([
      'Edge->api-route',
      'Edge->db-route',
      'Edge->grpc-route',
      'api-route->api',
      'db-route->grpc',
      'grpc-route->grpc',
    ]);
    await expectMermaidAccepts(d);
  });

  it('shows HelmCharts, HelmReleases and Argo CD Applications as packages', async () => {
    const d = parseKubernetes([{ path: 'packages.yaml', content: PACKAGES }]);
    expect(d.nodes.map((x) => [x.id, x.label, x.icon])).toEqual([
      ['traefik', 'traefik', 'lucide:package'],
      ['monitoring', 'Monitoring (kube-prometheus-stack)', 'lucide:package'],
      ['podinfo', 'podinfo', 'lucide:package'],
      ['redis', 'Redis (bitnami-redis)', 'lucide:package'],
      ['guestbook', 'guestbook (helm-guestbook)', 'lucide:package'],
    ]);
    await expectMermaidAccepts(d);
  });
});

const K0SCTL = `apiVersion: k0sctl.k0sproject.io/v1beta1
kind: Cluster
metadata:
  name: Lab-Cluster
spec:
  hosts:
    - role: controller
      ssh: { address: 10.0.0.11, user: root, port: 22, keyPath: ~/.ssh/id_ed25519 }
    - role: controller+worker
      ssh: { address: 10.0.0.12, user: root }
    - role: worker
      ssh: { address: 10.0.0.21, user: root }
      hostname: Backend-worker
    - role: worker
      hostname: worker-b
      openSSH: { address: worker-b.lab }
    - not-a-host
  k0s:
    version: v1.30.4+k0s.0
    config:
      apiVersion: k0s.k0sproject.io/v1beta1
      kind: ClusterConfig
      spec:
        api: { externalAddress: lb.lab.example.com, sans: [10.0.0.10] }
`;

const TALOS_CP = `version: v1alpha1
debug: false
persist: true
machine:
  type: controlplane
  token: abc.def
  network:
    hostname: Talos-cp-1
    interfaces:
      - interface: eth0
        addresses: [192.168.50.11/24]
  install: { disk: /dev/sda, image: ghcr.io/siderolabs/installer:v1.8.0 }
cluster:
  id: Zm9v
  clusterName: Homelab
  controlPlane:
    endpoint: https://192.168.50.10:6443
  network: { dnsDomain: cluster.local, podSubnets: [10.244.0.0/16] }
`;

const TALOS_CP2 = `version: v1alpha1
machine:
  type: controlplane
  network:
    interfaces:
      - interface: eth0
        addresses: [192.168.50.12/24]
cluster:
  clusterName: Homelab
  controlPlane: { endpoint: https://192.168.50.10:6443 }
`;

const TALOS_WORKER_MULTIDOC = `version: v1alpha1
machine:
  type: worker
  install: { disk: /dev/nvme0n1 }
cluster:
  clusterName: Homelab
  controlPlane:
    endpoint: https://192.168.50.10:6443
---
apiVersion: v1alpha1
kind: HostnameConfig
hostname: Rpi-worker
auto: off
`;

const K3S_SERVER = `cluster-init: true
token: "K10secret::server:abc"
tls-san:
  - k3s.lab.example.com
  - 10.1.0.10
write-kubeconfig-mode: "0644"
node-name: Lab-server-1
disable: [traefik]
`;

const K3S_SERVER2 = `server: https://k3s.lab.example.com:6443
token: "K10secret::server:abc"
tls-san: [k3s.lab.example.com]
node-name: lab-server-2
`;

const K3S_AGENT = `server: https://k3s.lab.example.com:6443
token: "K10secret::server:abc"
node-label:
  - "topology.kubernetes.io/zone=a"
`;

const RKE2_AGENT = `server: https://10.2.0.10:9345
token: my-shared-secret
node-name: rke2-agent-1
node-ip: 10.2.0.21
`;

describe('cluster config import', () => {
  it('detects k0sctl, Talos and RKE2 / k3s files and nothing else', () => {
    expect(detectClusterConfig('k0sctl.yaml', K0SCTL)).toBe('k0sctl');
    expect(detectClusterConfig('controlplane.yaml', TALOS_CP)).toBe('talos');
    expect(detectClusterConfig('worker.yaml', TALOS_WORKER_MULTIDOC)).toBe('talos');
    expect(detectClusterConfig('/etc/rancher/k3s/config.yaml', K3S_SERVER)).toBe('rke2');
    expect(detectClusterConfig('agent/config.yaml', K3S_AGENT)).toBe('rke2');
    expect(detectClusterConfig('rke2/config.yaml', RKE2_AGENT)).toBe('rke2');
    expect(detectClusterConfig('k8s.yaml', OPENSHIFT)).toBeNull();
    expect(detectClusterConfig('compose.yaml', 'services:\n  web: { image: nginx }\n')).toBeNull();
    expect(detectClusterConfig('values.yaml', 'replicaCount: 2\nimage: { tag: x }\n')).toBeNull();
    expect(detectClusterConfig('notes.md', K3S_SERVER)).toBeNull();
  });

  it('turns a k0sctl Cluster into control-plane and worker groups', async () => {
    const d = parseClusterConfig([{ path: 'k0sctl.yaml', content: K0SCTL }]);
    const n = byId(d);
    expect(n['cluster_lab-cluster']).toMatchObject({ kind: 'group', label: 'Lab-Cluster' });
    const cp = d.nodes.find((x) => x.label === 'Control plane')!;
    const workers = d.nodes.find((x) => x.label === 'Workers')!;
    expect(cp).toMatchObject({ kind: 'group', parent: 'cluster_lab-cluster' });
    expect(workers).toMatchObject({ kind: 'group', parent: 'cluster_lab-cluster' });
    const hosts = d.nodes.filter(
      (x) => x.kind === 'service' && x.parent !== n['cluster_lab-cluster']!.id,
    );
    expect(hosts.map((h) => [h.label, h.icon, h.parent])).toEqual([
      ['10.0.0.11', 'lucide:server-cog', cp.id],
      ['10.0.0.12', 'lucide:server-cog', cp.id],
      ['10.0.0.21', 'server', workers.id],
      ['worker-b', 'server', workers.id],
    ]);
    expect(byLabel(d)['10.0.0.11']!.id).toBe('node_10_0_0_11');
    expect(byLabel(d)['lb.lab.example.com']!.icon).toBe('lucide:split');
    expect(labelPairs(d)).toEqual([
      'lb.lab.example.com->10.0.0.11',
      'lb.lab.example.com->10.0.0.12',
    ]);
    await expectMermaidAccepts(d);
  });

  it('groups Talos machine configs by cluster with the endpoint in front', async () => {
    const d = parseClusterConfig([
      { path: 'talos/controlplane.yaml', content: TALOS_CP },
      { path: 'talos/cp2.yaml', content: TALOS_CP2 },
      { path: 'talos/worker.yaml', content: TALOS_WORKER_MULTIDOC },
    ]);
    const n = byLabel(d);
    expect(n.Homelab).toMatchObject({ kind: 'group', id: 'cluster_homelab' });
    expect(n['Talos-cp-1']).toMatchObject({ icon: 'lucide:server-cog', id: 'talos-cp-1' });
    expect(n['192.168.50.12']!.icon).toBe('lucide:server-cog');
    expect(n['Rpi-worker']).toMatchObject({ icon: 'server', parent: n.Workers!.id });
    expect(n['Talos-cp-1']!.parent).toBe(n['Control plane']!.id);
    expect(n['https://192.168.50.10:6443']).toMatchObject({
      icon: 'lucide:split',
      parent: 'cluster_homelab',
    });
    expect(labelPairs(d)).toEqual([
      'Rpi-worker->https://192.168.50.10:6443',
      'https://192.168.50.10:6443->192.168.50.12',
      'https://192.168.50.10:6443->Talos-cp-1',
    ]);
    await expectMermaidAccepts(d);
  });

  it('builds one k3s cluster from per-node config.yaml files', async () => {
    const d = parseClusterConfig([
      { path: 'nodes/server1/config.yaml', content: K3S_SERVER },
      { path: 'nodes/server2/config.yaml', content: K3S_SERVER2 },
      { path: 'nodes/agent-a/config.yaml', content: K3S_AGENT },
    ]);
    const n = byLabel(d);
    expect(n['k3s cluster']).toMatchObject({ kind: 'group' });
    expect(n['Lab-server-1']!.parent).toBe(n['Control plane']!.id);
    expect(n['lab-server-2']!.parent).toBe(n['Control plane']!.id);
    expect(n['agent-a']!.parent).toBe(n.Workers!.id);
    expect(labelPairs(d)).toEqual([
      'agent-a->https://k3s.lab.example.com:6443',
      'https://k3s.lab.example.com:6443->Lab-server-1',
      'lab-server-2->https://k3s.lab.example.com:6443',
    ]);
    await expectMermaidAccepts(d);
  });

  it('labels RKE2 clusters and links agents to the supervisor URL', async () => {
    const d = parseClusterConfig([{ path: 'rke2/agent/config.yaml', content: RKE2_AGENT }]);
    const n = byLabel(d);
    expect(n['RKE2 cluster']).toMatchObject({ kind: 'group' });
    expect(n['rke2-agent-1']!.icon).toBe('server');
    expect(pairs(d)).toEqual([`${n['rke2-agent-1']!.id}->${n['https://10.2.0.10:9345']!.id}`]);
    await expectMermaidAccepts(d);
  });

  it('never throws on odd input and keeps what it can', async () => {
    const d = parseClusterConfig([
      { path: 'broken.yaml', content: 'machine: [unclosed\n  - : :\n' },
      { path: 'empty.yaml', content: '' },
      { path: 'scalar.yaml', content: '42\n' },
      {
        path: 'k0s.yaml',
        content: 'apiVersion: k0sctl.k0sproject.io/v1beta1\nkind: Cluster\nspec: { hosts: 7 }\n',
      },
      { path: 'talos.yaml', content: 'machine: { type: 5 }\ncluster: null\n' },
      { path: 'k3s/config.yaml', content: K3S_AGENT },
    ]);
    expect(d.nodes.some((x) => x.label === 'agent-a' || x.label === 'k3s')).toBe(true);
    await expectMermaidAccepts(d);
  });
});
