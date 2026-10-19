import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { IacFile } from '@opsdraw/core';
import { UsageError } from './args';

import { IAC_BARE_NAMES, IAC_EXTENSIONS } from '@opsdraw/core';

export { IAC_BARE_NAMES, IAC_EXTENSIONS };
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 5000;

/** `p` relative to `cwd` with forward slashes, so output is the same on every OS. */
export const displayPath = (cwd: string, p: string): string =>
  path.relative(cwd, p).split(path.sep).join('/') || '.';

const wanted = (name: string) => {
  const lower = name.toLowerCase();
  return (
    (IAC_BARE_NAMES as readonly string[]).includes(lower) ||
    IAC_EXTENSIONS.some((ext) => lower.endsWith(ext))
  );
};

/**
 * Reads the infrastructure files under `inputs`. Files named explicitly are always read;
 * directories contribute files with a known extension (recursing when asked). Symlinks found
 * while walking, dot-directories and node_modules are skipped. Order is stable (sorted by
 * code point, not locale) so imports are reproducible across machines.
 */
export async function collectIacFiles(
  inputs: readonly string[],
  options: { recursive?: boolean; cwd?: string } = {},
): Promise<IacFile[]> {
  const cwd = options.cwd ?? process.cwd();
  const seen = new Set<string>();
  const files: IacFile[] = [];

  const add = async (abs: string) => {
    if (seen.has(abs)) return;
    seen.add(abs);
    if (files.length >= MAX_FILES) throw new Error(`More than ${MAX_FILES} files`);
    const stat = await fs.stat(abs);
    if (stat.size > MAX_FILE_BYTES) throw new Error(`${displayPath(cwd, abs)} is larger than 5 MB`);
    files.push({ path: displayPath(cwd, abs), content: await fs.readFile(abs, 'utf8') });
  };

  const walk = async (dir: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isFile() && wanted(e.name)) await add(full);
      else if (
        options.recursive &&
        e.isDirectory() &&
        !e.name.startsWith('.') &&
        e.name !== 'node_modules'
      )
        await walk(full);
    }
  };

  for (const input of inputs) {
    const abs = path.resolve(cwd, input);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      throw new UsageError(`Source "${input}" not found`);
    }
    if (stat.isFile()) await add(abs);
    else if (stat.isDirectory()) await walk(abs);
    else throw new UsageError(`Source "${input}" is not a file or directory`);
  }
  return files;
}
