/**
 * Optional per-guild features (stored as JSON in guild_settings.features). Pure data + helpers, safe to import
 * from browser code (the dashboard uses the same types and defaults).
 */
import type { ContentKind, Platform } from '../core/types.js';

export type Language = 'ar' | 'en';

/** #1 — opt-in notification role: members toggle it with a button and get pinged. */
export interface NotifyRoleFeature {
  /** Role handed out by the panel button (must be assignable and not elevated). null = feature off. */
  roleId: string | null;
  /** Mention the role on new live notifications. */
  pingOnLive: boolean;
  /** Mention the role on new content notifications. */
  pingOnContent: boolean;
  /** Channel where the toggle panel is posted. */
  panelChannelId: string | null;
  /** Optional custom panel text (defaults depend on the guild language). */
  panelTitle: string | null;
  panelDescription: string | null;
}

/** #4 — route notifications to different channels. Unset entries fall back to the default channels. */
export interface RoutingFeature {
  /** Live notification channel per platform (the primary platform at post time decides). */
  liveByPlatform: Partial<Record<Platform, string>>;
  /** Content channel per platform. */
  contentByPlatform: Partial<Record<Platform, string>>;
  /** Content channel per content kind (wins over contentByPlatform). */
  contentByKind: Partial<Record<ContentKind, string>>;
}

/** #6 — clip filters. */
export interface ClipsFeature {
  /** Only announce clips with at least this many views (re-checked while the clip is young). 0 = no minimum. */
  minViews: number;
  /** Only announce featured clips (platforms that report it, i.e. Twitch). */
  featuredOnly: boolean;
  /** 'each' = one message per clip, 'digest' = one daily summary message. */
  mode: 'each' | 'digest';
  /** Local hour (0-23, in `timezone`) when the daily digest is posted. */
  digestHour: number;
  /** Max clips listed in a digest. */
  digestMax: number;
  /** Digest channel; null = the routed content channel for clips. */
  digestChannelId: string | null;
}

/** #8 — a (voice) channel whose name shows how many streamers are live. */
export interface CounterFeature {
  channelId: string | null;
  /** Name template; {count} is replaced. Discord allows ~2 renames per 10 minutes per channel. */
  template: string;
}

/** #9 — streamer applications from a Discord button + modal, reviewed in the dashboard (or Discord). */
export interface ApplicationsFeature {
  enabled: boolean;
  /** Channel where the "apply" panel is posted. */
  panelChannelId: string | null;
  /** Channel where new applications are announced for reviewers (with approve/reject buttons). */
  reviewChannelId: string | null;
  /** Optional custom panel text. */
  panelTitle: string | null;
  panelDescription: string | null;
  /** DM the applicant when their application is approved/rejected. */
  dmApplicant: boolean;
}

/** #10 — send notifications without a notification sound/push (Discord "silent" messages). */
export interface SilentFeature {
  live: boolean;
  content: boolean;
}

/** #11 — optional official account linking (Twitch / TikTok OAuth) for streamers who want it. */
export interface LinkingFeature {
  enabled: boolean;
}

/** #14 — manual posting of a clip/VOD link (optional; automatic detection stays the default). */
export interface ManualPostsFeature {
  enabled: boolean;
}

/** #15 — Discord "Streaming" presence detection (needs the privileged Presence intent). */
export interface PresenceFeature {
  enabled: boolean;
  /** 'registered' = only registered streamers, 'everyone' = any member who shows a Streaming status. */
  scope: 'registered' | 'everyone';
  /** Also post a (simple) live notification for presence-only streams. */
  notify: boolean;
}

export interface GuildFeatures {
  notifyRole: NotifyRoleFeature;
  routing: RoutingFeature;
  clips: ClipsFeature;
  counter: CounterFeature;
  applications: ApplicationsFeature;
  silent: SilentFeature;
  linking: LinkingFeature;
  manualPosts: ManualPostsFeature;
  presence: PresenceFeature;
  /** #16 — language of the bot's Discord messages (default templates, labels, panels, replies). */
  language: Language;
  /** IANA timezone used for local times (clip digest hour). */
  timezone: string;
}

export const DEFAULT_GUILD_FEATURES: GuildFeatures = {
  notifyRole: { roleId: null, pingOnLive: true, pingOnContent: false, panelChannelId: null, panelTitle: null, panelDescription: null },
  routing: { liveByPlatform: {}, contentByPlatform: {}, contentByKind: {} },
  clips: { minViews: 0, featuredOnly: false, mode: 'each', digestHour: 21, digestMax: 10, digestChannelId: null },
  counter: { channelId: null, template: '🔴 يبثون الحين: {count}' },
  applications: { enabled: false, panelChannelId: null, reviewChannelId: null, panelTitle: null, panelDescription: null, dmApplicant: true },
  silent: { live: false, content: false },
  linking: { enabled: false },
  manualPosts: { enabled: false },
  presence: { enabled: false, scope: 'registered', notify: false },
  language: 'ar',
  timezone: 'Asia/Riyadh',
};

/** Deep-partial patch accepted by the settings API. */
export type GuildFeaturesPatch = {
  [K in keyof GuildFeatures]?: GuildFeatures[K] extends object ? Partial<GuildFeatures[K]> : GuildFeatures[K];
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Fills missing keys with defaults (stored JSON may predate newer fields). */
export function normalizeFeatures(raw: unknown): GuildFeatures {
  const src = isObject(raw) ? raw : {};
  const out = structuredClone(DEFAULT_GUILD_FEATURES) as unknown as Record<string, unknown>;
  for (const [key, def] of Object.entries(DEFAULT_GUILD_FEATURES)) {
    const value = src[key];
    if (value === undefined) continue;
    out[key] = isObject(def) && isObject(value) ? { ...(def as Record<string, unknown>), ...value } : value;
  }
  return out as unknown as GuildFeatures;
}

/** Applies a patch one level deep (each feature object is merged, scalar features replaced). */
export function mergeFeatures(current: GuildFeatures, patch: GuildFeaturesPatch | undefined): GuildFeatures {
  if (!patch) return current;
  const out = { ...current } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const cur = (current as unknown as Record<string, unknown>)[key];
    out[key] = isObject(cur) && isObject(value) ? { ...cur, ...value } : value;
  }
  return normalizeFeatures(out);
}
