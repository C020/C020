/**
 * #14 — /post url [title] [streamer]: manual posting of a clip/VOD link (optional feature; automatic detection
 * stays the default). Manage Server by default; gated by features.manualPosts.enabled.
 */
import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { ValidationError } from '../../core/errors.js';
import { PLATFORM_LABELS } from '../../core/types.js';
import type { Language } from '../../db/models.js';
import type { ManualPostPreview } from '../../app/context.js';
import type { MessageRef } from '../../services/ports.js';
import { DEFAULT_PLATFORM_EMOJIS, type PlatformEmojis } from '../emojis.js';
import { cleanText, escapeMarkdown, truncate } from '../format.js';
import { CONTENT_KIND_LABELS, englishLocalizations, ti } from '../i18n/interactions.js';
import { COLORS, embed, type ReplyPayload, respond, successEmbed } from './replies.js';
import { actorOf, type SlashCommand } from './types.js';

export const POST_URL_MAX = 500;
export const POST_TITLE_MAX = 200;

/** Pure builder of the /post result. */
export function buildPostReply(
  preview: Pick<ManualPostPreview, 'platform' | 'kind' | 'title' | 'url'> & { streamerName: string | null },
  ref: MessageRef | null,
  messageUrl: string | null,
  lang: Language,
  emojis: PlatformEmojis = DEFAULT_PLATFORM_EMOJIS,
): ReplyPayload {
  if (!ref) return { embeds: [embed(COLORS.warn, '⚠️', ti(lang, 'post.notPosted'))] };
  const emoji = (emojis[preview.platform] ?? DEFAULT_PLATFORM_EMOJIS[preview.platform]).text;
  const head = [`${emoji} **${PLATFORM_LABELS[preview.platform]}**`, CONTENT_KIND_LABELS[lang][preview.kind]];
  if (preview.streamerName) head.push(escapeMarkdown(preview.streamerName));
  const lines = [head.join(' • ')];
  const title = cleanText(preview.title);
  if (title) lines.push(escapeMarkdown(truncate(title, 200)));
  if (messageUrl) lines.push(`[${ti(lang, 'common.openMessage')}](${messageUrl})`);
  return { embeds: [successEmbed(ti(lang, 'post.posted'), lines.join('\n'))] };
}

export const postCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('post')
    .setDescription('نشر مقطع يدوي برابط (كليب أو إعادة بث أو فيديو)')
    .setDescriptionLocalizations(englishLocalizations('Manually post a clip, VOD or video by link'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) =>
      o
        .setName('url')
        .setDescription('رابط المقطع (كيك، تويتش، يوتيوب، تيك توك)')
        .setDescriptionLocalizations(englishLocalizations('Link of the clip/video (Kick, Twitch, YouTube, TikTok)'))
        .setRequired(true)
        .setMaxLength(POST_URL_MAX),
    )
    .addStringOption((o) =>
      o
        .setName('title')
        .setDescription('عنوان المقطع (اختياري)')
        .setDescriptionLocalizations(englishLocalizations('Title (optional)'))
        .setMaxLength(POST_TITLE_MAX),
    )
    .addUserOption((o) =>
      o
        .setName('streamer')
        .setDescription('الستريمر صاحب المقطع (اختياري — يتعرف عليه البوت من الرابط لو قدر)')
        .setDescriptionLocalizations(englishLocalizations('Streamer who owns it (optional — detected from the link when possible)')),
    )
    .toJSON(),
  // inspect() may call oEmbed endpoints: always defer.
  defer: 'ephemeral',
  async execute(interaction, env, lang) {
    const { guildId } = interaction;
    const { repos, manualPosts } = env.services;
    if (!repos.settings.get(guildId).features.manualPosts.enabled) throw new ValidationError(ti(lang, 'post.disabled'));
    if (!manualPosts) throw new ValidationError(ti(lang, 'common.unavailable'));

    const url = interaction.options.getString('url', true).trim();
    const title = interaction.options.getString('title')?.trim() || null;
    const user = interaction.options.getUser('streamer');
    let streamerId: number | null = null;
    let streamerName: string | null = null;
    if (user) {
      const streamer = repos.streamers.getByDiscordId(guildId, user.id);
      if (!streamer) throw new ValidationError(ti(lang, 'post.streamerNotRegistered', { user: `<@${user.id}>` }));
      streamerId = streamer.id;
      streamerName = streamer.displayName;
    }

    const preview = await manualPosts.inspect(guildId, url);
    if (preview.alreadyPosted) throw new ValidationError(ti(lang, 'post.alreadyPosted'));
    const result = await manualPosts.post(guildId, { url, title, streamerId }, actorOf(interaction));
    const ref = result.messageRef;
    await respond(
      interaction,
      buildPostReply(
        { platform: preview.platform, kind: preview.kind, title: title ?? preview.title, url: preview.url, streamerName: streamerName ?? preview.streamer?.displayName ?? null },
        ref,
        ref ? env.messageUrl(guildId, ref) : null,
        lang,
        env.emojis(),
      ),
    );
  },
};
