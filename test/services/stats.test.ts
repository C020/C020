import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/logger.js', async () => {
  const { pino } = await import('pino');
  const logger = pino({ level: 'silent' });
  return { logger, childLogger: () => logger };
});

import { ValidationError } from '../../src/core/errors.js';
import type { Platform } from '../../src/core/types.js';
import type { Channel, LiveSample, LiveSession, SessionCategory } from '../../src/db/models.js';
import {
  addDays,
  downsampleSamples,
  forEachLocalHour,
  normalizeStatsDays,
  resolveTimeZone,
  StatsService,
  ZonedCalendar,
} from '../../src/services/statsService.js';
import { addStreamer, configureGuild, createEnv, type Env, resolved } from './helpers.js';

const NOW = Date.parse('2026-10-05T12:00:00.000Z'); // 15:00 in Riyadh
const H = 3_600_000;
const USER = '100000000000000001';

describe('timezone calendar', () => {
  it('maps instants to local dates and finds local midnights (Riyadh, UTC+3)', () => {
    const cal = new ZonedCalendar('Asia/Riyadh');
    expect(cal.dateKey(Date.parse('2026-10-04T21:00:00Z'))).toBe('2026-10-05');
    expect(cal.dateKey(Date.parse('2026-10-04T20:59:59Z'))).toBe('2026-10-04');
    expect(new Date(cal.startOfDay('2026-10-05')).toISOString()).toBe('2026-10-04T21:00:00.000Z');
  });

  it('handles DST days (New York: a 23-hour day in March)', () => {
    const cal = new ZonedCalendar('America/New_York');
    const start = cal.startOfDay('2026-03-08');
    const next = cal.startOfDay('2026-03-09');
    expect(new Date(start).toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(new Date(next).toISOString()).toBe('2026-03-09T04:00:00.000Z');
    let total = 0;
    const hours = new Set<number>();
    forEachLocalHour(cal, start, next, (date, hour, ms) => {
      expect(date).toBe('2026-03-08');
      hours.add(hour);
      total += ms;
    });
    expect(total).toBe(23 * H);
    expect(hours.has(2)).toBe(false); // 02:00 does not exist that night
  });

  it('local midnight is always the first instant of the local date (also when DST skips midnight)', () => {
    for (const tz of ['Asia/Riyadh', 'America/New_York', 'America/Santiago', 'Asia/Kolkata', 'Australia/Lord_Howe', 'UTC']) {
      const cal = new ZonedCalendar(tz);
      for (let day = '2026-01-01'; day <= '2026-12-31'; day = addDays(day, 7)) {
        const start = cal.startOfDay(day);
        expect(cal.dateKey(start), `${tz} ${day}`).toBe(day);
        expect(cal.dateKey(start - 1) < day, `${tz} ${day}`).toBe(true);
      }
      // Santiago skips 00:00 on 2026-09-06.
      const s = cal.startOfDay('2026-09-06');
      expect(cal.dateKey(s)).toBe('2026-09-06');
      expect(cal.dateKey(s - 1)).toBe('2026-09-05');
    }
  });

  it('splits at local hour boundaries for half-hour offsets (Kolkata, UTC+5:30)', () => {
    const cal = new ZonedCalendar('Asia/Kolkata');
    const pieces: Array<[string, number, number]> = [];
    forEachLocalHour(cal, Date.parse('2026-10-05T12:00:00Z'), Date.parse('2026-10-05T13:15:00Z'), (d, h, ms) => pieces.push([d, h, ms]));
    expect(pieces).toEqual([
      ['2026-10-05', 17, 30 * 60_000],
      ['2026-10-05', 18, 45 * 60_000],
    ]);
  });

  it('falls back to the default timezone for invalid names', () => {
    expect(resolveTimeZone('Mars/Olympus')).toBe('Asia/Riyadh');
    expect(resolveTimeZone('')).toBe('Asia/Riyadh');
    expect(resolveTimeZone('Europe/Berlin')).toBe('Europe/Berlin');
  });

  it('adds calendar days across months and years', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('normalizeStatsDays', () => {
  it('maps any request to a supported period', () => {
    expect(normalizeStatsDays(7)).toBe(7);
    expect(normalizeStatsDays(30)).toBe(30);
    expect(normalizeStatsDays(90)).toBe(90);
    expect(normalizeStatsDays(365)).toBe(365);
    expect(normalizeStatsDays(10)).toBe(30);
    expect(normalizeStatsDays(1000)).toBe(365);
    expect(normalizeStatsDays(Number.NaN)).toBe(30);
    expect(normalizeStatsDays(-5)).toBe(30);
  });
});

describe('downsampleSamples', () => {
  const sample = (i: number, total: number | null): LiveSample => ({ id: i, sessionId: 1, at: new Date(NOW + i * 60_000).toISOString(), totalViewers: total, platforms: {}, category: null });

  it('returns short series unchanged and keeps the busiest sample of each bucket', () => {
    const short = [sample(1, 5), sample(2, 6)];
    expect(downsampleSamples(short, 10)).toBe(short);
    const long = [1, 9, 2, 3, 8, 4, null, 7, 5, 6].map((v, i) => sample(i, v));
    expect(downsampleSamples(long, 5).map((s) => s.totalViewers)).toEqual([9, 3, 8, 7, 6]);
  });
});

describe('StatsService.streamerStats', () => {
  let env: Env;
  let stats: StatsService;
  let streamerId: number;
  let twitch: Channel;
  let kick: Channel;

  const session = (opts: {
    start: string;
    end: string | null;
    peak?: number;
    viewerSum?: number;
    viewerSamples?: number;
    categories?: Array<Pick<SessionCategory, 'name' | 'seconds'>>;
    segments: Array<{ channel: Channel; start: string; end: string | null; peak?: number }>;
    guildId?: string;
    sid?: number;
  }): LiveSession => {
    const s = env.repos.sessions.create({ guildId: opts.guildId ?? 'g1', streamerId: opts.sid ?? streamerId, startedAt: opts.start });
    const saved: LiveSession = {
      ...s,
      status: opts.end ? 'ended' : 'live',
      endedAt: opts.end,
      peakViewers: opts.peak ?? 0,
      viewerSum: opts.viewerSum ?? 0,
      viewerSamples: opts.viewerSamples ?? 0,
      categories: (opts.categories ?? []).map((c) => ({ ...c, imageUrl: null, firstSeenAt: opts.start })),
    };
    env.repos.sessions.save(saved);
    for (const seg of opts.segments) {
      const added = env.repos.sessions.addSegment({
        sessionId: s.id,
        channelId: seg.channel.id,
        platform: seg.channel.platform as Platform,
        streamId: null,
        startedAt: seg.start,
        viewers: seg.peak ?? 0,
      });
      env.repos.sessions.saveSegment({ ...added, endedAt: seg.end, peakViewers: seg.peak ?? 0 });
    }
    return saved;
  };

  const sample = (sessionId: number, at: string, total: number) =>
    env.repos.samples.add({ sessionId, at, totalViewers: total, platforms: {}, category: null });

  const notification = (at: string, sid = streamerId, guildId = 'g1') => {
    const { item } = env.repos.content.insert(
      twitch.id,
      {
        platform: 'twitch',
        platformId: twitch.platformId,
        contentId: `c-${at}-${sid}-${guildId}`,
        kind: 'clip',
        title: 'clip',
        url: 'https://clips.example.com/x',
        thumbnailUrl: null,
        publishedAt: at,
        durationSec: 30,
        viewCount: 10,
      },
      true,
    );
    env.repos.db
      .prepare('INSERT INTO content_notifications (content_item_id, guild_id, streamer_id, message_channel_id, message_id, created_at) VALUES (?, ?, ?, NULL, NULL, ?)')
      .run(item.id, guildId, sid, at);
  };

  let a: LiveSession;
  let b: LiveSession;
  let c: LiveSession;
  let d: LiveSession;

  beforeEach(() => {
    env = createEnv();
    configureGuild(env.repos, 'g1');
    const reg = addStreamer(env.repos, 'g1', USER, [resolved('twitch', 'tw1', 'abu_tw'), resolved('kick', 'k1', 'abu_kick')]);
    streamerId = reg.streamer.id;
    [twitch, kick] = reg.channels as [Channel, Channel];
    stats = new StatsService({ repos: env.repos, clock: () => NOW });

    // A: 23:00 (Oct 3) → 02:00 (Oct 4) Riyadh; Kick joins for one hour.
    a = session({
      start: '2026-10-03T20:00:00.000Z',
      end: '2026-10-03T23:00:00.000Z',
      peak: 500,
      viewerSum: 1_080_000,
      viewerSamples: 10_800,
      categories: [
        { name: 'Valorant', seconds: 7200 },
        { name: 'Just Chatting', seconds: 3600 },
      ],
      segments: [
        { channel: twitch, start: '2026-10-03T20:00:00.000Z', end: '2026-10-03T23:00:00.000Z', peak: 400 },
        { channel: kick, start: '2026-10-03T21:00:00.000Z', end: '2026-10-03T22:00:00.000Z', peak: 150 },
      ],
    });
    sample(a.id, '2026-10-03T20:30:00.000Z', 450);
    sample(a.id, '2026-10-03T22:00:00.000Z', 500);
    // B: live since 13:00 Riyadh today.
    b = session({
      start: '2026-10-05T10:00:00.000Z',
      end: null,
      peak: 300,
      viewerSum: 1_440_000,
      viewerSamples: 7_200,
      categories: [{ name: 'valorant', seconds: 3600 }],
      segments: [{ channel: twitch, start: '2026-10-05T10:00:00.000Z', end: null, peak: 300 }],
    });
    // C: crosses the start of a 7-day period (Sep 28 23:00 → Sep 29 01:00 Riyadh).
    c = session({
      start: '2026-09-28T20:00:00.000Z',
      end: '2026-09-28T22:00:00.000Z',
      peak: 900,
      categories: [{ name: 'Minecraft', seconds: 7200 }],
      segments: [{ channel: twitch, start: '2026-09-28T20:00:00.000Z', end: '2026-09-28T22:00:00.000Z', peak: 900 }],
    });
    // D: 25 days ago (outside 7 days, inside 30).
    d = session({
      start: '2026-09-10T18:00:00.000Z',
      end: '2026-09-10T19:00:00.000Z',
      peak: 50,
      segments: [{ channel: kick, start: '2026-09-10T18:00:00.000Z', end: '2026-09-10T19:00:00.000Z', peak: 50 }],
    });
  });

  it('computes totals over the last 7 local days (union of segments, clipped to the period)', () => {
    const result = stats.streamerStats('g1', streamerId, 7);
    expect(result.days).toBe(7);
    expect(result.streamerId).toBe(streamerId);
    expect(result.totals).toMatchObject({ sessions: 3, seconds: 6 * 3600, peakViewers: 900, avgViewers: 140 });
  });

  it('builds the daily series in the guild timezone, splitting sessions across midnight', () => {
    const { daily } = stats.streamerStats('g1', streamerId, 7);
    expect(daily.map((d) => d.date)).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']);
    expect(daily).toEqual([
      { date: '2026-09-29', seconds: 3600, sessions: 1, peakViewers: 900 },
      { date: '2026-09-30', seconds: 0, sessions: 0, peakViewers: 0 },
      { date: '2026-10-01', seconds: 0, sessions: 0, peakViewers: 0 },
      { date: '2026-10-02', seconds: 0, sessions: 0, peakViewers: 0 },
      { date: '2026-10-03', seconds: 3600, sessions: 1, peakViewers: 450 },
      { date: '2026-10-04', seconds: 7200, sessions: 0, peakViewers: 500 },
      { date: '2026-10-05', seconds: 7200, sessions: 1, peakViewers: 300 },
    ]);
    expect(daily.reduce((n, d) => n + d.sessions, 0)).toBe(3);
  });

  it('fills the hour-of-day histogram with local hours', () => {
    const { hours } = stats.streamerStats('g1', streamerId, 7);
    expect(hours).toHaveLength(24);
    const expected = Array.from({ length: 24 }, () => 0);
    expected[23] = 3600;
    expected[0] = 7200; // A (00:00–01:00 Oct 4) + C (00:00–01:00 Sep 29)
    expected[1] = 3600;
    expected[13] = 3600;
    expected[14] = 3600;
    expect(hours).toEqual(expected);
  });

  it('reports per-platform time, sessions and peaks', () => {
    const { platforms } = stats.streamerStats('g1', streamerId, 7);
    expect(platforms).toEqual([
      { platform: 'twitch', seconds: 6 * 3600, sessions: 3, peakViewers: 900 },
      { platform: 'kick', seconds: 3600, sessions: 1, peakViewers: 150 },
    ]);
  });

  it('merges categories case-insensitively and counts only the time inside the period', () => {
    const { categories } = stats.streamerStats('g1', streamerId, 7);
    expect(categories).toEqual([
      { name: 'Valorant', seconds: 10_800 },
      { name: 'Just Chatting', seconds: 3600 },
      { name: 'Minecraft', seconds: 3600 }, // half of C is inside the period
    ]);
  });

  it('counts content posts of the period and lists the 10 most recent sessions', () => {
    notification('2026-10-04T10:00:00.000Z');
    notification('2026-10-05T11:00:00.000Z');
    notification('2026-09-20T10:00:00.000Z'); // before the 7-day period
    notification('2026-10-05T11:00:00.000Z', streamerId, 'g2'); // other guild
    const week = stats.streamerStats('g1', streamerId, 7);
    expect(week.totals.contentPosts).toBe(2);
    expect(week.recentSessionIds).toEqual([b.id, a.id, c.id, d.id]);
    expect(stats.streamerStats('g1', streamerId, 30).totals.contentPosts).toBe(3);
  });

  it('includes older sessions in longer periods', () => {
    const month = stats.streamerStats('g1', streamerId, 30);
    expect(month.days).toBe(30);
    expect(month.daily).toHaveLength(30);
    expect(month.totals.sessions).toBe(4);
    expect(month.totals.seconds).toBe(8 * 3600); // C fully inside now
    expect(month.daily.find((x) => x.date === '2026-09-10')).toEqual({ date: '2026-09-10', seconds: 3600, sessions: 1, peakViewers: 50 });
    expect(month.categories.find((x) => x.name === 'Minecraft')!.seconds).toBe(7200);
    expect(stats.streamerStats('g1', streamerId, 365).daily).toHaveLength(365);
  });

  it('follows the guild timezone setting (UTC puts the whole of A on Oct 3)', () => {
    env.repos.settings.update('g1', { features: { timezone: 'UTC' } });
    const { daily, hours } = stats.streamerStats('g1', streamerId, 7);
    expect(daily.find((x) => x.date === '2026-10-03')!.seconds).toBe(3 * 3600);
    expect(daily.find((x) => x.date === '2026-10-04')!.seconds).toBe(0);
    expect(hours[20]).toBe(3600);
    expect(hours[22]).toBe(3600);
  });

  it('uses the default timezone when the stored one is invalid', () => {
    env.repos.settings.update('g1', { features: { timezone: 'Not/AZone' } });
    expect(stats.streamerStats('g1', streamerId, 7).daily.find((x) => x.date === '2026-10-04')!.seconds).toBe(7200);
  });

  it('falls back to started → ended for sessions whose segments are gone', () => {
    session({ start: '2026-10-02T09:00:00.000Z', end: '2026-10-02T09:30:00.000Z', segments: [] });
    const result = stats.streamerStats('g1', streamerId, 7);
    expect(result.totals.seconds).toBe(6 * 3600 + 1800);
    expect(result.daily.find((x) => x.date === '2026-10-02')).toMatchObject({ seconds: 1800, sessions: 1 });
  });

  it('returns empty stats for a streamer without sessions', () => {
    const other = env.repos.streamers.create({ guildId: 'g1', discordUserId: '100000000000000009', displayName: 'New' });
    const result = stats.streamerStats('g1', other.id, 7);
    expect(result.totals).toEqual({ sessions: 0, seconds: 0, peakViewers: 0, avgViewers: null, contentPosts: 0 });
    expect(result.daily.every((x) => x.seconds === 0)).toBe(true);
    expect(result.hours.every((x) => x === 0)).toBe(true);
    expect(result.platforms).toEqual([]);
    expect(result.categories).toEqual([]);
    expect(result.recentSessionIds).toEqual([]);
  });

  it('rejects unknown streamers and streamers of another guild (guild language)', () => {
    expect(() => stats.streamerStats('g1', 9999, 7)).toThrow(ValidationError);
    expect(() => stats.streamerStats('g2', streamerId, 7)).toThrow('الستريمر غير موجود');
    env.repos.settings.update('g2', { features: { language: 'en' } });
    expect(() => stats.streamerStats('g2', streamerId, 7)).toThrow('Streamer not found');
  });

  it('returns the samples of a session in order', () => {
    expect(stats.sessionSamples(a.id).map((s) => s.totalViewers)).toEqual([450, 500]);
    expect(stats.sessionSamples(12345)).toEqual([]);
  });
});
