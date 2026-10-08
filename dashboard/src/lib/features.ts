/**
 * Helpers for the v2 optional features in the settings page (#1 notify role, #4 routing, #6 clips, #8 counter,
 * #9 applications, #10 silent, #11 linking, #14 manual posts, #15 presence, #16 language/timezone).
 * Pure functions (unit-tested): drafts, deep-partial diffs and client-side validation mirroring the server schema.
 */
import { normalizeFeatures } from '../../../src/db/features';
import type { ContentKind, GuildFeatures, GuildFeaturesPatch, Platform } from '../api/types';
import { t } from '../i18n/core';
import { isSnowflake } from './discord';

/** Same bounds as src/web/schemas.ts (featuresPatchSchema). */
export const FEATURE_LIMITS = {
  minViews: { min: 0, max: 100_000_000 },
  digestHour: { min: 0, max: 23 },
  digestMax: { min: 1, max: 20 },
  counterTemplate: 90,
  panelTitle: 256,
  panelDescription: 2000,
  channelName: 100,
} as const;

/** Common IANA timezones for the select (any valid IANA name typed by the server owner also works). */
export const COMMON_TIMEZONES = [
  'Asia/Riyadh',
  'Asia/Dubai',
  'Asia/Kuwait',
  'Asia/Qatar',
  'Asia/Bahrain',
  'Asia/Muscat',
  'Asia/Baghdad',
  'Asia/Amman',
  'Asia/Beirut',
  'Asia/Damascus',
  'Asia/Jerusalem',
  'Africa/Cairo',
  'Africa/Tripoli',
  'Africa/Tunis',
  'Africa/Algiers',
  'Africa/Casablanca',
  'Africa/Khartoum',
  'Europe/Istanbul',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Asia/Karachi',
  'Asia/Kolkata',
  'Asia/Tokyo',
  'UTC',
] as const;

export function isValidTimezone(tz: string): boolean {
  if (!tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

/** A complete, defaults-filled copy of the saved features (also tolerates `{}` from older servers). */
export function featuresDraft(saved: unknown): GuildFeatures {
  return structuredClone(normalizeFeatures(saved));
}

function sameRecord(a: Partial<Record<string, string>>, b: Partial<Record<string, string>>): boolean {
  const clean = (r: Partial<Record<string, string>>) =>
    Object.entries(r)
      .filter(([, v]) => typeof v === 'string' && v.trim() !== '')
      .map(([k, v]) => `${k}=${v!.trim()}`)
      .sort()
      .join('&');
  return clean(a) === clean(b);
}

/** Route map as sent to the server: blank entries dropped (= default channel). */
export function cleanRoutes<K extends string>(routes: Partial<Record<K, string>>): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const [key, value] of Object.entries(routes) as Array<[K, string | undefined]>) {
    const v = value?.trim();
    if (v) out[key] = v;
  }
  return out;
}

const normText = (v: string | null): string | null => (v !== null && v.trim() !== '' ? v.trim() : null);
const normId = (v: string | null): string | null => normText(v);

/**
 * Deep-partial patch with only the changed fields (each feature object is merged one level deep by the server, so
 * route maps are sent whole when they changed). Returns undefined when nothing changed.
 */
export function diffFeatures(savedRaw: unknown, draft: GuildFeatures): GuildFeaturesPatch | undefined {
  const saved = normalizeFeatures(savedRaw);
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(saved) as Array<keyof GuildFeatures>) {
    const before = saved[key];
    const after = draft[key];
    if (typeof before !== 'object' || before === null) {
      const next = typeof after === 'string' ? after.trim() : after;
      if (next !== before) patch[key] = next;
      continue;
    }
    const sub: Record<string, unknown> = {};
    for (const field of Object.keys(before)) {
      const b = (before as unknown as Record<string, unknown>)[field];
      const a = (after as unknown as Record<string, unknown>)[field];
      if (b !== null && typeof b === 'object') {
        const bRec = b as Partial<Record<string, string>>;
        const aRec = (a ?? {}) as Partial<Record<string, string>>;
        if (!sameRecord(bRec, aRec)) sub[field] = cleanRoutes(aRec);
        continue;
      }
      let next = a;
      if (field.endsWith('Id')) next = normId((a as string | null) ?? null);
      else if (field === 'panelTitle' || field === 'panelDescription') next = normText((a as string | null) ?? null);
      else if (field === 'template' && typeof a === 'string') next = a.trim();
      if (next !== b) sub[field] = next;
    }
    if (Object.keys(sub).length > 0) patch[key] = sub;
  }
  return Object.keys(patch).length > 0 ? (patch as GuildFeaturesPatch) : undefined;
}

/** Number of changed leaf fields in a features patch (for the save bar). */
export function countFeatureChanges(patch: GuildFeaturesPatch | undefined): number {
  if (!patch) return 0;
  let n = 0;
  for (const value of Object.values(patch)) n += value !== null && typeof value === 'object' ? Object.keys(value).length : 1;
  return n;
}

/** Channel name the counter will show for `count` (Discord trims names to 100 characters). */
export function counterPreview(template: string, count: number): string {
  const name = template.trim().replaceAll('{count}', String(Math.max(0, Math.trunc(count))));
  return [...name].slice(0, FEATURE_LIMITS.channelName).join('');
}

type Errors = Partial<Record<string, string>>;

function checkId(errors: Errors, key: string, value: string | null, guildId: string, role = false): void {
  const v = value?.trim();
  if (!v) return;
  if (!isSnowflake(v)) errors[key] = t('settings.err.snowflake');
  else if (role && v === guildId) errors[key] = t('settings.err.everyone');
}

function checkInt(errors: Errors, key: string, value: number, limit: { min: number; max: number }): void {
  if (!Number.isInteger(value) || value < limit.min || value > limit.max) errors[key] = t('settings.err.range', { min: limit.min, max: limit.max });
}

function checkLength(errors: Errors, key: string, value: string | null, max: number): void {
  if (value && [...value].length > max) errors[key] = t('features.err.tooLong', { max });
}

/**
 * Client-side checks mirroring the server; keys are "features.<feature>.<field>" (routes:
 * "features.routing.<map>.<key>") so they line up with the field ids in the settings page.
 */
export function validateFeatures(f: GuildFeatures, guildId: string, liveRoleIds: string[] = []): Errors {
  const errors: Errors = {};
  checkId(errors, 'features.notifyRole.roleId', f.notifyRole.roleId, guildId, true);
  const notifyRole = f.notifyRole.roleId?.trim();
  if (notifyRole && !errors['features.notifyRole.roleId'] && liveRoleIds.includes(notifyRole)) {
    errors['features.notifyRole.roleId'] = t('features.err.notifyRoleSame');
  }
  checkId(errors, 'features.notifyRole.panelChannelId', f.notifyRole.panelChannelId, guildId);
  checkLength(errors, 'features.notifyRole.panelTitle', f.notifyRole.panelTitle, FEATURE_LIMITS.panelTitle);
  checkLength(errors, 'features.notifyRole.panelDescription', f.notifyRole.panelDescription, FEATURE_LIMITS.panelDescription);

  for (const map of ['liveByPlatform', 'contentByPlatform', 'contentByKind'] as const) {
    for (const [key, id] of Object.entries(f.routing[map] as Record<string, string | undefined>)) {
      checkId(errors, `features.routing.${map}.${key}`, id ?? null, guildId);
    }
  }

  checkInt(errors, 'features.clips.minViews', f.clips.minViews, FEATURE_LIMITS.minViews);
  checkInt(errors, 'features.clips.digestHour', f.clips.digestHour, FEATURE_LIMITS.digestHour);
  checkInt(errors, 'features.clips.digestMax', f.clips.digestMax, FEATURE_LIMITS.digestMax);
  checkId(errors, 'features.clips.digestChannelId', f.clips.digestChannelId, guildId);

  checkId(errors, 'features.counter.channelId', f.counter.channelId, guildId);
  const template = f.counter.template.trim();
  if (!template) errors['features.counter.template'] = t('features.err.counterEmpty');
  else if ([...template].length > FEATURE_LIMITS.counterTemplate) errors['features.counter.template'] = t('features.err.tooLong', { max: FEATURE_LIMITS.counterTemplate });
  else if (!template.includes('{count}')) errors['features.counter.template'] = t('features.err.counterNoCount');

  checkId(errors, 'features.applications.panelChannelId', f.applications.panelChannelId, guildId);
  checkId(errors, 'features.applications.reviewChannelId', f.applications.reviewChannelId, guildId);
  checkLength(errors, 'features.applications.panelTitle', f.applications.panelTitle, FEATURE_LIMITS.panelTitle);
  checkLength(errors, 'features.applications.panelDescription', f.applications.panelDescription, FEATURE_LIMITS.panelDescription);

  if (!isValidTimezone(f.timezone)) errors['features.timezone'] = t('features.err.timezone');
  return errors;
}

/** Route map setter that removes the key when the value is blank (= "default channel"). */
export function setRoute<K extends Platform | ContentKind>(routes: Partial<Record<K, string>>, key: NoInfer<K>, value: string): Partial<Record<K, string>> {
  const next = { ...routes };
  if (value.trim()) next[key] = value.trim();
  else delete next[key];
  return next;
}

/** Local time "HH:00" for an hour of the day in the given language (western digits). */
export function formatHourOfDay(hour: number, lang: 'ar' | 'en'): string {
  const d = new Date(Date.UTC(2020, 0, 1, hour, 0, 0));
  try {
    return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-u-nu-latn' : 'en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(d);
  } catch {
    return `${String(hour).padStart(2, '0')}:00`;
  }
}
