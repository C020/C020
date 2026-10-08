/**
 * Pure math for the hand-built SVG charts (#13): scales, "nice" axis ticks, paths and data shaping.
 * Kept framework-free so it is unit-tested; the React components in components/charts only draw.
 */
import type { Platform, SessionDetailDto, ViewerSampleDto } from '../api/types';
import { PLATFORMS } from './platforms';

/** Rounds up to 1/2/2.5/5 × 10^n so axis labels are readable. */
export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = 10 ** exp;
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * base;
    if (candidate >= value * (1 - 1e-9)) return candidate;
  }
  return 10 * base;
}

/** Evenly spaced ticks 0..max (inclusive), `count` intervals. */
export function ticks(max: number, count = 4): number[] {
  const n = Math.max(1, Math.round(count));
  return Array.from({ length: n + 1 }, (_, i) => (max * i) / n);
}

export type Scale = (value: number) => number;

/** Linear map from [d0, d1] to [r0, r1]; a zero-width domain maps to the middle of the range. */
export function linearScale(d0: number, d1: number, r0: number, r1: number): Scale {
  if (d1 === d0) return () => (r0 + r1) / 2;
  const k = (r1 - r0) / (d1 - d0);
  return (v) => r0 + (v - d0) * k;
}

export interface Point {
  x: number;
  y: number;
}

const fmt = (n: number): string => (Math.round(n * 10) / 10).toString();

/**
 * Polyline path; `null` points break the line into separate segments (gaps where no platform reported viewers).
 */
export function linePath(points: ReadonlyArray<Point | null>): string {
  let d = '';
  let pen = false;
  for (const p of points) {
    if (!p) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${fmt(p.x)} ${fmt(p.y)}`;
    pen = true;
  }
  return d;
}

/** Closed area path for each continuous run of points, down to `baseline`. */
export function areaPath(points: ReadonlyArray<Point | null>, baseline: number): string {
  const runs: Point[][] = [];
  let run: Point[] = [];
  for (const p of points) {
    if (p) run.push(p);
    else if (run.length) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);
  return runs
    .map((r) => {
      const first = r[0]!;
      const last = r[r.length - 1]!;
      const top = r.map((p, i) => `${i === 0 ? 'M' : 'L'}${fmt(p.x)} ${fmt(p.y)}`).join('');
      return `${top}L${fmt(last.x)} ${fmt(baseline)}L${fmt(first.x)} ${fmt(baseline)}Z`;
    })
    .join('');
}

/** Index of the value in a sorted array closest to `x` (-1 for an empty array). */
export function nearestIndex(sorted: readonly number[], x: number): number {
  if (sorted.length === 0) return -1;
  let lo = 0;
  let hi = sorted.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < x) lo = mid;
    else hi = mid;
  }
  return Math.abs(sorted[lo]! - x) <= Math.abs(sorted[hi]! - x) ? lo : hi;
}

/** Mirrors an x coordinate for right-to-left layouts (time flows from the right in Arabic). */
export function mirrorX(x: number, width: number, rtl: boolean): number {
  return rtl ? width - x : x;
}

export interface ViewerSeries {
  times: number[];
  total: Array<number | null>;
  platforms: Array<{ platform: Platform; values: Array<number | null> }>;
  categories: Array<string | null>;
  max: number;
}

/** Samples sorted by time, with per-platform series for the platforms that reported at least once. */
export function viewerSeries(samples: readonly ViewerSampleDto[]): ViewerSeries {
  const sorted = samples
    .map((s) => ({ s, at: Date.parse(s.at) }))
    .filter((x) => Number.isFinite(x.at))
    .sort((a, b) => a.at - b.at);
  const times = sorted.map((x) => x.at);
  const total = sorted.map(({ s }) => (typeof s.total === 'number' && Number.isFinite(s.total) ? s.total : null));
  const platforms = PLATFORMS.filter((p) => sorted.some(({ s }) => typeof s.platforms[p] === 'number')).map((platform) => ({
    platform,
    values: sorted.map(({ s }) => {
      const v = s.platforms[platform];
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    }),
  }));
  let max = 0;
  for (const v of total) if (v !== null && v > max) max = v;
  for (const p of platforms) for (const v of p.values) if (v !== null && v > max) max = v;
  return { times, total, platforms, categories: sorted.map(({ s }) => s.category), max };
}

export interface CategorySpan {
  name: string;
  start: number;
  end: number;
}

/**
 * Category timeline from samples: consecutive samples with the same category merge into one span; a span lasts until
 * the next sample (the last one until the session end).
 */
export function categorySpans(samples: readonly ViewerSampleDto[], endMs: number): CategorySpan[] {
  const sorted = [...samples].map((s) => ({ at: Date.parse(s.at), category: s.category })).filter((s) => Number.isFinite(s.at)).sort((a, b) => a.at - b.at);
  const spans: CategorySpan[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const nextAt = sorted[i + 1]?.at ?? Math.max(endMs, cur.at);
    const name = cur.category?.trim();
    if (!name) continue;
    const prev = spans[spans.length - 1];
    if (prev && prev.name === name && prev.end >= cur.at) prev.end = nextAt;
    else spans.push({ name, start: cur.at, end: nextAt });
  }
  return spans;
}

/** End of the session for charting: endedAt, else the last sample, else now. */
export function sessionEndMs(session: Pick<SessionDetailDto, 'endedAt' | 'samples' | 'status'>, nowMs: number): number {
  if (session.endedAt) return Date.parse(session.endedAt);
  if (session.status === 'live') return nowMs;
  const last = session.samples[session.samples.length - 1];
  return last ? Date.parse(last.at) : nowMs;
}

/** Share of a total as a 0..100 percentage, rounded to one decimal; 0 when the total is 0. */
export function percent(part: number, total: number): number {
  if (!(total > 0) || !Number.isFinite(part)) return 0;
  return Math.round((part / total) * 1000) / 10;
}

/** Opacity 0.08..1 for a heat-strip cell relative to the busiest cell. */
export function heatLevel(value: number, max: number): number {
  if (!(max > 0) || !(value > 0)) return 0;
  return 0.08 + 0.92 * Math.min(1, value / max);
}

/**
 * Daily series covering the whole range, oldest first: days missing from the server response are zero-filled so
 * the bar chart has one bar per day. `days` dates end at `lastDate` (YYYY-MM-DD).
 */
export function fillDaily<T extends { date: string; seconds: number }>(daily: readonly T[], days: number, lastDate: string): Array<{ date: string; seconds: number; item: T | null }> {
  const byDate = new Map(daily.map((d) => [d.date, d]));
  const end = Date.parse(`${lastDate}T00:00:00Z`);
  if (!Number.isFinite(end) || days <= 0) return [...daily].sort((a, b) => a.date.localeCompare(b.date)).map((d) => ({ date: d.date, seconds: d.seconds, item: d }));
  const out: Array<{ date: string; seconds: number; item: T | null }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(end - i * 86_400_000).toISOString().slice(0, 10);
    const item = byDate.get(date) ?? null;
    out.push({ date, seconds: item?.seconds ?? 0, item });
  }
  return out;
}

/** Latest date among the series (YYYY-MM-DD) or the given fallback. */
export function lastDateOf(daily: ReadonlyArray<{ date: string }>, fallback: string): string {
  let last = '';
  for (const d of daily) if (d.date > last) last = d.date;
  return last && last > fallback ? last : fallback;
}

export const STATS_RANGES = [7, 30, 90, 365] as const;
export type StatsRangeValue = (typeof STATS_RANGES)[number];

export function parseRange(value: string | null): StatsRangeValue {
  const n = Number(value);
  return (STATS_RANGES as readonly number[]).includes(n) ? (n as StatsRangeValue) : 30;
}

/** Today's date (YYYY-MM-DD) in a timezone; falls back to UTC when the zone is unknown. */
export function todayIn(timezone: string | undefined, nowMs = Date.now()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(nowMs);
  } catch {
    return new Date(nowMs).toISOString().slice(0, 10);
  }
}
