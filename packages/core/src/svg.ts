import type { ArchNode, Diagram, NodeStyle, Point, Rect, Side } from './model';
import { GROUP_PADDING, JUNCTION_SIZE, SERVICE_SIZE } from './layout';
import { serializeArchitecture } from './mermaid';
import { catalogEntry, parseIconRef } from './icons';
import {
  cssColor,
  formatStyle,
  paletteVars,
  resolveColor,
  sanitizeStyle,
  type StyleKey,
} from './style';

/**
 * Renders a diagram to a standalone SVG from OpsDraw's own geometry (the `@pos` layout), so the
 * export looks like the canvas. Mermaid's renderer ignores stored positions, so it can't do this.
 *
 * The output uses plain <text> (no <foreignObject>, which many viewers can't show), inlines every
 * icon, carries <title>/<desc> for accessibility, and embeds the Mermaid source in <metadata> so
 * the file can be reopened and edited.
 */

export interface IconData {
  body: string;
  width: number;
  height: number;
}

export type Theme = 'light' | 'dark' | 'auto';

export interface SvgOptions {
  resolveIcon?: (ref: string) => IconData | null;
  theme?: Theme;
  /** Embed the Mermaid source in <metadata> (default true). */
  embedSource?: boolean;
  padding?: number;
  /** Add a box listing the icons and colors used (default false). */
  legend?: boolean;
  /** Heading of the legend box (default "Legend"). */
  legendTitle?: string;
  /** Draw a small hop where a horizontal edge segment crosses a vertical one (default true). */
  lineJumps?: boolean;
}

export const SOURCE_METADATA_ID = 'opsdraw-source';
const GROUP_DEFAULT = { w: 320, h: 220 };
/** Radius of the hop drawn where edges cross. */
export const JUMP_RADIUS = 5;

const COLORS = {
  light: {
    bg: '#ffffff',
    text: '#1c2330',
    muted: '#667085',
    node: '#ffffff',
    border: '#c9ced6',
    groupBg: 'rgba(37,99,235,0.05)',
    groupBorder: '#93a8d6',
    edge: '#5b6472',
    labelBg: '#ffffff',
  },
  dark: {
    bg: '#12151b',
    text: '#e4e7ec',
    muted: '#98a2b3',
    node: '#222833',
    border: '#3a4250',
    groupBg: 'rgba(91,141,239,0.08)',
    groupBorder: '#4b5f8a',
    edge: '#98a2b3',
    labelBg: '#12151b',
  },
};

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const RTL_RE = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/;
const LETTER_RE = /\p{L}/u;

/**
 * Whether text reads right to left, by its first strong (letter) character, like `dir="auto"`.
 * "API שרת" stays left to right; "שרת API" is right to left.
 */
export function isRtlText(text: string): boolean {
  for (const ch of text) {
    if (RTL_RE.test(ch)) return true;
    if (LETTER_RE.test(ch)) return false;
  }
  return false;
}

/** Splits a label into at most `maxLines` lines of about `width` characters. */
function wrap(text: string, width: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (!line) line = w;
    else if ((line + ' ' + w).length <= width) line += ' ' + w;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1]!.slice(0, width - 1) + '…';
    return kept;
  }
  return lines.map((l) => (l.length > width + 4 ? l.slice(0, width + 3) + '…' : l));
}

function textEl(
  text: string,
  x: number,
  y: number,
  cls: string,
  anchor = 'middle',
  style = '',
): string {
  // Right-to-left labels get an explicit direction so they render correctly outside browsers.
  // SVG 1.1 renderers know `embed` (not `isolate`); the label is the whole text run, so the
  // embedding isolates it the same way. A start-anchored label keeps its left edge at `x`.
  const rtl = isRtlText(text);
  const dir = rtl ? ' direction="rtl" unicode-bidi="embed"' : '';
  const a = rtl && anchor === 'start' ? 'end' : anchor;
  return `<text x="${x}" y="${y}" class="${cls}" text-anchor="${a}"${dir}${style}>${escapeXml(text)}</text>`;
}

/**
 * Absolute rectangles for every node. Nodes without a stored position are placed on a grid
 * inside their parent, the same way the canvas does it.
 */
export function absoluteRects(diagram: Diagram): Map<string, Rect> {
  const byId = new Map(diagram.nodes.map((n) => [n.id, n]));
  const fallback = new Map<string | undefined, number>();
  const relative = new Map<string, Rect>();
  for (const n of diagram.nodes) {
    const size =
      n.kind === 'group' ? GROUP_DEFAULT : n.kind === 'junction' ? JUNCTION_SIZE : SERVICE_SIZE;
    const l = diagram.layout[n.id];
    if (l) {
      relative.set(n.id, { x: l.x, y: l.y, w: l.w ?? size.w, h: l.h ?? size.h });
    } else {
      const i = fallback.get(n.parent) ?? 0;
      fallback.set(n.parent, i + 1);
      relative.set(n.id, {
        x: 24 + (i % 4) * 128,
        y: GROUP_PADDING.top + 8 + Math.floor(i / 4) * 120,
        w: size.w,
        h: size.h,
      });
    }
  }
  const abs = new Map<string, Rect>();
  const resolve = (id: string, depth = 0): Rect => {
    const cached = abs.get(id);
    if (cached) return cached;
    const r = relative.get(id)!;
    const parent = byId.get(id)?.parent;
    const p = parent && byId.has(parent) && depth < 64 ? resolve(parent, depth + 1) : null;
    const out = { ...r, x: r.x + (p?.x ?? 0), y: r.y + (p?.y ?? 0) };
    abs.set(id, out);
    return out;
  };
  for (const n of diagram.nodes) resolve(n.id);
  return abs;
}

/** Where an edge attaches to a side of a rectangle (its middle), and the outward direction. */
export function anchor(r: Rect, side: Side) {
  switch (side) {
    case 'T':
      return { x: r.x + r.w / 2, y: r.y, dx: 0, dy: -1 };
    case 'B':
      return { x: r.x + r.w / 2, y: r.y + r.h, dx: 0, dy: 1 };
    case 'L':
      return { x: r.x, y: r.y + r.h / 2, dx: -1, dy: 0 };
    case 'R':
      return { x: r.x + r.w, y: r.y + r.h / 2, dx: 1, dy: 0 };
  }
}

const horizontal = (s: Side) => s === 'L' || s === 'R';

/**
 * The points of a stored route: from `start` (on side `startSide`) through the bend points to
 * `end`. Where two consecutive points are not on a line (the ends moved a little, or the bend
 * points were rounded), an elbow is added so every segment stays horizontal or vertical, leaving
 * and entering perpendicular to the sides.
 */
export function routePoints(
  start: Point,
  startSide: Side,
  bends: readonly Point[],
  end: Point,
  endSide: Side,
): Point[] {
  const pts: Point[] = [{ x: start.x, y: start.y }];
  // Whether the segment arriving at the last point was horizontal.
  let wasHorizontal = !horizontal(startSide);
  const to = (next: Point, horizontalFirst: boolean) => {
    const cur = pts[pts.length - 1]!;
    const dx = Math.abs(next.x - cur.x);
    const dy = Math.abs(next.y - cur.y);
    if (dx < 0.5 && dy < 0.5) return;
    if (dx >= 0.5 && dy >= 0.5) {
      pts.push(horizontalFirst ? { x: next.x, y: cur.y } : { x: cur.x, y: next.y });
      wasHorizontal = !horizontalFirst;
    } else {
      wasHorizontal = dy < 0.5;
    }
    pts.push({ x: next.x, y: next.y });
  };
  bends.forEach((b, i) => to(b, i === 0 ? horizontal(startSide) : !wasHorizontal));
  to(end, !horizontal(endSide));
  // Drop the middle points of straight runs.
  return pts.filter((p, i) => {
    const a = pts[i - 1];
    const b = pts[i + 1];
    if (!a || !b) return true;
    return !((a.x === p.x && p.x === b.x) || (a.y === p.y && p.y === b.y));
  });
}

/** SVG path data for a polyline, and the middle of its longest segment (for a label). */
export function polylinePath(pts: readonly Point[]) {
  const d = pts.map((pt, i) => `${i ? 'L' : 'M'}${round(pt.x)} ${round(pt.y)}`).join(' ');
  let best = { len: -1, x: 0, y: 0 };
  for (let i = 1; i < pts.length; i++) {
    const len = Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
    if (len > best.len)
      best = { len, x: (pts[i]!.x + pts[i - 1]!.x) / 2, y: (pts[i]!.y + pts[i - 1]!.y) / 2 };
  }
  return { d, labelAt: best };
}

/** A crossing where edge `edge`'s horizontal segment `segment` (from point `segment` to the next) hops. */
export interface LineJump {
  edge: number;
  segment: number;
  x: number;
  y: number;
}

const EPS = 0.5;

/** Drops repeated points and the middle points of straight runs, so each segment is maximal. */
export function simplifyPolyline(pts: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < EPS && Math.abs(last.y - p.y) < EPS) continue;
    const prev = out[out.length - 2];
    if (
      prev &&
      last &&
      ((Math.abs(prev.x - last.x) < EPS && Math.abs(last.x - p.x) < EPS) ||
        (Math.abs(prev.y - last.y) < EPS && Math.abs(last.y - p.y) < EPS))
    )
      out.pop();
    out.push({ x: p.x, y: p.y });
  }
  return out;
}

/**
 * Where a horizontal segment of one polyline crosses a vertical segment of another, away from
 * both segments' ends (touching, T-junctions and shared end points are not crossings). Hops
 * closer than two radii to a segment end, or to another hop on the same segment, are left out,
 * so every hop has room to be drawn. Sorted by edge, segment and travel direction.
 */
export function findLineJumps(
  lines: readonly (readonly Point[])[],
  radius = JUMP_RADIUS,
): LineJump[] {
  type Seg = { edge: number; segment: number; a: Point; b: Point };
  const hs: Seg[] = [];
  const vs: Seg[] = [];
  lines.forEach((pts, edge) => {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      const dx = Math.abs(b.x - a.x);
      const dy = Math.abs(b.y - a.y);
      if (dy < EPS && dx >= EPS) hs.push({ edge, segment: i - 1, a, b });
      else if (dx < EPS && dy >= EPS) vs.push({ edge, segment: i - 1, a, b });
    }
  });
  const out: LineJump[] = [];
  for (const h of hs) {
    const y = h.a.y;
    const x0 = Math.min(h.a.x, h.b.x);
    const x1 = Math.max(h.a.x, h.b.x);
    const xs: number[] = [];
    for (const v of vs) {
      if (v.edge === h.edge) continue;
      const x = v.a.x;
      const y0 = Math.min(v.a.y, v.b.y);
      const y1 = Math.max(v.a.y, v.b.y);
      if (x <= x0 + radius * 2 || x >= x1 - radius * 2) continue;
      if (y <= y0 + EPS || y >= y1 - EPS) continue;
      xs.push(x);
    }
    const forward = h.b.x >= h.a.x;
    xs.sort((p, q) => (forward ? p - q : q - p));
    let last: number | undefined;
    for (const x of xs) {
      if (last !== undefined && Math.abs(x - last) < radius * 2) continue;
      out.push({ edge: h.edge, segment: h.segment, x, y });
      last = x;
    }
  }
  return out.sort((p, q) => p.edge - q.edge || p.segment - q.segment);
}

/**
 * SVG path data for a polyline with a semicircular hop (always upwards) at each jump. `jumps`
 * are the jumps of this polyline only, as returned by `findLineJumps`.
 */
export function jumpPath(
  pts: readonly Point[],
  jumps: readonly LineJump[],
  radius = JUMP_RADIUS,
): string {
  if (!jumps.length) return polylinePath(pts).d;
  const parts: string[] = [];
  pts.forEach((pt, i) => {
    if (i === 0) {
      parts.push(`M${round(pt.x)} ${round(pt.y)}`);
      return;
    }
    const prev = pts[i - 1]!;
    const dir = pt.x >= prev.x ? 1 : -1;
    for (const j of jumps) {
      if (j.segment !== i - 1) continue;
      parts.push(
        `L${round(j.x - dir * radius)} ${round(j.y)}`,
        `A${radius} ${radius} 0 0 ${dir > 0 ? 1 : 0} ${round(j.x + dir * radius)} ${round(j.y)}`,
      );
    }
    parts.push(`L${round(pt.x)} ${round(pt.y)}`);
  });
  return parts.join(' ');
}

/**
 * The drawn points of an edge: its stored route when it has one, otherwise an orthogonal elbow
 * leaving and entering perpendicular to the chosen sides.
 */
function edgePoints(a: Rect, as: Side, b: Rect, bs: Side, route?: readonly Point[]): Point[] {
  const p = anchor(a, as);
  const q = anchor(b, bs);
  if (route?.length) return routePoints(p, as, route, q, bs);
  const gap = 16;
  const p2 = { x: p.x + p.dx * gap, y: p.y + p.dy * gap };
  const q2 = { x: q.x + q.dx * gap, y: q.y + q.dy * gap };
  const pts = [{ x: p.x, y: p.y }, p2];
  if (p.dx !== 0 && q.dx !== 0) {
    const midX = (p2.x + q2.x) / 2;
    pts.push({ x: midX, y: p2.y }, { x: midX, y: q2.y });
  } else if (p.dy !== 0 && q.dy !== 0) {
    const midY = (p2.y + q2.y) / 2;
    pts.push({ x: p2.x, y: midY }, { x: q2.x, y: midY });
  } else if (p.dx !== 0) {
    pts.push({ x: q2.x, y: p2.y });
  } else {
    pts.push({ x: p2.x, y: q2.y });
  }
  pts.push(q2, { x: q.x, y: q.y });
  return pts;
}

const round = (v: number) => Math.round(v * 10) / 10;

export interface LegendEntry {
  kind: 'icon' | 'color';
  label: string;
  /** For `icon` entries: the icon reference. */
  icon?: string;
  /** For `color` entries: the (sanitized) style. */
  style?: NodeStyle;
}

/** `lucide:list-ordered` -> "List ordered", `aws:Arch_Amazon-EC2` -> "Arch Amazon EC2". */
export function humanizeIcon(ref: string): string {
  const words = parseIconRef(ref).name.replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : ref;
}

const MAX_LEGEND_NAMES = 3;
const joinNames = (names: string[]) =>
  names.length > MAX_LEGEND_NAMES
    ? `${names.slice(0, MAX_LEGEND_NAMES).join(', ')} +${names.length - MAX_LEGEND_NAMES}`
    : names.join(', ');

/**
 * What a legend lists: each distinct icon (the node's label when only one node uses it, else the
 * catalog title or humanized icon name), then each distinct color, labelled with the groups that use it (or the
 * nodes, when no group does). In order of first use.
 */
export function legendEntries(diagram: Diagram): LegendEntry[] {
  const icons = new Map<string, ArchNode[]>();
  const colors = new Map<string, { style: NodeStyle; nodes: ArchNode[] }>();
  for (const n of diagram.nodes) {
    if (n.kind === 'junction') continue;
    if (n.icon) icons.set(n.icon, [...(icons.get(n.icon) ?? []), n]);
    const style = sanitizeStyle(n.style);
    if (style) {
      const key = formatStyle(style);
      const entry = colors.get(key) ?? { style, nodes: [] };
      entry.nodes.push(n);
      colors.set(key, entry);
    }
  }
  const name = (n: ArchNode) => n.label || n.id;
  const out: LegendEntry[] = [];
  for (const [icon, nodes] of icons) {
    out.push({
      kind: 'icon',
      icon,
      label:
        nodes.length === 1 ? name(nodes[0]!) : (catalogEntry(icon)?.title ?? humanizeIcon(icon)),
    });
  }
  for (const { style, nodes } of colors.values()) {
    const groups = nodes.filter((n) => n.kind === 'group');
    out.push({
      kind: 'color',
      style,
      label: joinNames((groups.length ? groups : nodes).map(name)),
    });
  }
  return out;
}

function themeCss(theme: Theme): string {
  const vars = (c: (typeof COLORS)['light']) =>
    `--bg:${c.bg};--text:${c.text};--muted:${c.muted};--node:${c.node};--border:${c.border};` +
    `--group-bg:${c.groupBg};--group-border:${c.groupBorder};--edge:${c.edge};--label-bg:${c.labelBg};`;
  const base =
    `.bg{fill:var(--bg)}.node{fill:var(--node);stroke:var(--border)}` +
    `.group{fill:var(--group-bg);stroke:var(--group-border);stroke-dasharray:6 4}` +
    `.junction{fill:var(--muted)}.edge{fill:none;stroke:var(--edge);stroke-width:1.5}` +
    `.arrow{fill:var(--edge)}.icon{color:var(--text)}` +
    `.label,.group-label,.edge-label,.legend-label,.legend-title{fill:var(--text);font-family:system-ui,-apple-system,'Segoe UI','Noto Sans','Noto Sans Hebrew','Noto Sans Arabic',sans-serif}` +
    `.label,.legend-label{font-size:11px}.group-label,.legend-title{font-size:12px;font-weight:600}.edge-label{font-size:10px}` +
    `.edge-label-bg{fill:var(--label-bg)}.legend{fill:var(--bg);stroke:var(--border)}`;
  if (theme === 'auto') {
    return (
      `svg{${vars(COLORS.light)}${paletteVars('light')}}` +
      `@media (prefers-color-scheme: dark){svg{${vars(COLORS.dark)}${paletteVars('dark')}}}${base}`
    );
  }
  return `svg{${vars(COLORS[theme])}}${base}`;
}

const LEGEND = { pad: 10, row: 22, title: 22, gap: 20 };

export function renderDiagramSvg(diagram: Diagram, options: SvgOptions = {}): string {
  const {
    resolveIcon,
    theme = 'light',
    embedSource = true,
    padding = 24,
    legend = false,
    legendTitle = 'Legend',
    lineJumps = true,
  } = options;
  const rects = absoluteRects(diagram);
  const byId = new Map(diagram.nodes.map((n) => [n.id, n]));

  /** A theme-following color for a style value, validated again (the diagram may be hand-made). */
  const paint = (value: string | undefined, role: StyleKey) =>
    theme === 'auto' ? cssColor(value, role) : resolveColor(value, role, theme);
  /** ` style="..."` from CSS properties whose values passed `paint` (hex, var(), our rgba). */
  const styleAttr = (props: [string, string | undefined][]) => {
    const css = props
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}:${v}`)
      .join(';');
    return css ? ` style="${escapeXml(css)}"` : '';
  };

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects.values()) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  // Routes can go around nodes, outside their bounding box.
  for (const e of diagram.edges) {
    if (!e.route || !rects.has(e.from) || !rects.has(e.to)) continue;
    for (const p of e.route) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  if (!rects.size) [minX, minY, maxX, maxY] = [0, 0, 200, 100];
  // Leave room for labels below services.
  maxY += 8;

  // The legend goes below the diagram, aligned with its left edge.
  const entries = legend ? legendEntries(diagram) : [];
  const legendBox = entries.length
    ? {
        x: minX,
        y: maxY + LEGEND.gap,
        w: Math.round(
          Math.max(
            legendTitle.length * 7.5,
            ...entries.map((e) => Math.min(e.label.length, 48) * 6.4 + 26),
          ) +
            LEGEND.pad * 2,
        ),
        h: LEGEND.pad * 2 + LEGEND.title + entries.length * LEGEND.row - 4,
      }
    : null;
  if (legendBox) {
    maxX = Math.max(maxX, legendBox.x + legendBox.w);
    maxY = legendBox.y + legendBox.h;
  }

  const width = round(maxX - minX + padding * 2);
  const height = round(maxY - minY + padding * 2);
  const ox = padding - minX;
  const oy = padding - minY;

  const icon = (ref: string | undefined, x: number, y: number, size: number) => {
    const data = ref ? resolveIcon?.(ref) : null;
    if (!data) {
      return `<rect x="${round(x)}" y="${round(y)}" width="${size}" height="${size}" rx="4" fill="none" stroke="currentColor" stroke-dasharray="3 2" class="icon"/>`;
    }
    const s = size / Math.max(data.width, data.height);
    return `<g class="icon" transform="translate(${round(x)} ${round(y)}) scale(${round(s * 1000) / 1000})">${data.body}</g>`;
  };

  const depth = (n: ArchNode) => {
    let d = 0;
    for (let p = n.parent; p && d < 64; p = byId.get(p)?.parent) d++;
    return d;
  };
  const out: string[] = [];
  const title = diagram.title ?? 'Architecture diagram';
  const desc = `${diagram.nodes.filter((n) => n.kind === 'service').length} services, ${diagram.nodes.filter((n) => n.kind === 'group').length} groups, ${diagram.edges.length} connections`;

  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="opsdraw-title opsdraw-desc">`,
    `<title id="opsdraw-title">${escapeXml(title)}</title>`,
    `<desc id="opsdraw-desc">${escapeXml(desc)}</desc>`,
  );
  if (embedSource) {
    out.push(
      `<metadata id="${SOURCE_METADATA_ID}" data-format="mermaid">${escapeXml(serializeArchitecture(diagram))}</metadata>`,
    );
  }
  out.push(
    `<style>${themeCss(theme)}</style>`,
    `<defs><marker id="opsdraw-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="arrow"/></marker></defs>`,
    `<rect class="bg" width="100%" height="100%"/>`,
    `<g transform="translate(${round(ox)} ${round(oy)})">`,
  );

  // Groups first (outer to inner), then edges, then services on top.
  const groups = diagram.nodes
    .filter((n) => n.kind === 'group')
    .sort((a, b) => depth(a) - depth(b));
  for (const g of groups) {
    const r = rects.get(g.id)!;
    const s = g.style;
    out.push(
      `<g data-id="${escapeXml(g.id)}"><rect class="group" x="${round(r.x)}" y="${round(r.y)}" width="${round(r.w)}" height="${round(r.h)}" rx="12"${styleAttr(
        [
          ['fill', paint(s?.fill, 'fill')],
          ['stroke', paint(s?.stroke, 'stroke')],
        ],
      )}/>`,
    );
    const hasIcon = !!g.icon;
    if (hasIcon) out.push(icon(g.icon, r.x + 10, r.y + 9, 16));
    out.push(
      textEl(
        g.label ?? g.id,
        round(r.x + (hasIcon ? 32 : 12)),
        round(r.y + 21),
        'group-label',
        'start',
        styleAttr([['fill', paint(s?.color, 'color')]]),
      ),
      '</g>',
    );
  }

  const drawn = diagram.edges.flatMap((e) => {
    const a = rects.get(e.from);
    const b = rects.get(e.to);
    return a && b ? [{ e, pts: edgePoints(a, e.fromSide, b, e.toSide, e.route) }] : [];
  });
  // Hops need whole segments: an elbow's collinear pieces would hide a crossing at their joint.
  const lines = drawn.map((x) => simplifyPolyline(x.pts));
  const jumps = lineJumps ? findLineJumps(lines) : [];
  drawn.forEach(({ e, pts }, i) => {
    const plain = polylinePath(pts);
    const { labelAt } = plain;
    const mine = jumps.filter((j) => j.edge === i);
    const d = mine.length ? jumpPath(lines[i]!, mine) : plain.d;
    const markers =
      (e.arrowEnd ? ' marker-end="url(#opsdraw-arrow)"' : '') +
      (e.arrowStart ? ' marker-start="url(#opsdraw-arrow)"' : '');
    out.push(`<path class="edge" d="${d}"${markers}/>`);
    if (e.label) {
      const w = Math.min(200, e.label.length * 6 + 10);
      out.push(
        `<rect class="edge-label-bg" x="${round(labelAt.x - w / 2)}" y="${round(labelAt.y - 8)}" width="${round(w)}" height="16" rx="3"/>`,
        textEl(e.label, round(labelAt.x), round(labelAt.y + 3.5), 'edge-label'),
      );
    }
  });

  for (const n of diagram.nodes) {
    const r = rects.get(n.id)!;
    if (n.kind === 'junction') {
      out.push(
        `<circle class="junction" data-id="${escapeXml(n.id)}" cx="${round(r.x + r.w / 2)}" cy="${round(r.y + r.h / 2)}" r="${round(r.w / 2)}"/>`,
      );
      continue;
    }
    if (n.kind !== 'service') continue;
    const s = n.style;
    const box = `x="${round(r.x)}" y="${round(r.y)}" width="${round(r.w)}" height="${round(r.h)}" rx="10"`;
    const fill = paint(s?.fill, 'fill');
    out.push(
      `<g data-id="${escapeXml(n.id)}"><rect class="node" ${box}${styleAttr([['stroke', paint(s?.stroke, 'stroke')]])}/>`,
    );
    // Palette fills are translucent tints, so they go over the node's own background.
    if (fill) out.push(`<rect ${box}${styleAttr([['fill', fill]])}/>`);
    out.push(icon(n.icon, r.x + (r.w - 40) / 2, r.y + 8, 40));
    const textStyle = styleAttr([['fill', paint(s?.color, 'color')]]);
    wrap(n.label ?? n.id, 16, 2).forEach((line, i) =>
      out.push(
        textEl(line, round(r.x + r.w / 2), round(r.y + 62 + i * 13), 'label', 'middle', textStyle),
      ),
    );
    out.push('</g>');
  }

  if (legendBox) {
    const { x, y, w, h } = legendBox;
    out.push(
      `<g class="legend-box"><rect class="legend" x="${round(x)}" y="${round(y)}" width="${w}" height="${h}" rx="8"/>`,
      textEl(
        legendTitle,
        round(x + LEGEND.pad),
        round(y + LEGEND.pad + 12),
        'legend-title',
        'start',
      ),
    );
    entries.forEach((entry, i) => {
      const top = y + LEGEND.pad + LEGEND.title + i * LEGEND.row;
      const label = entry.label.length > 48 ? `${entry.label.slice(0, 47)}…` : entry.label;
      if (entry.kind === 'icon') out.push(icon(entry.icon, x + LEGEND.pad, top, 16));
      else {
        const s = entry.style;
        out.push(
          `<rect class="node" x="${round(x + LEGEND.pad)}" y="${round(top + 2)}" width="16" height="12" rx="3"${styleAttr(
            [['stroke', paint(s?.stroke ?? s?.fill ?? s?.color, 'stroke')]],
          )}/>`,
        );
        const fill = paint(s?.fill, 'fill');
        if (fill)
          out.push(
            `<rect x="${round(x + LEGEND.pad)}" y="${round(top + 2)}" width="16" height="12" rx="3"${styleAttr([['fill', fill]])}/>`,
          );
      }
      out.push(
        textEl(
          label,
          round(x + LEGEND.pad + 24),
          round(top + 12),
          'legend-label',
          'start',
          entry.kind === 'color' ? styleAttr([['fill', paint(entry.style?.color, 'color')]]) : '',
        ),
      );
    });
    out.push('</g>');
  }

  out.push('</g></svg>');
  return out.join('\n');
}

/** Reads the Mermaid source embedded by `renderDiagramSvg`, if present. */
export function extractSvgSource(svg: string): string | null {
  const m = new RegExp(
    `<metadata[^>]*id="${SOURCE_METADATA_ID}"[^>]*>([\\s\\S]*?)</metadata>`,
  ).exec(svg);
  if (!m) return null;
  return m[1]!
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}
