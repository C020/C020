/** /streamer add | remove | list | info — streamer management from Discord (Manage Server by default). */
import type { APIEmbed, APIEmbedField } from 'discord.js';
import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { ValidationError } from '../../core/errors.js';
import { isPlatform, type Platform, PLATFORM_LABELS, PLATFORMS } from '../../core/types.js';
import type { Language, StreamerWithAccounts } from '../../db/models.js';
import type { AccountInput } from '../../shared/api.js';
import { DEFAULT_PLATFORM_EMOJIS, ICONS, type PlatformEmojis } from '../emojis.js';
import { cleanText, discordTimestamp, escapeMarkdown, formatDurationShort, formatNumber, safeUrl, truncate } from '../format.js';
import { englishLocalizations, ti } from '../i18n/interactions.js';
import { DISCORD_LIMITS } from '../templates.js';
import { COLORS, embed, friendlyError, respond, successEmbed } from './replies.js';
import { actorOf, type CommandEnv, type GuildCommandInteraction, type SlashCommand } from './types.js';

const PLATFORM_OPTION_HINTS: Record<Platform, { ar: string; en: string }> = {
  twitch: { ar: 'حساب تويتش (اسم المستخدم أو الرابط)', en: 'Twitch account (username or link)' },
  kick: { ar: 'حساب كيك (اسم المستخدم أو الرابط)', en: 'Kick account (username or link)' },
  youtube: { ar: 'قناة يوتيوب (@handle أو رابط القناة)', en: 'YouTube channel (@handle or channel link)' },
  tiktok: { ar: 'حساب تيك توك (@username أو الرابط)', en: 'TikTok account (@username or link)' },
};

const MAX_INPUT = 300;

const data = new SlashCommandBuilder()
  .setName('streamer')
  .setDescription('إدارة الستريمرز')
  .setDescriptionLocalizations(englishLocalizations('Manage streamers'))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) => {
    sub
      .setName('add')
      .setDescription('إضافة ستريمر، أو إضافة حسابات جديدة لستريمر مسجّل')
      .setDescriptionLocalizations(englishLocalizations('Add a streamer, or add new accounts to a registered streamer'))
      .addUserOption((o) => o.setName('user').setDescription('العضو').setDescriptionLocalizations(englishLocalizations('The member')).setRequired(true));
    for (const platform of PLATFORMS) {
      sub.addStringOption((o) =>
        o
          .setName(platform)
          .setDescription(PLATFORM_OPTION_HINTS[platform].ar)
          .setDescriptionLocalizations(englishLocalizations(PLATFORM_OPTION_HINTS[platform].en))
          .setMaxLength(MAX_INPUT),
      );
    }
    return sub.addStringOption((o) =>
      o
        .setName('name')
        .setDescription('الاسم اللي يظهر في الإشعارات (اختياري)')
        .setDescriptionLocalizations(englishLocalizations('Name shown in notifications (optional)'))
        .setMaxLength(64),
    );
  })
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('حذف ستريمر، أو حذف حساب منصة وحدة منه')
      .setDescriptionLocalizations(englishLocalizations('Remove a streamer, or just one of their platform accounts'))
      .addUserOption((o) => o.setName('user').setDescription('العضو').setDescriptionLocalizations(englishLocalizations('The member')).setRequired(true))
      .addStringOption((o) =>
        o
          .setName('platform')
          .setDescription('احذف حساب هذي المنصة بس (اختياري)')
          .setDescriptionLocalizations(englishLocalizations('Only remove the account on this platform (optional)'))
          .addChoices(...PLATFORMS.map((p) => ({ name: PLATFORM_LABELS[p], value: p }))),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('list').setDescription('قائمة الستريمرز المسجلين').setDescriptionLocalizations(englishLocalizations('List the registered streamers')),
  )
  .addSubcommand((sub) =>
    sub
      .setName('info')
      .setDescription('تفاصيل ستريمر وحساباته')
      .setDescriptionLocalizations(englishLocalizations('Details of a streamer and their accounts'))
      .addUserOption((o) => o.setName('user').setDescription('العضو').setDescriptionLocalizations(englishLocalizations('The member')).setRequired(true)),
  )
  .toJSON();

// ───────────────────────────── pure builders ─────────────────────────────

function emojiText(emojis: PlatformEmojis, platform: Platform): string {
  return (emojis[platform] ?? DEFAULT_PLATFORM_EMOJIS[platform]).text;
}

function accountField(account: StreamerWithAccounts['accounts'][number], emojis: PlatformEmojis, lang: Language): APIEmbedField {
  const { channel } = account;
  const url = safeUrl(channel.url);
  const name = escapeMarkdown(cleanText(channel.displayName) || channel.handle);
  const lines = [url ? `[${name}](${url})` : name];
  if (channel.isLive) {
    const viewers = channel.liveSnapshot?.viewers;
    lines.push(`${ti(lang, 'streamer.account.liveNow')}${viewers != null ? ` — ${ICONS.viewers} ${formatNumber(viewers)}` : ''}`);
  } else {
    const checked = discordTimestamp(channel.lastLiveCheckAt, 'R');
    lines.push(checked ? ti(lang, 'streamer.account.lastCheck', { when: checked }) : ti(lang, 'streamer.account.neverChecked'));
  }
  lines.push(ti(lang, 'streamer.account.notify', { live: account.notifyLive ? '✅' : '❌', content: account.notifyContent ? '✅' : '❌' }));
  if (channel.lastError && channel.errorCount > 0) lines.push(`⚠️ ${escapeMarkdown(truncate(channel.lastError, 150))}`);
  return { name: `${emojiText(emojis, channel.platform)} ${PLATFORM_LABELS[channel.platform]}`, value: truncate(lines.join('\n'), DISCORD_LIMITS.fieldValue), inline: true };
}

export interface StreamerCardOptions {
  live: boolean;
  emojis?: PlatformEmojis;
  stats?: { sessions: number; seconds: number; peakViewers: number } | null;
  lang?: Language;
}

/** Embed describing one streamer and their accounts (used by add/info). */
export function buildStreamerCard(streamer: StreamerWithAccounts, options: StreamerCardOptions): APIEmbed {
  const emojis = options.emojis ?? DEFAULT_PLATFORM_EMOJIS;
  const lang = options.lang ?? 'ar';
  const status = !streamer.enabled ? ti(lang, 'streamer.status.paused') : options.live ? ti(lang, 'streamer.status.live') : ti(lang, 'streamer.status.offline');
  const description = [`<@${streamer.discordUserId}> • ${status}`, streamer.notes ? `📝 ${escapeMarkdown(truncate(streamer.notes, 300))}` : '']
    .filter(Boolean)
    .join('\n');
  const fields = streamer.accounts.slice(0, 20).map((a) => accountField(a, emojis, lang));
  if (options.stats) {
    const { sessions, seconds, peakViewers } = options.stats;
    fields.push({
      name: ti(lang, 'streamer.stats.title'),
      value:
        sessions > 0
          ? ti(lang, 'streamer.stats.value', { sessions, duration: formatDurationShort(seconds, lang), peak: formatNumber(peakViewers) })
          : ti(lang, 'streamer.stats.none'),
      inline: false,
    });
  }
  const avatar = streamer.accounts.map((a) => safeUrl(a.channel.avatarUrl)).find(Boolean);
  const card: APIEmbed = {
    color: streamer.color ?? (options.live ? COLORS.live : COLORS.info),
    title: truncate(cleanText(streamer.displayName), DISCORD_LIMITS.title),
    description,
    fields,
    footer: { text: ti(lang, 'streamer.addedOn', { date: new Date(streamer.createdAt).toISOString().slice(0, 10) }) },
  };
  if (avatar) card.thumbnail = { url: avatar };
  return card;
}

/** Compact list of every streamer in a guild (fits one embed; overflow is summarized). */
export function buildStreamerList(
  streamers: StreamerWithAccounts[],
  liveIds: ReadonlySet<number>,
  emojis: PlatformEmojis = DEFAULT_PLATFORM_EMOJIS,
  lang: Language = 'ar',
): APIEmbed {
  if (streamers.length === 0) {
    return embed(COLORS.info, ti(lang, 'streamer.list.empty.title'), ti(lang, 'streamer.list.empty.body'));
  }
  const sorted = [...streamers].sort(
    (a, b) => Number(liveIds.has(b.id)) - Number(liveIds.has(a.id)) || Number(b.enabled) - Number(a.enabled) || a.displayName.localeCompare(b.displayName),
  );
  const budget = DISCORD_LIMITS.description - 80;
  const lines: string[] = [];
  let length = 0;
  for (const s of sorted) {
    const status = !s.enabled ? '⏸️' : liveIds.has(s.id) ? ICONS.live : ICONS.ended;
    const accounts =
      s.accounts.map((a) => `${emojiText(emojis, a.channel.platform)} ${escapeMarkdown(a.channel.handle)}`).join(' • ') || ti(lang, 'streamer.list.noAccounts');
    const line = `${status} **${escapeMarkdown(s.displayName)}** <@${s.discordUserId}> — ${accounts}`;
    if (length + line.length + 1 > budget) break;
    lines.push(line);
    length += line.length + 1;
  }
  if (lines.length < sorted.length) lines.push(ti(lang, 'streamer.list.more', { count: sorted.length - lines.length }));
  const live = streamers.filter((s) => liveIds.has(s.id)).length;
  const result = embed(COLORS.info, ti(lang, 'streamer.list.title', { count: streamers.length }), lines.join('\n'));
  result.footer = { text: ti(lang, 'streamer.list.liveFooter', { count: live }) };
  return result;
}

// ───────────────────────────── handlers ─────────────────────────────

function registered(env: CommandEnv, guildId: string, userId: string, lang: Language): StreamerWithAccounts {
  const existing = env.services.repos.streamers.getByDiscordId(guildId, userId);
  if (!existing) throw new ValidationError(ti(lang, 'streamer.notRegistered'));
  return env.services.streamers.get(guildId, existing.id);
}

function isLive(env: CommandEnv, streamerId: number): boolean {
  return env.services.repos.sessions.getActive(streamerId) !== null;
}

async function add(interaction: GuildCommandInteraction, env: CommandEnv, lang: Language): Promise<void> {
  const { guildId } = interaction;
  const user = interaction.options.getUser('user', true);
  if (user.bot) throw new ValidationError(ti(lang, 'streamer.noBots'));
  const accounts: AccountInput[] = PLATFORMS.flatMap((platform) => {
    const input = interaction.options.getString(platform)?.trim();
    return input ? [{ platform, input }] : [];
  });
  const displayName = interaction.options.getString('name')?.trim() || undefined;
  const actor = actorOf(interaction);
  const { streamers, repos } = env.services;
  const emojis = env.emojis();

  const existing = repos.streamers.getByDiscordId(guildId, user.id);
  if (!existing) {
    if (accounts.length === 0) throw new ValidationError(ti(lang, 'streamer.needAccount'));
    const created = await streamers.create(guildId, { discordUserId: user.id, displayName, accounts }, actor);
    await respond(interaction, {
      embeds: [successEmbed(ti(lang, 'streamer.created', { name: cleanText(created.displayName) })), buildStreamerCard(created, { live: false, emojis, lang })],
    });
    return;
  }

  if (accounts.length === 0 && !displayName) throw new ValidationError(ti(lang, 'streamer.alreadyRegistered'));
  const results: string[] = [];
  if (displayName) {
    await streamers.update(guildId, existing.id, { displayName }, actor);
    results.push(ti(lang, 'streamer.renamed', { name: escapeMarkdown(displayName) }));
  }
  // One by one so a bad account doesn't block the others; each result is reported.
  for (const account of accounts) {
    const label = `${emojiText(emojis, account.platform)} ${PLATFORM_LABELS[account.platform]}`;
    try {
      await streamers.addAccount(guildId, existing.id, account, actor);
      results.push(ti(lang, 'streamer.accountAdded', { label }));
    } catch (err) {
      results.push(ti(lang, 'streamer.accountFailed', { label, error: friendlyError(err, lang) }));
    }
  }
  const current = streamers.get(guildId, existing.id);
  const allFailed = results.every((r) => r.startsWith('❌'));
  await respond(interaction, {
    embeds: [
      embed(allFailed ? COLORS.error : COLORS.success, ti(lang, 'streamer.updated', { name: cleanText(current.displayName) }), results.join('\n')),
      buildStreamerCard(current, { live: isLive(env, current.id), emojis, lang }),
    ],
  });
}

async function remove(interaction: GuildCommandInteraction, env: CommandEnv, lang: Language): Promise<void> {
  const { guildId } = interaction;
  const user = interaction.options.getUser('user', true);
  const streamer = registered(env, guildId, user.id, lang);
  const platformOption = interaction.options.getString('platform');
  const actor = actorOf(interaction);
  const name = cleanText(streamer.displayName);

  if (!platformOption) {
    await env.services.streamers.delete(guildId, streamer.id, actor);
    await respond(interaction, { embeds: [successEmbed(ti(lang, 'streamer.deleted', { name }))] });
    return;
  }
  if (!isPlatform(platformOption)) throw new ValidationError(ti(lang, 'streamer.unknownPlatform'));
  const accounts = streamer.accounts.filter((a) => a.channel.platform === platformOption);
  const platform = PLATFORM_LABELS[platformOption];
  if (accounts.length === 0) throw new ValidationError(ti(lang, 'streamer.noAccountOn', { name, platform }));
  let current = streamer;
  for (const account of accounts) current = await env.services.streamers.removeAccount(guildId, streamer.id, account.id, actor);
  const note = current.accounts.length === 0 ? ti(lang, 'streamer.noAccountsLeft') : undefined;
  await respond(interaction, { embeds: [successEmbed(ti(lang, 'streamer.accountRemoved', { platform, name }), note)] });
}

async function list(interaction: GuildCommandInteraction, env: CommandEnv, lang: Language): Promise<void> {
  const { guildId } = interaction;
  const streamers = env.services.streamers.list(guildId);
  const liveIds = new Set(env.services.repos.sessions.listActive(guildId).map((s) => s.streamerId));
  await respond(interaction, { embeds: [buildStreamerList(streamers, liveIds, env.emojis(), lang)] });
}

async function info(interaction: GuildCommandInteraction, env: CommandEnv, lang: Language): Promise<void> {
  const { guildId } = interaction;
  const user = interaction.options.getUser('user', true);
  const streamer = registered(env, guildId, user.id, lang);
  const since = new Date(env.clock() - 30 * 24 * 3600_000).toISOString();
  const stats = env.services.repos.sessions.totals(guildId, since).find((t) => t.streamerId === streamer.id) ?? { sessions: 0, seconds: 0, peakViewers: 0 };
  await respond(interaction, { embeds: [buildStreamerCard(streamer, { live: isLive(env, streamer.id), emojis: env.emojis(), stats, lang })] });
}

export const streamerCommand: SlashCommand = {
  data,
  defer: 'ephemeral',
  async execute(interaction, env, lang) {
    switch (interaction.options.getSubcommand(true)) {
      case 'add':
        return add(interaction, env, lang);
      case 'remove':
        return remove(interaction, env, lang);
      case 'list':
        return list(interaction, env, lang);
      case 'info':
        return info(interaction, env, lang);
      default:
        throw new ValidationError(ti(lang, 'common.unknownCommand'));
    }
  },
};
