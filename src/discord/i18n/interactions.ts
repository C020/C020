/**
 * #16 — Arabic/English texts of the interactive Discord layer: slash command replies, panels (notification role,
 * streamer applications), button/modal flows, the application review message, setup diagnostics and permission
 * hints. Everything a member or admin reads in Discord follows the guild's `features.language`.
 *
 * Audit-log messages stay Arabic (the dashboard log is Arabic by convention) and are not in here.
 */
import type { ContentKind } from '../../core/types.js';
import type { GuildSettings, Language } from '../../db/models.js';
import { defineMessages } from './index.js';

/** Guild language with a safe fallback for settings objects that predate the features column. */
export function guildLanguage(settings: Pick<GuildSettings, 'features'> | null | undefined): Language {
  return settings?.features?.language === 'en' ? 'en' : 'ar';
}

/** Discord locales that get the English command descriptions (Discord has no Arabic locale; Arabic is the default). */
export function englishLocalizations(text: string): Record<'en-US' | 'en-GB', string> {
  return { 'en-US': text, 'en-GB': text };
}

export const CONTENT_KIND_LABELS: Record<Language, Record<ContentKind, string>> = {
  ar: { video: 'فيديو', short: 'شورتس', vod: 'تسجيل بث', highlight: 'هايلايت', clip: 'كليب' },
  en: { video: 'Video', short: 'Short', vod: 'Stream VOD', highlight: 'Highlight', clip: 'Clip' },
};

export const ti = defineMessages({
  // ───────────── common ─────────────
  'common.serverOnly': { ar: 'أوامر البوت تشتغل داخل السيرفر بس', en: 'Bot commands only work inside a server' },
  'common.starting.title': { ar: '⏳ البوت لسا يجهز', en: '⏳ The bot is still starting' },
  'common.starting.body': { ar: 'جرّب بعد ثواني', en: 'Try again in a few seconds' },
  'common.failed.title': { ar: '⚠️ ما تمت العملية', en: '⚠️ That did not work' },
  'common.genericError': {
    ar: 'صار خطأ غير متوقع، جرّب بعد شوي. لو تكررت المشكلة راجع سجل البوت في لوحة التحكم',
    en: 'Something unexpected went wrong, please try again shortly. If it keeps happening, check the bot log in the dashboard',
  },
  'common.notReady': { ar: 'البوت غير متصل بديسكورد حالياً، جرّب بعد شوي', en: 'The bot is not connected to Discord right now, try again shortly' },
  'common.unknownCommand': { ar: 'أمر غير معروف', en: 'Unknown command' },
  'common.expired': { ar: 'هذا الزر قديم وما عاد يشتغل', en: 'This button is outdated and no longer works' },
  'common.unavailable': { ar: 'هذي الميزة مو جاهزة حالياً، جرّب بعد شوي', en: 'This feature is not available right now, try again shortly' },
  'common.openMessage': { ar: 'افتح الرسالة', en: 'Open the message' },

  // ───────────── /live ─────────────
  'live.none.title': { ar: '😴 ما فيه أحد يبث الحين', en: '😴 Nobody is live right now' },
  'live.none.body': {
    ar: 'أول ما يبدأ أحد من الستريمرز بث، بينزل إشعار في روم البثوث',
    en: 'As soon as one of the streamers goes live, a notification is posted in the live channel',
  },
  'live.more': { ar: 'و {count} غيرهم يبثون الحين', en: 'and {count} more are live right now' },
  'live.title': { ar: '🔴 يبثون الحين ({count})', en: '🔴 Live now ({count})' },
  'live.totalViewers': { ar: '👥 مجموع المشاهدين: {count}', en: '👥 Total viewers: {count}' },
  'live.watchOn': { ar: 'شاهد على {platform}', en: 'Watch on {platform}' },

  // ───────────── /streamer ─────────────
  'streamer.status.paused': { ar: '⏸️ موقوف', en: '⏸️ Paused' },
  'streamer.status.live': { ar: '🔴 يبث الحين', en: '🔴 Live now' },
  'streamer.status.offline': { ar: '⚫ أوفلاين', en: '⚫ Offline' },
  'streamer.account.liveNow': { ar: '🔴 مباشر الحين', en: '🔴 Live now' },
  'streamer.account.lastCheck': { ar: 'آخر فحص {when}', en: 'Last checked {when}' },
  'streamer.account.neverChecked': { ar: 'لسا ما انفحص', en: 'Not checked yet' },
  'streamer.account.notify': { ar: '🔔 البث {live} • المقاطع {content}', en: '🔔 Live {live} • Content {content}' },
  'streamer.stats.title': { ar: '📊 آخر 30 يوم', en: '📊 Last 30 days' },
  'streamer.stats.value': { ar: '{sessions} بث • {duration} • أعلى {peak} مشاهد', en: 'Streams: {sessions} • {duration} live • peak viewers: {peak}' },
  'streamer.stats.none': { ar: 'ما بث خلال آخر 30 يوم', en: 'No streams in the last 30 days' },
  'streamer.addedOn': { ar: 'أضيف {date}', en: 'Added {date}' },
  'streamer.list.empty.title': { ar: '👥 ما فيه ستريمرز مسجلين', en: '👥 No registered streamers' },
  'streamer.list.empty.body': {
    ar: 'أضف أول ستريمر بالأمر `/streamer add` أو من لوحة التحكم',
    en: 'Add the first streamer with `/streamer add` or from the dashboard',
  },
  'streamer.list.noAccounts': { ar: 'بدون حسابات', en: 'no accounts' },
  'streamer.list.more': { ar: 'و {count} غيرهم — شوف القائمة كاملة في لوحة التحكم', en: 'and {count} more — see the full list in the dashboard' },
  'streamer.list.title': { ar: '👥 الستريمرز ({count})', en: '👥 Streamers ({count})' },
  'streamer.list.liveFooter': { ar: '🔴 يبث الحين: {count}', en: '🔴 Live now: {count}' },
  'streamer.notRegistered': { ar: 'هذا العضو مو مسجّل كستريمر', en: 'This member is not registered as a streamer' },
  'streamer.noBots': { ar: 'ما ينفع تسجّل بوت كستريمر', en: 'Bots cannot be registered as streamers' },
  'streamer.needAccount': {
    ar: 'لازم تحط حساب واحد على الأقل (twitch أو kick أو youtube أو tiktok)',
    en: 'Add at least one account (twitch, kick, youtube or tiktok)',
  },
  'streamer.created': { ar: 'تمت إضافة {name}', en: '{name} was added' },
  'streamer.alreadyRegistered': {
    ar: 'هذا العضو مسجّل كستريمر من قبل — عشان تضيف له حساب، اكتب الحساب في خيار المنصة',
    en: 'This member is already registered — to add an account, fill in the platform option',
  },
  'streamer.renamed': { ar: '✅ الاسم صار: {name}', en: '✅ Name changed to: {name}' },
  'streamer.accountAdded': { ar: '✅ {label}: تمت الإضافة', en: '✅ {label}: added' },
  'streamer.accountFailed': { ar: '❌ {label}: {error}', en: '❌ {label}: {error}' },
  'streamer.updated': { ar: '✏️ تحديث {name}', en: '✏️ Updated {name}' },
  'streamer.deleted': { ar: 'تم حذف الستريمر {name}', en: 'Streamer {name} was removed' },
  'streamer.unknownPlatform': { ar: 'المنصة غير معروفة', en: 'Unknown platform' },
  'streamer.noAccountOn': { ar: '{name} ما عنده حساب {platform} مسجّل', en: '{name} has no {platform} account registered' },
  'streamer.accountRemoved': { ar: 'تم حذف حساب {platform} من {name}', en: 'Removed the {platform} account from {name}' },
  'streamer.noAccountsLeft': {
    ar: '⚠️ ما بقى له أي حساب، فما راح توصل له إشعارات لين تضيف له حساب',
    en: '⚠️ No accounts left, so there are no notifications until you add one',
  },

  // ───────────── /bot ─────────────
  'bot.type.live': { ar: 'إشعار بث', en: 'live notification' },
  'bot.type.summary': { ar: 'ملخص بث', en: 'stream summary' },
  'bot.type.content': { ar: 'مقطع جديد', en: 'new content post' },
  'bot.status.title': { ar: '🤖 حالة البوت', en: '🤖 Bot status' },
  'bot.status.setup': { ar: '**⚙️ فحص الإعدادات**', en: '**⚙️ Setup check**' },
  'bot.status.allGood': { ar: '✅ كل شي مضبوط', en: '✅ Everything is set up' },
  'bot.status.platformOff': { ar: '{head}: متوقفة من الإعدادات', en: '{head}: disabled in the settings' },
  'bot.status.noAccounts': { ar: '{head}: ما فيه حسابات', en: '{head}: no accounts' },
  'bot.status.accounts': { ar: '{count} حساب', en: 'accounts: {count}' },
  'bot.status.live': { ar: '{count} لايف', en: 'live: {count}' },
  'bot.status.failing': { ar: '⚠️ {count} فيها أخطاء', en: '⚠️ with errors: {count}' },
  'bot.status.lastCheck': { ar: 'آخر فحص {when}', en: 'last check {when}' },
  'bot.status.unknownPing': { ar: 'غير معروف', en: 'unknown' },
  'bot.status.connection': { ar: '📡 الاتصال', en: '📡 Connection' },
  'bot.status.connected': { ar: 'متصل ✅ • البينق {ping}', en: 'Connected ✅ • ping {ping}' },
  'bot.status.since': { ar: 'شغال من {since}', en: 'Up since {since}' },
  'bot.status.streamers': { ar: '👥 الستريمرز', en: '👥 Streamers' },
  'bot.status.streamersValue': {
    ar: '{streamers} ستريمر • {accounts} حساب\n🔴 يبث الحين: {live}',
    en: 'Streamers: {streamers} • Accounts: {accounts}\n🔴 Live now: {live}',
  },
  'bot.status.platforms': { ar: '🛰️ المنصات', en: '🛰️ Platforms' },
  'bot.status.noPlatforms': { ar: 'ما فيه منصات مفعلة', en: 'No platforms enabled' },
  'bot.sync.title': { ar: 'تمت مزامنة الرتب', en: 'Roles synced' },
  'bot.sync.body': { ar: '➕ أضيفت: {added}\n➖ أزيلت: {removed}', en: '➕ Added: {added}\n➖ Removed: {removed}' },
  'bot.test.unknownType': { ar: 'نوع الرسالة غير معروف', en: 'Unknown message type' },
  'bot.test.cooldown': {
    ar: 'لحظة شوي، تقدر ترسل رسالة تجريبية ثانية بعد {seconds} ثانية',
    en: 'Hold on — you can send another test message in {seconds} seconds',
  },
  'bot.test.failed': { ar: 'ما قدرت أرسل الرسالة التجريبية، راجع `/bot status`', en: 'Could not send the test message, check `/bot status`' },
  'bot.test.sent': { ar: 'أرسلت {type} تجريبي', en: 'Sent a test {type}' },
  'bot.panel.notify': { ar: 'زر الإشعارات', en: 'notification button' },
  'bot.panel.apply': { ar: 'زر طلب ستريمر', en: 'streamer application button' },
  'bot.panel.posted': { ar: 'تم نشر رسالة {panel}', en: 'Posted the {panel} message' },
  'bot.panel.unknown': { ar: 'نوع الرسالة غير معروف', en: 'Unknown panel type' },

  // ───────────── test messages (dashboard + /bot test) ─────────────
  'test.noLiveChannel': { ar: 'حدد روم إشعارات البث أول من الإعدادات', en: 'Set the live notification channel in the settings first' },
  'test.noContentChannel': { ar: 'حدد روم إشعارات المقاطع أول من الإعدادات', en: 'Set the content notification channel in the settings first' },
  'test.failed': { ar: 'ما قدرت أرسل الرسالة التجريبية، جرّب بعد شوي', en: 'Could not send the test message, try again shortly' },
  'preview.streamerMissing': { ar: 'الستريمر غير موجود', en: 'Streamer not found' },

  // ───────────── delivery failures (panels, tests, review messages) ─────────────
  'label.live': { ar: 'إشعارات البث', en: 'live notification' },
  'label.content': { ar: 'إشعارات المقاطع', en: 'content notification' },
  'label.notifyPanel': { ar: 'رسالة رتبة الإشعارات', en: 'notification panel' },
  'label.applyPanel': { ar: 'رسالة التقديم', en: 'application panel' },
  'label.review': { ar: 'مراجعة الطلبات', en: 'application review' },
  'delivery.forbiddenMissing': {
    ar: 'البوت ما يقدر يرسل في روم {label} ({where}) — ناقصه صلاحيات: {perms}',
    en: 'The bot cannot post in the {label} channel ({where}) — missing permissions: {perms}',
  },
  'delivery.forbidden': {
    ar: 'البوت ما عنده صلاحية في روم {label} ({where}) — تأكد إنه يقدر يشوف الروم ويرسل رسائل ويضمّن روابط (View Channel, Send Messages, Embed Links)',
    en: 'The bot has no access to the {label} channel ({where}) — make sure it has View Channel, Send Messages and Embed Links there',
  },
  'delivery.missing': {
    ar: 'روم {label} المحدد ({channel}) غير موجود أو البوت ما يشوفه — يمكن انحذف، حدّثه من لوحة التحكم',
    en: 'The {label} channel ({channel}) does not exist or the bot cannot see it — it may have been deleted, update it in the dashboard',
  },
  'delivery.wrongGuild': {
    ar: 'روم {label} المحدد ({channel}) تابع لسيرفر ثاني — اختر روم من هذا السيرفر',
    en: 'The {label} channel ({channel}) belongs to another server — pick a channel from this server',
  },
  'delivery.notText': {
    ar: 'روم {label} المحدد ({where}) مو روم كتابي — اختر روم نصي أو روم إعلانات',
    en: 'The {label} channel ({where}) is not a text channel — pick a text or announcement channel',
  },
  'delivery.invalid': { ar: 'ديسكورد رفض رسالة {label} — راجع النصوص المخصصة', en: 'Discord rejected the {label} message — check the custom texts' },
  'delivery.error': {
    ar: 'تعذّر إيصال رسالة {label} ({where}) لديسكورد — غالباً خلل مؤقت، جرّب بعد شوي',
    en: 'Could not deliver the {label} message ({where}) — probably a temporary Discord problem, try again shortly',
  },

  // ───────────── panels ─────────────
  'panel.notify.title': { ar: '🔔 إشعارات البثوث', en: '🔔 Stream alerts' },
  'panel.notify.desc.live': {
    ar: 'تبي يوصلك تنبيه أول ما يبدأ أحد من الستريمرز بث؟\nاضغط الزر تحت وتاخذ رتبة {role} — واضغطه مرة ثانية لو تبي توقف التنبيهات.',
    en: 'Want a ping as soon as one of our streamers goes live?\nPress the button below to get the {role} role — press it again any time to stop.',
  },
  'panel.notify.desc.content': {
    ar: 'تبي يوصلك تنبيه أول ما ينزل مقطع جديد من الستريمرز؟\nاضغط الزر تحت وتاخذ رتبة {role} — واضغطه مرة ثانية لو تبي توقف التنبيهات.',
    en: 'Want a ping whenever our streamers post new videos or clips?\nPress the button below to get the {role} role — press it again any time to stop.',
  },
  'panel.notify.desc.both': {
    ar: 'تبي يوصلك تنبيه أول ما يبدأ أحد من الستريمرز بث أو ينزل مقطع جديد؟\nاضغط الزر تحت وتاخذ رتبة {role} — واضغطه مرة ثانية لو تبي توقف التنبيهات.',
    en: 'Want a ping when one of our streamers goes live or posts something new?\nPress the button below to get the {role} role — press it again any time to stop.',
  },
  'panel.notify.button': { ar: 'إشعارات البثوث', en: 'Stream alerts' },
  'panel.apply.title': { ar: '📝 قدّم كستريمر', en: '📝 Apply as a streamer' },
  'panel.apply.desc': {
    ar: 'تبث على تويتش أو كيك أو يوتيوب أو تيك توك؟\nاضغط الزر تحت واكتب حساباتك، والإدارة بتراجع طلبك. أول ما ينقبل تاخذ رتبة الستريمر وتنزل إشعارات بثوثك في السيرفر.',
    en: 'Do you stream on Twitch, Kick, YouTube or TikTok?\nPress the button below and enter your accounts — the team will review your application. Once approved you get the streamer role and your streams are announced here.',
  },
  'panel.apply.button': { ar: 'قدّم كستريمر', en: 'Apply as a streamer' },
  'panel.notify.noRole': { ar: 'حدد رتبة الإشعارات أول من الإعدادات', en: 'Choose the notification role in the settings first' },
  'panel.notify.noChannel': { ar: 'حدد روم رسالة الإشعارات أول من الإعدادات', en: 'Choose the channel for the notification panel in the settings first' },
  'panel.notify.roleMissing': {
    ar: 'رتبة الإشعارات المحددة غير موجودة في السيرفر — يمكن انحذفت، اختر رتبة ثانية',
    en: 'The notification role no longer exists in the server — pick another role',
  },
  'panel.notify.roleElevated': {
    ar: 'رتبة الإشعارات فيها صلاحيات إدارية، والبوت ما يعطي رتب إدارية للأعضاء — اختر رتبة عادية',
    en: 'The notification role has moderation/admin permissions and the bot never hands those out — pick an ordinary role',
  },
  'panel.notify.roleConflict': {
    ar: 'رتبة الإشعارات نفس رتبة Streamer أو Streaming Now — اختر رتبة مستقلة للإشعارات',
    en: 'The notification role is the same as the Streamer or Streaming Now role — use a separate role for notifications',
  },
  'panel.apply.disabled': { ar: 'فعّل طلبات الستريمرز أول من الإعدادات', en: 'Enable streamer applications in the settings first' },
  'panel.apply.noChannel': { ar: 'حدد روم رسالة التقديم أول من الإعدادات', en: 'Choose the channel for the application panel in the settings first' },

  // ───────────── #1 notification role toggle ─────────────
  'notify.disabled': { ar: 'رتبة الإشعارات مو مفعّلة حالياً', en: 'The notification role is not enabled right now' },
  'notify.added.title': { ar: '🔔 تم تفعيل الإشعارات', en: '🔔 Alerts on' },
  'notify.added.live': { ar: 'أخذت رتبة {role} — بيوصلك منشن أول ما يبدأ أحد من الستريمرز بث.', en: 'You got the {role} role — you will be pinged when a streamer goes live.' },
  'notify.added.content': { ar: 'أخذت رتبة {role} — بيوصلك منشن كل ما نزل مقطع جديد.', en: 'You got the {role} role — you will be pinged when new content is posted.' },
  'notify.added.both': {
    ar: 'أخذت رتبة {role} — بيوصلك منشن أول ما يبدأ أحد من الستريمرز بث أو ينزل مقطع جديد.',
    en: 'You got the {role} role — you will be pinged when a streamer goes live or posts something new.',
  },
  'notify.added.none': { ar: 'أخذت رتبة {role}.', en: 'You got the {role} role.' },
  'notify.added.hint': { ar: 'تقدر توقفها بأي وقت من نفس الزر.', en: 'Press the same button any time to turn them off.' },
  'notify.removed.title': { ar: '🔕 تم إيقاف الإشعارات', en: '🔕 Alerts off' },
  'notify.removed.body': {
    ar: 'شلنا منك رتبة {role}. تقدر ترجعها بأي وقت من نفس الزر.',
    en: 'The {role} role was removed. Press the same button any time to turn alerts back on.',
  },
  'notify.error.config': {
    ar: 'ما قدرت أعدّل رتبتك لأن إعدادات الرتبة فيها مشكلة — وصل تنبيه للإدارة، جرّب بعدين',
    en: 'I could not change your role because of a role setup problem — the admins were notified, please try later',
  },
  'notify.error.setup': {
    ar: 'رتبة الإشعارات مو مضبوطة صح حالياً — بلّغ الإدارة',
    en: 'The notification role is not set up correctly right now — please tell the admins',
  },
  'notify.error.transient': { ar: 'ديسكورد ما رد علينا الحين، جرّب بعد شوي', en: 'Discord did not respond, please try again shortly' },
  'notify.error.notMember': { ar: 'ما لقيتك في السيرفر، جرّب مرة ثانية', en: 'I could not find you in the server, please try again' },

  // ───────────── #9 applications ─────────────
  'apply.disabled': { ar: 'استقبال طلبات الستريمرز مقفل حالياً', en: 'Streamer applications are closed right now' },
  'apply.registered': { ar: 'أنت مسجّل كستريمر من قبل ✅ — ما تحتاج تقدّم', en: 'You are already registered as a streamer ✅ — no need to apply' },
  'apply.pending': {
    ar: 'طلبك السابق لسا قيد المراجعة (أرسلته {when}) — بنرد عليك أول ما تخلص المراجعة',
    en: 'Your previous application is still being reviewed (sent {when}) — you will hear back once it is reviewed',
  },
  'apply.modal.title': { ar: 'طلب ستريمر', en: 'Streamer application' },
  'apply.modal.account.desc': {
    ar: 'اسم المستخدم أو رابط القناة — اتركه فاضي لو ما عندك حساب',
    en: 'Username or channel link — leave it empty if you have no account there',
  },
  'apply.modal.note': { ar: 'نبذة عنك (اختياري)', en: 'About you (optional)' },
  'apply.modal.note.desc': { ar: 'وش تبث؟ ومتى تبث عادة؟', en: 'What do you stream, and when?' },
  'apply.noAccounts': {
    ar: 'اكتب حساب واحد على الأقل (تويتش أو كيك أو يوتيوب أو تيك توك)',
    en: 'Enter at least one account (Twitch, Kick, YouTube or TikTok)',
  },
  'apply.received.title': { ar: '✅ تم استلام طلبك', en: '✅ Application received' },
  'apply.received.body': { ar: 'الإدارة بتراجع طلبك قريب.', en: 'The team will review it soon.' },
  'apply.received.dm': {
    ar: 'بيوصلك الرد على الخاص — تأكد إن رسائل الخاص من أعضاء السيرفر مفتوحة.',
    en: 'You will get the answer by DM — make sure direct messages from server members are allowed.',
  },
  'apply.received.accounts': { ar: '**الحسابات:**', en: '**Accounts:**' },

  // ───────────── review message ─────────────
  'review.title': { ar: '📝 طلب ستريمر', en: '📝 Streamer application' },
  'review.applicant': { ar: '👤 المتقدّم', en: '👤 Applicant' },
  'review.accounts': { ar: '📡 الحسابات', en: '📡 Accounts' },
  'review.note': { ar: '💬 نبذة', en: '💬 About' },
  'review.status': { ar: '📌 الحالة', en: '📌 Status' },
  'review.status.pending': { ar: '⏳ قيد المراجعة', en: '⏳ Pending review' },
  'review.status.approved': { ar: '✅ مقبول', en: '✅ Approved' },
  'review.status.rejected': { ar: '❌ مرفوض', en: '❌ Rejected' },
  'review.status.cancelled': { ar: '↩️ سحبه صاحبه', en: '↩️ Withdrawn by the applicant' },
  'review.decidedBy': { ar: '{status} — بواسطة {reviewer} {when}', en: '{status} — by {reviewer} {when}' },
  'review.reason': { ar: '📝 السبب', en: '📝 Reason' },
  'review.reviewNote': { ar: '📝 ملاحظة', en: '📝 Note' },
  'review.footer': { ar: 'طلب رقم {id}', en: 'Application #{id}' },
  'review.approve': { ar: 'قبول', en: 'Approve' },
  'review.reject': { ar: 'رفض', en: 'Reject' },
  'review.noPermission': { ar: 'هذا الزر للإدارة بس (يحتاج صلاحية Manage Server)', en: 'Only staff can use this button (requires Manage Server)' },
  'review.needManageRoles': {
    ar: 'القبول يحتاج كمان صلاحية Manage Roles لأن الستريمر بياخذ رتبة Streamer',
    en: 'Approving also requires Manage Roles, because the streamer gets the Streamer role',
  },
  'review.alreadyDecided': { ar: 'هذا الطلب انتهت مراجعته: {status}', en: 'This application was already handled: {status}' },
  'review.approved.title': { ar: '✅ تم قبول {name}', en: '✅ {name} approved' },
  'review.approved.body': { ar: 'تسجّل كستريمر بالحسابات اللي انضافت.', en: 'Registered as a streamer with the accounts that could be added.' },
  'review.approved.skipped': { ar: '⚠️ ما قدرت أضيف هذي الحسابات:', en: '⚠️ These accounts could not be added:' },
  'review.rejected.title': { ar: '❌ تم رفض الطلب', en: '❌ Application rejected' },
  'review.rejected.reason': { ar: 'السبب: {reason}', en: 'Reason: {reason}' },
  'review.rejectModal.title': { ar: 'رفض الطلب', en: 'Reject application' },
  'review.rejectModal.reason': { ar: 'سبب الرفض (اختياري)', en: 'Reason (optional)' },
  'review.rejectModal.reason.desc': {
    ar: 'يوصل للمتقدّم على الخاص لو كان الخاص مفتوح',
    en: 'Sent to the applicant by DM when their direct messages are open',
  },

  // ───────────── #11 /link /unlink ─────────────
  'link.disabled': { ar: 'ربط الحسابات الرسمي مو مفعّل في هذا السيرفر', en: 'Official account linking is not enabled in this server' },
  'link.unavailable': {
    ar: 'ربط حسابات {platform} غير متاح حالياً — صاحب البوت ما ضبط مفاتيحه',
    en: '{platform} linking is not available — the bot owner has not configured it',
  },
  'link.title': { ar: '🔗 ربط حسابك في {platform}', en: '🔗 Link your {platform} account' },
  'link.body': {
    ar: 'اضغط الزر تحت وسجّل دخولك في {platform} عشان نتأكد إن الحساب حقك.\nالرابط خاص فيك وينتهي بعد 15 دقيقة — لا ترسله لأحد.',
    en: 'Press the button below and sign in to {platform} to prove the account is yours.\nThe link is personal and expires in 15 minutes — do not share it.',
  },
  'link.optional': { ar: 'الربط اختياري — لو ما ربطت، كل شي يشتغل مثل ما هو.', en: 'Linking is optional — everything keeps working if you do not.' },
  'link.current': {
    ar: 'حسابك المربوط حالياً: **{login}** — لو ربطت من جديد بينستبدل',
    en: 'Currently linked: **{login}** — linking again replaces it',
  },
  'link.button': { ar: 'ربط {platform}', en: 'Link {platform}' },
  'link.unlinked': { ar: 'تم فك ربط حسابك في {platform}', en: 'Your {platform} account was unlinked' },
  'link.notLinked': { ar: 'ما عندك حساب {platform} مربوط', en: 'You have no linked {platform} account' },

  // ───────────── #14 /post ─────────────
  'post.disabled': { ar: 'النشر اليدوي مو مفعّل — فعّله من لوحة التحكم', en: 'Manual posting is not enabled — turn it on in the dashboard' },
  'post.streamerNotRegistered': { ar: '{user} مو مسجّل كستريمر', en: '{user} is not a registered streamer' },
  'post.alreadyPosted': { ar: 'هذا المقطع انتشر في السيرفر من قبل', en: 'This was already posted in this server' },
  'post.posted': { ar: 'تم نشر المقطع', en: 'Posted' },
  'post.notPosted': {
    ar: 'انحفظ المقطع بس ما انتشرت الرسالة — تأكد إن روم المقاطع محدد وإن البوت يقدر يرسل فيه (`/bot status`)',
    en: 'Saved, but the message was not posted — make sure a content channel is set and the bot can post there (`/bot status`)',
  },

  // ───────────── role assignability (dashboard + diagnostics + interactions) ─────────────
  'role.everyone': {
    ar: 'الرتبة المختارة هي @everyone وما ينفع تنعطى أو تنشال، اختر رتبة ثانية',
    en: 'The selected role is @everyone, which cannot be given or removed — pick another role',
  },
  'role.managed': {
    ar: 'رتبة {name} تابعة لبوت أو اشتراك (Managed) وما ينفع تنعطى يدوياً، اختر رتبة ثانية',
    en: 'The {name} role is managed by an integration and cannot be assigned — pick another role',
  },
  'role.noManageRoles': {
    ar: 'البوت ما عنده صلاحية {perm}، فعّلها لرتبة البوت عشان يقدر يعطي رتبة {name}',
    en: 'The bot lacks the {perm} permission — grant it to the bot role so it can assign {name}',
  },
  'role.aboveBot': {
    ar: 'رتبة البوت لازم تكون فوق رتبة {name} — من إعدادات السيرفر ← الرتب، اسحب رتبة البوت فوقها',
    en: 'The bot role must be above {name} — in Server Settings → Roles, drag the bot role above it',
  },

  // ───────────── diagnostics ─────────────
  'diag.role.streamer': { ar: 'Streamer', en: 'Streamer' },
  'diag.role.live': { ar: 'Streaming Now', en: 'Streaming Now' },
  'diag.role.notify': { ar: 'الإشعارات', en: 'notification' },
  'diag.channel.live': { ar: 'إشعارات البث', en: 'live notification' },
  'diag.channel.content': { ar: 'إشعارات المقاطع', en: 'content notification' },
  'diag.channel.log': { ar: 'اللوق', en: 'log' },
  'diag.channel.routed': { ar: 'توجيه الإشعارات', en: 'routed notification' },
  'diag.channel.notifyPanel': { ar: 'رسالة رتبة الإشعارات', en: 'notification panel' },
  'diag.channel.applyPanel': { ar: 'رسالة التقديم', en: 'application panel' },
  'diag.channel.review': { ar: 'مراجعة الطلبات', en: 'application review' },
  'diag.channel.counter': { ar: 'العداد', en: 'live counter' },
  'diag.notReady': {
    ar: 'البوت غير متصل بديسكورد حالياً — تأكد من التوكن وإن البوت شغال',
    en: 'The bot is not connected to Discord — check the token and that the bot is running',
  },
  'diag.notInGuild': {
    ar: 'البوت مو موجود في هذا السيرفر — ادعه من رابط الدعوة في لوحة التحكم',
    en: 'The bot is not in this server — invite it with the link in the dashboard',
  },
  'diag.missingManageRoles': {
    ar: 'البوت ما عنده صلاحية إدارة الرتب (Manage Roles) — بدونها ما يقدر يعطي رتبة Streamer و Streaming Now',
    en: 'The bot lacks the Manage Roles permission — without it, it cannot give the Streamer and Streaming Now roles',
  },
  'diag.roleUnset': {
    ar: 'ما حددت رتبة {label} — حددها من الإعدادات عشان البوت يعطيها تلقائياً',
    en: 'The {label} role is not set — choose it in the settings so the bot can assign it automatically',
  },
  'diag.roleNotFound': {
    ar: 'رتبة {label} المحددة ({id}) غير موجودة في السيرفر — يمكن انحذفت، حدّثها من الإعدادات',
    en: 'The {label} role ({id}) does not exist in the server — it may have been deleted, update it in the settings',
  },
  'diag.sameRoles': {
    ar: 'رتبة Streamer ورتبة Streaming Now نفس الرتبة — البوت بيشيلها من الستريمر أول ما يخلص بثه، استخدم رتبتين مختلفتين',
    en: 'Streamer and Streaming Now are the same role — the bot removes it as soon as the stream ends, use two different roles',
  },
  'diag.liveChannelUnset': {
    ar: 'ما حددت روم إشعارات البث — البوت ما راح يرسل إشعارات البث',
    en: 'No live notification channel is set — the bot will not post live notifications',
  },
  'diag.contentChannelUnset': {
    ar: 'ما حددت روم إشعارات المقاطع — البوت ما راح يرسل إشعارات المقاطع الجديدة',
    en: 'No content notification channel is set — the bot will not post new content',
  },
  'diag.channelNotFound': {
    ar: 'روم {label} المحدد ({id}) غير موجود في السيرفر — يمكن انحذف، حدّثه من الإعدادات',
    en: 'The {label} channel ({id}) does not exist in the server — it may have been deleted, update it in the settings',
  },
  'diag.channelNotText': {
    ar: 'روم {label} (#{name}) مو روم كتابي، اختر روم نصي أو روم إعلانات',
    en: 'The {label} channel (#{name}) is not a text channel, pick a text or announcement channel',
  },
  'diag.channelNoPermission': {
    ar: 'البوت ما يقدر يرسل في روم {label} (#{name}) — ناقصه: {perms}',
    en: 'The bot cannot post in the {label} channel (#{name}) — missing: {perms}',
  },
  'diag.channelNoAttach': {
    ar: 'البوت ما عنده صلاحية {perm} في روم {label} (#{name}) — صور تيك توك بتنرسل كروابط وتختفي بعد فترة',
    en: 'The bot lacks {perm} in the {label} channel (#{name}) — TikTok images will be sent as links and disappear after a while',
  },
  'diag.pingNoPermission': {
    ar: 'المنشن مضبوط على @{mode} بس البوت ما عنده صلاحية منشن الجميع (Mention @everyone)، المنشن ما راح يوصل',
    en: 'Pings are set to @{mode} but the bot lacks Mention @everyone, so nobody will be pinged',
  },
  'diag.pingRoleUnset': { ar: 'المنشن مضبوط على رتبة بس ما حددت الرتبة', en: 'Pings are set to a role but no role is selected' },
  'diag.pingRoleNotFound': { ar: 'رتبة المنشن ({id}) غير موجودة في السيرفر', en: 'The ping role ({id}) does not exist in the server' },
  'diag.pingRoleNotMentionable': {
    ar: 'رتبة المنشن {name} مقفول منشنها والبوت ما عنده صلاحية Mention @everyone — فعّل "Allow anyone to @mention this role" للرتبة',
    en: 'The ping role {name} is not mentionable and the bot lacks Mention @everyone — enable "Allow anyone to @mention this role" for it',
  },
  'diag.membersIntent': {
    ar: 'البوت ما قدر يجيب قائمة الأعضاء — فعّل "Server Members Intent" من Discord Developer Portal ← Bot ← Privileged Gateway Intents ثم أعد تشغيل البوت',
    en: 'The bot could not load the member list — enable "Server Members Intent" in the Discord Developer Portal → Bot → Privileged Gateway Intents, then restart the bot',
  },
  'diag.failed': { ar: 'ما قدرنا نفحص إعدادات السيرفر الحين، جرّب بعد شوي', en: 'Could not check the server setup right now, try again shortly' },
  'diag.notifyRoleElevated': {
    ar: 'رتبة الإشعارات {name} فيها صلاحيات إدارية — البوت ما راح يعطيها لأحد، اختر رتبة عادية بدون صلاحيات',
    en: 'The notification role {name} has moderation/admin permissions — the bot will not hand it out, pick an ordinary role',
  },
  'diag.notifyRoleNotMentionable': {
    ar: 'رتبة الإشعارات {name} مقفول منشنها والبوت ما عنده صلاحية Mention @everyone — فعّل "Allow anyone to @mention this role" عشان توصل المنشنات',
    en: 'The notification role {name} is not mentionable and the bot lacks Mention @everyone — enable "Allow anyone to @mention this role" so pings arrive',
  },
  'diag.notifyRoleConflict': {
    ar: 'رتبة الإشعارات نفس رتبة {other} — الأعضاء بيقدرون ياخذونها من الزر، اختر رتبة مستقلة للإشعارات',
    en: 'The notification role is the same as the {other} role — members could take it from the button, use a separate role',
  },
  'diag.notifyPanelUnset': {
    ar: 'رتبة الإشعارات محددة بس ما حددت روم رسالة الزر — الأعضاء ما عندهم طريقة ياخذونها',
    en: 'The notification role is set but no panel channel is chosen — members have no way to get it',
  },
  'diag.applyPanelUnset': {
    ar: 'طلبات الستريمرز مفعّلة بس ما حددت روم رسالة التقديم — الأعضاء ما يقدرون يقدّمون',
    en: 'Streamer applications are enabled but no panel channel is set — members cannot apply',
  },
  'diag.counterNoPermission': {
    ar: 'البوت ما يقدر يغيّر اسم روم العداد (#{name}) — ناقصه: {perms}. اعطه صلاحية Manage Channel على هذا الروم بس',
    en: 'The bot cannot rename the counter channel (#{name}) — missing: {perms}. Grant Manage Channel on that channel only',
  },
  'diag.counterIsThread': {
    ar: 'روم العداد (#{name}) ثريد — اختر روم صوتي أو كتابي عادي',
    en: 'The counter channel (#{name}) is a thread — pick a regular voice or text channel',
  },
  'diag.presenceIntent': {
    ar: 'كشف بث ديسكورد مفعّل بس البوت شغال بدون Presence Intent — فعّله من Developer Portal ← Bot ← Privileged Gateway Intents وحط DISCORD_PRESENCE_INTENT=true ثم أعد تشغيل البوت',
    en: 'Discord streaming detection is on, but the bot runs without the Presence Intent — enable it in Developer Portal → Bot → Privileged Gateway Intents, set DISCORD_PRESENCE_INTENT=true and restart the bot',
  },
});

export type InteractionMessageKey = Parameters<typeof ti>[1];
