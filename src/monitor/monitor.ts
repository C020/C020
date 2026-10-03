/**
 * Monitoring engine: polls every configured platform for live status and new content, reacts to webhook
 * push hints with targeted re-checks, and turns raw snapshots into ordered per-channel events for the
 * session / content services.
 *
 * Design notes
 * - Polling is the source of truth; webhooks only trigger earlier checks.
 * - Each platform runs its own self-rescheduling loops (never overlapping, drift-free, with backoff).
 * - Every state change for a channel happens under a per-channel lock, and results of fetches that
 *   started earlier than the last applied one are discarded, so concurrent cycle / hint checks can never
 *   reorder events.
 * - Nothing here throws into the caller: one bad provider response, guild or handler only affects itself.
 */
import type { MonitorApi, ProviderRegistryApi, ProviderRuntimeStatus } from '../app/context.js';
import type { AppConfig } from '../config.js';
import { ProviderError } from '../core/errors.js';
import type { AppEvents } from '../core/events.js';
import { childLogger } from '../core/logger.js';
import type { ChannelRef, ContentItem, ContentKind, LiveSnapshot, Platform } from '../core/types.js';
import { PLATFORMS, PLATFORM_LABELS, isContentKind } from '../core/types.js';
import type { Channel, GuildSettings, StoredContentItem } from '../db/models.js';
import type { Repositories } from '../db/repositories.js';
import type { PlatformProvider, PushHint } from '../platforms/types.js';
import type { AuditInput, AuditService } from '../services/audit.js';
import type { ContentEventHandler, LiveEventHandler } from '../services/ports.js';
import { CoalescingRunner, KeyedMutex, Semaphore, chunked, sleep, withTimeout } from './concurrency.js';
import { type ContentPlan, isTooOld, orderOldestFirst, planContent, sanitizeItems } from './contentPlan.js';
import {
  type LiveEvaluationOptions,
  type LiveState,
  type LiveTransition,
  evaluateSnapshot,
  forceOffline,
  isStaleLive,
  offlineConfirmationAt,
  parseTime,
} from './liveState.js';
import { type CheckKind, type Failure, type HealthTransition, PassOutcome, ProviderHealthTracker, classifyFailure } from './providerHealth.js';
import { EarliestTimer, KeyedDebouncer, TimerRegistry } from './scheduler.js';

const log = childLogger('monitor');

/** A live channel must be seen offline at least this many times in a row (plus the grace period). */
const MIN_OFFLINE_MISSES = 2;

export interface MonitorTuning {
  /** Delay before the first live cycle; later platforms are staggered by liveStaggerMs. */
  firstLiveDelayMs: number;
  liveStaggerMs: number;
  firstContentDelayMs: number;
  contentStaggerMs: number;
  /** Single-channel batches (TikTok) are spread over this fraction of the poll interval. */
  spreadFraction: number;
  /** Pause between consecutive multi-channel batches of one platform. */
  batchGapMs: number;
  /** Targeted live checks requested within this window are sent as one batch per platform. */
  targetedBatchWindowMs: number;
  hintDebounceMs: number;
  /** After a 'live' hint: re-check at these delays while the channel still does not look live. */
  liveHintRetryDelaysMs: number[];
  /** After a 'content' hint naming a content id we could not see yet: re-check after these delays. */
  contentHintRetryDelaysMs: number[];
  /** Extra wait after the grace window before the confirming offline check. */
  offlineConfirmSlackMs: number;
  minRecheckDelayMs: number;
  channelsChangedDebounceMs: number;
  webhookSyncDebounceMs: number;
  firstWebhookSyncDelayMs: number;
  webhookSyncIntervalMs: number;
  webhookSyncTimeoutMs: number;
  /**
   * Consecutive offline answers needed (on top of the grace period) before a live channel is declared offline.
   * Twitch's edge-cached Get Streams sometimes omits streams that are live; TikTok's unofficial answers flap.
   */
  offlineMisses: Record<Platform, number>;
  staleSweepIntervalMs: number;
  firstHousekeepingDelayMs: number;
  housekeepingIntervalMs: number;
  /** Concurrent checkLive() calls per platform (cycle + targeted checks). */
  liveConcurrency: Record<Platform, number>;
  /** Concurrent fetchRecentContent() calls per platform. */
  contentConcurrency: Record<Platform, number>;
  /** Random delay before each content fetch (spreads requests; Kick/TikTok web endpoints dislike bursts). */
  contentDelayMs: Record<Platform, { min: number; max: number }>;
  providerTimeoutMs: number;
  /** Max time a cycle waits for one channel's handlers before moving on (the work keeps running). */
  handlerTimeoutMs: number;
  stopTimeoutMs: number;
  /** Consecutive failures before a platform is reported as failing. */
  failAfterErrors: number;
  defaultPauseMs: number;
  maxPauseMs: number;
  /** Extra checkLive() calls per cycle allowed for bisecting a batch that failed non-retryably. */
  bisectBudget: number;
  /** Channels isolated as the cause of a batch failure are checked on their own for this long. */
  quarantineMs: number;
  /** After a bisect found nothing but failures, don't bisect that platform again for this long. */
  systemicCooldownMs: number;
  /** A channel seeded with zero items that suddenly returns more new items than this is re-baselined silently. */
  emptySeedBurstLimit: number;
  random: () => number;
}

export const DEFAULT_MONITOR_TUNING: MonitorTuning = {
  firstLiveDelayMs: 3_000,
  liveStaggerMs: 2_500,
  firstContentDelayMs: 45_000,
  contentStaggerMs: 20_000,
  spreadFraction: 0.8,
  batchGapMs: 250,
  targetedBatchWindowMs: 250,
  hintDebounceMs: 2_000,
  liveHintRetryDelaysMs: [20_000, 60_000],
  contentHintRetryDelaysMs: [90_000, 300_000],
  offlineConfirmSlackMs: 3_000,
  minRecheckDelayMs: 10_000,
  channelsChangedDebounceMs: 3_000,
  webhookSyncDebounceMs: 20_000,
  firstWebhookSyncDelayMs: 15_000,
  // Hourly: repairs revoked Twitch subscriptions and renews YouTube WebSub leases in time.
  webhookSyncIntervalMs: 3_600_000,
  webhookSyncTimeoutMs: 10 * 60_000,
  offlineMisses: { twitch: 3, kick: 2, youtube: 2, tiktok: 3 },
  staleSweepIntervalMs: 60_000,
  firstHousekeepingDelayMs: 10 * 60_000,
  housekeepingIntervalMs: 24 * 3_600_000,
  liveConcurrency: { twitch: 2, kick: 2, youtube: 2, tiktok: 1 },
  contentConcurrency: { twitch: 3, kick: 1, youtube: 3, tiktok: 1 },
  contentDelayMs: {
    twitch: { min: 0, max: 400 },
    kick: { min: 1_000, max: 2_500 },
    youtube: { min: 0, max: 400 },
    tiktok: { min: 2_000, max: 5_000 },
  },
  providerTimeoutMs: 90_000,
  handlerTimeoutMs: 60_000,
  stopTimeoutMs: 15_000,
  failAfterErrors: 2,
  defaultPauseMs: 60_000,
  maxPauseMs: 15 * 60_000,
  bisectBudget: 12,
  quarantineMs: 6 * 3_600_000,
  systemicCooldownMs: 30 * 60_000,
  emptySeedBurstLimit: 3,
  random: Math.random,
};

export interface MonitorDeps {
  config: AppConfig;
  repos: Repositories;
  providers: ProviderRegistryApi;
  live: LiveEventHandler;
  content: ContentEventHandler;
  audit: AuditService;
  events: AppEvents;
  /** Timing overrides (tests). */
  tuning?: Partial<MonitorTuning>;
}

type FetchResult = { ok: true; seq: number; snapshots: LiveSnapshot[] } | { ok: false; seq: number; error: unknown };
interface BatchResult {
  /** null = the platform answered (channel-level problems are recorded on the channels themselves). */
  failure: Failure | null;
  /** Stop the remaining batches of this pass (rate limited / not configured). */
  abort: boolean;
}
interface BisectBudget {
  remaining: number;
}
interface BisectStats {
  ok: number;
  failed: number;
  rateLimited: Failure | null;
}
interface PendingHints {
  types: Set<PushHint['type']>;
  contentIds: Set<string>;
}
/** Which content kinds of a channel already have a silent baseline (stored in kv). */
interface SeedRecord {
  kinds: ContentKind[];
  /** The channel had no content at all when it was seeded (and has had none since). */
  empty: boolean;
}
interface FreshContent {
  item: ContentItem;
  stored: StoredContentItem;
}

export function toChannelRef(channel: Channel): ChannelRef {
  return { id: channel.id, platform: channel.platform, platformId: channel.platformId, handle: channel.handle, meta: channel.meta ?? {} };
}

function stateOf(channel: Channel): LiveState {
  return {
    isLive: channel.isLive,
    snapshot: channel.liveSnapshot,
    liveSince: channel.liveSince,
    offlineSince: channel.offlineSince,
    missCount: channel.missCount,
  };
}

/** The channel as it looks in the DB right after saveLiveState(state). */
function withState(channel: Channel, state: LiveState, checkedAtMs: number): Channel {
  const at = new Date(checkedAtMs).toISOString();
  return {
    ...channel,
    isLive: state.isLive,
    liveSnapshot: state.snapshot,
    liveSince: state.liveSince,
    offlineSince: state.offlineSince,
    missCount: state.missCount,
    lastLiveCheckAt: at,
    lastError: null,
    errorCount: 0,
    updatedAt: at,
  };
}

/** Pairs snapshots with channels by platform id (exact first, then case-insensitive for handle-like ids). */
function matchSnapshots(channels: readonly Channel[], snapshots: readonly LiveSnapshot[]): Map<number, LiveSnapshot> {
  const exact = new Map<string, LiveSnapshot>();
  const loose = new Map<string, LiveSnapshot>();
  for (const snap of snapshots) {
    if (!snap || typeof snap.platformId !== 'string') continue;
    if (!exact.has(snap.platformId)) exact.set(snap.platformId, snap);
    const key = snap.platformId.toLowerCase();
    if (!loose.has(key)) loose.set(key, snap);
  }
  const out = new Map<number, LiveSnapshot>();
  for (const channel of channels) {
    const snap = exact.get(channel.platformId) ?? loose.get(channel.platformId.toLowerCase());
    if (snap) out.set(channel.id, snap);
  }
  return out;
}

const seedKey = (channelId: number): string => `monitor:content-seed:${channelId}`;

export class Monitor implements MonitorApi {
  private readonly config: AppConfig;
  private readonly repos: Repositories;
  private readonly providers: ProviderRegistryApi;
  private readonly live: LiveEventHandler;
  private readonly content: ContentEventHandler;
  private readonly audit: AuditService;
  private readonly events: AppEvents;
  private readonly tuning: MonitorTuning;
  private readonly liveOptions: LiveEvaluationOptions;
  private readonly health: ProviderHealthTracker;

  private readonly timers = new TimerRegistry();
  private readonly debouncer: KeyedDebouncer<string>;
  private readonly offlineRechecks: EarliestTimer<number>;
  private readonly channelLocks = new KeyedMutex<number>();
  private readonly contentRuns = new CoalescingRunner<number>();
  private readonly syncRuns = new CoalescingRunner<'webhooks'>();
  private readonly liveCycles = new Map<Platform, Promise<void>>();
  private readonly contentCycles = new Map<Platform, Promise<void>>();
  /** Outcome collector of the running content cycle per platform (ad-hoc checks report into it too). */
  private readonly contentPasses = new Map<Platform, PassOutcome>();
  private readonly liveGates: Record<Platform, Semaphore>;
  private readonly contentGates: Record<Platform, Semaphore>;
  private readonly inflight = new Set<Promise<void>>();

  /** channel id → last successful live check (this process). */
  private readonly lastSuccessAt = new Map<number, number>();
  /** channel id → sequence number of the newest fetch whose result was applied. */
  private readonly appliedSeq = new Map<number, number>();
  /** channel id → until when the channel is checked in its own batch. */
  private readonly quarantined = new Map<number, number>();
  private readonly notFoundReported = new Set<number>();
  private readonly pausedUntil = new Map<Platform, number>();
  private readonly systemicUntil = new Map<Platform, number>();
  private readonly pendingHints = new Map<number, PendingHints>();
  private readonly pendingLive = new Map<Platform, Set<number>>();

  private knownTracked: Set<number> | null = null;
  private fetchSeq = 0;
  private running = false;
  private stopped = false;
  private startedAtMs = Date.now();
  private abort = new AbortController();

  constructor(deps: MonitorDeps) {
    this.config = deps.config;
    this.repos = deps.repos;
    this.providers = deps.providers;
    this.live = deps.live;
    this.content = deps.content;
    this.audit = deps.audit;
    this.events = deps.events;
    this.tuning = { ...DEFAULT_MONITOR_TUNING, ...deps.tuning };
    this.liveOptions = {
      graceMs: this.config.OFFLINE_GRACE_SECONDS * 1_000,
      minMisses: MIN_OFFLINE_MISSES,
      staleMs: this.config.STALE_LIVE_MINUTES * 60_000,
    };
    this.health = new ProviderHealthTracker(this.tuning.failAfterErrors);
    const onTimerError = (err: unknown): void => log.error({ err }, 'timer callback failed');
    this.debouncer = new KeyedDebouncer(this.timers, onTimerError);
    this.offlineRechecks = new EarliestTimer(this.timers, onTimerError);
    const gates = (limits: Record<Platform, number>): Record<Platform, Semaphore> =>
      Object.fromEntries(PLATFORMS.map((p) => [p, new Semaphore(Math.max(1, limits[p] ?? 1))])) as Record<Platform, Semaphore>;
    this.liveGates = gates(this.tuning.liveConcurrency);
    this.contentGates = gates(this.tuning.contentConcurrency);
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    if (this.abort.signal.aborted) this.abort = new AbortController();
    this.startedAtMs = Date.now();
    this.knownTracked = this.safely('load tracked channels', () => new Set(this.repos.channels.listTracked().map((c) => c.id)), null);

    const t = this.tuning;
    PLATFORMS.forEach((platform, i) => {
      this.loop(`live:${platform}`, t.firstLiveDelayMs + i * t.liveStaggerMs, () => this.runLiveCycle(platform), (s) =>
        this.nextCycleDelay(platform, 'live', s),
      );
      this.loop(`content:${platform}`, t.firstContentDelayMs + i * t.contentStaggerMs, () => this.runContentCycle(platform), (s) =>
        this.nextCycleDelay(platform, 'content', s),
      );
    });
    this.loop('stale-sweep', t.staleSweepIntervalMs, () => this.runStaleSweep(), () => t.staleSweepIntervalMs);
    this.loop('webhook-sync', t.firstWebhookSyncDelayMs, () => this.syncWebhooks(), () => t.webhookSyncIntervalMs);
    this.loop('housekeeping', t.firstHousekeepingDelayMs, async () => this.runHousekeeping(), () => t.housekeepingIntervalMs);

    const configured = this.safely('list providers', () => this.providers.configured().map((p) => p.platform), []);
    log.info({ configured, trackedChannels: this.knownTracked?.size ?? 0 }, 'monitor started');
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.running = false;
    this.abort.abort();
    this.debouncer.cancelAll();
    this.offlineRechecks.cancelAll();
    this.timers.clearAll();
    this.pendingHints.clear();
    this.pendingLive.clear();
    const deadline = new AbortController();
    const timedOut = await Promise.race([
      this.whenIdle().then(() => false),
      sleep(this.tuning.stopTimeoutMs, deadline.signal).then(() => !deadline.signal.aborted),
    ]);
    deadline.abort();
    if (timedOut) log.warn({ inflight: this.inflight.size }, 'monitor stopped while some work was still running');
    else log.info('monitor stopped');
  }

  /** Resolves once no background work (cycles, targeted checks, handlers) is running. For tests and stop(). */
  async whenIdle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  // ───────────────────────────── MonitorControl / MonitorApi ─────────────────────────────

  channelsChanged(): void {
    if (this.stopped) return;
    this.debouncer.debounce('channels-changed', this.tuning.channelsChangedDebounceMs, () =>
      this.track('channel change processing', () => this.processChannelChanges()),
    );
  }

  checkNow(channelId: number): void {
    if (this.stopped) return;
    const channel = this.safely('load channel', () => this.repos.channels.get(channelId), null);
    if (!channel) return;
    this.enqueueLiveCheck(channel);
    this.track(`content check #${channelId}`, () => this.checkContent(channelId));
  }

  handleHints(hints: PushHint[]): void {
    if (this.stopped) return;
    for (const hint of hints) {
      try {
        this.acceptHint(hint);
      } catch (err) {
        log.warn({ err, hint }, 'failed to handle push hint');
      }
    }
  }

  status(): ProviderRuntimeStatus[] {
    return PLATFORMS.map((platform) => {
      const tracked = this.safely('list tracked channels', () => this.repos.channels.listTracked(platform), []);
      const health = this.health.snapshot(platform);
      return {
        platform,
        trackedChannels: tracked.length,
        liveChannels: tracked.filter((c) => c.isLive).length,
        lastSuccessAt: health.lastSuccessAt,
        lastError: health.lastError,
        consecutiveErrors: health.consecutiveErrors,
      };
    });
  }

  // ───────────────────────────── live polling ─────────────────────────────

  /** One live pass over every tracked channel of `platform`. Public for tests/internal use; never overlaps itself. */
  runLiveCycle(platform: Platform): Promise<void> {
    return this.singleFlight(this.liveCycles, platform, `live cycle (${platform})`, () => this.liveCycle(platform));
  }

  /** Live-check specific channels right away, batched per platform. Public for tests/internal use. */
  async checkLive(channelIds: readonly number[]): Promise<void> {
    const groups = new Map<Platform, Channel[]>();
    for (const id of new Set(channelIds)) {
      const channel = this.safely('load channel', () => this.repos.channels.get(id), null);
      if (!channel || !this.isTracked(id)) continue;
      const group = groups.get(channel.platform);
      if (group) group.push(channel);
      else groups.set(channel.platform, [channel]);
    }
    await Promise.all([...groups].map(([platform, channels]) => this.checkLiveTargeted(platform, channels)));
  }

  private async liveCycle(platform: Platform): Promise<void> {
    const provider = this.providerFor(platform, 'live');
    if (!provider || this.stopped || this.isPaused(platform)) return;
    const channels = this.repos.channels.listTracked(platform);
    if (channels.length === 0) return;

    const batches = this.planBatches(channels, provider);
    // Platforms without batch support (TikTok) get their requests spread over the interval instead of a burst.
    const spread = this.batchSize(provider) === 1 && batches.length > 1;
    const slotMs = spread ? (this.liveIntervalMs(platform) * this.tuning.spreadFraction) / batches.length : 0;
    const budget: BisectBudget = { remaining: this.tuning.bisectBudget };
    const pass = new PassOutcome();
    const cycleStart = Date.now();

    try {
      for (const [i, batch] of batches.entries()) {
        if (spread) await this.sleep(cycleStart + i * slotMs + this.tuning.random() * slotMs * 0.5 - Date.now());
        else if (i > 0) await this.sleep(this.tuning.batchGapMs);
        if (this.stopped || this.isPaused(platform)) return;
        const result = await this.checkLiveBatch(platform, provider, batch, budget);
        pass.add(result.failure);
        if (result.abort) return;
      }
    } finally {
      this.finishPass(platform, 'live', pass, true);
    }
  }

  private async checkLiveTargeted(platform: Platform, channels: Channel[]): Promise<void> {
    const provider = this.providerFor(platform, 'live');
    if (!provider) return;
    const budget: BisectBudget = { remaining: Math.floor(this.tuning.bisectBudget / 2) };
    const pass = new PassOutcome();
    try {
      for (const batch of this.planBatches(channels, provider)) {
        if (this.stopped) return;
        if (this.isPaused(platform)) {
          log.debug({ platform, channels: batch.length }, 'targeted live check skipped while the platform is rate limited');
          return;
        }
        const result = await this.checkLiveBatch(platform, provider, batch, budget);
        pass.add(result.failure);
        if (result.abort) return;
      }
    } finally {
      // Small targeted checks only count platform-wide failures; regular cycles judge the rest.
      this.finishPass(platform, 'live', pass, false);
    }
  }

  /** Regular batches first, then quarantined channels one by one so they cannot fail a whole batch again. */
  private planBatches(channels: readonly Channel[], provider: PlatformProvider): Channel[][] {
    const now = Date.now();
    const normal: Channel[] = [];
    const isolated: Channel[][] = [];
    for (const channel of channels) {
      if (this.isQuarantined(channel.id, now)) isolated.push([channel]);
      else normal.push(channel);
    }
    return [...chunked(normal, this.batchSize(provider)), ...isolated];
  }

  private async checkLiveBatch(platform: Platform, provider: PlatformProvider, channels: Channel[], budget: BisectBudget): Promise<BatchResult> {
    const res = await this.fetchLive(platform, provider, channels);
    if (res.ok) {
      await this.applyBatch(channels, res.snapshots, res.seq);
      return { failure: null, abort: false };
    }
    return this.handleBatchFailure(platform, provider, channels, classifyFailure(res.error), budget);
  }

  private fetchLive(platform: Platform, provider: PlatformProvider, channels: Channel[]): Promise<FetchResult> {
    return this.liveGates[platform].run(async (): Promise<FetchResult> => {
      const seq = ++this.fetchSeq;
      try {
        const snapshots = await withTimeout(provider.checkLive(channels.map(toChannelRef)), this.tuning.providerTimeoutMs, `${platform} live check`);
        if (!Array.isArray(snapshots)) throw new ProviderError(platform, 'checkLive returned a non-array result', false);
        return { ok: true, seq, snapshots };
      } catch (error) {
        return { ok: false, seq, error };
      }
    });
  }

  private async handleBatchFailure(
    platform: Platform,
    provider: PlatformProvider,
    channels: Channel[],
    failure: Failure,
    budget: BisectBudget,
  ): Promise<BatchResult> {
    log.warn({ platform, channels: channels.length, kind: failure.kind, err: failure.message }, 'live check failed');
    switch (failure.kind) {
      case 'rateLimited':
        this.pause(platform, failure.retryAfterMs, failure.message);
        await this.failChannels(channels, failure);
        return { failure, abort: true };
      case 'notConfigured':
        await this.failChannels(channels, failure);
        return { failure, abort: true };
      case 'transient':
        await this.failChannels(channels, failure);
        return { failure, abort: false };
      case 'notFound':
      case 'fatal': {
        if (channels.length === 1) {
          await this.failChannels(channels, failure);
          // "Not found" is an answer about that channel: the platform itself works.
          return { failure: failure.kind === 'notFound' ? null : failure, abort: false };
        }
        if (!this.canBisect(platform, budget)) {
          await this.failChannels(channels, failure);
          return { failure, abort: false };
        }
        const stats: BisectStats = { ok: 0, failed: 0, rateLimited: null };
        await this.isolateFailures(platform, provider, channels, failure, budget, stats);
        if (stats.rateLimited) return { failure: stats.rateLimited, abort: true };
        if (stats.ok > 0) return { failure: null, abort: false };
        this.systemicUntil.set(platform, Date.now() + this.tuning.systemicCooldownMs);
        return { failure, abort: false };
      }
    }
  }

  /**
   * Bisects a batch that failed with a non-retryable error to find the channel(s) causing it, so one bad
   * channel cannot blind the monitor to the rest of its batch. Isolated culprits are quarantined (checked
   * alone in later cycles). Stops early when the failure looks systemic (several failed halves and no
   * success) or when the per-pass budget is spent.
   */
  private async isolateFailures(
    platform: Platform,
    provider: PlatformProvider,
    channels: Channel[],
    failure: Failure,
    budget: BisectBudget,
    stats: BisectStats,
  ): Promise<void> {
    const mid = Math.ceil(channels.length / 2);
    for (const half of [channels.slice(0, mid), channels.slice(mid)]) {
      if (half.length === 0) continue;
      if (this.stopped || this.isPaused(platform)) return;
      if (budget.remaining <= 0 || (stats.failed >= 4 && stats.ok === 0)) {
        await this.failChannels(half, failure);
        continue;
      }
      budget.remaining--;
      const res = await this.fetchLive(platform, provider, half);
      if (res.ok) {
        stats.ok++;
        await this.applyBatch(half, res.snapshots, res.seq);
        continue;
      }
      stats.failed++;
      const sub = classifyFailure(res.error);
      if (sub.kind === 'rateLimited') {
        this.pause(platform, sub.retryAfterMs, sub.message);
        stats.rateLimited = sub;
        await this.failChannels(half, sub);
        return;
      }
      const channelLevel = sub.kind === 'fatal' || sub.kind === 'notFound';
      if (channelLevel && half.length > 1) {
        await this.isolateFailures(platform, provider, half, sub, budget, stats);
        continue;
      }
      if (channelLevel && half[0]) this.quarantine(half[0], sub);
      await this.failChannels(half, sub);
    }
  }

  private async applyBatch(channels: readonly Channel[], snapshots: readonly LiveSnapshot[], seq: number): Promise<void> {
    const matched = matchSnapshots(channels, snapshots);
    for (const channel of channels) {
      const snapshot = matched.get(channel.id);
      if (!snapshot) {
        // Treat a missing snapshot as "unknown", never as offline.
        await this.recordChannelFailure(channel, { kind: 'transient', message: 'Provider returned no snapshot for this channel', retryAfterMs: null });
        continue;
      }
      await this.withChannelLock(channel.id, () => this.applySnapshot(channel.id, snapshot, seq));
    }
  }

  /** Runs under the channel lock. */
  private async applySnapshot(channelId: number, snapshot: LiveSnapshot, seq: number): Promise<void> {
    const channel = this.repos.channels.get(channelId);
    if (!channel) return;
    if (seq < (this.appliedSeq.get(channelId) ?? 0)) {
      log.debug({ channelId, seq }, 'discarding out-of-order live result');
      return;
    }
    this.appliedSeq.set(channelId, seq);

    const now = Date.now();
    const normalized: LiveSnapshot = {
      ...snapshot,
      platform: channel.platform,
      platformId: channel.platformId,
      isLive: snapshot.isLive === true,
      tags: Array.isArray(snapshot.tags) ? snapshot.tags : [],
    };
    const transitions = evaluateSnapshot(stateOf(channel), normalized, now, this.liveOptionsFor(channel.platform), this.knownLastSuccess(channel));
    this.lastSuccessAt.set(channelId, now);
    this.quarantined.delete(channelId);
    this.notFoundReported.delete(channelId);

    let current = channel;
    for (const transition of transitions) {
      this.repos.channels.saveLiveState(channelId, transition.state);
      current = withState(current, transition.state, now);
      this.logTransition(current, transition);
      await this.dispatch(current, transition);
    }
    this.scheduleOfflineConfirmation(current);
  }

  private liveOptionsFor(platform: Platform): LiveEvaluationOptions {
    return { ...this.liveOptions, minMisses: Math.max(1, this.tuning.offlineMisses[platform] ?? MIN_OFFLINE_MISSES) };
  }

  private async dispatch(channel: Channel, transition: LiveTransition): Promise<void> {
    const { event, state } = transition;
    if (!event) return;
    try {
      if (event === 'offline') {
        await this.live.onChannelOffline(channel, transition.lastSnapshot, transition.endedAt ?? new Date().toISOString());
      } else if (state.snapshot) {
        if (event === 'live') await this.live.onChannelLive(channel, state.snapshot);
        else await this.live.onChannelUpdate(channel, state.snapshot, { streamChanged: transition.streamChanged });
      }
    } catch (err) {
      log.error({ err, channelId: channel.id, platform: channel.platform, event }, 'live event handler failed');
    }
  }

  private logTransition(channel: Channel, t: LiveTransition): void {
    const base = { channelId: channel.id, platform: channel.platform, handle: channel.handle };
    if (t.event === 'live') log.info({ ...base, streamId: t.state.snapshot?.streamId, title: t.state.snapshot?.title }, 'channel went live');
    else if (t.event === 'offline') log.info({ ...base, endedAt: t.endedAt }, 'channel went offline');
    else if (t.event === 'update' && t.streamChanged) log.info({ ...base, streamId: t.state.snapshot?.streamId }, 'stream id changed while live');
    else if (!t.event && t.state.isLive) log.debug({ ...base, misses: t.state.missCount }, 'channel looks offline; waiting for the grace period');
  }

  /** While an offline is pending, check again right when it can be confirmed instead of waiting for the next cycle. */
  private scheduleOfflineConfirmation(channel: Channel): void {
    const confirmAt = offlineConfirmationAt(stateOf(channel), this.liveOptionsFor(channel.platform));
    if (confirmAt === null) {
      this.offlineRechecks.cancel(channel.id);
      return;
    }
    const at = Math.max(confirmAt + this.tuning.offlineConfirmSlackMs, Date.now() + this.tuning.minRecheckDelayMs);
    this.offlineRechecks.schedule(channel.id, at, () => {
      if (this.stopped) return;
      const fresh = this.repos.channels.get(channel.id);
      if (fresh?.isLive && fresh.missCount > 0) this.enqueueLiveCheck(fresh);
    });
  }

  private async failChannels(channels: readonly Channel[], failure: Failure): Promise<void> {
    for (const channel of channels) await this.recordChannelFailure(channel, failure);
  }

  private async recordChannelFailure(channel: Channel, failure: Failure): Promise<void> {
    this.safely('record channel error', () => this.repos.channels.recordError(channel.id, failure.message), undefined);
    if (failure.kind === 'notFound') this.reportNotFound(channel);
    await this.endIfStale(channel.id);
  }

  private quarantine(channel: Channel, failure: Failure): void {
    if (!this.quarantined.has(channel.id)) {
      log.warn({ channelId: channel.id, platform: channel.platform, handle: channel.handle, err: failure.message }, 'channel breaks batched live checks; checking it on its own');
    }
    this.quarantined.set(channel.id, Date.now() + this.tuning.quarantineMs);
  }

  private isQuarantined(channelId: number, now: number): boolean {
    const until = this.quarantined.get(channelId);
    if (until === undefined) return false;
    if (until > now) return true;
    this.quarantined.delete(channelId);
    return false;
  }

  private canBisect(platform: Platform, budget: BisectBudget): boolean {
    return budget.remaining >= 2 && (this.systemicUntil.get(platform) ?? 0) <= Date.now();
  }

  // ───────────────────────────── forced offline (stale / untracked) ─────────────────────────────

  /** Ends stale live states and live states of channels nobody tracks anymore. Public for tests/internal use. */
  async runStaleSweep(): Promise<void> {
    const tracked = new Set(this.repos.channels.listTracked().map((c) => c.id));
    const all = this.repos.channels.listAll();
    for (const channel of all) {
      if (this.stopped) return;
      if (!channel.isLive) continue;
      if (!tracked.has(channel.id)) await this.endLive(channel.id, 'untracked');
      else await this.endIfStale(channel.id);
    }
    this.pruneMemory(new Set(all.map((c) => c.id)));
  }

  private async endIfStale(channelId: number): Promise<void> {
    const channel = this.safely('load channel', () => this.repos.channels.get(channelId), null);
    if (channel?.isLive && isStaleLive(true, this.staleReference(channel), Date.now(), this.liveOptions.staleMs)) {
      await this.endLive(channelId, 'stale');
    }
  }

  private endLive(channelId: number, reason: 'stale' | 'untracked'): Promise<void> {
    return this.withChannelLock(channelId, async () => {
      const channel = this.repos.channels.get(channelId);
      if (!channel?.isLive) return;
      const now = Date.now();
      // Re-evaluate under the lock: a successful check may have landed in the meantime.
      if (reason === 'stale' && !isStaleLive(true, this.staleReference(channel), now, this.liveOptions.staleMs)) return;

      const transition = forceOffline(stateOf(channel), reason === 'stale' ? (this.knownLastSuccess(channel) ?? now) : now);
      // Results of fetches that started before this decision must not resurrect the old state.
      this.appliedSeq.set(channelId, this.fetchSeq + 1);
      this.offlineRechecks.cancel(channelId);
      this.repos.channels.saveLiveState(channelId, transition.state);
      const current = withState(channel, transition.state, now);

      if (reason === 'stale') {
        const minutes = this.config.STALE_LIVE_MINUTES;
        this.safely('record channel error', () => this.repos.channels.recordError(channelId, `No successful live check for ${minutes} minutes; forced offline`), undefined);
        this.recordAudit({
          action: 'live.forced_offline',
          level: 'warn',
          message: `تم اعتبار ${channel.displayName} على ${PLATFORM_LABELS[channel.platform]} أوفلاين لأن البوت ما قدر يتأكد من حالة البث لأكثر من ${minutes} دقيقة.`,
          details: { channelId, platform: channel.platform, handle: channel.handle, endedAt: transition.endedAt },
        });
        log.warn({ channelId, platform: channel.platform, handle: channel.handle }, 'live channel went stale; forcing offline');
      } else {
        log.info({ channelId, platform: channel.platform, handle: channel.handle }, 'live channel is no longer tracked; ending its live state');
      }
      await this.dispatch(current, transition);
    });
  }

  /** Last successful live check we know of: this process, else the DB (only exact when no error came after it). */
  private knownLastSuccess(channel: Channel): number | null {
    return this.lastSuccessAt.get(channel.id) ?? (channel.errorCount === 0 ? parseTime(channel.lastLiveCheckAt) : null);
  }

  /** Staleness never counts time before this process started, so a restart cannot instantly end streams. */
  private staleReference(channel: Channel): number {
    return Math.max(this.knownLastSuccess(channel) ?? 0, this.startedAtMs);
  }

  private pruneMemory(existing: ReadonlySet<number>): void {
    for (const map of [this.lastSuccessAt, this.appliedSeq, this.quarantined]) {
      for (const id of map.keys()) if (!existing.has(id)) map.delete(id);
    }
    for (const id of this.notFoundReported) if (!existing.has(id)) this.notFoundReported.delete(id);
  }

  // ───────────────────────────── content polling ─────────────────────────────

  /** One content pass over every tracked channel of `platform`. Public for tests/internal use; never overlaps itself. */
  runContentCycle(platform: Platform): Promise<void> {
    return this.singleFlight(this.contentCycles, platform, `content cycle (${platform})`, () => this.contentCycle(platform));
  }

  /** Content check for one channel (silent seeding the first time). Public for tests/internal use; coalesces per channel. */
  checkContent(channelId: number): Promise<void> {
    return this.contentRuns.run(channelId, () => this.contentCheck(channelId));
  }

  private async contentCycle(platform: Platform): Promise<void> {
    const provider = this.providerFor(platform, 'content');
    if (!provider || this.stopped || this.isPaused(platform)) return;
    const settings = new Map<string, GuildSettings>();
    const due = this.repos.channels.listTracked(platform).filter((c) => this.contentPlanFor(c, provider, settings).kinds.length > 0);
    const pass = new PassOutcome();
    this.contentPasses.set(platform, pass);
    try {
      // The per-platform gate limits concurrency; checks queue up in order.
      await Promise.all(due.map((c) => this.checkContent(c.id)));
    } finally {
      this.contentPasses.delete(platform);
      this.finishPass(platform, 'content', pass, true);
    }
  }

  private async contentCheck(channelId: number): Promise<void> {
    const initial = this.repos.channels.get(channelId);
    if (!initial) return;
    const platform = initial.platform;
    const provider = this.providerFor(platform, 'content');
    if (!provider) return;

    const fetched = await this.contentGates[platform].run(async () => {
      const { min, max } = this.tuning.contentDelayMs[platform];
      await this.sleep(min + this.tuning.random() * Math.max(0, max - min));
      if (this.stopped || this.isPaused(platform)) return null;
      const channel = this.repos.channels.get(channelId);
      if (!channel) return null;
      const plan = this.contentPlanFor(channel, provider);
      if (plan.kinds.length === 0) return null;
      try {
        const items = await withTimeout(provider.fetchRecentContent(toChannelRef(channel), plan.kinds), this.tuning.providerTimeoutMs, `${platform} content check`);
        if (!Array.isArray(items)) throw new ProviderError(platform, 'fetchRecentContent returned a non-array result', false);
        return { channel, plan, items };
      } catch (err) {
        this.onContentFailure(channel, classifyFailure(err));
        return null;
      }
    });
    if (!fetched) return;
    this.noteContentOutcome(platform, null);

    let fresh: FreshContent[];
    try {
      fresh = this.storeContent(fetched.channel, fetched.items, fetched.plan);
    } catch (err) {
      log.error({ err, channelId, platform }, 'failed to store content items');
      return;
    }
    if (fresh.length === 0) return;
    const channel = this.repos.channels.get(channelId) ?? fetched.channel;
    for (const { item, stored } of fresh) await this.deliverContent(channel, item, stored);
  }

  /**
   * Stores fetched items and returns the ones to announce (oldest first). Items are stored silently when:
   * the channel was never seeded (first check), their kind has no baseline yet (kind just enabled), they
   * are older than every interested guild accepts, or a channel seeded with nothing suddenly returns a burst.
   */
  private storeContent(channel: Channel, items: ContentItem[], plan: ContentPlan): FreshContent[] {
    const now = Date.now();
    const ordered = orderOldestFirst(sanitizeItems(items, plan.kinds)).map((item) => ({ ...item, platform: channel.platform, platformId: channel.platformId }));
    const key = seedKey(channel.id);

    return this.repos.tx(() => {
      if (!channel.contentSeeded) {
        for (const item of ordered) this.repos.content.insert(channel.id, item, false);
        this.repos.channels.markContentChecked(channel.id, true);
        this.repos.kv.set(key, { kinds: plan.kinds, empty: ordered.length === 0 } satisfies SeedRecord);
        log.info({ channelId: channel.id, platform: channel.platform, handle: channel.handle, items: ordered.length }, 'content baseline stored (no notifications)');
        return [];
      }

      const seed = this.readSeed(key);
      const baselined = new Set(seed?.kinds ?? plan.kinds);
      let fresh: FreshContent[] = [];
      let silent = 0;
      for (const item of ordered) {
        const { item: stored, inserted } = this.repos.content.insert(channel.id, item, false);
        if (!inserted) continue;
        if (!baselined.has(item.kind) || isTooOld(item, plan.maxAgeMs, now)) silent++;
        else fresh.push({ item, stored });
      }
      const wasEmpty = seed?.empty ?? false;
      if (wasEmpty && fresh.length > this.tuning.emptySeedBurstLimit) {
        log.warn({ channelId: channel.id, platform: channel.platform, items: fresh.length }, 'channel seeded empty returned a burst of items; storing them as the baseline');
        silent += fresh.length;
        fresh = [];
      }
      this.repos.channels.markContentChecked(channel.id, true);
      this.repos.kv.set(key, { kinds: plan.kinds, empty: wasEmpty && ordered.length === 0 } satisfies SeedRecord);
      if (silent > 0) log.debug({ channelId: channel.id, platform: channel.platform, silent }, 'new items stored without notification');
      return fresh;
    });
  }

  private readSeed(key: string): SeedRecord | null {
    const raw = this.safely('read content seed', () => this.repos.kv.get<unknown>(key), undefined);
    if (!raw || typeof raw !== 'object' || !Array.isArray((raw as SeedRecord).kinds)) return null;
    const record = raw as SeedRecord;
    return { kinds: record.kinds.filter(isContentKind), empty: record.empty === true };
  }

  private async deliverContent(channel: Channel, item: ContentItem, stored: StoredContentItem): Promise<void> {
    log.info({ channelId: channel.id, platform: channel.platform, kind: item.kind, contentId: item.contentId, title: item.title }, 'new content detected');
    const run = (async () => {
      try {
        await this.content.onNewContent(channel, item, stored);
      } catch (err) {
        log.error({ err, channelId: channel.id, contentId: item.contentId }, 'content event handler failed');
      }
    })();
    try {
      await withTimeout(run, this.tuning.handlerTimeoutMs, 'content handler');
    } catch {
      log.warn({ channelId: channel.id, contentId: item.contentId }, 'content handler is slow; continuing without waiting');
      this.track('slow content handler', () => run);
    }
  }

  private onContentFailure(channel: Channel, failure: Failure): void {
    const base = { channelId: channel.id, platform: channel.platform, handle: channel.handle, err: failure.message };
    if (failure.kind === 'rateLimited') this.pause(channel.platform, failure.retryAfterMs, failure.message);
    if (failure.kind === 'notFound') {
      log.warn(base, 'content check: channel not found');
      this.reportNotFound(channel);
      this.noteContentOutcome(channel.platform, null);
      return;
    }
    log.warn({ ...base, kind: failure.kind }, 'content check failed');
    this.noteContentOutcome(channel.platform, failure);
  }

  private noteContentOutcome(platform: Platform, failure: Failure | null): void {
    const pass = this.contentPasses.get(platform);
    if (pass) {
      pass.add(failure);
      return;
    }
    const single = new PassOutcome();
    single.add(failure);
    this.finishPass(platform, 'content', single, false);
  }

  private contentPlanFor(channel: Channel, provider: PlatformProvider, cache = new Map<string, GuildSettings>()): ContentPlan {
    const settingsOf = (guildId: string): GuildSettings => {
      let settings = cache.get(guildId);
      if (!settings) {
        settings = this.repos.settings.get(guildId);
        cache.set(guildId, settings);
      }
      return settings;
    };
    return planContent(channel.platform, this.repos.accounts.subscribersOf(channel.id), settingsOf, provider.capabilities.content);
  }

  // ───────────────────────────── push hints ─────────────────────────────

  private acceptHint(hint: PushHint): void {
    const channel = this.repos.channels.getByPlatformId(hint.platform, hint.platformId);
    if (!channel || !this.isTracked(channel.id)) {
      log.debug({ hint }, 'push hint for an untracked channel ignored');
      return;
    }
    const pending = this.pendingHints.get(channel.id) ?? { types: new Set(), contentIds: new Set() };
    pending.types.add(hint.type);
    if (hint.contentId) pending.contentIds.add(hint.contentId);
    this.pendingHints.set(channel.id, pending);
    this.debouncer.debounce(`hint:${channel.id}`, this.tuning.hintDebounceMs, () => this.processHints(channel.id));
  }

  private processHints(channelId: number): void {
    const pending = this.pendingHints.get(channelId);
    this.pendingHints.delete(channelId);
    if (!pending || this.stopped) return;
    const channel = this.repos.channels.get(channelId);
    if (!channel) return;
    const { types, contentIds } = pending;
    log.debug({ channelId, platform: channel.platform, types: [...types] }, 'processing push hints');

    // A YouTube upload ping can also mean a new live broadcast.
    const wantsLive = types.has('live') || types.has('offline') || types.has('metadata') || (types.has('content') && channel.platform === 'youtube');
    if (wantsLive) this.enqueueLiveCheck(channel);
    // Platform APIs lag behind their webhooks: keep looking for a while.
    if (types.has('live')) {
      for (const delay of this.tuning.liveHintRetryDelaysMs) this.followUpLive(channelId, delay, (c) => !c.isLive || c.missCount > 0);
    }
    if (types.has('offline')) {
      this.followUpLive(channelId, this.liveOptions.graceMs + this.tuning.offlineConfirmSlackMs, (c) => c.isLive);
    }
    if (types.has('content')) {
      this.track(`content hint #${channelId}`, async () => {
        await this.checkContent(channelId);
        this.followUpContent(channelId, [...contentIds], 0);
      });
    }
  }

  private followUpLive(channelId: number, delayMs: number, condition: (channel: Channel) => boolean): void {
    this.timers.timeout(
      delayMs,
      () => {
        if (this.stopped) return;
        const channel = this.repos.channels.get(channelId);
        if (channel && condition(channel)) this.enqueueLiveCheck(channel);
      },
      (err) => log.error({ err, channelId }, 'live follow-up failed'),
    );
  }

  private followUpContent(channelId: number, contentIds: string[], attempt: number): void {
    const delay = this.tuning.contentHintRetryDelaysMs[attempt];
    if (delay === undefined || contentIds.length === 0 || this.stopped) return;
    const missing = contentIds.filter((id) => !this.repos.content.has(channelId, id));
    if (missing.length === 0) return;
    this.timers.timeout(
      delay,
      () => {
        if (this.stopped) return;
        this.track(`content hint retry #${channelId}`, async () => {
          await this.checkContent(channelId);
          this.followUpContent(channelId, missing, attempt + 1);
        });
      },
      (err) => log.error({ err, channelId }, 'content follow-up failed'),
    );
  }

  /** Queues a targeted live check; requests within a short window are batched per platform. */
  private enqueueLiveCheck(channel: Channel): void {
    if (this.stopped || !this.providerFor(channel.platform, 'live')) return;
    const { platform } = channel;
    let pending = this.pendingLive.get(platform);
    if (!pending) {
      pending = new Set();
      this.pendingLive.set(platform, pending);
      this.timers.timeout(
        this.tuning.targetedBatchWindowMs,
        () => {
          const ids = [...(this.pendingLive.get(platform) ?? [])];
          this.pendingLive.delete(platform);
          if (ids.length > 0 && !this.stopped) this.track(`targeted live check (${platform})`, () => this.checkLive(ids));
        },
        (err) => log.error({ err, platform }, 'targeted live check failed'),
      );
    }
    pending.add(channel.id);
  }

  // ───────────────────────────── channel set changes / webhooks / housekeeping ─────────────────────────────

  private async processChannelChanges(): Promise<void> {
    const tracked = this.repos.channels.listTracked();
    const previous = this.knownTracked;
    this.knownTracked = new Set(tracked.map((c) => c.id));
    // Without a baseline (not started yet) treat channels that were never checked as new.
    const added = previous ? tracked.filter((c) => !previous.has(c.id)) : tracked.filter((c) => !c.contentSeeded || c.lastLiveCheckAt === null);
    if (added.length > 0) log.info({ channels: added.map((c) => `${c.platform}:${c.handle}`) }, 'new tracked channels; checking now');
    for (const channel of added) {
      this.enqueueLiveCheck(channel);
      this.track(`content seed #${channel.id}`, () => this.checkContent(channel.id));
    }
    await this.runStaleSweep();
    this.debouncer.debounce('webhook-sync', this.tuning.webhookSyncDebounceMs, () => this.track('webhook sync', () => this.syncWebhooks()));
  }

  /** Makes webhook subscriptions match the tracked channels. Public for tests/internal use; never overlaps itself. */
  syncWebhooks(): Promise<void> {
    return this.syncRuns.run('webhooks', () => this.syncWebhooksNow());
  }

  private async syncWebhooksNow(): Promise<void> {
    const adapters = this.safely('list webhook adapters', () => this.providers.webhooks(), []);
    for (const { platform, adapter } of adapters) {
      if (this.stopped) return;
      try {
        const refs = this.repos.channels.listTracked(platform).map(toChannelRef);
        await withTimeout(adapter.sync(refs), this.tuning.webhookSyncTimeoutMs, `${platform} webhook sync`);
        log.info({ platform, channels: refs.length }, 'webhook subscriptions synced');
      } catch (err) {
        log.error({ err, platform }, 'webhook sync failed');
      }
    }
  }

  /** Daily DB pruning. Public for tests/internal use. */
  runHousekeeping(): void {
    const pruned = {
      contentItems: this.safely('prune content', () => this.repos.content.prune(), 0),
      auditEntries: this.safely('prune audit log', () => this.repos.audit.prune(), 0),
      webSessions: this.safely('prune web sessions', () => this.repos.webSessions.pruneExpired(), 0),
    };
    log.info(pruned, 'housekeeping done');
  }

  // ───────────────────────────── health / pausing ─────────────────────────────

  private finishPass(platform: Platform, kind: CheckKind, pass: PassOutcome, countChannelFailures: boolean): void {
    const verdict = pass.verdict(countChannelFailures);
    if (verdict !== undefined) this.recordHealth(platform, kind, verdict);
  }

  private recordHealth(platform: Platform, kind: CheckKind, failure: Failure | null): void {
    const now = Date.now();
    const transition = failure
      ? this.health.recordFailure(platform, kind, failure.message, failure.kind === 'notConfigured', now)
      : this.health.recordSuccess(platform, kind, now);
    if (transition) this.announceHealth(transition);
  }

  private announceHealth(t: HealthTransition): void {
    const label = PLATFORM_LABELS[t.platform];
    try {
      this.events.emit('provider.health', { platform: t.platform, ok: t.ok, message: t.message });
    } catch (err) {
      log.error({ err }, 'provider.health listener failed');
    }
    if (t.ok) {
      log.info({ platform: t.platform }, 'provider recovered');
      this.recordAudit({ action: 'provider.recovered', level: 'info', message: `رجع الاتصال بمنصة ${label} والمراقبة شغالة طبيعي.`, details: { platform: t.platform } });
    } else {
      log.warn({ platform: t.platform, check: t.kind, err: t.message }, 'provider failing');
      this.recordAudit({
        action: 'provider.failing',
        level: 'warn',
        message: `فيه مشكلة في الاتصال بمنصة ${label} (${t.kind === 'live' ? 'فحص البث' : 'فحص المحتوى'}). البوت بيعيد المحاولة تلقائياً.`,
        details: { platform: t.platform, check: t.kind, error: t.message },
      });
    }
  }

  private pause(platform: Platform, retryAfterMs: number | null, reason: string): void {
    const ms = Math.min(Math.max(retryAfterMs ?? this.tuning.defaultPauseMs, 1_000), this.tuning.maxPauseMs);
    const until = Date.now() + ms;
    if (until <= (this.pausedUntil.get(platform) ?? 0)) return;
    this.pausedUntil.set(platform, until);
    log.warn({ platform, pauseMs: ms, reason }, 'rate limited; pausing checks for this platform');
  }

  private isPaused(platform: Platform): boolean {
    return (this.pausedUntil.get(platform) ?? 0) > Date.now();
  }

  private reportNotFound(channel: Channel): void {
    if (this.notFoundReported.has(channel.id)) return;
    this.notFoundReported.add(channel.id);
    const label = PLATFORM_LABELS[channel.platform];
    const guildIds = new Set(this.safely('list subscribers', () => this.repos.accounts.subscribersOf(channel.id), []).map((s) => s.guildId));
    for (const guildId of guildIds) {
      this.recordAudit({
        guildId,
        action: 'channel.not_found',
        level: 'warn',
        message: `ما قدرنا نلقى حساب ${channel.displayName} (${channel.handle}) على ${label}. يمكن انحذف أو تغيّر اسمه، راجعه من لوحة التحكم.`,
        details: { channelId: channel.id, platform: channel.platform, handle: channel.handle },
      });
    }
  }

  private recordAudit(input: AuditInput): void {
    try {
      this.audit.record(input);
    } catch (err) {
      log.error({ err, action: input.action }, 'failed to record audit entry');
    }
  }

  // ───────────────────────────── small helpers ─────────────────────────────

  private providerFor(platform: Platform, need: 'live' | 'content'): PlatformProvider | null {
    try {
      const provider = this.providers.get(platform);
      if (!provider.isConfigured()) return null;
      if (need === 'live' ? !provider.capabilities.live : provider.capabilities.content.length === 0) return null;
      return provider;
    } catch (err) {
      log.error({ err, platform }, 'provider lookup failed');
      return null;
    }
  }

  private isTracked(channelId: number): boolean {
    return this.safely('list subscribers', () => this.repos.accounts.subscribersOf(channelId).length > 0, false);
  }

  private batchSize(provider: PlatformProvider): number {
    return Math.max(1, Math.floor(provider.capabilities.liveBatchSize || 1));
  }

  private liveIntervalMs(platform: Platform): number {
    const c = this.config;
    const seconds = { twitch: c.POLL_TWITCH_LIVE, kick: c.POLL_KICK_LIVE, youtube: c.POLL_YOUTUBE_LIVE, tiktok: c.POLL_TIKTOK_LIVE }[platform];
    return seconds * 1_000;
  }

  private contentIntervalMs(platform: Platform): number {
    return (platform === 'tiktok' ? this.config.POLL_TIKTOK_CONTENT : this.config.POLL_CONTENT) * 1_000;
  }

  /** Next run of a polling loop: drift-free interval, backoff after repeated failures, honours rate-limit pauses. */
  private nextCycleDelay(platform: Platform, kind: CheckKind, startedAtMs: number): number {
    const interval = kind === 'live' ? this.liveIntervalMs(platform) : this.contentIntervalMs(platform);
    const errors = this.health.consecutiveErrors(platform, kind);
    const backoff = errors >= 3 ? Math.min(4, 2 ** (errors - 2)) : 1;
    const jitter = this.tuning.random() * interval * 0.03;
    const at = Math.max(startedAtMs + interval * backoff + jitter, this.pausedUntil.get(platform) ?? 0);
    return Math.max(1_000, at - Date.now());
  }

  /** Self-rescheduling timer loop (the next run is planned only after the current one finished). */
  private loop(name: string, delayMs: number, task: () => Promise<void>, nextDelay: (startedAtMs: number) => number): void {
    if (this.stopped) return;
    this.timers.timeout(
      delayMs,
      () => {
        const startedAt = Date.now();
        this.track(name, async () => {
          try {
            await task();
          } catch (err) {
            log.error({ err, task: name }, 'scheduled task failed');
          }
          if (this.running && !this.stopped) this.loop(name, nextDelay(startedAt), task, nextDelay);
        });
      },
      (err) => log.error({ err, task: name }, 'scheduled task failed to start'),
    );
  }

  private singleFlight(map: Map<Platform, Promise<void>>, platform: Platform, name: string, run: () => Promise<void>): Promise<void> {
    const running = map.get(platform);
    if (running) return running;
    const promise = run()
      .catch((err: unknown) => log.error({ err, task: name }, 'cycle failed'))
      .finally(() => map.delete(platform));
    map.set(platform, promise);
    return promise;
  }

  /** Runs one channel task under its lock; the caller waits at most handlerTimeoutMs (order is still preserved). */
  private async withChannelLock(channelId: number, task: () => Promise<void>): Promise<void> {
    const run = this.channelLocks.run(channelId, async () => {
      try {
        await task();
      } catch (err) {
        log.error({ err, channelId }, 'channel update failed');
      }
    });
    try {
      await withTimeout(run, this.tuning.handlerTimeoutMs, 'channel update');
    } catch {
      log.warn({ channelId, timeoutMs: this.tuning.handlerTimeoutMs }, 'channel update is slow; continuing without waiting (events for the channel stay ordered)');
      this.track(`slow channel update #${channelId}`, () => run);
    }
  }

  /** Fire-and-forget with error logging; stop()/whenIdle() wait for tracked work. */
  private track(name: string, fn: () => Promise<unknown>): void {
    const promise = (async () => {
      try {
        await fn();
      } catch (err) {
        log.error({ err, task: name }, 'background task failed');
      }
    })();
    this.inflight.add(promise);
    void promise.finally(() => this.inflight.delete(promise));
  }

  private sleep(ms: number): Promise<void> {
    return sleep(ms, this.abort.signal);
  }

  private safely<T>(what: string, fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (err) {
      log.error({ err }, `${what} failed`);
      return fallback;
    }
  }
}

