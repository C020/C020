import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/logger.js', async () => {
  const { pino } = await import('pino');
  const logger = pino({ level: 'silent' });
  return { logger, childLogger: () => logger };
});

import type { ContentItem } from '../../src/core/types.js';
import type { Channel, GuildFeaturesPatch, StoredContentItem } from '../../src/db/models.js';
import { clipHoldReason, ContentService, digestLastKey, localDateHour } from '../../src/services/contentService.js';
import { addStreamer, configureGuild, createEnv, type Env, MIN, resolved } from './helpers.js';

const USER = '100000000000000001';

describe('ContentService — #4 routing and #6 clips', () => {
  let env: Env;
  let svc: ContentService;
  let tw: Channel;
  let seq = 0;

  const make = () =>
    new ContentService({ repos: env.repos, audit: env.audit, events: env.events, notifier: env.notifier, clock: env.clock.fn, limits: { burstMax: 0, retryDelaysMs: [] } });
  const features = (patch: GuildFeaturesPatch) => env.repos.settings.update('g1', { features: patch });

  beforeEach(() => {
    env = createEnv();
    configureGuild(env.repos, 'g1');
    tw = addStreamer(env.repos, 'g1', USER, [resolved('twitch', 'T1', 'abu')]).channels[0]!;
    svc = make();
  });
  afterEach(() => svc.stop());

  const clip = (o: Partial<ContentItem> = {}): ContentItem => ({
    platform: 'twitch',
    platformId: 'T1',
    contentId: `clip${++seq}`,
    kind: 'clip',
    title: `Clip ${seq}`,
    url: `https://clips.twitch.tv/clip${seq}`,
    thumbnailUrl: null,
    publishedAt: env.clock.iso(-5 * MIN),
    durationSec: 30,
    viewCount: 10,
    featured: null,
    ...o,
  });
  const store = (it: ContentItem): StoredContentItem => env.repos.content.insert(tw.id, it, false).item;
  const announce = async (it: ContentItem) => {
    const stored = store(it);
    await svc.onNewContent(tw, it, stored);
    return stored;
  };

  it('clipHoldReason applies minViews and featuredOnly only to clips', () => {
    const s = env.repos.settings.get('g1');
    s.features.clips.minViews = 20;
    expect(clipHoldReason(s, { kind: 'clip', viewCount: 5 })).toBe('below-min-views');
    expect(clipHoldReason(s, { kind: 'clip', viewCount: null })).toBeNull();
    expect(clipHoldReason(s, { kind: 'video', viewCount: 1 })).toBeNull();
    s.features.clips.featuredOnly = true;
    expect(clipHoldReason(s, { kind: 'clip', viewCount: 50, featured: false })).toBe('not-featured');
    expect(clipHoldReason(s, { kind: 'clip', viewCount: 50, featured: null })).toBeNull();
    expect(clipHoldReason(s, { kind: 'clip', viewCount: 50, featured: true })).toBeNull();
  });

  it('holds a clip below minViews and posts it once it passes on a later update', async () => {
    features({ clips: { minViews: 50 } });
    const it = clip({ viewCount: 10 });
    const stored = await announce(it);
    expect(env.notifier.contents).toHaveLength(0);

    await svc.onContentUpdate(tw, { ...it, viewCount: 20 }, stored);
    expect(env.notifier.contents).toHaveLength(0);

    await svc.onContentUpdate(tw, { ...it, viewCount: 60 }, stored);
    expect(env.notifier.contents).toHaveLength(1);
    expect(env.repos.content.wasNotified(stored.id, 'g1')).toBe(true);

    await svc.onContentUpdate(tw, { ...it, viewCount: 100 }, stored);
    expect(env.notifier.contents).toHaveLength(1);
  });

  it('never announces baseline clips through onContentUpdate', async () => {
    features({ clips: { minViews: 5 } });
    const it = clip({ viewCount: 100 });
    const stored = store(it); // stored silently (baseline), never offered via onNewContent
    await svc.onContentUpdate(tw, it, stored);
    expect(env.notifier.contents).toHaveLength(0);
  });

  it('featuredOnly holds non-featured Twitch clips until they become featured', async () => {
    features({ clips: { featuredOnly: true } });
    const it = clip({ featured: false });
    const stored = await announce(it);
    expect(env.notifier.contents).toHaveLength(0);
    await svc.onContentUpdate(tw, { ...it, featured: true }, stored);
    expect(env.notifier.contents).toHaveLength(1);
  });

  it('stops re-evaluating a held clip after 24h', async () => {
    features({ clips: { minViews: 50 } });
    const it = clip({ viewCount: 1 });
    const stored = await announce(it);
    const old = { ...stored, firstSeenAt: new Date(env.clock.now - 25 * 60 * MIN).toISOString() };
    await svc.onContentUpdate(tw, { ...it, viewCount: 500 }, old);
    expect(env.notifier.contents).toHaveLength(0);
    expect(env.repos.kv.get(`content:held:${stored.id}`)).toBeUndefined();
  });

  it('#4: skips quietly when no channel resolves; uses kind/platform routes otherwise', async () => {
    env.repos.settings.update('g1', { contentChannelId: null });
    await announce(clip());
    expect(env.notifier.contents).toHaveLength(0);
    expect(env.repos.audit.list({ guildId: 'g1', actionPrefix: 'content.failed' })).toHaveLength(0);

    features({ routing: { contentByKind: { clip: 'clips-room' } } });
    const failing = vi.spyOn(env.notifier, 'postContent').mockResolvedValueOnce({ channelId: 'clips-room', messageId: 'm1' });
    const stored = await announce(clip());
    expect(failing).toHaveBeenCalledTimes(1);
    expect(env.repos.content.wasNotified(stored.id, 'g1')).toBe(true);
  });

  it('#4: a failed post with a routed channel is audited', async () => {
    env.repos.settings.update('g1', { contentChannelId: null, features: { routing: { contentByPlatform: { twitch: 'tw-room' } } } });
    await announce(clip());
    expect(env.repos.audit.list({ guildId: 'g1', actionPrefix: 'content.failed' })).toHaveLength(1);
  });

  describe('digest mode', () => {
    beforeEach(() => features({ clips: { mode: 'digest', digestHour: 21, digestMax: 2 }, timezone: 'Asia/Riyadh' }));

    it('queues clips instead of posting (no double queue) and posts the top ones at the digest hour', async () => {
      // T0 = 12:00Z = 15:00 Riyadh
      const a = await announce(clip({ viewCount: 5 }));
      const b = await announce(clip({ viewCount: 50 }));
      const c = await announce(clip({ viewCount: 20 }));
      await svc.onNewContent(tw, clip({ contentId: 'x' }), a); // same stored row → no double queue
      expect(env.notifier.contents).toHaveLength(0);
      expect(env.repos.digest.pending('g1')).toHaveLength(3);

      await svc.runDigestTick();
      expect(env.notifier.digests).toHaveLength(0);

      env.clock.advance(6 * 60 * MIN); // 21:00 Riyadh
      await svc.runDigestTick();
      expect(env.notifier.digests).toHaveLength(1);
      const view = env.notifier.digests[0]!.view;
      expect(view.entries.map((e) => e.item.id)).toEqual([b.id, c.id]);
      expect(view.entries[0]!.item.viewCount).toBe(50);
      expect(view.total).toBe(3);
      expect(view.date).toBe('2026-10-03');
      expect(env.repos.digest.pending('g1')).toHaveLength(0);
      expect(env.repos.content.wasNotified(b.id, 'g1')).toBe(true);
      expect(env.repos.content.wasNotified(a.id, 'g1')).toBe(false);
      expect(env.repos.kv.get(digestLastKey('g1'))).toBe('2026-10-03');

      // Once per local day.
      await announce(clip());
      env.clock.advance(30 * MIN);
      await svc.runDigestTick();
      expect(env.notifier.digests).toHaveLength(1);
      // Next local day at/after the hour.
      env.clock.advance(24 * 60 * MIN);
      await svc.runDigestTick();
      expect(env.notifier.digests).toHaveLength(2);
    });

    it('postDigestNow posts immediately; empty queue posts nothing', async () => {
      expect(await svc.postDigestNow('g1', 'user:1')).toBeNull();
      await announce(clip());
      const ref = await svc.postDigestNow('g1', 'user:1');
      expect(ref).not.toBeNull();
      expect(env.repos.audit.list({ guildId: 'g1', actionPrefix: 'content.digest' })).toHaveLength(1);
    });

    it('retries a failed digest later and audits the failure', async () => {
      await announce(clip());
      env.clock.advance(6 * 60 * MIN);
      env.notifier.failDigest = 1;
      await svc.runDigestTick();
      expect(env.repos.audit.list({ guildId: 'g1', actionPrefix: 'content.digest.failed' })).toHaveLength(1);
      await svc.runDigestTick(); // backoff
      expect(env.notifier.digests).toHaveLength(1);
      env.clock.advance(31 * MIN);
      await svc.runDigestTick();
      expect(env.notifier.digests.filter((d) => d.ref)).toHaveLength(1);
    });

    it('held clips that later pass are queued', async () => {
      features({ clips: { minViews: 30 } });
      const it = clip({ viewCount: 1 });
      const stored = await announce(it);
      expect(env.repos.digest.pending('g1')).toHaveLength(0);
      await svc.onContentUpdate(tw, { ...it, viewCount: 40 }, stored);
      expect(env.repos.digest.pending('g1')).toHaveLength(1);
    });

    it('start/stop schedule the tick', async () => {
      vi.useFakeTimers();
      try {
        const s = new ContentService({ repos: env.repos, audit: env.audit, events: env.events, notifier: env.notifier, clock: env.clock.fn, limits: { digestCheckMs: 1000 } });
        const tick = vi.spyOn(s, 'runDigestTick').mockResolvedValue();
        s.start();
        s.start();
        vi.advanceTimersByTime(2500);
        expect(tick).toHaveBeenCalledTimes(2);
        s.stop();
        vi.advanceTimersByTime(5000);
        expect(tick).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('localDateHour handles timezones and bad zones', () => {
    const t = Date.parse('2026-10-03T22:30:00Z');
    expect(localDateHour(t, 'Asia/Riyadh')).toEqual({ date: '2026-10-04', hour: 1 });
    expect(localDateHour(t, 'Not/AZone')).toEqual({ date: '2026-10-03', hour: 22 });
  });
});
