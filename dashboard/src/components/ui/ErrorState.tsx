import { RefreshCw, WifiOff, TriangleAlert } from 'lucide-react';
import { errorMessage, isApiError } from '../../api/client';
import { cn } from '../../lib/cn';
import { Button } from './Button';

export interface ErrorStateProps {
  error: unknown;
  onRetry?: () => void;
  retrying?: boolean;
  title?: string;
  className?: string;
  compact?: boolean;
}

export function ErrorState({ error, onRetry, retrying, title, className, compact = false }: ErrorStateProps) {
  const offline = isApiError(error) && error.status === 0;
  const Icon = offline ? WifiOff : TriangleAlert;
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 text-center', compact ? 'py-6' : 'py-12', className)} role="alert">
      <div className="grid size-11 place-items-center rounded-2xl bg-rose-500/10 text-rose-300 ring-1 ring-inset ring-rose-500/20">
        <Icon className="size-5" />
      </div>
      <div className="space-y-1">
        <p className="font-medium text-zinc-200">{title ?? (offline ? 'ما قدرنا نوصل للسيرفر' : 'ما قدرنا نجيب البيانات')}</p>
        <p className="mx-auto max-w-md text-[13px] leading-relaxed text-zinc-400">{errorMessage(error)}</p>
      </div>
      {onRetry && (
        <Button size="sm" variant="secondary" onClick={onRetry} loading={retrying} icon={<RefreshCw className="size-3.5" />}>
          حاول مرة ثانية
        </Button>
      )}
    </div>
  );
}
