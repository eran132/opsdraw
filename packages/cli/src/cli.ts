import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  annotateConflicts,
  autoLayout,
  diffStructure,
  edgeKey,
  importIac,
  layoutNewNodes,
  lintDiagram,
  merge3,
  mergeLayout,
  nodeChanges,
  parseArchitecture,
  renderDiagramSvg,
  serializeArchitecture,
} from '@opsdraw/core';
import type { Diagram, LayoutDirection, ParseError, StructuralDiff, Theme } from '@opsdraw/core';
import { UsageError, parseArgs } from './args';
import type { OptionsSpec } from './args';
import { collectIacFiles, displayPath } from './collect';
import { createIconChecker, createIconResolver } from './icons';

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
  /** Path of the running CLI script (process.argv[1]); used by git-setup for a local driver. */
  entry?: string;
}

/** Exit codes: 0 success / up to date, 1 failure / drift / invalid diagram, 2 usage error. */
export const EXIT = { ok: 0, fail: 1, usage: 2 } as const;

const DIAGRAM_EXT = ['.mmd', '.mermaid'];

const HELP = `opsdraw - architecture diagrams as code (Mermaid architecture-beta)

Usage:
  opsdraw import <path...> -o <out.mmd> [options]
  opsdraw export <in.mmd> -o <out.svg> [--theme light|dark|auto] [--legend]
  opsdraw validate <file.mmd...> [--strict]
  opsdraw diff <old.mmd> <new.mmd>
  opsdraw merge-driver <base> <ours> <theirs> [<path>]
  opsdraw git-setup [--apply] [--driver auto|npx|local]
  opsdraw <command> --help
  opsdraw --version

Commands:
  import    Build a diagram from Terraform, CloudFormation, Kubernetes, Compose, cluster
            configs, Ansible inventories and Nomad jobs. If <out.mmd> exists, its hand-made
            layout is kept and only new nodes are laid out. --check verifies instead of writing.
  export    Render a diagram to SVG using its stored layout. PNG is not supported in the CLI
            yet (use the OpsDraw app for PNG).
  validate  Parse diagrams and report problems as file:line: message, plus lint warnings
            (edges sharing a node side, unknown icons, ...). --strict fails on warnings.
  diff      Print the structural differences between two diagrams, plus moved nodes.
  merge-driver
            Git merge driver: three-way merges diagrams semantically (layout never
            conflicts). Install it with "opsdraw git-setup --apply".
  git-setup Print (or with --apply, run) the git config that installs the merge driver.

Exit codes: 0 ok, 1 errors or drift (--check), 2 usage error or missing file.
`;

const IMPORT_HELP = `Usage: opsdraw import <path...> -o <out.mmd> [options]

Reads infrastructure-as-code files (.tf .yaml .yml .json .template .ini .nomad .hcl, and
extension-less hosts/inventory files) and writes a Mermaid architecture-beta diagram.
Symlinks, dot-directories and node_modules are skipped when walking directories.

If <out.mmd> already exists, positions, group sizes and edge sides of nodes that are still
there are kept; new nodes are laid out automatically.

Options:
  -o, --output <file>       Diagram to write (.mmd or .mermaid). Required.
  -r, --recursive           Walk sub-directories.
      --include-all         Keep plumbing resources (policies, config, secrets, volumes...).
      --direction <dir>     Layout direction for new nodes: right (default) or down.
      --title <text>        Diagram title (default: keep the existing title).
      --check               Don't write. Exit 1 if <out.mmd> is structurally different from
                            what the import would produce (layout is ignored), 0 if it is up
                            to date, 2 if it does not exist.
  -h, --help                Show this help.
`;

const EXPORT_HELP = `Usage: opsdraw export <in.mmd> -o <out.svg> [--theme light|dark|auto] [--legend]

Renders the diagram with its stored layout (nodes without a position are laid out first).
Mermaid built-in and lucide: icons are drawn; other icon packs (aws:, azure:, ...) are not
bundled with the CLI and are drawn as placeholders. PNG is not supported in the CLI yet.

Options:
  -o, --output <file>   SVG file to write. Required.
      --theme <theme>   light (default), dark, or auto (follows prefers-color-scheme).
      --legend          Add a legend of the icons and %% @style colors used.
  -h, --help            Show this help.
`;

const VALIDATE_HELP = `Usage: opsdraw validate <file.mmd...> [--strict]

Parses each diagram and prints problems as file:line: message. Diagrams that parse are also
linted, printed as file[:line]: <warning|info> [code] message:

  port-conflict   warning  more than one edge on the same side of a node (Mermaid allows one)
  unknown-icon    warning  built-in or lucide: icon that doesn't exist, with suggestions
  github-icons    info     icons GitHub/GitLab can't draw; export an SVG or use built-ins
  empty-group     info     group with nothing inside
  isolated-node   info     service without edges (only in diagrams with 3+ edges)

Exits 1 if any file has errors, 2 if a file is missing. Lint issues don't change the exit
code unless --strict is given.

Options:
      --strict   Exit 1 on lint warnings too (info issues never fail).
  -h, --help     Show this help.
`;

const HELP_OPT: OptionsSpec = { help: { type: 'boolean', short: 'h' } };

const isDiagramPath = (p: string) => DIAGRAM_EXT.includes(path.extname(p).toLowerCase());

async function readIfExists(abs: string): Promise<string | null> {
  try {
    return await fs.readFile(abs, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

async function writeFile(abs: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text, 'utf8');
}

const formatErrors = (file: string, errors: ParseError[]) =>
  [...errors]
    .sort((a, b) => a.line - b.line)
    .map((e) => `${file}:${e.line}: ${e.message}\n`)
    .join('');

/** Human-readable list of structural changes from `prev` to `next`. */
export function formatDiff(diff: StructuralDiff, prev: Diagram, next: Diagram): string {
  const lines: string[] = [];
  const prevById = new Map(prev.nodes.map((n) => [n.id, n]));
  const nextById = new Map(next.nodes.map((n) => [n.id, n]));
  const show = (v: string | undefined) => (v === undefined ? '(none)' : JSON.stringify(v));
  if (diff.titleChanged) lines.push(`  ~ title: ${show(prev.title)} -> ${show(next.title)}`);
  for (const id of diff.added) {
    const n = nextById.get(id)!;
    lines.push(`  + ${n.kind} ${id}${n.label && n.label !== id ? ` [${n.label}]` : ''}`);
  }
  for (const id of diff.removed) lines.push(`  - ${prevById.get(id)!.kind} ${id}`);
  for (const id of diff.changed) {
    const a = prevById.get(id)!;
    const b = nextById.get(id)!;
    const parts = nodeChanges(a, b).map((f) => `${f}: ${show(a[f])} -> ${show(b[f])}`);
    lines.push(`  ~ ${id} (${parts.join(', ')})`);
  }
  for (const k of diff.addedEdges) lines.push(`  + edge ${k}`);
  for (const k of diff.removedEdges) lines.push(`  - edge ${k}`);
  for (const k of diff.changedEdges) lines.push(`  ~ edge ${k} (arrows, label or {group})`);
  return lines.map((l) => `${l}\n`).join('');
}

const countLine = (d: StructuralDiff) =>
  `${d.added.length} added, ${d.removed.length} removed, ${d.changed.length} changed nodes; ` +
  `${d.addedEdges.length} added, ${d.removedEdges.length} removed, ${d.changedEdges.length} changed edges`;

const hasChanges = (d: StructuralDiff) =>
  d.titleChanged ||
  [d.added, d.removed, d.changed, d.addedEdges, d.removedEdges, d.changedEdges].some(
    (l) => l.length > 0,
  );

async function cmdImport(argv: string[], io: Io): Promise<number> {
  const { positionals, options } = parseArgs(argv, {
    ...HELP_OPT,
    output: { type: 'string', short: 'o' },
    recursive: { type: 'boolean', short: 'r' },
    'include-all': { type: 'boolean' },
    direction: { type: 'string', choices: ['right', 'down'] },
    title: { type: 'string' },
    check: { type: 'boolean' },
  });
  if (options.help) {
    io.stdout(IMPORT_HELP);
    return EXIT.ok;
  }
  if (!positionals.length) throw new UsageError('import needs at least one source path');
  const output = options.output as string | undefined;
  if (!output) throw new UsageError('import needs -o <out.mmd>');
  if (!isDiagramPath(output)) throw new UsageError('The output must end in .mmd or .mermaid');
  const check = !!options.check;
  const direction: LayoutDirection = options.direction === 'down' ? 'DOWN' : 'RIGHT';
  const outAbs = path.resolve(io.cwd, output);
  const outName = displayPath(io.cwd, outAbs);

  const files = await collectIacFiles(positionals, {
    recursive: !!options.recursive,
    cwd: io.cwd,
  });
  if (!files.length)
    throw new UsageError(
      `No infrastructure files found in ${positionals.join(', ')}${options.recursive ? '' : ' (try --recursive)'}`,
    );
  const {
    diagram: imported,
    kinds,
    skipped,
    overridden,
    warnings,
  } = importIac(files, {
    includeAll: !!options['include-all'],
  });
  if (!kinds.length) {
    io.stderr(
      `opsdraw: none of the ${files.length} file(s) looked like Terraform, CloudFormation, Kubernetes, Compose, a cluster config, an Ansible inventory or a Nomad job\n`,
    );
    return EXIT.fail;
  }
  const title = (options.title as string | undefined)?.trim().replace(/[\r\n]+/g, ' ');
  if (title) imported.title = title;

  const used = files.length - skipped.length;
  io.stdout(
    `Imported ${kinds.join(', ')} from ${used} file(s): ${imported.nodes.length} nodes, ${imported.edges.length} edges\n`,
  );
  if (skipped.length)
    io.stdout(`Skipped ${skipped.length} unrecognized file(s): ${skipped.join(', ')}\n`);
  if (overridden.length)
    io.stdout(
      `Ignored ${overridden.join(', ')} (a .tofu file with the same name takes precedence)\n`,
    );
  for (const w of warnings) io.stderr(`warning: ${w}\n`);

  const existingText = await readIfExists(outAbs);
  let previous: Diagram | null = null;
  if (existingText !== null) {
    const parsed = parseArchitecture(existingText);
    if (parsed.errors.length) {
      io.stderr(formatErrors(outName, parsed.errors));
      io.stderr(`opsdraw: ${outName} has errors; fix or delete it before re-importing\n`);
      return EXIT.fail;
    }
    previous = parsed.diagram;
  }

  if (check) {
    if (!previous) {
      io.stderr(`opsdraw: ${outName} does not exist; run without --check to create it\n`);
      return EXIT.usage;
    }
    const merged = mergeLayout(previous, imported);
    if (!hasChanges(merged)) {
      io.stdout(`${outName} is up to date\n`);
      return EXIT.ok;
    }
    io.stdout(`${outName} is out of date: ${countLine(merged)}\n`);
    io.stdout(formatDiff(merged, previous, merged.diagram));
    io.stdout(
      `To fix: run \`opsdraw import ${positionals.join(' ')}${options.recursive ? ' --recursive' : ''} -o ${outName}\` and commit the result.\n`,
    );
    return EXIT.fail;
  }

  let result: Diagram;
  if (previous) {
    const merged = mergeLayout(previous, imported);
    result = await layoutNewNodes(merged.diagram, new Set(merged.kept), {
      direction,
      pinnedEdges: new Set(merged.keptEdges),
    });
    io.stdout(`Changes: ${countLine(merged)}\n`);
    io.stdout(formatDiff(merged, previous, merged.diagram));
  } else {
    result = await autoLayout(imported, direction);
  }

  const text = serializeArchitecture(result);
  if (text === existingText) {
    io.stdout(`${outName} is already up to date\n`);
    return EXIT.ok;
  }
  await writeFile(outAbs, text);
  io.stdout(`Wrote ${outName}\n`);
  return EXIT.ok;
}

async function cmdExport(argv: string[], io: Io): Promise<number> {
  const { positionals, options } = parseArgs(argv, {
    ...HELP_OPT,
    output: { type: 'string', short: 'o' },
    theme: { type: 'string', choices: ['light', 'dark', 'auto'] },
    legend: { type: 'boolean' },
  });
  if (options.help) {
    io.stdout(EXPORT_HELP);
    return EXIT.ok;
  }
  if (positionals.length !== 1) throw new UsageError('export needs exactly one input diagram');
  const output = options.output as string | undefined;
  if (!output) throw new UsageError('export needs -o <out.svg>');
  const ext = path.extname(output).toLowerCase();
  if (ext === '.png')
    throw new UsageError('PNG export is not supported in the CLI yet; export SVG instead');
  if (ext !== '.svg') throw new UsageError('The output must end in .svg');

  const inAbs = path.resolve(io.cwd, positionals[0]!);
  const inName = displayPath(io.cwd, inAbs);
  const text = await readIfExists(inAbs);
  if (text === null) throw new UsageError(`Diagram "${positionals[0]}" not found`);
  const { diagram, errors } = parseArchitecture(text);
  if (errors.length) {
    io.stderr(formatErrors(inName, errors));
    return EXIT.fail;
  }
  const positioned = new Set(diagram.nodes.filter((n) => diagram.layout[n.id]).map((n) => n.id));
  const laidOut =
    positioned.size === diagram.nodes.length
      ? diagram
      : await layoutNewNodes(diagram, positioned, {
          pinnedEdges: new Set(diagram.edges.map(edgeKey)),
        });

  const icons = createIconResolver();
  const svg = renderDiagramSvg(laidOut, {
    resolveIcon: icons.resolve,
    theme: (options.theme as Theme | undefined) ?? 'light',
    legend: options.legend === true,
  });
  const outAbs = path.resolve(io.cwd, output);
  await writeFile(outAbs, svg);
  io.stdout(`Wrote ${displayPath(io.cwd, outAbs)} (${diagram.nodes.length} nodes)\n`);
  if (icons.unresolved.size) {
    io.stderr(
      `Note: these icons are not bundled with the CLI and were drawn as placeholders: ${[...icons.unresolved].sort().join(', ')}\n`,
    );
  }
  return EXIT.ok;
}

async function cmdValidate(argv: string[], io: Io): Promise<number> {
  const { positionals, options } = parseArgs(argv, {
    ...HELP_OPT,
    strict: { type: 'boolean' },
  });
  if (options.help) {
    io.stdout(VALIDATE_HELP);
    return EXIT.ok;
  }
  if (!positionals.length) throw new UsageError('validate needs at least one diagram');
  const checker = createIconChecker();
  const lintOptions = checker
    ? { knownIcons: checker.knownIcons, iconCandidates: checker.candidates }
    : {};
  let failed = false;
  let missing = false;
  let warned = false;
  for (const file of positionals) {
    const abs = path.resolve(io.cwd, file);
    const name = displayPath(io.cwd, abs);
    const text = await readIfExists(abs);
    if (text === null) {
      io.stderr(`${name}: file not found\n`);
      missing = true;
      continue;
    }
    const { diagram, errors } = parseArchitecture(text);
    if (errors.length) {
      io.stderr(formatErrors(name, errors));
      failed = true;
      continue;
    }
    io.stdout(`${name}: ok (${diagram.nodes.length} nodes, ${diagram.edges.length} edges)\n`);
    // Lint only diagrams that parse; issues never fail the run unless --strict sees a warning.
    for (const issue of lintDiagram(diagram, { ...lintOptions, source: text })) {
      if (issue.severity === 'warning') warned = true;
      const where = issue.line === undefined ? name : `${name}:${issue.line}`;
      io.stderr(`${where}: ${issue.severity} [${issue.code}] ${issue.message}\n`);
    }
  }
  if (failed || (options.strict && warned)) return EXIT.fail;
  return missing ? EXIT.usage : EXIT.ok;
}

const DIFF_HELP = `Usage: opsdraw diff <old.mmd> <new.mmd>

Prints what changed structurally from <old> to <new>: added, removed and changed nodes and
edges, and the title. Layout changes are summarized as counts of moved and resized nodes.

Exits 0 whether or not there are differences, 1 if a diagram does not parse, 2 on usage
errors or a missing file.
`;

const MERGE_DRIVER_HELP = `Usage: opsdraw merge-driver <base> <ours> <theirs> [<path>]

Git merge driver (git passes %O %A %B %P). Merges the three versions of a diagram
semantically and writes the result into <ours>:

  - nodes and edges added on either side are kept; a deletion wins unless the other side
    changed that node or edge;
  - the same field (label, icon, group, arrows...) changed differently on both sides is a
    conflict, and ours is kept;
  - layout never conflicts: each node keeps the position of the side that moved it (ours if
    both did).

Exits 0 on a clean merge. On conflicts, the merged file gets one "%% CONFLICT: ..." comment
line per conflict after the header (it still parses and renders) and the exit code is 1, so
git reports the file as conflicted. If a version does not parse, a line-based merge with the
usual conflict markers is done instead (git merge-file).
`;

const GIT_SETUP_HELP = `Usage: opsdraw git-setup [--apply] [--driver auto|npx|local]

Prints the commands that install the OpsDraw merge driver in the current repository:
a merge.opsdraw driver in .git/config and "*.mmd merge=opsdraw" / "*.mermaid merge=opsdraw"
lines in .gitattributes. With --apply, runs them (idempotently).

Options:
      --apply           Run the commands instead of printing them.
      --driver <kind>   npx: "npx --yes opsdraw merge-driver ..." (needs the npm package).
                        local: "node <this CLI's path> merge-driver ...".
                        auto (default): local when this CLI runs from a checkout, npx when it
                        was installed from npm.
  -h, --help            Show this help.
`;

async function readDiagram(
  file: string,
  io: Io,
): Promise<{ name: string; diagram: Diagram } | number> {
  const abs = path.resolve(io.cwd, file);
  const name = displayPath(io.cwd, abs);
  const text = await readIfExists(abs);
  if (text === null) throw new UsageError(`Diagram "${file}" not found`);
  const { diagram, errors } = parseArchitecture(text);
  if (errors.length) {
    io.stderr(formatErrors(name, errors));
    return EXIT.fail;
  }
  return { name, diagram };
}

async function cmdDiff(argv: string[], io: Io): Promise<number> {
  const { positionals, options } = parseArgs(argv, HELP_OPT);
  if (options.help) {
    io.stdout(DIFF_HELP);
    return EXIT.ok;
  }
  if (positionals.length !== 2) throw new UsageError('diff needs exactly two diagrams');
  const a = await readDiagram(positionals[0]!, io);
  const b = await readDiagram(positionals[1]!, io);
  if (typeof a === 'number' || typeof b === 'number') return EXIT.fail;

  const d = diffStructure(a.diagram, b.diagram);
  let moved = 0;
  let resized = 0;
  for (const n of b.diagram.nodes) {
    const was = a.diagram.layout[n.id];
    const now = b.diagram.layout[n.id];
    if (!was || !now || !a.diagram.nodes.some((m) => m.id === n.id)) continue;
    if (was.x !== now.x || was.y !== now.y) moved++;
    if (was.w !== now.w || was.h !== now.h) resized++;
  }
  io.stdout(`${a.name} -> ${b.name}\n`);
  io.stdout(hasChanges(d) ? `${countLine(d)}\n` : 'No structural changes\n');
  io.stdout(formatDiff(d, a.diagram, b.diagram));
  io.stdout(`Layout: ${moved} moved, ${resized} resized nodes\n`);
  return EXIT.ok;
}

async function cmdMergeDriver(argv: string[], io: Io): Promise<number> {
  const { positionals, options } = parseArgs(argv, HELP_OPT);
  if (options.help) {
    io.stdout(MERGE_DRIVER_HELP);
    return EXIT.ok;
  }
  if (positionals.length < 3 || positionals.length > 4)
    throw new UsageError('merge-driver needs <base> <ours> <theirs> [<path>]');
  const [basePath, oursPath, theirsPath] = positionals.map((p) => path.resolve(io.cwd, p));
  const name = positionals[3] ?? displayPath(io.cwd, oursPath!);
  const texts: string[] = [];
  for (const [i, p] of [basePath!, oursPath!, theirsPath!].entries()) {
    const t = await readIfExists(p);
    if (t === null) throw new UsageError(`merge-driver: "${positionals[i]}" not found`);
    texts.push(t);
  }
  const [base, ours, theirs] = texts as [string, string, string];
  const { text, conflicts } = merge3(base, ours, theirs);

  if (conflicts.some((c) => c.kind === 'parse')) {
    for (const c of conflicts) io.stderr(`opsdraw: ${name}: ${c.message}\n`);
    // Fall back to git's own line-based merge so nothing from theirs is silently lost.
    const r = spawnSync(
      'git',
      ['merge-file', '-L', 'ours', '-L', 'base', '-L', 'theirs', oursPath!, basePath!, theirsPath!],
      { cwd: io.cwd, encoding: 'utf8' },
    );
    if (r.status === 0) {
      io.stderr(`opsdraw: ${name}: merged line by line without conflicts\n`);
      return EXIT.ok;
    }
    io.stderr(
      r.status !== null && r.status > 0
        ? `opsdraw: ${name}: line-based merge left conflict markers\n`
        : `opsdraw: ${name}: line-based merge failed; kept ours\n`,
    );
    return EXIT.fail;
  }

  let out = annotateConflicts(text, conflicts);
  if (/\r\n/.test(ours)) out = out.replace(/\r?\n/g, '\r\n');
  await fs.writeFile(oursPath!, out, 'utf8');
  if (!conflicts.length) return EXIT.ok;
  io.stderr(`opsdraw: ${name}: ${conflicts.length} conflict(s), marked with %% CONFLICT lines:\n`);
  for (const c of conflicts) io.stderr(`  ${c.message}\n`);
  return EXIT.fail;
}

const ATTRIBUTE_PATTERNS = ['*.mmd', '*.mermaid'];
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** True when the script lives in an npm install (node_modules, npx cache), not a checkout. */
const isInstalled = (entry: string) => entry.split(/[\\/]/).includes('node_modules');

function driverCommand(kind: string, entry: string | undefined): string {
  const local = kind === 'local' || (kind === 'auto' && !!entry && !isInstalled(entry));
  if (!local) return 'npx --yes opsdraw merge-driver %O %A %B %P';
  if (!entry) throw new UsageError('Cannot tell where this CLI is installed; use --driver npx');
  // Forward slashes: git runs the driver through sh, where backslashes are escapes.
  return `node "${path.resolve(entry).replace(/\\/g, '/')}" merge-driver %O %A %B %P`;
}

/** .gitattributes text with the merge=opsdraw lines added where missing. */
export function withMergeAttributes(text: string): string {
  const has = (pattern: string) =>
    text.split(/\r?\n/).some((l) => {
      const [p, ...attrs] = l.trim().split(/\s+/);
      return p === pattern && attrs.includes('merge=opsdraw');
    });
  const missing = ATTRIBUTE_PATTERNS.filter((p) => !has(p));
  if (!missing.length) return text;
  const sep = text && !text.endsWith('\n') ? '\n' : '';
  return `${text}${sep}${missing.map((p) => `${p} merge=opsdraw\n`).join('')}`;
}

async function cmdGitSetup(argv: string[], io: Io): Promise<number> {
  const { positionals, options } = parseArgs(argv, {
    ...HELP_OPT,
    apply: { type: 'boolean' },
    driver: { type: 'string', choices: ['auto', 'npx', 'local'] },
  });
  if (options.help) {
    io.stdout(GIT_SETUP_HELP);
    return EXIT.ok;
  }
  if (positionals.length) throw new UsageError('git-setup takes no arguments');
  const driver = driverCommand((options.driver as string | undefined) ?? 'auto', io.entry);
  const config: [string, string][] = [
    ['merge.opsdraw.name', 'OpsDraw diagram merge'],
    ['merge.opsdraw.driver', driver],
  ];

  if (!options.apply) {
    io.stdout('# Run in your repository (or use: opsdraw git-setup --apply)\n');
    for (const [k, v] of config) io.stdout(`git config ${k} ${shQuote(v)}\n`);
    for (const p of ATTRIBUTE_PATTERNS) io.stdout(`echo '${p} merge=opsdraw' >> .gitattributes\n`);
    return EXIT.ok;
  }

  const git = (...args: string[]) => spawnSync('git', args, { cwd: io.cwd, encoding: 'utf8' });
  const top = git('rev-parse', '--show-toplevel');
  if (top.error || top.status !== 0) {
    io.stderr(`opsdraw: git-setup --apply must run inside a git repository\n`);
    return EXIT.fail;
  }
  for (const [k, v] of config) {
    const r = git('config', k, v);
    if (r.status !== 0) {
      io.stderr(`opsdraw: git config ${k} failed: ${r.stderr.trim()}\n`);
      return EXIT.fail;
    }
    io.stdout(`Set ${k} = ${v}\n`);
  }
  const attrPath = path.join(top.stdout.trim(), '.gitattributes');
  const before = (await readIfExists(attrPath)) ?? '';
  const after = withMergeAttributes(before);
  if (after === before) {
    io.stdout('.gitattributes already routes diagrams to the opsdraw driver\n');
  } else {
    await fs.writeFile(attrPath, after, 'utf8');
    io.stdout('Updated .gitattributes (commit it so the driver applies for everyone)\n');
  }
  return EXIT.ok;
}

const COMMANDS: Record<string, (argv: string[], io: Io) => Promise<number>> = {
  import: cmdImport,
  export: cmdExport,
  validate: cmdValidate,
  diff: cmdDiff,
  'merge-driver': cmdMergeDriver,
  'git-setup': cmdGitSetup,
};

/** Runs the CLI and returns the exit code. Never calls process.exit, so it is testable. */
export async function run(argv: readonly string[], io: Io, version: string): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (!command || command === '--help' || command === '-h' || command === 'help') {
      io.stdout(HELP);
      return EXIT.ok;
    }
    if (command === '--version' || command === '-v' || command === 'version') {
      io.stdout(`${version}\n`);
      return EXIT.ok;
    }
    const handler = COMMANDS[command];
    if (!handler) throw new UsageError(`Unknown command "${command}"`);
    return await handler(rest, io);
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr(`opsdraw: ${e.message}\nRun "opsdraw --help" for usage.\n`);
      return EXIT.usage;
    }
    io.stderr(`opsdraw: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.fail;
  }
}
