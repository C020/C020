import { cn, withDefaults } from '../../lib/cn';
import { t } from '../../i18n';

export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <span
      role="status"
      aria-label={label ?? t('common.loading')}
      className={cn('inline-block shrink-0 animate-spin rounded-full border-2 border-current border-e-transparent', withDefaults(className, ['size-', 'size-4']))}
    />
  );
}
