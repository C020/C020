/** Small async primitives used by the monitor. No dependencies, no clocks except setTimeout. */

const noop = (): void => {};

/** Runs tasks strictly one after another per key (FIFO). A failing task does not block the next one. */
export class KeyedMutex<K> {
  private readonly tails = new Map<K, Promise<void>>();

  run<T>(key: K, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const result = prev.then(task);
    const tail = result.then(noop, noop);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  isBusy(key: K): boolean {
    return this.tails.has(key);
  }
}

interface CoalescingEntry {
  running: Promise<void>;
  queued: Promise<void> | null;
}

/**
 * Per-key single flight with one trailing run. While a task runs for a key, any number of new requests
 * collapse into ONE follow-up run, so work requested mid-flight is never lost and never duplicated.
 * Tasks are expected to handle their own errors; a rejection is swallowed here.
 */
export class CoalescingRunner<K> {
  private readonly entries = new Map<K, CoalescingEntry>();

  run(key: K, task: () => Promise<void>): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) {
      const created: CoalescingEntry = { running: Promise.resolve(), queued: null };
      this.entries.set(key, created);
      created.running = this.execute(key, created, task);
      return created.running;
    }
    if (entry.queued) return entry.queued;
    entry.queued = entry.running.then(() => {
      entry.queued = null;
      entry.running = this.execute(key, entry, task);
      return entry.running;
    });
    return entry.queued;
  }

  isRunning(key: K): boolean {
    return this.entries.has(key);
  }

  private async execute(key: K, entry: CoalescingEntry, task: () => Promise<void>): Promise<void> {
    try {
      await task();
    } catch {
      // Callers handle errors inside the task; never let one poison the queue.
    } finally {
      if (!entry.queued && this.entries.get(key) === entry) this.entries.delete(key);
    }
  }
}

/** Limits how many tasks run at the same time (FIFO admission). */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!(limit >= 1)) throw new Error(`Semaphore limit must be >= 1 (got ${limit})`);
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  get pending(): number {
    return this.waiters.length;
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    // Hand the slot straight to the next waiter (active count unchanged), otherwise free it.
    if (next) next();
    else this.active--;
  }
}

export class TimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/** Rejects with TimeoutError when `promise` does not settle within `ms`. The underlying work keeps running. */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  if (!(ms > 0) || !Number.isFinite(ms)) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(what, ms)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Resolves after `ms` (immediately when ms <= 0) or as soon as `signal` aborts. Never rejects. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!(ms > 0) || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Splits a list into consecutive chunks of at most `size` items. */
export function chunked<T>(items: readonly T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}
