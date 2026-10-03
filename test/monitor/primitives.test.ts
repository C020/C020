import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelNotFoundError, ProviderError, ProviderNotConfiguredError, RateLimitedError } from '../../src/core/errors.js';
import { CoalescingRunner, KeyedMutex, Semaphore, TimeoutError, chunked, sleep, withTimeout } from '../../src/monitor/concurrency.js';
import { PassOutcome, ProviderHealthTracker, classifyFailure } from '../../src/monitor/providerHealth.js';
import { EarliestTimer, KeyedDebouncer, TimerRegistry } from '../../src/monitor/scheduler.js';
import { Deferred } from './helpers.js';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('KeyedMutex', () => {
  it('runs tasks for the same key in order and other keys in parallel', async () => {
    const mutex = new KeyedMutex<string>();
    const order: string[] = [];
    const gate = new Deferred();
    const a1 = mutex.run('a', async () => {
      order.push('a1:start');
      await gate.promise;
      order.push('a1:end');
    });
    const a2 = mutex.run('a', async () => {
      order.push('a2');
    });
    const b1 = mutex.run('b', async () => {
      order.push('b1');
    });
    await flush();
    expect(order).toEqual(['a1:start', 'b1']);
    gate.resolve();
    await Promise.all([a1, a2, b1]);
    expect(order).toEqual(['a1:start', 'b1', 'a1:end', 'a2']);
    expect(mutex.isBusy('a')).toBe(false);
  });

  it('keeps going after a failing task', async () => {
    const mutex = new KeyedMutex<number>();
    await expect(mutex.run(1, async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    await expect(mutex.run(1, async () => 42)).resolves.toBe(42);
  });
});

describe('CoalescingRunner', () => {
  it('collapses requests made while running into one trailing run', async () => {
    const runner = new CoalescingRunner<string>();
    const gate = new Deferred();
    let runs = 0;
    const task = async (): Promise<void> => {
      runs++;
      if (runs === 1) await gate.promise;
    };
    const first = runner.run('k', task);
    const second = runner.run('k', task);
    const third = runner.run('k', task);
    expect(second).toBe(third);
    gate.resolve();
    await Promise.all([first, second, third]);
    expect(runs).toBe(2);
    expect(runner.isRunning('k')).toBe(false);
    await runner.run('k', task);
    expect(runs).toBe(3);
  });
});

describe('Semaphore', () => {
  it('never runs more than the limit at once', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const gates = [new Deferred(), new Deferred(), new Deferred()];
    const all = gates.map((g) =>
      sem.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await g.promise;
        active--;
      }),
    );
    await flush();
    expect(active).toBe(2);
    expect(sem.pending).toBe(1);
    gates.forEach((g) => g.resolve());
    await Promise.all(all);
    expect(peak).toBe(2);
  });
});

describe('timing helpers', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('withTimeout rejects slow promises with TimeoutError', async () => {
    const slow = withTimeout(new Promise(() => {}), 1_000, 'slow op');
    const assertion = expect(slow).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    await expect(withTimeout(Promise.resolve(5), 1_000, 'fast')).resolves.toBe(5);
  });

  it('sleep resolves early on abort and immediately for non-positive delays', async () => {
    const controller = new AbortController();
    let done = false;
    void sleep(60_000, controller.signal).then(() => (done = true));
    controller.abort();
    await flush();
    expect(done).toBe(true);
    await expect(sleep(0)).resolves.toBeUndefined();
  });

  it('KeyedDebouncer runs once after the key is quiet', async () => {
    const timers = new TimerRegistry();
    const debouncer = new KeyedDebouncer<string>(timers);
    const fn = vi.fn();
    debouncer.debounce('k', 2_000, fn);
    await vi.advanceTimersByTimeAsync(1_500);
    debouncer.debounce('k', 2_000, fn);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(timers.size).toBe(0);
  });

  it('EarliestTimer keeps the earliest request per key', async () => {
    const timers = new TimerRegistry();
    const earliest = new EarliestTimer<number>(timers);
    const fired: string[] = [];
    const now = Date.now();
    earliest.schedule(1, now + 10_000, () => fired.push('late'));
    earliest.schedule(1, now + 5_000, () => fired.push('early'));
    earliest.schedule(1, now + 8_000, () => fired.push('ignored'));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fired).toEqual(['early']);
  });

  it('TimerRegistry.clearAll cancels everything and reports callback errors', async () => {
    const timers = new TimerRegistry();
    const fn = vi.fn();
    const onError = vi.fn();
    timers.timeout(100, fn);
    timers.timeout(
      50,
      () => {
        throw new Error('bad');
      },
      onError,
    );
    await vi.advanceTimersByTimeAsync(60);
    expect(onError).toHaveBeenCalledTimes(1);
    timers.clearAll();
    await vi.advanceTimersByTimeAsync(100);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('chunked', () => {
  it('splits into batches', () => {
    expect(chunked([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunked([1, 2], 0)).toEqual([[1], [2]]);
  });
});

describe('classifyFailure', () => {
  it.each([
    [new RateLimitedError('twitch', 5_000), 'rateLimited'],
    [new ProviderNotConfiguredError('kick'), 'notConfigured'],
    [new ChannelNotFoundError('tiktok', '@x'), 'notFound'],
    [new ProviderError('youtube', 'HTTP 400', false), 'fatal'],
    [new ProviderError('youtube', 'HTTP 503', true), 'transient'],
    [new TimeoutError('op', 10), 'transient'],
    [new TypeError('cannot read x of undefined'), 'fatal'],
  ])('%s → %s', (err, kind) => {
    expect(classifyFailure(err).kind).toBe(kind);
  });

  it('keeps retryAfter for rate limits', () => {
    expect(classifyFailure(new RateLimitedError('twitch', 5_000)).retryAfterMs).toBe(5_000);
  });
});

describe('ProviderHealthTracker', () => {
  it('flips to failing after N consecutive failures and back on success', () => {
    const tracker = new ProviderHealthTracker(2);
    expect(tracker.recordFailure('twitch', 'live', 'e1', false, 1)).toBeNull();
    expect(tracker.recordFailure('twitch', 'live', 'e2', false, 2)).toEqual({ platform: 'twitch', ok: false, message: 'e2', kind: 'live' });
    expect(tracker.recordFailure('twitch', 'live', 'e3', false, 3)).toBeNull();
    expect(tracker.snapshot('twitch')).toMatchObject({ failing: true, lastError: 'e3', consecutiveErrors: 3, lastSuccessAt: null });
    expect(tracker.recordSuccess('twitch', 'live', 4)).toEqual({ platform: 'twitch', ok: true, message: null, kind: 'live' });
    expect(tracker.snapshot('twitch')).toMatchObject({ failing: false, lastError: null, consecutiveErrors: 0, lastSuccessAt: new Date(4).toISOString() });
  });

  it('fails immediately on rejected credentials', () => {
    const tracker = new ProviderHealthTracker(3);
    expect(tracker.recordFailure('kick', 'live', 'bad creds', true, 1)?.ok).toBe(false);
  });

  it('stays failing while either check kind is failing', () => {
    const tracker = new ProviderHealthTracker(1);
    expect(tracker.recordFailure('youtube', 'content', 'rss down', false, 1)?.kind).toBe('content');
    expect(tracker.recordSuccess('youtube', 'live', 2)).toBeNull();
    expect(tracker.snapshot('youtube')).toMatchObject({ failing: true, lastError: 'rss down' });
    expect(tracker.recordSuccess('youtube', 'content', 3)?.ok).toBe(true);
  });
});

describe('PassOutcome', () => {
  const transient = { kind: 'transient' as const, message: 'HTTP 503', retryAfterMs: null };
  const limited = { kind: 'rateLimited' as const, message: 'Rate limited', retryAfterMs: 1_000 };

  it('succeeds when anything succeeded, fails only when everything failed', () => {
    const mixed = new PassOutcome();
    mixed.add(transient);
    mixed.add(null);
    expect(mixed.verdict(true)).toBeNull();

    const failed = new PassOutcome();
    failed.add(transient);
    expect(failed.verdict(true)).toBe(transient);
    expect(failed.verdict(false)).toBeUndefined();
    expect(new PassOutcome().verdict(true)).toBeUndefined();
  });

  it('always reports platform-wide failures', () => {
    const pass = new PassOutcome();
    pass.add(null);
    pass.add(limited);
    pass.add(transient);
    expect(pass.verdict(false)).toBe(limited);
  });
});
