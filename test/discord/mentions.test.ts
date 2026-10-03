import { describe, expect, it } from 'vitest';
import { buildPing, composeContent, silentMentions } from '../../src/discord/mentions.js';
import { applyPing, buildLiveMessage } from '../../src/discord/messages.js';
import { GUILD, liveView, platformView, ROLE, settings } from './helpers.js';

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
