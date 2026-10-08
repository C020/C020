import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/core/errors.js';
import type { ResolvedChannel } from '../../src/core/types.js';
import { localizeMessage, requestLanguage, translateMessage } from '../../src/web/i18n.js';
import { asLinkService, type WebServer } from '../../src/web/server.js';
import { isVerifiedAccount } from '../../src/web/dto.js';
import { CHANNEL_A, createEnv, GUILD, login, manageable, MEMBER, OTHER_GUILD, ROLE_A, ROLE_B, startServer, USER, type Login, type TestEnv } from './helpers.js';

let server: WebServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

async function setup(env: TestEnv = createEnv(), auth?: (env: TestEnv) => Login): Promise<{ env: TestEnv; s: WebServer; auth: Login }> {
  server = await startServer(env);
  return { env, s: server, auth: auth ? auth(env) : login(env) };
}

const base = `/api/guilds/${GUILD}`;
const ROLE_C = '777777777777777773';
const CHANNEL_B = '888888888888888882';

function resolved(platform: ResolvedChannel['platform'], handle: string, platformId = `${platform}-${handle}`): ResolvedChannel {
  return { platform, platformId, handle, displayName: handle, avatarUrl: null, url: `https://${platform}.tv/${handle}`, meta: {} };
}

function seedStreamer(env: TestEnv, discordUserId = MEMBER) {
  const streamer = env.repos.streamers.create({ guildId: GUILD, discordUserId, displayName: 'Abu Fahad' });
  const twitch = env.repos.channels.upsertResolved(resolved('twitch', `abu${streamer.id}`, '4242'));
  const tiktok = env.repos.channels.upsertResolved(resolved('tiktok', `Abu.Tok${streamer.id}`, 'tt-internal'));
  env.repos.accounts.create({ streamerId: streamer.id, channelId: twitch.id });
  env.repos.accounts.create({ streamerId: streamer.id, channelId: tiktok.id });
  return { streamer, twitch, tiktok };
}

function link(env: TestEnv, userId: string, platform: 'twitch' | 'tiktok', platformUserId: string, login: string | null) {
  return env.repos.links.upsert({
    discordUserId: userId,
    platform,
    platformUserId,
    platformLogin: login,
    displayName: login,
    accessTokenEnc: 'secret-token',
    refreshTokenEnc: 'secret-refresh',
    scopes: [],
    accessExpiresAt: null,
    refreshExpiresAt: null,
  });
}

function put(s: WebServer, auth: Login, payload: unknown, headers: Record<string, string> = {}) {
  return s.app.inject({ method: 'PUT', url: `${base}/settings`, headers: { ...auth.headers, ...headers }, payload: payload as object });
}

describe('settings.features', () => {
  it('GET returns feature defaults and PUT saves a partial patch merged per feature', async () => {
    const { s, auth, env } = await setup();
    const get = await s.app.inject({ method: 'GET', url: `${base}/settings`, headers: auth.headers });
    expect(get.json().features).toMatchObject({ language: 'ar', timezone: 'Asia/Riyadh', clips: { mode: 'each' }, notifyRole: { roleId: null } });

    const res = await put(s, auth, {
      features: {
        notifyRole: { roleId: ROLE_B, panelChannelId: CHANNEL_A, panelTitle: '  ' },
        clips: { minViews: 50, mode: 'digest', digestHour: 22 },
        routing: { liveByPlatform: { kick: CHANNEL_A, twitch: '' } },
        language: 'en',
        timezone: 'Europe/London',
        counter: { channelId: '999999999999999990', template: 'Live: {count}' },
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const f = res.json().features;
    expect(f.notifyRole).toMatchObject({ roleId: ROLE_B, panelChannelId: CHANNEL_A, panelTitle: null, pingOnLive: true });
    expect(f.clips).toMatchObject({ minViews: 50, mode: 'digest', digestHour: 22, digestMax: 10 });
    expect(f.routing.liveByPlatform).toEqual({ kick: CHANNEL_A });
    expect(f.language).toBe('en');
    expect(env.repos.settings.get(GUILD).features.timezone).toBe('Europe/London');
    expect(env.v2.counter.refresh).toHaveBeenCalledWith(GUILD);
    const audit = env.repos.audit.list({ guildId: GUILD, actionPrefix: 'settings.update' })[0]!;
    expect(audit.message).toContain('رتبة الإشعارات');
    expect((audit.details.changes as Record<string, unknown>)['features.language']).toEqual({ from: 'ar', to: 'en' });
  });

  it('rejects invalid feature values with the field path', async () => {
    const { s, auth } = await setup();
    const cases: Array<[unknown, string]> = [
      [{ features: { timezone: 'Mars/Olympus' } }, 'features.timezone'],
      [{ features: { language: 'fr' } }, 'features.language'],
      [{ features: { clips: { digestHour: 24 } } }, 'features.clips.digestHour'],
      [{ features: { clips: { minViews: -1 } } }, 'features.clips.minViews'],
      [{ features: { clips: { digestMax: 0 } } }, 'features.clips.digestMax'],
      [{ features: { clips: { mode: 'weekly' } } }, 'features.clips.mode'],
      [{ features: { counter: { template: 'no placeholder' } } }, 'features.counter.template'],
      [{ features: { counter: { template: `{count}${'x'.repeat(100)}` } } }, 'features.counter.template'],
      [{ features: { routing: { contentByKind: { podcast: CHANNEL_A } } } }, 'features.routing.contentByKind.podcast'],
      [{ features: { routing: { liveByPlatform: { twitch: '123' } } } }, 'features.routing.liveByPlatform.twitch'],
      [{ features: { presence: { scope: 'all' } } }, 'features.presence.scope'],
      [{ features: { notifyRole: { roleId: GUILD } } }, 'features.notifyRole.roleId'],
      [{ streamerRoleId: ROLE_A, features: { notifyRole: { roleId: ROLE_A } } }, 'features.notifyRole.roleId'],
    ];
    for (const [payload, field] of cases) {
      const res = await put(s, auth, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().field, JSON.stringify(payload)).toBe(field);
    }
  });

  it('checks the notification role against Discord: exists, not managed, not elevated, assignable', async () => {
    const env = createEnv();
    env.discord.roleList.push(
      { id: '700000000000000001', name: 'Mods', color: 0, position: 1, managed: false, assignable: true, permissions: '8', elevated: true },
      { id: '700000000000000002', name: 'BotRole', color: 0, position: 1, managed: true, assignable: false, permissions: '0', elevated: false },
      { id: '700000000000000003', name: 'High', color: 0, position: 9, managed: false, assignable: false, permissions: '0', elevated: false },
    );
    const { s, auth } = await setup(env);
    for (const [id, pattern] of [
      ['700000000000000009', /مو موجودة/],
      ['700000000000000001', /صلاحيات إدارية/],
      ['700000000000000002', /تابعة لبوت/],
      ['700000000000000003', /أعلى من رتبة البوت/],
    ] as const) {
      const res = await put(s, auth, { features: { notifyRole: { roleId: id } } });
      expect(res.statusCode, id).toBe(400);
      expect(res.json().field).toBe('features.notifyRole.roleId');
      expect(res.json().message).toMatch(pattern);
    }
    expect((await put(s, auth, { features: { notifyRole: { roleId: ROLE_B } } })).statusCode).toBe(200);
  });

  it('checks every changed feature channel exists when Discord is ready (skipped when not ready)', async () => {
    const env = createEnv();
    const { s, auth } = await setup(env);
    for (const [payload, field] of [
      [{ features: { applications: { reviewChannelId: CHANNEL_B } } }, 'features.applications.reviewChannelId'],
      [{ features: { clips: { digestChannelId: CHANNEL_B } } }, 'features.clips.digestChannelId'],
      [{ features: { routing: { contentByKind: { clip: CHANNEL_B } } } }, 'features.routing.contentByKind.clip'],
      [{ features: { notifyRole: { panelChannelId: CHANNEL_B } } }, 'features.notifyRole.panelChannelId'],
    ] as const) {
      const res = await put(s, auth, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().field).toBe(field);
    }
    env.discord.ready = false;
    expect((await put(s, auth, { features: { applications: { reviewChannelId: CHANNEL_B } } })).statusCode).toBe(200);
  });

  it('changing the notification role needs Manage Roles; other features only Manage Server', async () => {
    const env = createEnv();
    const { s, auth } = await setup(env, (e) => login(e, USER, [manageable(GUILD, { permissions: String(0x20) })]));
    const denied = await put(s, auth, { features: { notifyRole: { roleId: ROLE_C } } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().field).toBe('features.notifyRole.roleId');
    expect(denied.json().message).toContain('رتبة الإشعارات');
    const ok = await put(s, auth, { features: { silent: { live: true }, presence: { enabled: true } } });
    expect(ok.statusCode).toBe(200);
    expect(env.v2.presence.reconcile).toHaveBeenCalledWith(GUILD);
  });
});

describe('streamers v2', () => {
  it('PATCH passes cleaned per-streamer templates; DTO exposes templates, links and verified accounts', async () => {
    const env = createEnv();
    const { s, auth } = await setup(env);
    const { streamer } = seedStreamer(env);
    link(env, MEMBER, 'twitch', '4242', 'abu');
    link(env, MEMBER, 'tiktok', 'open-1', `@abu.tok${streamer.id}`);
    env.streamers.update.mockImplementationOnce(async (guildId, id, patch) => {
      env.repos.streamers.update(id, { templates: (patch as { templates: object }).templates });
      return env.repos.streamerWithAccounts(id)!;
    });

    const res = await s.app.inject({
      method: 'PATCH',
      url: `${base}/streamers/${streamer.id}`,
      headers: auth.headers,
      payload: { templates: { live: { title: '', content: 'hi', color: null }, summary: {}, content: { color: 255 } } },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(env.streamers.update).toHaveBeenCalledWith(GUILD, streamer.id, { templates: { live: { title: '', content: 'hi' }, content: { color: 255 } } }, `user:${USER}`);
    const body = res.json();
    expect(body.templates).toEqual({ live: { title: '', content: 'hi' }, content: { color: 255 } });
    expect(body.links).toHaveLength(2);
    expect(body.links[0]).toEqual(expect.objectContaining({ platform: expect.any(String), platformUserId: expect.any(String), linkedAt: expect.any(String) }));
    expect(JSON.stringify(body)).not.toContain('secret-token');
    expect(body.accounts.map((a: { platform: string; verified: boolean }) => [a.platform, a.verified]).sort()).toEqual([
      ['tiktok', true],
      ['twitch', true],
    ]);

    const tooLong = await s.app.inject({ method: 'PATCH', url: `${base}/streamers/${streamer.id}`, headers: auth.headers, payload: { templates: { live: { title: 'x'.repeat(257) } } } });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json().field).toBe('templates.live.title');
  });

  it('isVerifiedAccount compares ids (Twitch) and handles (TikTok)', () => {
    const env = createEnv();
    const { streamer } = seedStreamer(env);
    const [tw, tt] = env.repos.accounts.listForStreamer(streamer.id);
    expect(isVerifiedAccount(tw!, [link(env, MEMBER, 'twitch', '9999', 'abu')])).toBe(false);
    expect(isVerifiedAccount(tt!, [link(env, MEMBER, 'tiktok', 'x', 'someone')])).toBe(false);
    expect(isVerifiedAccount(tt!, [link(env, MEMBER, 'twitch', 'tt-internal', null)])).toBe(false);
  });

  it('DELETE /links/:platform removes the member link, 404 when none', async () => {
    const env = createEnv();
    const { s, auth } = await setup(env);
    const { streamer } = seedStreamer(env);
    link(env, MEMBER, 'twitch', '4242', 'abu');
    const res = await s.app.inject({ method: 'DELETE', url: `${base}/streamers/${streamer.id}/links/twitch`, headers: auth.headers });
    expect(res.statusCode, res.body).toBe(200);
    expect(env.v2.links.unlink).toHaveBeenCalledWith(MEMBER, 'twitch', `user:${USER}`);
    expect(res.json().links).toEqual([]);
    const again = await s.app.inject({ method: 'DELETE', url: `${base}/streamers/${streamer.id}/links/twitch`, headers: auth.headers });
    expect(again.statusCode).toBe(404);
    const bad = await s.app.inject({ method: 'DELETE', url: `${base}/streamers/${streamer.id}/links/kick`, headers: auth.headers });
    expect(bad.statusCode).toBe(400);
  });

  it('preview passes streamerId and 404s for other guilds', async () => {
    const env = createEnv();
    const { s, auth } = await setup(env);
    const { streamer } = seedStreamer(env);
    const ok = await s.app.inject({ method: 'POST', url: `${base}/preview`, headers: auth.headers, payload: { type: 'live', template: { title: 'x' }, streamerId: streamer.id } });
    expect(ok.statusCode).toBe(200);
    expect(env.discord.preview).toHaveBeenLastCalledWith(GUILD, 'live', { title: 'x' }, streamer.id);
    const other = env.repos.streamers.create({ guildId: OTHER_GUILD, discordUserId: USER, displayName: 'x' });
    const missing = await s.app.inject({ method: 'POST', url: `${base}/preview`, headers: auth.headers, payload: { type: 'live', streamerId: other.id } });
    expect(missing.statusCode).toBe(404);
  });
});

describe('applications', () => {
  function seedApp(env: TestEnv, guildId = GUILD) {
    return env.repos.applications.create({ guildId, userId: MEMBER, username: 'abu', accounts: [{ platform: 'kick', input: 'abu' }], note: 'hi' });
  }

  it('lists, gets, approves and rejects; other guilds are 404', async () => {
    const env = createEnv();
    env.discord.addMember(GUILD, MEMBER, 'Abu');
    const { s, auth } = await setup(env);
    const app = seedApp(env);
    const otherApp = seedApp(env, OTHER_GUILD);

    const list = await s.app.inject({ method: 'GET', url: `${base}/applications?status=pending`, headers: auth.headers });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([expect.objectContaining({ id: app.id, username: 'abu', status: 'pending', inGuild: true, reviewer: null, accounts: [{ platform: 'kick', input: 'abu' }] })]);
    expect((await s.app.inject({ method: 'GET', url: `${base}/applications/${otherApp.id}`, headers: auth.headers })).statusCode).toBe(404);
    expect((await s.app.inject({ method: 'GET', url: `${base}/applications?status=nope`, headers: auth.headers })).statusCode).toBe(400);

    const approved = await s.app.inject({
      method: 'POST',
      url: `${base}/applications/${app.id}/approve`,
      headers: auth.headers,
      payload: { note: ' welcome ', accounts: [{ platform: 'kick', input: 'abu_real' }] },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(env.v2.applications.approve).toHaveBeenCalledWith(GUILD, app.id, `user:${USER}`, { note: 'welcome', accounts: [{ platform: 'kick', input: 'abu_real' }] });
    expect(approved.json()).toMatchObject({ application: { status: 'approved' }, streamer: { discordUserId: MEMBER }, skipped: [] });

    const second = seedApp(env);
    const rejected = await s.app.inject({ method: 'POST', url: `${base}/applications/${second.id}/reject`, headers: auth.headers, payload: { note: 'no' } });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toMatchObject({ status: 'rejected', reviewNote: 'no', reviewer: { id: USER } });
  });

  it('approval needs Manage Roles when the streamer role is handed out automatically', async () => {
    const env = createEnv();
    env.repos.settings.update(GUILD, { streamerRoleId: ROLE_A });
    const { s, auth } = await setup(env, (e) => login(e, USER, [manageable(GUILD, { permissions: String(0x20) })]));
    const app = seedApp(env);
    const res = await s.app.inject({ method: 'POST', url: `${base}/applications/${app.id}/approve`, headers: auth.headers });
    expect(res.statusCode).toBe(403);
    expect(env.v2.applications.approve).not.toHaveBeenCalled();
  });

  it('service validation errors become 400', async () => {
    const env = createEnv();
    const { s, auth } = await setup(env);
    const app = seedApp(env);
    env.v2.applications.approve.mockRejectedValueOnce(new ValidationError('ولا حساب انضاف', 'accounts'));
    const res = await s.app.inject({ method: 'POST', url: `${base}/applications/${app.id}/approve`, headers: auth.headers, payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'validation', field: 'accounts' });
  });
});

describe('panels, manual posts, digest', () => {
  it('posts panels and audits; 503 while Discord is not ready; unknown kind 400', async () => {
    const env = createEnv();
    const { s, auth } = await setup(env);
    const res = await s.app.inject({ method: 'POST', url: `${base}/panels/notify`, headers: auth.headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, messageUrl: `https://discord.com/channels/${GUILD}/${CHANNEL_A}/223456789012345678` });
    expect(env.discord.postPanel).toHaveBeenCalledWith(GUILD, 'notify');
    expect(env.repos.audit.list({ guildId: GUILD, actionPrefix: 'panels.post' })).toHaveLength(1);

    env.discord.postPanel.mockRejectedValueOnce(new ValidationError('حدد روم اللوحة', 'features.applications.panelChannelId'));
    const invalid = await s.app.inject({ method: 'POST', url: `${base}/panels/apply`, headers: auth.headers });
    expect(invalid.statusCode).toBe(400);
    env.discord.postPanel.mockRejectedValueOnce(new Error('discord 500'));
    expect((await s.app.inject({ method: 'POST', url: `${base}/panels/apply`, headers: auth.headers })).statusCode).toBe(502);
    expect((await s.app.inject({ method: 'POST', url: `${base}/panels/other`, headers: auth.headers })).statusCode).toBe(400);
    env.discord.ready = false;
    expect((await s.app.inject({ method: 'POST', url: `${base}/panels/notify`, headers: auth.headers })).statusCode).toBe(503);
  });

  it('manual posts are gated by features.manualPosts.enabled', async () => {
    const env = createEnv();
    const { s, auth } = await setup(env);
    const url = 'https://kick.com/abu/clips/clip_01';
    const denied = await s.app.inject({ method: 'POST', url: `${base}/manual-posts/inspect`, headers: auth.headers, payload: { url } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe('feature_disabled');
    expect(env.v2.manualPosts.inspect).not.toHaveBeenCalled();

    env.repos.settings.update(GUILD, { features: { manualPosts: { enabled: true } } });
    const inspect = await s.app.inject({ method: 'POST', url: `${base}/manual-posts/inspect`, headers: auth.headers, payload: { url } });
    expect(inspect.statusCode, inspect.body).toBe(200);
    expect(inspect.json()).toMatchObject({ platform: 'kick', kind: 'clip', url, alreadyPosted: false });

    const bad = await s.app.inject({ method: 'POST', url: `${base}/manual-posts`, headers: auth.headers, payload: { url: 'javascript:alert(1)' } });
    expect(bad.statusCode).toBe(400);
    const post = await s.app.inject({ method: 'POST', url: `${base}/manual-posts`, headers: auth.headers, payload: { url, title: ' Great clip ', kind: 'clip' } });
    expect(post.statusCode, post.body).toBe(200);
    expect(post.json().messageUrl).toContain('323456789012345678');
    expect(env.v2.manualPosts.post).toHaveBeenCalledWith(GUILD, expect.objectContaining({ url, title: 'Great clip', kind: 'clip' }), `user:${USER}`);
    const foreign = env.repos.streamers.create({ guildId: OTHER_GUILD, discordUserId: USER, displayName: 'x' });
    expect((await s.app.inject({ method: 'POST', url: `${base}/manual-posts`, headers: auth.headers, payload: { url, streamerId: foreign.id } })).statusCode).toBe(404);
  });

  it('digest post-now returns the message url (or null when nothing was posted)', async () => {
    const env = createEnv();
    const { s, auth } = await setup(env);
    const res = await s.app.inject({ method: 'POST', url: `${base}/digest/post-now`, headers: auth.headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().messageUrl).toContain('423456789012345678');
    expect(env.content.postDigestNow).toHaveBeenCalledWith(GUILD, `user:${USER}`);
    env.content.postDigestNow.mockResolvedValueOnce(null);
    expect((await s.app.inject({ method: 'POST', url: `${base}/digest/post-now`, headers: auth.headers })).json()).toEqual({ ok: true, messageUrl: null });
  });
});

describe('statistics', () => {
  it('session detail includes samples and segments; 404 for other guilds', async () => {
    const env = createEnv();
    const { s, auth } = await setup(env);
    const { streamer, twitch } = seedStreamer(env);
    const session = env.repos.sessions.create({ guildId: GUILD, streamerId: streamer.id, startedAt: '2026-10-01T18:00:00.000Z' });
    env.repos.sessions.addSegment({ sessionId: session.id, channelId: twitch.id, platform: 'twitch', streamId: 's1', startedAt: '2026-10-01T18:00:00.000Z', viewers: 10 });
    env.repos.samples.add({ sessionId: session.id, at: '2026-10-01T18:01:00.000Z', totalViewers: 12, platforms: { twitch: 12 }, category: 'Just Chatting' });

    const res = await s.app.inject({ method: 'GET', url: `${base}/sessions/${session.id}`, headers: auth.headers });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.samples).toEqual([{ at: '2026-10-01T18:01:00.000Z', total: 12, platforms: { twitch: 12 }, category: 'Just Chatting' }]);
    expect(body.segments).toEqual([expect.objectContaining({ platform: 'twitch', channelId: twitch.id, displayName: twitch.displayName, url: twitch.url, vodUrl: null })]);
    expect(body.streamer.id).toBe(streamer.id);

    const otherStreamer = env.repos.streamers.create({ guildId: OTHER_GUILD, discordUserId: USER, displayName: 'x' });
    const other = env.repos.sessions.create({ guildId: OTHER_GUILD, streamerId: otherStreamer.id, startedAt: '2026-10-01T18:00:00.000Z' });
    expect((await s.app.inject({ method: 'GET', url: `${base}/sessions/${other.id}`, headers: auth.headers })).statusCode).toBe(404);
    // the existing list route still works
    expect((await s.app.inject({ method: 'GET', url: `${base}/sessions`, headers: auth.headers })).json().items).toHaveLength(1);
  });

  it('streamer stats are mapped with recent sessions; days must be 7/30/90/365', async () => {
    const env = createEnv();
    const { s, auth } = await setup(env);
    const { streamer } = seedStreamer(env);
    const session = env.repos.sessions.create({ guildId: GUILD, streamerId: streamer.id, startedAt: '2026-10-01T18:00:00.000Z' });
    env.v2.stats.streamerStats.mockReturnValueOnce({
      streamerId: streamer.id,
      days: 7,
      totals: { sessions: 1, seconds: 3600, peakViewers: 40, avgViewers: 20, contentPosts: 2 },
      daily: [{ date: '2026-10-01', seconds: 3600, sessions: 1, peakViewers: 40 }],
      platforms: [{ platform: 'twitch', seconds: 3600, sessions: 1, peakViewers: 40 }],
      categories: [{ name: 'Just Chatting', seconds: 3600 }],
      hours: [1, 2],
      recentSessionIds: [session.id, 99999],
    });
    const res = await s.app.inject({ method: 'GET', url: `${base}/streamers/${streamer.id}/stats?days=7`, headers: auth.headers });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(env.v2.stats.streamerStats).toHaveBeenCalledWith(GUILD, streamer.id, 7);
    expect(body).toMatchObject({ days: 7, streamer: { id: streamer.id }, totals: { contentPosts: 2 }, categories: [{ name: 'Just Chatting', seconds: 3600 }] });
    expect(body.hours).toHaveLength(24);
    expect(body.recentSessions.map((r: { id: number }) => r.id)).toEqual([session.id]);
    expect((await s.app.inject({ method: 'GET', url: `${base}/streamers/${streamer.id}/stats?days=14`, headers: auth.headers })).statusCode).toBe(400);
    expect((await s.app.inject({ method: 'GET', url: `${base}/streamers/99999/stats`, headers: auth.headers })).statusCode).toBe(404);
  });
});

describe('me / overview / sse', () => {
  it('/me reports capabilities without failing when services throw', async () => {
    const env = createEnv({ KICK_UNOFFICIAL_CONTENT: true });
    env.discord.presenceIntent = true;
    env.v2.links.isAvailable.mockImplementation((p) => p === 'twitch');
    const { s, auth } = await setup(env);
    const res = await s.app.inject({ method: 'GET', url: '/api/me', headers: auth.headers });
    expect(res.json().capabilities).toEqual({ presenceIntent: true, linking: { twitch: true, tiktok: false }, kickAutoContent: true });
    env.v2.links.isAvailable.mockImplementation(() => {
      throw new Error('boom');
    });
    const again = await s.app.inject({ method: 'GET', url: '/api/me', headers: auth.headers });
    expect(again.json().capabilities.linking).toEqual({ twitch: false, tiktok: false });
  });

  it('overview counts pending applications', async () => {
    const env = createEnv();
    const { s, auth } = await setup(env);
    env.repos.applications.create({ guildId: GUILD, userId: MEMBER, username: 'a', accounts: [{ platform: 'kick', input: 'a' }], note: null });
    const res = await s.app.inject({ method: 'GET', url: `${base}/overview`, headers: auth.headers });
    expect(res.json().counts.pendingApplications).toBe(1);
  });

  it('streams "application" events for the guild', async () => {
    const env = createEnv();
    server = await startServer(env, { sseHeartbeatMs: 1000 });
    await server.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = server.app.server.address() as AddressInfo;
    const { cookie } = login(env);
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/guilds/${GUILD}/events`, { headers: { cookie }, signal: controller.signal });
    const reader = res.body!.getReader();
    await reader.read(); // connected frame
    env.events.emit('application.changed', { guildId: OTHER_GUILD, applicationId: 1, status: 'pending' });
    env.events.emit('application.changed', { guildId: GUILD, applicationId: 7, status: 'approved' });
    let text = '';
    const deadline = Date.now() + 2000;
    while (!text.includes('event: application') && Date.now() < deadline) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    controller.abort();
    expect(text).toContain('event: application\ndata: {"applicationId":7,"status":"approved"}');
    expect(text).not.toContain('"applicationId":1');
  });
});

describe('English errors (x-ui-lang: en)', () => {
  it('translates web-generated errors and keeps Arabic by default', async () => {
    const { s, auth } = await setup();
    const en = await put(s, auth, { liveRoleId: '123' }, { 'x-ui-lang': 'en' });
    expect(en.json()).toMatchObject({ field: 'liveRoleId', message: 'Invalid ID, it must be a number of 17 to 20 digits' });
    const tz = await put(s, auth, { features: { timezone: 'Nope/Nope' } }, { 'x-ui-lang': 'en' });
    expect(tz.json().message).toBe('Invalid timezone (example: Asia/Riyadh)');
    const ar = await put(s, auth, { liveRoleId: '123' });
    expect(ar.json().message).toMatch(/[؀-ۿ]/);
    const notFound = await s.app.inject({ method: 'GET', url: '/api/nope', headers: { ...auth.headers, 'x-ui-lang': 'en' } });
    expect(notFound.json().message).toBe('Route not found');
    const unauth = await s.app.inject({ method: 'GET', url: '/api/me', headers: { 'x-ui-lang': 'en' } });
    expect(unauth.json().message).toBe('Log in first to use the dashboard');
  });

  it('i18n helpers', () => {
    expect(requestLanguage({ headers: { 'x-ui-lang': 'EN-us' } })).toBe('en');
    expect(requestLanguage({ headers: {} })).toBe('ar');
    expect(translateMessage('النص طويل، الحد 256 حرف')).toBe('Text too long, the limit is 256 characters');
    expect(translateMessage('شي ما نعرفه')).toBeNull();
    expect(localizeMessage('شي ما نعرفه', 'en')).toBe('شي ما نعرفه');
    expect(localizeMessage('الطلب غير صالح', 'ar')).toBe('الطلب غير صالح');
  });
});

describe('link routes wiring', () => {
  it('asLinkService only accepts a service with the OAuth flow methods', () => {
    expect(asLinkService(null)).toBeNull();
    expect(asLinkService({ isAvailable: () => true })).toBeNull();
    const svc = { authorizeRedirect: () => ({}), complete: async () => ({}), languageOfState: () => null };
    expect(asLinkService(svc)).toBe(svc);
  });

  it('registers /link/* when ctx.links is a LinkService', async () => {
    const env = createEnv();
    const fakeLink = {
      ...env.v2.links,
      authorizeRedirect: () => ({ url: 'https://id.twitch.tv/oauth2/authorize?x=1', nonce: 'n', platform: 'twitch', language: 'ar' }),
      complete: async () => {
        throw new Error('nope');
      },
      languageOfState: () => null,
    };
    env.ctx.links = fakeLink as unknown as TestEnv['ctx']['links'];
    server = await startServer(env);
    const res = await server.app.inject({ method: 'GET', url: '/link/start?t=abc' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('id.twitch.tv');
  });
});
