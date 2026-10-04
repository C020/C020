/**
 * Discord failures must heal: summaries that could not be published, live edits that failed or lost access,
 * and live-role changes that failed transiently are retried instead of being silently dropped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/logger.js', async () => {
  const { pino } = await import('pino');
  const logger = pino({ level: 'silent' });
  return { logger, childLogger: () => logger };
});

import type { Channel } from '../../src/db/models.js';
import { SessionService, type SessionServiceTiming } from '../../src/services/sessionService.js';
import { addStreamer, configureGuild, createEnv, type Env, FakeProvider, liveSnap, MIN, resolved } from './helpers.js';

const USER = '100000000000000001';

describe('SessionService delivery recovery', () => {
  let env: Env;
  let svc: SessionService;
  let twitch: Channel;
  let kick: Channel;
  let streamerId: number;

  const make = (timing: Partial<SessionServiceTiming> = {}) =>
    new SessionService({
      repos: env.repos,
      audit: env.audit,
      events: env.events,
      notifier: env.notifier,
      roles: env.roles,
      providers: env.providers,
      clock: env.clock.fn,
      timing,
    });

  beforeEach(() => {
    env = createEnv();
    // Twitch VODs are found right away, so the VOD retry never republishes the summary in these tests.
    env.providers.map.set('twitch', new FakeProvider('twitch', { vod: (_c, streamId) => `https://twitch.tv/videos/${streamId}` }));
    configureGuild(env.repos, 'g1');
    const reg = addStreamer(env.repos, 'g1', USER, [resolved('twitch', 'tw1', 'abu_tw'), resolved('kick', 'k1', 'abu_kick')]);
    [twitch, kick] = reg.channels as [Channel, Channel];
    streamerId = reg.streamer.id;
    svc = make();
  });

  afterEach(() => svc.stop());

  const lastSession = () => env.repos.sessions.listRecent('g1', 1)[0]!;
  const summaryAttempts = () => env.notifier.summaries.length;

  async function liveThenEnd(): Promise<{ channelId: string; messageId: string }> {
    await svc.onChannelLive(twitch, liveSnap(twitch, env.clock, { viewers: 100 }));
    const ref = env.notifier.posts[0]!.ref;
    env.clock.advance(10 * MIN);
    await svc.onChannelOffline(twitch, null, env.clock.iso());
    return ref;
  }

  describe('summary publication', () => {
    it('retries a summary that failed transiently instead of leaving the LIVE message up forever', async () => {
      env.notifier.failSummaries = 1;
      const ref = await liveThenEnd();
      expect(lastSession()).toMatchObject({ status: 'ended', summaryPending: true, summaryAttempts: 1, messageId: ref.messageId });

      await svc.tick(); // not due yet (1 min backoff)
      expect(summaryAttempts()).toBe(1);

      env.clock.advance(MIN);
      await svc.tick();
      expect(summaryAttempts()).toBe(2);
      expect(env.notifier.summaries[1]).toMatchObject({ ref, result: ref });
      expect(lastSession()).toMatchObject({ summaryPending: false, summaryAttempts: 0, messageId: ref.messageId });

      env.clock.advance(2 * 60 * MIN);
      await svc.tick();
      expect(summaryAttempts()).toBe(2);
    });

    it('backs off between attempts and gives up with an Arabic audit warning', async () => {
      svc = make({ summaryRetryDelaysMs: [MIN, 5 * MIN, 15 * MIN], summaryMaxAttempts: 4 });
      env.notifier.failSummaries = 100;
      await liveThenEnd();
      expect(summaryAttempts()).toBe(1);

      const tickAfter = async (ms: number) => {
        env.clock.advance(ms);
        await svc.tick();
        return summaryAttempts();
      };
      expect(await tickAfter(MIN)).toBe(2);
      expect(await tickAfter(4 * MIN)).toBe(2); // next one is 5 min after the 2nd failure
      expect(await tickAfter(MIN)).toBe(3);
      expect(await tickAfter(15 * MIN)).toBe(4);
      expect(lastSession()).toMatchObject({ summaryPending: false, summaryAttempts: 4 });
      const gaveUp = env.repos.audit.list({ guildId: 'g1', actionPrefix: 'live.summary_failed' });
      expect(gaveUp).toHaveLength(1);
      expect(gaveUp[0]!.level).toBe('warn');
      expect(gaveUp[0]!.message).toContain('ملخص');

      expect(await tickAfter(5 * 60 * MIN)).toBe(4);
    });

    it('republishes a pending summary after a restart', async () => {
      env.notifier.failSummaries = 1;
      const ref = await liveThenEnd();
      svc.stop();
      expect(lastSession()).toMatchObject({ summaryPending: true, summaryAttempts: 1 });

      // New process: nothing in memory, only the DB knows the summary is still pending.
      svc = make();
      await svc.reconcile();
      expect(summaryAttempts()).toBe(2);
      expect(env.notifier.summaries[1]!.result).toEqual(ref);
      expect(lastSession()).toMatchObject({ summaryPending: false, summaryAttempts: 0 });
    });

    it('drops a pending summary when the stream resumes (the LIVE message comes back)', async () => {
      env.notifier.failSummaries = 1;
      await liveThenEnd();
      env.clock.advance(MIN);
      await svc.onChannelLive(twitch, liveSnap(twitch, env.clock));
      expect(lastSession()).toMatchObject({ status: 'live', summaryPending: false, summaryAttempts: 0 });
      env.clock.advance(10 * MIN);
      await svc.tick();
      expect(summaryAttempts()).toBe(1);
    });
  });

  describe('live message edits', () => {
    it('does not mark a transiently failed edit as rendered (retried even without periodic refreshes)', async () => {
      configureGuild(env.repos, 'g1', { options: { liveUpdateMinutes: 0 } });
      await svc.onChannelLive(twitch, liveSnap(twitch, env.clock, { viewers: 100 }));
      env.clock.advance(40_000);
      env.notifier.updateOutcomes.push('transient');
      await svc.onChannelLive(kick, liveSnap(kick, env.clock, { viewers: 50 }));
      expect(env.notifier.failedUpdates.map((u) => u.outcome)).toEqual(['transient']);
      expect(env.notifier.updates).toHaveLength(0);

      env.clock.advance(MIN);
      await svc.tick();
      expect(env.notifier.updates).toHaveLength(1);
      expect(env.notifier.lastLiveView!.platforms.map((p) => p.platform).sort()).toEqual(['kick', 'twitch']);
      expect(env.notifier.posts).toHaveLength(1);
    });

    it('keeps the message when the bot lost access to the channel: no duplicate post or ping, edited once access is back', async () => {
      await svc.onChannelLive(twitch, liveSnap(twitch, env.clock));
      const original = env.notifier.posts[0]!.ref;
      env.clock.advance(40_000);
      env.notifier.updateOutcomes.push('forbidden', 'forbidden');
      env.notifier.failPosts = true;
      await svc.onChannelLive(kick, liveSnap(kick, env.clock));
      env.clock.advance(MIN);
      await svc.tick();
      expect(env.notifier.failedUpdates.map((u) => u.outcome)).toEqual(['forbidden', 'forbidden']);
      expect(env.repos.sessions.getActive(streamerId)).toMatchObject({ messageChannelId: original.channelId, messageId: original.messageId });

      // Access restored.
      env.notifier.failPosts = false;
      env.clock.advance(MIN);
      await svc.tick();
      expect(env.notifier.posts).toHaveLength(1);
      expect(env.notifier.updates.map((u) => u.ref)).toEqual([original]);

      env.clock.advance(MIN);
      await svc.onChannelOffline(twitch, null, env.clock.iso());
      await svc.onChannelOffline(kick, null, env.clock.iso());
      expect(env.notifier.summaries.map((s) => s.ref)).toEqual([original]);
    });

    it('posts in the new channel when access to the old one was lost after the admin moved notifications', async () => {
      await svc.onChannelLive(twitch, liveSnap(twitch, env.clock));
      configureGuild(env.repos, 'g1', { liveChannelId: 'live-new' });
      env.clock.advance(40_000);
      env.notifier.updateOutcomes.push('forbidden');
      await svc.onChannelLive(kick, liveSnap(kick, env.clock));
      expect(env.notifier.posts.map((p) => p.ref.channelId)).toEqual(['live-g1', 'live-new']);
      expect(env.repos.sessions.getActive(streamerId)!.messageChannelId).toBe('live-new');
    });
  });

  describe('live role', () => {
    it('retries a live-role removal that failed transiently at the end of the stream', async () => {
      await svc.onChannelLive(twitch, liveSnap(twitch, env.clock));
      expect(env.roles.isLive('g1', USER)).toBe(true);
      env.roles.failLive = 1;
      env.clock.advance(5 * MIN); // the periodic reconcile (every 10 min) is not due in this test
      await svc.onChannelOffline(twitch, null, env.clock.iso());
      expect(env.roles.isLive('g1', USER)).toBe(true);

      await svc.tick();
      expect(env.roles.isLive('g1', USER)).toBe(true); // backoff: 1 min
      env.clock.advance(MIN);
      await svc.tick();
      expect(env.roles.isLive('g1', USER)).toBe(false);
      expect(env.roles.liveCalls.map((c) => c.live)).toEqual([true, false, false]);
    });

    it('retries a failed add at go-live with backoff until it applies', async () => {
      env.roles.failLive = 2;
      await svc.onChannelLive(twitch, liveSnap(twitch, env.clock));
      expect(env.roles.isLive('g1', USER)).toBe(false);
      env.clock.advance(MIN);
      await svc.tick(); // 2nd failure, next retry 2 min later
      env.clock.advance(MIN);
      await svc.tick();
      expect(env.roles.liveCalls).toHaveLength(2);
      env.clock.advance(MIN);
      await svc.tick();
      expect(env.roles.liveCalls).toHaveLength(3);
      expect(env.roles.isLive('g1', USER)).toBe(true);
    });

    it('re-reads the desired state when retrying, so it never undoes a newer go-live', async () => {
      await svc.onChannelLive(twitch, liveSnap(twitch, env.clock));
      env.roles.failLive = 1;
      env.clock.advance(10 * MIN);
      await svc.onChannelOffline(twitch, null, env.clock.iso());
      // Back live (resume) before the retry ran: that change succeeds and supersedes the pending removal.
      await svc.onChannelLive(twitch, liveSnap(twitch, env.clock));
      expect(env.roles.isLive('g1', USER)).toBe(true);
      env.clock.advance(5 * MIN);
      await svc.tick();
      expect(env.roles.isLive('g1', USER)).toBe(true);
      expect(env.roles.liveCalls.map((c) => c.live)).toEqual([true, false, true]);
    });

    it('reconciles guilds with active or recently ended sessions periodically', async () => {
      await svc.onChannelLive(twitch, liveSnap(twitch, env.clock));
      env.clock.advance(9 * MIN);
      await svc.tick();
      expect(env.roles.reconcileCalls).toHaveLength(0);
      env.clock.advance(MIN);
      await svc.tick();
      expect(env.roles.reconcileCalls.map((c) => [c.guildId, c.live])).toEqual([['g1', [USER]]]);

      await svc.onChannelOffline(twitch, null, env.clock.iso());
      // The role removal "succeeded" but the role is still there (e.g. a REST error swallowed elsewhere).
      env.roles.live.set(`g1:${USER}`, true);
      env.clock.advance(10 * MIN);
      await svc.tick();
      expect(env.roles.isLive('g1', USER)).toBe(false);
      expect(env.roles.reconcileCalls).toHaveLength(2);

      // Long after the end, quiet guilds are left alone.
      env.clock.advance(40 * MIN);
      await svc.tick();
      env.clock.advance(10 * MIN);
      await svc.tick();
      expect(env.roles.reconcileCalls).toHaveLength(2);
    });

    it('reconciles roles right away when the Discord gateway recovers, including pending retries', async () => {
      await svc.onChannelLive(twitch, liveSnap(twitch, env.clock));
      env.roles.failLive = 1;
      await svc.onChannelOffline(twitch, null, env.clock.iso());
      expect(env.roles.isLive('g1', USER)).toBe(true);

      await svc.reconcileLiveRoles();
      expect(env.roles.isLive('g1', USER)).toBe(false);
      expect(env.roles.reconcileCalls.map((c) => c.guildId)).toEqual(['g1']);
    });

    it('retries a guild reconcile that failed at startup (Discord not ready yet)', async () => {
      env.roles.failReconcile = 1;
      await svc.reconcile();
      expect(env.roles.reconcileCalls).toHaveLength(1);
      env.clock.advance(MIN);
      await svc.tick();
      expect(env.roles.reconcileCalls).toHaveLength(2);
      env.clock.advance(5 * MIN);
      await svc.tick();
      expect(env.roles.reconcileCalls).toHaveLength(2);
    });
  });
});
