import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { DiscordLookups } from '../../src/discord/gateway.js';
import { silentMentions } from '../../src/discord/mentions.js';
import { DiscordTransport, type OutgoingMessage } from '../../src/discord/transport.js';
import { GUILD, settings } from './helpers.js';
import { FakeClient, FakeGuild } from './fakeDiscord.js';

const CHANNEL = '300000000000000001';
const OTHER_GUILD = '199999999999999999';
const POST = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];

const message = (content = ''): OutgoingMessage => ({ content, embeds: [{ title: 't' }], components: [], allowedMentions: silentMentions() });

function setup(perms: bigint[] = POST) {
  const client = new FakeClient();
  const guild = client.addGuild(new FakeGuild(GUILD));
  const botRole = guild.addRole('700000000000000009', 'StreamBot', 10);
  guild.addBot('800000000000000000', [botRole], perms);
  const channel = guild.addChannel(CHANNEL, 'live');
  const transport = new DiscordTransport(() => client.asClient());
  return { client, guild, channel, transport };
}

describe('DiscordTransport', () => {
  it('sends with explicit allowedMentions and omits empty content', async () => {
    const { transport, channel } = setup();
    const result = await transport.send(GUILD, CHANNEL, message());
    expect(result).toEqual({ ok: true, ref: { channelId: CHANNEL, messageId: '900000000000000001' } });
    expect(channel.sent[0]).toEqual({ content: undefined, embeds: [{ title: 't' }], components: [], allowedMentions: { parse: [], repliedUser: false } });
  });

  it('pre-checks posting permissions and names what is missing', async () => {
    const { transport, channel } = setup([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
    const result = await transport.send(GUILD, CHANNEL, message());
    expect(result).toMatchObject({ ok: false, reason: 'forbidden', missing: ['EmbedLinks'], channelName: 'live' });
    expect(channel.sent).toHaveLength(0);
  });

  it('rejects channels of another guild, non-text channels and bad ids', async () => {
    const { transport, client, guild } = setup();
    const other = client.addGuild(new FakeGuild(OTHER_GUILD));
    other.addChannel('300000000000000002', 'elsewhere');
    expect(await transport.send(GUILD, '300000000000000002', message())).toMatchObject({ ok: false, reason: 'wrong_guild' });
    guild.addChannel('300000000000000003', 'voice', ChannelType.GuildVoice);
    expect(await transport.send(GUILD, '300000000000000003', message())).toMatchObject({ ok: false, reason: 'not_text' });
    expect(await transport.send(GUILD, 'nope', message())).toMatchObject({ ok: false, reason: 'channel_missing' });
    expect(await transport.send(GUILD, '300000000000000009', message())).toMatchObject({ ok: false, reason: 'channel_missing' });
  });

  it('maps Discord errors', async () => {
    const { transport, channel, client } = setup();
    channel.sendError = Object.assign(new Error('Invalid Form Body'), { code: 50035 });
    expect(await transport.send(GUILD, CHANNEL, message())).toMatchObject({ ok: false, reason: 'invalid' });
    channel.sendError = Object.assign(new Error('Missing Permissions'), { code: 50013 });
    expect(await transport.send(GUILD, CHANNEL, message())).toMatchObject({ ok: false, reason: 'forbidden' });
    channel.sendError = Object.assign(new Error('Internal'), { status: 500 });
    expect(await transport.send(GUILD, CHANNEL, message())).toMatchObject({ ok: false, reason: 'error' });
    client.channelFetchError = Object.assign(new Error('Missing Access'), { code: 50001 });
    expect(await transport.send(GUILD, '300000000000000008', message())).toMatchObject({ ok: false, reason: 'forbidden' });
  });

  it('edits without a send-permission pre-check and always sends content', async () => {
    const { transport, channel } = setup([PermissionFlagsBits.ViewChannel]);
    const result = await transport.edit(GUILD, { channelId: CHANNEL, messageId: '900000000000000005' }, message(''));
    expect(result).toEqual({ ok: true, ref: { channelId: CHANNEL, messageId: '900000000000000005' } });
    expect(channel.edits[0]!.payload.content).toBe('');
    expect(channel.edits[0]!.payload.allowedMentions).toEqual({ parse: [], repliedUser: false });
  });

  it('reports a deleted message as gone', async () => {
    const { transport, channel } = setup();
    channel.editError = Object.assign(new Error('Unknown Message'), { code: 10008 });
    expect(await transport.edit(GUILD, { channelId: CHANNEL, messageId: '900000000000000005' }, message())).toMatchObject({ ok: false, reason: 'gone' });
    expect(await transport.edit(GUILD, { channelId: CHANNEL, messageId: 'x' }, message())).toMatchObject({ ok: false, reason: 'gone' });
  });

  it('is not ready without a connected client', async () => {
    const { transport, client } = setup();
    client.ready = false;
    expect(await transport.send(GUILD, CHANNEL, message())).toMatchObject({ ok: false, reason: 'not_ready' });
  });
});

describe('DiscordLookups', () => {
  function lookups() {
    const ctx = setup([...POST, PermissionFlagsBits.ManageRoles]);
    const intent = new Map<string, boolean>();
    return { ...ctx, intent, gateway: new DiscordLookups({ getClient: () => ctx.client.asClient(), membersIntentOk: (g) => intent.get(g) ?? null }) };
  }

  it('lists roles below/above the bot with assignability', async () => {
    const { gateway, guild } = lookups();
    guild.addRole('700000000000000001', 'Streamer', 5);
    guild.addRole('700000000000000002', 'Admins', 20);
    guild.addRole('700000000000000003', 'Bot Role', 3, { managed: true });
    const roles = await gateway.roles(GUILD);
    expect(roles.map((r) => [r.name, r.assignable])).toEqual([
      ['Admins', false],
      ['StreamBot', false],
      ['Streamer', true],
      ['Bot Role', false],
    ]);
    expect(roles[0]!.color).toBe(0x123456);
  });

  it('lists text and announcement channels with posting ability, ordered by category', async () => {
    const { gateway, guild, channel } = lookups();
    channel.rawPosition = 2;
    const news = guild.addChannel('300000000000000004', 'news', ChannelType.GuildAnnouncement, 1);
    news.allowed = new Set([PermissionFlagsBits.ViewChannel]);
    const categorized = guild.addChannel('300000000000000005', 'clips', ChannelType.GuildText, 0);
    categorized.parent = { name: 'بثوث', rawPosition: 1 };
    guild.addChannel('300000000000000006', 'voice', ChannelType.GuildVoice);
    const channels = await gateway.textChannels(GUILD);
    expect(channels).toEqual([
      { id: '300000000000000004', name: 'news', type: 'announcement', parentName: null, botCanPost: false },
      { id: CHANNEL, name: 'live', type: 'text', parentName: null, botCanPost: true },
      { id: '300000000000000005', name: 'clips', type: 'text', parentName: 'بثوث', botCanPost: true },
    ]);
  });

  it('fetches members: info for members, null for strangers', async () => {
    const { gateway, guild } = lookups();
    guild.addMember('200000000000000001', 'فهد', { cached: false });
    const member = await gateway.fetchMember(GUILD, '200000000000000001');
    expect(member).toMatchObject({ id: '200000000000000001', displayName: 'فهد', bot: false, roleIds: [] });
    expect(await gateway.fetchMember(GUILD, '200000000000000009')).toBeNull();
    expect(await gateway.fetchMember(GUILD, 'bad')).toBeNull();
    await expect(gateway.fetchMember('999999999999999999', '200000000000000001')).rejects.toThrow();
  });

  it('exposes bot, guild info and cached avatars', () => {
    const { gateway, guild } = lookups();
    guild.addMember('200000000000000001', 'فهد');
    expect(gateway.isReady()).toBe(true);
    expect(gateway.botUser()).toEqual({ id: '800000000000000000', username: 'StreamBot', avatarUrl: 'https://cdn.discordapp.com/avatars/bot.png' });
    expect(gateway.guilds()).toEqual([{ id: GUILD, name: 'سيرفر', iconUrl: null, memberCount: 100 }]);
    expect(gateway.avatarFor(GUILD, '200000000000000001')).toBe('https://cdn.discordapp.com/avatars/200000000000000001/a.png');
    expect(gateway.avatarFor(GUILD, '200000000000000002')).toBeNull();
  });

  it('diagnoses a real guild setup', async () => {
    const { gateway, guild, intent } = lookups();
    guild.addRole('700000000000000001', 'Streamer', 5);
    guild.addRole('700000000000000002', 'Streaming Now', 15);
    const content = guild.addChannel('300000000000000007', 'videos');
    content.allowed = new Set([PermissionFlagsBits.ViewChannel]);
    intent.set(GUILD, false);
    const result = await gateway.diagnose(
      GUILD,
      settings({ streamerRoleId: '700000000000000001', liveRoleId: '700000000000000002', liveChannelId: CHANNEL, contentChannelId: '300000000000000007' }),
    );
    expect(result.botInGuild).toBe(true);
    expect(result.botHasManageRoles).toBe(true);
    expect(result.problems.map((p) => p.code)).toEqual(['live_role_above_bot', 'content_channel_no_permission', 'members_intent']);
  });

  it('diagnoses a guild the bot is not in', async () => {
    const { gateway } = lookups();
    const result = await gateway.diagnose('999999999999999999', settings());
    expect(result).toMatchObject({ botInGuild: false, problems: [{ code: 'bot_not_in_guild' }] });
  });
});
