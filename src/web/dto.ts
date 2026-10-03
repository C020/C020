/** Domain → API DTO mapping (src/shared/api.ts). */
import type { AppContext } from '../app/context.js';
import { childLogger } from '../core/logger.js';
import type { Platform, ResolvedChannel } from '../core/types.js';
import type { AccountWithChannel, GuildSettings, LiveSession, StoredContentItem, Streamer, StreamerWithAccounts } from '../db/models.js';
import type { LiveView, MessageRef, SummaryView } from '../services/ports.js';
import { mergedDurationMs } from '../services/views.js';
import type {
  AccountDto,
  ContentDto,
  LeaderboardEntry,
  LiveNowItem,
  ResolvePreview,
  SessionDto,
  SettingsDto,
  StreamerDto,
  StreamerSummary,
} from '../shared/api.js';
import type { MemberCache, MemberLookup } from './memberCache.js';

const log = childLogger('web.dto');

/** How long list endpoints wait for Discord member lookups before rendering with what is cached. */
const LIST_MEMBER_BUDGET_MS = 1500;
const SINGLE_MEMBER_BUDGET_MS = 2000;
const STATS_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

export function toSettingsDto(s: GuildSettings): SettingsDto {
  return {
    guildId: s.guildId,
    streamerRoleId: s.streamerRoleId,
    liveRoleId: s.liveRoleId,
    liveChannelId: s.liveChannelId,
    contentChannelId: s.contentChannelId,
    logChannelId: s.logChannelId,
    pingMode: s.pingMode,
    pingRoleId: s.pingRoleId,
    platformsEnabled: [...s.platformsEnabled],
    contentKinds: [...s.contentKinds],
    templates: s.templates,
    options: { ...s.options },
    updatedAt: s.updatedAt,
  };
}

export function toAccountDto(a: AccountWithChannel): AccountDto {
  const ch = a.channel;
  return {
    id: a.id,
    platform: ch.platform,
    channelId: ch.id,
    handle: ch.handle,
    displayName: ch.displayName,
    avatarUrl: ch.avatarUrl,
    url: ch.url,
    notifyLive: a.notifyLive,
    notifyContent: a.notifyContent,
    contentKinds: a.contentKinds,
    isLive: ch.isLive,
    snapshot: ch.isLive ? ch.liveSnapshot : null,
    lastCheckedAt: ch.lastLiveCheckAt,
    lastError: ch.lastError,
  };
}

export function toResolvePreview(r: ResolvedChannel): ResolvePreview {
  return { platform: r.platform, platformId: r.platformId, handle: r.handle, displayName: r.displayName, avatarUrl: r.avatarUrl, url: r.url };
}

function memberAvatar(lookup: MemberLookup): string | null {
  return lookup.status === 'member' ? lookup.member.avatarUrl : null;
}

function inGuildOf(lookup: MemberLookup): boolean | null {
  if (lookup.status === 'member') return true;
  if (lookup.status === 'absent') return false;
  return null;
}

function parseMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Placeholder for history rows whose streamer no longer exists. */
export function deletedStreamerSummary(id: number): StreamerSummary {
  return { id, discordUserId: '', displayName: 'ستريمر محذوف', avatarUrl: null };
}

/** Resolves StreamerSummary for many rows of one guild with per-request memoization. */
export type SummaryLookup = (streamerId: number | null) => StreamerSummary | null;

export class DtoMapper {
  constructor(
    private readonly ctx: AppContext,
    private readonly members: MemberCache,
    private readonly now: () => number = Date.now,
  ) {}

  // ───────────────────────────── streamers ─────────────────────────────

  async streamerList(guildId: string): Promise<StreamerDto[]> {
    const list = this.ctx.streamers.list(guildId);
    await this.members.warm(
      guildId,
      list.map((s) => s.discordUserId),
      LIST_MEMBER_BUDGET_MS,
    );
    const stats = this.statsByStreamer(guildId);
    const live = this.liveStreamerIds(guildId);
    return list.map((s) => this.buildStreamer(s, this.members.peek(guildId, s.discordUserId), stats, live));
  }

  async streamer(s: StreamerWithAccounts): Promise<StreamerDto> {
    const lookup = await this.members.getWithin(s.guildId, s.discordUserId, SINGLE_MEMBER_BUDGET_MS);
    return this.buildStreamer(s, lookup, this.statsByStreamer(s.guildId), this.liveStreamerIds(s.guildId));
  }

  private buildStreamer(
    s: StreamerWithAccounts,
    lookup: MemberLookup,
    stats: Map<number, StreamerDto['stats']>,
    live: Set<number>,
  ): StreamerDto {
    return {
      id: s.id,
      discordUserId: s.discordUserId,
      displayName: s.displayName,
      avatarUrl: memberAvatar(lookup) ?? s.accounts.find((a) => a.channel.avatarUrl)?.channel.avatarUrl ?? null,
      notes: s.notes,
      color: s.color,
      enabled: s.enabled,
      isLive: live.has(s.id) || s.accounts.some((a) => a.channel.isLive),
      inGuild: inGuildOf(lookup),
      accounts: s.accounts.map(toAccountDto),
      stats: stats.get(s.id) ?? { sessions30d: 0, hours30d: 0, peakViewers30d: 0 },
      createdAt: s.createdAt,
    };
  }

  private statsByStreamer(guildId: string): Map<number, StreamerDto['stats']> {
    const since = new Date(this.now() - STATS_WINDOW_DAYS * DAY_MS).toISOString();
    const map = new Map<number, StreamerDto['stats']>();
    for (const row of this.ctx.repos.sessions.totals(guildId, since)) {
      map.set(row.streamerId, {
        sessions30d: row.sessions,
        hours30d: Math.round((row.seconds / 3600) * 10) / 10,
        peakViewers30d: row.peakViewers,
      });
    }
    return map;
  }

  private liveStreamerIds(guildId: string): Set<number> {
    return new Set(this.ctx.repos.sessions.listActive(guildId).map((s) => s.streamerId));
  }

  /** Streamer summaries for history rows: cached Discord avatar, else the first channel avatar. */
  summaries(guildId: string): SummaryLookup {
    const memo = new Map<number, StreamerSummary | null>();
    return (streamerId) => {
      if (streamerId == null) return null;
      if (memo.has(streamerId)) return memo.get(streamerId)!;
      const streamer = this.ctx.repos.streamers.get(streamerId);
      const summary = streamer && streamer.guildId === guildId ? this.summaryOf(streamer) : null;
      memo.set(streamerId, summary);
      return summary;
    };
  }

  summaryOf(streamer: Streamer, fallbackAvatar?: string | null): StreamerSummary {
    let avatar = memberAvatar(this.members.peek(streamer.guildId, streamer.discordUserId)) ?? fallbackAvatar ?? null;
    if (!avatar) {
      avatar = this.ctx.repos.accounts.listForStreamer(streamer.id).find((a) => a.channel.avatarUrl)?.channel.avatarUrl ?? null;
    }
    return { id: streamer.id, discordUserId: streamer.discordUserId, displayName: streamer.displayName, avatarUrl: avatar };
  }

  /** Starts background member lookups so the next history/overview render has Discord avatars. */
  prefetchMembers(guildId: string, userIds: string[]): void {
    void this.members.warm(guildId, userIds, 0).catch(() => {});
  }

  // ───────────────────────────── sessions ─────────────────────────────

  session(session: LiveSession, streamer: StreamerSummary): SessionDto {
    let view: SummaryView | null = null;
    try {
      view = this.ctx.sessions.summaryOf(session.id);
    } catch (err) {
      log.warn({ err, sessionId: session.id }, 'Building session summary failed; using stored values');
    }
    const segments = view?.segments ?? this.ctx.repos.sessions.segments(session.id);
    const platforms: Platform[] = [];
    for (const seg of segments) if (!platforms.includes(seg.platform)) platforms.push(seg.platform);
    const vodUrls: SessionDto['vodUrls'] = [];
    for (const seg of segments) {
      if (seg.vodUrl && !vodUrls.some((v) => v.url === seg.vodUrl)) vodUrls.push({ platform: seg.platform, url: seg.vodUrl });
    }

    return {
      id: session.id,
      streamer,
      status: session.status,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      durationSec: view?.durationSec ?? this.fallbackDurationSec(session, segments),
      peakViewers: view?.peakViewers ?? session.peakViewers,
      avgViewers: view ? view.avgViewers : session.viewerSamples > 0 ? Math.round(session.viewerSum / session.viewerSamples) : null,
      platforms,
      categories: [...(view?.categories ?? session.categories)].sort((a, b) => b.seconds - a.seconds),
      titles: [...(view?.titles ?? session.titles)],
      vodUrls,
      messageUrl: this.messageUrl(session.guildId, session),
    };
  }

  private fallbackDurationSec(session: LiveSession, segments: Array<{ startedAt: string; endedAt: string | null }>): number {
    const nowMs = this.now();
    const start = parseMs(session.startedAt) ?? nowMs;
    const end = parseMs(session.endedAt) ?? nowMs;
    const intervals: Array<[number, number]> = segments.map((seg) => {
      const s = parseMs(seg.startedAt) ?? start;
      return [s, Math.max(s, parseMs(seg.endedAt) ?? end)];
    });
    const ms = intervals.length > 0 ? mergedDurationMs(intervals) : Math.max(0, end - start);
    return Math.round(ms / 1000);
  }

  messageUrl(guildId: string, ref: { messageChannelId: string | null; messageId: string | null }): string | null {
    if (!ref.messageChannelId || !ref.messageId) return null;
    const messageRef: MessageRef = { channelId: ref.messageChannelId, messageId: ref.messageId };
    try {
      return this.ctx.discord.messageUrl(guildId, messageRef);
    } catch {
      return `https://discord.com/channels/${guildId}/${messageRef.channelId}/${messageRef.messageId}`;
    }
  }

  liveNow(view: LiveView): LiveNowItem {
    const fallbackAvatar = view.platforms.find((p) => p.channel.avatarUrl)?.channel.avatarUrl ?? null;
    return {
      sessionId: view.session.id,
      streamer: this.summaryOf(view.streamer, fallbackAvatar),
      startedAt: view.session.startedAt,
      totalViewers: view.totalViewers,
      peakViewers: view.session.peakViewers,
      platforms: view.platforms.map((p) => ({
        platform: p.platform,
        channelId: p.channel.id,
        displayName: p.channel.displayName,
        url: p.snapshot.url || p.channel.url,
        snapshot: p.snapshot,
      })),
      messageUrl: this.messageUrl(view.guildId, view.session),
    };
  }

  // ───────────────────────────── content / leaderboard ─────────────────────────────

  /** Content rows of a guild; items whose channel was deleted are skipped (platform unknown). */
  contentList(items: Array<StoredContentItem & { streamerId: number | null }>, summaries: SummaryLookup): ContentDto[] {
    const platforms = new Map<number, Platform | null>();
    const out: ContentDto[] = [];
    for (const item of items) {
      if (!platforms.has(item.channelId)) platforms.set(item.channelId, this.ctx.repos.channels.get(item.channelId)?.platform ?? null);
      const platform = platforms.get(item.channelId);
      if (!platform) continue;
      out.push({
        id: item.id,
        streamer: summaries(item.streamerId),
        platform,
        kind: item.kind,
        title: item.title,
        url: item.url,
        thumbnailUrl: item.thumbnailUrl,
        publishedAt: item.publishedAt,
      });
    }
    return out;
  }

  leaderboard(guildId: string, days: number, limit = 50): LeaderboardEntry[] {
    const since = new Date(this.now() - days * DAY_MS).toISOString();
    const summaries = this.summaries(guildId);
    const entries: LeaderboardEntry[] = [];
    for (const row of this.ctx.repos.sessions.totals(guildId, since)) {
      const streamer = summaries(row.streamerId);
      if (!streamer) continue;
      entries.push({ streamer, seconds: row.seconds, sessions: row.sessions, peakViewers: row.peakViewers });
      if (entries.length >= limit) break;
    }
    return entries.sort((a, b) => b.seconds - a.seconds || b.peakViewers - a.peakViewers);
  }
}
