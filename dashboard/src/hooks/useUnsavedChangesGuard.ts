import { useEffect } from 'react';
import { useBlocker } from 'react-router-dom';
import { confirmDialog } from '../lib/confirm';
import { useLatest } from './useLatest';

/** Warns before leaving a page (in-app navigation or tab close) with unsaved changes. */
export function useUnsavedChangesGuard(dirty: boolean): void {
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);
  const latest = useLatest(blocker);

  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    let active = true;
    void confirmDialog({
      title: 'عندك تغييرات ما انحفظت',
      description: 'لو طلعت الحين بتضيع التغييرات. متأكد تبي تطلع؟',
      confirmLabel: 'اطلع بدون حفظ',
      cancelLabel: 'ارجع',
      tone: 'danger',
    }).then((ok) => {
      if (!active) return;
      if (ok) latest.current.proceed?.();
      else latest.current.reset?.();
    });
    return () => {
      active = false;
    };
  }, [blocker.state, latest]);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);
}
