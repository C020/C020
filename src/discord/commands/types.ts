import type { ChatInputCommandInteraction, RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js';
import type { DiscordServices } from '../../app/context.js';
import type { Language, PanelKind } from '../../db/models.js';
import type { DiscordGateway, MessageRef } from '../../services/ports.js';
import type { PlatformEmojis } from '../emojis.js';

/** Services available to slash commands (v2 services are optional: commands explain when one is missing). */
export type CommandServices = DiscordServices;

/** Everything a command handler may use; built by DiscordService once services are attached. */
export interface CommandEnv {
  services: CommandServices;
  gateway: DiscordGateway;
  sendTest(guildId: string, type: 'live' | 'summary' | 'content'): Promise<MessageRef | null>;
  /** Post or refresh an interactive panel (#1 notify / #9 apply). Throws ValidationError in the guild language. */
  postPanel(guildId: string, kind: PanelKind): Promise<MessageRef>;
  messageUrl(guildId: string, ref: MessageRef): string;
  emojis(): PlatformEmojis;
  /** Gateway heartbeat latency in ms (-1 when unknown). */
  wsPing(): number;
  startedAt: number;
  clock(): number;
}

export type GuildCommandInteraction = ChatInputCommandInteraction<'cached' | 'raw'>;

export interface SlashCommand {
  data: RESTPostAPIChatInputApplicationCommandsJSONBody;
  /** Slow commands are deferred before running (ephemeral or public). */
  defer: 'ephemeral' | 'public' | ((interaction: GuildCommandInteraction) => 'ephemeral' | 'public' | null) | null;
  /** `lang` is the guild language (#16): every reply uses it. */
  execute(interaction: GuildCommandInteraction, env: CommandEnv, lang: Language): Promise<void>;
}

/** Audit actor for slash command invocations. */
export function actorOf(interaction: { user: { id: string } }): string {
  return `user:${interaction.user.id}`;
}
