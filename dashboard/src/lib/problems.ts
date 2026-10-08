import { t } from '../i18n/core';

/** Maps diagnostics problem codes (see src/discord/diagnostics.ts) to the action that fixes them. */
export type ProblemFix =
  | { kind: 'settings'; section: SettingsSection; label: string }
  | { kind: 'invite'; label: string }
  | { kind: 'external'; href: string; label: string }
  | { kind: 'system'; label: string }
  | { kind: 'retry'; label: string };

export type SettingsSection = 'roles' | 'channels' | 'ping' | 'platforms';

export function problemFix(code: string): ProblemFix | null {
  if (code === 'bot_not_in_guild') return { kind: 'invite', label: t('problems.fix.invite') };
  if (code === 'missing_manage_roles') return { kind: 'invite', label: t('problems.fix.reinvite') };
  if (code === 'members_intent') return { kind: 'external', href: 'https://discord.com/developers/applications', label: t('problems.fix.portal') };
  if (code === 'discord_not_ready' || code === 'discord_unavailable') return { kind: 'retry', label: t('problems.fix.retry') };
  if (code.startsWith('provider_')) return { kind: 'system', label: t('problems.fix.system') };
  if (code.startsWith('ping_')) return { kind: 'settings', section: 'ping', label: t('problems.fix.ping') };
  if (/^(streamer|live)_role_|^(streamer|live)_|^same_roles$/.test(code) && !code.includes('channel')) {
    return { kind: 'settings', section: 'roles', label: t('problems.fix.roles') };
  }
  if (code.includes('_channel_')) return { kind: 'settings', section: 'channels', label: t('problems.fix.channels') };
  return null;
}

/** Extra guidance shown under some problems (beyond the server's message). */
export function problemHint(code: string): string | null {
  if (code.endsWith('role_above_bot')) return t('problems.hint.roleAboveBot');
  if (code === 'missing_manage_roles') return t('problems.hint.manageRoles');
  if (code.endsWith('channel_no_permission')) return t('problems.hint.channelPerms');
  return null;
}
