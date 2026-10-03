import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelNotFoundError, ProviderError, RateLimitedError } from '../../src/core/errors.js';
import type { LiveSnapshot } from '../../src/core/types.js';
import { createHarness, Deferred, FakeProvider, liveSnap, T0 } from './helpers.js';
import { DEFAULT_MONITOR_TUNING } from '../../src/monitor/monitor.js';

const t = (sec: number): number => T0.getTime() + sec * 1_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Monitor live cycle', () => {
  it('goes live, updates, and ends after the grace period with persisted state', async () => {
    const h = createHarness();
    const tw = h.provider('twitch');
    const ch = h.track('twitch', '100');

    tw.setLive('100', { streamId: 'a', viewers: 5, startedAt: iso(t(-60)) });
    await h.monitor.runLiveCycle('twitch');
    expect(h.live.calls).toHaveLength(1);
    expect(h.live.calls[0]).toMatchObject({ type: 'live', channelId: ch.id, isLive: true });
    expect(h.channel(ch.id)).toMatchObject({ isLive: true, liveSince: iso(t(-60)), missCount: 0, errorCount: 0 });
    expect(h.channel(ch.id).liveSnapshot?.viewers).toBe(5);

    vi.setSystemTime(t(60));
    tw.setLive('100', { streamId: 'a', viewers: 9 });
    await h.monitor.runLiveCycle('twitch');
    expect(h.live.calls[1]).toMatchObject({ type: 'update', streamChanged: false });
    expect(h.live.calls[1]?.snapshot?.viewers).toBe(9);

    tw.setOffline('100');
    vi.setSystemTime(t(120));
    await h.monitor.runLiveCycle('twitch');
    expect(h.live.calls).toHaveLength(2);
    expect(h.channel(ch.id)).toMatchObject({ isLive: true, missCount: 1, offlineSince: iso(t(120)) });

    vi.setSystemTime(t(120 + 150));
    await h.monitor.runLiveCycle('twitch');
    expect(h.live.calls[2]).toMatchObject({ type: 'offline', channelId: ch.id, isLive: false, endedAt: iso(t(120)) });
    expect(h.live.calls[2]?.snapshot?.viewers).toBe(9);
    expect(h.channel(ch.id)).toMatchObject({ isLive: false, liveSnapshot: null, liveSince: null, offlineSince: null, missCount: 0 });
  });

  it('uses the per-platform offline thresholds by default (Twitch needs 3 misses)', async () => {
    const h = createHarness({ tuning: { offlineMisses: DEFAULT_MONITOR_TUNING.offlineMisses } });
    const tw = h.provider('twitch');
    const ch = h.track('twitch', '100');
    tw.setLive('100', { streamId: 'a' });
    await h.monitor.runLiveCycle('twitch');

    tw.setOffline('100');
    vi.setSystemTime(t(60));
    await h.monitor.runLiveCycle('twitch');
    vi.setSystemTime(t(60 + 200));
    await h.monitor.runLiveCycle('twitch');
    // Grace elapsed but only 2 misses: an edge-cached Get Streams omission must not end the stream yet.
    expect(h.channel(ch.id)).toMatchObject({ isLive: true, missCount: 2 });

    vi.setSystemTime(t(60 + 260));
    await h.monitor.runLiveCycle('twitch');
    expect(h.channel(ch.id).isLive).toBe(false);
    expect(h.live.calls.at(-1)).toMatchObject({ type: 'offline', endedAt: iso(t(60)) });
  });

  it('reports a stream id change as an update with streamChanged', async () => {
    const h = createHarness();
    h.track('twitch', '100');
    h.provider('twitch').setLive('100', { streamId: 'a' });
    await h.monitor.runLiveCycle('twitch');
    h.provider('twitch').setLive('100', { streamId: 'b' });
    await h.monitor.runLiveCycle('twitch');
    expect(h.live.calls.map((c) => [c.type, c.streamChanged])).toEqual([
      ['live', undefined],
      ['update', true],
    ]);
  });

  it('splits channels into batches of liveBatchSize', async () => {
    const tw = new FakeProvider('twitch', { liveBatchSize: 2 });
    const h = createHarness({ providers: [tw] });
    for (const id of ['1', '2', '3', '4', '5']) h.track('twitch', id);
    await h.monitor.runLiveCycle('twitch');
    expect(tw.liveCalls).toEqual([['1', '2'], ['3', '4'], ['5']]);
  });

  it('does nothing for unconfigured providers', async () => {
    const h = createHarness();
    h.track('twitch', '100');
    h.provider('twitch').configured = false;
    await h.monitor.runLiveCycle('twitch');
    await h.monitor.runLiveCycle('kick');
    expect(h.provider('twitch').liveCalls).toEqual([]);
  });

  it('never overlaps cycles of the same platform', async () => {
    const h = createHarness();
    h.track('twitch', '100');
    const gate = new Deferred<LiveSnapshot[]>();
    h.provider('twitch').liveInterceptor = () => gate.promise;
    const first = h.monitor.runLiveCycle('twitch');
    const second = h.monitor.runLiveCycle('twitch');
    expect(second).toBe(first);
    gate.resolve([liveSnap('100')]);
    await first;
    expect(h.provider('twitch').liveCalls).toHaveLength(1);
  });

  it('keeps state on provider errors, records them, and reports health transitions once', async () => {
    const h = createHarness();
    const tw = h.provider('twitch');
    const ch = h.track('twitch', '100');
    tw.setLive('100');
    await h.monitor.runLiveCycle('twitch');

    tw.liveFailure = () => new ProviderError('twitch', 'HTTP 503 from api.twitch.tv', true);
    await h.monitor.runLiveCycle('twitch');
    expect(h.channel(ch.id)).toMatchObject({ isLive: true, missCount: 0, errorCount: 1 });
    expect(h.channel(ch.id).lastError).toContain('503');
    expect(h.health).toEqual([]);

    await h.monitor.runLiveCycle('twitch');
    await h.monitor.runLiveCycle('twitch');
    expect(h.health).toEqual([{ platform: 'twitch', ok: false, message: expect.stringContaining('503') }]);
    expect(h.live.types()).toEqual(['live']);
    const status = h.monitor.status().find((s) => s.platform === 'twitch');
    expect(status).toMatchObject({ trackedChannels: 1, liveChannels: 1, consecutiveErrors: 3 });
    expect(status?.lastError).toContain('503');

    tw.liveFailure = null;
    await h.monitor.runLiveCycle('twitch');
    expect(h.health.at(-1)).toEqual({ platform: 'twitch', ok: true, message: null });
    expect(h.channel(ch.id)).toMatchObject({ errorCount: 0, lastError: null });
    expect(h.live.types()).toEqual(['live', 'update']);
    const audit = h.repos.audit.list({ actionPrefix: 'provider.' }).map((e) => [e.action, e.level]);
    expect(audit).toEqual([
      ['provider.recovered', 'info'],
      ['provider.failing', 'warn'],
    ]);
    expect(h.monitor.status().find((s) => s.platform === 'twitch')).toMatchObject({ lastError: null, consecutiveErrors: 0 });
  });

  it('judges platform health per pass, not per batch', async () => {
    const tw = new FakeProvider('twitch', { liveBatchSize: 2 });
    const h = createHarness({ providers: [tw] });
    for (const id of ['ok1', 'ok2', 'bad1', 'bad2']) h.track('twitch', id);
    tw.liveFailure = (ids) => (ids.includes('bad1') ? new ProviderError('twitch', 'HTTP 503', true) : null);
    for (let i = 0; i < 4; i++) await h.monitor.runLiveCycle('twitch');
    expect(h.health).toEqual([]);
    expect(h.repos.channels.getByPlatformId('twitch', 'bad1')?.errorCount).toBe(4);
    expect(h.monitor.status().find((s) => s.platform === 'twitch')?.consecutiveErrors).toBe(0);
  });

  it('targeted checks only count platform-wide failures', async () => {
    const h = createHarness();
    const ch = h.track('twitch', '100');
    h.provider('twitch').liveFailure = () => new ProviderError('twitch', 'HTTP 503', true);
    for (let i = 0; i < 3; i++) await h.monitor.checkLive([ch.id]);
    expect(h.health).toEqual([]);
    h.provider('twitch').liveFailure = () => new RateLimitedError('twitch', 1_000);
    await h.monitor.checkLive([ch.id]);
    vi.setSystemTime(t(5));
    await h.monitor.checkLive([ch.id]);
    expect(h.health).toEqual([{ platform: 'twitch', ok: false, message: expect.stringContaining('Rate limited') }]);
  });

  it('treats a missing snapshot as an error, not as offline', async () => {
    const h = createHarness();
    const ch = h.track('twitch', '100');
    h.provider('twitch').setLive('100');
    await h.monitor.runLiveCycle('twitch');
    h.provider('twitch').liveInterceptor = async () => [];
    vi.setSystemTime(t(600));
    await h.monitor.runLiveCycle('twitch');
    expect(h.channel(ch.id)).toMatchObject({ isLive: true, missCount: 0, errorCount: 1 });
    expect(h.live.types()).toEqual(['live']);
  });

  it('matches snapshots by platform id case-insensitively', async () => {
    const tt = new FakeProvider('tiktok', { liveBatchSize: 1 });
    const h = createHarness({ providers: [tt] });
    const ch = h.track('tiktok', 'SomeUser');
    tt.liveInterceptor = async () => [liveSnap('someuser', {}, 'tiktok')];
    await h.monitor.runLiveCycle('tiktok');
    expect(h.live.calls[0]?.snapshot?.platformId).toBe('SomeUser');
    expect(h.channel(ch.id).isLive).toBe(true);
  });

  it('pauses the platform and aborts the cycle when rate limited', async () => {
    const tw = new FakeProvider('twitch', { liveBatchSize: 2 });
    const h = createHarness({ providers: [tw] });
    for (const id of ['1', '2', '3']) h.track('twitch', id);
    tw.liveFailure = () => new RateLimitedError('twitch', 30_000);
    await h.monitor.runLiveCycle('twitch');
    expect(tw.liveCalls).toHaveLength(1);

    tw.liveFailure = null;
    await h.monitor.runLiveCycle('twitch');
    expect(tw.liveCalls).toHaveLength(1);

    vi.setSystemTime(t(31));
    await h.monitor.runLiveCycle('twitch');
    expect(tw.liveCalls).toEqual([['1', '2'], ['1', '2'], ['3']]);
  });

  it('catches handler errors so other channels are still processed', async () => {
    const h = createHarness();
    const a = h.track('twitch', '1');
    const b = h.track('twitch', '2');
    h.provider('twitch').setLive('1');
    h.provider('twitch').setLive('2');
    h.live.failFor.add(a.id);
    await h.monitor.runLiveCycle('twitch');
    expect(h.live.calls.map((c) => c.channelId)).toEqual([a.id, b.id]);
    expect(h.channel(a.id).isLive).toBe(true);
    expect(h.channel(b.id).isLive).toBe(true);
  });

  it('serializes events per channel', async () => {
    const h = createHarness();
    const ch = h.track('twitch', '100');
    h.provider('twitch').setLive('100');
    const gate = new Deferred();
    h.live.gate = gate.promise;

    const cycle = h.monitor.runLiveCycle('twitch');
    await flush();
    const targeted = h.monitor.checkLive([ch.id]);
    await flush();
    expect(h.live.types()).toEqual(['live']);

    h.live.gate = null;
    gate.resolve();
    await Promise.all([cycle, targeted]);
    expect(h.live.types()).toEqual(['live', 'update']);
  });

  it('does not let a hung handler block the cycle or shutdown', async () => {
    const h = createHarness();
    const a = h.track('twitch', '1');
    const b = h.track('twitch', '2');
    h.provider('twitch').setLive('1');
    h.provider('twitch').setLive('2');
    h.live.gate = new Promise(() => {}); // Discord never answers

    const cycle = h.monitor.runLiveCycle('twitch');
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await cycle;
    expect(h.live.calls.map((c) => c.channelId)).toEqual([a.id, b.id]);

    const stopping = h.monitor.stop();
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(stopping).resolves.toBeUndefined();
  });

  it('discards results of fetches that started before an already applied one', async () => {
    const h = createHarness();
    const ch = h.track('twitch', '100');
    const slow = new Deferred<LiveSnapshot[]>();
    let calls = 0;
    h.provider('twitch').liveInterceptor = () => (++calls === 1 ? slow.promise : null);

    const cycle = h.monitor.runLiveCycle('twitch');
    await flush();
    await h.monitor.checkLive([ch.id]); // newer fetch: offline
    slow.resolve([liveSnap('100')]); // stale "live" answer arrives late
    await cycle;
    expect(h.live.calls).toEqual([]);
    expect(h.channel(ch.id).isLive).toBe(false);
  });

  it('confirms a pending offline right after the grace window without waiting for a cycle', async () => {
    const h = createHarness();
    const ch = h.track('twitch', '100');
    h.provider('twitch').setLive('100');
    await h.monitor.runLiveCycle('twitch');
    h.provider('twitch').setOffline('100');
    vi.setSystemTime(t(60));
    await h.monitor.runLiveCycle('twitch');
    expect(h.live.types()).toEqual(['live']);

    await vi.advanceTimersByTimeAsync(150_000 + 3_000 + 250);
    await h.monitor.whenIdle();
    expect(h.live.types()).toEqual(['live', 'offline']);
    expect(h.live.calls[1]?.endedAt).toBe(iso(t(60)));
    expect(h.provider('twitch').liveCalls).toHaveLength(3);
    expect(h.channel(ch.id).isLive).toBe(false);
  });

  it('cancels the offline confirmation when the channel comes back', async () => {
    const h = createHarness();
    h.track('twitch', '100');
    const tw = h.provider('twitch');
    tw.setLive('100');
    await h.monitor.runLiveCycle('twitch');
    tw.setOffline('100');
    await h.monitor.runLiveCycle('twitch');
    tw.setLive('100');
    await h.monitor.runLiveCycle('twitch');
    await vi.advanceTimersByTimeAsync(200_000);
    await h.monitor.whenIdle();
    expect(tw.liveCalls).toHaveLength(3);
  });

  it('splits into offline + live when a different stream is found after bot downtime', async () => {
    const h = createHarness();
    const ch = h.track('twitch', '100');
    h.repos.channels.saveLiveState(ch.id, { isLive: true, snapshot: liveSnap('100', { streamId: 'old' }), liveSince: iso(t(-3600)), offlineSince: null, missCount: 0 });
    vi.setSystemTime(t(2 * 3600));
    h.provider('twitch').setLive('100', { streamId: 'new' });
    await h.monitor.runLiveCycle('twitch');
    expect(h.live.calls.map((c) => c.type)).toEqual(['offline', 'live']);
    expect(h.live.calls[0]).toMatchObject({ endedAt: iso(T0.getTime()), isLive: false });
    expect(h.live.calls[0]?.snapshot?.streamId).toBe('old');
    expect(h.live.calls[1]?.snapshot?.streamId).toBe('new');
  });
});

describe('Monitor bad batches', () => {
  it('bisects a batch broken by one channel and quarantines it', async () => {
    const h = createHarness();
    const tw = h.provider('twitch');
    for (const id of ['a', 'b', 'bad', 'c']) h.track('twitch', id);
    tw.setLive('a');
    tw.setLive('c');
    tw.liveFailure = (ids) => (ids.includes('bad') ? new ProviderError('twitch', 'HTTP 400: invalid user_id', false) : null);

    await h.monitor.runLiveCycle('twitch');
    expect(tw.liveCalls).toEqual([['a', 'b', 'bad', 'c'], ['a', 'b'], ['bad', 'c'], ['bad'], ['c']]);
    expect(h.live.calls.map((c) => h.channel(c.channelId).platformId)).toEqual(['a', 'c']);
    expect(h.repos.channels.getByPlatformId('twitch', 'bad')?.errorCount).toBe(1);
    expect(h.health).toEqual([]);

    tw.liveCalls.length = 0;
    await h.monitor.runLiveCycle('twitch');
    expect(tw.liveCalls).toEqual([['a', 'b', 'c'], ['bad']]);
  });

  it('stops bisecting quickly when the failure is systemic', async () => {
    const h = createHarness();
    const tw = h.provider('twitch');
    for (let i = 1; i <= 8; i++) h.track('twitch', String(i));
    tw.liveFailure = () => new ProviderError('twitch', 'HTTP 400: bad request', false);

    await h.monitor.runLiveCycle('twitch');
    expect(tw.liveCalls).toHaveLength(5);
    expect(h.repos.channels.listTracked('twitch').every((c) => c.errorCount === 1)).toBe(true);

    tw.liveCalls.length = 0;
    await h.monitor.runLiveCycle('twitch');
    // systemic cooldown: no bisect, just the regular batch and the two quarantined singles
    expect(tw.liveCalls.map((ids) => ids.length)).toEqual([6, 1, 1]);
    expect(h.health).toEqual([{ platform: 'twitch', ok: false, message: expect.stringContaining('400') }]);
  });

  it('reports a channel that no longer exists once per guild without failing the platform', async () => {
    const tt = new FakeProvider('tiktok', { liveBatchSize: 1 });
    const h = createHarness({ providers: [tt] });
    h.track('tiktok', 'gone', { guildId: 'g1' });
    h.track('tiktok', 'gone', { guildId: 'g2' });
    tt.liveFailure = () => new ChannelNotFoundError('tiktok', '@gone');
    await h.monitor.runLiveCycle('tiktok');
    await h.monitor.runLiveCycle('tiktok');
    await h.monitor.runLiveCycle('tiktok');
    const entries = h.repos.audit.list({ actionPrefix: 'channel.not_found' });
    expect(entries.map((e) => e.guildId).sort()).toEqual(['g1', 'g2']);
    expect(entries[0]?.level).toBe('warn');
    expect(h.health).toEqual([]);
  });
});

describe('Monitor stale and untracked live channels', () => {
  it('forces offline when a live channel cannot be checked for STALE_LIVE_MINUTES', async () => {
    const h = createHarness();
    const tw = h.provider('twitch');
    const ch = h.track('twitch', '100');
    tw.setLive('100');
    await h.monitor.runLiveCycle('twitch');

    tw.liveFailure = () => new ProviderError('twitch', 'network down', true);
    vi.setSystemTime(t(29 * 60));
    await h.monitor.runLiveCycle('twitch');
    expect(h.channel(ch.id).isLive).toBe(true);

    vi.setSystemTime(t(30 * 60));
    await h.monitor.runLiveCycle('twitch');
    expect(h.live.calls[1]).toMatchObject({ type: 'offline', isLive: false, endedAt: iso(T0.getTime()) });
    expect(h.channel(ch.id)).toMatchObject({ isLive: false });
    expect(h.channel(ch.id).lastError).toContain('forced offline');
    expect(h.repos.audit.list({ actionPrefix: 'live.forced_offline' })).toHaveLength(1);
  });

  it('the periodic sweep ends stale channels even when their provider is not configured', async () => {
    const h = createHarness();
    const ch = h.track('twitch', '100');
    h.repos.channels.saveLiveState(ch.id, { isLive: true, snapshot: liveSnap('100'), liveSince: iso(T0.getTime()), offlineSince: null, missCount: 0 });
    h.provider('twitch').configured = false;

    vi.setSystemTime(t(10 * 60));
    await h.monitor.runStaleSweep();
    expect(h.live.calls).toEqual([]);

    vi.setSystemTime(t(31 * 60));
    await h.monitor.runStaleSweep();
    expect(h.live.types()).toEqual(['offline']);
    expect(h.channel(ch.id).isLive).toBe(false);
  });

  it('does not count time before the monitor started (restart after downtime)', async () => {
    const h = createHarness();
    const ch = h.track('twitch', '100');
    h.repos.channels.saveLiveState(ch.id, { isLive: true, snapshot: liveSnap('100'), liveSince: iso(T0.getTime()), offlineSince: null, missCount: 0 });
    vi.setSystemTime(t(5 * 3600));
    h.monitor.start();
    await h.monitor.runStaleSweep();
    expect(h.live.calls).toEqual([]);
    await h.monitor.stop();
  });

  it('ends the live state of channels nobody tracks anymore', async () => {
    const h = createHarness();
    const ch = h.track('twitch', '100');
    h.provider('twitch').setLive('100');
    await h.monitor.runLiveCycle('twitch');
    const streamer = h.repos.accounts.subscribersOf(ch.id)[0]!.streamer;
    h.repos.streamers.update(streamer.id, { enabled: false });

    await h.monitor.runStaleSweep();
    expect(h.live.types()).toEqual(['live', 'offline']);
    expect(h.channel(ch.id).isLive).toBe(false);
  });
});

describe('Monitor TikTok spreading', () => {
  it('spreads single-channel batches across the poll interval', async () => {
    const tt = new FakeProvider('tiktok', { liveBatchSize: 1 });
    const h = createHarness({ providers: [tt] });
    for (const id of ['a', 'b', 'c']) h.track('tiktok', id);
    // POLL_TIKTOK_LIVE = 120s → 0.8 * 120 / 3 = 32s per slot
    const cycle = h.monitor.runLiveCycle('tiktok');
    await vi.advanceTimersByTimeAsync(0);
    expect(tt.liveCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(31_999);
    expect(tt.liveCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(tt.liveCalls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(32_000);
    await cycle;
    expect(tt.liveCalls).toEqual([['a'], ['b'], ['c']]);
  });
});

describe('Monitor status', () => {
  it('reports tracked and live counts for every platform', async () => {
    const h = createHarness();
    h.track('twitch', '1');
    h.track('twitch', '2');
    h.track('kick', 'k1');
    h.provider('twitch').setLive('1');
    await h.monitor.runLiveCycle('twitch');
    const status = Object.fromEntries(h.monitor.status().map((s) => [s.platform, s]));
    expect(status.twitch).toMatchObject({ trackedChannels: 2, liveChannels: 1, lastError: null, consecutiveErrors: 0 });
    expect(status.twitch?.lastSuccessAt).toBe(iso(T0.getTime()));
    expect(status.kick).toMatchObject({ trackedChannels: 1, liveChannels: 0, lastSuccessAt: null });
    expect(Object.keys(status)).toEqual(['twitch', 'kick', 'youtube', 'tiktok']);
  });
});
