/**
 * #8 — live counter channel: a (voice or text) channel whose name shows how many members are live right now,
 * e.g. "🔴 يبثون الحين: 3".
 *
 * Design notes
 * - The count is the number of DISTINCT members live in the guild: registered streamers with an active platform
 *   session plus, when presence detection (#15) is on, members live through their Discord "Streaming" status.
 * - Refreshes are event driven ('live.changed', presence changes) and coalesced (a burst of events = one
 *   evaluation), with a safety pass every `safetyMs` that also re-applies a name changed by hand.
 * - Discord allows about 2 renames per 10 minutes per channel, so a channel is renamed at most once per
 *   `throttleMs` (5 minutes); changes in between are coalesced into the latest value, applied when the window
 *   opens. A rename is only attempted when the wanted name differs from the last one applied. 'rate_limited'
 *   waits the larger of Discord's retry-after and the throttle.
 * - 'forbidden' / 'missing' are reported to the admins (audit + log channel, guild language) at most once per hour
 *   per channel and retried on the next safety pass; transient errors are retried after `errorRetryMs`.
 * - Never throws; one guild's failure never affects another.
 */
import type { CounterServiceApi, PresenceServiceApi } from '../app/context.js';
import type { AppEvents } from '../core/events.js';
import { childLogger } from '../core/logger.js';
import type { Language } from '../db/features.js';
import type { Repositories } from '../db/repositories.js';
import { defineMessages } from '../discord/i18n/index.js';
import type { AuditService } from './audit.js';
import type { DiscordActions, RenameOutcome } from './ports.js';

const log = childLogger('counter');

/** Discord channel names are 1-100 characters. */
export const COUNTER_NAME_MAX = 100;

const t = defineMessages({
  'default.template': { ar: '🔴 يبثون الحين: {count}', en: '🔴 Live now: {count}' },
  'audit.forbidden': {
    ar: 'ما قدر البوت يحدّث اسم روم عداد البثوث <#{channel}> — يحتاج صلاحية "Manage Channel" (إدارة الروم) في هذا الروم (وصلاحية الاتصال Connect لو كان روم صوتي)',
    en: 'The bot could not update the name of the live counter channel <#{channel}> — it needs the "Manage Channel" permission on that channel (and Connect for a voice channel)',
  },
  'audit.missing': {
    ar: 'روم عداد البثوث ({channel}) غير موجود أو البوت ما يشوفه — اختر روم ثاني من لوحة التحكم، أو أعط البوت صلاحية "Manage Channel" عليه',
    en: 'The live counter channel ({channel}) does not exist or the bot cannot see it — pick another channel in the dashboard, or give the bot "Manage Channel" on it',
  },
});

export interface CounterServiceTiming {
  /** Minimum spacing between two renames of the same channel. */
  throttleMs: number;
  /** Safety pass over every configured guild (also catches missed events and manual renames). */
  safetyMs: number;
  /** Coalescing delay between an event and the evaluation. */
  debounceMs: number;
  /** Retry delay after a transient rename error (Discord not ready, network). */
  errorRetryMs: number;
  /** Minimum spacing between two admin warnings about the same channel problem. */
  warnIntervalMs: number;
  /** First pass after start() (Discord logs in meanwhile). */
  firstPassDelayMs: number;
}

export const DEFAULT_COUNTER_TIMING: CounterServiceTiming = {
  throttleMs: 5 * 60_000,
  safetyMs: 5 * 60_000,
  debounceMs: 2_000,
  errorRetryMs: 60_000,
  warnIntervalMs: 60 * 60_000,
  firstPassDelayMs: 10_000,
};

/** Presence source (optional): live members and, when available, change notifications. */
export type CounterPresence = Pick<PresenceServiceApi, 'liveUserIds'> & { onChange?: (listener: (guildId: string) => void) => () => void };

export interface CounterServiceDeps {
  repos: Repositories;
  events: AppEvents;
  audit: AuditService;
  discord: Pick<DiscordActions, 'renameChannel'>;
  /** #15 presence service; presence-live members are counted when the guild has presence detection on. */
  presence?: CounterPresence | null;
  clock?: () => number;
  timing?: Partial<CounterServiceTiming>;
}

/** Rename bookkeeping per channel (`guildId:channelId`). */
interface ChannelState {
  /** Name the channel had after our last successful rename / check. */
  lastName: string | null;
  /** Last real rename (ms). */
  lastRenameAt: number;
  /** No attempt before this (rate limit / error backoff). */
  notBefore: number;
}

/**
 * Channel name for a count: `{count}` replaced (appended when the template has none), whitespace collapsed,
 * cut to 100 characters without splitting an emoji/surrogate pair. An empty template uses the language default.
 */
export function renderCounterName(template: string | null | undefined, count: number, lang: Language = 'ar'): string {
  let text = typeof template === 'string' ? template.replace(/\s+/g, ' ').trim() : '';
  if (!text) text = t(lang, 'default.template');
  if (!text.includes('{count}')) text = `${text} {count}`;
  const value = String(Math.max(0, Math.floor(Number.isFinite(count) ? count : 0)));
  const name = text.replace(/\{count\}/g, value).replace(/\s+/g, ' ').trim();
  const chars = Array.from(name);
  return chars.length <= COUNTER_NAME_MAX ? name : chars.slice(0, COUNTER_NAME_MAX).join('').trimEnd();
}

export class CounterService implements CounterServiceApi {
  private readonly repos: Repositories;
  private readonly events: AppEvents;
  private readonly audit: AuditService;
  private readonly discord: Pick<DiscordActions, 'renameChannel'>;
  private readonly presence: CounterPresence | null;
  private readonly clock: () => number;
  private readonly timing: CounterServiceTiming;

  private readonly channels = new Map<string, ChannelState>();
  /** Pending evaluation per guild and when it fires (ms). */
  private readonly timers = new Map<string, { timer: NodeJS.Timeout; at: number }>();
  /** Guilds being evaluated right now, and whether another evaluation was asked meanwhile. */
  private readonly inFlight = new Map<string, { again: boolean; force: boolean }>();
  /** Last admin warning per `guildId:channelId:outcome`. */
  private readonly warnedAt = new Map<string, number>();
  private readonly unsubscribers: Array<() => void> = [];
  private safetyTimer: NodeJS.Timeout | null = null;
  private firstTimer: NodeJS.Timeout | null = null;
  private running = false;
  /** After stop() nothing is scheduled anymore. */
  private stopped = false;

  constructor(deps: CounterServiceDeps) {
    this.repos = deps.repos;
    this.events = deps.events;
    this.audit = deps.audit;
    this.discord = deps.discord;
    this.presence = deps.presence ?? null;
    this.clock = deps.clock ?? Date.now;
    this.timing = { ...DEFAULT_COUNTER_TIMING, ...deps.timing };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.unsubscribers.push(this.events.on('live.changed', (payload) => this.refresh(payload.guildId)));
    if (this.presence?.onChange) {
      try {
        this.unsubscribers.push(this.presence.onChange((guildId) => this.refresh(guildId)));
      } catch (err) {
        log.warn({ err }, 'Subscribing to presence changes failed');
      }
    }
    this.firstTimer = setTimeout(() => void this.safetyPass(), Math.max(0, this.timing.firstPassDelayMs));
    this.firstTimer.unref();
    this.safetyTimer = setInterval(() => void this.safetyPass(), Math.max(1_000, this.timing.safetyMs));
    this.safetyTimer.unref();
  }

  stop(): void {
    this.running = false;
    this.stopped = true;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    if (this.safetyTimer) clearInterval(this.safetyTimer);
    if (this.firstTimer) clearTimeout(this.firstTimer);
    this.safetyTimer = null;
    this.firstTimer = null;
    for (const { timer } of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  refresh(guildId: string): void {
    if (!guildId) return;
    this.schedule(guildId, this.clock() + Math.max(0, this.timing.debounceMs));
  }

  /** Number of distinct members live in the guild right now. */
  liveCount(guildId: string): number {
    const members = new Set<string>();
    for (const session of this.repos.sessions.listActive(guildId)) {
      const streamer = this.repos.streamers.get(session.streamerId);
      if (streamer?.enabled) members.add(streamer.discordUserId);
    }
    if (this.presence && this.repos.settings.get(guildId).features.presence.enabled) {
      try {
        for (const userId of this.presence.liveUserIds(guildId)) members.add(userId);
      } catch (err) {
        log.warn({ err, guildId }, 'Reading presence-live members failed');
      }
    }
    return members.size;
  }

  /**
   * Evaluates one guild now (public for tests/tools): renames the counter channel when its wanted name changed and
   * the throttle allows it, otherwise schedules the evaluation for when it does. `force` also re-applies a name
   * that matches our last rename (a manual rename is undone; an unchanged name costs no rename).
   */
  async update(guildId: string, force = false): Promise<void> {
    const running = this.inFlight.get(guildId);
    if (running) {
      running.again = true;
      running.force ||= force;
      return;
    }
    const flight = { again: false, force: false };
    this.inFlight.set(guildId, flight);
    try {
      await this.evaluate(guildId, force);
    } catch (err) {
      log.error({ err, guildId }, 'Counter update failed');
    } finally {
      this.inFlight.delete(guildId);
    }
    if (flight.again) await this.update(guildId, flight.force);
  }

  private async evaluate(guildId: string, force: boolean): Promise<void> {
    const settings = this.repos.settings.get(guildId);
    const { channelId, template } = settings.features.counter;
    if (!channelId) return;
    const lang = settings.features.language;
    const name = renderCounterName(template, this.liveCount(guildId), lang);
    const key = `${guildId}:${channelId}`;
    const state = this.stateOf(key);
    if (name === state.lastName && !force) return;

    const now = this.clock();
    const notBefore = Math.max(state.lastRenameAt + this.timing.throttleMs, state.notBefore);
    if (now < notBefore) {
      // Coalesced: the evaluation at `notBefore` uses the latest count. A forced check of an unchanged name waits
      // for the next safety pass instead.
      if (name !== state.lastName) this.schedule(guildId, notBefore);
      return;
    }

    let result: { outcome: RenameOutcome; retryAfterMs?: number };
    try {
      result = await this.discord.renameChannel(guildId, channelId, name);
    } catch (err) {
      log.warn({ err, guildId, channelId }, 'Counter rename threw');
      result = { outcome: 'error' };
    }
    const at = this.clock();
    switch (result.outcome) {
      case 'ok':
        state.lastName = name;
        state.lastRenameAt = at;
        state.notBefore = 0;
        log.info({ guildId, channelId, name }, 'Live counter updated');
        this.clearWarnings(key);
        break;
      case 'unchanged':
        state.lastName = name;
        state.notBefore = 0;
        this.clearWarnings(key);
        break;
      case 'rate_limited': {
        const wait = Math.max(Number(result.retryAfterMs) || 0, this.timing.throttleMs);
        state.notBefore = at + wait;
        log.info({ guildId, channelId, retryInMs: wait }, 'Live counter rename rate limited');
        this.schedule(guildId, state.notBefore);
        break;
      }
      case 'forbidden':
      case 'missing':
        // Retried with the next change or safety pass, no sooner than one throttle window (the admin may fix
        // the permission or the channel meanwhile).
        state.notBefore = at + this.timing.throttleMs;
        this.warn(guildId, channelId, result.outcome, lang);
        break;
      default:
        state.notBefore = at + this.timing.errorRetryMs;
        this.schedule(guildId, state.notBefore);
        break;
    }
  }

  /** Safety pass: every guild with a counter channel, forced (manual renames are undone, missed events caught). */
  async safetyPass(): Promise<void> {
    let guildIds: string[];
    try {
      guildIds = this.repos.settings.listGuildIds().filter((id) => !!this.repos.settings.get(id).features.counter.channelId);
    } catch (err) {
      log.error({ err }, 'Listing counter guilds failed');
      return;
    }
    for (const guildId of guildIds) await this.update(guildId, true);
  }

  private stateOf(key: string): ChannelState {
    let state = this.channels.get(key);
    if (!state) {
      state = { lastName: null, lastRenameAt: Number.NEGATIVE_INFINITY, notBefore: 0 };
      this.channels.set(key, state);
    }
    return state;
  }

  /** Schedules an evaluation of the guild at `at` (an earlier pending one is kept). */
  private schedule(guildId: string, at: number): void {
    if (this.stopped) return;
    const pending = this.timers.get(guildId);
    if (pending && pending.at <= at) return;
    if (pending) clearTimeout(pending.timer);
    const delay = Math.max(0, at - this.clock());
    const timer = setTimeout(() => {
      this.timers.delete(guildId);
      void this.update(guildId);
    }, delay);
    timer.unref();
    this.timers.set(guildId, { timer, at });
  }

  private warn(guildId: string, channelId: string, outcome: 'forbidden' | 'missing', lang: Language): void {
    const key = `${guildId}:${channelId}:${outcome}`;
    const now = this.clock();
    const last = this.warnedAt.get(key);
    if (last !== undefined && now - last < this.timing.warnIntervalMs) return;
    this.warnedAt.set(key, now);
    this.audit.record({
      guildId,
      action: 'counter.failed',
      level: 'warn',
      message: t(lang, outcome === 'forbidden' ? 'audit.forbidden' : 'audit.missing', { channel: channelId }),
      details: { channelId, outcome },
    });
  }

  private clearWarnings(channelKey: string): void {
    for (const key of [...this.warnedAt.keys()]) if (key.startsWith(`${channelKey}:`)) this.warnedAt.delete(key);
  }
}
