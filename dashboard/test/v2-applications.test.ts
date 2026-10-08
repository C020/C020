import { describe, expect, it } from 'vitest';
import { applicationAccountUrl, decidableStatus, pendingBadge } from '../src/lib/applications';
import { overriddenTypes, overrideDrafts, overridesFromDrafts, sameOverrideDrafts } from '../src/lib/streamerTemplates';
import { looksLikeUrl } from '../src/pages/ManualPostPage';

describe('applications helpers', () => {
  it('maps the status query param to a tab', () => {
    expect(decidableStatus('approved')).toBe('approved');
    expect(decidableStatus('rejected')).toBe('rejected');
    expect(decidableStatus('cancelled')).toBe('pending');
    expect(decidableStatus(null)).toBe('pending');
  });

  it('builds safe profile links from what the applicant typed', () => {
    expect(applicationAccountUrl('twitch', '@Zed_1')).toBe('https://www.twitch.tv/Zed_1');
    expect(applicationAccountUrl('kick', 'zed')).toBe('https://kick.com/zed');
    expect(applicationAccountUrl('youtube', 'zed')).toBe('https://www.youtube.com/@zed');
    expect(applicationAccountUrl('tiktok', '@zed.k')).toBe('https://www.tiktok.com/@zed.k');
    expect(applicationAccountUrl('kick', 'https://kick.com/zed')).toBe('https://kick.com/zed');
    expect(applicationAccountUrl('kick', 'javascript:alert(1)')).toBeNull();
    expect(applicationAccountUrl('kick', 'two words')).toBeNull();
    expect(applicationAccountUrl('kick', '  ')).toBeNull();
  });

  it('formats the nav badge', () => {
    expect(pendingBadge(0)).toBeNull();
    expect(pendingBadge(undefined)).toBeNull();
    expect(pendingBadge(7)).toBe('7');
    expect(pendingBadge(250)).toBe('99+');
  });
});

describe('streamer template overrides', () => {
  it('round-trips overrides, dropping blank fields and empty types', () => {
    const drafts = overrideDrafts({ live: { title: 'Hi {name}', color: 0xff0000 } });
    expect(drafts.summary.title).toBe('');
    drafts.content.description = '   ';
    expect(overridesFromDrafts(drafts)).toEqual({ live: { title: 'Hi {name}', color: 0xff0000 } });
    expect(overridesFromDrafts(overrideDrafts(undefined))).toEqual({});
  });

  it('compares drafts and lists overridden types', () => {
    const a = overrideDrafts({ summary: { footer: 'x' } });
    const b = overrideDrafts({ summary: { footer: 'x' } });
    expect(sameOverrideDrafts(a, b)).toBe(true);
    b.live.content = 'y';
    expect(sameOverrideDrafts(a, b)).toBe(false);
    expect(overriddenTypes({ summary: { footer: 'x' }, live: {} })).toEqual(['summary']);
    expect(overriddenTypes(null)).toEqual([]);
  });
});

describe('manual post URL check', () => {
  it('accepts http(s) URLs only', () => {
    expect(looksLikeUrl('https://kick.com/a/clips/b')).toBe(true);
    expect(looksLikeUrl('kick.com/a')).toBe(false);
    expect(looksLikeUrl('https://nodot')).toBe(false);
  });
});
