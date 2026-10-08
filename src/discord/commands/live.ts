/** /live — public list of who is streaming right now, with links. */
import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { PLATFORM_LABELS } from '../../core/types.js';
import type { Language } from '../../db/models.js';
import type { LiveView } from '../../services/ports.js';
import { DEFAULT_PLATFORM_EMOJIS, ICONS, type PlatformEmojis } from '../emojis.js';
import { cleanText, discordTimestamp, escapeMarkdown, formatNumber, truncate } from '../format.js';
import { englishLocalizations, ti } from '../i18n/interactions.js';
import { linkButtonRows, watchUrl } from '../messages.js';
import { DISCORD_LIMITS } from '../templates.js';
import { COLORS, embed, type ReplyPayload, respond } from './replies.js';
import type { SlashCommand } from './types.js';

const BLOCK_SEPARATOR = '\n\n';

function streamerBlock(view: LiveView, emojis: PlatformEmojis): string {
  const since = discordTimestamp(view.session.startedAt, 'R');
  const header = `${ICONS.live} **${escapeMarkdown(view.streamer.displayName)}**${since ? ` • ${since}` : ''}`;
  const platforms = view.platforms
    .map((p) => {
      const url = watchUrl(p);
      const label = PLATFORM_LABELS[p.platform];
      const link = url ? `[${label}](${url})` : label;
      const viewers = p.snapshot.viewers != null ? ` ${ICONS.viewers} ${formatNumber(p.snapshot.viewers)}` : '';
      return `${(emojis[p.platform] ?? DEFAULT_PLATFORM_EMOJIS[p.platform]).text} ${link}${viewers}`;
    })
    .join(' • ');
  const primary = view.platforms[0];
  const game = cleanText(primary?.snapshot.category);
  const title = cleanText(primary?.snapshot.title);
  const details = [game ? `${ICONS.game} ${escapeMarkdown(game)}` : '', title ? escapeMarkdown(truncate(title, 90)) : ''].filter(Boolean).join(' — ');
  return [header, platforms, details].filter(Boolean).join('\n');
}

/** Pure builder for the /live reply. */
export function buildLiveNowMessage(views: LiveView[], emojis: PlatformEmojis = DEFAULT_PLATFORM_EMOJIS, lang: Language = 'ar'): ReplyPayload {
  const live = views.filter((v) => v.platforms.length > 0).sort((a, b) => (b.totalViewers ?? -1) - (a.totalViewers ?? -1));
  if (live.length === 0) {
    return { embeds: [embed(COLORS.info, ti(lang, 'live.none.title'), ti(lang, 'live.none.body'))] };
  }

  const budget = DISCORD_LIMITS.description - 60;
  const blocks: string[] = [];
  let length = 0;
  for (const view of live) {
    const block = streamerBlock(view, emojis);
    if (length + block.length + BLOCK_SEPARATOR.length > budget) break;
    blocks.push(block);
    length += block.length + BLOCK_SEPARATOR.length;
  }
  const hidden = live.length - blocks.length;
  if (hidden > 0) blocks.push(ti(lang, 'live.more', { count: hidden }));

  const total = live.reduce((sum, v) => sum + (v.totalViewers ?? 0), 0);
  const result = embed(COLORS.live, ti(lang, 'live.title', { count: live.length }), blocks.join(BLOCK_SEPARATOR));
  if (total > 0) result.footer = { text: ti(lang, 'live.totalViewers', { count: formatNumber(total) }) };

  // With a single streamer, real buttons are nicer than inline links.
  const only = live.length === 1 ? live[0] : undefined;
  const components = only
    ? linkButtonRows(
        only.platforms.map((p) => ({
          label: ti(lang, 'live.watchOn', { platform: PLATFORM_LABELS[p.platform] }),
          url: watchUrl(p),
          emoji: (emojis[p.platform] ?? DEFAULT_PLATFORM_EMOJIS[p.platform]).component,
        })),
      )
    : [];
  return { embeds: [result], components };
}

export const liveCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('live')
    .setDescription('مين يبث الحين؟')
    .setDescriptionLocalizations(englishLocalizations('Who is live right now?'))
    .setContexts(InteractionContextType.Guild)
    .toJSON(),
  defer: null,
  async execute(interaction, env, lang) {
    const views = env.services.sessions.liveViews(interaction.guildId);
    await respond(interaction, buildLiveNowMessage(views, env.emojis(), lang), false);
  },
};
