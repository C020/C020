import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelRef } from '../../src/core/types.js';
import type { WebhookAdapter } from '../../src/platforms/types.js';
import { createHarness, FakeProvider, item, T0 } from './helpers.js';

function fakeAdapter(): WebhookAdapter & { syncs: string[][] } {
  const syncs: string[][] = [];
  return {
    path: '/webhooks/fake',
    syncs,
    handle: async () => ({ status: 204, hints: [] }),
    sync: async (channels: ChannelRef[]) => {
      syncs.push(channels.map((c) => c.platformId));
    },
  };
}

const advance = (ms: number): Promise<void> => vi.advanceTimersByTimeAsync(ms).then(() => undefined);

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Monitor push hints', () => {
  it('debounces hints per channel and retries while the API still says offline', async () => {
    const h = createHarness();
    const tw = h.provider('twitch');
    h.track('twitch', '100');
    const hint = { type: 'live' as const, platform: 'twitch' as const, platformId: '100' };

    h.monitor.handleHints([hint]);
    await advance(1_000);
    h.monitor.handleHints([hint]);
    await advance(1_999);
    expect(tw.liveCalls).toHaveLength(0);
    await advance(1 + 250);
    expect(tw.liveCalls).toHaveLength(1);

    await advance(20_000);
    expect(tw.liveCalls).toHaveLength(2);

    tw.setLive('100');
    await advance(40_000);
    await h.monitor.whenIdle();
    expect(tw.liveCalls).toHaveLength(3);
    expect(h.live.types()).toEqual(['live']);

    await advance(10 * 60_000);
    expect(tw.liveCalls).toHaveLength(3);
  });

  it('stops retrying once the channel is live', async () => {
    const h = createHarness();
    const tw = h.provider('twitch');
    h.track('twitch', '100');
    h.monitor.handleHints([{ type: 'live', platform: 'twitch', platformId: '100' }]);
    await advance(2_250);
    expect(tw.liveCalls).toHaveLength(1);
    tw.setLive('100');
    await advance(20_000);
    expect(tw.liveCalls).toHaveLength(2);
    await advance(60_000);
    await h.monitor.whenIdle();
    expect(tw.liveCalls).toHaveLength(2);
    expect(h.live.types()).toEqual(['live']);
  });

  it('ends a session promptly after an offline hint', async () => {
    const h = createHarness();
    const tw = h.provider('twitch');
    const ch = h.track('twitch', '100');
    tw.setLive('100');
    await h.monitor.runLiveCycle('twitch');

    tw.setOffline('100');
    h.monitor.handleHints([{ type: 'offline', platform: 'twitch', platformId: '100' }]);
    await advance(2_250);
    expect(tw.liveCalls).toHaveLength(2);
    expect(h.channel(ch.id)).toMatchObject({ isLive: true, missCount: 1 });

    await advance(150_000 + 3_000 + 500);
    await h.monitor.whenIdle();
    expect(h.live.types()).toEqual(['live', 'offline']);
    expect(h.live.calls[1]?.endedAt).toBe(new Date(T0.getTime() + 2_250).toISOString());
  });

  it('runs a metadata hint as a single live check', async () => {
    const h = createHarness();
    h.track('twitch', '100');
    h.provider('twitch').setLive('100');
    h.monitor.handleHints([{ type: 'metadata', platform: 'twitch', platformId: '100' }]);
    await advance(2_250);
    await advance(5 * 60_000);
    expect(h.provider('twitch').liveCalls).toHaveLength(1);
  });

  it('batches hints for several channels of a platform into one request', async () => {
    const h = createHarness();
    for (const id of ['1', '2', '3']) h.track('twitch', id);
    h.monitor.handleHints(['1', '2', '3'].map((platformId) => ({ type: 'metadata' as const, platform: 'twitch' as const, platformId })));
    await advance(2_250);
    expect(h.provider('twitch').liveCalls).toEqual([['1', '2', '3']]);
  });

  it('turns a content hint into a content check (plus a live check on YouTube)', async () => {
    const tw = new FakeProvider('twitch');
    const yt = new FakeProvider('youtube', { liveBatchSize: 50 });
    const h = createHarness({ providers: [tw, yt] });
    h.track('twitch', 'tw1');
    h.track('youtube', 'UC1');
    h.monitor.handleHints([
      { type: 'content', platform: 'twitch', platformId: 'tw1' },
      { type: 'content', platform: 'youtube', platformId: 'UC1' },
    ]);
    await advance(2_250);
    await h.monitor.whenIdle();
    expect(tw.contentCalls).toHaveLength(1);
    expect(tw.liveCalls).toHaveLength(0);
    expect(yt.contentCalls).toHaveLength(1);
    expect(yt.liveCalls).toEqual([['UC1']]);
  });

  it('re-checks content for a pushed video id the API does not show yet', async () => {
    const yt = new FakeProvider('youtube', { liveBatchSize: 50 });
    const h = createHarness({ providers: [yt] });
    const ch = h.track('youtube', 'UC1');
    await h.monitor.checkContent(ch.id); // seed
    yt.contentCalls.length = 0;

    h.monitor.handleHints([{ type: 'content', platform: 'youtube', platformId: 'UC1', contentId: 'vid9' }]);
    await advance(2_250);
    await h.monitor.whenIdle();
    expect(yt.contentCalls).toHaveLength(1);

    yt.content.set('UC1', [item('vid9', { platform: 'youtube' })]);
    await advance(90_000);
    await h.monitor.whenIdle();
    expect(yt.contentCalls).toHaveLength(2);
    expect(h.content.ids()).toEqual(['vid9']);

    await advance(10 * 60_000);
    expect(yt.contentCalls).toHaveLength(2);
  });

  it('ignores hints for channels nobody tracks', async () => {
    const h = createHarness();
    h.monitor.handleHints([{ type: 'live', platform: 'twitch', platformId: 'unknown' }]);
    await advance(120_000);
    expect(h.provider('twitch').liveCalls).toEqual([]);
  });
});

describe('Monitor channel changes and webhooks', () => {
  it('checks newly tracked channels and syncs webhook subscriptions (debounced)', async () => {
    const h = createHarness();
    const tw = h.provider('twitch');
    const adapter = fakeAdapter();
    tw.webhook = adapter;

    const a = h.track('twitch', 'a');
    h.monitor.channelsChanged();
    h.monitor.channelsChanged();
    await advance(3_000 + 250);
    await h.monitor.whenIdle();
    expect(tw.liveCalls).toEqual([['a']]);
    expect(tw.contentCalls.map((c) => c.platformId)).toEqual(['a']);
    expect(h.channel(a.id).contentSeeded).toBe(true);
    expect(adapter.syncs).toEqual([]);

    h.track('twitch', 'b');
    h.monitor.channelsChanged();
    await advance(3_000 + 250);
    await h.monitor.whenIdle();
    expect(tw.liveCalls).toEqual([['a'], ['b']]);

    await advance(20_000);
    await h.monitor.whenIdle();
    expect(adapter.syncs).toEqual([['a', 'b']]);
  });

  it('checkNow runs an immediate live and content check', async () => {
    const h = createHarness();
    const ch = h.track('twitch', 'a');
    h.provider('twitch').setLive('a');
    h.monitor.checkNow(ch.id);
    await advance(250);
    await h.monitor.whenIdle();
    expect(h.live.types()).toEqual(['live']);
    expect(h.channel(ch.id).contentSeeded).toBe(true);
  });

  it('keeps syncing other adapters when one fails', async () => {
    const tw = new FakeProvider('twitch');
    const yt = new FakeProvider('youtube');
    const h = createHarness({ providers: [tw, yt] });
    h.track('youtube', 'UC1');
    tw.webhook = { ...fakeAdapter(), sync: async () => Promise.reject(new Error('eventsub down')) };
    const ytAdapter = fakeAdapter();
    yt.webhook = ytAdapter;
    await h.monitor.syncWebhooks();
    expect(ytAdapter.syncs).toEqual([['UC1']]);
  });
});

describe('Monitor lifecycle', () => {
  it('starts staggered loops, syncs webhooks, and stops cleanly', async () => {
    const h = createHarness({
      tuning: { firstLiveDelayMs: 1_000, liveStaggerMs: 500, firstContentDelayMs: 5_000, contentStaggerMs: 1_000, firstWebhookSyncDelayMs: 2_000 },
    });
    const tw = h.provider('twitch');
    const adapter = fakeAdapter();
    tw.webhook = adapter;
    h.track('twitch', 'a');

    h.monitor.start();
    h.monitor.start(); // idempotent
    await advance(1_000);
    expect(tw.liveCalls).toHaveLength(1);
    await advance(1_000);
    expect(adapter.syncs).toHaveLength(1);
    await advance(3_000);
    expect(tw.contentCalls).toHaveLength(1);

    await advance(61_000 - 5_000);
    expect(tw.liveCalls).toHaveLength(2);

    await h.monitor.stop();
    await advance(30 * 60_000);
    expect(tw.liveCalls).toHaveLength(2);
    expect(tw.contentCalls).toHaveLength(1);

    h.monitor.handleHints([{ type: 'live', platform: 'twitch', platformId: 'a' }]);
    h.monitor.channelsChanged();
    await advance(60_000);
    expect(tw.liveCalls).toHaveLength(2);
  });

  it('backs off a failing platform', async () => {
    const h = createHarness({ tuning: { firstLiveDelayMs: 0, firstContentDelayMs: 10 * 3_600_000, firstWebhookSyncDelayMs: 10 * 3_600_000 } });
    const tw = h.provider('twitch');
    h.track('twitch', 'a');
    tw.liveFailure = () => new Error('unexpected');
    h.monitor.start();
    await advance(0);
    // 1st and 2nd failures: normal 60s interval; from the 3rd on the interval doubles (capped at 4x)
    await advance(60_000);
    await advance(60_000);
    expect(tw.liveCalls).toHaveLength(3);
    await advance(60_000);
    expect(tw.liveCalls).toHaveLength(3);
    await advance(60_000);
    expect(tw.liveCalls).toHaveLength(4);
    await h.monitor.stop();
  });

  it('runs housekeeping without throwing', () => {
    const h = createHarness();
    h.repos.audit.add({ action: 'x', message: 'old' });
    expect(() => h.monitor.runHousekeeping()).not.toThrow();
  });
});
