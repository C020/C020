import { describe, expect, it } from 'vitest';
import type { ContentKind, Platform } from '../../src/core/types.js';
import { type ChannelSubscriber, defaultGuildSettings, type GuildSettings } from '../../src/db/models.js';
import { isTooOld, orderOldestFirst, planContent, sanitizeItems } from '../../src/monitor/contentPlan.js';
import { item } from './helpers.js';

const now = '2026-10-03T12:00:00.000Z';

function sub(guildId: string, over: { notifyContent?: boolean; contentKinds?: ContentKind[] | null; enabled?: boolean } = {}): ChannelSubscriber {
  return {
    guildId,
    streamer: { id: 1, guildId, discordUserId: '1', displayName: 'S', notes: null, color: null, templates: {}, enabled: over.enabled ?? true, createdAt: now, updatedAt: now },
    account: { id: 1, streamerId: 1, channelId: 1, notifyLive: true, notifyContent: over.notifyContent ?? true, contentKinds: over.contentKinds ?? null, createdAt: now },
  };
}

function settings(guildId: string, over: Partial<GuildSettings> & { maxAgeHours?: number } = {}): GuildSettings {
  const base = defaultGuildSettings(guildId, now);
  return { ...base, ...over, options: { ...base.options, contentMaxAgeHours: over.maxAgeHours ?? base.options.contentMaxAgeHours } };
}

function plan(subs: ChannelSubscriber[], all: Record<string, GuildSettings>, supported: ContentKind[], platform: Platform = 'youtube') {
  return planContent(platform, subs, (g) => all[g] ?? settings(g), supported);
}

describe('planContent', () => {
  it('unions guild/account kinds and intersects with provider support', () => {
    const all = {
      g1: settings('g1', { contentKinds: ['video', 'short'] }),
      g2: settings('g2', { contentKinds: ['video'] }),
    };
    const p = plan([sub('g1'), sub('g2', { contentKinds: ['clip', 'vod'] })], all, ['video', 'vod', 'short']);
    expect(p.kinds).toEqual(['video', 'short', 'vod']);
    expect(p.guildIds.sort()).toEqual(['g1', 'g2']);
  });

  it('ignores subscribers with notifications off, disabled platform or disabled streamer', () => {
    const all = {
      g1: settings('g1', { contentKinds: ['video'] }),
      g2: settings('g2', { platformsEnabled: ['twitch'] }),
      g3: settings('g3'),
    };
    const p = plan([sub('g1', { notifyContent: false }), sub('g2'), sub('g3', { enabled: false })], all, ['video', 'short']);
    expect(p).toEqual({ kinds: [], guildIds: [], maxAgeMs: null });
  });

  it('skips guilds whose wanted kinds are all unsupported', () => {
    const p = plan([sub('g1', { contentKinds: ['clip'] })], {}, ['video']);
    expect(p.kinds).toEqual([]);
    expect(p.guildIds).toEqual([]);
  });

  it('uses the largest max age of interested guilds (0 = unlimited)', () => {
    const all = { g1: settings('g1', { maxAgeHours: 24 }), g2: settings('g2', { maxAgeHours: 72 }), g3: settings('g3', { maxAgeHours: 0 }) };
    expect(plan([sub('g1'), sub('g2')], all, ['video']).maxAgeMs).toBe(72 * 3_600_000);
    expect(plan([sub('g1'), sub('g3')], all, ['video']).maxAgeMs).toBeNull();
  });
});

describe('content item helpers', () => {
  it('sanitizeItems drops unwanted kinds, empty ids and duplicates', () => {
    const items = [item('a'), item('b', { kind: 'clip' }), item(''), item('a', { title: 'dup' }), item('c', { kind: 'short' })];
    expect(sanitizeItems(items, ['video', 'short']).map((i) => i.contentId)).toEqual(['a', 'c']);
  });

  it('orderOldestFirst sorts by date and treats undated items as newest', () => {
    const items = [
      item('new', { publishedAt: '2026-10-03T11:00:00Z' }),
      item('undated-1', { publishedAt: 'n/a' }),
      item('old', { publishedAt: '2026-10-01T11:00:00Z' }),
      item('undated-0', { publishedAt: '' }),
      item('mid', { publishedAt: '2026-10-02T11:00:00Z' }),
    ];
    expect(orderOldestFirst(items).map((i) => i.contentId)).toEqual(['old', 'mid', 'new', 'undated-0', 'undated-1']);
  });

  it('isTooOld respects the limit and never rejects unknown dates', () => {
    const nowMs = Date.parse(now);
    expect(isTooOld(item('a', { publishedAt: '2026-10-01T11:00:00Z' }), 24 * 3_600_000, nowMs)).toBe(true);
    expect(isTooOld(item('a', { publishedAt: '2026-10-03T11:00:00Z' }), 24 * 3_600_000, nowMs)).toBe(false);
    expect(isTooOld(item('a', { publishedAt: 'garbage' }), 1, nowMs)).toBe(false);
    expect(isTooOld(item('a', { publishedAt: '2000-01-01T00:00:00Z' }), null, nowMs)).toBe(false);
  });
});
