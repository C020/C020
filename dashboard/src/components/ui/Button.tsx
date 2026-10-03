import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost' | 'outline' | 'success';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm';

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-violet-600 text-white shadow-[0_0_0_1px_rgb(255_255_255/0.08)_inset,0_8px_24px_-10px_rgb(124_58_237/0.7)] hover:bg-violet-500 active:bg-violet-700',
  secondary: 'bg-white/[0.06] text-zinc-100 ring-1 ring-inset ring-white/[0.08] hover:bg-white/[0.1] active:bg-white/[0.05]',
  ghost: 'text-zinc-300 hover:bg-white/[0.06] hover:text-white active:bg-white/[0.04]',
  outline: 'text-zinc-200 ring-1 ring-inset ring-white/15 hover:bg-white/[0.05] hover:ring-white/25',
  danger: 'bg-rose-600/90 text-white hover:bg-rose-500 active:bg-rose-700 shadow-[0_8px_24px_-12px_rgb(225_29_72/0.8)]',
  'danger-ghost': 'text-rose-300 hover:bg-rose-500/10 hover:text-rose-200 active:bg-rose-500/5',
  success: 'bg-emerald-600 text-white hover:bg-emerald-500 active:bg-emerald-700',
};

const SIZES: Record<ButtonSize, string> = {
  xs: 'h-7 gap-1 rounded-lg px-2 text-xs',
  sm: 'h-8 gap-1.5 rounded-lg px-3 text-[13px]',
  md: 'h-10 gap-2 rounded-xl px-4 text-sm',
  lg: 'h-12 gap-2.5 rounded-xl px-6 text-[15px]',
  icon: 'size-10 rounded-xl',
  'icon-sm': 'size-8 rounded-lg',
};

export function buttonClasses(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md', className?: string): string {
  return cn(
    'inline-flex select-none items-center justify-center whitespace-nowrap font-medium transition-[background-color,color,box-shadow,transform,opacity] duration-150',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500 active:scale-[0.98]',
    'disabled:pointer-events-none disabled:opacity-45',
    VARIANTS[variant],
    SIZES[size],
    className,
  );
}

export interface ButtonProps extends ComponentProps<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({ variant, size, loading = false, icon, className, children, disabled, type = 'button', ...rest }: ButtonProps) {
  return (
    <button type={type} disabled={disabled || loading} aria-busy={loading || undefined} className={buttonClasses(variant, size, className)} {...rest}>
      {loading ? <Spinner className="size-4" /> : icon}
      {children}
    </button>
  );
}

export interface LinkButtonProps extends ComponentProps<'a'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  external?: boolean;
}

export function LinkButton({ variant, size, icon, external, className, children, ...rest }: LinkButtonProps) {
  return (
    <a className={buttonClasses(variant, size, className)} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})} {...rest}>
      {icon}
      {children}
    </a>
  );
}
