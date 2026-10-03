/** Pure helpers deciding which content to fetch for a channel and which fetched items are announceable. */
import type { ContentItem, ContentKind, Platform } from '../core/types.js';
import { CONTENT_KINDS } from '../core/types.js';
import type { ChannelSubscriber, GuildSettings } from '../db/models.js';

export interface ContentPlan {
  /** Kinds to request from the provider (canonical order). Empty = skip the channel. */
  kinds: ContentKind[];
  /** Guilds that want at least one of those kinds. */
  guildIds: string[];
  /**
   * Items older than this are stored silently instead of announced (largest contentMaxAgeHours among the
   * interested guilds, so no guild loses anything it would accept). null = no limit.
   */
  maxAgeMs: number | null;
}

/**
 * Wanted kinds = union over subscribers (notifyContent on, platform enabled in their guild) of
 * account.contentKinds ?? guild.contentKinds, intersected with what the provider supports.
 */
export function planContent(
  platform: Platform,
  subscribers: readonly ChannelSubscriber[],
  settingsOf: (guildId: string) => GuildSettings,
  supported: readonly ContentKind[],
): ContentPlan {
  const supportedSet = new Set(supported);
  const kinds = new Set<ContentKind>();
  const guildIds = new Set<string>();
  let maxAgeHours = 0;
  let unlimited = false;

  for (const sub of subscribers) {
    if (!sub.streamer.enabled || !sub.account.notifyContent) continue;
    const settings = settingsOf(sub.guildId);
    if (!settings.platformsEnabled.includes(platform)) continue;
    const wanted = (sub.account.contentKinds ?? settings.contentKinds).filter((k) => supportedSet.has(k));
    if (wanted.length === 0) continue;
    for (const k of wanted) kinds.add(k);
    guildIds.add(sub.guildId);
    const hours = settings.options.contentMaxAgeHours;
    if (!(hours > 0)) unlimited = true;
    else maxAgeHours = Math.max(maxAgeHours, hours);
  }

  return {
    kinds: CONTENT_KINDS.filter((k) => kinds.has(k)),
    guildIds: [...guildIds],
    maxAgeMs: kinds.size === 0 || unlimited ? null : maxAgeHours * 3_600_000,
  };
}

/** Removes items with no id, kinds that were not requested, and duplicate ids (first occurrence wins). */
export function sanitizeItems(items: readonly ContentItem[], kinds: readonly ContentKind[]): ContentItem[] {
  const wanted = new Set(kinds);
  const seen = new Set<string>();
  const out: ContentItem[] = [];
  for (const item of items) {
    if (!item?.contentId || !wanted.has(item.kind) || seen.has(item.contentId)) continue;
    seen.add(item.contentId);
    out.push(item);
  }
  return out;
}

/**
 * Oldest first by publishedAt. Providers return newest first, so items without a parseable date keep
 * their relative position from the end of the list (i.e. they are treated as the newest).
 */
export function orderOldestFirst(items: readonly ContentItem[]): ContentItem[] {
  const keyed = items.map((item, index) => ({ item, index, time: Date.parse(item.publishedAt) }));
  keyed.sort((a, b) => {
    const aValid = Number.isFinite(a.time);
    const bValid = Number.isFinite(b.time);
    if (aValid && bValid && a.time !== b.time) return a.time - b.time;
    if (aValid !== bValid) return aValid ? -1 : 1;
    return b.index - a.index;
  });
  return keyed.map((k) => k.item);
}

/** True when the item is older than maxAgeMs. Unknown dates are never "too old". */
export function isTooOld(item: ContentItem, maxAgeMs: number | null, nowMs: number): boolean {
  if (maxAgeMs === null) return false;
  const published = Date.parse(item.publishedAt);
  return Number.isFinite(published) && nowMs - published > maxAgeMs;
}
