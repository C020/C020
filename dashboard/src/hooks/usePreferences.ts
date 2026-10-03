import { useSyncExternalStore } from 'react';
import { createStore } from '../lib/store';
import { readStorage, writeStorage } from './useLocalStorage';

export const LAST_GUILD_KEY = 'last-guild';
const TOASTS_KEY = 'realtime-toasts';

const toastsStore = createStore<boolean>(readStorage(TOASTS_KEY, true));

/** Whether go-live / new-content events pop up as toasts (shared across components, persisted). */
export function useRealtimeToasts(): [boolean, (value: boolean) => void] {
  const value = useSyncExternalStore(toastsStore.subscribe, toastsStore.get);
  return [
    value,
    (next: boolean) => {
      toastsStore.set(next);
      writeStorage(TOASTS_KEY, next);
    },
  ];
}
