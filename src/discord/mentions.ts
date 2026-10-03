/**
 * Ping (mention) policy. Nothing in a bot message may notify anyone except the guild's configured ping:
 * every send/edit carries an explicit allowedMentions, so `{mention}` and anything inside titles stay silent.
 */
import type { GuildSettings } from '../db/models.js';
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

/**
 * Ping for a guild's notifications. Mode "none" (the default) never pings. A role ping needs a valid role
 * id; the guild id itself is the @everyone role and is refused so a role ping can never become a mass ping.
 */
export function buildPing(settings: Pick<GuildSettings, 'guildId' | 'pingMode' | 'pingRoleId'>): PingSpec {
  switch (settings.pingMode) {
    case 'everyone':
      return { content: '@everyone', allowedMentions: { parse: ['everyone'], repliedUser: false } };
    case 'here':
      return { content: '@here', allowedMentions: { parse: ['everyone'], repliedUser: false } };
    case 'role': {
      const roleId = settings.pingRoleId?.trim() ?? '';
      if (!SNOWFLAKE_RE.test(roleId) || roleId === settings.guildId) return { content: '', allowedMentions: silentMentions() };
      return { content: `<@&${roleId}>`, allowedMentions: { parse: [], roles: [roleId], repliedUser: false } };
    }
    default:
      return { content: '', allowedMentions: silentMentions() };
  }
}

/** Puts the ping in front of the body, keeping the whole content within Discord's 2000 characters. */
export function composeContent(ping: string, body: string): string {
  if (!ping) return truncate(body, DISCORD_LIMITS.content);
  if (!body) return ping;
  const separator = body.includes('\n') ? '\n' : ' ';
  return `${ping}${separator}${truncate(body, DISCORD_LIMITS.content - ping.length - separator.length)}`;
}
