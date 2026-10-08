/**
 * Pure formatting helpers (numbers, durations, dates) that follow the dashboard language.
 * Latin digits are used on purpose in both languages: they are what Gulf users expect in dashboards
 * and they keep numbers readable next to platform names and IDs.
 */
import { getLang, intlLocale, t, type Lang } from '../i18n/core';

interface Formatters {
  integer: Intl.NumberFormat;
  compact: Intl.NumberFormat;
  decimal: Intl.NumberFormat;
  relative: Intl.RelativeTimeFormat;
  dateTime: Intl.DateTimeFormat;
  date: Intl.DateTimeFormat;
  shortDate: Intl.DateTimeFormat;
  time: Intl.DateTimeFormat;
  weekday: Intl.DateTimeFormat;
}

const formatterCache = new Map<Lang, Formatters>();

/** Intl formatters for the current (or given) language, created once per language. */
export function formatters(lang: Lang = getLang()): Formatters {
  let f = formatterCache.get(lang);
  if (!f) {
    const locale = intlLocale(lang);
    f = {
      integer: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }),
      compact: new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }),
      decimal: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }),
      relative: new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }),
      dateTime: new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }),
      date: new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' }),
      shortDate: new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }),
      time: new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }),
      weekday: new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' }),
    };
    formatterCache.set(lang, f);
  }
  return f;
}

export function formatNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return formatters().integer.format(value);
}

export function formatDecimal(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return formatters().decimal.format(value);
}

/** 1234 → "1,234"; 15300 → "15.3 ألف" / "15.3K" (exact below 10k so small counts stay precise). */
export function formatCompact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const f = formatters();
  return Math.abs(value) < 10_000 ? f.integer.format(value) : f.compact.format(value);
}

export interface ArabicPluralForms {
  /** 1 */
  one: string;
  /** 2 */
  two: string;
  /** 3–10 */
  few: string;
  /** 11+ (and 0) */
  many: string;
}

/** Arabic counted noun: 1 → "ساعة", 2 → "ساعتين", 3–10 → "3 ساعات", 11+ → "11 ساعة". Kept for callers that need Arabic explicitly. */
export function pluralAr(count: number, forms: ArabicPluralForms): string {
  const n = Math.abs(Math.trunc(count));
  const integer = formatters('ar').integer;
  if (n === 1) return forms.one;
  if (n === 2) return forms.two;
  if (n >= 3 && n <= 10) return `${integer.format(n)} ${forms.few}`;
  return `${integer.format(n)} ${forms.many}`;
}

const HOURS: ArabicPluralForms = { one: 'ساعة', two: 'ساعتين', few: 'ساعات', many: 'ساعة' };
const MINUTES: ArabicPluralForms = { one: 'دقيقة', two: 'دقيقتين', few: 'دقائق', many: 'دقيقة' };
const SECONDS: ArabicPluralForms = { one: 'ثانية', two: 'ثانيتين', few: 'ثواني', many: 'ثانية' };
const DAYS: ArabicPluralForms = { one: 'يوم', two: 'يومين', few: 'أيام', many: 'يوم' };

export const PLURALS = { hours: HOURS, minutes: MINUTES, seconds: SECONDS, days: DAYS } as const;

/** Long duration: 8100 → "ساعتين و15 دقيقة" / "2 hours 15 minutes". Seconds only show under a minute. */
export function formatDurationLong(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return s === 0 ? t('time.lessThanMinute') : t('time.seconds', { count: s });
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(t('time.days', { count: days }));
  if (hours > 0) parts.push(t('time.hours', { count: hours }));
  if (minutes > 0 && days === 0) parts.push(t('time.minutes', { count: minutes }));
  return parts.join(t('time.join'));
}

/** Compact duration for chips/tables: "2س 15د" / "2h 15m". */
export function formatDurationShort(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const u = (key: 'time.s' | 'time.m' | 'time.h' | 'time.d', n: number): string => t(key, { n: String(n) });
  if (s < 60) return u('time.s', s);
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return hours > 0 ? `${u('time.d', days)} ${u('time.h', hours)}` : u('time.d', days);
  if (hours > 0) return minutes > 0 ? `${u('time.h', hours)} ${u('time.m', minutes)}` : u('time.h', hours);
  return u('time.m', minutes);
}

/** Stopwatch format for ticking uptimes: "1:05:09" / "05:09". */
export function formatClockDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Hours with one decimal: 7.25 → "7.3 س" / "7.3 h". */
export function formatHours(hours: number): string {
  return t('time.hoursShort', { n: formatters().decimal.format(Math.round(hours * 10) / 10) });
}

export function secondsBetween(fromIso: string, toMs: number): number {
  const from = Date.parse(fromIso);
  if (Number.isNaN(from)) return 0;
  return Math.max(0, Math.floor((toMs - from) / 1000));
}

const RELATIVE_STEPS: Array<{ unit: Intl.RelativeTimeFormatUnit; seconds: number }> = [
  { unit: 'year', seconds: 31_536_000 },
  { unit: 'month', seconds: 2_592_000 },
  { unit: 'week', seconds: 604_800 },
  { unit: 'day', seconds: 86_400 },
  { unit: 'hour', seconds: 3600 },
  { unit: 'minute', seconds: 60 },
];

/** "قبل 5 دقائق" / "5 minutes ago". Under 45 seconds reads "الحين" / "just now". */
export function formatRelative(iso: string | null | undefined, nowMs: number = Date.now()): string {
  if (!iso) return '—';
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '—';
  const diffSec = Math.round((time - nowMs) / 1000);
  if (Math.abs(diffSec) < 45) return t('time.now');
  const relative = formatters().relative;
  for (const step of RELATIVE_STEPS) {
    if (Math.abs(diffSec) >= step.seconds) {
      return relative.format(Math.round(diffSec / step.seconds), step.unit);
    }
  }
  return relative.format(Math.round(diffSec / 60), 'minute');
}

function parseDate(iso: string | number | null | undefined): Date | null {
  if (iso == null) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDateTime(iso: string | number | null | undefined): string {
  const d = parseDate(iso);
  return d ? formatters().dateTime.format(d) : '—';
}

export function formatDate(iso: string | number | null | undefined): string {
  const d = parseDate(iso);
  return d ? formatters().date.format(d) : '—';
}

export function formatShortDate(iso: string | number | null | undefined): string {
  const d = parseDate(iso);
  return d ? formatters().shortDate.format(d) : '—';
}

export function formatTime(iso: string | number | null | undefined): string {
  const d = parseDate(iso);
  return d ? formatters().time.format(d) : '—';
}

export function formatWeekday(iso: string | number | null | undefined): string {
  const d = parseDate(iso);
  return d ? formatters().weekday.format(d) : '—';
}

/** Discord-style "Today at 3:32 PM" / "اليوم الساعة 3:32 م". */
export function formatCalendar(iso: string | number, nowMs: number = Date.now()): string {
  const d = parseDate(iso);
  if (!d) return '—';
  const f = formatters();
  const now = new Date(nowMs);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const ms = d.getTime();
  if (ms >= startOfToday && ms < startOfToday + 86_400_000) return t('time.todayAt', { time: f.time.format(d) });
  if (ms >= startOfToday - 86_400_000 && ms < startOfToday) return t('time.yesterdayAt', { time: f.time.format(d) });
  return f.dateTime.format(d);
}

// ───────────── colors ─────────────

export function colorIntToHex(color: number | null | undefined): string | null {
  if (color == null || !Number.isInteger(color) || color < 0 || color > 0xffffff) return null;
  return `#${color.toString(16).padStart(6, '0')}`;
}

/** Accepts "#rrggbb", "rrggbb" or "#rgb". Returns null for anything else. */
export function hexToColorInt(hex: string): number | null {
  let value = hex.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(value)) value = [...value].map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(value)) return null;
  return Number.parseInt(value, 16);
}

/** Discord role colors: 0 means "no color" (rendered as the default gray). */
export function roleColorHex(color: number): string {
  return color === 0 ? '#99aab5' : (colorIntToHex(color) ?? '#99aab5');
}

/** Truncates with an ellipsis, counting user-perceived characters. */
export function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/** Initials for avatar fallbacks ("Abu Ali" → "AA", "ستريمر" → "س"). */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.[0] ?? '?';
  const second = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '';
  return (first + second).toUpperCase();
}

/** Local calendar day key (YYYY-MM-DD) for grouping lists by day in the viewer's timezone. */
export function localDayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
