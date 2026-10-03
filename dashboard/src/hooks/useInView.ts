import { useEffect, useRef, type RefObject } from 'react';
import { useLatest } from './useLatest';

/** Calls `onEnter` whenever the element scrolls into view (used for infinite lists). */
export function useInView<T extends Element>(onEnter: () => void, enabled = true): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const callback = useLatest(onEnter);
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) callback.current();
      },
      { rootMargin: '240px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [enabled, callback]);
  return ref;
}
