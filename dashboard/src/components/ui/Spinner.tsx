import { cn, withDefaults } from '../../lib/cn';

export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <span
      role="status"
      aria-label={label ?? 'جاري التحميل'}
      className={cn('inline-block shrink-0 animate-spin rounded-full border-2 border-current border-e-transparent', withDefaults(className, ['size-', 'size-4']))}
    />
  );
}
