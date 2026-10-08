/** Slash command registry and dispatcher. */
import type { ChatInputCommandInteraction, RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js';
import { MessageFlags } from 'discord.js';
import type { Language } from '../../db/models.js';
import { guildLanguage, ti } from '../i18n/interactions.js';
import { botCommand } from './bot.js';
import { linkCommand, unlinkCommand } from './link.js';
import { liveCommand } from './live.js';
import { postCommand } from './post.js';
import { embed, COLORS, respond, respondError } from './replies.js';
import { streamerCommand } from './streamer.js';
import type { CommandEnv, SlashCommand } from './types.js';

export const SLASH_COMMANDS: readonly SlashCommand[] = [liveCommand, streamerCommand, botCommand, linkCommand, unlinkCommand, postCommand];

export function commandDefinitions(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  return SLASH_COMMANDS.map((c) => c.data);
}

function languageOf(env: CommandEnv | null, guildId: string | null): Language {
  if (!env || !guildId) return 'ar';
  try {
    return guildLanguage(env.services.repos.settings.get(guildId));
  } catch {
    return 'ar';
  }
}

/** Routes a chat-input interaction to its command. Never throws. */
export async function dispatchCommand(interaction: ChatInputCommandInteraction, env: CommandEnv | null): Promise<void> {
  const command = SLASH_COMMANDS.find((c) => c.data.name === interaction.commandName);
  if (!command) return;

  if (!interaction.inGuild()) {
    await interaction.reply({ content: ti('ar', 'common.serverOnly'), flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  const lang = languageOf(env, interaction.guildId);
  if (!env) {
    await respond(interaction, { embeds: [embed(COLORS.warn, ti(lang, 'common.starting.title'), ti(lang, 'common.starting.body'))] });
    return;
  }

  try {
    const mode = typeof command.defer === 'function' ? command.defer(interaction) : command.defer;
    if (mode) await interaction.deferReply(mode === 'ephemeral' ? { flags: MessageFlags.Ephemeral } : {});
    await command.execute(interaction, env, lang);
  } catch (err) {
    await respondError(interaction, err, lang);
  }
}

export type { CommandEnv, CommandServices, SlashCommand } from './types.js';
