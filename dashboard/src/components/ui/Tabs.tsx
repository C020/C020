import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface TabItem<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
}

export interface TabsProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  items: Array<TabItem<T>>;
  className?: string;
}

/** Underlined tab bar (horizontally scrollable on small screens). */
export function Tabs<T extends string>({ value, onChange, items, className }: TabsProps<T>) {
  return (
    <div role="tablist" className={cn('scrollbar-none -mb-px flex gap-1 overflow-x-auto border-b border-white/[0.06]', className)}>
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(item.value)}
            className={cn(
              'relative inline-flex shrink-0 items-center gap-2 px-3.5 pb-3 pt-2 text-sm font-medium transition-colors',
              active ? 'text-white' : 'text-zinc-500 hover:text-zinc-300',
            )}
          >
            {item.icon}
            {item.label}
            {item.badge}
            <span className={cn('absolute inset-x-2 -bottom-px h-0.5 rounded-full transition-colors', active ? 'bg-violet-500' : 'bg-transparent')} />
          </button>
        );
      })}
    </div>
  );
}
