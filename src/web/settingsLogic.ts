/**
 * Guild settings update rules: merge a validated patch, enforce cross-field rules, check referenced
 * Discord roles/channels (best-effort) and describe what changed for the audit log.
 */
import type { AppContext } from '../app/context.js';
import { ValidationError } from '../core/errors.js';
import { childLogger } from '../core/logger.js';
import { mergeFeatures, type GuildFeatures, type GuildFeaturesPatch, type GuildOptions, type GuildSettings, type GuildSettingsPatch, type TemplateSpec, type Templates } from '../db/models.js';
import type { DiscordRoleInfo } from '../services/ports.js';
import type { SettingsUpdateInput } from './schemas.js';

const log = childLogger('web.settings');

type TemplateKey = keyof Templates;
const TEMPLATE_KEYS: TemplateKey[] = ['live', 'summary', 'content'];

const ROLE_FIELDS = ['streamerRoleId', 'liveRoleId', 'pingRoleId'] as const;
/** #1 — role members toggle with the panel button (the bot hands it out, so the same rules as assigned roles apply). */
export const NOTIFY_ROLE_FIELD = 'features.notifyRole.roleId';
/** Roles the bot hands out and takes away by itself: changing them needs Manage Roles (see routes/settings.ts). */
export const ASSIGNED_ROLE_FIELDS: ReadonlySet<string> = new Set(['streamerRoleId', 'liveRoleId', NOTIFY_ROLE_FIELD]);
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
  'features.notifyRole.roleId': 'رتبة الإشعارات',
  'features.notifyRole.pingOnLive': 'منشن رتبة الإشعارات مع البث',
  'features.notifyRole.pingOnContent': 'منشن رتبة الإشعارات مع المقاطع',
  'features.notifyRole.panelChannelId': 'روم لوحة الإشعارات',
  'features.notifyRole.panelTitle': 'عنوان لوحة الإشعارات',
  'features.notifyRole.panelDescription': 'وصف لوحة الإشعارات',
  'features.routing.liveByPlatform': 'توجيه إشعارات البث',
  'features.routing.contentByPlatform': 'توجيه المقاطع حسب المنصة',
  'features.routing.contentByKind': 'توجيه المقاطع حسب النوع',
  'features.clips.minViews': 'أقل مشاهدات للكليب',
  'features.clips.featuredOnly': 'الكليبات المميزة فقط',
  'features.clips.mode': 'طريقة نشر الكليبات',
  'features.clips.digestHour': 'ساعة ملخص الكليبات',
  'features.clips.digestMax': 'عدد كليبات الملخص',
  'features.clips.digestChannelId': 'روم ملخص الكليبات',
  'features.counter.channelId': 'روم العداد',
  'features.counter.template': 'اسم روم العداد',
  'features.applications.enabled': 'طلبات الستريمرز',
  'features.applications.panelChannelId': 'روم لوحة التقديم',
  'features.applications.reviewChannelId': 'روم مراجعة الطلبات',
  'features.applications.panelTitle': 'عنوان لوحة التقديم',
  'features.applications.panelDescription': 'وصف لوحة التقديم',
  'features.applications.dmApplicant': 'رسالة خاصة للمتقدم',
  'features.silent.live': 'إشعارات بث صامتة',
  'features.silent.content': 'إشعارات مقاطع صامتة',
  'features.linking.enabled': 'ربط الحسابات الرسمي',
  'features.manualPosts.enabled': 'النشر اليدوي',
  'features.presence.enabled': 'كشف حالة البث في ديسكورد',
  'features.presence.scope': 'نطاق كشف البث',
  'features.presence.notify': 'إشعار بث الحالة',
  'features.language': 'لغة البوت',
  'features.timezone': 'المنطقة الزمنية',
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
    features: mergeFeatures(current.features, patch.features as GuildFeaturesPatch | undefined),
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
  const notifyRoleId = next.features.notifyRole.roleId;
  if (notifyRoleId === guildId) throw new ValidationError('ما ينفع تختار رتبة @everyone', NOTIFY_ROLE_FIELD);
  if (notifyRoleId && (notifyRoleId === next.streamerRoleId || notifyRoleId === next.liveRoleId)) {
    throw new ValidationError('رتبة الإشعارات لازم تكون مختلفة عن رتبة الستريمر ورتبة البث المباشر', NOTIFY_ROLE_FIELD);
  }
}

/** Feature sub-keys compared one by one (dot paths "features.<feature>.<key>", or "features.<feature>" for scalars). */
function featureFields(before: GuildFeatures, after: GuildFeatures): string[] {
  const changed: string[] = [];
  for (const key of Object.keys(after) as Array<keyof GuildFeatures>) {
    const a = before[key] as unknown;
    const b = after[key] as unknown;
    if (typeof b === 'object' && b !== null && !Array.isArray(b)) {
      const prev = (typeof a === 'object' && a !== null ? a : {}) as Record<string, unknown>;
      for (const sub of Object.keys(b)) {
        if (JSON.stringify(prev[sub]) !== JSON.stringify((b as Record<string, unknown>)[sub])) changed.push(`features.${key}.${sub}`);
      }
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      changed.push(`features.${key}`);
    }
  }
  return changed;
}

/** Reads a "features.x.y" path from settings. */
export function featureValue(settings: GuildSettings, field: string): unknown {
  let cur: unknown = settings;
  for (const part of field.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Every channel id referenced by the features (with its field path), the counter channel excluded (it may be a voice channel). */
export function featureChannelRefs(f: GuildFeatures): Array<{ field: string; channelId: string }> {
  const refs: Array<{ field: string; channelId: string }> = [];
  const add = (field: string, id: string | null | undefined) => {
    if (id) refs.push({ field, channelId: id });
  };
  add('features.notifyRole.panelChannelId', f.notifyRole.panelChannelId);
  add('features.clips.digestChannelId', f.clips.digestChannelId);
  add('features.applications.panelChannelId', f.applications.panelChannelId);
  add('features.applications.reviewChannelId', f.applications.reviewChannelId);
  for (const group of ['liveByPlatform', 'contentByPlatform', 'contentByKind'] as const) {
    for (const [key, id] of Object.entries(f.routing[group] as Record<string, string | undefined>)) add(`features.routing.${group}.${key}`, id);
  }
  return refs;
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
  changed.push(...featureFields(before.features, after.features));
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
    features: next.features,
  };
}

/** Audit details: old/new values (templates only list which message types changed). */
export function describeChanges(before: GuildSettings, after: GuildSettings, fields: string[]): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const field of fields) {
    if (field === 'templates') {
      changes.templates = TEMPLATE_KEYS.filter((k) => JSON.stringify(before.templates[k]) !== JSON.stringify(after.templates[k]));
    } else if (field.startsWith('features.')) {
      changes[field] = { from: featureValue(before, field) ?? null, to: featureValue(after, field) ?? null };
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
        if (role.elevated && field !== 'pingRoleId') {
          throw new ValidationError(
            `الرتبة "${role.name}" فيها صلاحيات إدارية (مثل Administrator أو Manage Roles أو Ban Members)، والبوت يعطي ${SETTING_LABELS_AR[field]} ويشيلها تلقائياً، فأي ستريمر بياخذ هذي الصلاحيات. اختر رتبة بدون صلاحيات إدارية`,
            field,
          );
        }
      }
    }
  }

  const notifyRoleId = after.features.notifyRole.roleId;
  if (notifyRoleId && notifyRoleId !== before.features.notifyRole.roleId) {
    const roles = await ctx.discord.roles(guildId).catch((err: unknown) => {
      log.warn({ err, guildId }, 'Role lookup failed; skipping notification role validation');
      return null;
    });
    if (roles) checkNotifyRole(roles.find((r) => r.id === notifyRoleId));
  }

  const previous = new Map(featureChannelRefs(before.features).map((r) => [r.field, r.channelId]));
  const featureChannelChanges = featureChannelRefs(after.features).filter((r) => previous.get(r.field) !== r.channelId);

  if (channelChanges.length > 0 || featureChannelChanges.length > 0) {
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
      for (const { field, channelId } of featureChannelChanges) {
        if (!channels.some((c) => c.id === channelId)) {
          throw new ValidationError('هذا الروم مو موجود في السيرفر أو مو روم كتابي يقدر البوت يشوفه', field);
        }
      }
    }
  }
}

/** #1 — the notification role is handed out by the bot on a button click: it must be assignable and harmless. */
function checkNotifyRole(role: DiscordRoleInfo | undefined): void {
  if (!role) throw new ValidationError('هذي الرتبة مو موجودة في السيرفر', NOTIFY_ROLE_FIELD);
  if (role.managed) throw new ValidationError(`الرتبة "${role.name}" تابعة لبوت أو تكامل، وديسكورد ما يسمح للبوت يعطيها لأحد`, NOTIFY_ROLE_FIELD);
  if (role.elevated) {
    throw new ValidationError(
      `الرتبة "${role.name}" فيها صلاحيات إدارية (مثل Administrator أو Manage Roles أو Ban Members)، والبوت يعطي ${SETTING_LABELS_AR[NOTIFY_ROLE_FIELD]} لأي عضو يضغط الزر، فأي أحد بياخذ هذي الصلاحيات. اختر رتبة بدون صلاحيات إدارية`,
      NOTIFY_ROLE_FIELD,
    );
  }
  if (!role.assignable) {
    throw new ValidationError(`الرتبة "${role.name}" أعلى من رتبة البوت أو ما يقدر البوت يعطيها، انقل رتبة البوت فوقها`, NOTIFY_ROLE_FIELD);
  }
}
