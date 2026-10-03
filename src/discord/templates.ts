/**
 * Message templates: Arabic defaults, `{variable}` rendering and Discord limits. Pure, no Discord imports.
 *
 * Rendering rules
 * - `{key}` is replaced by the variable value (keys are case-insensitive); unknown keys render empty.
 * - A line whose placeholders ALL rendered empty is dropped, so optional lines such as "🎮 {game}"
 *   disappear instead of leaving a dangling label.
 * - Three or more consecutive newlines collapse to a blank line; the result is trimmed.
 */
import type { Templates, TemplateSpec } from '../db/models.js';
import { formatNumber, truncate } from './format.js';

import { DEFAULT_TEMPLATES, type ResolvedTemplate, type TemplateType } from '../shared/templates.js';

export { DEFAULT_TEMPLATES };
export type { ResolvedTemplate, TemplateType };

export const DISCORD_LIMITS = {
  content: 2000,
  title: 256,
  description: 4096,
  fieldName: 256,
  fieldValue: 1024,
  fields: 25,
  footer: 2048,
  authorName: 256,
  /** Sum of title, description, field names/values, footer and author name across a message's embeds. */
  embedTotal: 6000,
  buttonLabel: 80,
  buttonUrl: 512,
  buttonsPerRow: 5,
  rows: 5,
  url: 2048,
} as const;

export type TemplateVars = Record<string, string | number | null | undefined>;

const PLACEHOLDER_RE = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

function valueOf(vars: TemplateVars, key: string): string {
  const direct = vars[key] ?? vars[key.toLowerCase()];
  if (direct == null) return '';
  return typeof direct === 'number' ? formatNumber(direct) : direct;
}

/** Replaces `{var}` placeholders (see module docs for the line-dropping rule). */
export function render(template: string, vars: TemplateVars): string {
  if (!template) return '';
  const lines: string[] = [];
  for (const line of template.replace(/\r\n?/g, '\n').split('\n')) {
    let placeholders = 0;
    let filled = 0;
    const out = line.replace(PLACEHOLDER_RE, (_match, key: string) => {
      placeholders++;
      const value = valueOf(vars, key);
      if (value.trim() !== '') filled++;
      return value;
    });
    if (placeholders > 0 && filled === 0) continue;
    lines.push(out.trimEnd());
  }
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function validColor(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffff ? value : null;
}

/**
 * Effective template for a type: each field comes from `override` (dashboard editor preview), else the
 * guild's saved template, else the default. An explicit empty string means "leave this part empty".
 */
export function resolveTemplate(type: TemplateType, templates: Templates | null | undefined, override?: TemplateSpec): ResolvedTemplate {
  const saved = templates?.[type];
  const def = DEFAULT_TEMPLATES[type];
  const pick = (key: 'content' | 'title' | 'description' | 'footer'): string => {
    const fromOverride = override?.[key];
    if (typeof fromOverride === 'string') return fromOverride;
    const fromSaved = saved?.[key];
    if (typeof fromSaved === 'string') return fromSaved;
    return def[key];
  };
  const color = override && 'color' in override ? override.color : saved?.color;
  return {
    content: pick('content'),
    title: pick('title'),
    description: pick('description'),
    footer: pick('footer'),
    color: validColor(color),
  };
}

export interface RenderedTemplate {
  content: string;
  title: string;
  description: string;
  footer: string;
}

/**
 * Renders a resolved template within Discord limits. `markdownVars` (escaped values) are used where Discord
 * renders markdown (content, description); `plainVars` where it does not (title, footer).
 */
export function renderTemplate(template: ResolvedTemplate, plainVars: TemplateVars, markdownVars: TemplateVars = plainVars): RenderedTemplate {
  return {
    content: truncate(render(template.content, markdownVars), DISCORD_LIMITS.content),
    title: truncate(render(template.title, plainVars), DISCORD_LIMITS.title),
    description: truncate(render(template.description, markdownVars), DISCORD_LIMITS.description),
    footer: truncate(render(template.footer, plainVars), DISCORD_LIMITS.footer),
  };
}
