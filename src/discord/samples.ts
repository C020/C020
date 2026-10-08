/**
 * Realistic sample views for the dashboard template preview and "send test" (no DB rows involved).
 * Samples follow the guild's enabled platforms so the preview looks like what members will actually see, and the
 * guild's language (#16) for the sample texts.
 */
import type { ContentKind, LiveSnapshot, Platform } from '../core/types.js';
import { PLATFORMS } from '../core/types.js';
import type { GuildSettings, Language, LiveSegment, LiveSession, Streamer } from '../db/models.js';
import type { ContentView, DigestView, LivePlatformView, LiveView, PresenceLiveView, SummaryView } from '../services/ports.js';
import { langOf } from './i18n/messages.js';
import type { TemplateType } from './templates.js';

export interface SampleIdentity {
  displayName: string;
  /** Used for `{mention}`; empty = no mention. */
  discordUserId: string;
  avatarUrl: string | null;
}

export const SAMPLE_AVATAR = 'https://cdn.discordapp.com/embed/avatars/0.png';

/** Name of the fake streamer in previews / test messages, per language. */
export const SAMPLE_STREAMER_NAMES: Readonly<Record<Language, string>> = Object.freeze({ ar: 'ستريمر تجريبي', en: 'Sample streamer' });

/** Default sample identity for a language (pass the bot's id as `discordUserId` so `{mention}` renders). */
export function sampleIdentityFor(lang: Language, discordUserId = ''): SampleIdentity {
  return { displayName: SAMPLE_STREAMER_NAMES[lang] ?? SAMPLE_STREAMER_NAMES.ar, discordUserId, avatarUrl: SAMPLE_AVATAR };
}

interface SampleTexts {
  liveTitle: string;
  earlierTitle: string;
  contentTitle: string;
  tag: string;
  clipTitles: [string, string, string];
}

const SAMPLE_TEXTS: Record<Language, SampleTexts> = {
  ar: {
    liveTitle: 'رانكد فالورانت 🔥 الطريق للريديانت',
    earlierTitle: 'سوالف الصباح ☕',
    contentTitle: 'أقوى لقطات الأسبوع 🔥 (لا تفوتكم الأخيرة)',
    tag: 'عربي',
    clipTitles: ['ايس خرافي 🔥', 'أقوى ضحكة بالبث 😂', 'كلتش ١ ضد ٤'],
  },
  en: {
    liveTitle: 'Ranked Valorant 🔥 road to Radiant',
    earlierTitle: 'Morning chat ☕',
    contentTitle: "Best plays of the week 🔥 (don't miss the last one)",
    tag: 'English',
    clipTitles: ['Insane ace 🔥', 'Funniest moment of the stream 😂', '1v4 clutch'],
  },
};

const textsFor = (settings: GuildSettings): SampleTexts => SAMPLE_TEXTS[langOf(settings)];
const identityFor = (settings: GuildSettings, identity: SampleIdentity | undefined): SampleIdentity => identity ?? sampleIdentityFor(langOf(settings));

interface PlatformSample {
  handle: string;
  displayName: string;
  url: string;
  thumbnailUrl: string | null;
  viewers: number | null;
  category: string | null;
  categoryImageUrl: string | null;
  vodUrl: string | null;
}

const VALORANT_BOX_ART = 'https://static-cdn.jtvnw.net/ttv-boxart/516575-285x380.jpg';
const LIVE_PREVIEW = 'https://static-cdn.jtvnw.net/ttv-static/404_preview-1280x720.jpg';

const PLATFORM_SAMPLES: Record<Platform, PlatformSample> = {
  twitch: {
    handle: 'twitch',
    displayName: 'StreamerTV',
    url: 'https://www.twitch.tv/twitch',
    thumbnailUrl: LIVE_PREVIEW,
    viewers: 1234,
    category: 'VALORANT',
    categoryImageUrl: VALORANT_BOX_ART,
    vodUrl: 'https://www.twitch.tv/videos/2000000000',
  },
  kick: {
    handle: 'kick',
    displayName: 'StreamerTV',
    url: 'https://kick.com/kick',
    thumbnailUrl: LIVE_PREVIEW,
    viewers: 321,
    category: 'VALORANT',
    categoryImageUrl: VALORANT_BOX_ART,
    vodUrl: null,
  },
  youtube: {
    handle: '@YouTube',
    displayName: 'Streamer TV',
    url: 'https://www.youtube.com/@YouTube',
    thumbnailUrl: 'https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg',
    viewers: 870,
    category: null,
    categoryImageUrl: null,
    vodUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
  },
  tiktok: {
    handle: 'tiktok',
    displayName: 'streamer.tv',
    url: 'https://www.tiktok.com/@tiktok',
    thumbnailUrl: null,
    viewers: 410,
    category: null,
    categoryImageUrl: null,
    vodUrl: null,
  },
};

const MIN = 60_000;

function enabledPlatforms(settings: GuildSettings, preferred: Platform[]): Platform[] {
  const enabled = settings.platformsEnabled.length > 0 ? settings.platformsEnabled : [...PLATFORMS];
  const ordered = [...preferred.filter((p) => enabled.includes(p)), ...enabled.filter((p) => !preferred.includes(p))];
  return ordered.length > 0 ? ordered : preferred;
}

function sampleStreamer(settings: GuildSettings, identity: SampleIdentity, now: number): Streamer {
  const at = new Date(now).toISOString();
  return {
    id: 0,
    guildId: settings.guildId,
    discordUserId: identity.discordUserId,
    displayName: identity.displayName,
    notes: null,
    templates: {},
    color: null,
    enabled: true,
    createdAt: at,
    updatedAt: at,
  };
}

function sampleSession(settings: GuildSettings, startedAt: number, endedAt: number | null): LiveSession {
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    id: 0,
    guildId: settings.guildId,
    streamerId: 0,
    status: endedAt === null ? 'live' : 'ended',
    startedAt: iso(startedAt),
    endedAt: endedAt === null ? null : iso(endedAt),
    messageChannelId: null,
    messageId: null,
    peakViewers: 1580,
    viewerSum: 1120 * 27,
    viewerSamples: 27,
    categories: [
      { name: 'VALORANT', imageUrl: VALORANT_BOX_ART, firstSeenAt: iso(startedAt + 25 * MIN), seconds: 110 * 60 },
      { name: 'Just Chatting', imageUrl: null, firstSeenAt: iso(startedAt), seconds: 25 * 60 },
    ],
    titles: [textsFor(settings).earlierTitle, textsFor(settings).liveTitle],
    lastMessageUpdate: null,
    summaryPending: false,
    summaryAttempts: 0,
    createdAt: iso(startedAt),
    updatedAt: iso(endedAt ?? startedAt),
  };
}

function channelInfo(platform: Platform, index: number) {
  const s = PLATFORM_SAMPLES[platform];
  return { id: -(index + 1), displayName: s.displayName, handle: s.handle, url: s.url, avatarUrl: SAMPLE_AVATAR };
}

function liveSnapshot(settings: GuildSettings, platform: Platform, startedAt: number, now: number): LiveSnapshot {
  const s = PLATFORM_SAMPLES[platform];
  const texts = textsFor(settings);
  return {
    platform,
    platformId: `sample-${platform}`,
    isLive: true,
    streamId: `sample-${platform}-stream`,
    title: texts.liveTitle,
    category: s.category,
    categoryImageUrl: s.categoryImageUrl,
    thumbnailUrl: s.thumbnailUrl ? `${s.thumbnailUrl}?t=${now}` : null,
    viewers: s.viewers,
    startedAt: new Date(startedAt).toISOString(),
    url: s.url,
    language: langOf(settings),
    tags: [texts.tag],
  };
}

export function sampleLiveView(settings: GuildSettings, now = Date.now(), identity?: SampleIdentity): LiveView {
  const startedAt = now - 47 * MIN;
  const platforms: LivePlatformView[] = enabledPlatforms(settings, ['twitch', 'kick'])
    .slice(0, 2)
    .map((platform, i) => ({ platform, channel: channelInfo(platform, i), snapshot: liveSnapshot(settings, platform, startedAt, now) }))
    .sort((a, b) => (b.snapshot.viewers ?? -1) - (a.snapshot.viewers ?? -1));
  const totalViewers = platforms.reduce<number | null>((sum, p) => (p.snapshot.viewers == null ? sum : (sum ?? 0) + p.snapshot.viewers), null);
  return {
    guildId: settings.guildId,
    settings,
    session: sampleSession(settings, startedAt, null),
    streamer: sampleStreamer(settings, identityFor(settings, identity), now),
    platforms,
    totalViewers,
  };
}

export function sampleSummaryView(settings: GuildSettings, now = Date.now(), identity?: SampleIdentity): SummaryView {
  const durationSec = 2 * 3600 + 15 * 60;
  const startedAt = now - durationSec * 1000;
  const session = sampleSession(settings, startedAt, now);
  const segments: SummaryView['segments'] = enabledPlatforms(settings, ['twitch', 'kick'])
    .slice(0, 2)
    .map((platform, i): LiveSegment & { channel: ReturnType<typeof channelInfo> } => ({
      id: -(i + 1),
      sessionId: 0,
      channelId: -(i + 1),
      platform,
      streamId: `sample-${platform}-stream`,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      peakViewers: i === 0 ? 1260 : 320,
      lastViewers: null,
      vodUrl: PLATFORM_SAMPLES[platform].vodUrl,
      channel: channelInfo(platform, i),
    }));
  return {
    guildId: settings.guildId,
    settings,
    session,
    streamer: sampleStreamer(settings, identityFor(settings, identity), now),
    durationSec,
    peakViewers: session.peakViewers,
    avgViewers: Math.round(session.viewerSum / session.viewerSamples),
    categories: [...session.categories].sort((a, b) => b.seconds - a.seconds),
    titles: [...session.titles],
    segments,
    imageUrl: LIVE_PREVIEW,
  };
}

export function sampleContentView(settings: GuildSettings, now = Date.now(), identity?: SampleIdentity): ContentView {
  const platform = enabledPlatforms(settings, ['youtube', 'tiktok', 'twitch', 'kick'])[0] ?? 'youtube';
  const kinds: ContentKind[] = settings.contentKinds.length > 0 ? settings.contentKinds : ['video'];
  const kind: ContentKind = kinds.includes('video') ? 'video' : (kinds[0] ?? 'video');
  const s = PLATFORM_SAMPLES[platform];
  return {
    guildId: settings.guildId,
    settings,
    streamer: sampleStreamer(settings, identityFor(settings, identity), now),
    channel: { ...channelInfo(platform, 0), platform },
    item: {
      platform,
      platformId: `sample-${platform}`,
      contentId: 'sample-content',
      kind,
      title: textsFor(settings).contentTitle,
      url: platform === 'youtube' ? 'https://www.youtube.com/watch?v=jNQXAC9IVRw' : s.url,
      thumbnailUrl: 'https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg',
      publishedAt: new Date(now - 5 * MIN).toISOString(),
      durationSec: 754,
      viewCount: 12500,
    },
  };
}

/** #6 — a sample daily clip digest (three Twitch clips, best first). */
export function sampleDigestView(settings: GuildSettings, now = Date.now(), identity?: SampleIdentity): DigestView {
  const who = identityFor(settings, identity);
  const texts = textsFor(settings);
  const s = PLATFORM_SAMPLES.twitch;
  const entries: DigestView['entries'] = texts.clipTitles.map((title, i) => ({
    streamer: sampleStreamer(settings, who, now),
    channel: { ...channelInfo('twitch', 0), platform: 'twitch' as const },
    item: {
      id: -(i + 1),
      channelId: -1,
      contentId: `sample-clip-${i + 1}`,
      kind: 'clip' as const,
      title,
      url: `https://clips.twitch.tv/SampleClip${i + 1}`,
      thumbnailUrl: s.thumbnailUrl,
      publishedAt: new Date(now - (i + 2) * 60 * MIN).toISOString(),
      firstSeenAt: new Date(now - (i + 2) * 60 * MIN).toISOString(),
      announced: false,
      viewCount: [4210, 2875, 1530][i] ?? 1000,
    },
  }));
  return { guildId: settings.guildId, settings, entries, date: new Date(now).toISOString().slice(0, 10), total: entries.length };
}

/** #15 — a sample presence-only stream (Discord "Streaming" status). */
export function samplePresenceView(settings: GuildSettings, now = Date.now(), identity?: SampleIdentity): PresenceLiveView {
  const who = identityFor(settings, identity);
  return {
    guildId: settings.guildId,
    settings,
    userId: who.discordUserId,
    displayName: who.displayName,
    avatarUrl: who.avatarUrl,
    streamer: null,
    url: PLATFORM_SAMPLES.twitch.url,
    platform: 'twitch',
    title: textsFor(settings).liveTitle,
    game: PLATFORM_SAMPLES.twitch.category,
    startedAt: new Date(now - 12 * MIN).toISOString(),
    endedAt: null,
  };
}

export function sampleView(type: TemplateType, settings: GuildSettings, now = Date.now(), identity?: SampleIdentity): LiveView | SummaryView | ContentView {
  switch (type) {
    case 'live':
      return sampleLiveView(settings, now, identity);
    case 'summary':
      return sampleSummaryView(settings, now, identity);
    case 'content':
      return sampleContentView(settings, now, identity);
  }
}
