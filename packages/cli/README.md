# opsdraw (CLI)

Command line for OpsDraw: turn infrastructure-as-code into a Mermaid `architecture-beta`
diagram, keep that diagram in sync in CI, and export it to SVG.

Diagrams are plain `.mmd` files that render on GitHub and GitLab as-is. Canvas positions live in
`%% @pos <id> x y [w h]` comment lines (edge routes in `%% @route <from> <to> x,y ...` lines, colors
in `%% @style <id> fill=<c> stroke=<c> color=<c>` lines) that Mermaid ignores, so you can arrange a diagram in the OpsDraw app, commit it, and re-import
later without losing the layout.

## Commands

```sh
opsdraw import <path...> -o <out.mmd> [--recursive] [--include-all] [--direction right|down] [--title T] [--check]
opsdraw export <in.mmd> -o <out.svg> [--theme light|dark|auto] [--legend]
opsdraw validate <file.mmd...> [--strict]
opsdraw diff <old.mmd> <new.mmd>
opsdraw merge-driver <base> <ours> <theirs> [<path>]
opsdraw git-setup [--apply] [--driver auto|npx|local]
opsdraw --help
opsdraw --version
```

### import

Reads Terraform (`.tf`), CloudFormation, Kubernetes manifests, Docker Compose, cluster configs
(k0sctl, Talos, RKE2, ...), Ansible inventories and Nomad jobs. Directories contribute files
ending in `.tf .yaml .yml .json .template .ini .nomad .hcl` plus extension-less `hosts` /
`inventory` files; `--recursive` walks sub-directories. Symlinks, dot-directories and
`node_modules` are skipped. Unrecognized files are listed as skipped.

When `<out.mmd>` already exists, the import is merged into it:

- nodes that still exist keep their position and group size (unless their parent group changed);
- edges that still exist keep their attachment sides;
- the existing title and `%%` comments are kept (pass `--title` to change the title);
- new nodes are laid out automatically and placed below the existing ones.

A true incremental layout (ELK with fixed nodes) is future work; for now new nodes get ELK's
positions from a full layout, moved as a block so they don't cover existing nodes.

Output is deterministic: the same sources and the same existing diagram always produce the same
bytes, and a re-import with no changes leaves the file untouched.

With `--check` nothing is written. The command compares the structure of the existing diagram
(nodes, kinds, labels, icons, parents, edges, title) with what the import would produce,
ignoring layout, edge sides, comments and order:

| Exit code | Meaning                                                   |
| --------- | --------------------------------------------------------- |
| 0         | Up to date                                                |
| 1         | Out of date (a diff is printed), or the diagram is broken |
| 2         | Usage error, or a source or the diagram does not exist    |

### export

Renders the diagram to a standalone SVG using its stored layout (nodes without a position are
laid out first). Mermaid built-in icons and `lucide:*` icons are drawn from the bundled Lucide
set. Other icon packs (`aws:`, `azure:`, `gcp:`, ...) are not bundled and are drawn as dashed
placeholders; the command prints a note listing them. The Mermaid source is embedded in the
SVG's `<metadata>`, so the OpsDraw app can reopen it.

`%% @style` colors (hex `#rgb`/`#rrggbb` or blue, green, orange, red, purple, gray, teal, yellow;
anything else is ignored) are drawn on groups and services, and crossing edges get a small line
jump. `--legend` adds a box listing the icons used and which groups each color marks.

PNG export is not supported in the CLI yet; use the OpsDraw app.

### validate

Parses each file and prints problems as `file:line: message`. Exits 1 if any file has errors,
2 if a file is missing.

Files that parse are also linted. Issues go to stderr as `file: <severity> [code] message`
(`file:line: ...` when the issue belongs to one node):

| Code            | Severity | Meaning                                                                        |
| --------------- | -------- | ------------------------------------------------------------------------------ |
| `port-conflict` | warning  | More than one edge uses the same side of a node; Mermaid allows one per side.  |
| `unknown-icon`  | warning  | A built-in or `lucide:` icon that doesn't exist, with up to three suggestions. |
| `github-icons`  | info     | Icons GitHub/GitLab can't draw (any `prefix:` icon); commit an exported SVG.   |
| `empty-group`   | info     | A group with nothing inside.                                                   |
| `isolated-node` | info     | A service with no edges, in a diagram that has at least three edges.           |

Lint issues don't change the exit code. With `--strict`, warnings exit 1 too; info issues never
fail. Vendor icon prefixes (`aws:`, `azure:`, ...) are not checked.

### diff

Prints the structural differences between two diagram files: added, removed and changed nodes
and edges (with the fields that changed) and title changes. Layout is summarized as a count of
moved and resized nodes. Exits 0 whether or not there are differences, 1 if a file does not
parse, 2 on usage errors or a missing file.

```text
$ opsdraw diff old.mmd new.mmd
old.mmd -> new.mmd
1 added, 0 removed, 1 changed nodes; 1 added, 0 removed, 0 changed edges
  + service y [Y]
  ~ x (label: "X" -> "X2")
  + edge y->z
Layout: 1 moved, 0 resized nodes
```

## Git merge driver

Two branches that each move a few nodes, or move one node and rename another, usually touch
neighbouring lines of an `.mmd` file, so git's line-based merge reports a conflict. The OpsDraw
merge driver merges the diagrams instead:

- nodes and edges added on either branch are kept;
- a deletion wins, unless the other branch changed that node or edge (then it is kept, as a
  conflict); a deleted group or node comes back if the other branch put a node in it or
  connected an edge to it;
- edits to different fields of the same node (label on one side, icon on the other) combine;
  the same field changed differently on both sides is a conflict, and your side (ours) is kept;
- layout never conflicts: each node keeps the position of the branch that moved it (ours if
  both did); position and group size merge separately; edge sides and routes count as layout;
- comments added on either side are kept, and the title merges like a field.

### Setup

Run once per clone, inside the repository:

```sh
opsdraw git-setup          # print the commands
opsdraw git-setup --apply  # run them (safe to repeat)
```

which amounts to:

```sh
git config merge.opsdraw.name "OpsDraw diagram merge"
git config merge.opsdraw.driver "npx --yes opsdraw merge-driver %O %A %B %P"
echo '*.mmd merge=opsdraw' >> .gitattributes
echo '*.mermaid merge=opsdraw' >> .gitattributes
```

When the CLI runs from a checkout of this repository rather than from npm (the CLI is not
published yet), `--driver auto` (the default) writes a driver that calls that build directly,
for example `node "/path/to/opsdraw/packages/cli/dist/index.js" merge-driver %O %A %B %P`.
Force either form with `--driver npx` or `--driver local`.

The driver config lives in `.git/config`, so every clone runs the setup once; commit
`.gitattributes` so the attribute is shared. Without the driver config git falls back to its
normal merge for these files.

### How conflicts look

The driver writes the merged diagram into the file either way. When something needs a decision
it keeps your side, adds one `%% CONFLICT:` comment per conflict after the header, and exits 1,
so `git merge` stops and lists the file as conflicted:

```text
architecture-beta
  %% CONFLICT: Node "x" label changed on both sides: ours "Ours X", theirs "Theirs X" (base "X"); kept ours
  group vpc(cloud)[VPC]
  service x(server)[Ours X] in vpc
  ...
```

The file still parses and renders (the notes are Mermaid comments). Edit what you want to
change, delete the `%% CONFLICT` lines, then `git add` the file and finish the merge. If one of
the versions does not parse, the driver falls back to `git merge-file`, which leaves the usual
`<<<<<<<` markers when the lines conflict.

The command contract is git's: `merge-driver <base> <ours> <theirs> [<path>]` (`%O %A %B %P`),
the result is written to `<ours>`, exit 0 means merged cleanly and 1 means conflicts remain.

## Keep diagrams in sync in CI

The repository root is a composite GitHub Action that fails when a committed diagram drifts from
the infrastructure code:

```yaml
# .github/workflows/diagrams.yml
name: Diagrams
on:
  pull_request:
    paths: ['infra/**', 'docs/arch.mmd']

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: eran132/opsdraw@main
        with:
          source: infra
          diagram: docs/arch.mmd
          recursive: true
```

Inputs: `source` (one or more space-separated paths), `diagram`, `recursive` (default `false`)
and `node-version` (default `22`). Until the CLI is published to npm, the action builds it from
its own checkout.

When the check fails, the log shows what changed, for example:

```text
docs/arch.mmd is out of date: 1 added, 0 removed, 0 changed nodes; 1 added, 0 removed, 0 changed edges
  + service tf_logs [logs]
  + edge tf_web->tf_logs
```

To fix it, re-import locally and commit the result. Your layout is kept; only the new nodes are
placed automatically:

```sh
opsdraw import infra --recursive -o docs/arch.mmd
git add docs/arch.mmd && git commit -m "docs: update architecture diagram"
```

Once the CLI is published to npm, the same check works without the action:

```yaml
- run: npx --yes opsdraw@latest import infra --recursive -o docs/arch.mmd --check
```

## Development

```sh
npm run build -w opsdraw
npm test -w opsdraw
node packages/cli/dist/index.js --help
```

## License

Apache-2.0
