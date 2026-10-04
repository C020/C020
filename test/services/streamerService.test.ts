import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/logger.js', async () => {
  const { pino } = await import('pino');
  const logger = pino({ level: 'silent' });
  return { logger, childLogger: () => logger };
});

import { ChannelNotFoundError, ProviderError, RateLimitedError, ValidationError } from '../../src/core/errors.js';
import type { CreateStreamerRequest } from '../../src/shared/api.js';
import { SessionService } from '../../src/services/sessionService.js';
import { sanitizeAccountInput, StreamerService } from '../../src/services/streamerService.js';
import { configureGuild, createEnv, type Env, FakeProvider, liveSnap, MIN, resolved } from './helpers.js';

const USER = '100000000000000001';
const GUILD = 'g1';

async function expectValidation(promise: Promise<unknown>, field?: string, text?: RegExp): Promise<ValidationError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ValidationError);
  const v = err as ValidationError;
  if (field !== undefined) expect(v.field).toBe(field);
  if (text) expect(v.message).toMatch(text);
  return v;
}

describe('StreamerService', () => {
  let env: Env;
  let sessions: SessionService;
  let svc: StreamerService;

  beforeEach(() => {
    env = createEnv();
    configureGuild(env.repos, GUILD);
    env.providers.map.set(
      'twitch',
      new FakeProvider('twitch', { channels: { abu: resolved('twitch', 'tw1', 'abu'), other: resolved('twitch', 'tw2', 'other') } }),
    );
    env.providers.map.set('kick', new FakeProvider('kick', { channels: { abu: resolved('kick', 'k1', 'abu') } }));
    env.providers.map.set('youtube', new FakeProvider('youtube', { configured: false }));
    env.gateway.addMember(GUILD, USER, 'Abu Fahad');
    sessions = new SessionService({
      repos: env.repos,
      audit: env.audit,
      events: env.events,
      notifier: env.notifier,
      roles: env.roles,
      providers: env.providers,
      clock: env.clock.fn,
    });
    svc = new StreamerService({
      repos: env.repos,
      audit: env.audit,
      providers: env.providers,
      discord: env.gateway,
      roles: env.roles,
      sessions,
      monitor: env.monitor,
    });
  });

  afterEach(() => sessions.stop());

  const request = (overrides: Partial<CreateStreamerRequest> = {}): CreateStreamerRequest => ({
    discordUserId: USER,
    accounts: [
      { platform: 'twitch', input: '@Abu' },
      { platform: 'kick', input: 'abu', notifyContent: false, contentKinds: ['clip', 'vod', 'clip'] },
    ],
    ...overrides,
  });

  describe('create', () => {
    it('registers the streamer with resolved accounts, role, audit and monitor notification', async () => {
      const st = await svc.create(GUILD, request(), 'user:9');

      expect(st.displayName).toBe('Abu Fahad');
      expect(st.accounts.map((a) => [a.channel.platform, a.channel.platformId])).toEqual([
        ['kick', 'k1'],
        ['twitch', 'tw1'],
      ]);
      const kick = st.accounts.find((a) => a.channel.platform === 'kick')!;
      expect(kick.notifyContent).toBe(false);
      expect(kick.contentKinds).toEqual(['vod', 'clip']);
      expect(env.roles.streamerCalls).toEqual([{ guildId: GUILD, userId: USER, isStreamer: true }]);
      expect(env.monitor.changed).toBe(1);
      expect(env.monitor.checks.sort()).toEqual(st.accounts.map((a) => a.channelId).sort());
      const audit = env.repos.audit.list({ guildId: GUILD, actionPrefix: 'streamer.create' })[0]!;
      expect(audit.actor).toBe('user:9');
      expect(svc.list(GUILD)).toHaveLength(1);
    });

    it('validates the Discord id, membership, bots and duplicates', async () => {
      await expectValidation(svc.create(GUILD, request({ discordUserId: '12ab' }), 'u'), 'discordUserId');
      await expectValidation(svc.create(GUILD, request({ discordUserId: '100000000000000099' }), 'u'), 'discordUserId', /مو موجود/);

      env.gateway.addMember(GUILD, '100000000000000002', 'Bot', true);
      await expectValidation(svc.create(GUILD, request({ discordUserId: '100000000000000002' }), 'u'), 'discordUserId', /بوت/);

      await svc.create(GUILD, request(), 'u');
      await expectValidation(svc.create(GUILD, request(), 'u'), 'discordUserId', /من قبل/);
    });

    it('allows registration when the gateway is not ready (no member check)', async () => {
      env.gateway.ready = false;
      const st = await svc.create(GUILD, request({ discordUserId: '100000000000000055', displayName: '  Custom  Name ' }), 'u');
      expect(st.displayName).toBe('Custom Name');

      env.gateway.ready = true;
      env.gateway.failLookup = true;
      const other = await svc.create(GUILD, request({ discordUserId: '100000000000000056', accounts: [{ platform: 'twitch', input: 'other' }] }), 'u');
      expect(other.displayName).toBe('OTHER'); // falls back to the channel display name
    });

    it('requires at least one valid account', async () => {
      await expectValidation(svc.create(GUILD, request({ accounts: [] }), 'u'), 'accounts');
      await expectValidation(svc.create(GUILD, request({ accounts: [{ platform: 'myspace' as 'twitch', input: 'x' }] }), 'u'), 'accounts.0.platform');
      await expectValidation(svc.create(GUILD, request({ accounts: [{ platform: 'twitch', input: '   ' }] }), 'u'), 'accounts.0.input');
      await expectValidation(
        svc.create(GUILD, request({ accounts: [{ platform: 'twitch', input: 'abu', contentKinds: ['podcast' as 'clip'] }] }), 'u'),
        'accounts.0.contentKinds',
      );
      expect(env.repos.streamers.list(GUILD)).toHaveLength(0);
    });

    it('explains which env keys are missing for an unconfigured provider', async () => {
      const err = await expectValidation(
        svc.create(GUILD, request({ accounts: [{ platform: 'twitch', input: 'abu' }, { platform: 'youtube', input: '@abu' }] }), 'u'),
        'accounts.1.platform',
      );
      expect(err.message).toContain('YOUTUBE_API_KEY');
      expect(env.repos.streamers.list(GUILD)).toHaveLength(0);
    });

    it('maps provider failures to field-specific Arabic errors', async () => {
      await expectValidation(svc.create(GUILD, request({ accounts: [{ platform: 'twitch', input: 'ghost' }] }), 'u'), 'accounts.0.input', /ما لقيت/);

      env.providers.get('kick').options.resolveError = new RateLimitedError('kick', 12_000);
      await expectValidation(svc.create(GUILD, request({ accounts: [{ platform: 'kick', input: 'abu' }] }), 'u'), 'accounts.0.input', /12 ثانية/);

      env.providers.get('kick').options.resolveError = new ProviderError('kick', 'HTTP 503');
      await expectValidation(svc.create(GUILD, request({ accounts: [{ platform: 'kick', input: 'abu' }] }), 'u'), 'accounts.0.input', /جرّب بعد شوي/);

      env.providers.get('kick').options.resolveError = new ValidationError('رابط كيك غير صالح', 'input');
      await expectValidation(svc.create(GUILD, request({ accounts: [{ platform: 'kick', input: 'abu' }] }), 'u'), 'accounts.0.input', /رابط كيك/);
    });

    it('rejects the same channel twice (even when entered differently)', async () => {
      env.providers.get('twitch').options.channels!['https://twitch.tv/abu'] = resolved('twitch', 'tw1', 'abu');
      await expectValidation(
        svc.create(GUILD, request({ accounts: [{ platform: 'twitch', input: 'abu' }, { platform: 'twitch', input: 'https://twitch.tv/ABU' }] }), 'u'),
        'accounts.1.input',
        /مكرر/,
      );
    });

    it('does not touch the streamer role when autoStreamerRole is off', async () => {
      env.repos.settings.update(GUILD, { options: { autoStreamerRole: false } });
      await svc.create(GUILD, request(), 'u');
      expect(env.roles.streamerCalls).toHaveLength(0);
    });
  });

  describe('update / delete', () => {
    it('disabling ends the live session and removes both roles; enabling restores the streamer role', async () => {
      const st = await svc.create(GUILD, request(), 'u');
      const twitch = st.accounts.find((a) => a.channel.platform === 'twitch')!.channel;
      await sessions.onChannelLive(twitch, liveSnap(twitch, env.clock));
      expect(env.roles.isLive(GUILD, USER)).toBe(true);

      env.clock.advance(10 * MIN);
      const disabled = await svc.update(GUILD, st.id, { enabled: false }, 'u');
      expect(disabled.enabled).toBe(false);
      expect(env.repos.sessions.getActive(st.id)).toBeNull();
      expect(env.notifier.summaries).toHaveLength(1);
      expect(env.roles.isLive(GUILD, USER)).toBe(false);
      expect(env.roles.streamer.get(`${GUILD}:${USER}`)).toBe(false);

      // Events for a disabled streamer are ignored.
      await sessions.onChannelUpdate(twitch, liveSnap(twitch, env.clock), { streamChanged: false });
      expect(env.repos.sessions.getActive(st.id)).toBeNull();

      await svc.update(GUILD, st.id, { enabled: true, displayName: 'أبو فهد' }, 'u');
      expect(env.roles.streamer.get(`${GUILD}:${USER}`)).toBe(true);
      expect(svc.get(GUILD, st.id).displayName).toBe('أبو فهد');
    });

    it('validates patches', async () => {
      const st = await svc.create(GUILD, request(), 'u');
      await expectValidation(svc.update(GUILD, st.id, { displayName: '' }, 'u'), 'displayName');
      await expectValidation(svc.update(GUILD, st.id, { color: 0x1000000 }, 'u'), 'color');
      await expectValidation(svc.update(GUILD, st.id, { notes: 'x'.repeat(501) }, 'u'), 'notes');
      await expectValidation(svc.update('other-guild', st.id, { notes: null }, 'u'), 'streamerId');
    });

    it('delete ends the session, removes roles, deletes orphan channels and notifies the monitor', async () => {
      const st = await svc.create(GUILD, request(), 'u');
      const twitch = st.accounts.find((a) => a.channel.platform === 'twitch')!.channel;
      await sessions.onChannelLive(twitch, liveSnap(twitch, env.clock));
      const changedBefore = env.monitor.changed;

      await svc.delete(GUILD, st.id, 'u');

      expect(env.notifier.summaries).toHaveLength(1);
      expect(env.roles.isLive(GUILD, USER)).toBe(false);
      expect(env.roles.streamer.get(`${GUILD}:${USER}`)).toBe(false);
      expect(env.repos.streamers.get(st.id)).toBeNull();
      expect(env.repos.channels.listAll()).toHaveLength(0);
      expect(env.monitor.changed).toBe(changedBefore + 1);
      expect(env.repos.audit.list({ guildId: GUILD, actionPrefix: 'streamer.delete' })).toHaveLength(1);
    });

    it('delete warns in the audit log when the live role could not be removed (Discord hiccup)', async () => {
      const st = await svc.create(GUILD, request(), 'u');
      // Reconciles only take the live role from registered streamers, so after the delete nobody retries it.
      vi.spyOn(env.roles, 'setLive').mockImplementation((async () => 'transient') as never);

      await svc.delete(GUILD, st.id, 'user:9');
      const warn = env.repos.audit.list({ guildId: GUILD }).filter((e) => e.action === 'discord.roles' && e.level === 'warn');
      expect(warn).toHaveLength(1);
      expect(warn[0]!.message).toContain('رتبة البث المباشر');
      expect(warn[0]!.actor).toBe('user:9');
    });

    it('delete does not warn when the live role change went through or was not needed', async () => {
      const st = await svc.create(GUILD, request(), 'u');
      vi.spyOn(env.roles, 'setLive').mockImplementation((async () => 'noop') as never);
      await svc.delete(GUILD, st.id, 'u');
      expect(env.repos.audit.list({ guildId: GUILD }).filter((e) => e.action === 'discord.roles')).toHaveLength(0);
    });

    it('keeps the streamer role on delete when removeStreamerRoleOnDelete is off, and keeps shared channels', async () => {
      env.repos.settings.update(GUILD, { options: { removeStreamerRoleOnDelete: false } });
      const st = await svc.create(GUILD, request(), 'u');
      env.gateway.addMember(GUILD, '100000000000000002', 'Partner');
      await svc.create(GUILD, request({ discordUserId: '100000000000000002', accounts: [{ platform: 'twitch', input: 'abu' }] }), 'u');

      await svc.delete(GUILD, st.id, 'u');
      expect(env.roles.streamerCalls.filter((c) => !c.isStreamer)).toHaveLength(0);
      expect(env.repos.channels.listAll().map((c) => c.platformId)).toEqual(['tw1']);
    });
  });

  describe('accounts', () => {
    it('adds, updates and removes accounts with ownership checks', async () => {
      const st = await svc.create(GUILD, request({ accounts: [{ platform: 'twitch', input: 'abu' }] }), 'u');
      const added = await svc.addAccount(GUILD, st.id, { platform: 'kick', input: 'abu' }, 'u');
      expect(added.accounts).toHaveLength(2);
      const kick = added.accounts.find((a) => a.channel.platform === 'kick')!;
      expect(env.monitor.checks).toContain(kick.channelId);

      await expectValidation(svc.addAccount(GUILD, st.id, { platform: 'kick', input: 'abu' }, 'u'), 'input', /من قبل/);

      const updated = await svc.updateAccount(GUILD, st.id, kick.id, { notifyLive: false, contentKinds: null }, 'u');
      expect(updated.accounts.find((a) => a.id === kick.id)!.notifyLive).toBe(false);

      env.gateway.addMember(GUILD, '100000000000000002', 'Other');
      const other = await svc.create(GUILD, request({ discordUserId: '100000000000000002', accounts: [{ platform: 'twitch', input: 'other' }] }), 'u');
      await expectValidation(svc.updateAccount(GUILD, other.id, kick.id, { notifyLive: true }, 'u'), 'accountId');
      await expectValidation(svc.removeAccount(GUILD, other.id, kick.id, 'u'), 'accountId');

      const removed = await svc.removeAccount(GUILD, st.id, kick.id, 'u');
      expect(removed.accounts.map((a) => a.channel.platform)).toEqual(['twitch']);
      expect(env.repos.channels.getByPlatformId('kick', 'k1')).toBeNull();
    });

    it('removing the only live platform ends the session properly', async () => {
      const st = await svc.create(GUILD, request(), 'u');
      const twitch = st.accounts.find((a) => a.channel.platform === 'twitch')!;
      await sessions.onChannelLive(twitch.channel, liveSnap(twitch.channel, env.clock));
      env.clock.advance(5 * MIN);
      await svc.removeAccount(GUILD, st.id, twitch.id, 'u');
      expect(env.repos.sessions.getActive(st.id)).toBeNull();
      expect(env.notifier.summaries).toHaveLength(1);
      expect(env.roles.isLive(GUILD, USER)).toBe(false);
    });
  });

  describe('resolve / checkNow', () => {
    it('sanitizes input before resolving', async () => {
      const result = await svc.resolve('twitch', '‏ @abu ‎');
      expect(result.platformId).toBe('tw1');
      expect(env.providers.get('twitch').resolveInputs.at(-1)).toBe('@abu');
    });

    it('keeps ChannelNotFoundError for the preview endpoint and validates platform/input', async () => {
      await expect(svc.resolve('twitch', 'ghost')).rejects.toBeInstanceOf(ChannelNotFoundError);
      await expectValidation(svc.resolve('nope' as 'twitch', 'abu'), 'platform');
      await expectValidation(svc.resolve('youtube', 'abu'), 'platform', /YOUTUBE_API_KEY/);
      await expectValidation(svc.resolve('twitch', 'a'.repeat(301)), 'input');
    });

    it('sanitizeAccountInput strips bidi/zero-width characters and collapses whitespace', () => {
      expect(sanitizeAccountInput('﻿ https://kick.com/abu​  ')).toBe('https://kick.com/abu');
      expect(() => sanitizeAccountInput(42)).toThrow(ValidationError);
    });

    it('checkNow asks the monitor to check every account channel', async () => {
      const st = await svc.create(GUILD, request(), 'u');
      env.monitor.checks.length = 0;
      svc.checkNow(GUILD, st.id);
      expect(env.monitor.checks.sort()).toEqual(st.accounts.map((a) => a.channelId).sort());
      expect(() => svc.checkNow('other', st.id)).toThrow(ValidationError);
    });
  });
});
