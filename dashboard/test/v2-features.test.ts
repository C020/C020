import { describe, expect, it } from 'vitest';
import { DEFAULT_GUILD_FEATURES } from '../../src/db/features';
import type { GuildFeatures, SettingsDto } from '../src/api/types';
import { cleanRoutes, countFeatureChanges, counterPreview, diffFeatures, featuresDraft, isValidTimezone, setRoute, validateFeatures } from '../src/lib/features';
import { diffSettings, draftFromSettings, validateDraft } from '../src/lib/settings';

const GUILD = '111111111111111111';
const ROLE = '222222222222222222';
const CH = '333333333333333333';
const CH2 = '444444444444444444';

function features(patch: Partial<GuildFeatures> = {}): GuildFeatures {
  return { ...structuredClone(DEFAULT_GUILD_FEATURES), ...patch };
}

function settings(f: unknown = features()): SettingsDto {
  return {
    guildId: GUILD,
    streamerRoleId: null,
    liveRoleId: null,
    liveChannelId: null,
    contentChannelId: null,
    logChannelId: null,
    pingMode: 'none',
    pingRoleId: null,
    platformsEnabled: ['twitch'],
    contentKinds: ['clip'],
    templates: {},
    features: f as GuildFeatures,
    options: {
      reconnectMergeMinutes: 10,
      liveUpdateMinutes: 5,
      summaryEnabled: true,
      contentMaxAgeHours: 48,
      skipVodOfAnnouncedLive: true,
      autoStreamerRole: true,
      removeStreamerRoleOnDelete: true,
    },
    updatedAt: '2026-10-03T00:00:00Z',
  };
}

describe('features draft & diff', () => {
  it('fills defaults for missing/legacy feature JSON and reports no change', () => {
    const draft = featuresDraft({ clips: { minViews: 5 } });
    expect(draft.clips.minViews).toBe(5);
    expect(draft.clips.mode).toBe('each');
    expect(draft.language).toBe('ar');
    expect(diffFeatures({ clips: { minViews: 5 } }, draft)).toBeUndefined();
    expect(diffFeatures({}, featuresDraft(undefined))).toBeUndefined();
  });

  it('sends only changed leaf fields as a deep partial', () => {
    const saved = features();
    const draft = featuresDraft(saved);
    draft.notifyRole.roleId = ` ${ROLE} `;
    draft.clips.mode = 'digest';
    draft.clips.digestHour = 20;
    draft.language = 'en';
    draft.silent.content = true;
    expect(diffFeatures(saved, draft)).toEqual({
      notifyRole: { roleId: ROLE },
      clips: { mode: 'digest', digestHour: 20 },
      language: 'en',
      silent: { content: true },
    });
  });

  it('normalises blank ids/texts to null and does not diff whitespace-only edits', () => {
    const saved = features({ notifyRole: { ...DEFAULT_GUILD_FEATURES.notifyRole, panelTitle: 'Hi', panelChannelId: CH } });
    const draft = featuresDraft(saved);
    draft.notifyRole.panelTitle = '   ';
    draft.notifyRole.panelChannelId = '';
    expect(diffFeatures(saved, draft)).toEqual({ notifyRole: { panelTitle: null, panelChannelId: null } });
    const same = featuresDraft(saved);
    same.notifyRole.panelTitle = ' Hi ';
    expect(diffFeatures(saved, same)).toBeUndefined();
  });

  it('sends a whole route map when one route changes (server merges one level deep)', () => {
    const saved = features({ routing: { liveByPlatform: { twitch: CH }, contentByPlatform: {}, contentByKind: {} } });
    const draft = featuresDraft(saved);
    draft.routing.liveByPlatform = setRoute(draft.routing.liveByPlatform, 'kick', CH2);
    expect(diffFeatures(saved, draft)).toEqual({ routing: { liveByPlatform: { twitch: CH, kick: CH2 } } });
    draft.routing.liveByPlatform = setRoute(setRoute(draft.routing.liveByPlatform, 'kick', ''), 'twitch', '  ');
    expect(diffFeatures(saved, draft)).toEqual({ routing: { liveByPlatform: {} } });
    expect(cleanRoutes({ twitch: ' ', kick: CH })).toEqual({ kick: CH });
  });

  it('counts changes for the save bar', () => {
    expect(countFeatureChanges(undefined)).toBe(0);
    expect(countFeatureChanges({ clips: { mode: 'digest', digestHour: 3 }, language: 'en' })).toBe(3);
  });

  it('integrates with the settings diff and change detection', () => {
    const saved = settings();
    const draft = draftFromSettings(saved);
    expect(diffSettings(saved, draft)).toEqual({});
    draft.features.manualPosts.enabled = true;
    expect(diffSettings(saved, draft)).toEqual({ features: { manualPosts: { enabled: true } } });
    // Old servers without features: no diff, no crash.
    const legacy = settings({});
    expect(diffSettings(legacy, draftFromSettings(legacy))).toEqual({});
  });
});

describe('features validation', () => {
  it('accepts the defaults', () => {
    expect(validateFeatures(features(), GUILD)).toEqual({});
  });

  it('mirrors the server rules', () => {
    const f = features();
    f.notifyRole.roleId = GUILD;
    f.notifyRole.panelChannelId = 'abc';
    f.notifyRole.panelTitle = 'x'.repeat(257);
    f.routing.contentByKind = { clip: '123' };
    f.clips.minViews = -1;
    f.clips.digestHour = 24;
    f.clips.digestMax = 0;
    f.counter.template = 'live now';
    f.timezone = 'Mars/Olympus';
    expect(Object.keys(validateFeatures(f, GUILD)).sort()).toEqual([
      'features.clips.digestHour',
      'features.clips.digestMax',
      'features.clips.minViews',
      'features.counter.template',
      'features.notifyRole.panelChannelId',
      'features.notifyRole.panelTitle',
      'features.notifyRole.roleId',
      'features.routing.contentByKind.clip',
      'features.timezone',
    ]);
  });

  it('rejects the streamer/live role as notification role and an empty or too long counter name', () => {
    const f = features();
    f.notifyRole.roleId = ROLE;
    expect(validateFeatures(f, GUILD, [ROLE])['features.notifyRole.roleId']).toBeTruthy();
    f.counter.template = '  ';
    expect(validateFeatures(f, GUILD)['features.counter.template']).toBeTruthy();
    f.counter.template = `{count}${'x'.repeat(90)}`;
    expect(validateFeatures(f, GUILD)['features.counter.template']).toContain('90');
  });

  it('is part of validateDraft', () => {
    const draft = draftFromSettings(settings());
    draft.features.clips.digestMax = 99;
    expect(validateDraft(draft, GUILD)['features.clips.digestMax']).toBeTruthy();
  });

  it('checks timezones with Intl', () => {
    expect(isValidTimezone('Asia/Riyadh')).toBe(true);
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone('Nope/Nowhere')).toBe(false);
  });
});

describe('counter preview', () => {
  it('replaces every {count} and caps at 100 characters', () => {
    expect(counterPreview(' 🔴 Live: {count} ', 3)).toBe('🔴 Live: 3');
    expect(counterPreview('{count}/{count}', 2.7)).toBe('2/2');
    expect([...counterPreview('x'.repeat(120), 1)]).toHaveLength(100);
    expect(counterPreview('{count}', -4)).toBe('0');
  });
});
