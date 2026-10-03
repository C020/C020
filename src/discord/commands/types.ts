import type { ChatInputCommandInteraction, RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js';
import type { SessionServiceApi, StreamerServiceApi } from '../../app/context.js';
import type { Repositories } from '../../db/repositories.js';
import type { AuditService } from '../../services/audit.js';
import type { DiscordGateway, MessageRef } from '../../services/ports.js';
import type { PlatformEmojis } from '../emojis.js';

export interface CommandServices {
  streamers: StreamerServiceApi;
  sessions: SessionServiceApi;
  repos: Repositories;
  audit: AuditService;
}

/** Everything a command handler may use; built by DiscordService once services are attached. */
export interface CommandEnv {
  services: CommandServices;
  gateway: DiscordGateway;
  sendTest(guildId: string, type: 'live' | 'summary' | 'content'): Promise<MessageRef | null>;
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
  execute(interaction: GuildCommandInteraction, env: CommandEnv): Promise<void>;
}

/** Audit actor for slash command invocations. */
export function actorOf(interaction: { user: { id: string } }): string {
  return `user:${interaction.user.id}`;
}
