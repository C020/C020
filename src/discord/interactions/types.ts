/**
 * Shapes shared by the button/modal handlers. Handlers depend on these narrow structural types instead of the
 * discord.js classes, so they are unit-tested with plain fakes; DiscordService passes the real interactions in.
 */
import type {
  APIActionRowComponent,
  APIComponentInMessageActionRow,
  APIEmbed,
  APIModalInteractionResponseCallbackData,
} from 'discord.js';
import type { DiscordServices } from '../../app/context.js';
import type { GuildSettings, StreamerApplication } from '../../db/models.js';
import type { MessageRef } from '../../services/ports.js';
import type { PlatformEmojis } from '../emojis.js';
import type { AllowedMentions } from '../mentions.js';
import type { ToggleRoleResult } from '../roles.js';

/** A message action row (buttons / selects), as raw API JSON. */
export type MessageRow = APIActionRowComponent<APIComponentInMessageActionRow>;

/** Message with interactive components (panels, review messages). Never pings anyone. */
export interface InteractiveMessage {
  content: string;
  embeds: APIEmbed[];
  components: MessageRow[];
}

export interface InteractionReplyPayload {
  content?: string;
  embeds?: APIEmbed[];
  components?: MessageRow[];
}

/** What handlers send through reply()/editReply(); a subset of discord.js' reply options. */
export interface InteractionSendOptions extends InteractionReplyPayload {
  flags?: number;
  allowedMentions?: AllowedMentions;
}

/** The parts of a discord.js ButtonInteraction / ModalSubmitInteraction the handlers use. */
export interface ComponentInteraction {
  readonly customId: string;
  readonly guildId: string | null;
  readonly user: { id: string; username: string; globalName?: string | null; bot?: boolean };
  /** GuildMember (cached guilds) or the raw API member; only used for the display name. */
  readonly member?: unknown;
  /** Permissions of the member in the channel (null outside guilds). */
  readonly memberPermissions: { has(permission: bigint): boolean } | null;
  readonly deferred: boolean;
  readonly replied: boolean;
  inGuild(): boolean;
  isButton(): boolean;
  isModalSubmit(): boolean;
  reply(options: InteractionSendOptions): Promise<unknown>;
  deferReply(options?: { flags?: number }): Promise<unknown>;
  editReply(options: InteractionSendOptions): Promise<unknown>;
  /** Buttons only (a modal submit cannot open another modal). */
  showModal?(modal: APIModalInteractionResponseCallbackData): Promise<unknown>;
  /** Modal submits only. */
  readonly fields?: { getTextInputValue(customId: string): string };
}

/** Everything the interaction handlers may use; built by DiscordService once services are attached. */
export interface InteractionEnv {
  services: DiscordServices;
  /** #1 — toggles a role on a member (DiscordRoles.toggleMemberRole). */
  toggleRole(guildId: string, userId: string, roleId: string, reason: string): Promise<ToggleRoleResult>;
  /** #9 — posts/refreshes the reviewers' message (idempotent). */
  upsertApplicationReview(application: StreamerApplication, settings: GuildSettings): Promise<MessageRef | null>;
  emojis(): PlatformEmojis;
  clock(): number;
}
