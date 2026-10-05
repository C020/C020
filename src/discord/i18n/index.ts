/**
 * #16 — tiny translation core for the bot's Discord-facing text (notifications, panels, replies).
 * Each area keeps its own dictionary file (e.g. ./messages.ts, ./interactions.ts) built with `defineMessages`,
 * so parallel work never edits the same file. Arabic is the fallback language.
 */
import type { Language } from '../../db/features.js';

export type { Language };

export type MessageDict = Record<string, { ar: string; en: string }>;
export type Vars = Record<string, string | number | null | undefined>;

/** Replaces {name} placeholders; unknown/null values render empty. */
export function interpolate(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_, key: string) => {
    const v = vars[key];
    return v == null ? '' : String(v);
  });
}

/** Builds a typed translator for one dictionary: t(lang, key, vars). */
export function defineMessages<D extends MessageDict>(dict: D): (lang: Language | null | undefined, key: keyof D & string, vars?: Vars) => string {
  return (lang, key, vars) => {
    const entry = dict[key];
    if (!entry) return key;
    return interpolate(lang === 'en' ? entry.en : entry.ar, vars);
  };
}

/** Number formatting with western digits in both languages (readable in RTL embeds). */
export function formatCount(value: number | null | undefined): string {
  return value == null ? '—' : new Intl.NumberFormat('en-US').format(value);
}
