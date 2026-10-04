/**
 * TikTok provider.
 *
 * TikTok has no official API that tells a third party whether an arbitrary creator is LIVE or lists their
 * videos, so everything here talks to TikTok's public web endpoints, the same ones tiktok-live-connector,
 * yt-dlp and RSSHub use. We call them directly rather than depending on those (AGPL) libraries.
 *
 * Live status (one request chain per channel, stopping at the first conclusive answer):
 *   1. GET www.tiktok.com/api-live/user/room/?uniqueId=…   → data.liveRoom.status (2 = live, 4 = ended)
 *      While live, enrich via GET webcast.tiktok.com/webcast/room/info/?room_id=… (viewers, title, cover).
 *   2. GET www.tiktok.com/@handle/live → <script id="SIGI_STATE"> LiveRoom.liveRoomUserInfo
 *   3. Optional: Euler Stream GET /webcast/anchors/{handle}/room_id (TIKTOK_SIGN_API_KEY). It runs on
 *      Euler's infrastructure, so it keeps working while TikTok is blocking our IP.
 *   An error or a block is never reported as "offline": if no method is conclusive we throw and the
 *   monitor keeps the previous state.
 *
 * Videos: the official Creator Profile Embed page (www.tiktok.com/embed/@handle →
 * <script id="__FRONTITY_CONNECT_STATE__"> videoList). TikTok's WAF proof-of-work challenge is solved
 * natively (the same SHA-256 puzzle RSSHub and yt-dlp solve). Optional fallback: a (self-hosted) RSSHub
 * feed. oEmbed fills in missing captions or thumbnails for new videos.
 *
 * Datacenter IPs get blocked (403/429, captcha pages, empty or non-JSON answers). A persisted circuit
 * breaker pauses all direct TikTok requests after 3 consecutive blocks (10 min, doubling up to 2 h), and
 * every request goes through one throttle with a small random gap so we never burst.
 */
import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { ChannelNotFoundError, ProviderError, RateLimitedError, ValidationError, errorMessage } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import { offlineSnapshot, type ChannelRef, type ContentItem, type ContentKind, type LiveSnapshot, type ResolvedChannel } from '../core/types.js';
import { HttpClient, type FetchLike } from './http.js';
import type { KeyValueStore, PlatformProvider, ProviderCapabilities, ProviderContext, ProviderFactory, ProviderHealth } from './types.js';

// ───────────────────────────── constants ─────────────────────────────

const WEB_BASE = 'https://www.tiktok.com';
const WEBCAST_BASE = 'https://webcast.tiktok.com/webcast';
const EULER_BASE = 'https://api.eulerstream.com';
const AID = '1988';

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const SEC_CH_UA = '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"';
const BOT_USER_AGENT = 'StreamBot/1.0 (+discord bot)';
/** tiktok-live-connector pins the webcast data centre the same way; it keeps webcast answers consistent. */
const DEFAULT_COOKIES: ReadonlyArray<[string, string]> = [['tt-target-idc', 'useast1a']];

const KV_BREAKER = 'tiktok:breaker';
/** handle -> last time this provider saw the account live; keeps the user_not_found contradiction window across restarts. */
const KV_LAST_LIVE = 'tiktok:lastLive';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const BLOCK_THRESHOLD = 3;
const BREAKER_BASE_COOLDOWN_MS = 10 * MINUTE;
const BREAKER_MAX_COOLDOWN_MS = 2 * HOUR;
const DEFAULT_MIN_GAP_MS = 400;
const DEFAULT_MAX_GAP_MS = 1_200;
const MAX_GAP_MS = 1_500;
const REQUEST_TIMEOUT_MS = 12_000;
const SHORT_LINK_TIMEOUT_MS = 10_000;
const RSSHUB_TIMEOUT_MS = 25_000;
const EULER_TIMEOUT_MS = 15_000;
const EULER_AUTH_PAUSE_MS = HOUR;
const WARN_INTERVAL_MS = 6 * HOUR;

/**
 * api-live answers "user_not_found" both for accounts that never went LIVE and, occasionally, for creators
 * who are live right now (tiktok-live-connector #323). We trust it, but cross-check with the live page every
 * so often, and immediately when it contradicts a recent live observation.
 */
const NEVER_LIVE_RECHECK_MS = 15 * MINUTE;
const CONTRADICTION_WINDOW_MS = 20 * MINUTE;

/** 2 = live; 3 is reported while a mobile stream is paused/reconnecting and must not end the session. */
/** Only status 2 is a confirmed live room. */
const LIVE_STATUSES = new Set([2]);
/** Status 3 shows up for paused/reconnecting rooms: it keeps an already-live stream alive but never starts one. */
const PAUSED_STATUS = 3;
const ENDED_STATUS = 4;
const USER_NOT_FOUND_STATUS_CODE = 19881007;
/** TikTok web status codes: 10202 = user does not exist, 10221 = banned account. */
const USER_MISSING_CODES = new Set([10202, 10221]);
const PRIVATE_ACCOUNT_CODE = 10222;

const MAX_VIDEOS = 20;
const OEMBED_PER_CALL = 3;
const OEMBED_CACHE_SIZE = 500;
const MAX_TITLE_LENGTH = 250;
const DEFAULT_VIDEO_TITLE = 'فيديو جديد على تيك توك';
const TIKTOK_CONTENT_KINDS = ['video'] as const satisfies readonly ContentKind[];

const HANDLE_RE = /^[a-z0-9._]{1,30}$/;
const SHORT_LINK_HOSTS = new Set(['vm.tiktok.com', 'vt.tiktok.com']);
const MIN_VALID_EPOCH_MS = Date.UTC(2014, 0, 1);
const WAF_PAGE_MAX_LENGTH = 50_000;
const DAY_MS = 24 * HOUR;

// ───────────────────────────── small helpers ─────────────────────────────

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** Ids as strings ("0" and empty mean "none"). Numeric ids may already have lost precision, so prefer *_str fields. */
function idStr(value: unknown): string | null {
  const s = typeof value === 'number' && Number.isFinite(value) ? String(value) : str(value);
  return s && s !== '0' ? s : null;
}

function positive(value: number | null): number | null {
  return value !== null && value > 0 ? value : null;
}

function count(value: number | null): number | null {
  return value !== null && value >= 0 ? Math.round(value) : null;
}

function dig(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

/** First URL of TikTok's `{ url_list: [...] }` image objects (or a plain string). */
function firstUrl(value: unknown): string | null {
  if (typeof value === 'string') return str(value);
  if (!isRecord(value) || !Array.isArray(value.url_list)) return null;
  for (const url of value.url_list) if (str(url)) return str(url);
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractScriptJson(html: string, id: string): unknown {
  const match = new RegExp(`<script[^>]*\\sid=["']${escapeRegExp(id)}["'][^>]*>([\\s\\S]*?)</script>`, 'i').exec(html);
  if (!match?.[1]) return undefined;
  try {
    return JSON.parse(match[1]);
  } catch {
    return undefined;
  }
}

function attributeOfId(html: string, id: string, attribute: string): string | null {
  const tag = new RegExp(`<[a-z][^>]*\\sid=["']${escapeRegExp(id)}["'][^>]*>`, 'i').exec(html)?.[0];
  if (!tag) return null;
  return new RegExp(`\\s${escapeRegExp(attribute)}=["']([^"']*)["']`, 'i').exec(tag)?.[1] ?? null;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function looksLikeHtml(text: string): boolean {
  return /^\s*</.test(text);
}

/** Best-effort label for a page that did not contain the data we expected. */
function describeBlockPage(html: string): string | null {
  const sample = html.slice(0, 30_000).toLowerCase();
  if (sample.includes('_wafchallengeid')) return 'WAF challenge page';
  if (/verify-bar|captcha_container|secsdk-captcha|tiktok-verify-page/.test(sample)) return 'captcha page';
  if (sample.includes('please wait')) return 'WAF interstitial';
  if (sample.includes('access denied')) return 'access denied page';
  return null;
}

function secondsToIso(seconds: number | null, nowMs: number): string | null {
  if (seconds === null) return null;
  const ms = seconds * 1000;
  if (ms < MIN_VALID_EPOCH_MS || ms > nowMs + DAY_MS) return null;
  return new Date(ms).toISOString();
}

function cleanTitle(value: string | null): string | null {
  if (!value) return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > MAX_TITLE_LENGTH ? `${text.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…` : text;
}

const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

const profileUrl = (handle: string) => `${WEB_BASE}/@${encodeURIComponent(handle)}`;
const liveUrl = (handle: string) => `${profileUrl(handle)}/live`;
const videoUrl = (handle: string, id: string) => `${profileUrl(handle)}/video/${id}`;

// ───────────────────────────── input parsing ─────────────────────────────

/** Lower-cases and validates a TikTok username (uniqueId). Returns null when it cannot be one. */
export function normalizeTikTokHandle(value: string): string | null {
  const handle = value.trim().replace(/^@+/, '').toLowerCase();
  return HANDLE_RE.test(handle) ? handle : null;
}

export type TikTokInput = { kind: 'handle'; handle: string } | { kind: 'short_link'; url: string };

function handleFromPath(pathname: string): string | null {
  for (const raw of pathname.split('/')) {
    let segment = raw;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      // keep the raw segment
    }
    if (segment.startsWith('@')) return normalizeTikTokHandle(segment);
  }
  return null;
}

/**
 * Accepts "handle", "@handle", profile/live/video URLs (with or without scheme, www/m subdomains, query
 * strings) and short links (vm.tiktok.com/…, vt.tiktok.com/…, tiktok.com/t/…), which need a redirect lookup.
 */
export function parseTikTokInput(raw: string): TikTokInput {
  const input = raw.trim().replace(/^<(.+)>$/, '$1').trim();
  if (!input) throw new ValidationError('اكتب يوزر تيك توك (مثل @username) أو رابط الحساب.', 'handle');

  const hasScheme = /^https?:\/\//i.test(input);
  if (hasScheme || /tiktok\.com/i.test(input)) {
    let url: URL;
    try {
      url = new URL(hasScheme ? input : `https://${input}`);
    } catch {
      throw new ValidationError('رابط تيك توك غير صالح.', 'handle');
    }
    const host = url.hostname.toLowerCase();
    if (host !== 'tiktok.com' && !host.endsWith('.tiktok.com')) {
      throw new ValidationError('الرابط لازم يكون من tiktok.com.', 'handle');
    }
    if (SHORT_LINK_HOSTS.has(host) || /^\/t\/[\w-]+/i.test(url.pathname)) return { kind: 'short_link', url: url.toString() };
    const handle = handleFromPath(url.pathname);
    if (!handle) {
      throw new ValidationError('ما لقيت اسم الحساب في الرابط. أرسل رابط الحساب بهالشكل: https://www.tiktok.com/@username', 'handle');
    }
    return { kind: 'handle', handle };
  }

  const handle = normalizeTikTokHandle(input);
  if (!handle) {
    throw new ValidationError('يوزر تيك توك غير صالح: المسموح فقط حروف إنجليزية وأرقام والنقطة (.) والشرطة السفلية (_).', 'handle');
  }
  return { kind: 'handle', handle };
}

/** TikTok video ids are snowflake-like: the upper 32 bits are the creation time in unix seconds. */
export function tiktokIdToDate(id: string): Date | null {
  if (!/^\d{15,22}$/.test(id)) return null;
  const ms = Number(BigInt(id) >> 32n) * 1000;
  if (ms < MIN_VALID_EPOCH_MS || ms > Date.UTC(2100, 0, 1)) return null;
  return new Date(ms);
}

// ───────────────────────────── WAF challenge ─────────────────────────────

export interface WafChallenge {
  /** Base64 JSON envelope `{ v: { a, b, c }, s }`. */
  payload: string;
  cookieName: string;
  /** Optional companion cookie (`waforiginalreid`) some challenge pages ask for. */
  extraCookies: Record<string, string>;
}

/** Detects TikTok's `_wafchallengeid` proof-of-work page and extracts what is needed to answer it. */
export function findWafChallenge(html: string): WafChallenge | null {
  if (!html.includes('_wafchallengeid') && !/\sid=["']wci["']/i.test(html)) return null;
  // Challenge pages are tiny; the script-variable form is only trusted there so a normal page that merely
  // mentions the cookie name is never mistaken for a challenge.
  const payload =
    attributeOfId(html, 'cs', 'class') ?? (html.length < WAF_PAGE_MAX_LENGTH ? (/\bcs="([A-Za-z0-9+/=_-]{16,})"/.exec(html)?.[1] ?? null) : null);
  if (!payload) return null;
  const declaredName = attributeOfId(html, 'wci', 'class');
  const cookieName = declaredName && /^[\w-]+$/.test(declaredName) ? declaredName : '_wafchallengeid';
  const extraCookies: Record<string, string> = {};
  const rciName = attributeOfId(html, 'rci', 'class');
  const rciValue = attributeOfId(html, 'rs', 'class');
  if (rciName && rciValue && /^[\w-]+$/.test(rciName)) extraCookies[rciName] = rciValue;
  return { payload, cookieName, extraCookies };
}

/**
 * Solves the challenge: find n such that sha256(base64decode(v.a) + String(n)) == base64decode(v.c), then
 * answer with the envelope plus `d = base64(String(n))`. n is usually tiny, but the loop yields to the event
 * loop periodically so a hard challenge can never stall the bot.
 */
export async function solveWafChallenge(payload: string, maxIterations = 1_000_000): Promise<string | null> {
  let challenge: unknown;
  try {
    challenge = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  const envelope = isRecord(challenge) ? challenge.v : undefined;
  if (!isRecord(challenge) || !isRecord(envelope) || typeof envelope.a !== 'string' || typeof envelope.c !== 'string') return null;
  const expected = Buffer.from(envelope.c, 'base64');
  if (expected.length !== 32) return null;
  const prefix = createHash('sha256').update(Buffer.from(envelope.a, 'base64'));
  for (let n = 0; n < maxIterations; n++) {
    if (n > 0 && n % 25_000 === 0) await yieldToEventLoop();
    if (prefix.copy().update(String(n)).digest().equals(expected)) {
      challenge.d = Buffer.from(String(n)).toString('base64');
      return Buffer.from(JSON.stringify(challenge)).toString('base64');
    }
  }
  return null;
}

// ───────────────────────────── infrastructure ─────────────────────────────

/** KV access that never throws: persistence is an optimisation, never a reason to fail a check. */
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
}

interface BreakerState {
  /** Blocks in a row since the last success (resets when the breaker trips). */
  consecutiveBlocks: number;
  /** Trips in a row without a success in between; drives the doubling cooldown. 0 = fully closed. */
  trips: number;
  openUntil: number;
  lastReason: string | null;
  lastBlockAt: number | null;
}

const CLOSED_BREAKER: BreakerState = { consecutiveBlocks: 0, trips: 0, openUntil: 0, lastReason: null, lastBlockAt: null };

/**
 * Pauses every direct TikTok request after BLOCK_THRESHOLD consecutive blocks. After the cooldown the next
 * request is a probe: one more block re-opens it with a doubled cooldown, a success closes it. Persisted so
 * restarts don't hammer TikTok and get the IP flagged harder.
 */
class BlockBreaker {
  private state: BreakerState;
  onTrip: (() => void) | null = null;

  constructor(
    private readonly kv: SafeKv,
    private readonly now: () => number,
    private readonly logger: Logger,
  ) {
    const stored = kv.get<Partial<BreakerState>>(KV_BREAKER);
    this.state = isRecord(stored)
      ? {
          consecutiveBlocks: num(stored.consecutiveBlocks) ?? 0,
          trips: num(stored.trips) ?? 0,
          openUntil: num(stored.openUntil) ?? 0,
          lastReason: str(stored.lastReason),
          lastBlockAt: num(stored.lastBlockAt),
        }
      : { ...CLOSED_BREAKER };
  }

  isOpen(): boolean {
    return this.now() < this.state.openUntil;
  }

  remainingMs(): number {
    return Math.max(0, this.state.openUntil - this.now());
  }

  snapshot(): Readonly<BreakerState> {
    return this.state;
  }

  recordSuccess(): void {
    if (this.state.consecutiveBlocks === 0 && this.state.trips === 0) return;
    if (this.state.trips > 0) this.logger.info({ trips: this.state.trips }, 'TikTok reachable again; closing circuit');
    this.state = { ...CLOSED_BREAKER, lastReason: this.state.lastReason, lastBlockAt: this.state.lastBlockAt };
    this.kv.set(KV_BREAKER, this.state);
  }

  recordBlock(reason: string, retryAfterMs = 0): void {
    const now = this.now();
    const probeFailed = this.state.trips > 0;
    const consecutiveBlocks = this.state.consecutiveBlocks + 1;
    if (consecutiveBlocks < BLOCK_THRESHOLD && !probeFailed) {
      this.state = { ...this.state, consecutiveBlocks, lastReason: reason, lastBlockAt: now };
      this.logger.debug({ reason, consecutiveBlocks }, 'TikTok request blocked');
    } else {
      const trips = this.state.trips + 1;
      const cooldown = Math.min(BREAKER_MAX_COOLDOWN_MS, Math.max(BREAKER_BASE_COOLDOWN_MS * 2 ** (trips - 1), retryAfterMs));
      this.state = { consecutiveBlocks: 0, trips, openUntil: now + cooldown, lastReason: reason, lastBlockAt: now };
      this.logger.warn({ reason, trips, cooldownMin: Math.round(cooldown / MINUTE) }, 'TikTok is blocking us; pausing TikTok requests');
      this.onTrip?.();
    }
    this.kv.set(KV_BREAKER, this.state);
  }
}

/** Serialises requests with a small randomised gap so checks for many channels never burst. */
class Throttle {
  private tail: Promise<unknown> = Promise.resolve();
  private lastAt = Number.NEGATIVE_INFINITY;
  private gap = 0;

  constructor(
    private readonly minGapMs: number,
    private readonly maxGapMs: number,
    private readonly now: () => number,
    private readonly random: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const wait = this.lastAt + this.gap - this.now();
      if (wait > 0) await this.sleep(wait);
      try {
        return await task();
      } finally {
        this.lastAt = this.now();
        this.gap = this.minGapMs + this.random() * (this.maxGapMs - this.minGapMs);
      }
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/** Minimal cookie jar: TikTok hands out ttwid / tt_chain_token etc.; sending them back looks like a real browser. */
class CookieJar {
  private readonly cookies = new Map<string, string>(DEFAULT_COOKIES);

  header(extra: Record<string, string> = {}): string {
    const merged = new Map(this.cookies);
    for (const [name, value] of Object.entries(extra)) merged.set(name, value);
    return [...merged].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  capture(headers: Headers): void {
    const lines = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
    for (const line of lines) {
      const pair = line.split(';', 1)[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '' || /max-age=(0|-\d+)/i.test(line)) this.cookies.delete(name);
      else if (this.cookies.size < 30 || this.cookies.has(name)) this.cookies.set(name, value);
    }
  }

  /** A flagged session can keep us blocked; start over with a fresh identity. */
  reset(): void {
    this.cookies.clear();
    for (const [name, value] of DEFAULT_COOKIES) this.cookies.set(name, value);
  }
}

type Failure =
  | { kind: 'blocked'; reason: string; retryAfterMs?: number }
  | { kind: 'error'; reason: string }
  | { kind: 'paused' };

type Fetched = { kind: 'ok'; data: unknown } | { kind: 'not_found' } | Failure;
type Sent = Fetched | { kind: 'challenge'; challenge: WafChallenge };

function failureReason(failure: Failure): string {
  return failure.kind === 'paused' ? 'paused (TikTok circuit open)' : failure.reason;
}

const blocked = (reason: string): Failure => ({ kind: 'blocked', reason });

/**
 * Transport for www.tiktok.com / webcast.tiktok.com: browser-like headers, cookies, throttling, breaker
 * gating and WAF solving. It classifies transport-level outcomes; the breaker itself is updated by the
 * provider once the payload has been interpreted (a 200 without the expected data is a block too).
 */
class TikTokWeb {
  wafSolved = 0;
  private readonly jar = new CookieJar();

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly throttle: Throttle,
    private readonly breaker: BlockBreaker,
  ) {}

  get(url: string, mode: 'json' | 'html', query?: Record<string, string>): Promise<Fetched> {
    return this.throttle.run(async () => {
      if (this.breaker.isOpen()) return { kind: 'paused' } as const;
      const first = await this.send(url, mode, query);
      if (first.kind !== 'challenge') return first;
      const answer = await solveWafChallenge(first.challenge.payload);
      if (!answer) return blocked('WAF challenge could not be solved');
      this.wafSolved++;
      // WAF cookies are single-use (the page's own JS sets Max-Age=1), so they only go on the retry.
      const second = await this.send(url, mode, query, { [first.challenge.cookieName]: answer, ...first.challenge.extraCookies });
      return second.kind === 'challenge' ? blocked('WAF challenge repeated after solving') : second;
    });
  }

  resetIdentity(): void {
    this.jar.reset();
  }

  private async send(url: string, mode: 'json' | 'html', query?: Record<string, string>, oneShotCookies?: Record<string, string>): Promise<Sent> {
    let status = 0;
    const observingFetch: FetchLike = async (input, init) => {
      const res = await this.fetchImpl(input, init);
      status = res.status;
      this.jar.capture(res.headers);
      return res;
    };
    const http = new HttpClient('tiktok', observingFetch, BROWSER_USER_AGENT);
    let data: unknown;
    try {
      const res = await http.request<unknown>(url, {
        query,
        headers: this.headers(url, mode, oneShotCookies),
        timeoutMs: REQUEST_TIMEOUT_MS,
        retries: 1,
        allow404: true,
      });
      if (res.status === 404) return { kind: 'not_found' };
      data = res.data;
    } catch (err) {
      if (err instanceof RateLimitedError) return { kind: 'blocked', reason: 'HTTP 429', retryAfterMs: err.retryAfterMs };
      if (status === 401 || status === 403) return blocked(`HTTP ${status}`);
      return { kind: 'error', reason: errorMessage(err) };
    }
    return classifyBody(data, mode);
  }

  private headers(url: string, mode: 'json' | 'html', oneShotCookies?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      'user-agent': BROWSER_USER_AGENT,
      'accept-language': 'en-US,en;q=0.9,ar;q=0.8',
      referer: `${WEB_BASE}/`,
      'cache-control': 'no-cache',
      pragma: 'no-cache',
      'sec-ch-ua': SEC_CH_UA,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      cookie: this.jar.header(oneShotCookies),
    };
    if (mode === 'json') {
      headers.accept = 'application/json, text/plain, */*';
      headers.origin = WEB_BASE;
      headers['sec-fetch-dest'] = 'empty';
      headers['sec-fetch-mode'] = 'cors';
      headers['sec-fetch-site'] = new URL(url).host === 'www.tiktok.com' ? 'same-origin' : 'same-site';
    } else {
      headers.accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
      headers['sec-fetch-dest'] = 'document';
      headers['sec-fetch-mode'] = 'navigate';
      headers['sec-fetch-site'] = 'same-origin';
      headers['upgrade-insecure-requests'] = '1';
    }
    return headers;
  }
}

function classifyBody(data: unknown, mode: 'json' | 'html'): Sent {
  if (data === null || data === undefined || data === '') return blocked('empty response');
  if (typeof data === 'string') {
    const challenge = findWafChallenge(data);
    if (challenge) return { kind: 'challenge', challenge };
    if (mode === 'html') return { kind: 'ok', data };
    const page = looksLikeHtml(data) ? describeBlockPage(data) : null;
    return blocked(looksLikeHtml(data) ? `HTML instead of JSON${page ? ` (${page})` : ''}` : 'non-JSON response');
  }
  return mode === 'json' ? { kind: 'ok', data } : blocked('JSON instead of HTML');
}

// ───────────────────────────── payload parsing ─────────────────────────────

interface TikTokProfile {
  uniqueId: string | null;
  nickname: string | null;
  avatarUrl: string | null;
  secUid: string | null;
  userId: string | null;
  /** TikTok's blue badge. */
  verifiedBadge: boolean | null;
  privateAccount: boolean | null;
}

interface RoomState {
  /** TikTok room status (2 = live, 4 = ended); null when the payload did not carry one. */
  status: number | null;
  roomId: string | null;
  title: string | null;
  startedAtSec: number | null;
  coverUrl: string | null;
  viewers: number | null;
  tags: string[];
  category: string | null;
  categoryImageUrl: string | null;
  /** Room host's handle (room/info owner.display_id). Differs from the account when it joined someone else's LIVE as a guest. */
  ownerHandle: string | null;
}

const EMPTY_ROOM: RoomState = {
  ownerHandle: null,
  status: null,
  roomId: null,
  title: null,
  startedAtSec: null,
  coverUrl: null,
  viewers: null,
  tags: [],
  category: null,
  categoryImageUrl: null,
};

interface RawVideo {
  id: string;
  desc: string | null;
  cover: string | null;
  playCount: number | null;
  durationSec: number | null;
  isPrivate: boolean;
  /** Fallback publish time when the id does not decode (RSS pubDate). */
  publishedAtMs: number | null;
}

type RoomLookup = { kind: 'room'; profile: TikTokProfile | null; room: RoomState };
type LiveLookup = RoomLookup | { kind: 'never_live' } | Failure;
type LivePageLookup = RoomLookup | Failure;
type RoomInfoLookup = { kind: 'ok'; room: RoomState } | { kind: 'unavailable'; reason: string } | Failure;
type EmbedLookup =
  | { kind: 'ok'; profile: TikTokProfile; videos: RawVideo[] }
  | { kind: 'missing'; code: number }
  | { kind: 'unavailable'; reason: string }
  | Failure;
type ProfileLookup = { kind: 'ok'; profile: TikTokProfile } | { kind: 'missing'; code: number } | Failure;
type OembedLookup = { kind: 'ok'; title: string | null; thumbnailUrl: string | null } | { kind: 'unavailable' } | Failure;

function profileFromUser(user: Json): TikTokProfile {
  return {
    uniqueId: str(user.uniqueId),
    nickname: str(user.nickname),
    avatarUrl: str(user.avatarLarger) ?? str(user.avatarMedium) ?? str(user.avatarThumb) ?? str(user.avatarThumbUrl),
    secUid: str(user.secUid),
    userId: idStr(user.id),
    verifiedBadge: bool(user.verified),
    privateAccount: bool(user.privateAccount) ?? bool(user.secret),
  };
}

function gameNames(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return entries
    .map((entry) => (isRecord(entry) ? (str(entry.show_name) ?? str(entry.full_name) ?? str(entry.tag_name) ?? str(entry.name) ?? str(entry.title)) : null))
    .filter((name): name is string => name !== null);
}

/**
 * TikTok has no Twitch-style category, but rooms carry a LIVE topic (`hashtag`, e.g. "Gaming") and sometimes a
 * game tag. The game wins when present, otherwise the topic is used so post-stream summaries can still group
 * time by what the creator was doing. Field names are undocumented, hence the defensive lookups.
 */
function topicOf(room: Json): Pick<RoomState, 'tags' | 'category' | 'categoryImageUrl'> {
  const topic = isRecord(room.hashtag) ? room.hashtag : isRecord(room.hashTag) ? room.hashTag : null;
  const topicTitle = topic ? str(topic.title) : null;
  const games = gameNames(room.game_tag ?? room.gameTag);
  const game = games[0] ?? null;
  const tags = [...new Set([topicTitle, ...games].filter((t): t is string => t !== null))].slice(0, 10);
  return { tags, category: game ?? topicTitle, categoryImageUrl: game ? null : topic ? firstUrl(topic.image) : null };
}

function roomFromLiveRoom(user: Json, liveRoom: unknown): RoomState {
  const room = isRecord(liveRoom) ? liveRoom : {};
  return {
    status: num(room.status),
    roomId: idStr(user.roomId) ?? idStr(room.roomId),
    title: str(room.title),
    startedAtSec: positive(num(room.startTime)),
    coverUrl: str(room.coverUrl) ?? firstUrl(room.cover),
    viewers: count(num(dig(room, 'liveRoomStats', 'userCount'))),
    ownerHandle: null,
    ...topicOf(room),
  };
}

function parseApiLive(data: unknown): LiveLookup {
  if (!isRecord(data)) return blocked('malformed api-live response');
  const message = str(data.message);
  const statusCode = num(data.statusCode);
  if (message === 'user_not_found' || statusCode === USER_NOT_FOUND_STATUS_CODE) return { kind: 'never_live' };
  if (statusCode !== null && statusCode !== 0) return blocked(`api-live statusCode ${statusCode}${message ? ` (${message})` : ''}`);
  const user = dig(data, 'data', 'user');
  if (!isRecord(user) || Object.keys(user).length === 0) return blocked('api-live response without user data');
  return { kind: 'room', profile: profileFromUser(user), room: roomFromLiveRoom(user, dig(data, 'data', 'liveRoom')) };
}

function parseLivePage(html: string): LivePageLookup {
  const sigi = extractScriptJson(html, 'SIGI_STATE') ?? extractScriptJson(html, 'sigi-persisted-data');
  const info = dig(sigi, 'LiveRoom', 'liveRoomUserInfo');
  if (isRecord(info) && isRecord(info.user)) {
    return { kind: 'room', profile: profileFromUser(info.user), room: roomFromLiveRoom(info.user, info.liveRoom) };
  }
  // Newer markup: the profile's user-detail only carries roomId; room/info then decides the status.
  const user = dig(extractScriptJson(html, '__UNIVERSAL_DATA_FOR_REHYDRATION__'), '__DEFAULT_SCOPE__', 'webapp.user-detail', 'userInfo', 'user');
  if (isRecord(user) && str(user.uniqueId)) {
    return { kind: 'room', profile: profileFromUser(user), room: { ...EMPTY_ROOM, roomId: idStr(user.roomId) } };
  }
  return blocked(describeBlockPage(html) ?? 'live page without SIGI_STATE');
}

function parseRoomInfo(data: unknown): RoomInfoLookup {
  if (!isRecord(data)) return blocked('malformed room info response');
  const statusCode = num(data.status_code) ?? 0;
  const room = isRecord(data.data) ? data.data : null;
  if (statusCode !== 0) {
    const message = room ? str(room.message) : null;
    return { kind: 'unavailable', reason: `room info status_code ${statusCode}${message ? ` (${message})` : ''}` };
  }
  // Age-restricted (18+) rooms answer with only a prompt for anonymous viewers.
  if (!room || 'prompts' in room || Object.keys(room).length <= 1) return { kind: 'unavailable', reason: 'room info restricted' };
  return {
    kind: 'ok',
    room: {
      status: num(room.status),
      roomId: idStr(room.id_str),
      title: str(room.title),
      startedAtSec: positive(num(room.create_time)),
      coverUrl: firstUrl(room.cover),
      viewers: count(num(room.user_count)),
      ownerHandle: str(dig(room, 'owner', 'display_id')),
      ...topicOf(room),
    },
  };
}

function videoFromEmbed(value: unknown): RawVideo | null {
  if (!isRecord(value)) return null;
  const id = idStr(value.id);
  if (!id || !/^\d+$/.test(id)) return null;
  return {
    id,
    desc: str(value.desc),
    cover: str(value.coverUrl) ?? str(value.originCoverUrl) ?? str(value.dynamicCoverUrl),
    playCount: count(num(value.playCount)),
    durationSec: positive(num(value.duration) ?? num(dig(value, 'video', 'duration'))),
    isPrivate: value.privateItem === true,
    publishedAtMs: null,
  };
}

function firstNonZeroCode(...values: unknown[]): number | null {
  for (const value of values) {
    const code = num(value);
    if (code !== null && code !== 0) return code;
  }
  return null;
}

function parseEmbed(html: string, handle: string): EmbedLookup {
  const state = extractScriptJson(html, '__FRONTITY_CONNECT_STATE__');
  if (!isRecord(state)) return blocked(describeBlockPage(html) ?? 'embed page without state');
  const data = dig(state, 'source', 'data');
  if (!isRecord(data)) return { kind: 'error', reason: 'unexpected embed state structure' };
  const key = `/embed/@${handle}`;
  const entries = Object.entries(data);
  const entry =
    data[key] ??
    entries.find(([k]) => k.toLowerCase() === key)?.[1] ??
    entries.find(([k]) => k.toLowerCase().startsWith('/embed/@'))?.[1];
  if (!isRecord(entry)) return { kind: 'error', reason: 'embed state without profile entry' };

  const userInfo = isRecord(entry.userInfo) ? entry.userInfo : null;
  if (userInfo && str(userInfo.uniqueId)) {
    const list = Array.isArray(entry.videoList) ? entry.videoList : [];
    const videos = list.map(videoFromEmbed).filter((v): v is RawVideo => v !== null);
    return { kind: 'ok', profile: profileFromUser(userInfo), videos };
  }
  const code = firstNonZeroCode(userInfo?.code, userInfo?.customErrorCode, userInfo?.statusCode, entry.statusCode, entry.code);
  if (code !== null && USER_MISSING_CODES.has(code)) return { kind: 'missing', code };
  return { kind: 'unavailable', reason: code !== null ? `embed code ${code}` : 'no profile in embed (private account or embedding disabled)' };
}

function parseProfilePage(html: string, handle: string): ProfileLookup {
  const detail = dig(extractScriptJson(html, '__UNIVERSAL_DATA_FOR_REHYDRATION__'), '__DEFAULT_SCOPE__', 'webapp.user-detail');
  if (isRecord(detail)) {
    const user = dig(detail, 'userInfo', 'user');
    if (isRecord(user) && str(user.uniqueId)) return { kind: 'ok', profile: profileFromUser(user) };
    const code = num(detail.statusCode);
    if (code !== null && USER_MISSING_CODES.has(code)) return { kind: 'missing', code };
    if (code === PRIVATE_ACCOUNT_CODE) {
      return {
        kind: 'ok',
        profile: { uniqueId: handle, nickname: null, avatarUrl: null, secUid: null, userId: null, verifiedBadge: null, privateAccount: true },
      };
    }
    return blocked(`profile page statusCode ${code ?? 'missing'}`);
  }
  const users = dig(extractScriptJson(html, 'SIGI_STATE'), 'UserModule', 'users');
  const sigiUser = isRecord(users) ? (users[handle] ?? Object.values(users)[0]) : undefined;
  if (isRecord(sigiUser) && str(sigiUser.uniqueId)) return { kind: 'ok', profile: profileFromUser(sigiUser) };
  return blocked(describeBlockPage(html) ?? 'profile page without user data');
}

function parseOembed(data: unknown): OembedLookup {
  if (!isRecord(data)) return blocked('malformed oEmbed response');
  return { kind: 'ok', title: cleanTitle(str(data.title)), thumbnailUrl: str(data.thumbnail_url) };
}

const rssParser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
  isArray: (name) => name === 'item',
});

/** Parses RSSHub's /tiktok/user/@handle feed (titles are captions, links are video URLs). */
function parseRssVideos(xml: string): RawVideo[] {
  let doc: unknown;
  try {
    doc = rssParser.parse(xml);
  } catch (err) {
    throw new ProviderError('tiktok', `RSSHub returned invalid XML: ${errorMessage(err)}`, true);
  }
  const channel = dig(doc, 'rss', 'channel');
  if (!isRecord(channel)) throw new ProviderError('tiktok', 'RSSHub response is not an RSS feed', true);
  const items = Array.isArray(channel.item) ? channel.item : [];
  return items.flatMap((item): RawVideo[] => {
    if (!isRecord(item)) return [];
    const link = str(item.link) ?? str(item.guid);
    const id = link ? /\/video\/(\d+)/.exec(link)?.[1] : undefined;
    if (!id) return [];
    const description = str(item.description) ?? '';
    const poster = /\sposter=["']([^"']+)["']/i.exec(description)?.[1] ?? /<img\b[^>]*?\ssrc=["']([^"']+)["']/i.exec(description)?.[1];
    const pubDate = str(item.pubDate);
    const publishedAtMs = pubDate ? Date.parse(pubDate) : NaN;
    return [
      {
        id,
        desc: str(item.title),
        cover: poster ? decodeHtmlEntities(poster) : null,
        playCount: null,
        durationSec: null,
        isPrivate: false,
        publishedAtMs: Number.isFinite(publishedAtMs) ? publishedAtMs : null,
      },
    ];
  });
}

function roomVerdict(room: RoomState): 'live' | 'offline' | 'unknown' {
  if (room.status !== null) {
    if (LIVE_STATUSES.has(room.status)) return 'live';
    return room.status === ENDED_STATUS ? 'offline' : 'unknown';
  }
  // A known user without any room cannot be live; with a room id, room/info has to decide.
  return room.roomId ? 'unknown' : 'offline';
}

function mergeRoom(base: RoomState, fresh: RoomState): RoomState {
  return {
    status: fresh.status ?? base.status,
    roomId: base.roomId ?? fresh.roomId,
    title: fresh.title ?? base.title,
    startedAtSec: fresh.startedAtSec ?? base.startedAtSec,
    coverUrl: fresh.coverUrl ?? base.coverUrl,
    viewers: fresh.viewers ?? base.viewers,
    tags: fresh.tags.length ? fresh.tags : base.tags,
    category: fresh.category ?? base.category,
    categoryImageUrl: fresh.category ? fresh.categoryImageUrl : base.categoryImageUrl,
    ownerHandle: fresh.ownerHandle ?? base.ownerHandle,
  };
}

// ───────────────────────────── Euler Stream (optional) ─────────────────────────────

type EulerResult = { kind: 'ok'; isLive: boolean; roomId: string | null; roomStatus: number | null } | { kind: 'error'; reason: string };

/**
 * Euler Stream's documented `GET /webcast/anchors/{unique_id}/room_id` (x-api-key). Used only as a fallback
 * because the free plan has a small daily quota.
 */
class EulerClient {
  /** Arabic, shown on the dashboard. */
  lastError: string | null = null;
  lastOkAt: number | null = null;
  private pausedUntil = 0;

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike,
    private readonly now: () => number,
    private readonly logger: Logger,
  ) {}

  async liveStatus(handle: string): Promise<EulerResult> {
    if (this.now() < this.pausedUntil) return { kind: 'error', reason: 'Euler fallback paused' };
    let status = 0;
    const observingFetch: FetchLike = async (input, init) => {
      const res = await this.fetchImpl(input, init);
      status = res.status;
      return res;
    };
    const http = new HttpClient('tiktok', observingFetch, BOT_USER_AGENT);
    let body: unknown;
    try {
      body = await http.getJson<unknown>(`${EULER_BASE}/webcast/anchors/${encodeURIComponent(handle)}/room_id`, {
        headers: { 'x-api-key': this.apiKey },
        timeoutMs: EULER_TIMEOUT_MS,
        retries: 1,
      });
    } catch (err) {
      if (err instanceof RateLimitedError) return this.pause(err.retryAfterMs, 'تجاوزنا حد الطلبات المسموح في Euler Stream، بنرجع نستخدمه بعد شوي.');
      if (status === 401 || status === 402 || status === 403) return this.rejectKey(status);
      this.lastError = `تعذّر الاتصال بـ Euler Stream: ${errorMessage(err)}`;
      return { kind: 'error', reason: errorMessage(err) };
    }
    if (isRecord(body) && body.ok === true && typeof body.is_live === 'boolean') {
      this.lastOkAt = this.now();
      this.lastError = null;
      return { kind: 'ok', isLive: body.is_live, roomId: idStr(body.room_id), roomStatus: num(body.room_status) };
    }
    const code = isRecord(body) ? num(body.code) : null;
    if (code === 401 || code === 402 || code === 403) return this.rejectKey(code);
    const message = (isRecord(body) ? str(body.message) : null) ?? 'unexpected response';
    this.lastError = `Euler Stream ما عطى نتيجة واضحة: ${message}`;
    return { kind: 'error', reason: `Euler: ${message}` };
  }

  private rejectKey(status: number): EulerResult {
    return this.pause(EULER_AUTH_PAUSE_MS, `مفتاح Euler Stream مرفوض أو خطتك ما تشمل خدمة room_id (HTTP ${status}).`);
  }

  private pause(ms: number, arabicReason: string): EulerResult {
    this.pausedUntil = this.now() + ms;
    this.lastError = arabicReason;
    this.logger.warn({ pauseMin: Math.round(ms / MINUTE) }, 'Euler Stream fallback paused');
    return { kind: 'error', reason: 'Euler unavailable' };
  }
}

// ───────────────────────────── provider ─────────────────────────────

export interface TikTokProviderOptions {
  now?: () => number;
  random?: () => number;
  /** Used for the gap between requests (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** Randomised gap between consecutive TikTok requests; capped at 1.5 s. Defaults to 400–1200 ms. */
  minRequestGapMs?: number;
  maxRequestGapMs?: number;
}

type ProfileSource = 'embed' | 'api-live' | 'profile' | 'unverified';

export class TikTokProvider implements PlatformProvider {
  readonly platform = 'tiktok' as const;
  readonly capabilities: ProviderCapabilities = { live: true, content: [...TIKTOK_CONTENT_KINDS], liveBatchSize: 1, push: false };

  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly fetchImpl: FetchLike;
  private readonly breaker: BlockBreaker;
  private readonly web: TikTokWeb;
  private readonly euler: EulerClient | null;
  private readonly rsshubUrl: string | null;
  private readonly kv: SafeKv;
  private readonly lastLiveAt = new Map<string, number>();
  private readonly neverLiveCheckedAt = new Map<string, number>();
  private readonly oembedCache = new Map<string, { title: string | null; thumbnailUrl: string | null }>();
  private readonly warnedAt = new Map<string, number>();
  /** Accounts whose videos can't be listed: gone (renamed/deleted) or hidden (private / embedding disabled). */
  private readonly contentIssues = new Map<string, 'gone' | 'hidden'>();
  private lastLiveOkAt: number | null = null;
  private lastLiveError: string | null = null;
  private lastContentOkAt: number | null = null;
  private lastContentError: string | null = null;

  constructor(ctx: ProviderContext, options: TikTokProviderOptions = {}) {
    this.logger = ctx.logger;
    this.now = options.now ?? Date.now;
    this.fetchImpl = ctx.fetch ?? globalThis.fetch.bind(globalThis);

    const maxGap = Math.min(MAX_GAP_MS, Math.max(0, options.maxRequestGapMs ?? DEFAULT_MAX_GAP_MS));
    const minGap = Math.min(maxGap, Math.max(0, options.minRequestGapMs ?? DEFAULT_MIN_GAP_MS));
    const throttle = new Throttle(minGap, maxGap, this.now, options.random ?? Math.random, options.sleep ?? sleepMs);

    this.kv = new SafeKv(ctx.kv, this.logger);
    this.breaker = new BlockBreaker(this.kv, this.now, this.logger);
    this.loadLastLive();
    this.web = new TikTokWeb(this.fetchImpl, throttle, this.breaker);
    this.breaker.onTrip = () => this.web.resetIdentity();

    const eulerKey = ctx.config.TIKTOK_SIGN_API_KEY;
    this.euler = eulerKey ? new EulerClient(eulerKey, this.fetchImpl, this.now, this.logger) : null;
    this.rsshubUrl = ctx.config.RSSHUB_URL ? ctx.config.RSSHUB_URL.replace(/\/+$/, '') : null;
  }

  isConfigured(): boolean {
    return true;
  }

  health(): ProviderHealth {
    const now = this.now();
    const notes = [
      'تيك توك ما عنده API رسمي لحالة البث أو قائمة المقاطع، فالبوت يقرأ صفحات تيك توك العامة (طريقة غير رسمية). ممكن تتأخر الإشعارات أو تتوقف مؤقتاً إذا حجب تيك توك السيرفر، وترجع تلقائياً بعدها.',
    ];

    const breaker = this.breaker.snapshot();
    if (this.breaker.isOpen()) {
      const minutes = Math.max(1, Math.ceil(this.breaker.remainingMs() / MINUTE));
      const viaEuler = this.euler ? ' فحص البث شغال حالياً عن طريق Euler Stream.' : '';
      notes.push(`تيك توك حاجب طلبات السيرفر حالياً (${breaker.lastReason ?? 'سبب غير معروف'}). وقّفنا الطلبات مؤقتاً وبنرجع نحاول بعد ${minutes} دقيقة تقريباً.${viaEuler}`);
    } else if (breaker.trips > 0) {
      notes.push('تيك توك كان حاجب السيرفر، والحين نتحقق إذا انرفع الحظر.');
    } else if (breaker.consecutiveBlocks > 0) {
      notes.push(`آخر ${breaker.consecutiveBlocks} طلب لتيك توك انحجب (${breaker.lastReason ?? 'سبب غير معروف'}). إذا وصلنا ${BLOCK_THRESHOLD} بنوقف الطلبات مؤقتاً.`);
    } else {
      notes.push('ما فيه حظر من تيك توك حالياً.');
    }

    if (this.lastLiveOkAt !== null) notes.push(`آخر فحص بث ناجح: ${new Date(this.lastLiveOkAt).toISOString()}`);
    if (this.lastLiveError) notes.push(`آخر فحص بث فشل: ${this.lastLiveError}`);
    if (this.lastContentOkAt !== null) notes.push(`آخر جلب مقاطع ناجح: ${new Date(this.lastContentOkAt).toISOString()}`);
    if (this.lastContentError) notes.push(`آخر جلب مقاطع فشل: ${this.lastContentError}`);
    if (this.web.wafSolved > 0) notes.push(`تم تجاوز تحدي الحماية (WAF) تلقائياً ${this.web.wafSolved} مرة.`);
    const accounts = (issue: 'gone' | 'hidden') =>
      [...this.contentIssues].filter(([, value]) => value === issue).map(([handle]) => `@${handle}`).slice(0, 10).join('، ');
    if (accounts('gone')) notes.push(`تيك توك يقول إن هالحسابات غير موجودة (يمكن غيّروا اليوزر أو انحذفت): ${accounts('gone')}`);
    if (accounts('hidden')) notes.push(`ما نقدر نقرأ مقاطع هالحسابات (الحساب خاص أو مقفل خاصية التضمين): ${accounts('hidden')}`);

    if (this.euler) {
      notes.push('Euler Stream مفعّل كاحتياطي لفحص البث، ويشتغل حتى لو تيك توك حاجب السيرفر.');
      if (this.euler.lastError) notes.push(`Euler Stream: ${this.euler.lastError}`);
    } else {
      notes.push('اختياري: أضف TIKTOK_SIGN_API_KEY (مفتاح Euler Stream) عشان يستمر فحص البث حتى لو تيك توك حجب السيرفر.');
    }
    notes.push(
      this.rsshubUrl
        ? `RSSHub مفعّل كاحتياطي لجلب المقاطع (${this.rsshubUrl}).`
        : 'اختياري: شغّل RSSHub وحط رابطه في RSSHUB_URL كاحتياطي لجلب مقاطع تيك توك.',
    );
    notes.push('تيك توك ما ينشر تسجيلات البث (VOD) للعامة، فإشعارات المحتوى تشمل الفيديوهات فقط.');
    if (breaker.lastBlockAt !== null && breaker.consecutiveBlocks === 0 && breaker.trips === 0 && now - breaker.lastBlockAt < DAY_MS) {
      notes.push(`آخر حظر من تيك توك كان ${new Date(breaker.lastBlockAt).toISOString()} (${breaker.lastReason ?? ''}).`);
    }
    return { configured: true, notes };
  }

  // ─────────── resolve ───────────

  async resolveChannel(input: string): Promise<ResolvedChannel> {
    const parsed = parseTikTokInput(input);
    const handle = parsed.kind === 'handle' ? parsed.handle : await this.expandShortLink(parsed.url);
    const { profile, source } = await this.lookupProfile(handle);
    const uniqueId = normalizeTikTokHandle(profile?.uniqueId ?? '') ?? handle;

    // `verified` means "TikTok confirmed this account exists"; the blue badge is `verifiedBadge`.
    const meta: Record<string, unknown> = { verified: source !== 'unverified', source };
    if (profile?.secUid) meta.secUid = profile.secUid;
    if (profile?.userId) meta.userId = profile.userId;
    if (profile?.verifiedBadge !== null && profile?.verifiedBadge !== undefined) meta.verifiedBadge = profile.verifiedBadge;
    if (profile?.privateAccount !== null && profile?.privateAccount !== undefined) meta.privateAccount = profile.privateAccount;

    return {
      platform: 'tiktok',
      platformId: uniqueId,
      handle: uniqueId,
      displayName: profile?.nickname ?? uniqueId,
      avatarUrl: profile?.avatarUrl ?? null,
      url: profileUrl(uniqueId),
      meta,
    };
  }

  /**
   * Only an explicit "this user does not exist" from TikTok rejects the account. When TikTok blocks us we
   * still accept it (unverified) so the admin is never stuck; the monitor will verify it on the next checks.
   */
  private async lookupProfile(handle: string): Promise<{ profile: TikTokProfile | null; source: ProfileSource }> {
    if (this.breaker.isOpen()) {
      this.logger.info({ handle }, 'TikTok circuit open; accepting account without verification');
      return { profile: null, source: 'unverified' };
    }

    const embed = await this.embedPage(handle);
    if (embed.kind === 'ok') return { profile: embed.profile, source: 'embed' };
    const embedSaysMissing = embed.kind === 'missing';

    const live = await this.apiLive(handle);
    if (live.kind === 'room' && live.profile?.uniqueId) return { profile: live.profile, source: 'api-live' };
    // api-live's user_not_found alone only means "never went live"; together with the embed's code it is conclusive.
    if (embedSaysMissing && live.kind === 'never_live') throw new ChannelNotFoundError('tiktok', `@${handle}`);

    const page = await this.profilePage(handle);
    if (page.kind === 'ok') return { profile: page.profile, source: 'profile' };
    if (page.kind === 'missing' || embedSaysMissing) throw new ChannelNotFoundError('tiktok', `@${handle}`);

    this.logger.warn(
      { handle, embed: embed.kind, apiLive: live.kind, profilePage: failureReason(page) },
      'Could not verify TikTok account (TikTok is blocking us); accepting it unverified',
    );
    return { profile: null, source: 'unverified' };
  }

  /** Short links need one redirect lookup; this is the only call that must not follow redirects automatically. */
  private async expandShortLink(url: string): Promise<string> {
    let current = url;
    try {
      for (let hop = 0; hop < 5; hop++) {
        const res = await this.fetchImpl(current, {
          method: 'GET',
          redirect: 'manual',
          headers: { 'user-agent': BROWSER_USER_AGENT, accept: 'text/html,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9' },
          signal: AbortSignal.timeout(SHORT_LINK_TIMEOUT_MS),
        });
        await res.body?.cancel().catch(() => undefined);
        const location = res.headers.get('location');
        if (res.status < 300 || res.status >= 400 || !location) break;
        const next = new URL(location, current);
        const handle = handleFromPath(next.pathname);
        if (handle) return handle;
        current = next.toString();
      }
    } catch (err) {
      this.logger.debug({ url, err: errorMessage(err) }, 'TikTok short link lookup failed');
    }
    throw new ValidationError('ما قدرت أفتح الرابط المختصر. أرسل رابط الحساب نفسه أو اليوزر (مثل @username).', 'handle');
  }

  // ─────────── live ───────────

  async checkLive(channels: ChannelRef[]): Promise<LiveSnapshot[]> {
    const snapshots: LiveSnapshot[] = [];
    const errors: unknown[] = [];
    for (const channel of channels) {
      try {
        snapshots.push(await this.checkOne(channel));
      } catch (err) {
        errors.push(err);
      }
    }
    if (errors.length === 0) {
      this.lastLiveOkAt = this.now();
      this.lastLiveError = null;
      return snapshots;
    }
    const first = errors[0];
    this.lastLiveError = errorMessage(first);
    // One unknown result poisons the batch: reporting it as offline would end a live session by mistake.
    if (errors.length === 1 && first instanceof ProviderError) throw first;
    throw new ProviderError('tiktok', `Live check failed for ${errors.length}/${channels.length} channels: ${errors.map(errorMessage).join(' | ')}`, true);
  }

  private async checkOne(channel: ChannelRef): Promise<LiveSnapshot> {
    const handle = this.handleOf(channel);
    const failures: string[] = [];
    let livePageTried = false;

    if (!this.breaker.isOpen()) {
      const primary = await this.apiLive(handle);
      if (primary.kind === 'never_live') {
        livePageTried = this.shouldConfirmNeverLive(handle);
        const confirmed = await this.confirmNeverLive(channel, handle, livePageTried);
        if (confirmed) return confirmed;
        failures.push('api-live: user_not_found contradicts a recent live observation');
      } else if (primary.kind === 'room') {
        const snapshot = await this.snapshotFromRoom(channel, handle, primary);
        if (snapshot) return snapshot;
        failures.push(`api-live: ambiguous room status ${primary.room.status ?? 'null'}`);
      } else {
        failures.push(`api-live: ${failureReason(primary)}`);
      }
    }

    if (!livePageTried && !this.breaker.isOpen()) {
      const page = await this.livePage(handle);
      if (page.kind === 'room') {
        const snapshot = await this.snapshotFromRoom(channel, handle, page);
        if (snapshot) return snapshot;
        failures.push(`live page: ambiguous room status ${page.room.status ?? 'null'}`);
      } else {
        failures.push(`live page: ${failureReason(page)}`);
      }
    }

    if (this.euler) {
      const viaEuler = await this.checkViaEuler(this.euler, channel, handle);
      if (typeof viaEuler !== 'string') return viaEuler;
      failures.push(`euler: ${viaEuler}`);
    }

    if (this.breaker.isOpen()) {
      this.logger.debug({ handle, failures }, 'TikTok live check skipped: circuit open');
      throw new RateLimitedError('tiktok', Math.max(1_000, this.breaker.remainingMs()));
    }
    throw new ProviderError('tiktok', `Live status unknown for @${handle} (${failures.join('; ')})`, true);
  }

  private shouldConfirmNeverLive(handle: string): boolean {
    if (this.wasRecentlyLive(handle)) return true;
    // The first user_not_found this process sees (e.g. right after a restart) is cross-checked immediately;
    // confirmNeverLive records the check, so later ones are cross-checked every NEVER_LIVE_RECHECK_MS.
    const lastCheck = this.neverLiveCheckedAt.get(handle);
    return lastCheck === undefined || this.now() - lastCheck >= NEVER_LIVE_RECHECK_MS;
  }

  /** Returns the verdict for a user_not_found answer, or null when it contradicts recent evidence and stays unconfirmed. */
  private async confirmNeverLive(channel: ChannelRef, handle: string, crossCheck: boolean): Promise<LiveSnapshot | null> {
    if (!crossCheck) return this.offline(channel, handle);
    this.neverLiveCheckedAt.set(handle, this.now());
    if (!this.breaker.isOpen()) {
      const page = await this.livePage(handle);
      if (page.kind === 'room') {
        const snapshot = await this.snapshotFromRoom(channel, handle, page);
        if (snapshot) return snapshot;
      }
    }
    if (this.wasRecentlyLive(handle)) return null;
    return this.offline(channel, handle);
  }

  private async snapshotFromRoom(channel: ChannelRef, handle: string, lookup: RoomLookup): Promise<LiveSnapshot | null> {
    let room = lookup.room;
    let verdict = roomVerdict(room);
    if (verdict !== 'offline' && room.roomId) {
      const info = await this.roomInfo(room.roomId);
      if (info.kind === 'ok') {
        // room/info is the freshest source (api-live and the page can lag behind a stream that just ended).
        const fresh = roomVerdict({ ...info.room, roomId: info.room.roomId ?? room.roomId });
        if (fresh !== 'unknown') verdict = fresh;
        room = mergeRoom(room, info.room);
      } else {
        this.logger.debug({ handle, roomId: room.roomId, reason: info.kind === 'unavailable' ? info.reason : failureReason(info) }, 'TikTok room info unavailable');
      }
    }
    if (room.ownerHandle && normalizeTikTokHandle(room.ownerHandle) !== handle) {
      // The account's room id points at another creator's LIVE: it is a guest there, not streaming itself.
      this.logger.debug({ handle, host: room.ownerHandle, roomId: room.roomId }, 'TikTok account is a guest in another LIVE');
      return this.offline(channel, handle);
    }
    if (verdict === 'unknown' && room.status === PAUSED_STATUS && this.wasRecentlyLive(handle)) verdict = 'live';
    if (verdict === 'live') return this.liveSnapshot(channel, handle, room, lookup.profile);
    if (verdict === 'offline') return this.offline(channel, handle);
    return null;
  }

  private wasRecentlyLive(handle: string): boolean {
    const lastLive = this.lastLiveAt.get(handle);
    return lastLive !== undefined && this.now() - lastLive < CONTRADICTION_WINDOW_MS;
  }

  /** Loads the persisted last-live times, dropping the ones already outside the contradiction window. */
  private loadLastLive(): void {
    const stored = this.kv.get<Record<string, unknown>>(KV_LAST_LIVE);
    if (!isRecord(stored)) return;
    const now = this.now();
    for (const [handle, value] of Object.entries(stored)) {
      const at = num(value);
      if (at !== null && now - at < CONTRADICTION_WINDOW_MS) this.lastLiveAt.set(handle, at);
    }
  }

  private markLive(handle: string, now: number): void {
    this.lastLiveAt.set(handle, now);
    const record: Record<string, number> = {};
    for (const [key, at] of this.lastLiveAt) {
      if (now - at < CONTRADICTION_WINDOW_MS) record[key] = at;
      else this.lastLiveAt.delete(key);
    }
    this.kv.set(KV_LAST_LIVE, record);
  }

  private async checkViaEuler(euler: EulerClient, channel: ChannelRef, handle: string): Promise<LiveSnapshot | string> {
    const result = await euler.liveStatus(handle);
    if (result.kind === 'error') return result.reason;
    if (!result.isLive) return this.offline(channel, handle);
    // is_live alone is not proof: the direct path's status-2 and room-owner (guest) rules apply here too.
    // Only a missing room_status falls back to Euler's own verdict (status 2).
    const room: RoomState = { ...EMPTY_ROOM, status: result.roomStatus ?? 2, roomId: result.roomId };
    const snapshot = await this.snapshotFromRoom(channel, handle, { kind: 'room', profile: null, room });
    return snapshot ?? `ambiguous room status ${room.status ?? 'null'}`;
  }

  private liveSnapshot(channel: ChannelRef, handle: string, room: RoomState, profile: TikTokProfile | null): LiveSnapshot {
    const now = this.now();
    this.markLive(handle, now);
    this.neverLiveCheckedAt.delete(handle);
    return {
      platform: 'tiktok',
      platformId: channel.platformId,
      isLive: true,
      streamId: room.roomId,
      title: room.title,
      category: room.category,
      categoryImageUrl: room.categoryImageUrl,
      // TikTok room covers are static, signed CDN URLs; a cache-buster param could break the signature.
      thumbnailUrl: room.coverUrl ?? profile?.avatarUrl ?? null,
      viewers: room.viewers,
      startedAt: secondsToIso(room.startedAtSec, now),
      url: liveUrl(handle),
      language: null,
      tags: room.tags,
    };
  }

  private offline(channel: ChannelRef, handle: string): LiveSnapshot {
    return offlineSnapshot(channel, liveUrl(handle));
  }

  // ─────────── content ───────────

  async fetchRecentContent(channel: ChannelRef, kinds: ContentKind[]): Promise<ContentItem[]> {
    if (!kinds.includes('video')) return [];
    const handle = this.handleOf(channel);
    const failures: string[] = [];
    let paused = this.breaker.isOpen();

    if (!paused) {
      const embed = await this.embedPage(handle);
      switch (embed.kind) {
        case 'ok':
          this.contentIssues.delete(handle);
          return this.toContent(channel, handle, embed.videos);
        case 'missing':
          this.markContentOk();
          this.contentIssues.set(handle, 'gone');
          this.warnOnce(`missing:${handle}`, { handle, code: embed.code }, 'TikTok says this account no longer exists (renamed or deleted?)');
          return [];
        case 'unavailable':
          // RSSHub reads the same embed, so there is nothing else to try.
          this.markContentOk();
          this.contentIssues.set(handle, 'hidden');
          this.warnOnce(`embed:${handle}`, { handle, reason: embed.reason }, 'TikTok videos unavailable for this account');
          return [];
        case 'paused':
          paused = true;
          break;
        default:
          failures.push(`embed: ${embed.reason}`);
      }
    }

    if (this.rsshubUrl) {
      try {
        return await this.toContent(channel, handle, await this.fetchRsshub(handle));
      } catch (err) {
        failures.push(`rsshub: ${errorMessage(err)}`);
      }
    }

    if (paused || this.breaker.isOpen()) {
      this.logger.debug({ handle, failures }, 'TikTok content check skipped: circuit open');
      return [];
    }
    const message = `Could not list TikTok videos for @${handle} (${failures.join('; ')})`;
    this.lastContentError = message;
    throw new ProviderError('tiktok', message, true);
  }

  private async toContent(channel: ChannelRef, handle: string, videos: RawVideo[]): Promise<ContentItem[]> {
    const seen = new Set<string>();
    const untitled = new Set<string>();
    const items: ContentItem[] = [];
    for (const video of videos) {
      if (video.isPrivate || seen.has(video.id)) continue;
      seen.add(video.id);
      const published = tiktokIdToDate(video.id) ?? (video.publishedAtMs !== null ? new Date(video.publishedAtMs) : null);
      if (!published) continue;
      const title = cleanTitle(video.desc);
      if (!title) untitled.add(video.id);
      items.push({
        platform: 'tiktok',
        platformId: channel.platformId,
        contentId: video.id,
        kind: 'video',
        title: title ?? DEFAULT_VIDEO_TITLE,
        url: videoUrl(handle, video.id),
        thumbnailUrl: video.cover,
        publishedAt: published.toISOString(),
        durationSec: video.durationSec,
        viewCount: video.playCount,
        relatedStreamId: null,
      });
    }
    // The embed lists pinned videos first; consumers expect newest first.
    items.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
    const recent = items.slice(0, MAX_VIDEOS);
    await this.enrichWithOembed(recent, untitled);
    this.markContentOk();
    return recent;
  }

  /** oEmbed can't discover videos, but it fills in a caption/thumbnail the listing lacked. Each video is asked once. */
  private async enrichWithOembed(items: ContentItem[], untitled: Set<string>): Promise<void> {
    const targets = items.filter((item) => (untitled.has(item.contentId) || !item.thumbnailUrl) && !this.oembedCache.has(item.contentId)).slice(0, OEMBED_PER_CALL);
    for (const item of targets) {
      if (this.breaker.isOpen()) break;
      const res = await this.web.get(`${WEB_BASE}/oembed`, 'json', { url: item.url });
      const result = this.settle<OembedLookup>(res.kind === 'ok' ? parseOembed(res.data) : res.kind === 'not_found' ? { kind: 'unavailable' } : res);
      if (result.kind === 'ok') this.rememberOembed(item.contentId, { title: result.title, thumbnailUrl: result.thumbnailUrl });
      else if (result.kind === 'unavailable') this.rememberOembed(item.contentId, { title: null, thumbnailUrl: null });
    }
    for (const item of items) {
      const cached = this.oembedCache.get(item.contentId);
      if (!cached) continue;
      if (untitled.has(item.contentId) && cached.title) item.title = cached.title;
      if (!item.thumbnailUrl && cached.thumbnailUrl) item.thumbnailUrl = cached.thumbnailUrl;
    }
  }

  private rememberOembed(id: string, value: { title: string | null; thumbnailUrl: string | null }): void {
    if (this.oembedCache.size >= OEMBED_CACHE_SIZE) {
      const oldest = this.oembedCache.keys().next().value;
      if (oldest !== undefined) this.oembedCache.delete(oldest);
    }
    this.oembedCache.set(id, value);
  }

  private async fetchRsshub(handle: string): Promise<RawVideo[]> {
    const http = new HttpClient('tiktok', this.fetchImpl, BOT_USER_AGENT);
    const xml = await http.getText(`${this.rsshubUrl}/tiktok/user/@${encodeURIComponent(handle)}`, {
      headers: { accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5' },
      timeoutMs: RSSHUB_TIMEOUT_MS,
      retries: 1,
    });
    return parseRssVideos(xml);
  }

  // ─────────── endpoints ───────────

  private async apiLive(handle: string): Promise<LiveLookup> {
    const res = await this.web.get(`${WEB_BASE}/api-live/user/room/`, 'json', { aid: AID, sourceType: '54', uniqueId: handle });
    return this.settle<LiveLookup>(res.kind === 'ok' ? parseApiLive(res.data) : res.kind === 'not_found' ? { kind: 'error', reason: 'api-live HTTP 404' } : res);
  }

  private async livePage(handle: string): Promise<LivePageLookup> {
    const res = await this.web.get(liveUrl(handle), 'html');
    return this.settle<LivePageLookup>(
      res.kind === 'ok' ? parseLivePage(String(res.data)) : res.kind === 'not_found' ? { kind: 'error', reason: 'live page HTTP 404' } : res,
    );
  }

  private async roomInfo(roomId: string): Promise<RoomInfoLookup> {
    const res = await this.web.get(`${WEBCAST_BASE}/room/info/`, 'json', { aid: AID, room_id: roomId });
    return this.settle<RoomInfoLookup>(res.kind === 'ok' ? parseRoomInfo(res.data) : res.kind === 'not_found' ? { kind: 'unavailable', reason: 'room info HTTP 404' } : res);
  }

  private async embedPage(handle: string): Promise<EmbedLookup> {
    const res = await this.web.get(`${WEB_BASE}/embed/@${encodeURIComponent(handle)}`, 'html');
    return this.settle<EmbedLookup>(
      res.kind === 'ok' ? parseEmbed(String(res.data), handle) : res.kind === 'not_found' ? { kind: 'unavailable', reason: 'embed HTTP 404' } : res,
    );
  }

  private async profilePage(handle: string): Promise<ProfileLookup> {
    const res = await this.web.get(profileUrl(handle), 'html');
    return this.settle<ProfileLookup>(
      res.kind === 'ok' ? parseProfilePage(String(res.data), handle) : res.kind === 'not_found' ? { kind: 'error', reason: 'profile page HTTP 404' } : res,
    );
  }

  /** Feeds the interpreted outcome of one request into the breaker: blocks count, conclusive answers reset it. */
  private settle<T extends { kind: string }>(result: T): T {
    const outcome = result as { kind: string; reason?: string; retryAfterMs?: number };
    if (outcome.kind === 'blocked') this.breaker.recordBlock(outcome.reason ?? 'blocked', outcome.retryAfterMs ?? 0);
    else if (outcome.kind !== 'error' && outcome.kind !== 'paused') this.breaker.recordSuccess();
    return result;
  }

  // ─────────── misc ───────────

  private handleOf(channel: ChannelRef): string {
    return normalizeTikTokHandle(channel.handle) ?? normalizeTikTokHandle(channel.platformId) ?? channel.platformId.trim().toLowerCase();
  }

  private markContentOk(): void {
    this.lastContentOkAt = this.now();
    this.lastContentError = null;
  }

  private warnOnce(key: string, context: Record<string, unknown>, message: string): void {
    const now = this.now();
    const last = this.warnedAt.get(key);
    if (last !== undefined && now - last < WARN_INTERVAL_MS) return;
    this.warnedAt.set(key, now);
    this.logger.warn(context, message);
  }
}

export const createTikTokProvider: ProviderFactory = (ctx) => new TikTokProvider(ctx);
