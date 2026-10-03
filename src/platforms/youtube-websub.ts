/**
 * YouTube WebSub (PubSubHubbub) push adapter, plus the Atom parser shared with the RSS poller.
 *
 * Google's hub is best effort: pushes can be late, duplicated or missing, old videos are re-pushed after
 * edits, and leases silently lapse. Pushes are therefore only hints that speed up discovery; the provider's
 * RSS/API polling stays the source of truth.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { errorMessage } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import type { ChannelRef } from '../core/types.js';
import type { FetchLike } from './http.js';
import type { KeyValueStore, PushHint, WebhookAdapter, WebhookRequest, WebhookResponse } from './types.js';

export const YOUTUBE_WEBSUB_PATH = '/webhooks/youtube';
export const DEFAULT_HUB_URL = 'https://pubsubhubbub.appspot.com/subscribe';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** We ask for 10 days; Google typically grants 5-10. */
const REQUESTED_LEASE_SECONDS = 864_000;
/** Assumed when a verification request omits hub.lease_seconds. */
const FALLBACK_LEASE_SECONDS = 432_000;
/** Renew once less than this fraction of the granted lease is left. */
const RENEW_WHEN_REMAINING = 0.25;
/** A subscription the hub never verified within this window is treated as failed (callback unreachable?). */
const VERIFY_TIMEOUT_MS = 15 * MINUTE;
/** Verification GETs are only accepted this long after we sent the matching request (hub queues can be slow). */
const VERIFY_ACCEPT_WINDOW_MS = HOUR;
/** How long we wait for the hub to confirm an unsubscribe before forgetting the channel anyway. */
const UNSUBSCRIBE_GRACE_MS = 24 * HOUR;
const FAILURE_BACKOFF_BASE_MS = 5 * MINUTE;
const FAILURE_BACKOFF_MAX_MS = 6 * HOUR;
const DEFAULT_HUB_RETRY_AFTER_MS = 10 * MINUTE;
const MAX_HUB_RETRY_AFTER_MS = 12 * HOUR;
/** Spread large channel sets over several sync() calls instead of bursting the hub. */
const MAX_HUB_REQUESTS_PER_SYNC = 40;
const HUB_TIMEOUT_MS = 15_000;
/** Pushes for videos published longer ago than this are edits of old videos, not uploads (ytnoti rule). */
const STALE_ENTRY_MS = 30 * MINUTE;
const MAX_CHALLENGE_LENGTH = 1024;
/** Google limits hub.secret to 200 bytes. */
const MAX_HUB_SECRET_BYTES = 200;
const RECENT_PUSH_CACHE = 2_000;

const KV_INDEX = 'youtube:websub:index';
const kvKey = (channelId: string) => `youtube:websub:${channelId}`;

const CHANNEL_ID_RE = /^UC[\w-]{22}$/;
const VIDEO_ID_RE = /^[\w-]{11}$/;

export const isYouTubeChannelId = (value: unknown): value is string => typeof value === 'string' && CHANNEL_ID_RE.test(value);
export const isYouTubeVideoId = (value: unknown): value is string => typeof value === 'string' && VIDEO_ID_RE.test(value);

export function websubTopic(channelId: string): string {
  return `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channelId}`;
}

/** Channel id of a hub topic URL we could have subscribed to, or null. */
export function channelIdFromTopic(topic: string): string | null {
  try {
    const url = new URL(topic);
    const host = url.hostname.toLowerCase();
    if (host !== 'www.youtube.com' && host !== 'youtube.com') return null;
    if (url.pathname !== '/xml/feeds/videos.xml' && url.pathname !== '/feeds/videos.xml') return null;
    const id = url.searchParams.get('channel_id');
    return isYouTubeChannelId(id) ? id : null;
  } catch {
    return null;
  }
}

// ───────────────────────────── Atom parsing ─────────────────────────────

export interface FeedEntry {
  videoId: string;
  channelId: string | null;
  title: string | null;
  /** The rel=alternate link; YouTube uses /shorts/<id> links for Shorts. */
  link: string | null;
  published: string | null;
  updated: string | null;
  thumbnailUrl: string | null;
  views: number | null;
}

export interface DeletedEntry {
  videoId: string;
  channelId: string | null;
  deletedAt: string | null;
}

export interface ParsedFeed {
  /** Feed-level channel id (RSS feeds carry one; push payloads usually do not). */
  channelId: string | null;
  entries: FeedEntry[];
  deleted: DeletedEntry[];
}

export class FeedParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedParseError';
  }
}

const atomParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // yt:videoId → videoId, media:group → group, at:deleted-entry → deleted-entry.
  removeNSPrefix: true,
  // Keep ids as strings: an all-digit video id must not become a number.
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) => name === 'entry' || name === 'link' || name === 'deleted-entry',
});

type XmlNode = Record<string, unknown>;

const isNode = (value: unknown): value is XmlNode => typeof value === 'object' && value !== null && !Array.isArray(value);

function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number') return String(value);
  if (isNode(value) && typeof value['#text'] === 'string') return value['#text'].trim() || null;
  return null;
}

function attrOf(node: unknown, name: string): string | null {
  return isNode(node) && typeof node[`@_${name}`] === 'string' ? (node[`@_${name}`] as string) : null;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

/** Normalizes RFC 3339 timestamps (Google sends up to 9 fractional digits) to ISO strings. */
export function normalizeTimestamp(value: string | null): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function alternateLink(entry: XmlNode): string | null {
  const links = asArray(entry.link);
  const alternate = links.find((l) => attrOf(l, 'rel') === 'alternate') ?? links.find((l) => attrOf(l, 'rel') === null);
  return attrOf(alternate, 'href');
}

function channelIdFromUri(uri: string | null): string | null {
  const id = uri?.split(/[/?#]/).filter(Boolean).pop() ?? null;
  return isYouTubeChannelId(id) ? id : null;
}

function parseEntry(raw: unknown): FeedEntry | null {
  if (!isNode(raw)) return null;
  const idText = textOf(raw.id);
  const videoId = textOf(raw.videoId) ?? (idText?.startsWith('yt:video:') ? idText.slice('yt:video:'.length) : null);
  if (!isYouTubeVideoId(videoId)) return null;
  const channelId = textOf(raw.channelId);
  const group = isNode(raw.group) ? raw.group : {};
  const community = isNode(group.community) ? group.community : {};
  const views = Number(attrOf(community.statistics, 'views'));
  return {
    videoId,
    channelId: isYouTubeChannelId(channelId) ? channelId : channelIdFromUri(isNode(raw.author) ? textOf(raw.author.uri) : null),
    title: textOf(raw.title) ?? textOf(group.title),
    link: alternateLink(raw),
    published: normalizeTimestamp(textOf(raw.published)),
    updated: normalizeTimestamp(textOf(raw.updated)),
    thumbnailUrl: attrOf(group.thumbnail, 'url'),
    views: attrOf(community.statistics, 'views') !== null && Number.isFinite(views) ? views : null,
  };
}

function parseDeleted(raw: unknown): DeletedEntry | null {
  const ref = attrOf(raw, 'ref');
  const videoId = ref?.startsWith('yt:video:') ? ref.slice('yt:video:'.length) : null;
  if (!isYouTubeVideoId(videoId) || !isNode(raw)) return null;
  return {
    videoId,
    channelId: channelIdFromUri(isNode(raw.by) ? textOf(raw.by.uri) : null),
    deletedAt: normalizeTimestamp(attrOf(raw, 'when')),
  };
}

/**
 * Parses a YouTube Atom document (the RSS feed or a WebSub push). Throws FeedParseError for anything that
 * is not a well-formed Atom feed: truncated downloads, HTML consent/bot-check pages, JSON errors.
 */
export function parseYouTubeFeed(xml: string): ParsedFeed {
  const text = xml.replace(/^﻿/, '').trim();
  if (!text) throw new FeedParseError('empty document');
  const validation = XMLValidator.validate(text);
  if (validation !== true) throw new FeedParseError(`invalid XML: ${validation.err.msg}`);
  let doc: unknown;
  try {
    doc = atomParser.parse(text);
  } catch (err) {
    throw new FeedParseError(`invalid XML: ${errorMessage(err)}`);
  }
  if (!isNode(doc) || !('feed' in doc)) throw new FeedParseError('not an Atom feed');
  const feed = isNode(doc.feed) ? doc.feed : {};
  const channelId = textOf(feed.channelId);
  return {
    channelId: isYouTubeChannelId(channelId) ? channelId : null,
    entries: asArray(feed.entry)
      .map(parseEntry)
      .filter((e): e is FeedEntry => e !== null),
    deleted: asArray(feed['deleted-entry'])
      .map(parseDeleted)
      .filter((e): e is DeletedEntry => e !== null),
  };
}

// ───────────────────────────── signatures ─────────────────────────────

/** Verifies X-Hub-Signature ("sha1=<hex>"; sha256/384/512 accepted per the WebSub spec) over the raw body. */
export function verifyHubSignature(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const match = /^(sha1|sha256|sha384|sha512)=([0-9a-f]+)$/i.exec(header.trim());
  if (!match?.[1] || !match[2]) return false;
  const expected = createHmac(match[1].toLowerCase(), secret).update(rawBody).digest();
  const given = Buffer.from(match[2], 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The value sent as hub.secret (and used to verify pushes): the configured secret, hashed if Google would reject its length. */
export function hubSecretFor(secret: string): string {
  return Buffer.byteLength(secret) <= MAX_HUB_SECRET_BYTES ? secret : createHash('sha256').update(secret).digest('hex');
}

// ───────────────────────────── adapter ─────────────────────────────

export type WebSubSubscriptionStatus = 'pending' | 'active' | 'failed' | 'unsubscribing';

export interface WebSubSubscription {
  channelId: string;
  status: WebSubSubscriptionStatus;
  /** Fingerprint of the callback + secret it was made with; a change forces a re-subscribe. */
  fingerprint: string;
  /** Last subscribe/unsubscribe request sent to the hub. */
  requestedAt: number;
  /** The hub accepted the last request (202) but has not called the verification GET yet. */
  awaitingVerification: boolean;
  verifiedAt: number | null;
  leaseSeconds: number | null;
  expiresAt: number | null;
  failures: number;
  retryAt: number;
  lastError: string | null;
}

export interface WebSubCallbacks {
  /**
   * A fresh video announced by the hub: queue it for classification. Return true when it still needs a
   * check (newly queued or not classified yet), false when it is already known.
   */
  onNewVideo(entry: FeedEntry & { channelId: string }): boolean;
  /** True when the video is an upcoming/live stream being tracked (pushes about it may mean it went live or ended). */
  isTrackedStream(channelId: string, videoId: string): boolean;
  onDeleted?(channelId: string, videoId: string): void;
}

export interface YouTubeWebSubOptions {
  callbackUrl: string;
  secret: string;
  kv: KeyValueStore;
  logger: Logger;
  now: () => number;
  fetch: FetchLike;
  callbacks: WebSubCallbacks;
  hubUrl?: string;
}

export interface WebSubStatus {
  channels: number;
  active: number;
  pending: number;
  failed: number;
  hubBlockedUntil: number | null;
  lastSyncAt: number | null;
  lastPushAt: number | null;
  lastError: string | null;
}

type HubMode = 'subscribe' | 'unsubscribe';

function headerValue(headers: WebhookRequest['headers'], name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function parseRetryAfter(value: string | null, now: number): number {
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_HUB_RETRY_AFTER_MS, Math.max(MINUTE, seconds * 1000));
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.min(MAX_HUB_RETRY_AFTER_MS, Math.max(MINUTE, date - now));
  }
  return DEFAULT_HUB_RETRY_AFTER_MS;
}

function isSubscription(value: unknown): value is WebSubSubscription {
  const v = value as Partial<WebSubSubscription> | null | undefined;
  return !!v && isYouTubeChannelId(v.channelId) && typeof v.status === 'string' && typeof v.requestedAt === 'number';
}

const backoff = (failures: number) => Math.min(FAILURE_BACKOFF_MAX_MS, FAILURE_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));

export class YouTubeWebSubAdapter implements WebhookAdapter {
  readonly path = YOUTUBE_WEBSUB_PATH;

  private readonly hubUrl: string;
  private readonly hubSecret: string;
  private readonly fingerprint: string;
  /** Channel ids from the last sync(); null until the first sync after startup (then kv state decides). */
  private desired: Set<string> | null = null;
  private hubBlockedUntil = 0;
  private lastSyncAt: number | null = null;
  private lastPushAt: number | null = null;
  private lastError: string | null = null;
  private readonly recentPushes = new Map<string, number>();
  private syncChain: Promise<void> = Promise.resolve();

  constructor(private readonly o: YouTubeWebSubOptions) {
    this.hubUrl = o.hubUrl ?? DEFAULT_HUB_URL;
    this.hubSecret = hubSecretFor(o.secret);
    this.fingerprint = createHash('sha256').update(`${o.callbackUrl}\n${this.hubSecret}`).digest('hex').slice(0, 16);
  }

  async handle(req: WebhookRequest): Promise<WebhookResponse> {
    const method = req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD') return this.handleVerification(req);
    if (method === 'POST') return this.handleNotification(req);
    return { status: 405, hints: [] };
  }

  sync(channels: ChannelRef[]): Promise<void> {
    const run = this.syncChain.then(() => this.runSync(channels));
    this.syncChain = run.catch(() => undefined);
    return run.catch((err) => {
      this.lastError = errorMessage(err);
      this.o.logger.error({ err: this.lastError }, 'YouTube WebSub sync failed');
    });
  }

  status(): WebSubStatus {
    const ids = this.desired ?? new Set(this.readIndex());
    let active = 0;
    let pending = 0;
    let failed = 0;
    const now = this.o.now();
    for (const id of ids) {
      const sub = this.load(id);
      if (sub?.status === 'active' && (sub.expiresAt ?? 0) > now) active++;
      else if (sub?.status === 'pending') pending++;
      else failed++;
    }
    return {
      channels: ids.size,
      active,
      pending,
      failed,
      hubBlockedUntil: this.hubBlockedUntil > now ? this.hubBlockedUntil : null,
      lastSyncAt: this.lastSyncAt,
      lastPushAt: this.lastPushAt,
      lastError: this.lastError,
    };
  }

  /** Subscription record of one channel (dashboard/tests). */
  subscription(channelId: string): WebSubSubscription | null {
    return this.load(channelId);
  }

  // ─────────────── verification (GET) ───────────────

  private handleVerification(req: WebhookRequest): WebhookResponse {
    const mode = req.query['hub.mode'];
    const topic = req.query['hub.topic'];
    const challenge = req.query['hub.challenge'];
    const channelId = topic ? channelIdFromTopic(topic) : null;
    if (!mode || !channelId) return { status: 404, hints: [] };

    if (mode === 'denied') {
      const reason = req.query['hub.reason'] ?? 'no reason given';
      const sub = this.load(channelId);
      if (sub && sub.status !== 'unsubscribing') this.markFailed(sub, `hub denied the subscription: ${reason}`);
      return { status: 200, body: '', contentType: 'text/plain; charset=utf-8', hints: [] };
    }
    if (!challenge || challenge.length > MAX_CHALLENGE_LENGTH) return { status: 400, hints: [] };

    const now = this.o.now();
    const prev = this.load(channelId);
    if (mode === 'subscribe') {
      // Someone else could ask the hub to subscribe our callback with *their* secret, which would break
      // signature checks for every real push: only confirm subscriptions we requested ourselves.
      if (!this.wants(channelId) || !this.isOwnRequest(prev, 'subscribe', req.query['hub.verify_token'], now)) {
        this.o.logger.warn({ channelId }, 'Refusing a WebSub subscribe verification we did not request');
        return { status: 404, hints: [] };
      }
      const leaseSeconds = this.parseLease(req.query['hub.lease_seconds']);
      this.save({
        channelId,
        status: 'active',
        fingerprint: prev?.fingerprint ?? this.fingerprint,
        requestedAt: prev?.requestedAt ?? now,
        awaitingVerification: false,
        verifiedAt: now,
        leaseSeconds,
        expiresAt: now + leaseSeconds * 1000,
        failures: 0,
        retryAt: 0,
        lastError: null,
      });
      this.o.logger.info({ channelId, leaseSeconds }, 'YouTube WebSub subscription verified');
      return { status: 200, body: challenge, contentType: 'text/plain; charset=utf-8', hints: [] };
    }

    if (mode === 'unsubscribe') {
      // Only confirm unsubscribes we asked for, so nobody can silently cut our pushes.
      if (prev?.status !== 'unsubscribing' || this.wants(channelId) || !this.isOwnRequest(prev, 'unsubscribe', req.query['hub.verify_token'], now)) {
        return { status: 404, hints: [] };
      }
      this.forget(channelId);
      this.o.logger.info({ channelId }, 'YouTube WebSub unsubscribe verified');
      return { status: 200, body: challenge, contentType: 'text/plain; charset=utf-8', hints: [] };
    }
    return { status: 404, hints: [] };
  }

  /** Expected hub.verify_token for a request: Google's hub echoes it back in the verification GET. */
  private verifyToken(mode: HubMode, channelId: string): string {
    return createHmac('sha256', this.hubSecret).update(`${mode}:${channelId}`).digest('hex').slice(0, 32);
  }

  private isOwnRequest(sub: WebSubSubscription | null, mode: HubMode, token: string | undefined, now: number): boolean {
    if (!sub || sub.fingerprint !== this.fingerprint || now - sub.requestedAt > VERIFY_ACCEPT_WINDOW_MS) return false;
    if (token === undefined) return true; // hubs that do not echo verify tokens fall back to the time window
    const expected = Buffer.from(this.verifyToken(mode, sub.channelId));
    const given = Buffer.from(token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  private parseLease(value: string | undefined): number {
    const lease = Number(value);
    return Number.isFinite(lease) && lease > 0 ? Math.floor(lease) : FALLBACK_LEASE_SECONDS;
  }

  // ─────────────── notifications (POST) ───────────────

  private handleNotification(req: WebhookRequest): WebhookResponse {
    if (!verifyHubSignature(req.rawBody, headerValue(req.headers, 'x-hub-signature'), this.hubSecret)) {
      this.o.logger.warn('Rejected YouTube WebSub delivery with a missing or invalid signature');
      return { status: 403, body: 'invalid signature', contentType: 'text/plain; charset=utf-8', hints: [] };
    }
    const now = this.o.now();
    this.lastPushAt = now;

    let feed: ParsedFeed;
    try {
      feed = parseYouTubeFeed(req.rawBody.toString('utf8'));
    } catch (err) {
      // Acknowledge anyway: a non-2xx only makes the hub retry the same unparsable payload.
      this.o.logger.warn({ err: errorMessage(err) }, 'Ignoring unparsable YouTube WebSub payload');
      return { status: 204, hints: [] };
    }

    const hints: PushHint[] = [];
    const hint = (type: PushHint['type'], platformId: string, contentId?: string) =>
      hints.push(contentId ? { type, platform: 'youtube', platformId, contentId } : { type, platform: 'youtube', platformId });

    for (const entry of feed.entries) {
      const channelId = entry.channelId ?? feed.channelId;
      if (!channelId || !this.wants(channelId)) continue;
      if (this.isDuplicate(`${entry.videoId}|${entry.updated ?? entry.published ?? ''}`, now)) continue;

      const published = entry.published ? Date.parse(entry.published) : Number.NaN;
      const fresh = !Number.isFinite(published) || now - published <= STALE_ENTRY_MS;
      if (fresh && this.o.callbacks.onNewVideo({ ...entry, channelId })) {
        hint('content', channelId, entry.videoId);
        hint('live', channelId);
      } else if (this.o.callbacks.isTrackedStream(channelId, entry.videoId)) {
        // Edits of a tracked scheduled/live stream often accompany it going live or ending.
        hint('live', channelId);
      } else {
        this.o.logger.debug({ channelId, videoId: entry.videoId }, 'Ignoring WebSub push for an old video (edit)');
      }
    }

    for (const deleted of feed.deleted) {
      const channelId = deleted.channelId;
      if (!channelId || !this.wants(channelId)) continue;
      const wasStream = this.o.callbacks.isTrackedStream(channelId, deleted.videoId);
      this.o.callbacks.onDeleted?.(channelId, deleted.videoId);
      if (wasStream) hint('live', channelId);
    }

    const unique = new Map(hints.map((h) => [`${h.type}|${h.platformId}|${h.contentId ?? ''}`, h]));
    return { status: 204, hints: [...unique.values()] };
  }

  private isDuplicate(key: string, now: number): boolean {
    if (this.recentPushes.has(key)) return true;
    this.recentPushes.set(key, now);
    while (this.recentPushes.size > RECENT_PUSH_CACHE) {
      const oldest = this.recentPushes.keys().next().value;
      if (oldest === undefined) break;
      this.recentPushes.delete(oldest);
    }
    return false;
  }

  // ─────────────── subscriptions ───────────────

  private async runSync(channels: ChannelRef[]): Promise<void> {
    const now = this.o.now();
    const desired = new Set(channels.filter((c) => c.platform === 'youtube' && isYouTubeChannelId(c.platformId)).map((c) => c.platformId));
    this.desired = desired;
    this.lastSyncAt = now;

    const index = new Set(this.readIndex());
    for (const id of desired) index.add(id);

    const work: Array<{ channelId: string; mode: HubMode; order: number }> = [];
    for (const channelId of desired) {
      const order = this.subscribeOrder(this.load(channelId), now);
      if (order !== null) work.push({ channelId, mode: 'subscribe', order });
    }
    for (const channelId of index) {
      if (desired.has(channelId)) continue;
      const sub = this.load(channelId);
      if (!sub) {
        index.delete(channelId);
      } else if (sub.status === 'unsubscribing') {
        if (now - sub.requestedAt > UNSUBSCRIBE_GRACE_MS) {
          this.forget(channelId);
          index.delete(channelId);
        }
      } else {
        work.push({ channelId, mode: 'unsubscribe', order: Number.MAX_SAFE_INTEGER });
      }
    }
    this.writeIndex([...index]);

    if (now < this.hubBlockedUntil) {
      if (work.length > 0) this.o.logger.debug({ until: new Date(this.hubBlockedUntil).toISOString() }, 'WebSub hub is throttling us; sync postponed');
      return;
    }

    // Brand-new subscriptions first, then the ones closest to expiry, unsubscribes last.
    work.sort((a, b) => a.order - b.order);
    let sent = 0;
    for (const item of work) {
      if (sent >= MAX_HUB_REQUESTS_PER_SYNC || this.o.now() < this.hubBlockedUntil) break;
      sent++;
      await this.request(item.channelId, item.mode);
    }
  }

  /** Sort key when the channel needs a (re)subscribe now, else null. */
  private subscribeOrder(sub: WebSubSubscription | null, now: number): number | null {
    if (!sub || sub.status === 'unsubscribing') return 0;
    if (sub.awaitingVerification) {
      if (now - sub.requestedAt <= VERIFY_TIMEOUT_MS) return null;
      // The hub accepted the request but never called back: usually the callback URL is unreachable.
      this.markFailed(sub, 'the hub never verified the subscription (is the callback URL reachable from the internet?)');
      return null;
    }
    if (now < sub.retryAt) return null;
    if (sub.fingerprint !== this.fingerprint) return 1;
    if (sub.status !== 'active') return 1;
    if (!sub.expiresAt || !sub.leaseSeconds) return 1;
    const remaining = sub.expiresAt - now;
    return remaining < sub.leaseSeconds * 1000 * RENEW_WHEN_REMAINING ? 2 + Math.max(0, remaining) : null;
  }

  private async request(channelId: string, mode: HubMode): Promise<void> {
    const now = this.o.now();
    const prev = this.load(channelId);
    // Persist the intent first: with hub.verify=async the verification GET can arrive before the response.
    if (mode === 'subscribe') {
      const renewing = prev?.status === 'active' && prev.fingerprint === this.fingerprint && (prev.expiresAt ?? 0) > now;
      this.save({
        ...(prev ?? this.blank(channelId, now)),
        // A renewal keeps the current lease usable until the new verification arrives.
        status: renewing ? 'active' : 'pending',
        fingerprint: this.fingerprint,
        requestedAt: now,
        awaitingVerification: false,
        retryAt: 0,
      });
    } else if (prev) {
      this.save({ ...prev, status: 'unsubscribing', requestedAt: now, awaitingVerification: false });
    }

    const body = new URLSearchParams({
      'hub.mode': mode,
      'hub.topic': websubTopic(channelId),
      'hub.callback': this.o.callbackUrl,
      'hub.verify': 'async',
      'hub.verify_token': this.verifyToken(mode, channelId),
    });
    if (mode === 'subscribe') {
      body.set('hub.secret', this.hubSecret);
      body.set('hub.lease_seconds', String(REQUESTED_LEASE_SECONDS));
    }

    let res: Response;
    try {
      res = await this.o.fetch(this.hubUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'StreamBot/1.0 (+discord bot)' },
        body,
        signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
      });
    } catch (err) {
      this.requestFailed(channelId, mode, prev, `hub request failed: ${errorMessage(err)}`);
      return;
    }

    if (res.status >= 200 && res.status < 300) {
      // 204: verified synchronously (the GET already ran). 202: the verification GET follows later.
      const sub = this.load(channelId);
      if (mode === 'subscribe' && res.status === 202 && sub && (sub.verifiedAt ?? -1) < sub.requestedAt) {
        this.save({ ...sub, awaitingVerification: true });
      }
      this.o.logger.debug({ channelId, mode, status: res.status }, 'WebSub hub accepted the request');
      return;
    }

    const text = (await res.text().catch(() => '')).trim().slice(0, 200);
    if (res.status === 503 || res.status === 429) {
      const wait = parseRetryAfter(res.headers.get('retry-after'), now);
      this.hubBlockedUntil = now + wait;
      this.lastError = `hub throttled us (HTTP ${res.status})`;
      this.o.logger.warn({ retryInMs: wait }, 'YouTube WebSub hub is throttling subscription requests');
      // Not the channel's fault: restore what we had and retry once the hub lets us.
      if (prev) this.save(prev);
      else this.save({ ...this.blank(channelId, now), status: 'failed', retryAt: this.hubBlockedUntil, lastError: this.lastError });
      return;
    }
    this.requestFailed(channelId, mode, prev, `HTTP ${res.status}${text ? `: ${text}` : ''}`);
  }

  private requestFailed(channelId: string, mode: HubMode, prev: WebSubSubscription | null, reason: string): void {
    this.lastError = reason;
    if (mode === 'unsubscribe') {
      // The lease lapses on its own; do not keep retrying an unsubscribe.
      this.o.logger.warn({ channelId, reason }, 'WebSub unsubscribe failed; letting the lease expire');
      this.forget(channelId);
      return;
    }
    const sub = this.load(channelId) ?? prev ?? this.blank(channelId, this.o.now());
    this.markFailed(sub, reason);
  }

  private markFailed(sub: WebSubSubscription, reason: string): void {
    const now = this.o.now();
    const failures = sub.failures + 1;
    const stillActive = sub.status === 'active' && (sub.expiresAt ?? 0) > now && sub.fingerprint === this.fingerprint;
    this.save({
      ...sub,
      // A failed renewal keeps the current lease usable until it expires.
      status: stillActive ? 'active' : 'failed',
      awaitingVerification: false,
      failures,
      retryAt: now + backoff(failures),
      lastError: reason,
    });
    this.lastError = reason;
    this.o.logger.warn({ channelId: sub.channelId, failures, reason }, 'YouTube WebSub subscription failed');
  }

  private blank(channelId: string, now: number): WebSubSubscription {
    return {
      channelId,
      status: 'pending',
      fingerprint: this.fingerprint,
      requestedAt: now,
      awaitingVerification: false,
      verifiedAt: null,
      leaseSeconds: null,
      expiresAt: null,
      failures: 0,
      retryAt: 0,
      lastError: null,
    };
  }

  /** Channels we currently want pushes for (and act on pushes of). */
  private wants(channelId: string): boolean {
    if (this.desired) return this.desired.has(channelId);
    const sub = this.load(channelId);
    return !!sub && sub.status !== 'unsubscribing';
  }

  // ─────────────── storage ───────────────

  private load(channelId: string): WebSubSubscription | null {
    try {
      const value = this.o.kv.get<WebSubSubscription>(kvKey(channelId));
      return isSubscription(value) ? value : null;
    } catch (err) {
      this.o.logger.warn({ channelId, err: errorMessage(err) }, 'Could not read WebSub state');
      return null;
    }
  }

  private save(sub: WebSubSubscription): void {
    try {
      this.o.kv.set(kvKey(sub.channelId), sub);
    } catch (err) {
      this.o.logger.warn({ channelId: sub.channelId, err: errorMessage(err) }, 'Could not persist WebSub state');
    }
  }

  private forget(channelId: string): void {
    try {
      this.o.kv.delete(kvKey(channelId));
      this.writeIndex(this.readIndex().filter((id) => id !== channelId));
    } catch (err) {
      this.o.logger.warn({ channelId, err: errorMessage(err) }, 'Could not delete WebSub state');
    }
  }

  private readIndex(): string[] {
    try {
      const value = this.o.kv.get<unknown>(KV_INDEX);
      return Array.isArray(value) ? value.filter(isYouTubeChannelId) : [];
    } catch {
      return [];
    }
  }

  private writeIndex(ids: string[]): void {
    try {
      this.o.kv.set(KV_INDEX, [...new Set(ids)]);
    } catch (err) {
      this.o.logger.warn({ err: errorMessage(err) }, 'Could not persist the WebSub index');
    }
  }
}
