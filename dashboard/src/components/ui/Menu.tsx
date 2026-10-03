import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface MenuProps {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'start' | 'end';
  side?: 'bottom' | 'top';
  className?: string;
  panelClassName?: string;
}

/** Lightweight dropdown: closes on outside click, Escape, or when an item calls close(). */
export function Menu({ trigger, children, align = 'end', side = 'bottom', className, panelClassName }: MenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      {trigger({ open, toggle: () => setOpen((v) => !v) })}
      {open && (
        <div
          role="menu"
          className={cn(
            'absolute z-40 min-w-56 animate-pop-in overflow-hidden rounded-xl border border-white/[0.08] bg-zinc-900/98 p-1.5 shadow-2xl shadow-black/60 backdrop-blur-xl',
            align === 'end' ? 'end-0' : 'start-0',
            side === 'bottom' ? 'top-full mt-2' : 'bottom-full mb-2',
            panelClassName,
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  icon,
  children,
  onClick,
  href,
  danger,
  active,
  external,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onClick?: () => void;
  href?: string;
  danger?: boolean;
  active?: boolean;
  external?: boolean;
}) {
  const classes = cn(
    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-start text-sm transition-colors',
    danger ? 'text-rose-300 hover:bg-rose-500/10' : 'text-zinc-200 hover:bg-white/[0.06]',
    active && 'bg-white/[0.06]',
  );
  if (href) {
    return (
      <a role="menuitem" href={href} onClick={onClick} className={classes} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
        {icon}
        {children}
      </a>
    );
  }
  return (
    <button role="menuitem" type="button" onClick={onClick} className={classes}>
      {icon}
      {children}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="my-1 h-px bg-white/[0.06]" />;
}
