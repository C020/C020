/** Shared fakes for the #11 LinkService / link route tests. */
import type { StreamerServiceApi } from '../../src/app/context.js';
import { loadConfig } from '../../src/config.js';
import { AppEvents } from '../../src/core/events.js';
import { ValidationError } from '../../src/core/errors.js';
import { openDatabase } from '../../src/db/database.js';
import { Repositories } from '../../src/db/repositories.js';
import { AuditService } from '../../src/services/audit.js';
import { LinkService } from '../../src/services/linkService.js';

export const GUILD = '111111111111111111';
export const USER = '222222222222222222';
export const T0 = Date.parse('2026-10-03T12:00:00.000Z');

export const linkEnv = {
  DISCORD_TOKEN: 't',
  DISCORD_CLIENT_ID: 'c',
  PUBLIC_URL: 'https://bot.example.com/',
  SESSION_SECRET: 'x'.repeat(40),
  TWITCH_CLIENT_ID: 'tw-id',
  TWITCH_CLIENT_SECRET: 'tw-secret',
  TIKTOK_CLIENT_KEY: 'tt-key',
  TIKTOK_CLIENT_SECRET: 'tt-secret',
};

export type Route = (req: { url: URL; init: RequestInit; body: URLSearchParams | null }) => Response | Promise<Response>;
export const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export class FakeHttp {
  readonly calls: Array<{ url: URL; init: RequestInit; body: URLSearchParams | null }> = [];
  routes = new Map<string, Route>();
  readonly fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const body = typeof init.body === 'string' ? new URLSearchParams(init.body) : null;
    const req = { url, init, body };
    this.calls.push(req);
    const route = this.routes.get(`${init.method ?? 'GET'} ${url.origin}${url.pathname}`);
    if (!route) return new Response('no route', { status: 418 });
    return route(req);
  }) as typeof fetch;
  to(key: string) {
    return this.calls.filter((c) => `${c.init.method ?? 'GET'} ${c.url.origin}${c.url.pathname}` === key);
  }
}

export interface FakeStreamerAccount {
  channel: { platform: string; platformId: string; handle: string };
}

export function makeHarness(env: Record<string, string | undefined> = {}) {
  const db = openDatabase(':memory:');
  const repos = new Repositories(db);
  const audit = new AuditService(repos, new AppEvents());
  const http = new FakeHttp();
  const clock = { now: T0 };
  const accounts: FakeStreamerAccount[] = [];
  const added: Array<{ streamerId: number; platform: string; input: string }> = [];
  let addFails = false;
  const streamers = {
    get: (_g: string, id: number) => ({ id, accounts }),
    addAccount: async (_g: string, streamerId: number, input: { platform: string; input: string }) => {
      if (addFails) throw new ValidationError('nope');
      added.push({ streamerId, platform: input.platform, input: input.input });
      return { id: streamerId, accounts };
    },
  } as unknown as StreamerServiceApi;
  const config = loadConfig({ ...linkEnv, ...env } as NodeJS.ProcessEnv);
  const service = new LinkService({ config, repos, audit, streamers, fetch: http.fetch, now: () => clock.now });
  repos.settings.update(GUILD, { features: { linking: { enabled: true } } } as never);
  return {
    repos,
    http,
    clock,
    service,
    accounts,
    added,
    failAdd: () => {
      addFails = true;
    },
  };
}

export function twitchRoutes(http: FakeHttp, user = { id: '4242', login: 'alpha', display_name: 'Alpha' }) {
  http.routes.set('POST https://id.twitch.tv/oauth2/token', () => json({ access_token: 'tw-user-token', expires_in: 3600 }));
  http.routes.set('GET https://api.twitch.tv/helix/users', () => json({ data: [user] }));
  http.routes.set('POST https://id.twitch.tv/oauth2/revoke', () => new Response(null, { status: 200 }));
}

export function tiktokRoutes(http: FakeHttp, username: string | null = 'streamer.one') {
  http.routes.set('POST https://open.tiktokapis.com/v2/oauth/token/', (req) =>
    req.body?.get('grant_type') === 'refresh_token'
      ? json({ access_token: 'tt-access-2', expires_in: 86400, refresh_token: 'tt-refresh-2', refresh_expires_in: 31536000, open_id: 'open-1' })
      : json({ access_token: 'tt-access-1', expires_in: 86400, refresh_token: 'tt-refresh-1', refresh_expires_in: 31536000, open_id: 'open-1', scope: 'user.info.basic,video.list' }),
  );
  http.routes.set('GET https://open.tiktokapis.com/v2/user/info/', () =>
    json({ data: { user: { open_id: 'open-1', display_name: 'Streamer One', ...(username ? { username } : {}) } }, error: { code: 'ok' } }),
  );
}

/** Runs /link/start → returns state + nonce like the browser would carry them. */
export function begin(service: LinkService, platform: 'twitch' | 'tiktok' = 'twitch') {
  const start = new URL(service.startUrl(GUILD, USER, platform));
  const redirect = service.authorizeRedirect(start.searchParams.get('t') ?? undefined);
  const state = new URL(redirect.url).searchParams.get('state')!;
  return { start, redirect, state, nonce: redirect.nonce };
}

