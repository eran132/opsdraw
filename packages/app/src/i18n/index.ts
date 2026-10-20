import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en';
import he from './he';
import ar from './ar';
import es from './es';
import fr from './fr';
import de from './de';
import ja from './ja';
import zh from './zh';
import { storage } from '../storage';

export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'he', name: 'עברית', rtl: true },
  { code: 'ar', name: 'العربية', rtl: true },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
  { code: 'ja', name: '日本語' },
  { code: 'zh', name: '中文' },
] as const;

const resources = { en, he, ar, es, fr, de, ja, zh };
const supported = LANGUAGES.map((l) => l.code as string);
const LANGUAGE_KEY = 'language';

/**
 * English unless the user picked another language in the app (saved on change). The system
 * language is deliberately not used: technical users often run a localized OS but work in English.
 */
function initialLanguage(): string {
  // 'language', not the older 'lang' key: up to 0.1.3 the auto-detected system language was
  // saved there as if the user had chosen it, so those values are ignored.
  const saved = storage.get(LANGUAGE_KEY);
  return saved && supported.includes(saved) ? saved : 'en';
}

export const isRtlLanguage = (lang: string): boolean =>
  LANGUAGES.some((l) => l.code === lang && 'rtl' in l && l.rtl);

/**
 * Keeps <html lang> in step for the browser (hyphenation, fonts, screen readers). The writing
 * direction is set on the app root instead (see App), so the editor can be embedded in a page
 * without flipping the host page.
 */
export function applyLanguage(lang: string) {
  document.documentElement.lang = lang;
}

void i18n.use(initReactI18next).init({
  resources: Object.fromEntries(Object.entries(resources).map(([k, v]) => [k, { translation: v }])),
  lng: initialLanguage(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

applyLanguage(i18n.language);
i18n.on('languageChanged', applyLanguage);

/** Switches the UI language because the user asked for it, and remembers the choice. */
export function chooseLanguage(code: string) {
  if (!supported.includes(code)) return;
  storage.set(LANGUAGE_KEY, code);
  void i18n.changeLanguage(code);
}

export default i18n;
