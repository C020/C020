/**
 * #16 — dictionary for the notification messages (live / summary / content / digest / presence posts, test marker,
 * log channel) and the admin-facing delivery warnings of the notifier. Arabic is the default language.
 */
import type { ContentKind } from '../../core/types.js';
import type { GuildSettings } from '../../db/models.js';
import type { PermissionName } from '../permissions.js';
import { defineMessages, type Language } from './index.js';

export type { Language };

export const NOTIFICATION_MESSAGES = {
  // ── live ──
  'live.viewers': { ar: '{count} مشاهد', en: '{count} viewers' },
  'live.viewer': { ar: '{count} مشاهد', en: '{count} viewer' },
  'live.now': { ar: 'مباشر الحين', en: 'Live now' },
  'live.total': { ar: 'المجموع', en: 'Total' },
  'live.started': { ar: 'بدأ', en: 'Started' },
  'live.watchOn': { ar: 'شاهد على {platform}', en: 'Watch on {platform}' },
  'live.watchOnChannel': { ar: 'شاهد على {platform} ({channel})', en: 'Watch on {platform} ({channel})' },

  // ── summary ──
  'summary.duration': { ar: 'المدة', en: 'Duration' },
  'summary.peak': { ar: 'أعلى مشاهدين', en: 'Peak viewers' },
  'summary.average': { ar: 'متوسط المشاهدين', en: 'Average viewers' },
  'summary.games': { ar: 'الألعاب', en: 'Games' },
  'summary.platforms': { ar: 'المنصات', en: 'Platforms' },
  'summary.time': { ar: 'الوقت', en: 'Time' },
  'summary.timeRange': { ar: 'من {start} إلى {end}', en: 'From {start} to {end}' },
  'summary.moreGames': { ar: 'و {count} غيرها', en: 'and {count} more' },
  'summary.peakShort': { ar: 'أعلى {count}', en: 'peak {count}' },
  'summary.replayOn': { ar: 'الإعادة على {platform}', en: 'Replay on {platform}' },
  'summary.replays': { ar: 'إعادات {platform}', en: '{platform} replays' },
  'summary.channelOn': { ar: 'قناة {platform}', en: '{platform} channel' },

  // ── minimal "stream ended" card ──
  'ended.title': { ar: 'انتهى البث', en: 'Stream ended' },
  'ended.duration': { ar: 'المدة: {duration}', en: 'Duration: {duration}' },

  // ── content ──
  'content.duration': { ar: 'المدة', en: 'Duration' },
  'content.views': { ar: 'المشاهدات', en: 'Views' },
  'content.published': { ar: 'نُشر', en: 'Published' },
  'content.watch': { ar: 'شاهد', en: 'Watch' },
  'content.channel': { ar: 'القناة', en: 'Channel' },

  // ── #6 daily clip digest ──
  'digest.title': { ar: 'أفضل كليبات اليوم', en: "Today's top clips" },
  'digest.more': { ar: '… و {count} كليب ثاني', en: '… and {count} more' },
  'digest.footer.one': { ar: 'كليب واحد', en: '1 clip' },
  'digest.footer.all': { ar: '{count} كليب', en: '{count} clips' },
  'digest.footer.capped': { ar: 'أفضل {shown} من {total} كليب', en: 'Top {shown} of {total} clips' },

  // ── #15 presence-only streams ──
  'presence.footer': { ar: 'من حالة ديسكورد', en: 'From Discord status' },
  'presence.watch': { ar: 'شاهد البث', en: 'Watch the stream' },
  'presence.platform': { ar: 'المنصة', en: 'Platform' },
  'presence.game': { ar: 'اللعبة', en: 'Game' },
  'presence.channel': { ar: 'القناة', en: 'Channel' },

  // ── test messages / log channel ──
  'test.marker': {
    ar: '🧪 **رسالة تجريبية** — بيانات وهمية عشان تشوف شكل الإشعار',
    en: '🧪 **Test message** — sample data so you can see how the notification looks',
  },
  'log.footer': { ar: 'سجل البوت', en: 'Bot log' },

  // ── admin-facing delivery warnings (audit log + log channel) ──
  'purpose.live': { ar: 'إشعارات البث', en: 'live notifications' },
  'purpose.content': { ar: 'إشعارات المقاطع', en: 'content notifications' },
  'purpose.log': { ar: 'اللوق', en: 'log' },
  'fail.forbiddenMissing': {
    ar: 'البوت ما يقدر يرسل في روم {label} ({where}) — ناقصه صلاحيات: {perms}',
    en: "The bot can't post in the {label} channel ({where}) — missing permissions: {perms}",
  },
  'fail.forbidden': {
    ar: 'البوت ما عنده صلاحية في روم {label} ({where}) — تأكد إنه يقدر يشوف الروم ويرسل رسائل ويضمّن روابط (View Channel, Send Messages, Embed Links)',
    en: 'The bot has no access to the {label} channel ({where}) — make sure it can view the channel, send messages and embed links (View Channel, Send Messages, Embed Links)',
  },
  'fail.channelMissing': {
    ar: 'روم {label} المحدد ({id}) غير موجود أو البوت ما يشوفه — يمكن انحذف، حدّثه من لوحة التحكم',
    en: "The selected {label} channel ({id}) doesn't exist or the bot can't see it — it may have been deleted; update it in the dashboard",
  },
  'fail.wrongGuild': {
    ar: 'روم {label} المحدد ({id}) تابع لسيرفر ثاني — اختر روم من هذا السيرفر',
    en: 'The selected {label} channel ({id}) belongs to another server — pick a channel from this server',
  },
  'fail.notText': {
    ar: 'روم {label} المحدد ({where}) مو روم كتابي — اختر روم نصي أو روم إعلانات',
    en: 'The selected {label} channel ({where}) is not a text channel — pick a text or announcement channel',
  },
  'fail.invalid': {
    ar: 'ديسكورد رفض رسالة {label} — راجع قالب الرسالة (روابط أو نصوص غير صالحة)',
    en: 'Discord rejected a {label} message — check the message template (invalid links or text)',
  },
  'fail.error': {
    ar: 'تعذّر إيصال رسالة {label} ({where}) لديسكورد — غالباً خلل مؤقت في ديسكورد أو الشبكة',
    en: "Couldn't deliver a {label} message ({where}) to Discord — most likely a temporary Discord or network problem",
  },
  'fail.attachFiles': {
    ar: 'البوت ما عنده صلاحية {perms} في روم {label} ({where}) — أرسلنا الصورة كرابط، وصور تيك توك تنتهي صلاحيتها وتختفي بعد فترة',
    en: 'The bot lacks {perms} in the {label} channel ({where}) — the image was sent as a link instead; TikTok images expire and disappear after a while',
  },
  'route.fallback': {
    ar: 'توجيه {scope}: {problem} — أرسلنا الإشعار في الروم الافتراضي ({fallback}) بدلاً منه',
    en: 'Routing for {scope}: {problem} — the notification was sent to the default channel ({fallback}) instead',
  },
  'route.scopeDigest': { ar: 'ملخص الكليبات', en: 'the clip digest' },
} as const;

/** Translator for the notification dictionary: tm(lang, key, vars). */
export const tm = defineMessages(NOTIFICATION_MESSAGES);

export const CONTENT_KIND_LABELS: Readonly<Record<Language, Readonly<Record<ContentKind, string>>>> = Object.freeze({
  ar: Object.freeze({ video: 'فيديو', short: 'شورتس', vod: 'تسجيل بث', highlight: 'هايلايت', clip: 'كليب' }),
  en: Object.freeze({ video: 'video', short: 'Short', vod: 'VOD', highlight: 'highlight', clip: 'clip' }),
});

const KIND_FALLBACK: Record<Language, string> = { ar: 'مقطع', en: 'video' };

export function contentKindLabel(kind: string, lang: Language): string {
  return (CONTENT_KIND_LABELS[lang] as Record<string, string | undefined>)[kind] ?? KIND_FALLBACK[lang];
}

/** English permission names used in delivery warnings (unknown names are spelled out from their key). */
export const PERMISSION_NAMES_EN: Readonly<Partial<Record<PermissionName, string>>> = Object.freeze({
  ViewChannel: 'View Channel',
  SendMessages: 'Send Messages',
  SendMessagesInThreads: 'Send Messages in Threads',
  EmbedLinks: 'Embed Links',
  AttachFiles: 'Attach Files',
  ReadMessageHistory: 'Read Message History',
  ManageRoles: 'Manage Roles',
  MentionEveryone: 'Mention @everyone',
});

export function permissionNameEn(name: PermissionName): string {
  return PERMISSION_NAMES_EN[name] ?? String(name).replace(/([a-z])([A-Z])/g, '$1 $2');
}

/** Language of a guild's bot messages; defensive about settings objects that predate `features`. */
export function langOf(settings: Pick<GuildSettings, 'features'> | null | undefined): Language {
  return settings?.features?.language === 'en' ? 'en' : 'ar';
}

/** "A، B و C" (Arabic) / "A, B and C" (English). */
export function joinList(items: string[], lang: Language): string {
  const list = items.filter(Boolean);
  if (list.length <= 1) return list[0] ?? '';
  const last = list[list.length - 1];
  return lang === 'en' ? `${list.slice(0, -1).join(', ')} and ${last}` : `${list.slice(0, -1).join('، ')} و ${last}`;
}

/** "1,234 مشاهد" / "1,234 viewers" (singular in English for exactly one viewer). */
export function viewersText(lang: Language, formatted: string, count: number): string {
  return tm(lang, count === 1 ? 'live.viewer' : 'live.viewers', { count: formatted });
}
