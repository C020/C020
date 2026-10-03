import { X } from 'lucide-react';
import { useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';
import { useOverlayBehavior } from './overlay';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  width?: 'md' | 'lg';
}

/** Side panel sliding in from the inline end (left in RTL); full screen on phones. */
export function Drawer({ open, onClose, title, header, footer, children, width = 'lg' }: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useOverlayBehavior(open, panelRef, onClose, true, false);
  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 animate-fade-in bg-black/50 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        data-overlay-panel
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={cn(
          'absolute inset-y-0 end-0 flex w-full animate-slide-in-end flex-col outline-none border-s border-white/[0.08] bg-zinc-900/95 shadow-2xl shadow-black/70 backdrop-blur-xl ltr:animate-slide-in-start',
          width === 'lg' ? 'sm:max-w-xl' : 'sm:max-w-md',
        )}
      >
        <div className="flex items-start justify-between gap-3 border-b border-white/[0.06] px-5 py-4">
          <div className="min-w-0 flex-1">
            {header ??
              (title && (
                <h2 id={titleId} className="text-base font-semibold text-white">
                  {title}
                </h2>
              ))}
          </div>
          <button type="button" onClick={onClose} aria-label="إغلاق" className="grid size-8 shrink-0 place-items-center rounded-lg text-zinc-400 hover:bg-white/[0.06] hover:text-white">
            <X className="size-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <div className="border-t border-white/[0.06] bg-zinc-950/40 px-5 py-3.5">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
