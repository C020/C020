/**
 * A small, safe parser for the subset of Discord markdown our messages use, producing an AST that
 * React renders without innerHTML. Covers: bold, italic, underline, strike, spoilers, inline code,
 * code blocks, headings, -# subtext, quotes, bullet lists, masked links, autolinks, mentions,
 * <t:unix:style> timestamps and custom emojis.
 */
import { intlLocale } from '../i18n/core';

export type InlineNode =
  | { type: 'text'; value: string }
  | { type: 'bold' | 'italic' | 'underline' | 'strike' | 'spoiler'; children: InlineNode[] }
  | { type: 'code'; value: string }
  | { type: 'link'; url: string; children: InlineNode[] }
  | { type: 'mention'; kind: 'user' | 'role' | 'channel'; id: string }
  | { type: 'everyone'; value: '@everyone' | '@here' }
  | { type: 'timestamp'; unix: number; style: TimestampStyle }
  | { type: 'emoji'; id: string; name: string; animated: boolean }
  | { type: 'br' };

export type BlockNode =
  | { type: 'paragraph'; children: InlineNode[] }
  | { type: 'heading'; level: 1 | 2 | 3; children: InlineNode[] }
  | { type: 'subtext'; children: InlineNode[] }
  | { type: 'quote'; children: BlockNode[] }
  | { type: 'list'; items: InlineNode[][] }
  | { type: 'codeblock'; lang: string | null; value: string };

export type TimestampStyle = 't' | 'T' | 'd' | 'D' | 'f' | 'F' | 'R';

interface InlineRule {
  re: RegExp;
  build: (m: RegExpExecArray, depth: number) => InlineNode;
}

const MAX_DEPTH = 6;

const INLINE_RULES: InlineRule[] = [
  { re: /^\\([*_~`|\\<>[\]()#@-])/, build: (m) => ({ type: 'text', value: m[1] ?? '' }) },
  { re: /^`([^`]+)`/, build: (m) => ({ type: 'code', value: m[1] ?? '' }) },
  { re: /^<t:(-?\d{1,13})(?::([tTdDfFR]))?>/, build: (m) => ({ type: 'timestamp', unix: Number(m[1]), style: (m[2] as TimestampStyle) ?? 'f' }) },
  { re: /^<(a)?:(\w{1,32}):(\d{17,20})>/, build: (m) => ({ type: 'emoji', animated: m[1] === 'a', name: m[2] ?? '', id: m[3] ?? '' }) },
  { re: /^<@!?(\d{17,20})>/, build: (m) => ({ type: 'mention', kind: 'user', id: m[1] ?? '' }) },
  { re: /^<@&(\d{17,20})>/, build: (m) => ({ type: 'mention', kind: 'role', id: m[1] ?? '' }) },
  { re: /^<#(\d{17,20})>/, build: (m) => ({ type: 'mention', kind: 'channel', id: m[1] ?? '' }) },
  { re: /^@(everyone|here)\b/, build: (m) => ({ type: 'everyone', value: m[1] === 'here' ? '@here' : '@everyone' }) },
  {
    re: /^\[([^\]\n]{1,256})\]\(<?(https?:\/\/[^\s)>]+)>?\)/,
    build: (m, depth) => ({ type: 'link', url: m[2] ?? '', children: parseInline(m[1] ?? '', depth + 1) }),
  },
  {
    re: /^<(https?:\/\/[^\s>]+)>/,
    build: (m) => ({ type: 'link', url: m[1] ?? '', children: [{ type: 'text', value: m[1] ?? '' }] }),
  },
  {
    re: /^https?:\/\/[^\s<]+[^\s<.,:;"')\]!?]/,
    build: (m) => ({ type: 'link', url: m[0], children: [{ type: 'text', value: m[0] }] }),
  },
  { re: /^\*\*([\s\S]+?)\*\*(?!\*)/, build: (m, d) => ({ type: 'bold', children: parseInline(m[1] ?? '', d + 1) }) },
  { re: /^__([\s\S]+?)__(?!_)/, build: (m, d) => ({ type: 'underline', children: parseInline(m[1] ?? '', d + 1) }) },
  { re: /^~~([\s\S]+?)~~/, build: (m, d) => ({ type: 'strike', children: parseInline(m[1] ?? '', d + 1) }) },
  { re: /^\|\|([\s\S]+?)\|\|/, build: (m, d) => ({ type: 'spoiler', children: parseInline(m[1] ?? '', d + 1) }) },
  { re: /^\*(?=\S)([\s\S]*?\S)\*(?!\*)/, build: (m, d) => ({ type: 'italic', children: parseInline(m[1] ?? '', d + 1) }) },
  { re: /^_(?=\S)([\s\S]*?\S)_(?![\p{L}\p{N}_])/u, build: (m, d) => ({ type: 'italic', children: parseInline(m[1] ?? '', d + 1) }) },
];

/** Characters that can start a rule; everything else is consumed as plain text in one go. */
const SPECIAL = /[\\`<@[h*_~|\n]/;

export function parseInline(source: string, depth = 0): InlineNode[] {
  const nodes: InlineNode[] = [];
  let text = '';
  const flush = (): void => {
    if (text) nodes.push({ type: 'text', value: text });
    text = '';
  };

  let i = 0;
  while (i < source.length) {
    const ch = source[i] ?? '';
    if (ch === '\n') {
      flush();
      nodes.push({ type: 'br' });
      i += 1;
      continue;
    }
    if (depth < MAX_DEPTH && SPECIAL.test(ch)) {
      const rest = source.slice(i);
      let matched = false;
      // "_" inside a word (snake_case) is literal in Discord.
      const prev = source[i - 1];
      const midWord = ch === '_' && prev !== undefined && /[\p{L}\p{N}]/u.test(prev);
      for (const rule of INLINE_RULES) {
        if (midWord && rule.re.source.startsWith('^_')) continue;
        const m = rule.re.exec(rest);
        if (m && m[0].length > 0) {
          flush();
          nodes.push(rule.build(m, depth));
          i += m[0].length;
          matched = true;
          break;
        }
      }
      if (matched) continue;
    }
    text += ch;
    i += 1;
  }
  flush();
  return nodes;
}

export function parseMarkdown(source: string): BlockNode[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: BlockNode[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let quote: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length > 0) blocks.push({ type: 'paragraph', children: parseInline(paragraph.join('\n')) });
    paragraph = [];
  };
  const flushList = (): void => {
    if (list.length > 0) blocks.push({ type: 'list', items: list.map((item) => parseInline(item)) });
    list = [];
  };
  const flushQuote = (): void => {
    if (quote.length > 0) blocks.push({ type: 'quote', children: parseMarkdown(quote.join('\n')) });
    quote = [];
  };
  const flushAll = (): void => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    if (line.startsWith('```')) {
      flushAll();
      // Single-line block: ```code```
      const single = /^```([\s\S]+?)```\s*$/.exec(line);
      if (single) {
        blocks.push({ type: 'codeblock', lang: null, value: single[1] ?? '' });
        continue;
      }
      const lang = /^```(\w{1,20})\s*$/.exec(line)?.[1] ?? null;
      const body: string[] = lang !== null || line.trim() === '```' ? [] : [line.slice(3)];
      let j = i + 1;
      while (j < lines.length && !(lines[j] ?? '').trimEnd().endsWith('```')) {
        body.push(lines[j] ?? '');
        j++;
      }
      if (j < lines.length) {
        const last = (lines[j] ?? '').trimEnd();
        const before = last.slice(0, -3);
        if (before) body.push(before);
      }
      blocks.push({ type: 'codeblock', lang, value: body.join('\n') });
      i = j;
      continue;
    }

    const quoteMatch = /^>>?>? ?(.*)$/.exec(line);
    if (quoteMatch && line.startsWith('>')) {
      flushParagraph();
      flushList();
      quote.push(quoteMatch[1] ?? '');
      continue;
    }
    flushQuote();

    const heading = /^(#{1,3}) +(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: 'heading', level: (heading[1]?.length ?? 1) as 1 | 2 | 3, children: parseInline(heading[2] ?? '') });
      continue;
    }

    const subtext = /^-# +(.+)$/.exec(line);
    if (subtext) {
      flushParagraph();
      flushList();
      blocks.push({ type: 'subtext', children: parseInline(subtext[1] ?? '') });
      continue;
    }

    const item = /^\s*[-*•] +(.+)$/.exec(line);
    if (item) {
      flushParagraph();
      list.push(item[1] ?? '');
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushAll();
  return blocks.filter((b) => !(b.type === 'paragraph' && b.children.every((c) => c.type === 'br' || (c.type === 'text' && !c.value.trim()))));
}

/** Formats a Discord timestamp tag the way the Discord client would (in the dashboard language). */
export function formatDiscordTimestamp(unix: number, style: TimestampStyle, nowMs: number = Date.now()): string {
  const LOCALE = intlLocale();
  const date = new Date(unix * 1000);
  if (Number.isNaN(date.getTime())) return `<t:${unix}>`;
  switch (style) {
    case 't':
      return new Intl.DateTimeFormat(LOCALE, { hour: 'numeric', minute: '2-digit' }).format(date);
    case 'T':
      return new Intl.DateTimeFormat(LOCALE, { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(date);
    case 'd':
      return new Intl.DateTimeFormat(LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
    case 'D':
      return new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
    case 'F':
      return new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
    case 'R': {
      const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });
      const diff = Math.round((date.getTime() - nowMs) / 1000);
      const abs = Math.abs(diff);
      if (abs < 60) return rtf.format(diff, 'second');
      if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
      if (abs < 86_400) return rtf.format(Math.round(diff / 3600), 'hour');
      if (abs < 2_592_000) return rtf.format(Math.round(diff / 86_400), 'day');
      if (abs < 31_536_000) return rtf.format(Math.round(diff / 2_592_000), 'month');
      return rtf.format(Math.round(diff / 31_536_000), 'year');
    }
    case 'f':
    default:
      return new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
  }
}
