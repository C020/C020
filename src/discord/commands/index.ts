/** Slash command registry and dispatcher. */
import type { ChatInputCommandInteraction, RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js';
import { MessageFlags } from 'discord.js';
import { botCommand } from './bot.js';
import { liveCommand } from './live.js';
import { embed, COLORS, respond, respondError } from './replies.js';
import { streamerCommand } from './streamer.js';
import type { CommandEnv, SlashCommand } from './types.js';

export const SLASH_COMMANDS: readonly SlashCommand[] = [liveCommand, streamerCommand, botCommand];

export function commandDefinitions(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  return SLASH_COMMANDS.map((c) => c.data);
}

/** Routes a chat-input interaction to its command. Never throws. */
export async function dispatchCommand(interaction: ChatInputCommandInteraction, env: CommandEnv | null): Promise<void> {
  const command = SLASH_COMMANDS.find((c) => c.data.name === interaction.commandName);
  if (!command) return;

  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'أوامر البوت تشتغل داخل السيرفر بس', flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  if (!env) {
    await respond(interaction, { embeds: [embed(COLORS.warn, '⏳ البوت لسا يجهز', 'جرّب بعد ثواني')] });
    return;
  }

  try {
    const mode = typeof command.defer === 'function' ? command.defer(interaction) : command.defer;
    if (mode) await interaction.deferReply(mode === 'ephemeral' ? { flags: MessageFlags.Ephemeral } : {});
    await command.execute(interaction, env);
  } catch (err) {
    await respondError(interaction, err);
  }
}

export type { CommandEnv, CommandServices, SlashCommand } from './types.js';
