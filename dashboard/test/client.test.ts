import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, apiRequest, buildUrl, errorMessage, onUnauthorized, setCsrfRefresher, setCsrfToken } from '../src/api/client';

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

describe('buildUrl', () => {
  it('skips empty query values', () => {
    expect(buildUrl('/api/x', { a: 1, b: undefined, c: null, d: '', e: 'y z' })).toBe('/api/x?a=1&e=y+z');
    expect(buildUrl('/api/x')).toBe('/api/x');
  });
});

describe('apiRequest', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    setCsrfToken('token-1');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setCsrfToken(null);
  });

  it('sends the CSRF header and JSON body on mutations only', async () => {
    fetchMock.mockResolvedValue(json(200, { ok: true }));
    await apiRequest('/api/a', { method: 'POST', body: { x: 1 } });
    await apiRequest('/api/b');
    const [, post] = fetchMock.mock.calls[0]!;
    const [, get] = fetchMock.mock.calls[1]!;
    expect((post?.headers as Record<string, string>)['x-csrf-token']).toBe('token-1');
    expect(post?.body).toBe('{"x":1}');
    expect(post?.credentials).toBe('same-origin');
    expect((get?.headers as Record<string, string>)['x-csrf-token']).toBeUndefined();
  });

  it('maps API errors to ApiRequestError with the server message and field', async () => {
    fetchMock.mockResolvedValue(json(400, { error: 'validation', message: 'الآيدي غير صحيح', field: 'liveRoleId' }));
    const error = await apiRequest('/api/a').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 400, code: 'validation', message: 'الآيدي غير صحيح', field: 'liveRoleId' });
  });

  it('falls back to Arabic messages for non-JSON errors and reads retry-after', async () => {
    fetchMock.mockResolvedValue(new Response('<html>bad gateway</html>', { status: 429, headers: { 'retry-after': '12' } }));
    const error = (await apiRequest('/api/a').catch((e: unknown) => e)) as ApiRequestError;
    expect(error.status).toBe(429);
    expect(error.retryAfterSec).toBe(12);
    expect(error.message).toContain('طلبات كثيرة');
  });

  it('refreshes a stale CSRF token once and retries', async () => {
    setCsrfRefresher(async () => 'token-2');
    fetchMock.mockResolvedValueOnce(json(403, { error: 'csrf', message: 'انتهت صلاحية الصفحة' })).mockResolvedValueOnce(json(200, { ok: true }));
    await expect(apiRequest('/api/a', { method: 'PUT', body: {} })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1]![1]?.headers as Record<string, string>)['x-csrf-token']).toBe('token-2');
  });

  it('notifies 401 listeners unless silenced', async () => {
    const listener = vi.fn();
    const off = onUnauthorized(listener);
    fetchMock.mockImplementation(async () => json(401, { error: 'unauthorized', message: 'سجّل دخولك' }));
    await apiRequest('/api/a').catch(() => undefined);
    await apiRequest('/api/me', { silentUnauthorized: true }).catch(() => undefined);
    off();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('turns network failures into a status-0 error', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const error = (await apiRequest('/api/a').catch((e: unknown) => e)) as ApiRequestError;
    expect(error.status).toBe(0);
    expect(error.code).toBe('network');
    expect(error.isTransient).toBe(true);
    expect(errorMessage(error)).toBe(error.message);
    expect(errorMessage(new Error('x'))).toContain('خطأ');
  });

  it('returns undefined for empty successful responses', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(apiRequest('/api/a', { method: 'DELETE' })).resolves.toBeUndefined();
  });
});
