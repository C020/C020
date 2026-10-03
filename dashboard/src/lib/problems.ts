/** Maps diagnostics problem codes (see src/discord/diagnostics.ts) to the action that fixes them. */
export type ProblemFix =
  | { kind: 'settings'; section: SettingsSection; label: string }
  | { kind: 'invite'; label: string }
  | { kind: 'external'; href: string; label: string }
  | { kind: 'system'; label: string }
  | { kind: 'retry'; label: string };

export type SettingsSection = 'roles' | 'channels' | 'ping' | 'platforms';

export function problemFix(code: string): ProblemFix | null {
  if (code === 'bot_not_in_guild') return { kind: 'invite', label: 'دعوة البوت' };
  if (code === 'missing_manage_roles') return { kind: 'invite', label: 'إعادة دعوة البوت بالصلاحيات' };
  if (code === 'members_intent') return { kind: 'external', href: 'https://discord.com/developers/applications', label: 'فتح Developer Portal' };
  if (code === 'discord_not_ready' || code === 'discord_unavailable') return { kind: 'retry', label: 'إعادة الفحص' };
  if (code.startsWith('provider_')) return { kind: 'system', label: 'حالة المنصات' };
  if (code.startsWith('ping_')) return { kind: 'settings', section: 'ping', label: 'إعدادات المنشن' };
  if (/^(streamer|live)_role_|^(streamer|live)_|^same_roles$/.test(code) && !code.includes('channel')) {
    return { kind: 'settings', section: 'roles', label: 'ضبط الرتب' };
  }
  if (code.includes('_channel_')) return { kind: 'settings', section: 'channels', label: 'ضبط الرومات' };
  return null;
}

/** Extra guidance shown under some problems (beyond the server's message). */
export function problemHint(code: string): string | null {
  if (code.endsWith('role_above_bot')) return 'من إعدادات السيرفر ← الرتب: اسحب رتبة البوت فوق رتبة الستريمر ورتبة البث.';
  if (code === 'missing_manage_roles') return 'أو من إعدادات السيرفر ← الرتب ← رتبة البوت: فعّل صلاحية Manage Roles.';
  if (code.endsWith('channel_no_permission')) return 'من إعدادات الروم ← الصلاحيات: اسمح للبوت بـ View Channel و Send Messages و Embed Links.';
  return null;
}
