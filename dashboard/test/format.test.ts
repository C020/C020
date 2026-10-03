import { describe, expect, it } from 'vitest';
import {
  colorIntToHex,
  formatClockDuration,
  formatCompact,
  formatDurationLong,
  formatDurationShort,
  formatRelative,
  hexToColorInt,
  initials,
  localDayKey,
  pluralAr,
  PLURALS,
  roleColorHex,
  secondsBetween,
  truncate,
} from '../src/lib/format';

describe('format', () => {
  it('pluralizes Arabic counted nouns', () => {
    expect(pluralAr(1, PLURALS.hours)).toBe('ساعة');
    expect(pluralAr(2, PLURALS.hours)).toBe('ساعتين');
    expect(pluralAr(5, PLURALS.hours)).toBe('5 ساعات');
    expect(pluralAr(11, PLURALS.hours)).toBe('11 ساعة');
  });

  it('formats long durations', () => {
    expect(formatDurationLong(0)).toBe('أقل من دقيقة');
    expect(formatDurationLong(45)).toBe('45 ثانية');
    expect(formatDurationLong(2 * 3600 + 15 * 60)).toBe('ساعتين و15 دقيقة');
    expect(formatDurationLong(86_400 + 3600)).toBe('يوم وساعة');
  });

  it('formats short and clock durations', () => {
    expect(formatDurationShort(30)).toBe('30ث');
    expect(formatDurationShort(45 * 60)).toBe('45د');
    expect(formatDurationShort(2 * 3600 + 5 * 60)).toBe('2س 5د');
    expect(formatDurationShort(3 * 86_400 + 4 * 3600)).toBe('3ي 4س');
    expect(formatClockDuration(65)).toBe('01:05');
    expect(formatClockDuration(3600 + 5 * 60 + 9)).toBe('1:05:09');
    expect(formatClockDuration(-5)).toBe('00:00');
  });

  it('keeps small counts exact and compacts big ones', () => {
    expect(formatCompact(1234)).toBe('1,234');
    expect(formatCompact(15_300)).toContain('15.3');
    expect(formatCompact(null)).toBe('—');
  });

  it('formats relative times', () => {
    const now = Date.parse('2026-10-03T12:00:00Z');
    expect(formatRelative('2026-10-03T11:59:50Z', now)).toBe('الحين');
    expect(formatRelative('2026-10-03T11:55:00Z', now)).toContain('5');
    expect(formatRelative(null, now)).toBe('—');
    expect(formatRelative('not a date', now)).toBe('—');
    expect(secondsBetween('2026-10-03T11:00:00Z', now)).toBe(3600);
  });

  it('converts colors both ways', () => {
    expect(colorIntToHex(0x9146ff)).toBe('#9146ff');
    expect(colorIntToHex(null)).toBeNull();
    expect(colorIntToHex(0x1000000)).toBeNull();
    expect(hexToColorInt('#9146FF')).toBe(0x9146ff);
    expect(hexToColorInt('fff')).toBe(0xffffff);
    expect(hexToColorInt('#12345')).toBeNull();
    expect(roleColorHex(0)).toBe('#99aab5');
  });

  it('truncates by characters and builds initials', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abc', 4)).toBe('abc');
    expect(initials('Abu Ali')).toBe('AA');
    expect(initials('ستريمر')).toBe('س');
    expect(initials('  ')).toBe('?');
  });

  it('keys days in local time', () => {
    const d = new Date(2026, 9, 3, 1, 30);
    expect(localDayKey(d.toISOString())).toBe('2026-10-03');
  });
});
