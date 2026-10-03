import { RotateCcw, Save, SlidersHorizontal } from 'lucide-react';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';

/** Floating "unsaved changes" bar (settings, templates). */
export function SaveBar({
  visible,
  changeCount,
  errorCount,
  saving,
  onSave,
  onReset,
  saveLabel = 'حفظ التغييرات',
  onShowErrors,
}: {
  visible: boolean;
  changeCount?: number;
  errorCount?: number;
  saving: boolean;
  onSave: () => void;
  onReset: () => void;
  saveLabel?: string;
  /** Scrolls to the first invalid field. */
  onShowErrors?: () => void;
}) {
  if (!visible) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center p-4 lg:ps-[264px]">
      <div className="pointer-events-auto flex w-full max-w-2xl animate-slide-up flex-wrap items-center gap-3 rounded-2xl border border-white/[0.1] bg-zinc-900/95 px-4 py-3 shadow-2xl shadow-black/60 backdrop-blur-xl">
        <SlidersHorizontal className="size-4 text-violet-300" />
        <p className="flex-1 text-[13px] text-zinc-300">
          {errorCount ? (
            <button type="button" onClick={onShowErrors} disabled={!onShowErrors} className="text-rose-300 underline-offset-4 enabled:hover:underline">
              فيه {errorCount} حقل يحتاج تصحيح
            </button>
          ) : (
            <>
              عندك تغييرات ما انحفظت{changeCount ? <Badge className="ms-2">{changeCount}</Badge> : null}
              <span className="ms-2 hidden text-xs text-zinc-500 sm:inline">Ctrl+S</span>
            </>
          )}
        </p>
        <Button variant="ghost" size="sm" onClick={onReset} disabled={saving} icon={<RotateCcw className="size-3.5" />}>
          تراجع
        </Button>
        <Button variant="primary" size="sm" onClick={onSave} loading={saving} disabled={!!errorCount} icon={<Save className="size-3.5" />}>
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}
