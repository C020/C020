import { createStore } from './store';

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'default';
  /** When set, the user must type this text to enable the confirm button (very destructive actions). */
  requireText?: string;
}

interface PendingConfirm extends ConfirmOptions {
  id: number;
  resolve: (ok: boolean) => void;
}

export const confirmStore = createStore<PendingConfirm | null>(null);
let nextId = 1;

/** Opens the app-wide confirm dialog; resolves true when confirmed. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  // A new dialog replaces (and cancels) any dialog still open.
  confirmStore.get()?.resolve(false);
  return new Promise<boolean>((resolve) => {
    confirmStore.set({ ...options, id: nextId++, resolve });
  });
}

export function settleConfirm(ok: boolean): void {
  const pending = confirmStore.get();
  if (!pending) return;
  confirmStore.set(null);
  pending.resolve(ok);
}
