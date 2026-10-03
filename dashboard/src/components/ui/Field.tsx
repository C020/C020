import type { ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  htmlFor?: string;
  /** Rendered at the end of the label row (counters, small actions). */
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function Field({ label, hint, error, htmlFor, aside, className, children }: FieldProps) {
  return (
    <div className={cn('space-y-1.5', className)}>
      {(label || aside) && (
        <div className="flex items-center justify-between gap-2">
          {label && (
            <label htmlFor={htmlFor} className="text-[13px] font-medium text-zinc-300">
              {label}
            </label>
          )}
          {aside && <div className="text-xs text-zinc-500">{aside}</div>}
        </div>
      )}
      {children}
      {error ? (
        <p className="flex items-center gap-1.5 text-xs text-rose-300" role="alert">
          <AlertCircle className="size-3.5 shrink-0" />
          {error}
        </p>
      ) : (
        hint && <p className="text-xs leading-relaxed text-zinc-500">{hint}</p>
      )}
    </div>
  );
}
