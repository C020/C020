import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/logger.js', async () => {
  const { pino } = await import('pino');
  const logger = pino({ level: 'silent' });
  return { logger, childLogger: () => logger };
});

import { ValidationError } from '../../src/core/errors.js';
import { ManualPostService, parseContentUrl } from '../../src/services/manualPostService.js';
import { addStreamer, configureGuild, createEnv, type Env, resolved } from './helpers.js';

const GUILD = 'g1';

describe('parseContentUrl (#14)', () => {
  it.each([
    ['https://kick.com/abu/clips/clip_01ABC', { platform: 'kick', kind: 'clip', contentId: 'clip_01ABC', handle: 'abu' }],
    ['https://kick.com/Abu?clip=clip_9', { platform: 'kick', kind: 'clip', contentId: 'clip_9', handle: 'abu' }],
    ['kick.com/abu/videos/1234-abcd', { platform: 'kick', kind: 'vod', contentId: '1234-abcd', handle: 'abu' }],
    ['https://clips.twitch.tv/FunnySlug-abc', { platform: 'twitch', kind: 'clip', contentId: 'FunnySlug-abc', handle: null }],
    ['https://www.twitch.tv/abu/clip/FunnySlug', { platform: 'twitch', kind: 'clip', contentId: 'FunnySlug', handle: 'abu' }],
    ['https://m.twitch.tv/videos/987654', { platform: 'twitch', kind: 'vod', contentId: '987654', handle: null }],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1', { platform: 'youtube', kind: 'video', contentId: 'dQw4w9WgXcQ' }],
    ['https://youtu.be/dQw4w9WgXcQ', { platform: 'youtube', kind: 'video', contentId: 'dQw4w9WgXcQ' }],
    ['https://youtube.com/shorts/dQw4w9WgXcQ', { platform: 'youtube', kind: 'short', contentId: 'dQw4w9WgXcQ' }],
    ['https://www.tiktok.com/@abu.k/video/7234567890123456789', { platform: 'tiktok', kind: 'video', contentId: '7234567890123456789', handle: 'abu.k' }],
  ])('%s', (url, expected) => {
    expect(parseContentUrl(url)).toMatchObject(expected);
  });

  it.each(['https://example.com/x', 'https://www.twitch.tv/abu', 'https://youtube.com/watch?v=short', 'javascript:alert(1)', 'not a url', 'https://www.tiktok.com/@abu'])(
    'rejects %s',
    (url) => expect(parseContentUrl(url)).toBeNull(),
  );
});

describe('ManualPostService (#14)', () => {
  let env: Env;
  let fetchMock: ReturnType<typeof vi.fn>;
  let svc: ManualPostService;
  let streamerId: number;

  beforeEach(() => {
    env = createEnv();
    configureGuild(env.repos, GUILD, { features: { manualPosts: { enabled: true } } });
    const reg = addStreamer(env.repos, GUILD, '100000000000000001', [resolved('kick', 'k1', 'abu'), resolved('youtube', 'UC1', '@abuyt')]);
    streamerId = reg.streamer.id;
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ title: 'Big moment', author_name: 'Abu YT', author_url: 'https://www.youtube.com/@AbuYT', thumbnail_url: 'https://i.ytimg.com/x.jpg' }), { status: 200 }));
    svc = new ManualPostService({ repos: env.repos, audit: env.audit, events: env.events, notifier: env.notifier, fetch: fetchMock as unknown as typeof fetch, clock: env.clock.fn });
  });

  it('requires the feature', async () => {
    env.repos.settings.update(GUILD, { features: { manualPosts: { enabled: false }, language: 'en' } });
    await expect(svc.inspect(GUILD, 'https://kick.com/abu/clips/c1')).rejects.toThrow(/not enabled/);
  });

  it('inspects a Kick clip: matches the streamer by slug, no oEmbed, routing applied', async () => {
    env.repos.settings.update(GUILD, { features: { routing: { contentByKind: { clip: 'clips-room' } } } });
    const p = await svc.inspect(GUILD, 'https://kick.com/abu/clips/c1');
    expect(p).toMatchObject({ platform: 'kick', kind: 'clip', contentId: 'c1', streamer: { id: streamerId }, channelId: 'clips-room', alreadyPosted: false, title: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('enriches YouTube via oEmbed and matches by author handle', async () => {
    const p = await svc.inspect(GUILD, 'https://youtu.be/dQw4w9WgXcQ');
    expect(fetchMock.mock.calls[0]![0]).toContain('https://www.youtube.com/oembed?url=');
    expect(p).toMatchObject({ title: 'Big moment', thumbnailUrl: 'https://i.ytimg.com/x.jpg', streamer: { id: streamerId } });
  });

  it('oEmbed failures are ignored', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network'));
    const p = await svc.inspect(GUILD, 'https://youtu.be/dQw4w9WgXcQ');
    expect(p.title).toBeNull();
    expect(p.streamer).toBeNull();
  });

  it('posts once, records the notification, audits; second post is refused', async () => {
    const res = await svc.post(GUILD, { url: 'https://kick.com/abu/clips/c1', title: 'Epic' }, 'user:1');
    expect(res.messageRef).not.toBeNull();
    expect(res.contentItemId).toBeGreaterThan(0);
    expect(env.notifier.contents).toHaveLength(1);
    expect(env.notifier.contents[0]!.view.item.title).toBe('Epic');
    expect(env.repos.content.wasNotified(res.contentItemId, GUILD)).toBe(true);
    expect(env.repos.audit.list({ guildId: GUILD, actionPrefix: 'content.manual' })).toHaveLength(1);
    expect((await svc.inspect(GUILD, 'https://kick.com/abu?clip=c1')).alreadyPosted).toBe(true);
    await expect(svc.post(GUILD, { url: 'https://kick.com/abu/clips/c1' }, 'user:1')).rejects.toThrow(/منشور/);
  });

  it('posts unmatched links with a synthetic channel and dedupes via kv', async () => {
    const res = await svc.post(GUILD, { url: 'https://clips.twitch.tv/Slug1' }, 'user:1');
    expect(res.contentItemId).toBe(0);
    expect(env.notifier.contents[0]!.view.channel).toMatchObject({ id: 0, platform: 'twitch' });
    expect(env.notifier.contents[0]!.view.item.title).toBe('كليب جديد');
    await expect(svc.post(GUILD, { url: 'https://clips.twitch.tv/Slug1' }, 'user:1')).rejects.toThrow(ValidationError);
  });

  it('uses the given streamer and validates kind/streamer/channel', async () => {
    const res = await svc.post(GUILD, { url: 'https://kick.com/someone/videos/v9', streamerId }, 'user:1');
    expect(env.notifier.contents[0]!.view.streamer.id).toBe(streamerId);
    expect(res.contentItemId).toBeGreaterThan(0);
    await expect(svc.post(GUILD, { url: 'https://kick.com/abu/clips/c2', streamerId: 999 }, 'user:1')).rejects.toMatchObject({ field: 'streamerId' });
    await expect(svc.post(GUILD, { url: 'https://kick.com/abu/clips/c2', kind: 'bogus' as never }, 'user:1')).rejects.toMatchObject({ field: 'kind' });
    env.repos.settings.update(GUILD, { contentChannelId: null });
    await expect(svc.post(GUILD, { url: 'https://kick.com/abu/clips/c2' }, 'user:1')).rejects.toMatchObject({ field: 'channel' });
  });

  it('reports a failed post', async () => {
    env.notifier.failContent = 1;
    await expect(svc.post(GUILD, { url: 'https://kick.com/abu/clips/c3' }, 'user:1')).rejects.toThrow(/صلاحيات/);
    // Not marked: can be retried.
    await expect(svc.post(GUILD, { url: 'https://kick.com/abu/clips/c3' }, 'user:1')).resolves.toMatchObject({ messageRef: expect.anything() });
  });

  it('rejects unsupported URLs', async () => {
    await expect(svc.inspect(GUILD, 'https://example.com/v')).rejects.toThrow(/غير مدعوم/);
    await expect(svc.inspect(GUILD, '')).rejects.toThrow(ValidationError);
  });
});
