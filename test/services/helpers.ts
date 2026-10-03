/** Shared fakes for the services tests (no Discord, no network). */
import type { ProviderRegistryApi } from '../../src/app/context.js';
import { ChannelNotFoundError } from '../../src/core/errors.js';
import { AppEvents, type AppEventMap } from '../../src/core/events.js';
import type { ChannelRef, ContentItem, LiveSnapshot, Platform, ResolvedChannel } from '../../src/core/types.js';
import { PLATFORMS } from '../../src/core/types.js';
import { openDatabase } from '../../src/db/database.js';
import type { Channel, GuildSettingsPatch, Streamer } from '../../src/db/models.js';
import { Repositories } from '../../src/db/repositories.js';
import type { PlatformProvider } from '../../src/platforms/types.js';
import { AuditService } from '../../src/services/audit.js';
import type {
  ContentView,
  DiscordGateway,
  DiscordMemberInfo,
  GuildDiagnostics,
  LiveView,
  MessageRef,
  MonitorControl,
  Notifier,
  RoleManager,
  SummaryView,
} from '../../src/services/ports.js';

export const T0 = Date.parse('2026-10-03T12:00:00.000Z');
export const MIN = 60_000;

export class FakeClock {
  constructor(public now = T0) {}
  readonly fn = (): number => this.now;
  advance(ms: number): number {
    this.now += ms;
    return this.now;
  }
  iso(offsetMs = 0): string {
    return new Date(this.now + offsetMs).toISOString();
  }
}

export class FakeNotifier implements Notifier {
  readonly posts: Array<{ ref: MessageRef; view: LiveView }> = [];
  readonly updates: Array<{ ref: MessageRef; view: LiveView }> = [];
  /** Every live render (post or edit) in order. */
  readonly renders: Array<{ kind: 'post' | 'update'; ref: MessageRef; view: LiveView }> = [];
  readonly summaries: Array<{ ref: MessageRef | null; view: SummaryView; result: MessageRef | null }> = [];
  readonly contents: Array<{ view: ContentView; ref: MessageRef | null }> = [];
  readonly logs: Array<{ guildId: string; message: string }> = [];
  /** Message ids that were deleted in Discord. */
  readonly deleted = new Set<string>();
  /** Upcoming postContent calls that fail (return null). */
  failContent = 0;
  throwOnContent = false;
  throwOnUpdate = false;
  private seq = 0;

  async postLive(view: LiveView): Promise<MessageRef | null> {
    if (!view.settings.liveChannelId) return null;
    const ref = { channelId: view.settings.liveChannelId, messageId: `live-${++this.seq}` };
    const entry = { ref, view: clone(view) };
    this.posts.push(entry);
    this.renders.push({ kind: 'post', ...entry });
    return ref;
  }

  async updateLive(ref: MessageRef, view: LiveView): Promise<boolean> {
    if (this.throwOnUpdate) throw new Error('discord down');
    if (this.deleted.has(ref.messageId)) return false;
    const entry = { ref, view: clone(view) };
    this.updates.push(entry);
    this.renders.push({ kind: 'update', ...entry });
    return true;
  }

  async postSummary(ref: MessageRef | null, view: SummaryView): Promise<MessageRef | null> {
    let result: MessageRef | null = null;
    if (ref && !this.deleted.has(ref.messageId)) result = ref;
    else if (view.settings.liveChannelId && view.settings.options.summaryEnabled) result = { channelId: view.settings.liveChannelId, messageId: `sum-${++this.seq}` };
    this.summaries.push({ ref, view: clone(view), result });
    return result;
  }

  async postContent(view: ContentView): Promise<MessageRef | null> {
    if (this.throwOnContent) throw new Error('discord down');
    if (this.failContent > 0) {
      this.failContent--;
      this.contents.push({ view, ref: null });
      return null;
    }
    if (!view.settings.contentChannelId) return null;
    const ref = { channelId: view.settings.contentChannelId, messageId: `content-${++this.seq}` };
    this.contents.push({ view, ref });
    return ref;
  }

  async log(guildId: string, _level: string, message: string): Promise<void> {
    this.logs.push({ guildId, message });
  }

  get lastLiveView(): LiveView | undefined {
    return this.renders.at(-1)?.view;
  }
}

/** Deep copy so later mutations of the session object don't change what a test captured. */
function clone<T>(value: T): T {
  return structuredClone(value);
}

export class FakeRoles implements RoleManager {
  readonly live = new Map<string, boolean>();
  readonly streamer = new Map<string, boolean>();
  readonly liveCalls: Array<{ guildId: string; userId: string; live: boolean }> = [];
  readonly streamerCalls: Array<{ guildId: string; userId: string; isStreamer: boolean }> = [];
  readonly reconcileCalls: Array<{ guildId: string; live: string[]; streamers: string[] }> = [];

  async setLive(guildId: string, userId: string, live: boolean): Promise<void> {
    this.liveCalls.push({ guildId, userId, live });
    this.live.set(`${guildId}:${userId}`, live);
  }

  async setStreamer(guildId: string, userId: string, isStreamer: boolean): Promise<void> {
    this.streamerCalls.push({ guildId, userId, isStreamer });
    this.streamer.set(`${guildId}:${userId}`, isStreamer);
  }

  async reconcile(guildId: string, liveUserIds: Set<string>, streamerUserIds: Set<string>): Promise<{ added: number; removed: number }> {
    this.reconcileCalls.push({ guildId, live: [...liveUserIds].sort(), streamers: [...streamerUserIds].sort() });
    return { added: liveUserIds.size, removed: 0 };
  }

  isLive(guildId: string, userId: string): boolean {
    return this.live.get(`${guildId}:${userId}`) === true;
  }
}

export class FakeGateway implements DiscordGateway {
  ready = true;
  readonly members = new Map<string, DiscordMemberInfo>();
  failLookup = false;

  addMember(guildId: string, id: string, displayName: string, bot = false): void {
    this.members.set(`${guildId}:${id}`, { id, username: displayName.toLowerCase(), displayName, avatarUrl: null, bot, roleIds: [] });
  }

  isReady(): boolean {
    return this.ready;
  }
  botUser() {
    return { id: '1', username: 'bot', avatarUrl: null };
  }
  guilds() {
    return [];
  }
  guild() {
    return null;
  }
  async fetchMember(guildId: string, userId: string): Promise<DiscordMemberInfo | null> {
    if (this.failLookup) throw new Error('gateway timeout');
    return this.members.get(`${guildId}:${userId}`) ?? null;
  }
  async roles() {
    return [];
  }
  async textChannels() {
    return [];
  }
  async diagnose(guildId: string): Promise<GuildDiagnostics> {
    return { guildId, botInGuild: true, botHasManageRoles: true, problems: [] };
  }
}

export class FakeMonitor implements MonitorControl {
  changed = 0;
  readonly checks: number[] = [];
  channelsChanged(): void {
    this.changed++;
  }
  checkNow(channelId: number): void {
    this.checks.push(channelId);
  }
}

export interface FakeProviderOptions {
  configured?: boolean;
  /** input (lowercased, without "@") → channel; anything else throws ChannelNotFoundError. */
  channels?: Record<string, ResolvedChannel>;
  vod?: (channel: ChannelRef, streamId: string | null) => string | null | Promise<string | null>;
  resolveError?: Error;
}

export class FakeProvider implements PlatformProvider {
  readonly capabilities = { live: true, content: [], liveBatchSize: 100, push: false };
  readonly resolveInputs: string[] = [];
  readonly vodCalls: Array<{ channelId: number; streamId: string | null }> = [];
  findVodUrl?: (channel: ChannelRef, streamId: string | null, startedAt: string | null) => Promise<string | null>;

  constructor(
    readonly platform: Platform,
    public options: FakeProviderOptions = {},
  ) {
    if (options.vod) {
      const vod = options.vod;
      this.findVodUrl = async (channel, streamId) => {
        this.vodCalls.push({ channelId: channel.id, streamId });
        return vod(channel, streamId);
      };
    }
  }

  isConfigured(): boolean {
    return this.options.configured ?? true;
  }
  health() {
    return { configured: this.isConfigured(), notes: [] };
  }
  async resolveChannel(input: string): Promise<ResolvedChannel> {
    this.resolveInputs.push(input);
    if (this.options.resolveError) throw this.options.resolveError;
    const key = input.replace(/^@/, '').toLowerCase();
    const found = this.options.channels?.[key];
    if (!found) throw new ChannelNotFoundError(this.platform, input);
    return found;
  }
  async checkLive(): Promise<LiveSnapshot[]> {
    return [];
  }
  async fetchRecentContent(): Promise<ContentItem[]> {
    return [];
  }
}

export class FakeProviders implements ProviderRegistryApi {
  readonly map = new Map<Platform, FakeProvider>();
  constructor(overrides: Partial<Record<Platform, FakeProvider>> = {}) {
    for (const p of PLATFORMS) this.map.set(p, overrides[p] ?? new FakeProvider(p));
  }
  get(platform: Platform): FakeProvider {
    const provider = this.map.get(platform);
    if (!provider) throw new Error(`unknown ${platform}`);
    return provider;
  }
  all(): PlatformProvider[] {
    return [...this.map.values()];
  }
  configured(): PlatformProvider[] {
    return this.all().filter((p) => p.isConfigured());
  }
  webhooks() {
    return [];
  }
}

export function resolved(platform: Platform, platformId: string, handle = platformId): ResolvedChannel {
  return {
    platform,
    platformId,
    handle,
    displayName: handle.toUpperCase(),
    avatarUrl: `https://cdn.example.com/${platform}/${handle}.png`,
    url: `https://${platform}.example.com/${handle}`,
    meta: {},
  };
}

export interface Env {
  repos: Repositories;
  events: AppEvents;
  audit: AuditService;
  notifier: FakeNotifier;
  roles: FakeRoles;
  providers: FakeProviders;
  gateway: FakeGateway;
  monitor: FakeMonitor;
  clock: FakeClock;
  emitted: Array<{ name: keyof AppEventMap; payload: unknown }>;
}

export function createEnv(): Env {
  const repos = new Repositories(openDatabase(':memory:'));
  const events = new AppEvents();
  const emitted: Env['emitted'] = [];
  events.on('live.changed', (payload) => emitted.push({ name: 'live.changed', payload }));
  events.on('content.announced', (payload) => emitted.push({ name: 'content.announced', payload }));
  return {
    repos,
    events,
    audit: new AuditService(repos, events),
    notifier: new FakeNotifier(),
    roles: new FakeRoles(),
    providers: new FakeProviders(),
    gateway: new FakeGateway(),
    monitor: new FakeMonitor(),
    clock: new FakeClock(),
    emitted,
  };
}

export function configureGuild(repos: Repositories, guildId: string, patch: GuildSettingsPatch = {}): void {
  repos.settings.update(guildId, {
    liveChannelId: `live-${guildId}`,
    contentChannelId: `content-${guildId}`,
    liveRoleId: `role-live-${guildId}`,
    streamerRoleId: `role-streamer-${guildId}`,
    ...patch,
  });
}

/** Registers a streamer directly in the DB with one account per given channel. */
export function addStreamer(
  repos: Repositories,
  guildId: string,
  discordUserId: string,
  channels: Array<ResolvedChannel | Channel>,
  accountFlags: { notifyLive?: boolean; notifyContent?: boolean } = {},
): { streamer: Streamer; channels: Channel[] } {
  const streamer = repos.streamers.create({ guildId, discordUserId, displayName: `Streamer ${discordUserId.slice(-2)}` });
  const stored = channels.map((c) => ('id' in c ? c : repos.channels.upsertResolved(c)));
  for (const ch of stored) repos.accounts.create({ streamerId: streamer.id, channelId: ch.id, ...accountFlags });
  return { streamer, channels: stored };
}

export function liveSnap(channel: Channel, clock: FakeClock, overrides: Partial<LiveSnapshot> = {}): LiveSnapshot {
  return {
    platform: channel.platform,
    platformId: channel.platformId,
    isLive: true,
    streamId: `${channel.platform}-stream-1`,
    title: 'Ranked grind',
    category: 'Valorant',
    categoryImageUrl: null,
    thumbnailUrl: `https://thumbs.example.com/${channel.platform}.jpg`,
    viewers: 100,
    startedAt: clock.iso(),
    url: channel.url,
    language: 'ar',
    tags: [],
    ...overrides,
  };
}

/** Mirrors what the monitor persists, so DB-based checks (reconcile) see a consistent state. */
export function saveLive(repos: Repositories, channel: Channel, snapshot: LiveSnapshot | null, clock: FakeClock): void {
  repos.channels.saveLiveState(channel.id, {
    isLive: !!snapshot,
    snapshot,
    liveSince: snapshot ? clock.iso() : null,
    offlineSince: snapshot ? null : clock.iso(),
    missCount: 0,
  });
}

export const flush = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));
