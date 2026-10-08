/**
 * Permission rules (pure): what the bot needs, the role-hierarchy decision and channel posting checks.
 * Messages default to Arabic (dashboard diagnostics and the audit log); pass a language for Discord-facing text.
 */
import { PermissionFlagsBits } from 'discord.js';
import type { Language } from '../db/features.js';
import { ti } from './i18n/interactions.js';

/** Permissions requested by the invite link. */
export const REQUIRED_PERMISSIONS: bigint =
  PermissionFlagsBits.ManageRoles |
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.EmbedLinks |
  // Expiring TikTok images are uploaded as attachments (content posts and summaries).
  PermissionFlagsBits.AttachFiles |
  PermissionFlagsBits.ReadMessageHistory;

export function buildInviteUrl(clientId: string, permissions: bigint = REQUIRED_PERMISSIONS): string {
  return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(clientId)}&scope=bot%20applications.commands&permissions=${permissions.toString()}`;
}

export const PERMISSION_NAMES_AR = {
  ViewChannel: 'عرض الروم (View Channel)',
  SendMessages: 'إرسال الرسائل (Send Messages)',
  SendMessagesInThreads: 'الإرسال في الثريدات (Send Messages in Threads)',
  EmbedLinks: 'تضمين الروابط (Embed Links)',
  AttachFiles: 'إرفاق الملفات (Attach Files)',
  ReadMessageHistory: 'قراءة سجل الرسائل (Read Message History)',
  ManageRoles: 'إدارة الرتب (Manage Roles)',
  MentionEveryone: 'منشن الجميع (Mention @everyone)',
  ManageChannels: 'إدارة الروم (Manage Channel)',
  Connect: 'الاتصال (Connect)',
} as const;

export type PermissionName = keyof typeof PERMISSION_NAMES_AR;

export const PERMISSION_NAMES_EN: Readonly<Record<PermissionName, string>> = {
  ViewChannel: 'View Channel',
  SendMessages: 'Send Messages',
  SendMessagesInThreads: 'Send Messages in Threads',
  EmbedLinks: 'Embed Links',
  AttachFiles: 'Attach Files',
  ReadMessageHistory: 'Read Message History',
  ManageRoles: 'Manage Roles',
  MentionEveryone: 'Mention @everyone',
  ManageChannels: 'Manage Channel',
  Connect: 'Connect',
};

export function permissionName(name: PermissionName, lang: Language = 'ar'): string {
  return lang === 'en' ? PERMISSION_NAMES_EN[name] : PERMISSION_NAMES_AR[name];
}

/** Permissions needed to post a notification in a channel (threads use their own send permission). */
export function postingPermissions(isThread: boolean): PermissionName[] {
  return ['ViewChannel', isThread ? 'SendMessagesInThreads' : 'SendMessages', 'EmbedLinks'];
}

/** Which of the posting permissions are missing, given a permission test. */
export function missingPostingPermissions(has: (flag: bigint) => boolean, isThread = false): PermissionName[] {
  return postingPermissions(isThread).filter((name) => !has(PermissionFlagsBits[name]));
}

export function permissionList(names: PermissionName[], lang: Language = 'ar'): string {
  return names.map((n) => permissionName(n, lang)).join(lang === 'en' ? ', ' : '، ');
}

export function permissionListAr(names: PermissionName[]): string {
  return permissionList(names, 'ar');
}

/**
 * Permissions needed to rename a channel (#8 counter). Voice/stage channels also need Connect: Discord refuses
 * edits of a voice channel the bot cannot connect to.
 */
export function manageChannelPermissions(isVoice: boolean): PermissionName[] {
  return isVoice ? ['ViewChannel', 'ManageChannels', 'Connect'] : ['ViewChannel', 'ManageChannels'];
}

export function missingManageChannelPermissions(has: (flag: bigint) => boolean, isVoice = false): PermissionName[] {
  return manageChannelPermissions(isVoice).filter((name) => !has(PermissionFlagsBits[name]));
}

/**
 * Permissions that make a role "elevated" (moderation/admin power). The bot hands its roles out automatically,
 * so such a role must never be used as the Streamer / Streaming Now role.
 */
export const ELEVATED_PERMISSIONS: bigint =
  PermissionFlagsBits.Administrator |
  PermissionFlagsBits.ManageGuild |
  PermissionFlagsBits.ManageRoles |
  PermissionFlagsBits.ManageChannels |
  PermissionFlagsBits.ManageMessages |
  PermissionFlagsBits.ManageWebhooks |
  PermissionFlagsBits.BanMembers |
  PermissionFlagsBits.KickMembers |
  PermissionFlagsBits.ModerateMembers |
  PermissionFlagsBits.MentionEveryone;

export function isElevatedPermissions(bitfield: bigint): boolean {
  return (bitfield & ELEVATED_PERMISSIONS) !== 0n;
}

// ───────────────────────────── role hierarchy ─────────────────────────────

export interface RolePosition {
  id: string;
  position: number;
}

/**
 * Discord's role order: higher position ranks higher; on equal positions the older role (smaller id) ranks
 * higher (same rule as discord.js Role.comparePositions). Positive when `a` ranks above `b`.
 */
export function compareRolePositions(a: RolePosition, b: RolePosition): number {
  if (a.position !== b.position) return a.position - b.position;
  try {
    const ia = BigInt(a.id);
    const ib = BigInt(b.id);
    return ia === ib ? 0 : ia < ib ? 1 : -1;
  } catch {
    return 0;
  }
}

export interface RoleAssignInput {
  guildId: string;
  role: RolePosition & { name: string; managed: boolean };
  bot: {
    hasManageRoles: boolean;
    /** The bot's highest role (null when it has none besides @everyone). */
    highestRole: RolePosition | null;
  };
}

export type RoleAssignProblem = 'missing_manage_roles' | 'role_everyone' | 'role_managed' | 'role_above_bot';

export type RoleAssignDecision = { ok: true } | { ok: false; code: RoleAssignProblem; message: string };

/**
 * Can the bot add/remove this role? Administrator does not bypass the hierarchy for bots, so the bot's
 * highest role must rank strictly above the target role.
 */
export function decideRoleAssignability(input: RoleAssignInput, lang: Language = 'ar'): RoleAssignDecision {
  const { role, bot } = input;
  const name = role.name || role.id;
  if (role.id === input.guildId) {
    return { ok: false, code: 'role_everyone', message: ti(lang, 'role.everyone') };
  }
  if (role.managed) {
    return { ok: false, code: 'role_managed', message: ti(lang, 'role.managed', { name }) };
  }
  if (!bot.hasManageRoles) {
    return { ok: false, code: 'missing_manage_roles', message: ti(lang, 'role.noManageRoles', { perm: permissionName('ManageRoles', lang), name }) };
  }
  if (!bot.highestRole || compareRolePositions(bot.highestRole, role) <= 0) {
    return { ok: false, code: 'role_above_bot', message: ti(lang, 'role.aboveBot', { name }) };
  }
  return { ok: true };
}

/** True when the bot can assign the role (used for the dashboard role picker). */
export function isAssignable(input: RoleAssignInput): boolean {
  return decideRoleAssignability(input).ok;
}
