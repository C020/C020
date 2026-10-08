/**
 * React bindings for the dashboard i18n. See ./core.ts for how to add keys and use `t()`.
 *
 *   const { t, lang, dir, setLang } = useI18n();
 *   <p>{t('overview.title')}</p>
 */
import { useCallback, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { applyDocumentLang, dirOf, getLang, langStore, setLang, t as translate, type Lang, type MessageKey, type MessageParams } from './core';

export * from './core';

export interface I18n {
  lang: Lang;
  dir: 'rtl' | 'ltr';
  t: (key: MessageKey, params?: MessageParams) => string;
  setLang: (lang: Lang) => void;
}

export function useLang(): Lang {
  return useSyncExternalStore(langStore.subscribe, langStore.get, getLang);
}

export function useI18n(): I18n {
  const lang = useLang();
  const t = useCallback((key: MessageKey, params?: MessageParams) => translate(key, params, lang), [lang]);
  return { lang, dir: dirOf(lang), t, setLang };
}

/**
 * Keeps <html lang dir> in sync and remounts its children when the language changes so every
 * string (including ones computed by plain helper modules) re-renders in the new language.
 * Server data stays in the react-query cache, so a switch does not refetch.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const lang = useLang();
  useEffect(() => applyDocumentLang(lang), [lang]);
  return <LangBoundary key={lang}>{children}</LangBoundary>;
}

function LangBoundary({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
