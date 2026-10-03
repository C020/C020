import { useEffect, type RefObject } from 'react';
import { useLatest } from '../../hooks/useLatest';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

let lockCount = 0;

/** Esc to close, focus trap, focus restore and body scroll lock for modal surfaces. */
export function useOverlayBehavior(
  open: boolean,
  panelRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  dismissible = true,
  /** Focus the first control on open (dialogs) or just the panel (drawers). */
  focusFirst = true,
): void {
  const close = useLatest(onClose);
  const canDismiss = useLatest(dismissible);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    lockCount += 1;
    document.body.style.overflow = 'hidden';

    const focusTimer = window.setTimeout(() => {
      const panel = panelRef.current;
      if (!panel || panel.contains(document.activeElement)) return;
      const preferred = panel.querySelector<HTMLElement>('[data-autofocus]') ?? (focusFirst ? panel.querySelector<HTMLElement>(FOCUSABLE) : null);
      (preferred ?? panel).focus({ preventScroll: true });
    }, 30);

    const onKeyDown = (event: KeyboardEvent): void => {
      const panel = panelRef.current;
      if (!panel) return;
      if (event.key === 'Escape' && canDismiss.current) {
        // Only the top-most overlay reacts.
        const overlays = document.querySelectorAll('[data-overlay-panel]');
        if (overlays[overlays.length - 1] !== panel) return;
        event.stopPropagation();
        close.current();
        return;
      }
      if (event.key === 'Tab') {
        const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
        if (items.length === 0) return;
        const first = items[0]!;
        const last = items[items.length - 1]!;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKeyDown);
      lockCount = Math.max(0, lockCount - 1);
      if (lockCount === 0) document.body.style.overflow = '';
      previouslyFocused?.focus?.({ preventScroll: true });
    };
  }, [open, panelRef, close, canDismiss, focusFirst]);
}
