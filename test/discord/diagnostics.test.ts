import { describe, expect, it } from 'vitest';
import { type ChannelFact, diagnoseGuild, type GuildFacts, type RoleFact } from '../../src/discord/diagnostics.js';
import { CONTENT_CHANNEL, GUILD, LIVE_CHANNEL, LOG_CHANNEL, settings } from './helpers.js';

const STREAMER_ROLE = '700000000000000001';
const LIVE_ROLE = '700000000000000002';
const PING_ROLE = '700000000000000003';
const BOT_ROLE = { id: '700000000000000009', position: 20 };

function roleFact(id: string, position: number, extra: Partial<RoleFact> = {}): RoleFact {
  return { id, position, name: `role-${position}`, managed: false, mentionable: true, ...extra };
}

function channelFact(id: string, extra: Partial<ChannelFact> = {}): ChannelFact {
  return { id, name: `ch-${id.slice(-2)}`, textBased: true, missing: [], ...extra };
}

function facts(patch: Partial<GuildFacts> = {}): GuildFacts {
  return {
    guildId: GUILD,
    ready: true,
    inGuild: true,
    bot: { hasManageRoles: true, hasMentionEveryone: false, highestRole: BOT_ROLE },
    roles: new Map([
      [STREAMER_ROLE, roleFact(STREAMER_ROLE, 5)],
      [LIVE_ROLE, roleFact(LIVE_ROLE, 6)],
      [PING_ROLE, roleFact(PING_ROLE, 2)],
    ]),
    channels: new Map([
      [LIVE_CHANNEL, channelFact(LIVE_CHANNEL)],
      [CONTENT_CHANNEL, channelFact(CONTENT_CHANNEL)],
      [LOG_CHANNEL, channelFact(LOG_CHANNEL)],
    ]),
    membersIntentOk: true,
    ...patch,
  };
}

const configured = settings({
  streamerRoleId: STREAMER_ROLE,
  liveRoleId: LIVE_ROLE,
  liveChannelId: LIVE_CHANNEL,
  contentChannelId: CONTENT_CHANNEL,
  logChannelId: LOG_CHANNEL,
});

const codes = (d: { problems: Array<{ code: string }> }) => d.problems.map((p) => p.code);

describe('diagnoseGuild', () => {
  it('reports no problems for a healthy setup', () => {
    const result = diagnoseGuild(facts(), configured);
    expect(result).toEqual({ guildId: GUILD, botInGuild: true, botHasManageRoles: true, problems: [] });
  });

  it('warns (without failing the channel) when the bot cannot upload expiring TikTok images', () => {
    const noUploads = (id: string) => [id, channelFact(id, { canAttachFiles: false })] as const;
    const channels = new Map([noUploads(LIVE_CHANNEL), noUploads(CONTENT_CHANNEL), noUploads(LOG_CHANNEL)]);
    const result = diagnoseGuild(facts({ channels }), configured);
    expect(result.problems.map((p) => [p.code, p.level])).toEqual([
      ['live_channel_no_attach_files', 'warn'],
      ['content_channel_no_attach_files', 'warn'],
    ]);
    expect(result.problems[0]!.message).toContain('إرفاق الملفات (Attach Files)');
    // Only TikTok images are uploaded.
    expect(codes(diagnoseGuild(facts({ channels }), { ...configured, platformsEnabled: ['twitch', 'kick'] }))).toEqual([]);
  });

  it('stops early when Discord is not ready or the bot is not in the guild', () => {
    expect(codes(diagnoseGuild(facts({ ready: false }), configured))).toEqual(['discord_not_ready']);
    const notInGuild = diagnoseGuild(facts({ inGuild: false }), configured);
    expect(codes(notInGuild)).toEqual(['bot_not_in_guild']);
    expect(notInGuild.botInGuild).toBe(false);
  });

  it('warns about unset roles and channels on a fresh guild', () => {
    expect(codes(diagnoseGuild(facts(), settings()))).toEqual(['streamer_role_unset', 'live_role_unset', 'live_channel_unset', 'content_channel_unset']);
  });

  it('does not require the streamer role when auto assignment is off', () => {
    const s = settings({ options: { ...configured.options, autoStreamerRole: false }, liveRoleId: LIVE_ROLE, liveChannelId: LIVE_CHANNEL, contentChannelId: CONTENT_CHANNEL });
    expect(codes(diagnoseGuild(facts(), s))).toEqual([]);
  });

  it('detects missing Manage Roles once, deleted roles and roles above the bot', () => {
    const result = diagnoseGuild(
      facts({
        bot: { hasManageRoles: false, hasMentionEveryone: false, highestRole: BOT_ROLE },
        roles: new Map([[LIVE_ROLE, roleFact(LIVE_ROLE, 25, { name: 'Streaming Now' })]]),
      }),
      configured,
    );
    expect(codes(result)).toEqual(['missing_manage_roles', 'streamer_role_not_found', 'live_role_above_bot']);
    expect(result.botHasManageRoles).toBe(false);
    expect(result.problems.find((p) => p.code === 'live_role_above_bot')?.message).toContain('رتبة البوت لازم تكون فوق رتبة Streaming Now');
  });

  it('flags managed roles and identical streamer/live roles', () => {
    const result = diagnoseGuild(
      facts({ roles: new Map([[LIVE_ROLE, roleFact(LIVE_ROLE, 3, { managed: true })]]) }),
      settings({ ...configured, streamerRoleId: LIVE_ROLE }),
    );
    expect(codes(result)).toEqual(['streamer_role_managed', 'live_role_managed', 'same_roles']);
  });

  it('explains channel problems with the missing permissions in Arabic', () => {
    const result = diagnoseGuild(
      facts({
        channels: new Map([
          [LIVE_CHANNEL, channelFact(LIVE_CHANNEL, { name: 'live', missing: ['SendMessages', 'EmbedLinks'] })],
          [LOG_CHANNEL, channelFact(LOG_CHANNEL, { textBased: false })],
        ]),
      }),
      configured,
    );
    expect(codes(result)).toEqual(['live_channel_no_permission', 'content_channel_not_found', 'log_channel_not_text']);
    const live = result.problems[0]!;
    expect(live.level).toBe('error');
    expect(live.message).toContain('#live');
    expect(live.message).toContain('إرسال الرسائل (Send Messages)');
    expect(result.problems[2]!.level).toBe('warn');
  });

  it('checks ping configuration', () => {
    expect(codes(diagnoseGuild(facts(), { ...configured, pingMode: 'everyone' }))).toEqual(['ping_no_permission']);
    expect(codes(diagnoseGuild(facts(), { ...configured, pingMode: 'role', pingRoleId: null }))).toEqual(['ping_role_unset']);
    expect(codes(diagnoseGuild(facts(), { ...configured, pingMode: 'role', pingRoleId: '799999999999999999' }))).toEqual(['ping_role_not_found']);
    const locked = facts({ roles: new Map([...facts().roles, [PING_ROLE, roleFact(PING_ROLE, 2, { mentionable: false })]]) });
    expect(codes(diagnoseGuild(locked, { ...configured, pingMode: 'role', pingRoleId: PING_ROLE }))).toEqual(['ping_role_not_mentionable']);
    const canMention = facts({ bot: { hasManageRoles: true, hasMentionEveryone: true, highestRole: BOT_ROLE } });
    expect(codes(diagnoseGuild(canMention, { ...configured, pingMode: 'here' }))).toEqual([]);
  });

  it('hints at the members intent when the member list could not be fetched', () => {
    const result = diagnoseGuild(facts({ membersIntentOk: false }), configured);
    expect(codes(result)).toEqual(['members_intent']);
    expect(result.problems[0]!.message).toContain('Server Members Intent');
  });
});
