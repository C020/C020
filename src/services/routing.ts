/**
 * #4 — notification channel routing. Pure helpers shared by the notifier, services and the dashboard preview,
 * so every caller resolves the same channel for the same settings.
 *
 * Precedence
 * - live:    features.routing.liveByPlatform[primary platform] → liveChannelId
 * - content: features.routing.contentByKind[kind] → features.routing.contentByPlatform[platform] → contentChannelId
 * - digest:  features.clips.digestChannelId → content route for (platform?, 'clip') → contentChannelId
 */
import type { ContentKind, Platform } from '../core/types.js';
import type { GuildSettings } from '../db/models.js';

const nonEmpty = (v: string | null | undefined): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/** Channel for a new live notification; the session keeps it for later edits and the summary. */
export function resolveLiveChannelId(settings: GuildSettings, primaryPlatform: Platform | null): string | null {
  const byPlatform = primaryPlatform ? nonEmpty(settings.features.routing.liveByPlatform[primaryPlatform]) : null;
  return byPlatform ?? nonEmpty(settings.liveChannelId);
}

export function resolveContentChannelId(settings: GuildSettings, platform: Platform | null, kind: ContentKind): string | null {
  const routing = settings.features.routing;
  return nonEmpty(routing.contentByKind[kind]) ?? (platform ? nonEmpty(routing.contentByPlatform[platform]) : null) ?? nonEmpty(settings.contentChannelId);
}

export function resolveDigestChannelId(settings: GuildSettings): string | null {
  return nonEmpty(settings.features.clips.digestChannelId) ?? resolveContentChannelId(settings, null, 'clip');
}

/** Every channel id the guild may post notifications to (for diagnostics / permission checks). */
export function allNotificationChannelIds(settings: GuildSettings): string[] {
  const r = settings.features.routing;
  const ids = [
    settings.liveChannelId,
    settings.contentChannelId,
    settings.features.clips.digestChannelId,
    ...Object.values(r.liveByPlatform),
    ...Object.values(r.contentByPlatform),
    ...Object.values(r.contentByKind),
  ]
    .map((v) => nonEmpty(v ?? null))
    .filter((v): v is string => v !== null);
  return [...new Set(ids)];
}
