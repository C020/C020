/**
 * Read-only Discord lookups for the dashboard and the services (DiscordGateway port), plus the fact
 * collection behind diagnostics. Everything degrades to "unknown/empty" instead of throwing, except
 * fetchMember which must distinguish "not a member" (null) from "could not check" (throws).
 */
import type { Client, Guild, GuildBasedChannel, GuildMember } from 'discord.js';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { childLogger } from '../core/logger.js';
import type { GuildSettings, Language } from '../db/models.js';
import type {
  DiscordChannelInfo,
  DiscordGateway,
  DiscordGuildInfo,
  DiscordMemberInfo,
  DiscordRoleInfo,
  GuildDiagnostics,
} from '../services/ports.js';
import { classifyDiscordError, describeDiscordError } from './apiErrors.js';
import { type ChannelFact, diagnosedChannelIds, diagnoseGuild, type GuildFacts, type RoleFact } from './diagnostics.js';
import { guildLanguage, ti } from './i18n/interactions.js';
import type { RoleCheck } from './interactions/panels.js';
import {
  decideRoleAssignability,
  isAssignable,
  isElevatedPermissions,
  missingManageChannelPermissions,
  missingPostingPermissions,
  type RolePosition,
} from './permissions.js';
import { isSnowflake } from './util.js';

const log = childLogger('discord.gateway');

export interface GatewayDeps {
  getClient: () => Client | null;
  /** Last known result of a full member fetch per guild (members intent health). */
  membersIntentOk: (guildId: string) => boolean | null;
  /** #15 — whether the client logged in with the Presence intent (diagnostics); omitted = unknown. */
  presenceIntent?: () => boolean;
}

const VOICE_TYPES: ReadonlySet<ChannelType> = new Set([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);

function guildInfo(guild: Guild): DiscordGuildInfo {
  return { id: guild.id, name: guild.name, iconUrl: guild.iconURL({ size: 128 }), memberCount: guild.memberCount };
}

function memberInfo(member: GuildMember): DiscordMemberInfo {
  return {
    id: member.id,
    username: member.user.username,
    displayName: member.displayName,
    avatarUrl: member.displayAvatarURL({ size: 256 }),
    bot: member.user.bot,
    roleIds: [...member.roles.cache.keys()].filter((id) => id !== member.guild.id),
  };
}

function botHighestRole(me: GuildMember | null, guildId: string): RolePosition | null {
  const highest = me?.roles.highest;
  return highest && highest.id !== guildId ? { id: highest.id, position: highest.position } : null;
}

export class DiscordLookups implements DiscordGateway {
  constructor(private readonly deps: GatewayDeps) {}

  private get client(): Client | null {
    return this.deps.getClient();
  }

  private readyClient(): Client<true> | null {
    const client = this.client;
    return client?.isReady() ? client : null;
  }

  isReady(): boolean {
    return this.readyClient() !== null;
  }

  botUser(): { id: string; username: string; avatarUrl: string | null } | null {
    const user = this.readyClient()?.user;
    return user ? { id: user.id, username: user.username, avatarUrl: user.displayAvatarURL({ size: 256 }) } : null;
  }

  guilds(): DiscordGuildInfo[] {
    const client = this.readyClient();
    if (!client) return [];
    return [...client.guilds.cache.values()].map(guildInfo).sort((a, b) => a.name.localeCompare(b.name));
  }

  guild(guildId: string): DiscordGuildInfo | null {
    const guild = this.readyClient()?.guilds.cache.get(guildId);
    return guild ? guildInfo(guild) : null;
  }

  async fetchMember(guildId: string, userId: string): Promise<DiscordMemberInfo | null> {
    if (!isSnowflake(userId)) return null;
    const client = this.readyClient();
    if (!client) throw new Error('Discord client is not ready');
    const guild = client.guilds.cache.get(guildId);
    if (!guild) throw new Error(`Bot is not in guild ${guildId}`);
    const cached = guild.members.cache.get(userId);
    if (cached) return memberInfo(cached);
    try {
      return memberInfo(await guild.members.fetch(userId));
    } catch (err) {
      if (classifyDiscordError(err) === 'unknown_member') return null;
      throw err;
    }
  }

  async roles(guildId: string): Promise<DiscordRoleInfo[]> {
    const guild = this.readyClient()?.guilds.cache.get(guildId);
    if (!guild) return [];
    const me = await this.me(guild);
    const bot = { hasManageRoles: me?.permissions.has(PermissionFlagsBits.ManageRoles) ?? false, highestRole: botHighestRole(me, guild.id) };
    return [...guild.roles.cache.values()]
      .filter((role) => role.id !== guild.id)
      .sort((a, b) => b.position - a.position || a.id.localeCompare(b.id))
      .map((role) => ({
        id: role.id,
        name: role.name,
        color: role.colors?.primaryColor ?? role.color,
        position: role.position,
        managed: role.managed,
        assignable: isAssignable({ guildId: guild.id, role: { id: role.id, name: role.name, position: role.position, managed: role.managed }, bot }),
        permissions: role.permissions.bitfield.toString(),
        elevated: isElevatedPermissions(role.permissions.bitfield),
      }));
  }

  async textChannels(guildId: string): Promise<DiscordChannelInfo[]> {
    const guild = this.readyClient()?.guilds.cache.get(guildId);
    if (!guild) return [];
    const me = await this.me(guild);
    const channels = [...guild.channels.cache.values()].filter(
      (c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement,
    );
    const categoryPosition = (c: GuildBasedChannel) => c.parent?.rawPosition ?? -1;
    const ownPosition = (c: GuildBasedChannel) => ('rawPosition' in c ? c.rawPosition : 0);
    return channels
      .sort((a, b) => categoryPosition(a) - categoryPosition(b) || ownPosition(a) - ownPosition(b) || a.id.localeCompare(b.id))
      .map((c) => {
        const perms = me ? c.permissionsFor(me) : null;
        return {
          id: c.id,
          name: c.name,
          type: c.type === ChannelType.GuildAnnouncement ? ('announcement' as const) : ('text' as const),
          parentName: c.parent?.name ?? null,
          botCanPost: perms ? missingPostingPermissions((flag) => perms.has(flag)).length === 0 : false,
        };
      });
  }

  async diagnose(guildId: string, settings: GuildSettings): Promise<GuildDiagnostics> {
    try {
      return diagnoseGuild(await this.collectFacts(guildId, settings), settings);
    } catch (err) {
      log.warn({ guildId, err: describeDiscordError(err) }, 'Diagnostics failed');
      return {
        guildId,
        botInGuild: this.guild(guildId) !== null,
        botHasManageRoles: false,
        problems: [{ code: 'diagnostics_failed', level: 'warn', message: ti(guildLanguage(settings), 'diag.failed') }],
      };
    }
  }

  /**
   * Can the bot hand out this role (exists, not managed, below the bot, Manage Roles) and does it carry
   * moderation power? null when Discord is not ready or the bot is not in the guild (unknown).
   */
  async checkRole(guildId: string, roleId: string, lang: Language = 'ar'): Promise<RoleCheck | null> {
    const guild = this.readyClient()?.guilds.cache.get(guildId);
    if (!guild) return null;
    if (!isSnowflake(roleId)) return { exists: false };
    let role = guild.roles.cache.get(roleId) ?? null;
    if (!role) {
      try {
        role = await guild.roles.fetch(roleId);
      } catch (err) {
        if (classifyDiscordError(err) !== 'unknown_role') return null;
      }
    }
    if (!role) return { exists: false };
    const me = await this.me(guild);
    if (!me) return null;
    return {
      exists: true,
      name: role.name,
      elevated: isElevatedPermissions(role.permissions?.bitfield ?? 0n),
      decision: decideRoleAssignability(
        {
          guildId: guild.id,
          role: { id: role.id, name: role.name, position: role.position, managed: role.managed },
          bot: { hasManageRoles: me.permissions.has(PermissionFlagsBits.ManageRoles), highestRole: botHighestRole(me, guild.id) },
        },
        lang,
      ),
    };
  }

  /** Streamer avatar from the cache only (no REST call on hot paths). */
  avatarFor(guildId: string, userId: string): string | null {
    const client = this.readyClient();
    if (!client || !isSnowflake(userId)) return null;
    const member = client.guilds.cache.get(guildId)?.members.cache.get(userId);
    if (member) return member.displayAvatarURL({ size: 256 });
    return client.users.cache.get(userId)?.displayAvatarURL({ size: 256 }) ?? null;
  }

  private async me(guild: Guild): Promise<GuildMember | null> {
    return guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  }

  private async collectFacts(guildId: string, settings: GuildSettings): Promise<GuildFacts> {
    const client = this.readyClient();
    const base: GuildFacts = {
      guildId,
      ready: client !== null,
      inGuild: false,
      bot: null,
      roles: new Map(),
      channels: new Map(),
      membersIntentOk: this.deps.membersIntentOk(guildId),
      presenceIntent: this.deps.presenceIntent?.(),
    };
    const guild = client?.guilds.cache.get(guildId);
    if (!guild) return base;

    const me = await this.me(guild);
    const roles = new Map<string, RoleFact>();
    for (const role of guild.roles.cache.values()) {
      roles.set(role.id, {
        id: role.id,
        name: role.name,
        position: role.position,
        managed: role.managed,
        mentionable: role.mentionable,
        elevated: isElevatedPermissions(role.permissions?.bitfield ?? 0n),
      });
    }

    const channels = new Map<string, ChannelFact>();
    const counterId = settings.features?.counter.channelId ?? null;
    for (const channelId of diagnosedChannelIds(settings)) {
      if (!isSnowflake(channelId)) continue;
      const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
      if (!channel) continue;
      const textBased = channel.isTextBased() && channel.isSendable();
      const perms = me ? channel.permissionsFor(me) : null;
      const fact: ChannelFact = {
        id: channelId,
        name: channel.name,
        textBased,
        missing: textBased && perms ? missingPostingPermissions((flag) => perms.has(flag), channel.isThread()) : [],
        canAttachFiles: textBased && perms ? perms.has(PermissionFlagsBits.AttachFiles) : undefined,
        thread: channel.isThread(),
      };
      if (channelId === counterId && perms) {
        fact.manageMissing = missingManageChannelPermissions((flag) => perms.has(flag), VOICE_TYPES.has(channel.type));
      }
      channels.set(channelId, fact);
    }

    return {
      ...base,
      inGuild: true,
      bot: me
        ? {
            hasManageRoles: me.permissions.has(PermissionFlagsBits.ManageRoles),
            hasMentionEveryone: me.permissions.has(PermissionFlagsBits.MentionEveryone),
            highestRole: botHighestRole(me, guild.id),
          }
        : null,
      roles,
      channels,
    };
  }
}
