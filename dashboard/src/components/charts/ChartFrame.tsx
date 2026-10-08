import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { cn } from '../../lib/cn';

/** Width of an element, kept up to date with ResizeObserver (charts redraw at the real pixel width). */
export function useElementWidth<T extends HTMLElement>(fallback = 600): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => {
      const w = Math.round(el.getBoundingClientRect().width);
      if (w > 0) setWidth(w);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

export interface TooltipState {
  /** Pixel position inside the chart container. */
  x: number;
  y: number;
  content: ReactNode;
}

/** Floating tooltip clamped inside the chart box. */
export function ChartTooltip({ state, width }: { state: TooltipState | null; width: number }) {
  if (!state) return null;
  const left = Math.min(Math.max(state.x, 70), Math.max(70, width - 70));
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-xl bg-zinc-900/95 px-3 py-2 text-xs text-zinc-200 shadow-xl shadow-black/50 ring-1 ring-inset ring-white/10 backdrop-blur"
      style={{ left, top: Math.max(state.y - 8, 0) }}
    >
      {state.content}
    </div>
  );
}

export function ChartLegend({ items, className }: { items: Array<{ label: string; color: string; dashed?: boolean }>; className?: string }) {
  return (
    <ul className={cn('flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-zinc-400', className)}>
      {items.map((item) => (
        <li key={item.label} className="inline-flex items-center gap-1.5">
          <span className={cn('h-0.5 w-4 rounded-full', item.dashed && 'opacity-70')} style={{ backgroundColor: item.color }} aria-hidden />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

export function ChartEmpty({ children, height = 180 }: { children: ReactNode; height?: number }) {
  return (
    <div className="grid place-items-center rounded-xl bg-white/[0.02] text-[13px] text-zinc-500 ring-1 ring-inset ring-white/[0.04]" style={{ height }}>
      {children}
    </div>
  );
}
