/** Routes button clicks and modal submits (custom_id "sb:...") to their handlers. Never throws. */
import { childLogger } from '../../core/logger.js';
import type { Language } from '../../db/models.js';
import { embed, COLORS } from '../commands/replies.js';
import { guildLanguage, ti } from '../i18n/interactions.js';
import { handleApplyOpen, handleApplySubmit, handleApprove, handleReject, handleRejectReason } from './applications.js';
import { parseCustomId } from './ids.js';
import { handleNotifyToggle } from './notifyRole.js';
import { replyEphemeral, replyError, warnEmbed } from './reply.js';
import type { ComponentInteraction, InteractionEnv } from './types.js';

const log = childLogger('discord.interactions');

/** True when the interaction is one of ours (so callers can ignore foreign components cheaply). */
export function isOwnComponent(customId: string | null | undefined): boolean {
  return typeof customId === 'string' && customId.startsWith('sb:');
}

export async function dispatchComponent(interaction: ComponentInteraction, env: InteractionEnv | null): Promise<void> {
  if (!isOwnComponent(interaction.customId)) return;
  const parsed = parseCustomId(interaction.customId);
  const guildId = interaction.inGuild() ? interaction.guildId : null;
  let lang: Language = 'ar';
  try {
    if (guildId && env) lang = guildLanguage(env.services.repos.settings.get(guildId));
  } catch {
    lang = 'ar';
  }

  if (!guildId) {
    await replyEphemeral(interaction, { embeds: [warnEmbed(ti(lang, 'common.serverOnly'))] });
    return;
  }
  if (!env) {
    await replyEphemeral(interaction, { embeds: [embed(COLORS.warn, ti(lang, 'common.starting.title'), ti(lang, 'common.starting.body'))] });
    return;
  }
  if (!parsed) {
    await replyEphemeral(interaction, { embeds: [warnEmbed(ti(lang, 'common.expired'))] });
    return;
  }

  try {
    switch (parsed.action) {
      case 'notify.toggle':
        if (interaction.isButton()) return await handleNotifyToggle(interaction, env, guildId);
        break;
      case 'apply.open':
        if (interaction.isButton()) return await handleApplyOpen(interaction, env, guildId);
        break;
      case 'apply.submit':
        if (interaction.isModalSubmit()) return await handleApplySubmit(interaction, env, guildId);
        break;
      case 'apply.approve':
        if (interaction.isButton()) return await handleApprove(interaction, env, guildId, parsed.applicationId);
        break;
      case 'apply.reject':
        if (interaction.isButton()) return await handleReject(interaction, env, guildId, parsed.applicationId);
        break;
      case 'apply.rejectReason':
        if (interaction.isModalSubmit()) return await handleRejectReason(interaction, env, guildId, parsed.applicationId);
        break;
      default:
        break;
    }
    log.debug({ customId: interaction.customId }, 'Component type does not match its custom id');
    await replyEphemeral(interaction, { embeds: [warnEmbed(ti(lang, 'common.expired'))] });
  } catch (err) {
    await replyError(interaction, err, lang);
  }
}
