import type { ProviderRegistryApi } from '../../src/app/context.js';
import { type AppConfig, loadConfig } from '../../src/config.js';
import { AppEvents, type AppEventMap } from '../../src/core/events.js';
import type { ChannelRef, ContentItem, ContentKind, LiveSnapshot, Platform, ResolvedChannel } from '../../src/core/types.js';
import { CONTENT_KINDS, PLATFORMS, offlineSnapshot } from '../../src/core/types.js';
import { openDatabase } from '../../src/db/database.js';
import type { Channel, StoredContentItem } from '../../src/db/models.js';
import { Repositories } from '../../src/db/repositories.js';
import { Monitor, type MonitorTuning } from '../../src/monitor/monitor.js';
import type { PlatformProvider, ProviderCapabilities, WebhookAdapter } from '../../src/platforms/types.js';
import { AuditService } from '../../src/services/audit.js';
import type { ContentEventHandler, LiveEventHandler } from '../../src/services/ports.js';

export const T0 = new Date('2026-10-03T12:00:00.000Z');

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({ DISCORD_TOKEN: 'token', DISCORD_CLIENT_ID: 'client', ...overrides });
}

export function liveSnap(platformId: string, over: Partial<LiveSnapshot> = {}, platform: Platform = 'twitch'): LiveSnapshot {
  return {
    platform,
    platformId,
    isLive: true,
    streamId: 's1',
    title: 'Live!',
    category: 'Just Chatting',
    categoryImageUrl: null,
    thumbnailUrl: null,
    viewers: 10,
    startedAt: null,
    url: `https://example.com/${platformId}`,
    language: 'ar',
    tags: [],
    ...over,
  };
}

export function item(contentId: string, over: Partial<ContentItem> = {}): ContentItem {
  return {
    platform: 'twitch',
    platformId: 'p',
    contentId,
    kind: 'video',
    title: `Video ${contentId}`,
    url: `https://example.com/v/${contentId}`,
    thumbnailUrl: null,
    publishedAt: new Date(Date.now() - 60_000).toISOString(),
    durationSec: 60,
    viewCount: 1,
    ...over,
  };
}

export class Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (err: unknown) => void;
  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

/** Scriptable provider: live state per platform id, content per platform id, optional failures. */
export class FakeProvider implements PlatformProvider {
  readonly capabilities: ProviderCapabilities;
  configured = true;
  readonly live = new Map<string, Partial<LiveSnapshot>>();
  readonly content = new Map<string, ContentItem[]>();
  readonly liveCalls: string[][] = [];
  readonly contentCalls: Array<{ platformId: string; kinds: ContentKind[] }> = [];
  /** Return an error to throw for a checkLive call (by requested ids), or null to answer normally. */
  liveFailure: ((ids: string[]) => unknown) | null = null;
  /** Return a promise to delay/replace a checkLive answer. */
  liveInterceptor: ((ids: string[]) => Promise<LiveSnapshot[]> | null) | null = null;
  contentFailure: ((platformId: string) => unknown) | null = null;
  webhook?: WebhookAdapter;

  constructor(
    readonly platform: Platform,
    caps: Partial<ProviderCapabilities> = {},
  ) {
    this.capabilities = { live: true, content: [...CONTENT_KINDS], liveBatchSize: 100, push: false, ...caps };
  }

  isConfigured(): boolean {
    return this.configured;
  }

  health() {
    return { configured: this.configured, notes: [] };
  }

  async resolveChannel(): Promise<ResolvedChannel> {
    throw new Error('not used in monitor tests');
  }

  setLive(platformId: string, over: Partial<LiveSnapshot> = {}): void {
    this.live.set(platformId, over);
  }

  setOffline(platformId: string): void {
    this.live.delete(platformId);
  }

  snapshotFor(ref: Pick<ChannelRef, 'platform' | 'platformId' | 'handle'>): LiveSnapshot {
    const over = this.live.get(ref.platformId);
    return over ? liveSnap(ref.platformId, over, this.platform) : offlineSnapshot(ref, `https://example.com/${ref.handle}`);
  }

  async checkLive(channels: ChannelRef[]): Promise<LiveSnapshot[]> {
    const ids = channels.map((c) => c.platformId);
    this.liveCalls.push(ids);
    const err = this.liveFailure?.(ids);
    if (err) throw err;
    const intercepted = this.liveInterceptor?.(ids);
    if (intercepted) return intercepted;
    return channels.map((c) => this.snapshotFor(c));
  }

  async fetchRecentContent(channel: ChannelRef, kinds: ContentKind[]): Promise<ContentItem[]> {
    this.contentCalls.push({ platformId: channel.platformId, kinds });
    const err = this.contentFailure?.(channel.platformId);
    if (err) throw err;
    return (this.content.get(channel.platformId) ?? []).filter((i) => kinds.includes(i.kind));
  }
}

export class FakeRegistry implements ProviderRegistryApi {
  readonly map = new Map<Platform, FakeProvider>();

  constructor(providers: FakeProvider[]) {
    for (const platform of PLATFORMS) {
      const given = providers.find((p) => p.platform === platform);
      const provider = given ?? new FakeProvider(platform);
      if (!given) provider.configured = false;
      this.map.set(platform, provider);
    }
  }

  get(platform: Platform): FakeProvider {
    return this.map.get(platform)!;
  }

  all(): PlatformProvider[] {
    return [...this.map.values()];
  }

  configured(): PlatformProvider[] {
    return this.all().filter((p) => p.isConfigured());
  }

  webhooks(): Array<{ platform: Platform; adapter: WebhookAdapter }> {
    return [...this.map.values()].filter((p) => p.isConfigured() && p.webhook).map((p) => ({ platform: p.platform, adapter: p.webhook! }));
  }
}

export interface LiveCall {
  type: 'live' | 'update' | 'offline';
  channelId: number;
  isLive: boolean;
  snapshot: LiveSnapshot | null;
  streamChanged?: boolean;
  endedAt?: string;
}

export class RecordingLiveHandler implements LiveEventHandler {
  readonly calls: LiveCall[] = [];
  /** Throw for these channel ids. */
  readonly failFor = new Set<number>();
  /** Await this before returning from onChannelLive (simulates a slow Discord call). */
  gate: Promise<void> | null = null;

  async onChannelLive(channel: Channel, snapshot: LiveSnapshot): Promise<void> {
    this.calls.push({ type: 'live', channelId: channel.id, isLive: channel.isLive, snapshot });
    if (this.gate) await this.gate;
    if (this.failFor.has(channel.id)) throw new Error('boom');
  }

  async onChannelUpdate(channel: Channel, snapshot: LiveSnapshot, info: { streamChanged: boolean }): Promise<void> {
    this.calls.push({ type: 'update', channelId: channel.id, isLive: channel.isLive, snapshot, streamChanged: info.streamChanged });
    if (this.failFor.has(channel.id)) throw new Error('boom');
  }

  async onChannelOffline(channel: Channel, lastSnapshot: LiveSnapshot | null, endedAt: string): Promise<void> {
    this.calls.push({ type: 'offline', channelId: channel.id, isLive: channel.isLive, snapshot: lastSnapshot, endedAt });
    if (this.failFor.has(channel.id)) throw new Error('boom');
  }

  types(channelId?: number): string[] {
    return this.calls.filter((c) => channelId === undefined || c.channelId === channelId).map((c) => c.type);
  }
}

export class RecordingContentHandler implements ContentEventHandler {
  readonly calls: Array<{ channelId: number; item: ContentItem; stored: StoredContentItem }> = [];
  readonly failFor = new Set<string>();

  async onNewContent(channel: Channel, item: ContentItem, stored: StoredContentItem): Promise<void> {
    this.calls.push({ channelId: channel.id, item, stored });
    if (this.failFor.has(item.contentId)) throw new Error('boom');
  }

  ids(): string[] {
    return this.calls.map((c) => c.item.contentId);
  }
}

/** Timing overrides that remove random delays so tests stay deterministic. */
export const TEST_TUNING: Partial<MonitorTuning> = {
  random: () => 0,
  batchGapMs: 0,
  // Uniform threshold keeps the state-transition tests platform-independent (production defaults differ per platform).
  offlineMisses: { twitch: 2, kick: 2, youtube: 2, tiktok: 2 },
  contentDelayMs: {
    twitch: { min: 0, max: 0 },
    kick: { min: 0, max: 0 },
    youtube: { min: 0, max: 0 },
    tiktok: { min: 0, max: 0 },
  },
};

export interface Harness {
  config: AppConfig;
  repos: Repositories;
  events: AppEvents;
  audit: AuditService;
  registry: FakeRegistry;
  live: RecordingLiveHandler;
  content: RecordingContentHandler;
  monitor: Monitor;
  health: AppEventMap['provider.health'][];
  provider(platform: Platform): FakeProvider;
  /** Registers a streamer account for a channel (creating streamer/channel as needed). */
  track(platform: Platform, platformId: string, opts?: TrackOptions): Channel;
  channel(id: number): Channel;
}

export interface TrackOptions {
  guildId?: string;
  discordUserId?: string;
  notifyContent?: boolean;
  contentKinds?: ContentKind[] | null;
  handle?: string;
}

export function createHarness(opts: { providers?: FakeProvider[]; config?: Record<string, string>; tuning?: Partial<MonitorTuning> } = {}): Harness {
  const config = testConfig(opts.config);
  const repos = new Repositories(openDatabase(':memory:'));
  const events = new AppEvents();
  const audit = new AuditService(repos, events);
  const registry = new FakeRegistry(opts.providers ?? [new FakeProvider('twitch')]);
  const live = new RecordingLiveHandler();
  const content = new RecordingContentHandler();
  const monitor = new Monitor({ config, repos, providers: registry, live, content, audit, events, tuning: { ...TEST_TUNING, ...opts.tuning } });
  const health: AppEventMap['provider.health'][] = [];
  events.on('provider.health', (e) => health.push(e));

  return {
    config,
    repos,
    events,
    audit,
    registry,
    live,
    content,
    monitor,
    health,
    provider: (platform) => registry.get(platform),
    track(platform, platformId, t = {}) {
      const guildId = t.guildId ?? 'g1';
      const discordUserId = t.discordUserId ?? `u-${platformId}`;
      const streamer =
        repos.streamers.getByDiscordId(guildId, discordUserId) ?? repos.streamers.create({ guildId, discordUserId, displayName: `Streamer ${platformId}` });
      const handle = t.handle ?? platformId;
      const channel = repos.channels.upsertResolved({
        platform,
        platformId,
        handle,
        displayName: handle.toUpperCase(),
        avatarUrl: null,
        url: `https://example.com/${handle}`,
        meta: {},
      });
      repos.accounts.create({ streamerId: streamer.id, channelId: channel.id, notifyContent: t.notifyContent, contentKinds: t.contentKinds ?? null });
      return repos.channels.get(channel.id)!;
    },
    channel: (id) => repos.channels.get(id)!,
  };
}
