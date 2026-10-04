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

export const updateStreamerSchema = z.object({
  displayName: z.preprocess(trimmed, z.string().min(1, 'اكتب اسم الستريمر').max(64)).optional(),
  notes: z.string().max(500).nullable().optional(),
  color: color.nullable().optional(),
  enabled: z.boolean().optional(),
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
export const previewSchema = z.object({ type: messageType, template: previewTemplateSpecSchema.optional() });
