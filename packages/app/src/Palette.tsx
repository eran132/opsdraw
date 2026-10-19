import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GENERIC_CATALOG, parseIconRef } from '@archidraw/core';
import { Icon, usePacksVersion } from './Icon';
import { installedPacks, searchIcons } from './icons';
import { DRAG_MIME, type PaletteItem } from './Canvas';

interface Props {
  /** Called on click; the app applies the icon to the selected node, if any. */
  onPick(icon: string): void;
}

/** "square-function" -> "Square function", used as a default label. */
export const humanize = (ref: string) => {
  const s = parseIconRef(ref).name.replace(/[-_]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

function Tile({
  item,
  title,
  onClick,
}: {
  item: PaletteItem;
  title: string;
  onClick?: () => void;
}) {
  return (
    <button
      className="tile"
      title={title}
      draggable
      onClick={onClick}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_MIME, JSON.stringify(item));
        e.dataTransfer.effectAllowed = 'copy';
      }}
    >
      {item.kind === 'junction' ? (
        <span className="tile-junction" />
      ) : item.kind === 'group' ? (
        <span className="tile-group" />
      ) : (
        <Icon refName={item.icon} size={28} />
      )}
      <span className="tile-label">{title}</span>
    </button>
  );
}

export function Palette({ onPick }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  usePacksVersion();
  const hits = useMemo(() => searchIcons(query), [query]);
  const packs = installedPacks();

  const tileFor = (ref: string) => (
    <Tile
      key={ref}
      item={{ kind: 'service', icon: ref, label: humanize(ref) }}
      title={humanize(ref)}
      onClick={() => onPick(ref)}
    />
  );

  return (
    <aside className="palette">
      <input
        type="search"
        className="palette-search"
        placeholder={t('palette.search')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <p className="muted small">{t('palette.hint')}</p>
      {query ? (
        <section>
          <h3>{t('palette.categories.results')}</h3>
          {hits.length ? (
            <div className="tiles">{hits.map((h) => tileFor(h.ref))}</div>
          ) : (
            <p className="muted">{t('palette.noResults')}</p>
          )}
        </section>
      ) : (
        <>
          <section>
            <h3>{t('palette.shapes')}</h3>
            <div className="tiles">
              <Tile
                item={{ kind: 'group', label: t('palette.group'), icon: 'cloud' }}
                title={t('palette.group')}
              />
              <Tile item={{ kind: 'junction', label: '' }} title={t('palette.junction')} />
            </div>
          </section>
          {GENERIC_CATALOG.map((cat) => (
            <section key={cat.id}>
              <h3>{t(`palette.categories.${cat.id}` as 'palette.categories.compute')}</h3>
              <div className="tiles">{cat.icons.map((i) => tileFor(i.ref))}</div>
            </section>
          ))}
          {packs.map((p) => (
            <section key={p.prefix}>
              <h3 dir="auto">
                {p.prefix}: <span className="muted">{p.name}</span>
              </h3>
              <div className="tiles">
                {Object.keys(p.icons)
                  .slice(0, 48)
                  .map((name) => tileFor(`${p.prefix}:${name}`))}
              </div>
            </section>
          ))}
        </>
      )}
    </aside>
  );
}
