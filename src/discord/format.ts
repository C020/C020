/**
 * Pure text helpers for Discord output: number/duration formatting (western digits, Arabic or English units),
 * Discord timestamps, markdown escaping of untrusted text, limit-aware truncation and URL sanitizing.
 */
import type { Language } from '../db/features.js';

const NUMBER_FORMAT = new Intl.NumberFormat('en-US');

/** "1,234" — western digits read better than Arabic-Indic ones next to Latin game names. */
export function formatNumber(value: number): string {
  return Number.isFinite(value) ? NUMBER_FORMAT.format(Math.round(value)) : '0';
}

function wholeSeconds(totalSec: number): number {
  return Number.isFinite(totalSec) ? Math.max(0, Math.round(totalSec)) : 0;
}

const DURATION_UNITS: Record<Language, { h: string; m: string; underMinute: string }> = {
  ar: { h: 'س', m: 'د', underMinute: 'أقل من دقيقة' },
  en: { h: 'h', m: 'm', underMinute: 'under a minute' },
};

/**
 * Compact duration such as "2س 15د", "45د" or "3س" (English: "2h 15m", "45m", "3h"). Streams longer than a day
 * stay in hours ("26س 10د").
 */
export function formatDurationShort(totalSec: number, lang: Language = 'ar'): string {
  const units = DURATION_UNITS[lang] ?? DURATION_UNITS.ar;
  const sec = wholeSeconds(totalSec);
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  if (hours === 0 && minutes === 0) return units.underMinute;
  if (hours === 0) return `${minutes}${units.m}`;
  return minutes === 0 ? `${hours}${units.h}` : `${hours}${units.h} ${minutes}${units.m}`;
}

/** Video length as a clock: "4:05", "1:02:03". */
export function formatClock(totalSec: number): string {
  const sec = wholeSeconds(totalSec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export type TimestampStyle = 't' | 'T' | 'd' | 'D' | 'f' | 'F' | 'R';

/** Discord timestamp markup (rendered in every viewer's own timezone). Null for invalid input. */
export function discordTimestamp(value: string | number | null | undefined, style: TimestampStyle = 'R'): string | null {
  if (value == null || value === '') return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

const MARKDOWN_CHARS_RE = /[\\*_~`|<>[\]#-]/g;
// Bidi overrides and invisible characters can visually scramble RTL messages; titles never need them.
// The zero-width joiner/non-joiner (U+200D/U+200C) are kept: they build composite emojis (👨‍💻, 🏳️‍🌈) and carry
// meaning in Persian text. Only joiners that join nothing (at the edges of a word) are dropped.
const INVISIBLE_RE = /[\u200B\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
const STRAY_JOINER_RE = /(^|\s)[\u200C\u200D]+|[\u200C\u200D]+(?=\s|$)/g;
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

/** Normalizes untrusted single-line text (titles, names, categories) without escaping it. */
export function cleanText(value: string | null | undefined): string {
  if (!value) return '';
  return value.replace(INVISIBLE_RE, '').replace(CONTROL_RE, ' ').replace(STRAY_JOINER_RE, '$1').replace(/\s+/g, ' ').trim();
}

/** Prevents "@everyone"/"@here" in untrusted text from looking like (or acting as) a mass mention. */
export function defuseMentions(text: string): string {
  return text.replace(/@(everyone|here)/gi, '@​$1');
}

/**
 * Makes untrusted text safe to embed in markdown (descriptions, field values, message content):
 * markdown syntax, masked links, custom emoji/mention markup and mass mentions are neutralized.
 */
export function escapeMarkdown(value: string | null | undefined): string {
  return defuseMentions(cleanText(value).replace(MARKDOWN_CHARS_RE, '\\$&'));
}

/**
 * Cuts text to at most `max` UTF-16 units (Discord counts at most that many characters), ending with "…".
 * Never splits a surrogate pair and never leaves a dangling markdown escape backslash.
 */
export function truncate(value: string, max: number): string {
  if (max <= 0) return '';
  if (value.length <= max) return value;
  if (max === 1) return '…';
  let cut = value.slice(0, max - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  const trailingSlashes = /\\+$/.exec(cut)?.[0].length ?? 0;
  if (trailingSlashes % 2 === 1) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/** Returns a normalized http(s) URL or null (Discord rejects the whole message on an invalid URL). */
export function safeUrl(value: string | null | undefined, maxLength = 2048): string | null {
  if (!value || typeof value !== 'string') return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const href = url.href;
  return href.length <= maxLength ? href : null;
}

/**
 * Markdown masked link "[text](url)" with escaped text. Parentheses in the URL are percent-encoded so a URL such
 * as ".../clip_(1)" cannot end the link early. Falls back to the escaped text when the URL is unusable.
 */
export function maskedLink(text: string | null | undefined, url: string | null | undefined): string {
  const label = escapeMarkdown(text);
  const safe = safeUrl(url);
  if (!safe || !label) return label;
  return `[${label}](${safe.replace(/\(/g, '%28').replace(/\)/g, '%29')})`;
}

/** Arabic list join: "أ، ب و ج". */
export function joinAr(items: string[]): string {
  const list = items.filter(Boolean);
  if (list.length <= 1) return list[0] ?? '';
  return `${list.slice(0, -1).join('، ')} و ${list[list.length - 1]}`;
}
