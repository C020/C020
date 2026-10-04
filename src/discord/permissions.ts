/**
 * Permission rules (pure): what the bot needs, the role-hierarchy decision and channel posting checks.
 * Messages are Arabic because they end up in the dashboard diagnostics and the audit log.
 */
import { PermissionFlagsBits } from 'discord.js';

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
} as const;

export type PermissionName = keyof typeof PERMISSION_NAMES_AR;

/** Permissions needed to post a notification in a channel (threads use their own send permission). */
export function postingPermissions(isThread: boolean): PermissionName[] {
  return ['ViewChannel', isThread ? 'SendMessagesInThreads' : 'SendMessages', 'EmbedLinks'];
}

/** Which of the posting permissions are missing, given a permission test. */
export function missingPostingPermissions(has: (flag: bigint) => boolean, isThread = false): PermissionName[] {
  return postingPermissions(isThread).filter((name) => !has(PermissionFlagsBits[name]));
}

export function permissionListAr(names: PermissionName[]): string {
  return names.map((n) => PERMISSION_NAMES_AR[n]).join('، ');
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
export function decideRoleAssignability(input: RoleAssignInput): RoleAssignDecision {
  const { role, bot } = input;
  const name = role.name || role.id;
  if (role.id === input.guildId) {
    return { ok: false, code: 'role_everyone', message: 'الرتبة المختارة هي @everyone وما ينفع تنعطى أو تنشال، اختر رتبة ثانية' };
  }
  if (role.managed) {
    return {
      ok: false,
      code: 'role_managed',
      message: `رتبة ${name} تابعة لبوت أو اشتراك (Managed) وما ينفع تنعطى يدوياً، اختر رتبة ثانية`,
    };
  }
  if (!bot.hasManageRoles) {
    return {
      ok: false,
      code: 'missing_manage_roles',
      message: `البوت ما عنده صلاحية ${PERMISSION_NAMES_AR.ManageRoles}، فعّلها لرتبة البوت عشان يقدر يعطي رتبة ${name}`,
    };
  }
  if (!bot.highestRole || compareRolePositions(bot.highestRole, role) <= 0) {
    return {
      ok: false,
      code: 'role_above_bot',
      message: `رتبة البوت لازم تكون فوق رتبة ${name} — من إعدادات السيرفر ← الرتب، اسحب رتبة البوت فوقها`,
    };
  }
  return { ok: true };
}

/** True when the bot can assign the role (used for the dashboard role picker). */
export function isAssignable(input: RoleAssignInput): boolean {
  return decideRoleAssignability(input).ok;
}
