import { createHmac } from 'node:crypto';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { ChannelNotFoundError, ProviderError, ProviderNotConfiguredError, RateLimitedError, ValidationError } from '../../src/core/errors.js';
import { type ChannelRef, offlineSnapshot } from '../../src/core/types.js';
import { openDatabase } from '../../src/db/database.js';
import { Repositories } from '../../src/db/repositories.js';
import type { FetchLike } from '../../src/platforms/http.js';
import { verifyEventSubSignature } from '../../src/platforms/twitch-eventsub.js';
import { type Clock, createTwitchProvider, parseTwitchDuration, parseTwitchInput, TwitchProvider } from '../../src/platforms/twitch.js';
import type { KeyValueStore, WebhookRequest } from '../../src/platforms/types.js';

// ───────────────────────────── fixtures ─────────────────────────────

const NOW = Date.parse('2026-10-03T12:00:00Z');
const SECRET = 'super-secret-eventsub-value';
const CALLBACK = 'https://bot.example.com/webhooks/twitch';
const silent = pino({ level: 'silent' });

interface Call {
  method: string;
  url: URL;
  path: string;
  headers: Record<string, string>;
  body: string | null;
}
type Route = (call: Call) => Response | Promise<Response>;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const empty = (status = 204) => new Response(null, { status });
const tokenResponse = (token = 'tok-1', expiresIn = 5_000_000) => json({ access_token: token, expires_in: expiresIn, token_type: 'bearer' });

/** Fake Twitch: routes keyed by "METHOD /path" (path without /helix). Unknown routes → 404. */
function fakeTwitch(routes: Record<string, Route>, token: Route = () => tokenResponse()) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? 'GET',
      url,
      path: url.pathname.replace(/^\/helix/, ''),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body == null ? null : String(init.body),
    };
    calls.push(call);
    if (url.host === 'id.twitch.tv') return token(call);
    const route = routes[`${call.method} ${call.path}`];
    return route ? route(call) : json({ error: 'Not Found', status: 404, message: 'no route' }, 404);
  };
  return {
    fetchImpl,
    calls,
    helix: (key?: string) => calls.filter((c) => c.url.host === 'api.twitch.tv' && (!key || `${c.method} ${c.path}` === key)),
    tokens: () => calls.filter((c) => c.url.host === 'id.twitch.tv'),
  };
}

function testClock(start = NOW): Clock & { t: number; advance(ms: number): void } {
  const clock = {
    t: start,
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.t += ms;
    },
    advance: (ms: number) => {
      clock.t += ms;
    },
  };
  return clock;
}

const newKv = (): KeyValueStore => new Repositories(openDatabase(':memory:')).kv;

function makeProvider(
  fetchImpl: FetchLike,
  opts: { env?: Record<string, string | undefined>; kv?: KeyValueStore; clock?: Clock } = {},
): TwitchProvider {
  const config = loadConfig({
    DISCORD_TOKEN: 'discord-token',
    DISCORD_CLIENT_ID: 'discord-client',
    TWITCH_CLIENT_ID: 'cid',
    TWITCH_CLIENT_SECRET: 'csecret',
    ...opts.env,
  });
  return new TwitchProvider({ config, logger: silent, kv: opts.kv ?? newKv(), fetch: fetchImpl }, { clock: opts.clock ?? testClock() });
}

const webhookEnv = { PUBLIC_URL: 'https://bot.example.com', TWITCH_EVENTSUB_SECRET: SECRET };

const channel = (platformId: string, handle: string): ChannelRef => ({ id: Number(platformId), platform: 'twitch', platformId, handle, meta: {} });

const user = (id: string, login: string, displayName = login) => ({
  id,
  login,
  display_name: displayName,
  type: '',
  broadcaster_type: 'partner',
  profile_image_url: `https://static-cdn.jtvnw.net/jtv_user_pictures/${login}-profile_image-300x300.png`,
  created_at: '2012-01-01T00:00:00Z',
});

const stream = (userId: string, login: string, overrides: Record<string, unknown> = {}) => ({
  id: `stream-${userId}`,
  user_id: userId,
  user_login: login,
  user_name: login,
  game_id: '33214',
  game_name: 'Fortnite',
  type: 'live',
  title: `  ${login} live!  `,
  viewer_count: 1234,
  started_at: '2026-10-03T10:00:00Z',
  language: 'ar',
  thumbnail_url: `https://static-cdn.jtvnw.net/previews-ttv/live_user_${login}-{width}x{height}.jpg`,
  tags: ['Arabic', 'Gaming'],
  is_mature: false,
  ...overrides,
});

const game = (id: string, name: string) => ({ id, name, box_art_url: `https://static-cdn.jtvnw.net/ttv-boxart/${id}-{width}x{height}.jpg` });

const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
const MIN = 60_000;
const HOUR = 60 * MIN;

// ───────────────────────────── helpers under test ─────────────────────────────

describe('parseTwitchDuration', () => {
  it.each([
    ['1h2m3s', 3723],
    ['3h2m10s', 10930],
    ['45m', 2700],
    ['12s', 12],
    ['1h', 3600],
    ['2m0s', 120],
  ])('%s → %d', (input, expected) => {
    expect(parseTwitchDuration(input)).toBe(expected);
  });

  it.each(['', 'abc', '1x', null, undefined])('returns null for %s', (input) => {
    expect(parseTwitchDuration(input)).toBeNull();
  });
});

describe('parseTwitchInput', () => {
  it.each([
    'shroud',
    '@Shroud',
    '  SHROUD ',
    'https://twitch.tv/shroud',
    'http://www.twitch.tv/shroud',
    'https://www.twitch.tv/shroud/videos?filter=archives',
    'www.twitch.tv/shroud/',
    'twitch.tv/shroud',
    'm.twitch.tv/shroud',
    'https://www.twitch.tv/popout/shroud/chat?popout=',
    'https://www.twitch.tv/moderator/shroud',
    'https://player.twitch.tv/?channel=shroud&parent=example.com',
    'https://www.twitch.tv/shroud/clip/FunnyClip-abc_123',
  ])('parses %s as login "shroud"', (input) => {
    expect(parseTwitchInput(input)).toEqual({ kind: 'login', login: 'shroud' });
  });

  it('parses ids, video and clip URLs', () => {
    expect(parseTwitchInput('id:12345')).toEqual({ kind: 'id', id: '12345' });
    expect(parseTwitchInput('https://www.twitch.tv/videos/987654321')).toEqual({ kind: 'video', id: '987654321' });
    expect(parseTwitchInput('https://player.twitch.tv/?video=v987&parent=x')).toEqual({ kind: 'video', id: '987' });
    expect(parseTwitchInput('https://clips.twitch.tv/FunnyClip-abc_1')).toEqual({ kind: 'clip', slug: 'FunnyClip-abc_1' });
  });

  it.each(['', '   ', 'bad name!', 'نص عربي', 'a'.repeat(26), 'https://twitch.tv/', 'https://twitch.tv/directory/all', 'https://youtube.com/@shroud', 'kick.com/shroud'])(
    'rejects %j with an Arabic ValidationError',
    (input) => {
      expect(() => parseTwitchInput(input)).toThrow(ValidationError);
    },
  );
});

// ───────────────────────────── auth ─────────────────────────────

describe('app access token', () => {
  const usersRoute = (): Route => (call) => json({ data: [user('1001', call.url.searchParams.get('login') ?? 'x')] });

  it('fetches once, sends Helix auth headers and caches the token in memory and kv', async () => {
    const api = fakeTwitch({ 'GET /users': usersRoute() });
    const kv = newKv();
    const provider = makeProvider(api.fetchImpl, { kv });

    await provider.resolveChannel('alpha');
    await provider.resolveChannel('beta');

    expect(api.tokens()).toHaveLength(1);
    const tokenBody = new URLSearchParams(api.tokens()[0]!.body ?? '');
    expect(tokenBody.get('grant_type')).toBe('client_credentials');
    expect(tokenBody.get('client_id')).toBe('cid');
    expect(tokenBody.get('client_secret')).toBe('csecret');
    expect(api.helix()[0]!.headers).toMatchObject({ authorization: 'Bearer tok-1', 'client-id': 'cid' });
    expect(kv.get('twitch:app_token')).toMatchObject({ accessToken: 'tok-1', clientId: 'cid', expiresAt: NOW + 5_000_000_000 });

    // A restarted process reuses the persisted token.
    const api2 = fakeTwitch({ 'GET /users': usersRoute() });
    await makeProvider(api2.fetchImpl, { kv }).resolveChannel('gamma');
    expect(api2.tokens()).toHaveLength(0);
    expect(api2.helix()[0]!.headers.authorization).toBe('Bearer tok-1');
  });

  it('ignores a persisted token issued for another client id', async () => {
    const kv = newKv();
    kv.set('twitch:app_token', { accessToken: 'foreign', obtainedAt: NOW, expiresAt: NOW + HOUR * 100, clientId: 'other' });
    const api = fakeTwitch({ 'GET /users': usersRoute() });
    await makeProvider(api.fetchImpl, { kv }).resolveChannel('alpha');
    expect(api.tokens()).toHaveLength(1);
    expect(api.helix()[0]!.headers.authorization).toBe('Bearer tok-1');
  });

  it('fetches a new token once on 401 and retries the request', async () => {
    let issued = 0;
    const api = fakeTwitch(
      {
        'GET /users': (call) =>
          call.headers.authorization === 'Bearer tok-1' ? json({ status: 401, message: 'Invalid OAuth token' }, 401) : usersRoute()(call),
      },
      () => tokenResponse(`tok-${++issued}`),
    );
    const kv = newKv();
    const provider = makeProvider(api.fetchImpl, { kv });

    const resolved = await provider.resolveChannel('alpha');
    expect(resolved.platformId).toBe('1001');
    expect(api.tokens()).toHaveLength(2);
    expect(api.helix('GET /users').map((c) => c.headers.authorization)).toEqual(['Bearer tok-1', 'Bearer tok-2']);
    expect(kv.get<{ accessToken: string }>('twitch:app_token')?.accessToken).toBe('tok-2');
  });

  it('surfaces a second consecutive 401 instead of looping', async () => {
    const api = fakeTwitch({ 'GET /users': () => json({ status: 401, message: 'Invalid OAuth token' }, 401) });
    const provider = makeProvider(api.fetchImpl);
    await expect(provider.resolveChannel('alpha')).rejects.toBeInstanceOf(ProviderError);
    expect(api.tokens()).toHaveLength(2);
    expect(api.helix()).toHaveLength(2);
  });

  it('refreshes the token shortly before it expires', async () => {
    let issued = 0;
    const api = fakeTwitch({ 'GET /users': usersRoute() }, () => tokenResponse(`tok-${++issued}`, 3600));
    const clock = testClock();
    const provider = makeProvider(api.fetchImpl, { clock });

    await provider.resolveChannel('alpha');
    clock.advance(50 * MIN);
    await provider.resolveChannel('alpha');
    expect(api.tokens()).toHaveLength(1);

    clock.advance(5 * MIN); // inside the refresh margin (10% of 1h)
    await provider.resolveChannel('alpha');
    expect(api.tokens()).toHaveLength(2);
    expect(api.helix().at(-1)!.headers.authorization).toBe('Bearer tok-2');
  });

  it('reports rejected credentials, backs off and recovers', async () => {
    let reject = true;
    const api = fakeTwitch({ 'GET /users': usersRoute() }, () =>
      reject ? json({ status: 400, message: 'invalid client secret' }, 400) : tokenResponse(),
    );
    const clock = testClock();
    const provider = makeProvider(api.fetchImpl, { clock });

    await expect(provider.resolveChannel('alpha')).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    await expect(provider.resolveChannel('alpha')).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    expect(api.tokens()).toHaveLength(1); // second attempt hit the backoff, not the network
    expect(provider.health().notes.join('\n')).toContain('تعذّر الحصول على رمز دخول Twitch');

    reject = false;
    clock.advance(20_000);
    await expect(provider.resolveChannel('alpha')).resolves.toMatchObject({ platformId: '1001' });
    expect(provider.health().notes.join('\n')).not.toContain('تعذّر');
  });

  it('is inert when credentials are missing', async () => {
    const api = fakeTwitch({});
    const provider = makeProvider(api.fetchImpl, { env: { TWITCH_CLIENT_ID: '', TWITCH_CLIENT_SECRET: '' } });
    expect(provider.isConfigured()).toBe(false);
    expect(provider.health().configured).toBe(false);
    expect(provider.webhook).toBeUndefined();
    await expect(provider.checkLive([channel('1', 'a')])).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    await expect(provider.findVodUrl(channel('1', 'a'), 's', null)).resolves.toBeNull();
    expect(api.calls).toHaveLength(0);
  });
});

// ───────────────────────────── rate limits ─────────────────────────────

describe('Helix rate limiting', () => {
  it('paces requests when few points remain', async () => {
    const reset = String(Math.floor((NOW + 30_000) / 1000));
    const api = fakeTwitch({
      'GET /users': () => json({ data: [user('1', 'alpha')] }, 200, { 'ratelimit-limit': '800', 'ratelimit-remaining': '2', 'ratelimit-reset': reset }),
    });
    const clock = testClock();
    const provider = makeProvider(api.fetchImpl, { clock });
    await provider.resolveChannel('alpha');
    expect(clock.t).toBe(NOW);
    await provider.resolveChannel('alpha');
    expect(clock.t).toBe(NOW + 300); // 75ms per point × 4 points
    expect(provider.health().notes.join('\n')).toContain('قريبة من الحد');
  });

  it('waits and retries once on a short 429, fails fast on a long one', async () => {
    let mode: 'short' | 'long' | 'ok' = 'short';
    let calls = 0;
    const api = fakeTwitch({
      'GET /users': () => {
        calls++;
        if (mode === 'ok' || (mode === 'short' && calls > 1)) return json({ data: [user('1', 'alpha')] });
        const resetIn = mode === 'short' ? 2 : 120;
        return json({ status: 429, message: 'Too Many Requests' }, 429, {
          'ratelimit-remaining': '0',
          'ratelimit-reset': String(Math.ceil(Date.now() / 1000) + resetIn),
        });
      },
    });
    const provider = makeProvider(api.fetchImpl);

    await expect(provider.resolveChannel('alpha')).resolves.toMatchObject({ handle: 'alpha' });
    expect(calls).toBe(2);

    mode = 'long';
    await expect(provider.resolveChannel('alpha')).rejects.toBeInstanceOf(RateLimitedError);
    const before = calls;
    mode = 'ok';
    await expect(provider.resolveChannel('alpha')).rejects.toBeInstanceOf(RateLimitedError); // still blocked locally
    expect(calls).toBe(before);
  });
});

// ───────────────────────────── resolve ─────────────────────────────

describe('resolveChannel', () => {
  it('resolves a login into a channel', async () => {
    const api = fakeTwitch({ 'GET /users': () => json({ data: [user('71092938', 'xqc', 'xQc')] }) });
    const provider = makeProvider(api.fetchImpl);
    await expect(provider.resolveChannel('https://www.twitch.tv/xQc/videos')).resolves.toEqual({
      platform: 'twitch',
      platformId: '71092938',
      handle: 'xqc',
      displayName: 'xQc',
      avatarUrl: 'https://static-cdn.jtvnw.net/jtv_user_pictures/xqc-profile_image-300x300.png',
      url: 'https://www.twitch.tv/xqc',
      meta: {},
    });
    expect(api.helix('GET /users')[0]!.url.searchParams.get('login')).toBe('xqc');
  });

  it('throws ChannelNotFoundError for unknown or malformed users', async () => {
    const api = fakeTwitch({
      'GET /users': (call) =>
        call.url.searchParams.get('login') === 'ghost' ? json({ data: [] }) : json({ status: 400, message: 'Invalid login names' }, 400),
    });
    const provider = makeProvider(api.fetchImpl);
    await expect(provider.resolveChannel('ghost')).rejects.toBeInstanceOf(ChannelNotFoundError);
    await expect(provider.resolveChannel('__')).rejects.toBeInstanceOf(ChannelNotFoundError);
  });

  it('resolves by user id, video URL and clip URL', async () => {
    const api = fakeTwitch({
      'GET /users': (call) => json({ data: call.url.searchParams.get('id') === '42' ? [user('42', 'owner')] : [] }),
      'GET /videos': (call) => (call.url.searchParams.get('id') === '555' ? json({ data: [{ id: '555', user_id: '42' }] }) : json({ data: [] })),
      'GET /clips': () => json({ data: [{ id: 'SlugA', broadcaster_id: '42' }] }),
    });
    const provider = makeProvider(api.fetchImpl);
    await expect(provider.resolveChannel('id:42')).resolves.toMatchObject({ platformId: '42', handle: 'owner' });
    await expect(provider.resolveChannel('https://www.twitch.tv/videos/555')).resolves.toMatchObject({ platformId: '42' });
    await expect(provider.resolveChannel('https://clips.twitch.tv/SlugA')).resolves.toMatchObject({ platformId: '42' });
    await expect(provider.resolveChannel('https://www.twitch.tv/videos/999')).rejects.toBeInstanceOf(ChannelNotFoundError);
  });

  it('rejects invalid input before calling Twitch', async () => {
    const api = fakeTwitch({});
    await expect(makeProvider(api.fetchImpl).resolveChannel('not a login')).rejects.toBeInstanceOf(ValidationError);
    expect(api.calls).toHaveLength(0);
  });
});

// ───────────────────────────── live ─────────────────────────────

describe('checkLive', () => {
  const channels = [channel('100', 'alpha'), channel('200', 'beta'), channel('300', 'gamma')];

  it('maps live and offline channels and batches game art lookups', async () => {
    let live = [stream('100', 'alpha'), stream('200', 'beta_renamed', { game_id: '509658', game_name: 'Just Chatting', tags: null })];
    const api = fakeTwitch({
      'GET /streams': () => json({ data: live, pagination: {} }),
      'GET /games': (call) => {
        const known: Record<string, ReturnType<typeof game>> = { '33214': game('33214', 'Fortnite'), '509658': game('509658', 'Just Chatting'), '21779': game('21779', 'LoL') };
        return json({ data: call.url.searchParams.getAll('id').flatMap((id) => (known[id] ? [known[id]] : [])) });
      },
    });
    const provider = makeProvider(api.fetchImpl);

    const snapshots = await provider.checkLive(channels);

    const streamsCall = api.helix('GET /streams')[0]!;
    expect(streamsCall.url.searchParams.getAll('user_id')).toEqual(['100', '200', '300']);
    expect(streamsCall.url.searchParams.get('first')).toBe('100');
    expect(api.helix('GET /games')).toHaveLength(1);
    expect(api.helix('GET /games')[0]!.url.searchParams.getAll('id').sort()).toEqual(['33214', '509658']);

    expect(snapshots).toHaveLength(3);
    const [alpha, beta, gamma] = snapshots;
    expect(alpha).toMatchObject({
      platform: 'twitch',
      platformId: '100',
      isLive: true,
      streamId: 'stream-100',
      title: 'alpha live!',
      category: 'Fortnite',
      categoryImageUrl: 'https://static-cdn.jtvnw.net/ttv-boxart/33214-285x380.jpg',
      viewers: 1234,
      startedAt: '2026-10-03T10:00:00Z',
      url: 'https://www.twitch.tv/alpha',
      language: 'ar',
      tags: ['Arabic', 'Gaming'],
    });
    expect(alpha!.thumbnailUrl).toMatch(/^https:\/\/static-cdn\.jtvnw\.net\/previews-ttv\/live_user_alpha-1280x720\.jpg\?t=\d+$/);
    expect(beta).toMatchObject({ url: 'https://www.twitch.tv/beta_renamed', category: 'Just Chatting', tags: [] });
    expect(gamma).toEqual(offlineSnapshot({ platform: 'twitch', platformId: '300' }, 'https://www.twitch.tv/gamma'));

    // Next poll: cached art is reused, only the new game is fetched; unknown games are negatively cached.
    live = [stream('100', 'alpha'), stream('300', 'gamma', { game_id: '21779', game_name: 'LoL' }), stream('200', 'beta', { game_id: '999', game_name: 'Mystery' })];
    const next = await provider.checkLive(channels);
    expect(api.helix('GET /games')).toHaveLength(2);
    expect(api.helix('GET /games')[1]!.url.searchParams.getAll('id').sort()).toEqual(['21779', '999']);
    expect(next.map((s) => s.categoryImageUrl)).toEqual([
      'https://static-cdn.jtvnw.net/ttv-boxart/33214-285x380.jpg',
      null,
      'https://static-cdn.jtvnw.net/ttv-boxart/21779-285x380.jpg',
    ]);

    await provider.checkLive(channels);
    expect(api.helix('GET /games')).toHaveLength(2);
  });

  it('keeps snapshots when box art lookup fails', async () => {
    const api = fakeTwitch({
      'GET /streams': () => json({ data: [stream('100', 'alpha')] }),
      'GET /games': () => json({ status: 400, message: 'bad' }, 400),
    });
    const [alpha] = await makeProvider(api.fetchImpl).checkLive([channel('100', 'alpha')]);
    expect(alpha).toMatchObject({ isLive: true, category: 'Fortnite', categoryImageUrl: null });
  });

  it('throws when the batch fails so the monitor keeps the previous state', async () => {
    const api = fakeTwitch({ 'GET /streams': () => json({ status: 400, message: 'bad' }, 400) });
    await expect(makeProvider(api.fetchImpl).checkLive(channels)).rejects.toBeInstanceOf(ProviderError);
  });

  it('splits oversized batches and reports malformed ids as offline', async () => {
    const api = fakeTwitch({ 'GET /streams': () => json({ data: [] }) });
    const many = Array.from({ length: 150 }, (_, i) => channel(String(i + 1), `user${i + 1}`));
    const bad: ChannelRef = { ...channel('1', 'broken'), platformId: 'not-a-number' };
    const snapshots = await makeProvider(api.fetchImpl).checkLive([...many, bad]);
    expect(snapshots).toHaveLength(151);
    expect(snapshots.every((s) => !s.isLive)).toBe(true);
    expect(api.helix('GET /streams').map((c) => c.url.searchParams.getAll('user_id').length)).toEqual([100, 50]);
  });

  it('returns [] for an empty batch without network calls', async () => {
    const api = fakeTwitch({});
    await expect(makeProvider(api.fetchImpl).checkLive([])).resolves.toEqual([]);
    expect(api.calls).toHaveLength(0);
  });
});

// ───────────────────────────── content ─────────────────────────────

const video = (id: string, type: string, overrides: Record<string, unknown> = {}) => ({
  id,
  stream_id: null,
  user_id: '100',
  user_login: 'alpha',
  title: `Video ${id}`,
  description: '',
  created_at: iso(-HOUR),
  published_at: iso(-HOUR),
  url: `https://www.twitch.tv/videos/${id}`,
  thumbnail_url: `https://static-cdn.jtvnw.net/cf_vods/x/${id}/thumb/thumb0-%{width}x%{height}.jpg`,
  viewable: 'public',
  view_count: 10,
  language: 'ar',
  type,
  duration: '1m',
  muted_segments: null,
  ...overrides,
});

const clip = (id: string, createdOffset: number, views = 5) => ({
  id,
  url: `https://clips.twitch.tv/${id}`,
  embed_url: `https://clips.twitch.tv/embed?clip=${id}`,
  broadcaster_id: '100',
  title: `Clip ${id}`,
  view_count: views,
  created_at: iso(createdOffset),
  thumbnail_url: `https://clips-media-assets2.twitch.tv/${id}-preview-480x272.jpg`,
  duration: 29.9,
});

const VIDEOS = [
  video('v1', 'archive', { stream_id: 's-live', thumbnail_url: '', created_at: iso(-30 * MIN), published_at: iso(-30 * MIN) }),
  video('v2', 'archive', { stream_id: 's-proc', thumbnail_url: 'https://vod-secure.twitch.tv/_404/404_processing_%{width}x%{height}.png' }),
  video('v3', 'archive', { stream_id: 's-current', created_at: iso(-2 * HOUR), published_at: iso(-2 * HOUR) }),
  video('v4', 'archive', { stream_id: 's-old', created_at: iso(-72 * HOUR), published_at: iso(-72 * HOUR), duration: '3h2m10s' }),
  video('v5', 'highlight', { created_at: iso(-20 * MIN), published_at: iso(-20 * MIN), duration: '45m', title: '' }),
  video('v6', 'upload', { created_at: iso(-4 * HOUR), published_at: iso(-4 * HOUR), duration: '12s' }),
];

function contentApi(liveStreamId: string | null = 's-current', videos: unknown[] = VIDEOS) {
  return fakeTwitch({
    'GET /videos': () => json({ data: videos, pagination: {} }),
    'GET /streams': () => json({ data: liveStreamId ? [stream('100', 'alpha', { id: liveStreamId })] : [] }),
    'GET /games': () => json({ data: [] }),
    'GET /clips': (call) => {
      const after = call.url.searchParams.get('after');
      if (!after) return json({ data: [clip('c1', -HOUR, 500), clip('c2', -3 * HOUR, 300)], pagination: { cursor: 'p2' } });
      if (after === 'p2') return json({ data: [clip('c3', -30 * MIN, 100)], pagination: { cursor: 'p3' } });
      if (after === 'p3') return json({ data: [clip('c4', -5 * HOUR, 50)], pagination: { cursor: 'p4' } });
      return json({ data: [clip('c-too-far', -6 * HOUR)], pagination: {} });
    },
  });
}

describe('fetchRecentContent', () => {
  const alpha = channel('100', 'alpha');

  it('maps videos and clips newest first, skipping in-progress archives', async () => {
    const api = contentApi();
    const provider = makeProvider(api.fetchImpl);
    await provider.checkLive([alpha]); // learns that s-current is live

    const items = await provider.fetchRecentContent(alpha, ['vod', 'highlight', 'video', 'clip']);

    expect(items.map((i) => i.contentId)).toEqual(['v5', 'c3', 'c1', 'c2', 'v6', 'c4', 'v4']);
    expect(api.helix('GET /streams')).toHaveLength(1); // the fresh checkLive status was reused

    const byId = new Map(items.map((i) => [i.contentId, i]));
    expect(byId.get('v4')).toEqual({
      platform: 'twitch',
      platformId: '100',
      contentId: 'v4',
      kind: 'vod',
      title: 'Video v4',
      url: 'https://www.twitch.tv/videos/v4',
      thumbnailUrl: 'https://static-cdn.jtvnw.net/cf_vods/x/v4/thumb/thumb0-320x180.jpg',
      publishedAt: iso(-72 * HOUR),
      durationSec: 10930,
      viewCount: 10,
      relatedStreamId: 's-old',
    });
    expect(byId.get('v5')).toMatchObject({ kind: 'highlight', durationSec: 2700, title: 'هايلايت' });
    expect(byId.get('v6')).toMatchObject({ kind: 'video', durationSec: 12 });
    expect(byId.get('c1')).toMatchObject({
      kind: 'clip',
      url: 'https://clips.twitch.tv/c1',
      thumbnailUrl: 'https://clips-media-assets2.twitch.tv/c1-preview-480x272.jpg',
      publishedAt: iso(-HOUR),
      durationSec: 30,
      viewCount: 500,
      relatedStreamId: null,
    });

    const videosCall = api.helix('GET /videos')[0]!.url.searchParams;
    expect(Object.fromEntries(videosCall)).toMatchObject({ user_id: '100', type: 'all', first: '20' });

    const clipCalls = api.helix('GET /clips');
    expect(clipCalls).toHaveLength(3); // pagination capped at 3 pages
    expect(clipCalls.map((c) => c.url.searchParams.get('after'))).toEqual([null, 'p2', 'p3']);
    expect(Object.fromEntries(clipCalls[0]!.url.searchParams)).toEqual({
      broadcaster_id: '100',
      started_at: iso(-12 * HOUR),
      ended_at: iso(0),
      first: '100',
    });
  });

  it('checks live status itself when no fresh status is known', async () => {
    const live = contentApi('s-current');
    const liveItems = await makeProvider(live.fetchImpl).fetchRecentContent(alpha, ['vod']);
    expect(liveItems.map((i) => i.contentId)).toEqual(['v4']);
    expect(live.helix('GET /streams')).toHaveLength(1);
    expect(live.helix('GET /videos')[0]!.url.searchParams.get('type')).toBe('archive');

    const offline = contentApi(null);
    const offlineItems = await makeProvider(offline.fetchImpl).fetchRecentContent(alpha, ['vod']);
    expect(offlineItems.map((i) => i.contentId)).toEqual(['v3', 'v4']);
  });

  it('skips the live check when no archive can be in progress', async () => {
    const api = contentApi('s-current', [VIDEOS[3], VIDEOS[4]]);
    const items = await makeProvider(api.fetchImpl).fetchRecentContent(alpha, ['vod', 'highlight']);
    expect(items.map((i) => i.contentId)).toEqual(['v5', 'v4']);
    expect(api.helix('GET /streams')).toHaveLength(0);
  });

  it('only calls the endpoints needed for the requested kinds', async () => {
    const clipsOnly = contentApi();
    const clips = await makeProvider(clipsOnly.fetchImpl).fetchRecentContent(alpha, ['clip']);
    expect(clips.every((i) => i.kind === 'clip')).toBe(true);
    expect(clipsOnly.helix('GET /videos')).toHaveLength(0);

    const highlights = contentApi();
    const items = await makeProvider(highlights.fetchImpl).fetchRecentContent(alpha, ['highlight']);
    expect(items.map((i) => i.contentId)).toEqual(['v5']);
    expect(highlights.helix('GET /videos')[0]!.url.searchParams.get('type')).toBe('highlight');
    expect(highlights.helix('GET /clips')).toHaveLength(0);

    const none = contentApi();
    await expect(makeProvider(none.fetchImpl).fetchRecentContent(alpha, ['short'])).resolves.toEqual([]);
    expect(none.calls).toHaveLength(0);
  });

  it('fails the whole call instead of returning a partial list', async () => {
    const api = fakeTwitch({
      'GET /videos': () => json({ status: 400, message: 'bad' }, 400),
      'GET /clips': () => json({ data: [clip('c1', -HOUR)] }),
    });
    await expect(makeProvider(api.fetchImpl).fetchRecentContent(alpha, ['vod', 'clip'])).rejects.toBeInstanceOf(ProviderError);
  });
});

// ───────────────────────────── VOD lookup ─────────────────────────────

describe('findVodUrl', () => {
  const alpha = channel('100', 'alpha');
  const archives = [
    video('a1', 'archive', { stream_id: 's-2', created_at: '2026-10-03T08:00:00Z' }),
    video('a2', 'archive', { stream_id: 's-1', created_at: '2026-10-02T20:00:00Z' }),
  ];

  it('matches by stream id, then by start time, else null', async () => {
    const api = fakeTwitch({ 'GET /videos': () => json({ data: archives }) });
    const provider = makeProvider(api.fetchImpl);

    await expect(provider.findVodUrl(alpha, 's-1', null)).resolves.toBe('https://www.twitch.tv/videos/a2');
    await expect(provider.findVodUrl(alpha, 'unknown', '2026-10-03T08:07:00Z')).resolves.toBe('https://www.twitch.tv/videos/a1');
    await expect(provider.findVodUrl(alpha, 'unknown', '2026-10-03T09:00:00Z')).resolves.toBeNull();
    await expect(provider.findVodUrl(alpha, null, null)).resolves.toBeNull();

    expect(Object.fromEntries(api.helix('GET /videos')[0]!.url.searchParams)).toMatchObject({ user_id: '100', type: 'archive', first: '5' });
  });

  it('returns null on errors', async () => {
    const api = fakeTwitch({ 'GET /videos': () => json({ status: 400, message: 'bad' }, 400) });
    await expect(makeProvider(api.fetchImpl).findVodUrl(alpha, 's-1', null)).resolves.toBeNull();
  });
});

// ───────────────────────────── EventSub webhook ─────────────────────────────

function delivery(
  body: unknown,
  opts: { id?: string; type?: string; timestamp?: string; secret?: string; method?: string; tamper?: boolean } = {},
): WebhookRequest {
  const id = opts.id ?? `msg-${Math.random().toString(36).slice(2)}`;
  const timestamp = opts.timestamp ?? new Date(NOW).toISOString();
  const raw = Buffer.from(JSON.stringify(body));
  const signature = `sha256=${createHmac('sha256', opts.secret ?? SECRET).update(id + timestamp).update(raw).digest('hex')}`;
  return {
    method: opts.method ?? 'POST',
    query: {},
    headers: {
      'twitch-eventsub-message-id': id,
      'twitch-eventsub-message-timestamp': timestamp,
      'twitch-eventsub-message-signature': signature,
      'twitch-eventsub-message-type': opts.type ?? 'notification',
      'twitch-eventsub-message-retry': '0',
    },
    rawBody: opts.tamper ? Buffer.from(JSON.stringify({ ...(body as object), injected: true })) : raw,
  };
}

const notification = (type: string, broadcasterId: string) => ({
  subscription: { id: 'sub-1', type, version: '1', status: 'enabled', condition: { broadcaster_user_id: broadcasterId }, transport: { method: 'webhook', callback: CALLBACK } },
  event: { broadcaster_user_id: broadcasterId, broadcaster_user_login: 'alpha', broadcaster_user_name: 'Alpha' },
});

describe('EventSub webhook', () => {
  const webhookProvider = () => makeProvider(fakeTwitch({}).fetchImpl, { env: webhookEnv });

  it('is enabled only with https PUBLIC_URL, a valid secret and port 443', () => {
    const enabled = webhookProvider();
    expect(enabled.webhook?.path).toBe('/webhooks/twitch');
    expect(enabled.webhook?.callbackUrl).toBe(CALLBACK);
    expect(enabled.capabilities).toEqual({ live: true, content: ['vod', 'highlight', 'video', 'clip'], liveBatchSize: 100, push: true });

    const variants: Array<[Record<string, string>, string]> = [
      [{ PUBLIC_URL: 'https://bot.example.com' }, 'TWITCH_EVENTSUB_SECRET'],
      [{ PUBLIC_URL: 'http://bot.example.com', TWITCH_EVENTSUB_SECRET: SECRET }, 'PUBLIC_URL'],
      [{ PUBLIC_URL: 'https://bot.example.com', TWITCH_EVENTSUB_SECRET: 'short' }, '10'],
      [{ PUBLIC_URL: 'https://bot.example.com:8443', TWITCH_EVENTSUB_SECRET: SECRET }, '443'],
    ];
    for (const [env, hint] of variants) {
      const provider = makeProvider(fakeTwitch({}).fetchImpl, { env });
      expect(provider.webhook).toBeUndefined();
      expect(provider.capabilities.push).toBe(false);
      expect(provider.health().notes.join('\n')).toContain(hint);
    }
  });

  it('echoes the verification challenge as text/plain', async () => {
    const res = await webhookProvider().webhook!.handle(
      delivery({ challenge: 'pogchamp-kappa-360noscope', subscription: { id: 's', type: 'stream.online', version: '1', status: 'webhook_callback_verification_pending' } }, { type: 'webhook_callback_verification' }),
    );
    expect(res).toMatchObject({ status: 200, body: 'pogchamp-kappa-360noscope', hints: [] });
    expect(res.contentType).toMatch(/^text\/plain/);
  });

  it('turns notifications into push hints and ignores redeliveries', async () => {
    const adapter = webhookProvider().webhook!;
    await expect(adapter.handle(delivery(notification('stream.online', '1234'), { id: 'm1' }))).resolves.toMatchObject({
      status: 204,
      hints: [{ type: 'live', platform: 'twitch', platformId: '1234' }],
    });
    await expect(adapter.handle(delivery(notification('stream.offline', '1234')))).resolves.toMatchObject({
      hints: [{ type: 'offline', platform: 'twitch', platformId: '1234' }],
    });
    await expect(adapter.handle(delivery(notification('channel.update', '1234')))).resolves.toMatchObject({
      hints: [{ type: 'metadata', platform: 'twitch', platformId: '1234' }],
    });
    await expect(adapter.handle(delivery(notification('channel.follow', '1234')))).resolves.toMatchObject({ status: 204, hints: [] });
    await expect(adapter.handle(delivery(notification('stream.online', '1234'), { id: 'm1' }))).resolves.toMatchObject({ status: 204, hints: [] });
  });

  it('rejects bad signatures, tampered bodies, missing headers and stale messages', async () => {
    const adapter = webhookProvider().webhook!;
    const body = notification('stream.online', '1234');
    expect((await adapter.handle(delivery(body, { secret: 'another-secret-value' }))).status).toBe(403);
    expect((await adapter.handle(delivery(body, { tamper: true }))).status).toBe(403);
    expect((await adapter.handle(delivery(body, { timestamp: new Date(NOW - 11 * MIN).toISOString() }))).status).toBe(403);
    expect((await adapter.handle(delivery(body, { timestamp: '2026-10-03T11:55:00.123456789Z' }))).status).toBe(204);

    const unsigned = delivery(body);
    delete unsigned.headers['twitch-eventsub-message-signature'];
    expect((await adapter.handle(unsigned)).status).toBe(403);

    const res = await adapter.handle(delivery(body, { method: 'GET' }));
    expect(res.status).toBe(405);
    expect(res.hints).toEqual([]);
  });

  it('acknowledges revocations, asks for a re-check and records them', async () => {
    const provider = webhookProvider();
    const res = await provider.webhook!.handle(
      delivery(
        { subscription: { id: 'sub-9', type: 'stream.online', version: '1', status: 'user_removed', condition: { broadcaster_user_id: '77' }, transport: { method: 'webhook', callback: CALLBACK } } },
        { type: 'revocation' },
      ),
    );
    expect(res).toMatchObject({ status: 204, hints: [{ type: 'metadata', platform: 'twitch', platformId: '77' }] });
    expect(provider.webhook!.status().revocations).toEqual([expect.objectContaining({ status: 'user_removed', broadcasterId: '77' })]);
    expect(provider.health().notes.join('\n')).toContain('user_removed');
  });

  it('verifyEventSubSignature matches the Twitch scheme', () => {
    const raw = Buffer.from('{"a":1}');
    const sig = `sha256=${createHmac('sha256', SECRET).update('id1').update('ts1').update(raw).digest('hex')}`;
    expect(verifyEventSubSignature(SECRET, 'id1', 'ts1', raw, sig)).toBe(true);
    expect(verifyEventSubSignature(SECRET, 'id1', 'ts2', raw, sig)).toBe(false);
    expect(verifyEventSubSignature(SECRET, 'id1', 'ts1', raw, 'sha256=zz')).toBe(false);
    expect(verifyEventSubSignature(SECRET, 'id1', 'ts1', raw, sig.replace('sha256=', 'sha1='))).toBe(false);
  });
});

// ───────────────────────────── EventSub sync ─────────────────────────────

interface FakeSub {
  id: string;
  type: string;
  version: string;
  status: string;
  condition: { broadcaster_user_id: string };
  created_at: string;
  transport: { method: string; callback: string };
}

const sub = (id: string, type: string, version: string, broadcaster: string, status = 'enabled', extra: Partial<FakeSub> = {}): FakeSub => ({
  id,
  type,
  version,
  status,
  condition: { broadcaster_user_id: broadcaster },
  created_at: iso(-HOUR),
  transport: { method: 'webhook', callback: CALLBACK },
  ...extra,
});

/** Fake EventSub backend: the listing is served in pages of 3, creates/deletes are recorded. */
function eventSubApi(initial: FakeSub[], create: (body: { type: string; version: string; condition: { broadcaster_user_id: string } }) => Response = () => empty(202)) {
  const state = { subs: [...initial], listFails: false };
  const api = fakeTwitch({
    'GET /eventsub/subscriptions': (call) => {
      if (state.listFails) return json({ status: 400, message: 'bad' }, 400);
      const offset = Number(call.url.searchParams.get('after') ?? 0);
      const page = state.subs.slice(offset, offset + 3);
      const next = offset + 3 < state.subs.length ? String(offset + 3) : undefined;
      return json({ data: page, total: state.subs.length, total_cost: state.subs.length, max_total_cost: 10000, pagination: next ? { cursor: next } : {} });
    },
    'POST /eventsub/subscriptions': (call) => create(JSON.parse(call.body ?? '{}')),
    'DELETE /eventsub/subscriptions': () => empty(204),
  });
  const created = () =>
    api.helix('POST /eventsub/subscriptions').map((c) => {
      const body = JSON.parse(c.body ?? '{}');
      return `${body.type}@${body.version}:${body.condition.broadcaster_user_id}`;
    });
  const deleted = () => api.helix('DELETE /eventsub/subscriptions').map((c) => c.url.searchParams.get('id'));
  return { ...api, state, created, deleted };
}

/** Provider whose kv already holds the fingerprint of the current secret (as after a previous sync). */
async function syncedProvider(api: ReturnType<typeof eventSubApi>, kv = newKv()) {
  const bootstrap = eventSubApi([]);
  await makeProvider(bootstrap.fetchImpl, { env: webhookEnv, kv }).webhook!.sync([]);
  return makeProvider(api.fetchImpl, { env: webhookEnv, kv });
}

describe('EventSub sync', () => {
  it('creates all subscriptions on a fresh setup with the right payload', async () => {
    const api = eventSubApi([]);
    const provider = makeProvider(api.fetchImpl, { env: webhookEnv });
    await provider.webhook!.sync([channel('111', 'a'), channel('222', 'b'), { ...channel('5', 'yt'), platform: 'youtube' }]);

    expect(api.created().sort()).toEqual(
      ['channel.update@2:111', 'channel.update@2:222', 'stream.offline@1:111', 'stream.offline@1:222', 'stream.online@1:111', 'stream.online@1:222'].sort(),
    );
    const body = JSON.parse(api.helix('POST /eventsub/subscriptions')[0]!.body ?? '{}');
    expect(body.transport).toEqual({ method: 'webhook', callback: CALLBACK, secret: SECRET });
    expect(provider.webhook!.status().lastSync).toMatchObject({ channels: 2, active: 6, created: 6, failed: 0, error: null });
    expect(provider.health().notes.join('\n')).toContain('اشتراكات EventSub: 6');
  });

  it('keeps healthy subscriptions, deletes stale ones and recreates broken ones', async () => {
    const api = eventSubApi(
      [
        sub('A', 'stream.online', '1', '111'),
        sub('B', 'stream.offline', '1', '111'),
        sub('C', 'channel.update', '2', '111', 'webhook_callback_verification_failed'),
        sub('D', 'stream.online', '1', '333'), // no longer tracked
        sub('E', 'stream.online', '1', '222', 'enabled', { transport: { method: 'webhook', callback: 'https://other.example.com/webhooks/twitch' } }),
        sub('F', 'channel.update', '1', '222'), // outdated version
        sub('G', 'stream.offline', '1', '222'),
        sub('H', 'stream.offline', '1', '222'), // duplicate
        sub('I', 'channel.update', '2', '222', 'webhook_callback_verification_pending', { created_at: iso(-2 * MIN) }), // still verifying
        sub('J', 'stream.online', '1', '444', 'webhook_callback_verification_pending', { created_at: iso(-30 * MIN) }), // stuck
      ],
      (body) => (body.condition.broadcaster_user_id === '222' && body.type === 'stream.online' ? json({ status: 409, message: 'subscription already exists' }, 409) : empty(202)),
    );
    const provider = await syncedProvider(api);
    await provider.webhook!.sync([channel('111', 'a'), channel('222', 'b'), channel('444', 'd')]);

    expect(api.helix('GET /eventsub/subscriptions')).toHaveLength(4); // paginated
    expect(api.deleted().sort()).toEqual(['C', 'D', 'F', 'H', 'J']);
    expect(api.created().sort()).toEqual(
      ['channel.update@2:111', 'channel.update@2:444', 'stream.offline@1:444', 'stream.online@1:222', 'stream.online@1:444'].sort(),
    );
    expect(provider.webhook!.status().lastSync).toMatchObject({ channels: 3, active: 9, created: 4, deleted: 5, failed: 0 });
  });

  it('never throws: single failures are counted, listing failures skip the sync', async () => {
    const api = eventSubApi([], (body) => (body.condition.broadcaster_user_id === '999' ? json({ status: 400, message: 'user does not exist' }, 400) : empty(202)));
    const provider = await syncedProvider(api);
    await expect(provider.webhook!.sync([channel('111', 'a'), channel('999', 'gone')])).resolves.toBeUndefined();
    expect(api.created()).toHaveLength(6);
    expect(provider.webhook!.status().lastSync).toMatchObject({ active: 3, created: 3, failed: 3 });

    api.state.listFails = true;
    const before = api.calls.length;
    await expect(provider.webhook!.sync([channel('111', 'a')])).resolves.toBeUndefined();
    expect(api.calls.length).toBe(before + 1);
    expect(provider.webhook!.status().lastSync?.error).toMatch(/HTTP 400/);
    expect(provider.health().notes.join('\n')).toContain('فشلت آخر مزامنة');
  });

  it('stops creating once Twitch reports a subscription limit', async () => {
    const api = eventSubApi([], () => json({ status: 429, message: 'max_total_cost exceeded' }, 429, { 'ratelimit-remaining': '700' }));
    const provider = await syncedProvider(api);
    await provider.webhook!.sync(Array.from({ length: 10 }, (_, i) => channel(String(i + 1), `u${i}`)));
    expect(api.created().length).toBeLessThanOrEqual(4); // at most the in-flight lane count
    expect(provider.webhook!.status().lastSync).toMatchObject({ limitReached: true, created: 0, failed: 30 });
    expect(provider.health().notes.join('\n')).toContain('حد اشتراكات');
  });

  it('recreates every subscription when the signing secret changes', async () => {
    const kv = newKv();
    const first = eventSubApi([]);
    await makeProvider(first.fetchImpl, { env: webhookEnv, kv }).webhook!.sync([channel('111', 'a')]);
    expect(first.created()).toHaveLength(3);

    const existing = [sub('A', 'stream.online', '1', '111'), sub('B', 'stream.offline', '1', '111'), sub('C', 'channel.update', '2', '111')];
    const rotated = eventSubApi(existing);
    const provider = makeProvider(rotated.fetchImpl, { env: { ...webhookEnv, TWITCH_EVENTSUB_SECRET: 'rotated-secret-value-456' }, kv });
    await provider.webhook!.sync([channel('111', 'a')]);
    expect(rotated.deleted().sort()).toEqual(['A', 'B', 'C']);
    expect(rotated.created()).toHaveLength(3);

    // Fingerprint is now stored: the next sync is a no-op.
    rotated.state.subs = existing;
    const calls = rotated.calls.length;
    await provider.webhook!.sync([channel('111', 'a')]);
    expect(rotated.calls.length).toBe(calls + 1); // listing only
  });

  it('coalesces overlapping sync calls and applies the latest channel list', async () => {
    const api = eventSubApi([]);
    const provider = await syncedProvider(api);
    const first = provider.webhook!.sync([channel('111', 'a')]);
    const second = provider.webhook!.sync([channel('111', 'a'), channel('222', 'b')]);
    await Promise.all([first, second]);
    expect(api.helix('GET /eventsub/subscriptions')).toHaveLength(2);
    expect(api.created().filter((k) => k.endsWith(':222'))).toHaveLength(3);
  });
});

describe('createTwitchProvider', () => {
  it('builds a provider from the context', () => {
    const config = loadConfig({ DISCORD_TOKEN: 't', DISCORD_CLIENT_ID: 'c' });
    const provider = createTwitchProvider({ config, logger: silent, kv: newKv() });
    expect(provider.platform).toBe('twitch');
    expect(provider.isConfigured()).toBe(false);
  });
});
