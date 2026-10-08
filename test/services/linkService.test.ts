import { beforeEach, describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/core/errors.js';
import { LinkFlowError } from '../../src/services/linkService.js';
import { GUILD, T0, USER, begin, json, makeHarness, tiktokRoutes, twitchRoutes } from './linkService-helpers.js';

const MIN = 60_000;

describe('LinkService availability & start URLs', () => {
  it('requires credentials, PUBLIC_URL and SESSION_SECRET', () => {
    expect(makeHarness().service.isAvailable('twitch')).toBe(true);
    expect(makeHarness().service.isAvailable('tiktok')).toBe(true);
    expect(makeHarness({ TIKTOK_CLIENT_KEY: undefined }).service.isAvailable('tiktok')).toBe(false);
    expect(makeHarness({ SESSION_SECRET: undefined }).service.isAvailable('twitch')).toBe(false);
    expect(makeHarness({ PUBLIC_URL: undefined }).service.isAvailable('twitch')).toBe(false);
    expect(() => makeHarness({ TWITCH_CLIENT_ID: undefined }).service.startUrl(GUILD, USER, 'twitch')).toThrow(ValidationError);
  });

  it('builds a signed start URL and Twitch/TikTok authorize redirects', () => {
    const { service } = makeHarness();
    const { start, redirect } = begin(service, 'twitch');
    expect(start.origin + start.pathname).toBe('https://bot.example.com/link/start');
    const tw = new URL(redirect.url);
    expect(tw.origin + tw.pathname).toBe('https://id.twitch.tv/oauth2/authorize');
    expect(Object.fromEntries(tw.searchParams)).toMatchObject({
      client_id: 'tw-id',
      response_type: 'code',
      scope: '',
      force_verify: 'true',
      redirect_uri: 'https://bot.example.com/link/callback/twitch',
    });
    const tt = new URL(begin(service, 'tiktok').redirect.url);
    expect(tt.origin + tt.pathname).toBe('https://www.tiktok.com/v2/auth/authorize/');
    expect(Object.fromEntries(tt.searchParams)).toMatchObject({
      client_key: 'tt-key',
      scope: 'user.info.basic,user.info.profile,video.list',
      response_type: 'code',
      redirect_uri: 'https://bot.example.com/link/callback/tiktok',
    });
  });

  it('rejects tampered, expired, wrong-kind tokens and disabled guilds', () => {
    const h = makeHarness();
    const t = new URL(h.service.startUrl(GUILD, USER, 'twitch')).searchParams.get('t')!;
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (err) {
        return err instanceof LinkFlowError ? err.code : 'other';
      }
      return 'none';
    };
    expect(code(() => h.service.authorizeRedirect(`${t}x`))).toBe('invalid');
    expect(code(() => h.service.authorizeRedirect(undefined))).toBe('invalid');
    // A state token cannot be used as a start token.
    expect(code(() => h.service.authorizeRedirect(begin(h.service).state))).toBe('invalid');
    h.clock.now += 16 * MIN;
    expect(code(() => h.service.authorizeRedirect(t))).toBe('expired');
    h.clock.now = T0;
    h.repos.settings.update(GUILD, { features: { linking: { enabled: false } } } as never);
    expect(code(() => h.service.authorizeRedirect(t))).toBe('disabled');
  });
});

describe('LinkService callback', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  it('Twitch: exchanges the code, stores an identity-only link, discards the token and audits', async () => {
    twitchRoutes(h.http);
    const { state, nonce } = begin(h.service);
    const result = await h.service.complete('twitch', { code: 'abc', state }, nonce);
    expect(result).toMatchObject({ guildId: GUILD, userId: USER, platform: 'twitch', login: 'alpha', account: 'not_streamer', language: 'ar' });
    const tokenCall = h.http.to('POST https://id.twitch.tv/oauth2/token')[0]!;
    expect(Object.fromEntries(tokenCall.body!)).toMatchObject({ client_id: 'tw-id', client_secret: 'tw-secret', code: 'abc', grant_type: 'authorization_code', redirect_uri: 'https://bot.example.com/link/callback/twitch' });
    const users = h.http.to('GET https://api.twitch.tv/helix/users')[0]!;
    expect((users.init.headers as Record<string, string>).authorization).toBe('Bearer tw-user-token');
    expect((users.init.headers as Record<string, string>)['client-id']).toBe('tw-id');
    const link = h.repos.links.get(USER, 'twitch')!;
    expect(link).toMatchObject({ platformUserId: '4242', platformLogin: 'alpha', accessTokenEnc: null, refreshTokenEnc: null });
    await new Promise((r) => setImmediate(r));
    expect(h.http.to('POST https://id.twitch.tv/oauth2/revoke')).toHaveLength(1);
    const audit = h.repos.audit.list({ guildId: GUILD } as never) as unknown as Array<{ action: string; message: string }>;
    expect(JSON.stringify(audit)).toContain('link.created');
    expect(JSON.stringify(audit)).not.toContain('tw-user-token');
  });

  it('rejects replays, missing cookie binding, denials and platform mismatches', async () => {
    twitchRoutes(h.http);
    const { state, nonce } = begin(h.service);
    await expect(h.service.complete('twitch', { code: 'abc', state }, 'other-nonce')).rejects.toMatchObject({ code: 'invalid' });
    await expect(h.service.complete('tiktok', { code: 'abc', state }, nonce)).rejects.toMatchObject({ code: 'invalid' });
    await expect(h.service.complete('nope', { code: 'abc', state }, nonce)).rejects.toMatchObject({ code: 'invalid' });
    await h.service.complete('twitch', { code: 'abc', state }, nonce);
    await expect(h.service.complete('twitch', { code: 'abc', state }, nonce)).rejects.toMatchObject({ code: 'replay' });
    const second = begin(h.service);
    await expect(h.service.complete('twitch', { error: 'access_denied', state: second.state }, second.nonce)).rejects.toMatchObject({ code: 'denied' });
    const third = begin(h.service);
    h.clock.now += 16 * MIN;
    await expect(h.service.complete('twitch', { code: 'x', state: third.state }, third.nonce)).rejects.toMatchObject({ code: 'expired' });
  });

  it('maps exchange failures (HTTP error or network) to exchange_failed', async () => {
    h.http.routes.set('POST https://id.twitch.tv/oauth2/token', () => json({ message: 'Invalid authorization code' }, 400));
    const a = begin(h.service);
    await expect(h.service.complete('twitch', { code: 'bad', state: a.state }, a.nonce)).rejects.toMatchObject({ code: 'exchange_failed' });
    h.http.routes.set('POST https://id.twitch.tv/oauth2/token', () => {
      throw new TypeError('fetch failed');
    });
    const b = begin(h.service);
    await expect(h.service.complete('twitch', { code: 'c', state: b.state }, b.nonce)).rejects.toBeInstanceOf(LinkFlowError);
    expect(h.repos.links.get(USER, 'twitch')).toBeNull();
  });

  it('refuses a platform account already linked to another member', async () => {
    twitchRoutes(h.http);
    h.repos.links.upsert({ discordUserId: '333333333333333333', platform: 'twitch', platformUserId: '4242', platformLogin: 'alpha', displayName: null, accessTokenEnc: null, refreshTokenEnc: null, scopes: [], accessExpiresAt: null, refreshExpiresAt: null });
    const { state, nonce } = begin(h.service);
    await expect(h.service.complete('twitch', { code: 'abc', state }, nonce)).rejects.toMatchObject({ code: 'already_linked' });
  });

  it('auto-adds the account to a registered streamer, or reports verified / mismatch', async () => {
    twitchRoutes(h.http);
    const streamer = h.repos.streamers.create({ guildId: GUILD, discordUserId: USER, displayName: 'S' });
    let flow = begin(h.service);
    expect((await h.service.complete('twitch', { code: 'a', state: flow.state }, flow.nonce)).account).toBe('added');
    expect(h.added).toEqual([{ streamerId: streamer.id, platform: 'twitch', input: 'id:4242' }]);

    h.accounts.push({ channel: { platform: 'twitch', platformId: '4242', handle: 'alpha' } });
    flow = begin(h.service);
    expect((await h.service.complete('twitch', { code: 'a', state: flow.state }, flow.nonce)).account).toBe('verified');
    h.accounts[0]!.channel.platformId = '999';
    flow = begin(h.service);
    expect((await h.service.complete('twitch', { code: 'a', state: flow.state }, flow.nonce)).account).toBe('mismatch');
    expect(h.added).toHaveLength(1);
  });

  it('a failing auto-add does not fail the link', async () => {
    tiktokRoutes(h.http);
    h.repos.streamers.create({ guildId: GUILD, discordUserId: USER, displayName: 'S' });
    h.failAdd();
    const flow = begin(h.service, 'tiktok');
    const result = await h.service.complete('tiktok', { code: 'a', state: flow.state }, flow.nonce);
    expect(result.account).toBe('add_failed');
    expect(h.repos.links.get(USER, 'tiktok')).not.toBeNull();
  });

  it('TikTok: stores encrypted tokens and adds the username to the streamer', async () => {
    tiktokRoutes(h.http);
    h.repos.streamers.create({ guildId: GUILD, discordUserId: USER, displayName: 'S' });
    const flow = begin(h.service, 'tiktok');
    const result = await h.service.complete('tiktok', { code: 'tc', state: flow.state }, flow.nonce);
    expect(result).toMatchObject({ login: 'streamer.one', account: 'added' });
    expect(h.added[0]).toMatchObject({ platform: 'tiktok', input: 'streamer.one' });
    const tokenCall = h.http.to('POST https://open.tiktokapis.com/v2/oauth/token/')[0]!;
    expect(Object.fromEntries(tokenCall.body!)).toMatchObject({ client_key: 'tt-key', client_secret: 'tt-secret', code: 'tc', grant_type: 'authorization_code' });
    const link = h.repos.links.get(USER, 'tiktok')!;
    expect(link.platformUserId).toBe('open-1');
    expect(link.accessTokenEnc).toMatch(/^v1\./);
    expect(link.accessTokenEnc).not.toContain('tt-access-1');
    expect(h.service.decrypt(link.accessTokenEnc!)).toBe('tt-access-1');
    expect(h.service.decrypt(link.refreshTokenEnc!)).toBe('tt-refresh-1');
    expect(link.scopes).toEqual(['user.info.basic', 'video.list']);
    expect(link.accessExpiresAt).toBe(new Date(T0 + 86_400_000).toISOString());
  });

  it('TikTok without a username: link stored, nothing added', async () => {
    tiktokRoutes(h.http, null);
    h.repos.streamers.create({ guildId: GUILD, discordUserId: USER, displayName: 'S' });
    const flow = begin(h.service, 'tiktok');
    expect((await h.service.complete('tiktok', { code: 'tc', state: flow.state }, flow.nonce)).account).toBe('no_handle');
  });
});

describe('LinkService crypto', () => {
  it('round-trips, detects tampering and other secrets', () => {
    const a = makeHarness().service;
    const enc = a.encrypt('secret-token');
    expect(a.decrypt(enc)).toBe('secret-token');
    expect(a.encrypt('secret-token')).not.toBe(enc); // random IV
    const tampered = `${enc.slice(0, -2)}${enc.endsWith('A') ? 'B' : 'A'}A`;
    expect(a.decrypt(tampered)).toBeNull();
    expect(a.decrypt('garbage')).toBeNull();
    expect(makeHarness({ SESSION_SECRET: 'y'.repeat(40) }).service.decrypt(enc)).toBeNull();
  });
});

describe('LinkService TikTok token source', () => {
  async function linked() {
    const h = makeHarness();
    tiktokRoutes(h.http);
    const flow = begin(h.service, 'tiktok');
    await h.service.complete('tiktok', { code: 'tc', state: flow.state }, flow.nonce);
    h.http.calls.length = 0;
    return h;
  }

  it('returns the stored token by handle (case/@ insensitive) and null when not linked', async () => {
    const h = await linked();
    expect(await h.service.tiktokAccessToken('@Streamer.One')).toEqual({ accessToken: 'tt-access-1', openId: 'open-1' });
    expect(await h.service.tiktokAccessToken('someone.else')).toBeNull();
    expect(h.http.calls).toHaveLength(0);
  });

  it('refreshes shortly before expiry (once for concurrent callers) and stores the new tokens', async () => {
    const h = await linked();
    h.clock.now = T0 + 86_400_000 - 2 * MIN;
    const [a, b] = await Promise.all([h.service.tiktokAccessToken('streamer.one'), h.service.tiktokAccessToken('streamer.one')]);
    expect(a?.accessToken).toBe('tt-access-2');
    expect(b?.accessToken).toBe('tt-access-2');
    const refreshCalls = h.http.to('POST https://open.tiktokapis.com/v2/oauth/token/');
    expect(refreshCalls).toHaveLength(1);
    expect(Object.fromEntries(refreshCalls[0]!.body!)).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'tt-refresh-1' });
    const link = h.repos.links.get(USER, 'tiktok')!;
    expect(h.service.decrypt(link.refreshTokenEnc!)).toBe('tt-refresh-2');
  });

  it('revoked refresh token: clears tokens, keeps the link, audits', async () => {
    const h = await linked();
    h.http.routes.set('POST https://open.tiktokapis.com/v2/oauth/token/', () => json({ error: 'invalid_grant', error_description: 'revoked' }));
    h.clock.now = T0 + 86_400_000 + MIN;
    expect(await h.service.tiktokAccessToken('streamer.one')).toBeNull();
    const link = h.repos.links.get(USER, 'tiktok')!;
    expect(link.accessTokenEnc).toBeNull();
    expect(link.refreshTokenEnc).toBeNull();
    expect(JSON.stringify(h.repos.audit.list({} as never))).toContain('link.tokens_revoked');
    expect(await h.service.tiktokAccessToken('streamer.one')).toBeNull();
  });

  it('transient refresh failure keeps tokens and uses the still-valid access token', async () => {
    const h = await linked();
    h.http.routes.set('POST https://open.tiktokapis.com/v2/oauth/token/', () => json({}, 503));
    h.clock.now = T0 + 86_400_000 - 2 * MIN;
    expect((await h.service.tiktokAccessToken('streamer.one'))?.accessToken).toBe('tt-access-1');
    h.clock.now = T0 + 86_400_000 + MIN;
    expect(await h.service.tiktokAccessToken('streamer.one')).toBeNull();
    expect(h.repos.links.get(USER, 'tiktok')!.refreshTokenEnc).not.toBeNull();
  });

  it('unlink revokes (best effort), deletes and audits', async () => {
    const h = await linked();
    h.http.routes.set('POST https://open.tiktokapis.com/v2/oauth/revoke/', () => {
      throw new TypeError('network');
    });
    expect(h.service.linksFor(USER)).toHaveLength(1);
    expect(await h.service.unlink(USER, 'tiktok', `user:${USER}`)).toBe(true);
    expect(h.http.to('POST https://open.tiktokapis.com/v2/oauth/revoke/')).toHaveLength(1);
    expect(h.service.linksFor(USER)).toHaveLength(0);
    expect(await h.service.unlink(USER, 'tiktok', `user:${USER}`)).toBe(false);
  });
});
