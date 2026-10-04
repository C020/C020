import type { AuditEntry, AuditLevel } from '../api/types';

export type AuditCategory = 'live' | 'content' | 'streamer' | 'settings' | 'roles' | 'discord' | 'provider' | 'tools' | 'system';

export const AUDIT_CATEGORY_LABELS: Record<AuditCategory, string> = {
  live: 'بث',
  content: 'مقاطع',
  streamer: 'ستريمرز',
  settings: 'إعدادات',
  roles: 'رتب',
  discord: 'ديسكورد',
  provider: 'منصات',
  tools: 'أدوات',
  system: 'النظام',
};

export const AUDIT_LEVEL_LABELS: Record<AuditLevel, string> = {
  info: 'معلومة',
  warn: 'تنبيه',
  error: 'خطأ',
};

/** Groups audit actions ("live.start", "account.add", "role.add", "discord.role.deleted"...) for icons and filters. */
export function auditCategory(action: string): AuditCategory {
  const prefix = action.split('.', 1)[0] ?? '';
  switch (prefix) {
    case 'live':
      return 'live';
    case 'content':
      return 'content';
    case 'streamer':
    case 'account':
    case 'channel':
      return 'streamer';
    case 'settings':
      return 'settings';
    case 'role': // per-member grants/removals: role.add, role.remove
    case 'roles':
      return 'roles';
    case 'discord':
      return action === 'discord.roles' ? 'roles' : 'discord';
    case 'provider':
      return 'provider';
    case 'tools':
      return 'tools';
    default:
      return 'system';
  }
}

/** Discord user id of a "user:<id>" actor. */
export function actorUserId(actor: string): string | null {
  const m = /^user:(\d+)$/.exec(actor);
  return m?.[1] ?? null;
}

export function actorLabel(actor: string, currentUserId?: string | null): string {
  const userId = actorUserId(actor);
  if (userId) return userId === currentUserId ? 'أنت' : `مشرف ${userId.slice(-4)}…`;
  if (actor === 'system' || actor === '') return 'النظام';
  if (actor === 'monitor') return 'المراقب';
  if (actor === 'bot') return 'البوت';
  return actor;
}

/** Actions after which the streamer list may have changed (e.g. edits from slash commands). */
export function touchesStreamers(entry: Pick<AuditEntry, 'action'>): boolean {
  return /^(streamer|account|channel)\./.test(entry.action);
}

export function touchesSettings(entry: Pick<AuditEntry, 'action'>): boolean {
  return entry.action === 'settings.update';
}

/** Discord-side changes that affect diagnostics or the role/channel pickers. */
export function touchesDiscordLookups(entry: Pick<AuditEntry, 'action'>): boolean {
  return entry.action.startsWith('discord.') || entry.action.startsWith('roles.');
}
