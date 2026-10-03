import { describe, expect, it, vi } from 'vitest';
import { ChannelNotFoundError, ProviderNotConfiguredError, ValidationError } from '../../src/core/errors.js';
import { defaultGuildSettings } from '../../src/db/models.js';
import type { DiscordGateway, DiscordMemberInfo } from '../../src/services/ports.js';
import { sanitizeNext, toSessionGuilds } from '../../src/web/auth.js';
import { csrfTokenFor, safeEqual, sessionIdFromToken, verifyCsrfToken } from '../../src/web/csrf.js';
import { DiscordOAuthClient, DiscordOAuthError, userAvatarUrl } from '../../src/web/discordOAuth.js';
import { HttpError, mapError } from '../../src/web/httpErrors.js';
import { MemberCache } from '../../src/web/memberCache.js';
import { canManageGuild } from '../../src/web/permissions.js';
import { parseInput, settingsUpdateSchema } from '../../src/web/schemas.js';
import { changedFields, mergeSettings, mergeTemplates, validateMergedSettings } from '../../src/web/settingsLogic.js';
import { flattenQuery } from '../../src/web/webhooks.js';
import { jsonResponse } from './helpers.js';

describe('mapError', () => {
  it('maps domain errors to API errors', () => {
    expect(mapError(new ValidationError('غلط', 'x'))).toMatchObject({ status: 400, body: { error: 'validation', message: 'غلط', field: 'x' } });
    expect(mapError(new ChannelNotFoundError('kick', 'a'))).toMatchObject({ status: 404, body: { message: 'الحساب غير موجود على المنصة' } });
    expect(mapError(new ProviderNotConfiguredError('youtube')).body.message).toContain('YOUTUBE_API_KEY');
    expect(mapError(new HttpError(418, 'teapot', 'شاي'))).toMatchObject({ status: 418, body: { error: 'teapot' } });
    const internal = mapError(new Error('db exploded'));
    expect(internal).toMatchObject({ status: 500, unexpected: true, body: { error: 'internal' } });
    expect(JSON.stringify(internal.body)).not.toContain('exploded');
  });

  it('maps fastify framework errors by status', () => {
    expect(mapError(Object.assign(new Error('too large'), { statusCode: 413 })).body.error).toBe('payload_too_large');
    expect(mapError(Object.assign(new Error('bad'), { statusCode: 400 })).body.error).toBe('bad_request');
  });
});

describe('csrf + session ids', () => {
  it('binds tokens to the session and compares safely', () => {
    const token = csrfTokenFor('secret', 'session-a');
    expect(verifyCsrfToken('secret', 'session-a', token)).toBe(true);
    expect(verifyCsrfToken('secret', 'session-b', token)).toBe(false);
    expect(verifyCsrfToken('other-secret', 'session-a', token)).toBe(false);
    expect(verifyCsrfToken('secret', 'session-a', undefined)).toBe(false);
    expect(verifyCsrfToken('secret', 'session-a', ['x'])).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(sessionIdFromToken('t')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('permissions', () => {
  it('accepts owner, Administrator and Manage Server only', () => {
    expect(canManageGuild({ owner: true, permissions: '0' })).toBe(true);
    expect(canManageGuild({ owner: false, permissions: '8' })).toBe(true);
    expect(canManageGuild({ owner: false, permissions: '32' })).toBe(true);
    expect(canManageGuild({ owner: false, permissions: '1024' })).toBe(false);
    expect(canManageGuild({ owner: false, permissions: 'garbage' })).toBe(false);
    expect(canManageGuild({ owner: false, permissions: ((1n << 60n) | 32n).toString() })).toBe(true);
  });

  it('stores only manageable guilds', () => {
    const stored = toSessionGuilds([
      { id: '1', name: 'a', permissions: '8' },
      { id: '2', name: 'b', permissions: '0' },
      { id: '3', name: 'c', owner: true },
    ]);
    expect(stored.map((g) => g.id)).toEqual(['1', '3']);
  });
});

describe('sanitizeNext', () => {
  it('allows only same-site dashboard paths', () => {
    expect(sanitizeNext('/guilds/1/streamers?tab=2')).toBe('/guilds/1/streamers?tab=2');
    for (const bad of ['//evil.com', '/\\evil.com', 'https://evil.com', '/auth/login', '/api/me', 'x', undefined, 5, `/${'a'.repeat(400)}`]) {
      expect(sanitizeNext(bad)).toBe('/');
    }
  });
});

describe('settings logic', () => {
  const current = () => defaultGuildSettings('111111111111111111', '2026-01-01T00:00:00.000Z');

  it('merges templates per type and resets empty specs', () => {
    const merged = mergeTemplates({ live: { title: 'a' }, content: { title: 'c' } }, { live: { title: undefined, color: null }, summary: { footer: 'f' } });
    expect(merged).toEqual({ content: { title: 'c' }, summary: { footer: 'f' } });
  });

  it('merges options without dropping existing ones and detects changes', () => {
    const before = current();
    const patch = parseInput(settingsUpdateSchema, { options: { liveUpdateMinutes: 2 }, contentChannelId: '' });
    const after = mergeSettings(before, patch);
    expect(after.options).toEqual({ ...before.options, liveUpdateMinutes: 2 });
    expect(changedFields(before, after)).toEqual(['options.liveUpdateMinutes']);
  });

  it('enforces cross-field rules', () => {
    const s = { ...current(), pingMode: 'role' as const, pingRoleId: null };
    expect(() => validateMergedSettings('111111111111111111', s)).toThrow(ValidationError);
  });
});

describe('flattenQuery', () => {
  it('keeps first values only', () => {
    expect(flattenQuery({ a: 'x', b: ['1', '2'], c: 3 })).toEqual({ a: 'x', b: '1' });
    expect(flattenQuery(null)).toEqual({});
  });
});

describe('MemberCache', () => {
  function gateway(impl: (guildId: string, userId: string) => Promise<DiscordMemberInfo | null>, ready = true): DiscordGateway & { calls: number } {
    const g = {
      calls: 0,
      isReady: () => ready,
      fetchMember: async (guildId: string, userId: string) => {
        g.calls++;
        return impl(guildId, userId);
      },
    };
    return g as unknown as DiscordGateway & { calls: number };
  }
  const member = (id: string): DiscordMemberInfo => ({ id, username: 'u', displayName: 'U', avatarUrl: 'a', bot: false, roleIds: [] });

  it('dedupes concurrent lookups and respects TTLs', async () => {
    let now = 0;
    const g = gateway(async (_g, id) => (id === 'missing' ? null : member(id)));
    const cache = new MemberCache(g, { now: () => now, ttlMs: 1000, negativeTtlMs: 100 });
    const [a, b] = await Promise.all([cache.get('g', 'u1'), cache.get('g', 'u1')]);
    expect(a).toEqual(b);
    expect(g.calls).toBe(1);
    expect((await cache.get('g', 'missing')).status).toBe('absent');
    now = 500;
    await cache.get('g', 'u1');
    await cache.get('g', 'missing');
    expect(g.calls).toBe(3); // member still cached, negative entry expired
    expect(cache.peek('g', 'u1').status).toBe('member');
  });

  it('returns unknown (and never throws) when the gateway fails or is not ready', async () => {
    const failing = new MemberCache(gateway(async () => Promise.reject(new Error('x'))));
    expect((await failing.get('g', 'u')).status).toBe('unknown');
    const notReady = new MemberCache(gateway(async () => member('u'), false));
    expect((await notReady.get('g', 'u')).status).toBe('unknown');
  });

  it('warm() waits at most the budget', async () => {
    const g = gateway(() => new Promise((r) => setTimeout(() => r(member('slow')), 200)));
    const cache = new MemberCache(g);
    const started = Date.now();
    await cache.warm('g', ['slow'], 20);
    expect(Date.now() - started).toBeLessThan(150);
    await new Promise((r) => setTimeout(r, 250));
    expect(cache.peek('g', 'slow').status).toBe('member');
  });
});

describe('DiscordOAuthClient', () => {
  const opts = { clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://x/auth/callback' };

  it('paginates guilds beyond 200', async () => {
    const page1 = Array.from({ length: 200 }, (_, i) => ({ id: String(1000 + i), name: `g${i}`, permissions: '0' }));
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('after=') ? jsonResponse(200, [{ id: '5000', name: 'last', permissions: '8' }]) : jsonResponse(200, page1),
    );
    const client = new DiscordOAuthClient({ ...opts, fetch: fetchMock as unknown as typeof fetch });
    const guilds = await client.fetchGuilds('tok');
    expect(guilds).toHaveLength(201);
    expect(String(fetchMock.mock.calls[1]![0])).toContain('after=1199');
  });

  it('classifies failures', async () => {
    const respond = (res: Response) => new DiscordOAuthClient({ ...opts, fetch: (async () => res) as unknown as typeof fetch });
    await expect(respond(jsonResponse(429, { retry_after: 2.5 })).fetchUser('t')).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 2500 });
    await expect(respond(jsonResponse(401, { message: '401' })).fetchUser('t')).rejects.toMatchObject({ kind: 'unauthorized' });
    await expect(respond(jsonResponse(200, { nope: true })).fetchUser('t')).rejects.toBeInstanceOf(DiscordOAuthError);
    const network = new DiscordOAuthClient({ ...opts, fetch: (async () => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch });
    await expect(network.fetchUser('t')).rejects.toMatchObject({ kind: 'network' });
  });

  it('builds avatar URLs including defaults', () => {
    expect(userAvatarUrl({ id: '80351110224678912', avatar: 'a_anim', discriminator: '0' })).toContain('.gif');
    expect(userAvatarUrl({ id: '80351110224678912', avatar: null, discriminator: '0' })).toMatch(/embed\/avatars\/[0-5]\.png$/);
    expect(userAvatarUrl({ id: '1', avatar: null, discriminator: '1337' })).toBe('https://cdn.discordapp.com/embed/avatars/2.png');
  });
});
