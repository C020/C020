import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/logger.js', async () => {
  const { pino } = await import('pino');
  const logger = pino({ level: 'silent' });
  return { logger, childLogger: () => logger };
});

import type { Channel } from '../../src/db/models.js';
import { SessionService } from '../../src/services/sessionService.js';
import { viewersByPlatform } from '../../src/services/views.js';
import { addStreamer, configureGuild, createEnv, type Env, liveSnap, MIN, resolved, saveLive } from './helpers.js';

const USER = '100000000000000001';

describe('SessionService — #13 viewer samples', () => {
  let env: Env;
  let svc: SessionService;
  let twitch: Channel;
  let kick: Channel;
  let streamerId: number;

  const make = () =>
    new SessionService({
      repos: env.repos,
      audit: env.audit,
      events: env.events,
      notifier: env.notifier,
      roles: env.roles,
      providers: env.providers,
      clock: env.clock.fn,
    });

  beforeEach(() => {
    env = createEnv();
    configureGuild(env.repos, 'g1');
    const reg = addStreamer(env.repos, 'g1', USER, [resolved('twitch', 'tw1', 'abu_tw'), resolved('kick', 'k1', 'abu_kick')]);
    [twitch, kick] = reg.channels as [Channel, Channel];
    streamerId = reg.streamer.id;
    svc = make();
  });

  afterEach(() => svc.stop());

  const sessionId = () => env.repos.sessions.listRecent('g1', 1)[0]!.id;
  const samples = () => env.repos.samples.forSession(sessionId());

  it('stores a sample when the session starts, with total, per-platform viewers and the primary category', async () => {
    await svc.onChannelLive(twitch, liveSnap(twitch, env.clock, { viewers: 120, category: 'Valorant' }));
    const [first] = samples();
    expect(samples()).toHaveLength(1);
    expect(first).toMatchObject({ at: env.clock.iso(), totalViewers: 120, platforms: { twitch: 120 }, category: 'Valorant' });
  });

  it('records at most one sample per minute, whatever the event rate', async () => {
    await svc.onChannelLive(twitch, liveSnap(twitch, env.clock, { viewers: 100 }));
    for (let i = 0; i < 5; i++) {
      env.clock.advance(15_000);
      await svc.onChannelUpdate(twitch, liveSnap(twitch, env.clock, { viewers: 100 + i }), { streamChanged: false });
    }
    // 75s elapsed: the start sample + one at 60s.
    expect(samples().map((s) => s.at)).toEqual([new Date(env.clock.now - 75_000).toISOString(), new Date(env.clock.now - 15_000).toISOString()]);
    expect(samples()[1]!.totalViewers).toBe(103);
  });

  it('sums platforms, reports hidden counts as null and keeps the category of the primary platform', async () => {
    await svc.onChannelLive(twitch, liveSnap(twitch, env.clock, { viewers: 100, category: 'Valorant' }));
    env.clock.advance(MIN);
    await svc.onChannelLive(kick, liveSnap(kick, env.clock, { viewers: 300, category: 'Just Chatting' }));
    const last = samples().at(-1)!;
    expect(last.totalViewers).toBe(400);
    expect(last.platforms).toEqual({ twitch: 100, kick: 300 });
    expect(last.category).toBe('Just Chatting'); // kick has the most viewers → primary

    env.clock.advance(MIN);
    await svc.onChannelUpdate(kick, liveSnap(kick, env.clock, { viewers: null, category: null }), { streamChanged: false });
    env.clock.advance(MIN);
    await svc.onChannelUpdate(twitch, liveSnap(twitch, env.clock, { viewers: null, category: null }), { streamChanged: false });
    const hidden = samples().at(-1)!;
    expect(hidden.totalViewers).toBeNull();
    expect(hidden.platforms).toEqual({ twitch: null, kick: null });
    expect(hidden.category).toBeNull();
  });

  it('samples on the periodic tick while nothing else happens', async () => {
    saveLive(env.repos, twitch, liveSnap(twitch, env.clock), env.clock);
    await svc.onChannelLive(twitch, liveSnap(twitch, env.clock, { viewers: 50 }));
    for (let i = 0; i < 3; i++) {
      env.clock.advance(MIN);
      await svc.tick();
    }
    expect(samples()).toHaveLength(4);
    expect(samples().every((s) => s.totalViewers === 50)).toBe(true);
  });

  it('spaces samples from the last stored one after a restart', async () => {
    await svc.onChannelLive(twitch, liveSnap(twitch, env.clock));
    svc.stop();
    const restarted = make();
    env.clock.advance(30_000);
    await restarted.onChannelUpdate(twitch, liveSnap(twitch, env.clock), { streamChanged: false });
    expect(samples()).toHaveLength(1);
    env.clock.advance(30_000);
    await restarted.onChannelUpdate(twitch, liveSnap(twitch, env.clock), { streamChanged: false });
    expect(samples()).toHaveLength(2);
    restarted.stop();
  });

  it('does not sample ended sessions and starts fresh when the session resumes', async () => {
    await svc.onChannelLive(twitch, liveSnap(twitch, env.clock));
    env.clock.advance(20_000);
    await svc.onChannelOffline(twitch, null, env.clock.iso());
    expect(samples()).toHaveLength(1);
    env.clock.advance(50_000);
    await svc.onChannelLive(twitch, liveSnap(twitch, env.clock, { streamId: 'twitch-stream-1' }));
    expect(env.repos.sessions.listRecent('g1', 5)).toHaveLength(1); // resumed (merge window)
    expect(samples()).toHaveLength(2);
  });

  it('keeps live handling working when storing a sample fails', async () => {
    vi.spyOn(env.repos.samples, 'add').mockImplementation(() => {
      throw new Error('disk full');
    });
    await svc.onChannelLive(twitch, liveSnap(twitch, env.clock));
    expect(env.notifier.posts).toHaveLength(1);
    expect(env.repos.sessions.getActive(streamerId)).not.toBeNull();
    expect(env.roles.isLive('g1', USER)).toBe(true);
  });

  it('prunes old samples on the first tick and then once per day', async () => {
    const prune = vi.spyOn(env.repos.samples, 'prune');
    await svc.tick();
    expect(prune).toHaveBeenCalledTimes(1);
    expect(prune).toHaveBeenCalledWith(180);
    env.clock.advance(60 * MIN);
    await svc.tick();
    expect(prune).toHaveBeenCalledTimes(1);
    env.clock.advance(24 * 60 * MIN);
    await svc.tick();
    expect(prune).toHaveBeenCalledTimes(2);
  });

  it('really deletes samples older than the retention', async () => {
    await svc.onChannelLive(twitch, liveSnap(twitch, env.clock));
    const id = sessionId();
    env.repos.samples.add({ sessionId: id, at: new Date(Date.now() - 200 * 86_400_000).toISOString(), totalViewers: 1, platforms: {}, category: null });
    expect(env.repos.samples.forSession(id)).toHaveLength(2);
    await svc.tick();
    expect(env.repos.samples.forSession(id)).toHaveLength(1);
  });
});

describe('viewersByPlatform', () => {
  it('adds channels of the same platform and keeps unknown counts as null', () => {
    const snap = (viewers: number | null) => ({ viewers });
    expect(
      viewersByPlatform([
        { platform: 'twitch', snapshot: snap(10) },
        { platform: 'twitch', snapshot: snap(5) },
        { platform: 'kick', snapshot: snap(null) },
        { platform: 'youtube', snapshot: snap(null) },
        { platform: 'youtube', snapshot: snap(7) },
        { platform: 'tiktok', snapshot: snap(-3) },
      ]),
    ).toEqual({ twitch: 15, kick: null, youtube: 7, tiktok: null });
  });
});

describe('SessionService — #15 presence-live members keep the live role', () => {
  let env: Env;
  let svc: SessionService;
  let twitch: Channel;
  const presenceLive = new Map<string, Set<string>>();

  beforeEach(() => {
    env = createEnv();
    presenceLive.clear();
    configureGuild(env.repos, 'g1');
    const reg = addStreamer(env.repos, 'g1', USER, [resolved('twitch', 'tw1', 'abu_tw')]);
    [twitch] = reg.channels as [Channel];
    svc = new SessionService({
      repos: env.repos,
      audit: env.audit,
      events: env.events,
      notifier: env.notifier,
      roles: env.roles,
      providers: env.providers,
      clock: env.clock.fn,
    });
    svc.setExtraLiveUsers({ liveUserIds: (guildId) => new Set(presenceLive.get(guildId) ?? []) });
  });

  afterEach(() => svc.stop());

  it('adds presence-live members to the guild role reconcile', async () => {
    presenceLive.set('g1', new Set(['200000000000000002']));
    await svc.syncRoles('g1', 'user:1');
    expect(env.roles.reconcileCalls.at(-1)!.live).toEqual(['200000000000000002']);
    expect(env.roles.isLive('g1', '200000000000000002')).toBe(true);
  });

  it('does not strip the role when the platform session ends while the presence goes on', async () => {
    await svc.onChannelLive(twitch, liveSnap(twitch, env.clock));
    expect(env.roles.isLive('g1', USER)).toBe(true);
    presenceLive.set('g1', new Set([USER]));
    env.clock.advance(5 * MIN);
    await svc.onChannelOffline(twitch, null, env.clock.iso());
    expect(env.repos.sessions.getActive(env.repos.streamers.list('g1')[0]!.id)).toBeNull();
    expect(env.roles.isLive('g1', USER)).toBe(true);
    expect(env.roles.liveCalls.filter((c) => !c.live)).toHaveLength(0);
    // The reconcile keeps it as well.
    await svc.reconcileLiveRoles();
    await svc.syncRoles('g1', 'user:1');
    expect(env.roles.isLive('g1', USER)).toBe(true);
  });

  it('removes the role at the end when the member is not presence-live', async () => {
    await svc.onChannelLive(twitch, liveSnap(twitch, env.clock));
    env.clock.advance(5 * MIN);
    await svc.onChannelOffline(twitch, null, env.clock.iso());
    expect(env.roles.isLive('g1', USER)).toBe(false);
  });

  it('ignores a failing presence source (roles follow sessions only)', async () => {
    svc.setExtraLiveUsers({
      liveUserIds: () => {
        throw new Error('db locked');
      },
    });
    await svc.onChannelLive(twitch, liveSnap(twitch, env.clock));
    env.clock.advance(5 * MIN);
    await svc.onChannelOffline(twitch, null, env.clock.iso());
    expect(env.roles.isLive('g1', USER)).toBe(false);
    await expect(svc.syncRoles('g1', 'user:1')).resolves.toEqual({ added: 0, removed: 0 });
  });

  it('a retried live-role change keeps the role for a presence-live member', async () => {
    await svc.onChannelLive(twitch, liveSnap(twitch, env.clock));
    env.roles.failLive = 1;
    env.clock.advance(5 * MIN);
    await svc.onChannelOffline(twitch, null, env.clock.iso()); // removal fails transiently → retry queued
    expect(env.roles.isLive('g1', USER)).toBe(true);
    presenceLive.set('g1', new Set([USER]));
    env.clock.advance(2 * MIN);
    await svc.tick();
    const last = env.roles.liveCalls.at(-1)!;
    expect(last).toMatchObject({ userId: USER, live: true });
    expect(env.roles.isLive('g1', USER)).toBe(true);
  });
});
