import { createHash } from 'node:crypto';
import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { ChannelNotFoundError, ProviderError, RateLimitedError, ValidationError } from '../../src/core/errors.js';
import type { ChannelRef } from '../../src/core/types.js';
import type { FetchLike } from '../../src/platforms/http.js';
import {
  TikTokProvider,
  createTikTokProvider,
  findWafChallenge,
  normalizeTikTokHandle,
  parseTikTokInput,
  solveWafChallenge,
  tiktokIdToDate,
} from '../../src/platforms/tiktok.js';
import type { KeyValueStore } from '../../src/platforms/types.js';

// ───────────────────────────── harness ─────────────────────────────

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  redirect: string | undefined;
}

type Handler = (call: Call, nth: number) => Response | Promise<Response>;

class FakeTikTok {
  readonly calls: Call[] = [];
  private readonly routes = new Map<string, Handler>();

  on(url: string, handler: Handler): this {
    this.routes.set(url, handler);
    return this;
  }

  readonly fetch: FetchLike = async (input, init = {}) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)]),
    );
    const call: Call = { url, method: (init.method ?? 'GET').toUpperCase(), headers, redirect: init.redirect };
    this.calls.push(call);
    const key = `${url.origin}${url.pathname}`;
    const handler = this.routes.get(key);
    if (!handler) return new Response(`no route for ${url.href}`, { status: 418 });
    return handler(call, this.callsTo(key).length);
  };

  callsTo(url: string): Call[] {
    return this.calls.filter((c) => `${c.url.origin}${c.url.pathname}` === url);
  }
}

class MemoryKv implements KeyValueStore {
  readonly data = new Map<string, string>();
  get<T = unknown>(key: string): T | undefined {
    const raw = this.data.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }
  set(key: string, value: unknown): void {
    this.data.set(key, JSON.stringify(value));
  }
  delete(key: string): void {
    this.data.delete(key);
  }
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const forbidden = () => html('<html><body>Access Denied</body></html>', 403);

const MINUTE = 60_000;
const T0 = Date.parse('2026-10-03T12:00:00Z');
const HANDLE = 'streamer.one';
const ROOM_ID = '7556123456789012345';
const USER_ID = '6621496731283095554';
const SEC_UID = 'MS4wLjABAAAAv7iSuuXDJGDvJkmH_vz1qkDZYo1apxgzaxdBSeIuPiM';

const API_LIVE = 'https://www.tiktok.com/api-live/user/room/';
const ROOM_INFO = 'https://webcast.tiktok.com/webcast/room/info/';
const LIVE_PAGE = `https://www.tiktok.com/@${HANDLE}/live`;
const PROFILE_PAGE = `https://www.tiktok.com/@${HANDLE}`;
const EMBED = `https://www.tiktok.com/embed/@${HANDLE}`;
const OEMBED = 'https://www.tiktok.com/oembed';
const EULER_ROOM_ID = `https://api.eulerstream.com/webcast/anchors/${HANDLE}/room_id`;
const RSSHUB_FEED = `http://rsshub:1200/tiktok/user/@${HANDLE}`;

// Video ids encode their creation time in the upper 32 bits.
const VID_1H = '7692394660435315989'; // 2026-10-03T11:00:00Z
const VID_2H = '7692379199417247921'; // 2026-10-03T10:00:00Z
const VID_OLD_PINNED = '7618193087319245355'; // 2026-03-17T12:00:00Z
const VID_PRIVATE = '7692402391252992042'; // 2026-10-03T11:30:00Z

const START_TIME = Math.floor((T0 - 30 * MINUTE) / 1000);

const liveUser = (overrides: Record<string, unknown> = {}) => ({
  id: USER_ID,
  uniqueId: HANDLE,
  nickname: 'Streamer One',
  avatarThumb: 'https://p16-sign.tiktokcdn.com/avatar-thumb.jpeg',
  avatarLarger: 'https://p16-sign.tiktokcdn.com/avatar-large.jpeg',
  secUid: SEC_UID,
  verified: true,
  secret: false,
  roomId: ROOM_ID,
  signature: 'bio',
  ...overrides,
});

const liveRoom = (status: number, overrides: Record<string, unknown> = {}) => ({
  title: 'Late night chill',
  status,
  startTime: START_TIME,
  coverUrl: 'https://p16-webcast.tiktokcdn.com/live-cover.jpeg',
  liveRoomStats: { userCount: 321, enterCount: 2000 },
  streamId: '2995107789123456789',
  ...overrides,
});

const apiLiveBody = (status: number, userOverrides: Record<string, unknown> = {}) => ({
  data: { user: liveUser(userOverrides), liveRoom: liveRoom(status) },
  extra: { fatal_ids: [], logid: '20261003120000', now: T0 },
  message: '',
  statusCode: 0,
});

const USER_NOT_FOUND = { data: {}, extra: { now: T0 }, message: 'user_not_found', statusCode: 19881007 };

const roomInfoBody = (status: number) => ({
  data: {
    id_str: ROOM_ID,
    status,
    title: 'Ranked grind with viewers',
    user_count: 1543,
    create_time: START_TIME - 60,
    cover: { url_list: ['https://p16-webcast.tiktokcdn.com/room-cover.webp', 'https://p19-webcast.tiktokcdn.com/room-cover.webp'] },
    owner: { display_id: HANDLE, nickname: 'Streamer One' },
    hashtag: { id: '5', title: 'Gaming', image: { url_list: ['https://p16-webcast.tiktokcdn.com/gaming.png'] } },
    game_tag: [{ id: 1, show_name: 'Fortnite', full_name: 'Fortnite' }],
    stats: { total_user: 4000 },
  },
  extra: { now: T0 },
  status_code: 0,
});

function embedHtml(handle: string, entry: unknown): string {
  const state = { router: { link: `/embed/@${handle}` }, source: { data: { [`/embed/@${handle}`]: entry } } };
  return `<!DOCTYPE html><html><head><title>TikTok</title><script id="__FRONTITY_CONNECT_STATE__" type="application/json">${JSON.stringify(state)}</script></head><body><div id="root"></div></body></html>`;
}

const embedUser = {
  id: USER_ID,
  uniqueId: HANDLE,
  nickname: 'Streamer One',
  avatarThumbUrl: 'https://p16-sign.tiktokcdn.com/avatar-embed.jpeg',
  verified: true,
  privateAccount: false,
  followerCount: 120000,
  heartCount: 3400000,
  signature: 'bio',
  code: 0,
};

const embedVideo = (id: string, desc: string, extra: Record<string, unknown> = {}) => ({
  id,
  desc,
  coverUrl: `https://p16-sign.tiktokcdn.com/cover-${id}.jpeg?x-expires=1&x-signature=abc`,
  originCoverUrl: `https://p16-sign.tiktokcdn.com/origin-${id}.jpeg`,
  playAddr: `https://v16.tiktokcdn.com/${id}.mp4`,
  playCount: 1000,
  privateItem: false,
  authorUniqueId: HANDLE,
  ...extra,
});

function sigiHtml(info: unknown): string {
  return `<!DOCTYPE html><html><head><script id="SIGI_STATE" type="application/json">${JSON.stringify({ AppContext: {}, LiveRoom: { liveRoomUserInfo: info } })}</script></head><body></body></html>`;
}

function profileHtml(detail: unknown): string {
  return `<!DOCTYPE html><html><head><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({ __DEFAULT_SCOPE__: { 'webapp.user-detail': detail } })}</script></head></html>`;
}

const CAPTCHA_PAGE = '<!DOCTYPE html><html><head><title>Security Check</title></head><body><div id="captcha_container" class="captcha_verify_container"></div></body></html>';

function wafPage(n: number): { page: string; prefix: string } {
  const prefix = Buffer.from('client-bound-prefix-123').toString('base64');
  const digest = createHash('sha256').update(Buffer.from(prefix, 'base64')).update(String(n)).digest('base64');
  const cs = Buffer.from(JSON.stringify({ v: { a: prefix, b: '1759492800', c: digest }, s: 'server-signature' })).toString('base64');
  return {
    prefix,
    page: `<!DOCTYPE html><html><head><title>Please wait...</title></head><body><p id="wci" class="_wafchallengeid"></p><p id="cs" class="${cs}"></p><script src="/waf.js"></script></body></html>`,
  };
}

const logger = pino({ level: 'silent' });
const baseEnv = { DISCORD_TOKEN: 't', DISCORD_CLIENT_ID: 'c' };
const channel: ChannelRef = { id: 1, platform: 'tiktok', platformId: HANDLE, handle: HANDLE, meta: {} };

let clock = T0;
let server: FakeTikTok;
let kv: MemoryKv;

function setup(env: Record<string, string> = {}, store: KeyValueStore = kv): TikTokProvider {
  return new TikTokProvider(
    { config: loadConfig({ ...baseEnv, ...env }), logger, kv: store, fetch: server.fetch },
    { now: () => clock, minRequestGapMs: 0, maxRequestGapMs: 0 },
  );
}

beforeEach(() => {
  clock = T0;
  server = new FakeTikTok();
  kv = new MemoryKv();
});

// ───────────────────────────── input parsing ─────────────────────────────

describe('parseTikTokInput', () => {
  it.each([
    ['Streamer.One', 'streamer.one'],
    ['@streamer_1', 'streamer_1'],
    ['  @@Streamer.One  ', 'streamer.one'],
    ['https://www.tiktok.com/@Streamer.One', 'streamer.one'],
    ['https://www.tiktok.com/@streamer.one/', 'streamer.one'],
    ['https://www.tiktok.com/@streamer.one/live', 'streamer.one'],
    ['https://www.tiktok.com/@streamer.one/live?enter_from_merge=others_homepage', 'streamer.one'],
    [`https://www.tiktok.com/@streamer.one/video/${VID_1H}?is_from_webapp=1&sender_device=pc`, 'streamer.one'],
    ['tiktok.com/@streamer.one', 'streamer.one'],
    ['https://m.tiktok.com/@streamer.one', 'streamer.one'],
    ['<https://www.tiktok.com/@streamer.one>', 'streamer.one'],
    ['https://www.tiktok.com/embed/@streamer.one', 'streamer.one'],
    ['https://www.tiktok.com/%40streamer.one', 'streamer.one'],
  ])('parses %s', (input, expected) => {
    expect(parseTikTokInput(input)).toEqual({ kind: 'handle', handle: expected });
  });

  it('recognises short links that need a redirect lookup', () => {
    expect(parseTikTokInput('https://vm.tiktok.com/ZMabc123/')).toEqual({ kind: 'short_link', url: 'https://vm.tiktok.com/ZMabc123/' });
    expect(parseTikTokInput('vt.tiktok.com/ZSxyz/').kind).toBe('short_link');
    expect(parseTikTokInput('https://www.tiktok.com/t/ZT8abc/').kind).toBe('short_link');
  });

  it.each(['', '   ', 'bad handle!', 'name-with-dash', 'https://example.com/@streamer', 'https://www.tiktok.com/foryou', 'a'.repeat(31)])(
    'rejects %j with an Arabic ValidationError',
    (input) => {
      expect(() => parseTikTokInput(input)).toThrow(ValidationError);
    },
  );

  it('normalizes handles and decodes timestamps from video ids', () => {
    expect(normalizeTikTokHandle('@Some.User_9')).toBe('some.user_9');
    expect(normalizeTikTokHandle('nope nope')).toBeNull();
    expect(tiktokIdToDate(VID_1H)?.toISOString()).toBe('2026-10-03T11:00:00.000Z');
    expect(tiktokIdToDate('7210809319192726273')?.toISOString()).toBe('2023-03-15T16:22:55.000Z');
    expect(tiktokIdToDate('123')).toBeNull();
    expect(tiktokIdToDate('not-a-number')).toBeNull();
  });
});

describe('WAF challenge solver', () => {
  it('finds n and appends the answer to the signed envelope', async () => {
    const { page, prefix } = wafPage(7);
    const challenge = findWafChallenge(page);
    expect(challenge?.cookieName).toBe('_wafchallengeid');
    const answer = await solveWafChallenge(challenge!.payload);
    const solved = JSON.parse(Buffer.from(answer!, 'base64').toString('utf8'));
    expect(solved.v.a).toBe(prefix);
    expect(solved.s).toBe('server-signature');
    expect(Buffer.from(solved.d, 'base64').toString()).toBe('7');
  });

  it('gives up on malformed or unsolvable challenges', async () => {
    expect(await solveWafChallenge('not base64 json')).toBeNull();
    const { page } = wafPage(500);
    expect(await solveWafChallenge(findWafChallenge(page)!.payload, 100)).toBeNull();
    expect(findWafChallenge('<html><body>regular page</body></html>')).toBeNull();
  });
});

// ───────────────────────────── provider ─────────────────────────────

describe('TikTokProvider basics', () => {
  it('needs no credentials and advertises its capabilities', () => {
    const provider = createTikTokProvider({ config: loadConfig(baseEnv), logger, kv, fetch: server.fetch });
    expect(provider.platform).toBe('tiktok');
    expect(provider.isConfigured()).toBe(true);
    expect(provider.capabilities).toEqual({ live: true, content: ['video'], liveBatchSize: 1, push: false });
    expect(provider.webhook).toBeUndefined();
    const health = provider.health();
    expect(health.configured).toBe(true);
    expect(health.notes.join('\n')).toContain('غير رسمية');
  });
});

describe('resolveChannel', () => {
  it('resolves through the embed page using browser-like headers', async () => {
    server.on(EMBED, () => html(embedHtml(HANDLE, { userInfo: embedUser, videoList: [] })));
    const provider = setup();

    const resolved = await provider.resolveChannel(`https://www.tiktok.com/@Streamer.One/video/${VID_1H}?lang=en`);

    expect(resolved).toEqual({
      platform: 'tiktok',
      platformId: HANDLE,
      handle: HANDLE,
      displayName: 'Streamer One',
      avatarUrl: 'https://p16-sign.tiktokcdn.com/avatar-embed.jpeg',
      url: 'https://www.tiktok.com/@streamer.one',
      meta: { verified: true, source: 'embed', userId: USER_ID, verifiedBadge: true, privateAccount: false },
    });
    const [call] = server.callsTo(EMBED);
    expect(call?.headers['user-agent']).toMatch(/Chrome\/\d+/);
    expect(call?.headers.referer).toBe('https://www.tiktok.com/');
    expect(call?.headers['accept-language']).toContain('en');
    expect(call?.headers.cookie).toContain('tt-target-idc=');
  });

  it('expands short links before resolving', async () => {
    server
      .on('https://vm.tiktok.com/ZMabc123/', () =>
        new Response(null, { status: 301, headers: { location: `https://www.tiktok.com/@Streamer.One/video/${VID_1H}?_r=1&_t=abc` } }),
      )
      .on(EMBED, () => html(embedHtml(HANDLE, { userInfo: embedUser, videoList: [] })));
    const provider = setup();

    const resolved = await provider.resolveChannel('https://vm.tiktok.com/ZMabc123/');

    expect(resolved.platformId).toBe(HANDLE);
    expect(server.callsTo('https://vm.tiktok.com/ZMabc123/')[0]?.redirect).toBe('manual');
  });

  it('rejects a short link that does not lead to an account', async () => {
    server.on('https://vm.tiktok.com/ZMdead/', () => new Response('gone', { status: 404 }));
    await expect(setup().resolveChannel('https://vm.tiktok.com/ZMdead/')).rejects.toBeInstanceOf(ValidationError);
  });

  it('falls back to api-live (and keeps the secUid) when the embed is unavailable', async () => {
    server
      .on(EMBED, () => html(embedHtml(HANDLE, { userInfo: {}, videoList: [] })))
      .on(API_LIVE, () => json(apiLiveBody(4)));

    const resolved = await setup().resolveChannel('@streamer.one');

    expect(resolved.displayName).toBe('Streamer One');
    expect(resolved.avatarUrl).toBe('https://p16-sign.tiktokcdn.com/avatar-large.jpeg');
    expect(resolved.meta).toMatchObject({ verified: true, source: 'api-live', secUid: SEC_UID, userId: USER_ID, privateAccount: false });
  });

  it('throws ChannelNotFoundError when TikTok explicitly says the user does not exist', async () => {
    server
      .on(EMBED, () => html(embedHtml(HANDLE, { userInfo: { uniqueId: '', code: 10202 }, videoList: [] })))
      .on(API_LIVE, () => json(USER_NOT_FOUND));

    await expect(setup().resolveChannel(HANDLE)).rejects.toBeInstanceOf(ChannelNotFoundError);
    expect(server.callsTo(PROFILE_PAGE)).toHaveLength(0);
  });

  it('uses the profile page status code when the embed is blocked', async () => {
    server
      .on(EMBED, forbidden)
      .on(API_LIVE, () => json(USER_NOT_FOUND))
      .on(PROFILE_PAGE, () => html(profileHtml({ statusCode: 10202, statusMsg: 'user not exist', userInfo: {} })));

    await expect(setup().resolveChannel(HANDLE)).rejects.toBeInstanceOf(ChannelNotFoundError);
  });

  it('resolves private accounts from the profile page', async () => {
    server
      .on(EMBED, () => html(embedHtml(HANDLE, { userInfo: {}, videoList: [] })))
      .on(API_LIVE, () => json(USER_NOT_FOUND))
      .on(PROFILE_PAGE, () => html(profileHtml({ statusCode: 10222, userInfo: {} })));

    const resolved = await setup().resolveChannel(HANDLE);
    expect(resolved.meta).toMatchObject({ verified: true, source: 'profile', privateAccount: true });
  });

  it('still accepts the account (unverified) when TikTok blocks every lookup', async () => {
    server
      .on(EMBED, forbidden)
      .on(API_LIVE, () => html(CAPTCHA_PAGE))
      .on(PROFILE_PAGE, () => html(CAPTCHA_PAGE));

    const resolved = await setup().resolveChannel('https://www.tiktok.com/@Streamer.One');

    expect(resolved).toMatchObject({
      platformId: HANDLE,
      handle: HANDLE,
      displayName: HANDLE,
      avatarUrl: null,
      url: 'https://www.tiktok.com/@streamer.one',
      meta: { verified: false, source: 'unverified' },
    });
  });
});

describe('checkLive', () => {
  it('reports live via api-live, enriched with webcast room/info', async () => {
    server.on(API_LIVE, () => json(apiLiveBody(2))).on(ROOM_INFO, () => json(roomInfoBody(2)));

    const [snapshot] = await setup().checkLive([channel]);

    expect(snapshot).toEqual({
      platform: 'tiktok',
      platformId: HANDLE,
      isLive: true,
      streamId: ROOM_ID,
      title: 'Ranked grind with viewers',
      category: 'Fortnite',
      categoryImageUrl: null,
      thumbnailUrl: 'https://p16-webcast.tiktokcdn.com/room-cover.webp',
      viewers: 1543,
      startedAt: new Date((START_TIME - 60) * 1000).toISOString(),
      url: 'https://www.tiktok.com/@streamer.one/live',
      language: null,
      tags: ['Gaming', 'Fortnite'],
    });
    const apiCall = server.callsTo(API_LIVE)[0]!;
    expect(Object.fromEntries(apiCall.url.searchParams)).toEqual({ aid: '1988', sourceType: '54', uniqueId: HANDLE });
    expect(apiCall.headers.origin).toBe('https://www.tiktok.com');
    expect(server.callsTo(ROOM_INFO)[0]?.url.searchParams.get('room_id')).toBe(ROOM_ID);
  });

  it('keeps the api-live data when room/info is age restricted', async () => {
    server.on(API_LIVE, () => json(apiLiveBody(2))).on(ROOM_INFO, () => json({ data: { prompts: 'This LIVE is for adults only' }, status_code: 0 }));

    const [snapshot] = await setup().checkLive([channel]);

    expect(snapshot).toMatchObject({
      isLive: true,
      streamId: ROOM_ID,
      title: 'Late night chill',
      viewers: 321,
      thumbnailUrl: 'https://p16-webcast.tiktokcdn.com/live-cover.jpeg',
      startedAt: new Date(START_TIME * 1000).toISOString(),
      category: null,
      tags: [],
    });
  });

  it('ignores a room hosted by someone else (the account is only a guest there)', async () => {
    const hosted = roomInfoBody(2);
    hosted.data.owner = { display_id: 'another.creator', nickname: 'Host' };
    server.on(API_LIVE, () => json(apiLiveBody(2))).on(ROOM_INFO, () => json(hosted));
    const [snapshot] = await setup().checkLive([channel]);
    expect(snapshot?.isLive).toBe(false);
  });

  it('never starts a stream on the transitional status 3, but keeps a live stream alive through it', async () => {
    const provider = setup();
    server.on(API_LIVE, () => json(apiLiveBody(3))).on(ROOM_INFO, () => json(roomInfoBody(3)));
    await expect(provider.checkLive([channel])).rejects.toBeInstanceOf(ProviderError);

    server.on(API_LIVE, () => json(apiLiveBody(2))).on(ROOM_INFO, () => json(roomInfoBody(2)));
    expect((await provider.checkLive([channel]))[0]?.isLive).toBe(true);

    server.on(API_LIVE, () => json(apiLiveBody(3))).on(ROOM_INFO, () => json(roomInfoBody(3)));
    expect((await provider.checkLive([channel]))[0]?.isLive).toBe(true);
  });

  it('trusts room/info when the room has already ended', async () => {
    server.on(API_LIVE, () => json(apiLiveBody(2))).on(ROOM_INFO, () => json(roomInfoBody(4)));
    const [snapshot] = await setup().checkLive([channel]);
    expect(snapshot?.isLive).toBe(false);
  });

  it('reports offline for status 4 without extra requests', async () => {
    server.on(API_LIVE, () => json(apiLiveBody(4)));

    const [snapshot] = await setup().checkLive([channel]);

    expect(snapshot).toEqual({
      platform: 'tiktok',
      platformId: HANDLE,
      isLive: false,
      streamId: null,
      title: null,
      category: null,
      categoryImageUrl: null,
      thumbnailUrl: null,
      viewers: null,
      startedAt: null,
      url: 'https://www.tiktok.com/@streamer.one/live',
      language: null,
      tags: [],
    });
    expect(server.calls).toHaveLength(1);
  });

  it('treats user_not_found as offline, cross-checking the live page every 15 minutes', async () => {
    server
      .on(API_LIVE, () => json(USER_NOT_FOUND))
      .on(LIVE_PAGE, () => html(sigiHtml({ user: liveUser(), liveRoom: liveRoom(2) })))
      .on(ROOM_INFO, () => json(roomInfoBody(2)));
    const provider = setup();

    expect((await provider.checkLive([channel]))[0]?.isLive).toBe(false);
    clock += 5 * MINUTE;
    expect((await provider.checkLive([channel]))[0]?.isLive).toBe(false);
    expect(server.callsTo(LIVE_PAGE)).toHaveLength(0);

    // api-live sometimes says user_not_found for creators who are live; the periodic cross-check catches it.
    clock += 11 * MINUTE;
    const [snapshot] = await provider.checkLive([channel]);
    expect(snapshot).toMatchObject({ isLive: true, streamId: ROOM_ID, viewers: 1543 });
    expect(server.callsTo(LIVE_PAGE)).toHaveLength(1);
  });

  it('never reports offline when user_not_found contradicts a recent live observation', async () => {
    let apiLive: unknown = apiLiveBody(2);
    server
      .on(API_LIVE, () => json(apiLive))
      .on(ROOM_INFO, () => json(roomInfoBody(2)))
      .on(LIVE_PAGE, forbidden);
    const provider = setup();
    expect((await provider.checkLive([channel]))[0]?.isLive).toBe(true);

    apiLive = USER_NOT_FOUND;
    clock += 2 * MINUTE;
    const error = await provider.checkLive([channel]).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).not.toBeInstanceOf(RateLimitedError);
    expect((error as ProviderError).retryable).toBe(true);
    expect(server.callsTo(LIVE_PAGE)).toHaveLength(1);
  });

  it('falls back to the live page SIGI_STATE when api-live is blocked', async () => {
    server
      .on(API_LIVE, () => html(CAPTCHA_PAGE))
      .on(LIVE_PAGE, () => html(sigiHtml({ user: liveUser(), liveRoom: liveRoom(2, { title: 'From SIGI' }) })))
      .on(ROOM_INFO, () => json({ data: { message: 'room not found' }, status_code: 30003 }));
    const provider = setup();

    const [snapshot] = await provider.checkLive([channel]);

    expect(snapshot).toMatchObject({ isLive: true, streamId: ROOM_ID, title: 'From SIGI', viewers: 321 });
    expect(provider.health().notes.join('\n')).toContain('ما فيه حظر');
  });

  it('reads an offline status from SIGI_STATE', async () => {
    server.on(API_LIVE, () => json({ statusCode: 10000, message: 'verify' })).on(LIVE_PAGE, () => html(sigiHtml({ user: liveUser({ roomId: '' }), liveRoom: liveRoom(4) })));
    const [snapshot] = await setup().checkLive([channel]);
    expect(snapshot?.isLive).toBe(false);
  });

  it('throws a retryable ProviderError (never "offline") when every method is blocked', async () => {
    server.on(API_LIVE, forbidden).on(LIVE_PAGE, () => html('<html><head></head><body>empty shell</body></html>'));

    const error = await setup().checkLive([channel]).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).not.toBeInstanceOf(RateLimitedError);
    expect((error as ProviderError).message).toContain('Live status unknown');
  });

  it('uses Euler Stream as a last resort when configured', async () => {
    server
      .on(API_LIVE, forbidden)
      .on(LIVE_PAGE, forbidden)
      .on(EULER_ROOM_ID, () => json({ code: 200, ok: true, routes_attempted: ['tiktok'], is_live: true, room_id: ROOM_ID, room_status: 2 }))
      .on(ROOM_INFO, () => json(roomInfoBody(2)));

    const [snapshot] = await setup({ TIKTOK_SIGN_API_KEY: 'euler-key' }).checkLive([channel]);

    expect(snapshot).toMatchObject({ isLive: true, streamId: ROOM_ID, viewers: 1543, title: 'Ranked grind with viewers' });
    expect(server.callsTo(EULER_ROOM_ID)[0]?.headers['x-api-key']).toBe('euler-key');
  });

  it('pauses Euler after the key is rejected', async () => {
    server.on(API_LIVE, forbidden).on(LIVE_PAGE, forbidden).on(EULER_ROOM_ID, () => json({ code: 403, message: 'Forbidden' }, 403));
    const provider = setup({ TIKTOK_SIGN_API_KEY: 'bad-key' });

    await expect(provider.checkLive([channel])).rejects.toBeInstanceOf(ProviderError);
    expect(provider.health().notes.join('\n')).toContain('مفتاح Euler Stream مرفوض');
  });
});

describe('circuit breaker', () => {
  it('pauses after 3 consecutive blocks, persists across restarts, and doubles the cooldown', async () => {
    let apiLive = forbidden;
    server.on(API_LIVE, () => apiLive()).on(LIVE_PAGE, forbidden).on(EMBED, forbidden);
    const provider = setup();

    // Blocks 1 + 2 (api-live, live page): unknown, but not paused yet.
    const first = await provider.checkLive([channel]).catch((err: unknown) => err);
    expect(first).toBeInstanceOf(ProviderError);
    expect(first).not.toBeInstanceOf(RateLimitedError);

    // Block 3 trips the breaker before the live page is tried.
    const second = await provider.checkLive([channel]).catch((err: unknown) => err);
    expect(second).toBeInstanceOf(RateLimitedError);
    expect((second as RateLimitedError).retryAfterMs).toBe(10 * MINUTE);
    expect(server.callsTo(LIVE_PAGE)).toHaveLength(1);

    // While open: no TikTok requests at all.
    const callsWhileOpen = server.calls.length;
    await expect(provider.checkLive([channel])).rejects.toBeInstanceOf(RateLimitedError);
    expect(await provider.fetchRecentContent(channel, ['video'])).toEqual([]);
    expect(server.calls).toHaveLength(callsWhileOpen);
    expect(provider.health().notes.join('\n')).toContain('حاجب طلبات السيرفر');

    // A restart keeps the pause.
    await expect(setup().checkLive([channel])).rejects.toBeInstanceOf(RateLimitedError);
    expect(server.calls).toHaveLength(callsWhileOpen);

    // After the cooldown one probe goes out; a failed probe re-opens with a doubled cooldown.
    clock += 10 * MINUTE + 1_000;
    const probe = await provider.checkLive([channel]).catch((err: unknown) => err);
    expect(probe).toBeInstanceOf(RateLimitedError);
    expect((probe as RateLimitedError).retryAfterMs).toBe(20 * MINUTE);
    expect(server.calls).toHaveLength(callsWhileOpen + 1);

    // A successful probe closes it again.
    clock += 20 * MINUTE + 1_000;
    apiLive = () => json(apiLiveBody(4));
    expect((await provider.checkLive([channel]))[0]?.isLive).toBe(false);
    expect(provider.health().notes.join('\n')).toContain('ما فيه حظر');
    expect(kv.get<{ trips: number }>('tiktok:breaker')?.trips).toBe(0);
  });

  it('keeps checking live status through Euler while TikTok is paused', async () => {
    server.on(EULER_ROOM_ID, () => json({ code: 200, ok: true, routes_attempted: [], is_live: false }));
    kv.set('tiktok:breaker', { consecutiveBlocks: 0, trips: 1, openUntil: T0 + 5 * MINUTE, lastReason: 'HTTP 403', lastBlockAt: T0 });
    const provider = setup({ TIKTOK_SIGN_API_KEY: 'euler-key' });

    const [snapshot] = await provider.checkLive([channel]);

    expect(snapshot?.isLive).toBe(false);
    expect(server.calls.map((c) => c.url.host)).toEqual(['api.eulerstream.com']);
    expect(provider.health().notes.join('\n')).toContain('Euler Stream');
  });

  it('accepts accounts unverified without contacting TikTok while paused', async () => {
    kv.set('tiktok:breaker', { consecutiveBlocks: 0, trips: 1, openUntil: T0 + 5 * MINUTE, lastReason: 'HTTP 403', lastBlockAt: T0 });
    const resolved = await setup().resolveChannel('@streamer.one');
    expect(resolved.meta).toMatchObject({ verified: false });
    expect(server.calls).toHaveLength(0);
  });
});

describe('fetchRecentContent', () => {
  const embedWithVideos = () =>
    embedHtml(HANDLE, {
      userInfo: embedUser,
      videoList: [
        embedVideo(VID_OLD_PINNED, 'Pinned classic'),
        embedVideo(VID_PRIVATE, 'secret', { privateItem: true }),
        embedVideo(VID_1H, '  New dance\n#fyp #dance  ', { playCount: 5321 }),
        embedVideo(VID_2H, ''),
      ],
    });

  it('parses the embed page newest first, decodes timestamps, skips private videos and enriches captions via oEmbed', async () => {
    server
      .on(EMBED, () => html(embedWithVideos()))
      .on(OEMBED, () => json({ version: '1.0', type: 'video', title: 'Caption from oEmbed', thumbnail_url: 'https://p16.tiktokcdn.com/oembed.jpeg' }));
    const provider = setup();

    const items = await provider.fetchRecentContent(channel, ['video', 'clip']);

    expect(items.map((i) => i.contentId)).toEqual([VID_1H, VID_2H, VID_OLD_PINNED]);
    expect(items[0]).toEqual({
      platform: 'tiktok',
      platformId: HANDLE,
      contentId: VID_1H,
      kind: 'video',
      title: 'New dance #fyp #dance',
      url: `https://www.tiktok.com/@streamer.one/video/${VID_1H}`,
      thumbnailUrl: `https://p16-sign.tiktokcdn.com/cover-${VID_1H}.jpeg?x-expires=1&x-signature=abc`,
      publishedAt: '2026-10-03T11:00:00.000Z',
      durationSec: null,
      viewCount: 5321,
      relatedStreamId: null,
    });
    expect(items[1]).toMatchObject({ title: 'Caption from oEmbed', publishedAt: '2026-10-03T10:00:00.000Z' });
    expect(items[2]?.publishedAt).toBe('2026-03-17T12:00:00.000Z');
    expect(server.callsTo(OEMBED)).toHaveLength(1);
    expect(server.callsTo(OEMBED)[0]?.url.searchParams.get('url')).toBe(`https://www.tiktok.com/@streamer.one/video/${VID_2H}`);

    // oEmbed answers are cached: each video is enriched once.
    await provider.fetchRecentContent(channel, ['video']);
    expect(server.callsTo(OEMBED)).toHaveLength(1);
  });

  it('falls back to a default Arabic title when no caption is available', async () => {
    server.on(EMBED, () => html(embedHtml(HANDLE, { userInfo: embedUser, videoList: [embedVideo(VID_2H, '   ')] }))).on(OEMBED, () => json({}, 404));
    const [item] = await setup().fetchRecentContent(channel, ['video']);
    expect(item?.title).toBe('فيديو جديد على تيك توك');
  });

  it('returns nothing when videos are not requested', async () => {
    expect(await setup().fetchRecentContent(channel, ['vod', 'clip'])).toEqual([]);
    expect(server.calls).toHaveLength(0);
  });

  it('returns [] for private accounts or accounts with embedding disabled, and says so in health()', async () => {
    server.on(EMBED, () => html(embedHtml(HANDLE, { userInfo: {}, videoList: [] })));
    const provider = setup();
    expect(await provider.fetchRecentContent(channel, ['video'])).toEqual([]);
    expect(provider.health().notes.join('\n')).toContain(`@${HANDLE}`);
  });

  it('flags accounts TikTok reports as gone (renamed or deleted)', async () => {
    let entry: unknown = { userInfo: { uniqueId: '', code: 10202 }, videoList: [] };
    server.on(EMBED, () => html(embedHtml(HANDLE, entry)));
    const provider = setup();

    expect(await provider.fetchRecentContent(channel, ['video'])).toEqual([]);
    expect(provider.health().notes.join('\n')).toContain('غير موجودة');

    entry = { userInfo: embedUser, videoList: [] };
    await provider.fetchRecentContent(channel, ['video']);
    expect(provider.health().notes.join('\n')).not.toContain('غير موجودة');
  });

  it('solves the WAF challenge and retries with the answer cookie', async () => {
    const { page } = wafPage(3);
    server.on(EMBED, (_call, nth) => html(nth === 1 ? page : embedWithVideos())).on(OEMBED, () => json({ title: '' }));
    const provider = setup();

    const items = await provider.fetchRecentContent(channel, ['video']);

    expect(items).toHaveLength(3);
    const [challenged, retried] = server.callsTo(EMBED);
    expect(challenged?.headers.cookie).not.toContain('_wafchallengeid');
    const cookie = /_wafchallengeid=([^;]+)/.exec(retried?.headers.cookie ?? '')?.[1];
    const answer = JSON.parse(Buffer.from(cookie ?? '', 'base64').toString('utf8'));
    expect(Buffer.from(answer.d, 'base64').toString()).toBe('3');
    expect(provider.health().notes.join('\n')).toContain('WAF');
  });

  it('falls back to RSSHub when the embed page is blocked', async () => {
    const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Streamer One (@streamer.one) | TikTok</title><link>https://www.tiktok.com/@streamer.one</link>
<item><title><![CDATA[New dance #fyp]]></title><description><![CDATA[<video controls preload="metadata" poster="https://p16-sign.tiktokcdn.com/rss-cover.jpeg?x-expires=1&amp;x-signature=abc"><source src="https://v16.tiktokcdn.com/a.mp4" type="video/mp4"></video>]]></description><pubDate>Sat, 03 Oct 2026 11:00:00 GMT</pubDate><guid isPermaLink="false">https://www.tiktok.com/@streamer.one/video/${VID_1H}</guid><link>https://www.tiktok.com/@streamer.one/video/${VID_1H}</link></item>
<item><title>Older &amp; better</title><description>&lt;img src="https://p16-sign.tiktokcdn.com/rss-old.jpeg"&gt;</description><pubDate>Sat, 03 Oct 2026 10:00:00 GMT</pubDate><link>https://www.tiktok.com/@streamer.one/video/${VID_2H}</link></item>
</channel></rss>`;
    server
      .on(EMBED, forbidden)
      .on(RSSHUB_FEED, () => new Response(rss, { headers: { 'content-type': 'application/rss+xml; charset=utf-8' } }));

    const items = await setup({ RSSHUB_URL: 'http://rsshub:1200/' }).fetchRecentContent(channel, ['video']);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      contentId: VID_1H,
      title: 'New dance #fyp',
      thumbnailUrl: 'https://p16-sign.tiktokcdn.com/rss-cover.jpeg?x-expires=1&x-signature=abc',
      publishedAt: '2026-10-03T11:00:00.000Z',
      url: `https://www.tiktok.com/@streamer.one/video/${VID_1H}`,
    });
    expect(items[1]).toMatchObject({ contentId: VID_2H, title: 'Older & better', thumbnailUrl: 'https://p16-sign.tiktokcdn.com/rss-old.jpeg' });
    expect(server.callsTo(OEMBED)).toHaveLength(0);
  });

  it('throws a retryable ProviderError when the embed is blocked and no fallback works', async () => {
    server.on(EMBED, () => html(CAPTCHA_PAGE));
    const error = await setup().fetchRecentContent(channel, ['video']).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).retryable).toBe(true);
  });
});
