/**
 * #5 — per-streamer template overrides. A blank field inherits the server template (the field is omitted); a type
 * with no fields is no override at all. The whole object is sent on save (the API replaces it).
 */
import type { Templates } from '../api/types';
import { draftFromSpec, sameDraft, specFromDraft, TEMPLATE_TYPES, type TemplateDraft, type TemplateType } from './templates';

export type OverrideDrafts = Record<TemplateType, TemplateDraft>;

export function overrideDrafts(templates: Templates | null | undefined): OverrideDrafts {
  const src = templates ?? {};
  return { live: draftFromSpec(src.live), summary: draftFromSpec(src.summary), content: draftFromSpec(src.content) };
}

export function overridesFromDrafts(drafts: OverrideDrafts): Templates {
  const out: Templates = {};
  for (const type of TEMPLATE_TYPES) {
    const spec = specFromDraft(drafts[type]);
    if (Object.keys(spec).length > 0) out[type] = spec;
  }
  return out;
}

export function sameOverrideDrafts(a: OverrideDrafts, b: OverrideDrafts): boolean {
  return TEMPLATE_TYPES.every((type) => sameDraft(a[type], b[type]));
}

/** Types that have an override (for badges). */
export function overriddenTypes(templates: Templates | null | undefined): TemplateType[] {
  const drafts = overrideDrafts(templates);
  return TEMPLATE_TYPES.filter((type) => Object.keys(specFromDraft(drafts[type])).length > 0);
}
