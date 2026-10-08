/**
 * Built-in message templates (Arabic + English). Shared by the bot (src/discord/templates.ts) and the dashboard
 * editor, so the dashboard's placeholders and preview fallbacks always match what the bot actually sends.
 * Pure data: imported by browser code.
 *
 * #16 — the guild's `features.language` picks the defaults. Saved custom templates are always used as written.
 */
import type { Language } from '../db/features.js';

export type TemplateType = 'live' | 'summary' | 'content';

export interface ResolvedTemplate {
  content: string;
  title: string;
  description: string;
  footer: string;
  color: number | null;
}

export type DefaultTemplateSet = Readonly<Record<TemplateType, Readonly<ResolvedTemplate>>>;

/** Arabic defaults (the historical `DEFAULT_TEMPLATES`, kept for compatibility). */
export const DEFAULT_TEMPLATES: DefaultTemplateSet = Object.freeze({
  live: Object.freeze({
    content: '',
    title: '🔴 {name} يبث الحين!',
    description: '**{title}**\n🎮 {game}',
    footer: 'تتحدث تلقائياً',
    color: null,
  }),
  summary: Object.freeze({
    content: '',
    title: '⚫ انتهى بث {name}',
    description: '**{title}**',
    footer: 'ملخص البث',
    color: null,
  }),
  content: Object.freeze({
    content: '',
    title: '{title}',
    description: '🎬 **{name}** نزّل {kind} جديد على {platform}!',
    footer: '{platform} • {kind}',
    color: null,
  }),
});

export const DEFAULT_TEMPLATES_EN: DefaultTemplateSet = Object.freeze({
  live: Object.freeze({
    content: '',
    title: '🔴 {name} is live now!',
    description: '**{title}**\n🎮 {game}',
    footer: 'Updates automatically',
    color: null,
  }),
  summary: Object.freeze({
    content: '',
    title: "⚫ {name}'s stream has ended",
    description: '**{title}**',
    footer: 'Stream summary',
    color: null,
  }),
  content: Object.freeze({
    content: '',
    title: '{title}',
    description: '🎬 **{name}** posted a new {kind} on {platform}!',
    footer: '{platform} • {kind}',
    color: null,
  }),
});

export const DEFAULT_TEMPLATES_BY_LANG: Readonly<Record<Language, DefaultTemplateSet>> = Object.freeze({
  ar: DEFAULT_TEMPLATES,
  en: DEFAULT_TEMPLATES_EN,
});

/** Defaults for a language; anything unknown falls back to Arabic (the bot's default language). */
export function defaultTemplatesFor(language: Language | null | undefined): DefaultTemplateSet {
  return language === 'en' ? DEFAULT_TEMPLATES_EN : DEFAULT_TEMPLATES;
}
