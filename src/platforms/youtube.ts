/**
 * YouTube provider: Data API v3 (API key) for classification, free RSS/WebSub for discovery.
 *
 * Quota (10k units/day, reset at Pacific midnight) is the scarce resource, so the API is never polled per
 * channel to find videos:
 *  - Discovery: each channel's RSS feed (free, ~every 110 s, staggered) is diffed against known ids; WebSub
 *    pushes add ids instantly; the uploads (UU) playlist is the fallback when RSS breaks (≤ every 15 min)
 *    and a 30-min reconciliation pass.
 *  - Classification: new ids → ONE batched videos.list (≤ 50 ids = 1 unit).
 *  - Live: a persistent per-channel candidate set of upcoming/live ids, re-checked with batched videos.list
 *    on a schedule that depends on how close the stream is to starting.
 *  - Content: classified uploads are cached per channel; Shorts are confirmed via the UUSH playlist only
 *    when the free signals (RSS /shorts/ link, duration, player aspect ratio) are not decisive.
 */
import { createHash } from 'node:crypto';
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
import type {
  KeyValueStore,
  PlatformProvider,
  ProviderCapabilities,
  ProviderContext,
  ProviderFactory,
  ProviderHealth,
} from './types.js';
import {
  type FeedEntry,
  isYouTubeChannelId,
  isYouTubeVideoId,
  normalizeTimestamp,
  type ParsedFeed,
  parseYouTubeFeed,
  YOUTUBE_WEBSUB_PATH,
  YouTubeWebSubAdapter,
} from './youtube-websub.js';

const API_BASE = 'https://www.googleapis.com/youtube/v3';
const RSS_URL = 'https://www.youtube.com/feeds/videos.xml';
const WEB_BASE = 'https://www.youtube.com';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const MAX_IDS_PER_CALL = 50;
const VIDEO_PARTS = 'snippet,contentDetails,liveStreamingDetails,statistics,player';
/** With maxWidth/maxHeight set, player.embedWidth/embedHeight reveal the video's aspect ratio (free Shorts signal). */
const PLAYER_BOX = 1280;

// Quota
const DEFAULT_DAILY_QUOTA = 10_000;
/** Above this share of the daily quota only essential calls run (9000 of 10k). */
const SOFT_LIMIT_RATIO = 0.9;
/** Above this share background intervals are stretched. */
const CONSERVE_RATIO = 0.75;
/** search.list has its own 100/day bucket since 2026-06; keep a reserve for manual retries. */
const SEARCH_DAILY_BUDGET = 90;
const KEY_PROBLEM_COOLDOWN_MS = 10 * MINUTE;
const API_RATE_LIMIT_BACKOFF_MS = MINUTE;

// Discovery
const RSS_MIN_INTERVAL_MS = 95 * SECOND;
/** Per-channel deterministic jitter on top of the minimum (95-110 s) so feeds are not fetched in lockstep. */
const RSS_JITTER_MS = 15 * SECOND;
const RSS_BACKOFF_MAX_MS = 5 * MINUTE;
const RSS_TIMEOUT_MS = 10 * SECOND;
const RSS_CONCURRENCY = 4;
/** Discovery for one batch never holds a live check longer than this (slow/timeouting RSS during outages). */
const DISCOVERY_BUDGET_MS = 30 * SECOND;
const UU_FALLBACK_INTERVAL_MS = 15 * MINUTE;
const RECONCILE_INTERVAL_MS = 30 * MINUTE;
const UU_PAGE_SIZE = 20;

// Live tracking
const LIVE_RECHECK_MS: Record<'normal' | 'conserve' | 'critical', number> = { normal: 45 * SECOND, conserve: 90 * SECOND, critical: 150 * SECOND };
/** Upcoming streams are checked on every poll from 15 min before their schedule... */
const UPCOMING_DUE_WINDOW_MS = 15 * MINUTE;
/** ...until 1 h after it (streams start late); later they fall back to the slow schedule. */
const UPCOMING_OVERDUE_MS = HOUR;
const UPCOMING_SLOW_RECHECK_MS = 15 * MINUTE;
const UPCOMING_UNSCHEDULED_RECHECK_MS = 5 * MINUTE;
/** Scheduled streams that never started are dropped after this long. */
const UPCOMING_DROP_AFTER_MS = 7 * DAY;

// Content
/** Ids the API does not return yet are retried with backoff (2, 4, 8, 16, 32 min ≈ 1 h) before being dropped. */
const PENDING_MAX_ATTEMPTS = 6;
const SEEN_CAP = 300;
const ITEMS_CAP = 30;
const RECENT_ITEMS = 15;
const ENDED_CAP = 10;
const SHORT_MAX_SEC = 180;
const LEGACY_SHORT_MAX_SEC = 60;
/** Shorts may be up to 3 minutes long since this date (60 s before). */
const SHORTS_3MIN_SINCE = Date.parse('2024-10-15T00:00:00Z');
/** UUSH may lag for a brand-new Short: a negative answer for a fresh upload is re-checked once. */
const SHORT_RECHECK_DELAY_MS = 3 * MINUTE;
const SHORT_RECHECK_FRESH_MS = 15 * MINUTE;
/** Hard cap on how long an item can be held back for verification. */
const VERIFY_HOLD_MAX_MS = 10 * MINUTE;
/** Ended broadcasts first seen after they ended get a Premiere check only when this recent. */
const PREMIERE_CHECK_MAX_AGE_MS = DAY;

const CATEGORY_TTL_MS = 7 * DAY;
const CATEGORY_RETRY_MS = HOUR;
const CATEGORY_FAILURE_RETRY_MS = 5 * MINUTE;
const VIDEO_CACHE_MAX = 1_000;
const CHANNEL_STATE_TTL_MS = 30 * DAY;
const INDEX_WRITE_INTERVAL_MS = HOUR;

const KV_KEYS = {
  quota: 'youtube:quota',
  categories: 'youtube:categories',
  channelIndex: 'youtube:channels',
  channel: (channelId: string) => `youtube:ch:${channelId}`,
};

const UPLOADS_PLAYLIST_RE = /^UU[\w-]{22}$/;
const CHANNEL_ID_RE = /^UC[\w-]{22}$/;
const SUPPORTED_KINDS = ['video', 'short', 'vod'] as const satisfies readonly ContentKind[];
type YouTubeKind = (typeof SUPPORTED_KINDS)[number];

const QUOTA_REASONS = new Set(['quotaExceeded', 'dailyLimitExceeded', 'dailyLimitExceededUnreg', 'RATE_LIMIT_EXCEEDED_DAILY']);
const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'RATE_LIMIT_EXCEEDED']);
const KEY_REASONS = new Set([
  'keyInvalid',
  'keyExpired',
  'API_KEY_INVALID',
  'API_KEY_EXPIRED',
  'accessNotConfigured',
  'SERVICE_DISABLED',
  'ipRefererBlocked',
  'API_KEY_IP_ADDRESS_BLOCKED',
  'API_KEY_HTTP_REFERRER_BLOCKED',
  'API_KEY_SERVICE_BLOCKED',
  'API_KEY_ANDROID_APP_BLOCKED',
  'API_KEY_IOS_APP_BLOCKED',
  'unauthorized',
  'authError',
  'CONSUMER_INVALID',
]);
const NOT_FOUND_REASONS = new Set(['notFound', 'playlistNotFound', 'videoNotFound', 'channelNotFound', 'playlistItemsNotAccessible']);

// ───────────────────────────── API payloads ─────────────────────────────

interface ApiThumb {
  url?: string;
  width?: number;
  height?: number;
}

type ApiThumbs = Partial<Record<'default' | 'medium' | 'high' | 'standard' | 'maxres', ApiThumb>>;

export interface ApiVideo {
  id: string;
  snippet?: {
    publishedAt?: string;
    channelId?: string;
    title?: string;
    thumbnails?: ApiThumbs;
    tags?: string[];
    categoryId?: string;
    liveBroadcastContent?: string;
    defaultLanguage?: string;
    defaultAudioLanguage?: string;
  };
  contentDetails?: { duration?: string };
  liveStreamingDetails?: {
    actualStartTime?: string;
    actualEndTime?: string;
    scheduledStartTime?: string;
    scheduledEndTime?: string;
    concurrentViewers?: string | number;
  };
  statistics?: { viewCount?: string | number };
  player?: { embedWidth?: string | number; embedHeight?: string | number };
}

interface ApiChannel {
  id: string;
  snippet?: { title?: string; customUrl?: string; thumbnails?: ApiThumbs };
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
}

interface ApiPlaylistItem {
  id?: string;
  contentDetails?: { videoId?: string; videoPublishedAt?: string };
}

interface ApiSearchResult {
  id?: { kind?: string; channelId?: string };
  snippet?: { title?: string; channelTitle?: string; channelId?: string };
}

interface ApiCategory {
  id?: string;
  snippet?: { title?: string };
}

interface ApiList<T> {
  items?: T[];
}

interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: Array<{ reason?: string; message?: string; domain?: string }>;
    details?: Array<{ '@type'?: string; reason?: string }>;
  };
}

// ───────────────────────────── errors ─────────────────────────────

/** A 4xx from the Data API with Google's machine-readable reason (quotaExceeded, keyInvalid, playlistNotFound...). */
export class YouTubeApiError extends ProviderError {
  /** Primary reason (first of `reasons`). */
  readonly reason: string;

  constructor(
    readonly status: number,
    /** Every reason Google reported (errors[].reason, details[].reason, status), e.g. ["badRequest", "API_KEY_INVALID"]. */
    readonly reasons: string[],
    detail: string,
    path: string,
  ) {
    const reason = reasons[0] ?? `http${status}`;
    super('youtube', `HTTP ${status} (${reasons.join(', ') || reason}) from ${path}: ${detail.slice(0, 200)}`, false);
    this.name = 'YouTubeApiError';
    this.reason = reason;
  }

  hasReason(set: ReadonlySet<string>): boolean {
    return this.reasons.some((r) => set.has(r));
  }
}

/** The daily Data API quota is used up; no API call is made until `until` (next Pacific midnight). */
export class QuotaExhaustedError extends ProviderError {
  constructor(readonly until: number) {
    super('youtube', `Data API quota exhausted until ${new Date(until).toISOString()}`, true);
    this.name = 'QuotaExhaustedError';
  }
}

/** A non-essential call was skipped to protect the remaining quota. */
class QuotaDeferredError extends ProviderError {
  constructor() {
    super('youtube', 'Skipped a non-essential API call to save quota', true);
    this.name = 'QuotaDeferredError';
  }
}

function parseGoogleError(text: string): { reasons: string[]; message: string } {
  let body: GoogleErrorBody | null = null;
  try {
    body = text ? (JSON.parse(text) as GoogleErrorBody) : null;
  } catch {
    body = null;
  }
  const error = body?.error;
  const reasons = [...(error?.errors ?? []).map((e) => e.reason), ...(error?.details ?? []).map((d) => d.reason), error?.status].filter(
    (r): r is string => typeof r === 'string' && r !== '',
  );
  return { reasons: unique(reasons), message: error?.message ?? text.slice(0, 200) };
}

/** Turns Data API 4xx responses into YouTubeApiError before HttpClient flattens them into a generic error. */
function googleApiFetch(base: FetchLike): FetchLike {
  return async (input, init) => {
    const res = await base(input, init);
    if (res.status < 400 || res.status >= 500 || res.status === 429) return res;
    const text = await res.text().catch(() => '');
    const { reasons, message } = parseGoogleError(text);
    const url = input instanceof Request ? input.url : String(input);
    throw new YouTubeApiError(res.status, reasons, message, new URL(url).pathname);
  };
}

// ───────────────────────────── small helpers ─────────────────────────────

const unique = <T>(items: readonly T[]) => [...new Set(items)];
const timeOf = (iso: string | null | undefined) => (iso ? Date.parse(iso) : Number.NaN);
const watchUrl = (videoId: string) => `${WEB_BASE}/watch?v=${videoId}`;
const channelUrl = (channelId: string) => `${WEB_BASE}/channel/${channelId}`;
const channelSuffix = (channelId: string) => channelId.slice(2);

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Stable small hash used for deterministic per-channel staggering. */
function hashOf(value: string): number {
  return createHash('sha1').update(value).digest().readUInt32BE(0);
}

function toNumber(value: string | number | undefined | null): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Parses ISO 8601 durations as used by YouTube ("PT1H2M3S", "P1DT2H", "P0D") into seconds. */
export function parseIsoDuration(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value.trim());
  if (!m || value.trim() === 'P' || value.trim().endsWith('T')) return null;
  const [, w, d, h, min, s] = m;
  return Number(w ?? 0) * 604_800 + Number(d ?? 0) * 86_400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Math.round(Number(s ?? 0));
}

function bestThumbnail(thumbs: ApiThumbs | undefined, order: Array<keyof ApiThumbs>): string | null {
  for (const key of order) {
    const url = thumbs?.[key]?.url;
    if (url) return url;
  }
  return null;
}

async function forEachLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

// ───────────────────────────── Pacific time ─────────────────────────────

const PACIFIC_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function pacificParts(ms: number): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const parts: Record<string, number> = {};
  for (const p of PACIFIC_FORMAT.formatToParts(new Date(ms))) if (p.type !== 'literal') parts[p.type] = Number(p.value);
  return { y: parts.year ?? 1970, mo: parts.month ?? 1, d: parts.day ?? 1, h: parts.hour ?? 0, mi: parts.minute ?? 0, s: parts.second ?? 0 };
}

/** Quota day (YYYY-MM-DD in America/Los_Angeles), the unit Google resets the Data API quota on. */
export function pacificDay(ms: number): string {
  const p = pacificParts(ms);
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** Pacific wall-clock time minus UTC at `ms` (-7 h or -8 h). */
function pacificOffset(ms: number): number {
  const p = pacificParts(ms);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/** Epoch ms of the next midnight in America/Los_Angeles (DST-safe). */
export function nextPacificMidnight(ms: number): number {
  const p = pacificParts(ms);
  const wallMidnight = Date.UTC(p.y, p.mo - 1, p.d + 1);
  // The offset at midnight can differ from the current one on DST days; one refinement step settles it.
  const guess = wallMidnight - pacificOffset(ms);
  return wallMidnight - pacificOffset(guess);
}

// ───────────────────────────── input parsing ─────────────────────────────

export type YouTubeTarget =
  | { kind: 'id'; id: string }
  /** Explicit "@handle". */
  | { kind: 'handle'; handle: string }
  /** youtube.com/user/<name> (legacy username). */
  | { kind: 'username'; username: string }
  /** youtube.com/c/<name> or youtube.com/<name> (legacy custom URL). */
  | { kind: 'custom'; name: string }
  /** A bare word: tried as a handle, then as a legacy username. */
  | { kind: 'name'; name: string }
  /** A video/short/live URL: resolves to the channel that owns it. */
  | { kind: 'video'; id: string };

const MSG_EMPTY = 'اكتب معرّف قناة YouTube أو رابطها، مثل ‎@name أو https://www.youtube.com/@name';
const MSG_INVALID = 'صيغة قناة YouTube غير صحيحة. أمثلة صحيحة: ‎@name أو https://www.youtube.com/@name أو https://www.youtube.com/channel/UC...';
const MSG_NOT_YOUTUBE_URL = 'هذا الرابط مو رابط قناة YouTube. مثال صحيح: https://www.youtube.com/@name';

/** Handles are 3-30 chars of letters (any script), digits, "_", "-", "." and "·"; legacy names are looser. */
const NAME_RE = /^[\p{L}\p{M}\p{N}_.\-·]{1,100}$/u;
const YOUTUBE_HOST_RE = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:youtube\.com|youtu\.be|youtube-nocookie\.com)(?:[/?#:]|$)/i;
const VIDEO_PATHS = new Set(['shorts', 'live', 'embed', 'v', 'e']);
/** First path segments on youtube.com that are pages, not channels. */
const RESERVED_PATHS = new Set([
  'about', 'account', 'ads', 'creators', 'feed', 'gaming', 'hashtag', 'howyoutubeworks', 'kids', 'logout', 'music',
  'new', 'post', 'premium', 'redirect', 'reporthistory', 'results', 'signin', 'source', 't', 'upload', 'watch', 'yt',
]);

function nameOrThrow(value: string | undefined): string {
  if (value && NAME_RE.test(value)) return value;
  throw new ValidationError(MSG_INVALID, 'input');
}

function videoOrThrow(value: string | null | undefined): YouTubeTarget {
  if (isYouTubeVideoId(value)) return { kind: 'video', id: value };
  throw new ValidationError(MSG_NOT_YOUTUBE_URL, 'input');
}

/** Channel id behind an uploads-style playlist id (UU…, UULF…, UUSH…). */
function channelIdFromPlaylist(list: string | null): string | null {
  if (!list) return null;
  const suffix = list.length === 24 && list.startsWith('UU') ? list.slice(2) : list.length === 26 && /^UU[A-Z]{2}/.test(list) ? list.slice(4) : null;
  const id = suffix ? `UC${suffix}` : null;
  return isYouTubeChannelId(id) ? id : null;
}

function parseYouTubeUrl(input: string): YouTubeTarget {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new ValidationError(MSG_NOT_YOUTUBE_URL, 'input');
  }
  const host = url.hostname.toLowerCase().replace(/^(?:www|m|music|studio|gaming)\./, '');
  const segments = url.pathname.split('/').filter(Boolean).map(safeDecode);
  const [first, second] = segments;

  if (host === 'youtu.be') return videoOrThrow(first);
  if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') throw new ValidationError(MSG_NOT_YOUTUBE_URL, 'input');
  if (!first) throw new ValidationError(MSG_NOT_YOUTUBE_URL, 'input');
  if (first.startsWith('@')) return { kind: 'handle', handle: nameOrThrow(first.slice(1)) };

  const head = first.toLowerCase();
  if (head === 'channel') {
    if (isYouTubeChannelId(second)) return { kind: 'id', id: second };
    throw new ValidationError(MSG_INVALID, 'input');
  }
  if (head === 'user') return { kind: 'username', username: nameOrThrow(second) };
  if (head === 'c') return { kind: 'custom', name: nameOrThrow(second) };
  if (head === 'watch') return videoOrThrow(url.searchParams.get('v'));
  if (VIDEO_PATHS.has(head)) return videoOrThrow(second);
  if (head === 'playlist') {
    const id = channelIdFromPlaylist(url.searchParams.get('list'));
    if (id) return { kind: 'id', id };
    throw new ValidationError(MSG_NOT_YOUTUBE_URL, 'input');
  }
  if (RESERVED_PATHS.has(head)) throw new ValidationError(MSG_NOT_YOUTUBE_URL, 'input');
  // youtube.com/<name>: a legacy vanity URL.
  return { kind: 'custom', name: nameOrThrow(first) };
}

/**
 * Parses admin input: "@handle", "UC…" ids, bare names, and channel/video URLs (youtube.com/@handle,
 * /channel/UC…, /user/…, /c/…, /<vanity>, watch/shorts/live/youtu.be links, uploads playlists).
 * Throws ValidationError (Arabic).
 */
export function parseYouTubeInput(raw: string): YouTubeTarget {
  // Discord users often paste links wrapped in <> to suppress embeds.
  const input = raw.trim().replace(/^<(.+)>$/s, '$1').trim();
  if (!input) throw new ValidationError(MSG_EMPTY, 'input');
  if (CHANNEL_ID_RE.test(input)) return { kind: 'id', id: input };
  if (YOUTUBE_HOST_RE.test(input)) return parseYouTubeUrl(input);
  if (input.startsWith('@')) return { kind: 'handle', handle: nameOrThrow(safeDecode(input.slice(1))) };
  if (/[/:?#\s]/.test(input)) throw new ValidationError(MSG_NOT_YOUTUBE_URL, 'input');
  return { kind: 'name', name: nameOrThrow(input) };
}

// ───────────────────────────── classification ─────────────────────────────

export type VideoClass =
  | { type: 'upcoming'; premiere: boolean; scheduledStartTime: string | null }
  | { type: 'live'; premiere: boolean; actualStartTime: string }
  /** A finished broadcast (live stream VOD or a Premiere that already played). */
  | { type: 'ended'; actualStartTime: string | null; actualEndTime: string | null }
  /** A regular upload (video or Short). */
  | { type: 'upload' };

/**
 * Classifies a videos.list resource. Premieres look like streams (liveBroadcastContent upcoming/live) but
 * carry the real length of the uploaded file, while real live streams report P0D until they end.
 */
export function classifyVideo(video: ApiVideo): VideoClass {
  const lbc = video.snippet?.liveBroadcastContent ?? 'none';
  const live = video.liveStreamingDetails;
  const duration = parseIsoDuration(video.contentDetails?.duration);
  const premiere = !!live && duration !== null && duration > 0;
  const ended = (): VideoClass => ({ type: 'ended', actualStartTime: live?.actualStartTime ?? null, actualEndTime: live?.actualEndTime ?? null });

  if (lbc === 'upcoming') return { type: 'upcoming', premiere, scheduledStartTime: live?.scheduledStartTime ?? null };
  if (lbc === 'live') {
    if (live?.actualEndTime) return ended();
    if (live?.actualStartTime) return { type: 'live', premiere, actualStartTime: live.actualStartTime };
    return { type: 'upcoming', premiere, scheduledStartTime: live?.scheduledStartTime ?? null };
  }
  if (live && (live.actualEndTime || live.actualStartTime)) return ended();
  return { type: 'upload' };
}

/** width / height of the player when YouTube knows the aspect ratio. */
function aspectOf(video: ApiVideo): number | null {
  const w = toNumber(video.player?.embedWidth);
  const h = toNumber(video.player?.embedHeight);
  return w && h ? w / h : null;
}

export interface ShortSignals {
  durationSec: number | null;
  publishedAt: string | null;
  /** true: the RSS link was /shorts/, false: it was /watch, null: no RSS link seen. */
  shortLink: boolean | null;
  aspect: number | null;
}

const isHorizontal = (aspect: number | null) => aspect !== null && aspect > 1.05;

/** 'check' means the free signals are not decisive and the UUSH playlist should be asked. */
function initialShortVerdict(s: ShortSignals): 'short' | 'video' | 'check' {
  if (s.shortLink === true) return 'short';
  if (s.durationSec === null || s.durationSec > SHORT_MAX_SEC) return 'video';
  // Shorts are vertical or square; a horizontal upload is a regular video whatever its length.
  if (isHorizontal(s.aspect)) return 'video';
  return 'check';
}

/** Best guess without the UUSH playlist. */
export function heuristicIsShort(s: ShortSignals): boolean {
  if (s.shortLink !== null) return s.shortLink;
  if (s.durationSec === null) return false;
  const limit = timeOf(s.publishedAt) >= SHORTS_3MIN_SINCE ? SHORT_MAX_SEC : LEGACY_SHORT_MAX_SEC;
  if (s.durationSec > limit) return false;
  return !isHorizontal(s.aspect);
}

function shortLinkOf(link: string | null): boolean | null {
  if (!link) return null;
  if (/\/shorts\//i.test(link)) return true;
  return /\/watch\?/i.test(link) ? false : null;
}

// ───────────────────────────── persistence ─────────────────────────────

/** kv access that never throws: persistence is an optimisation, never a reason to fail a check. */
class SafeKv implements KeyValueStore {
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

// ───────────────────────────── quota ─────────────────────────────

export type QuotaLevel = 'normal' | 'conserve' | 'critical' | 'exhausted';
type Priority = 'essential' | 'background';

interface StoredQuota {
  day: string;
  used: number;
  /** search.list calls (separate bucket). */
  search: number;
  exhaustedUntil: number | null;
}

/** Counts Data API units per Pacific day in kv ('youtube:quota') and tracks quotaExceeded lockouts. */
class QuotaTracker {
  private state: StoredQuota | null = null;

  constructor(
    private readonly kv: SafeKv,
    private readonly now: () => number,
    readonly dailyLimit: number,
    private readonly logger: Logger,
  ) {}

  get used(): number {
    return this.current().used;
  }

  get softLimit(): number {
    return Math.floor(this.dailyLimit * SOFT_LIMIT_RATIO);
  }

  exhaustedUntil(): number | null {
    const s = this.current();
    return s.exhaustedUntil !== null && s.exhaustedUntil > this.now() ? s.exhaustedUntil : null;
  }

  level(): QuotaLevel {
    if (this.exhaustedUntil() !== null) return 'exhausted';
    const used = this.current().used;
    if (used > this.softLimit) return 'critical';
    if (used > this.dailyLimit * CONSERVE_RATIO) return 'conserve';
    return 'normal';
  }

  allows(priority: Priority): boolean {
    const level = this.level();
    if (level === 'exhausted') return false;
    return priority === 'essential' || level !== 'critical';
  }

  canSearch(): boolean {
    return this.current().search < SEARCH_DAILY_BUDGET;
  }

  charge(units: number, bucket: 'units' | 'search'): void {
    const s = this.current();
    if (bucket === 'search') s.search += units;
    else s.used += units;
    this.persist();
  }

  markExhausted(bucket: 'units' | 'search'): number {
    const s = this.current();
    const until = nextPacificMidnight(this.now());
    if (bucket === 'search') {
      s.search = Math.max(s.search, SEARCH_DAILY_BUDGET);
    } else if (s.exhaustedUntil !== until) {
      s.exhaustedUntil = until;
      this.logger.error({ used: s.used, until: new Date(until).toISOString() }, 'YouTube Data API quota exhausted; API calls paused until Pacific midnight');
    }
    this.persist();
    return until;
  }

  private current(): StoredQuota {
    const day = pacificDay(this.now());
    if (!this.state) {
      const stored = this.kv.get<Partial<StoredQuota>>(KV_KEYS.quota);
      this.state = {
        day: typeof stored?.day === 'string' ? stored.day : day,
        used: typeof stored?.used === 'number' && stored.used >= 0 ? stored.used : 0,
        search: typeof stored?.search === 'number' && stored.search >= 0 ? stored.search : 0,
        exhaustedUntil: typeof stored?.exhaustedUntil === 'number' ? stored.exhaustedUntil : null,
      };
    }
    if (this.state.day !== day) {
      if (this.state.used > 0) this.logger.info({ day: this.state.day, used: this.state.used }, 'YouTube quota day rolled over');
      this.state = { day, used: 0, search: 0, exhaustedUntil: null };
      this.persist();
    }
    return this.state;
  }

  private persist(): void {
    if (this.state) this.kv.set(KV_KEYS.quota, this.state);
  }
}

// ───────────────────────────── Data API client ─────────────────────────────

type ApiEndpoint = 'videos' | 'channels' | 'playlistItems' | 'videoCategories' | 'search';
type ApiQuery = Record<string, string | number | boolean | undefined>;

class YouTubeApi {
  private keyProblem: { message: string; until: number } | null = null;
  private rateLimitedUntil = 0;
  lastError: string | null = null;

  constructor(
    private readonly http: HttpClient,
    private readonly apiKey: string,
    private readonly quota: QuotaTracker,
    private readonly now: () => number,
    private readonly retries: number,
  ) {}

  get keyError(): string | null {
    return this.keyProblem?.message ?? null;
  }

  /**
   * One Data API call, charged to the quota before it is sent (Google bills even failed requests).
   * With `notFound: 'null'`, 404s (and private playlists) resolve to null.
   */
  async get<T>(endpoint: ApiEndpoint, query: ApiQuery, opts: { priority: Priority; notFound?: 'null' | 'throw' }): Promise<T | null> {
    const bucket = endpoint === 'search' ? 'search' : 'units';
    this.assertAvailable(opts.priority, bucket);
    this.quota.charge(1, bucket);
    try {
      const { data } = await this.http.request<T>(`${API_BASE}/${endpoint}`, {
        query: { ...query, key: this.apiKey },
        retries: this.retries,
        timeoutMs: 15 * SECOND,
      });
      this.lastError = null;
      return data;
    } catch (err) {
      if (err instanceof YouTubeApiError) {
        if (err.hasReason(QUOTA_REASONS)) {
          const until = this.quota.markExhausted(bucket);
          if (bucket === 'search') throw new ProviderError('youtube', 'search.list daily budget exhausted', true);
          this.lastError = err.message;
          throw new QuotaExhaustedError(until);
        }
        if (err.hasReason(RATE_REASONS)) {
          this.rateLimitedUntil = this.now() + API_RATE_LIMIT_BACKOFF_MS;
          throw new RateLimitedError('youtube', API_RATE_LIMIT_BACKOFF_MS);
        }
        if (err.hasReason(KEY_REASONS) || err.status === 401) {
          const message = `Google rejected YOUTUBE_API_KEY (${err.reasons.find((r) => KEY_REASONS.has(r)) ?? err.reason})`;
          this.keyProblem = { message, until: this.now() + KEY_PROBLEM_COOLDOWN_MS };
          this.lastError = message;
          throw new ProviderNotConfiguredError('youtube', message);
        }
        if (opts.notFound === 'null' && (err.status === 404 || err.hasReason(NOT_FOUND_REASONS))) return null;
      }
      this.lastError = errorMessage(err);
      throw err;
    }
  }

  private assertAvailable(priority: Priority, bucket: 'units' | 'search'): void {
    const exhausted = this.quota.exhaustedUntil();
    if (exhausted !== null) throw new QuotaExhaustedError(exhausted);
    if (bucket === 'search' && !this.quota.canSearch()) throw new ProviderError('youtube', 'search.list daily budget exhausted', true);
    if (!this.quota.allows(priority)) throw new QuotaDeferredError();
    const now = this.now();
    if (this.keyProblem && now < this.keyProblem.until) throw new ProviderNotConfiguredError('youtube', this.keyProblem.message);
    if (now < this.rateLimitedUntil) throw new RateLimitedError('youtube', this.rateLimitedUntil - now);
  }
}

// ───────────────────────────── channel state ─────────────────────────────

interface PendingVideo {
  id: string;
  source: 'rss' | 'uu' | 'websub';
  discoveredAt: number;
  publishedAt: string | null;
  shortLink: boolean | null;
  attempts: number;
  retryAt: number;
  /** Part of the first listing of the channel (old uploads: never held back for verification). */
  baseline: boolean;
}

interface Candidate {
  id: string;
  premiere: boolean;
  status: 'upcoming' | 'live';
  scheduledStartTime: string | null;
  actualStartTime: string | null;
  addedAt: number;
  checkedAt: number;
}

interface PendingVerification {
  type: 'short' | 'premiere';
  /** Failed membership calls. */
  attempts: number;
  /** A negative UUSH answer for a fresh upload was already re-checked once. */
  rechecked?: boolean;
  notBefore: number;
  since: number;
  signals: ShortSignals;
}

interface StoredItem {
  id: string;
  kind: YouTubeKind;
  title: string;
  publishedAt: string;
  durationSec: number | null;
  viewCount: number | null;
  thumbnailUrl: string | null;
  /** Set while a Shorts/Premiere confirmation is outstanding: the item is held back until resolved. */
  verify?: PendingVerification;
}

interface EndedStream {
  id: string;
  endedAt: number;
  /** The video disappeared (deleted/private) instead of ending normally: there is no VOD. */
  vanished: boolean;
}

interface ChannelState {
  v: 1;
  channelId: string;
  uploadsPlaylistId: string;
  baselineAt: number | null;
  /** Video ids already discovered, newest first. */
  seen: string[];
  pending: PendingVideo[];
  candidates: Candidate[];
  items: StoredItem[];
  ended: EndedStream[];
  lastUuAt: number;
}

interface RssRuntime {
  nextAt: number;
  failures: number;
  lastOkAt: number | null;
  lastError: string | null;
}

function isChannelState(value: unknown, channelId: string): value is ChannelState {
  const v = value as Partial<ChannelState> | null | undefined;
  return (
    !!v &&
    v.v === 1 &&
    v.channelId === channelId &&
    Array.isArray(v.seen) &&
    Array.isArray(v.pending) &&
    Array.isArray(v.candidates) &&
    Array.isArray(v.items) &&
    Array.isArray(v.ended)
  );
}

/** Per-channel discovery state, cached in memory (one shared object per channel) and persisted in kv. */
class ChannelStore {
  private readonly cache = new Map<string, ChannelState>();
  private readonly dirty = new Set<string>();
  private index: Record<string, number> | null = null;
  private indexWrittenAt = 0;

  constructor(
    private readonly kv: SafeKv,
    private readonly now: () => number,
  ) {}

  get(channelId: string, meta?: Record<string, unknown>): ChannelState {
    let state = this.cache.get(channelId);
    if (!state) {
      const stored = this.kv.get<unknown>(KV_KEYS.channel(channelId));
      state = isChannelState(stored, channelId) ? stored : this.fresh(channelId);
      this.cache.set(channelId, state);
    }
    const uploads = meta?.uploadsPlaylistId;
    if (typeof uploads === 'string' && UPLOADS_PLAYLIST_RE.test(uploads) && uploads !== state.uploadsPlaylistId) {
      state.uploadsPlaylistId = uploads;
      this.markDirty(channelId);
    }
    this.touch(channelId);
    return state;
  }

  peek(channelId: string): ChannelState | null {
    if (this.cache.has(channelId)) return this.cache.get(channelId) ?? null;
    const stored = this.kv.get<unknown>(KV_KEYS.channel(channelId));
    return isChannelState(stored, channelId) ? this.get(channelId) : null;
  }

  markDirty(channelId: string): void {
    this.dirty.add(channelId);
  }

  flush(): void {
    for (const id of this.dirty) {
      const state = this.cache.get(id);
      if (state) this.kv.set(KV_KEYS.channel(id), state);
    }
    this.dirty.clear();
    this.maintainIndex();
  }

  private fresh(channelId: string): ChannelState {
    return {
      v: 1,
      channelId,
      uploadsPlaylistId: `UU${channelSuffix(channelId)}`,
      baselineAt: null,
      seen: [],
      pending: [],
      candidates: [],
      items: [],
      ended: [],
      lastUuAt: 0,
    };
  }

  private touch(channelId: string): void {
    this.index ??= this.kv.get<Record<string, number>>(KV_KEYS.channelIndex) ?? {};
    this.index[channelId] = this.now();
  }

  /** Persists last-use times hourly and drops state of channels unused for 30 days (API data retention policy). */
  private maintainIndex(): void {
    const now = this.now();
    if (!this.index || now - this.indexWrittenAt < INDEX_WRITE_INTERVAL_MS) return;
    this.indexWrittenAt = now;
    for (const [id, usedAt] of Object.entries(this.index)) {
      if (now - usedAt <= CHANNEL_STATE_TTL_MS) continue;
      delete this.index[id];
      this.cache.delete(id);
      this.kv.delete(KV_KEYS.channel(id));
    }
    this.kv.set(KV_KEYS.channelIndex, this.index);
  }
}

// ───────────────────────────── provider ─────────────────────────────

export interface YouTubeProviderOptions {
  /** Clock override for deterministic tests. */
  now?: () => number;
  /** Daily Data API quota of the Google project (default 10,000; raise after a quota extension). */
  dailyQuota?: number;
  /** WebSub hub endpoint override (tests). */
  hubUrl?: string;
  /** HttpClient retries for Data API calls on network errors/5xx (default 1). */
  apiRetries?: number;
}

interface CategoryCache {
  fetchedAt: number;
  names: Record<string, string>;
}

type LiveQuotaLevel = keyof typeof LIVE_RECHECK_MS;

export class YouTubeProvider implements PlatformProvider {
  readonly platform = 'youtube' as const;
  readonly capabilities: ProviderCapabilities;
  readonly webhook?: YouTubeWebSubAdapter;

  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly kv: SafeKv;
  private readonly quota: QuotaTracker;
  private readonly api: YouTubeApi | null = null;
  private readonly web: HttpClient;
  private readonly store: ChannelStore;
  private readonly webSubNote: string | null = null;
  private readonly rss = new Map<string, RssRuntime>();
  private readonly videoCache = new Map<string, { video: ApiVideo; at: number }>();
  private categories: CategoryCache | null = null;
  private categoryRetryAt = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(ctx: ProviderContext, opts: YouTubeProviderOptions = {}) {
    this.logger = ctx.logger;
    this.now = opts.now ?? Date.now;
    this.kv = new SafeKv(ctx.kv, this.logger);
    const fetchImpl: FetchLike = ctx.fetch ?? globalThis.fetch.bind(globalThis);
    // YOUTUBE_DAILY_QUOTA is not part of the config schema yet; honour it as soon as it is added.
    const configuredQuota = Number((ctx.config as { YOUTUBE_DAILY_QUOTA?: unknown }).YOUTUBE_DAILY_QUOTA);
    const dailyQuota = opts.dailyQuota ?? (Number.isFinite(configuredQuota) && configuredQuota > 0 ? configuredQuota : DEFAULT_DAILY_QUOTA);
    this.quota = new QuotaTracker(this.kv, this.now, dailyQuota, this.logger);
    this.web = new HttpClient('youtube', fetchImpl);
    this.store = new ChannelStore(this.kv, this.now);

    const apiKey = ctx.config.YOUTUBE_API_KEY;
    if (apiKey) {
      this.api = new YouTubeApi(new HttpClient('youtube', googleApiFetch(fetchImpl)), apiKey, this.quota, this.now, opts.apiRetries ?? 1);
      const webSub = this.setupWebSub(ctx, fetchImpl, opts.hubUrl);
      this.webhook = webSub.adapter;
      this.webSubNote = webSub.note;
    }
    this.capabilities = { live: true, content: [...SUPPORTED_KINDS], liveBatchSize: MAX_IDS_PER_CALL, push: !!this.webhook };
  }

  isConfigured(): boolean {
    return this.api !== null;
  }

  health(): ProviderHealth {
    if (!this.api) return { configured: false, notes: ['لم يتم ضبط YOUTUBE_API_KEY، لذلك متابعة YouTube متوقفة.'] };
    const notes: string[] = [];
    const level = this.quota.level();
    notes.push(`استهلاك حصة YouTube API اليوم: ${this.quota.used} من ${this.quota.dailyLimit} وحدة (تتجدد منتصف الليل بتوقيت المحيط الهادئ).`);
    if (level === 'exhausted') {
      const until = this.quota.exhaustedUntil();
      notes.push(`انتهت حصة YouTube API لليوم، والفحص عبر API متوقف حتى ${until ? new Date(until).toISOString() : 'منتصف الليل'}.`);
    } else if (level === 'critical') {
      notes.push(`تجاوز الاستهلاك ${this.quota.softLimit} وحدة، فتم إيقاف الفحوصات الإضافية (المطابقة الدورية وتأكيد الشورتس) لتوفير الحصة.`);
    } else if (level === 'conserve') {
      notes.push('الاستهلاك مرتفع اليوم، فتم تقليل تكرار الفحوصات الإضافية لتوفير الحصة.');
    }
    if (this.api.keyError) notes.push(`Google رفضت مفتاح YOUTUBE_API_KEY: ${this.api.keyError}`);

    const failing = [...this.rss.values()].filter((r) => r.failures >= 2).length;
    if (failing > 0) {
      notes.push(`خلاصة RSS متعطلة حالياً لـ ${failing} قناة، ويتم الاعتماد على قائمة الرفع (Uploads) عبر API كل 15 دقيقة كبديل.`);
    }

    if (this.webhook) {
      const s = this.webhook.status();
      notes.push(`إشعارات WebSub الفورية مفعّلة: ${s.active} اشتراك فعّال من ${s.channels} قناة، وRSS والفحص الدوري شغالين كمصدر أساسي.`);
      if (s.hubBlockedUntil) notes.push('خادم WebSub طلب منا التمهّل، وسيتم تجديد الاشتراكات تلقائياً لاحقاً.');
      if (s.failed > 0 && s.lastError) notes.push(`فشل اشتراك WebSub لـ ${s.failed} قناة (آخر خطأ: ${s.lastError}).`);
    } else if (this.webSubNote) {
      notes.push(this.webSubNote);
    }
    return { configured: true, notes };
  }

  // ─────────────── resolve ───────────────

  async resolveChannel(input: string): Promise<ResolvedChannel> {
    this.requireApi();
    const target = parseYouTubeInput(input);
    let channel: ApiChannel | null = null;
    let typedHandle: string | null = null;
    switch (target.kind) {
      case 'id':
        channel = await this.channelBy({ id: target.id });
        break;
      case 'handle':
        typedHandle = target.handle;
        channel = await this.channelBy({ forHandle: `@${target.handle}` });
        break;
      case 'name':
        typedHandle = target.name;
        channel = (await this.channelBy({ forHandle: `@${target.name}` })) ?? (await this.channelBy({ forUsername: target.name }));
        break;
      case 'username':
        channel = (await this.channelBy({ forUsername: target.username })) ?? (await this.channelBy({ forHandle: `@${target.username}` }));
        break;
      case 'custom':
        // Most legacy custom URLs became handles; search (own 100/day bucket) is the last resort.
        channel =
          (await this.channelBy({ forHandle: `@${target.name}` })) ??
          (await this.channelBy({ forUsername: target.name })) ??
          (await this.searchChannel(target.name));
        break;
      case 'video': {
        const owner = await this.videoOwner(target.id);
        channel = owner ? await this.channelBy({ id: owner }) : null;
        break;
      }
    }
    if (!channel) throw new ChannelNotFoundError('youtube', input.trim());
    return this.toResolved(channel, typedHandle);
  }

  private async channelBy(query: { id: string } | { forHandle: string } | { forUsername: string }): Promise<ApiChannel | null> {
    try {
      const res = await this.requireApi().get<ApiList<ApiChannel>>(
        'channels',
        { part: 'snippet,contentDetails', ...query },
        { priority: 'essential', notFound: 'null' },
      );
      return res?.items?.find((c) => isYouTubeChannelId(c.id)) ?? null;
    } catch (err) {
      // Malformed handles/usernames come back as 400 invalid*: that is "not found" for the admin.
      if (err instanceof YouTubeApiError && err.status === 400) return null;
      throw err;
    }
  }

  private async videoOwner(videoId: string): Promise<string | null> {
    const res = await this.requireApi().get<ApiList<ApiVideo>>('videos', { part: 'snippet', id: videoId }, { priority: 'essential', notFound: 'null' });
    const owner = res?.items?.[0]?.snippet?.channelId;
    return isYouTubeChannelId(owner) ? owner : null;
  }

  private async searchChannel(name: string): Promise<ApiChannel | null> {
    if (!this.quota.canSearch()) {
      this.logger.warn({ name }, 'Skipping YouTube channel search: daily search budget used up');
      return null;
    }
    const res = await this.requireApi().get<ApiList<ApiSearchResult>>(
      'search',
      { part: 'snippet', type: 'channel', q: name, maxResults: 5 },
      { priority: 'essential', notFound: 'null' },
    );
    const results = (res?.items ?? []).filter((r) => isYouTubeChannelId(r.id?.channelId ?? r.snippet?.channelId));
    const normalize = (s: string | undefined) => (s ?? '').toLowerCase().replace(/[\s_.\-·]/g, '');
    const best = results.find((r) => normalize(r.snippet?.title ?? r.snippet?.channelTitle) === normalize(name)) ?? results[0];
    const id = best?.id?.channelId ?? best?.snippet?.channelId;
    return id ? this.channelBy({ id }) : null;
  }

  private toResolved(channel: ApiChannel, typedHandle: string | null): ResolvedChannel {
    const customUrl = safeDecode(channel.snippet?.customUrl ?? '').trim();
    const handle = customUrl || (typedHandle ? `@${typedHandle}` : channel.id);
    const url = handle.startsWith('@') ? `${WEB_BASE}/@${encodeURIComponent(handle.slice(1))}` : channelUrl(channel.id);
    const uploads = channel.contentDetails?.relatedPlaylists?.uploads;
    return {
      platform: 'youtube',
      platformId: channel.id,
      handle,
      displayName: channel.snippet?.title?.trim() || handle,
      avatarUrl: bestThumbnail(channel.snippet?.thumbnails, ['high', 'medium', 'default']),
      url,
      meta: { uploadsPlaylistId: uploads && UPLOADS_PLAYLIST_RE.test(uploads) ? uploads : `UU${channelSuffix(channel.id)}` },
    };
  }

  // ─────────────── live ───────────────

  async checkLive(channels: ChannelRef[]): Promise<LiveSnapshot[]> {
    if (channels.length === 0) return [];
    this.requireApi();
    return this.exclusive(async () => {
      const invalid = channels.filter((c) => !isYouTubeChannelId(c.platformId));
      if (invalid.length > 0) {
        this.logger.warn({ channels: invalid.map((c) => c.id) }, 'Skipping YouTube channels with a malformed channel id (reported offline)');
      }
      const states = new Map<string, ChannelState>();
      for (const c of channels) if (isYouTubeChannelId(c.platformId) && !states.has(c.platformId)) states.set(c.platformId, this.store.get(c.platformId, c.meta));

      await this.discover([...states.values()]);
      const failure = await this.refreshVideos([...states.values()]);
      this.store.flush();
      // Only reachable when something had to be checked through the API (a live/imminent stream or a new
      // video) and could not be: the monitor keeps the previous state instead of guessing.
      if (failure) throw failure;

      const liveVideos = [...states.values()].flatMap((s) => this.liveVideosOf(s));
      const categories = await this.categoryNames(liveVideos.map((v) => v.snippet?.categoryId));
      return channels.map((c) => this.snapshotFor(c, states.get(c.platformId), categories));
    });
  }

  private snapshotFor(channel: ChannelRef, state: ChannelState | undefined, categories: Map<string, string>): LiveSnapshot {
    const offline = offlineSnapshot({ platform: 'youtube', platformId: channel.platformId }, isYouTubeChannelId(channel.platformId) ? channelUrl(channel.platformId) : WEB_BASE);
    const video = state ? this.liveVideosOf(state)[0] : undefined;
    if (!video) return offline;
    const live = video.liveStreamingDetails ?? {};
    const snippet = video.snippet ?? {};
    const thumb = bestThumbnail(snippet.thumbnails, ['maxres', 'standard', 'high', 'medium', 'default']) ?? `https://i.ytimg.com/vi/${video.id}/hqdefault_live.jpg`;
    return {
      platform: 'youtube',
      platformId: channel.platformId,
      isLive: true,
      streamId: video.id,
      title: snippet.title?.trim() || null,
      category: snippet.categoryId ? (categories.get(snippet.categoryId) ?? null) : null,
      categoryImageUrl: null,
      // Live thumbnails are replaced in place, so Discord needs a cache-buster to show a fresh frame.
      thumbnailUrl: cacheBust(thumb),
      // Hidden (or zero) viewer counts are omitted by the API: that is not "offline".
      viewers: toNumber(live.concurrentViewers),
      startedAt: normalizeTimestamp(live.actualStartTime ?? null),
      url: watchUrl(video.id),
      language: snippet.defaultAudioLanguage || snippet.defaultLanguage || null,
      tags: Array.isArray(snippet.tags) ? snippet.tags.filter((t): t is string => typeof t === 'string').slice(0, 15) : [],
    };
  }

  /**
   * Live (non-Premiere) videos of a channel, primary first. A channel can broadcast several streams at once;
   * the earliest-started one is reported so the stream id stays stable while it continues.
   */
  private liveVideosOf(state: ChannelState): ApiVideo[] {
    return state.candidates
      .filter((c) => c.status === 'live' && !c.premiere)
      .map((c) => this.videoCache.get(c.id)?.video)
      .filter((v): v is ApiVideo => !!v)
      .sort(
        (a, b) =>
          (timeOf(a.liveStreamingDetails?.actualStartTime) || 0) - (timeOf(b.liveStreamingDetails?.actualStartTime) || 0) || a.id.localeCompare(b.id),
      );
  }

  // ─────────────── content ───────────────

  async fetchRecentContent(channel: ChannelRef, kinds: ContentKind[]): Promise<ContentItem[]> {
    const wanted = new Set(kinds.filter((k): k is YouTubeKind => (SUPPORTED_KINDS as readonly string[]).includes(k)));
    if (wanted.size === 0) return [];
    this.requireApi();
    if (!isYouTubeChannelId(channel.platformId)) {
      this.logger.warn({ channel: channel.id }, 'Skipping content check for a YouTube channel with a malformed channel id');
      return [];
    }
    return this.exclusive(async () => {
      const state = this.store.get(channel.platformId, channel.meta);
      await this.discover([state]);
      const failure = await this.refreshVideos([state]);
      if (failure && !(failure instanceof QuotaExhaustedError)) {
        this.logger.warn({ channelId: state.channelId, err: failure.message }, 'Could not classify new YouTube videos; will retry');
      }
      await this.verifyItems(state);
      this.store.flush();

      // Without a complete first listing an empty/partial answer would later look like a flood of "new" videos.
      if (state.baselineAt === null || state.pending.some((p) => p.baseline && p.attempts === 0)) {
        const reason = failure?.message ?? this.rss.get(state.channelId)?.lastError ?? 'uploads could not be listed yet';
        throw new ProviderError('youtube', `Content of ${state.channelId} is not available yet: ${reason}`, true);
      }
      return state.items
        .filter((item) => !item.verify && wanted.has(item.kind))
        .slice(0, RECENT_ITEMS)
        .map((item) => this.toContentItem(state.channelId, item));
    });
  }

  private toContentItem(channelId: string, item: StoredItem): ContentItem {
    return {
      platform: 'youtube',
      platformId: channelId,
      contentId: item.id,
      kind: item.kind,
      title: item.title || CONTENT_KIND_LABELS_AR[item.kind],
      url: item.kind === 'short' ? `${WEB_BASE}/shorts/${item.id}` : watchUrl(item.id),
      thumbnailUrl: item.thumbnailUrl ?? `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
      publishedAt: item.publishedAt,
      durationSec: item.durationSec,
      viewCount: item.viewCount,
      relatedStreamId: item.kind === 'vod' ? item.id : null,
    };
  }

  // ─────────────── VOD lookup ───────────────

  async findVodUrl(channel: ChannelRef, streamId: string | null): Promise<string | null> {
    if (!this.api || !isYouTubeVideoId(streamId)) return null;
    // A YouTube stream's recording keeps the broadcast's video id.
    const state = isYouTubeChannelId(channel.platformId) ? this.store.peek(channel.platformId) : null;
    const ended = state?.ended.find((e) => e.id === streamId);
    if (ended) return ended.vanished ? null : watchUrl(streamId);
    if (state?.items.some((i) => i.id === streamId)) return watchUrl(streamId);
    if (!this.quota.allows('background')) return watchUrl(streamId);
    try {
      const res = await this.api.get<ApiList<ApiVideo>>('videos', { part: 'liveStreamingDetails', id: streamId }, { priority: 'background', notFound: 'null' });
      return res?.items?.some((v) => v.id === streamId) ? watchUrl(streamId) : null;
    } catch (err) {
      this.logger.warn({ channel: channel.id, streamId, err: errorMessage(err) }, 'Could not look up YouTube VOD');
      return watchUrl(streamId);
    }
  }

  // ─────────────── discovery ───────────────

  /** Refreshes the known video ids of each channel (RSS, UU fallback, reconciliation). Never throws. */
  private async discover(states: ChannelState[]): Promise<void> {
    // Real time on purpose: the budget bounds network waits, which the injectable clock does not see.
    const deadline = Date.now() + DISCOVERY_BUDGET_MS;
    await forEachLimit(states, RSS_CONCURRENCY, async (state) => {
      if (Date.now() > deadline) return;
      try {
        await this.discoverChannel(state);
      } catch (err) {
        this.logger.warn({ channelId: state.channelId, err: errorMessage(err) }, 'YouTube discovery failed');
      }
    });
  }

  private async discoverChannel(state: ChannelState): Promise<void> {
    const now = this.now();
    const rss = this.rssRuntime(state.channelId);
    if (state.baselineAt === null || now >= rss.nextAt) {
      try {
        const feed = await this.fetchRss(state.channelId);
        this.onListing(state, feed.entries.map((e) => ({ id: e.videoId, publishedAt: e.published, shortLink: shortLinkOf(e.link), entry: e })), 'rss');
        if (rss.failures > 0) this.logger.info({ channelId: state.channelId, failures: rss.failures }, 'YouTube RSS feed recovered');
        rss.failures = 0;
        rss.lastError = null;
        rss.lastOkAt = now;
        rss.nextAt = now + this.rssInterval(state.channelId);
      } catch (err) {
        rss.failures++;
        rss.lastError = errorMessage(err);
        rss.nextAt = now + Math.min(RSS_BACKOFF_MAX_MS, this.rssInterval(state.channelId) * 2 ** (rss.failures - 1));
        const log = { channelId: state.channelId, failures: rss.failures, err: rss.lastError };
        if (rss.failures === 1) this.logger.warn(log, 'YouTube RSS feed failed; falling back to the uploads playlist');
        else this.logger.debug(log, 'YouTube RSS feed still failing');
        if (now - state.lastUuAt >= UU_FALLBACK_INTERVAL_MS && this.quota.allows('essential')) await this.listUploads(state, 'fallback');
        return;
      }
    }
    if (now - state.lastUuAt >= this.reconcileInterval() && this.quota.allows('background')) await this.listUploads(state, 'reconcile');
  }

  private rssRuntime(channelId: string): RssRuntime {
    let r = this.rss.get(channelId);
    if (!r) {
      r = { nextAt: 0, failures: 0, lastOkAt: null, lastError: null };
      this.rss.set(channelId, r);
    }
    return r;
  }

  private rssInterval(channelId: string): number {
    return RSS_MIN_INTERVAL_MS + (hashOf(channelId) % RSS_JITTER_MS);
  }

  private reconcileInterval(): number {
    return this.quota.level() === 'conserve' ? RECONCILE_INTERVAL_MS * 2 : RECONCILE_INTERVAL_MS;
  }

  private async fetchRss(channelId: string): Promise<ParsedFeed> {
    const res = await this.web.request<unknown>(RSS_URL, {
      query: { channel_id: channelId },
      headers: { accept: 'application/atom+xml, application/xml;q=0.9, text/xml;q=0.8' },
      timeoutMs: RSS_TIMEOUT_MS,
      retries: 0,
      allow404: true,
    });
    if (res.status === 404) throw new ProviderError('youtube', 'RSS feed returned 404', true);
    if (typeof res.data !== 'string') throw new ProviderError('youtube', 'RSS feed returned a non-XML body', true);
    let feed: ParsedFeed;
    try {
      feed = parseYouTubeFeed(res.data);
    } catch (err) {
      throw new ProviderError('youtube', `RSS feed is invalid: ${errorMessage(err)}`, true);
    }
    if (feed.channelId && feed.channelId !== channelId) throw new ProviderError('youtube', `RSS feed belongs to ${feed.channelId}`, true);
    return feed;
  }

  /** Lists the uploads (UU) playlist: the RSS fallback (essential) or the periodic reconciliation (background). */
  private async listUploads(state: ChannelState, reason: 'fallback' | 'reconcile'): Promise<void> {
    state.lastUuAt = this.now();
    this.store.markDirty(state.channelId);
    try {
      const res = await this.requireApi().get<ApiList<ApiPlaylistItem>>(
        'playlistItems',
        { part: 'contentDetails', playlistId: state.uploadsPlaylistId, maxResults: UU_PAGE_SIZE },
        { priority: reason === 'fallback' ? 'essential' : 'background', notFound: 'null' },
      );
      const listed = (res?.items ?? [])
        .map((i) => ({ id: i.contentDetails?.videoId ?? '', publishedAt: normalizeTimestamp(i.contentDetails?.videoPublishedAt ?? null), shortLink: null }))
        .filter((e) => isYouTubeVideoId(e.id));
      this.onListing(state, listed, 'uu');
    } catch (err) {
      const level = err instanceof QuotaDeferredError || err instanceof QuotaExhaustedError ? 'debug' : 'warn';
      this.logger[level]({ channelId: state.channelId, reason, err: errorMessage(err) }, 'Could not list the YouTube uploads playlist');
    }
  }

  /** Diffs a listing (newest first) against what we know and queues new ids for classification. */
  private onListing(
    state: ChannelState,
    listed: Array<{ id: string; publishedAt: string | null; shortLink: boolean | null; entry?: FeedEntry }>,
    source: PendingVideo['source'],
  ): void {
    const now = this.now();
    const baseline = state.baselineAt === null;
    const known = new Set([...state.seen, ...state.pending.map((p) => p.id), ...state.candidates.map((c) => c.id), ...state.items.map((i) => i.id)]);
    const fresh = unique(listed.map((l) => l.id)).filter((id) => !known.has(id));
    for (const l of listed) {
      if (!fresh.includes(l.id) || state.pending.some((p) => p.id === l.id)) continue;
      state.pending.push({ id: l.id, source, discoveredAt: now, publishedAt: l.publishedAt, shortLink: l.shortLink, attempts: 0, retryAt: 0, baseline });
    }
    if (fresh.length > 0) state.seen = [...fresh, ...state.seen].slice(0, SEEN_CAP);
    if (baseline) {
      state.baselineAt = now;
      // Spread the first reconciliation of each channel over the interval instead of all at once
      // (a baseline that came from the UU playlist itself already set lastUuAt).
      if (source !== 'uu') state.lastUuAt = now - (hashOf(`uu:${state.channelId}`) % RECONCILE_INTERVAL_MS);
    }

    // Free refresh of cached metadata from the feed (titles change, views grow) and late /shorts/ hints.
    for (const l of listed) {
      const pending = state.pending.find((p) => p.id === l.id);
      if (pending && pending.shortLink === null && l.shortLink !== null) pending.shortLink = l.shortLink;
      const item = l.entry ? state.items.find((i) => i.id === l.id) : undefined;
      if (item && l.entry) {
        if (l.entry.title) item.title = l.entry.title;
        if (l.entry.views !== null) item.viewCount = l.entry.views;
      }
    }
    if (fresh.length > 0) this.logger.debug({ channelId: state.channelId, source, ids: fresh }, 'Discovered YouTube videos');
    this.store.markDirty(state.channelId);
  }

  /** WebSub push → discovery queue (synchronous; the next check classifies it). */
  private enqueuePushed(entry: FeedEntry & { channelId: string }): boolean {
    const state = this.store.get(entry.channelId);
    if (state.pending.some((p) => p.id === entry.videoId)) return true;
    if (state.seen.includes(entry.videoId) || state.candidates.some((c) => c.id === entry.videoId) || state.items.some((i) => i.id === entry.videoId)) {
      return false;
    }
    state.pending.push({
      id: entry.videoId,
      source: 'websub',
      discoveredAt: this.now(),
      publishedAt: entry.published,
      shortLink: shortLinkOf(entry.link),
      attempts: 0,
      retryAt: 0,
      baseline: false,
    });
    state.seen = [entry.videoId, ...state.seen].slice(0, SEEN_CAP);
    this.store.markDirty(state.channelId);
    this.store.flush();
    this.logger.debug({ channelId: entry.channelId, videoId: entry.videoId }, 'Queued YouTube video from WebSub');
    return true;
  }

  private onPushedDeletion(channelId: string, videoId: string): void {
    const state = this.store.peek(channelId);
    if (!state) return;
    const before = state.pending.length + state.items.length;
    state.pending = state.pending.filter((p) => p.id !== videoId);
    state.items = state.items.filter((i) => i.id !== videoId);
    if (state.pending.length + state.items.length !== before) {
      this.store.markDirty(channelId);
      this.store.flush();
    }
  }

  // ─────────────── classification & candidate tracking ───────────────

  /**
   * One batched videos.list pass for these channels: classifies pending ids and re-checks due candidates.
   * Quota is billed per call, not per id, so not-yet-due candidates ride along in chunks that are sent
   * anyway. Returns the first error that left essential state unknown, or null.
   */
  private async refreshVideos(states: ChannelState[]): Promise<ProviderError | null> {
    const now = this.now();
    const level = this.liveLevel();
    const owners = new Map<string, ChannelState>();
    const essential: string[] = [];
    const background: string[] = [];
    const riders: string[] = [];

    for (const state of states) {
      this.dropStaleCandidates(state, now);
      for (const p of state.pending) {
        if (p.retryAt > now || owners.has(p.id)) continue;
        owners.set(p.id, state);
        essential.push(p.id);
      }
      for (const c of state.candidates) {
        if (owners.has(c.id)) continue;
        owners.set(c.id, state);
        const due = this.candidateDue(c, now, level);
        (due === 'essential' ? essential : due === 'background' ? background : riders).push(c.id);
      }
    }

    const fill = (base: string[]) => {
      const capacity = Math.ceil(base.length / MAX_IDS_PER_CALL) * MAX_IDS_PER_CALL;
      return [...base, ...riders].slice(0, Math.max(capacity, base.length));
    };
    let ids: string[] = [];
    if (essential.length > 0) ids = fill([...essential, ...background]);
    else if (background.length > 0 && this.quota.allows('background')) ids = fill(background);
    if (ids.length === 0) return null;

    const essentialSet = new Set(essential);
    let failure: ProviderError | null = null;
    for (const batch of chunk(ids, MAX_IDS_PER_CALL)) {
      const priority: Priority = batch.some((id) => essentialSet.has(id)) ? 'essential' : 'background';
      try {
        const res = await this.requireApi().get<ApiList<ApiVideo>>(
          'videos',
          { part: VIDEO_PARTS, id: batch.join(','), maxWidth: PLAYER_BOX, maxHeight: PLAYER_BOX },
          { priority },
        );
        const found = new Map((res?.items ?? []).filter((v) => isYouTubeVideoId(v.id)).map((v) => [v.id, v]));
        for (const id of batch) {
          const state = owners.get(id);
          if (state) this.applyVideo(state, id, found.get(id) ?? null);
        }
      } catch (err) {
        const error = err instanceof ProviderError ? err : new ProviderError('youtube', errorMessage(err), true, { cause: err });
        if (priority === 'essential') failure ??= error;
        else this.logger.debug({ err: error.message }, 'Background YouTube re-check skipped');
        if (err instanceof QuotaExhaustedError || err instanceof ProviderNotConfiguredError) break;
      }
    }
    return failure;
  }

  /** How urgently a tracked stream needs a re-check: every poll near/after its start, slowly otherwise. */
  private candidateDue(c: Candidate, now: number, level: LiveQuotaLevel): 'essential' | 'background' | 'skip' {
    // Without a cached resource (e.g. after a restart) the candidate is treated as never checked.
    const since = this.videoCache.has(c.id) ? now - c.checkedAt : Number.POSITIVE_INFINITY;
    const pollInterval = LIVE_RECHECK_MS[level];
    if (c.status === 'live') return since >= pollInterval ? 'essential' : 'skip';
    const scheduled = timeOf(c.scheduledStartTime);
    if (!Number.isFinite(scheduled)) return since >= UPCOMING_UNSCHEDULED_RECHECK_MS ? 'background' : 'skip';
    const untilStart = scheduled - now;
    if (untilStart <= UPCOMING_DUE_WINDOW_MS && -untilStart <= UPCOMING_OVERDUE_MS) return since >= pollInterval ? 'essential' : 'skip';
    const slow = level === 'normal' ? UPCOMING_SLOW_RECHECK_MS : UPCOMING_SLOW_RECHECK_MS * 2;
    return since >= slow ? 'background' : 'skip';
  }

  private dropStaleCandidates(state: ChannelState, now: number): void {
    const keep = state.candidates.filter((c) => {
      if (c.status === 'live') return true;
      const scheduled = timeOf(c.scheduledStartTime);
      const reference = Number.isFinite(scheduled) ? scheduled : c.addedAt;
      return now - reference <= UPCOMING_DROP_AFTER_MS;
    });
    if (keep.length !== state.candidates.length) {
      this.logger.info({ channelId: state.channelId, dropped: state.candidates.length - keep.length }, 'Dropped scheduled YouTube streams that never started');
      state.candidates = keep;
      this.store.markDirty(state.channelId);
    }
  }

  private applyVideo(state: ChannelState, id: string, video: ApiVideo | null): void {
    const now = this.now();
    const pending = state.pending.find((p) => p.id === id);
    const candidate = state.candidates.find((c) => c.id === id);
    this.store.markDirty(state.channelId);

    if (!video) {
      // Deleted, made private, or not visible yet (very fresh pushes).
      if (candidate) {
        state.candidates = state.candidates.filter((c) => c.id !== id);
        this.videoCache.delete(id);
        if (candidate.status === 'live' && !candidate.premiere) this.recordEnded(state, id, now, true);
        this.logger.info({ channelId: state.channelId, videoId: id }, 'Tracked YouTube stream disappeared (deleted or private)');
      }
      if (pending) {
        pending.attempts++;
        if (pending.attempts >= PENDING_MAX_ATTEMPTS) state.pending = state.pending.filter((p) => p.id !== id);
        else pending.retryAt = now + MINUTE * 2 ** pending.attempts;
      }
      return;
    }

    this.cacheVideo(video, now);
    state.pending = state.pending.filter((p) => p.id !== id);
    const cls = classifyVideo(video);
    const removeCandidate = () => {
      state.candidates = state.candidates.filter((c) => c.id !== id);
    };

    switch (cls.type) {
      case 'upcoming':
      case 'live': {
        if (cls.type === 'live' && cls.premiere) {
          // A Premiere that started playing is announced as a new video, not as "streaming now".
          removeCandidate();
          this.upsertItem(state, this.itemFrom(video, 'video', normalizeTimestamp(cls.actualStartTime)));
          break;
        }
        const next: Candidate = {
          id,
          premiere: cls.premiere,
          status: cls.type,
          scheduledStartTime: cls.type === 'upcoming' ? normalizeTimestamp(cls.scheduledStartTime) : (candidate?.scheduledStartTime ?? null),
          actualStartTime: cls.type === 'live' ? normalizeTimestamp(cls.actualStartTime) : null,
          addedAt: candidate?.addedAt ?? now,
          checkedAt: now,
        };
        if (cls.type === 'live' && candidate?.status !== 'live') this.logger.info({ channelId: state.channelId, videoId: id }, 'YouTube stream is live');
        state.candidates = [...state.candidates.filter((c) => c.id !== id), next];
        break;
      }
      case 'ended': {
        removeCandidate();
        const knownPremiere = candidate?.premiere ?? false;
        if (candidate && !knownPremiere) this.recordEnded(state, id, timeOf(cls.actualEndTime) || now, false);
        const endedAt = normalizeTimestamp(cls.actualEndTime) ?? normalizeTimestamp(video.snippet?.publishedAt ?? null);
        const item = this.itemFrom(video, knownPremiere ? 'video' : 'vod', endedAt);
        if (item.durationSec === 0 || item.durationSec === null) {
          const span = (timeOf(cls.actualEndTime) - timeOf(cls.actualStartTime)) / SECOND;
          item.durationSec = Number.isFinite(span) && span > 0 ? Math.round(span) : null;
        }
        // Seen only after it ended: we cannot tell a Premiere from a stream VOD without asking UULF.
        if (!candidate && !pending?.baseline && now - (timeOf(endedAt) || 0) <= PREMIERE_CHECK_MAX_AGE_MS) {
          item.verify = { type: 'premiere', attempts: 0, notBefore: 0, since: now, signals: this.shortSignals(video, pending) };
        }
        if (candidate?.status === 'live') this.logger.info({ channelId: state.channelId, videoId: id }, 'YouTube stream ended');
        this.upsertItem(state, item);
        break;
      }
      case 'upload': {
        removeCandidate();
        const signals = this.shortSignals(video, pending);
        const verdict = initialShortVerdict(signals);
        const item = this.itemFrom(video, verdict === 'short' ? 'short' : 'video', normalizeTimestamp(video.snippet?.publishedAt ?? null));
        if (verdict === 'check') {
          // Old (baseline) uploads are never announced, so a heuristic is enough for them.
          if (pending?.baseline) item.kind = heuristicIsShort(signals) ? 'short' : 'video';
          else item.verify = { type: 'short', attempts: 0, notBefore: 0, since: now, signals };
        }
        this.upsertItem(state, item);
        break;
      }
    }
  }

  private shortSignals(video: ApiVideo, pending: PendingVideo | undefined): ShortSignals {
    return {
      durationSec: parseIsoDuration(video.contentDetails?.duration),
      publishedAt: video.snippet?.publishedAt ?? pending?.publishedAt ?? null,
      shortLink: pending?.shortLink ?? null,
      aspect: aspectOf(video),
    };
  }

  private itemFrom(video: ApiVideo, kind: YouTubeKind, publishedAt: string | null): StoredItem {
    const snippet = video.snippet ?? {};
    return {
      id: video.id,
      kind,
      title: snippet.title?.trim() ?? '',
      publishedAt: publishedAt ?? new Date(this.now()).toISOString(),
      durationSec: parseIsoDuration(video.contentDetails?.duration),
      viewCount: toNumber(video.statistics?.viewCount),
      thumbnailUrl: bestThumbnail(snippet.thumbnails, ['maxres', 'standard', 'high', 'medium']) ?? `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`,
    };
  }

  private upsertItem(state: ChannelState, item: StoredItem): void {
    state.items = [item, ...state.items.filter((i) => i.id !== item.id)]
      .sort((a, b) => timeOf(b.publishedAt) - timeOf(a.publishedAt) || b.id.localeCompare(a.id))
      .slice(0, ITEMS_CAP);
  }

  private recordEnded(state: ChannelState, id: string, endedAt: number, vanished: boolean): void {
    state.ended = [{ id, endedAt, vanished }, ...state.ended.filter((e) => e.id !== id)].slice(0, ENDED_CAP);
  }

  private cacheVideo(video: ApiVideo, now: number): void {
    this.videoCache.delete(video.id);
    this.videoCache.set(video.id, { video, at: now });
    while (this.videoCache.size > VIDEO_CACHE_MAX) {
      const oldest = this.videoCache.keys().next().value;
      if (oldest === undefined) break;
      this.videoCache.delete(oldest);
    }
  }

  // ─────────────── Shorts / Premiere verification ───────────────

  /** Resolves held-back items through the UUSH (Shorts) / UULF (long-form) playlists, or heuristics when quota is tight. */
  private async verifyItems(state: ChannelState): Promise<void> {
    const now = this.now();
    for (const item of state.items) {
      const v = item.verify;
      if (!v || now < v.notBefore) continue;
      this.store.markDirty(state.channelId);
      if (now - v.since > VERIFY_HOLD_MAX_MS || !this.quota.allows('background')) {
        this.finalizeHeuristically(item, v);
        continue;
      }
      try {
        if (v.type === 'short') {
          const isShort = await this.inPlaylist(`UUSH${channelSuffix(state.channelId)}`, item.id);
          const fresh = now - (timeOf(item.publishedAt) || 0) < SHORT_RECHECK_FRESH_MS;
          if (isShort) item.kind = 'short';
          else if (v.signals.shortLink === null && !v.rechecked && fresh) {
            v.rechecked = true;
            v.notBefore = now + SHORT_RECHECK_DELAY_MS;
            continue;
          } else item.kind = 'video';
        } else {
          // Premieres end up with the long-form uploads; past live streams do not.
          item.kind = (await this.inPlaylist(`UULF${channelSuffix(state.channelId)}`, item.id)) ? 'video' : 'vod';
        }
        delete item.verify;
      } catch (err) {
        v.attempts++;
        v.notBefore = now + MINUTE;
        if (err instanceof QuotaExhaustedError || err instanceof QuotaDeferredError || v.attempts >= 3) this.finalizeHeuristically(item, v);
        else this.logger.debug({ videoId: item.id, err: errorMessage(err) }, 'YouTube playlist membership check failed; will retry');
      }
    }
  }

  private finalizeHeuristically(item: StoredItem, v: PendingVerification): void {
    item.kind = v.type === 'short' ? (heuristicIsShort(v.signals) ? 'short' : 'video') : 'vod';
    delete item.verify;
  }

  private async inPlaylist(playlistId: string, videoId: string): Promise<boolean> {
    const res = await this.requireApi().get<ApiList<ApiPlaylistItem>>(
      'playlistItems',
      { part: 'id', playlistId, videoId, maxResults: 1 },
      { priority: 'background', notFound: 'null' },
    );
    return (res?.items?.length ?? 0) > 0;
  }

  // ─────────────── categories ───────────────

  /** Category names (videoCategories.list, regionCode US) cached for a week; cosmetic, so never fatal. */
  private async categoryNames(ids: Array<string | undefined>): Promise<Map<string, string>> {
    const wanted = unique(ids.filter((id): id is string => !!id));
    if (wanted.length === 0) return new Map();
    const now = this.now();
    this.categories ??= this.kv.get<CategoryCache>(KV_KEYS.categories) ?? null;
    const cache = this.categories;
    const missing = wanted.some((id) => !cache?.names[id]);
    const stale = !cache || now - cache.fetchedAt > CATEGORY_TTL_MS;
    if ((missing || stale) && now >= this.categoryRetryAt && this.quota.allows('background')) {
      try {
        const res = await this.requireApi().get<ApiList<ApiCategory>>('videoCategories', { part: 'snippet', regionCode: 'US', hl: 'en' }, { priority: 'background' });
        const names: Record<string, string> = {};
        for (const c of res?.items ?? []) if (c.id && c.snippet?.title) names[c.id] = c.snippet.title;
        this.categories = { fetchedAt: now, names };
        this.kv.set(KV_KEYS.categories, this.categories);
        this.categoryRetryAt = now + CATEGORY_RETRY_MS;
      } catch (err) {
        this.categoryRetryAt = now + CATEGORY_FAILURE_RETRY_MS;
        this.logger.debug({ err: errorMessage(err) }, 'Could not fetch YouTube video categories');
      }
    }
    const names = this.categories?.names ?? {};
    return new Map(wanted.filter((id) => names[id]).map((id) => [id, names[id] as string]));
  }

  // ─────────────── internals ───────────────

  private liveLevel(): LiveQuotaLevel {
    const level = this.quota.level();
    return level === 'exhausted' ? 'critical' : level;
  }

  private requireApi(): YouTubeApi {
    if (!this.api) throw new ProviderNotConfiguredError('youtube', 'YOUTUBE_API_KEY is not configured');
    return this.api;
  }

  /** Serializes discovery/classification so concurrent checks never fetch or classify the same ids twice. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private setupWebSub(ctx: ProviderContext, fetchImpl: FetchLike, hubUrl: string | undefined): { adapter?: YouTubeWebSubAdapter; note: string | null } {
    const { config } = ctx;
    const pollingOnly = 'والاعتماد حالياً على RSS والفحص الدوري فقط.';
    if (!config.webhooksEnabled || !config.PUBLIC_URL) {
      return { note: `إشعارات WebSub الفورية غير مفعّلة لأنها تحتاج PUBLIC_URL يبدأ بـ https://، ${pollingOnly}` };
    }
    if (!config.YOUTUBE_WEBSUB_SECRET) {
      return { note: `إشعارات WebSub الفورية غير مفعّلة لأن YOUTUBE_WEBSUB_SECRET غير مضبوط، ${pollingOnly}` };
    }
    const adapter = new YouTubeWebSubAdapter({
      callbackUrl: `${config.PUBLIC_URL}${YOUTUBE_WEBSUB_PATH}`,
      secret: config.YOUTUBE_WEBSUB_SECRET,
      kv: this.kv,
      logger: this.logger,
      now: this.now,
      fetch: fetchImpl,
      hubUrl,
      callbacks: {
        onNewVideo: (entry) => this.enqueuePushed(entry),
        isTrackedStream: (channelId, videoId) => !!this.store.peek(channelId)?.candidates.some((c) => c.id === videoId),
        onDeleted: (channelId, videoId) => this.onPushedDeletion(channelId, videoId),
      },
    });
    return { adapter, note: null };
  }
}

export const createYouTubeProvider: ProviderFactory = (ctx) => new YouTubeProvider(ctx);
