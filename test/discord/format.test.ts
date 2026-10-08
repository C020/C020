import { describe, expect, it } from 'vitest';
import {
  cleanText,
  discordTimestamp,
  escapeMarkdown,
  formatClock,
  formatDurationShort,
  formatNumber,
  joinAr,
  maskedLink,
  safeUrl,
  truncate,
} from '../../src/discord/format.js';

describe('format helpers', () => {
  it('formats numbers with western digits', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
    expect(formatNumber(12.6)).toBe('13');
    expect(formatNumber(Number.NaN)).toBe('0');
  });

  it('formats compact Arabic durations', () => {
    expect(formatDurationShort(0)).toBe('أقل من دقيقة');
    expect(formatDurationShort(59)).toBe('أقل من دقيقة');
    expect(formatDurationShort(45 * 60)).toBe('45د');
    expect(formatDurationShort(3 * 3600)).toBe('3س');
    expect(formatDurationShort(2 * 3600 + 15 * 60 + 20)).toBe('2س 15د');
    expect(formatDurationShort(26 * 3600 + 600)).toBe('26س 10د');
    expect(formatDurationShort(-10)).toBe('أقل من دقيقة');
  });

  it('formats video lengths as a clock', () => {
    expect(formatClock(5)).toBe('0:05');
    expect(formatClock(245)).toBe('4:05');
    expect(formatClock(3723)).toBe('1:02:03');
  });

  it('builds Discord timestamps and rejects invalid dates', () => {
    expect(discordTimestamp('2026-10-03T12:00:00.000Z')).toBe('<t:1791028800:R>');
    expect(discordTimestamp(1791028800500, 'f')).toBe('<t:1791028800:f>');
    expect(discordTimestamp('not a date')).toBeNull();
    expect(discordTimestamp(null)).toBeNull();
  });

  it('escapes markdown, masked links, mention markup and mass mentions in untrusted text', () => {
    expect(escapeMarkdown('**bold** _x_ ~~s~~ `c` ||sp||')).toBe('\\*\\*bold\\*\\* \\_x\\_ \\~\\~s\\~\\~ \\`c\\` \\|\\|sp\\|\\|');
    expect(escapeMarkdown('[free nitro](https://evil.example)')).toBe('\\[free nitro\\](https://evil.example)');
    expect(escapeMarkdown('<@&123> <t:1:R>')).toBe('\\<@&123\\> \\<t:1:R\\>');
    expect(escapeMarkdown('hi @everyone and @here')).toBe('hi @​everyone and @​here');
    expect(escapeMarkdown('# heading')).toBe('\\# heading');
  });

  it('cleans control characters, bidi overrides and whitespace', () => {
    expect(cleanText('  a‮b\n\tc​  ')).toBe('ab c');
    expect(cleanText(null)).toBe('');
  });

  it('keeps zero-width joiners inside composite emojis and words, dropping only stray ones', () => {
    const title = '\u{1F468}\u200D\u{1F4BB} كودنق مع الشباب \u{1F3F3}\uFE0F\u200D\u{1F308} \u2764\uFE0F\u200D\u{1F525}';
    expect(cleanText(title)).toBe(title);
    // Persian uses the zero-width non-joiner inside words.
    expect(cleanText('می\u200Cخواهم')).toBe('می\u200Cخواهم');
    // Joiners that join nothing (word edges) are still removed, like other invisible characters.
    expect(cleanText('\u200Dabc\u200D \u200C\u200Cdef\u200C')).toBe('abc def');
    expect(cleanText('a\u200Bb\u2066c\uFEFF')).toBe('abc');
  });

  it('truncates without breaking surrogate pairs or leaving a dangling escape', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abc', 3)).toBe('abc');
    expect(truncate('😀😀😀', 4)).toBe('😀…');
    expect(truncate('ab\\*cd', 4)).toBe('ab…');
    expect(truncate('abc', 1)).toBe('…');
    expect(truncate('abc', 0)).toBe('');
  });

  it('only accepts http(s) URLs within the length limit', () => {
    expect(safeUrl('https://twitch.tv/x')).toBe('https://twitch.tv/x');
    expect(safeUrl(' http://a.b/c ')).toBe('http://a.b/c');
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('ftp://a.b')).toBeNull();
    expect(safeUrl('not a url')).toBeNull();
    expect(safeUrl(null)).toBeNull();
    expect(safeUrl(`https://a.b/${'x'.repeat(600)}`, 512)).toBeNull();
  });

  it('joins lists the Arabic way', () => {
    expect(joinAr([])).toBe('');
    expect(joinAr(['Twitch'])).toBe('Twitch');
    expect(joinAr(['Twitch', 'Kick', 'YouTube'])).toBe('Twitch، Kick و YouTube');
  });

  it('formats compact English durations', () => {
    expect(formatDurationShort(2 * 3600 + 15 * 60, 'en')).toBe('2h 15m');
    expect(formatDurationShort(45 * 60, 'en')).toBe('45m');
    expect(formatDurationShort(3 * 3600, 'en')).toBe('3h');
    expect(formatDurationShort(20, 'en')).toBe('under a minute');
    expect(formatDurationShort(26 * 3600 + 600, 'en')).toBe('26h 10m');
    expect(formatDurationShort(45 * 60, 'ar')).toBe('45د');
  });

  it('builds masked links with escaped text and URLs that cannot break out of the link', () => {
    expect(maskedLink('a [b]', 'https://example.com/x')).toBe('[a \\[b\\]](https://example.com/x)');
    expect(maskedLink('clip', 'https://example.com/clip_(1)')).toBe('[clip](https://example.com/clip_%281%29)');
    expect(maskedLink('no link', 'javascript:alert(1)')).toBe('no link');
    expect(maskedLink('', 'https://example.com')).toBe('');
  });
});
