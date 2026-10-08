/**
 * Ping (mention) policy. Nothing in a bot message may notify anyone except the guild's configured ping (classic
 * ping mode + the #1 opt-in notification role): every send/edit carries an explicit allowedMentions, so `{mention}`
 * and anything inside titles stay silent.
 */
import type { GuildSettings, NotifyRoleFeature } from '../db/models.js';
import { DISCORD_LIMITS } from './templates.js';
import { truncate } from './format.js';

export interface AllowedMentions {
  parse: Array<'everyone' | 'roles' | 'users'>;
  roles?: string[];
  users?: string[];
  repliedUser: false;
}

export interface PingSpec {
  /** Text to put in front of the message content ('' when pings are off). */
  content: string;
  allowedMentions: AllowedMentions;
}

const SNOWFLAKE_RE = /^\d{17,20}$/;

/** No mention of any kind is allowed to notify. */
export function silentMentions(): AllowedMentions {
  return { parse: [], repliedUser: false };
}

export const SILENT_PING: Readonly<PingSpec> = Object.freeze({ content: '', allowedMentions: silentMentions() });

/** Which kind of new post the ping is for (#1: the notification role pings per kind). */
export type PingKind = 'live' | 'content';

/** Settings the ping depends on (`features` is optional so older/partial settings objects keep working). */
export type PingSettings = Pick<GuildSettings, 'guildId' | 'pingMode' | 'pingRoleId'> & {
  features?: { notifyRole?: Partial<Pick<NotifyRoleFeature, 'roleId' | 'pingOnLive' | 'pingOnContent'>> | null } | null;
};

/** A role id that may be pinged: a valid snowflake that is not the guild id (= the @everyone role). */
function pingableRole(roleId: string | null | undefined, guildId: string): string | null {
  const id = typeof roleId === 'string' ? roleId.trim() : '';
  return SNOWFLAKE_RE.test(id) && id !== guildId ? id : null;
}

/**
 * Ping for a guild's new live/content posts (never used for edits, summaries or test messages).
 *
 * - Classic `pingMode`: "none" (the default) never pings; "everyone"/"here" allow only the @everyone parse; "role"
 *   allows exactly `pingRoleId`.
 * - #1 opt-in notification role (`features.notifyRole.roleId`): mentioned on live posts when `pingOnLive` (default
 *   on) and on content posts when `pingOnContent` (default off).
 * Both are combined and deduplicated; allowedMentions lists exactly the roles in the content. A role id equal to the
 * guild id (@everyone) is refused, so a role ping can never become a mass ping.
 */
export function buildPing(settings: PingSettings, kind: PingKind = 'live'): PingSpec {
  let everyone: '@everyone' | '@here' | null = null;
  const roles: string[] = [];
  switch (settings.pingMode) {
    case 'everyone':
      everyone = '@everyone';
      break;
    case 'here':
      everyone = '@here';
      break;
    case 'role': {
      const roleId = pingableRole(settings.pingRoleId, settings.guildId);
      if (roleId) roles.push(roleId);
      break;
    }
    default:
      break;
  }

  const notify = settings.features?.notifyRole;
  if (notify) {
    const roleId = pingableRole(notify.roleId, settings.guildId);
    const wanted = kind === 'live' ? (notify.pingOnLive ?? true) === true : (notify.pingOnContent ?? false) === true;
    if (roleId && wanted && !roles.includes(roleId)) roles.push(roleId);
  }

  if (!everyone && roles.length === 0) return { content: '', allowedMentions: silentMentions() };
  const content = [...(everyone ? [everyone] : []), ...roles.map((id) => `<@&${id}>`)].join(' ');
  const allowedMentions: AllowedMentions = { parse: everyone ? ['everyone'] : [], repliedUser: false };
  if (roles.length > 0) allowedMentions.roles = roles;
  return { content, allowedMentions };
}

/** Puts the ping in front of the body, keeping the whole content within Discord's 2000 characters. */
export function composeContent(ping: string, body: string): string {
  if (!ping) return truncate(body, DISCORD_LIMITS.content);
  if (!body) return ping;
  const separator = body.includes('\n') ? '\n' : ' ';
  return `${ping}${separator}${truncate(body, DISCORD_LIMITS.content - ping.length - separator.length)}`;
}
