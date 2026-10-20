import { useSyncExternalStore } from 'react';
import { storage } from './storage';

/** What the user picked; "system" follows the operating system's light/dark setting. */
export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_PREFERENCES: readonly ThemePreference[] = ['light', 'dark', 'system'];

const isPreference = (v: string | null): v is ThemePreference =>
  v === 'light' || v === 'dark' || v === 'system';

const media =
  typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : undefined;
const listeners = new Set<() => void>();

let preference: ThemePreference = (() => {
  const saved = storage.get('theme');
  return isPreference(saved) ? saved : 'system';
})();

const resolve = (): ResolvedTheme =>
  preference === 'system' ? (media?.matches ? 'dark' : 'light') : preference;

let snapshot = { preference, resolved: resolve() };

function update() {
  snapshot = { preference, resolved: resolve() };
  listeners.forEach((fn) => fn());
}

/**
 * An explicit choice is written to `<html data-theme>`; "system" removes it so the CSS
 * `prefers-color-scheme` rules apply on their own, even before any script runs.
 */
export function applyTheme() {
  const root = document.documentElement;
  if (preference === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', preference);
}

export function setThemePreference(next: ThemePreference) {
  preference = next;
  storage.set('theme', next);
  applyTheme();
  update();
}

export const getTheme = () => snapshot;

media?.addEventListener('change', update);

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** The theme preference and the light/dark mode it currently resolves to. */
export function useTheme() {
  return useSyncExternalStore(subscribe, getTheme, getTheme);
}

/** Subscribes outside React (the Mermaid renderer). */
export const onThemeChanged = subscribe;
