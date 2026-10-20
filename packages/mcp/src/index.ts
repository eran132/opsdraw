import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import pkg from '../package.json' with { type: 'json' };
import * as tools from './tools';

const FORMAT = `File format: an opsdraw diagram is a Mermaid "architecture-beta" file (.mmd or .mermaid) that renders on GitHub/GitLab as-is. Statements:
  group <id>(<icon>)[<Label>] [in <parentGroup>]
  service <id>(<icon>)[<Label>] [in <group>]
  junction <id> [in <group>]
  <from>:<R|L|T|B> [<]--[>] <R|L|T|B>:<to>        (edge; optional label: -[label]-)
Canvas positions are stored as "%% @pos <id> x y [w h]" comment lines (relative to the parent group), which Mermaid ignores.
Colors: "%% @style <id> fill=<c> stroke=<c> color=<c>" with c a #hex or blue|green|orange|red|purple|gray|teal|yellow.
auto_layout also writes "%% @route <from> <to> x,y x,y ..." lines (absolute edge bend points); if you change a node's @pos by hand, delete the @route lines of its edges.
Ids must start with a letter or "_" and contain only letters, digits, "_" or "-".
Icons are Mermaid built-ins (cloud, database, disk, internet, server) or "prefix:name" such as lucide:database; use list_icons to find one.`;

const LAYOUT_NOTE =
  'Layout: with layout=true (default), the whole diagram is auto-laid out with ELK only if some node has no stored position, which replaces existing positions. Pass layout=false to keep hand-placed positions (the new node is written unplaced; call auto_layout later).';

const ICON_NOTE =
  'Unknown icons are rejected with suggestions: bare names must be Mermaid built-ins, lucide:<name> must exist; other prefixes (aws:, azure:...) are accepted as user-imported packs.';

const MERGE_NOTE =
  'If output exists, it is merged: positions and edge sides of surviving nodes are kept, only new nodes are laid out, and added/removed/changed ids are returned. overwrite: true replaces it with a fresh layout.';

const PATHS_NOTE = `Paths are relative to the server root (OPSDRAW_ROOT or the working directory) and cannot leave it.`;

const ctx = tools.contextFromEnv();

const pathArg = z
  .string()
  .describe('Diagram file path (.mmd or .mermaid), relative to the server root');
const idArg = z.string().describe('Node id');
const layoutArg = z
  .boolean()
  .optional()
  .describe('Auto-lay out when some node has no position (default true)');
const directionArg = z
  .enum(['RIGHT', 'DOWN'])
  .optional()
  .describe('Layout direction (default RIGHT)');
const sideArg = z.enum(['T', 'B', 'L', 'R']).optional();

function ok(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function fail(err: unknown): CallToolResult {
  const text = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: 'text', text }] };
}

const run =
  <A>(fn: (args: A) => Promise<unknown> | unknown) =>
  async (args: A): Promise<CallToolResult> => {
    try {
      return ok(await fn(args));
    } catch (err) {
      return fail(err);
    }
  };

// The format text lives in the server instructions and describe_format rather than in every tool
// description: very long descriptions stop some MCP clients from listing the tools at all.
const server = new McpServer({ name: 'opsdraw', version: pkg.version }, { instructions: FORMAT });

server.registerTool(
  'describe_format',
  {
    title: 'Describe the diagram format',
    description:
      'Explain the opsdraw diagram file format (Mermaid architecture-beta plus %% @pos layout lines). Call this before writing diagram text by hand.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => ({ content: [{ type: 'text', text: FORMAT }] }),
);

server.registerTool(
  'create_diagram',
  {
    title: 'Create diagram',
    description: `Create a new, empty architecture diagram file (parent directories are created). Fails if the file exists unless overwrite is true. ${PATHS_NOTE} File format: call describe_format.`,
    inputSchema: {
      path: pathArg,
      title: z.string().optional().describe('Diagram title (written as YAML front matter)'),
      overwrite: z.boolean().optional().describe('Replace an existing file (default false)'),
    },
  },
  run((a) => tools.createDiagram(ctx, a)),
);

server.registerTool(
  'read_diagram',
  {
    title: 'Read diagram',
    description: `Read an architecture diagram. Returns the Mermaid text and a compact JSON summary of nodes (id, kind, label, icon, parent) and edges (from, to, sides, arrow, label), plus ids that have no canvas position. ${PATHS_NOTE}`,
    inputSchema: { path: pathArg },
    annotations: { readOnlyHint: true },
  },
  run((a) => tools.readDiagram(ctx, a)),
);

server.registerTool(
  'write_diagram',
  {
    title: 'Write diagram',
    description: `Replace a diagram file with the given Mermaid text. Accepts "architecture-beta" or a flowchart ("flowchart"/"graph"), which is converted to architecture-beta (subgraphs become groups). If the text has errors, nothing is written and the errors (with line numbers) are returned. ${LAYOUT_NOTE} ${PATHS_NOTE} File format: call describe_format.`,
    inputSchema: {
      path: pathArg,
      mermaid: z.string().describe('Full Mermaid source'),
      layout: layoutArg,
      direction: directionArg,
    },
  },
  run((a) => tools.writeDiagram(ctx, a)),
);

const nodeInputs = {
  path: pathArg,
  id: z.string().optional().describe('Id; derived from the label when omitted'),
  label: z.string().describe('Display label'),
  icon: z
    .string()
    .optional()
    .describe('Icon ref, e.g. "server", "database" or "lucide:container" (see list_icons)'),
  parent: z.string().optional().describe('Id of the group to place it in'),
  layout: layoutArg,
};

server.registerTool(
  'add_service',
  {
    title: 'Add service',
    description: `Add a service (a box with an icon and label) to a diagram, optionally inside a group. Returns the new id. ${ICON_NOTE} ${LAYOUT_NOTE}`,
    inputSchema: nodeInputs,
  },
  run((a) => tools.addService(ctx, a)),
);

server.registerTool(
  'add_group',
  {
    title: 'Add group',
    description: `Add a group (a container such as a VPC, subnet, cluster or bounded context), optionally nested in another group. Returns the new id. ${ICON_NOTE} ${LAYOUT_NOTE}`,
    inputSchema: nodeInputs,
  },
  run((a) => tools.addGroup(ctx, a)),
);

server.registerTool(
  'add_junction',
  {
    title: 'Add junction',
    description: `Add a junction: an unlabeled point used to split or merge edges. ${LAYOUT_NOTE}`,
    inputSchema: {
      path: pathArg,
      id: z.string().optional().describe('Id; generated when omitted'),
      parent: z.string().optional().describe('Id of the group to place it in'),
      layout: layoutArg,
    },
  },
  run((a) => tools.addJunction(ctx, a)),
);

server.registerTool(
  'connect',
  {
    title: 'Connect nodes',
    description:
      'Add an edge between two services or junctions. Sides (T/B/L/R) default to the ones facing each other based on canvas positions, or R -> L when unplaced. Groups cannot be endpoints; to draw an edge from/to a group boundary, use a service inside the group with fromGroup/toGroup: true.',
    inputSchema: {
      path: pathArg,
      from: z.string().describe('Source node id'),
      to: z.string().describe('Target node id'),
      label: z.string().optional().describe('Edge label'),
      arrow: z
        .enum(['none', 'forward', 'back', 'both'])
        .optional()
        .describe('Arrowheads (default forward: from -> to)'),
      fromSide: sideArg.describe('Side of the source node'),
      toSide: sideArg.describe('Side of the target node'),
      fromGroup: z.boolean().optional().describe("Attach to the source's group boundary"),
      toGroup: z.boolean().optional().describe("Attach to the target's group boundary"),
    },
  },
  run((a) => tools.connect(ctx, a)),
);

server.registerTool(
  'disconnect',
  {
    title: 'Disconnect nodes',
    description: 'Remove every edge between two nodes (in either direction).',
    inputSchema: { path: pathArg, from: idArg, to: idArg },
  },
  run((a) => tools.disconnect(ctx, a)),
);

server.registerTool(
  'update_node',
  {
    title: 'Update node',
    description: `Change a node's label, icon, parent group or id. Renaming (newId) updates every edge and child reference. parent: null moves it to the top level; moving a node drops its position, and with layout=true (default) the diagram is re-laid out. icon: null removes the icon. ${ICON_NOTE}`,
    inputSchema: {
      path: pathArg,
      id: idArg,
      label: z.string().optional(),
      icon: z.string().nullable().optional(),
      parent: z.string().nullable().optional().describe('New group id, or null to un-nest'),
      newId: z.string().optional().describe('Rename the node'),
      layout: layoutArg,
    },
  },
  run((a) => tools.updateNode(ctx, a)),
);

server.registerTool(
  'remove',
  {
    title: 'Remove node',
    description: 'Remove a node and its edges. Removing a group also removes everything inside it.',
    inputSchema: { path: pathArg, id: idArg },
    annotations: { destructiveHint: true },
  },
  run((a) => tools.removeNode(ctx, a)),
);

server.registerTool(
  'auto_layout',
  {
    title: 'Auto layout',
    description:
      'Re-lay out the whole diagram with ELK (layered, groups nested) and re-pick edge sides from the result. Replaces all stored positions.',
    inputSchema: { path: pathArg, direction: directionArg },
  },
  run((a) => tools.autoLayoutFile(ctx, a)),
);

server.registerTool(
  'import_terraform',
  {
    title: 'Import Terraform',
    description: `Build an architecture diagram from Terraform: reads a .tf file, or the .tf files in a directory (non-recursive unless recursive: true; hidden dirs and symlinks are skipped). Resources and modules become services, networks (VPC/VNet/subnet/resource group) become nested groups, references become edges, and plumbing resources (IAM policies, attachments, rules...) are hidden unless includeAll is true. HCL is not evaluated. ${MERGE_NOTE} ${PATHS_NOTE}`,
    inputSchema: {
      source: z.string().describe('A .tf file or a directory containing .tf files'),
      output: z.string().describe('Diagram file to write (.mmd or .mermaid)'),
      recursive: z.boolean().optional().describe('Also read subdirectories (default false)'),
      includeAll: z.boolean().optional().describe('Keep plumbing resources (default false)'),
      direction: directionArg,
      title: z.string().optional(),
      overwrite: z
        .boolean()
        .optional()
        .describe('Replace instead of merging into an existing output (default false)'),
    },
  },
  run((a) => tools.importTerraform(ctx, a)),
);

server.registerTool(
  'import_iac',
  {
    title: 'Import infrastructure as code',
    description: `Build a diagram from infrastructure code, detecting each file's format: Terraform (.tf; clouds and virtualization providers such as Proxmox, vSphere, OpenStack, libvirt; hosts, clusters and networks become nested groups), CloudFormation, Kubernetes manifests (incl. OpenShift, KubeVirt, Gateway API, Helm/Flux/Argo apps; render charts to a file first), cluster configs (k0sctl, Talos, k3s/RKE2), Docker Compose, Ansible inventories (incl. extension-less hosts files) and Nomad jobs. Reads a file or directory; unrecognized files are reported as skipped; mixed formats get id prefixes. ${MERGE_NOTE} ${PATHS_NOTE}`,
    inputSchema: {
      source: z.string().describe('A file or a directory of infrastructure code'),
      output: z.string().describe('Diagram file to write (.mmd or .mermaid)'),
      recursive: z.boolean().optional().describe('Also read subdirectories (default false)'),
      includeAll: z
        .boolean()
        .optional()
        .describe('Keep plumbing resources: IAM, attachments, ConfigMaps... (default false)'),
      direction: directionArg,
      title: z.string().optional(),
      overwrite: z
        .boolean()
        .optional()
        .describe('Replace instead of merging into an existing output (default false)'),
    },
  },
  run((a) => tools.importIacFiles(ctx, a)),
);

server.registerTool(
  'list_icons',
  {
    title: 'List icons',
    description:
      'Search icons usable in diagrams. Searches the curated opsdraw catalog (by keywords like "queue", "cache", "k8s"), the Mermaid built-ins (cloud, database, disk, internet, server) and all Lucide icons (as lucide:<name>). Without a query it lists the curated catalog. Vendor packs (aws:, azure:, gcp:, ...) are not bundled: users import them in the opsdraw app, and you may reference them by prefix if the user says they have them.',
    inputSchema: {
      query: z.string().optional().describe('Search words, e.g. "message queue"'),
      limit: z.number().int().min(1).max(500).optional().describe('Max results (default 30)'),
    },
    annotations: { readOnlyHint: true },
  },
  run((a) => tools.listIcons(a)),
);

server.registerTool(
  'validate',
  {
    title: 'Validate',
    description: `Check Mermaid text, or a diagram file, without changing anything. Pass exactly one of path or mermaid. Returns the detected kind (architecture or flowchart), parse errors with line numbers, and lint issues ({severity, code, message, nodeId?, line?}): edges sharing a node side (port-conflict), unknown icons with suggestions, icons GitHub can't draw, empty groups, unconnected services. The file format is described in write_diagram.`,
    inputSchema: {
      path: z.string().optional().describe('Diagram file to check'),
      mermaid: z.string().optional().describe('Mermaid text to check'),
    },
    annotations: { readOnlyHint: true },
  },
  run((a) => tools.validate(ctx, a)),
);

await server.connect(new StdioServerTransport());
