import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/logger.js', async () => {
  const { pino } = await import('pino');
  const logger = pino({ level: 'silent' });
  return { logger, childLogger: () => logger };
});

import type { Channel } from '../../src/db/models.js';
import { SessionService } from '../../src/services/sessionService.js';
import { addStreamer, configureGuild, createEnv, type Env, FakeProvider, liveSnap, MIN, resolved, saveLive } from './helpers.js';

const USER = '100000000000000001';

describe('SessionService', () => {
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
    env.providers.map.set('twitch', new FakeProvider('twitch', { vod: (_c, streamId) => `https://twitch.tv/videos/${streamId}` }));
    configureGuild(env.repos, 'g1');
    const reg = addStreamer(env.repos, 'g1', USER, [resolved('twitch', 'tw1', 'abu_tw'), resolved('kick', 'k1', 'abu_kick')]);
    [twitch, kick] = reg.channels as [Channel, Channel];
    streamerId = reg.streamer.id;
    svc = make();
  });

  afterEach(() => svc.stop());

  const active = () => env.repos.sessions.getActive(streamerId);
  const allSessions = () => env.repos.sessions.listRecent('g1', 50);

  it('posts one combined notification and edits it when a second platform joins', async () => {
    await svc.onChannelLive(twitch, liveSnap(twitch, env.clock, { viewers: 100 }));
    expect(env.notifier.posts).toHaveLength(1);
    expect(env.notifier.posts[0]!.view.platforms.map((p) => p.platform)).toEqual(['twitch']);
    expect(env.roles.isLive('g1', USER)).toBe(true);

    env.clock.advance(40_000);
    await svc.onChannelLive(kick, liveSnap(kick, env.clock, { viewers: 300 }));

    expect(env.notifier.posts).toHaveLength(1);
    expect(env.notifier.updates).toHaveLength(1);
    const view = env.notifier.updates[0]!.view;
    expect(view.platforms.map((p) => p.platform)).toEqual(['kick', 'twitch']); // most viewers first
    expect(view.totalViewers).toBe(400);
    expect(env.notifier.updates[0]!.ref).toEqual(env.notifier.posts[0]!.ref);
    expect(allSessions()).toHaveLength(1);
    expect(active()!.peakViewers).toBe(400);
    expect(env.repos.audit.list({ guildId: 'g1', actionPrefix: 'live.start' })).toHaveLength(1);
    expect(env.emitted.filter((e) => e.name === 'live.changed').map((e) => (e.payload as { status: string }).status)).toEqual(['live', 'updated']);
  });

  it('never creates two sessions when platforms go live at the same instant', async () => {
    await Promise.all([
      svc.onChannelLive(twitch, liveSnap(twitch, env.clock, { viewers: 10 })),
      svc.onChannelLive(kick, liveSnap(kick, env.clock, { viewers: 20 })),
    ]);
    expect(allSessions()).toHaveLength(1);
    expect(env.notifier.posts).toHaveLength(1);
    expect(env.repos.sessions.segments(active()!.id)).toHaveLength(2);
  });

  it('keeps the session when one platform ends and the other continues', async () => {
    await svc.onChannelLive(twitch, liveSnap(twitch, env.clock));
    await svc.onChannelLive(kick, liveSnap(kick, env.clock));
    env.clock.advance(5 * MIN);
    await svc.onChannelOffline(kick, liveSnap(kick, env.clock), env.clock.iso());

    const session = active();
    expect(session).not.toBeNull();
    expect(env.roles.isLive('g1', USER)).toBe(true);
    expect(env.notifier.summaries).toHaveLength(0);
    expect(env.notifier.lastLiveView!.platforms.map((p) => p.platform)).toEqual(['twitch']);
    const segments = env.repos.sessions.segments(session!.id);
    expect(segments.find((s) => s.channelId === kick.id)!.endedAt).toBe(env.clock.iso());
    expect(segments.find((s) => s.channelId === twitch.id)!.endedAt).toBeNull();
  });

  it('turns the message into a summary with correct duration, peak, average and categories', async () => {
    await svc.onChannelLive(twitch, liveSnap(twitch, env.clock, { viewers: 100, title: 'T1', category: 'Valorant' }));
    const ref = env.notifier.posts[0]!.ref;
    env.clock.advance(MIN);
    await svc.onChannelUpdate(twitch, liveSnap(twitch, env.clock, { viewers: 200, title: 'T1', category: 'Valorant' }), { streamChanged: false });
    env.clock.advance(MIN);
    await svc.onChannelUpdate(twitch, liveSnap(twitch, env.clock, { viewers: 300, title: 'T2', category: 'FORTNITE' }), { streamChanged: false });
    env.clock.advance(MIN);
    await svc.onChannelOffline(twitch, null, env.clock.iso());

    expect(active()).toBeNull();
    expect(env.roles.isLive('g1', USER)).toBe(false);
    expect(env.notifier.summaries).toHaveLength(1);
    const { ref: summaryRef, view } = env.notifier.summaries[0]!;
    expect(summaryRef).toEqual(ref);
    expect(view.durationSec).toBe(180);
    expect(view.peakViewers).toBe(300);
    expect(view.avgViewers).toBe(200); // (100*60 + 200*60 + 300*60) / 180
    expect(view.categories.map((c) => [c.name, c.seconds])).toEqual([
      ['Valorant', 120],
      ['FORTNITE', 60],
    ]);
    expect(view.titles).toEqual(['T1', 'T2']);
    expect(view.segments).toHaveLength(1);
    expect(view.segments[0]!.vodUrl).toBe('https://twitch.tv/videos/twitch-stream-1');
    expect(view.segments[0]!.channel.handle).toBe('abu_tw');
    expect(view.imageUrl).toContain('thumbs.example.com');

    const ended = env.repos.sessions.get(view.session.id)!;
    expect(ended.status).toBe('ended');
    expect(ended.endedAt).toBe(env.clock.iso());
    expect(env.repos.audit.list({ guildId: 'g1', actionPrefix: 'live.end' })).toHaveLength(1);
  });

  it('calls postSummary even when summaries are disabled (notifier renders a minimal "ended" message)', async () => {
    env.repos.settings.update('g1', { options: { summaryEnabled: false } });
    await svc.onChannelLive(twitch, liveSnap(twitch, env.clock));
    env.clock.advance(MIN);
    await svc.onChannelOffline(twitch, null, env.clock.iso());
    expect(env.notifier.summaries).toHaveLength(1);
    expect(env.notifier.summaries[0]!.view.settings.options.summaryEnabled).toBe(false);
  });

  it('reuses the session and message when the streamer comes back inside the merge window', async () => {
    await svc.onChannelLive(twitch, liveSnap(twitch, env.clock, { streamId: 'a' }));
    const ref = env.notifier.posts[0]!.ref;
    const sessionId = active()!.id;
    env.clock.advance(20 * MIN);
    await svc.onChannelOffline(twitch, null, env.clock.iso());
    expect(env.roles.isLive('g1', USER)).toBe(false);

    env.clock.advance(5 * MIN);
    await svc.onChannelLive(twitch, liveSnap(twitch, env.clock, { streamId: 'b' }));

    expect(active()!.id).toBe(sessionId);
    expect(env.notifier.posts).toHaveLength(1);
    expect(env.notifier.renders.at(-1)).toMatchObject({ kind: 'update', ref });
    expect(env.roles.isLive('g1', USER)).toBe(true);
    expect(env.repos.audit.list({ guildId: 'g1', actionPrefix: 'live.resume' })).toHaveLength(1);

    env.clock.advance(10 * MIN);
    await svc.onChannelOffline(twitch, null, env.clock.iso());
    const summary = env.notifier.summaries.at(-1)!.view;
    expect(summary.session.id).toBe(sessionId);
    expect(summary.durationSec).toBe(30 * 60); // 20 + 10 minutes, the 5 minute gap is excluded
    expect(summary.segments.map((s) => s.vodUrl)).toEqual(['https://twitch.tv/videos/a', 'https://twitch.tv/videos/b']);
  });

  it('starts a new session and message after the merge window', async () => {
    await svc.onChannelLive(twitch, liveSnap(twitch, env.clock, { streamId: 'a' }));
    const first = active()!.id;
    env.clock.advance(MIN);
    await svc.onChannelOffline(twitch, null, env.clock.iso());
    env.clock.advance(11 * MIN);
    await svc.onChannelLive(twitch, liveSnap(twitch, env.clock, { streamId: 'b' }));

    expect(active()!.id).not.toBe(first);
    expect(env.notifier.posts).toHaveLength(2);
    expect(allSessions()).toHaveLength(2);
  });

  it('resumes beyond the merge window when the very same broadcast comes back (e.g. bot downtime)', async () => {
    await svc.onChannelLive(twitch, liveSnap(twitch, env.clock, { streamId: 'same' }));
    const first = active()!.id;
    env.clock.advance(MIN);
    await svc.onChannelOffline(twitch, null, env.clock.iso());
    env.clock.advance(45 * MIN);
    await svc.onChannelLive(twitch, liveSnap(twitch, env.clock, { streamId: 'same' }));
    expect(active()!.id).toBe(first);
    expect(env.notifier.posts).toHaveLength(1);
  });

  it('reposts the live message when it was deleted', async () => {
    await svc.onChannelLive(twitch, liveSnap(twitch, env.clock));
    const first = env.notifier.posts[0]!.ref;
    env.notifier.deleted.add(first.messageId);

    env.clock.advance(6 * MIN); // past liveUpdateMinutes (5)
    await svc.onChannelUpdate(twitch, liveSnap(twitch, env.clock, { viewers: 150 }), { streamChanged: false });

    expect(env.notifier.posts).toHaveLength(2);
    const session = active()!;
    expect(session.messageId).toBe(env.notifier.posts[1]!.ref.messageId);
    expect(session.messageId).not.toBe(first.messageId);
  });

  it('does not repost when an edit fails transiently, and retries on the next tick', async () => {
    await svc.onChannelLive(twitch, liveSnap(twitch, env.clock));
    env.notifier.throwOnUpdate = true;
    env.clock.advance(6 * MIN);
    await svc.onChannelUpdate(twitch, liveSnap(twitch, env.clock, { viewers: 150 }), { streamChanged: false });
    expect(env.notifier.posts).toHaveLength(1);

    env.notifier.throwOnUpdate = false;
    env.clock.advance(MIN);
    await svc.tick();
    expect(env.notifier.updates).toHaveLength(1);
    expect(env.notifier.posts).toHaveLength(1);
  });

  it('throttles edits: viewer-only changes wait for liveUpdateMinutes, title changes at most every 30s', async () => {
    await svc.onChannelLive(twitch, liveSnap(twitch, env.clock));
    env.clock.advance(MIN);
    await svc.onChannelUpdate(twitch, liveSnap(twitch, env.clock, { viewers: 120 }), { streamChanged: false });
    expect(env.notifier.updates).toHaveLength(0);

    await svc.onChannelUpdate(twitch, liveSnap(twitch, env.clock, { title: 'New title' }), { streamChanged: false });
    expect(env.notifier.updates).toHaveLength(1);

    env.clock.advance(10_000);
    await svc.onChannelUpdate(twitch, liveSnap(twitch, env.clock, { title: 'Newer title' }), { streamChanged: false });
    expect(env.notifier.updates).toHaveLength(1); // deferred: last edit was 10s ago

    env.clock.advance(25_000);
    await svc.tick();
    expect(env.notifier.updates).toHaveLength(2);
    expect(env.notifier.lastLiveView!.platforms[0]!.snapshot.title).toBe('Newer title');

    env.clock.advance(5 * MIN);
    await svc.tick();
    expect(env.notifier.updates).toHaveLength(3); // periodic refresh
  });

  it('handles every guild that tracks the channel independently', async () => {
    configureGuild(env.repos, 'g2');
    const other = addStreamer(env.repos, 'g2', '100000000000000002', [twitch]);
    await svc.onChannelLive(twitch, liveSnap(twitch, env.clock));

    expect(env.notifier.posts.map((p) => p.ref.channelId).sort()).toEqual(['live-g1', 'live-g2']);
    expect(env.repos.sessions.getActive(other.streamer.id)).not.toBeNull();
    expect(env.roles.isLive('g2', '100000000000000002')).toBe(true);
    expect(env.roles.isLive('g1', USER)).toBe(true);
  });

  it('ignores platforms disabled for the guild', async () => {
    env.repos.settings.update('g1', { platformsEnabled: ['kick', 'youtube', 'tiktok'] });
    await svc.onChannelLive(twitch, liveSnap(twitch, env.clock));
    expect(active()).toBeNull();
    expect(env.notifier.posts).toHaveLength(0);
    expect(env.roles.liveCalls).toHaveLength(0);
  });

  it('ignores accounts with live notifications turned off', async () => {
    const account = env.repos.accounts.getByPair(streamerId, twitch.id)!;
    env.repos.accounts.update(account.id, { notifyLive: false });
    await svc.onChannelLive(twitch, liveSnap(twitch, env.clock));
    expect(active()).toBeNull();
    expect(env.notifier.posts).toHaveLength(0);
  });

  it('drops a platform from a running session when its live notifications are turned off', async () => {
    await svc.onChannelLive(twitch, liveSnap(twitch, env.clock));
    const account = env.repos.accounts.getByPair(streamerId, twitch.id)!;
    env.repos.accounts.update(account.id, { notifyLive: false });
    env.clock.advance(MIN);
    await svc.onChannelUpdate(twitch, liveSnap(twitch, env.clock), { streamChanged: false });
    expect(active()).toBeNull();
    expect(env.notifier.summaries).toHaveLength(1);
    expect(env.roles.isLive('g1', USER)).toBe(false);
  });

  it('treats an update without a session as going live (bot restart / account added mid-stream)', async () => {
    const startedAt = env.clock.iso(-30 * MIN);
    await svc.onChannelUpdate(twitch, liveSnap(twitch, env.clock, { startedAt }), { streamChanged: false });
    expect(active()!.startedAt).toBe(startedAt);
    expect(env.notifier.posts).toHaveLength(1);
    expect(env.roles.isLive('g1', USER)).toBe(true);
  });

  it('splits the platform segment when the platform reports a new broadcast id', async () => {
    await svc.onChannelLive(twitch, liveSnap(twitch, env.clock, { streamId: 'one' }));
    env.clock.advance(10 * MIN);
    await svc.onChannelUpdate(twitch, liveSnap(twitch, env.clock, { streamId: 'two', startedAt: env.clock.iso() }), { streamChanged: true });
    const segments = env.repos.sessions.segments(active()!.id);
    expect(segments.map((s) => [s.streamId, s.endedAt === null])).toEqual([
      ['one', false],
      ['two', true],
    ]);
    expect(env.notifier.posts).toHaveLength(1);
  });

  it('ends the session immediately for endStreamerSession', async () => {
    await svc.onChannelLive(twitch, liveSnap(twitch, env.clock));
    await svc.onChannelLive(kick, liveSnap(kick, env.clock));
    env.clock.advance(3 * MIN);
    await svc.endStreamerSession(streamerId, 'deleted');
    expect(active()).toBeNull();
    expect(env.repos.sessions.segments(allSessions()[0]!.id).every((s) => s.endedAt !== null)).toBe(true);
    expect(env.notifier.summaries).toHaveLength(1);
    expect(env.roles.isLive('g1', USER)).toBe(false);
  });

  it('reconcile ends stale sessions and reconciles roles in every guild', async () => {
    const live = liveSnap(twitch, env.clock);
    saveLive(env.repos, twitch, live, env.clock);
    await svc.onChannelLive(twitch, live);
    addStreamer(env.repos, 'g3', '100000000000000003', [kick]);

    // Bot was down while the stream ended: the DB says offline but the session is still open.
    env.clock.advance(20 * MIN);
    saveLive(env.repos, twitch, null, env.clock);
    await svc.reconcile();

    expect(active()).toBeNull();
    expect(env.notifier.summaries).toHaveLength(1);
    expect(env.roles.reconcileCalls.find((c) => c.guildId === 'g1')).toEqual({ guildId: 'g1', live: [], streamers: [USER] });
    expect(env.roles.reconcileCalls.find((c) => c.guildId === 'g3')).toEqual({ guildId: 'g3', live: [], streamers: ['100000000000000003'] });
  });

  it('reconcile keeps healthy sessions and reports their streamers as live', async () => {
    const live = liveSnap(twitch, env.clock);
    saveLive(env.repos, twitch, live, env.clock);
    await svc.onChannelLive(twitch, live);
    await svc.reconcile();
    expect(active()).not.toBeNull();
    expect(env.roles.reconcileCalls.find((c) => c.guildId === 'g1')!.live).toEqual([USER]);
  });

  it('syncRoles reconciles one guild and records an audit entry', async () => {
    const result = await svc.syncRoles('g1', 'user:42');
    expect(result).toEqual({ added: 0, removed: 0 });
    const entry = env.repos.audit.list({ guildId: 'g1', actionPrefix: 'roles.sync' })[0]!;
    expect(entry.actor).toBe('user:42');
  });

  it('the tick closes segments of removed accounts and ends sessions without live platforms', async () => {
    await svc.onChannelLive(twitch, liveSnap(twitch, env.clock));
    const account = env.repos.accounts.getByPair(streamerId, twitch.id)!;
    env.repos.accounts.delete(account.id);
    env.clock.advance(MIN);
    await svc.tick();
    expect(active()).toBeNull();
    expect(env.notifier.summaries).toHaveLength(1);
  });

  it('exposes live views and summaries for the dashboard', async () => {
    await svc.onChannelLive(twitch, liveSnap(twitch, env.clock, { viewers: 50 }));
    const views = svc.liveViews('g1');
    expect(views).toHaveLength(1);
    expect(views[0]!.totalViewers).toBe(50);
    env.clock.advance(2 * MIN);
    const summary = svc.summaryOf(views[0]!.session.id)!;
    expect(summary.durationSec).toBe(120);
    expect(svc.summaryOf(9999)).toBeNull();
  });

  it('closes orphaned segments once the monitor stops confirming the channel (after a full window)', async () => {
    svc.stop();
    svc = new SessionService({
      repos: env.repos,
      audit: env.audit,
      events: env.events,
      notifier: env.notifier,
      roles: env.roles,
      providers: env.providers,
      clock: env.clock.fn,
      timing: { orphanSegmentMs: 45 * MIN },
    });
    svc.start();
    await svc.onChannelLive(twitch, liveSnap(twitch, env.clock));
    const lastEvent = env.clock.iso();

    env.clock.advance(30 * MIN);
    await svc.tick();
    expect(active()).not.toBeNull();

    env.clock.advance(20 * MIN); // 50 minutes without any live event or live check
    await svc.tick();
    expect(active()).toBeNull();
    const ended = allSessions()[0]!;
    expect(ended.endedAt).toBe(lastEvent);
    expect(env.roles.isLive('g1', USER)).toBe(false);
  });

  it('keeps sessions alive while the monitor keeps reporting them', async () => {
    svc.start();
    await svc.onChannelLive(twitch, liveSnap(twitch, env.clock));
    for (let i = 0; i < 6; i++) {
      env.clock.advance(10 * MIN);
      await svc.onChannelUpdate(twitch, liveSnap(twitch, env.clock), { streamChanged: false });
      await svc.tick();
    }
    expect(active()).not.toBeNull();
  });

  it('retries VOD lookups for platforms that publish recordings late and refreshes the summary', async () => {
    let calls = 0;
    env.providers.map.set('kick', new FakeProvider('kick', { vod: () => (++calls >= 2 ? 'https://kick.com/video/abc' : null) }));
    svc.stop();
    svc = new SessionService({
      repos: env.repos,
      audit: env.audit,
      events: env.events,
      notifier: env.notifier,
      roles: env.roles,
      providers: env.providers,
      clock: env.clock.fn,
      timing: { vodRetryDelaysMs: [5, 5] },
    });
    svc.start();
    await svc.onChannelLive(kick, liveSnap(kick, env.clock));
    env.clock.advance(10 * MIN);
    await svc.onChannelOffline(kick, null, env.clock.iso());
    expect(env.notifier.summaries).toHaveLength(1);
    expect(env.notifier.summaries[0]!.view.segments[0]!.vodUrl).toBeNull();

    await vi.waitFor(() => expect(env.notifier.summaries).toHaveLength(2), { timeout: 2_000 });
    expect(env.notifier.summaries[1]!.view.segments[0]!.vodUrl).toBe('https://kick.com/video/abc');
    expect(env.notifier.summaries[1]!.ref).toEqual(env.notifier.posts[0]!.ref);
  });

  it('bounds slow VOD lookups with a timeout', async () => {
    env.providers.map.set('twitch', new FakeProvider('twitch', { vod: () => new Promise<string | null>(() => {}) }));
    svc = new SessionService({
      repos: env.repos,
      audit: env.audit,
      events: env.events,
      notifier: env.notifier,
      roles: env.roles,
      providers: env.providers,
      clock: env.clock.fn,
      timing: { vodLookupTimeoutMs: 20 },
    });
    await svc.onChannelLive(twitch, liveSnap(twitch, env.clock));
    env.clock.advance(MIN);
    await svc.onChannelOffline(twitch, null, env.clock.iso());
    expect(env.notifier.summaries).toHaveLength(1);
    expect(env.notifier.summaries[0]!.view.segments[0]!.vodUrl).toBeNull();
  });

  it('never throws to the monitor when the notifier explodes', async () => {
    env.notifier.postLive = async () => {
      throw new Error('boom');
    };
    await expect(svc.onChannelLive(twitch, liveSnap(twitch, env.clock))).resolves.toBeUndefined();
    expect(active()).not.toBeNull();
    expect(env.roles.isLive('g1', USER)).toBe(true);
  });
});
