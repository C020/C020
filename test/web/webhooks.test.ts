import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PushHint, WebhookAdapter, WebhookRequest, WebhookResponse } from '../../src/platforms/types.js';
import type { WebServer } from '../../src/web/server.js';
import { createEnv, FakeProviders, fakeProvider, startServer } from './helpers.js';

let server: WebServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

const flush = () => new Promise((r) => setImmediate(r));

/** Adapter that records deliveries and verifies an HMAC over the raw body like the real ones do. */
function recordingAdapter(path: string, respond?: (req: WebhookRequest) => WebhookResponse | Promise<WebhookResponse>) {
  const calls: WebhookRequest[] = [];
  const adapter: WebhookAdapter = {
    path,
    handle: vi.fn(async (req: WebhookRequest) => {
      calls.push(req);
      if (respond) return respond(req);
      return { status: 204, hints: [] };
    }),
    sync: async () => {},
  };
  return { adapter, calls };
}

function envWith(adapters: Partial<Record<'twitch' | 'kick' | 'youtube', WebhookAdapter>>, dashboardEnabled = true) {
  const providers = new FakeProviders({
    twitch: fakeProvider('twitch', { webhook: adapters.twitch }),
    kick: fakeProvider('kick', { webhook: adapters.kick }),
    youtube: fakeProvider('youtube', { webhook: adapters.youtube }),
  });
  return createEnv({ dashboardEnabled }, providers);
}

describe('webhooks', () => {
  it('passes the exact raw bytes to the adapter (HMAC over the original body)', async () => {
    const secret = 'eventsub-secret';
    const hints: PushHint[] = [{ type: 'live', platform: 'twitch', platformId: '1234' }];
    const { adapter, calls } = recordingAdapter('/webhooks/twitch', (req) => {
      const expected = createHmac('sha256', secret).update(req.rawBody).digest('hex');
      const ok = req.headers['x-signature'] === expected;
      return ok ? { status: 204, hints } : { status: 403, body: 'bad signature', hints: [] };
    });
    const env = envWith({ twitch: adapter });
    server = await startServer(env);

    // Unusual whitespace/key order would not survive a JSON parse + re-stringify.
    const body = '{ "b":1,\n  "a" : "éم" }';
    const signature = createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
    const res = await server.app.inject({
      method: 'POST',
      url: '/webhooks/twitch?x=1&x=2',
      headers: { 'content-type': 'application/json', 'x-signature': signature },
      payload: body,
    });
    expect(res.statusCode).toBe(204);
    expect(calls).toHaveLength(1);
    expect(Buffer.isBuffer(calls[0]!.rawBody)).toBe(true);
    expect(calls[0]!.rawBody.toString('utf8')).toBe(body);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.query).toEqual({ x: '1' });

    // Hints are forwarded asynchronously, after the response.
    await flush();
    expect(env.monitor.handleHints).toHaveBeenCalledWith(hints);
  });

  it('rejects a tampered body via the adapter signature check', async () => {
    const { adapter } = recordingAdapter('/webhooks/twitch', (req) =>
      req.rawBody.toString() === 'original' ? { status: 204, hints: [] } : { status: 403, body: 'forbidden', hints: [] },
    );
    server = await startServer(envWith({ twitch: adapter }));
    const res = await server.app.inject({ method: 'POST', url: '/webhooks/twitch', headers: { 'content-type': 'application/json' }, payload: '{"x":1}' });
    expect(res.statusCode).toBe(403);
    expect(res.body).toBe('forbidden');
  });

  it('handles GET verification challenges (YouTube WebSub) with query passthrough and custom content type', async () => {
    const { adapter, calls } = recordingAdapter('/webhooks/youtube', (req) => ({
      status: 200,
      body: req.query['hub.challenge'] ?? '',
      contentType: 'text/plain',
      hints: [],
    }));
    const env = envWith({ youtube: adapter });
    server = await startServer(env);
    const res = await server.app.inject({ method: 'GET', url: '/webhooks/youtube?hub.mode=subscribe&hub.challenge=abc123&hub.topic=x' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('abc123');
    expect(res.headers['content-type']).toContain('text/plain');
    expect(calls[0]!.rawBody.length).toBe(0);
    expect(calls[0]!.method).toBe('GET');
    await flush();
    expect(env.monitor.handleHints).not.toHaveBeenCalled();
  });

  it('accepts Atom XML and bodies without a content type', async () => {
    const { adapter, calls } = recordingAdapter('/webhooks/youtube');
    server = await startServer(envWith({ youtube: adapter }));
    const xml = '<?xml version="1.0"?><feed><entry><yt:videoId>abc</yt:videoId></entry></feed>';
    const res1 = await server.app.inject({ method: 'POST', url: '/webhooks/youtube', headers: { 'content-type': 'application/atom+xml' }, payload: xml });
    expect(res1.statusCode).toBe(204);
    expect(calls[0]!.rawBody.toString()).toBe(xml);

    const res2 = await server.app.inject({ method: 'POST', url: '/webhooks/youtube', payload: Buffer.from('raw-bytes') });
    expect(res2.statusCode).toBe(204);
    expect(calls[1]!.rawBody.toString()).toBe('raw-bytes');
  });

  it('returns 500 (so the platform retries) when an adapter throws, without crashing', async () => {
    const { adapter } = recordingAdapter('/webhooks/kick', () => {
      throw new Error('boom');
    });
    const env = envWith({ kick: adapter });
    server = await startServer(env);
    const res = await server.app.inject({ method: 'POST', url: '/webhooks/kick', headers: { 'content-type': 'application/json' }, payload: '{}' });
    expect(res.statusCode).toBe(500);
    const health = await server.app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
  });

  it('survives a monitor that throws while handling hints', async () => {
    const { adapter } = recordingAdapter('/webhooks/kick', () => ({ status: 200, body: 'ok', hints: [{ type: 'offline', platform: 'kick', platformId: '9' }] }));
    const env = envWith({ kick: adapter });
    env.monitor.handleHints.mockImplementation(() => {
      throw new Error('monitor down');
    });
    server = await startServer(env);
    const res = await server.app.inject({ method: 'POST', url: '/webhooks/kick', payload: '{}', headers: { 'content-type': 'application/json' } });
    expect(res.statusCode).toBe(200);
    await flush();
    expect(env.monitor.handleHints).toHaveBeenCalledTimes(1);
  });

  it('works when the dashboard is disabled and does not need a session or CSRF token', async () => {
    const { adapter } = recordingAdapter('/webhooks/twitch', () => ({ status: 200, body: 'challenge', hints: [] }));
    server = await startServer(envWith({ twitch: adapter }, false));
    const res = await server.app.inject({ method: 'POST', url: '/webhooks/twitch', headers: { 'content-type': 'application/json' }, payload: '{"challenge":"x"}' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('challenge');
  });

  it('skips duplicate webhook paths instead of failing startup', async () => {
    const a = recordingAdapter('/webhooks/same');
    const b = recordingAdapter('/webhooks/same');
    server = await startServer(envWith({ twitch: a.adapter, kick: b.adapter }));
    const res = await server.app.inject({ method: 'POST', url: '/webhooks/same', payload: 'x' });
    expect(res.statusCode).toBe(204);
    expect(a.calls.length + b.calls.length).toBe(1);
  });
});
