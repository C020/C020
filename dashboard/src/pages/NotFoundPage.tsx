import { Compass, TriangleAlert } from 'lucide-react';
import { isRouteErrorResponse, Link, useRouteError } from 'react-router-dom';
import { buttonClasses } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { t } from '../i18n';

export function NotFoundPage() {
  return (
    <EmptyState
      icon={<Compass className="size-6" />}
      title={t('notFound.title')}
      description={t('notFound.desc')}
      action={
        <Link to="/" className={buttonClasses('secondary', 'md')}>
          {t('notFound.home')}
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
        title={status === 404 ? t('notFound.title') : chunkFailed ? t('routeError.updated') : t('routeError.unexpected')}
        description={chunkFailed ? t('routeError.updatedDesc') : t('routeError.unexpectedDesc')}
        action={
          <button type="button" onClick={() => window.location.reload()} className={buttonClasses('primary', 'md')}>
            {t('common.reload')}
          </button>
        }
      />
    </div>
  );
}
