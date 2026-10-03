/** Small dependency-free primitives used by the Discord layer. */

const noop = (): void => {};

/** Runs tasks one after another per key (FIFO). A failing task never blocks the ones queued after it. */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const result = prev.then(task);
    const tail = result.then(noop, noop);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  get size(): number {
    return this.tails.size;
  }
}

/**
 * Lets a warning through at most once per key per window (e.g. "missing permission in channel X"),
 * so a misconfiguration produces one clear audit entry instead of one per poll.
 */
export class WarnThrottle {
  private readonly last = new Map<string, number>();

  constructor(
    private readonly windowMs = 60 * 60_000,
    private readonly clock: () => number = Date.now,
    private readonly maxKeys = 2_000,
  ) {}

  allow(key: string): boolean {
    const now = this.clock();
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < this.windowMs) return false;
    this.last.set(key, now);
    if (this.last.size > this.maxKeys) this.prune(now);
    return true;
  }

  /** Forget a key (e.g. after the problem was fixed) so the next occurrence is reported right away. */
  reset(key: string): void {
    this.last.delete(key);
  }

  private prune(now: number): void {
    for (const [key, at] of this.last) {
      if (now - at >= this.windowMs) this.last.delete(key);
    }
    // Still too many: drop the oldest entries (Map iterates in insertion order).
    for (const key of this.last.keys()) {
      if (this.last.size <= this.maxKeys) break;
      this.last.delete(key);
    }
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/** Rejects with TimeoutError when `promise` does not settle within `ms`. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(message)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const SNOWFLAKE_RE = /^\d{17,20}$/;

export function isSnowflake(value: unknown): value is string {
  return typeof value === 'string' && SNOWFLAKE_RE.test(value);
}
