import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Skeleton } from './Skeleton';

export interface StatCardProps {
  label: string;
  value: ReactNode;
  icon: ReactNode;
  hint?: ReactNode;
  accent?: 'violet' | 'rose' | 'emerald' | 'sky' | 'amber';
  loading?: boolean;
}

const ACCENTS = {
  violet: 'from-violet-500/20 text-violet-300 ring-violet-400/20',
  rose: 'from-rose-500/20 text-rose-300 ring-rose-400/20',
  emerald: 'from-emerald-500/20 text-emerald-300 ring-emerald-400/20',
  sky: 'from-sky-500/20 text-sky-300 ring-sky-400/20',
  amber: 'from-amber-500/20 text-amber-300 ring-amber-400/20',
};

export function StatCard({ label, value, icon, hint, accent = 'violet', loading }: StatCardProps) {
  return (
    <div className="glass relative overflow-hidden rounded-2xl p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <p className="text-[12.5px] text-zinc-400">{label}</p>
          {loading ? <Skeleton className="h-7 w-16" /> : <p className="text-2xl font-semibold tabular-nums tracking-tight text-white">{value}</p>}
          {hint && <p className="text-xs text-zinc-500">{hint}</p>}
        </div>
        <div className={cn('grid size-10 shrink-0 place-items-center rounded-xl bg-gradient-to-b to-transparent ring-1 ring-inset', ACCENTS[accent])}>{icon}</div>
      </div>
    </div>
  );
}
