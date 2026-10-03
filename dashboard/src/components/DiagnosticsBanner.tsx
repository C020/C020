import { CircleAlert, ExternalLink, RefreshCw, TriangleAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { DiagnosticsDto } from '../api/types';
import { cn } from '../lib/cn';
import { problemFix, problemHint } from '../lib/problems';
import { buttonClasses } from './ui/Button';

export interface DiagnosticsBannerProps {
  diagnostics: DiagnosticsDto;
  basePath: string;
  inviteUrl: string;
  onRetry?: () => void;
  className?: string;
}

/** Problems found by the server (permissions, missing roles/channels, failing platforms) with one-click fixes. */
export function DiagnosticsBanner({ diagnostics, basePath, inviteUrl, onRetry, className }: DiagnosticsBannerProps) {
  const problems = [...diagnostics.problems].sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
  if (problems.length === 0) return null;
  const errors = problems.filter((p) => p.level === 'error').length;

  return (
    <section
      className={cn(
        'overflow-hidden rounded-2xl ring-1 ring-inset',
        errors > 0 ? 'bg-rose-500/[0.06] ring-rose-500/20' : 'bg-amber-500/[0.06] ring-amber-500/20',
        className,
      )}
      aria-label="مشاكل تحتاج انتباه"
    >
      <div className="flex items-center gap-2 px-4 pt-4 sm:px-5">
        {errors > 0 ? <CircleAlert className="size-5 text-rose-300" /> : <TriangleAlert className="size-5 text-amber-300" />}
        <h2 className="text-sm font-semibold text-zinc-100">
          {errors > 0 ? `فيه ${problems.length === 1 ? 'مشكلة تحتاج' : `${problems.length} مشاكل تحتاج`} حل` : 'تنبيهات بسيطة'}
        </h2>
      </div>
      <ul className="divide-y divide-white/[0.05] px-4 pb-2 sm:px-5">
        {problems.map((problem) => {
          const fix = problemFix(problem.code);
          const hint = problemHint(problem.code);
          return (
            <li key={problem.code} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
              <span className={cn('size-1.5 shrink-0 rounded-full', problem.level === 'error' ? 'bg-rose-400' : 'bg-amber-400')} />
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] leading-relaxed text-zinc-200">{problem.message}</p>
                {hint && <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">{hint}</p>}
              </div>
              {fix?.kind === 'settings' && (
                <Link to={`${basePath}/settings#${fix.section}`} className={buttonClasses('secondary', 'sm')}>
                  {fix.label}
                </Link>
              )}
              {fix?.kind === 'system' && (
                <Link to={`${basePath}/system`} className={buttonClasses('secondary', 'sm')}>
                  {fix.label}
                </Link>
              )}
              {fix?.kind === 'invite' && (
                <a href={inviteUrl} target="_blank" rel="noopener noreferrer" className={buttonClasses('secondary', 'sm')}>
                  {fix.label}
                  <ExternalLink className="size-3.5" />
                </a>
              )}
              {fix?.kind === 'external' && (
                <a href={fix.href} target="_blank" rel="noopener noreferrer" className={buttonClasses('secondary', 'sm')}>
                  {fix.label}
                  <ExternalLink className="size-3.5" />
                </a>
              )}
              {fix?.kind === 'retry' && onRetry && (
                <button type="button" onClick={onRetry} className={buttonClasses('secondary', 'sm')}>
                  <RefreshCw className="size-3.5" />
                  {fix.label}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
