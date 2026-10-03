/**
 * Built-in (Arabic) message templates. Shared by the bot (src/discord/templates.ts) and the dashboard editor,
 * so the dashboard's placeholders and preview fallbacks always match what the bot actually sends.
 * Pure data: imported by browser code.
 */
export type TemplateType = 'live' | 'summary' | 'content';

export interface ResolvedTemplate {
  content: string;
  title: string;
  description: string;
  footer: string;
  color: number | null;
}

export const DEFAULT_TEMPLATES: Readonly<Record<TemplateType, Readonly<ResolvedTemplate>>> = Object.freeze({
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
