# opsdraw-mcp

An [MCP](https://modelcontextprotocol.io) server that lets AI assistants create and edit
OpsDraw architecture diagrams and import Terraform into them.

Diagrams are plain Mermaid `architecture-beta` files (`.mmd` / `.mermaid`), so they render on
GitHub and GitLab as-is. Canvas positions are kept in `%% @pos <id> x y [w h]` comment lines that
Mermaid ignores. If the OpsDraw app has a file open, it live-reloads the changes the server
writes.

## Install

### Claude Code

```sh
claude mcp add opsdraw -- npx -y opsdraw-mcp
```

The server works inside the directory Claude Code was started in. To pin it to another folder:

```sh
claude mcp add opsdraw --env OPSDRAW_ROOT=/path/to/repo -- npx -y opsdraw-mcp
```

### Claude Desktop (or any MCP client using a JSON config)

```json
{
  "mcpServers": {
    "opsdraw": {
      "command": "npx",
      "args": ["-y", "opsdraw-mcp"],
      "env": { "OPSDRAW_ROOT": "/path/to/your/repo" }
    }
  }
}
```

Set `OPSDRAW_ROOT` for Claude Desktop, whose working directory is not your project.

## Security

Every path is resolved against `OPSDRAW_ROOT` (or the working directory when it is unset), and
paths that leave that root, including through `..`, other drives or symlinks, are rejected.
Diagram tools only read and write `.mmd` / `.mermaid` files; the Terraform importer only reads
`.tf` files and skips symlinks and hidden directories.

## Tools

| Tool               | What it does                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `create_diagram`   | Create an empty diagram (parent directories are created; `overwrite` to replace).                                               |
| `read_diagram`     | Return the Mermaid text plus a JSON summary of nodes and edges.                                                                 |
| `write_diagram`    | Replace a diagram with Mermaid text. Flowcharts are converted. Invalid text is not written; errors come back with line numbers. |
| `add_service`      | Add a service (`id` derived from `label` when omitted; optional `icon`, `parent`).                                              |
| `add_group`        | Add a group, optionally nested in another group.                                                                                |
| `add_junction`     | Add a junction for splitting or merging edges.                                                                                  |
| `connect`          | Add an edge (`arrow`: none, forward, back, both; sides picked from positions).                                                  |
| `disconnect`       | Remove the edges between two nodes.                                                                                             |
| `update_node`      | Change label, icon, parent (`null` to un-nest) or id (`newId`, references updated).                                             |
| `remove`           | Remove a node and its edges; removing a group removes its contents.                                                             |
| `auto_layout`      | Re-lay out the whole diagram with ELK (`RIGHT` or `DOWN`).                                                                      |
| `import_terraform` | Turn a `.tf` file or directory (optionally `recursive`) into a diagram; merges into an existing output (see below).             |
| `import_iac`       | Same for Terraform, CloudFormation, Kubernetes, Compose, cluster configs, Ansible inventories and Nomad jobs.                   |
| `list_icons`       | Search the curated catalog, Mermaid built-ins and all Lucide icons (`lucide:<name>`).                                           |
| `validate`         | Check a file or Mermaid text without writing anything: parse `errors` plus lint `issues` (see below).                           |

### Layout

Tools that add nodes (`add_*`, `write_diagram`, and `update_node` when it moves a node to another
group) take `layout` (default `true`). When at least one node has no stored position, the whole
diagram is auto-laid out, which replaces existing positions. When every node is already placed,
nothing moves. Pass `layout: false` to keep hand-placed positions; the new node is written without
a position until you call `auto_layout` or place it in the app.

### Icons

Use Mermaid built-ins (`cloud`, `database`, `disk`, `internet`, `server`) or `lucide:<name>`.
Vendor packs (`aws:`, `azure:`, `gcp:`, ...) are not bundled. Users import them in the OpsDraw
app, and diagrams can reference them by prefix once they have.

`add_service`, `add_group` and `update_node` reject icons they know are wrong: a bare name that is
not a Mermaid built-in, or a `lucide:` name that doesn't exist. The error suggests replacements
(`did you mean lucide:server, server?`). Any other prefix is accepted as-is, since vendor packs
live in the user's app.

### Re-importing

`import_iac` and `import_terraform` merge into an output file that already exists instead of
failing: positions, group sizes and edge sides of nodes that are still there are kept, and only
new nodes are laid out (the same merge as `opsdraw import` in the CLI). The result lists the
`added`, `removed` and `changed` node ids and `addedEdges` / `removedEdges`. Pass
`overwrite: true` to replace the file with a fresh layout instead. An existing output with parse
errors is never merged into; fix it or pass `overwrite: true`.

### Diffs and lint

Mutating tools (`add_*`, `connect`, `disconnect`, `update_node`, `remove`, and `write_diagram`
when the file existed) return a compact `diff` with the non-empty lists among `added`, `removed`,
`changed` (node ids) and `addedEdges`, `removedEdges`, `changedEdges` (`from->to`).

`validate` returns lint `issues` next to parse `errors`, each
`{ severity, code, message, nodeId?, line? }`:

| Code            | Severity | Meaning                                                                         |
| --------------- | -------- | ------------------------------------------------------------------------------- |
| `port-conflict` | warning  | More than one edge uses the same side of a node; Mermaid allows one per side.   |
| `unknown-icon`  | warning  | Built-in or `lucide:` icon that doesn't exist, with suggestions.                |
| `github-icons`  | info     | Nodes whose icons GitHub/GitLab can't draw (any `prefix:` icon); export an SVG. |
| `empty-group`   | info     | A group with nothing inside.                                                    |
| `isolated-node` | info     | A service with no edges, in a diagram that has at least three edges.            |

## Development

```sh
npm run build -w opsdraw-mcp   # bundles to dist/index.js
npm test -w opsdraw-mcp
```

## License

Apache-2.0
