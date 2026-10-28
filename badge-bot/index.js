require('dotenv').config();
const fs = require('fs');
const {
  Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
  PermissionFlagsBits, SlashCommandBuilder, MessageFlags,
} = require('discord.js');

const DATA_FILE = './nitro.json';
const COLOR = 0xf47fff;
const DAY = 86400000;

// شارات النيترو (بالأشهر)
const NITRO_BADGES = [
  { m: 1, name: 'Bronze' }, { m: 3, name: 'Silver' }, { m: 6, name: 'Gold' },
  { m: 12, name: 'Platinum' }, { m: 24, name: 'Diamond' }, { m: 36, name: 'Emerald' },
  { m: 60, name: 'Ruby' }, { m: 72, name: 'Opal' },
];
// شارات البوست (بالأشهر)
const BOOST_BADGES = [1, 2, 3, 6, 9, 12, 15, 18, 24];

const load = () => { try { return JSON.parse(fs.readFileSync(DATA_FILE)); } catch { return {}; } };
const save = (d) => fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));

const addMonths = (date, m) => { const d = new Date(date); d.setMonth(d.getMonth() + m); return d; };
const monthsBetween = (a, b) => {
  let m = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  if (b.getDate() < a.getDate()) m--;
  return Math.max(0, m);
};
const left = (target) => {
  const ms = target - Date.now();
  if (ms <= 0) return 'الآن ✅';
  const d = Math.floor(ms / DAY), h = Math.floor((ms % DAY) / 3600000);
  return `**${d}** يوم و **${h}** ساعة`;
};
const ts = (d) => `<t:${Math.floor(d.getTime() / 1000)}:D>`;

function nitroInfo(since) {
  const now = new Date();
  const months = monthsBetween(since, now);
  const cur = [...NITRO_BADGES].reverse().find(b => months >= b.m);
  const next = NITRO_BADGES.find(b => months < b.m);
  return { months, cur, next, nextDate: next && addMonths(since, next.m) };
}
function boostInfo(since) {
  const months = monthsBetween(since, new Date());
  const cur = [...BOOST_BADGES].reverse().find(m => months >= m);
  const next = BOOST_BADGES.find(m => months < m);
  return { months, cur, next, nextDate: next && addMonths(since, next) };
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.once('ready', async () => {
  await client.application.commands.set([
    new SlashCommandBuilder().setName('panel').setDescription('إرسال لوحة فحص الشارات')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  ]);
  console.log(`✅ ${client.user.tag} شغال`);
});

function panel() {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setAuthor({ name: 'Badge Checker', iconURL: client.user.displayAvatarURL() })
    .setTitle('💎 فاحص الشارات')
    .setDescription([
      'اضغط على الزر بالأسفل وبيطلع لك **أنت فقط**:',
      '',
      '> <:nitro:0> كم باقي على شارة النيترو الجاية',
      '> 🚀 كم باقي على شارة البوست في **كل سيرفر** تبوسته',
      '',
      '🔒 الرد يظهر لك وحدك.',
    ].join('\n').replace('<:nitro:0>', '💠'))
    .setFooter({ text: 'Badge Checker • Nitro & Boost' });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('check').setLabel('افحص شاراتي').setEmoji('🔍').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('setnitro').setLabel('تعديل تاريخ النيترو').setEmoji('⚙️').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

async function buildReport(user) {
  const embed = new EmbedBuilder().setColor(COLOR)
    .setAuthor({ name: user.username, iconURL: user.displayAvatarURL() })
    .setTitle('📊 تقرير شاراتك').setTimestamp();

  // النيترو
  const nitro = load()[user.id];
  if (nitro) {
    const n = nitroInfo(new Date(nitro));
    embed.addFields({
      name: '💠 النيترو',
      value: [
        `مشترك من: ${ts(new Date(nitro))} (**${n.months}** شهر)`,
        `الشارة الحالية: **${n.cur ? n.cur.name : 'لا يوجد'}**`,
        n.next ? `الشارة الجاية: **${n.next.name}** بتاريخ ${ts(n.nextDate)}\n⏳ باقي: ${left(n.nextDate)}`
               : '🏆 وصلت أعلى شارة!',
      ].join('\n'),
    });
  } else {
    embed.addFields({ name: '💠 النيترو', value: 'ما سجلت تاريخ النيترو، اضغط **تعديل تاريخ النيترو** مرة وحدة بس.' });
  }

  // البوست في كل السيرفرات المشتركة مع البوت
  const boosts = [];
  for (const g of client.guilds.cache.values()) {
    const m = await g.members.fetch(user.id).catch(() => null);
    if (m?.premiumSince) boosts.push({ g, since: m.premiumSince });
  }
  if (!boosts.length) {
    embed.addFields({ name: '🚀 البوست', value: 'ما لقيت بوست لك في السيرفرات اللي فيها البوت.' });
  } else {
    for (const { g, since } of boosts.slice(0, 20)) {
      const b = boostInfo(since);
      embed.addFields({
        name: `🚀 ${g.name}`,
        value: [
          `بوست من: ${ts(since)} (**${b.months}** شهر) • الشارة: **${b.cur ? b.cur + ' شهر' : 'لا يوجد'}**`,
          b.next ? `الجاية: **${b.next} شهر** • ⏳ ${left(b.nextDate)}` : '🏆 أعلى شارة بوست!',
        ].join('\n'),
      });
    }
  }
  return embed;
}

client.on('interactionCreate', async (i) => {
  try {
    if (i.isChatInputCommand() && i.commandName === 'panel') {
      await i.channel.send(panel());
      return i.reply({ content: '✅ تم إرسال اللوحة', flags: MessageFlags.Ephemeral });
    }
    if (i.isButton() && i.customId === 'check') {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      return i.editReply({ embeds: [await buildReport(i.user)] });
    }
    if (i.isButton() && i.customId === 'setnitro') {
      const modal = new ModalBuilder().setCustomId('nitromodal').setTitle('تاريخ بداية النيترو')
        .addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('date').setLabel('التاريخ (YYYY-MM-DD)')
            .setPlaceholder('2025-03-15').setStyle(TextInputStyle.Short).setRequired(true)));
      return i.showModal(modal);
    }
    if (i.isModalSubmit() && i.customId === 'nitromodal') {
      const v = i.fields.getTextInputValue('date').trim();
      const d = new Date(v);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(d) || d > new Date())
        return i.reply({ content: '❌ تاريخ غير صحيح، مثال: 2025-03-15', flags: MessageFlags.Ephemeral });
      const data = load(); data[i.user.id] = d.toISOString(); save(data);
      return i.reply({ content: '✅ تم الحفظ', embeds: [await buildReport(i.user)], flags: MessageFlags.Ephemeral });
    }
  } catch (e) { console.error(e); }
});

client.login(process.env.TOKEN);
