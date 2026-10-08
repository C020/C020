/**
 * Request validation (zod). Shapes mirror src/shared/api.ts; business rules (duplicates, limits per
 * streamer...) stay in the services. Unknown keys are stripped rather than rejected so the dashboard
 * can send whole objects back without tripping validation.
 */
import { z, type ZodError, type ZodType } from 'zod';
import { ValidationError } from '../core/errors.js';
import { CONTENT_KINDS, PLATFORMS } from '../core/types.js';

const SNOWFLAKE_RE = /^\d{17,20}$/;
const SNOWFLAKE_MESSAGE = 'الآيدي غير صحيح، لازم يكون رقم من 17 إلى 20 خانة';

/** Arabic defaults for zod's built-in issues; schema-level messages always win. */
function arabicIssue(issue: { code: string; origin?: unknown; input?: unknown; maximum?: unknown; minimum?: unknown }): string {
  const max = Number(issue.maximum);
  const min = Number(issue.minimum);
  switch (issue.code) {
    case 'invalid_type':
      return issue.input === undefined ? 'هذا الحقل مطلوب' : 'نوع القيمة غير صحيح';
    case 'too_big':
      if (issue.origin === 'string') return `النص طويل، الحد ${max} حرف`;
      if (issue.origin === 'array' || issue.origin === 'set') return `الحد الأقصى ${max} عنصر`;
      return `القيمة لازم تكون ${max} أو أقل`;
    case 'too_small':
      if (issue.origin === 'string') return min <= 1 ? 'هذا الحقل مطلوب' : `النص قصير، أقل شي ${min} حرف`;
      if (issue.origin === 'array' || issue.origin === 'set') return `لازم تختار ${min} على الأقل`;
      return `القيمة لازم تكون ${min} أو أكثر`;
    case 'invalid_value':
      return 'القيمة غير مسموحة';
    case 'invalid_format':
      return 'الصيغة غير صحيحة';
    default:
      return 'قيمة غير صحيحة';
  }
}

export function zodToValidationError(error: ZodError): ValidationError {
  const issue = error.issues[0];
  if (!issue) return new ValidationError('البيانات غير صحيحة');
  const field = issue.path.map(String).join('.');
  return new ValidationError(issue.message, field || undefined);
}

/** Parses `data` or throws an Arabic ValidationError pointing at the first invalid field. */
export function parseInput<S extends ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data, { error: (issue) => arabicIssue(issue as Parameters<typeof arabicIssue>[0]) });
  if (!result.success) throw zodToValidationError(result.error);
  return result.data;
}

// ───────────────────────────── primitives ─────────────────────────────

const trimmed = (v: unknown): unknown => (typeof v === 'string' ? v.trim() : v);

export const snowflake = z.preprocess(trimmed, z.string().regex(SNOWFLAKE_RE, SNOWFLAKE_MESSAGE));

/** Snowflake or null; an empty string clears the value. */
export const nullableSnowflake = z.preprocess((v) => {
  const t = trimmed(v);
  return t === '' ? null : t;
}, z.string().regex(SNOWFLAKE_RE, SNOWFLAKE_MESSAGE).nullable());

export const platformSchema = z.enum(PLATFORMS, { error: 'المنصة غير معروفة' });
export const contentKindSchema = z.enum(CONTENT_KINDS, { error: 'نوع المقطع غير معروف' });

const uniqueList = <T extends string>(item: ZodType<T>, max: number) =>
  z
    .array(item)
    .max(max)
    .transform((list) => [...new Set(list)]);

const color = z.number().int('اللون لازم يكون رقم صحيح').min(0).max(0xffffff, 'اللون غير صحيح');

/** Optional text where a blank value means "not set" (use the default). */
const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((v) => (v.trim() !== '' ? v : undefined))
    .optional();

// ───────────────────────────── params / queries ─────────────────────────────

export const guildParams = z.object({ guildId: snowflake });
export const streamerParams = z.object({ guildId: snowflake, id: z.coerce.number().int().positive('رقم الستريمر غير صحيح') });
export const accountParams = streamerParams.extend({ accountId: z.coerce.number().int().positive('رقم الحساب غير صحيح') });
export const memberParams = z.object({ guildId: snowflake, userId: snowflake });

export const sessionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

export const contentQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) });

export const auditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  beforeId: z.coerce.number().int().positive().optional(),
  level: z.enum(['info', 'warn', 'error']).optional(),
});

export const leaderboardQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

// ───────────────────────────── settings ─────────────────────────────

export const templateSpecSchema = z.object({
  content: optionalText(2000),
  title: optionalText(256),
  description: optionalText(4096),
  footer: optionalText(2048),
  color: color.nullable().optional(),
});

export const templatesSchema = z.object({
  live: templateSpecSchema.optional(),
  summary: templateSpecSchema.optional(),
  content: templateSpecSchema.optional(),
});

export const guildOptionsPatchSchema = z.object({
  reconnectMergeMinutes: z.number().int().min(0).max(180).optional(),
  liveUpdateMinutes: z.number().int().min(0).max(60).optional(),
  summaryEnabled: z.boolean().optional(),
  contentMaxAgeHours: z.number().int().min(1).max(720).optional(),
  skipVodOfAnnouncedLive: z.boolean().optional(),
  autoStreamerRole: z.boolean().optional(),
  removeStreamerRoleOnDelete: z.boolean().optional(),
});

// ───────────────────────────── features (v2) ─────────────────────────────

/** Optional nullable text: blank → null (use the default text). */
const nullableText = (max: number) =>
  z
    .string()
    .max(max)
    .nullable()
    .transform((v) => (v !== null && v.trim() !== '' ? v.trim() : null));

/** Map of key → channel id; null/blank values remove the route (fall back to the default channel). */
const channelRoutes = <K extends string>(keys: readonly [K, ...K[]], keyError: string) =>
  z
    .record(z.string(), nullableSnowflake)
    .superRefine((value, ctx) => {
      for (const key of Object.keys(value)) {
        if (!(keys as readonly string[]).includes(key)) ctx.addIssue({ code: 'custom', message: keyError, path: [key] });
      }
    })
    .transform((value) => {
      const out: Partial<Record<K, string>> = {};
      for (const [key, id] of Object.entries(value)) if (id) out[key as K] = id;
      return out;
    });

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Discord channel names are at most 100 characters; {count} is replaced by a short number. */
export const COUNTER_TEMPLATE_MAX = 90;
export const DIGEST_MAX_CLIPS = 20;

export const featuresPatchSchema = z.object({
  notifyRole: z
    .object({
      roleId: nullableSnowflake.optional(),
      pingOnLive: z.boolean().optional(),
      pingOnContent: z.boolean().optional(),
      panelChannelId: nullableSnowflake.optional(),
      panelTitle: nullableText(256).optional(),
      panelDescription: nullableText(2000).optional(),
    })
    .optional(),
  routing: z
    .object({
      liveByPlatform: channelRoutes(PLATFORMS, 'المنصة غير معروفة').optional(),
      contentByPlatform: channelRoutes(PLATFORMS, 'المنصة غير معروفة').optional(),
      contentByKind: channelRoutes(CONTENT_KINDS, 'نوع المقطع غير معروف').optional(),
    })
    .optional(),
  clips: z
    .object({
      minViews: z.number().int().min(0).max(100_000_000).optional(),
      featuredOnly: z.boolean().optional(),
      mode: z.enum(['each', 'digest'], { error: 'نوع الكليبات غير معروف' }).optional(),
      digestHour: z.number().int().min(0).max(23).optional(),
      digestMax: z.number().int().min(1).max(DIGEST_MAX_CLIPS).optional(),
      digestChannelId: nullableSnowflake.optional(),
    })
    .optional(),
  counter: z
    .object({
      channelId: nullableSnowflake.optional(),
      template: z
        .preprocess(trimmed, z.string().min(1).max(COUNTER_TEMPLATE_MAX))
        .refine((v) => v.includes('{count}'), 'اسم روم العداد لازم يحتوي {count}')
        .optional(),
    })
    .optional(),
  applications: z
    .object({
      enabled: z.boolean().optional(),
      panelChannelId: nullableSnowflake.optional(),
      reviewChannelId: nullableSnowflake.optional(),
      panelTitle: nullableText(256).optional(),
      panelDescription: nullableText(2000).optional(),
      dmApplicant: z.boolean().optional(),
    })
    .optional(),
  silent: z.object({ live: z.boolean().optional(), content: z.boolean().optional() }).optional(),
  linking: z.object({ enabled: z.boolean().optional() }).optional(),
  manualPosts: z.object({ enabled: z.boolean().optional() }).optional(),
  presence: z
    .object({
      enabled: z.boolean().optional(),
      scope: z.enum(['registered', 'everyone'], { error: 'نطاق الكشف غير معروف' }).optional(),
      notify: z.boolean().optional(),
    })
    .optional(),
  language: z.enum(['ar', 'en'], { error: 'اللغة غير معروفة' }).optional(),
  timezone: z
    .preprocess(trimmed, z.string().min(1).max(64))
    .refine(isValidTimezone, 'المنطقة الزمنية غير صحيحة (مثال: Asia/Riyadh)')
    .optional(),
});
export type FeaturesPatchInput = z.output<typeof featuresPatchSchema>;

export const settingsUpdateSchema = z.object({
  streamerRoleId: nullableSnowflake.optional(),
  liveRoleId: nullableSnowflake.optional(),
  liveChannelId: nullableSnowflake.optional(),
  contentChannelId: nullableSnowflake.optional(),
  logChannelId: nullableSnowflake.optional(),
  pingMode: z.enum(['none', 'everyone', 'here', 'role'], { error: 'نوع المنشن غير معروف' }).optional(),
  pingRoleId: nullableSnowflake.optional(),
  platformsEnabled: uniqueList(platformSchema, PLATFORMS.length * 2).optional(),
  contentKinds: uniqueList(contentKindSchema, CONTENT_KINDS.length * 2).optional(),
  templates: templatesSchema.optional(),
  options: guildOptionsPatchSchema.optional(),
  features: featuresPatchSchema.optional(),
});
export type SettingsUpdateInput = z.output<typeof settingsUpdateSchema>;

// ───────────────────────────── streamers ─────────────────────────────

const accountFlags = {
  notifyLive: z.boolean().optional(),
  notifyContent: z.boolean().optional(),
  contentKinds: uniqueList(contentKindSchema, CONTENT_KINDS.length * 2)
    .nullable()
    .optional(),
};

export const accountInputSchema = z.object({
  platform: platformSchema,
  // The service sanitizes the handle/URL (invisible characters, length); this only bounds the payload.
  input: z.string().max(1000),
  ...accountFlags,
});

export const createStreamerSchema = z.object({
  discordUserId: snowflake,
  displayName: z.preprocess(trimmed, z.string().max(64).optional()).transform((v) => (v ? v : undefined)),
  notes: z.string().max(500).nullable().optional(),
  color: color.nullable().optional(),
  accounts: z.array(accountInputSchema).max(50).default([]),
});

/**
 * #5 — per-streamer overrides: an empty string is a real override ("render this part empty"), a missing field
 * inherits the guild template. Specs with no fields are dropped (= no override for that type).
 */
const streamerTemplateText = (max: number) => z.string().max(max).optional();
export const streamerTemplateSpecSchema = z.object({
  content: streamerTemplateText(2000),
  title: streamerTemplateText(256),
  description: streamerTemplateText(4096),
  footer: streamerTemplateText(2048),
  color: color.nullable().optional(),
});
export const streamerTemplatesSchema = z
  .object({
    live: streamerTemplateSpecSchema.optional(),
    summary: streamerTemplateSpecSchema.optional(),
    content: streamerTemplateSpecSchema.optional(),
  })
  .transform((t) => {
    const out: Partial<Record<'live' | 'summary' | 'content', z.output<typeof streamerTemplateSpecSchema>>> = {};
    for (const key of ['live', 'summary', 'content'] as const) {
      const spec = t[key];
      if (!spec) continue;
      const clean: z.output<typeof streamerTemplateSpecSchema> = {};
      for (const field of ['content', 'title', 'description', 'footer'] as const) if (spec[field] !== undefined) clean[field] = spec[field];
      if (spec.color != null) clean.color = spec.color;
      if (Object.keys(clean).length > 0) out[key] = clean;
    }
    return out;
  });

export const updateStreamerSchema = z.object({
  displayName: z.preprocess(trimmed, z.string().min(1, 'اكتب اسم الستريمر').max(64)).optional(),
  notes: z.string().max(500).nullable().optional(),
  color: color.nullable().optional(),
  enabled: z.boolean().optional(),
  templates: streamerTemplatesSchema.optional(),
});

export const updateAccountSchema = z.object(accountFlags);

export const resolveSchema = z.object({ platform: platformSchema, input: z.string().max(1000) });

// ───────────────────────────── tools ─────────────────────────────

const messageType = z.enum(['live', 'summary', 'content'], { error: 'نوع الرسالة غير معروف' });
export const testSchema = z.object({ type: messageType });

/**
 * Preview overrides are the editor's draft as-is: an empty string means "render this part empty" (e.g. message text
 * cleared), not "fall back to the saved template" as it does when saving.
 */
const previewText = (max: number) => z.string().max(max).optional();
export const previewTemplateSpecSchema = z.object({
  content: previewText(2000),
  title: previewText(256),
  description: previewText(4096),
  footer: previewText(2048),
  color: color.nullable().optional(),
});
export const previewSchema = z.object({
  type: messageType,
  template: previewTemplateSpecSchema.optional(),
  streamerId: z.number().int().positive('رقم الستريمر غير صحيح').optional(),
});

// ───────────────────────────── v2 routes ─────────────────────────────

export const linkPlatformParams = streamerParams.extend({ platform: z.enum(['twitch', 'tiktok'], { error: 'المنصة غير معروفة' }) });

export const applicationParams = z.object({ guildId: snowflake, id: z.coerce.number().int().positive('رقم الطلب غير صحيح') });
export const applicationsQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled'], { error: 'حالة الطلب غير معروفة' }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  beforeId: z.coerce.number().int().positive().optional(),
});
const reviewNote = z
  .string()
  .max(500)
  .nullable()
  .optional()
  .transform((v) => (v == null || v.trim() === '' ? null : v.trim()));
export const approveApplicationSchema = z.object({
  note: reviewNote,
  accounts: z.array(accountInputSchema).min(1).max(20).optional(),
});
export const rejectApplicationSchema = z.object({ note: reviewNote });

export const panelParams = z.object({ guildId: snowflake, kind: z.enum(['notify', 'apply'], { error: 'نوع اللوحة غير معروف' }) });

const httpUrl = z.preprocess(
  trimmed,
  z
    .string()
    .min(1)
    .max(2000)
    .refine((v) => {
      try {
        const u = new URL(v.includes('://') ? v : `https://${v}`);
        return u.protocol === 'https:' || u.protocol === 'http:';
      } catch {
        return false;
      }
    }, 'الرابط غير صحيح'),
);
const optionalHttpsUrl = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : trimmed(v)),
  z
    .string()
    .max(2000)
    .refine((v) => {
      try {
        return new URL(v).protocol === 'https:';
      } catch {
        return false;
      }
    }, 'الرابط غير صحيح')
    .nullable()
    .optional(),
);
export const manualInspectSchema = z.object({ url: httpUrl });
export const manualPostSchema = z.object({
  url: httpUrl,
  title: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : trimmed(v)), z.string().max(256).nullable().optional()),
  thumbnailUrl: optionalHttpsUrl,
  streamerId: z.number().int().positive('رقم الستريمر غير صحيح').nullable().optional(),
  kind: contentKindSchema.nullable().optional(),
});

export const sessionParams = z.object({ guildId: snowflake, sessionId: z.coerce.number().int().positive('رقم البث غير صحيح') });
export const STATS_DAYS = [7, 30, 90, 365] as const;
export const streamerStatsQuery = z.object({
  days: z.coerce
    .number()
    .refine((d) => (STATS_DAYS as readonly number[]).includes(d), 'المدة لازم تكون 7 أو 30 أو 90 أو 365 يوم')
    .default(30),
});
