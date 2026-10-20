import { useTranslation } from 'react-i18next';
import { useReactFlow } from '@xyflow/react';
import {
  JUNCTION_SIZE,
  SERVICE_SIZE,
  removeNode,
  type ArchNode,
  type Diagram,
} from '@opsdraw/core';
import {
  alignRects,
  distributeRects,
  type AlignMode,
  type Axis,
  type Positions,
  type Rect,
} from './align';
import type { Selection } from './Canvas';
import { ColorPicker } from './ColorPicker';
import { duplicateSelection } from './clipboard';

interface Props {
  diagram: Diagram;
  ids: string[];
  onChange(d: Diagram): void;
  onSelect(s: Selection): void;
}

const GROUP_FALLBACK = { w: 320, h: 220 };

/** 16px glyphs: a guide line and two bars, like most drawing tools. */
const ALIGN_ICONS: Record<AlignMode, string> = {
  left: 'M2 1v14M4 3h9v3H4zM4 10h6v3H4z',
  center: 'M8 1v14M3 3h10v3H3zM5 10h6v3H5z',
  right: 'M14 1v14M3 3h9v3H3zM6 10h6v3H6z',
  top: 'M1 2h14M3 4h3v9H3zM10 4h3v6h-3z',
  middle: 'M1 8h14M3 3h3v10H3zM10 5h3v6h-3z',
  bottom: 'M1 14h14M3 3h3v9H3zM10 6h3v6h-3z',
};
const DISTRIBUTE_ICONS: Record<Axis, string> = {
  horizontal: 'M1 1v14M15 1v14M6 4h4v8H6z',
  vertical: 'M1 1h14M1 15h14M4 6h8v4H4z',
};

const Glyph = ({ d }: { d: string }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d={d} fill="none" stroke="currentColor" strokeWidth="1.3" />
  </svg>
);

const ALIGN_LABELS: Record<AlignMode, string> = {
  left: 'inspector.alignLeft',
  center: 'inspector.alignCenter',
  right: 'inspector.alignRight',
  top: 'inspector.alignTop',
  middle: 'inspector.alignMiddle',
  bottom: 'inspector.alignBottom',
};
const DISTRIBUTE_LABELS: Record<Axis, string> = {
  horizontal: 'inspector.distributeHorizontal',
  vertical: 'inspector.distributeVertical',
};

/** Inspector panel for a multi-node selection: align, distribute, delete. */
export function MultiSelection({ diagram, ids, onChange, onSelect }: Props) {
  const { t } = useTranslation();
  const rf = useReactFlow();
  const nodes = ids
    .map((id) => diagram.nodes.find((n) => n.id === id))
    .filter((n): n is ArchNode => !!n);
  const siblings = nodes.length > 1 && nodes.every((n) => n.parent === nodes[0]!.parent);

  /** Boxes as the canvas draws them, falling back to the stored layout when it isn't shown. */
  const rects = (): Rect[] =>
    nodes.map((n) => {
      const internal = rf.getInternalNode(n.id);
      const stored = diagram.layout[n.id];
      const fallback =
        n.kind === 'group' ? GROUP_FALLBACK : n.kind === 'junction' ? JUNCTION_SIZE : SERVICE_SIZE;
      return {
        id: n.id,
        x: internal?.position.x ?? stored?.x ?? 0,
        y: internal?.position.y ?? stored?.y ?? 0,
        w: internal?.measured.width ?? stored?.w ?? fallback.w,
        h: internal?.measured.height ?? stored?.h ?? fallback.h,
      };
    });

  const apply = (positions: Positions) => {
    const layout = { ...diagram.layout };
    for (const [id, p] of Object.entries(positions)) layout[id] = { ...layout[id], ...p };
    onChange({ ...diagram, layout });
  };

  return (
    <aside className="inspector">
      <h2>{t('inspector.multiSelected', { count: nodes.length })}</h2>
      <div className="align-section">
        <h3>{t('inspector.align')}</h3>
        <div className="align-buttons" role="group" aria-label={t('inspector.align')}>
          {(Object.keys(ALIGN_ICONS) as AlignMode[]).map((mode) => (
            <button
              key={mode}
              className="icon-button"
              disabled={!siblings}
              aria-label={t(ALIGN_LABELS[mode])}
              title={t(ALIGN_LABELS[mode])}
              onClick={() => apply(alignRects(rects(), mode))}
            >
              <Glyph d={ALIGN_ICONS[mode]} />
            </button>
          ))}
        </div>
        <h3>{t('inspector.distribute')}</h3>
        <div className="align-buttons" role="group" aria-label={t('inspector.distribute')}>
          {(Object.keys(DISTRIBUTE_ICONS) as Axis[]).map((axis) => (
            <button
              key={axis}
              className="icon-button"
              disabled={!siblings || nodes.length < 3}
              aria-label={t(DISTRIBUTE_LABELS[axis])}
              title={t(DISTRIBUTE_LABELS[axis])}
              onClick={() => apply(distributeRects(rects(), axis))}
            >
              <Glyph d={DISTRIBUTE_ICONS[axis]} />
            </button>
          ))}
        </div>
        {!siblings ? (
          <p className="muted small" role="note">
            {t('inspector.notSiblings')}
          </p>
        ) : (
          nodes.length < 3 && <p className="muted small">{t('inspector.distributeHint')}</p>
        )}
      </div>
      <ColorPicker diagram={diagram} ids={ids} onChange={onChange} />
      <p className="muted small">{t('inspector.nudgeHint')}</p>
      <button
        title={t('inspector.duplicateHint')}
        onClick={() => {
          const out = duplicateSelection(diagram, ids);
          onChange(out.diagram);
          onSelect(out.selection);
        }}
      >
        {t('inspector.duplicate')}
      </button>
      <button
        className="danger"
        onClick={() => {
          let d = diagram;
          for (const n of nodes) d = removeNode(d, n.id);
          onChange(d);
          onSelect(null);
        }}
      >
        {t('inspector.delete')}
      </button>
    </aside>
  );
}
