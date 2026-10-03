import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}

export function EmptyState({ icon, title, description, action, className, compact = false }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center', compact ? 'gap-2 py-8' : 'gap-3 py-14', className)}>
      {icon && (
        <div className="grid size-12 place-items-center rounded-2xl bg-gradient-to-b from-white/[0.08] to-white/[0.02] text-zinc-400 ring-1 ring-inset ring-white/[0.08]">
          {icon}
        </div>
      )}
      <div className="space-y-1">
        <p className="font-medium text-zinc-200">{title}</p>
        {description && <p className="mx-auto max-w-sm text-[13px] leading-relaxed text-zinc-500">{description}</p>}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
