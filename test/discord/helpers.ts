/** View factories and fakes for the Discord layer tests (no network, no discord.js client). */
import type { LiveSnapshot, Platform } from '../../src/core/types.js';
import { AppEvents } from '../../src/core/events.js';
import { openDatabase } from '../../src/db/database.js';
import { defaultGuildSettings, type GuildSettings, type LiveSession, type Streamer } from '../../src/db/models.js';
import { Repositories } from '../../src/db/repositories.js';
import { AuditService } from '../../src/services/audit.js';
import type { ContentView, LivePlatformView, LiveView, MessageRef, SummaryView } from '../../src/services/ports.js';
import type { MessageTransport, OutgoingMessage, TransportResult } from '../../src/discord/transport.js';

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

export function streamer(patch: Partial<Streamer> = {}): Streamer {
  return {
    id: 1,
    guildId: GUILD,
    discordUserId: USER,
    displayName: 'أبو فهد',
    notes: null,
    color: null,
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
