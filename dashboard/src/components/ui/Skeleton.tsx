import { cn, withDefaults } from '../../lib/cn';
import { t } from '../../i18n';

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={`skeleton ${withDefaults(className, ['rounded', 'rounded-lg'])}`} />;
}

export function SkeletonRows({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-3', className)} role="status" aria-label={t('common.loading')}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="size-10 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}
