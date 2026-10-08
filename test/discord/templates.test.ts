import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEMPLATES,
  DEFAULT_TEMPLATES_BY_LANG,
  DEFAULT_TEMPLATES_EN,
  defaultTemplatesFor,
  DISCORD_LIMITS,
  render,
  renderTemplate,
  resolveTemplate,
} from '../../src/discord/templates.js';
import * as shared from '../../src/shared/templates.js';

describe('render', () => {
  it('replaces variables and leaves unknown ones empty', () => {
    expect(render('🔴 {name} يبث على {platform}', { name: 'فهد', platform: 'Twitch' })).toBe('🔴 فهد يبث على Twitch');
    expect(render('مرحبا {name}{unknown}!', { name: 'فهد' })).toBe('مرحبا فهد!');
  });

  it('formats numbers with western digits and matches keys case-insensitively', () => {
    expect(render('{viewers} مشاهد', { viewers: 12345 })).toBe('12,345 مشاهد');
    expect(render('{Name}', { name: 'فهد' })).toBe('فهد');
  });

  it('drops lines whose placeholders all rendered empty', () => {
    expect(render('**{title}**\n🎮 {game}', { title: 'رانكد', game: '' })).toBe('**رانكد**');
    expect(render('**{title}**\n🎮 {game}', { title: '', game: '' })).toBe('');
    // A line with at least one filled placeholder is kept.
    expect(render('{a} و {b}', { a: 'x' })).toBe('x و');
    // Lines without placeholders are always kept.
    expect(render('سطر ثابت\n{missing}\nسطر ثاني', {})).toBe('سطر ثابت\nسطر ثاني');
  });

  it('collapses blank runs, trims and keeps text that only looks like a placeholder', () => {
    expect(render('a\n\n\n\nb\n', {})).toBe('a\n\nb');
    expect(render('{ not a var } {1abc}', {})).toBe('{ not a var } {1abc}');
    expect(render('', { a: 'x' })).toBe('');
  });
});

describe('resolveTemplate', () => {
  it('falls back field by field: override → saved → default', () => {
    const saved = { live: { title: 'محفوظ {name}', color: 0x123456 } };
    const resolved = resolveTemplate('live', saved, { description: 'معاينة' });
    expect(resolved.title).toBe('محفوظ {name}');
    expect(resolved.description).toBe('معاينة');
    expect(resolved.footer).toBe(DEFAULT_TEMPLATES.live.footer);
    expect(resolved.color).toBe(0x123456);
  });

  it('treats an explicit empty string as intentionally empty', () => {
    expect(resolveTemplate('live', { live: { footer: '' } }).footer).toBe('');
  });

  it('lets an override clear the saved color and rejects invalid colors', () => {
    expect(resolveTemplate('live', { live: { color: 0xff0000 } }, { color: null }).color).toBeNull();
    expect(resolveTemplate('live', { live: { color: -5 } }).color).toBeNull();
    expect(resolveTemplate('live', { live: { color: 0x1000000 } }).color).toBeNull();
    expect(resolveTemplate('live', { live: { color: 1.5 } }).color).toBeNull();
  });

  it('ignores non-string template fields coming from untrusted input', () => {
    const bad = { live: { title: 42 as unknown as string } };
    expect(resolveTemplate('live', bad).title).toBe(DEFAULT_TEMPLATES.live.title);
  });

  it('has Arabic defaults for every type', () => {
    expect(DEFAULT_TEMPLATES.live.title).toBe('🔴 {name} يبث الحين!');
    expect(DEFAULT_TEMPLATES.summary.title).toContain('انتهى بث');
    expect(DEFAULT_TEMPLATES.content.description).toContain('نزّل {kind} جديد على {platform}');
  });
});

describe('resolveTemplate layers (#5 streamer templates, #16 language)', () => {
  it('resolves each field: override → streamer → guild → default', () => {
    const guild = { live: { title: 'guild title', description: 'guild description', footer: 'guild footer' } };
    const streamer = { live: { title: 'streamer title', description: 'streamer description' } };
    const resolved = resolveTemplate('live', guild, { title: 'override title' }, { streamer });
    expect(resolved).toEqual({
      content: DEFAULT_TEMPLATES.live.content,
      title: 'override title',
      description: 'streamer description',
      footer: 'guild footer',
      color: null,
    });
  });

  it("treats an empty string in a streamer template as 'empty' and undefined as inherit", () => {
    const guild = { content: { footer: 'guild footer', title: 'guild title' } };
    const resolved = resolveTemplate('content', guild, undefined, { streamer: { content: { footer: '' } } });
    expect(resolved.footer).toBe('');
    expect(resolved.title).toBe('guild title');
  });

  it('only applies the streamer template of the same type', () => {
    expect(resolveTemplate('summary', {}, undefined, { streamer: { live: { title: 'x' } } }).title).toBe(DEFAULT_TEMPLATES.summary.title);
  });

  it('colors: override key decides, else a valid streamer color, else the guild color', () => {
    const guild = { live: { color: 0x111111 } };
    expect(resolveTemplate('live', guild, undefined, { streamer: { live: { color: 0x222222 } } }).color).toBe(0x222222);
    // A null/invalid streamer color inherits the guild template color.
    expect(resolveTemplate('live', guild, undefined, { streamer: { live: { color: null } } }).color).toBe(0x111111);
    expect(resolveTemplate('live', guild, undefined, { streamer: { live: { color: -1 } } }).color).toBe(0x111111);
    expect(resolveTemplate('live', guild, { color: 0x333333 }, { streamer: { live: { color: 0x222222 } } }).color).toBe(0x333333);
    expect(resolveTemplate('live', guild, { color: null }, { streamer: { live: { color: 0x222222 } } }).color).toBeNull();
  });

  it('uses the English defaults for English guilds and Arabic otherwise', () => {
    expect(resolveTemplate('live', {}, undefined, { language: 'en' }).title).toBe('🔴 {name} is live now!');
    expect(resolveTemplate('live', {}, undefined, { language: 'ar' }).title).toBe(DEFAULT_TEMPLATES.live.title);
    expect(resolveTemplate('live', {}, undefined, { language: null }).title).toBe(DEFAULT_TEMPLATES.live.title);
    // Saved custom templates are used as written, whatever the language.
    expect(resolveTemplate('live', { live: { title: 'عنوان مخصص' } }, undefined, { language: 'en' }).title).toBe('عنوان مخصص');
  });

  it('exposes defaults for every language and type, with the same placeholders', () => {
    expect(DEFAULT_TEMPLATES_BY_LANG.ar).toBe(DEFAULT_TEMPLATES);
    expect(DEFAULT_TEMPLATES_BY_LANG.en).toBe(DEFAULT_TEMPLATES_EN);
    expect(defaultTemplatesFor('en')).toBe(DEFAULT_TEMPLATES_EN);
    expect(defaultTemplatesFor(undefined)).toBe(DEFAULT_TEMPLATES);
    // The dashboard imports the shared module directly: both stay in sync.
    expect(shared.DEFAULT_TEMPLATES).toBe(DEFAULT_TEMPLATES);
    expect(shared.DEFAULT_TEMPLATES_BY_LANG).toBe(DEFAULT_TEMPLATES_BY_LANG);
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const type of ['live', 'summary', 'content'] as const) {
      for (const key of ['content', 'title', 'description', 'footer'] as const) {
        expect(placeholders(DEFAULT_TEMPLATES_EN[type][key])).toEqual(placeholders(DEFAULT_TEMPLATES[type][key]));
      }
    }
    expect(Object.isFrozen(DEFAULT_TEMPLATES_EN.live)).toBe(true);
  });
});

describe('renderTemplate', () => {
  it('truncates every part to Discord limits', () => {
    const long = 'ا'.repeat(10_000);
    const out = renderTemplate({ content: long, title: long, description: long, footer: long, color: null }, {});
    expect(out.content.length).toBe(DISCORD_LIMITS.content);
    expect(out.title.length).toBe(DISCORD_LIMITS.title);
    expect(out.description.length).toBe(DISCORD_LIMITS.description);
    expect(out.footer.length).toBe(DISCORD_LIMITS.footer);
    expect(out.title.endsWith('…')).toBe(true);
  });

  it('uses markdown-escaped variables only where Discord renders markdown', () => {
    const out = renderTemplate({ content: '{title}', title: '{title}', description: '{title}', footer: '{title}', color: null }, { title: 'a*b' }, { title: 'a\\*b' });
    expect(out.title).toBe('a*b');
    expect(out.footer).toBe('a*b');
    expect(out.description).toBe('a\\*b');
    expect(out.content).toBe('a\\*b');
  });
});
