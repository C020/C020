/** Error classification and per-platform health bookkeeping for the monitor. */
import {
  ChannelNotFoundError,
  ProviderError,
  ProviderNotConfiguredError,
  RateLimitedError,
  errorMessage,
} from '../core/errors.js';
import type { Platform } from '../core/types.js';
import { TimeoutError } from './concurrency.js';

/**
 * - rateLimited:   back off the whole platform until retryAfterMs
 * - notConfigured: credentials missing/rejected; nothing will work until fixed
 * - notFound:      the channel itself is gone/renamed (channel-level, the platform is fine)
 * - fatal:         non-retryable request failure (e.g. HTTP 400); may be caused by one bad channel in a batch
 * - transient:     network, 5xx, timeouts; retry next cycle
 */
export type FailureKind = 'rateLimited' | 'notConfigured' | 'notFound' | 'fatal' | 'transient';

export interface Failure {
  kind: FailureKind;
  message: string;
  retryAfterMs: number | null;
}

export function classifyFailure(err: unknown): Failure {
  const message = errorMessage(err);
  if (err instanceof RateLimitedError) return { kind: 'rateLimited', message, retryAfterMs: err.retryAfterMs };
  if (err instanceof ProviderNotConfiguredError) return { kind: 'notConfigured', message, retryAfterMs: null };
  if (err instanceof ChannelNotFoundError) return { kind: 'notFound', message, retryAfterMs: null };
  if (err instanceof ProviderError) return { kind: err.retryable ? 'transient' : 'fatal', message, retryAfterMs: null };
  if (err instanceof TimeoutError) return { kind: 'transient', message, retryAfterMs: null };
  // Unexpected exceptions (e.g. a parser choking on one channel's payload) are treated like non-retryable
  // request failures so a batch can be bisected to find the culprit.
  return { kind: 'fatal', message, retryAfterMs: null };
}

/** Failures that concern the platform as a whole rather than individual channels. */
export function isPlatformWide(failure: Failure): boolean {
  return failure.kind === 'rateLimited' || failure.kind === 'notConfigured';
}

/**
 * Aggregates the outcomes of one polling pass so health reflects the platform, not individual channels:
 * a few permanently broken accounts interleaved with healthy ones must not flip the platform between
 * failing and ok every cycle.
 */
export class PassOutcome {
  private succeeded = 0;
  private lastFailure: Failure | null = null;
  private platformFailure: Failure | null = null;

  /** null = the platform answered (even if the answer was "channel not found"). */
  add(failure: Failure | null): void {
    if (!failure) {
      this.succeeded++;
      return;
    }
    this.lastFailure = failure;
    if (isPlatformWide(failure)) this.platformFailure = failure;
  }

  /**
   * What to record for the pass: a platform-wide failure always counts; channel-level failures count only
   * when nothing succeeded (and `countChannelFailures` is set, e.g. not for small targeted checks).
   * Returns undefined when there is nothing to record (no attempt was made).
   */
  verdict(countChannelFailures: boolean): Failure | null | undefined {
    if (this.platformFailure) return this.platformFailure;
    if (this.succeeded > 0) return null;
    if (this.lastFailure && countChannelFailures) return this.lastFailure;
    return undefined;
  }
}

export type CheckKind = 'live' | 'content';

interface KindState {
  consecutiveErrors: number;
  lastError: string | null;
  lastErrorAt: number | null;
  lastSuccessAt: number | null;
  /** The last failure makes the platform unusable right away (no need to wait for repeated failures). */
  immediate: boolean;
}

interface PlatformState {
  live: KindState;
  content: KindState;
  failing: boolean;
}

export interface HealthTransition {
  platform: Platform;
  ok: boolean;
  /** Error that caused the platform to be marked failing (null on recovery). */
  message: string | null;
  kind: CheckKind;
}

export interface HealthSnapshot {
  failing: boolean;
  lastSuccessAt: string | null;
  /** Current error (null once the platform recovered). */
  lastError: string | null;
  consecutiveErrors: number;
}

const freshKind = (): KindState => ({ consecutiveErrors: 0, lastError: null, lastErrorAt: null, lastSuccessAt: null, immediate: false });
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/**
 * Tracks consecutive failures per platform for live checks and content checks separately. A platform is
 * "failing" when either kind failed `failAfter` times in a row (or once with an immediate failure such as
 * rejected credentials). record* return a transition only when the failing flag flips, so callers can emit
 * one event / audit entry per incident instead of one per failed request.
 */
export class ProviderHealthTracker {
  private readonly states = new Map<Platform, PlatformState>();

  constructor(private readonly failAfter = 2) {}

  recordSuccess(platform: Platform, kind: CheckKind, nowMs: number): HealthTransition | null {
    const state = this.state(platform);
    const k = state[kind];
    k.consecutiveErrors = 0;
    k.immediate = false;
    k.lastSuccessAt = nowMs;
    return this.evaluate(platform, state, kind);
  }

  recordFailure(platform: Platform, kind: CheckKind, message: string, immediate: boolean, nowMs: number): HealthTransition | null {
    const state = this.state(platform);
    const k = state[kind];
    k.consecutiveErrors++;
    k.lastError = message;
    k.lastErrorAt = nowMs;
    k.immediate = immediate;
    return this.evaluate(platform, state, kind);
  }

  consecutiveErrors(platform: Platform, kind: CheckKind): number {
    return this.states.get(platform)?.[kind].consecutiveErrors ?? 0;
  }

  snapshot(platform: Platform): HealthSnapshot {
    const state = this.states.get(platform);
    if (!state) return { failing: false, lastSuccessAt: null, lastError: null, consecutiveErrors: 0 };
    const { live, content } = state;
    const erroring = [live, content].filter((k) => k.consecutiveErrors > 0).sort((a, b) => (b.lastErrorAt ?? 0) - (a.lastErrorAt ?? 0));
    const lastSuccess = Math.max(live.lastSuccessAt ?? 0, content.lastSuccessAt ?? 0);
    return {
      failing: state.failing,
      lastSuccessAt: lastSuccess > 0 ? iso(lastSuccess) : null,
      lastError: erroring[0]?.lastError ?? null,
      consecutiveErrors: Math.max(live.consecutiveErrors, content.consecutiveErrors),
    };
  }

  private state(platform: Platform): PlatformState {
    let state = this.states.get(platform);
    if (!state) {
      state = { live: freshKind(), content: freshKind(), failing: false };
      this.states.set(platform, state);
    }
    return state;
  }

  private isKindFailing(k: KindState): boolean {
    return k.consecutiveErrors >= this.failAfter || (k.immediate && k.consecutiveErrors > 0);
  }

  private evaluate(platform: Platform, state: PlatformState, kind: CheckKind): HealthTransition | null {
    const failing = this.isKindFailing(state.live) || this.isKindFailing(state.content);
    if (failing === state.failing) return null;
    state.failing = failing;
    if (!failing) return { platform, ok: true, message: null, kind };
    const culprit = this.isKindFailing(state[kind]) ? kind : kind === 'live' ? 'content' : 'live';
    return { platform, ok: false, message: state[culprit].lastError, kind: culprit };
  }
}
