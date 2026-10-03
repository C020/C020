import { describe, expect, it } from 'vitest';
import { formatDiscordTimestamp, parseInline, parseMarkdown } from '../src/lib/discordMarkdown';

describe('parseInline', () => {
  it('parses emphasis and nesting', () => {
    expect(parseInline('**bold *both***')).toEqual([
      { type: 'bold', children: [{ type: 'text', value: 'bold ' }, { type: 'italic', children: [{ type: 'text', value: 'both' }] }] },
    ]);
    expect(parseInline('__u__ ~~s~~ ||x||').map((n) => n.type)).toEqual(['underline', 'text', 'strike', 'text', 'spoiler']);
  });

  it('keeps snake_case and unmatched markers literal', () => {
    expect(parseInline('snake_case_name')).toEqual([{ type: 'text', value: 'snake_case_name' }]);
    expect(parseInline('2 * 3')).toEqual([{ type: 'text', value: '2 * 3' }]);
  });

  it('parses links, mentions, timestamps and emojis', () => {
    expect(parseInline('[شاهد](https://twitch.tv/x)')).toEqual([{ type: 'link', url: 'https://twitch.tv/x', children: [{ type: 'text', value: 'شاهد' }] }]);
    expect(parseInline('see https://kick.com/abc.')).toEqual([
      { type: 'text', value: 'see ' },
      { type: 'link', url: 'https://kick.com/abc', children: [{ type: 'text', value: 'https://kick.com/abc' }] },
      { type: 'text', value: '.' },
    ]);
    expect(parseInline('<@123456789012345678> <@&123456789012345678> <#123456789012345678> @everyone').filter((n) => n.type !== 'text')).toEqual([
      { type: 'mention', kind: 'user', id: '123456789012345678' },
      { type: 'mention', kind: 'role', id: '123456789012345678' },
      { type: 'mention', kind: 'channel', id: '123456789012345678' },
      { type: 'everyone', value: '@everyone' },
    ]);
    expect(parseInline('<t:1700000000:R>')).toEqual([{ type: 'timestamp', unix: 1700000000, style: 'R' }]);
    expect(parseInline('<t:1700000000>')).toEqual([{ type: 'timestamp', unix: 1700000000, style: 'f' }]);
    expect(parseInline('<a:wave:123456789012345678>')).toEqual([{ type: 'emoji', animated: true, name: 'wave', id: '123456789012345678' }]);
  });

  it('handles escapes, code and line breaks', () => {
    expect(parseInline('\\*not italic\\*')).toEqual([
      { type: 'text', value: '*' },
      { type: 'text', value: 'not italic' },
      { type: 'text', value: '*' },
    ]);
    expect(parseInline('`**raw**`')).toEqual([{ type: 'code', value: '**raw**' }]);
    expect(parseInline('a\nb').map((n) => n.type)).toEqual(['text', 'br', 'text']);
  });
});

describe('parseMarkdown', () => {
  it('builds blocks', () => {
    const blocks = parseMarkdown('# عنوان\n-# صغير\n> اقتباس\n- أول\n- ثاني\n```js\nconst a = 1;\n```\nسطر');
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'subtext', 'quote', 'list', 'codeblock', 'paragraph']);
    const code = blocks[4];
    expect(code).toEqual({ type: 'codeblock', lang: 'js', value: 'const a = 1;' });
    const list = blocks[3];
    expect(list?.type === 'list' && list.items.length).toBe(2);
  });

  it('supports single-line code blocks and drops empty paragraphs', () => {
    expect(parseMarkdown('```x```')).toEqual([{ type: 'codeblock', lang: null, value: 'x' }]);
    expect(parseMarkdown('\n\n')).toEqual([]);
  });
});

describe('formatDiscordTimestamp', () => {
  it('formats relative timestamps', () => {
    const now = 1_700_000_000_000;
    expect(formatDiscordTimestamp(1_700_000_000 - 3600, 'R', now)).toContain('ساعة');
    expect(formatDiscordTimestamp(Number.NaN, 'f', now)).toBe('<t:NaN>');
  });
});
