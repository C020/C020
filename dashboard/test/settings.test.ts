import { describe, expect, it } from 'vitest';
import type { SettingsDto } from '../src/api/types';
import { diffSettings, draftFromSettings, hasChanges, validateDraft } from '../src/lib/settings';

const GUILD = '111111111111111111';

function settings(overrides: Partial<SettingsDto> = {}): SettingsDto {
  return {
    guildId: GUILD,
    streamerRoleId: '222222222222222222',
    liveRoleId: null,
    liveChannelId: null,
    contentChannelId: null,
    logChannelId: null,
    pingMode: 'none',
    pingRoleId: null,
    platformsEnabled: ['twitch', 'kick', 'youtube', 'tiktok'],
    contentKinds: ['video', 'short', 'vod', 'highlight', 'clip'],
    templates: {},
    // Not used by the settings helpers under test.
    features: {} as SettingsDto['features'],
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
    ...overrides,
  };
}

describe('settings draft', () => {
  it('reports no changes for an untouched draft (order-insensitive lists)', () => {
    const saved = settings({ platformsEnabled: ['kick', 'twitch'] });
    expect(hasChanges(diffSettings(saved, draftFromSettings(saved)))).toBe(false);
  });

  it('sends only changed fields; blank IDs clear the value', () => {
    const saved = settings();
    const draft = draftFromSettings(saved);
    draft.streamerRoleId = '  ';
    draft.liveChannelId = '333333333333333333';
    draft.options.liveUpdateMinutes = 0;
    draft.platformsEnabled = ['twitch'];
    expect(diffSettings(saved, draft)).toEqual({
      streamerRoleId: null,
      liveChannelId: '333333333333333333',
      platformsEnabled: ['twitch'],
      options: { liveUpdateMinutes: 0 },
    });
  });

  it('validates IDs and cross-field rules like the server', () => {
    const draft = draftFromSettings(settings());
    draft.liveRoleId = '222222222222222222';
    draft.logChannelId = '12345';
    draft.pingMode = 'role';
    draft.options.reconnectMergeMinutes = 500;
    const errors = validateDraft(draft, GUILD);
    expect(Object.keys(errors).sort()).toEqual(['liveRoleId', 'logChannelId', 'options.reconnectMergeMinutes', 'pingRoleId']);

    const everyone = draftFromSettings(settings({ streamerRoleId: GUILD }));
    expect(validateDraft(everyone, GUILD).streamerRoleId).toContain('@everyone');
  });
});
