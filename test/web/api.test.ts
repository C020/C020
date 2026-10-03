import { afterEach, describe, expect, it } from 'vitest';
import { ChannelNotFoundError, ProviderError, ProviderNotConfiguredError, RateLimitedError, ValidationError } from '../../src/core/errors.js';
import type { LiveSnapshot, ResolvedChannel } from '../../src/core/types.js';
import type { SummaryView } from '../../src/services/ports.js';
import type { WebServer } from '../../src/web/server.js';
import { CHANNEL_A, createEnv, FakeProviders, fakeProvider, GUILD, login, MEMBER, OTHER_GUILD, ROLE_A, ROLE_B, startServer, type Login, type TestEnv } from './helpers.js';

let server: WebServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

async function setup(env: TestEnv = createEnv()): Promise<{ env: TestEnv; s: WebServer; auth: Login }> {
  server = await startServer(env);
  return { env, s: server, auth: login(env) };
}

const base = `/api/guilds/${GUILD}`;

function resolved(platform: ResolvedChannel['platform'], handle: string): ResolvedChannel {
  return { platform, platformId: `${platform}-${handle}`, handle, displayName: handle.toUpperCase(), avatarUrl: `https://img.example.com/${handle}.png`, url: `https://${platform}.tv/${handle}`, meta: {} };
}

function seedStreamer(env: TestEnv, discordUserId = MEMBER, guildId = GUILD) {
  const streamer = env.repos.streamers.create({ guildId, discordUserId, displayName: 'Abu Fahad' });
  const channel = env.repos.channels.upsertResolved(resolved('twitch', `abufahad${streamer.id}`));
  const account = env.repos.accounts.create({ streamerId: streamer.id, channelId: channel.id });
  return { streamer, channel, account };
}

describe('settings', () => {
  it('GET returns defaults for a new guild', async () => {
    const { s, auth } = await setup();
    const res = await s.app.inject({ method: 'GET', url: `${base}/settings`, headers: auth.headers });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ guildId: GUILD, pingMode: 'none', liveRoleId: null, platformsEnabled: ['twitch', 'kick', 'youtube', 'tiktok'] });
    expect(body.options.reconnectMergeMinutes).toBe(10);
    expect(body).not.toHaveProperty('createdAt');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('PUT validates snowflakes and reports the field', async () => {
    const { s, auth } = await setup();
    const res = await s.app.inject({ method: 'PUT', url: `${base}/settings`, headers: auth.headers, payload: { liveRoleId: '12345' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'validation', field: 'liveRoleId' });
    expect(res.json().message).toContain('17');
  });

  it('PUT rejects bad option ranges, unknown enums and same role twice', async () => {
    const { s, auth } = await setup();
    const cases: Array<[unknown, string]> = [
      [{ options: { liveUpdateMinutes: 500 } }, 'options.liveUpdateMinutes'],
      [{ pingMode: 'loud' }, 'pingMode'],
      [{ platformsEnabled: ['twitch', 'myspace'] }, 'platformsEnabled.1'],
      [{ streamerRoleId: ROLE_A, liveRoleId: ROLE_A }, 'liveRoleId'],
      [{ pingMode: 'role' }, 'pingRoleId'],
      [{ liveRoleId: GUILD }, 'liveRoleId'],
      [{ templates: { live: { title: 'x'.repeat(300) } } }, 'templates.live.title'],
    ];
    for (const [payload, field] of cases) {
      const res = await s.app.inject({ method: 'PUT', url: `${base}/settings`, headers: auth.headers, payload: payload as object });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().field).toBe(field);
      expect(res.json().message).toMatch(/[؀-ۿ]/);
    }
  });

  it('PUT checks that roles/channels exist in the guild when Discord is ready', async () => {
    const { s, auth } = await setup();
    const unknownRole = await s.app.inject({ method: 'PUT', url: `${base}/settings`, headers: auth.headers, payload: { liveRoleId: '700000000000000009' } });
    expect(unknownRole.statusCode).toBe(400);
    expect(unknownRole.json().field).toBe('liveRoleId');
    const unknownChannel = await s.app.inject({ method: 'PUT', url: `${base}/settings`, headers: auth.headers, payload: { liveChannelId: '800000000000000009' } });
    expect(unknownChannel.statusCode).toBe(400);
    expect(unknownChannel.json().field).toBe('liveChannelId');
  });

  it('PUT saves, merges templates, audits with the user actor and notifies monitor/roles', async () => {
    const { env, s, auth } = await setup();
    env.repos.settings.update(GUILD, { templates: { content: { title: 'محتوى' } } });
    const res = await s.app.inject({
      method: 'PUT',
      url: `${base}/settings`,
      headers: auth.headers,
      payload: {
        guildId: 'ignored',
        updatedAt: 'ignored',
        liveRoleId: ROLE_B,
        streamerRoleId: ROLE_A,
        liveChannelId: CHANNEL_A,
        contentChannelId: '',
        platformsEnabled: ['twitch', 'kick', 'kick'],
        templates: { live: { title: '{name} يبث!', description: '' } },
        options: { reconnectMergeMinutes: 15 },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ liveRoleId: ROLE_B, streamerRoleId: ROLE_A, liveChannelId: CHANNEL_A, contentChannelId: null, platformsEnabled: ['twitch', 'kick'] });
    expect(body.templates).toEqual({ live: { title: '{name} يبث!' }, content: { title: 'محتوى' } });
    expect(body.options.reconnectMergeMinutes).toBe(15);
    expect(body.options.liveUpdateMinutes).toBe(5);

    const stored = env.repos.settings.get(GUILD);
    expect(stored.liveRoleId).toBe(ROLE_B);

    const audit = env.repos.audit.list({ guildId: GUILD, actionPrefix: 'settings.' });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor).toBe('user:444444444444444444');
    expect(audit[0]!.message).toContain('رتبة البث المباشر');
    expect((audit[0]!.details.changes as Record<string, unknown>).liveRoleId).toEqual({ from: null, to: ROLE_B });

    expect(env.monitor.channelsChanged).toHaveBeenCalledTimes(1);
    expect(env.sessions.syncRoles).toHaveBeenCalledWith(GUILD, 'user:444444444444444444');
  });

  it('PUT with no effective change does not audit or notify', async () => {
    const { env, s, auth } = await setup();
    const res = await s.app.inject({ method: 'PUT', url: `${base}/settings`, headers: auth.headers, payload: { pingMode: 'none', platformsEnabled: ['tiktok', 'youtube', 'kick', 'twitch'] } });
    expect(res.statusCode).toBe(200);
    expect(env.repos.audit.list({ guildId: GUILD, actionPrefix: 'settings.' })).toHaveLength(0);
    expect(env.monitor.channelsChanged).not.toHaveBeenCalled();
  });

  it('PUT changing only a template does not touch the monitor or roles', async () => {
    const { env, s, auth } = await setup();
    const res = await s.app.inject({ method: 'PUT', url: `${base}/settings`, headers: auth.headers, payload: { templates: { summary: { color: 0xff0000 } } } });
    expect(res.statusCode).toBe(200);
    expect(env.monitor.channelsChanged).not.toHaveBeenCalled();
    expect(env.sessions.syncRoles).not.toHaveBeenCalled();
  });

  it('accepts bodiless requests sent with a JSON content type, but still blocks prototype poisoning', async () => {
    const { env, s, auth } = await setup();
    const { streamer } = seedStreamer(env);
    const json = { ...auth.headers, 'content-type': 'application/json' };
    const del = await s.app.inject({ method: 'DELETE', url: `${base}/streamers/${streamer.id}`, headers: json, payload: '' });
    expect(del.statusCode).toBe(200);
    const sync = await s.app.inject({ method: 'POST', url: `${base}/sync-roles`, headers: json });
    expect(sync.statusCode).toBe(200);
    const poisoned = await s.app.inject({ method: 'PUT', url: `${base}/settings`, headers: json, payload: '{"__proto__":{"admin":true}}' });
    expect(poisoned.statusCode).toBe(400);
  });

  it('rejects invalid JSON with a 400', async () => {
    const { s, auth } = await setup();
    const res = await s.app.inject({ method: 'PUT', url: `${base}/settings`, headers: { ...auth.headers, 'content-type': 'application/json' }, payload: '{bad json' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad_request');
  });
});

describe('streamers', () => {
  it('POST creates through ctx.streamers.create with the actor and returns 201 + DTO', async () => {
    const { env, s, auth } = await setup();
    env.discord.addMember(GUILD, MEMBER, 'Abu Fahad');
    const res = await s.app.inject({
      method: 'POST',
      url: `${base}/streamers`,
      headers: auth.headers,
      payload: { discordUserId: ` ${MEMBER} `, displayName: 'أبو فهد', accounts: [{ platform: 'kick', input: '@abufahad', notifyContent: false }] },
    });
    expect(res.statusCode).toBe(201);
    expect(env.streamers.create).toHaveBeenCalledWith(
      GUILD,
      { discordUserId: MEMBER, displayName: 'أبو فهد', accounts: [{ platform: 'kick', input: '@abufahad', notifyContent: false }] },
      'user:444444444444444444',
    );
    const body = res.json();
    expect(body).toMatchObject({ discordUserId: MEMBER, displayName: 'أبو فهد', inGuild: true, isLive: false, enabled: true, accounts: [] });
    expect(body.avatarUrl).toBe(`https://cdn.discordapp.com/avatars/${MEMBER}/a.png`);
    expect(body.stats).toEqual({ sessions30d: 0, hours30d: 0, peakViewers30d: 0 });
  });

  it('POST rejects bad input before calling the service', async () => {
    const { env, s, auth } = await setup();
    const res = await s.app.inject({ method: 'POST', url: `${base}/streamers`, headers: auth.headers, payload: { discordUserId: 'abc', accounts: [] } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'validation', field: 'discordUserId' });
    const res2 = await s.app.inject({ method: 'POST', url: `${base}/streamers`, headers: auth.headers, payload: { discordUserId: MEMBER, accounts: [{ platform: 'myspace', input: 'x' }] } });
    expect(res2.json()).toMatchObject({ error: 'validation', field: 'accounts.0.platform' });
    expect(env.streamers.create).not.toHaveBeenCalled();
  });

  it('maps service ValidationError to 400 with field', async () => {
    const { env, s, auth } = await setup();
    env.streamers.create.mockRejectedValueOnce(new ValidationError('هذا العضو مسجّل كستريمر من قبل', 'discordUserId'));
    const res = await s.app.inject({ method: 'POST', url: `${base}/streamers`, headers: auth.headers, payload: { discordUserId: MEMBER, accounts: [{ platform: 'twitch', input: 'x' }] } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'validation', message: 'هذا العضو مسجّل كستريمر من قبل', field: 'discordUserId' });
  });

  it('maps unknown errors to 500 internal without leaking details', async () => {
    const { env, s, auth } = await setup();
    env.streamers.create.mockRejectedValueOnce(new Error('SQLITE_BUSY: secret path /data/bot.db'));
    const res = await s.app.inject({ method: 'POST', url: `${base}/streamers`, headers: auth.headers, payload: { discordUserId: MEMBER, accounts: [] } });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('internal');
    expect(res.body).not.toContain('SQLITE');
  });

  it('lists streamers with accounts, live state, Discord avatar and 30-day stats', async () => {
    const { env, s, auth } = await setup();
    const { streamer, channel } = seedStreamer(env);
    seedStreamer(env, '666666666666666667', OTHER_GUILD);
    env.discord.addMember(GUILD, MEMBER, 'Abu Fahad');
    const snapshot: LiveSnapshot = {
      platform: 'twitch', platformId: channel.platformId, isLive: true, streamId: 's1', title: 'رانكد', category: 'Valorant', categoryImageUrl: null,
      thumbnailUrl: null, viewers: 50, startedAt: new Date().toISOString(), url: channel.url, language: 'ar', tags: [],
    };
    env.repos.channels.saveLiveState(channel.id, { isLive: true, snapshot, liveSince: new Date().toISOString(), offlineSince: null, missCount: 0 });
    const session = env.repos.sessions.create({ guildId: GUILD, streamerId: streamer.id, startedAt: new Date(Date.now() - 2 * 3600_000).toISOString() });
    env.repos.sessions.save({ ...session, peakViewers: 80 });

    const res = await s.app.inject({ method: 'GET', url: `${base}/streamers`, headers: auth.headers });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: streamer.id, isLive: true, inGuild: true, avatarUrl: `https://cdn.discordapp.com/avatars/${MEMBER}/a.png` });
    expect(list[0].accounts[0]).toMatchObject({ platform: 'twitch', channelId: channel.id, isLive: true, notifyLive: true, contentKinds: null });
    expect(list[0].accounts[0].snapshot.title).toBe('رانكد');
    expect(list[0].stats.sessions30d).toBe(1);
    expect(list[0].stats.peakViewers30d).toBe(80);
    expect(list[0].stats.hours30d).toBeCloseTo(2, 1);
  });

  it('caches member lookups between requests', async () => {
    const { env, s, auth } = await setup();
    seedStreamer(env);
    env.discord.addMember(GUILD, MEMBER, 'Abu Fahad');
    await s.app.inject({ method: 'GET', url: `${base}/streamers`, headers: auth.headers });
    await s.app.inject({ method: 'GET', url: `${base}/streamers`, headers: auth.headers });
    expect(env.discord.fetchMember).toHaveBeenCalledTimes(1);
  });

  it('falls back to the channel avatar and inGuild=null when Discord lookups fail', async () => {
    const { env, s, auth } = await setup();
    const { streamer } = seedStreamer(env);
    env.discord.fetchMember.mockRejectedValue(new Error('gateway timeout'));
    const res = await s.app.inject({ method: 'GET', url: `${base}/streamers/${streamer.id}`, headers: auth.headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ inGuild: null, avatarUrl: `https://img.example.com/abufahad${streamer.id}.png` });
  });

  it('returns 404 for streamers of another guild or unknown accounts', async () => {
    const { env, s, auth } = await setup();
    const foreign = seedStreamer(env, MEMBER, OTHER_GUILD);
    const own = seedStreamer(env, '666666666666666668');
    const res = await s.app.inject({ method: 'GET', url: `${base}/streamers/${foreign.streamer.id}`, headers: auth.headers });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found' });
    const del = await s.app.inject({ method: 'DELETE', url: `${base}/streamers/${foreign.streamer.id}`, headers: auth.headers });
    expect(del.statusCode).toBe(404);
    expect(env.streamers.delete).not.toHaveBeenCalled();
    const acc = await s.app.inject({ method: 'DELETE', url: `${base}/streamers/${own.streamer.id}/accounts/${foreign.account.id}`, headers: auth.headers });
    expect(acc.statusCode).toBe(404);
    expect(env.streamers.removeAccount).not.toHaveBeenCalled();
  });

  it('PATCH, DELETE, account routes and check go through the service', async () => {
    const { env, s, auth } = await setup();
    const { streamer, account } = seedStreamer(env);
    const actor = 'user:444444444444444444';

    const patch = await s.app.inject({ method: 'PATCH', url: `${base}/streamers/${streamer.id}`, headers: auth.headers, payload: { enabled: false, displayName: ' جديد ' } });
    expect(patch.statusCode).toBe(200);
    expect(env.streamers.update).toHaveBeenCalledWith(GUILD, streamer.id, { enabled: false, displayName: 'جديد' }, actor);
    expect(patch.json().enabled).toBe(false);

    const add = await s.app.inject({ method: 'POST', url: `${base}/streamers/${streamer.id}/accounts`, headers: auth.headers, payload: { platform: 'youtube', input: '@abufahad' } });
    expect(add.statusCode).toBe(200);
    expect(env.streamers.addAccount).toHaveBeenCalledWith(GUILD, streamer.id, { platform: 'youtube', input: '@abufahad' }, actor);

    const upd = await s.app.inject({
      method: 'PATCH',
      url: `${base}/streamers/${streamer.id}/accounts/${account.id}`,
      headers: auth.headers,
      payload: { notifyContent: false, contentKinds: ['clip', 'clip', 'vod'] },
    });
    expect(upd.statusCode).toBe(200);
    expect(env.streamers.updateAccount).toHaveBeenCalledWith(GUILD, streamer.id, account.id, { notifyContent: false, contentKinds: ['clip', 'vod'] }, actor);

    const check = await s.app.inject({ method: 'POST', url: `${base}/streamers/${streamer.id}/check`, headers: auth.headers });
    expect(check.json()).toEqual({ ok: true });
    expect(env.streamers.checkNow).toHaveBeenCalledWith(GUILD, streamer.id);

    const rm = await s.app.inject({ method: 'DELETE', url: `${base}/streamers/${streamer.id}/accounts/${account.id}`, headers: auth.headers });
    expect(rm.statusCode).toBe(200);
    expect(env.streamers.removeAccount).toHaveBeenCalledWith(GUILD, streamer.id, account.id, actor);

    const del = await s.app.inject({ method: 'DELETE', url: `${base}/streamers/${streamer.id}`, headers: auth.headers });
    expect(del.json()).toEqual({ ok: true });
    expect(env.streamers.delete).toHaveBeenCalledWith(GUILD, streamer.id, actor);
  });
});

describe('platform resolve + provider error mapping', () => {
  it('returns a preview without provider meta', async () => {
    const { s, auth } = await setup();
    const res = await s.app.inject({ method: 'POST', url: '/api/platforms/resolve', headers: auth.headers, payload: { platform: 'kick', input: 'abufahad' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ platform: 'kick', platformId: 'id-abufahad', handle: 'abufahad', displayName: 'ABUFAHAD', avatarUrl: null, url: 'https://kick.example.com/abufahad' });
  });

  it('maps ChannelNotFoundError → 404, ProviderNotConfigured → 400, RateLimited → 429, ProviderError → 502', async () => {
    const { env, s, auth } = await setup();
    const call = () => s.app.inject({ method: 'POST', url: '/api/platforms/resolve', headers: auth.headers, payload: { platform: 'twitch', input: 'ghost' } });

    env.streamers.resolve.mockRejectedValueOnce(new ChannelNotFoundError('twitch', 'ghost'));
    const notFound = await call();
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json()).toEqual({ error: 'not_found', message: 'الحساب غير موجود على المنصة' });

    env.streamers.resolve.mockRejectedValueOnce(new ProviderNotConfiguredError('twitch'));
    const notConfigured = await call();
    expect(notConfigured.statusCode).toBe(400);
    expect(notConfigured.json().error).toBe('provider_not_configured');
    expect(notConfigured.json().message).toContain('TWITCH_CLIENT_ID');

    env.streamers.resolve.mockRejectedValueOnce(new RateLimitedError('twitch', 4200));
    const limited = await call();
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('5');

    env.streamers.resolve.mockRejectedValueOnce(new ProviderError('twitch', 'HTTP 503'));
    const upstream = await call();
    expect(upstream.statusCode).toBe(502);
    expect(upstream.json().error).toBe('provider_error');
  });

  it('validates the resolve body', async () => {
    const { s, auth } = await setup();
    const res = await s.app.inject({ method: 'POST', url: '/api/platforms/resolve', headers: auth.headers, payload: { platform: 'twitch' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ field: 'input', message: 'هذا الحقل مطلوب' });
  });
});

describe('history, overview and lookups', () => {
  it('lists sessions with duration, average, VOD links and message URL', async () => {
    const { env, s, auth } = await setup();
    const { streamer, channel } = seedStreamer(env);
    const start = Date.now() - 3 * 3600_000;
    const session = env.repos.sessions.create({ guildId: GUILD, streamerId: streamer.id, startedAt: new Date(start).toISOString() });
    env.repos.sessions.save({
      ...session,
      status: 'ended',
      endedAt: new Date(start + 2 * 3600_000).toISOString(),
      messageChannelId: CHANNEL_A,
      messageId: '900000000000000001',
      peakViewers: 300,
      viewerSum: 1000,
      viewerSamples: 8,
      titles: ['رانكد'],
      categories: [
        { name: 'Just Chatting', imageUrl: null, firstSeenAt: new Date(start).toISOString(), seconds: 600 },
        { name: 'Valorant', imageUrl: null, firstSeenAt: new Date(start).toISOString(), seconds: 6600 },
      ],
    });
    const seg = env.repos.sessions.addSegment({ sessionId: session.id, channelId: channel.id, platform: 'twitch', streamId: 's', startedAt: new Date(start).toISOString(), viewers: 10 });
    env.repos.sessions.saveSegment({ ...seg, endedAt: new Date(start + 90 * 60_000).toISOString(), vodUrl: 'https://twitch.tv/videos/1' });

    const res = await s.app.inject({ method: 'GET', url: `${base}/sessions?limit=10`, headers: auth.headers });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    const item = body.items[0];
    expect(item).toMatchObject({
      id: session.id,
      status: 'ended',
      durationSec: 90 * 60,
      peakViewers: 300,
      avgViewers: 125,
      platforms: ['twitch'],
      titles: ['رانكد'],
      vodUrls: [{ platform: 'twitch', url: 'https://twitch.tv/videos/1' }],
      messageUrl: `https://discord.com/channels/${GUILD}/${CHANNEL_A}/900000000000000001`,
    });
    expect(item.categories[0].name).toBe('Valorant');
    expect(item.streamer).toMatchObject({ id: streamer.id, displayName: 'Abu Fahad' });
  });

  it('prefers the session service summary (same numbers as the Discord summary)', async () => {
    const { env, s, auth } = await setup();
    const { streamer } = seedStreamer(env);
    const session = env.repos.sessions.create({ guildId: GUILD, streamerId: streamer.id, startedAt: new Date().toISOString() });
    env.sessions.summaryOf.mockImplementation(
      () => ({ durationSec: 4242, peakViewers: 9, avgViewers: 7, categories: [], titles: ['t'], segments: [] }) as unknown as SummaryView,
    );
    const res = await s.app.inject({ method: 'GET', url: `${base}/sessions`, headers: auth.headers });
    expect(res.json().items[0]).toMatchObject({ id: session.id, durationSec: 4242, avgViewers: 7, peakViewers: 9, status: 'live' });
  });

  it('validates pagination', async () => {
    const { s, auth } = await setup();
    const res = await s.app.inject({ method: 'GET', url: `${base}/sessions?limit=1000`, headers: auth.headers });
    expect(res.statusCode).toBe(400);
    expect(res.json().field).toBe('limit');
  });

  it('lists announced content, audit entries and the leaderboard', async () => {
    const { env, s, auth } = await setup();
    const { streamer, channel } = seedStreamer(env);
    const { item } = env.repos.content.insert(
      channel.id,
      { platform: 'twitch', platformId: channel.platformId, contentId: 'v1', kind: 'vod', title: 'بث أمس', url: 'https://twitch.tv/videos/1', thumbnailUrl: null, publishedAt: new Date().toISOString(), durationSec: null, viewCount: null },
      true,
    );
    env.repos.content.recordNotification({ contentItemId: item.id, guildId: GUILD, streamerId: streamer.id, messageChannelId: null, messageId: null });
    env.ctx.audit.record({ guildId: GUILD, action: 'x.one', message: 'واحد' });
    env.ctx.audit.record({ guildId: GUILD, action: 'x.two', level: 'warn', message: 'اثنين' });
    env.ctx.audit.record({ guildId: OTHER_GUILD, action: 'x.other', message: 'سيرفر ثاني' });
    env.repos.sessions.create({ guildId: GUILD, streamerId: streamer.id, startedAt: new Date(Date.now() - 3600_000).toISOString() });

    const content = await s.app.inject({ method: 'GET', url: `${base}/content?limit=5`, headers: auth.headers });
    expect(content.json()).toEqual([
      expect.objectContaining({ id: item.id, platform: 'twitch', kind: 'vod', title: 'بث أمس', streamer: expect.objectContaining({ id: streamer.id }) }),
    ]);

    const audit = await s.app.inject({ method: 'GET', url: `${base}/audit?level=warn`, headers: auth.headers });
    expect(audit.json().map((a: { action: string }) => a.action)).toEqual(['x.two']);
    const all = await s.app.inject({ method: 'GET', url: `${base}/audit?limit=10`, headers: auth.headers });
    expect(all.json().map((a: { action: string }) => a.action)).not.toContain('x.other');

    const board = await s.app.inject({ method: 'GET', url: `${base}/leaderboard?days=7`, headers: auth.headers });
    expect(board.json()[0]).toMatchObject({ streamer: { id: streamer.id }, sessions: 1 });
    expect(board.json()[0].seconds).toBeGreaterThanOrEqual(3599);
  });

  it('builds the overview with counts, live now and provider diagnostics', async () => {
    const providers = new FakeProviders({ twitch: fakeProvider('twitch', { configured: false }) });
    const env = createEnv({}, providers);
    const { s, auth } = await setup(env);
    const { streamer, channel } = seedStreamer(env);
    const session = env.repos.sessions.create({ guildId: GUILD, streamerId: streamer.id, startedAt: new Date().toISOString() });
    const snapshot: LiveSnapshot = {
      platform: 'twitch', platformId: channel.platformId, isLive: true, streamId: 's', title: 'هلا', category: null, categoryImageUrl: null,
      thumbnailUrl: null, viewers: 42, startedAt: session.startedAt, url: channel.url, language: null, tags: [],
    };
    env.sessions.liveViews.mockImplementation(() => [
      {
        guildId: GUILD,
        settings: env.repos.settings.get(GUILD),
        session,
        streamer,
        platforms: [{ platform: 'twitch', channel, snapshot }],
        totalViewers: 42,
      },
    ]);

    const res = await s.app.inject({ method: 'GET', url: `${base}/overview`, headers: auth.headers });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.guild).toMatchObject({ id: GUILD, memberCount: 120 });
    expect(body.counts).toMatchObject({ streamers: 1, accounts: 1, liveNow: 1, sessionsLast7d: 1 });
    expect(body.liveNow[0]).toMatchObject({ sessionId: session.id, totalViewers: 42, platforms: [{ platform: 'twitch', channelId: channel.id }] });
    expect(body.liveNow[0].streamer.avatarUrl).toBe(channel.avatarUrl);
    expect(body.diagnostics.problems.map((p: { code: string }) => p.code)).toContain('provider_not_configured:twitch');
    expect(body.recentSessions).toHaveLength(1);
  });

  it('returns Discord roles/channels and member lookups', async () => {
    const { env, s, auth } = await setup();
    env.discord.addMember(GUILD, MEMBER, 'Abu Fahad');
    seedStreamer(env);

    const lookups = await s.app.inject({ method: 'GET', url: `${base}/discord`, headers: auth.headers });
    expect(lookups.json().roles.map((r: { id: string }) => r.id)).toEqual([ROLE_B, ROLE_A]);
    expect(lookups.json().channels[0].id).toBe(CHANNEL_A);

    const member = await s.app.inject({ method: 'GET', url: `${base}/members/${MEMBER}`, headers: auth.headers });
    expect(member.json()).toMatchObject({ id: MEMBER, displayName: 'Abu Fahad', alreadyStreamer: true, bot: false });

    const missing = await s.app.inject({ method: 'GET', url: `${base}/members/600000000000000001`, headers: auth.headers });
    expect(missing.statusCode).toBe(404);

    env.discord.fetchMember.mockRejectedValueOnce(new Error('timeout'));
    const failed = await s.app.inject({ method: 'GET', url: `${base}/members/600000000000000002`, headers: auth.headers });
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error).toBe('discord_error');
  });
});

describe('tools and system', () => {
  it('sends a test message, audits it and returns the message URL', async () => {
    const { env, s, auth } = await setup();
    const res = await s.app.inject({ method: 'POST', url: `${base}/test`, headers: auth.headers, payload: { type: 'live' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, messageUrl: `https://discord.com/channels/${GUILD}/${CHANNEL_A}/123456789012345678` });
    expect(env.discord.sendTest).toHaveBeenCalledWith(GUILD, 'live');
    expect(env.repos.audit.list({ guildId: GUILD, actionPrefix: 'tools.' })).toHaveLength(1);
  });

  it('explains when the test message could not be sent', async () => {
    const { env, s, auth } = await setup();
    env.discord.sendTest.mockResolvedValueOnce(null);
    const res = await s.app.inject({ method: 'POST', url: `${base}/test`, headers: auth.headers, payload: { type: 'content' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'validation', field: 'contentChannelId' });
  });

  it('turns unexpected Discord failures into an actionable 502', async () => {
    const { env, s, auth } = await setup();
    env.discord.sendTest.mockRejectedValueOnce(new Error('Missing Permissions'));
    const res = await s.app.inject({ method: 'POST', url: `${base}/test`, headers: auth.headers, payload: { type: 'live' } });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: 'discord_error' });
    env.sessions.syncRoles.mockRejectedValueOnce(new ValidationError('حدد رتبة الستريمر أول', 'streamerRoleId'));
    const sync = await s.app.inject({ method: 'POST', url: `${base}/sync-roles`, headers: auth.headers });
    expect(sync.statusCode).toBe(400);
    expect(sync.json().field).toBe('streamerRoleId');
  });

  it('renders previews with an optional template and syncs roles', async () => {
    const { env, s, auth } = await setup();
    const preview = await s.app.inject({ method: 'POST', url: `${base}/preview`, headers: auth.headers, payload: { type: 'summary', template: { title: '{name}', color: 255 } } });
    expect(preview.statusCode).toBe(200);
    expect(env.discord.preview).toHaveBeenCalledWith(GUILD, 'summary', { title: '{name}', color: 255 });

    const sync = await s.app.inject({ method: 'POST', url: `${base}/sync-roles`, headers: auth.headers });
    expect(sync.json()).toEqual({ added: 2, removed: 1 });
  });

  it('GET /api/system merges provider config with monitor runtime status', async () => {
    const providers = new FakeProviders({ kick: fakeProvider('kick', { configured: false, notes: ['KICK_CLIENT_ID ناقص'] }) });
    const env = createEnv({}, providers);
    env.monitor.runtime = [{ platform: 'twitch', trackedChannels: 5, liveChannels: 2, lastSuccessAt: '2026-10-03T00:00:00.000Z', lastError: null, consecutiveErrors: 0 }];
    const { s, auth } = await setup(env);
    const res = await s.app.inject({ method: 'GET', url: '/api/system', headers: auth.headers });
    const body = res.json();
    expect(body).toMatchObject({ version: '1.2.3', webhooksEnabled: true, publicUrl: 'https://bot.example.com' });
    expect(body.uptimeSec).toBeGreaterThanOrEqual(89);
    const twitch = body.providers.find((p: { platform: string }) => p.platform === 'twitch');
    expect(twitch).toMatchObject({ configured: true, push: false, trackedChannels: 5, liveChannels: 2 });
    const kick = body.providers.find((p: { platform: string }) => p.platform === 'kick');
    expect(kick).toMatchObject({ configured: false, notes: ['KICK_CLIENT_ID ناقص'], trackedChannels: 0 });
  });
});
