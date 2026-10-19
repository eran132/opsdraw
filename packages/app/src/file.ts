/**
 * File access. Uses the File System Access API where available (Chromium, and the Tauri webview
 * on Windows) so Save writes back to the same file and external edits (for example from the MCP
 * server) can be picked up. Elsewhere it falls back to upload/download.
 */

interface FileHandle {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: string | Blob): Promise<void>; close(): Promise<void> }>;
}

type PickerWindow = Window & {
  showOpenFilePicker?: (opts: unknown) => Promise<FileHandle[]>;
  showSaveFilePicker?: (opts: unknown) => Promise<FileHandle>;
};

const pickerWindow = window as PickerWindow;
export const canWriteBack = typeof pickerWindow.showOpenFilePicker === 'function';

const MERMAID_TYPES = [
  { description: 'Mermaid', accept: { 'text/plain': ['.mmd', '.mermaid', '.md'] } },
];

export interface OpenedFile {
  name: string;
  text: string;
  handle?: FileHandle;
  lastModified: number;
}

export async function openFile(): Promise<OpenedFile | null> {
  if (canWriteBack) {
    try {
      const [handle] = await pickerWindow.showOpenFilePicker!({ types: MERMAID_TYPES });
      if (!handle) return null;
      const file = await handle.getFile();
      return { name: file.name, text: await file.text(), handle, lastModified: file.lastModified };
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return null;
      throw e;
    }
  }
  const [file] = await pickFiles('.mmd,.mermaid,.md,text/plain', false);
  return file
    ? { name: file.name, text: await file.text(), lastModified: file.lastModified }
    : null;
}

/** Writes to the handle, or asks for a location (or downloads) when there is none. */
export async function saveFile(
  text: string,
  name: string,
  handle?: FileHandle,
): Promise<{ handle?: FileHandle; name: string; lastModified: number } | null> {
  if (!handle && canWriteBack && pickerWindow.showSaveFilePicker) {
    try {
      handle = await pickerWindow.showSaveFilePicker({ suggestedName: name, types: MERMAID_TYPES });
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return null;
      throw e;
    }
  }
  if (handle) {
    const w = await handle.createWritable();
    await w.write(text);
    await w.close();
    const file = await handle.getFile();
    return { handle, name: handle.name, lastModified: file.lastModified };
  }
  download(new Blob([text], { type: 'text/plain' }), name);
  return { name, lastModified: Date.now() };
}

/** Reads the file again if it changed since `since`; used to follow edits made by other tools. */
export async function readIfChanged(handle: FileHandle, since: number): Promise<OpenedFile | null> {
  const file = await handle.getFile();
  if (file.lastModified <= since) return null;
  return { name: file.name, text: await file.text(), handle, lastModified: file.lastModified };
}

export function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.oncancel = () => resolve([]);
    input.click();
  });
}

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Rasterizes an SVG string to PNG at 2x for sharp output. */
export async function svgToPng(svg: string): Promise<Blob> {
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    await new Promise<void>((ok, fail) => {
      img.onload = () => ok();
      img.onerror = () => fail(new Error('Could not load SVG'));
      img.src = url;
    });
    const scale = 2;
    const w = img.naturalWidth || 1024;
    const h = img.naturalHeight || 768;
    const canvas = document.createElement('canvas');
    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((ok, fail) =>
      canvas.toBlob((b) => (b ? ok(b) : fail(new Error('PNG failed'))), 'image/png'),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}
