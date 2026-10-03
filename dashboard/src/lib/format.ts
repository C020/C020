/**
 * Pure formatting helpers (numbers, durations, dates) for Arabic UI text.
 * Latin digits are used on purpose: they are what Gulf users expect in dashboards and they keep
 * numbers readable next to platform names and IDs.
 */

const LOCALE = 'ar-u-nu-latn';

const integerFormat = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const compactFormat = new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 1 });
const decimalFormat = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 });
const relativeFormat = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });
const dateTimeFormat = new Intl.DateTimeFormat(LOCALE, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const dateFormat = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' });
const shortDateFormat = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short' });
const timeFormat = new Intl.DateTimeFormat(LOCALE, { hour: 'numeric', minute: '2-digit' });
const weekdayFormat = new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' });

export function formatNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return integerFormat.format(value);
}

export function formatDecimal(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return decimalFormat.format(value);
}

/** 1234 → "1.2 ألف" (exact below 10k so small counts stay precise). */
export function formatCompact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return Math.abs(value) < 10_000 ? integerFormat.format(value) : compactFormat.format(value);
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

/** Arabic counted noun: 1 → "ساعة", 2 → "ساعتين", 3–10 → "3 ساعات", 11+ → "11 ساعة". */
export function pluralAr(count: number, forms: ArabicPluralForms): string {
  const n = Math.abs(Math.trunc(count));
  if (n === 1) return forms.one;
  if (n === 2) return forms.two;
  if (n >= 3 && n <= 10) return `${integerFormat.format(n)} ${forms.few}`;
  return `${integerFormat.format(n)} ${forms.many}`;
}

const HOURS: ArabicPluralForms = { one: 'ساعة', two: 'ساعتين', few: 'ساعات', many: 'ساعة' };
const MINUTES: ArabicPluralForms = { one: 'دقيقة', two: 'دقيقتين', few: 'دقائق', many: 'دقيقة' };
const SECONDS: ArabicPluralForms = { one: 'ثانية', two: 'ثانيتين', few: 'ثواني', many: 'ثانية' };
const DAYS: ArabicPluralForms = { one: 'يوم', two: 'يومين', few: 'أيام', many: 'يوم' };

export const PLURALS = { hours: HOURS, minutes: MINUTES, seconds: SECONDS, days: DAYS } as const;

/** Long Arabic duration: 8100 → "ساعتين و15 دقيقة". Seconds only show under a minute. */
export function formatDurationLong(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return s === 0 ? 'أقل من دقيقة' : pluralAr(s, SECONDS);
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(pluralAr(days, DAYS));
  if (hours > 0) parts.push(pluralAr(hours, HOURS));
  if (minutes > 0 && days === 0) parts.push(pluralAr(minutes, MINUTES));
  return parts.join(' و');
}

/** Compact duration for chips/tables: "2س 15د", "45د", "3ي 4س". */
export function formatDurationShort(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s}ث`;
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return hours > 0 ? `${days}ي ${hours}س` : `${days}ي`;
  if (hours > 0) return minutes > 0 ? `${hours}س ${minutes}د` : `${hours}س`;
  return `${minutes}د`;
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

/** Hours with one decimal: 7.25 → "7.3 س". */
export function formatHours(hours: number): string {
  return `${decimalFormat.format(Math.round(hours * 10) / 10)} س`;
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

/** "قبل 5 دقائق", "أمس", "بعد ساعتين". Under 45 seconds reads "الحين". */
export function formatRelative(iso: string | null | undefined, nowMs: number = Date.now()): string {
  if (!iso) return '—';
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '—';
  const diffSec = Math.round((time - nowMs) / 1000);
  if (Math.abs(diffSec) < 45) return 'الحين';
  for (const step of RELATIVE_STEPS) {
    if (Math.abs(diffSec) >= step.seconds) {
      return relativeFormat.format(Math.round(diffSec / step.seconds), step.unit);
    }
  }
  return relativeFormat.format(Math.round(diffSec / 60), 'minute');
}

function parseDate(iso: string | number | null | undefined): Date | null {
  if (iso == null) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDateTime(iso: string | number | null | undefined): string {
  const d = parseDate(iso);
  return d ? dateTimeFormat.format(d) : '—';
}

export function formatDate(iso: string | number | null | undefined): string {
  const d = parseDate(iso);
  return d ? dateFormat.format(d) : '—';
}

export function formatShortDate(iso: string | number | null | undefined): string {
  const d = parseDate(iso);
  return d ? shortDateFormat.format(d) : '—';
}

export function formatTime(iso: string | number | null | undefined): string {
  const d = parseDate(iso);
  return d ? timeFormat.format(d) : '—';
}

export function formatWeekday(iso: string | number | null | undefined): string {
  const d = parseDate(iso);
  return d ? weekdayFormat.format(d) : '—';
}

/** Discord-style "Today at 3:32 PM" in Arabic. */
export function formatCalendar(iso: string | number, nowMs: number = Date.now()): string {
  const d = parseDate(iso);
  if (!d) return '—';
  const now = new Date(nowMs);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = d.getTime();
  if (t >= startOfToday && t < startOfToday + 86_400_000) return `اليوم الساعة ${timeFormat.format(d)}`;
  if (t >= startOfToday - 86_400_000 && t < startOfToday) return `أمس الساعة ${timeFormat.format(d)}`;
  return dateTimeFormat.format(d);
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
