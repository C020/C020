/**
 * Guild setup diagnostics (pure): turns a snapshot of Discord facts plus the guild settings into a list of
 * actionable Arabic problems for the dashboard and `/bot status`.
 */
import type { GuildSettings } from '../db/models.js';
import type { GuildDiagnostics } from '../services/ports.js';
import { decideRoleAssignability, type PermissionName, permissionListAr, type RolePosition } from './permissions.js';

export interface RoleFact extends RolePosition {
  name: string;
  managed: boolean;
  mentionable: boolean;
}

export interface ChannelFact {
  id: string;
  name: string;
  /** Text or announcement channel (or a thread) the bot could post in. */
  textBased: boolean;
  /** Posting permissions the bot lacks there. */
  missing: PermissionName[];
}

export interface GuildFacts {
  guildId: string;
  /** Gateway connected and ready. */
  ready: boolean;
  /** False when the bot is not a member of the guild. */
  inGuild: boolean;
  bot: {
    hasManageRoles: boolean;
    hasMentionEveryone: boolean;
    highestRole: RolePosition | null;
  } | null;
  roles: ReadonlyMap<string, RoleFact>;
  channels: ReadonlyMap<string, ChannelFact>;
  /** Result of the last full member list fetch (false = timed out, i.e. the members intent is off). */
  membersIntentOk: boolean | null;
}

type Problem = GuildDiagnostics['problems'][number];

const ROLE_LABELS = { streamer: 'Streamer', live: 'Streaming Now' } as const;
const CHANNEL_LABELS = { live: 'إشعارات البث', content: 'إشعارات المقاطع', log: 'اللوق' } as const;

function checkRole(facts: GuildFacts, kind: keyof typeof ROLE_LABELS, roleId: string | null, required: boolean, out: Problem[]): void {
  const label = ROLE_LABELS[kind];
  if (!roleId) {
    if (required) out.push({ code: `${kind}_role_unset`, level: 'warn', message: `ما حددت رتبة ${label} — حددها من الإعدادات عشان البوت يعطيها تلقائياً` });
    return;
  }
  const role = facts.roles.get(roleId);
  if (!role) {
    out.push({ code: `${kind}_role_not_found`, level: 'error', message: `رتبة ${label} المحددة (${roleId}) غير موجودة في السيرفر — يمكن انحذفت، حدّثها من الإعدادات` });
    return;
  }
  if (!facts.bot) return;
  // Missing Manage Roles is reported once for the whole guild; evaluate the hierarchy as if it were granted
  // so the admin sees every problem in one go.
  const decision = decideRoleAssignability({ guildId: facts.guildId, role, bot: { ...facts.bot, hasManageRoles: true } });
  if (!decision.ok) {
    out.push({ code: `${kind}_${decision.code}`, level: 'error', message: decision.message });
  }
}

function checkChannel(facts: GuildFacts, kind: keyof typeof CHANNEL_LABELS, channelId: string | null, out: Problem[]): void {
  const label = CHANNEL_LABELS[kind];
  if (!channelId) {
    if (kind === 'live') out.push({ code: 'live_channel_unset', level: 'warn', message: `ما حددت روم ${label} — البوت ما راح يرسل إشعارات البث` });
    if (kind === 'content') out.push({ code: 'content_channel_unset', level: 'warn', message: `ما حددت روم ${label} — البوت ما راح يرسل إشعارات المقاطع الجديدة` });
    return;
  }
  const level = kind === 'log' ? 'warn' : 'error';
  const channel = facts.channels.get(channelId);
  if (!channel) {
    out.push({ code: `${kind}_channel_not_found`, level, message: `روم ${label} المحدد (${channelId}) غير موجود في السيرفر — يمكن انحذف، حدّثه من الإعدادات` });
    return;
  }
  if (!channel.textBased) {
    out.push({ code: `${kind}_channel_not_text`, level, message: `روم ${label} (#${channel.name}) مو روم كتابي، اختر روم نصي أو روم إعلانات` });
    return;
  }
  if (channel.missing.length > 0) {
    out.push({
      code: `${kind}_channel_no_permission`,
      level,
      message: `البوت ما يقدر يرسل في روم ${label} (#${channel.name}) — ناقصه: ${permissionListAr(channel.missing)}`,
    });
  }
}

function checkPing(facts: GuildFacts, settings: GuildSettings, out: Problem[]): void {
  if (settings.pingMode === 'none') return;
  const canMentionEveryone = facts.bot?.hasMentionEveryone ?? true;
  if (settings.pingMode === 'everyone' || settings.pingMode === 'here') {
    if (!canMentionEveryone) {
      out.push({
        code: 'ping_no_permission',
        level: 'warn',
        message: `المنشن مضبوط على @${settings.pingMode} بس البوت ما عنده صلاحية منشن الجميع (Mention @everyone)، المنشن ما راح يوصل`,
      });
    }
    return;
  }
  if (!settings.pingRoleId) {
    out.push({ code: 'ping_role_unset', level: 'warn', message: 'المنشن مضبوط على رتبة بس ما حددت الرتبة' });
    return;
  }
  const role = facts.roles.get(settings.pingRoleId);
  if (!role) {
    out.push({ code: 'ping_role_not_found', level: 'warn', message: `رتبة المنشن (${settings.pingRoleId}) غير موجودة في السيرفر` });
  } else if (!role.mentionable && !canMentionEveryone) {
    out.push({
      code: 'ping_role_not_mentionable',
      level: 'warn',
      message: `رتبة المنشن ${role.name} مقفول منشنها والبوت ما عنده صلاحية Mention @everyone — فعّل "Allow anyone to @mention this role" للرتبة`,
    });
  }
}

export function diagnoseGuild(facts: GuildFacts, settings: GuildSettings): GuildDiagnostics {
  const problems: Problem[] = [];
  const result = (botHasManageRoles: boolean): GuildDiagnostics => ({ guildId: facts.guildId, botInGuild: facts.inGuild, botHasManageRoles, problems });

  if (!facts.ready) {
    problems.push({ code: 'discord_not_ready', level: 'error', message: 'البوت غير متصل بديسكورد حالياً — تأكد من التوكن وإن البوت شغال' });
    return result(false);
  }
  if (!facts.inGuild) {
    problems.push({ code: 'bot_not_in_guild', level: 'error', message: 'البوت مو موجود في هذا السيرفر — ادعه من رابط الدعوة في لوحة التحكم' });
    return result(false);
  }

  const hasManageRoles = facts.bot?.hasManageRoles ?? false;
  if (facts.bot && !hasManageRoles) {
    problems.push({
      code: 'missing_manage_roles',
      level: 'error',
      message: 'البوت ما عنده صلاحية إدارة الرتب (Manage Roles) — بدونها ما يقدر يعطي رتبة Streamer و Streaming Now',
    });
  }

  checkRole(facts, 'streamer', settings.streamerRoleId, settings.options.autoStreamerRole, problems);
  checkRole(facts, 'live', settings.liveRoleId, true, problems);
  if (settings.streamerRoleId && settings.streamerRoleId === settings.liveRoleId) {
    problems.push({
      code: 'same_roles',
      level: 'warn',
      message: 'رتبة Streamer ورتبة Streaming Now نفس الرتبة — البوت بيشيلها من الستريمر أول ما يخلص بثه، استخدم رتبتين مختلفتين',
    });
  }

  checkChannel(facts, 'live', settings.liveChannelId, problems);
  checkChannel(facts, 'content', settings.contentChannelId, problems);
  checkChannel(facts, 'log', settings.logChannelId, problems);
  checkPing(facts, settings, problems);

  if (facts.membersIntentOk === false) {
    problems.push({
      code: 'members_intent',
      level: 'warn',
      message:
        'البوت ما قدر يجيب قائمة الأعضاء — فعّل "Server Members Intent" من Discord Developer Portal ← Bot ← Privileged Gateway Intents ثم أعد تشغيل البوت',
    });
  }
  return result(hasManageRoles);
}
