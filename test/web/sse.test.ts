import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { WebServer } from '../../src/web/server.js';
import { createEnv, GUILD, login, manageable, OTHER_GUILD, startServer, USER } from './helpers.js';

let server: WebServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

async function listen(s: WebServer): Promise<string> {
  await s.app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = s.app.server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** Reads SSE frames from a fetch body until `predicate` matches one or the timeout hits. */
async function readUntil(body: ReadableStream<Uint8Array>, predicate: (frames: string[]) => boolean, timeoutMs = 3000): Promise<string[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), deadline - Date.now()))]);
      if (!chunk || chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const frames = buffer.split('\n\n').filter(Boolean);
      if (predicate(frames)) return frames;
    }
    return buffer.split('\n\n').filter(Boolean);
  } finally {
    reader.releaseLock();
  }
}

const waitFor = async (cond: () => boolean, timeoutMs = 2000): Promise<void> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('SSE /api/guilds/:guildId/events', () => {
  it('streams guild-filtered events with the right headers and cleans up on disconnect', async () => {
    const env = createEnv();
    server = await startServer(env, { sseHeartbeatMs: 50 });
    const url = await listen(server);
    const { cookie } = login(env, USER, [manageable(GUILD), manageable(OTHER_GUILD)]);
    const before = (env.events as unknown as { emitter: { listenerCount(n: string): number } }).emitter.listenerCount('live.changed');

    const controller = new AbortController();
    const res = await fetch(`${url}/api/guilds/${GUILD}/events`, { headers: { cookie }, signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-cache');
    expect(res.headers.get('x-accel-buffering')).toBe('no');

    const emitter = (env.events as unknown as { emitter: { listenerCount(n: string): number } }).emitter;
    await waitFor(() => emitter.listenerCount('live.changed') === before + 1);

    env.events.emit('live.changed', { guildId: OTHER_GUILD, streamerId: 99, status: 'live' });
    env.events.emit('live.changed', { guildId: GUILD, streamerId: 7, status: 'live' });
    env.events.emit('content.announced', { guildId: GUILD, streamerId: 7, platform: 'youtube', title: 'مقطع', url: 'https://youtu.be/x' });
    env.ctx.audit.record({ guildId: GUILD, action: 'test.audit', message: 'سجل' });

    const frames = await readUntil(res.body!, (f) => f.some((x) => x.includes('event: audit')) && f.some((x) => x.includes('event: ping')));
    const live = frames.filter((f) => f.startsWith('event: live'));
    expect(live).toHaveLength(1);
    expect(live[0]).toContain('"streamerId":7');
    expect(frames.some((f) => f.startsWith('event: content') && f.includes('"platform":"youtube"'))).toBe(true);
    expect(frames.some((f) => f.startsWith('event: audit') && f.includes('test.audit'))).toBe(true);
    expect(frames.some((f) => f.startsWith('event: ping'))).toBe(true);
    expect(frames.join('\n')).not.toContain('"streamerId":99');

    controller.abort();
    await waitFor(() => emitter.listenerCount('live.changed') === before);
  });

  it('requires authentication and guild access', async () => {
    const env = createEnv();
    server = await startServer(env);
    const anon = await server.app.inject({ method: 'GET', url: `/api/guilds/${GUILD}/events` });
    expect(anon.statusCode).toBe(401);
    const { cookie } = login(env, USER, [manageable(GUILD)]);
    const other = await server.app.inject({ method: 'GET', url: `/api/guilds/${OTHER_GUILD}/events`, headers: { cookie } });
    expect(other.statusCode).toBe(403);
  });

  it('closes the stream when the session is logged out', async () => {
    const env = createEnv();
    server = await startServer(env, { sseHeartbeatMs: 30 });
    const url = await listen(server);
    const { cookie, sessionId } = login(env);
    const res = await fetch(`${url}/api/guilds/${GUILD}/events`, { headers: { cookie } });
    expect(res.status).toBe(200);
    env.repos.webSessions.delete(sessionId);
    const reader = res.body!.getReader();
    let done = false;
    const deadline = Date.now() + 2000;
    while (!done && Date.now() < deadline) done = (await reader.read()).done;
    expect(done).toBe(true);
  });

  it('server shutdown ends open streams instead of hanging', async () => {
    const env = createEnv();
    server = await startServer(env);
    const url = await listen(server);
    const { cookie } = login(env);
    const res = await fetch(`${url}/api/guilds/${GUILD}/events`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const started = Date.now();
    await server.stop();
    server = null;
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
