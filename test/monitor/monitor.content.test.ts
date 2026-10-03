import { describe, expect, it } from 'vitest';
import { ChannelNotFoundError, ProviderError, RateLimitedError } from '../../src/core/errors.js';
import { createHarness, FakeProvider, item } from './helpers.js';

const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();

describe('Monitor content polling', () => {
  it('seeds silently on the first check, then announces only new items oldest first', async () => {
    const h = createHarness();
    const tw = h.provider('twitch');
    const ch = h.track('twitch', '100');
    tw.content.set('100', [item('v2', { publishedAt: minutesAgo(10) }), item('v1', { publishedAt: minutesAgo(20) })]);

    await h.monitor.runContentCycle('twitch');
    expect(h.content.calls).toEqual([]);
    expect(h.channel(ch.id).contentSeeded).toBe(true);
    expect(h.channel(ch.id).lastContentCheckAt).not.toBeNull();
    expect(h.repos.content.has(ch.id, 'v1')).toBe(true);
    expect(h.repos.content.has(ch.id, 'v2')).toBe(true);

    tw.content.set('100', [item('v4', { publishedAt: minutesAgo(1) }), item('v3', { publishedAt: minutesAgo(2) }), ...(tw.content.get('100') ?? [])]);
    await h.monitor.runContentCycle('twitch');
    expect(h.content.ids()).toEqual(['v3', 'v4']);
    expect(h.content.calls[0]?.channelId).toBe(ch.id);
    expect(h.content.calls[0]?.stored).toMatchObject({ channelId: ch.id, contentId: 'v3', announced: false });

    await h.monitor.runContentCycle('twitch');
    expect(h.content.ids()).toEqual(['v3', 'v4']);
  });

  it('requests the union of wanted kinds intersected with provider support', async () => {
    const tw = new FakeProvider('twitch', { content: ['video', 'vod', 'clip'] });
    const h = createHarness({ providers: [tw] });
    h.repos.settings.update('g1', { contentKinds: ['video', 'short'] });
    h.repos.settings.update('g3', { platformsEnabled: ['kick', 'youtube'] });
    h.track('twitch', 'shared', { guildId: 'g1' });
    h.track('twitch', 'shared', { guildId: 'g2', contentKinds: ['clip'] });
    h.track('twitch', 'shared', { guildId: 'g3' });
    h.track('twitch', 'disabled-platform', { guildId: 'g3' });
    h.track('twitch', 'muted', { guildId: 'g1', notifyContent: false });

    await h.monitor.runContentCycle('twitch');
    expect(tw.contentCalls).toEqual([{ platformId: 'shared', kinds: ['video', 'clip'] }]);
  });

  it('skips providers that cannot list content', async () => {
    const kick = new FakeProvider('kick', { content: [] });
    const h = createHarness({ providers: [kick] });
    h.track('kick', 'k1');
    await h.monitor.runContentCycle('kick');
    await h.monitor.checkContent(h.repos.channels.getByPlatformId('kick', 'k1')!.id);
    expect(kick.contentCalls).toEqual([]);
  });

  it('baselines a newly enabled kind silently instead of announcing its backlog', async () => {
    const h = createHarness();
    const tw = h.provider('twitch');
    h.repos.settings.update('g1', { contentKinds: ['video'] });
    h.track('twitch', '100');
    tw.content.set('100', [item('v1'), item('c1', { kind: 'clip' }), item('c2', { kind: 'clip' })]);
    await h.monitor.runContentCycle('twitch');

    h.repos.settings.update('g1', { contentKinds: ['video', 'clip'] });
    tw.content.set('100', [item('v2', { publishedAt: minutesAgo(0.5) }), ...(tw.content.get('100') ?? [])]);
    await h.monitor.runContentCycle('twitch');
    expect(h.content.ids()).toEqual(['v2']);

    tw.content.set('100', [item('c3', { kind: 'clip', publishedAt: minutesAgo(0.1) }), ...(tw.content.get('100') ?? [])]);
    await h.monitor.runContentCycle('twitch');
    expect(h.content.ids()).toEqual(['v2', 'c3']);
  });

  it('stores items older than every guild accepts without announcing them', async () => {
    const h = createHarness();
    const tw = h.provider('twitch');
    h.repos.settings.update('g1', { options: { contentMaxAgeHours: 24 } });
    const ch = h.track('twitch', '100');
    await h.monitor.runContentCycle('twitch');
    tw.content.set('100', [item('fresh', { publishedAt: minutesAgo(5) }), item('ancient', { publishedAt: minutesAgo(3 * 24 * 60) })]);
    await h.monitor.runContentCycle('twitch');
    expect(h.content.ids()).toEqual(['fresh']);
    expect(h.repos.content.has(ch.id, 'ancient')).toBe(true);
  });

  it('re-baselines a burst after an empty seed (provider glitch) and announces later items', async () => {
    const h = createHarness();
    const tw = h.provider('twitch');
    h.track('twitch', '100');
    await h.monitor.runContentCycle('twitch'); // seeded with nothing

    tw.content.set('100', ['a', 'b', 'c', 'd', 'e'].map((id, i) => item(id, { publishedAt: minutesAgo(10 - i) })));
    await h.monitor.runContentCycle('twitch');
    expect(h.content.calls).toEqual([]);

    tw.content.set('100', [item('f', { publishedAt: minutesAgo(1) }), ...(tw.content.get('100') ?? [])]);
    await h.monitor.runContentCycle('twitch');
    expect(h.content.ids()).toEqual(['f']);
  });

  it('announces a first upload after an empty seed', async () => {
    const h = createHarness();
    h.track('twitch', '100');
    await h.monitor.runContentCycle('twitch');
    h.provider('twitch').content.set('100', [item('first')]);
    await h.monitor.runContentCycle('twitch');
    expect(h.content.ids()).toEqual(['first']);
  });

  it('keeps delivering when one handler call fails', async () => {
    const h = createHarness();
    const tw = h.provider('twitch');
    h.track('twitch', '100');
    await h.monitor.runContentCycle('twitch');
    tw.content.set('100', [item('n2', { publishedAt: minutesAgo(1) }), item('n1', { publishedAt: minutesAgo(2) })]);
    h.content.failFor.add('n1');
    await h.monitor.runContentCycle('twitch');
    expect(h.content.ids()).toEqual(['n1', 'n2']);
  });

  it('isolates channel failures and reports provider health for content', async () => {
    const h = createHarness();
    const tw = h.provider('twitch');
    h.track('twitch', 'ok');
    h.track('twitch', 'broken');
    tw.contentFailure = (id) => (id === 'broken' ? new ProviderError('twitch', 'HTTP 500', true) : null);
    await h.monitor.runContentCycle('twitch');
    expect(h.repos.channels.getByPlatformId('twitch', 'ok')?.contentSeeded).toBe(true);
    expect(h.repos.channels.getByPlatformId('twitch', 'broken')?.contentSeeded).toBe(false);

    expect(h.health).toEqual([]);

    tw.contentFailure = () => new ProviderError('twitch', 'HTTP 500', true);
    await h.monitor.runContentCycle('twitch');
    expect(h.health).toEqual([]);
    await h.monitor.runContentCycle('twitch');
    expect(h.health).toEqual([{ platform: 'twitch', ok: false, message: expect.stringContaining('HTTP 500') }]);

    tw.contentFailure = null;
    await h.monitor.runContentCycle('twitch');
    expect(h.health.at(-1)).toEqual({ platform: 'twitch', ok: true, message: null });
    expect(h.repos.channels.getByPlatformId('twitch', 'broken')?.contentSeeded).toBe(true);
  });

  it('does not flap the platform health when some accounts are permanently broken', async () => {
    const h = createHarness({ tuning: { contentConcurrency: { twitch: 1, kick: 1, youtube: 1, tiktok: 1 } } });
    const tw = h.provider('twitch');
    for (const id of ['ok1', 'bad1', 'bad2', 'ok2']) h.track('twitch', id);
    tw.contentFailure = (id) => (id.startsWith('bad') ? new ProviderError('twitch', 'HTTP 500', true) : null);
    for (let i = 0; i < 4; i++) await h.monitor.runContentCycle('twitch');
    expect(h.health).toEqual([]);
    expect(h.repos.audit.list({ actionPrefix: 'provider.' })).toEqual([]);
  });

  it('pauses the platform when content checks are rate limited', async () => {
    const h = createHarness({ tuning: { contentConcurrency: { twitch: 1, kick: 1, youtube: 1, tiktok: 1 } } });
    const tw = h.provider('twitch');
    h.track('twitch', 'a');
    h.track('twitch', 'b');
    tw.contentFailure = () => new RateLimitedError('twitch', 60_000);
    await h.monitor.runContentCycle('twitch');
    expect(tw.contentCalls.map((c) => c.platformId)).toEqual(['a']);
    await h.monitor.runLiveCycle('twitch');
    expect(tw.liveCalls).toEqual([]);
  });

  it('reports a missing account instead of failing the platform', async () => {
    const tt = new FakeProvider('tiktok', { liveBatchSize: 1 });
    const h = createHarness({ providers: [tt] });
    h.track('tiktok', 'gone');
    tt.contentFailure = () => new ChannelNotFoundError('tiktok', '@gone');
    await h.monitor.runContentCycle('tiktok');
    await h.monitor.runContentCycle('tiktok');
    expect(h.repos.audit.list({ actionPrefix: 'channel.not_found' })).toHaveLength(1);
    expect(h.health).toEqual([]);
  });

  it('coalesces concurrent checks of the same channel', async () => {
    const h = createHarness();
    const ch = h.track('twitch', '100');
    await Promise.all([h.monitor.checkContent(ch.id), h.monitor.checkContent(ch.id), h.monitor.checkContent(ch.id)]);
    expect(h.provider('twitch').contentCalls).toHaveLength(2);
  });

  it('drops items of kinds that were not requested', async () => {
    const tw = new FakeProvider('twitch');
    const h = createHarness({ providers: [tw] });
    h.repos.settings.update('g1', { contentKinds: ['video'] });
    const ch = h.track('twitch', '100');
    // A sloppy provider ignoring the kinds filter:
    tw.fetchRecentContent = async () => [item('v1'), item('c1', { kind: 'clip' })];
    await h.monitor.runContentCycle('twitch');
    expect(h.repos.content.has(ch.id, 'v1')).toBe(true);
    expect(h.repos.content.has(ch.id, 'c1')).toBe(false);
  });
});
