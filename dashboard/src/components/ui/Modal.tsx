import { X } from 'lucide-react';
import { useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';
import { useOverlayBehavior } from './overlay';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** False while a request is running, so the dialog cannot be dismissed mid-save. */
  dismissible?: boolean;
  children?: ReactNode;
  className?: string;
}

const SIZES = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' };

export function Modal({ open, onClose, title, description, icon, footer, size = 'md', dismissible = true, children, className }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  useOverlayBehavior(open, panelRef, onClose, dismissible);
  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
      <div className="absolute inset-0 animate-fade-in bg-black/60 backdrop-blur-sm" onClick={() => dismissible && onClose()} aria-hidden />
      <div
        ref={panelRef}
        data-overlay-panel
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cn(
          'relative flex max-h-[92dvh] w-full animate-slide-up flex-col outline-none overflow-hidden rounded-t-3xl border border-white/[0.08] bg-zinc-900/95 shadow-2xl shadow-black/60 backdrop-blur-xl sm:animate-pop-in sm:rounded-3xl',
          SIZES[size],
          className,
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-white/[0.06] px-5 py-4 sm:px-6">
          <div className="flex min-w-0 items-start gap-3">
            {icon && <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-violet-500/10 text-violet-300 ring-1 ring-inset ring-violet-400/20">{icon}</div>}
            <div className="min-w-0">
              <h2 id={titleId} className="text-base font-semibold text-white">
                {title}
              </h2>
              {description && (
                <p id={descId} className="mt-0.5 text-[13px] leading-relaxed text-zinc-400">
                  {description}
                </p>
              )}
            </div>
          </div>
          <button type="button" onClick={onClose} disabled={!dismissible} aria-label="إغلاق" className="grid size-8 shrink-0 place-items-center rounded-lg text-zinc-400 hover:bg-white/[0.06] hover:text-white disabled:opacity-40">
            <X className="size-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-white/[0.06] bg-zinc-950/40 px-5 py-3.5 sm:px-6">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
