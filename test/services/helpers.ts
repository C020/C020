/** Shared fakes for the services tests (no Discord, no network). */
import type { ProviderRegistryApi, StreamingActivity } from '../../src/app/context.js';
import { ChannelNotFoundError } from '../../src/core/errors.js';
import { AppEvents, type AppEventMap } from '../../src/core/events.js';
import type { ChannelRef, ContentItem, LiveSnapshot, Platform, ResolvedChannel } from '../../src/core/types.js';
import { PLATFORMS } from '../../src/core/types.js';
import { openDatabase } from '../../src/db/database.js';
import type { Channel, GuildSettings, GuildSettingsPatch, Streamer, StreamerApplication } from '../../src/db/models.js';
import { Repositories } from '../../src/db/repositories.js';
import type { PlatformProvider } from '../../src/platforms/types.js';
import { AuditService } from '../../src/services/audit.js';
import type {
  ContentView,
  DigestView,
  DiscordActions,
  DiscordGateway,
  DiscordMemberInfo,
  EditOutcome,
  GuildDiagnostics,
  LiveView,
  MessageRef,
  MonitorControl,
  Notifier,
  PresenceLiveView,
  RenameOutcome,
  RoleChangeOutcome,
  RoleManager,
  SummaryOutcome,
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
  /** Every summary attempt; `result` is the final ref (null when skipped or failed). */
  readonly summaries: Array<{ ref: MessageRef | null; view: SummaryView; result: MessageRef | null; outcome: SummaryOutcome }> = [];
  /** Live edit attempts that did not succeed (transient/forbidden/gone). */
  readonly failedUpdates: Array<{ ref: MessageRef; outcome: EditOutcome }> = [];
  readonly contents: Array<{ view: ContentView; ref: MessageRef | null }> = [];
  readonly logs: Array<{ guildId: string; message: string }> = [];
  /** Message ids that were deleted in Discord. */
  readonly deleted = new Set<string>();
  /** Upcoming postContent calls that fail (return null). */
  failContent = 0;
  throwOnContent = false;
  throwOnUpdate = false;
  /** Outcome of upcoming live edits (consumed one per edit; empty = normal behavior). */
  readonly updateOutcomes: EditOutcome[] = [];
  /** Upcoming postSummary calls that fail transiently. */
  failSummaries = 0;
  /** While true, postLive fails (returns null), e.g. the bot lost access to the channel. */
  failPosts = false;
  private seq = 0;

  async postLive(view: LiveView): Promise<MessageRef | null> {
    if (!view.settings.liveChannelId || this.failPosts) return null;
    const ref = { channelId: view.settings.liveChannelId, messageId: `live-${++this.seq}` };
    const entry = { ref, view: clone(view) };
    this.posts.push(entry);
    this.renders.push({ kind: 'post', ...entry });
    return ref;
  }

  async updateLive(ref: MessageRef, view: LiveView): Promise<EditOutcome> {
    if (this.throwOnUpdate) throw new Error('discord down');
    const scripted = this.updateOutcomes.shift();
    const outcome: EditOutcome = scripted ?? (this.deleted.has(ref.messageId) ? 'gone' : 'ok');
    if (outcome !== 'ok') {
      this.failedUpdates.push({ ref, outcome });
      return outcome;
    }
    const entry = { ref, view: clone(view) };
    this.updates.push(entry);
    this.renders.push({ kind: 'update', ...entry });
    return 'ok';
  }

  async postSummary(ref: MessageRef | null, view: SummaryView): Promise<SummaryOutcome> {
    let outcome: SummaryOutcome;
    if (this.failSummaries > 0) {
      this.failSummaries--;
      outcome = { status: 'transient', reason: 'error' };
    } else if (ref && !this.deleted.has(ref.messageId)) {
      outcome = { status: 'done', ref };
    } else if (view.settings.liveChannelId && view.settings.options.summaryEnabled) {
      outcome = { status: 'done', ref: { channelId: view.settings.liveChannelId, messageId: `sum-${++this.seq}` } };
    } else {
      outcome = { status: 'skipped' };
    }
    this.summaries.push({ ref, view: clone(view), result: outcome.status === 'done' ? outcome.ref : null, outcome });
    return outcome;
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

  // ── v2 ──
  readonly digests: Array<{ view: DigestView; ref: MessageRef | null }> = [];
  readonly presencePosts: Array<{ view: PresenceLiveView; ref: MessageRef | null }> = [];
  readonly presenceEnds: Array<{ ref: MessageRef; view: PresenceLiveView; result: boolean }> = [];
  /** Upcoming postDigest calls that fail (return null). */
  failDigest = 0;
  /** While true, postPresenceLive fails (returns null). */
  failPresencePosts = false;
  throwOnPresence = false;

  async postDigest(view: DigestView): Promise<MessageRef | null> {
    if (this.failDigest > 0) {
      this.failDigest--;
      this.digests.push({ view: clone(view), ref: null });
      return null;
    }
    const channelId = view.settings.features.clips.digestChannelId ?? view.settings.contentChannelId;
    if (!channelId) return null;
    const ref = { channelId, messageId: `digest-${++this.seq}` };
    this.digests.push({ view: clone(view), ref });
    return ref;
  }

  async postPresenceLive(view: PresenceLiveView): Promise<MessageRef | null> {
    if (this.throwOnPresence) throw new Error('discord down');
    const channelId = view.settings.liveChannelId;
    if (!channelId || this.failPresencePosts) {
      this.presencePosts.push({ view: clone(view), ref: null });
      return null;
    }
    const ref = { channelId, messageId: `presence-${++this.seq}` };
    this.presencePosts.push({ view: clone(view), ref });
    return ref;
  }

  async endPresenceLive(ref: MessageRef, view: PresenceLiveView): Promise<boolean> {
    if (this.throwOnPresence) throw new Error('discord down');
    const result = !this.deleted.has(ref.messageId);
    this.presenceEnds.push({ ref, view: clone(view), result });
    return result;
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
  readonly removeCalls: Array<{ guildId: string; roleId: string; userIds: string[]; reason: string }> = [];
  /** Upcoming setLive calls that fail transiently (role unchanged). */
  failLive = 0;
  /** Upcoming reconcile calls that throw (e.g. Discord not ready). */
  failReconcile = 0;

  async setLive(guildId: string, userId: string, live: boolean): Promise<RoleChangeOutcome> {
    this.liveCalls.push({ guildId, userId, live });
    if (this.failLive > 0) {
      this.failLive--;
      return 'transient';
    }
    const changed = this.isLive(guildId, userId) !== live;
    this.live.set(`${guildId}:${userId}`, live);
    return changed ? 'applied' : 'noop';
  }

  async setStreamer(guildId: string, userId: string, isStreamer: boolean): Promise<RoleChangeOutcome> {
    this.streamerCalls.push({ guildId, userId, isStreamer });
    const changed = this.streamer.get(`${guildId}:${userId}`) !== isStreamer;
    this.streamer.set(`${guildId}:${userId}`, isStreamer);
    return changed ? 'applied' : 'noop';
  }

  async removeRoleFrom(guildId: string, roleId: string, userIds: string[], reason: string): Promise<void> {
    this.removeCalls.push({ guildId, roleId, userIds: [...userIds], reason });
  }

  /** Applies the live role like the real reconcile: added for live users, removed only from registered streamers. */
  async reconcile(guildId: string, liveUserIds: Set<string>, streamerUserIds: Set<string>): Promise<{ added: number; removed: number }> {
    this.reconcileCalls.push({ guildId, live: [...liveUserIds].sort(), streamers: [...streamerUserIds].sort() });
    if (this.failReconcile > 0) {
      this.failReconcile--;
      throw new Error('البوت غير متصل بديسكورد حالياً، جرّب بعد شوي');
    }
    let added = 0;
    let removed = 0;
    for (const userId of liveUserIds) {
      if (!this.isLive(guildId, userId)) added++;
      this.live.set(`${guildId}:${userId}`, true);
    }
    for (const userId of streamerUserIds) {
      if (liveUserIds.has(userId) || !this.isLive(guildId, userId)) continue;
      this.live.set(`${guildId}:${userId}`, false);
      removed++;
    }
    return { added, removed };
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

/** DiscordActions fake: scripted rename outcomes, recorded DMs/reviews, settable Streaming presences. */
export class FakeDiscordActions implements DiscordActions {
  readonly renames: Array<{ guildId: string; channelId: string; name: string; outcome: RenameOutcome }> = [];
  /** Current channel names (rename to the same name → 'unchanged'). */
  readonly channelNames = new Map<string, string>();
  /** Outcomes of upcoming renames (consumed one per call; empty = 'ok'/'unchanged'). */
  readonly renameOutcomes: Array<{ outcome: RenameOutcome; retryAfterMs?: number }> = [];
  readonly dms: Array<{ userId: string; content: string }> = [];
  readonly reviews: StreamerApplication[] = [];
  /** guildId → userId → activity (a guild missing from the map has nobody streaming). */
  readonly presences = new Map<string, Map<string, StreamingActivity>>();
  /** While true, streamingPresences reports null (intent unavailable / Discord not ready). */
  presencesUnavailable = false;
  readonly presenceCalls: string[] = [];
  /** What presenceIntentEnabled() reports. */
  presenceIntent = true;

  /** Member lookups go to the given gateway (when any), like the real DiscordApi. */
  constructor(private readonly gateway: FakeGateway | null = null) {}

  async fetchMember(guildId: string, userId: string): Promise<DiscordMemberInfo | null> {
    return this.gateway ? this.gateway.fetchMember(guildId, userId) : null;
  }

  presenceIntentEnabled(): boolean {
    return this.presenceIntent;
  }

  async renameChannel(guildId: string, channelId: string, name: string): Promise<{ outcome: RenameOutcome; retryAfterMs?: number }> {
    const scripted = this.renameOutcomes.shift();
    let result: { outcome: RenameOutcome; retryAfterMs?: number };
    if (scripted) result = scripted;
    else if (this.channelNames.get(channelId) === name) result = { outcome: 'unchanged' };
    else result = { outcome: 'ok' };
    if (result.outcome === 'ok') this.channelNames.set(channelId, name);
    this.renames.push({ guildId, channelId, name, outcome: result.outcome });
    return result;
  }

  async sendDirectMessage(userId: string, message: { content: string }): Promise<boolean> {
    this.dms.push({ userId, content: message.content });
    return true;
  }

  async upsertApplicationReview(application: StreamerApplication, _settings: GuildSettings): Promise<MessageRef | null> {
    this.reviews.push(application);
    return null;
  }

  async streamingPresences(guildId: string): Promise<Map<string, StreamingActivity> | null> {
    this.presenceCalls.push(guildId);
    if (this.presencesUnavailable) return null;
    const map = this.presences.get(guildId);
    return map ? new Map(map) : new Map();
  }

  setStreaming(guildId: string, userId: string, activity: StreamingActivity | null): void {
    let map = this.presences.get(guildId);
    if (!map) this.presences.set(guildId, (map = new Map()));
    if (activity) map.set(userId, activity);
    else map.delete(userId);
  }

  /** Renames that actually changed the name. */
  get applied(): string[] {
    return this.renames.filter((r) => r.outcome === 'ok').map((r) => r.name);
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
