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

function initialLanguage(): string {
  const saved = storage.get('lang');
  if (saved && supported.includes(saved)) return saved;
  for (const tag of navigator.languages ?? [navigator.language]) {
    const base = tag.toLowerCase().split('-')[0]!;
    // Browsers still report Hebrew as "iw" in some setups.
    const code = base === 'iw' ? 'he' : base;
    if (supported.includes(code)) return code;
  }
  return 'en';
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
i18n.on('languageChanged', (lang) => {
  storage.set('lang', lang);
  applyLanguage(lang);
});

export default i18n;
