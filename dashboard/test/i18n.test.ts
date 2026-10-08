import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiRequest, errorMessage } from '../src/api/client';
import { I18nProvider, useI18n } from '../src/i18n';
import { ar } from '../src/i18n/ar';
import {
  applyDocumentLang,
  dictionary,
  dirOf,
  formatList,
  getLang,
  interpolate,
  intlLocale,
  isLang,
  langStore,
  setLang,
  t,
  translatedRecord,
  type Message,
  type MessageKey,
} from '../src/i18n/core';
import { en } from '../src/i18n/en';
import { AUDIT_CATEGORY_LABELS, actorLabel } from '../src/lib/audit';
import { formatCalendar, formatCompact, formatDurationLong, formatDurationShort, formatHours, formatNumber, formatRelative } from '../src/lib/format';
import { CONTENT_KIND_LABELS, PLATFORM_META } from '../src/lib/platforms';
import { problemFix } from '../src/lib/problems';
import { validateDraft, type SettingsDraft } from '../src/lib/settings';
import { TEMPLATE_VARIABLES } from '../../src/shared/api';
import { TEMPLATE_TYPE_LABELS, TEMPLATE_TYPES, variableDescription } from '../src/lib/templates';

const ARABIC = /[؀-ۿ]/;
const ARABIC_INDIC_DIGITS = /[٠-٩۰-۹]/;

function placeholders(message: Message): string[] {
  const texts = typeof message === 'string' ? [message] : Object.values(message);
  const names = new Set<string>();
  for (const text of texts) for (const m of (text ?? '').matchAll(/\{(\w+)\}/g)) names.add(m[1]!);
  return [...names].sort();
}

afterEach(() => {
  langStore.set('ar');
  vi.unstubAllGlobals();
});

describe('dictionaries', () => {
  const keys = Object.keys(ar) as MessageKey[];

  it('have exactly the same keys in both languages', () => {
    expect(Object.keys(en).sort()).toEqual([...keys].sort());
  });

  it('use the same placeholders in both languages (count excepted, it is implied by plurals)', () => {
    for (const key of keys) {
      const a = placeholders(ar[key]).filter((p) => p !== 'count');
      const e = placeholders(en[key]).filter((p) => p !== 'count');
      expect({ key, placeholders: e }).toEqual({ key, placeholders: a });
    }
  });

  it('give every plural message an "other" form and keep English free of Arabic', () => {
    for (const key of keys) {
      for (const message of [ar[key], en[key]]) {
        if (typeof message !== 'string') expect(message.other, key).toBeTruthy();
      }
      const englishTexts = typeof en[key] === 'string' ? [en[key]] : Object.values(en[key]);
      // The language toggle label is intentionally written in the other language.
      if (key !== 'lang.switchTo' && key !== 'lang.switchToTitle') {
        for (const text of englishTexts) expect(ARABIC.test(text ?? ''), `${key}: ${text}`).toBe(false);
      }
    }
  });
});

describe('t()', () => {
  it('translates, interpolates and keeps unknown placeholders visible', () => {
    expect(t('nav.overview', undefined, 'ar')).toBe('نظرة عامة');
    expect(t('nav.overview', undefined, 'en')).toBe('Overview');
    expect(t('guilds.hello', { name: 'Zed' }, 'en')).toBe('Hi Zed 👋');
    expect(interpolate('a {x} {y}', { x: 'b' }, 'en')).toBe('a b {y}');
    expect(interpolate('{n}', { n: 12345 }, 'ar')).toBe('12,345');
  });

  it('picks Arabic and English plural forms with western digits', () => {
    const ar = (count: number) => t('time.hours', { count }, 'ar');
    expect([ar(1), ar(2), ar(5), ar(11), ar(100)]).toEqual(['ساعة', 'ساعتين', '5 ساعات', '11 ساعة', '100 ساعة']);
    expect(t('time.hours', { count: 1 }, 'en')).toBe('1 hour');
    expect(t('time.hours', { count: 3 }, 'en')).toBe('3 hours');
    expect(t('diagnostics.problems', { count: 4 }, 'ar')).toBe('فيه 4 مشاكل تحتاج حل');
    expect(t('diagnostics.problems', { count: 1 }, 'en')).toBe('1 problem needs fixing');
  });

  it('defaults to the current language', () => {
    expect(getLang()).toBe('ar');
    langStore.set('en');
    expect(t('common.cancel')).toBe('Cancel');
  });

  it('falls back to the key for unknown keys instead of throwing', () => {
    expect(t('no.such.key' as MessageKey)).toBe('no.such.key');
  });

  it('formats lists per locale', () => {
    expect(formatList(['a', 'b', 'c'], 'en')).toBe('a, b, and c');
    expect(formatList(['أ', 'ب'], 'ar')).toContain('و');
  });

  it('exposes locale helpers', () => {
    expect(isLang('en')).toBe(true);
    expect(isLang('fr')).toBe(false);
    expect(dirOf('ar')).toBe('rtl');
    expect(dirOf('en')).toBe('ltr');
    expect(intlLocale('ar')).toContain('nu-latn');
    expect(dictionary('en')['nav.history']).toBe('History');
  });
});

describe('setLang', () => {
  it('persists the choice and updates <html lang dir> and the title', () => {
    const storage = new Map<string, string>();
    const root = { lang: 'ar', dir: 'rtl' };
    const doc = { documentElement: root, title: '' };
    vi.stubGlobal('window', { localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) } });
    vi.stubGlobal('document', doc);

    setLang('en');
    expect(getLang()).toBe('en');
    expect(storage.get('sb:lang')).toBe('"en"');
    expect(root).toEqual({ lang: 'en', dir: 'ltr' });
    expect(doc.title).toBe('Streams Dashboard');

    setLang('ar');
    expect(root).toEqual({ lang: 'ar', dir: 'rtl' });
    expect(doc.title).toBe('لوحة تحكم البثوث');
  });

  it('ignores invalid languages and survives blocked storage', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
      },
    });
    setLang('fr' as never);
    expect(getLang()).toBe('ar');
    expect(() => setLang('en')).not.toThrow();
    expect(getLang()).toBe('en');
    expect(() => applyDocumentLang()).not.toThrow();
  });
});

describe('locale-aware helpers', () => {
  it('format durations, numbers and dates in English', () => {
    langStore.set('en');
    expect(formatDurationLong(2 * 3600 + 15 * 60)).toBe('2 hours 15 minutes');
    expect(formatDurationLong(0)).toBe('under a minute');
    expect(formatDurationShort(2 * 3600 + 5 * 60)).toBe('2h 5m');
    expect(formatHours(7.25)).toBe('7.3 h');
    expect(formatNumber(1234)).toBe('1,234');
    expect(formatCompact(15_300)).toBe('15.3K');
    const now = Date.parse('2026-10-03T12:00:00Z');
    expect(formatRelative('2026-10-03T11:59:50Z', now)).toBe('just now');
    expect(formatRelative('2026-10-03T11:55:00Z', now)).toBe('5 minutes ago');
    expect(formatCalendar(now, now)).toMatch(/^Today at /);
  });

  it('keep western digits in Arabic', () => {
    const now = Date.parse('2026-10-03T12:00:00Z');
    for (const text of [formatNumber(1234567), formatCompact(15_300), formatRelative('2026-10-01T11:55:00Z', now), formatCalendar(now - 3 * 86_400_000, now), formatDurationLong(9 * 3600)]) {
      expect(ARABIC_INDIC_DIGITS.test(text), text).toBe(false);
    }
  });

  it('translate module-level tables on read', () => {
    expect(PLATFORM_META.twitch.hint).toContain('اسم الحساب');
    expect(TEMPLATE_TYPE_LABELS.live.label).toBe('إشعار البث');
    expect(AUDIT_CATEGORY_LABELS.live).toBe('بث');
    langStore.set('en');
    expect(PLATFORM_META.twitch.hint).toBe('Account login or channel link');
    expect(TEMPLATE_TYPE_LABELS.live.label).toBe('Live notification');
    expect(AUDIT_CATEGORY_LABELS.live).toBe('Live');
    expect(CONTENT_KIND_LABELS.short).toBe('Shorts');
    expect(Object.keys(CONTENT_KIND_LABELS)).toEqual(['video', 'short', 'vod', 'highlight', 'clip']);
    expect(actorLabel('system')).toBe('System');
    expect(problemFix('bot_not_in_guild')?.label).toBe('Invite the bot');
    const record = translatedRecord({ a: 'common.save' });
    expect(record.a).toBe('Save');
    langStore.set('ar');
    expect(record.a).toBe('حفظ');
  });

  it('translate every template variable description', () => {
    for (const type of TEMPLATE_TYPES) {
      for (const variable of TEMPLATE_VARIABLES[type]) {
        expect(variableDescription(type, variable)).toBe(variable.description);
        langStore.set('en');
        expect(ARABIC.test(variableDescription(type, variable)), `${type}.${variable.key}`).toBe(false);
        langStore.set('ar');
      }
    }
    expect(variableDescription('live', { key: 'brand_new', description: 'جديد' })).toBe('جديد');
  });

  it('validate settings with messages in the current language', () => {
    langStore.set('en');
    const draft = { streamerRoleId: 'abc', liveRoleId: '', liveChannelId: '', contentChannelId: '', logChannelId: '', pingRoleId: '', pingMode: 'none' } as unknown as SettingsDraft;
    const errors = validateDraft({ ...draft, options: {} } as SettingsDraft, '111111111111111111');
    expect(errors.streamerRoleId).toBe('IDs are numbers with 17 to 20 digits');
  });
});

describe('API client', () => {
  it('sends x-ui-lang with the current language and localizes client-side errors', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await apiRequest('/api/a');
    langStore.set('en');
    await apiRequest('/api/b');
    expect((fetchMock.mock.calls[0]![1]?.headers as Record<string, string>)['x-ui-lang']).toBe('ar');
    expect((fetchMock.mock.calls[1]![1]?.headers as Record<string, string>)['x-ui-lang']).toBe('en');

    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    const error = await apiRequest('/api/c').catch((e: unknown) => e);
    expect(errorMessage(error)).toBe("Couldn't reach the server. Check your connection and try again");
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }));
    const error503 = await apiRequest('/api/d').catch((e: unknown) => e);
    expect(errorMessage(error503)).toBe('The server is unavailable right now, try again shortly');
    expect(errorMessage(new Error('x'))).toBe('Something went wrong, please try again');
  });
});

describe('React bindings', () => {
  function Probe() {
    const { t, lang, dir } = useI18n();
    return createElement('p', { lang, dir }, t('nav.settings'));
  }

  it('render with the current language', () => {
    expect(renderToString(createElement(I18nProvider, null, createElement(Probe)))).toBe('<p lang="ar" dir="rtl">الإعدادات</p>');
    langStore.set('en');
    expect(renderToString(createElement(I18nProvider, null, createElement(Probe)))).toBe('<p lang="en" dir="ltr">Settings</p>');
  });
});
