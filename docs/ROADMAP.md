# Roadmap

Built from a review of user-reported issues in draw.io, Excalidraw, Mermaid (`architecture-beta`),
D2, Structurizr, mingrammer/diagrams, IaC visualizers (Rover, Inframap, Terravision, Pluralith,
Blast Radius, KubeDiagrams) and diagram MCP servers (October 2026). Each item names the problem
other tools have and how OpsDraw solves it.

Legend: ✅ done · 🔜 next · 📋 planned

## Already addressed by the design

| Problem elsewhere                                                     | OpsDraw                                                                                   |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Opaque, non-diffable files (draw.io compressed XML)                   | Plain Mermaid text; positions in sorted `%% @pos` lines with rounded coordinates          |
| Mermaid layouts are random between renders (mermaid#6024, #6166)      | The canvas uses stored positions, so it is deterministic                                  |
| No manual positioning in Mermaid (mermaid#5420)                       | Drag on the canvas; positions saved in the file                                           |
| Structurizr loses positions when elements are renamed                 | Positions live next to the ids in the same file; renames carry them over                  |
| Vendor icons can't be bundled legally (mermaid#6109, drawio#1058)     | Users import official packs locally ([TRADEMARKS.md](../TRADEMARKS.md))                   |
| Tools that must run `terraform` or need cloud credentials             | Reads source files only; never executes anything                                          |
| Native dependency install failures (pygraphviz, Electron postinstall) | Pure JavaScript (ELK.js), no native modules                                               |
| Hosted endpoints receiving confidential architecture                  | Local-first; MCP server is stdio-only, opens no ports, and refuses paths outside its root |
| LLMs write invalid syntax with no feedback                            | MCP `write_diagram` / `validate` return line-numbered errors and write nothing on failure |
| Edge labels missing in `architecture-beta` (mermaid#6322)             | Supported (`-[label]-`); verified to render with Mermaid 12                               |

## Correctness and compatibility

- ✅ **Mermaid-safe output.** Mermaid rejects some label characters (mermaid#6056, #7232) and
  reportedly ids starting with `T/B/L/R` (#7022). Validate every serialized file with the real
  Mermaid parser in tests, escape or replace unsafe characters, and keep the full Unicode label
  where Mermaid can't hold it.
- ✅ **Exports that match the canvas.** Mermaid's renderer ignores `@pos`, so exports drawn by
  Mermaid don't look like the canvas. Add SVG/PNG export from canvas geometry, with plain
  `<text>` (no `<foreignObject>`, drawio#774), embedded icons, `<title>`/`<desc>`, light/dark/auto
  themes, and the `.mmd` source embedded in SVG `<metadata>` and PNG `tEXt` so exports can be
  reopened. Keep the Mermaid render as "how GitHub will show it".
- 🔜 **GitHub-safe icons.** GitHub renders `architecture-beta` but only the built-in icons
  (community discussion 146647). Warn when a file uses pack icons and offer to (a) commit an
  exported SVG next to it or (b) write built-in fallbacks.
- 🔜 **Icon validation in MCP.** Reject unknown icon names with nearest-match suggestions
  (LLMs hallucinate icon names).
- 📋 **Port conflicts.** Mermaid allows one edge per node side (mermaid PR #5452). Spread ports in
  auto-layout, insert junctions for fan-out, and warn in `validate`.

## Infrastructure as code

- ✅ Terraform, CloudFormation, Kubernetes (OpenShift, KubeVirt, Gateway API, Helm/Flux/Argo),
  cluster configs (k0sctl, Talos, k3s/RKE2), Docker Compose, Ansible inventories, Nomad jobs.
- ✅ Virtualization via Terraform: Proxmox, VergeOS, vSphere, Xen Orchestra, Nutanix, oVirt,
  OpenStack, libvirt, LXD/Incus, Harvester, Rancher, Hyper-V, VirtualBox.
- ✅ MCP `import_iac` with format detection and skipped-file reporting.
- ✅ OpenTofu: `.tofu` files, with `foo.tofu` taking precedence over `foo.tf`.
- ✅ **Plan/state JSON input** (`terraform show -json`): exact `count`/`for_each` expansion,
  modules and data sources (Rover's most requested feature, rover#20).
- ✅ **Modules:** recurse into local modules, read `.terraform/modules/modules.json`, show remote
  modules as collapsed groups instead of failing (Terravision #49, Blast Radius #85).
- ✅ **Resilience:** `count`/`for_each` shown as one node marked `×N`; partial diagrams plus a
  warnings list instead of aborting; an import summary of unknown types (Terravision #100, #206).
- 📋 **Focus and filters:** collapse by module or group, `--focus <resource> --depth N`,
  include/exclude globs, configurable plumbing rules.
- 📋 **Terragrunt units** and Terraform Cloud plans (Terravision #114, Rover #21/#34).
- 📋 **Helm/Kustomize:** accept `helm template` / `kustomize build` output on stdin; Gateway API
  routes; namespace filter (KubeDiagrams #44/#54/#72).
- ✅ **Drift checks in CI:** `opsdraw import … --check` exits non-zero when the committed
  diagram is out of date, plus a GitHub Action (Pluralith #84, KubeDiagrams #21). Imports keep
  `%% @src` ids so re-imports update the diagram instead of replacing hand-made layout.

## Editor

- 📋 **Incremental layout:** pin nodes the user placed and lay out only new ones (D2/TALA's
  headline feature).
- 📋 **Edge routing:** ELK orthogonal routing, saved bend points, line jumps at crossings
  (drawio#5772, Excalidraw#157).
- 📋 **Large diagrams:** ELK in a Web Worker, render only visible nodes, debounced parsing, and a
  500-node benchmark in CI (drawio#3636, Excalidraw#628).
- 📋 **Alignment tools:** snap guides, align/distribute, fast keyboard nudging.
- 📋 **Styling:** `%% @style` comments for group colors (mermaid#6168), auto-generated legend.
- 📋 **RTL polish:** bidi isolation in exported SVG text; scope `dir` to the app root so it can be
  embedded (Excalidraw#11963).

## Platform

- 📋 **Desktop app (Tauri)** for Windows, macOS and Linux, with native file watching.
- ✅ **CLI** (`opsdraw export`, `import`, `check`) sharing code with the MCP server.
- 📋 **Git merge driver** that resolves `@pos` conflicts, and a visual diff for pull requests.
- 📋 **Real-time collaboration** later, through a CRDT on the text (Yjs + CodeMirror).
