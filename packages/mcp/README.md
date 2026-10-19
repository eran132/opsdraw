# archidraw-mcp

An [MCP](https://modelcontextprotocol.io) server that lets AI assistants create and edit
archidraw architecture diagrams and import Terraform into them.

Diagrams are plain Mermaid `architecture-beta` files (`.mmd` / `.mermaid`), so they render on
GitHub and GitLab as-is. Canvas positions are kept in `%% @pos <id> x y [w h]` comment lines that
Mermaid ignores. If the archidraw app has a file open, it live-reloads the changes the server
writes.

## Install

### Claude Code

```sh
claude mcp add archidraw -- npx -y archidraw-mcp
```

The server works inside the directory Claude Code was started in. To pin it to another folder:

```sh
claude mcp add archidraw --env ARCHIDRAW_ROOT=/path/to/repo -- npx -y archidraw-mcp
```

### Claude Desktop (or any MCP client using a JSON config)

```json
{
  "mcpServers": {
    "archidraw": {
      "command": "npx",
      "args": ["-y", "archidraw-mcp"],
      "env": { "ARCHIDRAW_ROOT": "/path/to/your/repo" }
    }
  }
}
```

Set `ARCHIDRAW_ROOT` for Claude Desktop, whose working directory is not your project.

## Security

Every path is resolved against `ARCHIDRAW_ROOT` (or the working directory when it is unset), and
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
| `import_terraform` | Turn a `.tf` file or directory (optionally `recursive`) into a laid-out diagram.                                                |
| `list_icons`       | Search the curated catalog, Mermaid built-ins and all Lucide icons (`lucide:<name>`).                                           |
| `validate`         | Check a file or Mermaid text without writing anything.                                                                          |

### Layout

Tools that add nodes (`add_*`, `write_diagram`, and `update_node` when it moves a node to another
group) take `layout` (default `true`). When at least one node has no stored position, the whole
diagram is auto-laid out, which replaces existing positions. When every node is already placed,
nothing moves. Pass `layout: false` to keep hand-placed positions; the new node is written without
a position until you call `auto_layout` or place it in the app.

### Icons

Use Mermaid built-ins (`cloud`, `database`, `disk`, `internet`, `server`) or `lucide:<name>`.
Vendor packs (`aws:`, `azure:`, `gcp:`, ...) are not bundled. Users import them in the archidraw
app, and diagrams can reference them by prefix once they have.

## Development

```sh
npm run build -w archidraw-mcp   # bundles to dist/index.js
npm test -w archidraw-mcp
```

## License

Apache-2.0
