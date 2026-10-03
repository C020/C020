import { useEffect } from 'react';
import { useLatest } from './useLatest';

/** Ctrl/Cmd + key shortcut (e.g. "s" for save). The handler always sees the latest closure. */
export function useModHotkey(key: string, handler: () => void, enabled = true): void {
  const latest = useLatest(handler);
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === key) {
        event.preventDefault();
        latest.current();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [key, enabled, latest]);
}
