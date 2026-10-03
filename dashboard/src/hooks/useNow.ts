import { useSyncExternalStore } from 'react';

/**
 * One shared ticking clock per interval, so a page full of uptime counters runs a single timer.
 * The clock stops while nobody is subscribed. `subscribe` must be referentially stable, otherwise
 * React re-subscribes on every render.
 */
interface Ticker {
  now: number;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => number;
}

const tickers = new Map<number, Ticker>();

function createTicker(intervalMs: number): Ticker {
  const ticker: Ticker = {
    now: Date.now(),
    listeners: new Set(),
    timer: null,
    getSnapshot: () => ticker.now,
    subscribe: (listener) => {
      ticker.listeners.add(listener);
      if (!ticker.timer) {
        ticker.timer = setInterval(() => {
          ticker.now = Date.now();
          for (const l of ticker.listeners) l();
        }, intervalMs);
      }
      return () => {
        ticker.listeners.delete(listener);
        if (ticker.listeners.size === 0 && ticker.timer) {
          clearInterval(ticker.timer);
          ticker.timer = null;
        }
      };
    },
  };
  return ticker;
}

function tickerFor(intervalMs: number): Ticker {
  let ticker = tickers.get(intervalMs);
  if (!ticker) {
    ticker = createTicker(intervalMs);
    tickers.set(intervalMs, ticker);
  }
  // A clock that was idle may be stale; refresh it before the first subscriber renders.
  if (!ticker.timer && Date.now() - ticker.now > intervalMs) ticker.now = Date.now();
  return ticker;
}

export function useNow(intervalMs = 1000): number {
  const ticker = tickerFor(intervalMs);
  return useSyncExternalStore(ticker.subscribe, ticker.getSnapshot);
}
