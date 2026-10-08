/**
 * Pure helpers shared by the services: building the views handed to the notifier, change signatures,
 * duration math and small Arabic formatting utilities. No I/O in this file, so everything is unit-testable.
 */
import type { LiveSnapshot, Platform } from '../core/types.js';
import { PLATFORM_LABELS, PLATFORMS } from '../core/types.js';
import type { Channel, GuildSettings, LiveSegment, LiveSession, SessionCategory, Streamer } from '../db/models.js';
import type { LivePlatformView, MessageRef, SummaryView } from './ports.js';

export type ChannelInfo = Pick<Channel, 'id' | 'displayName' | 'handle' | 'url' | 'avatarUrl'>;

export const iso = (ms: number): string => new Date(ms).toISOString();

export function channelInfo(channel: ChannelInfo): ChannelInfo {
  return { id: channel.id, displayName: channel.displayName, handle: channel.handle, url: channel.url, avatarUrl: channel.avatarUrl };
}

export function messageRefOf(session: Pick<LiveSession, 'messageChannelId' | 'messageId'>): MessageRef | null {
  return session.messageChannelId && session.messageId ? { channelId: session.messageChannelId, messageId: session.messageId } : null;
}

/** Viewer counts from providers are untrusted: negative, fractional or non-numeric values become null/ints. */
export function sanitizeViewers(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

/** Parses an ISO timestamp, returning null for missing/invalid input. */
export function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Orders live platforms for display: most viewers first (unknown counts last), then the platform that
 * went live first, then the canonical platform order. platforms[0] is the "primary" platform.
 */
export function sortLivePlatforms<T extends { view: LivePlatformView; startedMs: number }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => {
    const va = a.view.snapshot.viewers ?? -1;
    const vb = b.view.snapshot.viewers ?? -1;
    if (va !== vb) return vb - va;
    if (a.startedMs !== b.startedMs) return a.startedMs - b.startedMs;
    return PLATFORMS.indexOf(a.view.platform) - PLATFORMS.indexOf(b.view.platform);
  });
}

/** Sum of reported viewers; null when no platform reports a count. */
export function sumViewers(platforms: Array<{ snapshot: Pick<LiveSnapshot, 'viewers'> }>): number | null {
  let total: number | null = null;
  for (const p of platforms) {
    if (p.snapshot.viewers != null) total = (total ?? 0) + p.snapshot.viewers;
  }
  return total;
}

/**
 * Viewers per platform (#13 samples). Several channels on the same platform add up; a platform whose channels
 * all hide their count is reported as null (live, but unknown).
 */
export function viewersByPlatform(platforms: Array<{ platform: Platform; snapshot: Pick<LiveSnapshot, 'viewers'> }>): Partial<Record<Platform, number | null>> {
  const out: Partial<Record<Platform, number | null>> = {};
  for (const p of platforms) {
    const viewers = sanitizeViewers(p.snapshot.viewers);
    const current = out[p.platform];
    if (viewers != null) out[p.platform] = (current ?? 0) + viewers;
    else if (current === undefined) out[p.platform] = null;
  }
  return out;
}

/** Case/spacing-insensitive identity of a category, so "VALORANT" on Kick and "Valorant" on Twitch merge. */
export function categoryKey(name: string): string {
  return name.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function normalizeText(value: string | null | undefined): string | null {
  const text = value?.replace(/\s+/g, ' ').trim();
  return text ? text : null;
}

/** Category of the primary platform; falls back to the next platform that reports one (TikTok has none). */
export function primaryCategory(platforms: LivePlatformView[]): { key: string; name: string; imageUrl: string | null } | null {
  for (const p of platforms) {
    const name = normalizeText(p.snapshot.category);
    if (name) return { key: categoryKey(name), name, imageUrl: p.snapshot.categoryImageUrl ?? null };
  }
  return null;
}

/**
 * Identity of what a live message shows, minus the volatile numbers. A different signature means the
 * message is outdated in a way worth an immediate edit (platform joined/left, new title or category).
 * Platforms are keyed by channel and sorted by id so viewer-driven reordering does not count as a change.
 */
export function liveSignature(platforms: LivePlatformView[]): string {
  const parts = platforms
    .map((p) => ({ id: p.channel.id, title: normalizeText(p.snapshot.title) ?? '', category: normalizeText(p.snapshot.category) ?? '' }))
    .sort((a, b) => a.id - b.id);
  return JSON.stringify(parts);
}

/**
 * Union of [start, end] intervals, sorted, with overlapping/touching ones merged. Empty, inverted or non-finite
 * intervals are ignored.
 */
export function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
  const sorted = intervals.filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s).sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** Total length of the union of [start, end] intervals (overlaps counted once, gaps excluded). */
export function mergedDurationMs(intervals: Array<[number, number]>): number {
  return mergeIntervals(intervals).reduce((total, [s, e]) => total + (e - s), 0);
}

/** Arabic counted noun: 1 → singular, 2 → dual, 3–10 → plural, otherwise singular after the number. */
function countAr(n: number, one: string, two: string, few: string): string {
  if (n === 1) return one;
  if (n === 2) return two;
  if (n >= 3 && n <= 10) return `${n} ${few}`;
  return `${n} ${one}`;
}

/** Human duration such as "ساعتين و 5 دقائق". */
export function formatDurationAr(totalSec: number): string {
  const sec = Math.max(0, Math.round(totalSec));
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  if (hours === 0 && minutes === 0) return 'أقل من دقيقة';
  const h = hours === 0 ? '' : countAr(hours, 'ساعة', 'ساعتين', 'ساعات');
  const m = minutes === 0 ? '' : countAr(minutes, 'دقيقة', 'دقيقتين', 'دقائق');
  return [h, m].filter(Boolean).join(' و ');
}

export function platformListAr(platforms: Platform[]): string {
  const labels = [...new Set(platforms)].map((p) => PLATFORM_LABELS[p]);
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join('، ')} و ${labels[labels.length - 1]}`;
}

export interface SummaryInput {
  guildId: string;
  settings: GuildSettings;
  session: LiveSession;
  streamer: Streamer;
  segments: Array<LiveSegment & { channel: ChannelInfo }>;
  imageUrl: string | null;
  /** Used as the end of still-open intervals (dashboard summary of a live session). */
  now: number;
}

/**
 * Builds the post-stream summary. Duration is the union of the platform segments, so a reconnect gap
 * inside the merge window is not counted as streamed time; it falls back to started→ended when the
 * session has no segments (e.g. the channel was deleted).
 */
export function buildSummaryView(input: SummaryInput): SummaryView {
  const { session, now } = input;
  const sessionStart = parseTime(session.startedAt) ?? now;
  const sessionEnd = parseTime(session.endedAt) ?? now;
  const intervals: Array<[number, number]> = input.segments.map((seg) => {
    const start = parseTime(seg.startedAt) ?? sessionStart;
    const end = parseTime(seg.endedAt) ?? sessionEnd;
    return [start, Math.max(start, end)];
  });
  const durationMs = intervals.length > 0 ? mergedDurationMs(intervals) : Math.max(0, sessionEnd - sessionStart);

  const categories: SessionCategory[] = [...session.categories]
    .map((c) => ({ ...c, seconds: Math.max(0, Math.round(c.seconds)) }))
    .sort((a, b) => b.seconds - a.seconds || a.firstSeenAt.localeCompare(b.firstSeenAt));

  return {
    guildId: input.guildId,
    settings: input.settings,
    session,
    streamer: input.streamer,
    durationSec: Math.round(durationMs / 1000),
    peakViewers: session.peakViewers,
    avgViewers: session.viewerSamples > 0 ? Math.round(session.viewerSum / session.viewerSamples) : null,
    categories,
    titles: [...session.titles],
    segments: [...input.segments].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id - b.id),
    imageUrl: input.imageUrl,
  };
}
