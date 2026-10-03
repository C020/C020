/**
 * ContentService announces new uploads (videos, Shorts, VODs, highlights, clips) found by the monitor.
 *
 * - One notification per (content item, guild): when several streamers of the same guild share a channel,
 *   the first eligible one (lowest account id) gets the credit; other guilds are handled independently.
 * - Filters: per-account notifyContent, guild platform switch, content kinds (account override or guild
 *   default), max age, and "skip the VOD of a stream we already announced live" (matched by stream id,
 *   with a time-overlap fallback for providers that cannot link a VOD to its broadcast).
 * - Robustness: failed posts are retried with backoff, a burst limiter stops a misbehaving provider (or a
 *   clip storm) from flooding the channel, and nothing here ever throws to the monitor.
 */
import type { ContentServiceApi } from '../app/context.js';
import { errorMessage } from '../core/errors.js';
import type { AppEvents } from '../core/events.js';
import { childLogger } from '../core/logger.js';
import type { ContentItem } from '../core/types.js';
import { CONTENT_KIND_LABELS_AR, isContentKind, PLATFORM_LABELS } from '../core/types.js';
import type { Channel, ChannelSubscriber, GuildSettings, StoredContentItem } from '../db/models.js';
import type { Repositories } from '../db/repositories.js';
import type { AuditService } from './audit.js';
import type { ContentView, MessageRef, Notifier } from './ports.js';
import { iso, parseTime } from './views.js';

const log = childLogger('content');

export interface ContentServiceLimits {
  /** Sliding window of the per (guild, channel) burst limiter. */
  burstWindowMs: number;
  /** Max announcements per (guild, channel) inside the window; 0 disables the limiter. */
  burstMax: number;
  /** Delays between retries of a failed post (the number of entries is the number of retries). */
  retryDelaysMs: number[];
  /** Tolerance when matching a VOD to a live segment by time (no usable stream id). */
  vodMatchToleranceMs: number;
}

export const DEFAULT_CONTENT_LIMITS: ContentServiceLimits = {
  burstWindowMs: 10 * 60_000,
  burstMax: 8,
  retryDelaysMs: [60_000, 5 * 60_000],
  vodMatchToleranceMs: 15 * 60_000,
};

export interface ContentServiceDeps {
  repos: Repositories;
  audit: AuditService;
  events: AppEvents;
  notifier: Notifier;
  /** Injectable clock (ms since epoch) for deterministic tests. */
  clock?: () => number;
  limits?: Partial<ContentServiceLimits>;
}

export type ContentSkipReason = 'notify-off' | 'platform-disabled' | 'kind-filtered' | 'too-old' | 'vod-of-announced-live';

export class ContentService implements ContentServiceApi {
  private readonly repos: Repositories;
  private readonly audit: AuditService;
  private readonly events: AppEvents;
  private readonly notifier: Notifier;
  private readonly clock: () => number;
  private readonly limits: ContentServiceLimits;

  /** `${contentItemId}:${guildId}` currently being posted (guards concurrent duplicate deliveries). */
  private readonly inflight = new Set<string>();
  /** Recent announcement times per `${guildId}:${channelId}`. */
  private readonly bursts = new Map<string, number[]>();
  /** Burst keys already warned about in the current window. */
  private readonly burstWarned = new Map<string, number>();
  private readonly retryTimers = new Set<NodeJS.Timeout>();
  private stopped = false;

  constructor(deps: ContentServiceDeps) {
    this.repos = deps.repos;
    this.audit = deps.audit;
    this.events = deps.events;
    this.notifier = deps.notifier;
    this.clock = deps.clock ?? Date.now;
    this.limits = { ...DEFAULT_CONTENT_LIMITS, ...deps.limits };
  }

  /** Cancels pending retries (optional; retry timers are unref'd and never keep the process alive). */
  stop(): void {
    this.stopped = true;
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
  }

  async onNewContent(channel: Channel, item: ContentItem, stored: StoredContentItem): Promise<void> {
    try {
      if (!isContentKind(item.kind)) {
        log.warn({ channelId: channel.id, kind: item.kind }, 'Ignoring content with an unknown kind');
        return;
      }
      const byGuild = new Map<string, ChannelSubscriber[]>();
      for (const sub of this.repos.accounts.subscribersOf(channel.id)) {
        const list = byGuild.get(sub.guildId) ?? [];
        list.push(sub);
        byGuild.set(sub.guildId, list);
      }
      await Promise.all(
        [...byGuild].map(([guildId, subs]) =>
          this.announceInGuild(guildId, subs, channel, item, stored, 0).catch((err) =>
            log.error({ err, guildId, channelId: channel.id, contentId: item.contentId }, 'Content announcement failed'),
          ),
        ),
      );
    } catch (err) {
      log.error({ err, channelId: channel.id, contentId: item.contentId }, 'Content handling failed');
    }
  }

  /** Why a subscriber should not be notified about an item (null = notify). Exposed for diagnostics/tests. */
  skipReason(settings: GuildSettings, sub: ChannelSubscriber, channel: Channel, item: ContentItem): ContentSkipReason | null {
    if (!sub.account.notifyContent) return 'notify-off';
    if (!settings.platformsEnabled.includes(channel.platform)) return 'platform-disabled';
    const kinds = sub.account.contentKinds ?? settings.contentKinds;
    if (!kinds.includes(item.kind)) return 'kind-filtered';
    const maxAgeHours = Number(settings.options.contentMaxAgeHours);
    const published = parseTime(item.publishedAt);
    if (Number.isFinite(maxAgeHours) && maxAgeHours > 0 && published !== null && this.clock() - published > maxAgeHours * 3_600_000) {
      return 'too-old';
    }
    if (settings.options.skipVodOfAnnouncedLive && item.kind === 'vod' && this.isRecordingOfAnnouncedLive(sub.streamer.id, channel.id, item)) {
      return 'vod-of-announced-live';
    }
    return null;
  }

  // ───────────────────────────── delivery ─────────────────────────────

  private async announceInGuild(
    guildId: string,
    subs: ChannelSubscriber[],
    channel: Channel,
    item: ContentItem,
    stored: StoredContentItem,
    attempt: number,
  ): Promise<void> {
    const settings = this.repos.settings.get(guildId);
    const ordered = [...subs].sort((a, b) => a.account.id - b.account.id);
    for (const sub of ordered) {
      const reason = this.skipReason(settings, sub, channel, item);
      if (reason) {
        log.debug({ guildId, streamerId: sub.streamer.id, contentId: item.contentId, reason }, 'Content skipped');
        continue;
      }
      await this.deliver(settings, sub, channel, item, stored, attempt);
      return;
    }
  }

  private async deliver(
    settings: GuildSettings,
    sub: ChannelSubscriber,
    channel: Channel,
    item: ContentItem,
    stored: StoredContentItem,
    attempt: number,
  ): Promise<void> {
    const { guildId } = settings;
    const key = `${stored.id}:${guildId}`;
    if (this.inflight.has(key) || this.repos.content.wasNotified(stored.id, guildId)) return;
    if (!this.burstAllows(guildId, channel, sub)) return;

    this.inflight.add(key);
    try {
      const view: ContentView = {
        guildId,
        settings,
        streamer: sub.streamer,
        channel: {
          id: channel.id,
          platform: channel.platform,
          displayName: channel.displayName,
          handle: channel.handle,
          url: channel.url,
          avatarUrl: channel.avatarUrl,
        },
        item,
      };

      let ref: MessageRef | null = null;
      let failure: string | null = null;
      try {
        ref = await this.notifier.postContent(view);
      } catch (err) {
        failure = errorMessage(err);
      }

      if (!ref) {
        // Without a configured channel a null result is expected; otherwise it is a failed post.
        if (settings.contentChannelId) this.handleFailedPost(sub, channel, item, stored, attempt, failure);
        return;
      }

      this.repos.tx(() => {
        this.repos.content.recordNotification({
          contentItemId: stored.id,
          guildId,
          streamerId: sub.streamer.id,
          messageChannelId: ref.channelId,
          messageId: ref.messageId,
        });
        this.repos.content.markAnnounced(stored.id);
      });
      this.noteBurst(guildId, channel.id);

      this.audit.record({
        guildId,
        action: 'content.new',
        message: `${CONTENT_KIND_LABELS_AR[item.kind]} جديد من ${sub.streamer.displayName} على ${PLATFORM_LABELS[channel.platform]}: ${truncate(item.title, 150)}`,
        details: { streamerId: sub.streamer.id, channelId: channel.id, contentId: item.contentId, kind: item.kind, url: item.url },
        mirror: true,
      });
      this.events.emit('content.announced', {
        guildId,
        streamerId: sub.streamer.id,
        platform: channel.platform,
        title: item.title,
        url: item.url,
      });
    } finally {
      this.inflight.delete(key);
    }
  }

  private handleFailedPost(
    sub: ChannelSubscriber,
    channel: Channel,
    item: ContentItem,
    stored: StoredContentItem,
    attempt: number,
    failure: string | null,
  ): void {
    const delay = this.limits.retryDelaysMs[attempt];
    if (delay !== undefined && !this.stopped) {
      log.warn({ guildId: sub.guildId, contentId: item.contentId, attempt, failure }, 'Content post failed; retrying later');
      const timer = setTimeout(() => {
        this.retryTimers.delete(timer);
        void this.retry(sub.guildId, channel.id, item, stored, attempt + 1);
      }, delay);
      timer.unref();
      this.retryTimers.add(timer);
      return;
    }
    this.audit.record({
      guildId: sub.guildId,
      action: 'content.failed',
      level: 'warn',
      message: `ما قدرت أرسل إشعار ${CONTENT_KIND_LABELS_AR[item.kind]} ${sub.streamer.displayName} في روم المحتوى — تأكد من صلاحيات البوت في الروم`,
      details: { streamerId: sub.streamer.id, channelId: channel.id, contentId: item.contentId, failure },
    });
  }

  /** Re-runs the whole pipeline with fresh state (settings/accounts may have changed meanwhile). */
  private async retry(guildId: string, channelId: number, item: ContentItem, stored: StoredContentItem, attempt: number): Promise<void> {
    try {
      const channel = this.repos.channels.get(channelId);
      if (!channel) return;
      const subs = this.repos.accounts.subscribersOf(channelId).filter((s) => s.guildId === guildId);
      await this.announceInGuild(guildId, subs, channel, item, stored, attempt);
    } catch (err) {
      log.error({ err, guildId, channelId, contentId: item.contentId }, 'Content retry failed');
    }
  }

  // ───────────────────────────── burst limiter ─────────────────────────────

  private burstAllows(guildId: string, channel: Channel, sub: ChannelSubscriber): boolean {
    const { burstMax, burstWindowMs } = this.limits;
    if (burstMax <= 0) return true;
    const key = `${guildId}:${channel.id}`;
    const now = this.clock();
    const recent = (this.bursts.get(key) ?? []).filter((t) => now - t < burstWindowMs);
    this.bursts.set(key, recent);
    if (recent.length < burstMax) return true;

    const warnedAt = this.burstWarned.get(key);
    if (warnedAt === undefined || now - warnedAt >= burstWindowMs) {
      this.burstWarned.set(key, now);
      this.audit.record({
        guildId,
        action: 'content.throttled',
        level: 'warn',
        message: `وقفنا مؤقتاً إشعارات ${PLATFORM_LABELS[channel.platform]} لـ ${sub.streamer.displayName} لأنها كثيرة بوقت قصير (الحد ${burstMax} كل ${Math.round(burstWindowMs / 60_000)} دقائق)`,
        details: { streamerId: sub.streamer.id, channelId: channel.id },
      });
    }
    return false;
  }

  private noteBurst(guildId: string, channelId: number): void {
    if (this.limits.burstMax <= 0) return;
    const key = `${guildId}:${channelId}`;
    const list = this.bursts.get(key) ?? [];
    list.push(this.clock());
    this.bursts.set(key, list);
  }

  // ───────────────────────────── VOD ↔ live matching ─────────────────────────────

  /**
   * True when the VOD records a broadcast this streamer was announced live for on the same channel.
   * Matches the platform stream id first (stream ids are only unique per platform, hence the channel
   * filter); when that fails, falls back to "the recording started during an announced segment".
   */
  private isRecordingOfAnnouncedLive(streamerId: number, channelId: number, item: ContentItem): boolean {
    try {
      if (item.relatedStreamId) {
        const byStream = this.repos.db
          .prepare(
            `SELECT 1 FROM live_segments seg JOIN live_sessions s ON s.id = seg.session_id
             WHERE s.streamer_id = ? AND seg.channel_id = ? AND seg.stream_id = ? AND s.message_id IS NOT NULL LIMIT 1`,
          )
          .get(streamerId, channelId, item.relatedStreamId);
        if (byStream) return true;
      }
      const published = parseTime(item.publishedAt);
      if (published === null) return false;
      const tolerance = this.limits.vodMatchToleranceMs;
      const byTime = this.repos.db
        .prepare(
          `SELECT 1 FROM live_segments seg JOIN live_sessions s ON s.id = seg.session_id
           WHERE s.streamer_id = ? AND seg.channel_id = ? AND s.message_id IS NOT NULL
             AND seg.started_at <= ? AND COALESCE(seg.ended_at, ?) >= ? LIMIT 1`,
        )
        .get(streamerId, channelId, iso(published + tolerance), iso(this.clock()), iso(published - tolerance));
      return !!byTime;
    } catch (err) {
      log.warn({ err, streamerId, channelId }, 'VOD/live match query failed');
      return false;
    }
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
