/**
 * Fetch wrapper for the dashboard API: cookie session, CSRF header on mutations (with one transparent
 * refresh-and-retry when the token went stale), request timeouts, and localized error messages. Every request
 * carries `x-ui-lang` so the server answers errors in the dashboard language.
 */
import { getLang, t, type MessageKey } from '../i18n/core';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export class ApiRequestError extends Error {
  constructor(
    /** HTTP status; 0 for network failures and timeouts. */
    readonly status: number,
    /** Machine code from the server (ApiError.error) or a client-side code ("network", "timeout"). */
    readonly code: string,
    message: string,
    readonly field?: string,
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  /** Errors worth retrying automatically (network blips, gateway errors, Discord reconnecting). */
  get isTransient(): boolean {
    return this.status === 0 || this.status === 502 || this.status === 503 || this.status === 504;
  }
}

export function isApiError(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError;
}

/** User-facing message (in the dashboard language) for any thrown value. */
export function errorMessage(error: unknown, fallback?: string): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof Error && error.name === 'AbortError') return t('errors.aborted');
  return fallback ?? t('errors.unexpected');
}

const FALLBACK_MESSAGES: Record<number, MessageKey> = {
  0: 'errors.http0',
  400: 'errors.http400',
  401: 'errors.http401',
  403: 'errors.http403',
  404: 'errors.http404',
  408: 'errors.http408',
  409: 'errors.http409',
  413: 'errors.http413',
  429: 'errors.http429',
  500: 'errors.http500',
  502: 'errors.http502',
  503: 'errors.http503',
  504: 'errors.http504',
};

function fallbackMessage(status: number): string {
  return t(FALLBACK_MESSAGES[status] ?? (status >= 500 ? 'errors.http500' : 'errors.http400'));
}

/** Header telling the server which language to answer error messages in. */
export const UI_LANG_HEADER = 'x-ui-lang';

const DEFAULT_TIMEOUT_MS = 20_000;
const MUTATING = new Set<HttpMethod>(['POST', 'PUT', 'PATCH', 'DELETE']);

let csrfToken: string | null = null;
let csrfRefresh: Promise<void> | null = null;
let csrfRefresher: (() => Promise<string | null>) | null = null;
const unauthorizedListeners = new Set<() => void>();

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/** Registers how a fresh CSRF token is obtained (GET /api/me) for the stale-token retry. */
export function setCsrfRefresher(refresher: () => Promise<string | null>): void {
  csrfRefresher = refresher;
}

/** Called whenever any request comes back 401 (session expired / logged out elsewhere). */
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

export interface RequestOptions {
  method?: HttpMethod;
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Do not broadcast 401s (used by the session probe itself). */
  silentUnauthorized?: boolean;
}

export function buildUrl(path: string, query?: RequestOptions['query']): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}${path.includes('?') ? '&' : '?'}${qs}` : path;
}

function combineSignals(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (!text) return undefined;
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }
  return text;
}

function toApiError(status: number, body: unknown, headers: Headers): ApiRequestError {
  const retryAfterRaw = headers.get('retry-after');
  const retryAfter = retryAfterRaw && /^\d+$/.test(retryAfterRaw) ? Number(retryAfterRaw) : undefined;
  if (body && typeof body === 'object') {
    const b = body as { error?: unknown; message?: unknown; field?: unknown };
    const message = typeof b.message === 'string' && b.message.trim() ? b.message : fallbackMessage(status);
    const code = typeof b.error === 'string' ? b.error : `http_${status}`;
    const field = typeof b.field === 'string' ? b.field : undefined;
    return new ApiRequestError(status, code, message, field, retryAfter);
  }
  return new ApiRequestError(status, `http_${status}`, fallbackMessage(status), undefined, retryAfter);
}

async function refreshCsrf(): Promise<void> {
  if (!csrfRefresher) return;
  // Concurrent mutations share one refresh.
  csrfRefresh ??= csrfRefresher()
    .then((token) => {
      if (token) csrfToken = token;
    })
    .catch(() => undefined)
    .finally(() => {
      csrfRefresh = null;
    });
  await csrfRefresh;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}, attempt = 0): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json', [UI_LANG_HEADER]: getLang() };
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  if (MUTATING.has(method) && csrfToken) headers['x-csrf-token'] = csrfToken;

  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = options.signal ? combineSignals([options.signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method,
      headers,
      body,
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (timeout.aborted) throw new ApiRequestError(0, 'timeout', fallbackMessage(504));
    throw new ApiRequestError(0, 'network', fallbackMessage(0));
  }

  const payload = await parseBody(response).catch(() => undefined);
  if (response.ok) return payload as T;

  const error = toApiError(response.status, payload, response.headers);
  if (error.status === 403 && error.code === 'csrf' && attempt === 0 && csrfRefresher) {
    await refreshCsrf();
    return apiRequest<T>(path, options, attempt + 1);
  }
  if (error.status === 401 && !options.silentUnauthorized) {
    for (const listener of unauthorizedListeners) listener();
  }
  throw error;
}

export const http = {
  get: <T>(path: string, query?: RequestOptions['query'], signal?: AbortSignal) => apiRequest<T>(path, { query, signal }),
  post: <T>(path: string, body?: unknown, signal?: AbortSignal) => apiRequest<T>(path, { method: 'POST', body, signal }),
  put: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string) => apiRequest<T>(path, { method: 'DELETE' }),
};
