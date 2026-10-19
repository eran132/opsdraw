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
  /** English search keywords; UI labels come from translations. */
  keywords: string;
}

export interface IconCategory {
  id: string;
  icons: IconEntry[];
}

const l = (name: string, keywords: string): IconEntry => ({ ref: `lucide:${name}`, keywords });
const b = (name: string, keywords: string): IconEntry => ({ ref: name, keywords });

/** Curated starter palette. Any other Lucide icon can still be found by search. */
export const GENERIC_CATALOG: IconCategory[] = [
  {
    id: 'compute',
    icons: [
      b('server', 'server vm instance host compute ec2'),
      l('cpu', 'cpu compute processor'),
      l('square-function', 'function serverless lambda faas'),
      l('container', 'container docker pod'),
      l('boxes', 'cluster kubernetes k8s nodes'),
      l('box', 'box generic component'),
    ],
  },
  {
    id: 'data',
    icons: [
      b('database', 'database sql rds postgres mysql db'),
      b('disk', 'disk volume block storage ebs'),
      l('archive', 'object storage bucket blob s3 archive'),
      l('folder-tree', 'file share nfs filesystem'),
      l('table', 'warehouse analytics table'),
      l('zap', 'cache redis memcached'),
    ],
  },
  {
    id: 'network',
    icons: [
      b('internet', 'internet public web globe'),
      b('cloud', 'cloud region provider'),
      l('network', 'network vpc vnet subnet'),
      l('split', 'load balancer lb alb nlb'),
      l('router', 'router gateway nat'),
      l('waypoints', 'dns cdn edge route'),
    ],
  },
  {
    id: 'messaging',
    icons: [
      l('list-ordered', 'queue sqs fifo'),
      l('radio-tower', 'pubsub topic sns event bus kafka'),
      l('webhook', 'webhook api callback'),
      l('mail', 'email smtp mail'),
      l('bell', 'notification alert'),
      l('workflow', 'workflow orchestration step functions pipeline'),
    ],
  },
  {
    id: 'security',
    icons: [
      l('shield', 'firewall waf security'),
      l('key-round', 'secret key vault kms'),
      l('lock', 'tls encryption private'),
      l('fingerprint', 'identity iam auth sso'),
    ],
  },
  {
    id: 'clients',
    icons: [
      l('user', 'user person actor'),
      l('users', 'users team customers'),
      l('monitor', 'browser desktop client'),
      l('smartphone', 'mobile phone app'),
    ],
  },
  {
    id: 'ops',
    icons: [
      l('activity', 'monitoring metrics observability'),
      l('scroll-text', 'logs logging audit'),
      l('git-branch', 'git ci cd repository'),
      l('settings', 'config settings'),
    ],
  },
];

/** Splits `prefix:name`; built-ins have no prefix. */
export function parseIconRef(ref: string): { prefix: string | null; name: string } {
  const i = ref.indexOf(':');
  return i === -1
    ? { prefix: null, name: ref }
    : { prefix: ref.slice(0, i), name: ref.slice(i + 1) };
}
