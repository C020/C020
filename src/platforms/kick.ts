/**
 * Kick provider.
 *
 * Live detection uses the official Public API (api.kick.com) with an app access token
 * (client-credentials grant), so streamers never have to authorise anything:
 *   - primary:  GET /public/v1/users/livestreams?user_id=…   (≤100 ids, returns live channels only)
 *   - fallback: GET /public/v1/channels?broadcaster_user_id=… (≤50 ids, stream.is_live) — used when the
 *               primary endpoint misbehaves so one broken endpoint never blinds the monitor.
 *
 * Push: livestream.status.updated / livestream.metadata.updated webhooks (RSA-SHA256 signed). They are
 * only hints; the monitor always re-checks through checkLive().
 *
 * Content: Kick has no official VOD/clip API, so VODs and clips come from the website's JSON endpoints.
 * Those sit behind Cloudflare and are frequently blocked from datacenter IPs, so they are guarded by a
 * persistent circuit breaker (15 min → 6 h backoff) and a request throttle.
 */
import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';
import type { AppConfig } from '../config.js';
import {
  ChannelNotFoundError,
  ProviderError,
  ProviderNotConfiguredError,
  RateLimitedError,
  ValidationError,
  errorMessage,
} from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import { offlineSnapshot, type ChannelRef, type ContentItem, type ContentKind, type LiveSnapshot, type ResolvedChannel } from '../core/types.js';
import { HttpClient, cacheBust, chunk, type FetchLike } from './http.js';
import type {
  KeyValueStore,
  PlatformProvider,
  ProviderCapabilities,
  ProviderContext,
  ProviderFactory,
  ProviderHealth,
  PushHint,
  WebhookAdapter,
  WebhookRequest,
  WebhookResponse,
} from './types.js';

// ───────────────────────────── constants ─────────────────────────────

const API_BASE = 'https://api.kick.com/public/v1';
const TOKEN_URL = 'https://id.kick.com/oauth/token';
const WEB_BASE = 'https://kick.com';
const API_USER_AGENT = 'StreamBot/1.0 (+discord bot; kick public api)';
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

export const KICK_WEBHOOK_PATH = '/webhooks/kick';

/** /users/livestreams accepts up to 100 user ids. */
const LIVE_BATCH_SIZE = 100;
/**
 * The spec allows 50 ids/slugs per /channels call, but batches of 50 return wrong data for about half the
 * channels (KickDevDocs issue #321); 25 is reliable.
 */
const CHANNELS_BATCH_SIZE = 25;
const SLUG_MAX_LENGTH = 25;

const KICK_CONTENT_KINDS = ['vod', 'clip'] as const satisfies readonly ContentKind[];
const MAX_ITEMS_PER_KIND = 12;

const MANAGED_EVENTS = [
  { name: 'livestream.status.updated', version: 1 },
  { name: 'livestream.metadata.updated', version: 1 },
] as const;
const MANAGED_EVENT_NAMES = new Set<string>(MANAGED_EVENTS.map((e) => e.name));
const eventKey = (name: string, version: number | string) => `${name}@${version}`;
const MANAGED_EVENT_KEYS = new Set(MANAGED_EVENTS.map((e) => eventKey(e.name, e.version)));

const KV_KEYS = {
  token: 'kick:app_token',
  publicKey: 'kick:public_key',
  breaker: 'kick:unofficial_breaker',
  streams: 'kick:streams',
} as const;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const TOKEN_REFRESH_MARGIN_MS = 5 * MINUTE;
const DEFAULT_TOKEN_LIFETIME_S = 3600;
const BREAKER_BASE_COOLDOWN_MS = 15 * MINUTE;
const BREAKER_MAX_COOLDOWN_MS = 6 * HOUR;
const DEFAULT_UNOFFICIAL_GAP_MS = 2_000;
const UNOFFICIAL_TIMEOUT_MS = 15_000;
const VIDEO_CACHE_TTL_MS = MINUTE;
const PUBLIC_KEY_MAX_AGE_MS = 24 * HOUR;
const PUBLIC_KEY_REFRESH_COOLDOWN_MS = 10 * MINUTE;
const DEFAULT_WEBHOOK_MAX_SKEW_MS = 5 * MINUTE;
const WEBHOOK_DEDUPE_SIZE = 5_000;
/** Two observations whose start times differ by less than this belong to the same broadcast. */
const SAME_STREAM_TOLERANCE_MS = 2 * MINUTE;
/** A VOD whose start time is this close to a tracked stream's start is that stream's recording. */
const VOD_MATCH_TOLERANCE_MS = 10 * MINUTE;
const STREAM_LEDGER_PER_CHANNEL = 6;
const STREAM_LEDGER_MAX_AGE_MS = 30 * 24 * HOUR;
/** Kick reports "0001-01-01T00:00:00Z" for unset timestamps. */
const MIN_VALID_DATE_MS = Date.UTC(2010, 0, 1);

/** Public key printed in the official webhook docs; used when the key endpoint is unreachable. */
export const KICK_DOCUMENTED_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAq/+l1WnlRrGSolDMA+A8
6rAhMbQGmQ2SapVcGM3zq8ANXjnhDWocMqfWcTd95btDydITa10kDvHzw9WQOqp2
MZI7ZyrfzJuz5nhTPCiJwTwnEtWft7nV14BYRDHvlfqPUaZ+1KR4OCaO/wWIk/rQ
L/TjY0M70gse8rlBkbo2a8rKhu69RQTRsoaf4DVhDPEeSeI5jVrRDGAMGL3cGuyY
6CLKGdjVEM78g3JfYOvDU/RvfqD7L89TZ3iN94jrmWdGz34JNlEI5hqK8dd7C5EF
BEbZ5jgB8s8ReQV8H+MkuffjdAj3ajDDX3DOJMIut1lBrUVD1AaSrGCKHooWoL2e
twIDAQAB
-----END PUBLIC KEY-----`;

/** First path segments of kick.com URLs that are not channel slugs. */
const RESERVED_PATHS = new Set([
  'api',
  'auth',
  'browse',
  'categories',
  'category',
  'clips',
  'dashboard',
  'following',
  'search',
  'settings',
  'subscriptions',
  'terms-of-service',
  'video',
  'videos',
]);

const CHALLENGE_MARKERS = [
  'just a moment',
  'challenge-platform',
  '_cf_chl',
  'cf-browser-verification',
  'attention required',
  'cf-error-details',
  'request blocked by security policy',
];

// ───────────────────────────── API payloads (loose: Kick changes fields often) ─────────────────────────────

interface Envelope<T> {
  data?: T;
  message?: string;
}

interface KickCategory {
  id?: number;
  name?: string;
  thumbnail?: string;
}

interface KickLivestreamV2 {
  id?: string | number;
  title?: string;
  viewer_count?: number | string;
  started_at?: string;
  thumbnail?: unknown;
  language_code?: string;
  tags?: unknown;
  category?: KickCategory | null;
  broadcaster_user?: { id?: number | string; username?: string; profile_picture?: string } | null;
  broadcaster_user_id?: number | string;
  channel?: { slug?: string } | null;
  slug?: string;
}

interface KickChannel {
  broadcaster_user_id?: number | string;
  slug?: string;
  stream_title?: string;
  category?: KickCategory | null;
  stream?: {
    is_live?: boolean;
    viewer_count?: number | string;
    start_time?: string;
    thumbnail?: unknown;
    language?: string;
    custom_tags?: unknown;
  } | null;
}

interface KickUser {
  user_id?: number | string;
  name?: string;
  profile_picture?: string;
}

interface KickSubscription {
  id?: string;
  broadcaster_user_id?: number | string;
  event?: string;
  version?: number | string;
  method?: string;
}

interface KickSubscriptionResult {
  name?: string;
  version?: number;
  subscription_id?: string;
  error?: string;
}

interface KickWebVideo {
  id?: number | string;
  session_title?: string | null;
  is_live?: boolean;
  start_time?: string;
  created_at?: string;
  duration?: number | string;
  thumbnail?: unknown;
  views?: number | string;
  /** Public VOD id used in URLs since Kick's mid-2026 change (differs from video.uuid). */
  vod_id?: string;
  video?: {
    uuid?: string;
    vod_id?: string;
    views?: number | string;
    live_stream_id?: number | string;
    created_at?: string;
  } | null;
}

interface KickWebClip {
  id?: string;
  title?: string;
  thumbnail_url?: string;
  duration?: number | string;
  view_count?: number | string;
  views?: number | string;
  created_at?: string;
  channel?: { slug?: string } | null;
}

/** Normalised live state, independent of which endpoint produced it. */
interface LiveData {
  platformId: string;
  officialId: string | null;
  slug: string | null;
  title: string | null;
  category: string | null;
  categoryImageUrl: string | null;
  thumbnailUrl: string | null;
  viewers: number | null;
  startedAt: number | null;
  language: string | null;
  tags: string[];
}

// ───────────────────────────── small helpers ─────────────────────────────

type JsonObject = Record<string, unknown>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const isRecord = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** Trimmed non-empty string, else null. */
function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Kick numeric ids (user ids, livestream ids) as canonical strings. */
function idString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return String(Number(value.trim()));
  return null;
}

function stringList(value: unknown): string[] {
  return asArray(value)
    .map((v) => str(v))
    .filter((v): v is string => v !== null);
}

function imageUrl(value: unknown): string | null {
  if (typeof value === 'string') return str(value);
  if (isRecord(value)) return str(value.url) ?? str(value.src);
  return null;
}

/** Live thumbnail, ignoring Kick's generic placeholder images. */
function liveThumbnail(value: unknown): string | null {
  const url = imageUrl(value);
  return url && !url.includes('/default-thumbnail') ? url : null;
}

const toIso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/**
 * Parses Kick timestamps. The official API uses RFC 3339; the website API uses "YYYY-MM-DD HH:MM:SS" in UTC
 * without an offset. Returns epoch ms, or null for missing/placeholder values.
 */
export function parseKickDate(value: unknown): number | null {
  const text = str(value);
  if (!text) return null;
  const normalised = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text) ? `${text.replace(' ', 'T')}Z` : text;
  const ms = Date.parse(normalised);
  return Number.isFinite(ms) && ms >= MIN_VALID_DATE_MS ? ms : null;
}

function channelUrl(slug: string): string {
  return `${WEB_BASE}/${encodeURIComponent(slug)}`;
}

function firstHeader(headers: WebhookRequest['headers'], name: string): string | null {
  const direct = headers[name] ?? Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
  const value = Array.isArray(direct) ? direct[0] : direct;
  return str(value);
}

function retryAfterMs(headers: Headers): number {
  const raw = headers.get('retry-after');
  if (!raw) return 0;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

async function forEachLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function minutesUntil(ms: number, now: number): number {
  return Math.max(1, Math.ceil((ms - now) / MINUTE));
}

/**
 * Parses admin input into slug candidates. Accepts "slug", "@slug", "kick.com/slug", "https://kick.com/slug/videos/…".
 * Usernames with underscores map to hyphenated slugs on Kick ("A_Log_Burner" → "a-log-burner"), so both are tried.
 */
export function parseKickChannelInput(input: string): { candidates: string[]; numericId: string | null } {
  let value = input.trim();
  if (!value) throw new ValidationError('اكتب اسم قناة كيك أو رابطها', 'input');

  const looksLikeKickUrl = /^(https?:\/\/)?([a-z0-9-]+\.)*kick\.com(\/|$|\?|#)/i.test(value);
  if (looksLikeKickUrl) {
    let url: URL;
    try {
      url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    } catch {
      throw new ValidationError('رابط كيك غير صالح', 'input');
    }
    const segments = url.pathname.split('/').filter(Boolean);
    const slugSegment = segments[0]?.toLowerCase() === 'popout' ? segments[1] : segments[0];
    if (!slugSegment || RESERVED_PATHS.has(slugSegment.toLowerCase())) {
      throw new ValidationError('الرابط ما فيه اسم قناة كيك — انسخ رابط القناة مثل kick.com/name', 'input');
    }
    try {
      value = decodeURIComponent(slugSegment);
    } catch {
      value = slugSegment;
    }
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^[\w-]+(\.[\w-]+)+\//.test(value)) {
    throw new ValidationError('الرابط لازم يكون من kick.com', 'input');
  }

  value = value.replace(/^@+/, '');
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > SLUG_MAX_LENGTH) {
    throw new ValidationError('اسم قناة كيك غير صالح — اكتب اسم القناة أو رابطها مثل kick.com/name', 'input');
  }
  const lower = value.toLowerCase();
  const candidates = [...new Set([lower, lower.replace(/_/g, '-')])];
  return { candidates, numericId: idString(value) };
}

// ───────────────────────────── infrastructure ─────────────────────────────

/** KV access that never throws: persistence is an optimisation here, never a reason to fail a check. */
class SafeKv {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly logger: Logger,
  ) {}

  get<T>(key: string): T | undefined {
    try {
      return this.kv.get<T>(key);
    } catch (err) {
      this.logger.warn({ key, err: errorMessage(err) }, 'kv read failed');
      return undefined;
    }
  }

  set(key: string, value: unknown): void {
    try {
      this.kv.set(key, value);
    } catch (err) {
      this.logger.warn({ key, err: errorMessage(err) }, 'kv write failed');
    }
  }

  delete(key: string): void {
    try {
      this.kv.delete(key);
    } catch (err) {
      this.logger.warn({ key, err: errorMessage(err) }, 'kv delete failed');
    }
  }
}

interface StoredToken {
  clientId: string;
  accessToken: string;
  /** Epoch ms after which the token should be replaced (expiry minus a safety margin). */
  refreshAt: number;
}

/** App access token (client credentials), cached in memory + kv, single-flight refresh. */
class KickAppToken {
  private cached: StoredToken | null = null;
  private inflight: Promise<string> | null = null;
  lastError: string | null = null;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly http: HttpClient,
    private readonly kv: SafeKv,
    private readonly now: () => number,
    private readonly logger: Logger,
  ) {}

  async get(): Promise<string> {
    if (this.isUsable(this.cached)) return this.cached.accessToken;
    const stored = this.kv.get<StoredToken>(KV_KEYS.token);
    if (this.isUsable(stored)) {
      this.cached = stored;
      return stored.accessToken;
    }
    this.inflight ??= this.fetchToken().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Drops a token Kick rejected (only if it is still the current one, so concurrent 401s refresh once). */
  invalidate(token: string): void {
    if (this.cached?.accessToken === token) this.cached = null;
    const stored = this.kv.get<StoredToken>(KV_KEYS.token);
    if (stored?.accessToken === token) this.kv.delete(KV_KEYS.token);
  }

  private isUsable(token: StoredToken | null | undefined): token is StoredToken {
    return (
      !!token &&
      token.clientId === this.clientId &&
      typeof token.accessToken === 'string' &&
      token.accessToken !== '' &&
      typeof token.refreshAt === 'number' &&
      token.refreshAt > this.now()
    );
  }

  private async fetchToken(): Promise<string> {
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: this.clientId, client_secret: this.clientSecret });
    let data: unknown;
    try {
      data = (await this.http.request<unknown>(TOKEN_URL, { method: 'POST', body, retries: 1 })).data;
    } catch (err) {
      this.lastError = errorMessage(err);
      // A 4xx from the token endpoint means the credentials (or the app) were rejected.
      if (err instanceof ProviderError && !err.retryable && !(err instanceof RateLimitedError)) {
        throw new ProviderNotConfiguredError('kick', `Kick rejected KICK_CLIENT_ID/KICK_CLIENT_SECRET: ${errorMessage(err)}`);
      }
      throw err;
    }
    const accessToken = isRecord(data) ? str(data.access_token) : null;
    if (!accessToken) {
      this.lastError = 'token response without access_token';
      throw new ProviderError('kick', 'Token endpoint returned no access_token');
    }
    const lifetimeMs = Math.max(60, num(isRecord(data) ? data.expires_in : null) ?? DEFAULT_TOKEN_LIFETIME_S) * 1000;
    const token: StoredToken = {
      clientId: this.clientId,
      accessToken,
      refreshAt: this.now() + lifetimeMs - Math.min(TOKEN_REFRESH_MARGIN_MS, lifetimeMs * 0.2),
    };
    this.cached = token;
    this.kv.set(KV_KEYS.token, token);
    this.lastError = null;
    this.logger.debug({ expiresInSec: Math.round(lifetimeMs / 1000) }, 'Kick app token refreshed');
    return accessToken;
  }
}

/** Latest known slug per broadcaster id (slugs can be renamed; the broadcaster id is the stable key). */
class SlugBook {
  private readonly slugs = new Map<string, string>();

  constructor(private readonly logger: Logger) {}

  get(platformId: string): string | undefined {
    return this.slugs.get(platformId);
  }

  observe(platformId: string, slug: string | null, previous?: string): void {
    const clean = str(slug);
    if (!clean) return;
    const known = this.slugs.get(platformId) ?? previous;
    if (known && known.toLowerCase() !== clean.toLowerCase()) {
      this.logger.info({ platformId, from: known, to: clean }, 'Kick channel slug changed');
    }
    this.slugs.set(platformId, clean);
  }
}

interface LedgerEntry {
  streamId: string;
  startedAt: number;
}

/**
 * Remembers recent broadcasts per channel. It keeps stream ids stable when the same broadcast is seen through
 * different endpoints (only /users/livestreams exposes an id) and links unofficial VODs back to the stream id
 * the monitor announced.
 */
class StreamLedger {
  private entries: Record<string, LedgerEntry[]> | null = null;

  constructor(
    private readonly kv: SafeKv,
    private readonly now: () => number,
  ) {}

  stableId(platformId: string, officialId: string | null, startedAt: number | null): string | null {
    const known = this.list(platformId);
    if (officialId) {
      const same = known.find((e) => e.streamId === officialId);
      if (same) return same.streamId;
    }
    if (startedAt !== null) {
      const near = known.find((e) => Math.abs(e.startedAt - startedAt) <= SAME_STREAM_TOLERANCE_MS);
      if (near) return near.streamId;
    }
    const streamId = officialId ?? (startedAt !== null ? `${platformId}-${Math.floor(startedAt / 1000)}` : null);
    if (streamId) this.remember(platformId, { streamId, startedAt: startedAt ?? this.now() });
    return streamId;
  }

  find(platformId: string, streamId: string): LedgerEntry | undefined {
    return this.list(platformId).find((e) => e.streamId === streamId);
  }

  closestByStart(platformId: string, startedAt: number, toleranceMs: number): LedgerEntry | undefined {
    let best: LedgerEntry | undefined;
    for (const entry of this.list(platformId)) {
      const delta = Math.abs(entry.startedAt - startedAt);
      if (delta <= toleranceMs && (!best || delta < Math.abs(best.startedAt - startedAt))) best = entry;
    }
    return best;
  }

  private list(platformId: string): LedgerEntry[] {
    return this.load()[platformId] ?? [];
  }

  private load(): Record<string, LedgerEntry[]> {
    if (!this.entries) {
      const stored = this.kv.get<Record<string, LedgerEntry[]>>(KV_KEYS.streams);
      this.entries = isRecord(stored) ? (stored as Record<string, LedgerEntry[]>) : {};
    }
    return this.entries;
  }

  private remember(platformId: string, entry: LedgerEntry): void {
    const all = this.load();
    const cutoff = this.now() - STREAM_LEDGER_MAX_AGE_MS;
    all[platformId] = [entry, ...(all[platformId] ?? [])].slice(0, STREAM_LEDGER_PER_CHANNEL);
    for (const [id, list] of Object.entries(all)) {
      const fresh = asArray<LedgerEntry>(list).filter((e) => isRecord(e) && typeof e.startedAt === 'number' && e.startedAt >= cutoff);
      if (fresh.length) all[id] = fresh;
      else delete all[id];
    }
    this.kv.set(KV_KEYS.streams, all);
  }
}

interface BreakerState {
  /** Consecutive blocks; 0 means closed. */
  failures: number;
  openUntil: number;
  lastReason: string | null;
}

/**
 * Circuit breaker for the Cloudflare-protected website API. Persisted so a restart doesn't hammer Kick
 * (and get the IP flagged harder). After the cooldown exactly one probe request is let through.
 */
class CircuitBreaker {
  private state: BreakerState;
  private probing = false;

  constructor(
    private readonly kv: SafeKv,
    private readonly now: () => number,
    private readonly logger: Logger,
  ) {
    const stored = kv.get<BreakerState>(KV_KEYS.breaker);
    this.state =
      isRecord(stored) && typeof stored.failures === 'number' && typeof stored.openUntil === 'number'
        ? { failures: stored.failures, openUntil: stored.openUntil, lastReason: str(stored.lastReason) }
        : { failures: 0, openUntil: 0, lastReason: null };
  }

  isOpen(): boolean {
    return this.state.failures > 0 && this.now() < this.state.openUntil;
  }

  /** True when a request may be sent now. */
  tryAcquire(): boolean {
    if (this.state.failures === 0) return true;
    if (this.now() < this.state.openUntil || this.probing) return false;
    this.probing = true;
    return true;
  }

  /** The request reached Kick's origin (any non-blocked answer, including 404). */
  recordReachable(): void {
    this.probing = false;
    if (this.state.failures === 0) return;
    this.logger.info({ previousFailures: this.state.failures }, 'Kick website API reachable again; closing circuit');
    this.state = { failures: 0, openUntil: 0, lastReason: null };
    this.kv.set(KV_KEYS.breaker, this.state);
  }

  recordBlocked(reason: string, minCooldownMs = 0): void {
    this.probing = false;
    const failures = this.state.failures + 1;
    const cooldown = Math.max(minCooldownMs, Math.min(BREAKER_MAX_COOLDOWN_MS, BREAKER_BASE_COOLDOWN_MS * 2 ** (failures - 1)));
    this.state = { failures, openUntil: this.now() + cooldown, lastReason: reason };
    this.kv.set(KV_KEYS.breaker, this.state);
    this.logger.warn({ reason, failures, cooldownMin: Math.round(cooldown / MINUTE) }, 'Kick website API blocked; pausing unofficial requests');
  }

  /** Transient failure that says nothing about blocking (timeout, 5xx). */
  recordInconclusive(): void {
    this.probing = false;
  }

  snapshot(): Readonly<BreakerState> {
    return this.state;
  }
}

/** Serialises calls with a minimum gap, so content checks for many channels don't burst into Cloudflare. */
class Throttle {
  private tail: Promise<unknown> = Promise.resolve();
  private last = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly gapMs: number,
    private readonly now: () => number,
  ) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const wait = this.last + this.gapMs - this.now();
      if (wait > 0) await sleep(wait);
      try {
        return await task();
      } finally {
        this.last = this.now();
      }
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
}

type WebResult =
  | { kind: 'ok'; data: unknown }
  | { kind: 'not_found' }
  | { kind: 'blocked'; detail: string }
  | { kind: 'unavailable'; detail: string }
  | { kind: 'error'; detail: string };

/**
 * Client for kick.com/api/* (undocumented website API). Uses browser-like headers and keeps cookies Cloudflare
 * hands out (e.g. __cf_bm). A plain Node TLS fingerprint is often blocked anyway; the breaker absorbs that.
 */
class KickWebClient {
  private readonly cookies = new Map<string, string>();
  private readonly throttle: Throttle;

  constructor(
    private readonly fetchImpl: FetchLike,
    readonly breaker: CircuitBreaker,
    now: () => number,
    gapMs: number,
  ) {
    this.throttle = new Throttle(gapMs, now);
  }

  async getJson(path: string, slug: string): Promise<WebResult> {
    if (this.breaker.isOpen()) return { kind: 'unavailable', detail: 'circuit open' };
    return this.throttle.run(async () => {
      if (!this.breaker.tryAcquire()) return { kind: 'unavailable', detail: 'circuit open' };
      let res: Response;
      let text: string;
      try {
        res = await this.fetchImpl(`${WEB_BASE}${path}`, {
          headers: this.headers(slug),
          signal: AbortSignal.timeout(UNOFFICIAL_TIMEOUT_MS),
        });
        text = await res.text();
      } catch (err) {
        this.breaker.recordInconclusive();
        const reason = (err as Error)?.name === 'TimeoutError' ? `timeout after ${UNOFFICIAL_TIMEOUT_MS}ms` : errorMessage(err);
        return { kind: 'error', detail: reason };
      }
      this.captureCookies(res.headers);
      return this.classify(res, text);
    });
  }

  private classify(res: Response, text: string): WebResult {
    const contentType = res.headers.get('content-type') ?? '';
    const isHtml = contentType.includes('text/html') || text.trimStart().startsWith('<');
    const sample = text.slice(0, 4000).toLowerCase();
    const challenged = res.headers.get('cf-mitigated') === 'challenge' || (isHtml && CHALLENGE_MARKERS.some((m) => sample.includes(m)));

    if (res.status === 404 && !challenged) {
      this.breaker.recordReachable();
      return { kind: 'not_found' };
    }
    if (res.status === 429) {
      this.breaker.recordBlocked('HTTP 429', retryAfterMs(res.headers));
      return { kind: 'blocked', detail: 'HTTP 429' };
    }
    if (res.status === 403 || challenged) {
      const detail = `HTTP ${res.status}${challenged ? ' (Cloudflare challenge)' : ''}`;
      this.breaker.recordBlocked(detail);
      return { kind: 'blocked', detail };
    }
    if (res.status >= 400) {
      this.breaker.recordInconclusive();
      return { kind: 'error', detail: `HTTP ${res.status}` };
    }
    try {
      const data: unknown = JSON.parse(text);
      this.breaker.recordReachable();
      return { kind: 'ok', data };
    } catch {
      if (isHtml) {
        this.breaker.recordBlocked('HTML instead of JSON');
        return { kind: 'blocked', detail: 'HTML instead of JSON' };
      }
      this.breaker.recordInconclusive();
      return { kind: 'error', detail: 'invalid JSON' };
    }
  }

  private headers(slug: string): Record<string, string> {
    const headers: Record<string, string> = {
      'user-agent': BROWSER_USER_AGENT,
      accept: 'application/json, text/plain, */*',
      'accept-language': 'en-US,en;q=0.9,ar;q=0.8',
      'cache-control': 'no-cache',
      referer: channelUrl(slug),
      'sec-ch-ua': '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
    };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    return headers;
  }

  private captureCookies(headers: Headers): void {
    const setCookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
    for (const line of setCookies) {
      const pair = line.split(';', 1)[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '' || /max-age=0/i.test(line)) this.cookies.delete(name);
      else if (this.cookies.size < 20 || this.cookies.has(name)) this.cookies.set(name, value);
    }
  }
}

// ───────────────────────────── webhooks ─────────────────────────────

interface StoredPublicKey {
  pem: string;
  fetchedAt: number;
}

function toPublicKey(pem: string | null | undefined): KeyObject | null {
  const text = str(pem);
  if (!text) return null;
  const wrapped = text.includes('BEGIN')
    ? text
    : `-----BEGIN PUBLIC KEY-----\n${text.replace(/\s+/g, '').replace(/(.{64})/g, '$1\n').trim()}\n-----END PUBLIC KEY-----`;
  try {
    return createPublicKey(wrapped);
  } catch {
    return null;
  }
}

function verifyWith(key: KeyObject, message: Buffer, signature: Buffer): boolean {
  try {
    return verifySignature('RSA-SHA256', message, key, signature);
  } catch {
    return false;
  }
}

/**
 * Kick's webhook verification key: pinned (option) → memory → kv → GET /public-key → documented constant.
 * A failed verification triggers at most one key refresh per 10 minutes (handles rotation without letting
 * forged requests make us hammer the key endpoint).
 */
class KickKeyring {
  private current: { key: KeyObject; fetchedAt: number } | null = null;
  private readonly documented = toPublicKey(KICK_DOCUMENTED_PUBLIC_KEY);
  private readonly pinned: KeyObject | null;
  private refreshing: Promise<boolean> | null = null;
  private lastRefreshAttempt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly fetchPem: () => Promise<string | null>,
    private readonly kv: SafeKv,
    private readonly now: () => number,
    private readonly logger: Logger,
    pinnedPem?: string,
  ) {
    this.pinned = pinnedPem ? toPublicKey(pinnedPem) : null;
    if (pinnedPem && !this.pinned) logger.error('Configured Kick webhook public key is not a valid PEM');
  }

  async verify(message: Buffer, signature: Buffer): Promise<boolean> {
    if (signature.length === 0) return false;
    if (this.pinned) return verifyWith(this.pinned, message, signature);

    await this.ensureLoaded();
    if (this.current && verifyWith(this.current.key, message, signature)) return true;
    if (this.documented && verifyWith(this.documented, message, signature)) return true;
    if ((await this.refresh()) && this.current && verifyWith(this.current.key, message, signature)) return true;
    return false;
  }

  /** Best-effort prefetch (called from sync). */
  async warmUp(): Promise<void> {
    if (!this.pinned) await this.ensureLoaded();
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.current) {
      const stored = this.kv.get<StoredPublicKey>(KV_KEYS.publicKey);
      const key = isRecord(stored) ? toPublicKey(str(stored.pem)) : null;
      if (key) this.current = { key, fetchedAt: num(stored?.fetchedAt) ?? 0 };
    }
    if (!this.current || this.now() - this.current.fetchedAt >= PUBLIC_KEY_MAX_AGE_MS) await this.refresh();
  }

  private refresh(): Promise<boolean> {
    if (this.refreshing) return this.refreshing;
    if (this.now() - this.lastRefreshAttempt < PUBLIC_KEY_REFRESH_COOLDOWN_MS) return Promise.resolve(false);
    this.lastRefreshAttempt = this.now();
    this.refreshing = (async () => {
      try {
        const pem = await this.fetchPem();
        const key = toPublicKey(pem);
        if (!key || !pem) throw new Error('public key endpoint returned no usable key');
        this.current = { key, fetchedAt: this.now() };
        this.kv.set(KV_KEYS.publicKey, { pem, fetchedAt: this.now() } satisfies StoredPublicKey);
        return true;
      } catch (err) {
        this.logger.warn({ err: errorMessage(err) }, 'Could not fetch Kick webhook public key; using cached/documented key');
        return false;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }
}

/** Bounded insertion-ordered set used to drop redelivered webhook messages. */
class RecentIds {
  private readonly ids = new Set<string>();

  constructor(private readonly max: number) {}

  /** Returns false when the id was already seen. */
  add(id: string): boolean {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    if (this.ids.size > this.max) {
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
    return true;
  }
}

interface SyncReport {
  at: number;
  tracked: number;
  created: number;
  deleted: number;
  errors: string[];
}

interface KickWebhookDeps {
  api: HttpClient;
  kv: SafeKv;
  now: () => number;
  logger: Logger;
  observeSlug(platformId: string, slug: string | null): void;
  publicKeyPem?: string;
  maxSkewMs: number;
}

class KickWebhookAdapter implements WebhookAdapter {
  readonly path = KICK_WEBHOOK_PATH;
  private readonly keyring: KickKeyring;
  private readonly seen = new RecentIds(WEBHOOK_DEDUPE_SIZE);
  private syncChain: Promise<void> = Promise.resolve();
  lastDeliveryAt: number | null = null;
  lastSync: SyncReport | null = null;
  lastSyncError: string | null = null;

  constructor(private readonly deps: KickWebhookDeps) {
    this.keyring = new KickKeyring(() => this.fetchPublicKey(), deps.kv, deps.now, deps.logger, deps.publicKeyPem);
  }

  async handle(req: WebhookRequest): Promise<WebhookResponse> {
    if (req.method.toUpperCase() !== 'POST') return { status: 200, body: 'ok', contentType: 'text/plain', hints: [] };
    try {
      return await this.handleDelivery(req);
    } catch (err) {
      this.deps.logger.error({ err: errorMessage(err) }, 'Kick webhook handling failed');
      return { status: 500, hints: [] };
    }
  }

  private async handleDelivery(req: WebhookRequest): Promise<WebhookResponse> {
    const messageId = firstHeader(req.headers, 'kick-event-message-id');
    const timestamp = firstHeader(req.headers, 'kick-event-message-timestamp');
    const signature = firstHeader(req.headers, 'kick-event-signature');
    const eventType = firstHeader(req.headers, 'kick-event-type')?.toLowerCase() ?? '';
    if (!messageId || !timestamp || !signature) return this.reject('missing Kick signature headers');

    const signed = Buffer.concat([Buffer.from(`${messageId}.${timestamp}.`, 'utf8'), req.rawBody]);
    if (!(await this.keyring.verify(signed, Buffer.from(signature, 'base64')))) return this.reject('invalid Kick signature');

    // Authentic but stale/duplicate deliveries are acknowledged with 2xx and ignored: answering non-2xx
    // would count as a delivery failure, and Kick unsubscribes apps that keep failing for a day.
    const sentAt = Date.parse(timestamp);
    if (!Number.isFinite(sentAt) || Math.abs(this.deps.now() - sentAt) > this.deps.maxSkewMs) {
      this.deps.logger.warn({ messageId, timestamp, eventType }, 'Ignoring stale Kick webhook delivery');
      return this.ack([]);
    }
    if (!this.seen.add(messageId)) {
      this.deps.logger.debug({ messageId, eventType }, 'Ignoring duplicate Kick webhook delivery');
      return this.ack([]);
    }
    this.lastDeliveryAt = this.deps.now();

    let payload: unknown;
    try {
      payload = JSON.parse(req.rawBody.toString('utf8'));
    } catch {
      this.deps.logger.warn({ messageId, eventType }, 'Kick webhook body is not JSON');
      return this.ack([]);
    }
    const hints = this.toHints(eventType, payload);
    this.deps.logger.debug({ eventType, hints: hints.length }, 'Kick webhook received');
    return this.ack(hints);
  }

  private toHints(eventType: string, payload: unknown): PushHint[] {
    if (!isRecord(payload)) return [];
    const broadcaster = isRecord(payload.broadcaster) ? payload.broadcaster : null;
    const platformId = idString(broadcaster?.user_id);
    if (!platformId) return [];
    this.deps.observeSlug(platformId, str(broadcaster?.channel_slug));

    switch (eventType) {
      case 'livestream.status.updated': {
        const raw = payload.is_live;
        const isLive = typeof raw === 'boolean' ? raw : raw === 'true' || (raw === undefined && !payload.ended_at);
        return [{ type: isLive ? 'live' : 'offline', platform: 'kick', platformId }];
      }
      case 'livestream.metadata.updated':
        return [{ type: 'metadata', platform: 'kick', platformId }];
      default:
        return [];
    }
  }

  private reject(reason: string): WebhookResponse {
    this.deps.logger.warn({ reason }, 'Rejected Kick webhook request');
    return { status: 403, body: 'forbidden', contentType: 'text/plain', hints: [] };
  }

  private ack(hints: PushHint[]): WebhookResponse {
    return { status: 200, body: 'ok', contentType: 'text/plain', hints };
  }

  private async fetchPublicKey(): Promise<string | null> {
    const body = await this.deps.api.getJson<unknown>(`${API_BASE}/public-key`, { retries: 1 });
    const data = isRecord(body) && isRecord(body.data) ? body.data : body;
    return isRecord(data) ? str(data.public_key) : null;
  }

  sync(channels: ChannelRef[]): Promise<void> {
    // Serialise syncs: overlapping runs would both see the same gaps and create duplicate subscriptions.
    const run = this.syncChain.then(() => this.doSync(channels));
    this.syncChain = run.catch((err: unknown) => {
      this.deps.logger.error({ err: errorMessage(err) }, 'Kick subscription sync crashed');
    });
    return this.syncChain;
  }

  private async doSync(channels: ChannelRef[]): Promise<void> {
    const { api, logger } = this.deps;
    await this.keyring.warmUp().catch(() => undefined);

    const desired = new Set<string>();
    for (const channel of channels) {
      if (channel.platform !== 'kick') continue;
      const id = idString(channel.platformId);
      if (id) desired.add(id);
      else logger.warn({ platformId: channel.platformId }, 'Skipping Kick subscription for non-numeric broadcaster id');
    }

    let existing: KickSubscription[];
    try {
      const body = await api.getJson<Envelope<KickSubscription[]>>(`${API_BASE}/events/subscriptions`, { retries: 1 });
      existing = asArray<KickSubscription>(body?.data).filter(isRecord);
    } catch (err) {
      this.lastSyncError = errorMessage(err);
      logger.warn({ err: this.lastSyncError }, 'Could not list Kick event subscriptions');
      return;
    }

    const have = new Map<string, Set<string>>();
    const stale: string[] = [];
    for (const sub of existing) {
      const name = str(sub.event);
      const subId = str(sub.id);
      if (!name || !MANAGED_EVENT_NAMES.has(name) || !subId) continue;
      if (sub.method && sub.method !== 'webhook') continue;
      const broadcaster = idString(sub.broadcaster_user_id);
      const key = eventKey(name, sub.version ?? '');
      const owned = broadcaster ? (have.get(broadcaster) ?? new Set<string>()) : null;
      if (!broadcaster || !owned || !desired.has(broadcaster) || !MANAGED_EVENT_KEYS.has(key) || owned.has(key)) {
        stale.push(subId);
        continue;
      }
      owned.add(key);
      have.set(broadcaster, owned);
    }

    const report: SyncReport = { at: this.deps.now(), tracked: desired.size, created: 0, deleted: 0, errors: [] };
    const missing = [...desired]
      .map((broadcaster) => ({
        broadcaster,
        events: MANAGED_EVENTS.filter((e) => !have.get(broadcaster)?.has(eventKey(e.name, e.version))),
      }))
      .filter((m) => m.events.length > 0);

    await forEachLimit(missing, 4, async ({ broadcaster, events }) => {
      try {
        const res = await api.request<Envelope<KickSubscriptionResult[]>>(`${API_BASE}/events/subscriptions`, {
          method: 'POST',
          body: {
            broadcaster_user_id: Number(broadcaster),
            method: 'webhook',
            events: events.map((e) => ({ name: e.name, version: e.version })),
          },
          retries: 1,
        });
        for (const result of asArray<KickSubscriptionResult>(res.data?.data).filter(isRecord)) {
          if (str(result.error)) {
            report.errors.push(`${broadcaster}/${result.name ?? '?'}: ${result.error}`);
            logger.warn({ broadcaster, event: result.name, error: result.error }, 'Kick refused event subscription');
          } else {
            report.created++;
          }
        }
      } catch (err) {
        report.errors.push(`${broadcaster}: ${errorMessage(err)}`);
        logger.warn({ broadcaster, err: errorMessage(err) }, 'Failed to subscribe to Kick events');
      }
    });

    for (const ids of chunk(stale, CHANNELS_BATCH_SIZE)) {
      try {
        await api.request(`${API_BASE}/events/subscriptions`, { method: 'DELETE', query: { id: ids }, retries: 1 });
        report.deleted += ids.length;
      } catch (err) {
        report.errors.push(`delete: ${errorMessage(err)}`);
        logger.warn({ count: ids.length, err: errorMessage(err) }, 'Failed to delete stale Kick event subscriptions');
      }
    }

    this.lastSync = report;
    this.lastSyncError = null;
    logger.info(
      { tracked: report.tracked, created: report.created, deleted: report.deleted, errors: report.errors.length },
      'Kick event subscriptions synced',
    );
  }
}

// ───────────────────────────── provider ─────────────────────────────

export interface KickProviderOptions {
  /** Pin the webhook verification key instead of fetching it (tests, or operators who want to pin it). */
  publicKeyPem?: string;
  /** Clock override for deterministic tests. */
  now?: () => number;
  /** Minimum gap between unofficial kick.com requests (default 2 s). */
  unofficialMinIntervalMs?: number;
  /** Max accepted difference between a webhook's timestamp and our clock (default 5 min). */
  webhookMaxSkewMs?: number;
}

type Fetched<T> = { status: 'ok'; value: T } | { status: 'skipped'; reason: string } | { status: 'failed'; error: string };

interface VideoListing {
  slug: string;
  videos: KickWebVideo[];
}

export class KickProvider implements PlatformProvider {
  readonly platform = 'kick' as const;
  readonly capabilities: ProviderCapabilities;
  readonly webhook?: WebhookAdapter;

  private readonly config: AppConfig;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly auth: KickAppToken | null;
  private readonly api: HttpClient;
  private readonly web: KickWebClient;
  private readonly breaker: CircuitBreaker;
  private readonly slugs: SlugBook;
  private readonly ledger: StreamLedger;
  private readonly webhookAdapter: KickWebhookAdapter | null = null;
  private readonly videoCache = new Map<string, { at: number; listing: VideoListing }>();
  private readonly warnedIds = new Set<string>();
  private lastLiveOkAt: number | null = null;
  private lastLiveError: string | null = null;
  /** Unofficial kick.com website endpoints (VODs/clips) are opt-in, see KICK_UNOFFICIAL_CONTENT. */
  private readonly unofficialContent: boolean;

  constructor(ctx: ProviderContext, options: KickProviderOptions = {}) {
    this.config = ctx.config;
    this.logger = ctx.logger;
    this.now = options.now ?? Date.now;
    const fetchImpl: FetchLike = ctx.fetch ?? globalThis.fetch.bind(globalThis);
    const kv = new SafeKv(ctx.kv, this.logger);

    const { KICK_CLIENT_ID: clientId, KICK_CLIENT_SECRET: clientSecret } = this.config;
    this.auth =
      clientId && clientSecret
        ? new KickAppToken(clientId, clientSecret, new HttpClient('kick', fetchImpl, API_USER_AGENT), kv, this.now, this.logger)
        : null;
    this.api = new HttpClient('kick', this.authorizedFetch(fetchImpl), API_USER_AGENT);
    this.breaker = new CircuitBreaker(kv, this.now, this.logger);
    this.web = new KickWebClient(fetchImpl, this.breaker, this.now, options.unofficialMinIntervalMs ?? DEFAULT_UNOFFICIAL_GAP_MS);
    this.slugs = new SlugBook(this.logger);
    this.ledger = new StreamLedger(kv, this.now);

    if (this.auth && this.config.webhooksEnabled) {
      this.webhookAdapter = new KickWebhookAdapter({
        api: this.api,
        kv,
        now: this.now,
        logger: this.logger,
        observeSlug: (platformId, slug) => this.slugs.observe(platformId, slug),
        publicKeyPem: options.publicKeyPem,
        maxSkewMs: options.webhookMaxSkewMs ?? DEFAULT_WEBHOOK_MAX_SKEW_MS,
      });
      this.webhook = this.webhookAdapter;
    }

    this.unofficialContent = this.config.KICK_UNOFFICIAL_CONTENT;
    this.capabilities = {
      live: true,
      content: this.unofficialContent ? [...KICK_CONTENT_KINDS] : [],
      liveBatchSize: LIVE_BATCH_SIZE,
      push: this.webhookAdapter !== null,
    };
  }

  isConfigured(): boolean {
    return this.auth !== null;
  }

  health(): ProviderHealth {
    const notes: string[] = [];
    const now = this.now();
    if (!this.auth) {
      notes.push('كيك غير مفعّل: أضف KICK_CLIENT_ID و KICK_CLIENT_SECRET من إعدادات المطوّر في كيك (kick.com/settings/developer).');
      return { configured: false, notes };
    }
    if (this.auth.lastError) notes.push(`تعذّر الحصول على توكن كيك: ${this.auth.lastError}`);
    if (this.lastLiveError) notes.push(`آخر فحص للبث في كيك فشل: ${this.lastLiveError}`);
    else if (this.lastLiveOkAt !== null) notes.push(`آخر فحص ناجح للبث: ${new Date(this.lastLiveOkAt).toISOString()}`);

    const breaker = this.breaker.snapshot();
    if (!this.unofficialContent) {
      notes.push(
        'مقاطع كيك (VOD/كليبات): كيك ما يوفر API رسمي لها، فملخص البث فيه زر صفحة الإعادات. تقدر تفعّل الطريقة غير الرسمية بـ KICK_UNOFFICIAL_CONTENT=true (على مسؤوليتك: شروط كيك تمنع السحب الآلي).',
      );
    } else if (breaker.failures > 0) {
      const retry = breaker.openUntil > now ? ` — المحاولة الجاية بعد ${minutesUntil(breaker.openUntil, now)} دقيقة تقريباً` : ' — جاري إعادة المحاولة';
      notes.push(`محتوى كيك (VOD/كليبات) محجوب حالياً من Cloudflare — البثوث المباشرة شغالة طبيعي${retry}.`);
    }

    if (this.webhookAdapter) {
      notes.push(`الويبهوك: لازم يكون رابط الويبهوك في إعدادات تطبيق كيك (Enable Webhooks) هو ${this.config.PUBLIC_URL}${KICK_WEBHOOK_PATH}`);
      const sync = this.webhookAdapter.lastSync;
      if (this.webhookAdapter.lastSyncError) notes.push(`تعذّرت مزامنة اشتراكات ويبهوك كيك: ${this.webhookAdapter.lastSyncError}`);
      if (sync) {
        notes.push(`اشتراكات ويبهوك كيك: ${sync.tracked} قناة (آخر مزامنة ${new Date(sync.at).toISOString()})`);
        if (sync.errors.length) notes.push(`أخطاء اشتراكات كيك (${sync.errors.length}): ${sync.errors.slice(0, 3).join(' | ')}`);
      }
      if (this.webhookAdapter.lastDeliveryAt !== null) {
        notes.push(`آخر إشعار ويبهوك من كيك: ${new Date(this.webhookAdapter.lastDeliveryAt).toISOString()}`);
      }
    } else {
      notes.push('ويبهوك كيك غير مفعّل (يحتاج PUBLIC_URL بـ https) — كشف البث يعتمد على الفحص الدوري فقط.');
    }
    return { configured: true, notes };
  }

  // ─────────── resolve ───────────

  async resolveChannel(input: string): Promise<ResolvedChannel> {
    this.assertConfigured();
    const { candidates, numericId } = parseKickChannelInput(input);

    let channel = await this.channelBySlugs(candidates);
    if (!channel && numericId) channel = (await this.channelsByIds([numericId]))[0] ?? null;
    if (!channel) throw new ChannelNotFoundError('kick', input.trim());

    const platformId = idString(channel.broadcaster_user_id);
    if (!platformId) throw new ProviderError('kick', 'Channel payload has no broadcaster_user_id', false);
    const slug = str(channel.slug) ?? candidates[0] ?? input.trim();

    let user: KickUser | null = null;
    try {
      const body = await this.api.getJson<Envelope<KickUser[]>>(`${API_BASE}/users`, { query: { id: platformId } });
      user = asArray<KickUser>(body?.data).find((u) => isRecord(u) && idString(u.user_id) === platformId) ?? null;
    } catch (err) {
      // The avatar/display name are cosmetic; resolving must not fail because of them.
      this.logger.warn({ platformId, err: errorMessage(err) }, 'Kick users lookup failed; resolving without avatar');
    }

    this.slugs.observe(platformId, slug);
    return {
      platform: 'kick',
      platformId,
      handle: slug,
      displayName: str(user?.name) ?? slug,
      avatarUrl: str(user?.profile_picture),
      url: channelUrl(slug),
      meta: { slug },
    };
  }

  private async channelBySlugs(candidates: string[]): Promise<KickChannel | null> {
    try {
      return pickBySlug(await this.channelsBySlugs(candidates), candidates);
    } catch (err) {
      // Kick validates every slug param, so one candidate it dislikes (e.g. with "_") fails the whole
      // request. Retry candidates one by one and treat a rejected candidate as "no match".
      if (candidates.length < 2 || !isClientError(err)) throw err;
      for (const candidate of candidates) {
        try {
          const match = pickBySlug(await this.channelsBySlugs([candidate]), [candidate]);
          if (match) return match;
        } catch (candidateErr) {
          if (!isClientError(candidateErr)) throw candidateErr;
        }
      }
      return null;
    }
  }

  private async channelsBySlugs(slugs: string[]): Promise<KickChannel[]> {
    const body = await this.api.getJson<Envelope<KickChannel[]> | null>(`${API_BASE}/channels`, { query: { slug: slugs }, allow404: true });
    return asArray<KickChannel>(body?.data).filter(isRecord);
  }

  private async channelsByIds(ids: string[]): Promise<KickChannel[]> {
    const out: KickChannel[] = [];
    for (const batch of chunk(ids, CHANNELS_BATCH_SIZE)) {
      const body = await this.api.getJson<Envelope<KickChannel[]> | null>(`${API_BASE}/channels`, {
        query: { broadcaster_user_id: batch },
        allow404: true,
      });
      out.push(...asArray<KickChannel>(body?.data).filter(isRecord));
    }
    return out;
  }

  // ─────────── live ───────────

  async checkLive(channels: ChannelRef[]): Promise<LiveSnapshot[]> {
    if (channels.length === 0) return [];
    this.assertConfigured();

    const ids = new Map<ChannelRef, string | null>(channels.map((c) => [c, idString(c.platformId)]));
    for (const [channel, id] of ids) {
      if (id || this.warnedIds.has(channel.platformId)) continue;
      this.warnedIds.add(channel.platformId);
      this.logger.warn({ channelId: channel.id, platformId: channel.platformId }, 'Kick channel has a non-numeric broadcaster id; re-add it');
    }
    const uniqueIds = [...new Set([...ids.values()].filter((id): id is string => id !== null))];

    let live = new Map<string, LiveData>();
    if (uniqueIds.length > 0) {
      try {
        live = await this.liveViaUsersEndpoint(uniqueIds);
      } catch (err) {
        if (err instanceof RateLimitedError || err instanceof ProviderNotConfiguredError) return this.failLive(err);
        this.logger.warn({ err: errorMessage(err) }, 'Kick /users/livestreams failed; falling back to /channels');
        try {
          live = await this.liveViaChannelsEndpoint(uniqueIds);
        } catch (fallbackErr) {
          this.logger.warn({ err: errorMessage(fallbackErr) }, 'Kick /channels fallback failed too');
          return this.failLive(err);
        }
      }
    }
    this.lastLiveOkAt = this.now();
    this.lastLiveError = null;

    return channels.map((channel) => {
      const id = ids.get(channel) ?? null;
      return this.toSnapshot(channel, id ? live.get(id) : undefined);
    });
  }

  private failLive(err: unknown): never {
    this.lastLiveError = errorMessage(err);
    throw err;
  }

  private async liveViaUsersEndpoint(ids: string[]): Promise<Map<string, LiveData>> {
    const live = new Map<string, LiveData>();
    for (const batch of chunk(ids, LIVE_BATCH_SIZE)) {
      const body = await this.api.getJson<Envelope<KickLivestreamV2[]>>(`${API_BASE}/users/livestreams`, { query: { user_id: batch } });
      for (const raw of asArray<KickLivestreamV2>(body?.data)) {
        const data = isRecord(raw) ? fromLivestream(raw) : null;
        if (data) live.set(data.platformId, data);
      }
    }
    return live;
  }

  private async liveViaChannelsEndpoint(ids: string[]): Promise<Map<string, LiveData>> {
    const live = new Map<string, LiveData>();
    for (const channel of await this.channelsByIds(ids)) {
      const platformId = idString(channel.broadcaster_user_id);
      if (!platformId) continue;
      this.slugs.observe(platformId, str(channel.slug));
      const data = fromChannel(platformId, channel);
      if (data) live.set(platformId, data);
    }
    return live;
  }

  private toSnapshot(channel: ChannelRef, data: LiveData | undefined): LiveSnapshot {
    if (data?.slug) this.slugs.observe(channel.platformId, data.slug, channel.handle);
    const url = channelUrl(this.slugFor(channel));
    if (!data) return offlineSnapshot(channel, url);
    return {
      platform: 'kick',
      platformId: channel.platformId,
      isLive: true,
      streamId: this.ledger.stableId(data.platformId, data.officialId, data.startedAt),
      title: data.title,
      category: data.category,
      categoryImageUrl: data.categoryImageUrl,
      thumbnailUrl: cacheBust(data.thumbnailUrl),
      viewers: data.viewers,
      startedAt: toIso(data.startedAt),
      url,
      language: data.language,
      tags: data.tags,
    };
  }

  // ─────────── content (unofficial) ───────────

  async fetchRecentContent(channel: ChannelRef, kinds: ContentKind[]): Promise<ContentItem[]> {
    if (!this.unofficialContent) return [];
    const wanted = KICK_CONTENT_KINDS.filter((k) => kinds.includes(k));
    if (wanted.length === 0) return [];

    const items: ContentItem[] = [];
    const failures: string[] = [];
    for (const kind of wanted) {
      const result = kind === 'vod' ? await this.recentVods(channel) : await this.recentClips(channel);
      if (result.status === 'ok') items.push(...result.value);
      else if (result.status === 'failed') failures.push(`${kind}: ${result.error}`);
      else this.logger.debug({ platformId: channel.platformId, kind, reason: result.reason }, 'Kick content check skipped');
    }
    if (failures.length === wanted.length) {
      throw new ProviderError('kick', `Content check failed for ${this.slugFor(channel)} (${failures.join('; ')})`, true);
    }
    if (failures.length) this.logger.warn({ platformId: channel.platformId, failures }, 'Kick content check partially failed');
    return items.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  }

  async findVodUrl(channel: ChannelRef, streamId: string | null, startedAt: string | null): Promise<string | null> {
    const fallback = `${channelUrl(this.slugFor(channel))}/videos`;
    if (!this.unofficialContent) return fallback;
    try {
      const listing = await this.loadVideos(channel);
      if (listing.status !== 'ok') return fallback;
      const target = parseKickDate(startedAt) ?? (streamId ? this.ledger.find(channel.platformId, streamId)?.startedAt : undefined) ?? null;
      const match = pickVod(listing.value.videos, streamId, target);
      return match ? `${channelUrl(listing.value.slug)}/videos/${match}` : `${channelUrl(listing.value.slug)}/videos`;
    } catch (err) {
      this.logger.debug({ platformId: channel.platformId, err: errorMessage(err) }, 'Kick VOD lookup failed');
      return fallback;
    }
  }

  private async recentVods(channel: ChannelRef): Promise<Fetched<ContentItem[]>> {
    const listing = await this.loadVideos(channel);
    if (listing.status !== 'ok') return listing;
    const { slug, videos } = listing.value;
    const items = videos
      .map((video) => this.mapVod(channel.platformId, slug, video))
      .filter((item): item is ContentItem => item !== null)
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
      .slice(0, MAX_ITEMS_PER_KIND);
    return { status: 'ok', value: items };
  }

  private async recentClips(channel: ChannelRef): Promise<Fetched<ContentItem[]>> {
    const res = await this.webGetForChannel(channel, (slug) => `/api/v2/channels/${encodeURIComponent(slug)}/clips?sort=date&time=all`);
    if (res.status !== 'ok') return res;
    const { slug, data } = res.value;
    const raw = isRecord(data) ? (data.clips ?? data.data) : data;
    const items = asArray<KickWebClip>(raw)
      .filter(isRecord)
      .map((clip) => mapClip(channel.platformId, slug, clip))
      .filter((item): item is ContentItem => item !== null)
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
      .slice(0, MAX_ITEMS_PER_KIND);
    return { status: 'ok', value: items };
  }

  private async loadVideos(channel: ChannelRef): Promise<Fetched<VideoListing>> {
    const cached = this.videoCache.get(channel.platformId);
    if (cached && this.now() - cached.at < VIDEO_CACHE_TTL_MS) return { status: 'ok', value: cached.listing };

    const res = await this.webGetForChannel(channel, (slug) => `/api/v2/channels/${encodeURIComponent(slug)}/videos`);
    if (res.status !== 'ok') return res;
    const { slug, data } = res.value;
    const listing: VideoListing = {
      slug,
      videos: asArray<KickWebVideo>(isRecord(data) ? data.data : data).filter(isRecord),
    };
    this.videoCache.set(channel.platformId, { at: this.now(), listing });
    return { status: 'ok', value: listing };
  }

  /** GET a website endpoint for a channel; on 404 the slug may have been renamed, so re-resolve it once by id. */
  private async webGetForChannel(channel: ChannelRef, path: (slug: string) => string): Promise<Fetched<{ slug: string; data: unknown }>> {
    let slug = this.slugFor(channel);
    let res = await this.web.getJson(path(slug), slug);
    if (res.kind === 'not_found') {
      const fresh = await this.refreshSlug(channel);
      if (fresh && fresh.toLowerCase() !== slug.toLowerCase()) {
        slug = fresh;
        res = await this.web.getJson(path(slug), slug);
      }
    }
    switch (res.kind) {
      case 'ok':
        return { status: 'ok', value: { slug, data: res.data } };
      case 'not_found':
        return { status: 'skipped', reason: `kick.com/${slug} not found` };
      case 'blocked':
      case 'unavailable':
        return { status: 'skipped', reason: res.detail };
      case 'error':
        return { status: 'failed', error: res.detail };
    }
  }

  private async refreshSlug(channel: ChannelRef): Promise<string | null> {
    const id = idString(channel.platformId);
    if (!id || !this.auth) return null;
    try {
      const [found] = await this.channelsByIds([id]);
      const slug = str(found?.slug);
      if (slug) this.slugs.observe(channel.platformId, slug, channel.handle);
      return slug;
    } catch (err) {
      this.logger.debug({ platformId: id, err: errorMessage(err) }, 'Kick slug refresh failed');
      return null;
    }
  }

  private mapVod(platformId: string, slug: string, video: KickWebVideo): ContentItem | null {
    const uuid = str(video.video?.uuid);
    // A video entry exists while the broadcast is still running; it's only "new content" once the stream ends.
    if (!uuid || video.is_live === true) return null;
    const startedAt = parseKickDate(video.start_time) ?? parseKickDate(video.created_at) ?? parseKickDate(video.video?.created_at);
    if (startedAt === null) return null;
    const durationMs = num(video.duration);
    const linked = this.ledger.closestByStart(platformId, startedAt, VOD_MATCH_TOLERANCE_MS);
    return {
      platform: 'kick',
      platformId,
      contentId: uuid,
      kind: 'vod',
      title: str(video.session_title) ?? `تسجيل بث ${slug}`,
      url: `${channelUrl(slug)}/videos/${vodPathId(video) ?? uuid}`,
      thumbnailUrl: imageUrl(video.thumbnail),
      // Published when the recording is complete, i.e. when the broadcast ended.
      publishedAt: new Date(startedAt + (durationMs && durationMs > 0 ? durationMs : 0)).toISOString(),
      durationSec: durationMs && durationMs > 0 ? Math.round(durationMs / 1000) : null,
      viewCount: num(video.views) ?? num(video.video?.views),
      relatedStreamId: linked?.streamId ?? idString(video.video?.live_stream_id) ?? idString(video.id),
    };
  }

  // ─────────── misc ───────────

  private slugFor(channel: ChannelRef): string {
    return this.slugs.get(channel.platformId) ?? str(channel.meta.slug) ?? channel.handle;
  }

  private assertConfigured(): void {
    if (!this.auth) throw new ProviderNotConfiguredError('kick', 'KICK_CLIENT_ID / KICK_CLIENT_SECRET are not set');
  }

  /**
   * fetch wrapper for api.kick.com used underneath HttpClient: injects the bearer token, refreshes it once on
   * 401, and turns the edge WAF's transient "blocked by security policy" 403 into a retryable error.
   */
  private authorizedFetch(fetchImpl: FetchLike): FetchLike {
    return async (input, init) => {
      const auth = this.auth;
      if (!auth) throw new ProviderNotConfiguredError('kick');
      const withToken = (token: string): RequestInit => ({
        ...init,
        headers: { ...(init?.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` },
      });

      const token = await auth.get();
      let res = await fetchImpl(input, withToken(token));
      if (res.status === 401) {
        await res.body?.cancel().catch(() => undefined);
        auth.invalidate(token);
        res = await fetchImpl(input, withToken(await auth.get()));
        if (res.status === 401) {
          auth.lastError = 'Kick rejected a freshly issued app token (401)';
          throw new ProviderNotConfiguredError('kick', auth.lastError);
        }
      }
      if (res.status === 403) {
        const text = await res
          .clone()
          .text()
          .catch(() => '');
        if (/security policy|just a moment|cloudflare/i.test(text)) {
          throw new ProviderError('kick', 'api.kick.com edge blocked the request (403 security policy)', true);
        }
      }
      return res;
    };
  }
}

// ───────────────────────────── mapping ─────────────────────────────

/** A definitive 4xx answer (bad input), as opposed to transport, auth or rate-limit failures. */
function isClientError(err: unknown): boolean {
  return err instanceof ProviderError && !err.retryable && !(err instanceof ProviderNotConfiguredError);
}

function pickBySlug(found: KickChannel[], candidates: string[]): KickChannel | null {
  for (const candidate of candidates) {
    const match = found.find((c) => str(c.slug)?.toLowerCase() === candidate);
    if (match) return match;
  }
  return found[0] ?? null;
}

function fromLivestream(raw: KickLivestreamV2): LiveData | null {
  const platformId = idString(raw.broadcaster_user?.id) ?? idString(raw.broadcaster_user_id);
  if (!platformId) return null;
  return {
    platformId,
    officialId: idString(raw.id) ?? str(raw.id),
    slug: str(raw.channel?.slug) ?? str(raw.slug),
    title: str(raw.title),
    category: str(raw.category?.name),
    categoryImageUrl: str(raw.category?.thumbnail),
    thumbnailUrl: liveThumbnail(raw.thumbnail),
    viewers: num(raw.viewer_count),
    startedAt: parseKickDate(raw.started_at),
    language: str(raw.language_code),
    tags: stringList(raw.tags),
  };
}

function fromChannel(platformId: string, channel: KickChannel): LiveData | null {
  const stream = channel.stream;
  if (!isRecord(stream) || stream.is_live !== true) return null;
  return {
    platformId,
    officialId: null,
    slug: str(channel.slug),
    title: str(channel.stream_title),
    category: str(channel.category?.name),
    categoryImageUrl: str(channel.category?.thumbnail),
    thumbnailUrl: liveThumbnail(stream.thumbnail),
    viewers: num(stream.viewer_count),
    startedAt: parseKickDate(stream.start_time),
    language: str(stream.language),
    tags: stringList(stream.custom_tags),
  };
}

function mapClip(platformId: string, fallbackSlug: string, clip: KickWebClip): ContentItem | null {
  const id = str(clip.id);
  const createdAt = parseKickDate(clip.created_at);
  if (!id || createdAt === null) return null;
  const slug = str(clip.channel?.slug) ?? fallbackSlug;
  const duration = num(clip.duration);
  return {
    platform: 'kick',
    platformId,
    contentId: id,
    kind: 'clip',
    title: str(clip.title) ?? 'كليب جديد',
    url: `${channelUrl(slug)}/clips/${encodeURIComponent(id)}`,
    thumbnailUrl: str(clip.thumbnail_url),
    publishedAt: new Date(createdAt).toISOString(),
    durationSec: duration !== null && duration > 0 ? Math.round(duration) : null,
    viewCount: num(clip.view_count) ?? num(clip.views),
  };
}

/** The id used in public VOD URLs: vod_id when Kick provides it, else the video uuid. */
function vodPathId(video: KickWebVideo): string | null {
  return str(video.vod_id) ?? str(video.video?.vod_id) ?? str(video.video?.uuid);
}

/** Picks the VOD URL id of a stream: by livestream id when it matches, else by the closest start time. */
function pickVod(videos: KickWebVideo[], streamId: string | null, startedAt: number | null): string | null {
  if (streamId) {
    const byId = videos.find((v) => idString(v.video?.live_stream_id) === streamId || idString(v.id) === streamId);
    const id = byId ? vodPathId(byId) : null;
    if (id) return id;
  }
  if (startedAt === null) return null;
  let best: { id: string; delta: number } | null = null;
  for (const video of videos) {
    const id = vodPathId(video);
    const start = parseKickDate(video.start_time) ?? parseKickDate(video.created_at);
    if (!id || start === null) continue;
    const delta = Math.abs(start - startedAt);
    if (delta <= VOD_MATCH_TOLERANCE_MS && (!best || delta < best.delta)) best = { id, delta };
  }
  return best?.id ?? null;
}

export const createKickProvider: ProviderFactory = (ctx) => new KickProvider(ctx);
