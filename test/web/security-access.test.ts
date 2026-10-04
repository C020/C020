/**
 * Web security regressions: account-level routes need a managed bot guild (and admins see full system details),
 * per-user resolve budget, fail-closed guild permission refresh, and SSE streams that stop when access ends.
 */
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RESOLVE_USER_LIMITS, UserBudget } from '../../src/web/routes/me.js';
import type { WebServer } from '../../src/web/server.js';
import type { WebServerOptions } from '../../src/web/types.js';
import { ADMIN, createEnv, FakeProviders, fakeProvider, GUILD, jsonResponse, login, manageable, NO_BOT_GUILD, startServer, USER, type TestEnv } from './helpers.js';

let server: WebServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

const MIN = 60_000;
const resolveBody = { platform: 'youtube', input: '@someone' };

/** Discord OAuth API mock whose /users/@me/guilds answer can be switched during a test. */
function guildsFetch(initial: () => Response) {
  let answer = initial;
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/users/@me/guilds')) return answer();
    if (url.endsWith('/oauth2/token/revoke')) return new Response('', { status: 200 });
    return new Response('not mocked', { status: 500 });
  });
  const guildCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes('/users/@me/guilds')).length;
  return { fetchMock, guildCalls, set: (next: () => Response) => (answer = next) };
}

async function start(env: TestEnv, options: WebServerOptions = {}): Promise<WebServer> {
  server = await startServer(env, options);
  return server;
}

describe('account-level routes (/api/platforms/resolve, /api/system)', () => {
  it('reject a logged-in Discord account that manages no guild the bot is in (403, nothing resolved)', async () => {
    const env = createEnv();
    const s = await start(env);
    for (const guilds of [[], [manageable(NO_BOT_GUILD)], [manageable(GUILD, { permissions: '1024' })]]) {
      const nobody = login(env, '123456789012345678', guilds);
      const resolve = await s.app.inject({ method: 'POST', url: '/api/platforms/resolve', headers: nobody.headers, payload: resolveBody });
      expect(resolve.statusCode).toBe(403);
      expect(resolve.json().error).toBe('forbidden');
      const system = await s.app.inject({ method: 'GET', url: '/api/system', headers: { cookie: nobody.cookie } });
      expect(system.statusCode).toBe(403);
    }
    expect(env.streamers.resolve).not.toHaveBeenCalled();
  });

  it('allow guild managers and ADMIN_USER_IDS (even with no guilds of their own)', async () => {
    const env = createEnv();
    const s = await start(env);
    for (const auth of [login(env, USER, [manageable(GUILD)]), login(env, ADMIN, [])]) {
      const resolve = await s.app.inject({ method: 'POST', url: '/api/platforms/resolve', headers: auth.headers, payload: resolveBody });
      expect(resolve.statusCode).toBe(200);
      const system = await s.app.inject({ method: 'GET', url: '/api/system', headers: { cookie: auth.cookie } });
      expect(system.statusCode).toBe(200);
    }
    expect(env.streamers.resolve).toHaveBeenCalledTimes(2);
  });

  it('answer 503 (not 403) for a manager while Discord is still connecting', async () => {
    const env = createEnv();
    env.discord.ready = false;
    env.discord.guildList.length = 0;
    const s = await start(env);
    const auth = login(env, USER, [manageable(GUILD)]);
    const res = await s.app.inject({ method: 'POST', url: '/api/platforms/resolve', headers: auth.headers, payload: resolveBody });
    expect(res.statusCode).toBe(503);
  });

  it('/api/system hides cross-guild provider notes and raw errors from non-admin managers', async () => {
    const secretNotes = ['تيك توك يقول إن هالحسابات غير موجودة: @other_guild_streamer', 'RSSHub http://user:pass@rsshub:1200'];
    const providers = new FakeProviders({
      tiktok: fakeProvider('tiktok', { notes: secretNotes }),
      kick: fakeProvider('kick', { configured: false, notes: ['KICK_CLIENT_ID ناقص'] }),
    });
    const env = createEnv({}, providers);
    env.monitor.runtime = [
      { platform: 'tiktok', trackedChannels: 9, liveChannels: 1, lastSuccessAt: null, lastError: 'fetch @other_guild_streamer: HTTP 403', consecutiveErrors: 4 },
    ];
    const s = await start(env);

    const manager = await s.app.inject({ method: 'GET', url: '/api/system', headers: { cookie: login(env, USER, [manageable(GUILD)]).cookie } });
    expect(manager.statusCode).toBe(200);
    const raw = manager.body;
    expect(raw).not.toContain('other_guild_streamer');
    expect(raw).not.toContain('rsshub');
    const mTiktok = manager.json().providers.find((p: { platform: string }) => p.platform === 'tiktok');
    // Counts and flags still drive the System page's status badges.
    expect(mTiktok).toMatchObject({ configured: true, trackedChannels: 9, liveChannels: 1, consecutiveErrors: 4, notes: [] });
    expect(typeof mTiktok.lastError).toBe('string');
    const mKick = manager.json().providers.find((p: { platform: string }) => p.platform === 'kick');
    expect(mKick.configured).toBe(false);
    expect(mKick.notes).toHaveLength(1);
    expect(mKick.notes[0]).not.toContain('KICK_CLIENT_ID');

    const admin = await s.app.inject({ method: 'GET', url: '/api/system', headers: { cookie: login(env, ADMIN, []).cookie } });
    const aTiktok = admin.json().providers.find((p: { platform: string }) => p.platform === 'tiktok');
    expect(aTiktok).toMatchObject({ notes: secretNotes, lastError: 'fetch @other_guild_streamer: HTTP 403' });
  });

  it('resolve has a per-user budget that holds across sessions and IP addresses', async () => {
    const env = createEnv();
    const s = await start(env);
    const sessions = [login(env, USER, [manageable(GUILD)]), login(env, USER, [manageable(GUILD)])];
    const call = (i: number) =>
      s.app.inject({
        method: 'POST',
        url: '/api/platforms/resolve',
        headers: sessions[i % 2]!.headers,
        payload: { platform: 'youtube', input: `@u${i}` },
        remoteAddress: `203.0.113.${i + 1}`,
      });
    const perMinute = RESOLVE_USER_LIMITS[0]!.max;
    for (let i = 0; i < perMinute; i++) expect((await call(i)).statusCode).toBe(200);
    const limited = await call(perMinute);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toBe('rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(env.streamers.resolve).toHaveBeenCalledTimes(perMinute);

    // Another manager is not affected.
    const other = login(env, '123456789012345670', [manageable(GUILD)]);
    const ok = await s.app.inject({ method: 'POST', url: '/api/platforms/resolve', headers: other.headers, payload: resolveBody, remoteAddress: '198.51.100.7' });
    expect(ok.statusCode).toBe(200);
  });

  it('UserBudget enforces every window, does not count rejected calls and reports the wait', () => {
    let now = 1_000_000;
    const budget = new UserBudget(
      [
        { max: 2, windowMs: MIN },
        { max: 3, windowMs: 60 * MIN },
      ],
      () => now,
    );
    expect(budget.take('u')).toBeNull();
    expect(budget.take('u')).toBeNull();
    expect(budget.take('u')).toBe(60); // minute window full
    now += 30_000;
    expect(budget.take('u')).toBe(30); // the rejected call above was not counted
    now += 30_000;
    expect(budget.take('u')).toBeNull(); // 3rd call this hour
    now += MIN;
    expect(budget.take('u')).toBe(Math.ceil((60 * MIN - 2 * MIN) / 1000)); // hour window full
    expect(budget.take('v')).toBeNull(); // per key
    now += 60 * MIN;
    expect(budget.take('u')).toBeNull();
  });
});

describe('guild permission refresh fails closed', () => {
  it('ends the session when Discord rejects the token (app deauthorized): 401, cookie cleared, nothing saved', async () => {
    const env = createEnv();
    const discord = guildsFetch(() => jsonResponse(401, { message: '401: Unauthorized' }));
    const s = await start(env, { fetch: discord.fetchMock as unknown as typeof fetch });
    const auth = login(env, USER, [manageable(GUILD)], { refreshedAt: new Date(Date.now() - 11 * MIN).toISOString() });

    const put = await s.app.inject({ method: 'PUT', url: `/api/guilds/${GUILD}/settings`, headers: auth.headers, payload: { pingMode: 'everyone' } });
    expect(put.statusCode).toBe(401);
    expect(String(put.headers['set-cookie'])).toContain('sb_session=;');
    expect(env.repos.settings.get(GUILD).pingMode).not.toBe('everyone');
    expect(env.repos.webSessions.get(auth.sessionId)).toBeNull();

    const again = await s.app.inject({ method: 'GET', url: `/api/guilds/${GUILD}/settings`, headers: { cookie: auth.cookie } });
    expect(again.statusCode).toBe(401);
    expect(discord.guildCalls()).toBe(1);
  });

  it('keeps cached permissions through short Discord outages, but not beyond 60 minutes', async () => {
    const env = createEnv();
    const discord = guildsFetch(() => new Response('upstream error', { status: 502 }));
    let now = Date.now();
    const s = await start(env, { fetch: discord.fetchMock as unknown as typeof fetch, now: () => now });
    const auth = login(env, USER, [manageable(GUILD)], { refreshedAt: new Date(now - 50 * MIN).toISOString() });
    const settings = () => s.app.inject({ method: 'GET', url: `/api/guilds/${GUILD}/settings`, headers: { cookie: auth.cookie } });

    expect((await settings()).statusCode).toBe(200); // 50 minutes old: still trusted

    now += 11 * MIN; // 61 minutes since the last successful refresh, Discord still failing
    const stale = await settings();
    expect(stale.statusCode).toBe(503);
    expect(stale.json().error).toBe('permissions_unverified');
    const me = await s.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: auth.cookie } });
    expect(me.json().guilds).toEqual([]);
    const resolve = await s.app.inject({ method: 'POST', url: '/api/platforms/resolve', headers: auth.headers, payload: resolveBody });
    expect(resolve.statusCode).toBe(503);
    expect(env.streamers.resolve).not.toHaveBeenCalled();

    // Discord recovers: the next refresh (after the back-off) restores access.
    discord.set(() => jsonResponse(200, [{ id: GUILD, name: 'Main', icon: null, owner: false, permissions: '32' }]));
    now += 2 * MIN;
    expect((await settings()).statusCode).toBe(200);
  });

  it('ADMIN_USER_IDS keep access with stale guild data (authorization comes from the config)', async () => {
    const env = createEnv();
    const discord = guildsFetch(() => new Response('upstream error', { status: 502 }));
    const s = await start(env, { fetch: discord.fetchMock as unknown as typeof fetch });
    const admin = login(env, ADMIN, [], { refreshedAt: new Date(Date.now() - 3 * 60 * MIN).toISOString() });
    const res = await s.app.inject({ method: 'GET', url: `/api/guilds/${GUILD}/settings`, headers: { cookie: admin.cookie } });
    expect(res.statusCode).toBe(200);
  });
});

describe('SSE streams re-check access on every heartbeat', () => {
  async function listen(s: WebServer): Promise<string> {
    await s.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = s.app.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  /** Reads until the server ends the stream; returns false if it is still open after the timeout. */
  async function endsWithin(res: Response, timeoutMs = 2000): Promise<boolean> {
    const reader = res.body!.getReader();
    const deadline = Date.now() + timeoutMs;
    try {
      while (Date.now() < deadline) {
        const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), Math.max(0, deadline - Date.now())))]);
        if (!chunk) return false;
        if (chunk.done) return true;
      }
      return false;
    } finally {
      reader.releaseLock(); // the stream may still be open: later checks read it again
    }
  }

  async function openStream(options: WebServerOptions = {}, guilds = [manageable(GUILD)]) {
    const env = createEnv();
    const s = await start(env, { sseHeartbeatMs: 30, ...options });
    const url = await listen(s);
    const auth = login(env, USER, guilds);
    const res = await fetch(`${url}/api/guilds/${GUILD}/events`, { headers: { cookie: auth.cookie } });
    expect(res.status).toBe(200);
    return { env, auth, res };
  }

  it('keeps a valid stream open (pings keep coming)', async () => {
    const { res } = await openStream();
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const deadline = Date.now() + 2000;
    while (!text.includes('event: ping') && Date.now() < deadline) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    await reader.cancel();
    expect(text).toContain('event: ping');
  });

  it('closes when the stored guild permissions no longer allow the guild', async () => {
    const { env, auth, res } = await openStream();
    env.repos.webSessions.updateGuilds(auth.sessionId, [manageable(GUILD, { permissions: '1024' })]);
    expect(await endsWithin(res)).toBe(true);
  });

  it('closes an expired session that has not been pruned yet', async () => {
    let now = Date.now();
    const discord = guildsFetch(() => jsonResponse(200, [{ id: GUILD, name: 'Main', icon: null, owner: false, permissions: '32' }]));
    const { res } = await openStream({ now: () => now, fetch: discord.fetchMock as unknown as typeof fetch });
    now += 2 * 24 * 60 * MIN; // login() sessions expire after one day
    expect(await endsWithin(res)).toBe(true);
  });

  it('refreshes guild permissions for an idle tab and closes once Manage Server is gone', async () => {
    let now = Date.now();
    const discord = guildsFetch(() => jsonResponse(200, [{ id: GUILD, name: 'Main', icon: null, owner: false, permissions: '32' }]));
    const { res } = await openStream({ now: () => now, fetch: discord.fetchMock as unknown as typeof fetch });
    expect(await endsWithin(res, 200)).toBe(false);
    expect(discord.guildCalls()).toBe(0);

    discord.set(() => jsonResponse(200, [{ id: GUILD, name: 'Main', icon: null, owner: false, permissions: '1024' }]));
    now += 11 * MIN;
    expect(await endsWithin(res)).toBe(true);
    expect(discord.guildCalls()).toBe(1);
  });

  it('closes when the refresh finds the token revoked (and the session is ended)', async () => {
    let now = Date.now();
    const discord = guildsFetch(() => jsonResponse(401, { message: '401: Unauthorized' }));
    const { env, auth, res } = await openStream({ now: () => now, fetch: discord.fetchMock as unknown as typeof fetch });
    now += 11 * MIN;
    expect(await endsWithin(res)).toBe(true);
    expect(env.repos.webSessions.get(auth.sessionId)).toBeNull();
  });
});
