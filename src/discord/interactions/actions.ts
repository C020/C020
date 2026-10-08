/**
 * DiscordActions port (used by the v2 services): channel renames (#8 counter), direct messages (application
 * decisions), the application review message (#9) and Streaming presences (#15). Every method resolves to an
 * outcome and never throws.
 */
import type { Client, GuildBasedChannel } from 'discord.js';
import { ChannelType } from 'discord.js';
import type { StreamingActivity } from '../../app/context.js';
import { childLogger } from '../../core/logger.js';
import type { GuildSettings, StreamerApplication } from '../../db/models.js';
import type { Repositories } from '../../db/repositories.js';
import type { AuditService } from '../../services/audit.js';
import type { DiscordActions, MessageRef, RenameOutcome } from '../../services/ports.js';
import { classifyDiscordError, describeDiscordError, discordErrorCode, DiscordErrorCodes, rateLimitRetryAfterMs } from '../apiErrors.js';
import { COLORS } from '../commands/replies.js';
import { DEFAULT_PLATFORM_EMOJIS, type PlatformEmojis } from '../emojis.js';
import { truncate } from '../format.js';
import { silentMentions } from '../mentions.js';
import { missingManageChannelPermissions } from '../permissions.js';
import { DISCORD_LIMITS } from '../templates.js';
import { isSnowflake, KeyedQueue, WarnThrottle } from '../util.js';
import { buildApplicationReviewMessage } from './applications.js';
import { deliveryFailureText } from './failures.js';
import { GONE_REASONS, type InteractiveMessenger } from './messenger.js';
import type { PresenceTracker } from './presence.js';

const log = childLogger('discord.actions');

/** Discord channel names are 1-100 characters. */
export const CHANNEL_NAME_MAX = 100;
const VOICE_TYPES: ReadonlySet<ChannelType> = new Set([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);
const TEXT_TYPES: ReadonlySet<ChannelType> = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
/** Discord asks for at least this long when it does not say (rename limit: 2 per 10 minutes). */
const MIN_RETRY_AFTER_MS = 1_000;

/** Trimmed, whitespace-collapsed name cut to 100 characters without splitting a surrogate pair. */
export function cleanChannelName(name: string): string {
  const clean = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= CHANNEL_NAME_MAX) return clean;
  let cut = clean.slice(0, CHANNEL_NAME_MAX);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut.trimEnd();
}

/** Discord lower-cases text channel names and turns spaces into dashes; voice channels keep the name as typed. */
function sameChannelName(current: string, wanted: string, type: ChannelType): boolean {
  if (current === wanted) return true;
  return TEXT_TYPES.has(type) && current === wanted.toLowerCase().replace(/\s+/g, '-');
}

export interface DiscordActionsDeps {
  getClient: () => Client | null;
  repos: Repositories;
  audit: AuditService;
  messenger: InteractiveMessenger;
  presences: PresenceTracker;
  /** True when the client logged in with the Presence intent. */
  presenceIntent: () => boolean;
  emojis?: () => PlatformEmojis;
  warnThrottle?: WarnThrottle;
}

export class DiscordActionsImpl implements DiscordActions {
  private readonly queue = new KeyedQueue();
  private readonly throttle: WarnThrottle;
  private readonly emojis: () => PlatformEmojis;

  constructor(private readonly deps: DiscordActionsDeps) {
    this.throttle = deps.warnThrottle ?? new WarnThrottle();
    this.emojis = deps.emojis ?? (() => DEFAULT_PLATFORM_EMOJIS);
  }

  private readyClient(): Client<true> | null {
    const client = this.deps.getClient();
    return client?.isReady() ? client : null;
  }

  // ───────────── #8 rename ─────────────

  async renameChannel(guildId: string, channelId: string, name: string): Promise<{ outcome: RenameOutcome; retryAfterMs?: number }> {
    try {
      const wanted = cleanChannelName(name);
      if (!wanted) return { outcome: 'error' };
      const client = this.readyClient();
      if (!client) return { outcome: 'error' };
      if (!isSnowflake(channelId)) return { outcome: 'missing' };
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return { outcome: 'missing' };

      let channel: GuildBasedChannel | null;
      try {
        channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId));
      } catch (err) {
        const kind = classifyDiscordError(err);
        return { outcome: kind === 'unknown_channel' ? 'missing' : kind === 'forbidden' ? 'forbidden' : 'error' };
      }
      if (!channel) return { outcome: 'missing' };
      if (sameChannelName(channel.name, wanted, channel.type)) return { outcome: 'unchanged' };

      // Threads use their own permission (Manage Threads); Discord decides for them.
      if (!channel.isThread()) {
        const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
        const perms = me ? channel.permissionsFor(me) : null;
        if (perms && missingManageChannelPermissions((flag) => perms.has(flag), VOICE_TYPES.has(channel.type)).length > 0) {
          return { outcome: 'forbidden' };
        }
      }

      try {
        await channel.setName(wanted, 'Live counter');
      } catch (err) {
        const retryAfter = rateLimitRetryAfterMs(err);
        if (retryAfter !== null) return { outcome: 'rate_limited', retryAfterMs: Math.max(retryAfter, MIN_RETRY_AFTER_MS) };
        const kind = classifyDiscordError(err);
        if (kind === 'unknown_channel') return { outcome: 'missing' };
        if (kind === 'forbidden') return { outcome: 'forbidden' };
        log.warn({ guildId, channelId, err: describeDiscordError(err) }, 'Renaming channel failed');
        return { outcome: 'error' };
      }
      return { outcome: 'ok' };
    } catch (err) {
      log.error({ err, guildId, channelId }, 'Renaming channel failed unexpectedly');
      return { outcome: 'error' };
    }
  }

  // ───────────── direct messages ─────────────

  async sendDirectMessage(userId: string, message: { content: string; embedTitle?: string; embedDescription?: string; color?: number }): Promise<boolean> {
    const client = this.readyClient();
    if (!client || !isSnowflake(userId)) return false;
    const content = truncate(message.content ?? '', DISCORD_LIMITS.content);
    const title = message.embedTitle ? truncate(message.embedTitle, DISCORD_LIMITS.title) : '';
    const description = message.embedDescription ? truncate(message.embedDescription, DISCORD_LIMITS.description) : '';
    const embeds = title || description ? [{ color: message.color ?? COLORS.info, ...(title ? { title } : {}), ...(description ? { description } : {}) }] : [];
    if (!content && embeds.length === 0) return false;
    try {
      const dm = await client.users.createDM(userId);
      await dm.send({ ...(content ? { content } : {}), embeds, allowedMentions: silentMentions() });
      return true;
    } catch (err) {
      if (discordErrorCode(err) === DiscordErrorCodes.CannotSendMessagesToUser) log.info({ userId }, 'Direct message refused (DMs closed)');
      else log.warn({ userId, err: describeDiscordError(err) }, 'Direct message failed');
      return false;
    }
  }

  // ───────────── #9 review message ─────────────

  /**
   * Posts the review message for a pending application, or edits the existing one (status, reviewer, buttons
   * removed after a decision). Serialized per application and the ref is stored on the application, so calls from
   * the service and from the Discord handlers never produce two messages. On a failed edit of a message that
   * still exists, the existing ref is returned (the caller must not forget it).
   */
  upsertApplicationReview(application: StreamerApplication, settings: GuildSettings): Promise<MessageRef | null> {
    return this.queue
      .run(`application:${application.id}`, () => this.upsertReview(application, settings))
      .catch((err): MessageRef | null => {
        log.error({ err, applicationId: application.id }, 'Review message update failed unexpectedly');
        return null;
      });
  }

  private async upsertReview(passed: StreamerApplication, settings: GuildSettings): Promise<MessageRef | null> {
    const { repos, messenger } = this.deps;
    const stored = repos.applications.get(passed.id);
    // The stored row is authoritative (fresher status, and the ref of a message posted by an earlier call).
    const application: StreamerApplication = stored
      ? { ...stored, reviewChannelId: stored.reviewChannelId ?? passed.reviewChannelId, reviewMessageId: stored.reviewMessageId ?? passed.reviewMessageId }
      : passed;
    const guildId = application.guildId;
    const message = buildApplicationReviewMessage(application, settings, this.emojis());
    const label = 'مراجعة الطلبات';

    if (application.reviewChannelId && application.reviewMessageId) {
      const ref = { channelId: application.reviewChannelId, messageId: application.reviewMessageId };
      const edited = await messenger.edit(guildId, ref, message);
      if (edited.ok) return edited.ref;
      if (!GONE_REASONS.has(edited.reason)) {
        this.report(guildId, ref.channelId, deliveryFailureText('ar', edited, label, ref.channelId), edited.reason);
        return ref;
      }
      if (stored) repos.applications.update(application.id, { reviewChannelId: null, reviewMessageId: null });
      // A decided application whose message was deleted does not need a new one.
      if (application.status !== 'pending') return null;
    } else if (application.status !== 'pending') {
      return null;
    }

    const channelId = settings.features.applications.reviewChannelId;
    if (!channelId) return null;
    const sent = await messenger.send(guildId, channelId, message);
    if (!sent.ok) {
      this.report(guildId, channelId, deliveryFailureText('ar', sent, label, channelId), sent.reason);
      return null;
    }
    if (stored) repos.applications.update(application.id, { reviewChannelId: sent.ref.channelId, reviewMessageId: sent.ref.messageId });
    return sent.ref;
  }

  private report(guildId: string, channelId: string, message: string, reason: string): void {
    log.warn({ guildId, channelId, reason }, 'Application review message delivery failed');
    if (reason === 'not_ready' || !this.throttle.allow(`${guildId}:${channelId}:review:${reason}`)) return;
    this.deps.audit.record({ guildId, action: 'discord.delivery', level: 'warn', message, details: { channelId, purpose: 'review', reason } });
  }

  // ───────────── #15 presences ─────────────

  async streamingPresences(guildId: string): Promise<Map<string, StreamingActivity> | null> {
    if (!this.deps.presenceIntent()) return null;
    const client = this.readyClient();
    if (!client) return null;
    const guild = client.guilds.cache.get(guildId);
    if (!guild || guild.available === false) return null;
    const streaming = this.deps.presences.streaming(guildId);
    if (!streaming) return null;
    for (const userId of [...streaming.keys()]) {
      if (client.users.cache.get(userId)?.bot) streaming.delete(userId);
    }
    return streaming;
  }
}
