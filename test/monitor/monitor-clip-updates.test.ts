import { describe, expect, it } from 'vitest';
import type { ContentItem } from '../../src/core/types.js';
import type { Channel, StoredContentItem } from '../../src/db/models.js';
import { CLIP_RECHECK_WINDOW_MS, Monitor, wantsContentUpdate } from '../../src/monitor/monitor.js';
import { createHarness, item, RecordingContentHandler, TEST_TUNING } from './helpers.js';

class UpdatingHandler extends RecordingContentHandler {
  readonly updates: Array<{ contentId: string; views: number | null; storedId: number }> = [];
  failUpdates = false;
  async onContentUpdate(_channel: Channel, it: ContentItem, stored: StoredContentItem): Promise<void> {
    this.updates.push({ contentId: it.contentId, views: it.viewCount, storedId: stored.id });
    if (this.failUpdates) throw new Error('boom');
  }
}

const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();

function setup() {
  const h = createHarness();
  const handler = new UpdatingHandler();
  const monitor = new Monitor({ config: h.config, repos: h.repos, providers: h.registry, live: h.live, content: handler, audit: h.audit, events: h.events, tuning: TEST_TUNING });
  return { h, handler, monitor };
}

describe('Monitor — #6 clip re-evaluation', () => {
  it('hands young stored clips seen again to onContentUpdate (not new ones, not videos)', async () => {
    const { h, handler, monitor } = setup();
    const tw = h.provider('twitch');
    h.track('twitch', '100');
    tw.content.set('100', [item('old-clip', { kind: 'clip', viewCount: 1 })]);
    await monitor.runContentCycle('twitch'); // baseline
    expect(handler.updates).toEqual([]);

    tw.content.set('100', [
      item('c1', { kind: 'clip', viewCount: 3, publishedAt: minutesAgo(1) }),
      item('v1', { kind: 'video', publishedAt: minutesAgo(1) }),
      item('old-clip', { kind: 'clip', viewCount: 5 }),
    ]);
    await monitor.runContentCycle('twitch');
    expect(handler.ids().sort()).toEqual(['c1', 'v1']);
    // The baseline clip is re-offered (the content service decides; it ignores clips it never held).
    expect(handler.updates.map((u) => u.contentId)).toEqual(['old-clip']);

    tw.content.set('100', [item('c1', { kind: 'clip', viewCount: 50, publishedAt: minutesAgo(1) }), item('v1', { kind: 'video', publishedAt: minutesAgo(1) })]);
    await monitor.runContentCycle('twitch');
    expect(handler.updates.at(-1)).toMatchObject({ contentId: 'c1', views: 50 });
    expect(handler.updates.filter((u) => u.contentId === 'v1')).toEqual([]);
    expect(handler.ids().sort()).toEqual(['c1', 'v1']);
  });

  it('survives a throwing update handler', async () => {
    const { h, handler, monitor } = setup();
    const tw = h.provider('twitch');
    h.track('twitch', '100');
    await monitor.runContentCycle('twitch');
    tw.content.set('100', [item('c1', { kind: 'clip', publishedAt: minutesAgo(1) })]);
    await monitor.runContentCycle('twitch');
    handler.failUpdates = true;
    await monitor.runContentCycle('twitch');
    expect(handler.updates).toHaveLength(1);
  });

  it('wantsContentUpdate: clips first seen within 24h only, and only with a handler', () => {
    const now = Date.now();
    const stored = (firstSeenMs: number, kind: 'clip' | 'video' = 'clip'): StoredContentItem => ({
      id: 1, channelId: 1, contentId: 'c', kind, title: 't', url: 'u', thumbnailUrl: null, publishedAt: new Date(firstSeenMs).toISOString(),
      firstSeenAt: new Date(firstSeenMs).toISOString(), announced: false,
    });
    const clip = item('c', { kind: 'clip' });
    expect(wantsContentUpdate(clip, stored(now - 60_000), now, true)).toBe(true);
    expect(wantsContentUpdate(clip, stored(now - 60_000), now, false)).toBe(false);
    expect(wantsContentUpdate(clip, stored(now - CLIP_RECHECK_WINDOW_MS - 1), now, true)).toBe(false);
    expect(wantsContentUpdate(item('v', { kind: 'video' }), stored(now - 60_000, 'video'), now, true)).toBe(false);
  });
});
