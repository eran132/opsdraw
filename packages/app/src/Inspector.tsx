import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { descendantsOf, isValidId, removeNode, renameNode, type Diagram } from '@opsdraw/core';
import type { Selection } from './Canvas';
import { Icon } from './Icon';
import { MultiSelection } from './Alignment';
import { ColorPicker } from './ColorPicker';
import { duplicateSelection } from './clipboard';

interface Props {
  diagram: Diagram;
  selection: Selection;
  onChange(d: Diagram): void;
  onSelect(s: Selection): void;
  /** Bumped to move focus to the label field (double-click on a node). */
  focusLabel: number;
}

type Arrow = 'none' | 'forward' | 'back' | 'both';

export function Inspector({ diagram, selection, onChange, onSelect, focusLabel }: Props) {
  const { t } = useTranslation();
  const labelRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusLabel) labelRef.current?.select();
  }, [focusLabel]);

  if (selection?.type === 'nodes') {
    return (
      <MultiSelection
        diagram={diagram}
        ids={selection.ids}
        onChange={onChange}
        onSelect={onSelect}
      />
    );
  }

  if (selection?.type === 'edge') {
    const e = diagram.edges[selection.index];
    if (!e) return <Empty />;
    const arrow: Arrow =
      e.arrowStart && e.arrowEnd ? 'both' : e.arrowEnd ? 'forward' : e.arrowStart ? 'back' : 'none';
    const update = (patch: Partial<typeof e>) => {
      const edges = diagram.edges.map((x, i) => (i === selection.index ? { ...x, ...patch } : x));
      onChange({ ...diagram, edges });
    };
    return (
      <aside className="inspector">
        <h2>{t('inspector.edge')}</h2>
        <p className="muted" dir="ltr">
          {e.from} → {e.to}
        </p>
        <label>
          {t('inspector.label')}
          <input
            ref={labelRef}
            dir="auto"
            value={e.label ?? ''}
            onChange={(ev) => update({ label: ev.target.value || undefined })}
          />
        </label>
        <label>
          {t('inspector.arrow')}
          <select
            value={arrow}
            onChange={(ev) => {
              const v = ev.target.value as Arrow;
              update({
                arrowStart: v === 'back' || v === 'both' || undefined,
                arrowEnd: v === 'forward' || v === 'both' || undefined,
              });
            }}
          >
            <option value="none">{t('inspector.arrowNone')}</option>
            <option value="forward">{t('inspector.arrowForward')}</option>
            <option value="back">{t('inspector.arrowBack')}</option>
            <option value="both">{t('inspector.arrowBoth')}</option>
          </select>
        </label>
        <button
          className="danger"
          onClick={() => {
            onChange({ ...diagram, edges: diagram.edges.filter((_, i) => i !== selection.index) });
            onSelect(null);
          }}
        >
          {t('inspector.delete')}
        </button>
      </aside>
    );
  }

  const node =
    selection?.type === 'node' ? diagram.nodes.find((n) => n.id === selection.id) : undefined;
  if (!node) return <Empty />;
  const inside = descendantsOf(diagram, node.id);
  const groups = diagram.nodes.filter((n) => n.kind === 'group' && !inside.has(n.id));
  const update = (patch: Partial<typeof node>) =>
    onChange({
      ...diagram,
      nodes: diagram.nodes.map((n) => (n.id === node.id ? { ...n, ...patch } : n)),
    });

  return (
    <aside className="inspector">
      <h2>{t('inspector.title')}</h2>
      <IdField
        key={node.id}
        id={node.id}
        taken={diagram.nodes.map((n) => n.id)}
        onRename={(to) => {
          onChange(renameNode(diagram, node.id, to));
          onSelect({ type: 'node', id: to });
        }}
      />
      {node.kind !== 'junction' && (
        <label>
          {t('inspector.label')}
          <input
            ref={labelRef}
            dir="auto"
            value={node.label ?? ''}
            onChange={(e) => update({ label: e.target.value })}
          />
        </label>
      )}
      {node.kind !== 'junction' && (
        <label>
          {t('inspector.icon')}
          <span className="icon-field">
            <Icon refName={node.icon} size={24} />
            <input
              dir="ltr"
              value={node.icon ?? ''}
              onChange={(e) => update({ icon: e.target.value.trim() || undefined })}
            />
          </span>
        </label>
      )}
      <ColorPicker diagram={diagram} ids={[node.id]} onChange={onChange} />
      <label>
        {t('inspector.parent')}
        <select
          value={node.parent ?? ''}
          onChange={(e) => {
            // Positions are relative to the parent, so drop the old one and let the canvas re-place it.
            const layout = { ...diagram.layout };
            delete layout[node.id];
            const nodes = diagram.nodes.map((n) => {
              if (n.id !== node.id) return n;
              const { parent: _old, ...rest } = n;
              return e.target.value ? { ...rest, parent: e.target.value } : rest;
            });
            onChange({ ...diagram, nodes, layout });
          }}
        >
          <option value="">{t('inspector.none')}</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.label || g.id}
            </option>
          ))}
        </select>
      </label>
      <DuplicateButton ids={[node.id]} />
      <button
        className="danger"
        onClick={() => {
          onChange(removeNode(diagram, node.id));
          onSelect(null);
        }}
      >
        {t('inspector.delete')}
      </button>
    </aside>
  );

  function DuplicateButton({ ids }: { ids: string[] }) {
    return (
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
    );
  }

  function Empty() {
    return (
      <aside className="inspector">
        <h2>{t('inspector.title')}</h2>
        <p className="muted">{t('inspector.empty')}</p>
      </aside>
    );
  }
}

/** Ids are renamed on blur/Enter so typing doesn't rewrite every reference per keystroke. */
function IdField({
  id,
  taken,
  onRename,
}: {
  id: string;
  taken: string[];
  onRename(to: string): void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(id);
  const error = !isValidId(value)
    ? t('inspector.invalidId')
    : value !== id && taken.includes(value)
      ? t('inspector.takenId')
      : '';
  const commit = () => {
    if (!error && value !== id) onRename(value);
    else setValue(id);
  };
  return (
    <label>
      {t('inspector.id')}
      <input
        dir="ltr"
        value={value}
        aria-invalid={!!error}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}
