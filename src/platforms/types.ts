import type { AppConfig } from '../config.js';
import type { Logger } from '../core/logger.js';
import type { ChannelRef, ContentItem, ContentKind, LiveSnapshot, Platform, ResolvedChannel } from '../core/types.js';
import type { FetchLike } from './http.js';

/** Tiny persistent key/value store (backed by the `kv` table). Values are JSON. */
export interface KeyValueStore {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
}

/**
 * #11 — official OAuth tokens of streamers who linked their account (optional). Providers use them to read data
 * through official APIs instead of unofficial ones (e.g. TikTok Display API video.list).
 */
export interface LinkedTokenSource {
  /** A valid (refreshed if needed) TikTok user access token for this handle, or null when the account isn't linked. */
  tiktokAccessToken(handle: string): Promise<{ accessToken: string; openId: string } | null>;
}

export interface ProviderContext {
  config: AppConfig;
  logger: Logger;
  kv: KeyValueStore;
  /** Injected fetch (tests pass a mock). */
  fetch?: FetchLike;
  /** Optional linked-account tokens (absent in tests and when linking is not configured). */
  links?: LinkedTokenSource;
}

export interface ProviderCapabilities {
  live: boolean;
  /** Content kinds this provider can detect. */
  content: ContentKind[];
  /** Max channels per checkLive() call that the provider batches efficiently (the monitor splits larger lists). */
  liveBatchSize: number;
  /** True when the provider can receive push notifications (webhooks) in addition to polling. */
  push: boolean;
}

export interface ProviderHealth {
  configured: boolean;
  /** Human readable status details for the dashboard (Arabic or English). */
  notes: string[];
}

/**
 * Push hint emitted by webhooks. Hints never carry authoritative state: the monitor reacts by
 * re-checking the channel immediately through checkLive()/fetchRecentContent().
 */
export interface PushHint {
  type: 'live' | 'offline' | 'content' | 'metadata';
  platform: Platform;
  platformId: string;
  /** Optional content/video id the hint refers to (e.g. YouTube WebSub video id). */
  contentId?: string;
}

export interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | undefined>;
  rawBody: Buffer;
  method: string;
}

export interface WebhookResponse {
  status: number;
  body?: string;
  contentType?: string;
  hints: PushHint[];
}

export interface WebhookAdapter {
  /** Route path under the web server, e.g. "/webhooks/twitch". Must accept GET and POST. */
  readonly path: string;
  /** Verify + parse a delivery. Must reject (status 403) unsigned/invalid requests. */
  handle(req: WebhookRequest): Promise<WebhookResponse>;
  /**
   * Make remote subscriptions match the given channel set (create missing, remove stale, renew expiring).
   * Called on startup, when channels change, and periodically. Must be idempotent and never throw
   * for a single failed channel (log and continue).
   */
  sync(channels: ChannelRef[]): Promise<void>;
}

export interface PlatformProvider {
  readonly platform: Platform;
  readonly capabilities: ProviderCapabilities;

  /** True when required credentials are present (TikTok needs none). */
  isConfigured(): boolean;
  health(): ProviderHealth;

  /**
   * Resolve admin input (handle, @handle, or full profile/channel URL) into a channel.
   * Throws ChannelNotFoundError when it does not exist, ProviderError on transport errors.
   */
  resolveChannel(input: string): Promise<ResolvedChannel>;

  /**
   * Check live status for a batch (size <= capabilities.liveBatchSize).
   * Must return exactly one snapshot per input channel (isLive=false when offline).
   * Throws ProviderError when the whole batch failed; the monitor then keeps the previous state.
   */
  checkLive(channels: ChannelRef[]): Promise<LiveSnapshot[]>;

  /**
   * Recent content for one channel, newest first (around 10-20 items), filtered to `kinds`.
   * Returns [] when the provider cannot list content.
   */
  fetchRecentContent(channel: ChannelRef, kinds: ContentKind[]): Promise<ContentItem[]>;

  /**
   * Optional: best-effort lookup of the recording/VOD URL of a stream that just ended
   * (used in the post-stream summary). Return null when unknown.
   */
  findVodUrl?(channel: ChannelRef, streamId: string | null, startedAt: string | null): Promise<string | null>;

  /** Present only when push is supported AND configured (e.g. PUBLIC_URL + secret). */
  readonly webhook?: WebhookAdapter;
}

export type ProviderFactory = (ctx: ProviderContext) => PlatformProvider;
