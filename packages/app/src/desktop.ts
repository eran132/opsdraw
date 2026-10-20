/**
 * Native file access for the OpsDraw desktop app (Tauri). The web build never loads the plugins:
 * they are imported lazily, only when running inside the desktop shell. The shell grants file
 * access only to paths the user picks in these dialogs.
 */

import type { FileHandle } from './file';

export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** A File System Access–style handle backed by a native path. */
export function desktopHandle(path: string): FileHandle {
  const name = baseName(path);
  return {
    name,
    async getFile() {
      const { readFile, stat } = await import('@tauri-apps/plugin-fs');
      const [bytes, info] = await Promise.all([readFile(path), stat(path)]);
      return new File([bytes], name, { lastModified: info.mtime?.getTime() ?? Date.now() });
    },
    async createWritable() {
      const parts: (string | Blob)[] = [];
      return {
        async write(data: string | Blob) {
          parts.push(data);
        },
        async close() {
          const { writeFile } = await import('@tauri-apps/plugin-fs');
          await writeFile(path, new Uint8Array(await new Blob(parts).arrayBuffer()));
        },
      };
    },
  };
}

/** `.mmd,.svg,text/plain` → `['mmd', 'svg']` (MIME types can't be filtered natively). */
const extensionsOf = (accept: string) =>
  accept
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('.'))
    .map((s) => s.slice(1));

export async function desktopOpen(accept: string, multiple: boolean): Promise<string[]> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const extensions = extensionsOf(accept);
  const picked = await open({
    multiple,
    filters: extensions.length ? [{ name: 'Supported files', extensions }] : undefined,
  });
  if (!picked) return [];
  return Array.isArray(picked) ? picked : [picked];
}

export async function desktopSavePath(name: string, extensions: string[]): Promise<string | null> {
  const { save } = await import('@tauri-apps/plugin-dialog');
  return save({ defaultPath: name, filters: [{ name: 'Diagram', extensions }] });
}

/** Desktop replacement for browser downloads: ask where to save, then write the bytes. */
export async function desktopSaveBlob(blob: Blob, name: string): Promise<void> {
  const ext = name.includes('.') ? name.split('.').pop()! : '';
  const path = await desktopSavePath(name, ext ? [ext] : []);
  if (!path) return;
  await desktopHandle(path)
    .createWritable()
    .then(async (w) => {
      await w.write(blob);
      await w.close();
    });
}

/** Reads picked files into File objects so the rest of the app is unchanged. */
export async function desktopPickFiles(accept: string, multiple: boolean): Promise<File[]> {
  const paths = await desktopOpen(accept, multiple);
  return Promise.all(paths.map((p) => desktopHandle(p).getFile()));
}
