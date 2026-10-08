/**
 * The I/O boundary for sending/editing messages. The notifier depends on `MessageTransport` only, so its
 * decision logic (fallbacks, warnings, retries) is testable without Discord; `DiscordTransport` is the real
 * implementation on top of discord.js.
 */
import type { Client, GuildBasedChannel, GuildMember, SendableChannels } from 'discord.js';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { childLogger } from '../core/logger.js';
import type { MessageRef } from '../services/ports.js';
import { classifyDiscordError, describeDiscordError } from './apiErrors.js';
import type { MessageFile } from './attachments.js';
import type { AllowedMentions } from './mentions.js';
import type { MessageContent } from './messages.js';
import { missingPostingPermissions, type PermissionName } from './permissions.js';
import { isSnowflake } from './util.js';

const log = childLogger('discord.transport');

export interface OutgoingMessage extends MessageContent {
  allowedMentions: AllowedMentions;
  /**
   * Files uploaded with the message (referenced from embeds as attachment://name). An edit always replaces the
   * message's attachments with these (none when omitted), so a re-rendered summary never piles up old uploads.
   */
  files?: MessageFile[];
  /**
   * #10 — send without a push/sound notification (Discord "silent" message, flag SuppressNotifications). Only
   * applies to NEW messages: edits never pass flags.
   */
  silent?: boolean;
}

export type TransportFailure =
  /** Gateway not connected yet. */
  | 'not_ready'
  /** Channel id unknown / deleted / not visible to the bot at all. */
  | 'channel_missing'
  /** The channel belongs to another guild (misconfiguration). */
  | 'wrong_guild'
  /** Not a channel messages can be posted in. */
  | 'not_text'
  /** Missing permissions (pre-checked or reported by Discord). */
  | 'forbidden'
  /** The message to edit no longer exists. */
  | 'gone'
  /** Discord rejected the payload. */
  | 'invalid'
  /** Network / 5xx / unknown. */
  | 'error';

export type TransportResult =
  | { ok: true; ref: MessageRef }
  | { ok: false; reason: TransportFailure; detail: string; missing?: PermissionName[]; channelName?: string };

export interface MessageTransport {
  send(guildId: string, channelId: string, message: OutgoingMessage): Promise<TransportResult>;
  edit(guildId: string, ref: MessageRef, message: OutgoingMessage): Promise<TransportResult>;
}

type Resolved = { ok: true; channel: SendableChannels & GuildBasedChannel } | Extract<TransportResult, { ok: false }>;

function failure(reason: TransportFailure, detail: string, extra: { missing?: PermissionName[]; channelName?: string } = {}): Extract<TransportResult, { ok: false }> {
  return { ok: false, reason, detail, ...extra };
}

function fromError(err: unknown, forEdit: boolean, channelName?: string): Extract<TransportResult, { ok: false }> {
  const detail = describeDiscordError(err);
  switch (classifyDiscordError(err)) {
    case 'unknown_message':
      return failure(forEdit ? 'gone' : 'error', detail, { channelName });
    case 'unknown_channel':
      return failure('channel_missing', detail, { channelName });
    case 'forbidden':
      return failure('forbidden', detail, { channelName });
    case 'invalid':
      return failure('invalid', detail, { channelName });
    default:
      return failure('error', detail, { channelName });
  }
}

function uploads(files: MessageFile[]): Array<{ attachment: Buffer; name: string }> {
  return files.map((f) => ({ attachment: f.data, name: f.name }));
}

export class DiscordTransport implements MessageTransport {
  constructor(private readonly getClient: () => Client | null) {}

  async send(guildId: string, channelId: string, message: OutgoingMessage): Promise<TransportResult> {
    const resolved = await this.resolve(guildId, channelId, { precheck: true, files: !!message.files?.length });
    if (!resolved.ok) return resolved;
    try {
      const sent = await resolved.channel.send({
        content: message.content || undefined,
        embeds: message.embeds,
        components: message.components,
        ...(message.files?.length ? { files: uploads(message.files) } : {}),
        ...(message.silent ? { flags: MessageFlags.SuppressNotifications as const } : {}),
        allowedMentions: message.allowedMentions,
      });
      return { ok: true, ref: { channelId: sent.channelId, messageId: sent.id } };
    } catch (err) {
      return fromError(err, false, resolved.channel.name);
    }
  }

  async edit(guildId: string, ref: MessageRef, message: OutgoingMessage): Promise<TransportResult> {
    if (!isSnowflake(ref.messageId)) return failure('gone', `invalid message id ${ref.messageId}`);
    // Editing our own message needs no send permission, so only resolve the channel (no posting pre-check).
    const resolved = await this.resolve(guildId, ref.channelId, { precheck: false, files: !!message.files?.length });
    if (!resolved.ok) return resolved;
    try {
      // `content` is always sent so an edit can also clear old text (e.g. the ping when turning into a summary),
      // and allowedMentions is explicit because Discord re-parses mentions on edit. `attachments: []` drops earlier
      // uploads (a fresh array each time: discord.js appends the new files to it). Flags (silent) are never sent on
      // edits: SuppressNotifications only exists for new messages.
      const edited = await resolved.channel.messages.edit(ref.messageId, {
        content: message.content,
        embeds: message.embeds,
        components: message.components,
        attachments: [],
        ...(message.files?.length ? { files: uploads(message.files) } : {}),
        allowedMentions: message.allowedMentions,
      });
      return { ok: true, ref: { channelId: edited.channelId, messageId: edited.id } };
    } catch (err) {
      return fromError(err, true, resolved.channel.name);
    }
  }

  /** `precheck`: posting permissions; `files`: Attach Files (checked for edits too, uploads need it either way). */
  private async resolve(guildId: string, channelId: string, opts: { precheck: boolean; files?: boolean }): Promise<Resolved> {
    const client = this.getClient();
    if (!client?.isReady()) return failure('not_ready', 'Discord client is not ready');
    if (!isSnowflake(channelId)) return failure('channel_missing', `invalid channel id ${channelId}`);

    let channel;
    try {
      channel = client.channels.cache.get(channelId) ?? (await client.channels.fetch(channelId));
    } catch (err) {
      const result = fromError(err, false);
      // A 403 on fetch means the bot cannot see the channel at all: treat like a missing channel for messaging.
      return result.reason === 'forbidden' ? failure('forbidden', result.detail) : result.reason === 'error' ? result : failure('channel_missing', result.detail);
    }
    if (!channel) return failure('channel_missing', `channel ${channelId} not found`);
    if (channel.isDMBased()) return failure('wrong_guild', `channel ${channelId} is a DM channel`);
    if (channel.guildId !== guildId) return failure('wrong_guild', `channel ${channelId} belongs to guild ${channel.guildId}`);
    if (!channel.isTextBased() || !channel.isSendable()) return failure('not_text', `channel ${channelId} is not text based`, { channelName: channel.name });

    if (opts.precheck || opts.files) {
      const me: GuildMember | null = channel.guild.members.me;
      const perms = me ? channel.permissionsFor(me) : null;
      if (perms) {
        const missing: PermissionName[] = opts.precheck ? missingPostingPermissions((flag) => perms.has(flag), channel.isThread()) : [];
        if (opts.files && !perms.has(PermissionFlagsBits.AttachFiles)) missing.push('AttachFiles');
        if (missing.length > 0) return failure('forbidden', `missing ${missing.join(', ')}`, { missing, channelName: channel.name });
      } else {
        log.debug({ guildId, channelId }, 'Bot member not cached; skipping permission pre-check');
      }
    }
    return { ok: true, channel: channel as SendableChannels & GuildBasedChannel };
  }
}
