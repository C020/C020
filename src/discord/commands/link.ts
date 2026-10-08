/**
 * #11 — /link and /unlink: optional official account linking (Twitch / TikTok OAuth) for members who want it.
 * Usable by everyone; replies are ephemeral because the link is personal (signed for this member, 15 minutes).
 */
import { ButtonStyle, ComponentType, InteractionContextType, SlashCommandBuilder, type SlashCommandStringOption } from 'discord.js';
import { ValidationError } from '../../core/errors.js';
import { PLATFORM_LABELS } from '../../core/types.js';
import type { Language, LinkPlatform } from '../../db/models.js';
import { cleanText, escapeMarkdown, safeUrl, truncate } from '../format.js';
import { englishLocalizations, ti } from '../i18n/interactions.js';
import type { LinkButtonRow } from '../messages.js';
import { COLORS, embed, respond, successEmbed } from './replies.js';
import { actorOf, type CommandEnv, type GuildCommandInteraction, type SlashCommand } from './types.js';

export const LINK_PLATFORMS = ['twitch', 'tiktok'] as const satisfies readonly LinkPlatform[];

const platformOption = (description: { ar: string; en: string }) => (o: SlashCommandStringOption) =>
  o
    .setName('platform')
    .setDescription(description.ar)
    .setDescriptionLocalizations(englishLocalizations(description.en))
    .setRequired(true)
    .addChoices(...LINK_PLATFORMS.map((p) => ({ name: PLATFORM_LABELS[p], value: p })));

function parsePlatform(value: string, lang: Language): LinkPlatform {
  if (!(LINK_PLATFORMS as readonly string[]).includes(value)) throw new ValidationError(ti(lang, 'streamer.unknownPlatform'));
  return value as LinkPlatform;
}

/** Feature switch + service availability; throws ValidationError explaining what is missing. */
function linkService(env: CommandEnv, guildId: string, lang: Language) {
  const settings = env.services.repos.settings.get(guildId);
  if (!settings.features.linking.enabled) throw new ValidationError(ti(lang, 'link.disabled'));
  const links = env.services.links;
  if (!links) throw new ValidationError(ti(lang, 'common.unavailable'));
  return links;
}

/** Pure builder of the /link reply: explanation + one link button to the signed start URL. */
export function buildLinkReply(platform: LinkPlatform, url: string, lang: Language, currentLogin: string | null): { embeds: ReturnType<typeof embed>[]; components: LinkButtonRow[] } {
  const label = PLATFORM_LABELS[platform];
  const lines = [ti(lang, 'link.body', { platform: label })];
  if (currentLogin) lines.push('', ti(lang, 'link.current', { login: escapeMarkdown(truncate(cleanText(currentLogin), 80)) }));
  lines.push('', ti(lang, 'link.optional'));
  return {
    embeds: [embed(COLORS.info, ti(lang, 'link.title', { platform: label }), lines.join('\n'))],
    components: [
      {
        type: ComponentType.ActionRow,
        components: [{ type: ComponentType.Button, style: ButtonStyle.Link, url, label: ti(lang, 'link.button', { platform: label }), emoji: { name: '🔗' } }],
      },
    ],
  };
}

export const linkCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('link')
    .setDescription('اربط حسابك الرسمي في تويتش أو تيك توك (اختياري)')
    .setDescriptionLocalizations(englishLocalizations('Link your official Twitch or TikTok account (optional)'))
    .setContexts(InteractionContextType.Guild)
    .addStringOption(platformOption({ ar: 'المنصة', en: 'Platform' }))
    .toJSON(),
  defer: 'ephemeral',
  async execute(interaction: GuildCommandInteraction, env, lang) {
    const platform = parsePlatform(interaction.options.getString('platform', true), lang);
    const links = linkService(env, interaction.guildId, lang);
    if (!links.isAvailable(platform)) throw new ValidationError(ti(lang, 'link.unavailable', { platform: PLATFORM_LABELS[platform] }));
    const url = safeUrl(links.startUrl(interaction.guildId, interaction.user.id, platform), 512);
    if (!url) throw new ValidationError(ti(lang, 'link.unavailable', { platform: PLATFORM_LABELS[platform] }));
    const current = links.linksFor(interaction.user.id).find((l) => l.platform === platform);
    const currentLogin = current ? (current.platformLogin ?? current.displayName ?? current.platformUserId) : null;
    await respond(interaction, buildLinkReply(platform, url, lang, currentLogin));
  },
};

export const unlinkCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('unlink')
    .setDescription('فك ربط حسابك الرسمي في تويتش أو تيك توك')
    .setDescriptionLocalizations(englishLocalizations('Unlink your official Twitch or TikTok account'))
    .setContexts(InteractionContextType.Guild)
    .addStringOption(platformOption({ ar: 'المنصة', en: 'Platform' }))
    .toJSON(),
  defer: 'ephemeral',
  async execute(interaction: GuildCommandInteraction, env, lang) {
    const platform = parsePlatform(interaction.options.getString('platform', true), lang);
    // Unlinking stays possible after the feature was turned off: members must always be able to remove their data.
    const links = env.services.links;
    if (!links) throw new ValidationError(ti(lang, 'common.unavailable'));
    const removed = await links.unlink(interaction.user.id, platform, actorOf(interaction));
    const label = PLATFORM_LABELS[platform];
    if (!removed) {
      await respond(interaction, { embeds: [embed(COLORS.info, 'ℹ️', ti(lang, 'link.notLinked', { platform: label }))] });
      return;
    }
    await respond(interaction, { embeds: [successEmbed(ti(lang, 'link.unlinked', { platform: label }))] });
  },
};
