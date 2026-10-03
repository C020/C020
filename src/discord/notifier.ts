/**
 * Notifier implementation: decides what to post/edit and how to react to failures. All Discord I/O goes
 * through a MessageTransport, so this logic is unit-tested with a fake transport.
 *
 * Failure policy
 * - Live edit: message/channel gone or access lost → false (caller reposts). Transient errors → true, so a
 *   Discord hiccup never produces duplicate live messages.
 * - Summary: edit the live message; post a new one only when the old one is really gone (never on a
 *   transient failure) and summaries are enabled.
 * - Configuration problems (missing permission, deleted channel...) become ONE Arabic audit warning per
 *   guild/channel/problem per hour. Problems with the log channel are never mirrored to the log channel.
 * - A payload rejected while custom platform emojis are in use is retried once with unicode emojis.
 */
import type { APIEmbed } from 'discord.js';
import { childLogger } from '../core/logger.js';
import type { AuditLevel } from '../db/models.js';
import type { Repositories } from '../db/repositories.js';
import type { AuditService } from '../services/audit.js';
import type { ContentView, LiveView, MessageRef, Notifier, SummaryView } from '../services/ports.js';
import { fetchImage, type ImageFetcher, rehostExpiringImages } from './attachments.js';
import { DEFAULT_PLATFORM_EMOJIS, hasCustomEmojis, type PlatformEmojis } from './emojis.js';
import { escapeMarkdown, truncate } from './format.js';
import { buildPing, silentMentions } from './mentions.js';
import {
  applyPing,
  buildContentMessage,
  buildEndedMessage,
  buildLiveMessage,
  buildSummaryMessage,
  type MessageContent,
  type RenderOptions,
} from './messages.js';
import { permissionListAr } from './permissions.js';
import { DISCORD_LIMITS } from './templates.js';
import type { MessageTransport, OutgoingMessage, TransportResult } from './transport.js';
import { WarnThrottle } from './util.js';

const log = childLogger('discord.notifier');

export type ChannelPurpose = 'live' | 'content' | 'log';

const PURPOSE_LABELS: Record<ChannelPurpose, string> = {
  live: 'إشعارات البث',
  content: 'إشعارات المقاطع',
  log: 'اللوق',
};

type Failure = Extract<TransportResult, { ok: false }>;

/** Edit failures meaning "this message can't be edited any more" (vs. transient errors). */
const UNEDITABLE = new Set<Failure['reason']>(['gone', 'channel_missing', 'wrong_guild', 'not_text', 'forbidden']);

/** Arabic, admin-facing explanation of a configuration failure; null for transient/unknown failures. */
export function failureMessageAr(result: Failure, purpose: ChannelPurpose, channelId: string): string | null {
  const label = PURPOSE_LABELS[purpose];
  const where = result.channelName ? `#${result.channelName}` : channelId;
  switch (result.reason) {
    case 'forbidden':
      return result.missing?.length
        ? `البوت ما يقدر يرسل في روم ${label} (${where}) — ناقصه صلاحيات: ${permissionListAr(result.missing)}`
        : `البوت ما عنده صلاحية في روم ${label} (${where}) — تأكد إنه يقدر يشوف الروم ويرسل رسائل ويضمّن روابط (View Channel, Send Messages, Embed Links)`;
    case 'channel_missing':
      return `روم ${label} المحدد (${channelId}) غير موجود أو البوت ما يشوفه — يمكن انحذف، حدّثه من لوحة التحكم`;
    case 'wrong_guild':
      return `روم ${label} المحدد (${channelId}) تابع لسيرفر ثاني — اختر روم من هذا السيرفر`;
    case 'not_text':
      return `روم ${label} المحدد (${where}) مو روم كتابي — اختر روم نصي أو روم إعلانات`;
    case 'invalid':
      return `ديسكورد رفض رسالة ${label} — راجع قالب الرسالة (روابط أو نصوص غير صالحة)`;
    default:
      return null;
  }
}

// ───────────────────────────── log channel batching ─────────────────────────────

export interface LogEntry {
  level: AuditLevel;
  message: string;
  at: number;
}

const LEVEL_ICONS: Record<AuditLevel, string> = { info: '🔹', warn: '⚠️', error: '⛔' };
const LEVEL_COLORS: Record<AuditLevel, number> = { info: 0x5865f2, warn: 0xfaa61a, error: 0xed4245 };
const LEVEL_RANK: Record<AuditLevel, number> = { info: 0, warn: 1, error: 2 };
const LOG_DESCRIPTION_BUDGET = 3_900;

/** Groups log entries into embeds that fit Discord's description limit (pure). */
export function buildLogMessages(entries: LogEntry[]): OutgoingMessage[] {
  const messages: OutgoingMessage[] = [];
  let lines: string[] = [];
  let worst: AuditLevel = 'info';
  let length = 0;
  let lastAt = 0;

  const flush = () => {
    if (lines.length === 0) return;
    const embed: APIEmbed = {
      description: lines.join('\n'),
      color: LEVEL_COLORS[worst],
      footer: { text: 'سجل البوت' },
      timestamp: new Date(lastAt || Date.now()).toISOString(),
    };
    messages.push({ content: '', embeds: [embed], components: [], allowedMentions: silentMentions() });
    lines = [];
    worst = 'info';
    length = 0;
  };

  for (const entry of entries) {
    const line = `${LEVEL_ICONS[entry.level]} ${truncate(escapeMarkdown(entry.message), 1_000)}`;
    if (length + line.length + 1 > LOG_DESCRIPTION_BUDGET) flush();
    lines.push(line);
    length += line.length + 1;
    if (LEVEL_RANK[entry.level] > LEVEL_RANK[worst]) worst = entry.level;
    lastAt = entry.at;
  }
  flush();
  return messages;
}

class LogBatcher {
  private readonly pending = new Map<string, { entries: LogEntry[]; timer: NodeJS.Timeout | null }>();
  private closed = false;

  constructor(
    private readonly flushFn: (guildId: string, entries: LogEntry[]) => Promise<void>,
    private readonly delayMs: number,
    private readonly maxEntries = 25,
  ) {}

  add(guildId: string, entry: LogEntry): void {
    if (this.closed) return;
    let batch = this.pending.get(guildId);
    if (!batch) {
      batch = { entries: [], timer: null };
      this.pending.set(guildId, batch);
    }
    batch.entries.push(entry);
    if (batch.entries.length >= this.maxEntries) {
      void this.flush(guildId);
    } else if (!batch.timer) {
      batch.timer = setTimeout(() => void this.flush(guildId), this.delayMs);
      batch.timer.unref?.();
    }
  }

  async flush(guildId: string): Promise<void> {
    const batch = this.pending.get(guildId);
    if (!batch) return;
    this.pending.delete(guildId);
    if (batch.timer) clearTimeout(batch.timer);
    try {
      await this.flushFn(guildId, batch.entries);
    } catch (err) {
      log.warn({ err, guildId }, 'Flushing log channel batch failed');
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.pending.keys()].map((guildId) => this.flush(guildId)));
  }
}

// ───────────────────────────── notifier ─────────────────────────────

export interface NotifierDeps {
  transport: MessageTransport;
  repos: Repositories;
  audit: AuditService;
  /** Current platform emoji set (custom application emojis or unicode). */
  emojis?: () => PlatformEmojis;
  /** Called when Discord rejected a payload containing custom emojis. */
  onCustomEmojisRejected?: () => void;
  /** Streamer's Discord avatar when cached. */
  avatarFor?: (guildId: string, userId: string) => string | null;
  clock?: () => number;
  warnThrottle?: WarnThrottle;
  /** How long log lines are collected before they are posted as one message. */
  logBatchDelayMs?: number;
  /** Downloads images that must be re-hosted (expiring TikTok CDN URLs). */
  fetchImage?: ImageFetcher;
}

export class DiscordNotifier implements Notifier {
  private readonly fetchImage: ImageFetcher;
  private readonly transport: MessageTransport;
  private readonly repos: Repositories;
  private readonly audit: AuditService;
  private readonly emojis: () => PlatformEmojis;
  private readonly onCustomEmojisRejected: () => void;
  private readonly avatarFor: (guildId: string, userId: string) => string | null;
  private readonly clock: () => number;
  private readonly throttle: WarnThrottle;
  private readonly logs: LogBatcher;

  constructor(deps: NotifierDeps) {
    this.transport = deps.transport;
    this.repos = deps.repos;
    this.audit = deps.audit;
    this.emojis = deps.emojis ?? (() => DEFAULT_PLATFORM_EMOJIS);
    this.onCustomEmojisRejected = deps.onCustomEmojisRejected ?? (() => {});
    this.avatarFor = deps.avatarFor ?? (() => null);
    this.clock = deps.clock ?? Date.now;
    this.fetchImage = deps.fetchImage ?? fetchImage;
    this.throttle = deps.warnThrottle ?? new WarnThrottle(60 * 60_000, this.clock);
    this.logs = new LogBatcher((guildId, entries) => this.flushLogs(guildId, entries), deps.logBatchDelayMs ?? 2_000);
  }

  // ───────────── live ─────────────

  async postLive(view: LiveView): Promise<MessageRef | null> {
    const channelId = view.settings.liveChannelId;
    if (!channelId) return null;
    const result = await this.deliver(this.liveBuilder(view), (message) => this.transport.send(view.guildId, channelId, message));
    if (result.ok) return result.ref;
    this.reportFailure(view.guildId, channelId, 'live', result);
    return null;
  }

  async updateLive(ref: MessageRef, view: LiveView): Promise<boolean> {
    const result = await this.deliver(this.liveBuilder(view), (message) => this.transport.edit(view.guildId, ref, message));
    if (result.ok) return true;
    if (UNEDITABLE.has(result.reason)) {
      if (result.reason === 'forbidden') this.reportFailure(view.guildId, ref.channelId, 'live', result);
      log.info({ guildId: view.guildId, ref, reason: result.reason }, 'Live message can no longer be edited');
      return false;
    }
    if (result.reason === 'invalid') this.reportFailure(view.guildId, ref.channelId, 'live', result);
    log.warn({ guildId: view.guildId, ref, reason: result.reason, detail: result.detail }, 'Editing live message failed; keeping it');
    return true;
  }

  // ───────────── summary ─────────────

  async postSummary(ref: MessageRef | null, view: SummaryView): Promise<MessageRef | null> {
    const enabled = view.settings.options.summaryEnabled;
    const build = (emojis: PlatformEmojis): OutgoingMessage => {
      const options = this.renderOptions(view.guildId, view.streamer.discordUserId, emojis);
      const message = enabled ? buildSummaryMessage(view, options) : buildEndedMessage(view, options);
      return { ...message, allowedMentions: silentMentions() };
    };

    if (ref) {
      const edited = await this.deliver(build, (message) => this.transport.edit(view.guildId, ref, message));
      if (edited.ok) return edited.ref;
      if (!UNEDITABLE.has(edited.reason)) {
        if (edited.reason === 'invalid') this.reportFailure(view.guildId, ref.channelId, 'live', edited);
        log.warn({ guildId: view.guildId, ref, reason: edited.reason, detail: edited.detail }, 'Editing message into summary failed');
        return null;
      }
      if (edited.reason === 'forbidden') this.reportFailure(view.guildId, ref.channelId, 'live', edited);
    }

    const channelId = view.settings.liveChannelId;
    if (!enabled || !channelId) return null;
    const posted = await this.deliver(build, (message) => this.transport.send(view.guildId, channelId, message));
    if (posted.ok) return posted.ref;
    this.reportFailure(view.guildId, channelId, 'live', posted);
    return null;
  }

  // ───────────── content ─────────────

  async postContent(view: ContentView): Promise<MessageRef | null> {
    const channelId = view.settings.contentChannelId;
    if (!channelId) return null;
    const result = await this.deliver(
      (emojis) => this.withPing(buildContentMessage(view, this.renderOptions(view.guildId, view.streamer.discordUserId, emojis)), view),
      // Content posts are never edited later, so expiring thumbnails (TikTok) are uploaded as attachments.
      async (message) => {
        const { embeds, files } = await rehostExpiringImages(message.embeds, this.fetchImage);
        return this.transport.send(view.guildId, channelId, files.length ? { ...message, embeds, files } : message);
      },
    );
    if (result.ok) return result.ref;
    this.reportFailure(view.guildId, channelId, 'content', result);
    return null;
  }

  // ───────────── log channel ─────────────

  async log(guildId: string, level: AuditLevel, message: string): Promise<void> {
    try {
      if (!this.repos.settings.get(guildId).logChannelId) return;
      this.logs.add(guildId, { level, message, at: this.clock() });
    } catch (err) {
      log.warn({ err, guildId }, 'Queueing log message failed');
    }
  }

  /** Posts any buffered log lines and stops accepting new ones (shutdown). */
  async close(): Promise<void> {
    await this.logs.close();
  }

  // ───────────── raw send (test messages) ─────────────

  /** Sends an arbitrary prepared message (used for test notifications); failures are reported like real posts. */
  async send(guildId: string, channelId: string, purpose: ChannelPurpose, build: (emojis: PlatformEmojis) => OutgoingMessage): Promise<TransportResult> {
    const result = await this.deliver(build, (message) => this.transport.send(guildId, channelId, message));
    if (!result.ok) this.reportFailure(guildId, channelId, purpose, result);
    return result;
  }

  // ───────────── internals ─────────────

  /** Live post and live edits render identically (same ping + allowedMentions), so edits never change who was pinged. */
  private liveBuilder(view: LiveView): (emojis: PlatformEmojis) => OutgoingMessage {
    return (emojis) => this.withPing(buildLiveMessage(view, this.renderOptions(view.guildId, view.streamer.discordUserId, emojis)), view);
  }

  private renderOptions(guildId: string, userId: string, emojis: PlatformEmojis): RenderOptions {
    let avatarUrl: string | null = null;
    try {
      avatarUrl = this.avatarFor(guildId, userId);
    } catch {
      avatarUrl = null;
    }
    return { emojis, avatarUrl, now: this.clock() };
  }

  private withPing(message: MessageContent, view: LiveView | ContentView): OutgoingMessage {
    const ping = buildPing(view.settings);
    return { ...applyPing(message, ping), allowedMentions: ping.allowedMentions };
  }

  private async deliver(build: (emojis: PlatformEmojis) => OutgoingMessage, op: (message: OutgoingMessage) => Promise<TransportResult>): Promise<TransportResult> {
    const emojis = this.emojis();
    const first = await this.attempt(op, build, emojis);
    if (first.ok || first.reason !== 'invalid' || !hasCustomEmojis(emojis)) return first;
    log.warn({ detail: first.detail }, 'Discord rejected a message with custom emojis; retrying with unicode emojis');
    this.onCustomEmojisRejected();
    return this.attempt(op, build, DEFAULT_PLATFORM_EMOJIS);
  }

  private async attempt(
    op: (message: OutgoingMessage) => Promise<TransportResult>,
    build: (emojis: PlatformEmojis) => OutgoingMessage,
    emojis: PlatformEmojis,
  ): Promise<TransportResult> {
    try {
      return await op(build(emojis));
    } catch (err) {
      return { ok: false, reason: 'error', detail: err instanceof Error ? err.message : String(err) };
    }
  }

  private reportFailure(guildId: string, channelId: string, purpose: ChannelPurpose, result: Failure): void {
    const message = failureMessageAr(result, purpose, channelId);
    if (!message) {
      log.warn({ guildId, channelId, purpose, reason: result.reason, detail: result.detail }, 'Discord message delivery failed');
      return;
    }
    if (result.reason === 'invalid') log.error({ guildId, channelId, purpose, detail: result.detail }, 'Discord rejected a message payload');
    if (!this.throttle.allow(`${guildId}:${channelId}:${result.reason}`)) return;
    this.audit.record({
      guildId,
      action: 'discord.delivery',
      level: 'warn',
      message,
      details: { channelId, purpose, reason: result.reason, detail: truncate(result.detail, 300), missing: result.missing ?? [] },
      // Never mirror log-channel problems into the log channel (it would fail again, forever).
      mirror: purpose !== 'log',
    });
  }

  private async flushLogs(guildId: string, entries: LogEntry[]): Promise<void> {
    const channelId = this.repos.settings.get(guildId).logChannelId;
    if (!channelId || entries.length === 0) return;
    for (const message of buildLogMessages(entries)) {
      const result = await this.attempt((m) => this.transport.send(guildId, channelId, m), () => message, DEFAULT_PLATFORM_EMOJIS);
      if (!result.ok) {
        this.reportFailure(guildId, channelId, 'log', result);
        return;
      }
    }
  }
}

/** Visible marker for test notifications (never pings). */
export function asTestMessage(message: MessageContent): OutgoingMessage {
  const marker = '🧪 **رسالة تجريبية** — بيانات وهمية عشان تشوف شكل الإشعار';
  const content = message.content ? `${marker}\n${message.content}` : marker;
  return { ...message, content: truncate(content, DISCORD_LIMITS.content), allowedMentions: silentMentions() };
}
