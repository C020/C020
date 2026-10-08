import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { AppContext } from '../../src/app/context.js';
import { LINK_COOKIE, LINK_PAGE_CSP, registerLinkRoutes, renderLinkPage } from '../../src/web/routes/link.js';
import { GUILD, USER, makeHarness, tiktokRoutes, twitchRoutes } from '../services/linkService-helpers.js';

async function setup() {
  const h = makeHarness();
  const app = Fastify();
  registerLinkRoutes(app, { config: (h.service as unknown as { config: AppContext['config'] }).config } as AppContext, h.service);
  await app.ready();
  return { ...h, app };
}

function cookieFrom(setCookie: string | string[] | undefined): string {
  const raw = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
  return raw.split(';')[0]!;
}

describe('GET /link/start + /link/callback/:platform', () => {
  it('redirects to the provider with a flow cookie, then renders the success page', async () => {
    const { app, service, http, repos } = await setup();
    twitchRoutes(http);
    const start = new URL(service.startUrl(GUILD, USER, 'twitch'));
    const res = await app.inject({ method: 'GET', url: `${start.pathname}${start.search}` });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.host).toBe('id.twitch.tv');
    const setCookie = res.headers['set-cookie'] as string;
    expect(setCookie).toContain(`${LINK_COOKIE}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('Path=/link/callback');

    const state = location.searchParams.get('state')!;
    const cb = await app.inject({
      method: 'GET',
      url: `/link/callback/twitch?code=abc&state=${encodeURIComponent(state)}`,
      headers: { cookie: cookieFrom(setCookie) },
    });
    expect(cb.statusCode).toBe(200);
    expect(cb.headers['content-type']).toContain('text/html');
    expect(cb.headers['content-security-policy']).toBe(LINK_PAGE_CSP);
    expect(cb.headers['cache-control']).toBe('no-store');
    expect(cb.body).toContain('تم ربط حسابك في Twitch (alpha)');
    expect(cb.body).toContain('You can close this page');
    expect(cb.body).toContain('dir="rtl"');
    expect(cb.headers['set-cookie']).toContain('Max-Age=0');
    expect(repos.links.get(USER, 'twitch')).not.toBeNull();
    await app.close();
  });

  it('renders error pages for invalid start tokens, missing cookie and denied consent', async () => {
    const { app, service, http } = await setup();
    tiktokRoutes(http);
    const bad = await app.inject({ method: 'GET', url: '/link/start?t=nope' });
    expect(bad.statusCode).toBe(400);
    expect(bad.headers['content-security-policy']).toBe(LINK_PAGE_CSP);
    expect(bad.body).toContain('/link');

    const start = new URL(service.startUrl(GUILD, USER, 'tiktok'));
    const res = await app.inject({ method: 'GET', url: `${start.pathname}${start.search}` });
    const state = new URL(res.headers.location as string).searchParams.get('state')!;
    const noCookie = await app.inject({ method: 'GET', url: `/link/callback/tiktok?code=x&state=${encodeURIComponent(state)}` });
    expect(noCookie.statusCode).toBe(400);

    const denied = await app.inject({
      method: 'GET',
      url: `/link/callback/tiktok?error=access_denied&state=${encodeURIComponent(state)}`,
      headers: { cookie: cookieFrom(res.headers['set-cookie'] as string) },
    });
    expect(denied.statusCode).toBe(400);
    expect(denied.body).toContain('تم إلغاء الربط');
    expect(denied.body).toContain('Linking was cancelled');
    await app.close();
  });

  it('shows English first for English guilds and escapes HTML', async () => {
    const html = renderLinkPage('en', { ok: true, title: { ar: 'ع', en: 'Linked' }, lines: [{ ar: 'x', en: '<script>alert(1)</script>' }] });
    expect(html.startsWith('<!doctype html><html lang="en" dir="ltr">')).toBe(true);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
