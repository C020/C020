import { DEFAULT_TEMPLATES as SHARED_DEFAULTS } from '../../../src/shared/templates';
import type { TemplateSpec } from '../api/types';
import { dictionary, t, type MessageKey } from '../i18n/core';

export type TemplateType = 'live' | 'summary' | 'content';
export type TemplateTextField = 'content' | 'title' | 'description' | 'footer';

export const TEMPLATE_TYPES: TemplateType[] = ['live', 'summary', 'content'];

/** Labels are translated on read (getters), so the table always follows the current language. */
export const TEMPLATE_TYPE_LABELS: Readonly<Record<TemplateType, { readonly label: string; readonly description: string }>> = {
  live: { get label() { return t('templates.type.live'); }, get description() { return t('templates.type.liveDesc'); } },
  summary: { get label() { return t('templates.type.summary'); }, get description() { return t('templates.type.summaryDesc'); } },
  content: { get label() { return t('templates.type.content'); }, get description() { return t('templates.type.contentDesc'); } },
};

/** Discord hard limits per field (characters). */
export const TEMPLATE_LIMITS: Record<TemplateTextField, number> = {
  content: 2000,
  title: 256,
  description: 4096,
  footer: 2048,
};

export const TEMPLATE_FIELD_LABELS: Readonly<Record<TemplateTextField, { readonly label: string; readonly hint: string }>> = {
  content: { get label() { return t('templates.field.content'); }, get hint() { return t('templates.field.contentHint'); } },
  title: { get label() { return t('templates.field.title'); }, get hint() { return t('templates.field.titleHint'); } },
  description: { get label() { return t('templates.field.description'); }, get hint() { return t('templates.field.descriptionHint'); } },
  footer: { get label() { return t('templates.field.footer'); }, get hint() { return t('templates.field.footerHint'); } },
};

/** The bot's built-in defaults (shared source), used as placeholders and as the preview fallback for cleared fields. */
export const DEFAULT_TEMPLATES: Record<TemplateType, Required<Pick<TemplateSpec, TemplateTextField>>> = {
  live: pickText(SHARED_DEFAULTS.live),
  summary: pickText(SHARED_DEFAULTS.summary),
  content: pickText(SHARED_DEFAULTS.content),
};

function pickText(t: { content: string; title: string; description: string; footer: string }): Required<Pick<TemplateSpec, TemplateTextField>> {
  return { content: t.content, title: t.title, description: t.description, footer: t.footer };
}

export interface TemplateDraft {
  content: string;
  title: string;
  description: string;
  footer: string;
  /** null = platform color */
  color: number | null;
}

export function draftFromSpec(spec: TemplateSpec | undefined): TemplateDraft {
  return {
    content: spec?.content ?? '',
    title: spec?.title ?? '',
    description: spec?.description ?? '',
    footer: spec?.footer ?? '',
    color: spec?.color ?? null,
  };
}

/** What gets saved: blank fields are dropped so the server falls back to its defaults. */
export function specFromDraft(draft: TemplateDraft): TemplateSpec {
  const spec: TemplateSpec = {};
  if (draft.content.trim()) spec.content = draft.content;
  if (draft.title.trim()) spec.title = draft.title;
  if (draft.description.trim()) spec.description = draft.description;
  if (draft.footer.trim()) spec.footer = draft.footer;
  if (draft.color != null) spec.color = draft.color;
  return spec;
}

/** Spec for the preview endpoint: blank fields show the default text, like after saving. */
export function previewSpec(type: TemplateType, draft: TemplateDraft): TemplateSpec {
  const defaults = DEFAULT_TEMPLATES[type];
  return {
    content: draft.content.trim() ? draft.content : defaults.content,
    title: draft.title.trim() ? draft.title : defaults.title,
    description: draft.description.trim() ? draft.description : defaults.description,
    footer: draft.footer.trim() ? draft.footer : defaults.footer,
    color: draft.color,
  };
}

export function sameDraft(a: TemplateDraft, b: TemplateDraft): boolean {
  return a.content === b.content && a.title === b.title && a.description === b.description && a.footer === b.footer && a.color === b.color;
}

export function isDefaultDraft(draft: TemplateDraft): boolean {
  return Object.keys(specFromDraft(draft)).length === 0;
}

/** Inserts `insert` replacing the [start, end) selection; returns the new text and caret position. */
export function insertAtCursor(text: string, start: number | null, end: number | null, insert: string): { text: string; caret: number } {
  const from = Math.max(0, Math.min(start ?? text.length, text.length));
  const to = Math.max(from, Math.min(end ?? from, text.length));
  return { text: text.slice(0, from) + insert + text.slice(to), caret: from + insert.length };
}

/** `{key}` placeholders used in a text that are not known variables for the type. */
export function unknownVariables(text: string, known: ReadonlyArray<{ key: string }>): string[] {
  const keys = new Set(known.map((v) => v.key.toLowerCase()));
  const found = new Set<string>();
  for (const m of text.matchAll(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g)) {
    const key = m[1];
    if (key && !keys.has(key.toLowerCase())) found.add(key);
  }
  return [...found];
}

/**
 * Description of a template variable in the dashboard language. Falls back to the shared (Arabic)
 * description for variables added to TEMPLATE_VARIABLES without a dictionary entry yet.
 */
export function variableDescription(type: TemplateType, variable: { key: string; description: string }): string {
  const key = `tplVar.${type}.${variable.key}`;
  return key in dictionary('ar') ? t(key as MessageKey) : variable.description;
}
