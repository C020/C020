import { createStore } from './store';

export type ToastTone = 'success' | 'error' | 'warning' | 'info' | 'live';

export interface ToastAction {
  label: string;
  href?: string;
  onClick?: () => void;
}

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
  action?: ToastAction;
  /** ms; 0 = sticky until dismissed */
  duration: number;
  createdAt: number;
}

export interface ToastOptions {
  description?: string;
  action?: ToastAction;
  duration?: number;
}

const MAX_VISIBLE = 4;
const DEDUPE_WINDOW_MS = 2500;
const DEFAULT_DURATION: Record<ToastTone, number> = { success: 3500, info: 4500, warning: 6000, error: 6500, live: 7000 };

export const toastStore = createStore<Toast[]>([]);
let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

export function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  toastStore.set((list) => list.filter((t) => t.id !== id));
}

function push(tone: ToastTone, title: string, options: ToastOptions = {}): number {
  const now = Date.now();
  // The same failure reported by several queries at once shows up only once.
  const duplicate = toastStore.get().find((t) => t.tone === tone && t.title === title && now - t.createdAt < DEDUPE_WINDOW_MS);
  if (duplicate) return duplicate.id;

  const id = nextId++;
  const toast: Toast = { ...options, id, tone, title, duration: options.duration ?? DEFAULT_DURATION[tone], createdAt: now };
  toastStore.set((list) => {
    const next = [...list, toast];
    for (const dropped of next.slice(0, Math.max(0, next.length - MAX_VISIBLE))) {
      const timer = timers.get(dropped.id);
      if (timer) clearTimeout(timer);
      timers.delete(dropped.id);
    }
    return next.slice(-MAX_VISIBLE);
  });
  if (toast.duration > 0) timers.set(id, setTimeout(() => dismissToast(id), toast.duration));
  return id;
}

/** Pauses auto-dismiss while the pointer is over a toast. */
export function holdToast(id: number): void {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
}

export function releaseToast(id: number): void {
  const toast = toastStore.get().find((t) => t.id === id);
  if (!toast || toast.duration === 0 || timers.has(id)) return;
  timers.set(id, setTimeout(() => dismissToast(id), 2000));
}

export const toast = {
  success: (title: string, options?: ToastOptions) => push('success', title, options),
  error: (title: string, options?: ToastOptions) => push('error', title, options),
  warning: (title: string, options?: ToastOptions) => push('warning', title, options),
  info: (title: string, options?: ToastOptions) => push('info', title, options),
  live: (title: string, options?: ToastOptions) => push('live', title, options),
  dismiss: dismissToast,
};
