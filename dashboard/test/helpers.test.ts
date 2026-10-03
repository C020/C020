import { describe, expect, it } from 'vitest';
import type { StreamerDto } from '../src/api/types';
import { actorLabel, actorUserId, auditCategory, touchesStreamers } from '../src/lib/audit';
import { withDefaults } from '../src/lib/cn';
import { defaultAvatarUrl, extractSnowflake, isSnowflake, snowflakeDate } from '../src/lib/discord';
import { layoutFields } from '../src/lib/embed';
import { problemFix } from '../src/lib/problems';
import { filterStreamers } from '../src/lib/streamers';

describe('discord helpers', () => {
  it('extracts IDs from mentions, links and raw input', () => {
    expect(extractSnowflake(' 123456789012345678 ')).toBe('123456789012345678');
    expect(extractSnowflake('<@!123456789012345678>')).toBe('123456789012345678');
    expect(extractSnowflake('<@&123456789012345678>')).toBe('123456789012345678');
    expect(extractSnowflake('https://discord.com/users/123456789012345678')).toBe('123456789012345678');
    expect(extractSnowflake('‎1234 5678 9012 345678')).toBe('123456789012345678');
    expect(extractSnowflake('abc')).toBe('abc');
    expect(isSnowflake('1234')).toBe(false);
  });

  it('computes default avatars and creation dates', () => {
    expect(defaultAvatarUrl('80351110224678912')).toMatch(/embed\/avatars\/[0-5]\.png$/);
    expect(defaultAvatarUrl(null)).toContain('/0.png');
    expect(snowflakeDate('175928847299117063')?.toISOString()).toBe('2016-04-30T11:18:25.796Z');
  });
});

describe('class defaults', () => {
  it('applies a default only when the caller did not set that utility', () => {
    expect(withDefaults('size-3 text-red-500', ['size-', 'size-4'])).toBe('size-3 text-red-500');
    expect(withDefaults('text-red-500', ['size-', 'size-4'])).toBe('size-4 text-red-500');
    expect(withDefaults('sm:size-6', ['size-', 'size-4'])).toBe('size-4 sm:size-6');
    expect(withDefaults(undefined, ['rounded', 'rounded-lg'])).toBe('rounded-lg');
  });
});

describe('audit helpers', () => {
  it('categorizes actions and labels actors', () => {
    expect(auditCategory('live.start')).toBe('live');
    expect(auditCategory('account.add')).toBe('streamer');
    expect(auditCategory('discord.roles')).toBe('roles');
    expect(auditCategory('discord.channel.deleted')).toBe('discord');
    expect(auditCategory('bot.start')).toBe('system');
    expect(actorUserId('user:123')).toBe('123');
    expect(actorLabel('user:123', '123')).toBe('أنت');
    expect(actorLabel('user:987654321', '123')).toBe('مشرف 4321…');
    expect(actorLabel('system')).toBe('النظام');
    expect(touchesStreamers({ action: 'streamer.update' })).toBe(true);
  });
});

describe('problem fixes', () => {
  it('maps diagnostics codes to actions', () => {
    expect(problemFix('bot_not_in_guild')?.kind).toBe('invite');
    expect(problemFix('live_role_above_bot')).toMatchObject({ kind: 'settings', section: 'roles' });
    expect(problemFix('same_roles')).toMatchObject({ kind: 'settings', section: 'roles' });
    expect(problemFix('content_channel_unset')).toMatchObject({ kind: 'settings', section: 'channels' });
    expect(problemFix('ping_role_not_mentionable')).toMatchObject({ kind: 'settings', section: 'ping' });
    expect(problemFix('provider_failing:tiktok')?.kind).toBe('system');
    expect(problemFix('members_intent')?.kind).toBe('external');
    expect(problemFix('something_new')).toBeNull();
  });
});

describe('embed layout', () => {
  it('packs inline fields three per row', () => {
    const f = (name: string, inline = true) => ({ name, value: 'v', inline });
    const rows = layoutFields([f('a'), f('b'), f('c'), f('d'), f('wide', false), f('e')]);
    expect(rows.map((r) => r.map((x) => x.name))).toEqual([['a', 'b', 'c'], ['d'], ['wide'], ['e']]);
  });
});

describe('streamer list filter', () => {
  const streamer = (id: number, name: string, extra: Partial<StreamerDto> = {}): StreamerDto => ({
    id,
    discordUserId: `10000000000000000${id}`,
    displayName: name,
    avatarUrl: null,
    notes: null,
    color: null,
    enabled: true,
    isLive: false,
    inGuild: true,
    accounts: [],
    stats: { sessions30d: 0, hours30d: id, peakViewers30d: 0 },
    createdAt: `2026-10-0${id}T00:00:00Z`,
    ...extra,
  });
  const account = { id: 1, platform: 'kick' as const, channelId: 1, handle: 'zed_live', displayName: 'Zed', avatarUrl: null, url: '', notifyLive: true, notifyContent: true, contentKinds: null, isLive: false, snapshot: null, lastCheckedAt: null, lastError: null };
  const list = [
    streamer(1, 'Bravo', { accounts: [account] }),
    streamer(2, 'Alpha', { isLive: true, accounts: [{ ...account, id: 2, platform: 'twitch' as const, handle: 'alpha' }] }),
    streamer(3, 'Charlie', { enabled: false, accounts: [{ ...account, id: 3, lastError: 'boom' }] }),
  ];

  it('sorts live first by default and filters by status/platform/search', () => {
    expect(filterStreamers(list, '', 'all', null, 'live').map((s) => s.displayName)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(filterStreamers(list, '', 'all', null, 'hours').map((s) => s.id)).toEqual([3, 2, 1]);
    expect(filterStreamers(list, '', 'disabled', null, 'name').map((s) => s.id)).toEqual([3]);
    expect(filterStreamers(list, '', 'issues', null, 'name').map((s) => s.id)).toEqual([3]);
    expect(filterStreamers(list, '', 'all', 'kick', 'name').map((s) => s.id)).toEqual([1, 3]);
    expect(filterStreamers(list, 'ZED_', 'all', null, 'name').map((s) => s.id)).toEqual([1, 3]);
    expect(filterStreamers(list, '100000000000000002', 'all', null, 'name').map((s) => s.id)).toEqual([2]);
  });
});
