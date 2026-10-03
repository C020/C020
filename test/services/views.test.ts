import { describe, expect, it } from 'vitest';
import type { LivePlatformView } from '../../src/services/ports.js';
import { categoryKey, formatDurationAr, liveSignature, mergedDurationMs, platformListAr, primaryCategory, sumViewers } from '../../src/services/views.js';

const platform = (id: number, title: string, category: string | null, viewers: number | null): LivePlatformView => ({
  platform: 'twitch',
  channel: { id, displayName: 'x', handle: 'x', url: 'https://x', avatarUrl: null },
  snapshot: {
    platform: 'twitch',
    platformId: String(id),
    isLive: true,
    streamId: null,
    title,
    category,
    categoryImageUrl: null,
    thumbnailUrl: null,
    viewers,
    startedAt: null,
    url: 'https://x',
    language: null,
    tags: [],
  },
});

describe('views helpers', () => {
  it('merges overlapping intervals and excludes gaps', () => {
    expect(mergedDurationMs([])).toBe(0);
    expect(
      mergedDurationMs([
        [0, 10],
        [5, 20],
        [30, 40],
      ]),
    ).toBe(30);
    expect(
      mergedDurationMs([
        [10, 5],
        [0, 1],
      ]),
    ).toBe(1);
  });

  it('formats durations in Arabic with dual/plural forms', () => {
    expect(formatDurationAr(20)).toBe('أقل من دقيقة');
    expect(formatDurationAr(60)).toBe('دقيقة');
    expect(formatDurationAr(2 * 3600 + 5 * 60)).toBe('ساعتين و 5 دقائق');
    expect(formatDurationAr(11 * 3600 + 30 * 60)).toBe('11 ساعة و 30 دقيقة');
  });

  it('signature ignores viewers and ordering but reacts to titles, categories and platform set', () => {
    const a = platform(1, 'Hello', 'Valorant', 10);
    const b = platform(2, 'Hello', 'Valorant', 99);
    expect(liveSignature([a, b])).toBe(liveSignature([b, { ...a, snapshot: { ...a.snapshot, viewers: 500 } }]));
    expect(liveSignature([a, b])).not.toBe(liveSignature([a]));
    expect(liveSignature([a])).not.toBe(liveSignature([{ ...a, snapshot: { ...a.snapshot, title: 'Bye' } }]));
  });

  it('picks the primary category with fallback and normalizes keys', () => {
    expect(primaryCategory([platform(1, 't', null, 5), platform(2, 't', ' Just  Chatting ', 1)])?.name).toBe('Just Chatting');
    expect(categoryKey('VALORANT')).toBe(categoryKey('valorant'));
    expect(sumViewers([platform(1, 't', null, null)])).toBeNull();
    expect(sumViewers([platform(1, 't', null, 3), platform(2, 't', null, null)])).toBe(3);
  });

  it('lists platforms in Arabic', () => {
    expect(platformListAr(['twitch'])).toBe('Twitch');
    expect(platformListAr(['twitch', 'kick', 'youtube'])).toBe('Twitch، Kick و YouTube');
  });
});
