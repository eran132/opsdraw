import { useTranslation } from 'react-i18next';
import {
  PALETTE_NAMES,
  cssColor,
  formatStyle,
  type ArchNode,
  type Diagram,
  type PaletteName,
} from '@opsdraw/core';

interface Props {
  diagram: Diagram;
  /** Nodes to color; junctions are skipped. */
  ids: readonly string[];
  onChange(d: Diagram): void;
}

/**
 * Palette swatches for the selected nodes and groups (written as `%% @style`). A swatch sets
 * the fill and the border; "default" removes the style.
 */
export function ColorPicker({ diagram, ids, onChange }: Props) {
  const { t } = useTranslation();
  const wanted = new Set(ids);
  const targets = diagram.nodes.filter((n) => wanted.has(n.id) && n.kind !== 'junction');
  if (!targets.length) return null;
  const current = new Set(targets.map((n) => formatStyle(n.style)));
  const active = current.size === 1 ? [...current][0]! : null;

  const apply = (name: PaletteName | null) => {
    const ids = new Set(targets.map((n) => n.id));
    onChange({
      ...diagram,
      nodes: diagram.nodes.map((n): ArchNode => {
        if (!ids.has(n.id)) return n;
        const { style: _old, ...rest } = n;
        return name ? { ...rest, style: { fill: name, stroke: name } } : rest;
      }),
    });
  };

  return (
    <div className="color-picker">
      <span className="color-picker-label" id="color-picker-label">
        {t('inspector.color')}
      </span>
      <div className="swatches" role="group" aria-labelledby="color-picker-label">
        {PALETTE_NAMES.map((name) => {
          const label = t(`inspector.colors.${name}`);
          const pressed = active === formatStyle({ fill: name, stroke: name });
          return (
            <button
              key={name}
              type="button"
              className="swatch"
              aria-label={label}
              title={label}
              aria-pressed={pressed}
              data-color={name}
              style={{
                background: `linear-gradient(${cssColor(name, 'fill')}, ${cssColor(name, 'fill')}) var(--node-bg)`,
                borderColor: cssColor(name, 'stroke'),
              }}
              onClick={() => apply(name)}
            />
          );
        })}
        <button
          type="button"
          className="swatch swatch-reset"
          aria-label={t('inspector.resetColor')}
          title={t('inspector.resetColor')}
          aria-pressed={active === ''}
          onClick={() => apply(null)}
        />
      </div>
    </div>
  );
}
