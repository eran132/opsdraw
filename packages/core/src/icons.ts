/**
 * Icon references in diagrams are either Mermaid's built-in architecture icons or
 * Iconify-style `prefix:name` strings. The bundled, vendor-neutral set is Lucide (ISC licensed).
 * Vendor icon packs (AWS, Azure, GCP, ...) are never bundled: users import the official
 * downloads themselves, under the vendor's terms, and they get their own prefix.
 */

/** Icons every Mermaid renderer knows without registering a pack. */
export const MERMAID_BUILTIN_ICONS = ['cloud', 'database', 'disk', 'internet', 'server'] as const;

/** Lucide equivalents used to draw the built-ins on the canvas. */
export const BUILTIN_TO_LUCIDE: Record<string, string> = {
  cloud: 'cloud',
  database: 'database',
  disk: 'hard-drive',
  internet: 'globe',
  server: 'server',
};

export interface IconEntry {
  /** The reference written into the diagram. */
  ref: string;
  /** English display name; the app translates it (`icons.<key>`, see `catalogKey`). */
  title: string;
  /** English search keywords. */
  keywords: string;
}

export interface IconCategory {
  id: string;
  icons: IconEntry[];
}

const l = (name: string, title: string, keywords: string): IconEntry => ({
  ref: `lucide:${name}`,
  title,
  keywords,
});
const b = (name: string, title: string, keywords: string): IconEntry => ({
  ref: name,
  title,
  keywords,
});

/** Curated starter palette. Any other Lucide icon can still be found by search. */
export const GENERIC_CATALOG: IconCategory[] = [
  {
    id: 'compute',
    icons: [
      b('server', 'Server', 'server vm instance host compute ec2'),
      l('cpu', 'CPU', 'cpu compute processor'),
      l('square-function', 'Function', 'function serverless lambda faas'),
      l('container', 'Container', 'container docker'),
      l('package', 'Kubernetes pod', 'pod kubernetes k8s workload deployment'),
      l('boxes', 'Cluster', 'cluster kubernetes k8s nodes'),
      l('box', 'Component', 'box generic component'),
      l('package-search', 'Container registry', 'registry container image ecr acr gcr docker hub'),
    ],
  },
  {
    id: 'data',
    icons: [
      b('database', 'Database', 'database sql rds postgres mysql db'),
      b('disk', 'Disk', 'disk volume block storage ebs'),
      l('archive', 'Object storage', 'object storage bucket blob s3 archive'),
      l('folder-tree', 'File share', 'file share nfs filesystem'),
      l('table', 'Data warehouse', 'warehouse analytics table'),
      l('zap', 'Cache', 'cache redis memcached'),
      l('database-backup', 'Backup', 'backup restore snapshot recovery'),
      l('search', 'Search', 'search elasticsearch opensearch index'),
      l('chart-line', 'Analytics', 'analytics bi dashboard reporting'),
    ],
  },
  {
    id: 'network',
    icons: [
      b('internet', 'Internet', 'internet public web globe'),
      b('cloud', 'Cloud', 'cloud region provider'),
      l('network', 'Network', 'network vpc vnet subnet'),
      l('split', 'Load balancer', 'load balancer lb alb nlb'),
      l('door-open', 'API gateway', 'api gateway apigw ingress entry'),
      l('router', 'Router / gateway', 'router gateway nat'),
      l('waypoints', 'DNS / CDN', 'dns cdn edge route'),
      l('globe-lock', 'VPN', 'vpn tunnel ipsec wireguard private link'),
    ],
  },
  {
    id: 'messaging',
    icons: [
      l('list-ordered', 'Queue', 'queue sqs fifo'),
      l('radio-tower', 'Pub/Sub', 'pubsub topic sns event bus kafka'),
      l('webhook', 'API / webhook', 'webhook api callback'),
      l('mail', 'Email', 'email smtp mail'),
      l('bell', 'Notifications', 'notification alert'),
      l('workflow', 'Workflow', 'workflow orchestration step functions pipeline'),
    ],
  },
  {
    id: 'security',
    icons: [
      l('brick-wall', 'Firewall', 'firewall acl security group nsg network policy'),
      l('shield', 'Security / WAF', 'waf security firewall protection'),
      l('key-round', 'Secrets / keys', 'secret key vault kms'),
      l('lock', 'Encryption', 'tls encryption private'),
      l('fingerprint', 'Identity', 'identity iam auth sso'),
    ],
  },
  {
    id: 'clients',
    icons: [
      l('user', 'User', 'user person actor'),
      l('users', 'Users', 'users team customers'),
      l('monitor', 'Client', 'browser desktop client'),
      l('smartphone', 'Mobile app', 'mobile phone app'),
    ],
  },
  {
    id: 'ops',
    icons: [
      l('activity', 'Monitoring', 'monitoring metrics observability'),
      l('scroll-text', 'Logs', 'logs logging audit'),
      l('git-branch', 'CI/CD', 'git ci cd repository'),
      l('settings', 'Configuration', 'config settings'),
    ],
  },
];

/** Translation key of a curated icon: its name without the prefix (`lucide:split` -> `split`). */
export const catalogKey = (ref: string): string => parseIconRef(ref).name;

const CATALOG_BY_REF = new Map(GENERIC_CATALOG.flatMap((c) => c.icons.map((i) => [i.ref, i])));

/** The curated entry for an icon reference, if it is one of the palette's icons. */
export const catalogEntry = (ref: string | undefined): IconEntry | undefined =>
  ref === undefined ? undefined : CATALOG_BY_REF.get(ref);

/** Splits `prefix:name`; built-ins have no prefix. */
export function parseIconRef(ref: string): { prefix: string | null; name: string } {
  const i = ref.indexOf(':');
  return i === -1
    ? { prefix: null, name: ref }
    : { prefix: ref.slice(0, i), name: ref.slice(i + 1) };
}
