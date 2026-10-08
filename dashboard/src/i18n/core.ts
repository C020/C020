/**
 * Dashboard i18n core (framework-free; React bindings live in ./index.tsx).
 *
 * ── How to add / use strings ─────────────────────────────────────────────────────────────────
 * 1. Add the key to `ar.ts` (the source of truth, Arabic is the default language). Keys are flat
 *    dotted names grouped by area: "nav.*", "common.*", "settings.*", "streamers.*"…
 * 2. Add the same key to `en.ts`. The `Dictionary` type makes a missing/extra key a type error and
 *    test/i18n.test.ts checks placeholders match between languages.
 * 3. Use it:   t('streamers.removed', { name })            → "{name}" placeholders are interpolated
 *              t('common.items', { count: 3 })              → plural object picked by Intl.PluralRules
 *    In components prefer `const { t, lang } = useI18n()`; plain modules can import `t` from here.
 *    Changing the language remounts the routed tree, so module-level helpers that call `t()` at
 *    render time are always up to date — but never call `t()` at module top level (it would freeze
 *    the import-time language); wrap such tables in a function instead.
 *
 * Plural messages are objects keyed by Intl plural categories (`zero|one|two|few|many|other`,
 * `other` required). Arabic uses all six; English uses `one`/`other`. `{count}` inside them is
 * replaced with the locale-formatted number (western digits in both languages).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
import { readStorage, writeStorage } from '../hooks/useLocalStorage';
import { createStore } from '../lib/store';
import { ar } from './ar';
import { en } from './en';

export type Lang = 'ar' | 'en';
export const LANGS: readonly Lang[] = ['ar', 'en'];
export const DEFAULT_LANG: Lang = 'ar';
export const LANG_STORAGE_KEY = 'lang';

export type PluralMessage = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };
export type Message = string | PluralMessage;
export type MessageKey = keyof typeof ar;
export type Dictionary = { readonly [K in MessageKey]: Message };
export type MessageParams = Record<string, string | number | null | undefined>;

const DICTIONARIES: Record<Lang, Dictionary> = { ar, en };

export function isLang(value: unknown): value is Lang {
  return value === 'ar' || value === 'en';
}

/** Intl locale per UI language — always western (latn) digits. */
export function intlLocale(lang: Lang = getLang()): string {
  return lang === 'ar' ? 'ar-u-nu-latn' : 'en-US';
}

export function dirOf(lang: Lang): 'rtl' | 'ltr' {
  return lang === 'ar' ? 'rtl' : 'ltr';
}

function initialLang(): Lang {
  const stored = readStorage<unknown>(LANG_STORAGE_KEY, null);
  return isLang(stored) ? stored : DEFAULT_LANG;
}

export const langStore = createStore<Lang>(typeof window === 'undefined' ? DEFAULT_LANG : initialLang());

export function getLang(): Lang {
  return langStore.get();
}

/** Mirrors the language on <html lang dir> and the document title. Safe outside the browser. */
export function applyDocumentLang(lang: Lang = getLang()): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.lang = lang;
  root.dir = dirOf(lang);
  document.title = t('app.documentTitle', undefined, lang);
}

export function setLang(lang: Lang): void {
  if (!isLang(lang)) return;
  writeStorage(LANG_STORAGE_KEY, lang);
  langStore.set(lang);
  applyDocumentLang(lang);
}

const pluralRulesCache = new Map<Lang, Intl.PluralRules>();
const numberCache = new Map<Lang, Intl.NumberFormat>();

function pluralRules(lang: Lang): Intl.PluralRules {
  let rules = pluralRulesCache.get(lang);
  if (!rules) {
    rules = new Intl.PluralRules(intlLocale(lang));
    pluralRulesCache.set(lang, rules);
  }
  return rules;
}

function countFormat(lang: Lang): Intl.NumberFormat {
  let f = numberCache.get(lang);
  if (!f) {
    f = new Intl.NumberFormat(intlLocale(lang), { maximumFractionDigits: 1 });
    numberCache.set(lang, f);
  }
  return f;
}

/** Replaces `{name}` placeholders; unknown placeholders are left as-is so mistakes stay visible. */
export function interpolate(template: string, params: MessageParams | undefined, lang: Lang = getLang()): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    if (value === undefined || value === null) return whole;
    return typeof value === 'number' ? countFormat(lang).format(value) : value;
  });
}

export function selectPlural(message: PluralMessage, count: number, lang: Lang): string {
  const n = Number.isFinite(count) ? Math.abs(count) : 0;
  const category = pluralRules(lang).select(n);
  // Arabic "zero" falls back to "other"; anything missing falls back to "other".
  return message[category] ?? message.other;
}

/** Translates a key. Falls back to Arabic, then to the key itself (never throws). */
export function t(key: MessageKey, params?: MessageParams, lang: Lang = getLang()): string {
  const message: Message | undefined = DICTIONARIES[lang][key] ?? DICTIONARIES[DEFAULT_LANG][key];
  if (message === undefined) return String(key);
  if (typeof message === 'string') return interpolate(message, params, lang);
  const count = typeof params?.count === 'number' ? params.count : 0;
  return interpolate(selectPlural(message, count, lang), params, lang);
}

/** Joins list items the locale's way ("أ، ب و ج" / "a, b and c"). */
export function formatList(items: readonly string[], lang: Lang = getLang()): string {
  try {
    return new Intl.ListFormat(intlLocale(lang), { style: 'long', type: 'conjunction' }).format(items);
  } catch {
    return items.join(lang === 'ar' ? '\u060C ' : ', ');
  }
}

export function dictionary(lang: Lang): Dictionary {
  return DICTIONARIES[lang];
}

/**
 * A read-only record whose values are translated on every read (getters), for lookup tables that
 * live at module level: `const LABELS = translatedRecord({ a: 'x.a', b: 'x.b' }); LABELS.a`.
 */
export function translatedRecord<K extends string>(keys: Record<K, MessageKey>): Readonly<Record<K, string>> {
  const out = {} as Record<K, string>;
  for (const name of Object.keys(keys) as K[]) {
    Object.defineProperty(out, name, { enumerable: true, get: () => t(keys[name]) });
  }
  return out;
}
