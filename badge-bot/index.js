require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client, GatewayIntentBits, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder,
  SlashCommandBuilder, PermissionFlagsBits, MessageFlags,
} = require('discord.js');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
GlobalFonts.registerFromPath(path.join(__dirname, 'fonts', 'Cairo-Regular.ttf'), 'Cairo');
GlobalFonts.registerFromPath(path.join(__dirname, 'fonts', 'Cairo-Bold.ttf'), 'Cairo');

// ---------- التخزين ----------
const DATA_FILE = path.join(__dirname, 'data.json');
const load = () => { try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return {}; } };
let db = load();
const save = () => fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
const userData = (id) => (db[id] ??= { nitro: null, boosts: [] });

// ---------- مستويات الشارات (بالأشهر) ----------
const NITRO_TIERS = [
  { m: 1, name: 'Bronze', ar: 'برونز', color: '#cd7f32' },
  { m: 3, name: 'Silver', ar: 'فضي', color: '#c0c0c0' },
  { m: 6, name: 'Gold', ar: 'ذهبي', color: '#ffd700' },
  { m: 12, name: 'Platinum', ar: 'بلاتيني', color: '#7fd8e6' },
  { m: 24, name: 'Diamond', ar: 'ماسي', color: '#7fb2ff' },
  { m: 36, name: 'Emerald', ar: 'زمردي', color: '#2ecc71' },
  { m: 60, name: 'Ruby', ar: 'ياقوتي', color: '#e0115f' },
  { m: 72, name: 'Opal', ar: 'أوبال', color: '#d9b3ff' },
];
const BOOST_TIERS = [1, 2, 3, 6, 9, 12, 15, 18, 24].map((m) => ({ m, name: `${m} Month${m > 1 ? 's' : ''}`, ar: `${m} شهر`, color: '#f47fff' }));

// ---------- حسابات التاريخ ----------
const DAY = 86400000;
const addMonths = (d, n) => { const r = new Date(d); r.setMonth(r.getMonth() + n); return r; };
const monthsBetween = (a, b) => {
  let m = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  if (addMonths(a, m) > b) m--;
  return Math.max(0, m);
};
const fmtLeft = (ms) => {
  if (ms <= 0) return 'الآن';
  const d = Math.floor(ms / DAY), h = Math.floor((ms % DAY) / 3600000);
  return d > 0 ? `${d} يوم و ${h} ساعة` : `${h} ساعة`;
};
const parseDate = (s) => {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s.trim());
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return isNaN(d) || d > new Date() ? null : d;
};

function badgeInfo(start, tiers) {
  const now = new Date();
  const months = monthsBetween(start, now);
  let cur = null, next = tiers[0];
  for (const t of tiers) { if (months >= t.m) cur = t; else { next = t; break; } }
  if (cur === tiers[tiers.length - 1]) next = null;
  const nextAt = next ? addMonths(start, next.m) : null;
  const renew = addMonths(start, months + 1); // التجديد/الانتهاء الشهري القادم
  const progress = next ? Math.min(1, (now - (cur ? addMonths(start, cur.m) : start)) / (nextAt - (cur ? addMonths(start, cur.m) : start))) : 1;
  return { months, cur, next, nextLeft: nextAt ? nextAt - now : 0, renewLeft: renew - now, renew, progress };
}

// ---------- جمع البوستات ----------
async function collectBoosts(client, user) {
  const list = [];
  for (const guild of client.guilds.cache.values()) {
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (member?.premiumSince) list.push({ server: guild.name, since: member.premiumSince, auto: true });
  }
  for (const b of userData(user.id).boosts) list.push({ server: b.server, since: new Date(b.since), auto: false });
  return list.sort((a, b) => a.since - b.since);
}

// ---------- رسم البطاقة ----------
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

const SEC_H = 200;
function drawSection(ctx, y, title, accent, info, subtitle) {
  const W = 900, x = 30, w = W - 60, R = W - 60;
  roundRect(ctx, x, y, w, SEC_H - 20, 18); ctx.fillStyle = 'rgba(255,255,255,0.05)'; ctx.fill();
  ctx.fillStyle = accent; roundRect(ctx, W - x - 8, y, 8, SEC_H - 20, 4); ctx.fill();
  ctx.textAlign = 'right'; ctx.direction = 'rtl';
  ctx.fillStyle = '#fff'; ctx.font = 'bold 26px Cairo'; ctx.fillText(title, R, y + 40);
  ctx.fillStyle = '#b9bbbe'; ctx.font = '17px Cairo'; ctx.fillText(subtitle, R, y + 68);
  if (!info) {
    ctx.fillStyle = '#ed4245'; ctx.font = '20px Cairo'; ctx.fillText('لا توجد بيانات — استخدم أزرار التسجيل', R, y + 110); return;
  }
  ctx.font = 'bold 20px Cairo'; ctx.fillStyle = info.cur?.color ?? '#fff';
  ctx.fillText(`الشارة الحالية: ${info.cur ? info.cur.ar : 'لا يوجد بعد'}`, R, y + 102);
  ctx.font = '19px Cairo'; ctx.fillStyle = '#fff';
  ctx.fillText(info.next ? `الشارة التالية (${info.next.ar}) بعد: ${fmtLeft(info.nextLeft)}` : 'وصلت لأعلى شارة', R, y + 132);
  ctx.fillStyle = '#faa61a';
  ctx.fillText(`التجديد / الانتهاء بعد: ${fmtLeft(info.renewLeft)}`, R, y + 160);
  // شريط التقدم نحو الشارة التالية
  const bx = 60, bw = 300, by = y + 120;
  ctx.textAlign = 'left'; ctx.direction = 'ltr'; ctx.fillStyle = '#b9bbbe'; ctx.font = '15px Cairo';
  ctx.fillText(`${Math.round(info.progress * 100)}%`, bx, by - 10);
  roundRect(ctx, bx, by, bw, 14, 7); ctx.fillStyle = '#2f3136'; ctx.fill();
  roundRect(ctx, bx, by, Math.max(14, bw * info.progress), 14, 7); ctx.fillStyle = accent; ctx.fill();
}

async function buildCard(user, nitro, boosts) {
  const rows = Math.max(1, boosts.length);
  const W = 900, H = 160 + SEC_H * (1 + rows) + 10;
  const c = createCanvas(W, H), ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#1e1f29'); g.addColorStop(1, '#2b1f3a');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  const av = await loadImage(user.displayAvatarURL({ extension: 'png', size: 128 })).catch(() => null);
  if (av) { ctx.save(); ctx.beginPath(); ctx.arc(W - 90, 80, 50, 0, Math.PI * 2); ctx.clip(); ctx.drawImage(av, W - 140, 30, 100, 100); ctx.restore(); }
  ctx.textAlign = 'right'; ctx.direction = 'rtl';
  ctx.fillStyle = '#fff'; ctx.font = 'bold 34px Cairo'; ctx.fillText(user.globalName ?? user.username, W - 160, 75);
  ctx.fillStyle = '#b9bbbe'; ctx.font = '20px Cairo'; ctx.fillText('تقرير شارات النيترو والبوست', W - 160, 108);

  let y = 160;
  drawSection(ctx, y, 'شارة النيترو', '#ff73fa', nitro, nitro ? `مشترك منذ ${nitro.months} شهر` : 'غير مسجل');
  y += SEC_H;
  if (!boosts.length) drawSection(ctx, y, 'شارة البوست', '#f47fff', null, 'لا يوجد بوست');
  for (const b of boosts) {
    drawSection(ctx, y, `بوست: ${b.server}`, '#f47fff', badgeInfo(b.since, BOOST_TIERS),
      `منذ ${b.since.toISOString().slice(0, 10)}${b.auto ? ' • تم اكتشافه تلقائياً' : ''}`);
    y += SEC_H;
  }
  return new AttachmentBuilder(await c.encode('png'), { name: 'badges.png' });
}

// ---------- البوت ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const panelRow = () => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('check').setLabel('شوف شاراتي').setEmoji('🔍').setStyle(ButtonStyle.Primary),
  new ButtonBuilder().setCustomId('set_nitro').setLabel('تسجيل النيترو').setEmoji('💎').setStyle(ButtonStyle.Secondary),
  new ButtonBuilder().setCustomId('add_boost').setLabel('إضافة بوست').setEmoji('🚀').setStyle(ButtonStyle.Secondary),
  new ButtonBuilder().setCustomId('clear').setLabel('مسح بياناتي').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
);

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ ${c.user.tag} شغال`);
  await c.application.commands.set([
    new SlashCommandBuilder().setName('panel').setDescription('إرسال لوحة فحص الشارات')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  ]);
});

const dateInput = (id, label) => new TextInputBuilder().setCustomId(id).setLabel(label)
  .setPlaceholder('YYYY-MM-DD  مثال: 2025-03-14').setStyle(TextInputStyle.Short).setRequired(true);

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isChatInputCommand() && i.commandName === 'panel') {
      const embed = new EmbedBuilder().setColor(0xff73fa).setTitle('💎 فاحص شارات النيترو والبوست')
        .setDescription([
          'اضغط **شوف شاراتي** وبيطلع لك تقرير **مخفي يشوفه أنت بس** فيه:',
          '• شارة النيترو الحالية وكم باقي على الشارة الجاية',
          '• شارة البوست لكل سيرفر (حتى السيرفرات اللي البوت مو فيها)',
          '• كم باقي على التجديد / الانتهاء',
          '',
          '> البوستات في السيرفرات اللي فيها البوت تنكشف تلقائياً، والباقي سجله بزر **إضافة بوست**.',
        ].join('\n'))
        .setFooter({ text: i.guild.name, iconURL: i.guild.iconURL() ?? undefined });
      await i.channel.send({ embeds: [embed], components: [panelRow()] });
      return i.reply({ content: '✅ تم إرسال اللوحة', flags: MessageFlags.Ephemeral });
    }

    if (i.isButton()) {
      if (i.customId === 'check') {
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const u = userData(i.user.id);
        const nitro = u.nitro ? badgeInfo(new Date(u.nitro), NITRO_TIERS) : null;
        const boosts = await collectBoosts(client, i.user);
        const file = await buildCard(i.user, nitro, boosts);
        const embed = new EmbedBuilder().setColor(0xff73fa).setImage('attachment://badges.png')
          .setFooter({ text: 'هذه الرسالة تظهر لك فقط' });
        return i.editReply({ embeds: [embed], files: [file] });
      }
      if (i.customId === 'set_nitro') {
        return i.showModal(new ModalBuilder().setCustomId('m_nitro').setTitle('تسجيل النيترو')
          .addComponents(new ActionRowBuilder().addComponents(dateInput('date', 'تاريخ بداية اشتراك النيترو'))));
      }
      if (i.customId === 'add_boost') {
        return i.showModal(new ModalBuilder().setCustomId('m_boost').setTitle('إضافة بوست').addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('server').setLabel('اسم السيرفر')
            .setStyle(TextInputStyle.Short).setMaxLength(50).setRequired(true)),
          new ActionRowBuilder().addComponents(dateInput('date', 'تاريخ بداية البوست')),
        ));
      }
      if (i.customId === 'clear') {
        delete db[i.user.id]; save();
        return i.reply({ content: '🗑️ تم مسح بياناتك المسجلة.', flags: MessageFlags.Ephemeral });
      }
    }

    if (i.isModalSubmit()) {
      const date = parseDate(i.fields.getTextInputValue('date'));
      if (!date) return i.reply({ content: '❌ التاريخ غير صحيح. اكتبه بهذا الشكل: `2025-03-14`', flags: MessageFlags.Ephemeral });
      const u = userData(i.user.id);
      if (i.customId === 'm_nitro') u.nitro = date.toISOString();
      if (i.customId === 'm_boost') {
        const server = i.fields.getTextInputValue('server').trim();
        u.boosts = u.boosts.filter((b) => b.server !== server);
        u.boosts.push({ server, since: date.toISOString() });
      }
      save();
      return i.reply({ content: '✅ تم الحفظ! اضغط **شوف شاراتي** لعرض التقرير.', flags: MessageFlags.Ephemeral });
    }
  } catch (e) {
    console.error(e);
    const msg = { content: '⚠️ صار خطأ، حاول مرة ثانية.', flags: MessageFlags.Ephemeral };
    if (i.deferred || i.replied) i.editReply(msg).catch(() => {}); else i.reply?.(msg).catch(() => {});
  }
});

client.login(process.env.TOKEN);
