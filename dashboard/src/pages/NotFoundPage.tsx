import { Compass, TriangleAlert } from 'lucide-react';
import { isRouteErrorResponse, Link, useRouteError } from 'react-router-dom';
import { buttonClasses } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';

export function NotFoundPage() {
  return (
    <EmptyState
      icon={<Compass className="size-6" />}
      title="الصفحة مو موجودة"
      description="يمكن الرابط قديم أو فيه خطأ."
      action={
        <Link to="/" className={buttonClasses('secondary', 'md')}>
          الرجوع للرئيسية
        </Link>
      }
    />
  );
}

/** Last-resort boundary for render errors (e.g. a failed lazy chunk after a deploy). */
export function RouteErrorPage() {
  const error = useRouteError();
  const chunkFailed = error instanceof Error && /dynamically imported module|Failed to fetch|Importing a module script failed/i.test(error.message);
  const status = isRouteErrorResponse(error) ? error.status : null;
  return (
    <div className="grid min-h-dvh place-items-center p-6">
      <EmptyState
        icon={<TriangleAlert className="size-6" />}
        title={status === 404 ? 'الصفحة مو موجودة' : chunkFailed ? 'فيه تحديث جديد للوحة' : 'صار خطأ غير متوقع'}
        description={chunkFailed ? 'حدّث الصفحة عشان تحمل النسخة الجديدة.' : 'جرّب تحدّث الصفحة، ولو تكرر الخطأ راجع سجل البوت.'}
        action={
          <button type="button" onClick={() => window.location.reload()} className={buttonClasses('primary', 'md')}>
            تحديث الصفحة
          </button>
        }
      />
    </div>
  );
}
