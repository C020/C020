/**
 * removeAccount ends the session while holding the streamer lock for seconds (VOD lookup, Discord edit). A monitor
 * update queued behind it must not find the account anymore and bring the ended session back to life.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/logger.js', async () => {
  const { pino } = await import('pino');
  const logger = pino({ level: 'silent' });
  return { logger, childLogger: () => logger };
});

import { SessionService } from '../../src/services/sessionService.js';
import { StreamerService } from '../../src/services/streamerService.js';
import { addStreamer, configureGuild, createEnv, flush, liveSnap, MIN, resolved } from './helpers.js';

const GUILD = '100000000000000001';
const USER = '200000000000000001';

describe('StreamerService.removeAccount vs a queued live update', () => {
  let sessions: SessionService | null = null;
  afterEach(() => sessions?.stop());

  it('does not resume the session that removing the last live account just ended', async () => {
    const env = createEnv();
    configureGuild(env.repos, GUILD);
    let releaseVod!: () => void;
    const vodGate = new Promise<void>((resolve) => (releaseVod = resolve));
    env.providers.get('twitch').findVodUrl = async () => {
      await vodGate;
      return 'https://www.twitch.tv/videos/1';
    };
    sessions = new SessionService({
      repos: env.repos,
      audit: env.audit,
      events: env.events,
      notifier: env.notifier,
      roles: env.roles,
      providers: env.providers,
      clock: env.clock.fn,
    });
    const streamers = new StreamerService({
      repos: env.repos,
      audit: env.audit,
      providers: env.providers,
      discord: env.gateway,
      roles: env.roles,
      sessions,
      monitor: env.monitor,
    });
    const { streamer, channels } = addStreamer(env.repos, GUILD, USER, [resolved('twitch', '42', 'abc')]);
    const channel = channels[0]!;

    await sessions.onChannelLive(env.repos.channels.get(channel.id)!, liveSnap(channel, env.clock));
    env.clock.advance(10 * MIN);
    const account = env.repos.accounts.listForStreamer(streamer.id)[0]!;
    const liveCallsBefore = env.roles.liveCalls.length;

    const removal = streamers.removeAccount(GUILD, streamer.id, account.id, 'user:1');
    await flush(5); // endSession now waits on the VOD lookup while holding the streamer lock
    const update = sessions.onChannelUpdate(env.repos.channels.get(channel.id)!, liveSnap(channel, env.clock), { streamChanged: false });
    await flush(5);
    releaseVod();
    await Promise.all([removal, update]);

    const all = env.repos.sessions.listRecent(GUILD);
    expect(all.map((s) => s.status)).toEqual(['ended']);
    expect(env.repos.sessions.getActive(streamer.id)).toBeNull();
    // Role removed once at the end, never given back.
    expect(env.roles.liveCalls.slice(liveCallsBefore).map((c) => c.live)).toEqual([false]);
    expect(env.repos.audit.list({ guildId: GUILD }).filter((e) => e.action === 'live.resume')).toHaveLength(0);
    expect(env.repos.audit.list({ guildId: GUILD }).filter((e) => e.action === 'live.end')).toHaveLength(1);
    // The channel row survives for the summary/history even though no account references it.
    expect(env.repos.channels.get(channel.id)).not.toBeNull();
    expect(env.repos.accounts.get(account.id)).toBeNull();
  });
});
