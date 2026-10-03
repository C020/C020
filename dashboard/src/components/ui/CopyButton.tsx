import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useCopy } from '../../hooks/useCopy';
import { cn } from '../../lib/cn';

export function CopyButton({ value, label = 'نسخ', className }: { value: string; label?: string; className?: string }) {
  const copy = useCopy();
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        void copy(value).then(() => setDone(true));
      }}
      className={cn('inline-grid size-6 shrink-0 place-items-center rounded-md text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200', className)}
    >
      {done ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
    </button>
  );
}
