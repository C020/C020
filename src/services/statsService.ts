/**
 * #13 — advanced statistics: per-streamer aggregates over a period and the viewer samples of a session.
 *
 * Design notes
 * - Read-only over the DB (sessions, segments, samples, content notifications); nothing is cached, every call
 *   reflects the current state, including a session that is still live (its open intervals end "now").
 * - Live time is the union of the platform segments (a reconnect gap or a second platform is never counted
 *   twice), clipped to the period. Sessions without segments (their channel was deleted) fall back to
 *   started → ended.
 * - Days and hours are LOCAL to the guild timezone (features.timezone, IANA): the period is the last `days` local
 *   days including today, live time is split at local midnights and local hour boundaries (DST-safe, also for
 *   :30/:45 offsets). An invalid timezone falls back to the default one.
 * - A session that overlaps the period counts once (on the local day it started, or the first day of the period
 *   when it started earlier), so the daily session counts add up to the total.
 */
import type { StatsServiceApi, StreamerStatsData } from '../app/context.js';
import { ValidationError } from '../core/errors.js';
import { childLogger } from '../core/logger.js';
import type { Platform } from '../core/types.js';
import { PLATFORMS } from '../core/types.js';
import type { Db } from '../db/database.js';
import { DEFAULT_GUILD_FEATURES } from '../db/features.js';
import type { LiveSample, LiveSegment, LiveSession } from '../db/models.js';
import type { Repositories } from '../db/repositories.js';
import { categoryKey, iso, mergedDurationMs, mergeIntervals, parseTime } from './views.js';

const log = childLogger('stats');

/** Periods offered by the dashboard. */
export const STATS_PERIODS = [7, 30, 90, 365] as const;
export type StatsPeriod = (typeof STATS_PERIODS)[number];
const DEFAULT_PERIOD: StatsPeriod = 30;
/** Categories returned by streamerStats (largest first). */
const TOP_CATEGORIES = 10;
const RECENT_SESSIONS = 10;
/** Upper bound of samples returned for one session (a 25h stream at one sample per minute). */
export const MAX_SESSION_SAMPLES = 1_500;

export interface StatsServiceDeps {
  repos: Repositories;
  /** Injectable clock (ms since epoch) for deterministic tests. */
  clock?: () => number;
}

/** Maps any requested number of days to a supported period (the next larger one, capped at a year). */
export function normalizeStatsDays(days: number): StatsPeriod {
  if (!Number.isFinite(days) || days <= 0) return DEFAULT_PERIOD;
  return STATS_PERIODS.find((p) => p >= days) ?? 365;
}

// ───────────────────────────── timezone calendar ─────────────────────────────

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** True when the runtime knows the IANA timezone. */
export function isValidTimeZone(timeZone: string | null | undefined): timeZone is string {
  if (!timeZone || typeof timeZone !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The guild timezone when valid, else the default one (Asia/Riyadh), else UTC. */
export function resolveTimeZone(timeZone: string | null | undefined): string {
  if (isValidTimeZone(timeZone)) return timeZone;
  return isValidTimeZone(DEFAULT_GUILD_FEATURES.timezone) ? DEFAULT_GUILD_FEATURES.timezone : 'UTC';
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** Shifts a YYYY-MM-DD date by whole days (calendar arithmetic, no timezone involved). */
export function addDays(dateKey: string, delta: number): string {
  const [y, m, d] = dateKey.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d + delta));
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Local calendar of one IANA timezone (wall-clock parts, local dates, local midnights, hour boundaries). */
export class ZonedCalendar {
  private readonly fmt: Intl.DateTimeFormat;

  constructor(readonly timeZone: string) {
    this.fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  parts(ms: number): ZonedParts {
    const out: ZonedParts = { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
    for (const part of this.fmt.formatToParts(new Date(ms))) {
      if (part.type in out) out[part.type as keyof ZonedParts] = Number(part.value);
    }
    if (out.hour === 24) out.hour = 0; // very old ICU data renders midnight as 24 even with h23
    return out;
  }

  dateKey(ms: number): string {
    return this.keyOf(this.parts(ms));
  }

  keyOf(p: ZonedParts): string {
    return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
  }

  /** Local offset from UTC at an instant (ms; positive east of Greenwich). */
  offsetMs(ms: number): number {
    const p = this.parts(ms);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
  }

  /** First instant of a local date (local midnight, or the first existing instant when DST skips midnight). */
  startOfDay(dateKey: string): number {
    const [y, m, d] = dateKey.split('-').map(Number) as [number, number, number];
    const wall = Date.UTC(y, m - 1, d);
    let t = wall - this.offsetMs(wall);
    t = wall - this.offsetMs(t); // second pass: the offset at the result may differ from the guess (DST)
    // A DST jump at midnight makes 00:00 not exist: step to the first instant that belongs to the date.
    if (this.dateKey(t) < dateKey) t = this.nextHourBoundary(t);
    return t;
  }

  /** Next local full hour strictly after `ms` (local hours also bound local days). */
  nextHourBoundary(ms: number, parts: ZonedParts = this.parts(ms)): number {
    const subSecond = ((ms % 1000) + 1000) % 1000;
    return ms - subSecond + (3600 - (parts.minute * 60 + parts.second)) * 1000;
  }
}

/**
 * Walks [start, end) in pieces that never cross a local hour boundary and reports each piece with its local date
 * and hour. The number of pieces is bounded by the hours covered (callers clip intervals to the period).
 */
export function forEachLocalHour(cal: ZonedCalendar, start: number, end: number, fn: (dateKey: string, hour: number, ms: number) => void): void {
  let t = start;
  while (t < end) {
    const parts = cal.parts(t);
    const boundary = Math.min(end, Math.max(t + 1, cal.nextHourBoundary(t, parts)));
    fn(cal.keyOf(parts), parts.hour, boundary - t);
    t = boundary;
  }
}

// ───────────────────────────── service ─────────────────────────────

interface SessionSpan {
  session: LiveSession;
  segments: LiveSegment[];
  /** Union of the session's live intervals (all platforms), unclipped. */
  union: Array<[number, number]>;
  /** The union clipped to the period. */
  clipped: Array<[number, number]>;
}

type Row = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : Number(v ?? 0));

export class StatsService implements StatsServiceApi {
  private readonly repos: Repositories;
  private readonly clock: () => number;

  constructor(deps: StatsServiceDeps) {
    this.repos = deps.repos;
    this.clock = deps.clock ?? Date.now;
  }

  private get db(): Db {
    return this.repos.db;
  }

  /**
   * Viewer samples of a session, oldest first. Very long sessions are reduced to at most MAX_SESSION_SAMPLES
   * points (keeping the busiest sample of each bucket, so peaks survive).
   */
  sessionSamples(sessionId: number): LiveSample[] {
    const samples = this.repos.samples.forSession(sessionId);
    return downsampleSamples(samples, MAX_SESSION_SAMPLES);
  }

  /** Aggregates of one streamer over the last `days` local days (7, 30, 90 or 365; other values are normalized). */
  streamerStats(guildId: string, streamerId: number, days: number): StreamerStatsData {
    const settings = this.repos.settings.get(guildId);
    const streamer = this.repos.streamers.get(streamerId);
    if (!streamer || streamer.guildId !== guildId) {
      throw new ValidationError(settings.features.language === 'en' ? 'Streamer not found' : 'الستريمر غير موجود', 'streamerId');
    }
    const period = normalizeStatsDays(days);
    const cal = new ZonedCalendar(resolveTimeZone(settings.features.timezone));
    const now = this.clock();

    const todayKey = cal.dateKey(now);
    const dayKeys = Array.from({ length: period }, (_, i) => addDays(todayKey, i - (period - 1)));
    const firstDay = dayKeys[0] ?? todayKey;
    const windowStart = Math.min(cal.startOfDay(firstDay), now);
    const windowEnd = now;
    const clip = (intervals: Array<[number, number]>): Array<[number, number]> =>
      intervals.map(([s, e]): [number, number] => [Math.max(s, windowStart), Math.min(e, windowEnd)]).filter(([s, e]) => e > s);

    const spans: SessionSpan[] = this.sessionsOverlapping(guildId, streamerId, iso(windowStart), iso(windowEnd)).map((session) => {
      const segments = this.repos.sessions.segments(session.id);
      const union = sessionUnion(session, segments, now);
      return { session, segments, union, clipped: clip(union) };
    });

    // ── daily + hour-of-day ──
    const daily = new Map(dayKeys.map((date) => [date, { date, ms: 0, sessions: 0, peakViewers: 0 }]));
    const hours = Array.from({ length: 24 }, () => 0);
    const allClipped = mergeIntervals(spans.flatMap((s) => s.clipped));
    for (const [s, e] of allClipped) {
      forEachLocalHour(cal, s, e, (dateKey, hour, ms) => {
        const day = daily.get(dateKey);
        if (day) day.ms += ms;
        hours[hour] = (hours[hour] ?? 0) + ms;
      });
    }
    for (const span of spans) {
      const startMs = Math.max(parseTime(span.session.startedAt) ?? windowStart, windowStart);
      const startDay = daily.get(cal.dateKey(Math.min(startMs, windowEnd)));
      if (startDay) startDay.sessions += 1;
      this.applyDailyPeaks(cal, span, daily);
    }

    // ── platforms ──
    const platforms = new Map<Platform, { intervals: Array<[number, number]>; sessions: Set<number>; peakViewers: number }>();
    for (const span of spans) {
      for (const seg of span.segments) {
        const interval = segmentInterval(span.session, seg, now);
        const inWindow = interval[0] < windowEnd && interval[1] >= windowStart;
        if (!inWindow) continue;
        let entry = platforms.get(seg.platform);
        if (!entry) platforms.set(seg.platform, (entry = { intervals: [], sessions: new Set(), peakViewers: 0 }));
        entry.intervals.push(...clip([interval]));
        entry.sessions.add(span.session.id);
        entry.peakViewers = Math.max(entry.peakViewers, seg.peakViewers);
      }
    }

    // ── categories (time inside the period only, pro rata for sessions crossing its start) ──
    const categories = new Map<string, { names: Map<string, number>; seconds: number }>();
    for (const span of spans) {
      const total = mergedDurationMs(span.union);
      const inside = mergedDurationMs(span.clipped);
      const factor = total > 0 ? Math.min(1, inside / total) : 1;
      for (const c of span.session.categories) {
        const seconds = Math.max(0, Number(c.seconds) || 0) * factor;
        if (seconds <= 0 || !c.name) continue;
        const key = categoryKey(c.name);
        let entry = categories.get(key);
        if (!entry) categories.set(key, (entry = { names: new Map(), seconds: 0 }));
        entry.seconds += seconds;
        entry.names.set(c.name, (entry.names.get(c.name) ?? 0) + seconds);
      }
    }

    // ── totals ──
    let viewerSum = 0;
    let viewerSamples = 0;
    let peakViewers = 0;
    for (const { session } of spans) {
      viewerSum += Math.max(0, session.viewerSum);
      viewerSamples += Math.max(0, session.viewerSamples);
      peakViewers = Math.max(peakViewers, session.peakViewers);
    }

    return {
      streamerId,
      days: period,
      totals: {
        sessions: spans.length,
        seconds: Math.round(mergedDurationMs(allClipped) / 1000),
        peakViewers,
        avgViewers: viewerSamples > 0 ? Math.round(viewerSum / viewerSamples) : null,
        contentPosts: this.countContentPosts(guildId, streamerId, iso(windowStart)),
      },
      daily: dayKeys.map((date) => {
        const d = daily.get(date)!;
        return { date, seconds: Math.round(d.ms / 1000), sessions: d.sessions, peakViewers: d.peakViewers };
      }),
      platforms: [...platforms.entries()]
        .map(([platform, p]) => ({
          platform,
          seconds: Math.round(mergedDurationMs(p.intervals) / 1000),
          sessions: p.sessions.size,
          peakViewers: p.peakViewers,
        }))
        .sort((a, b) => b.seconds - a.seconds || PLATFORMS.indexOf(a.platform) - PLATFORMS.indexOf(b.platform)),
      categories: [...categories.values()]
        .map((c) => ({ name: [...c.names.entries()].sort((a, b) => b[1] - a[1])[0]![0], seconds: Math.round(c.seconds) }))
        .filter((c) => c.seconds > 0)
        .sort((a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name))
        .slice(0, TOP_CATEGORIES),
      hours: hours.map((ms) => Math.round(ms / 1000)),
      recentSessionIds: this.recentSessionIds(guildId, streamerId),
    };
  }

  /**
   * Peak viewers per local day: a session within one day contributes its peak; a session spanning several days
   * contributes, per day, the highest sample of that day (its overall peak for days without samples).
   */
  private applyDailyPeaks(cal: ZonedCalendar, span: SessionSpan, daily: Map<string, { peakViewers: number }>): void {
    const days = new Set<string>();
    for (const [s, e] of span.clipped) {
      for (let key = cal.dateKey(s), last = cal.dateKey(e - 1); key <= last; key = addDays(key, 1)) days.add(key);
    }
    if (days.size === 0) return;
    const peak = Math.max(0, span.session.peakViewers);
    if (days.size === 1) {
      const day = daily.get([...days][0]!);
      if (day) day.peakViewers = Math.max(day.peakViewers, peak);
      return;
    }
    const byDay = new Map<string, number>();
    try {
      for (const sample of this.repos.samples.forSession(span.session.id)) {
        const at = parseTime(sample.at);
        if (at === null || sample.totalViewers == null) continue;
        const key = cal.dateKey(at);
        byDay.set(key, Math.max(byDay.get(key) ?? 0, sample.totalViewers));
      }
    } catch (err) {
      log.warn({ err, sessionId: span.session.id }, 'Reading samples for daily peaks failed');
    }
    for (const key of days) {
      const day = daily.get(key);
      if (day) day.peakViewers = Math.max(day.peakViewers, byDay.get(key) ?? peak);
    }
  }

  private sessionsOverlapping(guildId: string, streamerId: number, fromIso: string, toIso: string): LiveSession[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM live_sessions WHERE guild_id = ? AND streamer_id = ? AND started_at < ? AND (ended_at IS NULL OR ended_at > ?)
         ORDER BY started_at, id`,
      )
      .all(guildId, streamerId, toIso, fromIso) as Row[];
    const sessions: LiveSession[] = [];
    for (const row of rows) {
      const session = this.repos.sessions.get(num(row.id));
      if (session) sessions.push(session);
    }
    return sessions;
  }

  private recentSessionIds(guildId: string, streamerId: number): number[] {
    const rows = this.db
      .prepare('SELECT id FROM live_sessions WHERE guild_id = ? AND streamer_id = ? ORDER BY started_at DESC, id DESC LIMIT ?')
      .all(guildId, streamerId, RECENT_SESSIONS) as Row[];
    return rows.map((r) => num(r.id));
  }

  private countContentPosts(guildId: string, streamerId: number, sinceIso: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM content_notifications WHERE guild_id = ? AND streamer_id = ? AND created_at >= ?')
      .get(guildId, streamerId, sinceIso) as Row | undefined;
    return num(row?.n);
  }
}

/** [start, end] of a segment; an open one ends now (live session) or with its session. */
function segmentInterval(session: LiveSession, seg: LiveSegment, now: number): [number, number] {
  const sessionStart = parseTime(session.startedAt) ?? now;
  const sessionEnd = session.status === 'live' ? now : (parseTime(session.endedAt) ?? now);
  const start = Math.min(parseTime(seg.startedAt) ?? sessionStart, now);
  const end = Math.min(parseTime(seg.endedAt) ?? sessionEnd, now);
  return [start, Math.max(start, end)];
}

/** Union of the live intervals of a session (started → ended when it has no segments anymore). */
function sessionUnion(session: LiveSession, segments: LiveSegment[], now: number): Array<[number, number]> {
  if (segments.length > 0) return mergeIntervals(segments.map((seg) => segmentInterval(session, seg, now)));
  const start = Math.min(parseTime(session.startedAt) ?? now, now);
  const end = session.status === 'live' ? now : Math.min(parseTime(session.endedAt) ?? now, now);
  return end > start ? [[start, end]] : [];
}

/** Reduces samples to at most `max` points: consecutive buckets, keeping each bucket's busiest sample. */
export function downsampleSamples(samples: LiveSample[], max: number): LiveSample[] {
  if (max <= 0 || samples.length <= max) return samples;
  const out: LiveSample[] = [];
  const size = samples.length / max;
  for (let i = 0; i < max; i++) {
    const bucket = samples.slice(Math.floor(i * size), Math.floor((i + 1) * size));
    let best: LiveSample | undefined;
    for (const s of bucket) if (!best || (s.totalViewers ?? -1) > (best.totalViewers ?? -1)) best = s;
    if (best) out.push(best);
  }
  return out;
}
