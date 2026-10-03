import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/logger.js', async () => {
  const { pino } = await import('pino');
  const logger = pino({ level: 'silent' });
  return { logger, childLogger: () => logger };
});

import type { ContentItem } from '../../src/core/types.js';
import type { Channel, StoredContentItem } from '../../src/db/models.js';
import { ContentService, type ContentServiceLimits } from '../../src/services/contentService.js';
import { addStreamer, configureGuild, createEnv, type Env, MIN, resolved } from './helpers.js';

const USER = '100000000000000001';

describe('ContentService', () => {
  let env: Env;
  let svc: ContentService;
  let yt: Channel;
  let streamerId: number;
  let seq = 0;

  const make = (limits: Partial<ContentServiceLimits> = {}) =>
    new ContentService({ repos: env.repos, audit: env.audit, events: env.events, notifier: env.notifier, clock: env.clock.fn, limits });

  beforeEach(() => {
    env = createEnv();
    configureGuild(env.repos, 'g1');
    const reg = addStreamer(env.repos, 'g1', USER, [resolved('youtube', 'UC1', 'abu_yt')]);
    yt = reg.channels[0]!;
    streamerId = reg.streamer.id;
    svc = make();
  });

  afterEach(() => svc.stop());

  const item = (overrides: Partial<ContentItem> = {}): ContentItem => ({
    platform: 'youtube',
    platformId: 'UC1',
    contentId: `vid${++seq}`,
    kind: 'video',
    title: 'New video',
    url: `https://youtube.com/watch?v=vid${seq}`,
    thumbnailUrl: null,
    publishedAt: env.clock.iso(-10 * MIN),
    durationSec: 600,
    viewCount: 10,
    relatedStreamId: null,
    ...overrides,
  });

  const store = (channel: Channel, it: ContentItem): StoredContentItem => env.repos.content.insert(channel.id, it, false).item;

  const announce = async (it: ContentItem, channel = yt) => {
    const stored = store(channel, it);
    await svc.onNewContent(channel, it, stored);
    return stored;
  };

  it('posts new content once, records the notification and emits an event', async () => {
    const it1 = item();
    const stored = await announce(it1);

    expect(env.notifier.contents).toHaveLength(1);
    const view = env.notifier.contents[0]!.view;
    expect(view.streamer.id).toBe(streamerId);
    expect(view.channel.handle).toBe('abu_yt');
    expect(view.item.contentId).toBe(it1.contentId);
    expect(env.repos.content.wasNotified(stored.id, 'g1')).toBe(true);
    expect(env.repos.content.recentForGuild('g1')[0]!.announced).toBe(true);
    expect(env.emitted).toContainEqual({
      name: 'content.announced',
      payload: { guildId: 'g1', streamerId, platform: 'youtube', title: 'New video', url: it1.url },
    });
    expect(env.repos.audit.list({ guildId: 'g1', actionPrefix: 'content.new' })).toHaveLength(1);

    await svc.onNewContent(yt, it1, stored);
    expect(env.notifier.contents).toHaveLength(1);
  });

  it('filters by kind: guild default, overridden per account', async () => {
    env.repos.settings.update('g1', { contentKinds: ['video', 'vod'] });
    await announce(item({ kind: 'short' }));
    expect(env.notifier.contents).toHaveLength(0);

    const account = env.repos.accounts.getByPair(streamerId, yt.id)!;
    env.repos.accounts.update(account.id, { contentKinds: ['short'] });
    await announce(item({ kind: 'short' }));
    await announce(item({ kind: 'video' }));
    expect(env.notifier.contents.map((c) => c.view.item.kind)).toEqual(['short']);
  });

  it('ignores content older than contentMaxAgeHours', async () => {
    await announce(item({ publishedAt: env.clock.iso(-49 * 3_600_000) }));
    expect(env.notifier.contents).toHaveLength(0);
    env.repos.settings.update('g1', { options: { contentMaxAgeHours: 0 } }); // 0 = no age limit
    await announce(item({ publishedAt: env.clock.iso(-49 * 3_600_000) }));
    expect(env.notifier.contents).toHaveLength(1);
  });

  it('respects notifyContent and the guild platform switch', async () => {
    const account = env.repos.accounts.getByPair(streamerId, yt.id)!;
    env.repos.accounts.update(account.id, { notifyContent: false });
    await announce(item());
    env.repos.accounts.update(account.id, { notifyContent: true });
    env.repos.settings.update('g1', { platformsEnabled: ['twitch'] });
    await announce(item());
    expect(env.notifier.contents).toHaveLength(0);
  });

  describe('VOD of an announced live stream', () => {
    const announcedSession = (streamId: string, startedAt: string, endedAt: string | null) => {
      const session = env.repos.sessions.create({ guildId: 'g1', streamerId, startedAt });
      env.repos.sessions.save({ ...session, messageChannelId: 'live-g1', messageId: 'm1', status: endedAt ? 'ended' : 'live', endedAt });
      const seg = env.repos.sessions.addSegment({ sessionId: session.id, channelId: yt.id, platform: 'youtube', streamId, startedAt, viewers: 5 });
      if (endedAt) env.repos.sessions.saveSegment({ ...seg, endedAt });
    };

    it('skips a VOD whose stream id matches an announced live segment', async () => {
      announcedSession('live1', env.clock.iso(-3 * 3_600_000), env.clock.iso(-3_600_000));
      await announce(item({ kind: 'vod', contentId: 'live1', relatedStreamId: 'live1', publishedAt: env.clock.iso(-30 * MIN) }));
      expect(env.notifier.contents).toHaveLength(0);
    });

    it('falls back to time overlap when the VOD has no stream id', async () => {
      announcedSession('live1', env.clock.iso(-3 * 3_600_000), env.clock.iso(-3_600_000));
      await announce(item({ kind: 'vod', relatedStreamId: null, publishedAt: env.clock.iso(-3 * 3_600_000 + 60_000) }));
      expect(env.notifier.contents).toHaveLength(0);
      // A recording from a different time is still announced.
      await announce(item({ kind: 'vod', relatedStreamId: null, publishedAt: env.clock.iso(-30 * MIN) }));
      expect(env.notifier.contents).toHaveLength(1);
    });

    it('announces such VODs when skipVodOfAnnouncedLive is off, and never skips other kinds', async () => {
      announcedSession('live1', env.clock.iso(-3 * 3_600_000), env.clock.iso(-3_600_000));
      await announce(item({ kind: 'clip', relatedStreamId: 'live1', publishedAt: env.clock.iso(-2 * 3_600_000) }));
      env.repos.settings.update('g1', { options: { skipVodOfAnnouncedLive: false } });
      await announce(item({ kind: 'vod', relatedStreamId: 'live1' }));
      expect(env.notifier.contents.map((c) => c.view.item.kind)).toEqual(['clip', 'vod']);
    });

    it('does not skip the VOD of a stream that was never announced', async () => {
      const session = env.repos.sessions.create({ guildId: 'g1', streamerId, startedAt: env.clock.iso(-3 * 3_600_000) });
      env.repos.sessions.addSegment({ sessionId: session.id, channelId: yt.id, platform: 'youtube', streamId: 'quiet', startedAt: session.startedAt, viewers: 1 });
      await announce(item({ kind: 'vod', relatedStreamId: 'quiet' }));
      expect(env.notifier.contents).toHaveLength(1);
    });
  });

  it('notifies once per guild, even when several streamers share the channel', async () => {
    addStreamer(env.repos, 'g1', '100000000000000002', [yt]);
    configureGuild(env.repos, 'g2');
    addStreamer(env.repos, 'g2', '100000000000000003', [yt]);
    const stored = await announce(item());

    expect(env.notifier.contents.map((c) => c.view.guildId).sort()).toEqual(['g1', 'g2']);
    expect(env.notifier.contents.find((c) => c.view.guildId === 'g1')!.view.streamer.id).toBe(streamerId);
    expect(env.repos.content.wasNotified(stored.id, 'g1')).toBe(true);
    expect(env.repos.content.wasNotified(stored.id, 'g2')).toBe(true);
  });

  it('uses the next eligible streamer in a guild when the first one filters the item out', async () => {
    const account = env.repos.accounts.getByPair(streamerId, yt.id)!;
    env.repos.accounts.update(account.id, { notifyContent: false });
    const second = addStreamer(env.repos, 'g1', '100000000000000002', [yt]);
    await announce(item());
    expect(env.notifier.contents).toHaveLength(1);
    expect(env.notifier.contents[0]!.view.streamer.id).toBe(second.streamer.id);
  });

  it('retries a failed post and gives up with an audit warning', async () => {
    svc = make({ retryDelaysMs: [5] });
    env.notifier.failContent = 1;
    const stored = await announce(item());
    expect(env.repos.content.wasNotified(stored.id, 'g1')).toBe(false);
    await vi.waitFor(() => expect(env.repos.content.wasNotified(stored.id, 'g1')).toBe(true), { timeout: 2_000 });
    expect(env.notifier.contents.filter((c) => c.ref)).toHaveLength(1);

    env.notifier.failContent = 2;
    const failed = await announce(item());
    await vi.waitFor(() => expect(env.repos.audit.list({ guildId: 'g1', actionPrefix: 'content.failed' })).toHaveLength(1), { timeout: 2_000 });
    expect(env.repos.content.wasNotified(failed.id, 'g1')).toBe(false);
  });

  it('does not retry when no content channel is configured', async () => {
    svc = make({ retryDelaysMs: [5] });
    env.repos.settings.update('g1', { contentChannelId: null });
    await announce(item());
    await new Promise((r) => setTimeout(r, 30));
    expect(env.repos.audit.list({ guildId: 'g1', actionPrefix: 'content.failed' })).toHaveLength(0);
  });

  it('limits bursts per channel and warns once', async () => {
    svc = make({ burstMax: 2, burstWindowMs: 10 * MIN });
    for (let i = 0; i < 4; i++) await announce(item());
    expect(env.notifier.contents).toHaveLength(2);
    expect(env.repos.audit.list({ guildId: 'g1', actionPrefix: 'content.throttled' })).toHaveLength(1);

    env.clock.advance(11 * MIN);
    await announce(item({ publishedAt: env.clock.iso(-MIN) }));
    expect(env.notifier.contents).toHaveLength(3);
  });

  it('never throws, even when the notifier does', async () => {
    env.notifier.throwOnContent = true;
    svc = make({ retryDelaysMs: [] });
    await expect(announce(item())).resolves.toBeDefined();
    expect(env.repos.audit.list({ guildId: 'g1', actionPrefix: 'content.failed' })).toHaveLength(1);
  });

  it('skips items with an unknown kind', async () => {
    await announce(item({ kind: 'podcast' as ContentItem['kind'] }));
    expect(env.notifier.contents).toHaveLength(0);
  });
});
