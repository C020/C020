import { CircleCheck, CircleX, Info, Radio, TriangleAlert, X } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { cn } from '../lib/cn';
import { dismissToast, holdToast, releaseToast, toastStore, type Toast, type ToastTone } from '../lib/toast';
import { t } from '../i18n';

const TONE_STYLES: Record<ToastTone, { icon: typeof Info; className: string }> = {
  success: { icon: CircleCheck, className: 'text-emerald-300' },
  error: { icon: CircleX, className: 'text-rose-300' },
  warning: { icon: TriangleAlert, className: 'text-amber-300' },
  info: { icon: Info, className: 'text-sky-300' },
  live: { icon: Radio, className: 'text-rose-400' },
};

export function Toaster() {
  const toasts = useSyncExternalStore(toastStore.subscribe, toastStore.get);
  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:start-auto sm:end-2 sm:w-[24rem]">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}

function ToastItem({ toast }: { toast: Toast }) {
  const { icon: Icon, className } = TONE_STYLES[toast.tone];
  return (
    <div
      role={toast.tone === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => holdToast(toast.id)}
      onMouseLeave={() => releaseToast(toast.id)}
      className={cn(
        'pointer-events-auto flex w-full max-w-sm animate-slide-up items-start gap-3 rounded-2xl border border-white/[0.08] bg-zinc-900/95 p-3.5 shadow-2xl shadow-black/50 backdrop-blur-xl',
        toast.tone === 'live' && 'border-rose-500/30',
      )}
    >
      <Icon className={cn('mt-0.5 size-5 shrink-0', className)} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium leading-snug text-zinc-100">{toast.title}</p>
        {toast.description && <p className="mt-0.5 text-[13px] leading-relaxed text-zinc-400">{toast.description}</p>}
        {toast.action &&
          (toast.action.href ? (
            <a href={toast.action.href} target="_blank" rel="noopener noreferrer" className="mt-1.5 inline-block text-[13px] font-medium text-violet-300 hover:text-violet-200">
              {toast.action.label}
            </a>
          ) : (
            <button
              type="button"
              onClick={() => {
                toast.action?.onClick?.();
                dismissToast(toast.id);
              }}
              className="mt-1.5 text-[13px] font-medium text-violet-300 hover:text-violet-200"
            >
              {toast.action.label}
            </button>
          ))}
      </div>
      <button type="button" onClick={() => dismissToast(toast.id)} aria-label={t('common.close')} className="grid size-6 shrink-0 place-items-center rounded-md text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200">
        <X className="size-3.5" />
      </button>
    </div>
  );
}
