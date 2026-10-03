/** Reply helpers shared by the slash commands: consistent Arabic embeds and safe (silent) replies. */
import type { APIEmbed, InteractionEditReplyOptions, InteractionReplyOptions } from 'discord.js';
import { MessageFlags } from 'discord.js';
import { ValidationError } from '../../core/errors.js';
import { childLogger } from '../../core/logger.js';
import { describeDiscordError } from '../apiErrors.js';
import { truncate } from '../format.js';
import { silentMentions } from '../mentions.js';
import type { LinkButtonRow } from '../messages.js';
import { DISCORD_LIMITS } from '../templates.js';
import type { GuildCommandInteraction } from './types.js';

const log = childLogger('discord.commands');

export const COLORS = {
  success: 0x57f287,
  info: 0x5865f2,
  warn: 0xfaa61a,
  error: 0xed4245,
  live: 0xe91e63,
} as const;

export function embed(color: number, title: string, description?: string): APIEmbed {
  const out: APIEmbed = { color, title: truncate(title, DISCORD_LIMITS.title) };
  if (description) out.description = truncate(description, DISCORD_LIMITS.description);
  return out;
}

export const successEmbed = (title: string, description?: string) => embed(COLORS.success, `✅ ${title}`, description);
export const errorEmbed = (description: string) => embed(COLORS.error, '⚠️ ما تمت العملية', description);

const ARABIC_RE = /[؀-ۿ]/;
const GENERIC_ERROR = 'صار خطأ غير متوقع، جرّب بعد شوي. لو تكررت المشكلة راجع سجل البوت في لوحة التحكم';

/** User-facing text for an error: validation and Arabic messages are shown as-is, anything else is generic. */
export function friendlyError(err: unknown): string {
  if (err instanceof ValidationError) return err.message;
  if (err instanceof Error && ARABIC_RE.test(err.message)) return err.message;
  return GENERIC_ERROR;
}

export interface ReplyPayload {
  content?: string;
  embeds?: APIEmbed[];
  components?: LinkButtonRow[];
}

/** Replies or edits the deferred reply; never throws (expired interactions are only logged). */
export async function respond(interaction: GuildCommandInteraction, payload: ReplyPayload, ephemeral = true): Promise<void> {
  try {
    if (interaction.deferred || interaction.replied) {
      const edit: InteractionEditReplyOptions = {
        content: payload.content ?? '',
        embeds: payload.embeds ?? [],
        components: payload.components ?? [],
        allowedMentions: silentMentions(),
      };
      await interaction.editReply(edit);
      return;
    }
    const reply: InteractionReplyOptions = {
      content: payload.content,
      embeds: payload.embeds ?? [],
      components: payload.components ?? [],
      allowedMentions: silentMentions(),
      ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
    };
    await interaction.reply(reply);
  } catch (err) {
    log.warn({ err: describeDiscordError(err), command: interaction.commandName }, 'Could not reply to interaction');
  }
}

export async function respondError(interaction: GuildCommandInteraction, err: unknown): Promise<void> {
  if (!(err instanceof ValidationError)) log.error({ err, command: interaction.commandName }, 'Slash command failed');
  await respond(interaction, { embeds: [errorEmbed(friendlyError(err))] });
}
