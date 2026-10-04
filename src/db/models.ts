import type { ContentKind, LiveSnapshot, Platform } from '../core/types.js';
import { CONTENT_KINDS, PLATFORMS } from '../core/types.js';

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
  createdAt: string;
  updatedAt: string;
}

export type GuildSettingsPatch = Partial<Omit<GuildSettings, 'guildId' | 'createdAt' | 'updatedAt' | 'options'>> & {
  options?: Partial<GuildOptions>;
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
  color: number | null;
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
