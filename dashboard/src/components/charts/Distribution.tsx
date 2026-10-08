import { useState } from 'react';
import { cn } from '../../lib/cn';
import { heatLevel, percent } from '../../lib/charts';

export interface ShareItem {
  key: string;
  label: string;
  value: number;
  color: string;
  detail?: string;
}

/** Stacked horizontal share bar + legend with percentages (e.g. hours per platform). */
export function ShareBar({ items, ariaLabel, formatValue }: { items: ShareItem[]; ariaLabel: string; formatValue: (v: number) => string }) {
  const total = items.reduce((n, i) => n + Math.max(0, i.value), 0);
  return (
    <figure className="space-y-3" aria-label={ariaLabel}>
      <div className="flex h-3 overflow-hidden rounded-full bg-white/[0.04]" role="presentation">
        {items.map((item) =>
          item.value > 0 ? <div key={item.key} title={`${item.label} • ${percent(item.value, total)}%`} style={{ width: `${percent(item.value, total)}%`, backgroundColor: item.color }} /> : null,
        )}
      </div>
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.key} className="flex items-center gap-2.5 text-[13px]">
            <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: item.color }} aria-hidden />
            <span className="min-w-0 flex-1 truncate text-zinc-200" dir="auto">
              {item.label}
            </span>
            {item.detail && <span className="hidden text-xs text-zinc-500 sm:inline">{item.detail}</span>}
            <span className="tabular-nums text-zinc-400">{formatValue(item.value)}</span>
            <span className="w-12 text-end text-xs font-medium tabular-nums text-zinc-300">{percent(item.value, total)}%</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

/** Ranked list with proportional bars (e.g. top categories). */
export function RankedBars({ items, formatValue, color = '#06b6d4' }: { items: Array<{ key: string; label: string; value: number }>; formatValue: (v: number) => string; color?: string }) {
  const max = Math.max(0, ...items.map((i) => i.value));
  return (
    <ol className="space-y-2.5">
      {items.map((item, i) => (
        <li key={item.key} className="space-y-1">
          <div className="flex items-center gap-2 text-[13px]">
            <span className="w-4 text-xs tabular-nums text-zinc-600">{i + 1}</span>
            <span className="min-w-0 flex-1 truncate text-zinc-200" dir="auto">
              {item.label}
            </span>
            <span className="text-xs tabular-nums text-zinc-400">{formatValue(item.value)}</span>
          </div>
          <div className="ms-6 h-1.5 overflow-hidden rounded-full bg-white/[0.04]">
            <div className="h-full rounded-full" style={{ width: `${max > 0 ? (item.value / max) * 100 : 0}%`, backgroundColor: color }} />
          </div>
        </li>
      ))}
    </ol>
  );
}

/** 24-cell heat strip (seconds live per local hour of day); hover/focus/tap shows the value. */
export function HourStrip({
  hours,
  ariaLabel,
  formatHour,
  formatValue,
}: {
  hours: number[];
  ariaLabel: string;
  formatHour: (hour: number) => string;
  formatValue: (seconds: number) => string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const cells = Array.from({ length: 24 }, (_, h) => Math.max(0, hours[h] ?? 0));
  const max = Math.max(0, ...cells);
  const busiest = max > 0 ? cells.indexOf(max) : -1;
  const shown = active ?? busiest;
  return (
    <figure aria-label={ariaLabel} className="space-y-2">
      <div className="grid grid-cols-12 gap-1 sm:grid-cols-24" role="list" onMouseLeave={() => setActive(null)}>
        {cells.map((value, h) => (
          <button
            key={h}
            type="button"
            role="listitem"
            aria-label={`${formatHour(h)}: ${formatValue(value)}`}
            onMouseEnter={() => setActive(h)}
            onFocus={() => setActive(h)}
            onClick={() => setActive(h)}
            className={cn('h-8 rounded-md ring-1 ring-inset ring-white/[0.05] outline-none focus-visible:ring-2 focus-visible:ring-violet-400', active === h && 'ring-2 ring-white/60')}
            style={{ backgroundColor: value > 0 ? `rgb(139 92 246 / ${heatLevel(value, max)})` : 'rgb(255 255 255 / 0.02)' }}
          />
        ))}
      </div>
      <div className="flex justify-between text-[10.5px] tabular-nums text-zinc-600" aria-hidden>
        <span>{formatHour(0)}</span>
        <span>{formatHour(6)}</span>
        <span>{formatHour(12)}</span>
        <span>{formatHour(18)}</span>
        <span>{formatHour(23)}</span>
      </div>
      <p className="min-h-5 text-xs text-zinc-400" aria-live="polite">
        {shown >= 0 ? `${formatHour(shown)} • ${formatValue(cells[shown] ?? 0)}` : ''}
      </p>
    </figure>
  );
}
