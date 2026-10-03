import type { ComponentProps } from 'react';
import { cn, withDefaults } from '../../lib/cn';

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'violet' | 'live';

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-white/[0.06] text-zinc-300 ring-white/[0.08]',
  success: 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/20',
  warning: 'bg-amber-500/10 text-amber-300 ring-amber-500/20',
  danger: 'bg-rose-500/10 text-rose-300 ring-rose-500/20',
  info: 'bg-sky-500/10 text-sky-300 ring-sky-500/20',
  violet: 'bg-violet-500/10 text-violet-300 ring-violet-500/20',
  live: 'bg-rose-500/15 text-rose-200 ring-rose-500/30',
};

export interface BadgeProps extends ComponentProps<'span'> {
  tone?: BadgeTone;
  size?: 'sm' | 'md';
}

export function Badge({ tone = 'neutral', size = 'md', className, ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full font-medium ring-1 ring-inset',
        size === 'sm' ? 'h-5 px-1.5 text-[10.5px]' : 'h-6 px-2 text-[11.5px]',
        TONES[tone],
        className,
      )}
      {...rest}
    />
  );
}

/** Pulsing red dot used for "live" states. */
export function LiveDot({ className }: { className?: string }) {
  return (
    <span className={cn('relative inline-flex size-2 shrink-0', className)} aria-hidden>
      <span className="absolute inset-0 animate-live-ping rounded-full bg-rose-500/80" />
      <span className="relative inline-flex size-2 rounded-full bg-rose-500" />
    </span>
  );
}

export function StatusDot({ tone, className }: { tone: 'ok' | 'warn' | 'error' | 'off'; className?: string }) {
  const color = { ok: 'bg-emerald-400', warn: 'bg-amber-400', error: 'bg-rose-500', off: 'bg-zinc-600' }[tone];
  return <span className={cn('inline-block shrink-0 rounded-full', color, withDefaults(className, ['size-', 'size-2']))} aria-hidden />;
}
