import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon, UiIcon } from './Icon';

export interface Command {
  id: string;
  label: string;
  /** Section heading the command is listed under. */
  group: string;
  icon?: string;
  /** Rendered with the Icon component instead of a Lucide UI glyph (palette icons). */
  iconRef?: string;
  shortcut?: string;
  /** Extra words that match, e.g. the English name in other languages. */
  keywords?: string;
  run(): void;
}

/**
 * Scores how well `query` matches a command: every word of the query must appear in the label
 * (best at the start or at a word start), in the keywords, or as letters in order in the label
 * ("fwl" finds "Firewall"). 0 means no match.
 */
export function fuzzyScore(query: string, label: string, keywords = ''): number {
  const hay = label.toLowerCase();
  const extra = keywords.toLowerCase();
  let score = 0;
  for (const word of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    const at = hay.indexOf(word);
    if (at >= 0) {
      score += at === 0 ? 6 : /[\s:/(-]/.test(hay[at - 1]!) ? 4 : 3;
      continue;
    }
    if (extra.includes(word)) {
      score += 2;
      continue;
    }
    let from = 0;
    for (const ch of word) {
      from = hay.indexOf(ch, from) + 1;
      if (!from) return 0;
    }
    score += 1;
  }
  return score;
}

interface Props {
  onClose(): void;
  commands: Command[];
  /** Extra results computed from the query (icon search). */
  extra?(query: string): Command[];
}

const MAX_RESULTS = 80;

/**
 * Ctrl/⌘+K command palette, rendered only while open: a modal dialog with a combobox that drives
 * a listbox of actions (WAI-ARIA APG combobox with aria-activedescendant, so focus stays in the
 * text field).
 */
export function CommandPalette({ onClose, commands, extra }: Props) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const id = useId();

  // Mounted only while open: open as a modal on mount, give focus back on unmount.
  useEffect(() => {
    const restore = document.activeElement as HTMLElement | null;
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    input.current?.focus();
    return () => restore?.focus?.();
  }, []);

  const results = useMemo(() => {
    const q = query.trim();
    const all = q && extra ? [...commands, ...extra(q)] : commands;
    if (!q) return all.filter((c) => !c.iconRef).slice(0, MAX_RESULTS);
    const seen = new Set<string>();
    return all
      .map((c, order) => ({ c, order, score: fuzzyScore(q, c.label, c.keywords) }))
      .filter((r) => r.score > 0 && !seen.has(r.c.id) && seen.add(r.c.id))
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .slice(0, MAX_RESULTS)
      .map((r) => r.c);
  }, [commands, extra, query]);

  const current = Math.min(active, Math.max(results.length - 1, 0));

  useEffect(() => {
    list.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [current, results]);

  const run = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const n = results.length;
    if (e.key === 'ArrowDown') setActive(n ? (current + 1) % n : 0);
    else if (e.key === 'ArrowUp') setActive(n ? (current - 1 + n) % n : 0);
    else if (e.key === 'PageDown') setActive(Math.min(current + 8, n - 1));
    else if (e.key === 'PageUp') setActive(Math.max(current - 8, 0));
    else if (e.key === 'Enter') run(results[current]);
    else return;
    e.preventDefault();
  };

  let lastGroup = '';
  return (
    <dialog
      ref={dialog}
      className="command-palette"
      aria-label={t('commands.title')}
      onClose={onClose}
      onMouseDown={(e) => {
        // A press on the backdrop (the dialog element itself) closes it.
        if (e.target === dialog.current) onClose();
      }}
    >
      <div className="command-input">
        <UiIcon name="search" />
        <input
          ref={input}
          role="combobox"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={results.length ? `${id}-opt-${current}` : undefined}
          aria-label={t('commands.title')}
          placeholder={t('commands.placeholder')}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        <kbd>Esc</kbd>
      </div>
      <ul ref={list} id={`${id}-list`} role="listbox" aria-label={t('commands.title')}>
        {results.map((c, i) => {
          const heading = c.group !== lastGroup ? c.group : null;
          lastGroup = c.group;
          return (
            <Fragment key={c.id}>
              {heading && (
                <li role="presentation" aria-hidden="true" className="command-group">
                  {heading}
                </li>
              )}
              <li
                id={`${id}-opt-${i}`}
                data-index={i}
                role="option"
                aria-selected={i === current}
                className="command-option"
                onMouseMove={() => i !== current && setActive(i)}
                onClick={() => run(c)}
              >
                <span className="command-icon" aria-hidden="true">
                  {c.iconRef ? (
                    <CommandIcon refName={c.iconRef} />
                  ) : c.icon ? (
                    <UiIcon name={c.icon} />
                  ) : null}
                </span>
                <span className="command-label" dir="auto">
                  {c.label}
                </span>
                {c.shortcut && <kbd dir="ltr">{c.shortcut}</kbd>}
              </li>
            </Fragment>
          );
        })}
      </ul>
      {results.length === 0 && <p className="command-empty muted">{t('commands.empty')}</p>}
      <p className="command-hint muted small">{t('commands.hint')}</p>
    </dialog>
  );
}

const CommandIcon = ({ refName }: { refName: string }) => (
  <Icon refName={refName} size={18} className="ui-icon" />
);
