/** View factories and fakes for the Discord layer tests (no network, no discord.js client). */
import type { LiveSnapshot, Platform } from '../../src/core/types.js';
import { AppEvents } from '../../src/core/events.js';
import { openDatabase } from '../../src/db/database.js';
import { defaultGuildSettings, type GuildSettings, type LiveSession, type Streamer } from '../../src/db/models.js';
import { Repositories } from '../../src/db/repositories.js';
import { AuditService } from '../../src/services/audit.js';
import type { ContentView, DigestView, LivePlatformView, LiveView, MessageRef, PresenceLiveView, SummaryView } from '../../src/services/ports.js';
import type { MessageTransport, OutgoingMessage, TransportResult } from '../../src/discord/transport.js';
import type { ImageFetcher } from '../../src/discord/attachments.js';
import type { PlatformEmojis } from '../../src/discord/emojis.js';
import { DiscordNotifier } from '../../src/discord/notifier.js';
import { WarnThrottle } from '../../src/discord/util.js';
import { DEFAULT_GUILD_FEATURES, type GuildFeaturesPatch, mergeFeatures } from '../../src/db/features.js';

export const GUILD = '111111111111111111';
export const USER = '222222222222222222';
export const LIVE_CHANNEL = '333333333333333333';
export const CONTENT_CHANNEL = '444444444444444444';
export const LOG_CHANNEL = '555555555555555555';
export const ROLE = '666666666666666666';
export const T0 = Date.parse('2026-10-03T12:00:00.000Z');
export const MIN = 60_000;

export function settings(patch: Partial<GuildSettings> = {}): GuildSettings {
  return { ...defaultGuildSettings(GUILD, new Date(T0).toISOString()), ...patch };
}

/** Settings with optional features patched (deep-merged one level like the settings API). */
export function withFeatures(features: GuildFeaturesPatch, patch: Partial<GuildSettings> = {}): GuildSettings {
  return settings({ ...patch, features: mergeFeatures(structuredClone(DEFAULT_GUILD_FEATURES), features) });
}

export function streamer(patch: Partial<Streamer> = {}): Streamer {
  return {
    id: 1,
    guildId: GUILD,
    discordUserId: USER,
    displayName: 'أبو فهد',
    notes: null,
    color: null,
    templates: {},
    enabled: true,
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    ...patch,
  };
}

export function session(patch: Partial<LiveSession> = {}): LiveSession {
  return {
    id: 7,
    guildId: GUILD,
    streamerId: 1,
    status: 'live',
    startedAt: new Date(T0 - 30 * MIN).toISOString(),
    endedAt: null,
    messageChannelId: null,
    messageId: null,
    peakViewers: 0,
    viewerSum: 0,
    viewerSamples: 0,
    categories: [],
    titles: [],
    lastMessageUpdate: null,
    summaryPending: false,
    summaryAttempts: 0,
    createdAt: new Date(T0 - 30 * MIN).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    ...patch,
  };
}

const URLS: Record<Platform, string> = {
  twitch: 'https://www.twitch.tv/abufahad',
  kick: 'https://kick.com/abufahad',
  youtube: 'https://www.youtube.com/@abufahad',
  tiktok: 'https://www.tiktok.com/@abufahad',
};

export function snapshot(platform: Platform, patch: Partial<LiveSnapshot> = {}): LiveSnapshot {
  return {
    platform,
    platformId: `${platform}-id`,
    isLive: true,
    streamId: `${platform}-stream`,
    title: 'رانكد فالورانت',
    category: 'Valorant',
    categoryImageUrl: 'https://static-cdn.jtvnw.net/ttv-boxart/516575-285x380.jpg',
    thumbnailUrl: `https://img.example.com/${platform}.jpg?t=1`,
    viewers: 100,
    startedAt: new Date(T0 - 30 * MIN).toISOString(),
    url: URLS[platform],
    language: 'ar',
    tags: [],
    ...patch,
  };
}

export function platformView(platform: Platform, snap: Partial<LiveSnapshot> = {}, channelPatch: Partial<LivePlatformView['channel']> = {}, id = 1): LivePlatformView {
  return {
    platform,
    channel: { id, displayName: 'AbuFahad', handle: 'abufahad', url: URLS[platform], avatarUrl: `https://img.example.com/${platform}-avatar.png`, ...channelPatch },
    snapshot: snapshot(platform, snap),
  };
}

export function liveView(platforms: LivePlatformView[], patch: Partial<LiveView> = {}): LiveView {
  const total = platforms.reduce<number | null>((sum, p) => (p.snapshot.viewers == null ? sum : (sum ?? 0) + p.snapshot.viewers), null);
  return { guildId: GUILD, settings: settings(), session: session(), streamer: streamer(), platforms, totalViewers: total, ...patch };
}

export function summaryView(patch: Partial<SummaryView> = {}): SummaryView {
  const s = session({
    status: 'ended',
    startedAt: new Date(T0 - 135 * MIN).toISOString(),
    endedAt: new Date(T0).toISOString(),
    peakViewers: 1580,
    viewerSum: 11200,
    viewerSamples: 10,
  });
  return {
    guildId: GUILD,
    settings: settings(),
    session: s,
    streamer: streamer(),
    durationSec: 2 * 3600 + 15 * 60,
    peakViewers: 1580,
    avgViewers: 1120,
    categories: [
      { name: 'Valorant', imageUrl: null, firstSeenAt: s.startedAt, seconds: 110 * 60 },
      { name: 'Just Chatting', imageUrl: null, firstSeenAt: s.startedAt, seconds: 25 * 60 },
    ],
    titles: ['سوالف', 'رانكد فالورانت'],
    segments: [
      {
        id: 1,
        sessionId: s.id,
        channelId: 10,
        platform: 'twitch',
        streamId: 'a',
        startedAt: s.startedAt,
        endedAt: new Date(T0 - 60 * MIN).toISOString(),
        peakViewers: 1200,
        lastViewers: null,
        vodUrl: null,
        channel: { id: 10, displayName: 'AbuFahad', handle: 'abufahad', url: URLS.twitch, avatarUrl: 'https://img.example.com/a.png' },
      },
      {
        id: 2,
        sessionId: s.id,
        channelId: 10,
        platform: 'twitch',
        streamId: 'b',
        startedAt: new Date(T0 - 55 * MIN).toISOString(),
        endedAt: s.endedAt,
        peakViewers: 1300,
        lastViewers: null,
        vodUrl: 'https://www.twitch.tv/videos/123',
        channel: { id: 10, displayName: 'AbuFahad', handle: 'abufahad', url: URLS.twitch, avatarUrl: 'https://img.example.com/a.png' },
      },
      {
        id: 3,
        sessionId: s.id,
        channelId: 11,
        platform: 'kick',
        streamId: 'c',
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        peakViewers: 300,
        lastViewers: null,
        vodUrl: null,
        channel: { id: 11, displayName: 'abufahad', handle: 'abufahad', url: URLS.kick, avatarUrl: null },
      },
    ],
    imageUrl: 'https://img.example.com/last.jpg',
    ...patch,
  };
}

export function contentView(patch: Partial<ContentView> = {}, item: Partial<ContentView['item']> = {}): ContentView {
  return {
    guildId: GUILD,
    settings: settings(),
    streamer: streamer(),
    channel: { id: 20, platform: 'youtube', displayName: 'Abu Fahad', handle: '@abufahad', url: URLS.youtube, avatarUrl: 'https://img.example.com/yt.png' },
    item: {
      platform: 'youtube',
      platformId: 'UC123',
      contentId: 'vid1',
      kind: 'video',
      title: 'أقوى لقطات الأسبوع',
      url: 'https://www.youtube.com/watch?v=vid1',
      thumbnailUrl: 'https://i.ytimg.com/vi/vid1/hqdefault.jpg',
      publishedAt: new Date(T0 - 5 * MIN).toISOString(),
      durationSec: 754,
      viewCount: 12500,
      ...item,
    } as ContentView['item'],
    ...patch,
  };
}

export interface TransportCall {
  op: 'send' | 'edit';
  guildId: string;
  channelId: string;
  messageId?: string;
  message: OutgoingMessage;
}

/** Scriptable MessageTransport: queue results per call, default success. */
export class FakeTransport implements MessageTransport {
  readonly calls: TransportCall[] = [];
  readonly results: TransportResult[] = [];
  throwNext = false;
  private seq = 0;

  push(...results: TransportResult[]): this {
    this.results.push(...results);
    return this;
  }

  async send(guildId: string, channelId: string, message: OutgoingMessage): Promise<TransportResult> {
    this.calls.push({ op: 'send', guildId, channelId, message });
    return this.next({ channelId, messageId: `m${++this.seq}` });
  }

  async edit(guildId: string, ref: MessageRef, message: OutgoingMessage): Promise<TransportResult> {
    this.calls.push({ op: 'edit', guildId, channelId: ref.channelId, messageId: ref.messageId, message });
    return this.next(ref);
  }

  private next(ref: MessageRef): TransportResult {
    if (this.throwNext) {
      this.throwNext = false;
      throw new Error('socket hang up');
    }
    return this.results.shift() ?? { ok: true, ref };
  }
}

export function db() {
  const repos = new Repositories(openDatabase(':memory:'));
  const events = new AppEvents();
  const audit = new AuditService(repos, events);
  return { repos, events, audit };
}

export function digestView(count = 3, patch: Partial<DigestView> = {}): DigestView {
  const entries: DigestView['entries'] = Array.from({ length: count }, (_, i) => ({
    streamer: streamer({ id: i + 1, displayName: `ستريمر ${i + 1}` }),
    channel: { id: 100 + i, platform: 'twitch', displayName: `Streamer${i + 1}`, handle: `streamer${i + 1}`, url: `https://www.twitch.tv/streamer${i + 1}`, avatarUrl: null },
    item: {
      id: 1000 + i,
      channelId: 100 + i,
      contentId: `clip-${i + 1}`,
      kind: 'clip',
      title: `لقطة رقم ${i + 1}`,
      url: `https://clips.twitch.tv/Clip${i + 1}`,
      thumbnailUrl: `https://clips-media-assets2.twitch.tv/clip${i + 1}-preview-480x272.jpg`,
      publishedAt: new Date(T0 - (i + 1) * 60 * MIN).toISOString(),
      firstSeenAt: new Date(T0 - (i + 1) * 60 * MIN).toISOString(),
      announced: false,
      viewCount: 5000 - i * 1000,
    },
  }));
  return { guildId: GUILD, settings: settings({ contentChannelId: CONTENT_CHANNEL }), entries, date: '2026-10-03', total: count, ...patch };
}

export function presenceView(patch: Partial<PresenceLiveView> = {}): PresenceLiveView {
  return {
    guildId: GUILD,
    settings: settings({ liveChannelId: LIVE_CHANNEL }),
    userId: USER,
    displayName: 'Member Name',
    avatarUrl: 'https://cdn.discordapp.com/avatars/2/member.png',
    streamer: null,
    url: 'https://www.twitch.tv/membername',
    platform: 'twitch',
    title: 'Chill stream',
    game: 'Minecraft',
    startedAt: new Date(T0 - 10 * MIN).toISOString(),
    endedAt: null,
    ...patch,
  };
}

/** A DiscordNotifier over a FakeTransport and an in-memory DB, with a controllable clock. */
export function makeNotifier(opts: { emojis?: PlatformEmojis; fetchImage?: ImageFetcher } = {}) {
  const { repos, audit } = db();
  const transport = new FakeTransport();
  let now = T0;
  const clock = () => now;
  const notifier = new DiscordNotifier({
    transport,
    repos,
    audit,
    emojis: opts.emojis ? () => opts.emojis! : undefined,
    avatarFor: () => null,
    clock,
    warnThrottle: new WarnThrottle(60 * 60_000, clock),
    logBatchDelayMs: 50,
    fetchImage: opts.fetchImage ?? (async () => null),
  });
  const warnings = () => repos.audit.list({ guildId: GUILD }).filter((e) => e.action === 'discord.delivery');
  return { repos, audit, transport, notifier, warnings, advance: (ms: number) => (now += ms) };
}
