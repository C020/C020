import { useEffect } from 'react';
import { useBlocker } from 'react-router-dom';
import { t } from '../i18n/core';
import { confirmDialog } from '../lib/confirm';
import { useLatest } from './useLatest';

let dirtyGuards = 0;

/** True while any mounted page reports unsaved changes (used e.g. before switching the UI language). */
export function hasUnsavedChanges(): boolean {
  return dirtyGuards > 0;
}

/** Asks before discarding unsaved changes; resolves true right away when nothing is dirty. */
export function confirmDiscardChanges(): Promise<boolean> {
  if (!hasUnsavedChanges()) return Promise.resolve(true);
  return confirmDialog({
    title: t('unsaved.title'),
    description: t('unsaved.description'),
    confirmLabel: t('unsaved.leave'),
    cancelLabel: t('unsaved.stay'),
    tone: 'danger',
  });
}

/** Warns before leaving a page (in-app navigation or tab close) with unsaved changes. */
export function useUnsavedChangesGuard(dirty: boolean): void {
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);
  const latest = useLatest(blocker);

  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    let active = true;
    void confirmDialog({
      title: t('unsaved.title'),
      description: t('unsaved.description'),
      confirmLabel: t('unsaved.leave'),
      cancelLabel: t('unsaved.stay'),
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
    dirtyGuards += 1;
    return () => {
      dirtyGuards -= 1;
    };
  }, [dirty]);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);
}
