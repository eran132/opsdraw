import {
  absoluteRects,
  duplicateNodes,
  extractSubgraph,
  insertSubgraph,
  parseMermaid,
  removeNode,
  serializeArchitecture,
  type Diagram,
  type Point,
} from '@opsdraw/core';
import type { Selection } from './Canvas';

/**
 * Duplicate, copy, cut and paste for canvas selections. A copy is plain Mermaid text (with its
 * `@pos`/`@style` lines), so it can be pasted into the code editor, another file or another
 * OpsDraw window. When the system clipboard is unavailable or blocked, an in-memory copy still
 * makes paste work within this window.
 */

/** A selection of the given nodes. */
export function selectionOf(ids: string[]): Selection {
  if (!ids.length) return null;
  return ids.length === 1 ? { type: 'node', id: ids[0]! } : { type: 'nodes', ids };
}

/** Copies the selected nodes next to the originals and selects the copies. */
export function duplicateSelection(diagram: Diagram, ids: string[]) {
  const { diagram: next, roots } = duplicateNodes(diagram, ids);
  return { diagram: next, selection: selectionOf(roots) };
}

/** Where pastes of the last copy go when the pointer isn't over the canvas. */
const OFFSET = 24;

let memory: { text: string; origin: Point; pastes: number } | null = null;

/** The clipboard text for a selection, or null when nothing is selected. */
export function copyText(diagram: Diagram, ids: string[]): string | null {
  const frag = extractSubgraph(diagram, ids);
  return frag.nodes.length ? serializeArchitecture(frag) : null;
}

/** Copies the selection to the system clipboard (and the in-memory one). */
export async function copySelection(diagram: Diagram, ids: string[]): Promise<boolean> {
  const text = copyText(diagram, ids);
  if (!text) return false;
  const rects = absoluteRects(diagram);
  const tops = ids.map((id) => rects.get(id)).filter((r) => !!r);
  memory = {
    text,
    origin: {
      x: Math.min(...tops.map((r) => r.x)),
      y: Math.min(...tops.map((r) => r.y)),
    },
    pastes: 0,
  };
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Blocked or unavailable: the in-memory copy still pastes in this window.
  }
  return true;
}

/** Copies the selection, then removes it. */
export async function cutSelection(diagram: Diagram, ids: string[]): Promise<Diagram | null> {
  if (!(await copySelection(diagram, ids))) return null;
  let d = diagram;
  for (const id of ids) d = removeNode(d, id);
  return d;
}

async function readClipboard(): Promise<string | null> {
  try {
    const text = await navigator.clipboard.readText();
    if (text.trim()) return text;
  } catch {
    // Blocked or unavailable: fall back to what was copied in this window.
  }
  return memory?.text ?? null;
}

/** Parses clipboard text (architecture or flowchart Mermaid) into a fragment, if it is one. */
export function parseFragment(text: string): Diagram | null {
  const result = parseMermaid(text);
  if (result.errors.length || !result.diagram.nodes.length) return null;
  return result.diagram;
}

export interface PasteTarget {
  /** Pointer position on the canvas, or null when the pointer isn't over it. */
  pointer: Point | null;
  /** Where to paste when there is no pointer and the text isn't this window's last copy. */
  fallback: Point;
  /** Group under a point, to paste into. */
  groupAt(point: Point): string | undefined;
}

/**
 * Pastes the clipboard: at the pointer (into the group under it), or, without a pointer, next to
 * the copied originals. Returns the new diagram and the pasted nodes, or null when the clipboard
 * holds no diagram.
 */
export async function pasteClipboard(diagram: Diagram, target: PasteTarget) {
  const text = await readClipboard();
  if (!text) return null;
  const fragment = parseFragment(text);
  if (!fragment) return null;
  let at = target.pointer;
  if (!at) {
    if (memory && memory.text === text) {
      memory.pastes++;
      at = {
        x: memory.origin.x + OFFSET * memory.pastes,
        y: memory.origin.y + OFFSET * memory.pastes,
      };
    } else {
      at = target.fallback;
    }
  }
  const parent = target.groupAt(at);
  const { diagram: next, roots } = insertSubgraph(diagram, fragment, {
    at,
    ...(parent ? { parent } : {}),
  });
  return { diagram: next, selection: selectionOf(roots) };
}

/** Forgets the in-memory copy (tests). */
export function clearMemoryClipboard() {
  memory = null;
}
