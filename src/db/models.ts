import type { ContentKind, LiveSnapshot, Platform } from '../core/types.js';
import { CONTENT_KINDS, PLATFORMS } from '../core/types.js';
import { DEFAULT_GUILD_FEATURES, type GuildFeatures, type GuildFeaturesPatch } from './features.js';

export * from './features.js';

export type PingMode = 'none' | 'everyone' | 'here' | 'role';

/** Editable message template for one notification type. All fields support {variables}. */
export interface TemplateSpec {
  /** Plain message text above the embed (pings are added automatically from ping settings). */
  content?: string;
  title?: string;
  description?: string;
  footer?: string;
  /** Embed color as integer; null/undefined = platform color. */
  color?: number | null;
}

export interface Templates {
  live?: TemplateSpec;
  summary?: TemplateSpec;
  content?: TemplateSpec;
}

export interface GuildOptions {
  /** If the streamer goes live again within this window, reuse the same session + message. */
  reconnectMergeMinutes: number;
  /** Edit the live message with fresh viewers/title every N minutes (0 = never). */
  liveUpdateMinutes: number;
  /** Turn the live message into a post-stream summary when the stream ends. */
  summaryEnabled: boolean;
  /** Ignore content older than this (protects against old uploads being announced). */
  contentMaxAgeHours: number;
  /** Don't announce a VOD/replay for a stream that was already announced live. */
  skipVodOfAnnouncedLive: boolean;
  /** Give the Streamer role automatically to every registered streamer. */
  autoStreamerRole: boolean;
  /** Remove the Streamer role when the streamer is deleted from the dashboard. */
  removeStreamerRoleOnDelete: boolean;
}

export const DEFAULT_GUILD_OPTIONS: GuildOptions = {
  reconnectMergeMinutes: 10,
  liveUpdateMinutes: 5,
  summaryEnabled: true,
  contentMaxAgeHours: 48,
  skipVodOfAnnouncedLive: true,
  autoStreamerRole: true,
  removeStreamerRoleOnDelete: true,
};

export interface GuildSettings {
  guildId: string;
  streamerRoleId: string | null;
  liveRoleId: string | null;
  liveChannelId: string | null;
  contentChannelId: string | null;
  logChannelId: string | null;
  pingMode: PingMode;
  pingRoleId: string | null;
  platformsEnabled: Platform[];
  contentKinds: ContentKind[];
  templates: Templates;
  options: GuildOptions;
  /** Optional features (#1, #4, #6, #8–#11, #14–#16). */
  features: GuildFeatures;
  createdAt: string;
  updatedAt: string;
}

export type GuildSettingsPatch = Partial<Omit<GuildSettings, 'guildId' | 'createdAt' | 'updatedAt' | 'options' | 'features'>> & {
  options?: Partial<GuildOptions>;
  features?: GuildFeaturesPatch;
};

export function defaultGuildSettings(guildId: string, now: string): GuildSettings {
  return {
    guildId,
    streamerRoleId: null,
    liveRoleId: null,
    liveChannelId: null,
    contentChannelId: null,
    logChannelId: null,
    pingMode: 'none',
    pingRoleId: null,
    platformsEnabled: [...PLATFORMS],
    contentKinds: [...CONTENT_KINDS],
    templates: {},
    options: { ...DEFAULT_GUILD_OPTIONS },
    features: structuredClone(DEFAULT_GUILD_FEATURES),
    createdAt: now,
    updatedAt: now,
  };
}

export interface Streamer {
  id: number;
  guildId: string;
  discordUserId: string;
  displayName: string;
  notes: string | null;
  /** Embed color for this streamer's notifications (overrides the platform color, not a template color). */
  color: number | null;
  /** #5 — per-streamer message template overrides (field by field over the guild templates). */
  templates: Templates;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Channel {
  id: number;
  platform: Platform;
  platformId: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  url: string;
  meta: Record<string, unknown>;
  isLive: boolean;
  liveSnapshot: LiveSnapshot | null;
  liveSince: string | null;
  offlineSince: string | null;
  missCount: number;
  lastLiveCheckAt: string | null;
  contentSeeded: boolean;
  lastContentCheckAt: string | null;
  lastError: string | null;
  errorCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface StreamerAccount {
  id: number;
  streamerId: number;
  channelId: number;
  notifyLive: boolean;
  notifyContent: boolean;
  /** null = inherit guild setting */
  contentKinds: ContentKind[] | null;
  createdAt: string;
}

/** Account joined with its channel (what most callers want). */
export interface AccountWithChannel extends StreamerAccount {
  channel: Channel;
}

export interface StreamerWithAccounts extends Streamer {
  accounts: AccountWithChannel[];
}

/** Link from a channel back to every (guild, streamer, account) that tracks it. */
export interface ChannelSubscriber {
  guildId: string;
  streamer: Streamer;
  account: StreamerAccount;
}

export interface SessionCategory {
  name: string;
  imageUrl: string | null;
  firstSeenAt: string;
  /** Approximate seconds spent in this category (accumulated on updates). */
  seconds: number;
}

export interface LiveSession {
  id: number;
  guildId: string;
  streamerId: number;
  status: 'live' | 'ended';
  startedAt: string;
  endedAt: string | null;
  messageChannelId: string | null;
  messageId: string | null;
  peakViewers: number;
  viewerSum: number;
  viewerSamples: number;
  categories: SessionCategory[];
  titles: string[];
  lastMessageUpdate: string | null;
  /** True while the post-stream summary still has to be published (retried until it succeeds). */
  summaryPending: boolean;
  /** Failed summary publication attempts (drives the retry backoff). */
  summaryAttempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface LiveSegment {
  id: number;
  sessionId: number;
  channelId: number;
  platform: Platform;
  streamId: string | null;
  startedAt: string;
  endedAt: string | null;
  peakViewers: number;
  lastViewers: number | null;
  vodUrl: string | null;
}

export interface StoredContentItem {
  id: number;
  channelId: number;
  contentId: string;
  kind: ContentKind;
  title: string;
  url: string;
  thumbnailUrl: string | null;
  publishedAt: string;
  firstSeenAt: string;
  announced: boolean;
}

export type AuditLevel = 'info' | 'warn' | 'error';

export interface AuditEntry {
  id: number;
  guildId: string | null;
  actor: string;
  action: string;
  level: AuditLevel;
  message: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface WebSessionGuild {
  id: string;
  name: string;
  icon: string | null;
  /** Permission bitfield as decimal string (from Discord). */
  permissions: string;
  owner: boolean;
}

export interface WebSession {
  id: string;
  userId: string;
  username: string;
  avatarUrl: string | null;
  guilds: WebSessionGuild[];
  guildsRefreshedAt: string;
  accessToken: string | null;
  createdAt: string;
  expiresAt: string;
}

// ───────────── v2 features ─────────────

/** #13 — viewer sample of a live session (one per minute at most). */
export interface LiveSample {
  id: number;
  sessionId: number;
  at: string;
  /** Sum over live platforms; null when no platform reported viewers. */
  totalViewers: number | null;
  /** Viewers per live platform at that moment (null = hidden/unknown). */
  platforms: Partial<Record<Platform, number | null>>;
  /** Primary platform category at that moment. */
  category: string | null;
}

export type ApplicationStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

/** #9 — a member's request to be registered as a streamer. */
export interface StreamerApplication {
  id: number;
  guildId: string;
  userId: string;
  username: string;
  /** Raw inputs the member typed per platform. */
  accounts: Array<{ platform: Platform; input: string }>;
  note: string | null;
  status: ApplicationStatus;
  reviewerId: string | null;
  reviewNote: string | null;
  /** Streamer created when approved. */
  streamerId: number | null;
  /** Review message in the reviewers' channel (so it can be edited after a decision). */
  reviewChannelId: string | null;
  reviewMessageId: string | null;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
}

export type LinkPlatform = 'twitch' | 'tiktok';

/** #11 — an official OAuth link between a Discord user and a platform account. */
export interface AccountLink {
  id: number;
  discordUserId: string;
  platform: LinkPlatform;
  platformUserId: string;
  /** Login / username on the platform (TikTok: unique handle when the profile scope was granted). */
  platformLogin: string | null;
  displayName: string | null;
  /** Encrypted tokens (TikTok keeps them to read the video list officially; Twitch discards them). */
  accessTokenEnc: string | null;
  refreshTokenEnc: string | null;
  scopes: string[];
  accessExpiresAt: string | null;
  refreshExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PanelKind = 'notify' | 'apply';

/** Message with interactive buttons posted by the bot (notification-role toggle, apply button). */
export interface PanelMessage {
  guildId: string;
  kind: PanelKind;
  channelId: string;
  messageId: string;
  updatedAt: string;
}

/** #15 — a live role given because of a Discord "Streaming" presence (removed when the presence ends). */
export interface PresenceGrant {
  guildId: string;
  userId: string;
  startedAt: string;
  url: string | null;
  platform: Platform | null;
  title: string | null;
  game: string | null;
  /** Presence-only live notification, when `presence.notify` is on. */
  messageChannelId: string | null;
  messageId: string | null;
}

/** #6 — clip waiting for the guild's daily digest. */
export interface DigestEntry {
  id: number;
  guildId: string;
  contentItemId: number;
  streamerId: number | null;
  queuedAt: string;
  postedAt: string | null;
}
