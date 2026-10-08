/**
 * Twitch provider (Helix API with an app access token; no streamer authorization needed).
 *
 * - Live: batched Get Streams (100 ids per call) + Get Games box art cached across polls.
 * - Content: Get Videos (archives/highlights/uploads) and Get Clips (time window + pagination).
 * - Push: optional EventSub webhooks (see twitch-eventsub.ts); polling stays the source of truth.
 */
import {
  ChannelNotFoundError,
  errorMessage,
  ProviderError,
  ProviderNotConfiguredError,
  RateLimitedError,
  ValidationError,
} from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import {
  type ChannelRef,
  CONTENT_KIND_LABELS_AR,
  type ContentItem,
  type ContentKind,
  type LiveSnapshot,
  offlineSnapshot,
  type ResolvedChannel,
} from '../core/types.js';
import { cacheBust, chunk, type FetchLike, HttpClient } from './http.js';
import { EVENTSUB_PATH, type HelixRequest, type HelixResult, type HelixTransport, TwitchEventSubAdapter } from './twitch-eventsub.js';
import type {
  KeyValueStore,
  PlatformProvider,
  ProviderCapabilities,
  ProviderContext,
  ProviderFactory,
  ProviderHealth,
} from './types.js';

const HELIX_BASE = 'https://api.twitch.tv/helix';
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const TOKEN_KV_KEY = 'twitch:app_token';

const MAX_IDS_PER_REQUEST = 100;
/** Get Streams can return a short page plus a cursor that is not the end of the list; follow at most this many pages. */
const STREAMS_MAX_PAGES = 3;
const VIDEOS_PAGE_SIZE = 20;
const CLIP_WINDOW_MS = 12 * 3_600_000;
const CLIP_MAX_PAGES = 3;
const VOD_MATCH_TOLERANCE_MS = 10 * 60_000;
/** Twitch caps a single broadcast at 48h; older archives cannot be in progress. */
const MAX_BROADCAST_MS = 49 * 3_600_000;
/** How long a live status learned from checkLive() is trusted by fetchRecentContent(). */
const LIVE_STATUS_FRESH_MS = 3 * 60_000;

const GAME_ART_TTL_MS = 24 * 3_600_000;
const GAME_ART_MISS_TTL_MS = 3_600_000;
const GAME_ART_CACHE_MAX = 5_000;

const TOKEN_REFRESH_MARGIN_MS = 3_600_000;
const TOKEN_FALLBACK_LIFETIME_S = 3_600;
const TOKEN_BACKOFF_BASE_MS = 15_000;
const TOKEN_BACKOFF_MAX_MS = 10 * 60_000;

/** Below this many remaining points we pace requests until the bucket refills a little. */
const RATE_LIMIT_LOW_WATERMARK = 5;
/** Waits longer than this are surfaced as RateLimitedError so the monitor backs off instead of stalling. */
const MAX_RATE_LIMIT_WAIT_MS = 10_000;

const LIVE_THUMBNAIL = { width: 1280, height: 720 };
const BOX_ART = { width: 285, height: 380 };
const VIDEO_THUMBNAIL = { width: 320, height: 180 };

const SUPPORTED_KINDS = ['vod', 'highlight', 'video', 'clip'] as const satisfies readonly ContentKind[];
type VideoKind = 'vod' | 'highlight' | 'video';
type HelixVideoType = 'archive' | 'highlight' | 'upload';
const VIDEO_KINDS: readonly VideoKind[] = ['vod', 'highlight', 'video'];
const VIDEO_TYPE_TO_KIND: Record<HelixVideoType, VideoKind> = { archive: 'vod', highlight: 'highlight', upload: 'video' };
const KIND_TO_VIDEO_TYPE: Record<VideoKind, HelixVideoType> = { vod: 'archive', highlight: 'highlight', video: 'upload' };

const TWITCH_ID_RE = /^\d{1,20}$/;
const LOGIN_RE = /^[a-z0-9_]{1,25}$/i;
const CLIP_SLUG_RE = /^[A-Za-z0-9_-]{1,120}$/;
const EVENTSUB_SECRET_RE = /^[\x20-\x7e]{10,100}$/;

/** First path segments on twitch.tv that are pages, not channels. */
const RESERVED_PATHS = new Set([
  'about', 'bits', 'broadcast', 'clips', 'collections', 'creatorcamp', 'dashboard', 'directory', 'downloads', 'drops',
  'event', 'friends', 'following', 'help', 'inventory', 'jobs', 'legal', 'login', 'logout', 'messages', 'p', 'payments',
  'prime', 'privacy', 'products', 'redeem', 'search', 'settings', 'signup', 'store', 'subs', 'subscriptions', 'team',
  'turbo', 'user', 'videos', 'wallet',
]);
/** twitch.tv/<prefix>/<login>/... */
const LOGIN_PREFIX_PATHS = new Set(['popout', 'embed', 'moderator']);

// ───────────────────────────── Helix payloads ─────────────────────────────

interface HelixPage<T> {
  data: T[];
  pagination?: { cursor?: string };
}

interface HelixUser {
  id: string;
  login: string;
  display_name: string;
  profile_image_url?: string;
}

interface HelixStream {
  id: string;
  user_id: string;
  user_login: string;
  game_id: string;
  game_name: string;
  type: string;
  title: string;
  viewer_count: number;
  started_at: string;
  language: string;
  thumbnail_url: string;
  tags?: string[] | null;
}

interface HelixGame {
  id: string;
  name: string;
  box_art_url: string;
}

interface HelixVideo {
  id: string;
  stream_id: string | null;
  user_id: string;
  title: string;
  url: string;
  thumbnail_url: string;
  created_at: string;
  published_at: string;
  viewable?: string;
  view_count: number;
  type: string;
  duration: string;
}

interface HelixClip {
  id: string;
  url: string;
  broadcaster_id: string;
  title: string;
  view_count: number;
  created_at: string;
  thumbnail_url: string;
  duration: number;
  /** Whether the broadcaster featured the clip (#6 featuredOnly filter). */
  is_featured?: boolean;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
}

// ───────────────────────────── small helpers ─────────────────────────────

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** A 4xx from Twitch (other than 404 and bucket-exhausted 429) with its status and body. */
export class TwitchApiError extends ProviderError {
  constructor(
    readonly status: number,
    readonly responseBody: string,
    path: string,
  ) {
    super('twitch', `HTTP ${status} from ${path}: ${responseBody.slice(0, 300)}`, status === 408);
    this.name = 'TwitchApiError';
  }
}

/**
 * Wraps fetch so 4xx responses become TwitchApiError (keeping the status) before HttpClient turns them into
 * a generic ProviderError. 404 and bucket-exhausted 429 are left to HttpClient (allow404 / RateLimitedError);
 * a 429 with points remaining is endpoint-specific (e.g. EventSub limits) and must not pause all requests.
 */
function statusAwareFetch(base: FetchLike): FetchLike {
  return async (input, init) => {
    const res = await base(input, init);
    if (res.status < 400 || res.status >= 500 || res.status === 404) return res;
    if (res.status === 429) {
      const remaining = res.headers.get('ratelimit-remaining');
      if (remaining === null || Number(remaining) <= 0) return res;
    }
    const body = await res.text().catch(() => '');
    const url = input instanceof Request ? input.url : String(input);
    throw new TwitchApiError(res.status, body, new URL(url).pathname);
  };
}

function parseJsonSafe(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** Fills Twitch image templates: {width}x{height} (streams, box art) and %{width}x%{height} (videos). */
function fillImageTemplate(url: string, size: { width: number; height: number }): string {
  return url.replace(/%?\{width\}/g, String(size.width)).replace(/%?\{height\}/g, String(size.height));
}

/** In-progress archives have an empty thumbnail or Twitch's "processing" placeholder. */
function isPlaceholderThumbnail(url: string | null | undefined): boolean {
  return !url || url.trim() === '' || /\/_404\/|404_processing/i.test(url);
}

const channelUrl = (login: string) => `https://www.twitch.tv/${login}`;
const videoUrl = (video: HelixVideo) => video.url || `https://www.twitch.tv/videos/${video.id}`;
const isTwitchId = (value: string) => TWITCH_ID_RE.test(value);
const unique = <T>(items: readonly T[]) => [...new Set(items)];
const rfc3339 = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const timeOf = (iso: string | null | undefined) => (iso ? Date.parse(iso) : Number.NaN);

/** Parses Twitch video durations like "1h2m3s", "45m", "12s" into seconds. */
export function parseTwitchDuration(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(value.trim());
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Math.round(Number(match[3] ?? 0));
}

// ───────────────────────────── input parsing ─────────────────────────────

export type TwitchTarget =
  | { kind: 'login'; login: string }
  | { kind: 'id'; id: string }
  | { kind: 'video'; id: string }
  | { kind: 'clip'; slug: string };

const MSG_EMPTY = 'اكتب اسم مستخدم Twitch أو رابط القناة.';
const MSG_INVALID_LOGIN = 'اسم مستخدم Twitch غير صالح. اكتب اسم القناة (حروف إنجليزية وأرقام و _) أو رابطها مثل https://twitch.tv/name';
const MSG_NOT_TWITCH_URL = 'هذا الرابط مو رابط قناة Twitch. مثال صحيح: https://twitch.tv/name';

function loginTarget(value: string): TwitchTarget {
  if (!LOGIN_RE.test(value)) throw new ValidationError(MSG_INVALID_LOGIN, 'input');
  return { kind: 'login', login: value.toLowerCase() };
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function parseTwitchUrl(input: string): TwitchTarget {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new ValidationError(MSG_NOT_TWITCH_URL, 'input');
  }
  const host = url.hostname.toLowerCase().replace(/^(?:www|m|go)\./, '');
  const segments = url.pathname.split('/').filter(Boolean).map(safeDecode);

  if (host === 'clips.twitch.tv') {
    const slug = segments[0] === 'embed' ? url.searchParams.get('clip') : segments[0];
    if (slug && CLIP_SLUG_RE.test(slug)) return { kind: 'clip', slug };
    throw new ValidationError(MSG_NOT_TWITCH_URL, 'input');
  }
  if (host === 'player.twitch.tv') {
    const channel = url.searchParams.get('channel');
    if (channel) return loginTarget(channel);
    const video = url.searchParams.get('video')?.replace(/^v/i, '');
    if (video && TWITCH_ID_RE.test(video)) return { kind: 'video', id: video };
    throw new ValidationError(MSG_NOT_TWITCH_URL, 'input');
  }
  if (host !== 'twitch.tv') throw new ValidationError(MSG_NOT_TWITCH_URL, 'input');

  const [first, second] = segments;
  if (!first) throw new ValidationError(MSG_NOT_TWITCH_URL, 'input');
  const head = first.toLowerCase();
  if (head === 'videos' && second && TWITCH_ID_RE.test(second)) return { kind: 'video', id: second };
  if (LOGIN_PREFIX_PATHS.has(head) && second) return loginTarget(second);
  if (RESERVED_PATHS.has(head)) throw new ValidationError(MSG_NOT_TWITCH_URL, 'input');
  return loginTarget(first);
}

/**
 * Parses admin input: "login", "@login", "id:<user id>", channel URLs (twitch.tv, www./m., popout/embed/
 * moderator paths, player.twitch.tv), video URLs and clip URLs. Throws ValidationError (Arabic).
 */
export function parseTwitchInput(raw: string): TwitchTarget {
  const input = raw.trim();
  if (!input) throw new ValidationError(MSG_EMPTY, 'input');

  const id = /^id:\s*(\d{1,20})$/i.exec(input)?.[1];
  if (id) return { kind: 'id', id };

  if (/^(?:https?:\/\/)?(?:[a-z0-9-]+\.)*twitch\.tv(?:[/?#:]|$)/i.test(input)) return parseTwitchUrl(input);
  if (/[/:]/.test(input)) throw new ValidationError(MSG_NOT_TWITCH_URL, 'input');
  return loginTarget(input.replace(/^@/, ''));
}

// ───────────────────────────── app access token ─────────────────────────────

interface StoredAppToken {
  accessToken: string;
  obtainedAt: number;
  expiresAt: number;
  /** Tokens are bound to the issuing client; a changed TWITCH_CLIENT_ID invalidates the cache. */
  clientId: string;
}

function isStoredAppToken(value: unknown): value is StoredAppToken {
  const v = value as Partial<StoredAppToken> | null | undefined;
  return (
    !!v &&
    typeof v.accessToken === 'string' &&
    v.accessToken !== '' &&
    typeof v.expiresAt === 'number' &&
    typeof v.obtainedAt === 'number' &&
    typeof v.clientId === 'string'
  );
}

/** Refresh ahead of expiry: 10% of the lifetime, at most one hour. */
const refreshAt = (t: StoredAppToken) => t.expiresAt - Math.min(TOKEN_REFRESH_MARGIN_MS, (t.expiresAt - t.obtainedAt) / 10);

interface AppAuthOptions {
  clientId: string;
  clientSecret: string;
  http: HttpClient;
  kv: KeyValueStore;
  logger: Logger;
  clock: Clock;
}

/** Client-credentials app token: cached in memory + kv, refreshed early, single-flight, with failure backoff. */
class TwitchAppAuth {
  /** undefined = not loaded from kv yet; null = no usable token. */
  private current: StoredAppToken | null | undefined = undefined;
  private inflight: Promise<StoredAppToken> | null = null;
  private failures = 0;
  private retryAt = 0;
  private lastFailure: ProviderError | null = null;
  lastError: string | null = null;

  constructor(private readonly o: AppAuthOptions) {}

  get expiresAt(): number | null {
    return this.current?.expiresAt ?? null;
  }

  async getToken(): Promise<string> {
    const token = this.load();
    const now = this.o.clock.now();
    if (token && now < refreshAt(token)) return token.accessToken;
    try {
      return (await this.refresh()).accessToken;
    } catch (err) {
      // An early refresh failed but the current token is still valid: keep using it.
      if (token && now < token.expiresAt - 60_000) {
        this.o.logger.warn({ err: errorMessage(err) }, 'Twitch token refresh failed; using the current token until it expires');
        return token.accessToken;
      }
      throw err;
    }
  }

  /** Drops `accessToken` after a 401 (no-op if a newer token already replaced it). */
  invalidate(accessToken: string): void {
    if (this.current?.accessToken !== accessToken) return;
    this.current = null;
    this.retryAt = 0; // a rejected token is not a credentials failure; allow an immediate refetch
    try {
      this.o.kv.delete(TOKEN_KV_KEY);
    } catch {
      // kv is a cache; ignore storage errors
    }
  }

  private load(): StoredAppToken | null {
    if (this.current !== undefined) return this.current;
    let stored: unknown;
    try {
      stored = this.o.kv.get(TOKEN_KV_KEY);
    } catch {
      stored = undefined;
    }
    this.current =
      isStoredAppToken(stored) && stored.clientId === this.o.clientId && stored.expiresAt > this.o.clock.now() ? stored : null;
    return this.current;
  }

  private refresh(): Promise<StoredAppToken> {
    this.inflight ??= this.fetchToken().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async fetchToken(): Promise<StoredAppToken> {
    const now = this.o.clock.now();
    if (this.lastFailure && now < this.retryAt) throw this.lastFailure;
    try {
      const { data } = await this.o.http.request<TokenResponse | null>(TOKEN_URL, {
        method: 'POST',
        body: new URLSearchParams({ client_id: this.o.clientId, client_secret: this.o.clientSecret, grant_type: 'client_credentials' }),
        retries: 1,
      });
      if (!data || typeof data.access_token !== 'string' || data.access_token === '') {
        throw new ProviderError('twitch', 'Token endpoint returned no access_token');
      }
      const lifetimeSec = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : TOKEN_FALLBACK_LIFETIME_S;
      const token: StoredAppToken = { accessToken: data.access_token, obtainedAt: now, expiresAt: now + lifetimeSec * 1000, clientId: this.o.clientId };
      this.current = token;
      this.failures = 0;
      this.retryAt = 0;
      this.lastFailure = null;
      this.lastError = null;
      try {
        this.o.kv.set(TOKEN_KV_KEY, token);
      } catch (err) {
        this.o.logger.warn({ err: errorMessage(err) }, 'Could not persist Twitch app token');
      }
      this.o.logger.info({ expiresAt: new Date(token.expiresAt).toISOString() }, 'Obtained Twitch app access token');
      return token;
    } catch (err) {
      const failure =
        err instanceof TwitchApiError && [400, 401, 403].includes(err.status)
          ? new ProviderNotConfiguredError('twitch', `Twitch rejected the client credentials (HTTP ${err.status}): ${err.responseBody.slice(0, 200)}`)
          : err instanceof ProviderError
            ? err
            : new ProviderError('twitch', `Token request failed: ${errorMessage(err)}`, true, { cause: err });
      this.failures++;
      this.retryAt = now + Math.min(TOKEN_BACKOFF_MAX_MS, TOKEN_BACKOFF_BASE_MS * 2 ** (this.failures - 1));
      this.lastFailure = failure;
      this.lastError = failure.message;
      this.o.logger.error({ err: failure.message, retryInMs: this.retryAt - now }, 'Could not obtain a Twitch app access token');
      throw failure;
    }
  }
}

// ───────────────────────────── Helix client ─────────────────────────────

/** Authenticated Helix calls: retries once on 401 with a fresh token and paces on Ratelimit-* headers. */
class TwitchHelixClient implements HelixTransport {
  private limit: number | null = null;
  private remaining: number | null = null;
  private resetAt = 0;
  private blockedUntil = 0;

  constructor(
    private readonly http: HttpClient,
    private readonly auth: TwitchAppAuth,
    private readonly clientId: string,
    private readonly clock: Clock,
  ) {}

  rateLimit(): { limit: number; remaining: number } | null {
    return this.limit !== null && this.remaining !== null ? { limit: this.limit, remaining: this.remaining } : null;
  }

  async get<T>(path: string, query: HelixRequest['query'], opts: Pick<HelixRequest, 'allow404'> = {}): Promise<T> {
    return (await this.request<T>(path, { query, ...opts })).data;
  }

  async request<T>(path: string, req: HelixRequest = {}): Promise<HelixResult<T>> {
    const token = await this.auth.getToken();
    try {
      return await this.send<T>(path, req, token, true);
    } catch (err) {
      if (!(err instanceof TwitchApiError && err.status === 401)) throw err;
      // Revoked/expired app token (e.g. secret rotated): refetch once, then let a second 401 surface.
      this.auth.invalidate(token);
      return await this.send<T>(path, req, await this.auth.getToken(), true);
    }
  }

  private async send<T>(path: string, req: HelixRequest, token: string, retryOnRateLimit: boolean): Promise<HelixResult<T>> {
    await this.waitForBudget();
    try {
      const res = await this.http.request<T>(`${HELIX_BASE}${path}`, {
        method: req.method ?? 'GET',
        query: req.query,
        body: req.body,
        allow404: req.allow404,
        headers: { authorization: `Bearer ${token}`, 'client-id': this.clientId },
      });
      this.track(res.headers);
      return { status: res.status, data: res.data };
    } catch (err) {
      if (err instanceof TwitchApiError && req.okStatuses?.includes(err.status)) {
        return { status: err.status, data: parseJsonSafe(err.responseBody) as T };
      }
      if (err instanceof RateLimitedError) {
        this.blockedUntil = Math.max(this.blockedUntil, this.clock.now() + Math.min(err.retryAfterMs, 60_000));
        if (retryOnRateLimit && err.retryAfterMs <= MAX_RATE_LIMIT_WAIT_MS) return this.send<T>(path, req, token, false);
      }
      throw err;
    }
  }

  private track(headers: Headers): void {
    const limit = Number(headers.get('ratelimit-limit'));
    const remaining = Number(headers.get('ratelimit-remaining'));
    const reset = Number(headers.get('ratelimit-reset'));
    if (headers.has('ratelimit-limit') && Number.isFinite(limit) && limit > 0) this.limit = limit;
    if (headers.has('ratelimit-remaining') && Number.isFinite(remaining)) this.remaining = remaining;
    if (headers.has('ratelimit-reset') && Number.isFinite(reset)) this.resetAt = reset * 1000;
  }

  private async waitForBudget(): Promise<void> {
    const now = this.clock.now();
    let until = this.blockedUntil;
    if (this.remaining !== null && this.remaining <= RATE_LIMIT_LOW_WATERMARK && this.resetAt > now) {
      // The bucket refills continuously (limit per minute), so wait just long enough for a few points.
      const msPerPoint = 60_000 / (this.limit ?? 800);
      until = Math.max(until, Math.min(this.resetAt, now + msPerPoint * (RATE_LIMIT_LOW_WATERMARK + 1 - this.remaining)));
    }
    const wait = until - now;
    if (wait <= 0) return;
    if (wait > MAX_RATE_LIMIT_WAIT_MS) throw new RateLimitedError('twitch', wait);
    await this.clock.sleep(wait);
    this.remaining = null; // unknown until the next response reports it
  }
}

// ───────────────────────────── provider ─────────────────────────────

export interface TwitchProviderOptions {
  /** Injected clock (tests). */
  clock?: Clock;
}

interface GameArtEntry {
  url: string | null;
  expiresAt: number;
}

export class TwitchProvider implements PlatformProvider {
  readonly platform = 'twitch' as const;
  readonly capabilities: ProviderCapabilities;
  readonly webhook?: TwitchEventSubAdapter;

  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly auth: TwitchAppAuth | null = null;
  private readonly helix: TwitchHelixClient | null = null;
  private readonly eventSubNote: string | null = null;
  private readonly gameArt = new Map<string, GameArtEntry>();
  /** Latest known live stream id per broadcaster (null = offline), learned from Get Streams. */
  private readonly liveStreams = new Map<string, { streamId: string | null; at: number }>();

  constructor(ctx: ProviderContext, opts: TwitchProviderOptions = {}) {
    this.logger = ctx.logger;
    this.clock = opts.clock ?? systemClock;
    const { TWITCH_CLIENT_ID: clientId, TWITCH_CLIENT_SECRET: clientSecret } = ctx.config;
    if (clientId && clientSecret) {
      const http = new HttpClient('twitch', statusAwareFetch(ctx.fetch ?? globalThis.fetch.bind(globalThis)));
      this.auth = new TwitchAppAuth({ clientId, clientSecret, http, kv: ctx.kv, logger: this.logger, clock: this.clock });
      this.helix = new TwitchHelixClient(http, this.auth, clientId, this.clock);
      const eventSub = this.setupEventSub(ctx, this.helix);
      this.webhook = eventSub.adapter;
      this.eventSubNote = eventSub.note;
    }
    this.capabilities = { live: true, content: [...SUPPORTED_KINDS], liveBatchSize: MAX_IDS_PER_REQUEST, push: !!this.webhook };
  }

  isConfigured(): boolean {
    return this.helix !== null;
  }

  health(): ProviderHealth {
    if (!this.helix || !this.auth) {
      return { configured: false, notes: ['لم يتم ضبط TWITCH_CLIENT_ID و TWITCH_CLIENT_SECRET، لذلك متابعة Twitch متوقفة.'] };
    }
    const notes: string[] = [];
    if (this.auth.lastError) notes.push(`تعذّر الحصول على رمز دخول Twitch: ${this.auth.lastError}`);
    else if (this.auth.expiresAt) notes.push('رمز دخول التطبيق في Twitch صالح ويتجدد تلقائياً.');

    if (this.webhook) {
      notes.push('إشعارات EventSub الفورية مفعّلة (Webhook)، والفحص الدوري شغّال كمصدر أساسي للحالة.');
      const { lastSync, revocations } = this.webhook.status();
      if (!lastSync) notes.push('لم تتم مزامنة اشتراكات EventSub بعد.');
      else if (lastSync.error) notes.push(`فشلت آخر مزامنة لاشتراكات EventSub: ${lastSync.error}`);
      else {
        const failed = lastSync.failed > 0 ? `، وفشل ${lastSync.failed}` : '';
        notes.push(`اشتراكات EventSub: ${lastSync.active} اشتراك فعّال لـ ${lastSync.channels} قناة${failed}.`);
      }
      if (lastSync?.limitReached) notes.push('وصلنا لحد اشتراكات EventSub في Twitch، بعض القنوات تعتمد على الفحص الدوري فقط.');
      const latest = revocations[0];
      if (latest) notes.push(`ألغت Twitch ${revocations.length} اشتراك مؤخراً (آخر سبب: ${latest.status}) وسيُعاد إنشاؤها تلقائياً عند الإمكان.`);
    } else if (this.eventSubNote) {
      notes.push(this.eventSubNote);
    }

    const rate = this.helix.rateLimit();
    if (rate && rate.remaining < rate.limit * 0.1) {
      notes.push(`طلبات Twitch API قريبة من الحد (المتبقي ${rate.remaining} من ${rate.limit} بالدقيقة).`);
    }
    return { configured: true, notes };
  }

  // ─────────────── resolve ───────────────

  async resolveChannel(input: string): Promise<ResolvedChannel> {
    const helix = this.requireHelix();
    const target = parseTwitchInput(input);
    let userId: string | null = null;
    let user: HelixUser | null = null;
    switch (target.kind) {
      case 'login':
        user = await this.getUser(helix, { login: target.login });
        break;
      case 'id':
        userId = target.id;
        break;
      case 'video': {
        const page = await helix.get<HelixPage<HelixVideo> | null>('/videos', { id: target.id }, { allow404: true });
        userId = page?.data?.[0]?.user_id ?? null;
        break;
      }
      case 'clip': {
        const page = await helix.get<HelixPage<HelixClip> | null>('/clips', { id: target.slug }, { allow404: true });
        userId = page?.data?.[0]?.broadcaster_id ?? null;
        break;
      }
    }
    if (!user && userId) user = await this.getUser(helix, { id: userId });
    if (!user) throw new ChannelNotFoundError('twitch', input.trim());
    return {
      platform: 'twitch',
      platformId: user.id,
      handle: user.login,
      displayName: user.display_name || user.login,
      avatarUrl: user.profile_image_url || null,
      url: channelUrl(user.login),
      meta: {},
    };
  }

  private async getUser(helix: TwitchHelixClient, query: { login: string } | { id: string }): Promise<HelixUser | null> {
    try {
      const page = await helix.get<HelixPage<HelixUser>>('/users', query);
      return page?.data?.[0] ?? null;
    } catch (err) {
      // Twitch answers 400 for logins/ids it considers malformed: that is "not found" for the admin.
      if (err instanceof TwitchApiError && err.status === 400) return null;
      throw err;
    }
  }

  // ─────────────── live ───────────────

  async checkLive(channels: ChannelRef[]): Promise<LiveSnapshot[]> {
    if (channels.length === 0) return [];
    const helix = this.requireHelix();

    const ids = unique(channels.map((c) => c.platformId).filter(isTwitchId));
    const invalid = channels.filter((c) => !isTwitchId(c.platformId));
    if (invalid.length > 0) {
      this.logger.warn({ channels: invalid.map((c) => c.id) }, 'Skipping Twitch channels with a malformed user id (reported offline)');
    }

    const streams = new Map<string, HelixStream>();
    await Promise.all(chunk(ids, MAX_IDS_PER_REQUEST).map((batch) => this.fetchStreams(helix, batch, streams)));

    const now = this.clock.now();
    for (const id of ids) this.liveStreams.set(id, { streamId: streams.get(id)?.id ?? null, at: now });

    const art = await this.resolveGameArt(helix, [...streams.values()].map((s) => s.game_id));
    return channels.map((channel) => {
      const stream = streams.get(channel.platformId);
      return stream ? this.toSnapshot(channel, stream, art) : offlineSnapshot({ platform: 'twitch', platformId: channel.platformId }, channelUrl(channel.handle));
    });
  }

  /** Live streams of one batch of user ids; a stream missing from a short first page must not read as offline. */
  private async fetchStreams(helix: TwitchHelixClient, batch: string[], into: Map<string, HelixStream>): Promise<void> {
    let cursor: string | undefined;
    for (let page = 0; page < STREAMS_MAX_PAGES; page++) {
      const res = await helix.get<HelixPage<HelixStream>>('/streams', { user_id: batch, first: MAX_IDS_PER_REQUEST, after: cursor });
      const data = res?.data ?? [];
      for (const stream of data) into.set(stream.user_id, stream);
      const next = res?.pagination?.cursor || undefined;
      if (!next || next === cursor || data.length === 0 || batch.every((id) => into.has(id))) return;
      cursor = next;
    }
  }

  private toSnapshot(channel: ChannelRef, s: HelixStream, art: Map<string, string | null>): LiveSnapshot {
    return {
      platform: 'twitch',
      platformId: channel.platformId,
      isLive: true,
      streamId: s.id || null,
      title: s.title?.trim() || null,
      category: s.game_name?.trim() || null,
      categoryImageUrl: s.game_id ? (art.get(s.game_id) ?? null) : null,
      thumbnailUrl: s.thumbnail_url ? cacheBust(fillImageTemplate(s.thumbnail_url, LIVE_THUMBNAIL)) : null,
      viewers: typeof s.viewer_count === 'number' ? s.viewer_count : null,
      startedAt: s.started_at || null,
      // Prefer the login from the stream: it reflects renames before our stored handle does.
      url: channelUrl(s.user_login || channel.handle),
      language: s.language || null,
      tags: Array.isArray(s.tags) ? s.tags.filter((t): t is string => typeof t === 'string') : [],
    };
  }

  /** Box art per game id, fetched in one batched call for unknown ids and cached across polls. */
  private async resolveGameArt(helix: TwitchHelixClient, gameIds: string[]): Promise<Map<string, string | null>> {
    const now = this.clock.now();
    const wanted = unique(gameIds.filter((id) => !!id && id !== '0'));
    const missing = wanted.filter((id) => (this.gameArt.get(id)?.expiresAt ?? 0) <= now);
    try {
      for (const batch of chunk(missing, MAX_IDS_PER_REQUEST)) {
        const page = await helix.get<HelixPage<HelixGame>>('/games', { id: batch });
        const found = new Map((page?.data ?? []).map((g) => [g.id, g]));
        for (const id of batch) {
          const boxArt = found.get(id)?.box_art_url;
          this.cacheGameArt(id, boxArt ? fillImageTemplate(boxArt, BOX_ART) : null, now);
        }
      }
    } catch (err) {
      // Cosmetic only: keep serving stale entries and retry on the next poll.
      this.logger.warn({ err: errorMessage(err) }, 'Could not fetch Twitch game box art');
    }
    return new Map(wanted.map((id) => [id, this.gameArt.get(id)?.url ?? null]));
  }

  private cacheGameArt(id: string, url: string | null, now: number): void {
    this.gameArt.delete(id);
    this.gameArt.set(id, { url, expiresAt: now + (url ? GAME_ART_TTL_MS : GAME_ART_MISS_TTL_MS) });
    while (this.gameArt.size > GAME_ART_CACHE_MAX) {
      const oldest = this.gameArt.keys().next().value;
      if (oldest === undefined) break;
      this.gameArt.delete(oldest);
    }
  }

  // ─────────────── content ───────────────

  async fetchRecentContent(channel: ChannelRef, kinds: ContentKind[]): Promise<ContentItem[]> {
    const wanted = new Set(kinds.filter((k): k is (typeof SUPPORTED_KINDS)[number] => (SUPPORTED_KINDS as readonly string[]).includes(k)));
    if (wanted.size === 0) return [];
    const helix = this.requireHelix();
    if (!isTwitchId(channel.platformId)) {
      this.logger.warn({ channel: channel.id }, 'Skipping content check for a Twitch channel with a malformed user id');
      return [];
    }

    // Any failure fails the whole call: returning a partial list could make the content monitor treat
    // the missing half as "new" once it reappears.
    const videoKinds = VIDEO_KINDS.filter((k) => wanted.has(k));
    const [videos, clips] = await Promise.all([
      videoKinds.length > 0 ? this.fetchVideos(helix, channel, videoKinds) : Promise.resolve([]),
      wanted.has('clip') ? this.fetchClips(helix, channel) : Promise.resolve([]),
    ]);

    const seen = new Set<string>();
    return [...videos, ...clips]
      .filter((item) => {
        const key = `${item.kind}:${item.contentId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => timeOf(b.publishedAt) - timeOf(a.publishedAt) || b.contentId.localeCompare(a.contentId));
  }

  private async fetchVideos(helix: TwitchHelixClient, channel: ChannelRef, kinds: VideoKind[]): Promise<ContentItem[]> {
    const type = kinds.length === 1 && kinds[0] ? KIND_TO_VIDEO_TYPE[kinds[0]] : 'all';
    const page = await helix.get<HelixPage<HelixVideo> | null>(
      '/videos',
      { user_id: channel.platformId, type, sort: 'time', first: VIDEOS_PAGE_SIZE },
      { allow404: true },
    );
    const videos = page?.data ?? [];
    const liveStreamId = kinds.includes('vod') ? await this.liveStreamIdForArchives(helix, channel, videos) : null;

    const items: ContentItem[] = [];
    for (const video of videos) {
      const kind = VIDEO_TYPE_TO_KIND[video.type as HelixVideoType] as VideoKind | undefined;
      if (!kind || !kinds.includes(kind)) continue;
      if (video.viewable && video.viewable !== 'public') continue;
      // Twitch creates the archive when the stream starts; announcing it mid-stream would be wrong.
      if (kind === 'vod' && (isPlaceholderThumbnail(video.thumbnail_url) || (!!video.stream_id && video.stream_id === liveStreamId))) continue;
      items.push({
        platform: 'twitch',
        platformId: channel.platformId,
        contentId: video.id,
        kind,
        title: video.title?.trim() || CONTENT_KIND_LABELS_AR[kind],
        url: videoUrl(video),
        thumbnailUrl: isPlaceholderThumbnail(video.thumbnail_url) ? null : fillImageTemplate(video.thumbnail_url, VIDEO_THUMBNAIL),
        publishedAt: video.published_at || video.created_at,
        durationSec: parseTwitchDuration(video.duration),
        viewCount: typeof video.view_count === 'number' ? video.view_count : null,
        relatedStreamId: video.stream_id || null,
      });
    }
    return items;
  }

  /**
   * Current live stream id of the channel, but only when some archive could still be in progress
   * (recent, real thumbnail). Uses the status learned by checkLive() when fresh, else asks Get Streams.
   */
  private async liveStreamIdForArchives(helix: TwitchHelixClient, channel: ChannelRef, videos: HelixVideo[]): Promise<string | null> {
    const now = this.clock.now();
    const needsCheck = videos.some(
      (v) => v.type === 'archive' && !!v.stream_id && !isPlaceholderThumbnail(v.thumbnail_url) && now - timeOf(v.created_at) < MAX_BROADCAST_MS,
    );
    if (!needsCheck) return null;
    const known = this.liveStreams.get(channel.platformId);
    if (known && now - known.at < LIVE_STATUS_FRESH_MS) return known.streamId;
    const page = await helix.get<HelixPage<HelixStream>>('/streams', { user_id: channel.platformId, first: 1 });
    const streamId = page?.data?.[0]?.id ?? null;
    this.liveStreams.set(channel.platformId, { streamId, at: now });
    return streamId;
  }

  private async fetchClips(helix: TwitchHelixClient, channel: ChannelRef): Promise<ContentItem[]> {
    const now = this.clock.now();
    const query = { broadcaster_id: channel.platformId, started_at: rfc3339(now - CLIP_WINDOW_MS), ended_at: rfc3339(now), first: 100 };
    const clips: HelixClip[] = [];
    let cursor: string | undefined;
    // Clips come sorted by views, not time, so walk a few pages of the window to catch fresh ones.
    for (let page = 0; page < CLIP_MAX_PAGES; page++) {
      const res = await helix.get<HelixPage<HelixClip> | null>('/clips', { ...query, after: cursor }, { allow404: true });
      const data = res?.data ?? [];
      clips.push(...data);
      cursor = res?.pagination?.cursor || undefined;
      if (!cursor || data.length === 0) break;
    }
    return clips
      .filter((clip) => clip.id && clip.created_at)
      .map((clip) => ({
        platform: 'twitch' as const,
        platformId: channel.platformId,
        contentId: clip.id,
        kind: 'clip' as const,
        title: clip.title?.trim() || CONTENT_KIND_LABELS_AR.clip,
        url: clip.url || `https://clips.twitch.tv/${clip.id}`,
        thumbnailUrl: clip.thumbnail_url || null,
        publishedAt: clip.created_at,
        durationSec: typeof clip.duration === 'number' ? Math.round(clip.duration) : null,
        viewCount: typeof clip.view_count === 'number' ? clip.view_count : null,
        relatedStreamId: null,
        featured: typeof clip.is_featured === 'boolean' ? clip.is_featured : null,
      }))
      .sort((a, b) => timeOf(b.publishedAt) - timeOf(a.publishedAt));
  }

  // ─────────────── VOD lookup ───────────────

  async findVodUrl(channel: ChannelRef, streamId: string | null, startedAt: string | null): Promise<string | null> {
    if (!this.helix || !isTwitchId(channel.platformId)) return null;
    try {
      const page = await this.helix.get<HelixPage<HelixVideo> | null>(
        '/videos',
        { user_id: channel.platformId, type: 'archive', sort: 'time', first: 5 },
        { allow404: true },
      );
      const archives = page?.data ?? [];
      const byStream = streamId ? archives.find((v) => v.stream_id === streamId) : undefined;
      const match = byStream ?? closestArchive(archives, startedAt);
      return match ? videoUrl(match) : null;
    } catch (err) {
      this.logger.warn({ channel: channel.id, streamId, err: errorMessage(err) }, 'Could not look up Twitch VOD');
      return null;
    }
  }

  // ─────────────── internals ───────────────

  private requireHelix(): TwitchHelixClient {
    if (!this.helix) throw new ProviderNotConfiguredError('twitch', 'TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET are not configured');
    return this.helix;
  }

  private setupEventSub(ctx: ProviderContext, helix: TwitchHelixClient): { adapter?: TwitchEventSubAdapter; note: string | null } {
    const { config } = ctx;
    const secret = config.TWITCH_EVENTSUB_SECRET;
    const pollingOnly = 'والاعتماد حالياً على الفحص الدوري فقط.';
    if (!config.webhooksEnabled || !config.PUBLIC_URL) {
      return { note: `إشعارات EventSub غير مفعّلة لأنها تحتاج PUBLIC_URL يبدأ بـ https://، ${pollingOnly}` };
    }
    if (!secret) {
      return { note: `إشعارات EventSub غير مفعّلة لأن TWITCH_EVENTSUB_SECRET غير مضبوط، ${pollingOnly}` };
    }
    if (!EVENTSUB_SECRET_RE.test(secret)) {
      this.logger.warn('TWITCH_EVENTSUB_SECRET must be 10-100 ASCII characters; EventSub disabled');
      return { note: `TWITCH_EVENTSUB_SECRET لازم يكون بين 10 و100 حرف إنجليزي، لذلك EventSub متوقف ${pollingOnly}` };
    }
    const port = new URL(config.PUBLIC_URL).port;
    if (port && port !== '443') {
      this.logger.warn({ port }, 'Twitch EventSub callbacks must use port 443; EventSub disabled');
      return { note: `Twitch تقبل روابط EventSub على المنفذ 443 فقط (PUBLIC_URL يستخدم ${port})، ${pollingOnly}` };
    }
    const adapter = new TwitchEventSubAdapter({
      api: helix,
      secret,
      callbackUrl: `${config.PUBLIC_URL}${EVENTSUB_PATH}`,
      logger: this.logger,
      kv: ctx.kv,
      now: () => this.clock.now(),
    });
    return { adapter, note: null };
  }
}

/** Archive created closest to `startedAt`, within the match tolerance. */
function closestArchive(archives: HelixVideo[], startedAt: string | null): HelixVideo | undefined {
  const target = timeOf(startedAt);
  if (!Number.isFinite(target)) return undefined;
  let best: { video: HelixVideo; diff: number } | undefined;
  for (const video of archives) {
    const diff = Math.abs(timeOf(video.created_at) - target);
    if (Number.isFinite(diff) && diff <= VOD_MATCH_TOLERANCE_MS && (!best || diff < best.diff)) best = { video, diff };
  }
  return best?.video;
}

export const createTwitchProvider: ProviderFactory = (ctx) => new TwitchProvider(ctx);
