import type { WebSessionGuild } from '../db/models.js';

export const PERMISSION_ADMINISTRATOR = 0x8n;
export const PERMISSION_MANAGE_GUILD = 0x20n;
export const PERMISSION_MANAGE_ROLES = 0x10000000n;

/** Discord permission bitfields are decimal strings that can exceed 2^53, hence BigInt. */
export function parsePermissions(value: string | number | null | undefined): bigint {
  if (value == null || value === '') return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/** Owner, Administrator or Manage Server: the users allowed to configure the bot in a guild. */
export function canManageGuild(guild: Pick<WebSessionGuild, 'owner' | 'permissions'>): boolean {
  if (guild.owner) return true;
  const perms = parsePermissions(guild.permissions);
  return (perms & (PERMISSION_ADMINISTRATOR | PERMISSION_MANAGE_GUILD)) !== 0n;
}

/**
 * Owner, Administrator or Manage Roles: the users allowed to choose which roles the bot hands out and takes away
 * (Manage Server alone must not grant role-assignment power Discord does not give it).
 */
export function canManageRoles(guild: Pick<WebSessionGuild, 'owner' | 'permissions'>): boolean {
  if (guild.owner) return true;
  const perms = parsePermissions(guild.permissions);
  return (perms & (PERMISSION_ADMINISTRATOR | PERMISSION_MANAGE_ROLES)) !== 0n;
}
