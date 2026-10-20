import { useSyncExternalStore } from 'react';
import { storage } from './storage';

/** The side panels around the stage (canvas or preview). */
export type PaneId = 'palette' | 'editor' | 'inspector';
/** Where the code editor sits: beside the canvas (columns) or above it (rows). */
export type EditorPosition = 'beside' | 'above';
/** A size the user can drag: a panel width, or the editor height when it sits above the canvas. */
export type SizeId = PaneId | 'editorHeight';

export const PANE_IDS: readonly PaneId[] = ['palette', 'editor', 'inspector'];

export interface PaneLayout {
  sizes: Record<SizeId, number>;
  /** Missing means the default: open, except the inspector in narrow windows. */
  collapsed: Partial<Record<PaneId, boolean>>;
  editorPosition: EditorPosition;
  /** Focus mode hides every side panel; the stage gets the whole workspace. */
  focus: boolean;
}

/** Size limits in CSS pixels. */
export const LIMITS: Record<SizeId, { min: number; max: number; initial: number }> = {
  palette: { min: 160, max: 360, initial: 224 },
  editor: { min: 220, max: 960, initial: 360 },
  inspector: { min: 200, max: 420, initial: 256 },
  editorHeight: { min: 120, max: 720, initial: 240 },
};
/** The canvas never gets narrower or shorter than this because of a side panel. */
export const STAGE_MIN = { width: 280, height: 200 };
/** Width (or height) of the strip a collapsed panel leaves behind. */
export const RAIL = 32;
/** Below this window width the inspector starts as a rail. */
export const NARROW_WIDTH = 1100;

export const DEFAULT_LAYOUT: PaneLayout = {
  sizes: {
    palette: LIMITS.palette.initial,
    editor: LIMITS.editor.initial,
    inspector: LIMITS.inspector.initial,
    editorHeight: LIMITS.editorHeight.initial,
  },
  collapsed: {},
  editorPosition: 'beside',
  focus: false,
};

const KEY = 'layout';

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

/** Reads a stored layout, keeping only well-formed values. */
export function parseLayout(raw: string | null): PaneLayout {
  if (!raw) return DEFAULT_LAYOUT;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return DEFAULT_LAYOUT;
  }
  if (!data || typeof data !== 'object') return DEFAULT_LAYOUT;
  const d = data as Partial<Record<keyof PaneLayout, unknown>>;
  const sizes = { ...DEFAULT_LAYOUT.sizes };
  if (d.sizes && typeof d.sizes === 'object') {
    for (const id of Object.keys(LIMITS) as SizeId[]) {
      const v = (d.sizes as Record<string, unknown>)[id];
      if (typeof v === 'number' && Number.isFinite(v))
        sizes[id] = clamp(Math.round(v), LIMITS[id].min, LIMITS[id].max);
    }
  }
  const collapsed: PaneLayout['collapsed'] = {};
  if (d.collapsed && typeof d.collapsed === 'object') {
    for (const id of PANE_IDS) {
      const v = (d.collapsed as Record<string, unknown>)[id];
      if (typeof v === 'boolean') collapsed[id] = v;
    }
  }
  return {
    sizes,
    collapsed,
    editorPosition: d.editorPosition === 'above' ? 'above' : 'beside',
    focus: d.focus === true,
  };
}

/** Whether a panel is shown, taking focus mode and the narrow-window default into account. */
export function isOpen(layout: PaneLayout, id: PaneId, narrow: boolean): boolean {
  if (layout.focus) return false;
  const c = layout.collapsed[id];
  return c === undefined ? !(id === 'inspector' && narrow) : !c;
}

export interface ResolvedPane {
  open: boolean;
  /** Size the panel is drawn at (it may be squeezed below the stored size in small windows). */
  size: number;
  min: number;
  /** Largest size that still leaves the stage its minimum. */
  max: number;
}

export interface ResolvedLayout {
  palette: ResolvedPane;
  editor: ResolvedPane;
  inspector: ResolvedPane;
  editorHeight: ResolvedPane;
  editorPosition: EditorPosition;
  focus: boolean;
}

/**
 * Turns the stored layout into the sizes drawn in a workspace of `width` x `height`: panels that
 * do not fit are squeezed (editor first, then palette, then inspector, never below their minimum),
 * and each panel's maximum is what still leaves the stage STAGE_MIN.
 */
export function resolveLayout(
  layout: PaneLayout,
  width: number,
  height: number,
  narrow: boolean,
): ResolvedLayout {
  const above = layout.editorPosition === 'above';
  const open = {
    palette: isOpen(layout, 'palette', narrow),
    editor: isOpen(layout, 'editor', narrow),
    inspector: isOpen(layout, 'inspector', narrow),
  };
  // Panels that take width from the stage: the editor only when it sits beside the canvas.
  const columns: PaneId[] = above ? ['palette', 'inspector'] : ['palette', 'editor', 'inspector'];
  const size: Record<PaneId, number> = {
    palette: layout.sizes.palette,
    editor: layout.sizes.editor,
    inspector: layout.sizes.inspector,
  };
  const railWidth = layout.focus
    ? 0
    : columns.reduce((sum, id) => sum + (open[id] ? 0 : RAIL), 0) + columns.length; // + 1px dividers
  const used = () => columns.reduce((sum, id) => sum + (open[id] ? size[id] : 0), 0);
  let excess = used() + railWidth + STAGE_MIN.width - width;
  for (const id of ['editor', 'palette', 'inspector'] as PaneId[]) {
    if (excess <= 0) break;
    if (!columns.includes(id) || !open[id]) continue;
    const give = Math.min(excess, size[id] - LIMITS[id].min);
    if (give <= 0) continue;
    size[id] -= give;
    excess -= give;
  }
  const pane = (id: PaneId): ResolvedPane => {
    const { min, max } = LIMITS[id];
    if (!columns.includes(id)) return { open: open[id], size: size[id], min, max };
    const others = used() - (open[id] ? size[id] : 0);
    // Opening a collapsed panel gives back its rail.
    const rails = railWidth - (open[id] ? 0 : RAIL);
    const room = width - rails - others - STAGE_MIN.width;
    return { open: open[id], size: size[id], min, max: Math.max(min, Math.min(max, room)) };
  };
  const h = LIMITS.editorHeight;
  const heightRoom = height - 1 - STAGE_MIN.height;
  const maxHeight = Math.max(h.min, Math.min(h.max, heightRoom));
  return {
    palette: pane('palette'),
    editor: pane('editor'),
    inspector: pane('inspector'),
    editorHeight: {
      open: open.editor,
      size: clamp(layout.sizes.editorHeight, h.min, maxHeight),
      min: h.min,
      max: maxHeight,
    },
    editorPosition: layout.editorPosition,
    focus: layout.focus,
  };
}

// ---------- Store ----------

const listeners = new Set<() => void>();
const narrowQuery =
  typeof matchMedia === 'function'
    ? matchMedia(`(max-width: ${NARROW_WIDTH - 0.02}px)`)
    : undefined;

let layout: PaneLayout = parseLayout(storage.get(KEY));
let snapshot = { layout, narrow: narrowQuery?.matches ?? false };

function emit() {
  snapshot = { layout, narrow: narrowQuery?.matches ?? false };
  listeners.forEach((fn) => fn());
}

narrowQuery?.addEventListener?.('change', emit);

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** The stored layout and whether the window is narrow; re-renders on every change. */
export function usePanes() {
  return useSyncExternalStore(subscribe, () => snapshot);
}

export const getPanes = () => snapshot;

/** Replaces the layout and remembers it (storage failures are ignored by the helper). */
export function setLayout(update: (l: PaneLayout) => PaneLayout) {
  layout = update(layout);
  storage.set(KEY, JSON.stringify(layout));
  emit();
}

export function setPaneSize(id: SizeId, size: number) {
  const { min, max } = LIMITS[id];
  setLayout((l) => ({ ...l, sizes: { ...l.sizes, [id]: clamp(Math.round(size), min, max) } }));
}

/** Shows or hides a panel; showing one leaves focus mode (the other panels come back too). */
export function setPaneOpen(id: PaneId, open: boolean) {
  setLayout((l) => ({ ...l, focus: false, collapsed: { ...l.collapsed, [id]: !open } }));
}

export function togglePane(id: PaneId) {
  setPaneOpen(id, !isOpen(snapshot.layout, id, snapshot.narrow));
}

export function setEditorPosition(editorPosition: EditorPosition) {
  setLayout((l) => ({ ...l, editorPosition }));
}

export function setFocusMode(focus: boolean) {
  setLayout((l) => ({ ...l, focus }));
}

export function resetLayout() {
  setLayout(() => DEFAULT_LAYOUT);
}
