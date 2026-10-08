/** /bot status | sync | test | panel — health, role sync, test notifications and panels (Manage Server by default). */
import type { APIEmbed } from 'discord.js';
import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { ValidationError } from '../../core/errors.js';
import { type Platform, PLATFORM_LABELS, PLATFORMS } from '../../core/types.js';
import type { Channel, GuildSettings, Language, PanelKind, StreamerWithAccounts } from '../../db/models.js';
import type { GuildDiagnostics } from '../../services/ports.js';
import { DEFAULT_PLATFORM_EMOJIS, type PlatformEmojis } from '../emojis.js';
import { discordTimestamp, formatNumber } from '../format.js';
import { englishLocalizations, ti } from '../i18n/interactions.js';
import { COLORS, respond, successEmbed } from './replies.js';
import { actorOf, type CommandEnv, type GuildCommandInteraction, type SlashCommand } from './types.js';

const TEST_TYPES = ['live', 'summary', 'content'] as const;
type TestType = (typeof TEST_TYPES)[number];
const TEST_LABELS: Record<TestType, { ar: string; en: string }> = {
  live: { ar: 'إشعار بث', en: 'Live notification' },
  summary: { ar: 'ملخص بث', en: 'Stream summary' },
  content: { ar: 'مقطع جديد', en: 'New content' },
};
const TEST_COOLDOWN_MS = 15_000;

const PANEL_KINDS = ['notify', 'apply'] as const satisfies readonly PanelKind[];
const PANEL_LABELS: Record<PanelKind, { ar: string; en: string }> = {
  notify: { ar: 'زر رتبة الإشعارات', en: 'Notification role button' },
  apply: { ar: 'زر طلب ستريمر', en: 'Streamer application button' },
};

const data = new SlashCommandBuilder()
  .setName('bot')
  .setDescription('حالة البوت وأدواته')
  .setDescriptionLocalizations(englishLocalizations('Bot status and tools'))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) =>
    sub.setName('status').setDescription('حالة البوت والمنصات وفحص الإعدادات').setDescriptionLocalizations(englishLocalizations('Bot and platform status, setup check')),
  )
  .addSubcommand((sub) =>
    sub.setName('sync').setDescription('مزامنة رتب Streamer و Streaming Now الحين').setDescriptionLocalizations(englishLocalizations('Sync the Streamer and Streaming Now roles now')),
  )
  .addSubcommand((sub) =>
    sub
      .setName('test')
      .setDescription('إرسال رسالة تجريبية للروم المحدد')
      .setDescriptionLocalizations(englishLocalizations('Send a test message to the configured channel'))
      .addStringOption((o) =>
        o
          .setName('type')
          .setDescription('نوع الرسالة')
          .setDescriptionLocalizations(englishLocalizations('Message type'))
          .setRequired(true)
          .addChoices(...TEST_TYPES.map((t) => ({ name: TEST_LABELS[t].ar, name_localizations: englishLocalizations(TEST_LABELS[t].en), value: t }))),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('panel')
      .setDescription('نشر (أو تحديث) رسالة زر الإشعارات أو زر طلب ستريمر')
      .setDescriptionLocalizations(englishLocalizations('Post (or refresh) the notification button or the streamer application button'))
      .addStringOption((o) =>
        o
          .setName('type')
          .setDescription('أي رسالة؟')
          .setDescriptionLocalizations(englishLocalizations('Which panel?'))
          .setRequired(true)
          .addChoices(...PANEL_KINDS.map((k) => ({ name: PANEL_LABELS[k].ar, name_localizations: englishLocalizations(PANEL_LABELS[k].en), value: k }))),
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
  lang?: Language;
}

export function buildStatusEmbed(input: StatusInput): APIEmbed {
  const emojis = input.emojis ?? DEFAULT_PLATFORM_EMOJIS;
  const lang = input.lang ?? 'ar';
  const { problems } = input.diagnostics;
  const errors = problems.filter((p) => p.level === 'error');
  const color = errors.length > 0 ? COLORS.error : problems.length > 0 ? COLORS.warn : COLORS.success;
  const setup = problems.length === 0 ? ti(lang, 'bot.status.allGood') : problems.map((p) => `${p.level === 'error' ? '⛔' : '⚠️'} ${p.message}`).join('\n');

  const platformLines = input.health
    .filter((h) => h.tracked > 0 || h.enabled)
    .map((h) => {
      const head = `${(emojis[h.platform] ?? DEFAULT_PLATFORM_EMOJIS[h.platform]).text} **${PLATFORM_LABELS[h.platform]}**`;
      if (!h.enabled) return ti(lang, 'bot.status.platformOff', { head });
      if (h.tracked === 0) return ti(lang, 'bot.status.noAccounts', { head });
      const parts = [ti(lang, 'bot.status.accounts', { count: h.tracked }), ti(lang, 'bot.status.live', { count: h.live })];
      if (h.failing > 0) parts.push(ti(lang, 'bot.status.failing', { count: h.failing }));
      const checked = discordTimestamp(h.lastCheckAt, 'R');
      if (checked) parts.push(ti(lang, 'bot.status.lastCheck', { when: checked }));
      return `${head}: ${parts.join(' • ')}`;
    });

  const since = discordTimestamp(input.startedAt, 'R');
  const ping = input.wsPing >= 0 ? `${Math.round(input.wsPing)}ms` : ti(lang, 'bot.status.unknownPing');
  return {
    color,
    title: ti(lang, 'bot.status.title'),
    description: `${ti(lang, 'bot.status.setup')}\n${setup}`.slice(0, 4000),
    fields: [
      {
        name: ti(lang, 'bot.status.connection'),
        value: `${ti(lang, 'bot.status.connected', { ping })}${since ? `\n${ti(lang, 'bot.status.since', { since })}` : ''}`,
        inline: true,
      },
      {
        name: ti(lang, 'bot.status.streamers'),
        value: ti(lang, 'bot.status.streamersValue', { streamers: formatNumber(input.streamers), accounts: formatNumber(input.accounts), live: formatNumber(input.liveNow) }),
        inline: true,
      },
      { name: ti(lang, 'bot.status.platforms'), value: (platformLines.join('\n') || ti(lang, 'bot.status.noPlatforms')).slice(0, 1024), inline: false },
    ],
  };
}

// ───────────────────────────── handlers ─────────────────────────────

const lastTestAt = new Map<string, number>();

async function status(interaction: GuildCommandInteraction, env: CommandEnv, lang: Language): Promise<void> {
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
    lang,
  });
  await respond(interaction, { embeds: [statusEmbed] });
}

async function sync(interaction: GuildCommandInteraction, env: CommandEnv, lang: Language): Promise<void> {
  const result = await env.services.sessions.syncRoles(interaction.guildId, actorOf(interaction));
  await respond(interaction, {
    embeds: [successEmbed(ti(lang, 'bot.sync.title'), ti(lang, 'bot.sync.body', { added: formatNumber(result.added), removed: formatNumber(result.removed) }))],
  });
}

async function test(interaction: GuildCommandInteraction, env: CommandEnv, lang: Language): Promise<void> {
  const type = interaction.options.getString('type', true);
  if (!(TEST_TYPES as readonly string[]).includes(type)) throw new ValidationError(ti(lang, 'bot.test.unknownType'));
  const testType = type as TestType;
  const now = env.clock();
  const last = lastTestAt.get(interaction.guildId) ?? 0;
  if (now - last < TEST_COOLDOWN_MS) {
    throw new ValidationError(ti(lang, 'bot.test.cooldown', { seconds: Math.ceil((TEST_COOLDOWN_MS - (now - last)) / 1000) }));
  }
  const ref = await env.sendTest(interaction.guildId, testType);
  if (!ref) throw new ValidationError(ti(lang, 'bot.test.failed'));
  // Only successful sends count toward the cooldown, so fixing a setting and retrying is never blocked.
  lastTestAt.set(interaction.guildId, now);
  env.services.audit.record({
    guildId: interaction.guildId,
    actor: actorOf(interaction),
    action: 'tools.test',
    message: `تم إرسال ${TEST_LABELS[testType].ar} تجريبي من أمر /bot test`,
    details: { type, channelId: ref.channelId, messageId: ref.messageId },
  });
  await respond(interaction, {
    embeds: [
      successEmbed(ti(lang, 'bot.test.sent', { type: ti(lang, `bot.type.${testType}`) }), `[${ti(lang, 'common.openMessage')}](${env.messageUrl(interaction.guildId, ref)})`),
    ],
  });
}

async function panel(interaction: GuildCommandInteraction, env: CommandEnv, lang: Language): Promise<void> {
  const kind = interaction.options.getString('type', true);
  if (!(PANEL_KINDS as readonly string[]).includes(kind)) throw new ValidationError(ti(lang, 'bot.panel.unknown'));
  const panelKind = kind as PanelKind;
  const ref = await env.postPanel(interaction.guildId, panelKind);
  env.services.audit.record({
    guildId: interaction.guildId,
    actor: actorOf(interaction),
    action: 'panel.posted',
    message: `تم نشر ${PANEL_LABELS[panelKind].ar} من أمر /bot panel`,
    details: { kind: panelKind, channelId: ref.channelId, messageId: ref.messageId },
    mirror: false,
  });
  await respond(interaction, {
    embeds: [
      successEmbed(
        ti(lang, 'bot.panel.posted', { panel: ti(lang, panelKind === 'notify' ? 'bot.panel.notify' : 'bot.panel.apply') }),
        `[${ti(lang, 'common.openMessage')}](${env.messageUrl(interaction.guildId, ref)})`,
      ),
    ],
  });
}

export const botCommand: SlashCommand = {
  data,
  defer: 'ephemeral',
  async execute(interaction, env, lang) {
    switch (interaction.options.getSubcommand(true)) {
      case 'status':
        return status(interaction, env, lang);
      case 'sync':
        return sync(interaction, env, lang);
      case 'test':
        return test(interaction, env, lang);
      case 'panel':
        return panel(interaction, env, lang);
      default:
        throw new ValidationError(ti(lang, 'common.unknownCommand'));
    }
  },
};
