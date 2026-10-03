import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WebServer } from '../../src/web/server.js';
import { createEnv, login, startServer } from './helpers.js';

let server: WebServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

describe('web server basics', () => {
  it('GET /healthz reports Discord readiness and uptime', async () => {
    const env = createEnv();
    env.discord.ready = false;
    server = await startServer(env);
    const res = await server.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ ok: true, discord: false });
    expect(body.uptimeSec).toBeGreaterThanOrEqual(89);
  });

  it('sends security headers with a CSP that allows platform image CDNs', async () => {
    server = await startServer(createEnv());
    const res = await server.app.inject({ method: 'GET', url: '/healthz' });
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain('https://cdn.discordapp.com');
    expect(csp).toContain('https://static-cdn.jtvnw.net');
    expect(csp).toContain('https://i.ytimg.com');
    expect(csp).toContain('https://*.kick.com');
    expect(csp).toContain('https://*.tiktokcdn.com');
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
  });

  it('does not force https upgrades when PUBLIC_URL is plain http', async () => {
    server = await startServer(createEnv({ PUBLIC_URL: 'http://localhost:3000', webhooksEnabled: false }));
    const res = await server.app.inject({ method: 'GET', url: '/healthz' });
    expect(String(res.headers['content-security-policy'])).not.toContain('upgrade-insecure-requests');
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('returns JSON 404 for unknown API routes (authenticated)', async () => {
    const env = createEnv();
    server = await startServer(env);
    const { cookie } = login(env);
    const res = await server.app.inject({ method: 'GET', url: '/api/nope', headers: { cookie } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found' });
  });
});

describe('dashboard disabled', () => {
  it('answers /api/* and /auth/* with 503 and names the missing env vars', async () => {
    const env = createEnv({ dashboardEnabled: false, DISCORD_CLIENT_SECRET: undefined, SESSION_SECRET: undefined });
    server = await startServer(env);
    for (const url of ['/api/me', '/api/guilds/111111111111111111/settings', '/auth/login']) {
      const res = await server.app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.error).toBe('dashboard_disabled');
      expect(body.message).toContain('DISCORD_CLIENT_SECRET');
      expect(body.message).toContain('SESSION_SECRET');
      expect(body.message).not.toContain('PUBLIC_URL،');
    }
    const post = await server.app.inject({ method: 'POST', url: '/api/guilds/1/streamers', payload: {} });
    expect(post.statusCode).toBe(503);
  });

  it('keeps the health check working', async () => {
    server = await startServer(createEnv({ dashboardEnabled: false }));
    const res = await server.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });
});

describe('SPA hosting', () => {
  it('explains how to build the dashboard when the build is missing', async () => {
    server = await startServer(createEnv());
    const res = await server.app.inject({ method: 'GET', url: '/streamers' });
    expect(res.statusCode).toBe(503);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('npm run build');
    expect(res.body).toContain('dir="rtl"');
  });

  it('serves index.html for client routes and long-caches hashed assets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-build-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
    writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
    server = await startServer(createEnv(), { publicDir: dir });

    const root = await server.app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain('id="root"');
    expect(root.headers['cache-control']).toBe('no-cache');

    const deep = await server.app.inject({ method: 'GET', url: '/guilds/111111111111111111/streamers' });
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain('id="root"');

    const asset = await server.app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toContain('immutable');

    const missingAsset = await server.app.inject({ method: 'GET', url: '/assets/missing-123.js' });
    expect(missingAsset.statusCode).toBe(404);
    expect(missingAsset.body).not.toContain('id="root"');

    // Backend prefixes never fall back to the SPA.
    const webhook = await server.app.inject({ method: 'GET', url: '/webhooks/unknown' });
    expect(webhook.statusCode).toBe(404);
    expect(webhook.json()).toMatchObject({ error: 'not_found' });
  });
});

describe('rate limiting', () => {
  it('limits the API per IP with an Arabic 429', async () => {
    const env = createEnv();
    server = await startServer(env);
    let last = 0;
    let body: { error?: string; message?: string } = {};
    for (let i = 0; i < 121; i++) {
      const res = await server.app.inject({ method: 'GET', url: '/api/me', remoteAddress: '10.0.0.9' });
      last = res.statusCode;
      body = res.json();
    }
    expect(last).toBe(429);
    expect(body.error).toBe('rate_limited');
    expect(body.message).toMatch(/طلبات كثيرة/);
    // Another client is unaffected.
    const other = await server.app.inject({ method: 'GET', url: '/api/me', remoteAddress: '10.0.0.10' });
    expect(other.statusCode).toBe(401);
  });

  it('applies a stricter limit to auth routes', async () => {
    server = await startServer(createEnv());
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await server.app.inject({ method: 'GET', url: '/auth/login', remoteAddress: '10.0.0.11' });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 20).every((s) => s === 302)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});
