import { useEffect, useId, useRef, useState } from 'react';
import { UiIcon } from './Icon';

export type MenuEntry =
  | {
      type?: 'item';
      id: string;
      label: string;
      icon?: string;
      /** Shown on the right, e.g. "Ctrl+S". */
      shortcut?: string;
      disabled?: boolean;
      onSelect(): void;
    }
  | {
      type: 'checkbox';
      id: string;
      label: string;
      checked: boolean;
      /** Longer explanation, shown as a tooltip. */
      hint?: string;
      shortcut?: string;
      onSelect(): void;
    }
  | { type: 'radio'; id: string; label: string; icon?: string; checked: boolean; onSelect(): void }
  | { type: 'separator'; id: string };

interface Props {
  /** Visible text of the trigger; also its accessible name unless `ariaLabel` is given. */
  label?: string;
  ariaLabel?: string;
  /** Lucide icon shown before the label (or alone, for icon-only triggers). */
  icon?: string;
  /** Tooltip text for icon-only triggers. */
  tooltip?: string;
  entries: MenuEntry[];
  /** Which edge of the trigger the menu lines up with (logical, so it flips in RTL). */
  align?: 'start' | 'end';
  className?: string;
}

type Focusable = Exclude<MenuEntry, { type: 'separator' }>;

/**
 * A menu button (WAI-ARIA APG "menu button" pattern): Enter, Space or Arrow Down opens the menu on
 * its first item, Arrow Up on its last; arrows, Home and End move between items, a letter jumps to
 * the next item starting with it, Escape or Tab closes it, and a click outside dismisses it.
 */
export function MenuButton({
  label,
  ariaLabel,
  icon,
  tooltip,
  entries,
  align = 'start',
  className = '',
}: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const id = useId();
  const items = entries.filter((e): e is Focusable => e.type !== 'separator');
  const enabled = (i: number) => !(items[i] && 'disabled' in items[i] && items[i].disabled);

  const openAt = (index: number) => {
    setActive(index);
    setOpen(true);
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  useEffect(() => {
    if (open) itemRefs.current[active]?.focus();
  }, [open, active]);

  // Dismiss on a pointer press outside the menu and its button.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  const step = (from: number, delta: number) => {
    for (let n = 1; n <= items.length; n++) {
      const i = (from + delta * n + items.length * n) % items.length;
      if (enabled(i)) return i;
    }
    return from;
  };

  const activate = (entry: Focusable) => {
    if ('disabled' in entry && entry.disabled) return;
    // Check boxes stay open so several can be toggled; everything else closes first, so focus is
    // back on the button before the action runs (it may open a file picker or a dialog).
    if (entry.type !== 'checkbox') close();
    entry.onSelect();
  };

  const onButtonKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openAt(step(-1, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      openAt(step(items.length, -1));
    }
  };

  const onMenuKey = (e: React.KeyboardEvent) => {
    const k = e.key;
    if (k === 'ArrowDown') setActive((i) => step(i, 1));
    else if (k === 'ArrowUp') setActive((i) => step(i, -1));
    else if (k === 'Home') setActive(step(-1, 1));
    else if (k === 'End') setActive(step(items.length, -1));
    else if (k === 'Escape') close();
    else if (k === 'Tab') {
      setOpen(false);
      return; // Let focus move on naturally.
    } else if (k === 'Enter' || k === ' ') {
      const entry = items[active];
      if (entry) activate(entry);
    } else if (k.length === 1 && /\S/.test(k)) {
      const ch = k.toLowerCase();
      for (let n = 1; n <= items.length; n++) {
        const i = (active + n) % items.length;
        if (enabled(i) && items[i]!.label.toLowerCase().startsWith(ch)) {
          setActive(i);
          break;
        }
      }
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  let index = -1;
  const iconOnly = !label;
  return (
    <div className={`menu-root ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        id={`${id}-button`}
        className={`ghost menu-trigger${iconOnly ? ' icon-button' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        aria-label={ariaLabel}
        data-tooltip={iconOnly && !open ? tooltip : undefined}
        onClick={() => (open ? close() : openAt(step(-1, 1)))}
        onKeyDown={onButtonKey}
      >
        {icon && <UiIcon name={icon} />}
        {label && <span>{label}</span>}
        {!iconOnly && <UiIcon name="chevron-down" size={14} />}
      </button>
      {open && (
        <div
          ref={menuRef}
          id={`${id}-menu`}
          role="menu"
          aria-labelledby={`${id}-button`}
          className={`menu menu-${align}`}
          onKeyDown={onMenuKey}
        >
          {entries.map((entry) => {
            if (entry.type === 'separator')
              return <div key={entry.id} role="separator" className="menu-separator" />;
            const i = ++index;
            const checkable = entry.type === 'checkbox' || entry.type === 'radio';
            const disabled = 'disabled' in entry && entry.disabled;
            return (
              <div
                key={entry.id}
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                role={
                  entry.type === 'checkbox'
                    ? 'menuitemcheckbox'
                    : entry.type === 'radio'
                      ? 'menuitemradio'
                      : 'menuitem'
                }
                aria-checked={checkable ? entry.checked : undefined}
                aria-disabled={disabled || undefined}
                title={entry.type === 'checkbox' ? entry.hint : undefined}
                tabIndex={i === active ? 0 : -1}
                className="menu-item"
                onClick={() => activate(entry)}
                onPointerMove={() => i !== active && enabled(i) && setActive(i)}
              >
                <span className="menu-item-icon" aria-hidden="true">
                  {'icon' in entry && entry.icon ? (
                    <UiIcon name={entry.icon} />
                  ) : (
                    checkable && entry.checked && <UiIcon name="check" />
                  )}
                </span>
                <span className="menu-item-label">{entry.label}</span>
                {entry.type === 'radio' && entry.icon && (
                  <span className="menu-item-check" aria-hidden="true">
                    {entry.checked && <UiIcon name="check" />}
                  </span>
                )}
                {entry.type !== 'radio' && entry.shortcut && (
                  <kbd className="menu-item-shortcut" dir="ltr">
                    {entry.shortcut}
                  </kbd>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** "Ctrl+S" on Windows and Linux, "⌘S" on macOS. */
export const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');
export function shortcut(keys: string): string {
  if (!IS_MAC) return keys;
  return keys.replace('Ctrl+', '⌘').replace('Shift+', '⇧').replace('Alt+', '⌥');
}
