import { Minus, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '../../lib/cn';
import { fieldClasses } from './Input';
import { t } from '../../i18n';

export interface NumberFieldProps {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  id?: string;
  invalid?: boolean;
  className?: string;
}

/** Integer stepper. Typing is free-form; the value is clamped on blur. */
export function NumberField({ value, onChange, min, max, step = 1, suffix, id, invalid, className }: NumberFieldProps) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);

  const commit = (raw: string): void => {
    const parsed = Number.parseInt(raw.replace(/[^\d-]/g, ''), 10);
    const next = Number.isNaN(parsed) ? value : Math.min(max, Math.max(min, parsed));
    setText(String(next));
    if (next !== value) onChange(next);
  };

  const bump = (delta: number): void => {
    const next = Math.min(max, Math.max(min, value + delta));
    if (next !== value) onChange(next);
  };

  return (
    <div className={cn('inline-flex items-center gap-1.5', className)}>
      <button type="button" aria-label={t('common.decrease')} onClick={() => bump(-step)} disabled={value <= min} className="grid size-9 place-items-center rounded-lg text-zinc-400 ring-1 ring-inset ring-white/[0.08] hover:bg-white/[0.05] hover:text-white disabled:opacity-40">
        <Minus className="size-4" />
      </button>
      <div className="relative">
        <input
          id={id}
          inputMode="numeric"
          dir="ltr"
          value={text}
          aria-invalid={invalid || undefined}
          onChange={(e) => setText(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              bump(step);
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              bump(-step);
            }
          }}
          className={fieldClasses(invalid, 'h-9 w-20 px-2 text-center tabular-nums')}
        />
      </div>
      <button type="button" aria-label={t('common.increase')} onClick={() => bump(step)} disabled={value >= max} className="grid size-9 place-items-center rounded-lg text-zinc-400 ring-1 ring-inset ring-white/[0.08] hover:bg-white/[0.05] hover:text-white disabled:opacity-40">
        <Plus className="size-4" />
      </button>
      {suffix && <span className="ms-1 text-[13px] text-zinc-500">{suffix}</span>}
    </div>
  );
}
