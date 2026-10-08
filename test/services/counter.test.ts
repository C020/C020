import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/logger.js', async () => {
  const { pino } = await import('pino');
  const logger = pino({ level: 'silent' });
  return { logger, childLogger: () => logger };
});

import type { GuildFeaturesPatch } from '../../src/db/models.js';
import { COUNTER_NAME_MAX, CounterService, type CounterServiceTiming, renderCounterName } from '../../src/services/counterService.js';
import { configureGuild, createEnv, type Env, FakeDiscordActions, MIN, T0 } from './helpers.js';

const CHANNEL = '300000000000000001';

const settle = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

describe('renderCounterName', () => {
  it('replaces every {count}', () => {
    expect(renderCounterName('🔴 Live: {count}', 3)).toBe('🔴 Live: 3');
    expect(renderCounterName('{count}/{count}', 2)).toBe('2/2');
  });

  it('uses the language default for an empty template and appends the count when the placeholder is missing', () => {
    expect(renderCounterName('', 4, 'ar')).toBe('🔴 يبثون الحين: 4');
    expect(renderCounterName('   ', 4, 'en')).toBe('🔴 Live now: 4');
    expect(renderCounterName(null, 1, 'en')).toBe('🔴 Live now: 1');
    expect(renderCounterName('Streamers', 5)).toBe('Streamers 5');
  });

  it('collapses whitespace, never shows negative or fractional counts and cuts at 100 characters without breaking emojis', () => {
    expect(renderCounterName('  a \n  {count}  ', -2)).toBe('a 0');
    expect(renderCounterName('{count}', 2.7)).toBe('2');
    const long = renderCounterName(`${'🔴'.repeat(120)}{count}`, 1);
    expect(Array.from(long)).toHaveLength(COUNTER_NAME_MAX);
    expect(long.endsWith('🔴')).toBe(true);
  });
});

describe('CounterService (#8)', () => {
  let env: Env;
  let actions: FakeDiscordActions;
  let presenceLive: Set<string>;
  let presenceListeners: Array<(guildId: string) => void>;
  let svc: CounterService;
  let nextUser = 1;

  const features = (patch: GuildFeaturesPatch) => env.repos.settings.update('g1', { features: patch });

  const make = (timing: Partial<CounterServiceTiming> = {}, withPresence = true) =>
    new CounterService({
      repos: env.repos,
      events: env.events,
      audit: env.audit,
      discord: actions,
      presence: withPresence
        ? {
            liveUserIds: () => new Set(presenceLive),
            onChange: (listener) => {
              presenceListeners.push(listener);
              return () => (presenceListeners = presenceListeners.filter((l) => l !== listener));
            },
          }
        : null,
      clock: () => Date.now(),
      timing,
    });

  /** Registers a streamer and opens a live session; returns the discord user id and session id. */
  const goLive = (guildId = 'g1', userId = `1000000000000000${String(nextUser++).padStart(2, '0')}`) => {
    const streamer = env.repos.streamers.getByDiscordId(guildId, userId) ?? env.repos.streamers.create({ guildId, discordUserId: userId, displayName: userId });
    const session = env.repos.sessions.create({ guildId, streamerId: streamer.id, startedAt: new Date().toISOString() });
    return { userId, streamerId: streamer.id, sessionId: session.id };
  };
  const endLive = (sessionId: number) => {
    const s = env.repos.sessions.get(sessionId)!;
    env.repos.sessions.save({ ...s, status: 'ended', endedAt: new Date().toISOString() });
  };
  const changed = (guildId = 'g1') => env.events.emit('live.changed', { guildId, streamerId: 1, status: 'updated' });
  const warnings = () => env.repos.audit.list({ guildId: 'g1', actionPrefix: 'counter.' });

  beforeEach(() => {
    vi.useFakeTimers({ now: T0, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    env = createEnv();
    configureGuild(env.repos, 'g1', { features: { counter: { channelId: CHANNEL, template: '🔴 Live: {count}' } } });
    actions = new FakeDiscordActions();
    presenceLive = new Set();
    presenceListeners = [];
    nextUser = 1;
    svc = make();
  });

  afterEach(() => {
    svc.stop();
    vi.useRealTimers();
  });

  describe('count', () => {
    it('counts distinct live members: active sessions plus presence-live members when presence is on', () => {
      const a = goLive();
      goLive();
      const ended = goLive();
      endLive(ended.sessionId);
      expect(svc.liveCount('g1')).toBe(2);
      presenceLive = new Set([a.userId, '200000000000000009']);
      expect(svc.liveCount('g1')).toBe(2); // presence detection is off
      features({ presence: { enabled: true } });
      expect(svc.liveCount('g1')).toBe(3); // a is counted once
    });

    it('ignores disabled streamers and other guilds', () => {
      const a = goLive();
      goLive('g2');
      env.repos.streamers.update(a.streamerId, { enabled: false });
      expect(svc.liveCount('g1')).toBe(0);
    });

    it('works without a presence service', () => {
      svc = make({}, false);
      features({ presence: { enabled: true } });
      goLive();
      expect(svc.liveCount('g1')).toBe(1);
    });
  });

  describe('renames', () => {
    it('renames the channel with the count, and only when the name changes', async () => {
      goLive();
      await svc.update('g1');
      expect(actions.renames).toEqual([{ guildId: 'g1', channelId: CHANNEL, name: '🔴 Live: 1', outcome: 'ok' }]);
      await svc.update('g1');
      expect(actions.renames).toHaveLength(1);
    });

    it('does nothing without a counter channel', async () => {
      features({ counter: { channelId: null } });
      goLive();
      await svc.update('g1');
      await svc.safetyPass();
      expect(actions.renames).toHaveLength(0);
    });

    it('uses the guild language for the default template', async () => {
      features({ counter: { template: '' }, language: 'en' });
      await svc.update('g1');
      expect(actions.applied).toEqual(['🔴 Live now: 0']);
    });

    it('renames at most once per 5 minutes per channel, coalescing to the latest count', async () => {
      svc.start();
      const first = goLive();
      changed();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(actions.applied).toEqual(['🔴 Live: 1']);

      await vi.advanceTimersByTimeAsync(MIN);
      goLive();
      changed();
      await vi.advanceTimersByTimeAsync(MIN);
      goLive();
      changed();
      await vi.advanceTimersByTimeAsync(MIN);
      endLive(first.sessionId);
      changed();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(actions.applied).toEqual(['🔴 Live: 1']);

      // The window opens 5 minutes after the first rename: one rename with the latest value.
      await vi.advanceTimersByTimeAsync(90_000); // now 5:02 after the first rename at 0:02
      await settle();
      expect(actions.applied).toEqual(['🔴 Live: 1', '🔴 Live: 2']);
      expect(actions.renames.filter((r) => r.outcome === 'ok')).toHaveLength(2);
    });

    it('coalesces bursts of events into one evaluation', async () => {
      svc.start();
      goLive();
      for (let i = 0; i < 10; i++) changed();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(actions.renames).toHaveLength(1);
    });

    it('refreshes on presence changes', async () => {
      svc.start();
      features({ presence: { enabled: true } });
      presenceLive = new Set(['200000000000000009']);
      expect(presenceListeners).toHaveLength(1);
      presenceListeners[0]!('g1');
      await vi.advanceTimersByTimeAsync(2_000);
      expect(actions.applied).toEqual(['🔴 Live: 1']);
    });

    it('never runs two renames of the same guild at once', async () => {
      let release!: () => void;
      const original = actions.renameChannel.bind(actions);
      let calls = 0;
      vi.spyOn(actions, 'renameChannel').mockImplementation(async (...args) => {
        calls++;
        if (calls === 1) await new Promise<void>((resolve) => (release = resolve));
        return original(...args);
      });
      goLive();
      const first = svc.update('g1');
      await settle();
      goLive();
      const second = svc.update('g1');
      await settle();
      expect(calls).toBe(1);
      release();
      await Promise.all([first, second]);
      // The second request ran after the first rename and is throttled now (scheduled, not lost).
      expect(calls).toBe(1);
      expect(actions.applied).toEqual(['🔴 Live: 1']);
      await vi.advanceTimersByTimeAsync(5 * MIN);
      await settle();
      expect(actions.applied).toEqual(['🔴 Live: 1', '🔴 Live: 2']);
    });

    it('stops scheduling after stop()', async () => {
      svc.start();
      svc.stop();
      goLive();
      changed();
      await vi.advanceTimersByTimeAsync(10 * MIN);
      expect(actions.renames).toHaveLength(0);
    });
  });

  describe('Discord outcomes', () => {
    it('waits for the rate limit (at least the throttle window)', async () => {
      svc.start();
      actions.renameOutcomes.push({ outcome: 'rate_limited', retryAfterMs: 9 * MIN });
      goLive();
      await svc.update('g1');
      expect(actions.renames).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(8 * MIN);
      changed();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(actions.renames).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(31_000);
      await settle();
      expect(actions.applied).toEqual(['🔴 Live: 1']);

      actions.channelNames.clear();
      svc.stop();
      svc = make();
      svc.start();
      actions.renameOutcomes.push({ outcome: 'rate_limited', retryAfterMs: 10_000 });
      await svc.update('g1');
      const attempts = actions.renames.length;
      await vi.advanceTimersByTimeAsync(4 * MIN);
      expect(actions.renames).toHaveLength(attempts);
      await vi.advanceTimersByTimeAsync(MIN + 1_000);
      await settle();
      expect(actions.renames).toHaveLength(attempts + 1);
    });

    it('warns the admins once per hour when the bot lacks Manage Channel, then recovers', async () => {
      svc.start();
      actions.renameOutcomes.push({ outcome: 'forbidden' }, { outcome: 'forbidden' }, { outcome: 'forbidden' });
      await svc.update('g1');
      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]!.level).toBe('warn');
      expect(warnings()[0]!.message).toContain('Manage Channel');
      expect(warnings()[0]!.message).toContain(`<#${CHANNEL}>`);

      await vi.advanceTimersByTimeAsync(10 * MIN + 1_000); // safety passes retry, still forbidden
      await settle();
      expect(actions.renames.filter((r) => r.outcome === 'forbidden').length).toBeGreaterThanOrEqual(2);
      expect(warnings()).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(5 * MIN); // fixed by the admin
      await settle();
      expect(actions.applied).toEqual(['🔴 Live: 0']);
      expect(warnings()).toHaveLength(1);
    });

    it('explains a missing channel in the guild language', async () => {
      features({ language: 'en' });
      actions.renameOutcomes.push({ outcome: 'missing' });
      await svc.update('g1');
      expect(warnings()[0]!.message).toContain('does not exist');
      expect(warnings()[0]!.details).toMatchObject({ channelId: CHANNEL, outcome: 'missing' });
    });

    it('retries transient errors after a minute', async () => {
      svc.start();
      actions.renameOutcomes.push({ outcome: 'error' });
      await svc.update('g1');
      expect(actions.applied).toEqual([]);
      await vi.advanceTimersByTimeAsync(MIN + 100);
      await settle();
      expect(actions.applied).toEqual(['🔴 Live: 0']);
      expect(warnings()).toHaveLength(0);
    });

    it('treats a throwing Discord layer as a transient error', async () => {
      vi.spyOn(actions, 'renameChannel').mockRejectedValueOnce(new Error('boom'));
      await expect(svc.update('g1')).resolves.toBeUndefined();
    });

    it('an unchanged name costs no rename window', async () => {
      actions.channelNames.set(CHANNEL, '🔴 Live: 0');
      await svc.update('g1');
      expect(actions.renames.at(-1)!.outcome).toBe('unchanged');
      goLive();
      await svc.update('g1');
      expect(actions.applied).toEqual(['🔴 Live: 1']);
    });
  });

  describe('safety pass', () => {
    it('runs on start and periodically, re-applying a name changed by hand', async () => {
      svc.start();
      await vi.advanceTimersByTimeAsync(10_000);
      await settle();
      expect(actions.applied).toEqual(['🔴 Live: 0']);
      actions.channelNames.set(CHANNEL, 'renamed by a moderator');
      // The pass at 5:00 is still inside the rename window of the first rename (0:10); the one at 10:00 fixes it.
      await vi.advanceTimersByTimeAsync(5 * MIN);
      await settle();
      expect(actions.applied).toEqual(['🔴 Live: 0']);
      await vi.advanceTimersByTimeAsync(5 * MIN);
      await settle();
      expect(actions.applied).toEqual(['🔴 Live: 0', '🔴 Live: 0']);
      await vi.advanceTimersByTimeAsync(5 * MIN);
      await settle();
      expect(actions.renames.at(-1)!.outcome).toBe('unchanged');
    });

    it('follows a changed counter channel', async () => {
      await svc.update('g1');
      features({ counter: { channelId: '300000000000000002' } });
      await svc.update('g1');
      expect(actions.renames.map((r) => r.channelId)).toEqual([CHANNEL, '300000000000000002']);
    });

    it('covers every configured guild and tolerates failures', async () => {
      configureGuild(env.repos, 'g2', { features: { counter: { channelId: '300000000000000003', template: '{count} live' } } });
      configureGuild(env.repos, 'g3');
      const original = actions.renameChannel.bind(actions);
      vi.spyOn(actions, 'renameChannel').mockImplementation(async (guildId, channelId, name) => {
        if (guildId === 'g1') throw new Error('boom');
        return original(guildId, channelId, name);
      });
      await svc.safetyPass();
      expect(actions.applied).toEqual(['0 live']);
    });
  });
});
