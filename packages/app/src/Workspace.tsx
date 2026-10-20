import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from './Icon';
import { shortcut } from './Menu';
import {
  LIMITS,
  isOpen,
  RAIL,
  resolveLayout,
  setFocusMode,
  setLayout,
  setPaneOpen,
  togglePane,
  usePanes,
  type PaneId,
  type ResolvedPane,
  type SizeId,
} from './panes';

/** Keyboard shortcuts of the layout commands (also listed in the README). */
export const PANE_SHORTCUTS: Record<PaneId | 'focus', string> = {
  palette: 'Ctrl+B',
  editor: 'Ctrl+\\',
  inspector: 'Ctrl+.',
  focus: 'Ctrl+Shift+F',
};

const PANE_ICONS: Record<PaneId, string> = {
  palette: 'shapes',
  editor: 'code-xml',
  inspector: 'sliders-horizontal',
};

const domId = (id: PaneId) => `pane-${id}`;

/** Arrow-key step of a focused splitter; Shift moves further. */
const STEP = 16;
const BIG_STEP = 64;
/** A splitter dragged below half the panel's minimum collapses it on release. */
const COLLAPSE_RATIO = 0.5;

interface Props {
  palette: ReactNode;
  editor: ReactNode;
  stage: ReactNode;
  inspector: ReactNode;
}

/** A splitter drag in progress: shown live, stored on release. */
interface Live {
  id: SizeId;
  size: number;
  collapsed: boolean;
}

/**
 * The workspace grid: palette | code editor | stage | inspector, with a splitter between
 * neighbours. The editor can also sit above the stage. Collapsed panels leave a rail; focus mode
 * leaves only the stage. Grid columns are logical, so the order mirrors in right-to-left languages.
 */
export function Workspace(p: Props) {
  const { t } = useTranslation();
  const { layout, narrow } = usePanes();
  const ref = useRef<HTMLElement>(null);
  const [box, setBox] = useState(() => ({
    width: typeof innerWidth === 'number' ? innerWidth : 1280,
    height: typeof innerHeight === 'number' ? innerHeight - 80 : 680,
  }));
  const [live, setLive] = useState<Live | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setBox({ width: el.clientWidth, height: el.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const liveLayout = live
    ? {
        ...layout,
        sizes: { ...layout.sizes, [live.id]: live.size },
        collapsed: { ...layout.collapsed, [paneOf(live.id)]: live.collapsed },
      }
    : layout;
  const r = resolveLayout(liveLayout, box.width, box.height, narrow);
  const above = r.editorPosition === 'above';
  const focus = r.focus;

  // Hiding the panel that holds the keyboard focus would drop it on <body>; give it to the canvas.
  const openKey = `${r.palette.open}${r.editor.open}${r.inspector.open}`;
  const lastOpenKey = useRef(openKey);
  useLayoutEffect(() => {
    if (lastOpenKey.current === openKey) return;
    lastOpenKey.current = openKey;
    const active = document.activeElement;
    const lost =
      !active ||
      active === document.body ||
      [...(ref.current?.querySelectorAll('.pane[hidden]') ?? [])].some((el) => el.contains(active));
    if (lost) focusStage();
  }, [openKey]);

  const col = (pane: ResolvedPane) => (focus ? '0px' : pane.open ? `${pane.size}px` : `${RAIL}px`);
  const line = focus ? '0px' : '1px';
  const style: React.CSSProperties = above
    ? {
        gridTemplateColumns: `${col(r.palette)} ${line} minmax(0, 1fr) ${line} ${col(r.inspector)}`,
        gridTemplateRows: `${focus ? '0px' : r.editor.open ? `${r.editorHeight.size}px` : `${RAIL}px`} ${line} minmax(0, 1fr)`,
        gridTemplateAreas: `"pal spal ed sinsp insp" "pal spal sed sinsp insp" "pal spal stage sinsp insp"`,
      }
    : {
        gridTemplateColumns: `${col(r.palette)} ${line} ${col(r.editor)} ${line} minmax(0, 1fr) ${line} ${col(r.inspector)}`,
        gridTemplateRows: 'minmax(0, 1fr)',
        gridTemplateAreas: `"pal spal ed sed stage sinsp insp"`,
      };

  const commit = (id: SizeId, size: number, collapsed: boolean) => {
    const pane = paneOf(id);
    setLayout((l) => ({
      ...l,
      focus: false,
      sizes: collapsed
        ? l.sizes
        : { ...l.sizes, [id]: Math.round(clamp(size, LIMITS[id].min, LIMITS[id].max)) },
      collapsed: { ...l.collapsed, [pane]: collapsed },
    }));
  };

  const splitter = (id: SizeId, pane: ResolvedPane, area: string, side: 'start' | 'end') => {
    const which = paneOf(id);
    return (
      <Splitter
        key={`split-${id}`}
        area={area}
        axis={id === 'editorHeight' ? 'y' : 'x'}
        side={side}
        size={pane.open ? pane.size : 0}
        min={pane.min}
        max={pane.max}
        label={t(`panes.resize.${which}`)}
        hint={t('panes.resizeHint')}
        controls={domId(which)}
        dragging={live?.id === id}
        onPreview={(size, collapsed) => setLive(size === null ? null : { id, size, collapsed })}
        onCommit={(size, collapsed) => commit(id, size, collapsed)}
        onToggle={() => setPaneOpen(which, !pane.open)}
      />
    );
  };

  const paneEl = (id: PaneId, pane: ResolvedPane, area: string, children: ReactNode) => (
    <div
      key={id}
      id={domId(id)}
      className={`pane pane-${id}`}
      style={{ gridArea: area }}
      hidden={!pane.open}
    >
      {children}
    </div>
  );

  const rail = (id: PaneId, area: string, axis: 'x' | 'y', end = false) => (
    <button
      key={`${id}-rail`}
      type="button"
      className={`pane-rail pane-rail-${axis}${end ? ' pane-rail-end' : ''}`}
      style={{ gridArea: area }}
      aria-label={t(`panes.show.${id}`)}
      aria-expanded={false}
      aria-controls={domId(id)}
      aria-keyshortcuts={keyshortcuts(PANE_SHORTCUTS[id])}
      data-tooltip={`${t(`panes.show.${id}`)} (${shortcut(PANE_SHORTCUTS[id])})`}
      onClick={() => setPaneOpen(id, true)}
    >
      <UiIcon name={PANE_ICONS[id]} />
      <span className="pane-rail-label">{t(`panes.name.${id}`)}</span>
    </button>
  );

  return (
    <main
      ref={ref}
      className={`workspace${live ? ' resizing' : ''}${live?.id === 'editorHeight' ? ' resizing-y' : ''}${focus ? ' focus-mode' : ''}`}
      data-editor={r.editorPosition}
      style={style}
    >
      {paneEl('palette', r.palette, 'pal', p.palette)}
      {!focus && !r.palette.open && rail('palette', 'pal', 'x')}
      {!focus && splitter('palette', r.palette, 'spal', 'start')}

      {paneEl('editor', r.editor, 'ed', p.editor)}
      {!focus && !r.editor.open && rail('editor', 'ed', above ? 'y' : 'x')}
      {!focus &&
        (above
          ? splitter('editorHeight', r.editorHeight, 'sed', 'start')
          : splitter('editor', r.editor, 'sed', 'start'))}

      <div className="pane pane-stage" style={{ gridArea: 'stage' }}>
        {p.stage}
      </div>

      {!focus && splitter('inspector', r.inspector, 'sinsp', 'end')}
      {paneEl('inspector', r.inspector, 'insp', p.inspector)}
      {!focus && !r.inspector.open && rail('inspector', 'insp', 'x', true)}
    </main>
  );
}

const paneOf = (id: SizeId): PaneId => (id === 'editorHeight' ? 'editor' : id);
const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

/** "Ctrl+Shift+F" -> "Control+Shift+F" (or Meta on macOS) for aria-keyshortcuts. */
const keyshortcuts = (keys: string) =>
  keys
    .replace('Ctrl+', /Mac|iPhone|iPad/.test(navigator.platform || '') ? 'Meta+' : 'Control+')
    .replace('\\', 'Backslash')
    .replace(/\+\.$/, '+Period');

function focusStage() {
  const target =
    document.querySelector<HTMLElement>('.pane-stage .canvas') ??
    document.querySelector<HTMLElement>('.pane-stage [role=tab][aria-selected=true]');
  target?.focus({ preventScroll: true });
}

interface SplitterProps {
  area: string;
  /** x: a column splitter (drag sideways); y: the row splitter under the editor. */
  axis: 'x' | 'y';
  /** Which side of the splitter the panel it sizes is on (logical: flips in RTL). */
  side: 'start' | 'end';
  /** Size of that panel; 0 when it is collapsed. */
  size: number;
  min: number;
  max: number;
  label: string;
  hint: string;
  controls: string;
  dragging: boolean;
  onPreview(size: number | null, collapsed: boolean): void;
  onCommit(size: number, collapsed: boolean): void;
  onToggle(): void;
}

/**
 * A window splitter (WAI-ARIA APG): drag it, or focus it and use the arrow keys (Shift for bigger
 * steps), Home and End for the smallest and largest size, Enter or a double-click to collapse and
 * restore the panel. Moving it toward the stage enlarges the panel, in either writing direction.
 */
function Splitter(p: SplitterProps) {
  const drag = useRef<{ pos: number; size: number; moved: boolean; pointer: number } | null>(null);
  const last = useRef<{ size: number; collapsed: boolean } | null>(null);

  /** +1 when moving right (or down) enlarges the panel, -1 when it shrinks it. */
  const growSign = (el: Element) => {
    if (p.axis === 'y') return 1;
    const rtl = el.closest('[dir=rtl]') !== null;
    return (p.side === 'start') !== rtl ? 1 : -1;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus({ preventScroll: true });
    drag.current = {
      pos: p.axis === 'x' ? e.clientX : e.clientY,
      size: p.size,
      moved: false,
      pointer: e.pointerId,
    };
    last.current = null;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    const delta = (p.axis === 'x' ? e.clientX : e.clientY) - d.pos;
    if (!d.moved && Math.abs(delta) < 3) return;
    d.moved = true;
    const raw = d.size + delta * growSign(e.currentTarget);
    const collapsed = raw < p.min * COLLAPSE_RATIO;
    const size = clamp(raw, p.min, p.max);
    last.current = { size, collapsed };
    p.onPreview(size, collapsed);
  };

  const end = (e: React.PointerEvent<HTMLDivElement>, cancel: boolean) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    const result = last.current;
    last.current = null;
    if (!cancel && d.moved && result) p.onCommit(result.size, result.collapsed);
    p.onPreview(null, false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const collapsed = p.size === 0;
    let next: number | undefined;
    const step = e.shiftKey ? BIG_STEP : STEP;
    const sign = growSign(e.currentTarget);
    const physical =
      p.axis === 'x'
        ? { ArrowRight: 1, ArrowLeft: -1 }[e.key]
        : { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (physical !== undefined) {
      const grow = physical * sign;
      if (collapsed) next = grow > 0 ? p.min : undefined;
      else next = clamp(p.size + grow * step, p.min, p.max);
    } else if (e.key === 'Home') next = p.min;
    else if (e.key === 'End') next = p.max;
    else if (e.key === 'Enter') {
      e.preventDefault();
      p.onToggle();
      return;
    } else return;
    e.preventDefault();
    if (next !== undefined) p.onCommit(next, false);
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      className={`splitter splitter-${p.axis}${p.dragging ? ' dragging' : ''}`}
      style={{ gridArea: p.area }}
      aria-orientation={p.axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={p.label}
      aria-controls={p.controls}
      aria-valuenow={Math.round(p.size)}
      aria-valuemin={0}
      aria-valuemax={Math.round(p.max)}
      title={p.hint}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => end(e, false)}
      onPointerCancel={(e) => end(e, true)}
      onLostPointerCapture={(e) => end(e, false)}
      onDoubleClick={p.onToggle}
      onKeyDown={onKeyDown}
    />
  );
}

/** A toggle button for the stage bar that shows or hides one side panel. */
export function PaneToggle({ id, className = '' }: { id: PaneId; className?: string }) {
  const { t } = useTranslation();
  const { layout, narrow } = usePanes();
  const open = isOpen(layout, id, narrow);
  const icon =
    id === 'palette'
      ? 'panel-left'
      : id === 'inspector'
        ? 'panel-right'
        : layout.editorPosition === 'above'
          ? 'panel-top'
          : 'code-xml';
  return (
    <button
      type="button"
      className={`ghost icon-button pane-toggle ${className}`}
      aria-label={t(`panes.name.${id}`)}
      aria-pressed={open}
      aria-controls={domId(id)}
      aria-keyshortcuts={keyshortcuts(PANE_SHORTCUTS[id])}
      data-tooltip={`${t(open ? `panes.hide.${id}` : `panes.show.${id}`)} (${shortcut(PANE_SHORTCUTS[id])})`}
      onClick={() => togglePane(id)}
    >
      <span className={id === 'editor' ? undefined : 'flip-rtl'}>
        <UiIcon name={icon} />
      </span>
    </button>
  );
}

/** Focus mode on/off: hides every side panel so the stage fills the workspace. */
export function FocusToggle({ className = '' }: { className?: string }) {
  const { t } = useTranslation();
  const { layout } = usePanes();
  const on = layout.focus;
  return (
    <button
      type="button"
      className={`ghost icon-button pane-toggle ${className}`}
      aria-label={t('panes.focus')}
      aria-pressed={on}
      aria-keyshortcuts={keyshortcuts(PANE_SHORTCUTS.focus)}
      data-tooltip={
        on
          ? `${t('panes.exitFocus')} (Esc)`
          : `${t('panes.focus')} (${shortcut(PANE_SHORTCUTS.focus)})`
      }
      onClick={() => setFocusMode(!on)}
    >
      <UiIcon name={on ? 'minimize' : 'maximize'} />
    </button>
  );
}
