import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { DiscordLookups } from '../../src/discord/gateway.js';
import { FakeClient, FakeGuild } from './fakeDiscord.js';
import { GUILD, settings } from './helpers.js';

const BOT_ROLE = '700000000000000009';
const NOTIFY_ROLE = '700000000000000004';
const PANEL = '300000000000000101';
const COUNTER = '300000000000000102';
const ROUTED = '300000000000000103';
const POST = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles];

function setup(opts: { presenceIntent?: boolean; perms?: bigint[] } = {}) {
  const client = new FakeClient();
  const guild = client.addGuild(new FakeGuild(GUILD));
  const botRole = guild.addRole(BOT_ROLE, 'StreamBot', 10);
  guild.addBot('800000000000000000', [botRole], opts.perms ?? [...POST, PermissionFlagsBits.ManageRoles, PermissionFlagsBits.MentionEveryone]);
  const lookups = new DiscordLookups({ getClient: () => client.asClient(), membersIntentOk: () => true, presenceIntent: () => opts.presenceIntent ?? false });
  return { client, guild, lookups };
}

describe('DiscordLookups v2 facts', () => {
  it('collects routed, panel and counter channels, role power and the presence intent', async () => {
    const { guild, lookups } = setup();
    guild.addRole(NOTIFY_ROLE, 'Alerts', 3, { permissions: PermissionFlagsBits.BanMembers });
    guild.addChannel(PANEL, 'panels');
    const counter = guild.addChannel(COUNTER, 'counter', ChannelType.GuildVoice);
    counter.allowed = new Set([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels]);
    const s = settings({ liveRoleId: null, streamerRoleId: null, options: { ...settings().options, autoStreamerRole: false } });
    s.features.notifyRole = { ...s.features.notifyRole, roleId: NOTIFY_ROLE, panelChannelId: PANEL };
    s.features.counter = { ...s.features.counter, channelId: COUNTER };
    s.features.routing = { liveByPlatform: { kick: ROUTED }, contentByPlatform: {}, contentByKind: {} };
    s.features.presence = { ...s.features.presence, enabled: true };
    const result = await lookups.diagnose(GUILD, s);
    expect(result.problems.map((p) => p.code)).toEqual([
      'live_role_unset',
      'live_channel_unset',
      'content_channel_unset',
      'routed_channel_not_found',
      'notify_role_elevated',
      'counter_channel_no_permission',
      'presence_intent_missing',
    ]);
    expect(result.problems.find((p) => p.code === 'counter_channel_no_permission')!.message).toContain('الاتصال (Connect)');
  });

  it('accepts a renameable counter and an enabled presence intent', async () => {
    const { guild, lookups } = setup({ presenceIntent: true, perms: [...POST, PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.Connect] });
    guild.addChannel(COUNTER, 'counter', ChannelType.GuildVoice);
    const s = settings({ options: { ...settings().options, autoStreamerRole: false } });
    s.features.counter = { ...s.features.counter, channelId: COUNTER };
    s.features.presence = { ...s.features.presence, enabled: true };
    const codes = (await lookups.diagnose(GUILD, s)).problems.map((p) => p.code);
    expect(codes).not.toContain('counter_channel_no_permission');
    expect(codes).not.toContain('presence_intent_missing');
  });

  it('reports diagnostics failures in the guild language', async () => {
    const { lookups } = setup();
    const s = settings();
    s.features.language = 'en';
    // A settings object that makes fact collection throw (corrupt routing).
    (s.features as unknown as { routing: unknown }).routing = null;
    const result = await lookups.diagnose(GUILD, s);
    expect(result.problems).toEqual([{ code: 'diagnostics_failed', level: 'warn', message: 'Could not check the server setup right now, try again shortly' }]);
  });
});

describe('DiscordLookups.checkRole', () => {
  it('describes whether the bot can hand out a role', async () => {
    const { guild, lookups } = setup();
    guild.addRole('700000000000000001', 'Alerts', 3);
    guild.addRole('700000000000000002', 'Admins', 20);
    guild.addRole('700000000000000003', 'Mods', 4, { permissions: PermissionFlagsBits.ManageMessages });
    await expect(lookups.checkRole(GUILD, '700000000000000001')).resolves.toEqual({ exists: true, name: 'Alerts', elevated: false, decision: { ok: true } });
    const above = await lookups.checkRole(GUILD, '700000000000000002', 'en');
    expect(above).toMatchObject({ exists: true, decision: { ok: false, code: 'role_above_bot' } });
    expect(above && above.exists && !above.decision.ok && above.decision.message).toContain('The bot role must be above Admins');
    await expect(lookups.checkRole(GUILD, '700000000000000003')).resolves.toMatchObject({ elevated: true });
    await expect(lookups.checkRole(GUILD, '700000000000000099')).resolves.toEqual({ exists: false });
    await expect(lookups.checkRole(GUILD, 'nope')).resolves.toEqual({ exists: false });
    await expect(lookups.checkRole('999999999999999999', '700000000000000001')).resolves.toBeNull();
  });
});
