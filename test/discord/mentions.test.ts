import { describe, expect, it } from 'vitest';
import { buildPing, composeContent, silentMentions } from '../../src/discord/mentions.js';
import { applyPing, buildLiveMessage } from '../../src/discord/messages.js';
import { GUILD, liveView, platformView, ROLE, settings, withFeatures } from './helpers.js';

const NOTIFY = '777777777777777777';
const notify = (patch: Record<string, unknown> = {}) => ({ notifyRole: { roleId: NOTIFY, ...patch } });

describe('buildPing', () => {
  it('pings nobody by default', () => {
    const ping = buildPing(settings());
    expect(ping.content).toBe('');
    expect(ping.allowedMentions).toEqual({ parse: [], repliedUser: false });
  });

  it('allows only @everyone parsing for everyone/here modes', () => {
    expect(buildPing(settings({ pingMode: 'everyone' }))).toEqual({ content: '@everyone', allowedMentions: { parse: ['everyone'], repliedUser: false } });
    expect(buildPing(settings({ pingMode: 'here' }))).toEqual({ content: '@here', allowedMentions: { parse: ['everyone'], repliedUser: false } });
  });

  it('allows exactly the configured role for role mode', () => {
    const ping = buildPing(settings({ pingMode: 'role', pingRoleId: ROLE }));
    expect(ping.content).toBe(`<@&${ROLE}>`);
    expect(ping.allowedMentions).toEqual({ parse: [], roles: [ROLE], repliedUser: false });
  });

  it('falls back to silence for a missing/invalid role or the @everyone role id', () => {
    expect(buildPing(settings({ pingMode: 'role', pingRoleId: null })).content).toBe('');
    expect(buildPing(settings({ pingMode: 'role', pingRoleId: 'abc' })).content).toBe('');
    const everyoneRole = buildPing(settings({ pingMode: 'role', pingRoleId: GUILD }));
    expect(everyoneRole.content).toBe('');
    expect(everyoneRole.allowedMentions.parse).toEqual([]);
  });

  it('silentMentions never allows anything', () => {
    expect(silentMentions()).toEqual({ parse: [], repliedUser: false });
  });
});

describe('composeContent', () => {
  it('prefixes the ping and respects the 2000 character limit', () => {
    expect(composeContent('', 'نص')).toBe('نص');
    expect(composeContent('@here', '')).toBe('@here');
    expect(composeContent('@here', 'شوفوا')).toBe('@here شوفوا');
    expect(composeContent('@here', 'سطر\nسطر')).toBe('@here\nسطر\nسطر');
    const long = composeContent('@everyone', 'x'.repeat(3000));
    expect(long.length).toBe(2000);
    expect(long.startsWith('@everyone ')).toBe(true);
  });
});

describe('{mention} never pings', () => {
  it('keeps allowedMentions silent even when the template uses {mention}', () => {
    const view = liveView([platformView('twitch')], { settings: settings({ templates: { live: { content: '{mention} بدأ البث' } } }) });
    const message = buildLiveMessage(view);
    expect(message.content).toMatch(/^<@\d+> بدأ البث$/);
    const ping = buildPing(view.settings);
    const final = applyPing(message, ping);
    expect(final.content).toBe(message.content);
    expect(ping.allowedMentions).toEqual({ parse: [], repliedUser: false });
  });

  it('only the configured role may ping when role mode is combined with {mention}', () => {
    const view = liveView([platformView('twitch')], {
      settings: settings({ pingMode: 'role', pingRoleId: ROLE, templates: { live: { content: '{mention}' } } }),
    });
    const ping = buildPing(view.settings);
    const final = applyPing(buildLiveMessage(view), ping);
    expect(final.content.startsWith(`<@&${ROLE}> <@`)).toBe(true);
    expect(ping.allowedMentions.users).toBeUndefined();
    expect(ping.allowedMentions.parse).not.toContain('users');
  });
});

describe('buildPing with the opt-in notification role (#1)', () => {
  it('mentions the notify role on live posts by default (pingOnLive) and not on content posts', () => {
    const s = withFeatures(notify());
    expect(buildPing(s, 'live')).toEqual({ content: `<@&${NOTIFY}>`, allowedMentions: { parse: [], roles: [NOTIFY], repliedUser: false } });
    expect(buildPing(s)).toEqual(buildPing(s, 'live'));
    expect(buildPing(s, 'content')).toEqual({ content: '', allowedMentions: { parse: [], repliedUser: false } });
  });

  it('follows pingOnLive / pingOnContent', () => {
    const contentOnly = withFeatures(notify({ pingOnLive: false, pingOnContent: true }));
    expect(buildPing(contentOnly, 'live').content).toBe('');
    expect(buildPing(contentOnly, 'content').content).toBe(`<@&${NOTIFY}>`);
    expect(buildPing(contentOnly, 'content').allowedMentions.roles).toEqual([NOTIFY]);
  });

  it('combines with @everyone/@here, allowing exactly those mentions', () => {
    const ping = buildPing(withFeatures(notify(), { pingMode: 'everyone' }), 'live');
    expect(ping.content).toBe(`@everyone <@&${NOTIFY}>`);
    expect(ping.allowedMentions).toEqual({ parse: ['everyone'], roles: [NOTIFY], repliedUser: false });
    expect(buildPing(withFeatures(notify(), { pingMode: 'here' }), 'live').content).toBe(`@here <@&${NOTIFY}>`);
  });

  it('combines with the classic role ping and dedupes the same role', () => {
    const both = buildPing(withFeatures(notify(), { pingMode: 'role', pingRoleId: ROLE }), 'live');
    expect(both.content).toBe(`<@&${ROLE}> <@&${NOTIFY}>`);
    expect(both.allowedMentions).toEqual({ parse: [], roles: [ROLE, NOTIFY], repliedUser: false });
    const same = buildPing(withFeatures(notify(), { pingMode: 'role', pingRoleId: NOTIFY }), 'live');
    expect(same.content).toBe(`<@&${NOTIFY}>`);
    expect(same.allowedMentions.roles).toEqual([NOTIFY]);
  });

  it('keeps the classic ping on content posts even when the notify role does not ping there', () => {
    const ping = buildPing(withFeatures(notify(), { pingMode: 'role', pingRoleId: ROLE }), 'content');
    expect(ping.content).toBe(`<@&${ROLE}>`);
    expect(ping.allowedMentions.roles).toEqual([ROLE]);
  });

  it('refuses invalid notify role ids and the @everyone role', () => {
    for (const roleId of [null, '', 'abc', GUILD, ' ']) {
      const ping = buildPing(withFeatures({ notifyRole: { roleId } }), 'live');
      expect(ping).toEqual({ content: '', allowedMentions: { parse: [], repliedUser: false } });
    }
  });

  it('works with settings objects that have no features (older callers)', () => {
    const { features: _features, ...legacy } = settings({ pingMode: 'here' });
    expect(buildPing(legacy, 'live').content).toBe('@here');
  });

  it('never lets {mention} or role markup in templates ping beyond the configured roles', () => {
    const view = liveView([platformView('twitch')], {
      settings: withFeatures(notify(), { templates: { live: { content: '{mention} <@&888888888888888888>' } } }),
    });
    const ping = buildPing(view.settings, 'live');
    const final = applyPing(buildLiveMessage(view), ping);
    expect(final.content.startsWith(`<@&${NOTIFY}> <@`)).toBe(true);
    expect(ping.allowedMentions).toEqual({ parse: [], roles: [NOTIFY], repliedUser: false });
  });
});
