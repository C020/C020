import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/logger.js', async () => {
  const { pino } = await import('pino');
  const logger = pino({ level: 'silent' });
  return { logger, childLogger: () => logger };
});

import type { StreamingActivity } from '../../src/app/context.js';
import type { Channel, GuildFeaturesPatch } from '../../src/db/models.js';
import { channelHandleFromUrl, PresenceService, type PresenceServiceTiming } from '../../src/services/presenceService.js';
import { SessionService } from '../../src/services/sessionService.js';
import { addStreamer, configureGuild, createEnv, type Env, FakeClock, FakeDiscordActions, liveSnap, MIN, resolved, T0 } from './helpers.js';

const USER = '100000000000000001';
const OTHER = '100000000000000002';
const BOT = '100000000000000003';

const ACTIVITY: StreamingActivity = { url: 'https://twitch.tv/abu', platform: 'twitch', title: 'Ranked grind', game: 'Valorant' };

/** Lets the promise chains of the fakes settle (they resolve synchronously). */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

describe('PresenceService (#15)', () => {
  let env: Env;
  let actions: FakeDiscordActions;
  let svc: PresenceService;
  let extraSource: { liveUserIds(guildId: string): Set<string> } | null;
  let changes: string[];
  let streamerId: number;
  let twitch: Channel;

  const features = (patch: GuildFeaturesPatch) => env.repos.settings.update('g1', { features: patch });

  const make = (timing: Partial<PresenceServiceTiming> = {}) => {
    const service = new PresenceService({
      repos: env.repos,
      audit: env.audit,
      events: env.events,
      notifier: env.notifier,
      roles: env.roles,
      discord: actions,
      sessions: { setExtraLiveUsers: (source) => (extraSource = source) },
      clock: () => Date.now(),
      timing,
    });
    service.onChange((guildId) => changes.push(guildId));
    return service;
  };

  beforeEach(() => {
    vi.useFakeTimers({ now: T0, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    env = createEnv();
    configureGuild(env.repos, 'g1', { features: { presence: { enabled: true, scope: 'registered', notify: true } } });
    const reg = addStreamer(env.repos, 'g1', USER, [resolved('twitch', 'tw1', 'abu_tw')]);
    streamerId = reg.streamer.id;
    [twitch] = reg.channels as [Channel];
    env.gateway.addMember('g1', USER, 'Abu');
    env.gateway.addMember('g1', OTHER, 'Visitor');
    env.gateway.addMember('g1', BOT, 'SomeBot', true);
    actions = new FakeDiscordActions(env.gateway);
    extraSource = null;
    changes = [];
    svc = make();
  });

  afterEach(() => {
    svc.stop();
    vi.useRealTimers();
  });

  const grant = (userId = USER) => env.repos.presence.get('g1', userId);
  const audits = (prefix: string) => env.repos.audit.list({ guildId: 'g1', actionPrefix: prefix });

  describe('start', () => {
    it('registers itself as the extra live-user source of the session service', () => {
      expect(extraSource).toBe(svc);
    });

    it('gives the live role, records the grant and posts the presence notification', async () => {
      await svc.onPresence('g1', USER, ACTIVITY);
      expect(env.roles.isLive('g1', USER)).toBe(true);
      expect(grant()).toMatchObject({ userId: USER, startedAt: new Date(T0).toISOString(), url: ACTIVITY.url, platform: 'twitch', title: 'Ranked grind', game: 'Valorant' });
      expect(env.notifier.presencePosts).toHaveLength(1);
      const view = env.notifier.presencePosts[0]!.view;
      expect(view).toMatchObject({ guildId: 'g1', userId: USER, displayName: 'Streamer 01', url: ACTIVITY.url, platform: 'twitch', endedAt: null });
      expect(view.streamer?.id).toBe(streamerId);
      expect(grant()).toMatchObject({ messageChannelId: 'live-g1', messageId: env.notifier.presencePosts[0]!.ref!.messageId });
      expect(svc.liveUserIds('g1')).toEqual(new Set([USER]));
      expect(audits('presence.start')[0]!.message).toBe('Streamer 01 يبث الحين على Twitch — حسب حالة ديسكورد');
      expect(changes).toEqual(['g1']);
    });

    it('does not post when presence notifications are off', async () => {
      features({ presence: { notify: false } });
      await svc.onPresence('g1', USER, ACTIVITY);
      expect(env.roles.isLive('g1', USER)).toBe(true);
      expect(env.notifier.presencePosts).toHaveLength(0);
      expect(grant()!.messageId).toBeNull();
    });

    it('only covers registered (enabled) streamers with the "registered" scope', async () => {
      await svc.onPresence('g1', OTHER, ACTIVITY);
      expect(grant(OTHER)).toBeNull();
      expect(env.roles.liveCalls).toHaveLength(0);
      env.repos.streamers.update(streamerId, { enabled: false });
      await svc.onPresence('g1', USER, ACTIVITY);
      expect(grant()).toBeNull();
    });

    it('covers any member with the "everyone" scope, but never bots or members who left', async () => {
      features({ presence: { scope: 'everyone' } });
      await svc.onPresence('g1', OTHER, ACTIVITY);
      expect(grant(OTHER)).not.toBeNull();
      expect(env.notifier.presencePosts[0]!.view).toMatchObject({ displayName: 'Visitor', streamer: null });
      await svc.onPresence('g1', BOT, ACTIVITY);
      expect(grant(BOT)).toBeNull();
      await svc.onPresence('g1', '100000000000000099', ACTIVITY);
      expect(grant('100000000000000099')).toBeNull();
    });

    it('still starts when the member lookup fails (Discord hiccup)', async () => {
      env.gateway.failLookup = true;
      await svc.onPresence('g1', USER, ACTIVITY);
      expect(grant()).not.toBeNull();
      expect(env.notifier.presencePosts[0]!.view.displayName).toBe('Streamer 01');
    });

    it('does nothing extra while the member has an active platform session', async () => {
      env.repos.sessions.create({ guildId: 'g1', streamerId, startedAt: new Date(T0).toISOString() });
      await svc.onPresence('g1', USER, ACTIVITY);
      expect(grant()).toBeNull();
      expect(env.roles.liveCalls).toHaveLength(0);
      expect(env.notifier.presencePosts).toHaveLength(0);
    });

    it('updates the grant on activity changes without notifying again', async () => {
      await svc.onPresence('g1', USER, ACTIVITY);
      await svc.onPresence('g1', USER, { ...ACTIVITY, title: 'Chill', game: 'Minecraft' });
      expect(grant()).toMatchObject({ title: 'Chill', game: 'Minecraft', startedAt: new Date(T0).toISOString() });
      expect(env.notifier.presencePosts).toHaveLength(1);
      expect(env.roles.liveCalls).toHaveLength(1);
    });

    it('keeps the grant (and role) when the notification cannot be posted', async () => {
      env.notifier.throwOnPresence = true;
      await svc.onPresence('g1', USER, ACTIVITY);
      expect(grant()).toMatchObject({ messageId: null });
      expect(env.roles.isLive('g1', USER)).toBe(true);
    });

    it('writes audit messages in the guild language', async () => {
      features({ language: 'en' });
      await svc.onPresence('g1', USER, ACTIVITY);
      expect(audits('presence.start')[0]!.message).toBe('Streamer 01 is streaming now on Twitch — from their Discord status');
    });

    it('gives the role but no extra post when a tracked account will announce the stream', async () => {
      await svc.onPresence('g1', USER, { ...ACTIVITY, url: 'https://www.twitch.tv/ABU_TW' });
      expect(grant()).not.toBeNull();
      expect(env.roles.isLive('g1', USER)).toBe(true);
      expect(env.notifier.presencePosts).toHaveLength(0);
    });

    it('still posts when the matching account has live notifications off or the platform is disabled', async () => {
      const account = env.repos.accounts.listForStreamer(streamerId)[0]!;
      env.repos.accounts.update(account.id, { notifyLive: false });
      await svc.onPresence('g1', USER, { ...ACTIVITY, url: 'https://twitch.tv/abu_tw' });
      expect(env.notifier.presencePosts).toHaveLength(1);

      svc.stop();
      env.repos.presence.delete('g1', USER);
      env.repos.accounts.update(account.id, { notifyLive: true });
      env.repos.settings.update('g1', { platformsEnabled: ['kick', 'youtube', 'tiktok'] });
      svc = make({ endDebounceMs: 0 });
      await svc.onPresence('g1', USER, { ...ACTIVITY, url: 'https://twitch.tv/abu_tw' });
      expect(env.notifier.presencePosts).toHaveLength(2);
    });

    it('treats any YouTube account as covering a YouTube presence (URLs rarely name the channel)', async () => {
      env.repos.accounts.create({ streamerId, channelId: env.repos.channels.upsertResolved(resolved('youtube', 'UC1', 'abu_yt')).id });
      await svc.onPresence('g1', USER, { url: 'https://www.youtube.com/watch?v=abc', platform: 'youtube', title: 'x', game: null });
      expect(grant()).not.toBeNull();
      expect(env.notifier.presencePosts).toHaveLength(0);
    });

    it('serializes concurrent events of the same member (one grant, one post)', async () => {
      await Promise.all([svc.onPresence('g1', USER, ACTIVITY), svc.onPresence('g1', USER, ACTIVITY), svc.onPresence('g1', USER, { ...ACTIVITY, title: 'x' })]);
      expect(env.notifier.presencePosts).toHaveLength(1);
      expect(grant()!.title).toBe('x');
    });
  });

  describe('end', () => {
    it('debounces flapping: an end followed by a start within 60s is ignored', async () => {
      await svc.onPresence('g1', USER, ACTIVITY);
      await svc.onPresence('g1', USER, null);
      expect(grant()).not.toBeNull();
      await vi.advanceTimersByTimeAsync(30_000);
      await svc.onPresence('g1', USER, ACTIVITY);
      await vi.advanceTimersByTimeAsync(60_000);
      await settle();
      expect(grant()).not.toBeNull();
      expect(env.roles.isLive('g1', USER)).toBe(true);
      expect(env.notifier.presenceEnds).toHaveLength(0);
      expect(env.notifier.presencePosts).toHaveLength(1);
    });

    it('ends the grant after the debounce: role removed, notification turned into "ended", audited', async () => {
      await svc.onPresence('g1', USER, ACTIVITY);
      changes.length = 0;
      await svc.onPresence('g1', USER, null);
      await vi.advanceTimersByTimeAsync(60_000);
      await settle();
      expect(grant()).toBeNull();
      expect(env.roles.isLive('g1', USER)).toBe(false);
      expect(env.notifier.presenceEnds).toHaveLength(1);
      const end = env.notifier.presenceEnds[0]!;
      expect(end.ref).toEqual(env.notifier.presencePosts[0]!.ref);
      expect(end.view).toMatchObject({ userId: USER, endedAt: new Date(T0 + 60_000).toISOString(), startedAt: new Date(T0).toISOString() });
      expect(audits('presence.end')[0]!.message).toBe('Streamer 01 وقف البث — حسب حالة ديسكورد');
      expect(svc.liveUserIds('g1').size).toBe(0);
      expect(changes).toEqual(['g1']);
    });

    it('ends immediately when the debounce is disabled', async () => {
      svc.stop();
      svc = make({ endDebounceMs: 0 });
      await svc.onPresence('g1', USER, ACTIVITY);
      await svc.onPresence('g1', USER, null);
      expect(grant()).toBeNull();
    });

    it('keeps the role when the member is live on a platform by then', async () => {
      await svc.onPresence('g1', USER, ACTIVITY);
      env.repos.sessions.create({ guildId: 'g1', streamerId, startedAt: new Date().toISOString() });
      await svc.onPresence('g1', USER, null);
      await vi.advanceTimersByTimeAsync(60_000);
      await settle();
      expect(grant()).toBeNull();
      expect(env.roles.isLive('g1', USER)).toBe(true);
      expect(env.roles.liveCalls.filter((c) => !c.live)).toHaveLength(0);
      expect(env.notifier.presenceEnds).toHaveLength(1);
    });

    it('survives a notification that is gone or an edit that throws', async () => {
      await svc.onPresence('g1', USER, ACTIVITY);
      env.notifier.deleted.add(grant()!.messageId!);
      await svc.onPresence('g1', USER, null);
      await vi.advanceTimersByTimeAsync(60_000);
      await settle();
      expect(env.notifier.presenceEnds[0]!.result).toBe(false);
      expect(grant()).toBeNull();

      await svc.onPresence('g1', USER, ACTIVITY);
      env.notifier.throwOnPresence = true;
      await svc.onPresence('g1', USER, null);
      await vi.advanceTimersByTimeAsync(60_000);
      await settle();
      expect(grant()).toBeNull();
      expect(env.roles.isLive('g1', USER)).toBe(false);
    });

    it('ends grants when the feature is turned off, with an explaining audit entry', async () => {
      await svc.onPresence('g1', USER, ACTIVITY);
      features({ presence: { enabled: false } });
      await svc.onPresence('g1', USER, { ...ACTIVITY, title: 'new' });
      expect(grant()).toBeNull();
      expect(env.roles.isLive('g1', USER)).toBe(false);
      expect(audits('presence.end')[0]!.message).toContain('كشف البث من حالة ديسكورد صار متوقف');
      // Members without a grant are simply ignored.
      await svc.onPresence('g1', OTHER, ACTIVITY);
      expect(env.roles.liveCalls).toHaveLength(2);
    });

    it('ends a grant when the member falls out of scope', async () => {
      await svc.onPresence('g1', USER, ACTIVITY);
      env.repos.streamers.update(streamerId, { enabled: false });
      await svc.onPresence('g1', USER, ACTIVITY);
      expect(grant()).toBeNull();
      expect(audits('presence.end')[0]!.message).toContain('ما عاد ضمن نطاق');
    });
  });

  describe('reconcile', () => {
    it('ends stale grants and starts missing ones from the current presences', async () => {
      features({ presence: { scope: 'everyone' } });
      await svc.onPresence('g1', USER, ACTIVITY);
      actions.setStreaming('g1', OTHER, { ...ACTIVITY, url: 'https://kick.com/visitor', platform: 'kick' });
      await svc.reconcile('g1');
      expect(grant()).toBeNull();
      expect(env.roles.isLive('g1', USER)).toBe(false);
      expect(grant(OTHER)).toMatchObject({ platform: 'kick' });
      expect(env.roles.isLive('g1', OTHER)).toBe(true);
    });

    it('changes nothing when the presences are unknown (Discord not ready)', async () => {
      await svc.onPresence('g1', USER, ACTIVITY);
      actions.presencesUnavailable = true;
      await svc.reconcile();
      expect(grant()).not.toBeNull();
      expect(actions.presenceCalls).toEqual(['g1']);
    });

    it('ends every grant when the bot runs without the Presence intent', async () => {
      await svc.onPresence('g1', USER, ACTIVITY);
      actions.presenceIntent = false;
      await svc.reconcile();
      expect(grant()).toBeNull();
      expect(env.roles.isLive('g1', USER)).toBe(false);
    });

    it('reconciles every guild with grants or the feature on (and survives a throwing lookup)', async () => {
      configureGuild(env.repos, 'g2', { features: { presence: { enabled: true, scope: 'everyone', notify: false } } });
      configureGuild(env.repos, 'g3');
      env.gateway.addMember('g2', OTHER, 'Visitor');
      actions.setStreaming('g2', OTHER, ACTIVITY);
      const original = actions.streamingPresences.bind(actions);
      vi.spyOn(actions, 'streamingPresences').mockImplementation(async (guildId) => {
        if (guildId === 'g1') throw new Error('boom');
        return original(guildId);
      });
      await svc.reconcile();
      expect(env.repos.presence.get('g2', OTHER)).not.toBeNull();
      expect(actions.presenceCalls).not.toContain('g3');
    });

    it('a presence event newer than the snapshot wins', async () => {
      let resolveSnapshot!: (value: Map<string, StreamingActivity>) => void;
      vi.spyOn(actions, 'streamingPresences').mockImplementation(() => new Promise((resolve) => (resolveSnapshot = resolve)));
      const reconcile = svc.reconcile('g1');
      await settle();
      await svc.onPresence('g1', USER, ACTIVITY);
      resolveSnapshot(new Map()); // taken before the member started streaming
      await reconcile;
      expect(grant()).not.toBeNull();
      expect(env.notifier.presencePosts).toHaveLength(1);
    });

    it('runs on start and periodically', async () => {
      svc.start();
      actions.setStreaming('g1', USER, ACTIVITY);
      await vi.advanceTimersByTimeAsync(15_000);
      await settle();
      expect(grant()).not.toBeNull();
      actions.setStreaming('g1', USER, null);
      await vi.advanceTimersByTimeAsync(5 * MIN);
      await settle();
      expect(grant()).toBeNull();
    });
  });

  describe('roles', () => {
    it('retries a transient role failure with the current desired state', async () => {
      env.roles.failLive = 1;
      actions.setStreaming('g1', USER, ACTIVITY);
      await svc.onPresence('g1', USER, ACTIVITY);
      expect(env.roles.isLive('g1', USER)).toBe(false);
      expect(grant()).not.toBeNull();
      await vi.advanceTimersByTimeAsync(MIN);
      await svc.periodic();
      expect(env.roles.isLive('g1', USER)).toBe(true);
      expect(env.roles.liveCalls).toHaveLength(2);
      await svc.periodic();
      expect(env.roles.liveCalls).toHaveLength(2);
    });

    it('gives up after a day with an audit warning', async () => {
      svc.stop();
      svc = make({ roleRetryDelaysMs: [MIN], roleRetryMaxAgeMs: 3 * MIN });
      env.roles.failLive = 100;
      actions.setStreaming('g1', USER, ACTIVITY);
      await svc.onPresence('g1', USER, ACTIVITY);
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(MIN);
        await svc.periodic();
      }
      expect(audits('presence.role_failed')).toHaveLength(1);
    });
  });

  describe('platform sessions', () => {
    it('re-checks a presence that outlives a just-ended platform session after the grace', async () => {
      svc.start();
      const ended = env.repos.sessions.create({ guildId: 'g1', streamerId, startedAt: new Date(T0 - 60 * MIN).toISOString() });
      env.repos.sessions.save({ ...ended, status: 'ended', endedAt: new Date(T0).toISOString() });
      actions.setStreaming('g1', USER, ACTIVITY);
      await svc.onPresence('g1', USER, ACTIVITY);
      expect(grant()).toBeNull(); // Discord status lagging behind the platform
      await vi.advanceTimersByTimeAsync(5 * MIN); // periodic reconciles do not start it during the grace either
      await settle();
      expect(grant()).toBeNull();
      await vi.advanceTimersByTimeAsync(5 * MIN + 2_000);
      await settle();
      expect(grant()).not.toBeNull();
      expect(env.roles.isLive('g1', USER)).toBe(true);
    });

    it('drops the re-check when the presence ends during the grace', async () => {
      svc.start();
      const ended = env.repos.sessions.create({ guildId: 'g1', streamerId, startedAt: new Date(T0 - 60 * MIN).toISOString() });
      env.repos.sessions.save({ ...ended, status: 'ended', endedAt: new Date(T0).toISOString() });
      await svc.onPresence('g1', USER, ACTIVITY);
      await svc.onPresence('g1', USER, null);
      await vi.advanceTimersByTimeAsync(11 * MIN);
      await settle();
      expect(grant()).toBeNull();
      expect(env.roles.liveCalls).toHaveLength(0);
    });

    it('works with the real SessionService: the role survives the session end while the presence goes on', async () => {
      const sessions = new SessionService({
        repos: env.repos,
        audit: env.audit,
        events: env.events,
        notifier: env.notifier,
        roles: env.roles,
        providers: env.providers,
        clock: () => Date.now(),
      });
      svc.stop();
      svc = new PresenceService({
        repos: env.repos,
        audit: env.audit,
        events: env.events,
        notifier: env.notifier,
        roles: env.roles,
        discord: actions,
        sessions,
        clock: () => Date.now(),
      });
      // Presence-only stream first, then the platform goes live too.
      await svc.onPresence('g1', USER, ACTIVITY);
      await sessions.onChannelLive(twitch, liveSnap(twitch, new FakeClock(Date.now())));
      expect(env.notifier.posts).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(30 * MIN);
      await sessions.onChannelOffline(twitch, null, new Date().toISOString());
      expect(env.roles.isLive('g1', USER)).toBe(true); // presence still on
      await sessions.syncRoles('g1', 'user:1');
      expect(env.roles.isLive('g1', USER)).toBe(true);
      await svc.onPresence('g1', USER, null);
      await vi.advanceTimersByTimeAsync(60_000);
      await settle();
      expect(env.roles.isLive('g1', USER)).toBe(false);
      sessions.stop();
    });
  });
});

describe('channelHandleFromUrl', () => {
  it('extracts the channel named by a stream URL', () => {
    expect(channelHandleFromUrl('https://www.twitch.tv/Abu_TW')).toBe('abu_tw');
    expect(channelHandleFromUrl('https://kick.com/abu/')).toBe('abu');
    expect(channelHandleFromUrl('https://www.tiktok.com/@abu/live')).toBe('abu');
    expect(channelHandleFromUrl('https://twitch.tv/')).toBeNull();
    expect(channelHandleFromUrl('not a url')).toBeNull();
    expect(channelHandleFromUrl(null)).toBeNull();
  });
});
