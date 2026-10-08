/**
 * #15 — Discord "Streaming" presence detection.
 *
 * When a member shows a Streaming activity (Discord status linked to Twitch/YouTube...), the bot can treat them as
 * live even without a tracked platform account: it gives the "Streaming Now" role, records a PresenceGrant and,
 * when `features.presence.notify` is on, posts a simple live notification that turns into an "ended" card later.
 *
 * Design notes
 * - Platform sessions win: a member who already has an active platform session gets nothing extra (the session
 *   owns role + notification). A presence that outlives a just-ended platform session by less than
 *   `sessionGraceMs` is treated as Discord's status lagging behind and re-checked after the grace.
 * - Grants persist in the DB, so a restart neither re-notifies nor forgets roles to remove; `reconcile()` compares
 *   the grants with the gateway's current Streaming presences (on start, periodically and after a gateway
 *   recovery) and ends stale ones / starts missing ones. Without a presence snapshot (Discord not ready) nothing is
 *   changed; with the feature turned off (or no Presence intent) every grant is ended.
 * - Flapping is debounced: an end is applied only when no new start arrives within `endDebounceMs`.
 * - Every change of one member runs under a per-member lock, so events, reconciles and timers never race.
 * - The role is removed at the end only when the member has no active platform session; role changes that fail
 *   transiently are retried with backoff (the desired state is re-read each time).
 * - The SessionService is told about presence-live members (`setExtraLiveUsers`), so its live-role reconcile keeps
 *   their role and the end of a platform session does not strip it while the presence goes on.
 * - Never throws to the Discord layer; failures are logged and healed by the periodic reconcile.
 */
import type { PresenceServiceApi, SessionServiceApi, StreamingActivity } from '../app/context.js';
import { errorMessage } from '../core/errors.js';
import type { AppEvents } from '../core/events.js';
import { childLogger } from '../core/logger.js';
import { PLATFORM_LABELS } from '../core/types.js';
import type { GuildSettings, PresenceGrant, Streamer } from '../db/models.js';
import type { Repositories } from '../db/repositories.js';
import { defineMessages } from '../discord/i18n/index.js';
import type { AuditService } from './audit.js';
import type { DiscordActions, DiscordGateway, DiscordMemberInfo, MessageRef, Notifier, PresenceLiveView, RoleChangeOutcome, RoleManager } from './ports.js';
import { KeyedMutex } from './sessionService.js';
import { iso, parseTime } from './views.js';

const log = childLogger('presence');

const t = defineMessages({
  'role.reason.start': { ar: 'يبث الحين (حالة ديسكورد)', en: 'Streaming now (Discord status)' },
  'role.reason.end': { ar: 'انتهى البث (حالة ديسكورد)', en: 'Stream ended (Discord status)' },
  'audit.start': { ar: '{name} يبث الحين{platform} — حسب حالة ديسكورد', en: '{name} is streaming now{platform} — from their Discord status' },
  'audit.start.platform': { ar: ' على {platform}', en: ' on {platform}' },
  'audit.end': { ar: '{name} وقف البث — حسب حالة ديسكورد', en: '{name} stopped streaming — from their Discord status' },
  'audit.end.disabled': {
    ar: 'شلنا رتبة البث من {name} لأن كشف البث من حالة ديسكورد صار متوقف',
    en: 'Removed the live role from {name} because Discord status detection is now off',
  },
  'audit.end.scope': {
    ar: 'شلنا رتبة البث من {name} لأنه ما عاد ضمن نطاق كشف البث من حالة ديسكورد',
    en: 'Removed the live role from {name} because they are no longer covered by Discord status detection',
  },
  'audit.role_giveup': {
    ar: 'ما قدرنا نعدّل رتبة البث لـ {name} (حالة ديسكورد) بعد محاولات لمدة يوم — تأكد من صلاحية Manage Roles وترتيب رتبة البوت',
    en: 'Could not update the live role of {name} (Discord status) after retrying for a day — check Manage Roles and the bot role position',
  },
});

export interface PresenceServiceTiming {
  /** An end followed by a new start within this window is ignored (Discord status flapping). */
  endDebounceMs: number;
  /** Periodic re-sync with the gateway's presences (also retries failed role changes). */
  reconcileMs: number;
  /** Delay of the first re-sync after start() (Discord logs in meanwhile). */
  firstReconcileDelayMs: number;
  /** A presence that outlives a tracked platform session by less than this is Discord's status lagging behind. */
  sessionGraceMs: number;
  /** Backoff of role changes that failed transiently (the last delay repeats). */
  roleRetryDelaysMs: number[];
  /** Transient role failures are given up after this long. */
  roleRetryMaxAgeMs: number;
}

export const DEFAULT_PRESENCE_TIMING: PresenceServiceTiming = {
  endDebounceMs: 60_000,
  reconcileMs: 5 * 60_000,
  firstReconcileDelayMs: 15_000,
  sessionGraceMs: 10 * 60_000,
  roleRetryDelaysMs: [1, 2, 5, 10].map((m) => m * 60_000),
  roleRetryMaxAgeMs: 24 * 3_600_000,
};

/** Discord access needed by the presence service (the DiscordApi satisfies it). */
export type PresenceDiscord = DiscordActions &
  Pick<DiscordGateway, 'fetchMember'> & {
    /** False when the bot runs without the privileged Presence intent (then presence grants are ended). */
    presenceIntentEnabled?: () => boolean;
  };

export interface PresenceServiceDeps {
  repos: Repositories;
  audit: AuditService;
  events: AppEvents;
  notifier: Notifier;
  roles: RoleManager;
  discord: PresenceDiscord;
  /** Told about presence-live members (setExtraLiveUsers) so its role reconcile keeps them. */
  sessions: Pick<SessionServiceApi, 'setExtraLiveUsers'>;
  clock?: () => number;
  timing?: Partial<PresenceServiceTiming>;
}

type EndReason = 'ended' | 'disabled' | 'scope';

interface RoleRetry {
  guildId: string;
  userId: string;
  attempt: number;
  dueAt: number;
  since: number;
}

interface MemberCard {
  displayName: string;
  avatarUrl: string | null;
}

const keyOf = (guildId: string, userId: string): string => `${guildId}:${userId}`;

function sameDetails(grant: PresenceGrant, activity: StreamingActivity): boolean {
  return grant.url === activity.url && grant.platform === activity.platform && grant.title === activity.title && grant.game === activity.game;
}

export class PresenceService implements PresenceServiceApi {
  private readonly repos: Repositories;
  private readonly audit: AuditService;
  private readonly events: AppEvents;
  private readonly notifier: Notifier;
  private readonly roles: RoleManager;
  private readonly discord: PresenceDiscord;
  private readonly clock: () => number;
  private readonly timing: PresenceServiceTiming;

  private readonly lock = new KeyedMutex<string>();
  /** Last known Streaming activity per guild and member (only members currently streaming). */
  private readonly activities = new Map<string, Map<string, StreamingActivity>>();
  /** Debounced ends, by member key. */
  private readonly endTimers = new Map<string, NodeJS.Timeout>();
  /** Re-checks after a platform session ended while the presence went on, by member key. */
  private readonly handoffTimers = new Map<string, NodeJS.Timeout>();
  private readonly roleRetries = new Map<string, RoleRetry>();
  /** Member names/avatars seen at the start (for the "ended" card when the member left meanwhile). */
  private readonly cards = new Map<string, MemberCard>();
  private readonly listeners = new Set<(guildId: string) => void>();
  private unsubscribe: (() => void) | null = null;
  private firstTimer: NodeJS.Timeout | null = null;
  private interval: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private passBusy = false;
  /** Ordering of presence events vs. reconcile snapshots (a newer event wins over an older snapshot). */
  private seq = 0;
  private readonly eventSeq = new Map<string, number>();

  constructor(deps: PresenceServiceDeps) {
    this.repos = deps.repos;
    this.audit = deps.audit;
    this.events = deps.events;
    this.notifier = deps.notifier;
    this.roles = deps.roles;
    this.discord = deps.discord;
    this.clock = deps.clock ?? Date.now;
    this.timing = { ...DEFAULT_PRESENCE_TIMING, ...deps.timing };
    try {
      deps.sessions.setExtraLiveUsers(this);
    } catch (err) {
      log.warn({ err }, 'Registering presence-live members with the session service failed');
    }
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.unsubscribe = this.events.on('live.changed', (payload) => {
      if (payload.status === 'ended') this.onSessionEnded(payload.guildId, payload.streamerId);
    });
    this.firstTimer = setTimeout(() => void this.periodic(), Math.max(0, this.timing.firstReconcileDelayMs));
    this.firstTimer.unref();
    this.interval = setInterval(() => void this.periodic(), Math.max(1_000, this.timing.reconcileMs));
    this.interval.unref();
  }

  stop(): void {
    this.running = false;
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.firstTimer) clearTimeout(this.firstTimer);
    if (this.interval) clearInterval(this.interval);
    this.firstTimer = null;
    this.interval = null;
    for (const timer of [...this.endTimers.values(), ...this.handoffTimers.values()]) clearTimeout(timer);
    this.endTimers.clear();
    this.handoffTimers.clear();
  }

  /** Subscribes to changes of the presence-live set of a guild (the live counter uses it). Returns an unsubscribe. */
  onChange(listener: (guildId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ───────────────────────────── API ─────────────────────────────

  async onPresence(guildId: string, userId: string, activity: StreamingActivity | null): Promise<void> {
    if (!guildId || !userId) return;
    const key = keyOf(guildId, userId);
    try {
      if (!this.repos.settings.get(guildId).features.presence.enabled) {
        // Feature off: keep no state for the member; a grant left from before is ended.
        this.remember(guildId, userId, null);
        this.eventSeq.delete(key);
        if (this.repos.presence.get(guildId, userId)) await this.lock.run(key, () => this.evaluate(guildId, userId, null));
        return;
      }
      this.eventSeq.set(key, ++this.seq);
      this.remember(guildId, userId, activity);
      if (activity) {
        this.cancelEnd(key);
        await this.lock.run(key, () => this.evaluate(guildId, userId, activity));
        return;
      }
      if (!this.repos.presence.get(guildId, userId)) return;
      if (this.timing.endDebounceMs <= 0) await this.lock.run(key, () => this.endIfStillOff(guildId, userId));
      else this.scheduleEnd(guildId, userId);
    } catch (err) {
      log.error({ err, guildId, userId }, 'Presence update handling failed');
    }
  }

  liveUserIds(guildId: string): Set<string> {
    try {
      return new Set(this.repos.presence.list(guildId).map((g) => g.userId));
    } catch (err) {
      log.warn({ err, guildId }, 'Listing presence grants failed');
      return new Set();
    }
  }

  /**
   * Re-syncs grants with the current Streaming presences of one guild (or of every guild with grants or with the
   * feature on). Never throws.
   */
  async reconcile(guildId?: string): Promise<void> {
    let guildIds: string[];
    try {
      guildIds = guildId ? [guildId] : this.reconcileTargets();
    } catch (err) {
      log.error({ err }, 'Listing guilds for the presence reconcile failed');
      return;
    }
    for (const id of guildIds) {
      try {
        await this.reconcileGuild(id);
      } catch (err) {
        log.error({ err, guildId: id }, 'Presence reconcile failed');
      }
    }
  }

  // ───────────────────────────── core ─────────────────────────────

  /** Applies the member's current activity (null = not streaming). Must run under the member's lock. */
  private async evaluate(guildId: string, userId: string, activity: StreamingActivity | null): Promise<void> {
    const settings = this.repos.settings.get(guildId);
    const feature = settings.features.presence;
    const grant = this.repos.presence.get(guildId, userId);
    const streamer = this.repos.streamers.getByDiscordId(guildId, userId);

    if (!feature.enabled || !this.intentAvailable()) {
      if (grant) await this.endGrant(grant, settings, 'disabled');
      return;
    }
    if (feature.scope !== 'everyone' && !streamer?.enabled) {
      if (grant) await this.endGrant(grant, settings, 'scope');
      return;
    }
    if (!activity) {
      if (grant) await this.endGrant(grant, settings, 'ended');
      return;
    }
    if (grant) {
      if (!sameDetails(grant, activity)) this.repos.presence.upsert({ ...grant, ...activityFields(activity) });
      return;
    }
    // The platform session owns the role and the notification.
    if (this.hasActiveSession(guildId, userId)) return;
    const graceEnd = this.platformGraceEnd(streamer);
    if (graceEnd !== null) {
      this.scheduleHandoff(guildId, userId, graceEnd - this.clock() + 1_000);
      return;
    }
    await this.startGrant(guildId, userId, activity, settings, streamer);
  }

  private async startGrant(guildId: string, userId: string, activity: StreamingActivity, settings: GuildSettings, streamer: Streamer | null): Promise<void> {
    const lookup = await this.lookupMember(guildId, userId);
    if (lookup.member?.bot) return;
    // Not in the guild (anymore): nothing to give. A failed lookup is not proof, so it proceeds.
    if (!lookup.member && !lookup.failed) return;
    const key = keyOf(guildId, userId);
    const card: MemberCard = {
      displayName: streamer?.displayName ?? lookup.member?.displayName ?? this.cards.get(key)?.displayName ?? userId,
      avatarUrl: lookup.member?.avatarUrl ?? this.cards.get(key)?.avatarUrl ?? null,
    };
    this.cards.set(key, card);

    const grant: PresenceGrant = {
      guildId,
      userId,
      startedAt: iso(this.clock()),
      ...activityFields(activity),
      messageChannelId: null,
      messageId: null,
    };
    // Recorded before the role change: a concurrent live-role reconcile must already count the member as live.
    this.repos.presence.upsert(grant);
    const lang = settings.features.language;
    await this.applyRole(guildId, userId, true, t(lang, 'role.reason.start'));

    // A stream that a tracked account will announce anyway (the monitor usually notices it a little later) gets
    // the role now but no extra notification: presence posts are for streams the bot does not track.
    if (settings.features.presence.notify && !this.coveredByTrackedAccount(settings, streamer, activity)) {
      let ref: MessageRef | null = null;
      try {
        ref = await this.notifier.postPresenceLive(this.view(grant, settings, streamer, card, null));
      } catch (err) {
        log.warn({ err, guildId, userId }, 'Posting presence notification failed');
      }
      if (ref && this.repos.presence.get(guildId, userId)) {
        this.repos.presence.upsert({ ...grant, messageChannelId: ref.channelId, messageId: ref.messageId });
      }
    }

    this.audit.record({
      guildId,
      action: 'presence.start',
      message: t(lang, 'audit.start', {
        name: card.displayName,
        platform: activity.platform ? t(lang, 'audit.start.platform', { platform: PLATFORM_LABELS[activity.platform] }) : '',
      }),
      details: { userId, streamerId: streamer?.id ?? null, url: activity.url, platform: activity.platform },
      mirror: false,
    });
    this.emitChange(guildId);
  }

  /** Deletes the grant, removes the role (unless a platform session holds it) and turns the notification into "ended". */
  private async endGrant(grant: PresenceGrant, settings: GuildSettings, reason: EndReason): Promise<void> {
    const { guildId, userId } = grant;
    const key = keyOf(guildId, userId);
    this.cancelEnd(key);
    this.repos.presence.delete(guildId, userId);
    const lang = settings.features.language;
    if (!this.hasActiveSession(guildId, userId)) await this.applyRole(guildId, userId, false, t(lang, 'role.reason.end'));
    else this.roleRetries.delete(key);

    const streamer = this.repos.streamers.getByDiscordId(guildId, userId);
    const card = this.cards.get(key) ?? (await this.cardFor(guildId, userId, streamer));
    this.cards.delete(key);
    if (grant.messageChannelId && grant.messageId) {
      const ref = { channelId: grant.messageChannelId, messageId: grant.messageId };
      try {
        const edited = await this.notifier.endPresenceLive(ref, this.view(grant, settings, streamer, card, iso(this.clock())));
        if (!edited) log.info({ guildId, userId, ref }, 'Presence notification is gone; nothing to end');
      } catch (err) {
        log.warn({ err, guildId, userId }, 'Ending presence notification failed');
      }
    }

    const messageKey = reason === 'disabled' ? 'audit.end.disabled' : reason === 'scope' ? 'audit.end.scope' : 'audit.end';
    this.audit.record({
      guildId,
      action: 'presence.end',
      message: t(lang, messageKey, { name: card.displayName }),
      details: { userId, streamerId: streamer?.id ?? null, reason, startedAt: grant.startedAt },
      mirror: false,
    });
    this.emitChange(guildId);
  }

  private async endIfStillOff(guildId: string, userId: string): Promise<void> {
    // A new start arrived meanwhile (the start cancels the timer, this is the safety net).
    if (this.activities.get(guildId)?.has(userId)) return;
    await this.evaluate(guildId, userId, null);
  }

  private async reconcileGuild(guildId: string): Promise<void> {
    const settings = this.repos.settings.get(guildId);
    const grants = this.repos.presence.list(guildId);
    if (!settings.features.presence.enabled || !this.intentAvailable()) {
      this.activities.delete(guildId);
      for (const key of this.eventSeq.keys()) if (key.startsWith(`${guildId}:`)) this.eventSeq.delete(key);
      for (const grant of grants) await this.lock.run(keyOf(guildId, grant.userId), () => this.evaluate(guildId, grant.userId, null));
      return;
    }
    const snapshotSeq = ++this.seq;
    let presences: Map<string, StreamingActivity> | null = null;
    try {
      presences = await this.discord.streamingPresences(guildId);
    } catch (err) {
      log.warn({ err: errorMessage(err), guildId }, 'Reading Streaming presences failed');
    }
    // Discord not ready / no snapshot yet: an unknown state must not end anything.
    if (!presences) return;

    // A presence event newer than the snapshot wins over it (the event handler applies it itself).
    const fresher = (userId: string): boolean => (this.eventSeq.get(keyOf(guildId, userId)) ?? 0) > snapshotSeq;
    const merged = new Map<string, StreamingActivity>();
    for (const [userId, activity] of presences) if (!fresher(userId)) merged.set(userId, activity);
    for (const [userId, activity] of this.activities.get(guildId) ?? []) if (fresher(userId)) merged.set(userId, activity);
    if (merged.size > 0) this.activities.set(guildId, merged);
    else this.activities.delete(guildId);

    const userIds = new Set([...grants.map((g) => g.userId), ...presences.keys()]);
    for (const userId of userIds) {
      const key = keyOf(guildId, userId);
      await this.lock
        .run(key, async () => {
          if (fresher(userId)) return;
          // The snapshot is authoritative: a pending debounced end is applied (or dropped) now.
          this.cancelEnd(key);
          await this.evaluate(guildId, userId, presences.get(userId) ?? null);
        })
        .catch((err) => log.error({ err, guildId, userId }, 'Presence reconcile of a member failed'));
    }
    for (const [key, seq] of this.eventSeq) if (seq < snapshotSeq && key.startsWith(`${guildId}:`)) this.eventSeq.delete(key);
  }

  // ───────────────────────────── roles ─────────────────────────────

  private async applyRole(guildId: string, userId: string, live: boolean, reason: string): Promise<RoleChangeOutcome> {
    const key = keyOf(guildId, userId);
    let outcome: RoleChangeOutcome;
    try {
      outcome = await this.roles.setLive(guildId, userId, live, reason);
    } catch (err) {
      log.warn({ err, guildId, userId, live }, 'Presence live role change threw');
      outcome = 'transient';
    }
    if (outcome !== 'transient') {
      this.roleRetries.delete(key);
      return outcome;
    }
    if (!this.roleRetries.has(key)) {
      const now = this.clock();
      this.roleRetries.set(key, { guildId, userId, attempt: 0, dueAt: now + this.retryDelay(0), since: now });
      log.warn({ guildId, userId, live }, 'Presence live role change failed transiently; will retry');
    }
    return outcome;
  }

  private async retryRoles(): Promise<void> {
    const now = this.clock();
    for (const [key, entry] of [...this.roleRetries]) {
      if (entry.dueAt > now) continue;
      await this.lock
        .run(key, async () => {
          if (this.roleRetries.get(key) !== entry) return; // superseded meanwhile
          const settings = this.repos.settings.get(entry.guildId);
          const live = !!this.repos.presence.get(entry.guildId, entry.userId) || this.hasActiveSession(entry.guildId, entry.userId);
          let outcome: RoleChangeOutcome;
          try {
            outcome = await this.roles.setLive(entry.guildId, entry.userId, live, t(settings.features.language, live ? 'role.reason.start' : 'role.reason.end'));
          } catch {
            outcome = 'transient';
          }
          if (this.roleRetries.get(key) !== entry) return;
          const at = this.clock();
          if (outcome !== 'transient') {
            this.roleRetries.delete(key);
            return;
          }
          if (at - entry.since >= this.timing.roleRetryMaxAgeMs) {
            this.roleRetries.delete(key);
            const streamer = this.repos.streamers.getByDiscordId(entry.guildId, entry.userId);
            this.audit.record({
              guildId: entry.guildId,
              action: 'presence.role_failed',
              level: 'warn',
              message: t(settings.features.language, 'audit.role_giveup', { name: streamer?.displayName ?? this.cards.get(key)?.displayName ?? entry.userId }),
              details: { userId: entry.userId, live },
            });
            return;
          }
          const attempt = entry.attempt + 1;
          this.roleRetries.set(key, { ...entry, attempt, dueAt: at + this.retryDelay(attempt) });
        })
        .catch((err) => log.warn({ err, guildId: entry.guildId }, 'Presence role retry failed'));
    }
  }

  private retryDelay(attempt: number): number {
    const delays = this.timing.roleRetryDelaysMs;
    return delays[Math.min(attempt, delays.length - 1)] ?? 5 * 60_000;
  }

  // ───────────────────────────── timers ─────────────────────────────

  /** Periodic pass: role retries, then a full reconcile. One at a time; never throws. */
  async periodic(): Promise<void> {
    if (this.passBusy) return;
    this.passBusy = true;
    try {
      await this.retryRoles();
      await this.reconcile();
    } catch (err) {
      log.error({ err }, 'Presence maintenance pass failed');
    } finally {
      this.passBusy = false;
    }
  }

  private scheduleEnd(guildId: string, userId: string): void {
    const key = keyOf(guildId, userId);
    if (this.stopped || this.endTimers.has(key)) return;
    const timer = setTimeout(() => {
      this.endTimers.delete(key);
      this.lock.run(key, () => this.endIfStillOff(guildId, userId)).catch((err) => log.error({ err, guildId, userId }, 'Debounced presence end failed'));
    }, this.timing.endDebounceMs);
    timer.unref();
    this.endTimers.set(key, timer);
  }

  private cancelEnd(key: string): void {
    const timer = this.endTimers.get(key);
    if (timer) clearTimeout(timer);
    this.endTimers.delete(key);
  }

  /** A platform session of a member ended: if their presence goes on, re-check once the grace has passed. */
  private onSessionEnded(guildId: string, streamerId: number): void {
    try {
      const streamer = this.repos.streamers.get(streamerId);
      if (!streamer || streamer.guildId !== guildId) return;
      if (!this.activities.get(guildId)?.has(streamer.discordUserId)) return;
      if (!this.repos.settings.get(guildId).features.presence.enabled) return;
      this.scheduleHandoff(guildId, streamer.discordUserId, this.timing.sessionGraceMs + 1_000);
    } catch (err) {
      log.warn({ err, guildId, streamerId }, 'Presence handoff after session end failed');
    }
  }

  private scheduleHandoff(guildId: string, userId: string, delayMs: number): void {
    const key = keyOf(guildId, userId);
    if (this.stopped) return;
    const previous = this.handoffTimers.get(key);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(
      () => {
        this.handoffTimers.delete(key);
        const activity = this.activities.get(guildId)?.get(userId);
        if (!activity) return;
        this.lock.run(key, () => this.evaluate(guildId, userId, activity)).catch((err) => log.error({ err, guildId, userId }, 'Presence handoff check failed'));
      },
      Math.max(1_000, delayMs),
    );
    timer.unref();
    this.handoffTimers.set(key, timer);
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private remember(guildId: string, userId: string, activity: StreamingActivity | null): void {
    let members = this.activities.get(guildId);
    if (activity) {
      if (!members) this.activities.set(guildId, (members = new Map()));
      members.set(userId, activity);
    } else if (members) {
      members.delete(userId);
      if (members.size === 0) this.activities.delete(guildId);
    }
  }

  /** Guilds to reconcile: every guild with grants or with the feature on. */
  private reconcileTargets(): string[] {
    const ids = new Set(this.repos.presence.list().map((g) => g.guildId));
    for (const guildId of this.repos.settings.listGuildIds()) {
      if (this.repos.settings.get(guildId).features.presence.enabled) ids.add(guildId);
    }
    return [...ids];
  }

  private intentAvailable(): boolean {
    try {
      return this.discord.presenceIntentEnabled ? this.discord.presenceIntentEnabled() !== false : true;
    } catch {
      return true;
    }
  }

  /** True when the member has an active platform session in the guild (as an enabled registered streamer). */
  private hasActiveSession(guildId: string, userId: string): boolean {
    const streamer = this.repos.streamers.getByDiscordId(guildId, userId);
    return !!streamer?.enabled && this.repos.sessions.getActive(streamer.id) !== null;
  }

  /**
   * True when the streamer has a tracked account (live notifications on, platform enabled) that matches the
   * presence: same platform and, when the stream URL names a channel, the same handle. YouTube URLs rarely name the
   * channel, so any YouTube account counts there.
   */
  private coveredByTrackedAccount(settings: GuildSettings, streamer: Streamer | null, activity: StreamingActivity): boolean {
    if (!streamer?.enabled || !activity.platform || !settings.platformsEnabled.includes(activity.platform)) return false;
    let accounts: Array<{ handle: string }>;
    try {
      accounts = this.repos.accounts
        .listForStreamer(streamer.id)
        .filter((a) => a.notifyLive && a.channel.platform === activity.platform)
        .map((a) => ({ handle: a.channel.handle }));
    } catch (err) {
      log.warn({ err, streamerId: streamer.id }, 'Reading streamer accounts failed');
      return false;
    }
    if (accounts.length === 0) return false;
    const handle = activity.platform === 'youtube' ? null : channelHandleFromUrl(activity.url);
    return handle === null || accounts.some((a) => a.handle.replace(/^@/, '').toLowerCase() === handle);
  }

  /** End of the grace window after the member's last platform session ended, or null when it is over. */
  private platformGraceEnd(streamer: Streamer | null): number | null {
    const grace = this.timing.sessionGraceMs;
    if (!streamer || grace <= 0) return null;
    const now = this.clock();
    const recent = this.repos.sessions.getRecentlyEnded(streamer.id, iso(now - grace));
    const endedAt = parseTime(recent?.endedAt);
    return endedAt !== null && endedAt + grace > now ? endedAt + grace : null;
  }

  private async lookupMember(guildId: string, userId: string): Promise<{ member: DiscordMemberInfo | null; failed: boolean }> {
    try {
      return { member: await this.discord.fetchMember(guildId, userId), failed: false };
    } catch (err) {
      log.debug({ err: errorMessage(err), guildId, userId }, 'Member lookup failed');
      return { member: null, failed: true };
    }
  }

  private async cardFor(guildId: string, userId: string, streamer: Streamer | null): Promise<MemberCard> {
    const { member } = await this.lookupMember(guildId, userId);
    return { displayName: streamer?.displayName ?? member?.displayName ?? userId, avatarUrl: member?.avatarUrl ?? null };
  }

  private view(grant: PresenceGrant, settings: GuildSettings, streamer: Streamer | null, card: MemberCard, endedAt: string | null): PresenceLiveView {
    return {
      guildId: grant.guildId,
      settings,
      userId: grant.userId,
      displayName: card.displayName,
      avatarUrl: card.avatarUrl,
      streamer,
      url: grant.url,
      platform: grant.platform,
      title: grant.title,
      game: grant.game,
      startedAt: grant.startedAt,
      endedAt,
    };
  }

  private emitChange(guildId: string): void {
    for (const listener of this.listeners) {
      try {
        listener(guildId);
      } catch (err) {
        log.warn({ err, guildId }, 'Presence change listener failed');
      }
    }
  }
}

/** Lower-cased channel handle named by a stream URL (first path segment, without "@"), or null. */
export function channelHandleFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const first = new URL(url).pathname.split('/').find(Boolean);
    const handle = first?.replace(/^@/, '').trim().toLowerCase();
    return handle ? handle : null;
  } catch {
    return null;
  }
}

function activityFields(activity: StreamingActivity): Pick<PresenceGrant, 'url' | 'platform' | 'title' | 'game'> {
  return { url: activity.url ?? null, platform: activity.platform ?? null, title: activity.title ?? null, game: activity.game ?? null };
}
