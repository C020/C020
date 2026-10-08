/**
 * Safe ephemeral replies for button/modal interactions. Discord gives 3 seconds for the first response and
 * 15 minutes for follow-ups; anything slower than a DB lookup defers first. Never throws: an expired or already
 * acknowledged interaction is only logged.
 */
import type { APIEmbed } from 'discord.js';
import { MessageFlags } from 'discord.js';
import { ValidationError } from '../../core/errors.js';
import { childLogger } from '../../core/logger.js';
import type { Language } from '../../db/models.js';
import { describeDiscordError } from '../apiErrors.js';
import { COLORS, embed, friendlyError } from '../commands/replies.js';
import { silentMentions } from '../mentions.js';
import { ti } from '../i18n/interactions.js';
import type { ComponentInteraction, InteractionReplyPayload } from './types.js';

const log = childLogger('discord.interactions');

/** Acknowledges with an ephemeral "thinking…" state. Returns false when the interaction could not be deferred. */
export async function deferEphemeral(interaction: ComponentInteraction): Promise<boolean> {
  if (interaction.deferred || interaction.replied) return true;
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    return true;
  } catch (err) {
    log.warn({ err: describeDiscordError(err), customId: interaction.customId }, 'Could not defer interaction');
    return false;
  }
}

/** Replies ephemerally, or edits the deferred reply. */
export async function replyEphemeral(interaction: ComponentInteraction, payload: InteractionReplyPayload): Promise<void> {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({
        content: payload.content ?? '',
        embeds: payload.embeds ?? [],
        components: payload.components ?? [],
        allowedMentions: silentMentions(),
      });
      return;
    }
    await interaction.reply({
      ...(payload.content ? { content: payload.content } : {}),
      embeds: payload.embeds ?? [],
      components: payload.components ?? [],
      allowedMentions: silentMentions(),
      flags: MessageFlags.Ephemeral,
    });
  } catch (err) {
    log.warn({ err: describeDiscordError(err), customId: interaction.customId }, 'Could not reply to interaction');
  }
}

export function warnEmbed(description: string, title?: string): APIEmbed {
  return embed(COLORS.warn, title ?? '⚠️', description);
}

export function failureEmbed(description: string, lang: Language): APIEmbed {
  return embed(COLORS.error, ti(lang, 'common.failed.title'), description);
}

/** Ephemeral error reply; unexpected errors are logged and shown as a generic message. */
export async function replyError(interaction: ComponentInteraction, err: unknown, lang: Language): Promise<void> {
  if (!(err instanceof ValidationError)) log.error({ err, customId: interaction.customId }, 'Interaction handler failed');
  await replyEphemeral(interaction, { embeds: [failureEmbed(friendlyError(err, lang), lang)] });
}

/** Display name for audit/application texts: server nickname, global name, then username. */
export function memberDisplayName(interaction: Pick<ComponentInteraction, 'member' | 'user'>): string {
  const member = interaction.member as { displayName?: unknown; nick?: unknown } | null | undefined;
  const candidates = [member?.displayName, member?.nick, interaction.user.globalName, interaction.user.username];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, 100);
  }
  return interaction.user.id;
}
