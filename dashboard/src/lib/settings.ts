import type { ContentKind, GuildOptions, PingMode, Platform, SettingsDto, SettingsUpdate } from '../api/types';
import { isSnowflake } from './discord';
import { CONTENT_KINDS, PLATFORMS } from './platforms';

export const ID_FIELDS = ['streamerRoleId', 'liveRoleId', 'liveChannelId', 'contentChannelId', 'logChannelId', 'pingRoleId'] as const;
export type IdField = (typeof ID_FIELDS)[number];

/** Editable copy of the settings; IDs are strings where '' means "not set". */
export interface SettingsDraft {
  streamerRoleId: string;
  liveRoleId: string;
  liveChannelId: string;
  contentChannelId: string;
  logChannelId: string;
  pingMode: PingMode;
  pingRoleId: string;
  platformsEnabled: Platform[];
  contentKinds: ContentKind[];
  options: GuildOptions;
}

export function draftFromSettings(s: SettingsDto): SettingsDraft {
  return {
    streamerRoleId: s.streamerRoleId ?? '',
    liveRoleId: s.liveRoleId ?? '',
    liveChannelId: s.liveChannelId ?? '',
    contentChannelId: s.contentChannelId ?? '',
    logChannelId: s.logChannelId ?? '',
    pingMode: s.pingMode,
    pingRoleId: s.pingRoleId ?? '',
    platformsEnabled: PLATFORMS.filter((p) => s.platformsEnabled.includes(p)),
    contentKinds: CONTENT_KINDS.filter((k) => s.contentKinds.includes(k)),
    options: { ...s.options },
  };
}

function sameSet<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((v) => set.has(v));
}

const normalizeId = (value: string): string | null => {
  const v = value.trim();
  return v === '' ? null : v;
};

/** Only the fields that differ from the saved settings (so concurrent edits elsewhere are not clobbered). */
export function diffSettings(saved: SettingsDto, draft: SettingsDraft): SettingsUpdate {
  const update: SettingsUpdate = {};
  for (const field of ID_FIELDS) {
    const next = normalizeId(draft[field]);
    if (next !== saved[field]) update[field] = next;
  }
  if (draft.pingMode !== saved.pingMode) update.pingMode = draft.pingMode;
  if (!sameSet(draft.platformsEnabled, saved.platformsEnabled)) update.platformsEnabled = [...draft.platformsEnabled];
  if (!sameSet(draft.contentKinds, saved.contentKinds)) update.contentKinds = [...draft.contentKinds];

  const options: Partial<GuildOptions> = {};
  for (const key of Object.keys(draft.options) as Array<keyof GuildOptions>) {
    if (draft.options[key] !== saved.options[key]) (options as Record<string, unknown>)[key] = draft.options[key];
  }
  if (Object.keys(options).length > 0) update.options = options;
  return update;
}

export function hasChanges(update: SettingsUpdate): boolean {
  return Object.keys(update).length > 0;
}

export interface OptionLimit {
  min: number;
  max: number;
}

/** Same bounds as the server schema (src/web/schemas.ts guildOptionsPatchSchema). */
export const OPTION_LIMITS = {
  reconnectMergeMinutes: { min: 0, max: 180 },
  liveUpdateMinutes: { min: 0, max: 60 },
  contentMaxAgeHours: { min: 1, max: 720 },
} satisfies Record<string, OptionLimit>;

/** Client-side checks mirroring the server rules, so mistakes show up before saving. */
export function validateDraft(draft: SettingsDraft, guildId: string): Partial<Record<string, string>> {
  const errors: Partial<Record<string, string>> = {};
  for (const field of ID_FIELDS) {
    const value = draft[field].trim();
    if (value && !isSnowflake(value)) errors[field] = 'الآيدي لازم يكون رقم من 17 إلى 20 خانة';
    else if (value && value === guildId && field.endsWith('RoleId')) errors[field] = 'ما ينفع تختار رتبة @everyone';
  }
  if (!errors.liveRoleId && draft.streamerRoleId.trim() && draft.streamerRoleId.trim() === draft.liveRoleId.trim()) {
    errors.liveRoleId = 'رتبة الستريمر ورتبة البث لازم يكونون رتبتين مختلفتين';
  }
  if (draft.pingMode === 'role' && !draft.pingRoleId.trim()) errors.pingRoleId = 'اختر الرتبة اللي ينمنشن مع الإشعار';
  for (const [key, limit] of Object.entries(OPTION_LIMITS)) {
    const value = draft.options[key as keyof typeof OPTION_LIMITS];
    if (!Number.isInteger(value) || value < limit.min || value > limit.max) {
      errors[`options.${key}`] = `القيمة لازم تكون بين ${limit.min} و ${limit.max}`;
    }
  }
  return errors;
}
