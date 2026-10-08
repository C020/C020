import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/logger.js', async () => {
  const { pino } = await import('pino');
  const logger = pino({ level: 'silent' });
  return { logger, childLogger: () => logger };
});

import type { SessionServiceApi } from '../../src/app/context.js';
import { ValidationError } from '../../src/core/errors.js';
import type { AppEventMap } from '../../src/core/events.js';
import type { GuildSettings, StreamerApplication } from '../../src/db/models.js';
import { ApplicationService, platformOfUrl } from '../../src/services/applicationService.js';
import type { MessageRef } from '../../src/services/ports.js';
import { StreamerService } from '../../src/services/streamerService.js';
import { configureGuild, createEnv, type Env, FakeDiscordActions, FakeProvider, resolved } from './helpers.js';

const GUILD = 'g1';
const USER = '100000000000000001';

class ReviewActions extends FakeDiscordActions {
  seq = 0;
  failReview = false;
  dmFails = false;
  readonly dmMessages: Array<{ userId: string; content: string; embedDescription?: string }> = [];
  override async upsertApplicationReview(app: StreamerApplication, settings: GuildSettings): Promise<MessageRef | null> {
    await super.upsertApplicationReview(app, settings);
    if (this.failReview) throw new Error('discord down');
    return { channelId: settings.features.applications.reviewChannelId ?? 'x', messageId: app.reviewMessageId ?? `rev-${++this.seq}` };
  }
  override async sendDirectMessage(userId: string, m: { content: string; embedDescription?: string }): Promise<boolean> {
    this.dmMessages.push({ userId, ...m });
    if (this.dmFails) throw new Error('closed');
    return true;
  }
}

describe('ApplicationService (#9)', () => {
  let env: Env;
  let actions: ReviewActions;
  let streamers: StreamerService;
  let svc: ApplicationService;
  let changes: AppEventMap['application.changed'][];

  beforeEach(() => {
    env = createEnv();
    configureGuild(env.repos, GUILD, { features: { applications: { enabled: true, reviewChannelId: 'review', dmApplicant: true } } });
    env.providers.map.set('twitch', new FakeProvider('twitch', { channels: { abu: resolved('twitch', 'tw1', 'abu') } }));
    env.providers.map.set('kick', new FakeProvider('kick', { channels: {} }));
    env.gateway.addMember(GUILD, USER, 'Abu');
    actions = new ReviewActions(env.gateway);
    const sessions = { endStreamerSession: async () => {} } as unknown as SessionServiceApi;
    streamers = new StreamerService({ repos: env.repos, audit: env.audit, providers: env.providers, discord: env.gateway, roles: env.roles, sessions, monitor: env.monitor });
    svc = new ApplicationService({ repos: env.repos, audit: env.audit, events: env.events, streamers, providers: env.providers, discord: actions, guildName: () => 'My Server' });
    changes = [];
    env.events.on('application.changed', (p) => changes.push(p));
  });

  const submit = (accounts = [{ platform: 'twitch' as const, input: 'abu' }, { platform: 'kick' as const, input: 'ghost' }], note: string | null = 'hi') =>
    svc.submit(GUILD, { userId: USER, username: 'abu_fahad', accounts, note });

  it('submits, posts the review message and emits an event', async () => {
    const app = await submit();
    expect(app.status).toBe('pending');
    expect(app.accounts).toEqual([{ platform: 'twitch', input: 'abu' }, { platform: 'kick', input: 'ghost' }]);
    expect(app.reviewChannelId).toBe('review');
    expect(app.reviewMessageId).toBe('rev-1');
    expect(changes).toEqual([{ guildId: GUILD, applicationId: app.id, status: 'pending' }]);
    expect(env.repos.audit.list({ guildId: GUILD, actionPrefix: 'application.submit' })).toHaveLength(1);
  });

  it('validates submissions (Arabic by default, English when configured)', async () => {
    await expect(submit([{ platform: 'twitch', input: '   ' }])).rejects.toThrow(/حساب واحد/);
    await expect(submit([{ platform: 'twitch', input: 'https://kick.com/abu' }])).rejects.toMatchObject({ field: 'accounts.twitch' });
    await expect(submit([{ platform: 'twitch', input: 'x'.repeat(201) }])).rejects.toThrow(ValidationError);
    await expect(submit([{ platform: 'twitch', input: 'abu' }], 'n'.repeat(501))).rejects.toMatchObject({ field: 'note' });
    env.repos.settings.update(GUILD, { features: { language: 'en' } });
    await expect(submit([])).rejects.toThrow(/at least one account/);
    env.repos.settings.update(GUILD, { features: { applications: { enabled: false } } });
    await expect(submit()).rejects.toThrow(/closed/);
  });

  it('rejects duplicate pending applications and registered members', async () => {
    await submit();
    await expect(submit()).rejects.toThrow(/قيد المراجعة/);
    env.repos.streamers.create({ guildId: GUILD, discordUserId: '100000000000000002', displayName: 'x' });
    await expect(svc.submit(GUILD, { userId: '100000000000000002', username: 'x', accounts: [{ platform: 'twitch', input: 'abu' }], note: null })).rejects.toThrow(/مسجّل/);
  });

  it('survives review message failures', async () => {
    actions.failReview = true;
    const app = await submit();
    expect(app.reviewMessageId).toBeNull();
  });

  it('approves tolerantly: skips unresolvable accounts, registers the streamer, DMs and audits', async () => {
    const app = await submit();
    const res = await svc.approve(GUILD, app.id, 'user:200000000000000001');
    expect(res.streamer.discordUserId).toBe(USER);
    expect(res.streamer.accounts.map((a) => a.channel.platform)).toEqual(['twitch']);
    expect(res.skipped).toMatchObject([{ platform: 'kick', input: 'ghost' }]);
    expect(res.application).toMatchObject({ status: 'approved', streamerId: res.streamer.id, reviewerId: '200000000000000001' });
    expect(res.application.decidedAt).not.toBeNull();
    expect(actions.dmMessages).toHaveLength(1);
    expect(actions.dmMessages[0]!.embedDescription).toContain('My Server');
    expect(changes.at(-1)).toMatchObject({ status: 'approved' });
    expect(env.repos.audit.list({ guildId: GUILD, actionPrefix: 'application.approve' })).toHaveLength(1);
    await expect(svc.approve(GUILD, app.id, 'user:2')).rejects.toThrow(/تمت مراجعته/);
  });

  it('approve with edited accounts; fails when none resolve', async () => {
    const app = await submit([{ platform: 'kick', input: 'ghost' }]);
    await expect(svc.approve(GUILD, app.id, 'user:2')).rejects.toThrow(ValidationError);
    expect(env.repos.applications.get(app.id)?.status).toBe('pending');
    const res = await svc.approve(GUILD, app.id, 'user:2', { accounts: [{ platform: 'twitch', input: 'abu' }] });
    expect(res.streamer.accounts).toHaveLength(1);
  });

  it('does not DM when disabled and tolerates DM failures', async () => {
    env.repos.settings.update(GUILD, { features: { applications: { dmApplicant: false } } });
    const app = await submit();
    await svc.reject(GUILD, app.id, 'user:2', 'no');
    expect(actions.dmMessages).toHaveLength(0);

    env.repos.settings.update(GUILD, { features: { applications: { dmApplicant: true } } });
    actions.dmFails = true;
    const again = await submit();
    const rejected = await svc.reject(GUILD, again.id, 'user:2', 'Not enough followers');
    expect(rejected).toMatchObject({ status: 'rejected', reviewNote: 'Not enough followers' });
    expect(actions.dmMessages[0]!.embedDescription).toContain('Not enough followers');
  });

  it('cancel withdraws a pending application; get checks the guild', async () => {
    const app = await submit();
    expect(await svc.cancel(GUILD, USER)).toBe(true);
    expect(await svc.cancel(GUILD, USER)).toBe(false);
    expect(svc.get(GUILD, app.id).status).toBe('cancelled');
    expect(() => svc.get('other', app.id)).toThrow(ValidationError);
    expect(svc.list(GUILD, { status: 'cancelled' })).toHaveLength(1);
  });

  it('guards concurrent decisions', async () => {
    const app = await submit();
    const [a, b] = await Promise.allSettled([svc.approve(GUILD, app.id, 'user:2'), svc.reject(GUILD, app.id, 'user:3')]);
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
  });

  it('platformOfUrl', () => {
    expect(platformOfUrl('https://www.twitch.tv/abu')).toBe('twitch');
    expect(platformOfUrl('kick.com/abu')).toBe('kick');
    expect(platformOfUrl('youtu.be/xyz')).toBe('youtube');
    expect(platformOfUrl('https://www.tiktok.com/@abu')).toBe('tiktok');
    expect(platformOfUrl('abu')).toBeNull();
    expect(platformOfUrl('@abu.tv')).toBeNull();
  });
});
