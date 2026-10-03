/** Timer bookkeeping for the monitor: every timer goes through a registry so stop() can cancel them all. */

export type CancelFn = () => void;

export class TimerRegistry {
  private readonly handles = new Set<ReturnType<typeof setTimeout>>();

  /** Runs `fn` once after `ms`. Errors thrown by `fn` are reported to `onError` (never crash the process). */
  timeout(ms: number, fn: () => void, onError?: (err: unknown) => void): CancelFn {
    const handle = setTimeout(
      () => {
        this.handles.delete(handle);
        try {
          fn();
        } catch (err) {
          onError?.(err);
        }
      },
      Math.max(0, ms),
    );
    handle.unref?.();
    this.handles.add(handle);
    return () => {
      clearTimeout(handle);
      this.handles.delete(handle);
    };
  }

  clearAll(): void {
    for (const handle of this.handles) clearTimeout(handle);
    this.handles.clear();
  }

  get size(): number {
    return this.handles.size;
  }
}

/** Trailing debounce per key: `fn` runs once the key has been quiet for `delayMs`. */
export class KeyedDebouncer<K> {
  private readonly pending = new Map<K, CancelFn>();

  constructor(
    private readonly timers: TimerRegistry,
    private readonly onError?: (err: unknown) => void,
  ) {}

  debounce(key: K, delayMs: number, fn: () => void): void {
    this.pending.get(key)?.();
    const cancel = this.timers.timeout(
      delayMs,
      () => {
        this.pending.delete(key);
        fn();
      },
      this.onError,
    );
    this.pending.set(key, cancel);
  }

  has(key: K): boolean {
    return this.pending.has(key);
  }

  cancel(key: K): void {
    this.pending.get(key)?.();
    this.pending.delete(key);
  }

  cancelAll(): void {
    for (const cancel of this.pending.values()) cancel();
    this.pending.clear();
  }
}

/**
 * One timer per key where the EARLIEST requested time wins (e.g. "re-check this channel at T").
 * Requests later than an already scheduled one (within `toleranceMs`) are ignored.
 */
export class EarliestTimer<K> {
  private readonly scheduled = new Map<K, { at: number; cancel: CancelFn }>();

  constructor(
    private readonly timers: TimerRegistry,
    private readonly onError?: (err: unknown) => void,
  ) {}

  schedule(key: K, atMs: number, fn: () => void, toleranceMs = 1_000): void {
    const existing = this.scheduled.get(key);
    if (existing && existing.at <= atMs + toleranceMs) return;
    existing?.cancel();
    const cancel = this.timers.timeout(
      atMs - Date.now(),
      () => {
        this.scheduled.delete(key);
        fn();
      },
      this.onError,
    );
    this.scheduled.set(key, { at: atMs, cancel });
  }

  scheduledAt(key: K): number | null {
    return this.scheduled.get(key)?.at ?? null;
  }

  cancel(key: K): void {
    this.scheduled.get(key)?.cancel();
    this.scheduled.delete(key);
  }

  cancelAll(): void {
    for (const entry of this.scheduled.values()) entry.cancel();
    this.scheduled.clear();
  }
}
