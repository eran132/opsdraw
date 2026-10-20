import { useTranslation } from 'react-i18next';
import type { LayoutDirection } from '@opsdraw/core';
import { LANGUAGES, chooseLanguage } from './i18n';
import { UiIcon } from './Icon';
import { IS_MAC, MenuButton, shortcut } from './Menu';
import { THEME_PREFERENCES, setThemePreference, useTheme } from './theme';

export const THEME_ICONS = { light: 'sun', dark: 'moon', system: 'monitor' } as const;

interface Props {
  fileName: string;
  dirty: boolean;
  legend: boolean;
  onLegend(on: boolean): void;
  onNew(): void;
  onOpen(): void;
  onSave(as: boolean): void;
  onImportIac(): void;
  onExport(kind: 'svg' | 'png'): void;
  onLayout(direction: LayoutDirection): void;
  onIconPacks(): void;
  onCommands(): void;
}

/** The app bar: brand and file name, File and Export menus, layout, and app-wide settings. */
export function AppBar(p: Props) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  return (
    <header className="appbar">
      <div className="appbar-start">
        <span className="brand" title={t('app.tagline')}>
          <img src="./favicon.svg" alt="" width={20} height={20} />
          <strong>OpsDraw</strong>
        </span>
        <span className="appbar-divider" />
        <MenuButton
          label={t('toolbar.file')}
          entries={[
            { id: 'new', label: t('toolbar.new'), icon: 'file-plus', onSelect: p.onNew },
            {
              id: 'open',
              label: t('toolbar.open'),
              icon: 'folder-open',
              shortcut: shortcut('Ctrl+O'),
              onSelect: p.onOpen,
            },
            {
              id: 'save',
              label: t('toolbar.save'),
              icon: 'save',
              shortcut: shortcut('Ctrl+S'),
              onSelect: () => p.onSave(false),
            },
            {
              id: 'save-as',
              label: t('toolbar.saveAs'),
              icon: 'save-all',
              shortcut: shortcut('Ctrl+Shift+S'),
              onSelect: () => p.onSave(true),
            },
            { type: 'separator', id: 'sep' },
            {
              id: 'import-iac',
              label: t('toolbar.importIac'),
              icon: 'import',
              onSelect: p.onImportIac,
            },
          ]}
        />
        <MenuButton
          label={t('toolbar.export')}
          entries={[
            {
              id: 'svg',
              label: t('toolbar.exportSvg'),
              icon: 'file-code',
              onSelect: () => p.onExport('svg'),
            },
            {
              id: 'png',
              label: t('toolbar.exportPng'),
              icon: 'file-image',
              onSelect: () => p.onExport('png'),
            },
            { type: 'separator', id: 'sep' },
            {
              type: 'checkbox',
              id: 'legend',
              label: t('toolbar.legend'),
              hint: t('toolbar.legendHint'),
              checked: p.legend,
              onSelect: () => p.onLegend(!p.legend),
            },
          ]}
        />
        <span className="appbar-divider" />
        <div className="segmented" role="group" aria-label={t('toolbar.autoLayout')}>
          <button
            type="button"
            className="icon-button"
            aria-label={t('toolbar.layoutRight')}
            data-tooltip={t('toolbar.layoutRight')}
            onClick={() => p.onLayout('RIGHT')}
          >
            <UiIcon name="arrow-right-from-line" />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={t('toolbar.layoutDown')}
            data-tooltip={t('toolbar.layoutDown')}
            onClick={() => p.onLayout('DOWN')}
          >
            <UiIcon name="arrow-down-from-line" />
          </button>
        </div>
      </div>

      <div className="appbar-center">
        <span className="file-name" dir="auto" title={p.fileName}>
          {p.fileName}
        </span>
        {p.dirty && (
          <span
            className="dirty-dot"
            role="img"
            aria-label={t('file.unsaved')}
            title={t('file.unsaved')}
          />
        )}
      </div>

      <div className="appbar-end">
        <button
          type="button"
          className="command-trigger"
          aria-keyshortcuts={IS_MAC ? 'Meta+K' : 'Control+K'}
          onClick={p.onCommands}
        >
          <UiIcon name="search" />
          <span className="command-trigger-label">{t('commands.open')}</span>
          <kbd dir="ltr">{shortcut('Ctrl+K')}</kbd>
        </button>
        <button
          type="button"
          className="ghost icon-button"
          aria-label={t('toolbar.iconPacks')}
          data-tooltip={t('toolbar.iconPacks')}
          onClick={p.onIconPacks}
        >
          <UiIcon name="package" />
        </button>
        <span className="select-wrap">
          <UiIcon name="languages" />
          <select
            aria-label={t('toolbar.language')}
            value={i18n.language}
            onChange={(e) => chooseLanguage(e.target.value)}
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </select>
        </span>
        <MenuButton
          ariaLabel={t('theme.label')}
          tooltip={t('theme.label')}
          icon={THEME_ICONS[theme.preference]}
          align="end"
          className="tip-end"
          entries={THEME_PREFERENCES.map((pref) => ({
            type: 'radio' as const,
            id: pref,
            label: t(`theme.${pref}`),
            icon: THEME_ICONS[pref],
            checked: theme.preference === pref,
            onSelect: () => setThemePreference(pref),
          }))}
        />
      </div>
    </header>
  );
}
