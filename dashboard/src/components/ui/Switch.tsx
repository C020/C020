import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  size?: 'sm' | 'md';
  className?: string;
  id?: string;
}

/** Accessible toggle; the knob uses logical margins so it moves the right way in RTL. */
export function Switch({ checked, onChange, disabled, label, size = 'md', className, id }: SwitchProps) {
  const dims = size === 'sm' ? { track: 'h-5 w-9', knob: 'size-4', on: 'ms-[18px]' } : { track: 'h-6 w-11', knob: 'size-5', on: 'ms-[22px]' };
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      className={cn(
        'relative inline-flex shrink-0 items-center rounded-full p-0.5 ring-1 ring-inset transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-45',
        checked ? 'bg-violet-600 ring-violet-400/40' : 'bg-zinc-700/70 ring-white/10',
        dims.track,
        className,
      )}
    >
      <span
        className={cn(
          'block rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.4)] transition-[margin] duration-200 ease-out',
          dims.knob,
          checked ? dims.on : 'ms-0',
        )}
      />
    </button>
  );
}

export interface SwitchRowProps extends Omit<SwitchProps, 'label'> {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
}

/** A labelled switch row (settings lists). Clicking anywhere on the row toggles it. */
export function SwitchRow({ title, description, icon, checked, onChange, disabled, className, size }: SwitchRowProps) {
  return (
    <div
      role="presentation"
      onClick={() => !disabled && onChange(!checked)}
      className={cn(
        'flex cursor-pointer items-start justify-between gap-4 rounded-xl px-1 py-3 transition-colors',
        disabled && 'cursor-not-allowed opacity-60',
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        {icon && <div className="mt-0.5 text-zinc-400">{icon}</div>}
        <div className="min-w-0">
          <div className="text-sm font-medium text-zinc-200">{title}</div>
          {description && <div className="mt-0.5 text-xs leading-relaxed text-zinc-500">{description}</div>}
        </div>
      </div>
      <Switch checked={checked} onChange={onChange} disabled={disabled} size={size} label={typeof title === 'string' ? title : undefined} />
    </div>
  );
}
