/**
 * Send / edit / delete messages that carry interactive components (panels, application review messages).
 * Sending and editing reuse DiscordTransport (same channel resolution, permission pre-check and failure
 * classification as notifications); deleting is implemented here. Everything is sent with no pings at all.
 */
import type { Client } from 'discord.js';
import { childLogger } from '../../core/logger.js';
import type { MessageRef } from '../../services/ports.js';
import { classifyDiscordError, describeDiscordError } from '../apiErrors.js';
import { silentMentions } from '../mentions.js';
import type { LinkButtonRow } from '../messages.js';
import { DiscordTransport, type MessageTransport, type OutgoingMessage, type TransportResult } from '../transport.js';
import { isSnowflake } from '../util.js';
import type { InteractiveMessage } from './types.js';

const log = childLogger('discord.messenger');

export type DeleteOutcome = 'ok' | 'gone' | 'failed';

export interface InteractiveMessenger {
  send(guildId: string, channelId: string, message: InteractiveMessage): Promise<TransportResult>;
  edit(guildId: string, ref: MessageRef, message: InteractiveMessage): Promise<TransportResult>;
  delete(guildId: string, ref: MessageRef): Promise<DeleteOutcome>;
}

/** Failure reasons meaning "the message (or its channel) no longer exists". */
export const GONE_REASONS: ReadonlySet<string> = new Set(['gone', 'channel_missing', 'wrong_guild', 'not_text']);

export class DiscordInteractiveMessenger implements InteractiveMessenger {
  private readonly transport: MessageTransport;

  constructor(
    private readonly getClient: () => Client | null,
    transport?: MessageTransport,
  ) {
    this.transport = transport ?? new DiscordTransport(getClient);
  }

  send(guildId: string, channelId: string, message: InteractiveMessage): Promise<TransportResult> {
    return this.transport.send(guildId, channelId, outgoing(message));
  }

  edit(guildId: string, ref: MessageRef, message: InteractiveMessage): Promise<TransportResult> {
    return this.transport.edit(guildId, ref, outgoing(message));
  }

  async delete(guildId: string, ref: MessageRef): Promise<DeleteOutcome> {
    const client = this.getClient();
    if (!client?.isReady()) return 'failed';
    if (!isSnowflake(ref.channelId) || !isSnowflake(ref.messageId)) return 'gone';
    try {
      const channel = client.channels.cache.get(ref.channelId) ?? (await client.channels.fetch(ref.channelId));
      if (!channel || channel.isDMBased() || channel.guildId !== guildId || !channel.isTextBased()) return 'gone';
      await channel.messages.delete(ref.messageId);
      return 'ok';
    } catch (err) {
      const kind = classifyDiscordError(err);
      if (kind === 'unknown_message' || kind === 'unknown_channel') return 'gone';
      log.warn({ guildId, ref, err: describeDiscordError(err) }, 'Deleting message failed');
      return 'failed';
    }
  }
}

/**
 * The transport is typed for link-button rows only (notifications); it passes components through to discord.js
 * untouched, so interactive rows (custom_id buttons) work the same.
 */
function outgoing(message: InteractiveMessage): OutgoingMessage {
  return {
    content: message.content,
    embeds: message.embeds,
    components: message.components as unknown as LinkButtonRow[],
    allowedMentions: silentMentions(),
  };
}
