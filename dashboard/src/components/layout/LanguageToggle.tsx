import { Languages } from 'lucide-react';
import { confirmDiscardChanges } from '../../hooks/useUnsavedChangesGuard';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/cn';

/**
 * Header button that flips the dashboard between Arabic and English. The choice is stored per
 * browser (localStorage) and sent to the API as `x-ui-lang`. Switching remounts the pages, so it
 * asks first when a page has unsaved changes.
 */
export function LanguageToggle({ className }: { className?: string }) {
  const { lang, t, setLang } = useI18n();
  const next = lang === 'ar' ? 'en' : 'ar';
  return (
    <button
      type="button"
      lang={next}
      onClick={() => {
        void confirmDiscardChanges().then((ok) => {
          if (ok) setLang(next);
        });
      }}
      title={t('lang.switchToTitle')}
      aria-label={t('lang.switchToTitle')}
      className={cn(
        'inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-xs font-medium text-zinc-300 ring-1 ring-inset ring-white/[0.08] transition-colors hover:bg-white/[0.06] hover:text-white',
        className,
      )}
    >
      <Languages className="size-4 shrink-0" />
      <span>{t('lang.switchTo')}</span>
    </button>
  );
}
