import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface ToggleChipProps {
  selected: boolean;
  onToggle: () => void;
  children: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  title?: string;
  size?: 'sm' | 'md';
}

export function ToggleChip({ selected, onToggle, children, icon, disabled, title, size = 'md' }: ToggleChipProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      title={title}
      onClick={onToggle}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full font-medium ring-1 ring-inset transition-[background-color,color,box-shadow] duration-150 disabled:opacity-40',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-[13px]',
        selected ? 'bg-violet-500/15 text-violet-200 ring-violet-400/40' : 'bg-transparent text-zinc-400 ring-white/10 hover:text-zinc-200 hover:ring-white/20',
      )}
    >
      {selected ? <Check className="size-3.5" /> : icon}
      {children}
    </button>
  );
}
