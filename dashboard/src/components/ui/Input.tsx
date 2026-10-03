import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/cn';

/**
 * Shared field styling. Width, height and ring color are left to `fieldClasses` so callers never need
 * to override a base utility (Tailwind resolves same-utility conflicts by CSS order, not class order).
 */
export const inputBase =
  'rounded-xl bg-zinc-900/70 text-sm text-zinc-100 placeholder:text-zinc-600 ring-1 ring-inset transition-[box-shadow,background-color] duration-150 focus:bg-zinc-900 focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:opacity-50';

export function ringClasses(invalid: boolean | undefined): string {
  return invalid ? 'ring-rose-500/60 focus:ring-rose-500/70' : 'ring-white/[0.08] hover:ring-white/[0.14] focus:ring-violet-500/70';
}

export function fieldClasses(invalid?: boolean, extra?: string): string {
  return cn(inputBase, ringClasses(invalid), extra);
}

export interface InputProps extends ComponentProps<'input'> {
  invalid?: boolean;
  /** Icon/element at the start (right in RTL). */
  leading?: ReactNode;
  /** Element at the end (left in RTL). */
  trailing?: ReactNode;
  inputClassName?: string;
  inputSize?: 'sm' | 'md';
  /** Full width (default). Pass false and a width class (e.g. "w-28") for compact inputs. */
  block?: boolean;
}

export function Input({ invalid, leading, trailing, className, inputClassName, inputSize = 'md', block = true, ...rest }: InputProps) {
  const height = inputSize === 'sm' ? 'h-8' : 'h-10';
  if (!leading && !trailing) {
    return <input aria-invalid={invalid || undefined} className={fieldClasses(invalid, cn(height, 'px-3.5', block && 'w-full', className))} {...rest} />;
  }
  return (
    <div className={cn('relative', className)}>
      {leading && <div className="pointer-events-none absolute inset-y-0 start-0 flex items-center ps-3 text-zinc-500">{leading}</div>}
      <input
        aria-invalid={invalid || undefined}
        className={fieldClasses(invalid, cn(height, 'w-full', leading ? 'ps-10' : 'ps-3.5', trailing ? 'pe-10' : 'pe-3.5', inputClassName))}
        {...rest}
      />
      {trailing && <div className="absolute inset-y-0 end-0 flex items-center pe-2.5">{trailing}</div>}
    </div>
  );
}

export interface TextareaProps extends ComponentProps<'textarea'> {
  invalid?: boolean;
}

export function Textarea({ invalid, className, ...rest }: TextareaProps) {
  return <textarea aria-invalid={invalid || undefined} className={fieldClasses(invalid, cn('block min-h-20 w-full resize-y px-3.5 py-2.5 leading-relaxed', className))} {...rest} />;
}
