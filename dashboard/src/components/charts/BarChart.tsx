import { useId, useState, type ReactNode } from 'react';
import { useI18n } from '../../i18n';
import { linearScale, mirrorX, niceMax, ticks } from '../../lib/charts';
import { ChartTooltip, useElementWidth, type TooltipState } from './ChartFrame';

export interface BarDatum {
  key: string;
  /** Short axis label (shown for a subset of bars when crowded). */
  label: string;
  value: number;
  tooltip: ReactNode;
}

export interface BarChartProps {
  data: BarDatum[];
  ariaLabel: string;
  formatValue: (value: number) => string;
  height?: number;
  color?: string;
}

const PAD = { top: 12, bottom: 26, side: 44, end: 8 };

/** Vertical bar chart (SVG): first datum is the oldest; in RTL the time axis runs right → left. */
export function BarChart({ data, ariaLabel, formatValue, height = 220, color = '#8b5cf6' }: BarChartProps) {
  const { dir } = useI18n();
  const rtl = dir === 'rtl';
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TooltipState | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const titleId = useId();

  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const plotW = Math.max(10, width - PAD.side - PAD.end);
  const plotH = height - PAD.top - PAD.bottom;
  const y = linearScale(0, max, PAD.top + plotH, PAD.top);
  const slot = data.length > 0 ? plotW / data.length : plotW;
  const barW = Math.max(1.5, Math.min(28, slot * 0.7));
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(plotW / 46))));
  // Logical x (LTR) → physical x; the axis gutter sits on the start side.
  const xAt = (i: number): number => mirrorX(PAD.side + slot * i + slot / 2, width, rtl);
  const axisX = rtl ? width - PAD.side : PAD.side;

  const show = (i: number): void => {
    const d = data[i];
    if (!d) return;
    setActive(i);
    setTip({ x: xAt(i), y: y(d.value), content: d.tooltip });
  };
  const hide = (): void => {
    setActive(null);
    setTip(null);
  };

  return (
    <div ref={ref} className="relative w-full min-w-0 select-none" onMouseLeave={hide}>
      <svg width="100%" height={height} preserveAspectRatio="none" viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={titleId} className="block overflow-visible">
        <title id={titleId}>{ariaLabel}</title>
        {ticks(max, 4).map((v) => (
          <g key={v}>
            <line x1={rtl ? 0 + PAD.end : PAD.side} x2={rtl ? width - PAD.side : width - PAD.end} y1={y(v)} y2={y(v)} stroke="rgb(255 255 255 / 0.06)" strokeDasharray={v === 0 ? undefined : '3 4'} />
            <text x={rtl ? axisX + 6 : axisX - 6} y={y(v)} dy="0.32em" textAnchor={rtl ? 'start' : 'end'} className="fill-zinc-500 text-[10.5px] tabular-nums">
              {formatValue(v)}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const top = y(d.value);
          const h = Math.max(d.value > 0 ? 2 : 0, PAD.top + plotH - top);
          const cx = xAt(i);
          return (
            <g key={d.key}>
              <rect
                x={cx - barW / 2}
                y={PAD.top + plotH - h}
                width={barW}
                height={h}
                rx={Math.min(4, barW / 2)}
                fill={color}
                opacity={active === null || active === i ? 0.9 : 0.45}
              />
              {/* Full-height hit area: hover, tap and keyboard focus show the tooltip. */}
              <rect
                x={cx - slot / 2}
                y={PAD.top}
                width={slot}
                height={plotH}
                fill="transparent"
                tabIndex={0}
                role="button"
                aria-label={`${d.label}: ${formatValue(d.value)}`}
                onMouseEnter={() => show(i)}
                onClick={() => show(i)}
                onFocus={() => show(i)}
                onBlur={hide}
                className="cursor-pointer outline-none"
              />
              {i % labelEvery === 0 && (
                <text x={cx} y={height - 8} textAnchor="middle" className="fill-zinc-500 text-[10.5px]">
                  {d.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <ChartTooltip state={tip} width={width} />
    </div>
  );
}
