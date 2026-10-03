import { DEFAULT_TEMPLATES as SHARED_DEFAULTS } from '../../../src/shared/templates';
import type { TemplateSpec } from '../api/types';

export type TemplateType = 'live' | 'summary' | 'content';
export type TemplateTextField = 'content' | 'title' | 'description' | 'footer';

export const TEMPLATE_TYPES: TemplateType[] = ['live', 'summary', 'content'];

export const TEMPLATE_TYPE_LABELS: Record<TemplateType, { label: string; description: string }> = {
  live: { label: 'إشعار البث', description: 'الرسالة اللي تنرسل أول ما الستريمر يبدأ بث، وتتحدّث تلقائياً وهو لايف.' },
  summary: { label: 'ملخص البث', description: 'نفس رسالة البث تتحول لملخص بعد ما يخلص (المدة، المشاهدين، الألعاب، روابط الإعادة).' },
  content: { label: 'إشعار المقاطع', description: 'الرسالة اللي تنرسل لما ينزل مقطع جديد (فيديو، شورتس، كليب، تسجيل بث…).' },
};

/** Discord hard limits per field (characters). */
export const TEMPLATE_LIMITS: Record<TemplateTextField, number> = {
  content: 2000,
  title: 256,
  description: 4096,
  footer: 2048,
};

export const TEMPLATE_FIELD_LABELS: Record<TemplateTextField, { label: string; hint: string }> = {
  content: { label: 'نص الرسالة', hint: 'يظهر فوق الـ Embed. المنشن ينضاف تلقائياً حسب إعدادات المنشن.' },
  title: { label: 'العنوان', hint: 'عنوان الـ Embed (بدون تنسيق ماركداون).' },
  description: { label: 'الوصف', hint: 'يدعم تنسيق ديسكورد: **عريض** و *مائل* و [روابط](https://…).' },
  footer: { label: 'التذييل', hint: 'سطر صغير أسفل الـ Embed.' },
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
