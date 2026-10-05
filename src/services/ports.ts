/**
 * Ports = interfaces between the core logic (monitor + services) and the outside world
 * (Discord, web). Core code depends only on these, so it is testable without Discord.
 */
import type { ContentItem, LiveSnapshot, Platform } from '../core/types.js';
import type {
  AuditLevel,
  Channel,
  GuildSettings,
  StreamerApplication,
  LiveSegment,
  LiveSession,
  SessionCategory,
  StoredContentItem,
  Streamer,
} from '../db/models.js';

// ───────────────────────────── views rendered by the notifier ─────────────────────────────

/** One platform the streamer is currently live on (idea #1: combined notification). */
export interface LivePlatformView {
  platform: Platform;
  channel: Pick<Channel, 'id' | 'displayName' | 'handle' | 'url' | 'avatarUrl'>;
  snapshot: LiveSnapshot;
}

export interface LiveView {
  guildId: string;
  settings: GuildSettings;
  session: LiveSession;
  streamer: Streamer;
  /** Currently live platforms, sorted by viewers desc. platforms[0] is the "primary" one. */
  platforms: LivePlatformView[];
  /** Sum of current viewers across platforms (null when no platform reports viewers). */
  totalViewers: number | null;
}

/** Post-stream summary (idea #2). */
export interface SummaryView {
  guildId: string;
  settings: GuildSettings;
  session: LiveSession;
  streamer: Streamer;
  durationSec: number;
  peakViewers: number;
  avgViewers: number | null;
  categories: SessionCategory[];
  titles: string[];
  segments: Array<LiveSegment & { channel: Pick<Channel, 'id' | 'displayName' | 'handle' | 'url' | 'avatarUrl'> }>;
  /** Best available image for the summary (last live thumbnail or avatar). */
  imageUrl: string | null;
}

export interface ContentView {
  guildId: string;
  settings: GuildSettings;
  streamer: Streamer;
  channel: Pick<Channel, 'id' | 'platform' | 'displayName' | 'handle' | 'url' | 'avatarUrl'>;
  item: ContentItem | StoredContentItem;
}

export interface MessageRef {
  channelId: string;
  messageId: string;
}

/** #6 — daily clip digest for a guild. */
export interface DigestView {
  guildId: string;
  settings: GuildSettings;
  /** Clips, best first (by views), at most features.clips.digestMax. */
  entries: Array<{ streamer: Streamer | null; channel: Pick<Channel, 'id' | 'platform' | 'displayName' | 'handle' | 'url' | 'avatarUrl'>; item: StoredContentItem & { viewCount?: number | null } }>;
  /** Local date label of the digest (YYYY-MM-DD in the guild timezone). */
  date: string;
  /** Total clips queued (may exceed entries when capped). */
  total: number;
}

/** #15 — a stream detected only through the member's Discord "Streaming" presence. */
export interface PresenceLiveView {
  guildId: string;
  settings: GuildSettings;
  userId: string;
  /** Display name of the member (or registered streamer name). */
  displayName: string;
  avatarUrl: string | null;
  streamer: Streamer | null;
  url: string | null;
  platform: Platform | null;
  title: string | null;
  game: string | null;
  startedAt: string;
  endedAt: string | null;
}

/**
 * Outcome of editing an existing live message.
 * - ok:        edited (or nothing to change)
 * - gone:      the message/channel no longer exists (deleted, channel removed, wrong guild, not a text channel) → repost
 * - forbidden: the bot lost access to the channel (403/50001/50013); the message may still exist → keep the ref, retry later
 * - transient: network/5xx/timeout/client not ready → keep the ref, retry later
 */
export type EditOutcome = 'ok' | 'gone' | 'forbidden' | 'transient';

/**
 * Outcome of publishing a post-stream summary.
 * - done:      summary is visible (edited in place or posted) at `ref`
 * - skipped:   nothing to do (old message gone and summaries disabled / no channel configured)
 * - transient: Discord failed temporarily (or access is missing); the caller must retry later
 */
export type SummaryOutcome = { status: 'done'; ref: MessageRef } | { status: 'skipped' } | { status: 'transient'; reason: string };

/** Outcome of a single role change. 'transient' means it should be retried (REST error, Discord not ready). */
export type RoleChangeOutcome = 'applied' | 'noop' | 'transient' | 'config';

// ───────────────────────────── ports implemented by the Discord layer ─────────────────────────────

export interface Notifier {
  /** Post a new live notification. Returns null when no channel is configured or posting failed. */
  postLive(view: LiveView): Promise<MessageRef | null>;
  /**
   * Edit an existing live notification. Returns false when the message no longer exists
   * (deleted/unknown channel) so the caller can post a new one.
   */
  updateLive(ref: MessageRef, view: LiveView): Promise<EditOutcome>;
  /**
   * Turn the live notification into the post-stream summary (edit `ref` when given and still exists,
   * otherwise post a new message when summaries are enabled). Returns the final message ref.
   */
  postSummary(ref: MessageRef | null, view: SummaryView): Promise<SummaryOutcome>;
  /** Post a new-content notification. */
  postContent(view: ContentView): Promise<MessageRef | null>;
  /** #6 — post the daily clip digest. Returns null when nothing could be posted. */
  postDigest(view: DigestView): Promise<MessageRef | null>;
  /** #15 — simple live notification for a presence-only stream (no platform account tracked). */
  postPresenceLive(view: PresenceLiveView): Promise<MessageRef | null>;
  /** #15 — turn a presence notification into a short "ended" card. Returns false when the message is gone. */
  endPresenceLive(ref: MessageRef, view: PresenceLiveView): Promise<boolean>;
  /** Mirror an important event to the guild's log channel (no-op when not configured). */
  log(guildId: string, level: AuditLevel, message: string): Promise<void>;
}

export interface RoleManager {
  /** Add/remove the "Streaming Now" role. Must never throw (log + audit on failure). */
  setLive(guildId: string, userId: string, live: boolean, reason: string): Promise<RoleChangeOutcome>;
  /** Add/remove the "Streamer" role. Must never throw. */
  setStreamer(guildId: string, userId: string, isStreamer: boolean, reason: string): Promise<RoleChangeOutcome>;
  /**
   * Remove a specific role (e.g. the previous "Streaming Now" role after the admin changed it) from the given
   * members. Best effort, runs on the guild's role queue, never throws.
   */
  removeRoleFrom(guildId: string, roleId: string, userIds: string[], reason: string): Promise<void>;
  /**
   * Make roles match reality for a guild: live role only on members with an active session,
   * streamer role on every registered (enabled) streamer when autoStreamerRole is on.
   * Never strips roles from members the bot could not have given them to: the live role is only removed
   * from registered streamers (an admin picking an existing, widely held role must not wipe it from everyone).
   */
  reconcile(guildId: string, liveUserIds: Set<string>, streamerUserIds: Set<string>): Promise<{ added: number; removed: number }>;
}

export interface DiscordMemberInfo {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bot: boolean;
  roleIds: string[];
}

export interface DiscordRoleInfo {
  id: string;
  name: string;
  color: number;
  position: number;
  managed: boolean;
  /** True when the bot can assign it (below the bot's highest role and not managed/@everyone). */
  assignable: boolean;
  /** Role permission bitfield as a decimal string. */
  permissions: string;
  /**
   * True when the role grants moderation/admin power (Administrator, Manage Server/Roles/Channels/Messages/Webhooks,
   * Ban/Kick/Moderate Members, Mention Everyone). Such roles must not be used as the Streamer/Streaming Now role,
   * because the bot would hand them out automatically.
   */
  elevated: boolean;
}

export interface DiscordChannelInfo {
  id: string;
  name: string;
  type: 'text' | 'announcement';
  parentName: string | null;
  /** True when the bot can view, send messages and embed links there. */
  botCanPost: boolean;
}

export interface GuildDiagnostics {
  guildId: string;
  botInGuild: boolean;
  botHasManageRoles: boolean;
  problems: Array<{ code: string; message: string; level: 'warn' | 'error' }>;
}

export interface DiscordGuildInfo {
  id: string;
  name: string;
  iconUrl: string | null;
  memberCount: number;
}

/** Outcome of renaming a channel (#8 counter). Discord allows ~2 renames per 10 minutes per channel. */
export type RenameOutcome = 'ok' | 'unchanged' | 'rate_limited' | 'forbidden' | 'missing' | 'error';

/** Discord write actions used by the v2 services (implemented by the Discord layer). Never throw. */
export interface DiscordActions {
  /** #8 — rename a channel (voice/text). `retryAfterMs` is set when rate limited. */
  renameChannel(guildId: string, channelId: string, name: string): Promise<{ outcome: RenameOutcome; retryAfterMs?: number }>;
  /** Send a direct message (e.g. application decision). Returns false when DMs are closed or it failed. */
  sendDirectMessage(userId: string, message: { content: string; embedTitle?: string; embedDescription?: string; color?: number }): Promise<boolean>;
  /** #9 — post/refresh the reviewers' message for an application (with approve/reject buttons). Returns its ref or null. */
  upsertApplicationReview(application: StreamerApplication, settings: GuildSettings): Promise<MessageRef | null>;
  /**
   * #15 — members of a guild currently showing a Discord "Streaming" activity, or null when the Presence intent is
   * not available (then presence detection is inactive).
   */
  streamingPresences(guildId: string): Promise<Map<string, { url: string | null; platform: Platform | null; title: string | null; game: string | null }> | null>;
}

/** Read-only Discord lookups used by the web dashboard and the services. */
export interface DiscordGateway {
  isReady(): boolean;
  botUser(): { id: string; username: string; avatarUrl: string | null } | null;
  guilds(): DiscordGuildInfo[];
  guild(guildId: string): DiscordGuildInfo | null;
  fetchMember(guildId: string, userId: string): Promise<DiscordMemberInfo | null>;
  roles(guildId: string): Promise<DiscordRoleInfo[]>;
  textChannels(guildId: string): Promise<DiscordChannelInfo[]>;
  diagnose(guildId: string, settings: GuildSettings): Promise<GuildDiagnostics>;
}

// ───────────────────────────── handlers implemented by services, called by the monitor ─────────────────────────────

export interface LiveEventHandler {
  /** Channel went live (offline → live). */
  onChannelLive(channel: Channel, snapshot: LiveSnapshot): Promise<void>;
  /** Channel is still live; snapshot refreshed. streamChanged = platform stream id changed (reconnect). */
  onChannelUpdate(channel: Channel, snapshot: LiveSnapshot, info: { streamChanged: boolean }): Promise<void>;
  /** Channel confirmed offline (after grace). endedAt = when it was first seen offline. */
  onChannelOffline(channel: Channel, lastSnapshot: LiveSnapshot | null, endedAt: string): Promise<void>;
}

export interface ContentEventHandler {
  /** A content item never seen before (only after the channel's initial seeding). */
  onNewContent(channel: Channel, item: ContentItem, stored: StoredContentItem): Promise<void>;
  /**
   * #6 — an already stored item that has not been announced yet was seen again with fresh data (e.g. a young clip
   * whose view count grew past the guild's minimum). Called by the monitor for unannounced clips first seen within
   * the last 24h. Implementations must be idempotent (per-guild dedupe).
   */
  onContentUpdate?(channel: Channel, item: ContentItem, stored: StoredContentItem): Promise<void>;
}

/** What services need from the monitor (to react to dashboard changes). */
export interface MonitorControl {
  /** Tracked channel set changed (streamer/account added/removed/enabled). */
  channelsChanged(): void;
  /** Check one channel right away (live + content seeding when needed). */
  checkNow(channelId: number): void;
}
