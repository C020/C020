import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebServer } from '../../src/web/server.js';
import { ADMIN, createEnv, GUILD, jsonResponse, login, manageable, NO_BOT_GUILD, OTHER_GUILD, startServer, USER, type TestEnv } from './helpers.js';

let server: WebServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

type FetchCall = { url: string; init: RequestInit };

/** Mocked Discord API: token exchange, /users/@me and /users/@me/guilds. */
function discordFetch(overrides: Partial<Record<'token' | 'user' | 'guilds', () => Response>> = {}) {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/oauth2/token')) {
      return overrides.token?.() ?? jsonResponse(200, { access_token: 'acc-1', token_type: 'Bearer', expires_in: 604800, scope: 'identify guilds' });
    }
    if (url.endsWith('/users/@me')) {
      return overrides.user?.() ?? jsonResponse(200, { id: USER, username: 'azoz', global_name: 'عزوز', avatar: 'abc', discriminator: '0' });
    }
    if (url.includes('/users/@me/guilds')) {
      return (
        overrides.guilds?.() ??
        jsonResponse(200, [
          { id: GUILD, name: 'Main', icon: null, owner: false, permissions: '32' },
          { id: OTHER_GUILD, name: 'Member only', icon: null, owner: false, permissions: '1024' },
          { id: NO_BOT_GUILD, name: 'No bot', icon: null, owner: true, permissions: '0' },
        ])
      );
    }
    if (url.endsWith('/oauth2/token/revoke')) return new Response('', { status: 200 });
    return new Response('not mocked', { status: 500 });
  });
  return { fetchMock, calls };
}

function cookieValue(setCookie: string | string[] | undefined, name: string): string | null {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const c of list) {
    const [pair] = c.split(';');
    const [k, ...v] = pair!.split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

async function beginLogin(env: TestEnv, fetchMock: ReturnType<typeof discordFetch>['fetchMock'], next?: string) {
  server = await startServer(env, { fetch: fetchMock as unknown as typeof fetch });
  const res = await server.app.inject({ method: 'GET', url: `/auth/login${next ? `?next=${encodeURIComponent(next)}` : ''}` });
  const location = new URL(String(res.headers.location));
  const stateCookie = cookieValue(res.headers['set-cookie'], 'sb_oauth_state');
  return { res, location, state: location.searchParams.get('state')!, stateCookie: stateCookie! };
}

describe('Discord OAuth2 login', () => {
  it('redirects to Discord with state, scopes and the PUBLIC_URL callback', async () => {
    const env = createEnv();
    const { res, location, state, stateCookie } = await beginLogin(env, discordFetch().fetchMock);
    expect(res.statusCode).toBe(302);
    expect(location.origin + location.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(location.searchParams.get('client_id')).toBe('999999999999999999');
    expect(location.searchParams.get('redirect_uri')).toBe('https://bot.example.com/auth/callback');
    expect(location.searchParams.get('response_type')).toBe('code');
    expect(location.searchParams.get('scope')).toBe('identify guilds');
    expect(location.searchParams.get('prompt')).toBe('none');
    expect(String(res.headers.location)).toContain('scope=identify%20guilds');
    expect(state.length).toBeGreaterThanOrEqual(32);
    expect(stateCookie).toBeTruthy();
    const raw = ([] as string[]).concat(res.headers['set-cookie'] ?? []).join(';');
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/Secure/i);
    expect(raw).toMatch(/SameSite=Lax/i);
  });

  it('completes the callback: exchanges the code, stores a hashed session and redirects', async () => {
    const env = createEnv();
    const { fetchMock, calls } = discordFetch();
    const { state, stateCookie } = await beginLogin(env, fetchMock, '/guilds/111111111111111111');

    const res = await server!.app.inject({
      method: 'GET',
      url: `/auth/callback?code=the-code&state=${state}`,
      headers: { cookie: `sb_oauth_state=${stateCookie}` },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/guilds/111111111111111111');

    const token = cookieValue(res.headers['set-cookie'], 'sb_session');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const raw = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('sb_session='))!;
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/Secure/i);
    expect(raw).toMatch(/SameSite=Lax/i);
    expect(raw).toMatch(/Max-Age=604800/);

    // The DB never stores the cookie value itself.
    const id = createHash('sha256').update(token!).digest('hex');
    const session = env.repos.webSessions.get(id);
    expect(session).not.toBeNull();
    expect(session!.userId).toBe(USER);
    expect(session!.username).toBe('عزوز');
    expect(session!.avatarUrl).toBe(`https://cdn.discordapp.com/avatars/${USER}/abc.png?size=128`);
    expect(session!.accessToken).toBe('acc-1');
    // Only guilds the user can manage are kept.
    expect(session!.guilds.map((g) => g.id).sort()).toEqual([GUILD, NO_BOT_GUILD].sort());

    // Token exchange: form-encoded body + HTTP basic client auth.
    const tokenCall = calls.find((c) => c.url.endsWith('/oauth2/token'))!;
    expect(tokenCall.init.method).toBe('POST');
    const headers = tokenCall.init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(headers.authorization).toBe(`Basic ${Buffer.from('999999999999999999:client-secret').toString('base64')}`);
    const form = new URLSearchParams(String(tokenCall.init.body));
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('the-code');
    expect(form.get('redirect_uri')).toBe('https://bot.example.com/auth/callback');

    // The new session works for the API; only guilds with the bot + manage permission are listed.
    const me = await server!.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `sb_session=${token}` } });
    expect(me.statusCode).toBe(200);
    const body = me.json();
    expect(body.user).toMatchObject({ id: USER, username: 'عزوز' });
    expect(body.guilds.map((g: { id: string }) => g.id)).toEqual([GUILD]);
    expect(typeof body.csrfToken).toBe('string');
    expect(body.bot).toMatchObject({ username: 'StreamBot', ready: true });
    expect(body.inviteUrl).toContain('discord.com/oauth2/authorize');
  });

  it('rejects a callback whose state does not match the signed cookie', async () => {
    const env = createEnv();
    const { fetchMock } = discordFetch();
    const { stateCookie } = await beginLogin(env, fetchMock);
    const res = await server!.app.inject({
      method: 'GET',
      url: '/auth/callback?code=c&state=forged-state-value',
      headers: { cookie: `sb_oauth_state=${stateCookie}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('/auth/login');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a tampered (unsigned) state cookie', async () => {
    const env = createEnv();
    const { fetchMock } = discordFetch();
    const { state } = await beginLogin(env, fetchMock);
    const res = await server!.app.inject({
      method: 'GET',
      url: `/auth/callback?code=c&state=${state}`,
      headers: { cookie: `sb_oauth_state=${state}.Lw.forgedsignature` },
    });
    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows an Arabic error page when Discord rejects the code', async () => {
    const env = createEnv();
    const { fetchMock } = discordFetch({ token: () => jsonResponse(400, { error: 'invalid_grant' }) });
    const { state, stateCookie } = await beginLogin(env, fetchMock);
    const res = await server!.app.inject({ method: 'GET', url: `/auth/callback?code=old&state=${state}`, headers: { cookie: `sb_oauth_state=${stateCookie}` } });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('انتهت صلاحيته');
    expect(cookieValue(res.headers['set-cookie'], 'sb_session')).toBeNull();
  });

  it('handles the user cancelling on Discord', async () => {
    const env = createEnv();
    const { fetchMock } = discordFetch();
    const { stateCookie } = await beginLogin(env, fetchMock);
    const res = await server!.app.inject({ method: 'GET', url: '/auth/callback?error=access_denied&state=x', headers: { cookie: `sb_oauth_state=${stateCookie}` } });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('لغيت');
  });

  it('retries once with the consent screen when silent authorization is not possible', async () => {
    const env = createEnv();
    const { fetchMock } = discordFetch();
    const { state, stateCookie } = await beginLogin(env, fetchMock, '/settings');
    const res = await server!.app.inject({
      method: 'GET',
      url: `/auth/callback?error=consent_required&state=${state}`,
      headers: { cookie: `sb_oauth_state=${stateCookie}` },
    });
    expect(res.statusCode).toBe(302);
    const location = new URL(String(res.headers.location));
    expect(location.searchParams.get('prompt')).toBe('consent');
    const retryCookie = cookieValue(res.headers['set-cookie'], 'sb_oauth_state')!;
    expect(retryCookie).toBeTruthy();

    // A second consent error does not loop.
    const again = await server!.app.inject({
      method: 'GET',
      url: `/auth/callback?error=consent_required&state=${location.searchParams.get('state')}`,
      headers: { cookie: `sb_oauth_state=${retryCookie}` },
    });
    expect(again.statusCode).toBe(400);
  });

  it('never redirects to another site after login', async () => {
    const env = createEnv();
    const { fetchMock } = discordFetch();
    const { state, stateCookie } = await beginLogin(env, fetchMock, '//evil.example.com/x');
    const res = await server!.app.inject({ method: 'GET', url: `/auth/callback?code=c&state=${state}`, headers: { cookie: `sb_oauth_state=${stateCookie}` } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
  });
});

describe('sessions, logout and CSRF', () => {
  it('requires a session for the API (401) and ignores garbage cookies', async () => {
    const env = createEnv();
    server = await startServer(env);
    for (const cookie of [undefined, 'sb_session=short', `sb_session=${'x'.repeat(43)}`]) {
      const res = await server.app.inject({ method: 'GET', url: '/api/me', headers: cookie ? { cookie } : {} });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: 'unauthorized' });
    }
  });

  it('rejects mutating requests without a valid CSRF token (403)', async () => {
    const env = createEnv();
    server = await startServer(env);
    const { cookie, csrf } = login(env);
    const url = `/api/guilds/${GUILD}/sync-roles`;
    const missing = await server.app.inject({ method: 'POST', url, headers: { cookie } });
    expect(missing.statusCode).toBe(403);
    expect(missing.json()).toMatchObject({ error: 'csrf' });
    const wrong = await server.app.inject({ method: 'POST', url, headers: { cookie, 'x-csrf-token': `${csrf.slice(0, -2)}xx` } });
    expect(wrong.statusCode).toBe(403);
    // A token from another session is useless.
    const other = login(env, USER);
    const crossed = await server.app.inject({ method: 'POST', url, headers: { cookie, 'x-csrf-token': other.csrf } });
    expect(crossed.statusCode).toBe(403);
    const ok = await server.app.inject({ method: 'POST', url, headers: { cookie, 'x-csrf-token': csrf } });
    expect(ok.statusCode).toBe(200);
    expect(env.sessions.syncRoles).toHaveBeenCalledTimes(1);
  });

  it('GET requests do not need the CSRF token, and /api/me returns the right one', async () => {
    const env = createEnv();
    server = await startServer(env);
    const { cookie, csrf } = login(env);
    const me = await server.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(me.json().csrfToken).toBe(csrf);
  });

  it('logout requires CSRF, deletes the session and clears the cookie', async () => {
    const env = createEnv();
    const { fetchMock, calls } = discordFetch();
    server = await startServer(env, { fetch: fetchMock as unknown as typeof fetch });
    const { cookie, csrf, sessionId } = login(env);

    const denied = await server.app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } });
    expect(denied.statusCode).toBe(403);
    expect(env.repos.webSessions.get(sessionId)).not.toBeNull();

    const res = await server.app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie, 'x-csrf-token': csrf } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(env.repos.webSessions.get(sessionId)).toBeNull();
    expect(cookieValue(res.headers['set-cookie'], 'sb_session')).toBe('');
    await new Promise((r) => setImmediate(r));
    expect(calls.some((c) => c.url.endsWith('/oauth2/token/revoke'))).toBe(true);

    const after = await server.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(after.statusCode).toBe(401);

    // Logging out without a session is a harmless no-op.
    const again = await server.app.inject({ method: 'POST', url: '/auth/logout' });
    expect(again.statusCode).toBe(200);
  });
});

describe('guild permissions', () => {
  it('forbids guilds the user cannot manage, and guilds without the bot', async () => {
    const env = createEnv();
    server = await startServer(env);
    const { cookie } = login(env, USER, [
      manageable(GUILD),
      manageable(OTHER_GUILD, { permissions: String(0x400) }), // view channel only
      manageable(NO_BOT_GUILD, { owner: true }),
    ]);
    const ok = await server.app.inject({ method: 'GET', url: `/api/guilds/${GUILD}/settings`, headers: { cookie } });
    expect(ok.statusCode).toBe(200);

    const noPerm = await server.app.inject({ method: 'GET', url: `/api/guilds/${OTHER_GUILD}/settings`, headers: { cookie } });
    expect(noPerm.statusCode).toBe(403);
    expect(noPerm.json()).toMatchObject({ error: 'forbidden' });

    const noBot = await server.app.inject({ method: 'GET', url: `/api/guilds/${NO_BOT_GUILD}/settings`, headers: { cookie } });
    expect(noBot.statusCode).toBe(403);
    expect(noBot.json().message).toContain('البوت');
  });

  it('accepts Administrator (0x8) and large permission bitfields', async () => {
    const env = createEnv();
    server = await startServer(env);
    const big = (1n << 50n) | 0x8n;
    const { cookie } = login(env, USER, [manageable(GUILD, { permissions: big.toString() })]);
    const res = await server.app.inject({ method: 'GET', url: `/api/guilds/${GUILD}/settings`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
  });

  it('lets ADMIN_USER_IDS manage every bot guild', async () => {
    const env = createEnv();
    server = await startServer(env);
    const { cookie } = login(env, ADMIN, []);
    const me = await server.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(me.json().guilds.map((g: { id: string }) => g.id).sort()).toEqual([GUILD, OTHER_GUILD].sort());
    const res = await server.app.inject({ method: 'GET', url: `/api/guilds/${OTHER_GUILD}/settings`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const noBot = await server.app.inject({ method: 'GET', url: `/api/guilds/${NO_BOT_GUILD}/settings`, headers: { cookie } });
    expect(noBot.statusCode).toBe(403);
  });

  it('returns 503 instead of 403 while Discord is still connecting', async () => {
    const env = createEnv();
    env.discord.ready = false;
    env.discord.guildList.length = 0;
    server = await startServer(env);
    const { cookie } = login(env);
    const res = await server.app.inject({ method: 'GET', url: `/api/guilds/${GUILD}/settings`, headers: { cookie } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'discord_unavailable' });
  });

  it('rejects malformed guild ids with a validation error', async () => {
    const env = createEnv();
    server = await startServer(env);
    const { cookie } = login(env);
    const res = await server.app.inject({ method: 'GET', url: '/api/guilds/not-a-snowflake/settings', headers: { cookie } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'validation', field: 'guildId' });
  });
});

describe('guild list refresh', () => {
  const stale = () => new Date(Date.now() - 11 * 60_000).toISOString();

  it('refreshes guild permissions from Discord when the cache is older than 10 minutes', async () => {
    const env = createEnv();
    const { fetchMock } = discordFetch({
      guilds: () => jsonResponse(200, [{ id: OTHER_GUILD, name: 'Now admin', icon: null, owner: false, permissions: '8' }]),
    });
    server = await startServer(env, { fetch: fetchMock as unknown as typeof fetch });
    const { cookie, sessionId } = login(env, USER, [manageable(GUILD)], { refreshedAt: stale() });

    // Parallel requests share one refresh.
    const [a, b] = await Promise.all([
      server.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } }),
      server.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } }),
    ]);
    expect(a.json().guilds.map((g: { id: string }) => g.id)).toEqual([OTHER_GUILD]);
    expect(b.statusCode).toBe(200);
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/users/@me/guilds'))).toHaveLength(1);

    const stored = env.repos.webSessions.get(sessionId)!;
    expect(stored.guilds.map((g) => g.id)).toEqual([OTHER_GUILD]);
    expect(Date.now() - Date.parse(stored.guildsRefreshedAt)).toBeLessThan(5000);

    // Permission revoked in GUILD → now forbidden.
    const res = await server.app.inject({ method: 'GET', url: `/api/guilds/${GUILD}/settings`, headers: { cookie } });
    expect(res.statusCode).toBe(403);
  });

  it('keeps the cached guilds when Discord fails, and backs off', async () => {
    const env = createEnv();
    const { fetchMock } = discordFetch({ guilds: () => new Response('upstream error', { status: 502 }) });
    server = await startServer(env, { fetch: fetchMock as unknown as typeof fetch });
    const { cookie } = login(env, USER, [manageable(GUILD)], { refreshedAt: stale() });

    const res = await server.app.inject({ method: 'GET', url: `/api/guilds/${GUILD}/settings`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    await server.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/users/@me/guilds'))).toHaveLength(1);
  });
});
