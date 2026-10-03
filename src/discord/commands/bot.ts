/** /bot status | sync | test — health, role sync and test notifications (Manage Server by default). */
import type { APIEmbed } from 'discord.js';
import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { ValidationError } from '../../core/errors.js';
import { type Platform, PLATFORM_LABELS, PLATFORMS } from '../../core/types.js';
import type { Channel, GuildSettings, StreamerWithAccounts } from '../../db/models.js';
import type { GuildDiagnostics } from '../../services/ports.js';
import { DEFAULT_PLATFORM_EMOJIS, type PlatformEmojis } from '../emojis.js';
import { discordTimestamp, formatNumber } from '../format.js';
import { COLORS, respond, successEmbed } from './replies.js';
import { actorOf, type CommandEnv, type GuildCommandInteraction, type SlashCommand } from './types.js';

const TEST_TYPES = ['live', 'summary', 'content'] as const;
type TestType = (typeof TEST_TYPES)[number];
const TEST_LABELS: Record<TestType, string> = { live: 'إشعار بث', summary: 'ملخص بث', content: 'مقطع جديد' };
const TEST_COOLDOWN_MS = 15_000;

const data = new SlashCommandBuilder()
  .setName('bot')
  .setDescription('حالة البوت وأدواته')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) => sub.setName('status').setDescription('حالة البوت والمنصات وفحص الإعدادات'))
  .addSubcommand((sub) => sub.setName('sync').setDescription('مزامنة رتب Streamer و Streaming Now الحين'))
  .addSubcommand((sub) =>
    sub
      .setName('test')
      .setDescription('إرسال رسالة تجريبية للروم المحدد')
      .addStringOption((o) =>
        o
          .setName('type')
          .setDescription('نوع الرسالة')
          .setRequired(true)
          .addChoices(...TEST_TYPES.map((t) => ({ name: TEST_LABELS[t], value: t }))),
      ),
  )
  .toJSON();

// ───────────────────────────── pure builders ─────────────────────────────

export interface PlatformHealth {
  platform: Platform;
  tracked: number;
  live: number;
  failing: number;
  lastCheckAt: string | null;
  enabled: boolean;
}

/** Per-platform health of the channels tracked by a guild (deduplicated across streamers). */
export function platformHealth(streamers: StreamerWithAccounts[], settings: Pick<GuildSettings, 'platformsEnabled'>): PlatformHealth[] {
  const channels = new Map<number, Channel>();
  for (const s of streamers) {
    if (!s.enabled) continue;
    for (const a of s.accounts) channels.set(a.channel.id, a.channel);
  }
  return PLATFORMS.map((platform) => {
    const list = [...channels.values()].filter((c) => c.platform === platform);
    const lastCheckAt = list.map((c) => c.lastLiveCheckAt).filter((v): v is string => !!v).sort().at(-1) ?? null;
    return {
      platform,
      tracked: list.length,
      live: list.filter((c) => c.isLive).length,
      failing: list.filter((c) => c.errorCount > 0).length,
      lastCheckAt,
      enabled: settings.platformsEnabled.includes(platform),
    };
  });
}

export interface StatusInput {
  diagnostics: GuildDiagnostics;
  health: PlatformHealth[];
  streamers: number;
  accounts: number;
  liveNow: number;
  wsPing: number;
  startedAt: number;
  emojis?: PlatformEmojis;
}

export function buildStatusEmbed(input: StatusInput): APIEmbed {
  const emojis = input.emojis ?? DEFAULT_PLATFORM_EMOJIS;
  const { problems } = input.diagnostics;
  const errors = problems.filter((p) => p.level === 'error');
  const color = errors.length > 0 ? COLORS.error : problems.length > 0 ? COLORS.warn : COLORS.success;
  const setup = problems.length === 0 ? '✅ كل شي مضبوط' : problems.map((p) => `${p.level === 'error' ? '⛔' : '⚠️'} ${p.message}`).join('\n');

  const platformLines = input.health
    .filter((h) => h.tracked > 0 || h.enabled)
    .map((h) => {
      const head = `${(emojis[h.platform] ?? DEFAULT_PLATFORM_EMOJIS[h.platform]).text} **${PLATFORM_LABELS[h.platform]}**`;
      if (!h.enabled) return `${head}: متوقفة من الإعدادات`;
      if (h.tracked === 0) return `${head}: ما فيه حسابات`;
      const parts = [`${h.tracked} حساب`, `${h.live} لايف`];
      if (h.failing > 0) parts.push(`⚠️ ${h.failing} فيها أخطاء`);
      const checked = discordTimestamp(h.lastCheckAt, 'R');
      if (checked) parts.push(`آخر فحص ${checked}`);
      return `${head}: ${parts.join(' • ')}`;
    });

  const since = discordTimestamp(input.startedAt, 'R');
  const ping = input.wsPing >= 0 ? `${Math.round(input.wsPing)}ms` : 'غير معروف';
  return {
    color,
    title: '🤖 حالة البوت',
    description: `**⚙️ فحص الإعدادات**\n${setup}`.slice(0, 4000),
    fields: [
      { name: '📡 الاتصال', value: `متصل ✅ • البينق ${ping}${since ? `\nشغال من ${since}` : ''}`, inline: true },
      { name: '👥 الستريمرز', value: `${formatNumber(input.streamers)} ستريمر • ${formatNumber(input.accounts)} حساب\n🔴 يبث الحين: ${formatNumber(input.liveNow)}`, inline: true },
      { name: '🛰️ المنصات', value: (platformLines.join('\n') || 'ما فيه منصات مفعلة').slice(0, 1024), inline: false },
    ],
  };
}

// ───────────────────────────── handlers ─────────────────────────────

const lastTestAt = new Map<string, number>();

async function status(interaction: GuildCommandInteraction, env: CommandEnv): Promise<void> {
  const { guildId } = interaction;
  const { repos } = env.services;
  const settings = repos.settings.get(guildId);
  const diagnostics = await env.gateway.diagnose(guildId, settings);
  const streamers = repos.streamersWithAccounts(guildId);
  const statusEmbed = buildStatusEmbed({
    diagnostics,
    health: platformHealth(streamers, settings),
    streamers: streamers.length,
    accounts: streamers.reduce((n, s) => n + s.accounts.length, 0),
    liveNow: repos.sessions.listActive(guildId).length,
    wsPing: env.wsPing(),
    startedAt: env.startedAt,
    emojis: env.emojis(),
  });
  await respond(interaction, { embeds: [statusEmbed] });
}

async function sync(interaction: GuildCommandInteraction, env: CommandEnv): Promise<void> {
  const result = await env.services.sessions.syncRoles(interaction.guildId, actorOf(interaction));
  await respond(interaction, { embeds: [successEmbed('تمت مزامنة الرتب', `➕ أضيفت: ${formatNumber(result.added)}\n➖ أزيلت: ${formatNumber(result.removed)}`)] });
}

async function test(interaction: GuildCommandInteraction, env: CommandEnv): Promise<void> {
  const type = interaction.options.getString('type', true);
  if (!(TEST_TYPES as readonly string[]).includes(type)) throw new ValidationError('نوع الرسالة غير معروف');
  const now = env.clock();
  const last = lastTestAt.get(interaction.guildId) ?? 0;
  if (now - last < TEST_COOLDOWN_MS) {
    throw new ValidationError(`لحظة شوي، تقدر ترسل رسالة تجريبية ثانية بعد ${Math.ceil((TEST_COOLDOWN_MS - (now - last)) / 1000)} ثانية`);
  }
  const ref = await env.sendTest(interaction.guildId, type as TestType);
  if (!ref) throw new ValidationError('ما قدرت أرسل الرسالة التجريبية، راجع `/bot status`');
  // Only successful sends count toward the cooldown, so fixing a setting and retrying is never blocked.
  lastTestAt.set(interaction.guildId, now);
  env.services.audit.record({
    guildId: interaction.guildId,
    actor: actorOf(interaction),
    action: 'tools.test',
    message: `تم إرسال ${TEST_LABELS[type as TestType]} تجريبي من أمر /bot test`,
    details: { type, channelId: ref.channelId, messageId: ref.messageId },
  });
  await respond(interaction, {
    embeds: [successEmbed(`أرسلت ${TEST_LABELS[type as TestType]} تجريبي`, `[افتح الرسالة](${env.messageUrl(interaction.guildId, ref)})`)],
  });
}

export const botCommand: SlashCommand = {
  data,
  defer: 'ephemeral',
  async execute(interaction, env) {
    switch (interaction.options.getSubcommand(true)) {
      case 'status':
        return status(interaction, env);
      case 'sync':
        return sync(interaction, env);
      case 'test':
        return test(interaction, env);
      default:
        throw new ValidationError('أمر غير معروف');
    }
  },
};
