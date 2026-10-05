import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { pino } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { ChannelNotFoundError, ProviderError, ProviderNotConfiguredError, RateLimitedError, ValidationError } from '../../src/core/errors.js';
import type { ChannelRef } from '../../src/core/types.js';
import { openDatabase } from '../../src/db/database.js';
import { Repositories } from '../../src/db/repositories.js';
import type { FetchLike } from '../../src/platforms/http.js';
import { KICK_WEBHOOK_PATH, KickProvider, parseKickChannelInput, parseKickDate, type KickProviderOptions } from '../../src/platforms/kick.js';
import type { KeyValueStore, WebhookRequest } from '../../src/platforms/types.js';

// ───────────────────────────── test harness ─────────────────────────────

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

type Handler = (call: Call) => Response | Promise<Response>;

class FakeKick {
  readonly calls: Call[] = [];
  private readonly routes = new Map<string, Handler>();

  on(method: string, url: string, handler: Handler): this {
    this.routes.set(`${method} ${url}`, handler);
    return this;
  }

  readonly fetch: FetchLike = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)]),
    );
    const call: Call = { url, method, headers, body: init.body === undefined || init.body === null ? undefined : String(init.body) };
    this.calls.push(call);
    const handler = this.routes.get(`${method} ${url.origin}${url.pathname}`);
    if (!handler) return new Response(`no route for ${method} ${url.href}`, { status: 418 });
    return handler(call);
  };

  callsTo(pathOrUrl: string): Call[] {
    return this.calls.filter((c) => `${c.url.origin}${c.url.pathname}` === pathOrUrl || c.url.pathname === pathOrUrl);
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

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

const API = 'https://api.kick.com/public/v1';
const TOKEN = 'https://id.kick.com/oauth/token';
const T0 = Date.parse('2026-10-03T12:00:00Z');

// Most tests exercise the unofficial content path (on by default); the switched-off behaviour has its own test.
const baseEnv = { DISCORD_TOKEN: 't', DISCORD_CLIENT_ID: 'c', KICK_CLIENT_ID: 'kick-id', KICK_CLIENT_SECRET: 'kick-secret', KICK_UNOFFICIAL_CONTENT: 'true' };
const logger = pino({ level: 'silent' });

let clock = T0;
let server: FakeKick;
let kv: KeyValueStore;

interface Setup {
  env?: Record<string, string>;
  options?: KickProviderOptions;
  kv?: KeyValueStore;
}

function makeProvider(setup: Setup = {}): KickProvider {
  const config = loadConfig({ ...baseEnv, ...(setup.env ?? {}) });
  return new KickProvider(
    { config, logger, kv: setup.kv ?? kv, fetch: server.fetch },
    { now: () => clock, unofficialMinIntervalMs: 0, ...(setup.options ?? {}) },
  );
}

function channel(platformId: string, handle: string, id = Number(platformId) || 1): ChannelRef {
  return { id, platform: 'kick', platformId, handle, meta: { slug: handle } };
}

function tokenRoute(tokens: string[] = ['tok-1']): void {
  let i = 0;
  server.on('POST', TOKEN, () => json({ access_token: tokens[Math.min(i++, tokens.length - 1)], token_type: 'Bearer', expires_in: 7200 }));
}

beforeEach(() => {
  clock = T0;
  server = new FakeKick();
  kv = new MemoryKv();
});

// ───────────────────────────── input parsing ─────────────────────────────

describe('parseKickChannelInput', () => {
  it('accepts slugs, @handles and kick.com URLs', () => {
    expect(parseKickChannelInput('xqc').candidates).toEqual(['xqc']);
    expect(parseKickChannelInput('  @XQC ').candidates).toEqual(['xqc']);
    expect(parseKickChannelInput('https://kick.com/xqc/videos/5c697a87-afce-4256-b01f-3c8fe71ef5cb').candidates).toEqual(['xqc']);
    expect(parseKickChannelInput('kick.com/xqc?clip=clip_01').candidates).toEqual(['xqc']);
    expect(parseKickChannelInput('https://www.kick.com/popout/xqc/chat').candidates).toEqual(['xqc']);
  });

  it('tries the hyphenated slug for usernames with underscores', () => {
    expect(parseKickChannelInput('@A_Log_Burner').candidates).toEqual(['a_log_burner', 'a-log-burner']);
  });

  it('detects numeric input that may be a broadcaster id', () => {
    expect(parseKickChannelInput('668').numericId).toBe('668');
    expect(parseKickChannelInput('xqc').numericId).toBeNull();
  });

  it('rejects other hosts, non-channel URLs and malformed names with Arabic messages', () => {
    expect(() => parseKickChannelInput('https://twitch.tv/xqc')).toThrow(ValidationError);
    expect(() => parseKickChannelInput('https://kick.com/categories/just-chatting')).toThrow(ValidationError);
    expect(() => parseKickChannelInput('')).toThrow(ValidationError);
    expect(() => parseKickChannelInput('bad name!')).toThrow(/كيك/);
    expect(() => parseKickChannelInput('a'.repeat(26))).toThrow(ValidationError);
  });
});

describe('parseKickDate', () => {
  it('handles RFC 3339, website timestamps (UTC without offset) and placeholders', () => {
    expect(parseKickDate('2026-10-02T18:00:00Z')).toBe(Date.parse('2026-10-02T18:00:00Z'));
    expect(parseKickDate('2025-01-01T11:00:00+11:00')).toBe(Date.parse('2025-01-01T00:00:00Z'));
    expect(parseKickDate('2026-10-02 18:00:00')).toBe(Date.parse('2026-10-02T18:00:00Z'));
    expect(parseKickDate('0001-01-01T00:00:00Z')).toBeNull();
    expect(parseKickDate('')).toBeNull();
    expect(parseKickDate(undefined)).toBeNull();
  });
});

// ───────────────────────────── auth ─────────────────────────────

describe('app access token', () => {
  const liveRoute = () => server.on('GET', `${API}/users/livestreams`, () => json({ data: [], message: 'OK' }));

  it('requests a client-credentials token once and caches it in memory and kv', async () => {
    const db = openDatabase(':memory:');
    const repos = new Repositories(db);
    tokenRoute();
    liveRoute();
    const provider = makeProvider({ kv: repos.kv });

    await provider.checkLive([channel('668', 'xqc')]);
    await provider.checkLive([channel('668', 'xqc')]);

    const tokenCalls = server.callsTo(TOKEN);
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(tokenCalls[0]?.body);
    expect(Object.fromEntries(form)).toEqual({ grant_type: 'client_credentials', client_id: 'kick-id', client_secret: 'kick-secret' });
    expect(server.callsTo(`${API}/users/livestreams`).every((c) => c.headers.authorization === 'Bearer tok-1')).toBe(true);
    expect(repos.kv.get<{ accessToken: string }>('kick:app_token')?.accessToken).toBe('tok-1');

    // A restarted process reuses the persisted token.
    const restarted = makeProvider({ kv: repos.kv });
    await restarted.checkLive([channel('668', 'xqc')]);
    expect(server.callsTo(TOKEN)).toHaveLength(1);
    db.close();
  });

  it('refreshes the token when it expires', async () => {
    tokenRoute(['tok-1', 'tok-2']);
    liveRoute();
    const provider = makeProvider();
    await provider.checkLive([channel('668', 'xqc')]);
    clock += 2 * 60 * 60 * 1000;
    await provider.checkLive([channel('668', 'xqc')]);
    expect(server.callsTo(TOKEN)).toHaveLength(2);
    expect(server.calls.at(-1)?.headers.authorization).toBe('Bearer tok-2');
  });

  it('fetches a new token and retries once when the API answers 401', async () => {
    tokenRoute(['tok-1', 'tok-2']);
    server.on('GET', `${API}/users/livestreams`, (call) =>
      call.headers.authorization === 'Bearer tok-1' ? json({ message: 'Unauthorized' }, 401) : json({ data: [] }),
    );
    const provider = makeProvider();
    const snapshots = await provider.checkLive([channel('668', 'xqc')]);
    expect(snapshots[0]?.isLive).toBe(false);
    expect(server.callsTo(TOKEN)).toHaveLength(2);
    expect((kv.get<{ accessToken: string }>('kick:app_token'))?.accessToken).toBe('tok-2');
  });

  it('ignores a cached token that belongs to another client id', async () => {
    kv.set('kick:app_token', { clientId: 'old-app', accessToken: 'stale', refreshAt: T0 + 3_600_000 });
    tokenRoute();
    liveRoute();
    await makeProvider().checkLive([channel('668', 'xqc')]);
    expect(server.callsTo(TOKEN)).toHaveLength(1);
    expect(server.calls.at(-1)?.headers.authorization).toBe('Bearer tok-1');
  });

  it('reports rejected credentials as not configured', async () => {
    server.on('POST', TOKEN, () => json({ error: 'Invalid request' }, 400));
    const provider = makeProvider();
    await expect(provider.checkLive([channel('668', 'xqc')])).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    expect(provider.health().notes.join('\n')).toContain('توكن');
  });

  it('is not configured without credentials', async () => {
    const provider = makeProvider({ env: { KICK_CLIENT_ID: '', KICK_CLIENT_SECRET: '' } });
    expect(provider.isConfigured()).toBe(false);
    expect(provider.health().configured).toBe(false);
    expect(provider.webhook).toBeUndefined();
    await expect(provider.checkLive([channel('668', 'xqc')])).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    await expect(provider.resolveChannel('xqc')).rejects.toBeInstanceOf(ProviderNotConfiguredError);
  });
});

// ───────────────────────────── resolve ─────────────────────────────

describe('resolveChannel', () => {
  beforeEach(() => tokenRoute());

  it('resolves a slug to the broadcaster id with display name and avatar', async () => {
    server.on('GET', `${API}/channels`, () => json({ data: [{ broadcaster_user_id: 668, slug: 'xqc', stream_title: 'hi' }] }));
    server.on('GET', `${API}/users`, () => json({ data: [{ user_id: 668, name: 'xQc', profile_picture: 'https://files.kick.com/xqc.webp' }] }));

    const resolved = await makeProvider().resolveChannel('https://kick.com/XQC');
    expect(resolved).toEqual({
      platform: 'kick',
      platformId: '668',
      handle: 'xqc',
      displayName: 'xQc',
      avatarUrl: 'https://files.kick.com/xqc.webp',
      url: 'https://kick.com/xqc',
      meta: { slug: 'xqc' },
    });
    expect(server.callsTo(`${API}/channels`)[0]?.url.searchParams.getAll('slug')).toEqual(['xqc']);
    expect(server.callsTo(`${API}/users`)[0]?.url.searchParams.get('id')).toBe('668');
  });

  it('matches the hyphenated slug of an underscore username', async () => {
    server.on('GET', `${API}/channels`, (call) => {
      expect(call.url.searchParams.getAll('slug')).toEqual(['a_log_burner', 'a-log-burner']);
      return json({ data: [{ broadcaster_user_id: 65114691, slug: 'a-log-burner' }] });
    });
    server.on('GET', `${API}/users`, () => json({ data: [] }));
    const resolved = await makeProvider().resolveChannel('@A_Log_Burner');
    expect(resolved.platformId).toBe('65114691');
    expect(resolved.handle).toBe('a-log-burner');
    expect(resolved.displayName).toBe('a-log-burner');
    expect(resolved.avatarUrl).toBeNull();
  });

  it('retries slug candidates one by one when Kick rejects the combined request', async () => {
    server.on('GET', `${API}/channels`, (call) => {
      const slugs = call.url.searchParams.getAll('slug');
      if (slugs.some((s) => s.includes('_'))) return json({ message: 'invalid slug' }, 400);
      return json({ data: [{ broadcaster_user_id: 65114691, slug: 'a-log-burner' }] });
    });
    server.on('GET', `${API}/users`, () => json({ data: [] }));
    const resolved = await makeProvider().resolveChannel('A_Log_Burner');
    expect(resolved.handle).toBe('a-log-burner');
    expect(server.callsTo(`${API}/channels`).map((c) => c.url.searchParams.getAll('slug'))).toEqual([
      ['a_log_burner', 'a-log-burner'],
      ['a_log_burner'],
      ['a-log-burner'],
    ]);
  });

  it('falls back to a broadcaster id lookup for numeric input', async () => {
    server.on('GET', `${API}/channels`, (call) =>
      call.url.searchParams.has('slug') ? json({ data: [] }) : json({ data: [{ broadcaster_user_id: 668, slug: 'xqc' }] }),
    );
    server.on('GET', `${API}/users`, () => json({ data: [{ user_id: 668, name: 'xQc' }] }));
    const resolved = await makeProvider().resolveChannel('668');
    expect(resolved.handle).toBe('xqc');
    expect(server.callsTo(`${API}/channels`)[1]?.url.searchParams.get('broadcaster_user_id')).toBe('668');
  });

  it('still resolves when the users lookup fails', async () => {
    server.on('GET', `${API}/channels`, () => json({ data: [{ broadcaster_user_id: 668, slug: 'xqc' }] }));
    server.on('GET', `${API}/users`, () => json({ message: 'Forbidden' }, 403));
    const resolved = await makeProvider().resolveChannel('xqc');
    expect(resolved.platformId).toBe('668');
    expect(resolved.avatarUrl).toBeNull();
  });

  it('throws ChannelNotFoundError for unknown slugs', async () => {
    server.on('GET', `${API}/channels`, () => json({ data: [], message: 'OK' }));
    await expect(makeProvider().resolveChannel('nobody-here')).rejects.toBeInstanceOf(ChannelNotFoundError);
  });
});

// ───────────────────────────── live ─────────────────────────────

const liveStream = (overrides: Record<string, unknown> = {}) => ({
  id: '123e4567-e89b-12d3-a456-426614174000',
  title: 'سوالف وقيمنق',
  viewer_count: 1543,
  started_at: '2026-10-03T10:00:00Z',
  thumbnail: 'https://images.kick.com/video_thumbnails/abc/720.webp',
  language_code: 'ar',
  tags: ['arabic', 'saudi'],
  has_mature_content: false,
  category: { id: 15, name: 'Just Chatting', thumbnail: 'https://files.kick.com/images/subcategories/15/banner.webp' },
  broadcaster_user: { id: 668, username: 'xQc', profile_picture: 'https://files.kick.com/xqc.webp' },
  channel: { slug: 'xqc' },
  ...overrides,
});

describe('checkLive', () => {
  beforeEach(() => tokenRoute());

  it('maps live channels and returns offline snapshots for the rest in one batched request', async () => {
    server.on('GET', `${API}/users/livestreams`, () => json({ data: [liveStream()] }));
    const provider = makeProvider();
    const [live, offline] = await provider.checkLive([channel('668', 'xqc'), channel('777', 'quiet')]);

    const call = server.callsTo(`${API}/users/livestreams`)[0];
    expect(call?.url.searchParams.getAll('user_id')).toEqual(['668', '777']);
    expect(server.callsTo(`${API}/users/livestreams`)).toHaveLength(1);

    expect(live).toMatchObject({
      platform: 'kick',
      platformId: '668',
      isLive: true,
      streamId: '123e4567-e89b-12d3-a456-426614174000',
      title: 'سوالف وقيمنق',
      category: 'Just Chatting',
      categoryImageUrl: 'https://files.kick.com/images/subcategories/15/banner.webp',
      viewers: 1543,
      startedAt: '2026-10-03T10:00:00.000Z',
      url: 'https://kick.com/xqc',
      language: 'ar',
      tags: ['arabic', 'saudi'],
    });
    expect(live?.thumbnailUrl).toMatch(/^https:\/\/images\.kick\.com\/video_thumbnails\/abc\/720\.webp\?t=\d+$/);
    expect(offline).toEqual({
      platform: 'kick',
      platformId: '777',
      isLive: false,
      streamId: null,
      title: null,
      category: null,
      categoryImageUrl: null,
      thumbnailUrl: null,
      viewers: null,
      startedAt: null,
      url: 'https://kick.com/quiet',
      language: null,
      tags: [],
    });
  });

  it('puts a renamed slug in the snapshot url and remembers it while offline', async () => {
    let isLive = true;
    server.on('GET', `${API}/users/livestreams`, () => json({ data: isLive ? [liveStream({ channel: { slug: 'xqc-new' } })] : [] }));
    const provider = makeProvider();
    const [first] = await provider.checkLive([channel('668', 'xqc')]);
    expect(first?.url).toBe('https://kick.com/xqc-new');
    isLive = false;
    const [second] = await provider.checkLive([channel('668', 'xqc')]);
    expect(second?.url).toBe('https://kick.com/xqc-new');
  });

  it('ignores placeholder thumbnails and keeps a hidden viewer count as reported', async () => {
    server.on('GET', `${API}/users/livestreams`, () =>
      json({ data: [liveStream({ thumbnail: 'https://kick.com/img/default-thumbnail-pictures/default2.jpeg', viewer_count: 0, category: null })] }),
    );
    const [snap] = await makeProvider().checkLive([channel('668', 'xqc')]);
    expect(snap?.thumbnailUrl).toBeNull();
    expect(snap?.viewers).toBe(0);
    expect(snap?.category).toBeNull();
  });

  it('answers non-numeric ids with offline snapshots without breaking the batch', async () => {
    server.on('GET', `${API}/users/livestreams`, () => json({ data: [liveStream()] }));
    const snaps = await makeProvider().checkLive([channel('not-an-id', 'weird', 5), channel('668', 'xqc')]);
    expect(snaps.map((s) => s.isLive)).toEqual([false, true]);
    expect(server.callsTo(`${API}/users/livestreams`)[0]?.url.searchParams.getAll('user_id')).toEqual(['668']);
  });

  it('makes no request for an empty batch', async () => {
    expect(await makeProvider().checkLive([])).toEqual([]);
    expect(server.calls).toHaveLength(0);
  });

  it('falls back to /channels and keeps the stream id stable across endpoints', async () => {
    let primaryUp = true;
    server.on('GET', `${API}/users/livestreams`, () => (primaryUp ? json({ data: [liveStream()] }) : json({ message: 'gone' }, 404)));
    server.on('GET', `${API}/channels`, (call) => {
      expect(call.url.searchParams.getAll('broadcaster_user_id')).toEqual(['668', '777']);
      return json({
        data: [
          {
            broadcaster_user_id: 668,
            slug: 'xqc',
            stream_title: 'عنوان جديد',
            category: { id: 1, name: 'Minecraft', thumbnail: 'https://files.kick.com/mc.webp' },
            stream: { is_live: true, viewer_count: 2000, start_time: '2026-10-03T10:00:30Z', thumbnail: 'https://images.kick.com/t.webp', language: 'ar', custom_tags: ['x'] },
          },
          { broadcaster_user_id: 777, slug: 'quiet', stream: { is_live: false, start_time: '0001-01-01T00:00:00Z' } },
        ],
      });
    });
    const provider = makeProvider();
    const channels = [channel('668', 'xqc'), channel('777', 'quiet')];
    const [before] = await provider.checkLive(channels);
    primaryUp = false;
    const [after, quiet] = await provider.checkLive(channels);

    expect(after).toMatchObject({ isLive: true, title: 'عنوان جديد', category: 'Minecraft', viewers: 2000, tags: ['x'] });
    expect(after?.streamId).toBe(before?.streamId);
    expect(quiet?.isLive).toBe(false);
  });

  it('synthesises a deterministic stream id when only the fallback endpoint answers', async () => {
    server.on('GET', `${API}/users/livestreams`, () => json({ message: 'bad' }, 400));
    server.on('GET', `${API}/channels`, () =>
      json({ data: [{ broadcaster_user_id: 668, slug: 'xqc', stream: { is_live: true, start_time: '2026-10-03T10:00:00Z' } }] }),
    );
    const [snap] = await makeProvider().checkLive([channel('668', 'xqc')]);
    expect(snap?.streamId).toBe(`668-${Date.parse('2026-10-03T10:00:00Z') / 1000}`);
  });

  it('surfaces rate limits without hammering the fallback endpoint', async () => {
    server.on('GET', `${API}/users/livestreams`, () => json({ message: 'slow down' }, 429, { 'retry-after': '30' }));
    server.on('GET', `${API}/channels`, () => json({ data: [] }));
    await expect(makeProvider().checkLive([channel('668', 'xqc')])).rejects.toBeInstanceOf(RateLimitedError);
    expect(server.callsTo(`${API}/channels`)).toHaveLength(0);
  });

  it('throws when every endpoint fails and reports it in health()', async () => {
    server.on('GET', `${API}/users/livestreams`, () => json({ message: 'bad' }, 400));
    server.on('GET', `${API}/channels`, () => json({ message: 'bad' }, 400));
    const provider = makeProvider();
    await expect(provider.checkLive([channel('668', 'xqc')])).rejects.toBeInstanceOf(ProviderError);
    expect(provider.health().notes.join('\n')).toContain('آخر فحص للبث في كيك فشل');
  });

  it('retries the edge WAF 403 instead of failing immediately', async () => {
    let calls = 0;
    server.on('GET', `${API}/users/livestreams`, () =>
      ++calls === 1 ? json({ error: 'Request blocked by security policy.' }, 403) : json({ data: [liveStream()] }),
    );
    const [snap] = await makeProvider().checkLive([channel('668', 'xqc')]);
    expect(snap?.isLive).toBe(true);
    expect(calls).toBe(2);
  });
});

// ───────────────────────────── content (unofficial) ─────────────────────────────

const VIDEOS = 'https://kick.com/api/v2/channels/xqc/videos';
const CLIPS = 'https://kick.com/api/v2/channels/xqc/clips';

const videoList = () => [
  {
    id: 9100,
    session_title: 'البث الحالي',
    is_live: true,
    start_time: '2026-10-03 11:00:00',
    duration: 0,
    video: { uuid: 'aaaaaaaa-0000-4000-8000-000000000003', live_stream_id: 9100 },
  },
  {
    id: 9001,
    session_title: 'بث أمس',
    is_live: false,
    start_time: '2026-10-02 18:00:00',
    duration: 7_200_000,
    thumbnail: { src: 'https://images.kick.com/video_thumbnails/x/720.webp', srcset: '' },
    views: 4321,
    video: { uuid: 'aaaaaaaa-0000-4000-8000-000000000002', live_stream_id: 9001, views: 10 },
  },
  {
    id: 8000,
    session_title: null,
    is_live: false,
    start_time: '2026-09-30 15:00:00',
    duration: 3_600_000,
    thumbnail: null,
    views: 5,
    video: { uuid: 'aaaaaaaa-0000-4000-8000-000000000001', live_stream_id: 8000 },
  },
];

const clipList = () => ({
  clips: [
    {
      id: 'clip_01OLDER',
      title: 'لقطة قديمة',
      thumbnail_url: 'https://clips.kick.com/clips/aa/clip_01OLDER/thumbnail.webp',
      duration: 30,
      view_count: 12,
      created_at: '2026-10-01T10:00:00Z',
      channel: { id: 1, slug: 'xqc' },
    },
    {
      id: 'clip_01NEWER',
      title: '',
      thumbnail_url: 'https://clips.kick.com/clips/bb/clip_01NEWER/thumbnail.webp',
      duration: 45.4,
      views: 99,
      created_at: '2026-10-03T09:00:00Z',
      channel: { id: 1, slug: 'xqc' },
    },
  ],
  nextCursor: 'abc',
});

const challengePage = () =>
  new Response('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>challenge-platform</body></html>', {
    status: 403,
    headers: { 'content-type': 'text/html; charset=UTF-8', 'cf-mitigated': 'challenge' },
  });

describe('unofficial content can be turned off', () => {
  beforeEach(() => tokenRoute());

  it('does not touch kick.com website endpoints when KICK_UNOFFICIAL_CONTENT=false', async () => {
    let websiteCalls = 0;
    server.on('GET', VIDEOS, () => {
      websiteCalls++;
      return json(videoList());
    });
    const provider = makeProvider({ env: { KICK_UNOFFICIAL_CONTENT: 'false' } });
    expect(provider.capabilities.content).toEqual([]);
    expect(await provider.fetchRecentContent(channel('668', 'xqc'), ['vod', 'clip'])).toEqual([]);
    expect(await provider.findVodUrl(channel('668', 'xqc'), 'stream-1', '2026-10-02T18:00:00Z')).toBe('https://kick.com/xqc/videos');
    expect(websiteCalls).toBe(0);
    expect(provider.health().notes.join('\n')).toContain('KICK_UNOFFICIAL_CONTENT');
  });
});

describe('fetchRecentContent (unofficial website API)', () => {
  beforeEach(() => tokenRoute());

  it('maps finished VODs, skips the in-progress recording and links VODs to tracked streams', async () => {
    // The monitor saw yesterday's broadcast through the official API (stream id = official uuid).
    server.on('GET', `${API}/users/livestreams`, () => json({ data: [liveStream({ id: 'official-uuid', started_at: '2026-10-02T18:01:00Z' })] }));
    server.on('GET', VIDEOS, () => json(videoList()));
    const provider = makeProvider();
    await provider.checkLive([channel('668', 'xqc')]);

    const items = await provider.fetchRecentContent(channel('668', 'xqc'), ['vod']);
    expect(items).toEqual([
      {
        platform: 'kick',
        platformId: '668',
        contentId: 'aaaaaaaa-0000-4000-8000-000000000002',
        kind: 'vod',
        title: 'بث أمس',
        url: 'https://kick.com/xqc/videos/aaaaaaaa-0000-4000-8000-000000000002',
        thumbnailUrl: 'https://images.kick.com/video_thumbnails/x/720.webp',
        publishedAt: '2026-10-02T20:00:00.000Z',
        durationSec: 7200,
        viewCount: 4321,
        relatedStreamId: 'official-uuid',
      },
      {
        platform: 'kick',
        platformId: '668',
        contentId: 'aaaaaaaa-0000-4000-8000-000000000001',
        kind: 'vod',
        title: 'تسجيل بث xqc',
        url: 'https://kick.com/xqc/videos/aaaaaaaa-0000-4000-8000-000000000001',
        thumbnailUrl: null,
        publishedAt: '2026-09-30T16:00:00.000Z',
        durationSec: 3600,
        viewCount: 5,
        relatedStreamId: '8000',
      },
    ]);

    const call = server.callsTo(VIDEOS)[0];
    expect(call?.headers['user-agent']).toMatch(/^Mozilla\/5\.0/);
    expect(call?.headers.referer).toBe('https://kick.com/xqc');
    expect(call?.headers.accept).toContain('application/json');
  });

  it('maps clips newest first', async () => {
    server.on('GET', CLIPS, (call) => {
      expect(call.url.searchParams.get('sort')).toBe('date');
      return json(clipList());
    });
    const items = await makeProvider().fetchRecentContent(channel('668', 'xqc'), ['clip']);
    expect(items.map((i) => i.contentId)).toEqual(['clip_01NEWER', 'clip_01OLDER']);
    expect(items[0]).toEqual({
      platform: 'kick',
      platformId: '668',
      contentId: 'clip_01NEWER',
      kind: 'clip',
      title: 'كليب جديد',
      url: 'https://kick.com/xqc/clips/clip_01NEWER',
      thumbnailUrl: 'https://clips.kick.com/clips/bb/clip_01NEWER/thumbnail.webp',
      publishedAt: '2026-10-03T09:00:00.000Z',
      durationSec: 45,
      viewCount: 99,
    });
  });

  it('ignores kinds Kick cannot provide', async () => {
    expect(await makeProvider().fetchRecentContent(channel('668', 'xqc'), ['video', 'short'])).toEqual([]);
    expect(server.calls).toHaveLength(0);
  });

  it('opens the circuit on a Cloudflare 403 and backs off exponentially (15 min → 30 min)', async () => {
    let blocked = true;
    server.on('GET', VIDEOS, () => (blocked ? challengePage() : json(videoList())));
    server.on('GET', CLIPS, () => json(clipList()));
    const provider = makeProvider();
    const ch = channel('668', 'xqc');

    expect(await provider.fetchRecentContent(ch, ['vod', 'clip'])).toEqual([]);
    expect(server.calls).toHaveLength(1); // clips were not even attempted
    expect(provider.health().notes.join('\n')).toContain('محتوى كيك (VOD/كليبات) محجوب حالياً من Cloudflare');

    // While open: no requests at all.
    clock += 10 * 60_000;
    expect(await provider.fetchRecentContent(ch, ['vod', 'clip'])).toEqual([]);
    expect(server.calls).toHaveLength(1);

    // Cooldown over: one probe, blocked again → 30 min.
    clock = T0 + 15 * 60_000 + 1;
    expect(await provider.fetchRecentContent(ch, ['vod', 'clip'])).toEqual([]);
    expect(server.calls).toHaveLength(2);
    const state = kv.get<{ failures: number; openUntil: number }>('kick:unofficial_breaker');
    expect(state?.failures).toBe(2);
    expect(state!.openUntil - clock).toBe(30 * 60_000);

    // A restarted process respects the persisted breaker.
    const restarted = makeProvider();
    expect(await restarted.fetchRecentContent(ch, ['vod'])).toEqual([]);
    expect(server.calls).toHaveLength(2);

    // Kick lets us through again: the circuit closes.
    blocked = false;
    clock += 30 * 60_000 + 1;
    const items = await provider.fetchRecentContent(ch, ['vod', 'clip']);
    expect(items.map((i) => i.kind).sort()).toEqual(['clip', 'clip', 'vod', 'vod']);
    expect(kv.get<{ failures: number }>('kick:unofficial_breaker')?.failures).toBe(0);
    expect(provider.health().notes.join('\n')).not.toContain('Cloudflare');
  });

  it('caps the backoff at 6 hours', async () => {
    server.on('GET', VIDEOS, () => challengePage());
    const provider = makeProvider();
    const cooldownsMin: number[] = [];
    for (let i = 0; i < 8; i++) {
      const requestedAt = clock;
      await provider.fetchRecentContent(channel('668', 'xqc'), ['vod']);
      const state = kv.get<{ openUntil: number }>('kick:unofficial_breaker')!;
      cooldownsMin.push((state.openUntil - requestedAt) / 60_000);
      clock = state.openUntil + 1;
    }
    expect(cooldownsMin).toEqual([15, 30, 60, 120, 240, 360, 360, 360]);
    expect(server.callsTo(VIDEOS)).toHaveLength(8);
  });

  it('treats a 200 HTML challenge page as blocked', async () => {
    server.on('GET', VIDEOS, () => new Response('<html><title>Just a moment...</title></html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const provider = makeProvider();
    expect(await provider.fetchRecentContent(channel('668', 'xqc'), ['vod'])).toEqual([]);
    expect(kv.get<{ failures: number }>('kick:unofficial_breaker')?.failures).toBe(1);
  });

  it('throws a retryable error when every requested kind fails transiently, without tripping the breaker', async () => {
    server.on('GET', VIDEOS, () => json({ message: 'oops' }, 500));
    server.on('GET', CLIPS, () => json({ message: 'oops' }, 502));
    const provider = makeProvider();
    await expect(provider.fetchRecentContent(channel('668', 'xqc'), ['vod', 'clip'])).rejects.toMatchObject({ retryable: true });
    expect(kv.get('kick:unofficial_breaker')).toBeUndefined();
  });

  it('returns partial results when only one kind fails', async () => {
    server.on('GET', VIDEOS, () => json({ message: 'oops' }, 500));
    server.on('GET', CLIPS, () => json(clipList()));
    const items = await makeProvider().fetchRecentContent(channel('668', 'xqc'), ['vod', 'clip']);
    expect(items.map((i) => i.kind)).toEqual(['clip', 'clip']);
  });

  it('re-resolves a renamed slug through the official API when the website answers 404', async () => {
    server.on('GET', 'https://kick.com/api/v2/channels/oldname/videos', () => json({ message: 'Not found' }, 404));
    server.on('GET', 'https://kick.com/api/v2/channels/newname/videos', () => json(videoList()));
    server.on('GET', `${API}/channels`, (call) => {
      expect(call.url.searchParams.get('broadcaster_user_id')).toBe('668');
      return json({ data: [{ broadcaster_user_id: 668, slug: 'newname' }] });
    });
    const items = await makeProvider().fetchRecentContent(channel('668', 'oldname'), ['vod']);
    expect(items[0]?.url).toBe('https://kick.com/newname/videos/aaaaaaaa-0000-4000-8000-000000000002');
    expect(kv.get('kick:unofficial_breaker')).toBeUndefined();
  });
});

describe('findVodUrl', () => {
  beforeEach(() => tokenRoute());

  it('finds the recording by start time, even while Kick still marks it live', async () => {
    server.on('GET', VIDEOS, () => json(videoList()));
    const provider = makeProvider();
    expect(await provider.findVodUrl(channel('668', 'xqc'), 'some-official-uuid', '2026-10-03T11:02:00.000Z')).toBe(
      'https://kick.com/xqc/videos/aaaaaaaa-0000-4000-8000-000000000003',
    );
    expect(await provider.findVodUrl(channel('668', 'xqc'), null, '2026-10-02T18:00:10Z')).toBe(
      'https://kick.com/xqc/videos/aaaaaaaa-0000-4000-8000-000000000002',
    );
    // Second lookup was served from the short-lived cache.
    expect(server.callsTo(VIDEOS)).toHaveLength(1);
  });

  it('returns null (so the lookup is retried later) when nothing matches or the website is blocked', async () => {
    server.on('GET', VIDEOS, () => json(videoList()));
    expect(await makeProvider().findVodUrl(channel('668', 'xqc'), null, '2026-01-01T00:00:00Z')).toBeNull();

    server.on('GET', VIDEOS, () => challengePage());
    kv = new MemoryKv();
    expect(await makeProvider().findVodUrl(channel('668', 'xqc'), null, '2026-10-02T18:00:00Z')).toBeNull();

    server.on('GET', VIDEOS, () => new Response('boom', { status: 500 }));
    kv = new MemoryKv();
    expect(await makeProvider().findVodUrl(channel('668', 'xqc'), null, '2026-10-02T18:00:00Z')).toBeNull();
  });
});

// ───────────────────────────── webhooks ─────────────────────────────

interface Keys {
  publicPem: string;
  privateKey: KeyObject;
}

function rsaKeys(): Keys {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey };
}

function delivery(
  keys: Keys,
  eventType: string,
  payload: unknown,
  opts: { messageId?: string; timestamp?: string; tamper?: boolean } = {},
): WebhookRequest {
  const messageId = opts.messageId ?? `01J${Math.random().toString(36).slice(2, 12).toUpperCase()}`;
  const timestamp = opts.timestamp ?? new Date(clock).toISOString();
  const body = JSON.stringify(payload);
  const signature = sign('RSA-SHA256', Buffer.from(`${messageId}.${timestamp}.${body}`), keys.privateKey).toString('base64');
  return {
    method: 'POST',
    query: {},
    rawBody: Buffer.from(opts.tamper ? body.replace('true', 'false') : body),
    headers: {
      'kick-event-message-id': messageId,
      'kick-event-subscription-id': '01SUB',
      'kick-event-signature': signature,
      'kick-event-message-timestamp': timestamp,
      'kick-event-type': eventType,
      'kick-event-version': '1',
    },
  };
}

const broadcaster = { is_anonymous: false, user_id: 123456789, username: 'Streamer', is_verified: true, profile_picture: '', channel_slug: 'streamer', identity: null };
const statusPayload = (isLive: boolean) => ({
  broadcaster,
  is_live: isLive,
  title: 'Stream Title',
  started_at: '2026-10-03T11:00:00Z',
  ended_at: isLive ? null : '2026-10-03T12:00:00Z',
});
const webhookEnv = { PUBLIC_URL: 'https://bot.example.com' };

describe('webhook adapter', () => {
  let keys: Keys;
  beforeEach(() => {
    keys = rsaKeys();
    tokenRoute();
  });

  it('exists only when credentials and an https PUBLIC_URL are configured', () => {
    expect(makeProvider().webhook).toBeUndefined();
    expect(makeProvider().capabilities.push).toBe(false);
    expect(makeProvider({ env: { PUBLIC_URL: 'http://localhost:3000' } }).webhook).toBeUndefined();
    const provider = makeProvider({ env: webhookEnv });
    expect(provider.webhook?.path).toBe(KICK_WEBHOOK_PATH);
    expect(KICK_WEBHOOK_PATH).toBe('/webhooks/kick');
    expect(provider.capabilities).toEqual({ live: true, content: ['vod', 'clip'], liveBatchSize: 100, push: true });
    expect(provider.health().notes.join('\n')).toContain('https://bot.example.com/webhooks/kick');
  });

  it('turns verified status/metadata events into hints', async () => {
    const hook = makeProvider({ env: webhookEnv, options: { publicKeyPem: keys.publicPem } }).webhook!;
    const live = await hook.handle(delivery(keys, 'livestream.status.updated', statusPayload(true)));
    expect(live.status).toBe(200);
    expect(live.hints).toEqual([{ type: 'live', platform: 'kick', platformId: '123456789' }]);

    const offline = await hook.handle(delivery(keys, 'livestream.status.updated', statusPayload(false)));
    expect(offline.hints).toEqual([{ type: 'offline', platform: 'kick', platformId: '123456789' }]);

    const metadata = await hook.handle(
      delivery(keys, 'livestream.metadata.updated', {
        broadcaster,
        metadata: { title: 'New', language: 'ar', has_mature_content: false, category: { id: 1, name: 'GTA V', thumbnail: '' } },
      }),
    );
    expect(metadata.hints).toEqual([{ type: 'metadata', platform: 'kick', platformId: '123456789' }]);

    const other = await hook.handle(delivery(keys, 'channel.followed', { broadcaster, follower: broadcaster }));
    expect(other).toMatchObject({ status: 200, hints: [] });
  });

  it('rejects unsigned, tampered or foreign-key deliveries with 403', async () => {
    const hook = makeProvider({ env: webhookEnv, options: { publicKeyPem: keys.publicPem } }).webhook!;
    const tampered = await hook.handle(delivery(keys, 'livestream.status.updated', statusPayload(true), { tamper: true }));
    expect(tampered).toMatchObject({ status: 403, hints: [] });

    const unsigned = delivery(keys, 'livestream.status.updated', statusPayload(true));
    delete unsigned.headers['kick-event-signature'];
    expect((await hook.handle(unsigned)).status).toBe(403);

    const forged = await hook.handle(delivery(rsaKeys(), 'livestream.status.updated', statusPayload(true)));
    expect(forged.status).toBe(403);
  });

  it('acknowledges but ignores stale and duplicate deliveries', async () => {
    const hook = makeProvider({ env: webhookEnv, options: { publicKeyPem: keys.publicPem } }).webhook!;
    const stale = await hook.handle(
      delivery(keys, 'livestream.status.updated', statusPayload(true), { timestamp: new Date(clock - 6 * 60_000).toISOString() }),
    );
    expect(stale).toMatchObject({ status: 200, hints: [] });

    const first = await hook.handle(delivery(keys, 'livestream.status.updated', statusPayload(true), { messageId: 'dup-1' }));
    const again = await hook.handle(delivery(keys, 'livestream.status.updated', statusPayload(true), { messageId: 'dup-1' }));
    expect(first.hints).toHaveLength(1);
    expect(again).toMatchObject({ status: 200, hints: [] });
  });

  it('answers GET health probes', async () => {
    const hook = makeProvider({ env: webhookEnv, options: { publicKeyPem: keys.publicPem } }).webhook!;
    const res = await hook.handle({ method: 'GET', headers: {}, query: {}, rawBody: Buffer.alloc(0) });
    expect(res).toMatchObject({ status: 200, hints: [] });
  });

  it('uses the public key cached in kv', async () => {
    kv.set('kick:public_key', { pem: keys.publicPem, fetchedAt: clock });
    const hook = makeProvider({ env: webhookEnv }).webhook!;
    const res = await hook.handle(delivery(keys, 'livestream.status.updated', statusPayload(true)));
    expect(res.hints).toHaveLength(1);
    expect(server.callsTo(`${API}/public-key`)).toHaveLength(0);
  });

  it('fetches the public key from Kick and caches it', async () => {
    server.on('GET', `${API}/public-key`, () => json({ data: { public_key: keys.publicPem }, message: 'OK' }));
    const hook = makeProvider({ env: webhookEnv }).webhook!;
    expect((await hook.handle(delivery(keys, 'livestream.status.updated', statusPayload(true)))).hints).toHaveLength(1);
    expect((await hook.handle(delivery(keys, 'livestream.status.updated', statusPayload(false)))).hints).toHaveLength(1);
    expect(server.callsTo(`${API}/public-key`)).toHaveLength(1);
    expect(kv.get<{ pem: string }>('kick:public_key')?.pem).toBe(keys.publicPem.trim());
  });

  it('refreshes the key once when Kick rotates it, but not on every forged request', async () => {
    const rotated = rsaKeys();
    kv.set('kick:public_key', { pem: keys.publicPem, fetchedAt: clock });
    server.on('GET', `${API}/public-key`, () => json({ data: { public_key: rotated.publicPem } }));
    const hook = makeProvider({ env: webhookEnv }).webhook!;

    expect((await hook.handle(delivery(rotated, 'livestream.status.updated', statusPayload(true)))).status).toBe(200);
    expect(server.callsTo(`${API}/public-key`)).toHaveLength(1);

    for (let i = 0; i < 3; i++) expect((await hook.handle(delivery(rsaKeys(), 'livestream.status.updated', statusPayload(true)))).status).toBe(403);
    expect(server.callsTo(`${API}/public-key`)).toHaveLength(1);
  });

  it('learns renamed slugs from webhook payloads', async () => {
    server.on('GET', `${API}/users/livestreams`, () => json({ data: [] }));
    const provider = makeProvider({ env: webhookEnv, options: { publicKeyPem: keys.publicPem } });
    await provider.webhook!.handle(
      delivery(keys, 'livestream.status.updated', { ...statusPayload(false), broadcaster: { ...broadcaster, channel_slug: 'renamed' } }),
    );
    const [snap] = await provider.checkLive([channel('123456789', 'streamer')]);
    expect(snap?.url).toBe('https://kick.com/renamed');
  });
});

// ───────────────────────────── subscription sync ─────────────────────────────

describe('webhook sync', () => {
  const SUBS = `${API}/events/subscriptions`;

  beforeEach(() => {
    tokenRoute();
    server.on('GET', `${API}/public-key`, () => json({ data: { public_key: rsaKeys().publicPem } }));
  });

  it('creates missing subscriptions and deletes stale or duplicate ones', async () => {
    server.on('GET', SUBS, () =>
      json({
        data: [
          { id: 's1', broadcaster_user_id: 100, event: 'livestream.status.updated', version: 1, method: 'webhook' },
          { id: 's2', broadcaster_user_id: 999, event: 'livestream.status.updated', version: 1, method: 'webhook' },
          { id: 's3', broadcaster_user_id: 100, event: 'livestream.status.updated', version: 1, method: 'webhook' },
          { id: 's4', broadcaster_user_id: 999, event: 'chat.message.sent', version: 1, method: 'webhook' },
        ],
      }),
    );
    server.on('POST', SUBS, (call) => {
      const body = JSON.parse(call.body ?? '{}') as { events: Array<{ name: string; version: number }> };
      return json({ data: body.events.map((e, i) => ({ name: e.name, version: e.version, subscription_id: `new-${i}` })) });
    });
    server.on('DELETE', SUBS, () => new Response(null, { status: 204 }));

    const provider = makeProvider({ env: webhookEnv });
    await provider.webhook!.sync([channel('100', 'a'), channel('200', 'b'), { ...channel('300', 'tw'), platform: 'twitch' }]);

    const posts = server.calls
      .filter((c) => c.method === 'POST' && c.url.href === SUBS)
      .map((c) => JSON.parse(c.body ?? '{}') as { broadcaster_user_id: number; method: string; events: unknown[] })
      .sort((a, b) => a.broadcaster_user_id - b.broadcaster_user_id);
    expect(posts).toEqual([
      { broadcaster_user_id: 100, method: 'webhook', events: [{ name: 'livestream.metadata.updated', version: 1 }] },
      {
        broadcaster_user_id: 200,
        method: 'webhook',
        events: [
          { name: 'livestream.status.updated', version: 1 },
          { name: 'livestream.metadata.updated', version: 1 },
        ],
      },
    ]);
    const deletes = server.calls.filter((c) => c.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.url.searchParams.getAll('id')).toEqual(['s2', 's3']);
    expect(provider.health().notes.join('\n')).toContain('اشتراكات ويبهوك كيك: 2 قناة');
  });

  it('is a no-op when subscriptions already match', async () => {
    server.on('GET', SUBS, () =>
      json({
        data: [
          { id: 'a', broadcaster_user_id: 100, event: 'livestream.status.updated', version: 1, method: 'webhook' },
          { id: 'b', broadcaster_user_id: 100, event: 'livestream.metadata.updated', version: 1, method: 'webhook' },
        ],
      }),
    );
    await makeProvider({ env: webhookEnv }).webhook!.sync([channel('100', 'a')]);
    expect(server.calls.filter((c) => c.url.href.startsWith(SUBS) && c.method !== 'GET')).toHaveLength(0);
  });

  /** POST handler that hands out unique subscription ids and records what it created. */
  function creatingPosts(): string[] {
    const created: string[] = [];
    server.on('POST', SUBS, (call) => {
      const body = JSON.parse(call.body ?? '{}') as { broadcaster_user_id: number; events: Array<{ name: string; version: number }> };
      return json({
        data: body.events.map((e) => {
          const id = `sub-${body.broadcaster_user_id}-${e.name.split('.')[1]}-${created.length}`;
          created.push(id);
          return { name: e.name, version: e.version, subscription_id: id };
        }),
      });
    });
    return created;
  }
  const subCalls = () => server.calls.filter((c) => c.url.href.split('?')[0] === SUBS && c.method !== 'GET');
  const postedFor = () => subCalls().filter((c) => c.method === 'POST').map((c) => (JSON.parse(c.body ?? '{}') as { broadcaster_user_id: number }).broadcaster_user_id);
  const deletedIds = () => subCalls().filter((c) => c.method === 'DELETE').flatMap((c) => c.url.searchParams.getAll('id'));

  it('deletes the stored ids before re-creating subscriptions the listing omits (#419)', async () => {
    server.on('GET', SUBS, () => json({ data: [] }));
    server.on('DELETE', SUBS, () => new Response(null, { status: 204 }));
    const created = creatingPosts();
    const provider = makeProvider({ env: webhookEnv });

    await provider.webhook!.sync([channel('100', 'a')]);
    expect(created).toEqual(['sub-100-status-0', 'sub-100-metadata-1']);
    expect(kv.get('kick:subscriptions')).toMatchObject({
      subs: { '100': { ids: { 'livestream.status.updated@1': 'sub-100-status-0', 'livestream.metadata.updated@1': 'sub-100-metadata-1' } } },
    });

    // The next sync's listing still omits them: delete what we created first, then subscribe again.
    server.calls.length = 0;
    clock += 60 * 60_000;
    await provider.webhook!.sync([channel('100', 'a')]);
    const calls = subCalls();
    expect(calls.map((c) => c.method)).toEqual(['DELETE', 'POST']);
    expect(deletedIds()).toEqual(['sub-100-status-0', 'sub-100-metadata-1']);
    expect(kv.get('kick:subscriptions')).toMatchObject({
      subs: { '100': { ids: { 'livestream.status.updated@1': 'sub-100-status-2', 'livestream.metadata.updated@1': 'sub-100-metadata-3' } } },
    });

    // Once the listing shows them, nothing changes; a stored id that differs from the listed one is a hidden duplicate.
    server.calls.length = 0;
    server.on('GET', SUBS, () =>
      json({
        data: [
          { id: 'sub-100-status-2', broadcaster_user_id: 100, event: 'livestream.status.updated', version: 1, method: 'webhook' },
          { id: 'listed-meta', broadcaster_user_id: 100, event: 'livestream.metadata.updated', version: 1, method: 'webhook' },
        ],
      }),
    );
    await provider.webhook!.sync([channel('100', 'a')]);
    expect(postedFor()).toEqual([]);
    expect(deletedIds()).toEqual(['sub-100-metadata-3']);
  });

  it('deletes the stored subscriptions of a removed streamer even when the listing omits them', async () => {
    server.on('GET', SUBS, () => json({ data: [] }));
    server.on('DELETE', SUBS, () => new Response(null, { status: 404 }));
    creatingPosts();
    const provider = makeProvider({ env: webhookEnv });
    await provider.webhook!.sync([channel('100', 'a'), channel('200', 'b')]);

    server.calls.length = 0;
    await provider.webhook!.sync([channel('200', 'b')]);

    expect(deletedIds()).toEqual(expect.arrayContaining(['sub-100-status-0', 'sub-100-metadata-1']));
    expect(deletedIds()).not.toContain('sub-200-status-2');
    // A 404 means it is already gone: forgotten, not retried.
    expect(kv.get<{ subs: Record<string, unknown>; orphans: string[] }>('kick:subscriptions')?.subs['100']).toBeUndefined();
    expect(kv.get<{ orphans: string[] }>('kick:subscriptions')?.orphans).toEqual([]);
  });

  it('caps re-creations per sync, rotates through the rest and respects the cooldown', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => String(1000 + i));
    kv.set('kick:subscriptions', {
      subs: Object.fromEntries(ids.map((id) => [id, { ids: { 'livestream.status.updated@1': `old-${id}-s`, 'livestream.metadata.updated@1': `old-${id}-m` } }])),
      orphans: [],
    });
    server.on('GET', SUBS, () => json({ data: [] }));
    server.on('DELETE', SUBS, () => new Response(null, { status: 204 }));
    creatingPosts();
    const provider = makeProvider({ env: webhookEnv });
    const channels = ids.map((id) => channel(id, `c${id}`));

    await provider.webhook!.sync(channels);
    expect(postedFor()).toHaveLength(10);
    expect(deletedIds()).toHaveLength(20);
    const first = new Set(postedFor());

    server.calls.length = 0;
    clock += 60_000;
    await provider.webhook!.sync(channels);
    expect(postedFor()).toHaveLength(2);
    expect(postedFor().some((id) => first.has(id))).toBe(false);

    // Everything was re-created within the cooldown: no churn until it passes.
    server.calls.length = 0;
    clock += 60_000;
    await provider.webhook!.sync(channels);
    expect(subCalls()).toHaveLength(0);
  });

  it('does not re-subscribe while the stored subscription could not be deleted, and retries failed deletes', async () => {
    kv.set('kick:subscriptions', { subs: { '100': { ids: { 'livestream.status.updated@1': 'old-s', 'livestream.metadata.updated@1': 'old-m' } } }, orphans: [] });
    server.on('GET', SUBS, () =>
      json({ data: [{ id: 'gone-streamer', broadcaster_user_id: 999, event: 'livestream.status.updated', version: 1, method: 'webhook' }] }),
    );
    server.on('DELETE', SUBS, () => new Response('bad request', { status: 400 }));
    creatingPosts();
    const provider = makeProvider({ env: webhookEnv });

    await provider.webhook!.sync([channel('100', 'a')]);
    expect(postedFor()).toEqual([]);
    const stored = kv.get<{ subs: Record<string, { ids: Record<string, string> }>; orphans: string[] }>('kick:subscriptions');
    expect(stored?.subs['100']?.ids).toEqual({ 'livestream.status.updated@1': 'old-s', 'livestream.metadata.updated@1': 'old-m' });
    expect(stored?.orphans).toEqual(['gone-streamer']);

    // Kick recovers and the listing no longer shows the orphan: it is still deleted.
    server.calls.length = 0;
    server.on('GET', SUBS, () => json({ data: [] }));
    server.on('DELETE', SUBS, () => new Response(null, { status: 204 }));
    await provider.webhook!.sync([channel('100', 'a')]);
    expect(deletedIds()).toEqual(['old-s', 'old-m', 'gone-streamer']);
    expect(postedFor()).toEqual([100]);
  });

  it('records per-event errors and never throws when Kick is unreachable', async () => {
    server.on('GET', SUBS, () => json({ data: [] }));
    server.on('POST', SUBS, () => json({ data: [{ name: 'livestream.status.updated', version: 1, error: 'webhooks are disabled for this app' }] }));
    const provider = makeProvider({ env: webhookEnv });
    await provider.webhook!.sync([channel('100', 'a')]);
    expect(provider.health().notes.join('\n')).toContain('webhooks are disabled for this app');

    server.on('GET', SUBS, () => json({ message: 'nope' }, 400));
    await expect(provider.webhook!.sync([channel('100', 'a')])).resolves.toBeUndefined();
    expect(provider.health().notes.join('\n')).toContain('تعذّرت مزامنة اشتراكات ويبهوك كيك');
  });
});
