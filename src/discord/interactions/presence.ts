/**
 * #15 — Discord "Streaming" presence tracking (only active with the privileged GuildPresences intent).
 *
 * discord.js' presence cache is disabled (it would hold every online member). Instead the raw gateway packets keep
 * a small map of members currently showing a Streaming activity: GUILD_CREATE delivers an authoritative snapshot
 * (initial login and every re-identify), PRESENCE_UPDATE changes one member, GUILD_MEMBER_REMOVE drops one.
 * Only real changes of the streaming activity are reported, so status flips (online → idle) cost nothing.
 */
import { ActivityType } from 'discord.js';
import type { StreamingActivity } from '../../app/context.js';
import type { Platform } from '../../core/types.js';
import { cleanText, safeUrl, truncate } from '../format.js';

/** Raw activity as sent by the gateway (only the fields we read). */
export interface RawActivity {
  type?: unknown;
  name?: unknown;
  url?: unknown;
  details?: unknown;
  state?: unknown;
}

const HOST_PLATFORMS: Array<[RegExp, Platform]> = [
  [/(^|\.)twitch\.tv$/, 'twitch'],
  [/(^|\.)youtube\.com$/, 'youtube'],
  [/(^|\.)youtu\.be$/, 'youtube'],
  [/(^|\.)kick\.com$/, 'kick'],
  [/(^|\.)tiktok\.com$/, 'tiktok'],
];

/** Platform from a stream URL host: twitch.tv, youtube.com / youtu.be, kick.com, tiktok.com. */
export function platformFromStreamUrl(url: string | null | undefined): Platform | null {
  const safe = safeUrl(url);
  if (!safe) return null;
  const host = new URL(safe).hostname.toLowerCase();
  for (const [re, platform] of HOST_PLATFORMS) if (re.test(host)) return platform;
  return null;
}

const text = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const clean = cleanText(value);
  return clean ? truncate(clean, max) : null;
};

/** The member's Streaming activity (ActivityType.Streaming), or null when they are not streaming. */
export function streamingActivityFrom(activities: readonly RawActivity[] | null | undefined): StreamingActivity | null {
  if (!Array.isArray(activities)) return null;
  const activity = activities.find((a) => a && a.type === ActivityType.Streaming);
  if (!activity) return null;
  const url = typeof activity.url === 'string' ? safeUrl(activity.url) : null;
  return {
    url,
    platform: platformFromStreamUrl(url),
    title: text(activity.details, 300),
    game: text(activity.state, 200),
  };
}

export function sameActivity(a: StreamingActivity | null | undefined, b: StreamingActivity | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.url === b.url && a.platform === b.platform && a.title === b.title && a.game === b.game;
}

interface RawPresence {
  user?: { id?: unknown } | null;
  activities?: RawActivity[] | null;
  status?: unknown;
}

const userIdOf = (presence: RawPresence | null | undefined): string | null => {
  const id = presence?.user?.id;
  return typeof id === 'string' && id !== '' ? id : null;
};

export interface PresenceChange {
  guildId: string;
  userId: string;
  activity: StreamingActivity | null;
}

/** Map of members currently streaming per guild, fed by raw gateway packets. */
export class PresenceTracker {
  private readonly guilds = new Map<string, Map<string, StreamingActivity>>();
  /** Guilds whose current snapshot is complete (a GUILD_CREATE arrived since the last GUILD_DELETE). */
  private readonly complete = new Set<string>();

  /**
   * Applies one raw gateway dispatch. Returns the members whose streaming activity changed (to forward to the
   * presence service). Snapshots (GUILD_CREATE) replace silently: reconcile() compares them with the grants.
   */
  handlePacket(packet: { t?: unknown; d?: unknown } | null | undefined): PresenceChange[] {
    if (!packet || typeof packet.t !== 'string' || !packet.d || typeof packet.d !== 'object') return [];
    const d = packet.d as Record<string, unknown>;
    switch (packet.t) {
      case 'GUILD_CREATE':
        if (typeof d.id === 'string' && d.unavailable !== true) this.snapshot(d.id, Array.isArray(d.presences) ? (d.presences as RawPresence[]) : []);
        return [];
      case 'GUILD_DELETE':
        if (typeof d.id === 'string') {
          this.guilds.delete(d.id);
          this.complete.delete(d.id);
        }
        return [];
      case 'PRESENCE_UPDATE': {
        const guildId = typeof d.guild_id === 'string' ? d.guild_id : null;
        const userId = userIdOf(d as RawPresence);
        if (!guildId || !userId) return [];
        const activity = d.status === 'offline' ? null : streamingActivityFrom((d as RawPresence).activities);
        return this.update(guildId, userId, activity) ? [{ guildId, userId, activity }] : [];
      }
      case 'GUILD_MEMBER_REMOVE': {
        const guildId = typeof d.guild_id === 'string' ? d.guild_id : null;
        const userId = userIdOf(d as RawPresence);
        if (!guildId || !userId) return [];
        this.guilds.get(guildId)?.delete(userId);
        // Always report: a grant may exist from before a restart even when this member was not tracked.
        return [{ guildId, userId, activity: null }];
      }
      default:
        return [];
    }
  }

  /** Replaces a guild's streaming members with an authoritative snapshot. */
  snapshot(guildId: string, presences: readonly RawPresence[]): void {
    const map = new Map<string, StreamingActivity>();
    for (const presence of presences) {
      const userId = userIdOf(presence);
      if (!userId || presence.status === 'offline') continue;
      const activity = streamingActivityFrom(presence.activities);
      if (activity) map.set(userId, activity);
    }
    this.guilds.set(guildId, map);
    this.complete.add(guildId);
  }

  /** Records a member's activity; true when it changed. */
  update(guildId: string, userId: string, activity: StreamingActivity | null): boolean {
    let map = this.guilds.get(guildId);
    const previous = map?.get(userId) ?? null;
    if (sameActivity(previous, activity)) return false;
    if (activity) {
      if (!map) {
        map = new Map();
        this.guilds.set(guildId, map);
      }
      map.set(userId, activity);
    } else {
      map?.delete(userId);
    }
    return true;
  }

  /** Members currently streaming, or null when no snapshot of the guild was received yet (unknown). */
  streaming(guildId: string): Map<string, StreamingActivity> | null {
    if (!this.complete.has(guildId)) return null;
    return new Map(this.guilds.get(guildId) ?? []);
  }

  clear(): void {
    this.guilds.clear();
    this.complete.clear();
  }
}
