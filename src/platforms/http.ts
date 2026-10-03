import { ProviderError, RateLimitedError } from '../core/errors.js';
import type { Platform } from '../core/types.js';

export interface HttpRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  /** Object bodies are JSON-encoded; URLSearchParams are form-encoded. */
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | Array<string | number>>;
  timeoutMs?: number;
  /** Number of retries for retryable failures (network errors, 5xx). 429 is surfaced as RateLimitedError. */
  retries?: number;
  /** Return null instead of throwing on 404. */
  allow404?: boolean;
}

export interface HttpResponse<T> {
  status: number;
  headers: Headers;
  data: T;
}

export type FetchLike = typeof fetch;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function buildUrl(base: string, query?: HttpRequestOptions['query']): string {
  if (!query) return base;
  const url = new URL(base);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) url.searchParams.append(key, String(v));
    else url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function parseRetryAfter(headers: Headers): number {
  const ra = headers.get('retry-after');
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return Math.max(1000, secs * 1000);
    const date = Date.parse(ra);
    if (Number.isFinite(date)) return Math.max(1000, date - Date.now());
  }
  // Twitch style: Ratelimit-Reset is an epoch-seconds timestamp.
  const reset = headers.get('ratelimit-reset');
  if (reset && Number.isFinite(Number(reset))) return Math.max(1000, Number(reset) * 1000 - Date.now());
  return 60_000;
}

/**
 * Small fetch wrapper used by all providers: timeout, retries with exponential backoff
 * + jitter on network errors / 5xx, JSON parsing, and typed errors.
 */
export class HttpClient {
  constructor(
    private readonly platform: Platform,
    private readonly fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
    private readonly userAgent = 'StreamBot/1.0 (+discord bot)',
  ) {}

  async request<T = unknown>(url: string, opts: HttpRequestOptions = {}): Promise<HttpResponse<T>> {
    const { method = 'GET', headers = {}, body, query, timeoutMs = 15_000, retries = 2, allow404 = false } = opts;
    const fullUrl = buildUrl(url, query);
    let attempt = 0;
    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const init: RequestInit = { method, headers: { 'user-agent': this.userAgent, accept: 'application/json', ...headers }, signal: controller.signal };
        if (body instanceof URLSearchParams) {
          init.body = body;
          (init.headers as Record<string, string>)['content-type'] = 'application/x-www-form-urlencoded';
        } else if (body !== undefined) {
          init.body = JSON.stringify(body);
          (init.headers as Record<string, string>)['content-type'] = 'application/json';
        }
        const res = await this.fetchImpl(fullUrl, init);
        if (res.status === 429) throw new RateLimitedError(this.platform, parseRetryAfter(res.headers));
        if (res.status === 404 && allow404) return { status: 404, headers: res.headers, data: null as T };
        const text = await res.text();
        if (res.status >= 500) throw new ProviderError(this.platform, `HTTP ${res.status} from ${new URL(fullUrl).host}`, true);
        if (res.status >= 400) {
          throw new ProviderError(this.platform, `HTTP ${res.status} from ${new URL(fullUrl).pathname}: ${text.slice(0, 300)}`, res.status === 408);
        }
        const ct = res.headers.get('content-type') ?? '';
        let data: unknown = text;
        if (ct.includes('json') || (text.startsWith('{') || text.startsWith('['))) {
          try {
            data = text ? JSON.parse(text) : null;
          } catch {
            data = text;
          }
        }
        return { status: res.status, headers: res.headers, data: data as T };
      } catch (err) {
        const retryable =
          err instanceof RateLimitedError ? false : err instanceof ProviderError ? err.retryable : true; // network/abort errors are retryable
        if (!retryable || attempt >= retries) {
          if (err instanceof ProviderError) throw err;
          const reason = (err as Error)?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : (err as Error)?.message ?? String(err);
          throw new ProviderError(this.platform, `Request failed (${method} ${new URL(fullUrl).host}): ${reason}`, true, { cause: err });
        }
        attempt++;
        await sleep(Math.min(8000, 500 * 2 ** attempt) + Math.random() * 250);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  async getJson<T = unknown>(url: string, opts: Omit<HttpRequestOptions, 'method'> = {}): Promise<T> {
    return (await this.request<T>(url, { ...opts, method: 'GET' })).data;
  }

  async getText(url: string, opts: Omit<HttpRequestOptions, 'method'> = {}): Promise<string> {
    const res = await this.request<unknown>(url, { ...opts, method: 'GET', headers: { accept: '*/*', ...(opts.headers ?? {}) } });
    return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  }
}

/** Splits an array into chunks of `size`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Appends a cache-busting query param so Discord re-fetches live thumbnails. */
export function cacheBust(url: string | null, bucketMs = 5 * 60_000): string | null {
  if (!url) return null;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}t=${Math.floor(Date.now() / bucketMs)}`;
}
