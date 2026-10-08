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
 * - #4: the destination channel is resolved with the routing helpers; "no channel resolved" = not configured.
 * - #6: clip filters (minViews / featuredOnly). A clip that does not pass yet is "held" for that guild (kv marker)
 *   and re-evaluated by onContentUpdate while it is young (< 24h). In digest mode clips are queued instead of
 *   posted; a 5-minute scheduler posts each guild's digest once per local day at/after the configured hour.
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
import type { ContentView, DigestView, MessageRef, Notifier } from './ports.js';
import { resolveContentChannelId, resolveDigestChannelId } from './routing.js';
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
  /** #6 — how often the digest scheduler checks whether a guild's digest is due. */
  digestCheckMs: number;
  /** #6 — wait this long before retrying a digest that failed to post. */
  digestRetryMs: number;
  /** #6 — a held clip is re-evaluated only while it is younger than this (since first seen). */
  clipRecheckWindowMs: number;
}

export const DEFAULT_CONTENT_LIMITS: ContentServiceLimits = {
  burstWindowMs: 10 * 60_000,
  burstMax: 8,
  retryDelaysMs: [60_000, 5 * 60_000],
  vodMatchToleranceMs: 15 * 60_000,
  digestCheckMs: 5 * 60_000,
  digestRetryMs: 30 * 60_000,
  clipRecheckWindowMs: 24 * 3_600_000,
};

/** Discord allows at most 25 lines comfortably inside one embed description; keep digests readable. */
export const MAX_DIGEST_ENTRIES = 25;

const heldKey = (contentItemId: number): string => `content:held:${contentItemId}`;
const viewsKey = (contentItemId: number): string => `digest:views:${contentItemId}`;
export const digestLastKey = (guildId: string): string => `digest:last:${guildId}`;

interface HeldRecord {
  guilds: string[];
}

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

/** #6 — why a clip is held back for now (it may pass later while it is young). */
export type ClipHoldReason = 'below-min-views' | 'not-featured';

/** #6 — guild-level clip filters. null = the item may be announced now. */
export function clipHoldReason(settings: GuildSettings, item: Pick<ContentItem, 'kind' | 'viewCount' | 'featured'>): ClipHoldReason | null {
  if (item.kind !== 'clip') return null;
  const clips = settings.features.clips;
  if (clips.featuredOnly && typeof item.featured === 'boolean' && !item.featured) return 'not-featured';
  const min = Number(clips.minViews);
  if (Number.isFinite(min) && min > 0 && typeof item.viewCount === 'number' && item.viewCount < min) return 'below-min-views';
  return null;
}

/** Local date (YYYY-MM-DD) and hour (0-23) of `ms` in an IANA timezone (falls back to UTC on a bad zone). */
export function localDateHour(ms: number, timezone: string): { date: string; hour: number } {
  const fmt = (tz: string) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(
      new Date(ms),
    );
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = fmt(timezone || 'UTC');
  } catch {
    parts = fmt('UTC');
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const hour = Number(get('hour')) % 24;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number.isFinite(hour) ? hour : 0 };
}

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
  private digestTimer: NodeJS.Timeout | null = null;
  /** Guilds whose digest is being posted right now. */
  private readonly digestInflight = new Set<string>();
  /** Last failed digest attempt per guild (retry backoff). */
  private readonly digestFailedAt = new Map<string, number>();

  constructor(deps: ContentServiceDeps) {
    this.repos = deps.repos;
    this.audit = deps.audit;
    this.events = deps.events;
    this.notifier = deps.notifier;
    this.clock = deps.clock ?? Date.now;
    this.limits = { ...DEFAULT_CONTENT_LIMITS, ...deps.limits };
  }

  /** #6 — starts the digest scheduler (checks every few minutes; timers never keep the process alive). */
  start(): void {
    this.stopped = false;
    if (this.digestTimer) return;
    this.digestTimer = setInterval(() => void this.runDigestTick(), this.limits.digestCheckMs);
    this.digestTimer.unref();
  }

  /** Cancels pending retries and the digest scheduler. */
  stop(): void {
    this.stopped = true;
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
    if (this.digestTimer) clearInterval(this.digestTimer);
    this.digestTimer = null;
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

  /**
   * #6 — a stored, not yet announced item was seen again with fresh data. Only clips this service held back
   * (minViews / featuredOnly) are re-evaluated, per guild, while they are young; baseline items are never touched.
   */
  async onContentUpdate(channel: Channel, item: ContentItem, stored: StoredContentItem): Promise<void> {
    try {
      if (!isContentKind(item.kind)) return;
      this.refreshDigestViews(stored.id, item.viewCount);
      const held = this.readHeld(stored.id);
      if (!held) return;
      const firstSeen = parseTime(stored.firstSeenAt);
      if (firstSeen !== null && this.clock() - firstSeen > this.limits.clipRecheckWindowMs) {
        this.safeKv(() => this.repos.kv.delete(heldKey(stored.id)));
        return;
      }
      const subs = this.repos.accounts.subscribersOf(channel.id);
      await Promise.all(
        held.guilds.map((guildId) =>
          this.announceInGuild(
            guildId,
            subs.filter((s) => s.guildId === guildId),
            channel,
            item,
            stored,
            0,
          ).catch((err) => log.error({ err, guildId, channelId: channel.id, contentId: item.contentId }, 'Content re-evaluation failed')),
        ),
      );
    } catch (err) {
      log.error({ err, channelId: channel.id, contentId: item.contentId }, 'Content update handling failed');
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
      if (this.repos.content.wasNotified(stored.id, guildId)) {
        this.releaseHeld(stored.id, guildId);
        return;
      }
      const hold = clipHoldReason(settings, item);
      if (hold) {
        log.debug({ guildId, contentId: item.contentId, hold, views: item.viewCount }, 'Clip held back by the guild filters');
        this.markHeld(stored.id, guildId);
        return;
      }
      this.releaseHeld(stored.id, guildId);
      if (item.kind === 'clip' && settings.features.clips.mode === 'digest') {
        this.enqueueDigest(settings, sub, channel, item, stored);
        return;
      }
      await this.deliver(settings, sub, channel, item, stored, attempt);
      return;
    }
  }

  // ───────────────────────────── #6 held clips ─────────────────────────────

  private readHeld(contentItemId: number): HeldRecord | null {
    const raw = this.safeKv(() => this.repos.kv.get<unknown>(heldKey(contentItemId)));
    if (!raw || typeof raw !== 'object' || !Array.isArray((raw as HeldRecord).guilds)) return null;
    const guilds = (raw as HeldRecord).guilds.filter((g): g is string => typeof g === 'string');
    return guilds.length > 0 ? { guilds } : null;
  }

  private markHeld(contentItemId: number, guildId: string): void {
    const held = this.readHeld(contentItemId) ?? { guilds: [] };
    if (held.guilds.includes(guildId)) return;
    held.guilds.push(guildId);
    this.safeKv(() => this.repos.kv.set(heldKey(contentItemId), held));
  }

  private releaseHeld(contentItemId: number, guildId: string): void {
    const held = this.readHeld(contentItemId);
    if (!held || !held.guilds.includes(guildId)) return;
    const guilds = held.guilds.filter((g) => g !== guildId);
    this.safeKv(() => (guilds.length > 0 ? this.repos.kv.set(heldKey(contentItemId), { guilds }) : this.repos.kv.delete(heldKey(contentItemId))));
  }

  private safeKv<T>(fn: () => T): T | undefined {
    try {
      return fn();
    } catch (err) {
      log.warn({ err }, 'Content kv access failed');
      return undefined;
    }
  }

  // ───────────────────────────── #6 digest ─────────────────────────────

  private enqueueDigest(settings: GuildSettings, sub: ChannelSubscriber, channel: Channel, item: ContentItem, stored: StoredContentItem): void {
    try {
      const queued = this.repos.digest.enqueue(settings.guildId, stored.id, sub.streamer.id);
      this.refreshDigestViews(stored.id, item.viewCount, true);
      if (queued) log.debug({ guildId: settings.guildId, channelId: channel.id, contentId: item.contentId }, 'Clip queued for the daily digest');
    } catch (err) {
      log.error({ err, guildId: settings.guildId, contentId: item.contentId }, 'Queuing clip for the digest failed');
    }
  }

  /** Remembers the latest view count of a queued clip (stored items do not keep views). */
  private refreshDigestViews(contentItemId: number, viewCount: number | null, force = false): void {
    if (typeof viewCount !== 'number' || !Number.isFinite(viewCount)) {
      return;
    }
    const key = viewsKey(contentItemId);
    if (!force && this.safeKv(() => this.repos.kv.get<unknown>(key)) === undefined) return;
    this.safeKv(() => this.repos.kv.set(key, viewCount));
  }

  /** One scheduler pass: posts every due guild digest. Public for tests. Never throws. */
  async runDigestTick(): Promise<void> {
    let guilds: string[];
    try {
      guilds = this.repos.digest.guildsWithPending();
    } catch (err) {
      log.error({ err }, 'Reading the digest queue failed');
      return;
    }
    for (const guildId of guilds) {
      if (this.stopped) break;
      try {
        if (!this.digestDue(guildId)) continue;
        const ref = await this.postDigest(guildId, 'system');
        if (ref) this.safeKv(() => this.repos.kv.set(digestLastKey(guildId), localDateHour(this.clock(), this.timezoneOf(guildId)).date));
      } catch (err) {
        log.error({ err, guildId }, 'Digest tick failed');
      }
    }
  }

  async postDigestNow(guildId: string, actor: string): Promise<MessageRef | null> {
    return this.postDigest(guildId, actor);
  }

  private timezoneOf(guildId: string): string {
    return this.repos.settings.get(guildId).features.timezone;
  }

  private digestDue(guildId: string): boolean {
    const settings = this.repos.settings.get(guildId);
    const now = this.clock();
    const failedAt = this.digestFailedAt.get(guildId);
    if (failedAt !== undefined && now - failedAt < this.limits.digestRetryMs) return false;
    const { date, hour } = localDateHour(now, settings.features.timezone);
    const target = Math.min(23, Math.max(0, Math.trunc(Number(settings.features.clips.digestHour) || 0)));
    if (hour < target) return false;
    return this.safeKv(() => this.repos.kv.get<string>(digestLastKey(guildId))) !== date;
  }

  /** Builds and posts the guild's digest. Returns null when empty, not configured or posting failed. */
  private async postDigest(guildId: string, actor: string): Promise<MessageRef | null> {
    if (this.digestInflight.has(guildId)) return null;
    this.digestInflight.add(guildId);
    try {
      const settings = this.repos.settings.get(guildId);
      const pending = this.repos.digest.pending(guildId);
      if (pending.length === 0) return null;
      // Already announced elsewhere in this guild (e.g. mode switched) → drop from the queue.
      const fresh = pending.filter((p) => !this.repos.content.wasNotified(p.contentItemId, guildId));
      const entries: DigestView['entries'] = [];
      const unusable: number[] = pending.filter((p) => !fresh.includes(p)).map((p) => p.id);
      const scored = fresh.map((p) => ({ p, views: this.safeKv(() => this.repos.kv.get<number>(viewsKey(p.contentItemId))) }));
      scored.sort((a, b) => (typeof b.views === 'number' ? b.views : -1) - (typeof a.views === 'number' ? a.views : -1) || a.p.id - b.p.id);
      const max = Math.min(MAX_DIGEST_ENTRIES, Math.max(1, Math.trunc(Number(settings.features.clips.digestMax) || 10)));
      const included: typeof scored = [];
      for (const s of scored) {
        const channel = this.repos.channels.get(s.p.item.channelId);
        if (!channel) {
          unusable.push(s.p.id);
          continue;
        }
        if (included.length >= max) continue;
        included.push(s);
        entries.push({
          streamer: s.p.streamerId !== null ? this.repos.streamers.get(s.p.streamerId) : null,
          channel: { id: channel.id, platform: channel.platform, displayName: channel.displayName, handle: channel.handle, url: channel.url, avatarUrl: channel.avatarUrl },
          item: { ...s.p.item, viewCount: typeof s.views === 'number' ? s.views : null },
        });
      }
      if (entries.length === 0) {
        this.repos.digest.markPosted(unusable);
        return null;
      }
      if (!resolveDigestChannelId(settings)) {
        log.debug({ guildId }, 'Digest due but no digest/content channel is configured');
        return null;
      }
      const view: DigestView = { guildId, settings, entries, date: localDateHour(this.clock(), settings.features.timezone).date, total: fresh.length };
      let ref: MessageRef | null = null;
      let failure: string | null = null;
      try {
        ref = await this.notifier.postDigest(view);
      } catch (err) {
        failure = errorMessage(err);
      }
      if (!ref) {
        this.digestFailedAt.set(guildId, this.clock());
        this.audit.record({
          guildId,
          actor,
          action: 'content.digest.failed',
          level: 'warn',
          message:
            settings.features.language === 'en'
              ? "Couldn't post the daily clip digest — check the bot's permissions in the digest channel"
              : 'ما قدرت أرسل ملخص الكليبات اليومي — تأكد من صلاحيات البوت في روم الملخص',
          details: { failure, clips: entries.length },
        });
        return null;
      }
      this.digestFailedAt.delete(guildId);
      const postedRef = ref;
      this.repos.tx(() => {
        // Every queued entry is consumed (clips beyond digestMax are dropped, not carried to the next day).
        this.repos.digest.markPosted(pending.map((p) => p.id));
        for (const s of included) {
          this.repos.content.recordNotification({
            contentItemId: s.p.contentItemId,
            guildId,
            streamerId: s.p.streamerId,
            messageChannelId: postedRef.channelId,
            messageId: postedRef.messageId,
          });
          this.repos.content.markAnnounced(s.p.contentItemId);
        }
      });
      for (const p of pending) this.safeKv(() => this.repos.kv.delete(viewsKey(p.contentItemId)));
      this.audit.record({
        guildId,
        actor,
        action: 'content.digest',
        message:
          settings.features.language === 'en'
            ? `Posted the daily clip digest (${entries.length} of ${fresh.length} clips)`
            : `تم نشر ملخص الكليبات اليومي (${entries.length} من ${fresh.length} كليب)`,
        details: { clips: entries.length, total: fresh.length, channelId: postedRef.channelId, messageId: postedRef.messageId },
        mirror: true,
      });
      return postedRef;
    } catch (err) {
      log.error({ err, guildId }, 'Posting the clip digest failed');
      return null;
    } finally {
      this.digestInflight.delete(guildId);
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

      // #4 — kind route > platform route > default content channel; none = not configured (skip quietly).
      if (!resolveContentChannelId(settings, channel.platform, item.kind)) {
        log.debug({ guildId, contentId: item.contentId, kind: item.kind }, 'No content channel configured; skipping');
        return;
      }

      let ref: MessageRef | null = null;
      let failure: string | null = null;
      try {
        ref = await this.notifier.postContent(view);
      } catch (err) {
        failure = errorMessage(err);
      }

      if (!ref) {
        this.handleFailedPost(sub, channel, item, stored, attempt, failure);
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
