/**
 * Guild settings update rules: merge a validated patch, enforce cross-field rules, check referenced
 * Discord roles/channels (best-effort) and describe what changed for the audit log.
 */
import type { AppContext } from '../app/context.js';
import { ValidationError } from '../core/errors.js';
import { childLogger } from '../core/logger.js';
import type { GuildOptions, GuildSettings, GuildSettingsPatch, TemplateSpec, Templates } from '../db/models.js';
import type { SettingsUpdateInput } from './schemas.js';

const log = childLogger('web.settings');

type TemplateKey = keyof Templates;
const TEMPLATE_KEYS: TemplateKey[] = ['live', 'summary', 'content'];

const ROLE_FIELDS = ['streamerRoleId', 'liveRoleId', 'pingRoleId'] as const;
const CHANNEL_FIELDS = ['liveChannelId', 'contentChannelId', 'logChannelId'] as const;
type RoleField = (typeof ROLE_FIELDS)[number];
type ChannelField = (typeof CHANNEL_FIELDS)[number];

export const SETTING_LABELS_AR: Record<string, string> = {
  streamerRoleId: 'رتبة الستريمر',
  liveRoleId: 'رتبة البث المباشر',
  liveChannelId: 'روم إشعارات البث',
  contentChannelId: 'روم إشعارات المقاطع',
  logChannelId: 'روم السجل',
  pingMode: 'المنشن',
  pingRoleId: 'رتبة المنشن',
  platformsEnabled: 'المنصات المفعّلة',
  contentKinds: 'أنواع المقاطع',
  templates: 'قوالب الرسائل',
  'options.reconnectMergeMinutes': 'مدة دمج البث',
  'options.liveUpdateMinutes': 'تحديث رسالة البث',
  'options.summaryEnabled': 'ملخص بعد البث',
  'options.contentMaxAgeHours': 'أقصى عمر للمقاطع',
  'options.skipVodOfAnnouncedLive': 'تجاهل إعادة البث المعلن',
  'options.autoStreamerRole': 'رتبة الستريمر التلقائية',
  'options.removeStreamerRoleOnDelete': 'سحب رتبة الستريمر عند الحذف',
};

function cleanSpec(spec: TemplateSpec): TemplateSpec | null {
  const out: TemplateSpec = {};
  if (spec.content) out.content = spec.content;
  if (spec.title) out.title = spec.title;
  if (spec.description) out.description = spec.description;
  if (spec.footer) out.footer = spec.footer;
  if (spec.color != null) out.color = spec.color;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Templates are merged per message type: a provided type replaces that type entirely, and an empty
 * spec ({} or only blank fields) resets it to the built-in default.
 */
export function mergeTemplates(current: Templates, patch: SettingsUpdateInput['templates']): Templates {
  if (!patch) return current;
  const next: Templates = { ...current };
  for (const key of TEMPLATE_KEYS) {
    const spec = patch[key];
    if (spec === undefined) continue;
    const cleaned = cleanSpec(spec);
    if (cleaned) next[key] = cleaned;
    else delete next[key];
  }
  return next;
}

/** Applies a validated patch to the current settings (no I/O). */
export function mergeSettings(current: GuildSettings, patch: SettingsUpdateInput): GuildSettings {
  const options: GuildOptions = { ...current.options };
  for (const [k, v] of Object.entries(patch.options ?? {})) {
    if (v !== undefined) (options as unknown as Record<string, unknown>)[k] = v;
  }
  return {
    ...current,
    streamerRoleId: patch.streamerRoleId !== undefined ? patch.streamerRoleId : current.streamerRoleId,
    liveRoleId: patch.liveRoleId !== undefined ? patch.liveRoleId : current.liveRoleId,
    liveChannelId: patch.liveChannelId !== undefined ? patch.liveChannelId : current.liveChannelId,
    contentChannelId: patch.contentChannelId !== undefined ? patch.contentChannelId : current.contentChannelId,
    logChannelId: patch.logChannelId !== undefined ? patch.logChannelId : current.logChannelId,
    pingMode: patch.pingMode ?? current.pingMode,
    pingRoleId: patch.pingRoleId !== undefined ? patch.pingRoleId : current.pingRoleId,
    platformsEnabled: patch.platformsEnabled ?? current.platformsEnabled,
    contentKinds: patch.contentKinds ?? current.contentKinds,
    templates: mergeTemplates(current.templates, patch.templates),
    options,
  };
}

/** Rules that span several fields. Throws ValidationError (Arabic) with the offending field. */
export function validateMergedSettings(guildId: string, next: GuildSettings): void {
  for (const field of ROLE_FIELDS) {
    if (next[field] === guildId) throw new ValidationError('ما ينفع تختار رتبة @everyone', field);
  }
  if (next.streamerRoleId && next.streamerRoleId === next.liveRoleId) {
    throw new ValidationError('رتبة الستريمر ورتبة البث المباشر لازم يكونون رتبتين مختلفتين', 'liveRoleId');
  }
  if (next.pingMode === 'role' && !next.pingRoleId) {
    throw new ValidationError('اختر الرتبة اللي ينمنشن مع الإشعار', 'pingRoleId');
  }
}

/** Fields whose value changed between two settings objects (dot paths for options). */
export function changedFields(before: GuildSettings, after: GuildSettings): string[] {
  const changed: string[] = [];
  const top = [...ROLE_FIELDS, ...CHANNEL_FIELDS, 'pingMode'] as const;
  for (const key of top) if (before[key] !== after[key]) changed.push(key);
  if (!sameSet(before.platformsEnabled, after.platformsEnabled)) changed.push('platformsEnabled');
  if (!sameSet(before.contentKinds, after.contentKinds)) changed.push('contentKinds');
  if (JSON.stringify(before.templates) !== JSON.stringify(after.templates)) changed.push('templates');
  for (const key of Object.keys(after.options) as Array<keyof GuildOptions>) {
    if (before.options[key] !== after.options[key]) changed.push(`options.${key}`);
  }
  return changed;
}

export function toPatch(next: GuildSettings): GuildSettingsPatch {
  return {
    streamerRoleId: next.streamerRoleId,
    liveRoleId: next.liveRoleId,
    liveChannelId: next.liveChannelId,
    contentChannelId: next.contentChannelId,
    logChannelId: next.logChannelId,
    pingMode: next.pingMode,
    pingRoleId: next.pingRoleId,
    platformsEnabled: next.platformsEnabled,
    contentKinds: next.contentKinds,
    templates: next.templates,
    options: next.options,
  };
}

/** Audit details: old/new values (templates only list which message types changed). */
export function describeChanges(before: GuildSettings, after: GuildSettings, fields: string[]): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const field of fields) {
    if (field === 'templates') {
      changes.templates = TEMPLATE_KEYS.filter((k) => JSON.stringify(before.templates[k]) !== JSON.stringify(after.templates[k]));
    } else if (field.startsWith('options.')) {
      const key = field.slice('options.'.length) as keyof GuildOptions;
      changes[field] = { from: before.options[key], to: after.options[key] };
    } else {
      const key = field as keyof GuildSettings;
      changes[field] = { from: before[key], to: after[key] };
    }
  }
  return changes;
}

function sameSet<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

/**
 * Checks newly set role/channel ids against the guild. Best-effort: when Discord is not ready or the
 * lookup fails, the snowflake format check already done by the schema has to be enough.
 */
export async function validateDiscordReferences(ctx: AppContext, guildId: string, before: GuildSettings, after: GuildSettings): Promise<void> {
  if (!ctx.discord.isReady()) return;
  const roleChanges = ROLE_FIELDS.filter((f): f is RoleField => !!after[f] && after[f] !== before[f]);
  const channelChanges = CHANNEL_FIELDS.filter((f): f is ChannelField => !!after[f] && after[f] !== before[f]);

  if (roleChanges.length > 0) {
    const roles = await ctx.discord.roles(guildId).catch((err: unknown) => {
      log.warn({ err, guildId }, 'Role lookup failed; skipping role validation');
      return null;
    });
    if (roles) {
      for (const field of roleChanges) {
        const role = roles.find((r) => r.id === after[field]);
        if (!role) throw new ValidationError('هذي الرتبة مو موجودة في السيرفر', field);
        if (role.managed && field !== 'pingRoleId') {
          throw new ValidationError(`الرتبة "${role.name}" تابعة لبوت أو تكامل، وديسكورد ما يسمح للبوت يعطيها لأحد`, field);
        }
      }
    }
  }

  if (channelChanges.length > 0) {
    const channels = await ctx.discord.textChannels(guildId).catch((err: unknown) => {
      log.warn({ err, guildId }, 'Channel lookup failed; skipping channel validation');
      return null;
    });
    if (channels) {
      for (const field of channelChanges) {
        if (!channels.some((c) => c.id === after[field])) {
          throw new ValidationError('هذا الروم مو موجود في السيرفر أو مو روم كتابي يقدر البوت يشوفه', field);
        }
      }
    }
  }
}
