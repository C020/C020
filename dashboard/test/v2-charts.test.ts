import { describe, expect, it } from 'vitest';
import { areaPath, categorySpans, fillDaily, heatLevel, lastDateOf, linePath, linearScale, mirrorX, nearestIndex, niceMax, parseRange, percent, sessionEndMs, ticks, todayIn, viewerSeries } from '../src/lib/charts';

describe('chart math', () => {
  it('rounds axis maxima to readable values', () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(-5)).toBe(1);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(130)).toBe(200);
    expect(niceMax(240)).toBe(250);
    expect(niceMax(1000)).toBe(1000);
    expect(niceMax(0.3)).toBeCloseTo(0.5);
    expect(ticks(200, 4)).toEqual([0, 50, 100, 150, 200]);
  });

  it('scales linearly and handles a zero-width domain', () => {
    const s = linearScale(0, 10, 100, 0);
    expect(s(0)).toBe(100);
    expect(s(5)).toBe(50);
    expect(linearScale(3, 3, 0, 10)(3)).toBe(5);
    expect(mirrorX(10, 100, true)).toBe(90);
    expect(mirrorX(10, 100, false)).toBe(10);
  });

  it('builds line and area paths with gaps', () => {
    const pts = [{ x: 0, y: 10 }, { x: 5, y: 5 }, null, { x: 10, y: 0 }];
    expect(linePath(pts)).toBe('M0 10L5 5M10 0');
    expect(areaPath(pts, 20)).toBe('M0 10L5 5L5 20L0 20ZM10 0L10 20L10 20Z');
    expect(linePath([])).toBe('');
  });

  it('finds the nearest sample', () => {
    expect(nearestIndex([], 4)).toBe(-1);
    expect(nearestIndex([0, 10, 20], 14)).toBe(1);
    expect(nearestIndex([0, 10, 20], 16)).toBe(2);
    expect(nearestIndex([0, 10, 20], -5)).toBe(0);
    expect(nearestIndex([0, 10, 20], 99)).toBe(2);
  });

  it('computes percentages and heat levels safely', () => {
    expect(percent(1, 3)).toBe(33.3);
    expect(percent(5, 0)).toBe(0);
    expect(heatLevel(0, 10)).toBe(0);
    expect(heatLevel(10, 10)).toBe(1);
    expect(heatLevel(5, 0)).toBe(0);
  });
});

describe('viewer data shaping', () => {
  const samples = [
    { at: '2026-10-01T20:02:00Z', total: 120, platforms: { twitch: 100, kick: 20 }, category: 'Valorant' },
    { at: '2026-10-01T20:00:00Z', total: 100, platforms: { twitch: 100 }, category: 'Just Chatting' },
    { at: '2026-10-01T20:01:00Z', total: null, platforms: {}, category: 'Valorant' },
    { at: 'garbage', total: 5, platforms: {}, category: null },
  ];

  it('sorts samples, keeps nulls as gaps and only includes reporting platforms', () => {
    const s = viewerSeries(samples);
    expect(s.times).toHaveLength(3);
    expect(s.total).toEqual([100, null, 120]);
    expect(s.platforms.map((p) => p.platform)).toEqual(['twitch', 'kick']);
    expect(s.platforms[1]?.values).toEqual([null, null, 20]);
    expect(s.max).toBe(120);
  });

  it('merges consecutive categories into spans ending at the next sample / session end', () => {
    const end = Date.parse('2026-10-01T20:10:00Z');
    const spans = categorySpans(samples, end);
    expect(spans.map((s) => s.name)).toEqual(['Just Chatting', 'Valorant']);
    expect(spans[0]?.end).toBe(Date.parse('2026-10-01T20:01:00Z'));
    expect(spans[1]?.end).toBe(end);
  });

  it('picks the session end for charting', () => {
    const now = Date.parse('2026-10-02T00:00:00Z');
    expect(sessionEndMs({ endedAt: '2026-10-01T21:00:00Z', samples: [], status: 'ended' }, now)).toBe(Date.parse('2026-10-01T21:00:00Z'));
    expect(sessionEndMs({ endedAt: null, samples: [], status: 'live' }, now)).toBe(now);
  });
});

describe('daily series', () => {
  it('zero-fills missing days, oldest first', () => {
    const out = fillDaily([{ date: '2026-10-03', seconds: 3600, sessions: 1, peakViewers: 5 }], 3, '2026-10-04');
    expect(out.map((d) => [d.date, d.seconds])).toEqual([
      ['2026-10-02', 0],
      ['2026-10-03', 3600],
      ['2026-10-04', 0],
    ]);
    expect(out[1]?.item?.sessions).toBe(1);
  });

  it('uses the latest date of the series when it is after the fallback', () => {
    expect(lastDateOf([{ date: '2026-10-09' }], '2026-10-08')).toBe('2026-10-09');
    expect(lastDateOf([], '2026-10-08')).toBe('2026-10-08');
  });

  it('parses ranges and today in a timezone', () => {
    expect(parseRange('90')).toBe(90);
    expect(parseRange('12')).toBe(30);
    expect(parseRange(null)).toBe(30);
    const ms = Date.parse('2026-10-08T22:30:00Z');
    expect(todayIn('Asia/Riyadh', ms)).toBe('2026-10-09');
    expect(todayIn('UTC', ms)).toBe('2026-10-08');
    expect(todayIn('Bad/Zone', ms)).toBe('2026-10-08');
  });
});
