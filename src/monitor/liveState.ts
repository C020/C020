/**
 * Pure live-state machine for a single platform channel.
 *
 * The monitor feeds every successful snapshot through here and persists the resulting state. Keeping this
 * free of I/O and clocks (callers pass `nowMs`) makes the flapping / grace-period rules easy to test.
 */
import type { LiveSnapshot } from '../core/types.js';

export interface LiveState {
  isLive: boolean;
  /** Latest live snapshot while live (kept during the offline grace period); null when offline. */
  snapshot: LiveSnapshot | null;
  /** When the channel became live (platform-reported start when plausible, otherwise detection time). */
  liveSince: string | null;
  /** First time the channel looked offline while still considered live (start of the grace period). */
  offlineSince: string | null;
  /** Consecutive offline snapshots seen while still considered live. */
  missCount: number;
}

export type LiveEvent = 'live' | 'update' | 'offline';

export interface LiveTransition {
  state: LiveState;
  event: LiveEvent | null;
  /** 'update' only: both snapshots carry a stream id and they differ (reconnect / new broadcast). */
  streamChanged: boolean;
  /** 'offline' only: when the channel was first seen offline (ISO). */
  endedAt: string | null;
  /** 'offline' only: the last live snapshot before the channel went offline. */
  lastSnapshot: LiveSnapshot | null;
}

export interface LiveStateOptions {
  /** A live channel must look offline for at least this long before it is declared offline. */
  graceMs: number;
  /** ...and for at least this many consecutive checks. */
  minMisses: number;
}

export interface LiveEvaluationOptions extends LiveStateOptions {
  /** A live channel we could not check for this long is considered stale (see evaluateSnapshot). */
  staleMs: number;
}

export function offlineState(): LiveState {
  return { isLive: false, snapshot: null, liveSince: null, offlineSince: null, missCount: 0 };
}

export function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** True when both snapshots identify their broadcast and the ids differ. */
export function isDifferentStream(prev: LiveSnapshot | null, next: LiveSnapshot): boolean {
  return !!prev?.streamId && !!next.streamId && prev.streamId !== next.streamId;
}

/** Platform start time when it is parseable and not in the future, otherwise the detection time. */
function liveSinceFor(snapshot: LiveSnapshot, nowMs: number): string {
  const started = parseTime(snapshot.startedAt);
  return iso(started !== null && started <= nowMs ? started : nowMs);
}

function result(state: LiveState, event: LiveEvent | null, extra: Partial<Omit<LiveTransition, 'state' | 'event'>> = {}): LiveTransition {
  return { state, event, streamChanged: false, endedAt: null, lastSnapshot: null, ...extra };
}

/**
 * Applies one snapshot to the previous state.
 * - offline → live: 'live'
 * - live + live: 'update' (cancels a pending offline; streamChanged when the stream id changed)
 * - live + offline: counts a miss and stays live until there were `minMisses` misses AND `graceMs`
 *   elapsed since the first one, then 'offline' (state reset, endedAt = first miss)
 * - offline + offline: nothing
 */
export function nextLiveState(prev: LiveState, snapshot: LiveSnapshot, nowMs: number, opts: LiveStateOptions): LiveTransition {
  if (snapshot.isLive) {
    if (!prev.isLive) {
      return result({ isLive: true, snapshot, liveSince: liveSinceFor(snapshot, nowMs), offlineSince: null, missCount: 0 }, 'live');
    }
    return result(
      { isLive: true, snapshot, liveSince: prev.liveSince ?? liveSinceFor(snapshot, nowMs), offlineSince: null, missCount: 0 },
      'update',
      { streamChanged: isDifferentStream(prev.snapshot, snapshot) },
    );
  }

  if (!prev.isLive) return result(offlineState(), null);

  const missCount = Math.max(0, prev.missCount) + 1;
  const firstMissMs = Math.min(parseTime(prev.offlineSince) ?? nowMs, nowMs);
  const offlineSince = iso(firstMissMs);
  if (missCount >= Math.max(1, opts.minMisses) && nowMs - firstMissMs >= opts.graceMs) {
    return result(offlineState(), 'offline', { endedAt: offlineSince, lastSnapshot: prev.snapshot });
  }
  return result({ ...prev, missCount, offlineSince }, null);
}

/**
 * Ends a live state without a snapshot (stale checks, channel no longer tracked).
 * endedAt is the start of a pending grace period when there is one, otherwise `endedAtMs`.
 */
export function forceOffline(prev: LiveState, endedAtMs: number): LiveTransition {
  if (!prev.isLive) return result(offlineState(), null);
  return result(offlineState(), 'offline', { endedAt: prev.offlineSince ?? iso(endedAtMs), lastSnapshot: prev.snapshot });
}

/** "Stale live": still live but no successful check for `staleMs` (avoids stuck roles when a platform is down). */
export function isStaleLive(isLive: boolean, lastSuccessAtMs: number | null, nowMs: number, staleMs: number): boolean {
  return isLive && lastSuccessAtMs !== null && nowMs - lastSuccessAtMs >= staleMs;
}

/** When a pending offline (live with misses) can be confirmed, or null when nothing is pending. */
export function offlineConfirmationAt(state: LiveState, opts: LiveStateOptions): number | null {
  if (!state.isLive || state.missCount <= 0) return null;
  const since = parseTime(state.offlineSince);
  return since === null ? null : since + opts.graceMs;
}

/**
 * nextLiveState plus handling of blind spots (bot downtime, long provider outages): when a live channel
 * has not been checked successfully for `staleMs`, what we see now may belong to a different broadcast.
 * - live again with another stream id → the old broadcast ended while we were blind: 'offline'
 *   (endedAt = last time we saw it) followed by 'live'.
 * - offline → the grace period starts at the last time we saw it live, so the summary does not count the
 *   blind window as streaming time.
 */
export function evaluateSnapshot(
  prev: LiveState,
  snapshot: LiveSnapshot,
  nowMs: number,
  opts: LiveEvaluationOptions,
  lastSuccessAtMs: number | null,
): LiveTransition[] {
  const blind = prev.isLive && lastSuccessAtMs !== null && nowMs - lastSuccessAtMs >= opts.staleMs;
  if (blind && lastSuccessAtMs !== null) {
    if (snapshot.isLive && isDifferentStream(prev.snapshot, snapshot)) {
      const ended = forceOffline(prev, lastSuccessAtMs);
      return [ended, nextLiveState(ended.state, snapshot, nowMs, opts)];
    }
    if (!snapshot.isLive && prev.offlineSince === null) {
      return [nextLiveState({ ...prev, offlineSince: iso(lastSuccessAtMs) }, snapshot, nowMs, opts)];
    }
  }
  return [nextLiveState(prev, snapshot, nowMs, opts)];
}
