/**
 * Shared domain types. Every module (platforms, monitor, services, discord, web)
 * speaks in these shapes, so keep them stable and platform-agnostic.
 */

export const PLATFORMS = ['twitch', 'kick', 'youtube', 'tiktok'] as const;
export type Platform = (typeof PLATFORMS)[number];

/**
 * Kinds of uploaded content we can announce.
 * - video:     a normal uploaded video (YouTube upload, Twitch "upload", TikTok post)
 * - short:     YouTube Shorts
 * - vod:       a past-broadcast recording (Twitch archive, Kick VOD, YouTube live replay)
 * - highlight: Twitch highlight
 * - clip:      a clip cut from a stream (Twitch / Kick clips)
 */
export const CONTENT_KINDS = ['video', 'short', 'vod', 'highlight', 'clip'] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

/** A platform channel as stored in the DB, passed to providers. */
export interface ChannelRef {
  /** DB id of the tracked channel. */
  id: number;
  platform: Platform;
  /** Stable platform id (Twitch user id, Kick broadcaster user id, YouTube channel id UC..., TikTok uniqueId). */
  platformId: string;
  /** Human handle / login / slug used in URLs (may change; platformId is the stable key). */
  handle: string;
  /** Provider-specific extra data saved at resolve time (e.g. YouTube uploads playlist id, Kick slug). */
  meta: Record<string, unknown>;
}

/** Result of resolving admin input ("@name", URL, login) into a concrete channel. */
export interface ResolvedChannel {
  platform: Platform;
  platformId: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  url: string;
  meta: Record<string, unknown>;
}

/** Point-in-time live status of one channel. */
export interface LiveSnapshot {
  platform: Platform;
  platformId: string;
  isLive: boolean;
  /** Platform stream/broadcast id when live (used to detect a brand-new stream vs. the same one). */
  streamId: string | null;
  title: string | null;
  category: string | null;
  categoryImageUrl: string | null;
  /** Preview image of the live stream; providers should add a cache-buster. */
  thumbnailUrl: string | null;
  viewers: number | null;
  /** ISO timestamp the stream started (platform-reported), if known. */
  startedAt: string | null;
  /** Watch URL. */
  url: string;
  language: string | null;
  tags: string[];
}

export interface ContentItem {
  platform: Platform;
  /** Channel platform id that owns the content. */
  platformId: string;
  /** Stable content id (YouTube video id, Twitch video/clip id, TikTok video id...). */
  contentId: string;
  kind: ContentKind;
  title: string;
  url: string;
  thumbnailUrl: string | null;
  /** ISO timestamp. */
  publishedAt: string;
  durationSec: number | null;
  viewCount: number | null;
  /**
   * For recordings of a live stream: the stream id it belongs to (Twitch archive stream_id,
   * YouTube: the same video id as the live broadcast). Lets us skip VODs of streams we already announced.
   */
  relatedStreamId?: string | null;
}

export function offlineSnapshot(channel: Pick<ChannelRef, 'platform' | 'platformId'>, url: string): LiveSnapshot {
  return {
    platform: channel.platform,
    platformId: channel.platformId,
    isLive: false,
    streamId: null,
    title: null,
    category: null,
    categoryImageUrl: null,
    thumbnailUrl: null,
    viewers: null,
    startedAt: null,
    url,
    language: null,
    tags: [],
  };
}

export const PLATFORM_LABELS: Record<Platform, string> = {
  twitch: 'Twitch',
  kick: 'Kick',
  youtube: 'YouTube',
  tiktok: 'TikTok',
};

export const PLATFORM_COLORS: Record<Platform, number> = {
  twitch: 0x9146ff,
  kick: 0x53fc18,
  youtube: 0xff0000,
  tiktok: 0xfe2c55,
};

export const CONTENT_KIND_LABELS_AR: Record<ContentKind, string> = {
  video: 'فيديو',
  short: 'شورتس',
  vod: 'تسجيل بث',
  highlight: 'هايلايت',
  clip: 'كليب',
};

export function isPlatform(value: unknown): value is Platform {
  return typeof value === 'string' && (PLATFORMS as readonly string[]).includes(value);
}

export function isContentKind(value: unknown): value is ContentKind {
  return typeof value === 'string' && (CONTENT_KINDS as readonly string[]).includes(value);
}
