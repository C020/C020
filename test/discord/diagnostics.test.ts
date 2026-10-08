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

describe('diagnoseGuild — v2 features', () => {
  const NOTIFY_ROLE = '700000000000000004';
  const PANEL = '300000000000000091';
  const APPLY_PANEL = '300000000000000092';
  const REVIEW = '300000000000000093';
  const COUNTER = '300000000000000094';
  const ROUTED = '300000000000000095';

  function withFeatures(features: Partial<typeof configured.features>, patch: Partial<typeof configured> = {}) {
    return { ...configured, ...patch, features: { ...configured.features, ...features } };
  }

  it('checks the notification role: missing, above the bot, elevated, not mentionable, conflicting', () => {
    const notify = { ...configured.features.notifyRole, roleId: NOTIFY_ROLE, panelChannelId: PANEL };
    const channels = new Map([...facts().channels, [PANEL, channelFact(PANEL)]]);
    expect(codes(diagnoseGuild(facts({ channels }), withFeatures({ notifyRole: notify })))).toEqual(['notify_role_not_found']);

    const roles = new Map([...facts().roles, [NOTIFY_ROLE, roleFact(NOTIFY_ROLE, 30, { name: 'Alerts', elevated: true, mentionable: false })]]);
    const result = diagnoseGuild(facts({ roles, channels }), withFeatures({ notifyRole: notify }));
    expect(codes(result)).toEqual(['notify_role_above_bot', 'notify_role_elevated', 'notify_role_not_mentionable']);
    expect(result.problems.find((p) => p.code === 'notify_role_not_mentionable')!.level).toBe('warn');

    // Mentionable check is skipped when the role pings nobody or the bot can mention everyone.
    const quiet = { ...notify, pingOnLive: false, pingOnContent: false };
    const okRoles = new Map([...facts().roles, [NOTIFY_ROLE, roleFact(NOTIFY_ROLE, 3, { mentionable: false })]]);
    expect(codes(diagnoseGuild(facts({ roles: okRoles, channels }), withFeatures({ notifyRole: quiet })))).toEqual([]);
    const canMention = facts({ roles: okRoles, channels, bot: { hasManageRoles: true, hasMentionEveryone: true, highestRole: BOT_ROLE } });
    expect(codes(diagnoseGuild(canMention, withFeatures({ notifyRole: notify })))).toEqual([]);

    const conflict = withFeatures({ notifyRole: { ...notify, roleId: LIVE_ROLE } });
    expect(codes(diagnoseGuild(facts({ channels }), conflict))).toEqual(['notify_role_conflict']);
  });

  it('checks the notify panel channel', () => {
    const roles = new Map([...facts().roles, [NOTIFY_ROLE, roleFact(NOTIFY_ROLE, 3)]]);
    const notify = { ...configured.features.notifyRole, roleId: NOTIFY_ROLE };
    expect(codes(diagnoseGuild(facts({ roles }), withFeatures({ notifyRole: notify })))).toEqual(['notify_panel_channel_unset']);
    const channels = new Map([...facts().channels, [PANEL, channelFact(PANEL, { missing: ['SendMessages'] })]]);
    const result = diagnoseGuild(facts({ roles, channels }), withFeatures({ notifyRole: { ...notify, panelChannelId: PANEL } }));
    expect(result.problems.map((p) => [p.code, p.level])).toEqual([['notify_panel_channel_no_permission', 'warn']]);
  });

  it('checks every routed channel once (and not the defaults twice)', () => {
    const routing = { liveByPlatform: { kick: ROUTED }, contentByPlatform: { tiktok: LIVE_CHANNEL }, contentByKind: { clip: ROUTED } };
    const missing = diagnoseGuild(facts(), withFeatures({ routing }));
    expect(codes(missing)).toEqual(['routed_channel_not_found']);
    expect(missing.problems[0]!.level).toBe('error');
    const channels = new Map([...facts().channels, [ROUTED, channelFact(ROUTED, { canAttachFiles: false })]]);
    expect(codes(diagnoseGuild(facts({ channels }), withFeatures({ routing })))).toEqual(['routed_channel_no_attach_files']);
    // The digest channel is a routed channel too.
    const clips = { ...configured.features.clips, digestChannelId: ROUTED };
    expect(codes(diagnoseGuild(facts(), withFeatures({ clips })))).toEqual(['routed_channel_not_found']);
  });

  it('checks the application channels only when applications are enabled', () => {
    const applications = { ...configured.features.applications, enabled: true };
    expect(codes(diagnoseGuild(facts(), withFeatures({ applications })))).toEqual(['apply_panel_channel_unset']);
    const full = { ...applications, panelChannelId: APPLY_PANEL, reviewChannelId: REVIEW };
    const channels = new Map([...facts().channels, [APPLY_PANEL, channelFact(APPLY_PANEL)], [REVIEW, channelFact(REVIEW, { textBased: false })]]);
    expect(codes(diagnoseGuild(facts({ channels }), withFeatures({ applications: full })))).toEqual(['review_channel_not_text']);
    expect(codes(diagnoseGuild(facts(), withFeatures({ applications: { ...full, enabled: false } })))).toEqual([]);
  });

  it('checks that the counter channel can be renamed', () => {
    const counter = { ...configured.features.counter, channelId: COUNTER };
    expect(codes(diagnoseGuild(facts(), withFeatures({ counter })))).toEqual(['counter_channel_not_found']);
    const voice = new Map([...facts().channels, [COUNTER, channelFact(COUNTER, { textBased: false, manageMissing: ['ManageChannels', 'Connect'] })]]);
    const result = diagnoseGuild(facts({ channels: voice }), withFeatures({ counter }));
    expect(codes(result)).toEqual(['counter_channel_no_permission']);
    expect(result.problems[0]!.message).toContain('إدارة الروم (Manage Channel)، الاتصال (Connect)');
    const ok = new Map([...facts().channels, [COUNTER, channelFact(COUNTER, { textBased: false, manageMissing: [] })]]);
    expect(codes(diagnoseGuild(facts({ channels: ok }), withFeatures({ counter })))).toEqual([]);
    const thread = new Map([...facts().channels, [COUNTER, channelFact(COUNTER, { thread: true })]]);
    expect(codes(diagnoseGuild(facts({ channels: thread }), withFeatures({ counter })))).toEqual(['counter_channel_thread']);
  });

  it('warns when presence detection is on without the Presence intent', () => {
    const presence = { ...configured.features.presence, enabled: true };
    expect(codes(diagnoseGuild(facts({ presenceIntent: false }), withFeatures({ presence })))).toEqual(['presence_intent_missing']);
    expect(codes(diagnoseGuild(facts({ presenceIntent: true }), withFeatures({ presence })))).toEqual([]);
    expect(codes(diagnoseGuild(facts({ presenceIntent: false }), configured))).toEqual([]);
  });

  it('speaks the guild language', () => {
    const english = withFeatures({ language: 'en' });
    const fresh = diagnoseGuild(facts(), { ...settings(), features: { ...settings().features, language: 'en' } });
    expect(fresh.problems.map((p) => p.message)).toEqual([
      'The Streamer role is not set — choose it in the settings so the bot can assign it automatically',
      'The Streaming Now role is not set — choose it in the settings so the bot can assign it automatically',
      'No live notification channel is set — the bot will not post live notifications',
      'No content notification channel is set — the bot will not post new content',
    ]);
    const perms = diagnoseGuild(facts({ channels: new Map([[LIVE_CHANNEL, channelFact(LIVE_CHANNEL, { name: 'live', missing: ['SendMessages', 'EmbedLinks'] })]]) }), english);
    expect(perms.problems[0]!.message).toBe('The bot cannot post in the live notification channel (#live) — missing: Send Messages, Embed Links');
    const above = diagnoseGuild(facts({ roles: new Map([[LIVE_ROLE, roleFact(LIVE_ROLE, 25, { name: 'Streaming Now' })]]) }), english);
    expect(above.problems.find((p) => p.code === 'live_role_above_bot')!.message).toContain('The bot role must be above Streaming Now');
    expect(diagnoseGuild(facts({ ready: false }), english).problems[0]!.message).toContain('The bot is not connected to Discord');
  });

  it('still works with settings that predate the features column', () => {
    const legacy = { ...configured } as Partial<typeof configured>;
    delete legacy.features;
    expect(codes(diagnoseGuild(facts(), legacy as typeof configured))).toEqual([]);
  });
});
