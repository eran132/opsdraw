/** A node's box in its parent's coordinates. */
export interface Rect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type AlignMode = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
export type Axis = 'horizontal' | 'vertical';

export type Positions = Record<string, { x: number; y: number }>;

/** Lines the boxes up on the edge or center of the box spanning them all. */
export function alignRects(rects: Rect[], mode: AlignMode): Positions {
  const out: Positions = {};
  if (!rects.length) return out;
  const left = Math.min(...rects.map((r) => r.x));
  const right = Math.max(...rects.map((r) => r.x + r.w));
  const top = Math.min(...rects.map((r) => r.y));
  const bottom = Math.max(...rects.map((r) => r.y + r.h));
  for (const r of rects) {
    let { x, y } = r;
    if (mode === 'left') x = left;
    else if (mode === 'right') x = right - r.w;
    else if (mode === 'center') x = (left + right) / 2 - r.w / 2;
    else if (mode === 'top') y = top;
    else if (mode === 'bottom') y = bottom - r.h;
    else y = (top + bottom) / 2 - r.h / 2;
    out[r.id] = { x: Math.round(x), y: Math.round(y) };
  }
  return out;
}

/**
 * Spaces the boxes so the gaps between neighbours are equal, keeping the outermost two in place.
 * Needs at least three boxes to change anything.
 */
export function distributeRects(rects: Rect[], axis: Axis): Positions {
  const out: Positions = {};
  for (const r of rects) out[r.id] = { x: r.x, y: r.y };
  if (rects.length < 3) return out;
  const pos = axis === 'horizontal' ? 'x' : 'y';
  const size = axis === 'horizontal' ? 'w' : 'h';
  const sorted = [...rects].sort((a, b) => a[pos] - b[pos] || a.id.localeCompare(b.id));
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const span = last[pos] + last[size] - first[pos];
  const total = sorted.reduce((sum, r) => sum + r[size], 0);
  const gap = (span - total) / (sorted.length - 1);
  let at = first[pos];
  for (const r of sorted) {
    out[r.id]![pos] = Math.round(at);
    at += r[size] + gap;
  }
  return out;
}
