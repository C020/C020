import { createHmac } from 'node:crypto';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { ChannelNotFoundError, ProviderError, ProviderNotConfiguredError, ValidationError } from '../../src/core/errors.js';
import type { ChannelRef } from '../../src/core/types.js';
import { openDatabase } from '../../src/db/database.js';
import { Repositories } from '../../src/db/repositories.js';
import type { FetchLike } from '../../src/platforms/http.js';
import type { KeyValueStore, WebhookRequest } from '../../src/platforms/types.js';
import {
  type ApiVideo,
  classifyVideo,
  createYouTubeProvider,
  heuristicIsShort,
  nextPacificMidnight,
  pacificDay,
  parseIsoDuration,
  parseYouTubeInput,
  QuotaExhaustedError,
  YouTubeProvider,
  type YouTubeProviderOptions,
} from '../../src/platforms/youtube.js';
import { channelIdFromTopic, parseYouTubeFeed, verifyHubSignature, websubTopic } from '../../src/platforms/youtube-websub.js';

// ───────────────────────────── fixtures ─────────────────────────────

const NOW = Date.parse('2026-10-03T12:00:00Z');
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const SECRET = 'websub-secret-value';
const CALLBACK = 'https://bot.example.com/webhooks/youtube';
const silent = pino({ level: 'silent' });

const CH1 = `UC${'a'.repeat(22)}`;
const CH2 = `UC${'b'.repeat(22)}`;
const suffix = (id: string) => id.slice(2);
const vid = (n: number) => `v${String(n).padStart(10, '0')}`;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const newKv = (): KeyValueStore => new Repositories(openDatabase(':memory:')).kv;
const channel = (platformId: string, id = 1): ChannelRef => ({ id, platform: 'youtube', platformId, handle: '@someone', meta: {} });

function clock(start = NOW) {
  const c = { t: start, now: () => c.t, advance: (ms: number) => (c.t += ms) };
  return c;
}

interface Call {
  method: string;
  url: URL;
  host: string;
  path: string;
  body: string | null;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const xml = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'application/atom+xml; charset=UTF-8' } });
const googleError = (status: number, reasons: string[], message = 'error') =>
  json({ error: { code: status, message, errors: reasons.map((reason) => ({ reason, message, domain: 'youtube' })) } }, status);

interface FeedEntryFixture {
  id: string;
  title?: string;
  shorts?: boolean;
  published?: string;
  views?: number;
  channelId?: string;
}

function feedXml(channelId: string, entries: FeedEntryFixture[]): string {
  const body = entries
    .map(
      (e) => `
  <entry>
    <id>yt:video:${e.id}</id>
    <yt:videoId>${e.id}</yt:videoId>
    <yt:channelId>${e.channelId ?? channelId}</yt:channelId>
    <title>${e.title ?? `Title ${e.id}`}</title>
    <link rel="alternate" href="https://www.youtube.com/${e.shorts ? `shorts/${e.id}` : `watch?v=${e.id}`}"/>
    <author><name>Someone</name><uri>https://www.youtube.com/channel/${channelId}</uri></author>
    <published>${e.published ?? '2026-10-01T10:00:00+00:00'}</published>
    <updated>${e.published ?? '2026-10-01T10:00:00+00:00'}</updated>
    <media:group>
      <media:title>${e.title ?? `Title ${e.id}`}</media:title>
      <media:thumbnail url="https://i1.ytimg.com/vi/${e.id}/hqdefault.jpg" width="480" height="360"/>
      <media:community><media:statistics views="${e.views ?? 10}"/></media:community>
    </media:group>
  </entry>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
  <link rel="self" href="http://www.youtube.com/feeds/videos.xml?channel_id=${channelId}"/>
  <id>yt:channel:${suffix(channelId)}</id>
  <yt:channelId>${channelId}</yt:channelId>
  <title>Someone</title>${body}
</feed>`;
}

function pushXml(channelId: string, videoId: string, published: string, updated = published): string {
  return `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">
  <link rel="hub" href="https://pubsubhubbub.appspot.com"/>
  <link rel="self" href="https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channelId}"/>
  <title>YouTube video feed</title>
  <updated>${updated}</updated>
  <entry>
    <id>yt:video:${videoId}</id>
    <yt:videoId>${videoId}</yt:videoId>
    <yt:channelId>${channelId}</yt:channelId>
    <title>Pushed</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=${videoId}"/>
    <author><name>Someone</name><uri>https://www.youtube.com/channel/${channelId}</uri></author>
    <published>${published}</published>
    <updated>${updated}</updated>
  </entry>
</feed>`;
}

const deletedXml = (channelId: string, videoId: string) => `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns:at="http://purl.org/atompub/tombstones/1.0" xmlns="http://www.w3.org/2005/Atom">
  <at:deleted-entry ref="yt:video:${videoId}" when="2026-10-03T11:59:00.000000+00:00">
    <link href="https://www.youtube.com/watch?v=${videoId}"/>
    <at:by><name>Someone</name><uri>https://www.youtube.com/channel/${channelId}</uri></at:by>
  </at:deleted-entry>
</feed>`;

const thumbs = (id: string, live = false) => ({
  high: { url: `https://i.ytimg.com/vi/${id}/hqdefault${live ? '_live' : ''}.jpg` },
  maxres: { url: `https://i.ytimg.com/vi/${id}/maxresdefault${live ? '_live' : ''}.jpg` },
});

function upload(id: string, channelId: string, o: { duration?: string; vertical?: boolean; published?: string; title?: string } = {}): ApiVideo {
  return {
    id,
    snippet: {
      channelId,
      title: o.title ?? `Upload ${id}`,
      publishedAt: o.published ?? '2026-10-01T10:00:00Z',
      liveBroadcastContent: 'none',
      categoryId: '20',
      thumbnails: thumbs(id),
    },
    contentDetails: { duration: o.duration ?? 'PT10M' },
    statistics: { viewCount: '1234' },
    player: o.vertical ? { embedWidth: '720', embedHeight: '1280' } : { embedWidth: '1280', embedHeight: '720' },
  };
}

function liveVideo(id: string, channelId: string, o: { viewers?: number | null; started?: string; title?: string } = {}): ApiVideo {
  return {
    id,
    snippet: {
      channelId,
      title: o.title ?? `Live ${id}`,
      publishedAt: o.started ?? iso(-HOUR),
      liveBroadcastContent: 'live',
      categoryId: '20',
      thumbnails: thumbs(id, true),
      tags: ['gaming', 'arabic'],
      defaultAudioLanguage: 'ar',
    },
    contentDetails: { duration: 'P0D' },
    liveStreamingDetails: {
      actualStartTime: o.started ?? iso(-HOUR),
      scheduledStartTime: iso(-HOUR - 5 * MIN),
      ...(o.viewers === null ? {} : { concurrentViewers: String(o.viewers ?? 1500) }),
    },
    statistics: { viewCount: '99' },
  };
}

function endedVideo(id: string, channelId: string, o: { started?: string; ended?: string; duration?: string } = {}): ApiVideo {
  return {
    id,
    snippet: { channelId, title: `Stream ${id}`, publishedAt: o.started ?? iso(-3 * HOUR), liveBroadcastContent: 'none', categoryId: '20', thumbnails: thumbs(id) },
    contentDetails: { duration: o.duration ?? 'PT2H' },
    liveStreamingDetails: { actualStartTime: o.started ?? iso(-3 * HOUR), actualEndTime: o.ended ?? iso(-HOUR) },
    statistics: { viewCount: '500' },
  };
}

function upcomingVideo(id: string, channelId: string, scheduled: string, premiere = false): ApiVideo {
  return {
    id,
    snippet: { channelId, title: `Soon ${id}`, publishedAt: iso(-DAY), liveBroadcastContent: 'upcoming', categoryId: '20', thumbnails: thumbs(id, true) },
    contentDetails: { duration: premiere ? 'PT12M30S' : 'P0D' },
    liveStreamingDetails: { scheduledStartTime: scheduled },
  };
}
const DAY = 24 * HOUR;

/** In-memory fake of the YouTube endpoints we use. */
function fakeYouTube() {
  const calls: Call[] = [];
  const videos = new Map<string, ApiVideo>();
  const channels = new Map<string, { id: string; snippet: Record<string, unknown>; contentDetails: Record<string, unknown> }>();
  const handles = new Map<string, string>();
  const usernames = new Map<string, string>();
  const feeds = new Map<string, () => Response>();
  const playlists = new Map<string, string[]>();
  const searchResults: Array<{ id: { kind: string; channelId: string }; snippet: { title: string } }> = [];
  const state = {
    hub: (_call: Call): Response | Promise<Response> => new Response(null, { status: 202 }),
    apiFailure: null as null | (() => Response),
  };

  const addChannel = (id: string, title: string, customUrl?: string) => {
    channels.set(id, {
      id,
      snippet: { title, customUrl, thumbnails: { default: { url: 'https://yt3.ggpht.com/d' }, high: { url: 'https://yt3.ggpht.com/high' } } },
      contentDetails: { relatedPlaylists: { uploads: `UU${suffix(id)}` } },
    });
  };

  const api = (call: Call): Response => {
    if (state.apiFailure) return state.apiFailure();
    const q = call.url.searchParams;
    switch (call.path) {
      case '/youtube/v3/videos': {
        const ids = (q.get('id') ?? '').split(',').filter(Boolean);
        return json({ items: ids.map((id) => videos.get(id)).filter(Boolean) });
      }
      case '/youtube/v3/channels': {
        const id = q.get('id') ?? (q.get('forHandle') ? handles.get(q.get('forHandle')!.toLowerCase()) : undefined) ?? usernames.get(q.get('forUsername') ?? '');
        const found = id ? channels.get(id) : undefined;
        return json({ kind: 'youtube#channelListResponse', pageInfo: { totalResults: found ? 1 : 0 }, ...(found ? { items: [found] } : {}) });
      }
      case '/youtube/v3/playlistItems': {
        const list = playlists.get(q.get('playlistId') ?? '');
        if (!list) return googleError(404, ['playlistNotFound']);
        const videoId = q.get('videoId');
        const ids = videoId ? list.filter((id) => id === videoId) : list.slice(0, Number(q.get('maxResults') ?? 5));
        return json({ items: ids.map((id) => ({ id: `pi-${id}`, contentDetails: { videoId: id, videoPublishedAt: '2026-10-01T10:00:00Z' } })) });
      }
      case '/youtube/v3/videoCategories':
        return json({ items: [{ id: '20', snippet: { title: 'Gaming' } }, { id: '22', snippet: { title: 'People & Blogs' } }] });
      case '/youtube/v3/search':
        return json({ items: searchResults });
      default:
        return googleError(404, ['notFound']);
    }
  };

  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const call: Call = { method: init?.method ?? 'GET', url, host: url.host, path: url.pathname, body: init?.body == null ? null : String(init.body) };
    calls.push(call);
    if (url.host === 'www.googleapis.com') return api(call);
    if (url.host === 'www.youtube.com' && url.pathname === '/feeds/videos.xml') {
      const feed = feeds.get(url.searchParams.get('channel_id') ?? '');
      return feed ? feed() : new Response('Not Found', { status: 404 });
    }
    if (url.host === 'pubsubhubbub.appspot.com') return state.hub(call);
    return new Response('unexpected host', { status: 500 });
  };

  const apiCalls = (endpoint?: string) => calls.filter((c) => c.host === 'www.googleapis.com' && (!endpoint || c.path === `/youtube/v3/${endpoint}`));
  return {
    fetchImpl,
    calls,
    videos,
    channels,
    handles,
    usernames,
    feeds,
    playlists,
    searchResults,
    state,
    addChannel,
    apiCalls,
    rssCalls: () => calls.filter((c) => c.path === '/feeds/videos.xml'),
    hubCalls: () => calls.filter((c) => c.host === 'pubsubhubbub.appspot.com'),
    reset: () => (calls.length = 0),
    setFeed: (channelId: string, entries: FeedEntryFixture[]) => feeds.set(channelId, () => xml(feedXml(channelId, entries))),
  };
}

type Fake = ReturnType<typeof fakeYouTube>;

function makeProvider(fake: Fake, o: { env?: Record<string, string | undefined>; kv?: KeyValueStore; clock?: ReturnType<typeof clock>; opts?: YouTubeProviderOptions } = {}) {
  const config = loadConfig({ DISCORD_TOKEN: 't', DISCORD_CLIENT_ID: 'c', YOUTUBE_API_KEY: 'yt-key', ...o.env });
  const c = o.clock ?? clock();
  const kv = o.kv ?? newKv();
  const provider = new YouTubeProvider({ config, logger: silent, kv, fetch: fake.fetchImpl }, { now: c.now, apiRetries: 0, ...o.opts });
  return { provider, kv, clock: c };
}

const webhookEnv = { PUBLIC_URL: 'https://bot.example.com', YOUTUBE_WEBSUB_SECRET: SECRET };

function signedPost(body: string, secret = SECRET): WebhookRequest {
  const raw = Buffer.from(body);
  return {
    method: 'POST',
    headers: { 'x-hub-signature': `sha1=${createHmac('sha1', secret).update(raw).digest('hex')}`, 'content-type': 'application/atom+xml' },
    query: {},
    rawBody: raw,
  };
}

const verifyRequest = (mode: string, channelId: string, extra: Record<string, string> = {}): WebhookRequest => ({
  method: 'GET',
  headers: {},
  query: { 'hub.mode': mode, 'hub.topic': websubTopic(channelId), 'hub.challenge': 'challenge-123', ...extra },
  rawBody: Buffer.alloc(0),
});

// ───────────────────────────── pure helpers ─────────────────────────────

describe('parseYouTubeInput', () => {
  it.each([
    ['@Someone', { kind: 'handle', handle: 'Someone' }],
    ['https://www.youtube.com/@Someone/videos', { kind: 'handle', handle: 'Someone' }],
    ['youtube.com/@Someone', { kind: 'handle', handle: 'Someone' }],
    ['https://www.youtube.com/@%D8%B9%D8%B2%D9%88%D8%B2', { kind: 'handle', handle: 'عزوز' }],
    ['@عزوز', { kind: 'handle', handle: 'عزوز' }],
    ['<https://www.youtube.com/@Someone>', { kind: 'handle', handle: 'Someone' }],
    [CH1, { kind: 'id', id: CH1 }],
    [`https://m.youtube.com/channel/${CH1}/live`, { kind: 'id', id: CH1 }],
    [`https://studio.youtube.com/channel/${CH1}`, { kind: 'id', id: CH1 }],
    [`https://www.youtube.com/playlist?list=UU${suffix(CH1)}`, { kind: 'id', id: CH1 }],
    [`https://www.youtube.com/playlist?list=UUSH${suffix(CH1)}`, { kind: 'id', id: CH1 }],
    ['https://www.youtube.com/user/OldName', { kind: 'username', username: 'OldName' }],
    ['https://www.youtube.com/c/CustomName', { kind: 'custom', name: 'CustomName' }],
    ['https://www.youtube.com/LegacyVanity', { kind: 'custom', name: 'LegacyVanity' }],
    ['https://youtu.be/dQw4w9WgXcQ?t=10', { kind: 'video', id: 'dQw4w9WgXcQ' }],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=x', { kind: 'video', id: 'dQw4w9WgXcQ' }],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', { kind: 'video', id: 'dQw4w9WgXcQ' }],
    ['https://www.youtube.com/live/dQw4w9WgXcQ?feature=share', { kind: 'video', id: 'dQw4w9WgXcQ' }],
    ['someone_123', { kind: 'name', name: 'someone_123' }],
  ])('parses %s', (input, expected) => {
    expect(parseYouTubeInput(input)).toEqual(expected);
  });

  it.each([
    '',
    '   ',
    'https://twitch.tv/someone',
    'https://www.youtube.com/results?search_query=x',
    'https://www.youtube.com/channel/not-an-id',
    'https://www.youtube.com/watch?v=short',
    'some name with spaces',
    'kick.com/someone',
    'https://www.youtube.com/',
  ])('rejects %j with an Arabic ValidationError', (input) => {
    expect(() => parseYouTubeInput(input)).toThrow(ValidationError);
  });
});

describe('parseIsoDuration', () => {
  it.each([
    ['PT1H2M3S', 3723],
    ['PT45S', 45],
    ['PT3M', 180],
    ['P1DT2H', 93_600],
    ['P0D', 0],
    ['PT0S', 0],
  ])('%s → %d', (input, expected) => expect(parseIsoDuration(input)).toBe(expected));

  it.each(['', 'P', 'PT', '1H', null, undefined])('returns null for %j', (input) => expect(parseIsoDuration(input)).toBeNull());
});

describe('Pacific quota day', () => {
  it('computes the quota day and the next Pacific midnight across DST changes', () => {
    expect(pacificDay(NOW)).toBe('2026-10-03');
    expect(nextPacificMidnight(NOW)).toBe(Date.parse('2026-10-04T07:00:00Z'));
    // 2026-11-01 05:00Z is still Oct 31 in Los Angeles (PDT).
    expect(pacificDay(Date.parse('2026-11-01T05:00:00Z'))).toBe('2026-10-31');
    expect(nextPacificMidnight(Date.parse('2026-11-01T05:00:00Z'))).toBe(Date.parse('2026-11-01T07:00:00Z'));
    // After the fall-back the offset is -8 h.
    expect(nextPacificMidnight(Date.parse('2026-11-01T12:00:00Z'))).toBe(Date.parse('2026-11-02T08:00:00Z'));
    // Spring-forward night: 01:00 PST → next midnight is already PDT.
    expect(nextPacificMidnight(Date.parse('2027-03-14T09:00:00Z'))).toBe(Date.parse('2027-03-15T07:00:00Z'));
  });
});

describe('parseYouTubeFeed', () => {
  it('extracts ids, Shorts links, views and normalized timestamps', () => {
    const feed = parseYouTubeFeed(
      feedXml(CH1, [
        { id: vid(1), title: 'A &amp; B', shorts: true, published: '2026-10-01T12:00:00.123456789+00:00', views: 77 },
        { id: '12345678901' },
      ]),
    );
    expect(feed.channelId).toBe(CH1);
    expect(feed.entries).toHaveLength(2);
    expect(feed.entries[0]).toMatchObject({
      videoId: vid(1),
      channelId: CH1,
      title: 'A & B',
      link: `https://www.youtube.com/shorts/${vid(1)}`,
      published: '2026-10-01T12:00:00.123Z',
      views: 77,
      thumbnailUrl: `https://i1.ytimg.com/vi/${vid(1)}/hqdefault.jpg`,
    });
    // All-digit ids must stay strings.
    expect(feed.entries[1]!.videoId).toBe('12345678901');
  });

  it('parses deleted entries and empty feeds', () => {
    expect(parseYouTubeFeed(deletedXml(CH1, vid(9))).deleted).toEqual([{ videoId: vid(9), channelId: CH1, deletedAt: '2026-10-03T11:59:00.000Z' }]);
    expect(parseYouTubeFeed('<feed xmlns="http://www.w3.org/2005/Atom"></feed>')).toEqual({ channelId: null, entries: [], deleted: [] });
  });

  it.each(['', 'not xml at all', '<html><body>Before you continue to YouTube</body></html>', '<feed><entry>', '{"error":true}'])(
    'rejects %j',
    (input) => {
      expect(() => parseYouTubeFeed(input)).toThrow();
    },
  );
});

describe('classifyVideo', () => {
  it('distinguishes streams, Premieres, VODs and uploads', () => {
    expect(classifyVideo(upcomingVideo(vid(1), CH1, iso(HOUR)))).toEqual({ type: 'upcoming', premiere: false, scheduledStartTime: iso(HOUR) });
    expect(classifyVideo(upcomingVideo(vid(1), CH1, iso(HOUR), true))).toMatchObject({ type: 'upcoming', premiere: true });
    expect(classifyVideo(liveVideo(vid(2), CH1))).toEqual({ type: 'live', premiere: false, actualStartTime: iso(-HOUR) });
    const premiereLive = { ...liveVideo(vid(3), CH1), contentDetails: { duration: 'PT12M' } };
    expect(classifyVideo(premiereLive)).toMatchObject({ type: 'live', premiere: true });
    expect(classifyVideo(endedVideo(vid(4), CH1))).toEqual({ type: 'ended', actualStartTime: iso(-3 * HOUR), actualEndTime: iso(-HOUR) });
    expect(classifyVideo(upload(vid(5), CH1))).toEqual({ type: 'upload' });
    const starting = { ...liveVideo(vid(6), CH1), liveStreamingDetails: { scheduledStartTime: iso(0) } };
    expect(classifyVideo(starting)).toMatchObject({ type: 'upcoming', premiere: false });
  });

  it('falls back to Shorts heuristics by duration, aspect ratio and upload date', () => {
    const base = { publishedAt: '2026-10-01T00:00:00Z', shortLink: null, aspect: null };
    expect(heuristicIsShort({ ...base, durationSec: 45 })).toBe(true);
    expect(heuristicIsShort({ ...base, durationSec: 170 })).toBe(true);
    expect(heuristicIsShort({ ...base, durationSec: 170, publishedAt: '2023-01-01T00:00:00Z' })).toBe(false);
    expect(heuristicIsShort({ ...base, durationSec: 45, aspect: 16 / 9 })).toBe(false);
    expect(heuristicIsShort({ ...base, durationSec: 400 })).toBe(false);
    expect(heuristicIsShort({ ...base, durationSec: 400, shortLink: true })).toBe(true);
  });
});

// ───────────────────────────── resolve ─────────────────────────────

describe('resolveChannel', () => {
  it('resolves @handles through channels.list forHandle and maps the channel', async () => {
    const fake = fakeYouTube();
    fake.addChannel(CH1, 'Someone TV', '@someone');
    fake.handles.set('@someone', CH1);
    const { provider, kv } = makeProvider(fake);

    const resolved = await provider.resolveChannel('https://www.youtube.com/@Someone');

    expect(resolved).toEqual({
      platform: 'youtube',
      platformId: CH1,
      handle: '@someone',
      displayName: 'Someone TV',
      avatarUrl: 'https://yt3.ggpht.com/high',
      url: 'https://www.youtube.com/@someone',
      meta: { uploadsPlaylistId: `UU${suffix(CH1)}` },
    });
    const call = fake.apiCalls('channels')[0]!;
    expect(call.url.searchParams.get('forHandle')).toBe('@Someone');
    expect(call.url.searchParams.get('part')).toBe('snippet,contentDetails');
    expect(call.url.searchParams.get('key')).toBe('yt-key');
    expect(kv.get('youtube:quota')).toMatchObject({ day: '2026-10-03', used: 1 });
  });

  it('URL-encodes non-Latin handles and builds encoded profile URLs', async () => {
    const fake = fakeYouTube();
    fake.addChannel(CH1, 'عزوز', '@عزوز');
    fake.handles.set('@عزوز', CH1);
    const { provider } = makeProvider(fake);

    const resolved = await provider.resolveChannel('@عزوز');

    expect(fake.apiCalls('channels')[0]!.url.search).toContain('forHandle=%40%D8%B9%D8%B2%D9%88%D8%B2');
    expect(resolved.handle).toBe('@عزوز');
    expect(resolved.url).toBe('https://www.youtube.com/@%D8%B9%D8%B2%D9%88%D8%B2');
  });

  it('resolves channel ids, legacy usernames, custom URLs (search fallback) and video links', async () => {
    const fake = fakeYouTube();
    fake.addChannel(CH1, 'One');
    fake.addChannel(CH2, 'Custom Name');
    fake.usernames.set('OldName', CH1);
    fake.searchResults.push({ id: { kind: 'youtube#channel', channelId: CH2 }, snippet: { title: 'Custom Name' } });
    fake.videos.set('dQw4w9WgXcQ', upload('dQw4w9WgXcQ', CH2));
    const { provider, kv } = makeProvider(fake);

    expect((await provider.resolveChannel(CH1)).platformId).toBe(CH1);
    expect((await provider.resolveChannel(`https://www.youtube.com/channel/${CH1}`)).url).toBe(`https://www.youtube.com/channel/${CH1}`);
    expect((await provider.resolveChannel('https://www.youtube.com/user/OldName')).platformId).toBe(CH1);
    expect((await provider.resolveChannel('https://youtu.be/dQw4w9WgXcQ')).platformId).toBe(CH2);

    fake.reset();
    const custom = await provider.resolveChannel('https://www.youtube.com/c/CustomName');
    expect(custom.platformId).toBe(CH2);
    expect(fake.apiCalls().map((c) => [...c.url.searchParams.keys()].find((k) => ['forHandle', 'forUsername', 'q', 'id'].includes(k)))).toEqual([
      'forHandle',
      'forUsername',
      'q',
      'id',
    ]);
    expect(fake.apiCalls('search')[0]!.url.searchParams.get('type')).toBe('channel');
    expect(kv.get('youtube:quota')).toMatchObject({ search: 1 });
  });

  it('bare names try the handle first, then the legacy username', async () => {
    const fake = fakeYouTube();
    fake.addChannel(CH1, 'Legacy');
    fake.usernames.set('legacy', CH1);
    const { provider } = makeProvider(fake);

    const resolved = await provider.resolveChannel('legacy');
    expect(resolved.platformId).toBe(CH1);
    expect(resolved.handle).toBe('@legacy');
    expect(fake.apiCalls('channels').map((c) => c.url.searchParams.has('forHandle'))).toEqual([true, false]);
  });

  it('throws ChannelNotFoundError for unknown channels and ProviderNotConfiguredError without a key', async () => {
    const fake = fakeYouTube();
    const { provider } = makeProvider(fake);
    await expect(provider.resolveChannel('@nobody')).rejects.toBeInstanceOf(ChannelNotFoundError);
    await expect(provider.resolveChannel(CH2)).rejects.toBeInstanceOf(ChannelNotFoundError);

    const unconfigured = createYouTubeProvider({ config: loadConfig({ DISCORD_TOKEN: 't', DISCORD_CLIENT_ID: 'c' }), logger: silent, kv: newKv(), fetch: fake.fetchImpl });
    expect(unconfigured.isConfigured()).toBe(false);
    expect(unconfigured.health()).toEqual({ configured: false, notes: [expect.stringContaining('YOUTUBE_API_KEY')] });
    await expect(unconfigured.resolveChannel('@x')).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    await expect(unconfigured.checkLive([channel(CH1)])).rejects.toBeInstanceOf(ProviderNotConfiguredError);
  });

  it('maps a rejected API key (badRequest + API_KEY_INVALID) to ProviderNotConfiguredError with a health note', async () => {
    const fake = fakeYouTube();
    fake.state.apiFailure = () =>
      json({ error: { code: 400, message: 'API key not valid.', errors: [{ reason: 'badRequest' }], details: [{ reason: 'API_KEY_INVALID' }] } }, 400);
    const { provider } = makeProvider(fake);

    await expect(provider.resolveChannel('@x')).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    // Cool-down: no further calls hammer Google with a bad key.
    await expect(provider.resolveChannel('@y')).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    expect(fake.apiCalls()).toHaveLength(1);
    expect(provider.health().notes.join('\n')).toContain('API_KEY_INVALID');
  });
});

// ───────────────────────────── live ─────────────────────────────

describe('checkLive', () => {
  function liveSetup() {
    const fake = fakeYouTube();
    fake.setFeed(CH1, [{ id: vid(1) }, { id: vid(2) }, { id: vid(3) }]);
    fake.setFeed(CH2, [{ id: vid(10) }]);
    fake.videos.set(vid(1), liveVideo(vid(1), CH1));
    fake.videos.set(vid(2), upload(vid(2), CH1));
    fake.videos.set(vid(3), endedVideo(vid(3), CH1));
    fake.videos.set(vid(10), upload(vid(10), CH2));
    return fake;
  }

  it('classifies the first listing in one batched call and reports live streams with full details', async () => {
    const fake = liveSetup();
    const { provider, kv } = makeProvider(fake);

    const snapshots = await provider.checkLive([channel(CH1, 1), channel(CH2, 2), channel('bad-id', 3), channel(CH1, 4)]);

    expect(snapshots).toHaveLength(4);
    expect(snapshots[0]).toMatchObject({
      platform: 'youtube',
      platformId: CH1,
      isLive: true,
      streamId: vid(1),
      title: `Live ${vid(1)}`,
      category: 'Gaming',
      categoryImageUrl: null,
      viewers: 1500,
      startedAt: iso(-HOUR),
      url: `https://www.youtube.com/watch?v=${vid(1)}`,
      language: 'ar',
      tags: ['gaming', 'arabic'],
    });
    expect(snapshots[0]!.thumbnailUrl).toMatch(new RegExp(`^https://i\\.ytimg\\.com/vi/${vid(1)}/maxresdefault_live\\.jpg\\?t=\\d+$`));
    expect(snapshots[1]).toMatchObject({ platformId: CH2, isLive: false, streamId: null, url: `https://www.youtube.com/channel/${CH2}` });
    expect(snapshots[2]).toMatchObject({ platformId: 'bad-id', isLive: false });
    expect(snapshots[3]).toMatchObject({ platformId: CH1, isLive: true, streamId: vid(1) });

    const videoCalls = fake.apiCalls('videos');
    expect(videoCalls).toHaveLength(1);
    expect(videoCalls[0]!.url.searchParams.get('id')!.split(',').sort()).toEqual([vid(1), vid(2), vid(3), vid(10)].sort());
    expect(videoCalls[0]!.url.searchParams.get('part')).toBe('snippet,contentDetails,liveStreamingDetails,statistics,player');
    expect(fake.apiCalls('videoCategories')).toHaveLength(1);
    expect(fake.rssCalls()).toHaveLength(2);
    // The candidate set is persisted per channel.
    expect(kv.get<{ candidates: Array<{ id: string; status: string }> }>(`youtube:ch:${CH1}`)?.candidates).toEqual([
      expect.objectContaining({ id: vid(1), status: 'live' }),
    ]);
  });

  it('tracks a stream from live to ended, then offers its VOD', async () => {
    const fake = liveSetup();
    const { provider, clock: c } = makeProvider(fake);
    await provider.checkLive([channel(CH1)]);

    // Within the re-check interval the cached resource is reused (no quota spent).
    fake.reset();
    c.advance(20 * SEC);
    expect((await provider.checkLive([channel(CH1)]))[0]!.isLive).toBe(true);
    expect(fake.apiCalls()).toHaveLength(0);

    // Two minutes later only the live candidate is re-checked; RSS has nothing new.
    c.advance(2 * MIN);
    fake.videos.set(vid(1), liveVideo(vid(1), CH1, { viewers: 2100, title: 'New title' }));
    fake.reset();
    const [updated] = await provider.checkLive([channel(CH1)]);
    expect(updated).toMatchObject({ isLive: true, viewers: 2100, title: 'New title' });
    expect(fake.apiCalls('videos').map((call) => call.url.searchParams.get('id'))).toEqual([vid(1)]);
    expect(fake.apiCalls('videoCategories')).toHaveLength(0);

    c.advance(2 * MIN);
    fake.videos.set(vid(1), endedVideo(vid(1), CH1, { started: iso(-HOUR), ended: iso(4 * MIN), duration: 'P0D' }));
    const [ended] = await provider.checkLive([channel(CH1)]);
    expect(ended).toMatchObject({ isLive: false, streamId: null });

    fake.reset();
    const content = await provider.fetchRecentContent(channel(CH1), ['vod']);
    expect(content.map((i) => [i.contentId, i.kind, i.relatedStreamId])).toEqual([
      [vid(1), 'vod', vid(1)],
      [vid(3), 'vod', vid(3)],
    ]);
    // VOD duration falls back to the broadcast span while YouTube still processes the recording.
    expect(content[0]).toMatchObject({ durationSec: 64 * 60, publishedAt: iso(4 * MIN) });
    expect(await provider.findVodUrl(channel(CH1), vid(1))).toBe(`https://www.youtube.com/watch?v=${vid(1)}`);
    expect(fake.apiCalls()).toHaveLength(0);
  });

  it('keeps hidden viewer counts live (viewers null) and drops vanished streams without a VOD', async () => {
    const fake = fakeYouTube();
    fake.setFeed(CH1, [{ id: vid(1) }]);
    fake.videos.set(vid(1), liveVideo(vid(1), CH1, { viewers: null }));
    const { provider, clock: c } = makeProvider(fake);

    expect((await provider.checkLive([channel(CH1)]))[0]).toMatchObject({ isLive: true, viewers: null });

    c.advance(2 * MIN);
    fake.videos.delete(vid(1));
    expect((await provider.checkLive([channel(CH1)]))[0]!.isLive).toBe(false);
    expect(await provider.findVodUrl(channel(CH1), vid(1))).toBeNull();
  });

  it('re-checks far-future schedules slowly and imminent ones on every poll until they go live', async () => {
    const fake = fakeYouTube();
    const start = iso(2 * HOUR);
    fake.setFeed(CH1, [{ id: vid(1) }]);
    fake.videos.set(vid(1), upcomingVideo(vid(1), CH1, start));
    const { provider, clock: c } = makeProvider(fake);

    expect((await provider.checkLive([channel(CH1)]))[0]!.isLive).toBe(false);

    fake.reset();
    c.advance(2 * MIN);
    await provider.checkLive([channel(CH1)]);
    expect(fake.apiCalls('videos')).toHaveLength(0);

    c.advance(14 * MIN); // 16 min after the first check: slow re-check is due
    await provider.checkLive([channel(CH1)]);
    expect(fake.apiCalls('videos')).toHaveLength(1);

    c.t = Date.parse(start) - 10 * MIN; // inside the 15-min window: every poll
    fake.reset();
    await provider.checkLive([channel(CH1)]);
    c.advance(2 * MIN);
    await provider.checkLive([channel(CH1)]);
    expect(fake.apiCalls('videos')).toHaveLength(2);

    c.t = Date.parse(start) + MIN;
    fake.videos.set(vid(1), liveVideo(vid(1), CH1, { started: start }));
    expect((await provider.checkLive([channel(CH1)]))[0]).toMatchObject({ isLive: true, streamId: vid(1), startedAt: start });
  });

  it('never reports Premieres as live and announces them as videos once they play', async () => {
    const fake = fakeYouTube();
    const start = iso(5 * MIN);
    fake.setFeed(CH1, [{ id: vid(1) }, { id: vid(2) }]);
    fake.videos.set(vid(1), upcomingVideo(vid(1), CH1, start, true));
    fake.videos.set(vid(2), upload(vid(2), CH1));
    const { provider, clock: c } = makeProvider(fake);

    await provider.checkLive([channel(CH1)]);
    expect((await provider.fetchRecentContent(channel(CH1), ['video'])).map((i) => i.contentId)).toEqual([vid(2)]);

    c.advance(6 * MIN);
    fake.videos.set(vid(1), { ...liveVideo(vid(1), CH1, { started: start }), contentDetails: { duration: 'PT12M30S' } });
    expect((await provider.checkLive([channel(CH1)]))[0]!.isLive).toBe(false);
    const content = await provider.fetchRecentContent(channel(CH1), ['video', 'vod']);
    expect(content.map((i) => [i.contentId, i.kind])).toEqual([
      [vid(1), 'video'],
      [vid(2), 'video'],
    ]);
  });

  it('reports the earliest-started stream when a channel broadcasts twice at once', async () => {
    const fake = fakeYouTube();
    fake.setFeed(CH1, [{ id: vid(2) }, { id: vid(1) }]);
    fake.videos.set(vid(1), liveVideo(vid(1), CH1, { started: iso(-2 * HOUR) }));
    fake.videos.set(vid(2), liveVideo(vid(2), CH1, { started: iso(-10 * MIN) }));
    const { provider } = makeProvider(fake);
    expect((await provider.checkLive([channel(CH1)]))[0]!.streamId).toBe(vid(1));
  });

  it('throws when a live stream cannot be re-checked so the monitor keeps the previous state', async () => {
    const fake = liveSetup();
    const { provider, clock: c } = makeProvider(fake);
    await provider.checkLive([channel(CH1)]);

    c.advance(2 * MIN);
    fake.state.apiFailure = () => new Response('backend error', { status: 503 });
    await expect(provider.checkLive([channel(CH1)])).rejects.toBeInstanceOf(ProviderError);

    fake.state.apiFailure = null;
    expect((await provider.checkLive([channel(CH1)]))[0]!.isLive).toBe(true);
  });

  it('lets not-yet-due candidates ride along in calls that are sent anyway', async () => {
    const fake = liveSetup();
    const { provider, clock: c } = makeProvider(fake);
    await provider.checkLive([channel(CH1)]);
    const forceRss = () => ((provider as unknown as { rss: Map<string, { nextAt: number }> }).rss.get(CH1)!.nextAt = 0);

    // Nothing new and the live stream was checked 20 s ago: no call at all.
    c.advance(20 * SEC);
    forceRss();
    fake.reset();
    await provider.checkLive([channel(CH1)]);
    expect(fake.apiCalls('videos')).toHaveLength(0);

    // A new upload must be classified anyway, so the (not yet due) live stream is refreshed for free.
    c.advance(5 * SEC);
    fake.setFeed(CH1, [{ id: vid(4) }, { id: vid(1) }, { id: vid(2) }, { id: vid(3) }]);
    fake.videos.set(vid(4), upload(vid(4), CH1));
    fake.videos.set(vid(1), liveVideo(vid(1), CH1, { viewers: 4500 }));
    forceRss();
    fake.reset();
    const [snapshot] = await provider.checkLive([channel(CH1)]);
    expect(fake.apiCalls('videos')).toHaveLength(1);
    expect(fake.apiCalls('videos')[0]!.url.searchParams.get('id')!.split(',').sort()).toEqual([vid(1), vid(4)].sort());
    expect(snapshot!.viewers).toBe(4500);
  });

  it('retries ids the API does not return yet without failing the check', async () => {
    const fake = fakeYouTube();
    fake.setFeed(CH1, []);
    const { provider, clock: c } = makeProvider(fake);
    await provider.checkLive([channel(CH1)]);

    fake.setFeed(CH1, [{ id: vid(1), published: iso(0) }]);
    c.advance(2 * MIN);
    expect((await provider.checkLive([channel(CH1)]))[0]!.isLive).toBe(false); // not visible to the API yet

    fake.reset();
    c.advance(MIN);
    await provider.checkLive([channel(CH1)]);
    expect(fake.apiCalls('videos')).toHaveLength(0); // backing off (2 min)

    fake.videos.set(vid(1), liveVideo(vid(1), CH1, { started: iso(MIN) }));
    c.advance(2 * MIN);
    expect((await provider.checkLive([channel(CH1)]))[0]).toMatchObject({ isLive: true, streamId: vid(1) });
  });

  it('turns a scheduled stream that started and ended between polls into a VOD', async () => {
    const fake = fakeYouTube();
    fake.setFeed(CH1, [{ id: vid(1) }]);
    fake.videos.set(vid(1), upcomingVideo(vid(1), CH1, iso(5 * MIN)));
    const { provider, clock: c } = makeProvider(fake);
    await provider.checkLive([channel(CH1)]);

    c.advance(30 * MIN);
    fake.videos.set(vid(1), endedVideo(vid(1), CH1, { started: iso(6 * MIN), ended: iso(20 * MIN) }));
    expect((await provider.checkLive([channel(CH1)]))[0]!.isLive).toBe(false);
    const items = await provider.fetchRecentContent(channel(CH1), ['vod']);
    expect(items.map((i) => [i.contentId, i.kind, i.relatedStreamId])).toEqual([[vid(1), 'vod', vid(1)]]);
    expect(await provider.findVodUrl(channel(CH1), vid(1))).toBe(`https://www.youtube.com/watch?v=${vid(1)}`);
  });

  it('resumes tracking persisted candidates after a restart', async () => {
    const fake = liveSetup();
    const kv = newKv();
    await makeProvider(fake, { kv }).provider.checkLive([channel(CH1)]);

    fake.feeds.set(CH1, () => new Response('down', { status: 500 }));
    fake.playlists.set(`UU${suffix(CH1)}`, [vid(1), vid(2), vid(3)]);
    fake.reset();
    const restarted = makeProvider(fake, { kv }).provider;
    expect((await restarted.checkLive([channel(CH1)]))[0]).toMatchObject({ isLive: true, streamId: vid(1) });
    // Known ids are not re-classified; only the live candidate is fetched.
    expect(fake.apiCalls('videos').map((call) => call.url.searchParams.get('id'))).toEqual([vid(1)]);
  });
});

// ───────────────────────────── content ─────────────────────────────

describe('fetchRecentContent', () => {
  it('classifies Shorts with free signals first and the UUSH playlist only when needed', async () => {
    const fake = fakeYouTube();
    fake.setFeed(CH1, [{ id: vid(1) }]);
    fake.videos.set(vid(1), upload(vid(1), CH1, { published: '2026-09-01T00:00:00Z' }));
    const { provider, clock: c } = makeProvider(fake);
    await provider.fetchRecentContent(channel(CH1), ['video']); // baseline

    fake.setFeed(CH1, [
      { id: vid(6), published: iso(-5 * MIN) },
      { id: vid(5), published: iso(-6 * MIN) },
      { id: vid(4), published: iso(-7 * MIN) },
      { id: vid(3), published: iso(-8 * MIN) },
      { id: vid(2), shorts: true, published: iso(-9 * MIN) },
      { id: vid(1) },
    ]);
    fake.videos.set(vid(2), upload(vid(2), CH1, { duration: 'PT40S', vertical: true, published: iso(-9 * MIN) }));
    fake.videos.set(vid(3), upload(vid(3), CH1, { duration: 'PT50S', vertical: true, published: iso(-8 * MIN) }));
    fake.videos.set(vid(4), upload(vid(4), CH1, { duration: 'PT55S', vertical: true, published: iso(-7 * MIN) }));
    fake.videos.set(vid(5), upload(vid(5), CH1, { duration: 'PT2M', vertical: false, published: iso(-6 * MIN) }));
    fake.videos.set(vid(6), upload(vid(6), CH1, { duration: 'PT8M', vertical: true, published: iso(-5 * MIN) }));
    fake.playlists.set(`UUSH${suffix(CH1)}`, [vid(3)]);
    c.advance(2 * MIN);
    fake.reset();

    const items = await provider.fetchRecentContent(channel(CH1), ['video', 'short']);

    expect(items.map((i) => [i.contentId, i.kind])).toEqual([
      [vid(6), 'video'], // > 3 min
      [vid(5), 'video'], // horizontal
      [vid(4), 'video'], // RSS /watch link + not in UUSH
      [vid(3), 'short'], // in UUSH
      [vid(2), 'short'], // RSS /shorts/ link
      [vid(1), 'video'],
    ]);
    expect(items.find((i) => i.contentId === vid(2))!.url).toBe(`https://www.youtube.com/shorts/${vid(2)}`);
    const uush = fake.apiCalls('playlistItems').map((call) => call.url.searchParams.get('videoId'));
    expect(uush.sort()).toEqual([vid(3), vid(4)]);
    expect(fake.apiCalls('videos')).toHaveLength(1);
    expect((await provider.fetchRecentContent(channel(CH1), ['short'])).map((i) => i.contentId)).toEqual([vid(3), vid(2)]);
  });

  it('holds back a fresh upload once when UUSH has not caught up yet', async () => {
    const fake = fakeYouTube();
    fake.setFeed(CH1, []);
    const { provider, clock: c } = makeProvider(fake, { env: webhookEnv });
    await provider.webhook!.sync([channel(CH1)]);
    provider.webhook!.handle(verifyRequest('subscribe', CH1, { 'hub.lease_seconds': '432000' }));
    await provider.fetchRecentContent(channel(CH1), ['short']); // baseline (empty channel)

    fake.videos.set(vid(7), upload(vid(7), CH1, { duration: 'PT30S', vertical: true, published: iso(-MIN) }));
    const res = await provider.webhook!.handle(signedPost(pushXml(CH1, vid(7), iso(-MIN)).replace('watch?v=', 'video/')));
    expect(res.hints).toHaveLength(2);

    expect(await provider.fetchRecentContent(channel(CH1), ['short', 'video'])).toEqual([]);
    c.advance(4 * MIN);
    fake.playlists.set(`UUSH${suffix(CH1)}`, [vid(7)]);
    const items = await provider.fetchRecentContent(channel(CH1), ['short', 'video']);
    expect(items.map((i) => [i.contentId, i.kind])).toEqual([[vid(7), 'short']]);
    expect(fake.apiCalls('playlistItems').filter((call) => call.url.searchParams.get('videoId') === vid(7))).toHaveLength(2);
  });

  it('uses heuristics (no UUSH calls) for baseline items and skips live/upcoming videos', async () => {
    const fake = fakeYouTube();
    fake.setFeed(CH1, [{ id: vid(1) }, { id: vid(2) }, { id: vid(3) }]);
    fake.videos.set(vid(1), liveVideo(vid(1), CH1));
    fake.videos.set(vid(2), upcomingVideo(vid(2), CH1, iso(DAY)));
    fake.videos.set(vid(3), upload(vid(3), CH1, { duration: 'PT45S', vertical: true }));
    const { provider } = makeProvider(fake);

    const items = await provider.fetchRecentContent(channel(CH1), ['video', 'short', 'vod']);
    expect(items).toEqual([
      {
        platform: 'youtube',
        platformId: CH1,
        contentId: vid(3),
        kind: 'video', // RSS /watch link says it is not a Short
        title: `Upload ${vid(3)}`,
        url: `https://www.youtube.com/watch?v=${vid(3)}`,
        thumbnailUrl: `https://i.ytimg.com/vi/${vid(3)}/maxresdefault.jpg`,
        publishedAt: '2026-10-01T10:00:00.000Z',
        durationSec: 45,
        viewCount: 1234,
        relatedStreamId: null,
      },
    ]);
    expect(fake.apiCalls('playlistItems')).toHaveLength(0);
    expect(await provider.fetchRecentContent(channel(CH1), ['highlight', 'clip'])).toEqual([]);
  });

  it('asks UULF whether a broadcast first seen after it ended was a Premiere', async () => {
    const fake = fakeYouTube();
    fake.setFeed(CH1, []);
    const { provider, clock: c } = makeProvider(fake);
    await provider.fetchRecentContent(channel(CH1), ['vod']);

    fake.setFeed(CH1, [{ id: vid(1), published: iso(-HOUR) }, { id: vid(2), published: iso(-2 * HOUR) }]);
    fake.videos.set(vid(1), endedVideo(vid(1), CH1, { started: iso(-30 * MIN), ended: iso(-MIN), duration: 'PT29M' }));
    fake.videos.set(vid(2), endedVideo(vid(2), CH1, { started: iso(-3 * HOUR), ended: iso(-2 * HOUR) }));
    fake.playlists.set(`UULF${suffix(CH1)}`, [vid(1)]);
    c.advance(2 * MIN);

    const items = await provider.fetchRecentContent(channel(CH1), ['video', 'vod']);
    expect(items.map((i) => [i.contentId, i.kind, i.relatedStreamId])).toEqual([
      [vid(1), 'video', null],
      [vid(2), 'vod', vid(2)],
    ]);
  });

  it('throws instead of returning a partial list when the channel was never listed', async () => {
    const fake = fakeYouTube();
    fake.feeds.set(CH1, () => new Response('nope', { status: 500 }));
    fake.state.apiFailure = () => new Response('backend error', { status: 500 });
    const { provider } = makeProvider(fake);
    await expect(provider.fetchRecentContent(channel(CH1), ['video'])).rejects.toBeInstanceOf(ProviderError);
    // The UU fallback was tried and failed too.
    expect(fake.apiCalls('playlistItems')).toHaveLength(1);
  });

  it('treats a missing uploads playlist as a channel without uploads', async () => {
    const fake = fakeYouTube();
    fake.feeds.set(CH1, () => new Response('Not Found', { status: 404 }));
    const { provider } = makeProvider(fake);
    expect(await provider.fetchRecentContent(channel(CH1), ['video'])).toEqual([]);
  });

  it('refreshes titles and view counts of cached items from later feed fetches', async () => {
    const fake = fakeYouTube();
    fake.setFeed(CH1, [{ id: vid(1), views: 5 }]);
    fake.videos.set(vid(1), upload(vid(1), CH1));
    const { provider, clock: c } = makeProvider(fake);
    expect((await provider.fetchRecentContent(channel(CH1), ['video']))[0]).toMatchObject({ viewCount: 1234 });

    fake.setFeed(CH1, [{ id: vid(1), views: 4321, title: 'Renamed' }]);
    c.advance(2 * MIN);
    fake.reset();
    expect((await provider.fetchRecentContent(channel(CH1), ['video']))[0]).toMatchObject({ viewCount: 4321, title: 'Renamed' });
    expect(fake.apiCalls()).toHaveLength(0);
  });
});

// ───────────────────────────── RSS fallback & reconciliation ─────────────────────────────

describe('RSS fallback and reconciliation', () => {
  it('falls back to the UU playlist at most every 15 minutes while RSS is broken', async () => {
    const fake = fakeYouTube();
    fake.feeds.set(CH1, () => new Response('Not Found', { status: 404 }));
    fake.playlists.set(`UU${suffix(CH1)}`, [vid(1)]);
    fake.videos.set(vid(1), upload(vid(1), CH1));
    const { provider, clock: c } = makeProvider(fake);

    await provider.checkLive([channel(CH1)]);
    expect(fake.apiCalls('playlistItems')).toHaveLength(1);
    expect(fake.apiCalls('playlistItems')[0]!.url.searchParams.get('playlistId')).toBe(`UU${suffix(CH1)}`);
    expect((await provider.fetchRecentContent(channel(CH1), ['video'])).map((i) => i.contentId)).toEqual([vid(1)]);

    // RSS keeps failing (invalid XML now); UU is not re-polled inside the 15-min window.
    fake.feeds.set(CH1, () => xml('<html><body>consent</body></html>'));
    for (let i = 0; i < 4; i++) {
      c.advance(3 * MIN);
      await provider.checkLive([channel(CH1)]);
    }
    expect(fake.apiCalls('playlistItems')).toHaveLength(1);
    expect(provider.health().notes.join('\n')).toContain('RSS');

    // Past the window the fallback runs again and finds the new upload.
    fake.playlists.set(`UU${suffix(CH1)}`, [vid(2), vid(1)]);
    fake.videos.set(vid(2), upload(vid(2), CH1, { published: iso(-MIN) }));
    c.advance(5 * MIN);
    await provider.checkLive([channel(CH1)]);
    expect(fake.apiCalls('playlistItems')).toHaveLength(2);
    expect((await provider.fetchRecentContent(channel(CH1), ['video'])).map((i) => i.contentId)).toEqual([vid(2), vid(1)]);
  });

  it('backs off RSS retries while a feed keeps failing', async () => {
    const fake = fakeYouTube();
    fake.feeds.set(CH1, () => new Response('down', { status: 503 }));
    fake.playlists.set(`UU${suffix(CH1)}`, []);
    const { provider, clock: c } = makeProvider(fake);
    await provider.checkLive([channel(CH1)]);
    c.advance(2 * MIN);
    await provider.checkLive([channel(CH1)]); // second failure → next retry ≥ 190 s later
    c.advance(2 * MIN);
    await provider.checkLive([channel(CH1)]);
    expect(fake.rssCalls()).toHaveLength(2);
  });

  it('reconciles each channel against the UU playlist every 30 minutes', async () => {
    const fake = fakeYouTube();
    fake.setFeed(CH1, [{ id: vid(1) }]);
    fake.videos.set(vid(1), upload(vid(1), CH1));
    fake.playlists.set(`UU${suffix(CH1)}`, [vid(1)]);
    const { provider, clock: c } = makeProvider(fake);

    await provider.checkLive([channel(CH1)]);
    expect(fake.apiCalls('playlistItems')).toHaveLength(0);
    let reconciled = 0;
    for (let i = 0; i < 16; i++) {
      c.advance(2 * MIN);
      await provider.checkLive([channel(CH1)]);
      reconciled = fake.apiCalls('playlistItems').length;
    }
    expect(reconciled).toBe(1);
  });
});

// ───────────────────────────── quota ─────────────────────────────

describe('quota tracker', () => {
  it('counts units per Pacific day and resets at Pacific midnight', async () => {
    const fake = fakeYouTube();
    fake.addChannel(CH1, 'One');
    const { provider, kv, clock: c } = makeProvider(fake);
    await provider.resolveChannel(CH1);
    await provider.resolveChannel(CH1);
    expect(kv.get('youtube:quota')).toMatchObject({ day: '2026-10-03', used: 2 });

    c.t = Date.parse('2026-10-04T07:00:01Z');
    await provider.resolveChannel(CH1);
    expect(kv.get('youtube:quota')).toMatchObject({ day: '2026-10-04', used: 1 });
  });

  it('skips reconciliation and UUSH checks above 9000 units but keeps essential calls', async () => {
    const fake = fakeYouTube();
    fake.setFeed(CH1, []);
    fake.playlists.set(`UU${suffix(CH1)}`, []);
    fake.playlists.set(`UUSH${suffix(CH1)}`, []);
    const kv = newKv();
    kv.set('youtube:quota', { day: '2026-10-03', used: 9001, search: 0, exhaustedUntil: null });
    const { provider, clock: c } = makeProvider(fake, { kv });
    await provider.fetchRecentContent(channel(CH1), ['short']);

    fake.setFeed(CH1, [{ id: vid(1), published: iso(-MIN) }]);
    fake.videos.set(vid(1), upload(vid(1), CH1, { duration: 'PT40S', vertical: true, published: iso(-MIN) }));
    c.advance(HOUR);
    const items = await provider.fetchRecentContent(channel(CH1), ['short', 'video']);

    // Essential classification still ran; the Short was decided heuristically (RSS /watch link → video).
    expect(fake.apiCalls('videos')).toHaveLength(1);
    expect(items.map((i) => [i.contentId, i.kind])).toEqual([[vid(1), 'video']]);
    expect(fake.apiCalls('playlistItems')).toHaveLength(0);
    expect(provider.health().notes.join('\n')).toContain('9000');
  });

  it('stops all API calls after quotaExceeded until the next Pacific midnight', async () => {
    const fake = fakeYouTube();
    fake.setFeed(CH1, [{ id: vid(1) }]);
    fake.videos.set(vid(1), liveVideo(vid(1), CH1));
    const { provider, kv, clock: c } = makeProvider(fake);
    await provider.checkLive([channel(CH1)]);

    c.advance(2 * MIN);
    fake.state.apiFailure = () => googleError(403, ['quotaExceeded'], 'The request cannot be completed because you have exceeded your quota.');
    await expect(provider.checkLive([channel(CH1)])).rejects.toBeInstanceOf(QuotaExhaustedError);
    expect(kv.get('youtube:quota')).toMatchObject({ exhaustedUntil: Date.parse('2026-10-04T07:00:00Z') });
    expect(provider.health().notes.join('\n')).toContain('انتهت حصة');

    fake.reset();
    c.advance(HOUR);
    await expect(provider.checkLive([channel(CH1)])).rejects.toBeInstanceOf(QuotaExhaustedError);
    await expect(provider.resolveChannel(CH1)).rejects.toBeInstanceOf(QuotaExhaustedError);
    expect(fake.apiCalls()).toHaveLength(0);
    expect(fake.rssCalls().length).toBeGreaterThan(0); // free discovery keeps running

    fake.state.apiFailure = null;
    c.t = Date.parse('2026-10-04T07:01:00Z');
    expect((await provider.checkLive([channel(CH1)]))[0]!.isLive).toBe(true);
    expect(kv.get('youtube:quota')).toMatchObject({ day: '2026-10-04', exhaustedUntil: null });
  });

  it('returns offline snapshots without the API when nothing needs checking, even with no quota left', async () => {
    const fake = fakeYouTube();
    fake.setFeed(CH1, [{ id: vid(1) }]);
    fake.videos.set(vid(1), upload(vid(1), CH1));
    const kv = newKv();
    const { provider, clock: c } = makeProvider(fake, { kv });
    await provider.checkLive([channel(CH1)]);

    kv.set('youtube:quota', { day: '2026-10-03', used: 10_000, search: 0, exhaustedUntil: Date.parse('2026-10-04T07:00:00Z') });
    const reloaded = makeProvider(fake, { kv, clock: c }).provider;
    c.advance(2 * MIN);
    fake.reset();
    expect((await reloaded.checkLive([channel(CH1)]))[0]!.isLive).toBe(false);
    expect(fake.apiCalls()).toHaveLength(0);
  });
});

// ───────────────────────────── WebSub ─────────────────────────────

describe('WebSub', () => {
  it('is only enabled with an https PUBLIC_URL and YOUTUBE_WEBSUB_SECRET', () => {
    const fake = fakeYouTube();
    expect(makeProvider(fake).provider.webhook).toBeUndefined();
    expect(makeProvider(fake).provider.capabilities).toEqual({ live: true, content: ['video', 'short', 'vod'], liveBatchSize: 50, push: false });
    expect(makeProvider(fake, { env: { PUBLIC_URL: 'https://bot.example.com' } }).provider.webhook).toBeUndefined();
    expect(makeProvider(fake, { env: { PUBLIC_URL: 'https://bot.example.com' } }).provider.health().notes.join('\n')).toContain('YOUTUBE_WEBSUB_SECRET');
    const enabled = makeProvider(fake, { env: webhookEnv }).provider;
    expect(enabled.webhook?.path).toBe('/webhooks/youtube');
    expect(enabled.capabilities.push).toBe(true);
  });

  it('subscribes, verifies the challenge for tracked topics only and stores the granted lease', async () => {
    const fake = fakeYouTube();
    const { provider, clock: c } = makeProvider(fake, { env: webhookEnv });
    const hook = provider.webhook!;

    await hook.sync([channel(CH1)]);
    const [sub] = fake.hubCalls();
    const form = new URLSearchParams(sub!.body!);
    expect(sub!.url.toString()).toBe('https://pubsubhubbub.appspot.com/subscribe');
    expect(Object.fromEntries(form)).toEqual({
      'hub.mode': 'subscribe',
      'hub.topic': `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${CH1}`,
      'hub.callback': CALLBACK,
      'hub.verify': 'async',
      'hub.verify_token': expect.stringMatching(/^[0-9a-f]{32}$/),
      'hub.secret': SECRET,
      'hub.lease_seconds': '864000',
    });

    expect((await hook.handle(verifyRequest('subscribe', CH1, { 'hub.verify_token': 'forged-token-forged-token-forged' }))).status).toBe(404);
    const ok = await hook.handle(verifyRequest('subscribe', CH1, { 'hub.lease_seconds': '432000', 'hub.verify_token': form.get('hub.verify_token')! }));
    expect(ok).toEqual({ status: 200, body: 'challenge-123', contentType: 'text/plain; charset=utf-8', hints: [] });
    expect(hook.subscription(CH1)).toMatchObject({ status: 'active', leaseSeconds: 432000, expiresAt: c.t + 432_000_000 });
    expect((await hook.handle(verifyRequest('subscribe', CH2))).status).toBe(404);
    expect((await hook.handle(verifyRequest('unsubscribe', CH1))).status).toBe(404);
    expect((await hook.handle({ ...verifyRequest('subscribe', CH1), query: { 'hub.mode': 'subscribe', 'hub.topic': 'https://evil.example.com/feed' } })).status).toBe(404);
    expect(provider.health().notes.join('\n')).toContain('1 اشتراك فعّال');

    // A verification long after our request (e.g. someone else's subscribe request) is refused.
    c.advance(2 * HOUR);
    expect((await hook.handle(verifyRequest('subscribe', CH1))).status).toBe(404);
  });

  it('renews leases with less than 25% left and unsubscribes removed channels', async () => {
    const fake = fakeYouTube();
    const { provider, clock: c } = makeProvider(fake, { env: webhookEnv });
    const hook = provider.webhook!;
    await hook.sync([channel(CH1), channel(CH2)]);
    await hook.handle(verifyRequest('subscribe', CH1, { 'hub.lease_seconds': '400000' }));
    await hook.handle(verifyRequest('subscribe', CH2, { 'hub.lease_seconds': '400000' }));

    fake.reset();
    c.advance(200_000 * SEC); // 50% left
    await hook.sync([channel(CH1), channel(CH2)]);
    expect(fake.hubCalls()).toHaveLength(0);

    c.advance(120_000 * SEC); // 20% left → renew CH1; CH2 was removed → unsubscribe
    await hook.sync([channel(CH1)]);
    const forms = fake.hubCalls().map((call) => Object.fromEntries(new URLSearchParams(call.body!)));
    expect(forms.map((f) => [f['hub.mode'], f['hub.topic']?.slice(-24)])).toEqual([
      ['subscribe', CH1],
      ['unsubscribe', CH2],
    ]);
    expect(hook.subscription(CH1)).toMatchObject({ status: 'active', awaitingVerification: true });
    expect((await hook.handle(verifyRequest('unsubscribe', CH2))).status).toBe(200);
    expect(hook.subscription(CH2)).toBeNull();
    await hook.handle(verifyRequest('subscribe', CH1, { 'hub.lease_seconds': '864000' }));
    expect(hook.subscription(CH1)).toMatchObject({ status: 'active', leaseSeconds: 864000, awaitingVerification: false });
  });

  it('backs off when the hub answers 503 with Retry-After, and retries unverified subscriptions later', async () => {
    const fake = fakeYouTube();
    fake.state.hub = () => new Response('busy', { status: 503, headers: { 'retry-after': '600' } });
    const { provider, clock: c } = makeProvider(fake, { env: webhookEnv });
    const hook = provider.webhook!;

    await hook.sync([channel(CH1), channel(CH2)]);
    expect(fake.hubCalls()).toHaveLength(1);
    c.advance(5 * MIN);
    await hook.sync([channel(CH1), channel(CH2)]);
    expect(fake.hubCalls()).toHaveLength(1);

    fake.state.hub = () => new Response(null, { status: 202 });
    c.advance(6 * MIN);
    await hook.sync([channel(CH1), channel(CH2)]);
    expect(fake.hubCalls()).toHaveLength(3);

    // Accepted but never verified (callback unreachable): failed after 15 min, retried with backoff.
    c.advance(16 * MIN);
    fake.reset();
    await hook.sync([channel(CH1), channel(CH2)]);
    expect(fake.hubCalls()).toHaveLength(0);
    expect(hook.subscription(CH1)).toMatchObject({ status: 'failed', failures: 1 });
    c.advance(6 * MIN);
    await hook.sync([channel(CH1), channel(CH2)]);
    expect(fake.hubCalls()).toHaveLength(2);
  });

  it('verifies signatures, ignores stale/deleted entries and queues fresh videos for the next check', async () => {
    const fake = fakeYouTube();
    fake.setFeed(CH1, [{ id: vid(1) }]);
    fake.videos.set(vid(1), upload(vid(1), CH1));
    const { provider } = makeProvider(fake, { env: webhookEnv });
    const hook = provider.webhook!;
    await hook.sync([channel(CH1)]);
    await provider.checkLive([channel(CH1)]);

    const fresh = pushXml(CH1, vid(2), iso(-2 * MIN));
    expect((await hook.handle({ ...signedPost(fresh), headers: {} })).status).toBe(403);
    expect((await hook.handle(signedPost(fresh, 'wrong-secret'))).status).toBe(403);
    expect((await hook.handle({ ...signedPost(fresh), headers: { 'x-hub-signature': 'sha1=zz' } })).status).toBe(403);

    const accepted = await hook.handle(signedPost(fresh));
    expect(accepted.status).toBe(204);
    expect(accepted.hints).toEqual([
      { type: 'content', platform: 'youtube', platformId: CH1, contentId: vid(2) },
      { type: 'live', platform: 'youtube', platformId: CH1 },
    ]);
    // Duplicate delivery of the same notification → no new hints.
    expect((await hook.handle(signedPost(fresh))).hints).toEqual([]);
    // Edit of an old video → ignored.
    expect((await hook.handle(signedPost(pushXml(CH1, vid(1), iso(-5 * DAY), iso(-MIN))))).hints).toEqual([]);
    // Untracked channel → ignored.
    expect((await hook.handle(signedPost(pushXml(CH2, vid(8), iso(-MIN))))).hints).toEqual([]);
    // Deleted entry of a non-stream → no hints.
    expect((await hook.handle(signedPost(deletedXml(CH1, vid(1))))).hints).toEqual([]);
    // Garbage with a valid signature is acknowledged without hints.
    expect(await hook.handle(signedPost('<<<not xml'))).toEqual({ status: 204, hints: [] });

    // The pushed id is classified by the next live check even though RSS does not list it yet.
    fake.videos.set(vid(2), liveVideo(vid(2), CH1, { started: iso(-MIN) }));
    fake.reset();
    const [snapshot] = await provider.checkLive([channel(CH1)]);
    expect(snapshot).toMatchObject({ isLive: true, streamId: vid(2) });
    expect(fake.apiCalls('videos')[0]!.url.searchParams.get('id')).toBe(vid(2));

    // Pushes about a tracked live stream (even old-published edits) produce a live hint.
    expect((await hook.handle(signedPost(pushXml(CH1, vid(2), iso(-2 * HOUR), iso(0))))).hints).toEqual([
      { type: 'live', platform: 'youtube', platformId: CH1 },
    ]);
  });

  it('exposes signature and topic helpers', () => {
    const body = Buffer.from('<feed/>');
    const sig = createHmac('sha256', 's').update(body).digest('hex');
    expect(verifyHubSignature(body, `sha256=${sig}`, 's')).toBe(true);
    expect(verifyHubSignature(body, `sha256=${sig}`, 't')).toBe(false);
    expect(verifyHubSignature(body, undefined, 's')).toBe(false);
    expect(channelIdFromTopic(websubTopic(CH1))).toBe(CH1);
    expect(channelIdFromTopic('https://www.youtube.com/xml/feeds/videos.xml?channel_id=nope')).toBeNull();
  });
});
