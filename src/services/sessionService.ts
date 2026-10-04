/**
 * SessionService turns per-channel live events from the monitor into ONE aggregated live session per
 * (guild, streamer): a single combined Discord message across platforms, the "Streaming Now" role,
 * viewer/category statistics and the post-stream summary.
 *
 * Design notes
 * - Concurrency: every read-modify-write of a streamer's session runs under a per-streamer mutex, so two
 *   platforms going live in the same instant can never create two sessions or two messages.
 * - Average viewers are time-weighted: `viewerSum` holds viewer-seconds and `viewerSamples` holds observed
 *   seconds, so `avg = viewerSum / viewerSamples` stays correct however often (or irregularly) channels are
 *   polled or pushed by webhooks.
 * - Category time is accumulated into the category that was active on the primary platform during each
 *   elapsed interval (the 60s tick keeps intervals short even when a provider is slow).
 * - Duration is the union of the per-platform segments, so a reconnect gap inside the merge window is not
 *   counted as streamed time.
 * - Message edits are throttled: significant changes (platform joined/left, title, category) are applied at
 *   most once per `minEditIntervalMs`; viewer-only refreshes follow `options.liveUpdateMinutes`.
 * - Every handler is failure-isolated per subscriber and never throws to the monitor.
 * - Discord failures heal: a summary that could not be published stays `summaryPending` in the DB and is
 *   retried with backoff (and after a restart); a live edit that failed transiently or lost access is retried
 *   without reposting (only a message that is really gone is reposted); a live-role change that failed
 *   transiently is retried with backoff, and guilds with active or recently ended sessions get a periodic role
 *   reconcile (also right after the Discord gateway reconnects).
 */
import type { ProviderRegistryApi, SessionServiceApi } from '../app/context.js';
import { errorMessage } from '../core/errors.js';
import type { AppEvents } from '../core/events.js';
import { childLogger } from '../core/logger.js';
import type { ChannelRef, LiveSnapshot } from '../core/types.js';
import { offlineSnapshot, PLATFORM_LABELS } from '../core/types.js';
import type { Channel, ChannelSubscriber, GuildSettings, LiveSegment, LiveSession, Streamer, StreamerAccount } from '../db/models.js';
import type { Repositories } from '../db/repositories.js';
import type { AuditService } from './audit.js';
import type { EditOutcome, LivePlatformView, LiveView, MessageRef, Notifier, RoleChangeOutcome, RoleManager, SummaryOutcome, SummaryView } from './ports.js';
import {
  buildSummaryView,
  categoryKey,
  channelInfo,
  clamp,
  formatDurationAr,
  iso,
  liveSignature,
  messageRefOf,
  normalizeText,
  parseTime,
  platformListAr,
  primaryCategory,
  sanitizeViewers,
  sortLivePlatforms,
  sumViewers,
} from './views.js';

const log = childLogger('sessions');

export interface SessionServiceTiming {
  /** Periodic tick: throttled edits, category/viewer accounting, segment repair. */
  tickMs: number;
  /** Minimum spacing between two edits of the same live message caused by significant changes. */
  minEditIntervalMs: number;
  /** Per-provider timeout for the VOD lookup done when a session ends. */
  vodLookupTimeoutMs: number;
  /** Delays (after the end) of extra VOD lookups for platforms that publish recordings late (Kick). */
  vodRetryDelaysMs: number[];
  /** Intervals longer than this (process suspended / restarted) are capped when accounting time. */
  maxSampleGapMs: number;
  /**
   * The tick closes an open segment when, for this long, the monitor neither sent a live event for the
   * channel nor recorded a fresh live check in the DB (provider removed, missed offline event...).
   * Longer than the monitor's own STALE_LIVE_MINUTES so the monitor normally decides first.
   */
  orphanSegmentMs: number;
  /** Backoff between retries of a summary that failed transiently, by failure count (the last delay repeats). */
  summaryRetryDelaysMs: number[];
  /** Failed summary attempts after which the bot gives up (with an audit warning); ~24h with the defaults. */
  summaryMaxAttempts: number;
  /** Periodic live-role reconcile of guilds with active or recently ended sessions. */
  roleReconcileMs: number;
  /** Backoff of the guild role reconcile scheduled after a transient role change failure (the last delay repeats). */
  roleRetryDelaysMs: number[];
}

export const DEFAULT_SESSION_TIMING: SessionServiceTiming = {
  tickMs: 60_000,
  minEditIntervalMs: 30_000,
  vodLookupTimeoutMs: 8_000,
  vodRetryDelaysMs: [4 * 60_000, 15 * 60_000],
  maxSampleGapMs: 10 * 60_000,
  orphanSegmentMs: 45 * 60_000,
  summaryRetryDelaysMs: [1, 5, 15, 30, 60].map((m) => m * 60_000),
  summaryMaxAttempts: 28,
  roleReconcileMs: 10 * 60_000,
  roleRetryDelaysMs: [1, 2, 5, 10].map((m) => m * 60_000),
};

export interface SessionServiceDeps {
  repos: Repositories;
  audit: AuditService;
  events: AppEvents;
  notifier: Notifier;
  roles: RoleManager;
  providers: ProviderRegistryApi;
  /** Injectable clock (ms since epoch) for deterministic tests. */
  clock?: () => number;
  timing?: Partial<SessionServiceTiming>;
}

/** Platform-reported start times older than this are not trusted. */
const MAX_STREAM_AGE_MS = 48 * 3_600_000;
/** An ended session is resumed regardless of the merge window when the very same broadcast comes back. */
const SAME_BROADCAST_RESUME_MS = 6 * 3_600_000;
const MAX_TITLES = 20;
const MAX_CATEGORIES = 30;
/** Pending summaries looked at per tick (oldest first). */
const SUMMARY_SCAN_LIMIT = 200;
/** A guild stays in the periodic role reconcile this long after one of its sessions ended. */
const RECENT_ROLE_GUILD_MS = 30 * 60_000;
/** A guild whose role reconcile keeps failing (bot offline / not in the guild) is given up after this long. */
const ROLE_REPAIR_MAX_AGE_MS = 24 * 3_600_000;

interface RetryState {
  dueAt: number;
  attempt: number;
  /** First failure (ms): retries stop after ROLE_REPAIR_MAX_AGE_MS. */
  since: number;
}

/** Serializes async work per key (FIFO). Different keys run concurrently. */
export class KeyedMutex<K> {
  private readonly tails = new Map<K, Promise<void>>();

  async run<T>(key: K, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

/** In-memory accounting state of a live session (rebuilt lazily after a restart). */
interface SessionRuntime {
  /** Last viewer sample: the total is integrated over time until the next sample. */
  sample: { at: number; total: number | null } | null;
  /** Category active on the primary platform since `at`. */
  category: { key: string | null; at: number } | null;
  /** Signature of what the live message currently shows. */
  renderedSignature: string | null;
  /** A significant change is waiting for the edit throttle. */
  dirty: boolean;
  flushTimer: NodeJS.Timeout | null;
  lastPostAttempt: number;
  lastThumbnail: string | null;
}

type Lifecycle = 'existing' | 'created' | 'resumed';
type DetachReason = 'offline' | 'disabled';

interface Scope {
  guildId: string;
  streamer: Streamer;
  settings: GuildSettings;
}

/** Arabic suffix explaining why a session ended when it was not a normal "went offline". */
const END_REASON_NOTE: Record<string, string> = {
  disabled: ' (تم إيقاف الستريمر)',
  'streamer-disabled': ' (تم إيقاف الستريمر)',
  deleted: ' (تم حذف الستريمر)',
  'account-removed': ' (تم حذف حساب البث)',
  'live-notify-off': ' (تم إيقاف إشعارات البث لهذا الحساب)',
  stale: ' (أنهيناها تلقائياً لأن القنوات صارت أوفلاين)',
  'no-live-platforms': ' (أنهيناها تلقائياً لأن ما بقى منصة شغالة)',
};

export class SessionService implements SessionServiceApi {
  private readonly repos: Repositories;
  private readonly audit: AuditService;
  private readonly events: AppEvents;
  private readonly notifier: Notifier;
  private readonly roles: RoleManager;
  private readonly providers: ProviderRegistryApi;
  private readonly clock: () => number;
  private readonly timing: SessionServiceTiming;

  private readonly lock = new KeyedMutex<number>();
  private readonly runtimes = new Map<number, SessionRuntime>();
  /** Freshest live snapshot per channel as received from the monitor. */
  private readonly snapshots = new Map<number, LiveSnapshot>();
  /** When the monitor last reported each channel live (onChannelLive/onChannelUpdate). */
  private readonly lastLiveEventAt = new Map<number, number>();
  private readonly vodRetries = new Map<number, NodeJS.Timeout>();
  /** When the next attempt of each pending summary is due (ms); unknown (e.g. after a restart) = due now. */
  private readonly summaryRetryAt = new Map<number, number>();
  /** Last live thumbnail of ended sessions whose summary is still pending (their runtime is gone). */
  private readonly summaryThumbnails = new Map<number, string | null>();
  /** Live-role changes that failed transiently, by `guildId:userId`; retried with backoff (desired state re-read from the DB). */
  private readonly liveRoleRetries = new Map<string, RetryState & { guildId: string; userId: string; streamerId: number }>();
  /** Guilds whose role reconcile failed (Discord not ready, bot not in the guild), with backoff state. */
  private readonly roleRepairs = new Map<string, RetryState>();
  /** Guilds where a session ended recently (ms): part of the periodic role reconcile. */
  private readonly recentRoleGuilds = new Map<string, number>();
  private lastRoleSweepAt: number;
  /** Maintenance passes currently running (each kind runs once at a time). */
  private readonly busy = new Set<string>();
  private tickTimer: NodeJS.Timeout | null = null;
  private running = false;
  /** When start() was called; the orphan-segment safety net only applies after a full window. */
  private startedAtMs: number | null = null;

  constructor(deps: SessionServiceDeps) {
    this.repos = deps.repos;
    this.audit = deps.audit;
    this.events = deps.events;
    this.notifier = deps.notifier;
    this.roles = deps.roles;
    this.providers = deps.providers;
    this.clock = deps.clock ?? Date.now;
    this.timing = { ...DEFAULT_SESSION_TIMING, ...deps.timing };
    this.lastRoleSweepAt = this.clock();
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAtMs = this.clock();
    this.lastRoleSweepAt = this.startedAtMs;
    this.tickTimer = setInterval(() => void this.tick(), this.timing.tickMs);
    this.tickTimer.unref();
  }

  stop(): void {
    this.running = false;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    for (const rt of this.runtimes.values()) {
      if (rt.flushTimer) clearTimeout(rt.flushTimer);
      rt.flushTimer = null;
    }
    for (const timer of this.vodRetries.values()) clearTimeout(timer);
    this.vodRetries.clear();
  }

  /**
   * One maintenance pass: over every active session (account viewer/category time, close segments that lost
   * their account/permission, end sessions without live platforms, flush throttled message edits), plus
   * retries of pending summaries and live-role repairs. Each part runs independently (a slow role reconcile
   * never delays live sessions). Called by the interval timer; public so tests and admin tooling can drive it.
   */
  async tick(): Promise<void> {
    await Promise.all([
      this.exclusive('sessions', async () => {
        const active = this.repos.sessions.listActive();
        await Promise.all(
          active.map((s) =>
            this.lock
              .run(s.streamerId, () => this.tickSession(s.id))
              .catch((err) => log.error({ err, sessionId: s.id }, 'Session tick failed')),
          ),
        );
      }),
      this.exclusive('summaries', () => this.retryPendingSummaries(false)),
      this.exclusive('roles', () => this.maintainRoles()),
    ]);
  }

  /**
   * Repairs live roles now: retries pending live-role changes and reconciles guilds with active or recently
   * ended sessions or a failed reconcile. Called after the Discord gateway reconnects (role changes may have
   * failed meanwhile).
   */
  async reconcileLiveRoles(): Promise<void> {
    // Everything becomes due now; if a role pass is already running, the next tick picks it up.
    for (const entry of this.liveRoleRetries.values()) entry.dueAt = 0;
    for (const repair of this.roleRepairs.values()) repair.dueAt = 0;
    this.lastRoleSweepAt = Number.NEGATIVE_INFINITY;
    await this.exclusive('roles', () => this.maintainRoles());
  }

  // ───────────────────────────── monitor events ─────────────────────────────

  async onChannelLive(channel: Channel, snapshot: LiveSnapshot): Promise<void> {
    const snap = this.remember(channel, snapshot);
    await this.forEachSubscriber(channel, 'live', async (scope, account) => {
      if (!this.tracksLive(scope, account, channel)) {
        await this.detachChannel(scope, channel.id, this.clock(), 'disabled');
        return;
      }
      await this.applyLive(scope, channel, snap, 'live');
    });
  }

  async onChannelUpdate(channel: Channel, snapshot: LiveSnapshot, _info: { streamChanged: boolean }): Promise<void> {
    // A changed stream id is detected per segment (see upsertSegment), so the hint itself is not needed.
    const snap = this.remember(channel, snapshot);
    await this.forEachSubscriber(channel, 'update', async (scope, account) => {
      if (!this.tracksLive(scope, account, channel)) {
        // Live notifications turned off (or platform disabled) mid-stream: drop it like an offline platform.
        await this.detachChannel(scope, channel.id, this.clock(), 'disabled');
        return;
      }
      await this.applyLive(scope, channel, snap, 'update');
    });
  }

  async onChannelOffline(channel: Channel, lastSnapshot: LiveSnapshot | null, endedAt: string): Promise<void> {
    this.snapshots.delete(channel.id);
    this.lastLiveEventAt.delete(channel.id);
    const now = this.clock();
    const endedMs = Math.min(parseTime(endedAt) ?? now, now);
    await this.forEachSubscriber(channel, 'offline', (scope) => this.detachChannel(scope, channel.id, endedMs, 'offline', lastSnapshot));
  }

  // ───────────────────────────── queries ─────────────────────────────

  liveViews(guildId: string): LiveView[] {
    const settings = this.repos.settings.get(guildId);
    const views: LiveView[] = [];
    for (const session of this.repos.sessions.listActive(guildId)) {
      const streamer = this.repos.streamers.get(session.streamerId);
      if (streamer) views.push(this.buildLiveView(session, streamer, settings));
    }
    return views;
  }

  summaryOf(sessionId: number): SummaryView | null {
    const session = this.repos.sessions.get(sessionId);
    if (!session) return null;
    const streamer = this.repos.streamers.get(session.streamerId);
    if (!streamer) return null;
    return this.buildSummary(session, streamer, this.repos.settings.get(session.guildId), this.runtimes.get(session.id)?.lastThumbnail ?? null);
  }

  // ───────────────────────────── admin actions ─────────────────────────────

  async endStreamerSession(streamerId: number, reason: string): Promise<void> {
    await this.lock.run(streamerId, async () => {
      const session = this.repos.sessions.getActive(streamerId);
      if (!session) return;
      const scope = this.scopeOf(session);
      if (scope) await this.endSession(scope, session, reason);
    });
  }

  /**
   * Startup consistency: ends sessions whose channels are all offline (or whose streamer/accounts are gone),
   * closes individual dead segments, then makes Discord roles match the DB in every known guild.
   */
  async reconcile(): Promise<void> {
    for (const active of this.repos.sessions.listActive()) {
      await this.lock
        .run(active.streamerId, async () => {
          const session = this.repos.sessions.get(active.id);
          if (!session || session.status !== 'live') return;
          const scope = this.scopeOf(session);
          if (!scope) return;
          if (!scope.streamer.enabled) {
            await this.endSession(scope, session, 'streamer-disabled');
            return;
          }
          const now = this.clock();
          const closed = this.repairSegments(scope, session, now, 'startup');
          if (this.openSegments(session.id).length === 0) {
            await this.endSession(scope, session, 'stale');
          } else if (closed > 0) {
            const view = this.buildLiveView(session, scope.streamer, scope.settings);
            await this.syncMessage(session, view, scope.settings, now, { force: true });
          }
        })
        .catch((err) => log.error({ err, sessionId: active.id }, 'Session reconcile failed'));
    }

    // Summaries that could not be published before the restart (Discord failure, crash mid-publish).
    await this.retryPendingSummaries(true).catch((err) => log.error({ err }, 'Republishing pending summaries failed'));

    const guildIds = new Set([...this.repos.settings.listGuildIds(), ...this.repos.streamers.listAll().map((s) => s.guildId)]);
    for (const guildId of guildIds) {
      try {
        const result = await this.reconcileGuildRoles(guildId);
        if (result.added + result.removed > 0) log.info({ guildId, ...result }, 'Roles reconciled');
      } catch (err) {
        log.warn({ err, guildId }, 'Role reconcile failed; will retry');
        this.scheduleRoleRepair(guildId);
      }
    }
  }

  async syncRoles(guildId: string, actor: string): Promise<{ added: number; removed: number }> {
    try {
      const result = await this.reconcileGuildRoles(guildId);
      this.audit.record({
        guildId,
        actor,
        action: 'roles.sync',
        message: `تمت مزامنة الرتب: إضافة ${result.added} وإزالة ${result.removed}`,
        details: result,
      });
      return result;
    } catch (err) {
      this.audit.record({
        guildId,
        actor,
        action: 'roles.sync',
        level: 'warn',
        message: `فشلت مزامنة الرتب: ${errorMessage(err)}`,
      });
      throw err;
    }
  }

  // ───────────────────────────── core flow ─────────────────────────────

  private async forEachSubscriber(
    channel: Channel,
    what: string,
    fn: (scope: Scope, account: StreamerAccount | null) => Promise<void>,
  ): Promise<void> {
    let subscribers: ChannelSubscriber[];
    try {
      subscribers = this.repos.accounts.subscribersOf(channel.id);
    } catch (err) {
      log.error({ err, channelId: channel.id }, `Failed to load subscribers (${what})`);
      return;
    }
    await Promise.all(
      subscribers.map((sub) =>
        this.lock
          .run(sub.streamer.id, async () => {
            // Re-read under the lock: the streamer or account may have changed while we waited.
            const streamer = this.repos.streamers.get(sub.streamer.id);
            if (!streamer?.enabled) return;
            const account = this.repos.accounts.get(sub.account.id);
            const settings = this.repos.settings.get(streamer.guildId);
            await fn({ guildId: streamer.guildId, streamer, settings }, account && account.streamerId === streamer.id ? account : null);
          })
          .catch((err) =>
            log.error({ err, channelId: channel.id, streamerId: sub.streamer.id, guildId: sub.guildId }, `Live ${what} handling failed`),
          ),
      ),
    );
  }

  private tracksLive(scope: Scope, account: StreamerAccount | null, channel: Channel): boolean {
    return !!account?.notifyLive && scope.settings.platformsEnabled.includes(channel.platform);
  }

  private async applyLive(scope: Scope, channel: Channel, snapshot: LiveSnapshot, source: 'live' | 'update'): Promise<void> {
    const now = this.clock();
    const { streamer, settings } = scope;

    let session = this.repos.sessions.getActive(streamer.id);
    let lifecycle: Lifecycle = 'existing';
    if (!session) ({ session, lifecycle } = this.openSession(scope, channel, snapshot, now));

    const joined = this.upsertSegment(session, channel, snapshot, now);
    const view = this.buildLiveView(session, streamer, settings);
    this.accrue(session, view, now);
    this.addTitle(session, snapshot.title);
    this.repos.sessions.save(session);

    if (lifecycle !== 'existing' || source === 'live') {
      await this.setLiveRole(scope, true, lifecycle === 'resumed' ? 'رجع للبث' : 'بدأ البث');
    }
    await this.syncMessage(session, view, settings, now, { force: lifecycle === 'resumed' });

    const platforms = view.platforms.map((p) => p.platform);
    if (lifecycle === 'created') {
      this.audit.record({
        guildId: scope.guildId,
        action: 'live.start',
        message: `${streamer.displayName} بدأ بث مباشر على ${platformListAr(platforms)}`,
        details: { sessionId: session.id, streamerId: streamer.id, platforms, title: snapshot.title },
        mirror: true,
      });
    } else if (lifecycle === 'resumed') {
      this.audit.record({
        guildId: scope.guildId,
        action: 'live.resume',
        message: `${streamer.displayName} رجع للبث على ${platformListAr(platforms)} (كمّلنا على نفس الإشعار)`,
        details: { sessionId: session.id, streamerId: streamer.id, platforms },
        mirror: true,
      });
    } else if (joined) {
      this.audit.record({
        guildId: scope.guildId,
        action: 'live.platform_add',
        message: `${streamer.displayName} بدأ يبث كمان على ${PLATFORM_LABELS[channel.platform]}`,
        details: { sessionId: session.id, streamerId: streamer.id, channelId: channel.id },
      });
    }
    this.emitChanged(scope, lifecycle === 'existing' ? 'updated' : 'live');
  }

  /** Reuse a session that ended inside the merge window (or the same broadcast), else create one. */
  private openSession(scope: Scope, channel: Channel, snapshot: LiveSnapshot, now: number): { session: LiveSession; lifecycle: Lifecycle } {
    const { streamer, settings } = scope;
    const mergeMinutes = Number(settings.options.reconnectMergeMinutes);
    const mergeMs = Number.isFinite(mergeMinutes) && mergeMinutes > 0 ? mergeMinutes * 60_000 : 0;
    const recent = this.repos.sessions.getRecentlyEnded(streamer.id, iso(now - Math.max(mergeMs, SAME_BROADCAST_RESUME_MS)));
    const recentEnd = parseTime(recent?.endedAt);
    if (recent && recentEnd !== null) {
      const withinMerge = mergeMs > 0 && now - recentEnd <= mergeMs;
      // The same platform broadcast coming back means our "end" was wrong (bot downtime, stale check).
      const sameBroadcast =
        !!snapshot.streamId &&
        this.repos.sessions.segments(recent.id).some((seg) => seg.channelId === channel.id && seg.streamId === snapshot.streamId);
      if (withinMerge || sameBroadcast) {
        this.cancelVodRetry(recent.id);
        this.forgetSummary(recent.id);
        // The live message comes back, so a summary that was still pending is obsolete.
        const resumed: LiveSession = { ...recent, status: 'live', endedAt: null, summaryPending: false, summaryAttempts: 0 };
        this.repos.sessions.save(resumed);
        log.info({ sessionId: resumed.id, streamerId: streamer.id, sameBroadcast }, 'Resumed live session');
        return { session: resumed, lifecycle: 'resumed' };
      }
    }
    const session = this.repos.sessions.create({ guildId: scope.guildId, streamerId: streamer.id, startedAt: iso(this.platformStart(snapshot, now)) });
    log.info({ sessionId: session.id, streamerId: streamer.id, channelId: channel.id }, 'Live session started');
    return { session, lifecycle: 'created' };
  }

  /** Opens/updates the channel's segment. Returns true when the platform newly joined the session. */
  private upsertSegment(session: LiveSession, channel: Channel, snapshot: LiveSnapshot, now: number): boolean {
    const viewers = sanitizeViewers(snapshot.viewers);
    const segment = this.repos.sessions.openSegment(session.id, channel.id);

    if (segment && snapshot.streamId && segment.streamId && segment.streamId !== snapshot.streamId) {
      // Same platform, new broadcast (reconnected faster than the offline grace): keep one segment per
      // broadcast so each gets its own VOD link; the platform stays "live" throughout.
      const segStart = parseTime(segment.startedAt) ?? now;
      const newStart = Math.max(this.platformStart(snapshot, now), segStart);
      this.repos.sessions.saveSegment({ ...segment, endedAt: iso(clamp(newStart, segStart, now)) });
      this.repos.sessions.addSegment({
        sessionId: session.id,
        channelId: channel.id,
        platform: channel.platform,
        streamId: snapshot.streamId,
        startedAt: iso(newStart),
        viewers,
      });
      return false;
    }

    if (segment) {
      segment.lastViewers = viewers ?? segment.lastViewers;
      segment.peakViewers = Math.max(segment.peakViewers, viewers ?? 0);
      if (snapshot.streamId) segment.streamId = snapshot.streamId;
      this.repos.sessions.saveSegment(segment);
      return false;
    }

    const start = this.platformStart(snapshot, now);
    this.repos.sessions.addSegment({
      sessionId: session.id,
      channelId: channel.id,
      platform: channel.platform,
      streamId: snapshot.streamId,
      startedAt: iso(start),
      viewers,
    });
    // A platform that was already live before we noticed it moves the session start earlier.
    const sessionStart = parseTime(session.startedAt);
    if (sessionStart === null || start < sessionStart) session.startedAt = iso(start);
    return true;
  }

  /** Closes the channel's open segment; ends the session when it was the last live platform. */
  private async detachChannel(scope: Scope, channelId: number, endedMs: number, reason: DetachReason, lastSnapshot?: LiveSnapshot | null): Promise<void> {
    const session = this.repos.sessions.getActive(scope.streamer.id);
    if (!session) return;
    const segment = this.repos.sessions.openSegment(session.id, channelId);
    if (!segment) return;

    const now = this.clock();
    this.closeSegment(segment, endedMs, now);
    if (lastSnapshot?.thumbnailUrl) {
      const rt = this.runtime(session.id);
      rt.lastThumbnail ??= lastSnapshot.thumbnailUrl;
    }

    if (this.openSegments(session.id).length === 0) {
      await this.endSession(scope, session, reason === 'offline' ? 'offline' : 'live-notify-off', endedMs);
      return;
    }

    const view = this.buildLiveView(session, scope.streamer, scope.settings);
    this.accrue(session, view, now);
    this.repos.sessions.save(session);
    await this.syncMessage(session, view, scope.settings, now, { force: false });
    this.audit.record({
      guildId: scope.guildId,
      action: 'live.platform_remove',
      message:
        reason === 'offline'
          ? `${scope.streamer.displayName} وقف البث على ${PLATFORM_LABELS[segment.platform]} (مكمّل على ${platformListAr(view.platforms.map((p) => p.platform))})`
          : `شلنا ${PLATFORM_LABELS[segment.platform]} من إشعار بث ${scope.streamer.displayName} لأن إشعارات البث لهذا الحساب متوقفة`,
      details: { sessionId: session.id, streamerId: scope.streamer.id, channelId, reason },
    });
    this.emitChanged(scope, 'updated');
  }

  /**
   * Ends the session: closes open segments, finalizes stats, removes the live role, looks up VODs and turns
   * the live message into the summary. `notifier.postSummary` is called even when `options.summaryEnabled`
   * is false: the notifier then renders a minimal "stream ended" message instead of the full summary, so the
   * channel never keeps a stale "LIVE" message.
   */
  private async endSession(scope: Scope, session: LiveSession, reason: string, endedMs: number = this.clock()): Promise<void> {
    const now = this.clock();
    const { streamer } = scope;
    for (const segment of this.openSegments(session.id)) this.closeSegment(segment, endedMs, now);

    const startMs = parseTime(session.startedAt) ?? now;
    const lastSegmentEnd = this.repos.sessions.segments(session.id).reduce((max, seg) => Math.max(max, parseTime(seg.endedAt) ?? 0), 0);
    const endMs = clamp(lastSegmentEnd || Math.min(endedMs, now), startMs, now);

    this.accrue(session, null, endMs);
    const thumbnail = this.runtimes.get(session.id)?.lastThumbnail ?? null;
    this.dropRuntime(session.id);
    session.status = 'ended';
    session.endedAt = iso(endMs);
    // Persisted together with the end, so a failed (or interrupted) publication is retried, even after a restart.
    session.summaryPending = true;
    session.summaryAttempts = 0;
    this.repos.sessions.save(session);
    this.recentRoleGuilds.set(scope.guildId, now);
    log.info({ sessionId: session.id, streamerId: streamer.id, reason }, 'Live session ended');

    await this.setLiveRole(scope, false, 'انتهى البث');
    const vods = await this.lookupVods(session.id);
    const summary = await this.publishSummary(scope, session, thumbnail);

    this.audit.record({
      guildId: scope.guildId,
      action: 'live.end',
      message:
        `${streamer.displayName} خلّص البث — المدة ${formatDurationAr(summary.durationSec)}، أعلى مشاهدين ${summary.peakViewers}` +
        (summary.avgViewers != null ? `، المتوسط ${summary.avgViewers}` : '') +
        (END_REASON_NOTE[reason] ?? ''),
      details: {
        sessionId: session.id,
        streamerId: streamer.id,
        reason,
        durationSec: summary.durationSec,
        peakViewers: summary.peakViewers,
        avgViewers: summary.avgViewers,
      },
      mirror: true,
    });
    this.emitChanged(scope, 'ended');
    if (vods.missing > 0) this.scheduleVodRetry(streamer.id, session.id, thumbnail, 0);
  }

  private closeSegment(segment: LiveSegment, endedMs: number, now: number): void {
    const start = parseTime(segment.startedAt) ?? now;
    this.repos.sessions.saveSegment({ ...segment, endedAt: iso(clamp(endedMs, start, Math.max(start, now))) });
  }

  // ───────────────────────────── statistics ─────────────────────────────

  /**
   * Integrates viewers and category time from the previous sample up to `now`, then records the new state.
   * `view = null` finalizes (session end): the interval is closed without starting a new one.
   */
  private accrue(session: LiveSession, view: LiveView | null, now: number): void {
    const rt = this.runtime(session.id);
    const total = view ? view.totalViewers : null;
    const next = view ? primaryCategory(view.platforms) : null;

    if (rt.sample) {
      const step = this.wholeSeconds(rt.sample.at, now);
      if (step.secs > 0) {
        if (rt.sample.total != null) {
          session.viewerSum += Math.round(rt.sample.total * step.secs);
          session.viewerSamples += step.secs;
        }
        rt.sample = { at: step.nextAt, total };
      } else if (now >= rt.sample.at) {
        rt.sample.total = total;
      }
    } else {
      rt.sample = { at: now, total };
    }
    if (total != null) session.peakViewers = Math.max(session.peakViewers, total);

    if (rt.category) {
      const step = this.wholeSeconds(rt.category.at, now);
      if (step.secs > 0) {
        const activeKey = rt.category.key;
        const active = activeKey ? session.categories.find((c) => categoryKey(c.name) === activeKey) : undefined;
        if (active) active.seconds += step.secs;
        rt.category = { key: next?.key ?? null, at: step.nextAt };
      } else if (now >= rt.category.at) {
        rt.category.key = next?.key ?? null;
      }
    } else {
      rt.category = { key: next?.key ?? null, at: now };
    }
    if (next) {
      const existing = session.categories.find((c) => categoryKey(c.name) === next.key);
      if (!existing && session.categories.length < MAX_CATEGORIES) {
        session.categories.push({ name: next.name, imageUrl: next.imageUrl, firstSeenAt: iso(now), seconds: 0 });
      } else if (existing && !existing.imageUrl && next.imageUrl) {
        existing.imageUrl = next.imageUrl;
      }
    }

    const thumbnail = view?.platforms[0]?.snapshot.thumbnailUrl;
    if (thumbnail) rt.lastThumbnail = thumbnail;
  }

  /** Whole seconds between two instants (carrying the remainder), capped for suspended processes. */
  private wholeSeconds(from: number, to: number): { secs: number; nextAt: number } {
    const dt = to - from;
    if (dt <= 0) return { secs: 0, nextAt: from };
    if (dt > this.timing.maxSampleGapMs) return { secs: Math.floor(this.timing.maxSampleGapMs / 1000), nextAt: to };
    const secs = Math.floor(dt / 1000);
    return { secs, nextAt: from + secs * 1000 };
  }

  private addTitle(session: LiveSession, title: string | null): void {
    const text = normalizeText(title);
    if (!text || session.titles.includes(text)) return;
    session.titles.push(text);
    if (session.titles.length > MAX_TITLES) session.titles.splice(0, session.titles.length - MAX_TITLES);
  }

  // ───────────────────────────── message rendering ─────────────────────────────

  private buildLiveView(session: LiveSession, streamer: Streamer, settings: GuildSettings): LiveView {
    const entries: Array<{ view: LivePlatformView; startedMs: number }> = [];
    for (const segment of this.openSegments(session.id)) {
      const channel = this.repos.channels.get(segment.channelId);
      if (!channel) continue;
      entries.push({
        view: { platform: channel.platform, channel: channelInfo(channel), snapshot: this.snapshotFor(channel, segment) },
        startedMs: parseTime(segment.startedAt) ?? 0,
      });
    }
    const platforms = sortLivePlatforms(entries).map((e) => e.view);
    return { guildId: session.guildId, settings, session, streamer, platforms, totalViewers: sumViewers(platforms) };
  }

  /** Freshest known snapshot: what the monitor just sent, else the DB copy, else a minimal placeholder. */
  private snapshotFor(channel: Channel, segment: LiveSegment): LiveSnapshot {
    const cached = this.snapshots.get(channel.id);
    if (cached?.isLive) return cached;
    if (channel.liveSnapshot?.isLive) return channel.liveSnapshot;
    return {
      ...offlineSnapshot(channel, channel.url),
      isLive: true,
      streamId: segment.streamId,
      viewers: segment.lastViewers,
      startedAt: segment.startedAt,
    };
  }

  /**
   * Posts or edits the live message according to the throttle rules. `force` bypasses the throttle
   * (used when a resumed session must turn the summary back into a live message right away).
   */
  private async syncMessage(session: LiveSession, view: LiveView, settings: GuildSettings, now: number, opts: { force: boolean }): Promise<void> {
    const rt = this.runtime(session.id);
    const signature = liveSignature(view.platforms);
    const changed = rt.dirty || signature !== rt.renderedSignature;
    const lastUpdate = parseTime(session.lastMessageUpdate);
    const sinceLast = lastUpdate === null ? Number.POSITIVE_INFINITY : now - lastUpdate;
    const periodicMs = Math.max(0, Number(settings.options.liveUpdateMinutes) || 0) * 60_000;

    let due: boolean;
    if (!messageRefOf(session)) due = now - rt.lastPostAttempt >= this.timing.minEditIntervalMs;
    else if (opts.force) due = true;
    else if (changed) due = sinceLast >= this.timing.minEditIntervalMs;
    else due = periodicMs > 0 && sinceLast >= periodicMs;

    if (!due) {
      if (changed && messageRefOf(session)) {
        rt.dirty = true;
        this.scheduleFlush(session, sinceLast);
      }
      return;
    }
    await this.renderLive(session, view, signature, now);
  }

  private async renderLive(session: LiveSession, view: LiveView, signature: string, now: number): Promise<void> {
    const rt = this.runtime(session.id);
    const ref = messageRefOf(session);
    if (ref) {
      let outcome: EditOutcome;
      try {
        outcome = await this.notifier.updateLive(ref, view);
      } catch (err) {
        log.warn({ err, sessionId: session.id }, 'Live message edit threw');
        outcome = 'transient';
      }
      if (outcome === 'ok') {
        this.markRendered(session, rt, signature, now);
        return;
      }
      // Lost access only matters as "gone" when the admin moved notifications to another channel meanwhile.
      const moved = !!view.settings.liveChannelId && view.settings.liveChannelId !== ref.channelId;
      if (outcome === 'transient' || (outcome === 'forbidden' && !moved)) {
        // The message still exists (Discord hiccup, or access lost for now): never repost here or it would be
        // duplicated. Not marked rendered, so the next sync/tick edits it again.
        log.warn({ sessionId: session.id, ref, outcome }, 'Live message edit failed; will retry');
        rt.dirty = true;
        return;
      }
      log.info({ sessionId: session.id, ref, outcome }, 'Live message is gone or unreachable; posting a new one');
    }

    rt.lastPostAttempt = now;
    let posted: MessageRef | null = null;
    try {
      posted = await this.notifier.postLive(view);
    } catch (err) {
      log.warn({ err, sessionId: session.id }, 'Posting live message failed');
    }
    if (posted) {
      session.messageChannelId = posted.channelId;
      session.messageId = posted.messageId;
      this.markRendered(session, rt, signature, now);
    } else if (ref) {
      // The old message is gone (or unreachable in the old channel); forget it so the next attempt posts.
      session.messageChannelId = null;
      session.messageId = null;
      this.repos.sessions.save(session);
    }
  }

  private markRendered(session: LiveSession, rt: SessionRuntime, signature: string, now: number): void {
    session.lastMessageUpdate = iso(now);
    rt.renderedSignature = signature;
    rt.dirty = false;
    if (rt.flushTimer) clearTimeout(rt.flushTimer);
    rt.flushTimer = null;
    this.repos.sessions.save(session);
  }

  /** Schedules the throttled edit for exactly when the throttle window opens (the tick is the fallback). */
  private scheduleFlush(session: LiveSession, sinceLast: number): void {
    const rt = this.runtime(session.id);
    if (!this.running || rt.flushTimer) return;
    const delay = Math.max(1_000, this.timing.minEditIntervalMs - (Number.isFinite(sinceLast) ? sinceLast : 0));
    const { id: sessionId, streamerId } = session;
    rt.flushTimer = setTimeout(() => {
      rt.flushTimer = null;
      this.lock
        .run(streamerId, async () => {
          const current = this.repos.sessions.get(sessionId);
          if (!current || current.status !== 'live') return;
          const scope = this.scopeOf(current);
          if (!scope) return;
          const now = this.clock();
          const view = this.buildLiveView(current, scope.streamer, scope.settings);
          this.accrue(current, view, now);
          this.repos.sessions.save(current);
          await this.syncMessage(current, view, scope.settings, now, { force: false });
        })
        .catch((err) => log.error({ err, sessionId }, 'Deferred live message edit failed'));
    }, delay);
    rt.flushTimer.unref();
  }

  // ───────────────────────────── summary + VODs ─────────────────────────────

  private buildSummary(session: LiveSession, streamer: Streamer, settings: GuildSettings, thumbnail: string | null): SummaryView {
    const segments = this.repos.sessions.segments(session.id).flatMap((seg) => {
      const channel = this.repos.channels.get(seg.channelId);
      return channel ? [{ ...seg, channel: channelInfo(channel) }] : [];
    });
    const byPeak = [...segments].sort((a, b) => b.peakViewers - a.peakViewers);
    const imageUrl = thumbnail ?? byPeak.find((s) => s.channel.avatarUrl)?.channel.avatarUrl ?? null;
    return buildSummaryView({ guildId: session.guildId, settings, session, streamer, segments, imageUrl, now: this.clock() });
  }

  /**
   * Publishes the summary (or the minimal "ended" card). `summaryPending` is persisted before the attempt and
   * cleared once Discord shows it (or there is nothing to show); a transient failure keeps the old ref and
   * schedules a retry with backoff, giving up after `summaryMaxAttempts` with an audit warning.
   */
  private async publishSummary(scope: Scope, session: LiveSession, thumbnail: string | null): Promise<SummaryView> {
    const summary = this.buildSummary(session, scope.streamer, scope.settings, thumbnail);
    if (!session.summaryPending) {
      session.summaryPending = true;
      this.repos.sessions.save(session);
    }
    this.summaryThumbnails.set(session.id, thumbnail);

    let outcome: SummaryOutcome;
    try {
      outcome = await this.notifier.postSummary(messageRefOf(session), summary);
    } catch (err) {
      outcome = { status: 'transient', reason: errorMessage(err) };
    }
    if (outcome.status === 'transient') {
      this.summaryFailed(scope, session, outcome.reason);
      return summary;
    }
    if (outcome.status === 'done') {
      session.messageChannelId = outcome.ref.channelId;
      session.messageId = outcome.ref.messageId;
    }
    session.summaryPending = false;
    session.summaryAttempts = 0;
    this.repos.sessions.save(session);
    this.forgetSummary(session.id);
    return summary;
  }

  private summaryFailed(scope: Scope, session: LiveSession, reason: string): void {
    session.summaryAttempts += 1;
    if (session.summaryAttempts >= this.timing.summaryMaxAttempts) {
      session.summaryPending = false;
      this.repos.sessions.save(session);
      this.forgetSummary(session.id);
      log.warn({ sessionId: session.id, attempts: session.summaryAttempts, reason }, 'Giving up publishing the stream summary');
      this.audit.record({
        guildId: scope.guildId,
        action: 'live.summary_failed',
        level: 'warn',
        message: `ما قدرنا نحوّل إشعار بث ${scope.streamer.displayName} لملخص بعد محاولات لمدة يوم — تأكد إن البوت يقدر يوصل لروم إشعارات البث، والإشعار القديم ممكن يبقى "مباشر"`,
        details: { sessionId: session.id, streamerId: scope.streamer.id, attempts: session.summaryAttempts, reason },
        mirror: true,
      });
      return;
    }
    this.repos.sessions.save(session);
    const delays = this.timing.summaryRetryDelaysMs;
    const delay = delays[Math.min(session.summaryAttempts, delays.length) - 1] ?? 60 * 60_000;
    this.summaryRetryAt.set(session.id, this.clock() + delay);
    log.warn({ sessionId: session.id, attempts: session.summaryAttempts, reason, retryInMs: delay }, 'Publishing stream summary failed; will retry');
  }

  /** Retries due pending summaries (`all`: every pending one, used at startup). */
  private async retryPendingSummaries(all: boolean): Promise<void> {
    const now = this.clock();
    const due = this.repos.sessions.listSummaryPending(SUMMARY_SCAN_LIMIT).filter((s) => all || (this.summaryRetryAt.get(s.id) ?? 0) <= now);
    await Promise.all(
      due.map((s) =>
        this.lock
          .run(s.streamerId, () => this.retrySummary(s.id, all))
          .catch((err) => log.warn({ err, sessionId: s.id }, 'Summary retry failed')),
      ),
    );
  }

  private async retrySummary(sessionId: number, force: boolean): Promise<void> {
    const session = this.repos.sessions.get(sessionId);
    if (!session || session.status !== 'ended' || !session.summaryPending) {
      this.forgetSummary(sessionId);
      return;
    }
    // Re-checked under the lock: another path (end, VOD retry) may have just published or rescheduled it.
    if (!force && (this.summaryRetryAt.get(sessionId) ?? 0) > this.clock()) return;
    const scope = this.scopeOf(session);
    if (!scope) {
      session.summaryPending = false;
      this.repos.sessions.save(session);
      this.forgetSummary(sessionId);
      return;
    }
    await this.publishSummary(scope, session, this.summaryThumbnails.get(sessionId) ?? null);
  }

  private forgetSummary(sessionId: number): void {
    this.summaryRetryAt.delete(sessionId);
    this.summaryThumbnails.delete(sessionId);
  }

  /** Best-effort VOD lookup for segments without one (parallel, bounded by a timeout each). */
  private async lookupVods(sessionId: number): Promise<{ found: number; missing: number }> {
    const pending = this.repos.sessions.segments(sessionId).filter((seg) => !seg.vodUrl);
    const lookups = new Map<string, Promise<string | null>>();
    let found = 0;
    let missing = 0;

    await Promise.all(
      pending.map(async (segment) => {
        const channel = this.repos.channels.get(segment.channelId);
        const provider = channel ? this.providerFor(channel) : null;
        if (!channel || !provider?.findVodUrl) return;
        // Segments of the same broadcast share one lookup.
        const key = `${channel.id}:${segment.streamId ?? segment.startedAt}`;
        let lookup = lookups.get(key);
        if (!lookup) {
          lookup = this.withTimeout(provider.findVodUrl(toChannelRef(channel), segment.streamId, segment.startedAt), this.timing.vodLookupTimeoutMs).catch(
            (err) => {
              log.debug({ err: errorMessage(err), channelId: channel.id }, 'VOD lookup failed');
              return null;
            },
          );
          lookups.set(key, lookup);
        }
        const url = await lookup;
        if (url && /^https?:\/\//i.test(url)) {
          this.repos.sessions.saveSegment({ ...segment, vodUrl: url });
          found++;
        } else {
          missing++;
        }
      }),
    );
    return { found, missing };
  }

  private scheduleVodRetry(streamerId: number, sessionId: number, thumbnail: string | null, attempt: number): void {
    const delay = this.timing.vodRetryDelaysMs[attempt];
    if (!this.running || delay === undefined) return;
    this.cancelVodRetry(sessionId);
    const timer = setTimeout(() => {
      this.vodRetries.delete(sessionId);
      this.lock
        .run(streamerId, async () => {
          const session = this.repos.sessions.get(sessionId);
          if (!session || session.status !== 'ended') return;
          const vods = await this.lookupVods(sessionId);
          const scope = this.scopeOf(session);
          if (vods.found > 0 && scope && (messageRefOf(session) || session.summaryPending)) await this.publishSummary(scope, session, thumbnail);
          if (vods.missing > 0) this.scheduleVodRetry(streamerId, sessionId, thumbnail, attempt + 1);
        })
        .catch((err) => log.warn({ err, sessionId }, 'VOD retry failed'));
    }, delay);
    timer.unref();
    this.vodRetries.set(sessionId, timer);
  }

  private cancelVodRetry(sessionId: number): void {
    const timer = this.vodRetries.get(sessionId);
    if (timer) clearTimeout(timer);
    this.vodRetries.delete(sessionId);
  }

  // ───────────────────────────── maintenance ─────────────────────────────

  private async tickSession(sessionId: number): Promise<void> {
    const session = this.repos.sessions.get(sessionId);
    if (!session || session.status !== 'live') return;
    const scope = this.scopeOf(session);
    if (!scope) return;
    if (!scope.streamer.enabled) {
      await this.endSession(scope, session, 'streamer-disabled');
      return;
    }
    const now = this.clock();
    const closed = this.repairSegments(scope, session, now, 'tick');
    if (this.openSegments(session.id).length === 0) {
      await this.endSession(scope, session, 'no-live-platforms');
      return;
    }
    const view = this.buildLiveView(session, scope.streamer, scope.settings);
    this.accrue(session, view, now);
    this.repos.sessions.save(session);
    await this.syncMessage(session, view, scope.settings, now, { force: false });
    if (closed > 0) this.emitChanged(scope, 'updated');
  }

  /**
   * Closes open segments that should not be open anymore. Always: channel/account deleted, live
   * notifications turned off, platform disabled for the guild. At startup: channel offline in the DB.
   * On the tick: orphaned segments (see `orphanSegmentMs`). Returns the number of segments closed.
   */
  private repairSegments(scope: Scope, session: LiveSession, now: number, mode: 'tick' | 'startup'): number {
    let closed = 0;
    for (const segment of this.openSegments(session.id)) {
      const channel = this.repos.channels.get(segment.channelId);
      const account = channel ? this.repos.accounts.getByPair(scope.streamer.id, channel.id) : null;
      let endedMs: number | null = null;
      if (!channel || !account || !account.notifyLive || !scope.settings.platformsEnabled.includes(channel.platform)) {
        endedMs = now;
      } else if (mode === 'startup') {
        if (!channel.isLive) endedMs = parseTime(channel.offlineSince) ?? parseTime(channel.lastLiveCheckAt) ?? parseTime(channel.updatedAt) ?? now;
      } else {
        endedMs = this.orphanedSince(channel, now);
      }
      if (endedMs !== null) {
        this.closeSegment(segment, Math.min(endedMs, now), now);
        closed++;
        log.info({ sessionId: session.id, channelId: segment.channelId, mode }, 'Closed stale live segment');
      }
    }
    return closed;
  }

  /**
   * Returns when an open segment's channel was last known live if nothing has confirmed it for
   * `orphanSegmentMs` (no live event and no fresh live check in the DB), else null. Inactive until the
   * service has run for a full window, so a restart never closes segments before the monitor's first polls.
   */
  private orphanedSince(channel: Channel, now: number): number | null {
    const window = this.timing.orphanSegmentMs;
    if (this.startedAtMs === null || now - this.startedAtMs < window) return null;
    const lastEvent = this.lastLiveEventAt.get(channel.id) ?? null;
    if (lastEvent !== null && now - lastEvent < window) return null;
    const checked = parseTime(channel.lastLiveCheckAt);
    if (channel.isLive && checked !== null && now - checked < window) return null;
    return lastEvent ?? (channel.isLive ? checked : parseTime(channel.offlineSince)) ?? now;
  }

  private async reconcileGuildRoles(guildId: string): Promise<{ added: number; removed: number }> {
    const enabled = this.repos.streamers.list(guildId).filter((s) => s.enabled);
    const liveStreamerIds = new Set(this.repos.sessions.listActive(guildId).map((s) => s.streamerId));
    const liveUserIds = new Set(enabled.filter((s) => liveStreamerIds.has(s.id)).map((s) => s.discordUserId));
    // Always the full registered set: the RoleManager only applies it when options.autoStreamerRole is on
    // (passing an empty set instead could strip manually managed roles).
    const streamerUserIds = new Set(enabled.map((s) => s.discordUserId));
    return this.roles.reconcile(guildId, liveUserIds, streamerUserIds);
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private remember(channel: Channel, snapshot: LiveSnapshot): LiveSnapshot {
    const clean: LiveSnapshot = { ...snapshot, isLive: true, viewers: sanitizeViewers(snapshot.viewers), tags: snapshot.tags ?? [] };
    this.snapshots.set(channel.id, clean);
    this.lastLiveEventAt.set(channel.id, this.clock());
    return clean;
  }

  /** Start of the broadcast as reported by the platform, when plausible; otherwise `now`. */
  private platformStart(snapshot: LiveSnapshot, now: number): number {
    const reported = parseTime(snapshot.startedAt);
    if (reported === null || reported > now || now - reported > MAX_STREAM_AGE_MS) return now;
    return reported;
  }

  private openSegments(sessionId: number): LiveSegment[] {
    const byChannel = new Map<number, LiveSegment>();
    for (const seg of this.repos.sessions.segments(sessionId)) {
      if (seg.endedAt) continue;
      const prev = byChannel.get(seg.channelId);
      if (!prev || seg.id > prev.id) byChannel.set(seg.channelId, seg);
    }
    return [...byChannel.values()];
  }

  private scopeOf(session: LiveSession): Scope | null {
    const streamer = this.repos.streamers.get(session.streamerId);
    if (!streamer) return null;
    return { guildId: session.guildId, streamer, settings: this.repos.settings.get(session.guildId) };
  }

  private runtime(sessionId: number): SessionRuntime {
    let rt = this.runtimes.get(sessionId);
    if (!rt) {
      rt = { sample: null, category: null, renderedSignature: null, dirty: false, flushTimer: null, lastPostAttempt: 0, lastThumbnail: null };
      this.runtimes.set(sessionId, rt);
    }
    return rt;
  }

  private dropRuntime(sessionId: number): void {
    const rt = this.runtimes.get(sessionId);
    if (rt?.flushTimer) clearTimeout(rt.flushTimer);
    this.runtimes.delete(sessionId);
  }

  private providerFor(channel: Channel) {
    try {
      const provider = this.providers.get(channel.platform);
      return provider.isConfigured() ? provider : null;
    } catch {
      return null;
    }
  }

  private async setLiveRole(scope: Scope, live: boolean, reason: string): Promise<void> {
    const { guildId, streamer } = scope;
    const key = `${guildId}:${streamer.discordUserId}`;
    let outcome: RoleChangeOutcome;
    try {
      outcome = await this.roles.setLive(guildId, streamer.discordUserId, live, reason);
    } catch (err) {
      log.warn({ err, guildId, streamerId: streamer.id, live }, 'Updating live role failed');
      outcome = 'transient';
    }
    if (outcome !== 'transient') {
      // A newer change went through (or needs an admin fix): an older pending retry is obsolete.
      this.liveRoleRetries.delete(key);
      return;
    }
    if (this.liveRoleRetries.has(key)) return;
    const now = this.clock();
    log.warn({ guildId, streamerId: streamer.id, live }, 'Live role change failed transiently; will retry');
    this.liveRoleRetries.set(key, { guildId, userId: streamer.discordUserId, streamerId: streamer.id, dueAt: now + this.roleRetryDelay(0), attempt: 0, since: now });
  }

  // ───────────────────────────── role maintenance ─────────────────────────────

  /** Whether the member should hold the live role right now (same rule as the guild reconcile). */
  private wantsLiveRole(guildId: string, userId: string): boolean {
    return this.repos.streamers.list(guildId).some((s) => s.enabled && s.discordUserId === userId && this.repos.sessions.getActive(s.id) !== null);
  }

  /**
   * Retries a live-role change that failed transiently. The desired state is read from the DB under the
   * streamer's lock, so a retry can never undo a newer go-live or end.
   */
  private async retryLiveRole(key: string, entry: RetryState & { guildId: string; userId: string; streamerId: number }): Promise<void> {
    await this.lock
      .run(entry.streamerId, async () => {
        if (this.liveRoleRetries.get(key) !== entry) return; // superseded meanwhile
        const live = this.wantsLiveRole(entry.guildId, entry.userId);
        let outcome: RoleChangeOutcome;
        try {
          outcome = await this.roles.setLive(entry.guildId, entry.userId, live, live ? 'بدأ البث' : 'انتهى البث');
        } catch (err) {
          log.debug({ err, guildId: entry.guildId }, 'Live role retry threw');
          outcome = 'transient';
        }
        if (this.liveRoleRetries.get(key) !== entry) return;
        const now = this.clock();
        if (outcome !== 'transient') {
          this.liveRoleRetries.delete(key);
          log.info({ guildId: entry.guildId, streamerId: entry.streamerId, live, outcome }, 'Live role change retried');
          return;
        }
        if (now - entry.since >= ROLE_REPAIR_MAX_AGE_MS) {
          this.liveRoleRetries.delete(key);
          log.warn({ guildId: entry.guildId, streamerId: entry.streamerId, live }, 'Giving up retrying the live role change');
          return;
        }
        const attempt = entry.attempt + 1;
        this.liveRoleRetries.set(key, { ...entry, attempt, dueAt: now + this.roleRetryDelay(attempt) });
      })
      .catch((err) => log.warn({ err, guildId: entry.guildId }, 'Live role retry failed'));
  }

  private scheduleRoleRepair(guildId: string): void {
    if (this.roleRepairs.has(guildId)) return;
    const now = this.clock();
    this.roleRepairs.set(guildId, { dueAt: now + this.roleRetryDelay(0), attempt: 0, since: now });
  }

  private roleRetryDelay(attempt: number): number {
    const delays = this.timing.roleRetryDelaysMs;
    return delays[Math.min(attempt, delays.length - 1)] ?? this.timing.roleReconcileMs;
  }

  /** Guilds with an active session or one that ended recently (prunes expired entries). */
  private sweepGuilds(now: number): Set<string> {
    const guilds = new Set(this.repos.sessions.listActive().map((s) => s.guildId));
    for (const [guildId, endedAt] of this.recentRoleGuilds) {
      if (now - endedAt <= RECENT_ROLE_GUILD_MS) guilds.add(guildId);
      else this.recentRoleGuilds.delete(guildId);
    }
    return guilds;
  }

  /** Due live-role retries and guild repairs, plus the periodic reconcile of guilds with active or recently ended sessions. */
  private async maintainRoles(): Promise<void> {
    const now = this.clock();
    for (const [key, entry] of [...this.liveRoleRetries]) if (entry.dueAt <= now) await this.retryLiveRole(key, entry);
    const guilds = new Set<string>();
    for (const [guildId, repair] of this.roleRepairs) if (repair.dueAt <= now) guilds.add(guildId);
    if (now - this.lastRoleSweepAt >= this.timing.roleReconcileMs) {
      this.lastRoleSweepAt = now;
      for (const guildId of this.sweepGuilds(now)) guilds.add(guildId);
    }
    for (const guildId of guilds) await this.reconcileRolesOf(guildId, now);
  }

  private async reconcileRolesOf(guildId: string, now: number): Promise<void> {
    try {
      const result = await this.reconcileGuildRoles(guildId);
      this.roleRepairs.delete(guildId);
      if (result.added + result.removed > 0) log.info({ guildId, ...result }, 'Live roles repaired');
    } catch (err) {
      const previous = this.roleRepairs.get(guildId);
      const since = previous?.since ?? now;
      if (now - since >= ROLE_REPAIR_MAX_AGE_MS) {
        this.roleRepairs.delete(guildId);
        log.warn({ guildId, err: errorMessage(err) }, 'Giving up repairing roles');
        return;
      }
      const attempt = previous ? previous.attempt + 1 : 0;
      this.roleRepairs.set(guildId, { dueAt: now + this.roleRetryDelay(attempt), attempt, since });
      if (attempt === 0) log.warn({ guildId, err: errorMessage(err) }, 'Role reconcile failed; will retry');
      else log.debug({ guildId, attempt, err: errorMessage(err) }, 'Role reconcile failed again');
    }
  }

  /** Runs one maintenance pass of a kind at a time; never throws. */
  private async exclusive(kind: string, fn: () => Promise<void>): Promise<void> {
    if (this.busy.has(kind)) return;
    this.busy.add(kind);
    try {
      await fn();
    } catch (err) {
      log.error({ err, kind }, 'Maintenance pass failed');
    } finally {
      this.busy.delete(kind);
    }
  }

  private emitChanged(scope: Scope, status: 'live' | 'updated' | 'ended'): void {
    try {
      this.events.emit('live.changed', { guildId: scope.guildId, streamerId: scope.streamer.id, status });
    } catch (err) {
      log.warn({ err }, 'live.changed listener failed');
    }
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function toChannelRef(channel: Channel): ChannelRef {
  return { id: channel.id, platform: channel.platform, platformId: channel.platformId, handle: channel.handle, meta: channel.meta };
}
