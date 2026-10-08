/**
 * #16 — English versions of web-generated error messages. The API answers in Arabic by default; when the dashboard
 * sends header "x-ui-lang: en", the error handler swaps in the English text when one is known here (messages from
 * other layers without a translation stay Arabic, as documented in src/shared/api.ts).
 */
import type { FastifyRequest } from 'fastify';
import type { Language } from '../db/features.js';

export const UI_LANG_HEADER = 'x-ui-lang';

export function requestLanguage(request: Pick<FastifyRequest, 'headers'>): Language {
  const raw = request.headers[UI_LANG_HEADER];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim().toLowerCase();
  return value === 'en' || value?.startsWith('en-') ? 'en' : 'ar';
}

/** Exact Arabic → English messages. */
const EXACT: Record<string, string> = {
  // auth / generic
  'سجّل دخولك أول عشان تقدر تستخدم لوحة التحكم': 'Log in first to use the dashboard',
  'ما عندك صلاحية على هذا السيرفر': 'You do not have access to this server',
  'المطلوب غير موجود': 'Not found',
  'المسار غير موجود': 'Route not found',
  'البوت يتصل بديسكورد الحين، جرّب بعد لحظات': 'The bot is connecting to Discord, try again in a moment',
  'انتهت صلاحية الصفحة، حدّثها وجرّب مرة ثانية': 'This page expired, refresh it and try again',
  'ما عندك صلاحية على هذا السيرفر (لازم تكون صاحب السيرفر أو عندك Manage Server)':
    'You do not have access to this server (you must be the owner or have Manage Server)',
  'البوت مو موجود في هذا السيرفر، ادعه أول': 'The bot is not in this server, invite it first',
  'هذي الميزة لمشرفي السيرفرات اللي فيها البوت (صاحب السيرفر أو عنده Manage Server)':
    'This feature is for managers of servers the bot is in (owner or Manage Server)',
  'حجم الطلب أكبر من المسموح': 'The request is too large',
  'نوع البيانات غير مدعوم، أرسل JSON': 'Unsupported content type, send JSON',
  'طلبات كثيرة، هدّ شوي وجرّب بعد دقيقة': 'Too many requests, slow down and try again in a minute',
  'الطلب غير صالح': 'Invalid request',
  'صار خطأ غير متوقع، جرّب مرة ثانية': 'Something went wrong, please try again',
  'الحساب غير موجود على المنصة': 'The account does not exist on the platform',
  'فاتح اللوحة في صفحات كثيرة، سكّر بعضها وحدّث الصفحة': 'The dashboard is open in too many tabs, close some and refresh',
  'السيرفر مشغول الحين، حدّث الصفحة بعد شوي': 'The server is busy, refresh the page shortly',
  // validation (schemas)
  'البيانات غير صحيحة': 'Invalid data',
  'هذا الحقل مطلوب': 'This field is required',
  'نوع القيمة غير صحيح': 'Invalid value type',
  'القيمة غير مسموحة': 'Value not allowed',
  'الصيغة غير صحيحة': 'Invalid format',
  'قيمة غير صحيحة': 'Invalid value',
  'الآيدي غير صحيح، لازم يكون رقم من 17 إلى 20 خانة': 'Invalid ID, it must be a number of 17 to 20 digits',
  'المنصة غير معروفة': 'Unknown platform',
  'نوع المقطع غير معروف': 'Unknown content type',
  'اللون لازم يكون رقم صحيح': 'The color must be an integer',
  'اللون غير صحيح': 'Invalid color',
  'نوع المنشن غير معروف': 'Unknown ping mode',
  'رقم الستريمر غير صحيح': 'Invalid streamer number',
  'رقم الحساب غير صحيح': 'Invalid account number',
  'رقم الطلب غير صحيح': 'Invalid application number',
  'رقم البث غير صحيح': 'Invalid session number',
  'اكتب اسم الستريمر': 'Enter the streamer name',
  'نوع الرسالة غير معروف': 'Unknown message type',
  'اللغة غير معروفة': 'Unknown language',
  'المنطقة الزمنية غير صحيحة (مثال: Asia/Riyadh)': 'Invalid timezone (example: Asia/Riyadh)',
  'اسم روم العداد لازم يحتوي {count}': 'The counter channel name must contain {count}',
  'نوع اللوحة غير معروف': 'Unknown panel type',
  'المدة لازم تكون 7 أو 30 أو 90 أو 365 يوم': 'The period must be 7, 30, 90 or 365 days',
  'الرابط غير صحيح': 'Invalid URL',
  'حالة الطلب غير معروفة': 'Unknown application status',
  'نوع الكليبات غير معروف': 'Unknown clip mode',
  'نطاق الكشف غير معروف': 'Unknown detection scope',
  // settings rules
  'ما ينفع تختار رتبة @everyone': 'You cannot pick the @everyone role',
  'رتبة الستريمر ورتبة البث المباشر لازم يكونون رتبتين مختلفتين': 'The streamer role and the live role must be different roles',
  'اختر الرتبة اللي ينمنشن مع الإشعار': 'Pick the role to mention with notifications',
  'هذي الرتبة مو موجودة في السيرفر': 'This role does not exist in the server',
  'هذا الروم مو موجود في السيرفر أو مو روم كتابي يقدر البوت يشوفه': 'This channel does not exist in the server or is not a text channel the bot can see',
  'رتبة الإشعارات لازم تكون مختلفة عن رتبة الستريمر ورتبة البث المباشر': 'The notification role must differ from the streamer role and the live role',
  'تغيير رتبة الستريمر أو رتبة البث المباشر يحتاج صلاحية Manage Roles (أو Administrator أو تكون صاحب السيرفر)، لأن البوت يعطي هذي الرتب ويشيلها تلقائياً':
    'Changing the streamer or live role needs Manage Roles (or Administrator, or being the owner), because the bot gives and removes these roles automatically',
  'تغيير رتبة الإشعارات يحتاج صلاحية Manage Roles (أو Administrator أو تكون صاحب السيرفر)، لأن الأعضاء ياخذونها من البوت بزر':
    'Changing the notification role needs Manage Roles (or Administrator, or being the owner), because members get it from the bot with a button',
  // tools
  'ديسكورد رفض رسالة التجربة، تأكد إن البوت يقدر يرسل ويضيف روابط في الروم':
    'Discord rejected the test message, make sure the bot can send messages and embed links in the channel',
  'ما قدرنا نرسل رسالة التجربة: تأكد إنك محدد الروم في الإعدادات وإن البوت يقدر يشوفه ويرسل فيه':
    'Could not send the test message: make sure the channel is set in the settings and the bot can see it and send there',
  'ما قدرنا نزامن الرتب، تأكد إن عند البوت صلاحية Manage Roles وإن رتبته فوق الرتب':
    'Could not sync roles, make sure the bot has Manage Roles and its role is above the roles',
  'ما قدرنا نجهّز المعاينة الحين، جرّب بعد شوي': 'Could not render the preview right now, try again shortly',
  'ما قدرنا نجيب الرتب والرومات من ديسكورد الحين، جرّب بعد شوي': 'Could not load roles and channels from Discord right now, try again shortly',
  'هذا العضو مو موجود في السيرفر': 'This member is not in the server',
  'ما قدرنا نجيب بيانات العضو من ديسكورد الحين، جرّب بعد شوي': 'Could not load the member from Discord right now, try again shortly',
  'الستريمر غير موجود': 'Streamer not found',
  'الحساب غير موجود': 'Account not found',
  // v2
  'الطلب غير موجود': 'Application not found',
  'البث غير موجود': 'Session not found',
  'هذا العضو ما عنده ربط رسمي على هذي المنصة': 'This member has no official link on this platform',
  'ربط الحسابات غير متاح في البوت حالياً': 'Account linking is not available on the bot',
  'النشر اليدوي مقفل في هذا السيرفر، فعّله من الإعدادات أول': 'Manual posting is disabled in this server, enable it in the settings first',
  'نشر ملخص الكليبات غير متاح حالياً': 'Posting the clip digest is not available right now',
  'ما قدرنا ننشر اللوحة، تأكد إن الروم محدد وإن البوت يقدر يرسل فيه': 'Could not post the panel, make sure the channel is set and the bot can send there',
  'ما قدرنا ننشر المقطع، تأكد إن روم المقاطع محدد وإن البوت يقدر يرسل فيه':
    'Could not post the clip, make sure the content channel is set and the bot can send there',
  'ما قدرنا ننشر ملخص الكليبات الحين، جرّب بعد شوي': 'Could not post the clip digest right now, try again shortly',
  'ما قدرنا نفحص الرابط الحين، جرّب بعد شوي': 'Could not inspect the link right now, try again shortly',
  'ما قدرنا نكمّل الطلب الحين، جرّب بعد شوي': 'Could not complete the request right now, try again shortly',
  'قبول الطلبات يحتاج صلاحية Manage Roles (أو Administrator أو تكون صاحب السيرفر)، لأن البوت بيعطي المقبول رتبة الستريمر':
    'Approving applications needs Manage Roles (or Administrator, or being the owner), because the bot gives the approved member the streamer role',
  'الإحصائيات غير متاحة الحين، جرّب بعد شوي': 'Statistics are not available right now, try again shortly',
};

/** Arabic patterns with numbers/names inside → English. */
const PATTERNS: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/^النص طويل، الحد (\d+) حرف$/, (m) => `Text too long, the limit is ${m[1]} characters`],
  [/^النص قصير، أقل شي (\d+) حرف$/, (m) => `Text too short, at least ${m[1]} characters`],
  [/^الحد الأقصى (\d+) عنصر$/, (m) => `At most ${m[1]} items`],
  [/^لازم تختار (\d+) على الأقل$/, (m) => `Pick at least ${m[1]}`],
  [/^القيمة لازم تكون (-?[\d.]+) أو أقل$/, (m) => `The value must be ${m[1]} or less`],
  [/^القيمة لازم تكون (-?[\d.]+) أو أكثر$/, (m) => `The value must be ${m[1]} or more`],
  [/^طلبات كثيرة، هدّ شوي وجرّب بعد (\d+) ثانية$/, (m) => `Too many requests, try again in ${m[1]} seconds`],
  [/^تحققت من حسابات كثيرة، هدّ شوي وجرّب بعد (\d+) ثانية$/, (m) => `You checked many accounts, try again in ${m[1]} seconds`],
  [/^(\S+) طالبة نهدّي شوي، جرّب بعد (\d+) ثانية$/, (m) => `${m[1]} asked us to slow down, try again in ${m[2]} seconds`],
  [/^(\S+) ما ردّت الحين، جرّب بعد شوي$/, (m) => `${m[1]} did not respond, try again shortly`],
  [/^منصة (\S+) مو مفعّلة أو مفاتيحها مرفوضة: تأكد من (.+) في ملف الإعدادات \(\.env\) وأعد تشغيل البوت$/,
    (m) => `${m[1]} is not enabled or its keys were rejected: check ${m[2]!.replace(/ و /g, ' and ')} in the .env file and restart the bot`],
  [/^منصة (\S+) مو مفعّلة في البوت، راجع إعدادات البوت$/, (m) => `${m[1]} is not enabled on the bot, check the bot settings`],
  [/^الرتبة "(.+)" تابعة لبوت أو تكامل، وديسكورد ما يسمح للبوت يعطيها لأحد$/,
    (m) => `The role "${m[1]}" belongs to a bot or integration, and Discord does not let the bot give it to anyone`],
  [/^الرتبة "(.+)" فيها صلاحيات إدارية .*$/,
    (m) => `The role "${m[1]}" has moderation/admin permissions (like Administrator, Manage Roles or Ban Members) and the bot hands it out automatically. Pick a role without admin permissions`],
  [/^الرتبة "(.+)" أعلى من رتبة البوت أو ما يقدر البوت يعطيها، انقل رتبة البوت فوقها$/,
    (m) => `The bot cannot assign the role "${m[1]}" (it is above the bot's role), move the bot's role above it`],
];

/** English text for a known Arabic message, or null. */
export function translateMessage(message: string): string | null {
  const exact = EXACT[message];
  if (exact) return exact;
  for (const [re, fn] of PATTERNS) {
    const m = message.match(re);
    if (m) return fn(m);
  }
  return null;
}

/** Message in the requested language (falls back to the Arabic original). */
export function localizeMessage(message: string, lang: Language): string {
  if (lang !== 'en') return message;
  return translateMessage(message) ?? message;
}
