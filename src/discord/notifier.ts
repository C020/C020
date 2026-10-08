/**
 * Notifier implementation: decides what to post/edit, where (channel routing) and how to react to failures. All
 * Discord I/O goes through a MessageTransport, so this logic is unit-tested with a fake transport.
 *
 * Failure policy
 * - Live edit: message/channel gone → 'gone' (caller reposts). Access lost → 'forbidden' (the message still
 *   exists: caller keeps the ref and retries). Network/5xx/not ready → 'transient' (caller retries, never
 *   reposts, so a Discord hiccup never produces duplicate live messages). A payload Discord refuses is reported
 *   and treated as rendered ('ok'): resending the same payload cannot succeed, the next change re-renders.
 * - Summary: edit the live message; post a new one only when the old one is really gone (never on a
 *   transient failure) and summaries are enabled. Every failure that may heal is returned as 'transient' so
 *   the caller retries later; a refused summary falls back to the minimal "stream ended" card.
 * - Configuration problems (missing permission, deleted channel...) and transient delivery failures become
 *   ONE audit warning (guild language) per guild/channel/problem per hour. Problems with the log channel are never
 *   mirrored to the log channel.
 * - A payload rejected while custom platform emojis are in use is retried once with unicode emojis; the
 *   custom emojis are only turned off when that retry succeeds.
 * - Expiring images (TikTok CDN) are uploaded as attachments; without Attach Files the message is sent with
 *   the linked image instead.
 *
 * v2
 * - #4 routing: new posts go to the routed channel (src/services/routing.ts). When a routed channel is unusable
 *   (forbidden / missing / other guild / not text) the post falls back ONCE to the default channel and the admins
 *   get a throttled warning. The session keeps whatever channel the post landed in; edits never move.
 * - #1 pings: buildPing(settings, 'live' | 'content') on new live/content posts (+ presence posts of registered
 *   streamers). Summaries, digests, ended cards and tests never ping.
 * - #10 silent: new live/presence/summary posts (features.silent.live) and content/digest posts
 *   (features.silent.content) are sent with SuppressNotifications. Edits never carry flags.
 * - #16 every built-in text follows features.language.
 */
import type { APIEmbed } from 'discord.js';
import { childLogger } from '../core/logger.js';
import { type ContentKind, type Platform, PLATFORM_LABELS } from '../core/types.js';
import type { AuditLevel, GuildSettings, Language } from '../db/models.js';
import type { Repositories } from '../db/repositories.js';
import type { AuditService } from '../services/audit.js';
import type {
  ContentView,
  DigestView,
  EditOutcome,
  LiveView,
  MessageRef,
  Notifier,
  PresenceLiveView,
  SummaryOutcome,
  SummaryView,
} from '../services/ports.js';
import { resolveContentChannelId, resolveDigestChannelId, resolveLiveChannelId } from '../services/routing.js';
import { fetchImage, type ImageFetcher, rehostExpiringImages } from './attachments.js';
import { DEFAULT_PLATFORM_EMOJIS, hasCustomEmojis, type PlatformEmojis } from './emojis.js';
import { escapeMarkdown, truncate } from './format.js';
import { contentKindLabel, langOf, permissionNameEn, tm } from './i18n/messages.js';
import { buildPing, type PingKind, type PingSpec, SILENT_PING, silentMentions } from './mentions.js';
import {
  applyPing,
  buildContentMessage,
  buildDigestMessage,
  buildEndedMessage,
  buildLiveMessage,
  buildPresenceEndedMessage,
  buildPresenceLiveMessage,
  buildSummaryMessage,
  type MessageContent,
  type RenderOptions,
} from './messages.js';
import { type PermissionName, permissionListAr } from './permissions.js';
import { DISCORD_LIMITS } from './templates.js';
import type { MessageTransport, OutgoingMessage, TransportResult } from './transport.js';
import { WarnThrottle } from './util.js';

const log = childLogger('discord.notifier');

export type ChannelPurpose = 'live' | 'content' | 'log';

type Failure = Extract<TransportResult, { ok: false }>;

/** Edit failures meaning "this message no longer exists" (vs. lost access or transient errors). */
const GONE = new Set<Failure['reason']>(['gone', 'channel_missing', 'wrong_guild', 'not_text']);

/** Send failures meaning "this channel cannot be used" — a routed post then falls back to the default channel. */
const UNUSABLE_CHANNEL = new Set<Failure['reason']>(['forbidden', 'channel_missing', 'wrong_guild', 'not_text']);

/** Permission list in the guild language ("إرسال الرسائل (Send Messages)، ..." / "Send Messages, ..."). */
export function permissionList(names: PermissionName[], lang: Language = 'ar'): string {
  return lang === 'en' ? names.map(permissionNameEn).join(', ') : permissionListAr(names);
}

/** Admin-facing explanation of a delivery failure; null when admins need not see it (client not ready). */
export function failureMessage(result: Failure, purpose: ChannelPurpose, channelId: string, lang: Language = 'ar'): string | null {
  const label = tm(lang, `purpose.${purpose}`);
  const where = result.channelName ? `#${result.channelName}` : channelId;
  switch (result.reason) {
    case 'forbidden':
      return result.missing?.length
        ? tm(lang, 'fail.forbiddenMissing', { label, where, perms: permissionList(result.missing, lang) })
        : tm(lang, 'fail.forbidden', { label, where });
    case 'channel_missing':
      return tm(lang, 'fail.channelMissing', { label, id: channelId });
    case 'wrong_guild':
      return tm(lang, 'fail.wrongGuild', { label, id: channelId });
    case 'not_text':
      return tm(lang, 'fail.notText', { label, where });
    case 'invalid':
      return tm(lang, 'fail.invalid', { label });
    case 'error':
      return tm(lang, 'fail.error', { label, where });
    default:
      return null;
  }
}

/** Arabic explanation of a delivery failure (kept for existing callers; see failureMessage). */
export function failureMessageAr(result: Failure, purpose: ChannelPurpose, channelId: string): string | null {
  return failureMessage(result, purpose, channelId, 'ar');
}

const nonEmpty = (v: string | null | undefined): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

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
export function buildLogMessages(entries: LogEntry[], lang: Language = 'ar'): OutgoingMessage[] {
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
      footer: { text: tm(lang, 'log.footer') },
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

/** Where a new post goes (#4). */
interface RouteTarget {
  channelId: string;
  /** Default channel used once when `channelId` is unusable (null or the same channel = no fallback). */
  fallbackId: string | null;
  /** What the route was for (platform, content kind, digest) — shown in the admin warning. */
  scope: string;
}

type SendOp = (message: OutgoingMessage) => Promise<TransportResult>;

const withSilent = (message: OutgoingMessage, silent: boolean): OutgoingMessage => (silent ? { ...message, silent: true } : message);

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
    const primary = view.platforms[0]?.platform ?? null;
    const target = this.liveTarget(view.settings, primary);
    if (!target) return null;
    const silent = view.settings.features?.silent?.live === true;
    const build = this.liveBuilder(view);
    const result = await this.sendRouted(view.guildId, 'live', target, langOf(view.settings), (channelId) =>
      this.deliver(build, (message) => this.transport.send(view.guildId, channelId, withSilent(message, silent))),
    );
    return result.ok ? result.ref : null;
  }

  async updateLive(ref: MessageRef, view: LiveView): Promise<EditOutcome> {
    const lang = langOf(view.settings);
    const result = await this.deliver(this.liveBuilder(view), (message) => this.transport.edit(view.guildId, ref, message));
    if (result.ok) return 'ok';
    if (GONE.has(result.reason)) {
      log.info({ guildId: view.guildId, ref, reason: result.reason }, 'Live message no longer exists');
      return 'gone';
    }
    if (result.reason === 'forbidden') {
      this.reportFailure(view.guildId, ref.channelId, 'live', result, lang);
      return 'forbidden';
    }
    if (result.reason === 'invalid') {
      // Resending the same payload cannot succeed; the next change (or periodic refresh) renders a new one.
      this.reportFailure(view.guildId, ref.channelId, 'live', result, lang);
      return 'ok';
    }
    log.warn({ guildId: view.guildId, ref, reason: result.reason, detail: result.detail }, 'Editing live message failed; will retry');
    return 'transient';
  }

  // ───────────── summary ─────────────

  async postSummary(ref: MessageRef | null, view: SummaryView): Promise<SummaryOutcome> {
    const settings = view.settings;
    const lang = langOf(settings);
    const enabled = settings.options.summaryEnabled;
    const builder =
      (minimal: boolean) =>
      (emojis: PlatformEmojis): OutgoingMessage => {
        const options = this.renderOptions(view.guildId, view.streamer.discordUserId, emojis);
        const message = enabled && !minimal ? buildSummaryMessage(view, options) : buildEndedMessage(view, options);
        return { ...message, allowedMentions: silentMentions() };
      };
    /** Full summary first; a summary Discord refuses must still replace the LIVE card, so retry with the minimal one. */
    const publish = async (target: string, op: SendOp): Promise<TransportResult> => {
      const deliverOp = (message: OutgoingMessage) => this.withRehostedImages(view.guildId, target, 'live', message, op, lang);
      const first = await this.deliver(builder(false), deliverOp);
      if (first.ok || first.reason !== 'invalid') return first;
      this.reportFailure(view.guildId, target, 'live', first, lang);
      return enabled ? this.deliver(builder(true), deliverOp) : first;
    };

    const primary = summaryPrimaryPlatform(view);
    const routed = this.liveTarget(settings, primary);
    const liveChannels = configuredLiveChannels(settings);
    let repostIn: string | null = null;

    if (ref) {
      const edited = await publish(ref.channelId, (message) => this.transport.edit(view.guildId, ref, message));
      if (edited.ok) return { status: 'done', ref: edited.ref };
      if (edited.reason === 'forbidden') {
        this.reportFailure(view.guildId, ref.channelId, 'live', edited, lang);
        // The old message still exists. Only when the admin moved the live channel (the old channel is no longer a
        // configured live channel) does the summary go to the current one instead.
        if (!enabled || !routed || routed.channelId === ref.channelId || liveChannels.has(ref.channelId)) {
          return { status: 'transient', reason: edited.reason };
        }
      } else if (!GONE.has(edited.reason)) {
        if (edited.reason !== 'invalid') this.reportFailure(view.guildId, ref.channelId, 'live', edited, lang);
        log.warn({ guildId: view.guildId, ref, reason: edited.reason, detail: edited.detail }, 'Editing message into summary failed; will retry');
        return { status: 'transient', reason: edited.reason };
      } else if (edited.reason === 'gone' && liveChannels.has(ref.channelId)) {
        // Only the message was deleted: the session's channel still works, keep the summary there (never move).
        repostIn = ref.channelId;
      }
    }

    if (!enabled) return { status: 'skipped' };
    const target: RouteTarget | null = repostIn ? { channelId: repostIn, fallbackId: nonEmpty(settings.liveChannelId), scope: platformScope(primary) } : routed;
    if (!target) return { status: 'skipped' };
    const silent = settings.features?.silent?.live === true;
    const posted = await this.sendRouted(
      view.guildId,
      'live',
      target,
      lang,
      (channelId) => publish(channelId, (message) => this.transport.send(view.guildId, channelId, withSilent(message, silent))),
      { reportInvalid: false },
    );
    if (posted.ok) return { status: 'done', ref: posted.ref };
    return { status: 'transient', reason: posted.reason };
  }

  // ───────────── content ─────────────

  async postContent(view: ContentView): Promise<MessageRef | null> {
    const settings = view.settings;
    const lang = langOf(settings);
    const target = this.contentTarget(settings, view.channel.platform, view.item.kind, lang);
    if (!target) return null;
    const silent = settings.features?.silent?.content === true;
    const build = (emojis: PlatformEmojis) =>
      this.withPing(buildContentMessage(view, this.renderOptions(view.guildId, view.streamer.discordUserId, emojis)), buildPing(settings, 'content'));
    const result = await this.sendRouted(view.guildId, 'content', target, lang, (channelId) =>
      this.deliver(build, (message) =>
        // Expiring thumbnails (TikTok) are uploaded as attachments so the post keeps its image.
        this.withRehostedImages(view.guildId, channelId, 'content', withSilent(message, silent), (m) => this.transport.send(view.guildId, channelId, m), lang),
      ),
    );
    return result.ok ? result.ref : null;
  }

  // ───────────── #6 daily clip digest ─────────────

  async postDigest(view: DigestView): Promise<MessageRef | null> {
    try {
      if (view.entries.length === 0) return null;
      const settings = view.settings;
      const lang = langOf(settings);
      const channelId = this.safeRoute(() => resolveDigestChannelId(settings), settings.contentChannelId);
      if (!channelId) return null;
      const target: RouteTarget = { channelId, fallbackId: nonEmpty(settings.contentChannelId), scope: tm(lang, 'route.scopeDigest') };
      const silent = settings.features?.silent?.content === true;
      const build = (emojis: PlatformEmojis): OutgoingMessage => ({
        ...buildDigestMessage(view, { emojis, now: this.clock() }),
        allowedMentions: silentMentions(),
      });
      const result = await this.sendRouted(view.guildId, 'content', target, lang, (target) =>
        this.deliver(build, (message) =>
          this.withRehostedImages(view.guildId, target, 'content', withSilent(message, silent), (m) => this.transport.send(view.guildId, target, m), lang),
        ),
      );
      return result.ok ? result.ref : null;
    } catch (err) {
      log.error({ err, guildId: view.guildId }, 'Posting the clip digest failed');
      return null;
    }
  }

  // ───────────── #15 presence-only streams ─────────────

  async postPresenceLive(view: PresenceLiveView): Promise<MessageRef | null> {
    try {
      const settings = view.settings;
      const target = this.liveTarget(settings, view.platform);
      if (!target) return null;
      const silent = settings.features?.silent?.live === true;
      // Members who are not registered streamers (scope "everyone") never trigger pings.
      const ping = view.streamer ? buildPing(settings, 'live') : SILENT_PING;
      const build = (emojis: PlatformEmojis) => this.withPing(buildPresenceLiveMessage(view, this.renderOptions(view.guildId, view.userId, emojis)), ping);
      const result = await this.sendRouted(view.guildId, 'live', target, langOf(settings), (channelId) =>
        this.deliver(build, (message) => this.transport.send(view.guildId, channelId, withSilent(message, silent))),
      );
      return result.ok ? result.ref : null;
    } catch (err) {
      log.error({ err, guildId: view.guildId, userId: view.userId }, 'Posting a presence live notification failed');
      return null;
    }
  }

  async endPresenceLive(ref: MessageRef, view: PresenceLiveView): Promise<boolean> {
    try {
      const lang = langOf(view.settings);
      const build = (emojis: PlatformEmojis): OutgoingMessage => ({
        ...buildPresenceEndedMessage(view, this.renderOptions(view.guildId, view.userId, emojis)),
        allowedMentions: silentMentions(),
      });
      const result = await this.deliver(build, (message) => this.transport.edit(view.guildId, ref, message));
      if (result.ok) return true;
      if (GONE.has(result.reason)) return false;
      if (result.reason === 'forbidden' || result.reason === 'invalid') this.reportFailure(view.guildId, ref.channelId, 'live', result, lang);
      else log.warn({ guildId: view.guildId, ref, reason: result.reason, detail: result.detail }, 'Editing a presence notification into "ended" failed');
      return true;
    } catch (err) {
      log.error({ err, guildId: view.guildId, ref }, 'Ending a presence live notification failed');
      return true;
    }
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
    if (!result.ok) this.reportFailure(guildId, channelId, purpose, result, this.guildLanguage(guildId));
    return result;
  }

  // ───────────── internals ─────────────

  /** Live post and live edits render identically (same ping + allowedMentions), so edits never change who was pinged. */
  private liveBuilder(view: LiveView): (emojis: PlatformEmojis) => OutgoingMessage {
    return (emojis) =>
      this.withPing(buildLiveMessage(view, this.renderOptions(view.guildId, view.streamer.discordUserId, emojis)), buildPing(view.settings, 'live' satisfies PingKind));
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

  private withPing(message: MessageContent, ping: PingSpec): OutgoingMessage {
    return { ...applyPing(message, ping), allowedMentions: ping.allowedMentions };
  }

  /** Routing helpers never throw: a malformed settings object falls back to the default channel. */
  private safeRoute(resolve: () => string | null, fallback: string | null): string | null {
    try {
      return resolve();
    } catch (err) {
      log.warn({ err }, 'Resolving the notification channel failed; using the default channel');
      return nonEmpty(fallback);
    }
  }

  private liveTarget(settings: GuildSettings, platform: Platform | null): RouteTarget | null {
    const channelId = this.safeRoute(() => resolveLiveChannelId(settings, platform), settings.liveChannelId);
    return channelId ? { channelId, fallbackId: nonEmpty(settings.liveChannelId), scope: platformScope(platform) } : null;
  }

  private contentTarget(settings: GuildSettings, platform: Platform, kind: ContentKind, lang: Language): RouteTarget | null {
    const channelId = this.safeRoute(() => resolveContentChannelId(settings, platform, kind), settings.contentChannelId);
    if (!channelId) return null;
    const byKind = nonEmpty(settings.features?.routing?.contentByKind?.[kind]);
    return { channelId, fallbackId: nonEmpty(settings.contentChannelId), scope: byKind ? contentKindLabel(kind, lang) : platformScope(platform) };
  }

  /**
   * Sends to the routed channel; when that channel is unusable and differs from the default one, warns (throttled)
   * and tries the default channel once. Failures are reported (once per hour per channel/problem).
   */
  private async sendRouted(
    guildId: string,
    purpose: ChannelPurpose,
    target: RouteTarget,
    lang: Language,
    send: (channelId: string) => Promise<TransportResult>,
    opts: { reportInvalid?: boolean } = {},
  ): Promise<TransportResult> {
    const report = (channelId: string, result: Failure) => {
      if (result.reason !== 'invalid' || opts.reportInvalid !== false) this.reportFailure(guildId, channelId, purpose, result, lang);
    };
    const first = await send(target.channelId);
    if (first.ok) return first;
    const fallbackId = target.fallbackId;
    if (!fallbackId || fallbackId === target.channelId || !UNUSABLE_CHANNEL.has(first.reason)) {
      report(target.channelId, first);
      return first;
    }
    this.warnRouteFallback(guildId, purpose, target, fallbackId, first, lang);
    const second = await send(fallbackId);
    if (!second.ok) report(fallbackId, second);
    return second;
  }

  private async deliver(build: (emojis: PlatformEmojis) => OutgoingMessage, op: SendOp): Promise<TransportResult> {
    const emojis = this.emojis();
    const first = await this.attempt(op, build, emojis);
    if (first.ok || first.reason !== 'invalid' || !hasCustomEmojis(emojis)) return first;
    log.warn({ detail: first.detail }, 'Discord rejected a message with custom emojis; retrying with unicode emojis');
    const second = await this.attempt(op, build, DEFAULT_PLATFORM_EMOJIS);
    // Most 400s have nothing to do with emojis: only blame them when the unicode version went through.
    if (second.ok) this.onCustomEmojisRejected();
    return second;
  }

  /**
   * Runs `op` with expiring embed images re-hosted as attachments. When Discord refuses the upload (no Attach
   * Files), the original message (linked images, no files) is sent instead and the admin is warned once per hour.
   */
  private async withRehostedImages(
    guildId: string,
    channelId: string,
    purpose: ChannelPurpose,
    message: OutgoingMessage,
    op: SendOp,
    lang: Language,
  ): Promise<TransportResult> {
    const { embeds, files } = await rehostExpiringImages(message.embeds, this.fetchImage);
    if (files.length === 0) return op(message);
    const result = await op({ ...message, embeds, files });
    // A pre-check that found other missing permissions would fail the plain message too.
    if (result.ok || result.reason !== 'forbidden' || result.missing?.some((name) => name !== 'AttachFiles')) return result;
    const fallback = await op(message);
    if (fallback.ok) this.warnAttachFiles(guildId, channelId, purpose, result.channelName, lang);
    return fallback;
  }

  private async attempt(op: SendOp, build: (emojis: PlatformEmojis) => OutgoingMessage, emojis: PlatformEmojis): Promise<TransportResult> {
    try {
      return await op(build(emojis));
    } catch (err) {
      return { ok: false, reason: 'error', detail: err instanceof Error ? err.message : String(err) };
    }
  }

  private guildLanguage(guildId: string): Language {
    try {
      return langOf(this.repos.settings.get(guildId));
    } catch {
      return 'ar';
    }
  }

  /** Audit entries must never break a delivery path (e.g. a DB hiccup while recording a warning). */
  private record(entry: Parameters<AuditService['record']>[0]): void {
    try {
      this.audit.record(entry);
    } catch (err) {
      log.warn({ err, guildId: entry.guildId, action: entry.action }, 'Recording a delivery warning failed');
    }
  }

  private reportFailure(guildId: string, channelId: string, purpose: ChannelPurpose, result: Failure, lang: Language): void {
    const message = failureMessage(result, purpose, channelId, lang);
    if (!message) {
      log.warn({ guildId, channelId, purpose, reason: result.reason, detail: result.detail }, 'Discord message delivery failed');
      return;
    }
    if (result.reason === 'invalid') log.error({ guildId, channelId, purpose, detail: result.detail }, 'Discord rejected a message payload');
    if (!this.throttle.allow(`${guildId}:${channelId}:${result.reason}`)) return;
    this.record({
      guildId,
      action: 'discord.delivery',
      level: 'warn',
      message,
      details: { channelId, purpose, reason: result.reason, detail: truncate(result.detail, 300), missing: result.missing ?? [] },
      // Never mirror log-channel problems into the log channel (it would fail again, forever).
      mirror: purpose !== 'log',
    });
  }

  private warnRouteFallback(guildId: string, purpose: ChannelPurpose, target: RouteTarget, fallbackId: string, result: Failure, lang: Language): void {
    log.warn({ guildId, purpose, channelId: target.channelId, fallbackId, reason: result.reason, detail: result.detail }, 'Routed channel unusable; falling back to the default channel');
    if (!this.throttle.allow(`${guildId}:${target.channelId}:route:${result.reason}`)) return;
    const problem = failureMessage(result, purpose, target.channelId, lang) ?? result.reason;
    this.record({
      guildId,
      action: 'discord.delivery',
      level: 'warn',
      message: tm(lang, 'route.fallback', { scope: target.scope || '—', problem, fallback: fallbackId }),
      details: {
        channelId: target.channelId,
        fallbackChannelId: fallbackId,
        purpose,
        reason: result.reason,
        detail: truncate(result.detail, 300),
        missing: result.missing ?? [],
        routed: true,
      },
      mirror: purpose !== 'log',
    });
  }

  private warnAttachFiles(guildId: string, channelId: string, purpose: ChannelPurpose, channelName: string | undefined, lang: Language): void {
    log.warn({ guildId, channelId, purpose }, 'Image upload refused (Attach Files missing); sent the linked image instead');
    if (!this.throttle.allow(`${guildId}:${channelId}:attach_files`)) return;
    const where = channelName ? `#${channelName}` : channelId;
    this.record({
      guildId,
      action: 'discord.delivery',
      level: 'warn',
      message: tm(lang, 'fail.attachFiles', { perms: permissionList(['AttachFiles'], lang), label: tm(lang, `purpose.${purpose}`), where }),
      details: { channelId, purpose, reason: 'forbidden', missing: ['AttachFiles'] },
      mirror: purpose !== 'log',
    });
  }

  private async flushLogs(guildId: string, entries: LogEntry[]): Promise<void> {
    const settings = this.repos.settings.get(guildId);
    const channelId = settings.logChannelId;
    if (!channelId || entries.length === 0) return;
    const lang = langOf(settings);
    for (const message of buildLogMessages(entries, lang)) {
      const result = await this.attempt((m) => this.transport.send(guildId, channelId, m), () => message, DEFAULT_PLATFORM_EMOJIS);
      if (!result.ok) {
        this.reportFailure(guildId, channelId, 'log', result, lang);
        return;
      }
    }
  }
}

// ───────────────────────────── routing helpers (pure) ─────────────────────────────

function platformScope(platform: Platform | null): string {
  return platform ? PLATFORM_LABELS[platform] : '';
}

/** Every channel live notifications may currently be posted to (default + per-platform routes). */
export function configuredLiveChannels(settings: GuildSettings): Set<string> {
  const ids = new Set<string>();
  const add = (v: string | null | undefined) => {
    const id = nonEmpty(v);
    if (id) ids.add(id);
  };
  add(settings.liveChannelId);
  for (const id of Object.values(settings.features?.routing?.liveByPlatform ?? {})) add(id);
  return ids;
}

/** Platform that decides where a newly posted summary goes: the one with the highest peak (first on ties). */
export function summaryPrimaryPlatform(view: Pick<SummaryView, 'segments'>): Platform | null {
  let best: { platform: Platform; peak: number } | null = null;
  for (const seg of view.segments) {
    if (!best || seg.peakViewers > best.peak) best = { platform: seg.platform, peak: seg.peakViewers };
  }
  return best?.platform ?? null;
}

/** Visible marker for test notifications (never pings, never silent-flagged). */
export function asTestMessage(message: MessageContent, lang: Language = 'ar'): OutgoingMessage {
  const marker = tm(lang, 'test.marker');
  const content = message.content ? `${marker}\n${message.content}` : marker;
  return { ...message, content: truncate(content, DISCORD_LIMITS.content), allowedMentions: silentMentions() };
}
