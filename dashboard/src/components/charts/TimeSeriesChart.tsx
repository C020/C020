import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { useI18n } from '../../i18n';
import { areaPath, linePath, linearScale, mirrorX, nearestIndex, niceMax, ticks, type Point } from '../../lib/charts';
import { ChartTooltip, useElementWidth, type TooltipState } from './ChartFrame';

export interface TimeSeries {
  id: string;
  label: string;
  color: string;
  values: Array<number | null>;
  /** Filled area under the line (used for the total). */
  area?: boolean;
  dashed?: boolean;
}

export interface TimeSeriesChartProps {
  times: number[];
  series: TimeSeries[];
  ariaLabel: string;
  formatValue: (value: number) => string;
  formatTime: (ms: number) => string;
  /** Tooltip body for a sample index. */
  renderTooltip: (index: number) => ReactNode;
  height?: number;
  /** Domain end (e.g. session end) when it is later than the last sample. */
  endMs?: number;
}

const PAD = { top: 12, bottom: 26, side: 44, end: 10 };

/** Viewer chart: area for the total + one line per platform; RTL-aware time axis, pointer/touch/keyboard tooltips. */
export function TimeSeriesChart({ times, series, ariaLabel, formatValue, formatTime, renderTooltip, height = 240, endMs }: TimeSeriesChartProps) {
  const { dir } = useI18n();
  const rtl = dir === 'rtl';
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const titleId = useId();
  const gradientId = `g${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const t0 = times[0] ?? 0;
  const t1 = Math.max(times[times.length - 1] ?? 0, endMs ?? 0);
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values.map((v) => v ?? 0))));
  const plotH = height - PAD.top - PAD.bottom;
  const logicalX = linearScale(t0, t1, PAD.side, width - PAD.end);
  const x = (ms: number): number => mirrorX(logicalX(ms), width, rtl);
  const y = linearScale(0, max, PAD.top + plotH, PAD.top);
  const baseline = PAD.top + plotH;
  const axisX = rtl ? width - PAD.side : PAD.side;

  const paths = useMemo(
    () =>
      series.map((s) => {
        const points: Array<Point | null> = s.values.map((v, i) => (v === null ? null : { x: x(times[i]!), y: y(v) }));
        return { s, line: linePath(points), area: s.area ? areaPath(points, baseline) : '' };
      }),
    // x/y are derived from these inputs.
    [series, times, width, height, max, rtl, t0, t1],
  );

  const xTicks = useMemo(() => {
    const count = Math.max(2, Math.min(6, Math.floor((width - PAD.side) / 90)));
    if (t1 <= t0) return [t0];
    return Array.from({ length: count + 1 }, (_, i) => t0 + ((t1 - t0) * i) / count);
  }, [t0, t1, width]);

  const pointAt = (clientX: number, rect: DOMRect): number => {
    const px = clientX - rect.left;
    const logical = rtl ? width - px : px;
    const ms = t0 + ((logical - PAD.side) / Math.max(1, width - PAD.end - PAD.side)) * (t1 - t0);
    return nearestIndex(times, ms);
  };

  const onPointer = (e: PointerEvent<SVGSVGElement>): void => {
    const i = pointAt(e.clientX, e.currentTarget.getBoundingClientRect());
    if (i >= 0) setActive(i);
  };

  const onKey = (e: KeyboardEvent<SVGSVGElement>): void => {
    if (times.length === 0) return;
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const back = rtl ? 'ArrowRight' : 'ArrowLeft';
    if (e.key === forward) setActive((a) => Math.min(times.length - 1, (a ?? -1) + 1));
    else if (e.key === back) setActive((a) => Math.max(0, (a ?? times.length) - 1));
    else if (e.key === 'Escape') setActive(null);
    else return;
    e.preventDefault();
  };

  const activeTime = active !== null ? times[active] : undefined;
  const topValue = active !== null ? Math.max(0, ...series.map((s) => s.values[active] ?? 0)) : 0;
  const tip: TooltipState | null = activeTime !== undefined && active !== null ? { x: x(activeTime), y: y(topValue), content: renderTooltip(active) } : null;

  return (
    <div ref={ref} className="relative w-full min-w-0 touch-pan-y select-none">
      <svg
        width="100%"
        preserveAspectRatio="none"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-labelledby={titleId}
        tabIndex={0}
        onPointerMove={onPointer}
        onPointerDown={onPointer}
        onPointerLeave={(e) => e.pointerType === 'mouse' && setActive(null)}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
        className="block overflow-visible rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50"
      >
        <title id={titleId}>{ariaLabel}</title>
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#8b5cf6" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks(max, 4).map((v) => (
          <g key={v}>
            <line x1={rtl ? PAD.end : PAD.side} x2={rtl ? width - PAD.side : width - PAD.end} y1={y(v)} y2={y(v)} stroke="rgb(255 255 255 / 0.06)" strokeDasharray={v === 0 ? undefined : '3 4'} />
            <text x={rtl ? axisX + 6 : axisX - 6} y={y(v)} dy="0.32em" textAnchor={rtl ? 'start' : 'end'} className="fill-zinc-500 text-[10.5px] tabular-nums">
              {formatValue(v)}
            </text>
          </g>
        ))}
        {xTicks.map((ms, i) => (
          <text
            key={ms}
            x={x(ms)}
            y={height - 8}
            textAnchor={i === 0 ? (rtl ? 'end' : 'start') : i === xTicks.length - 1 ? (rtl ? 'start' : 'end') : 'middle'}
            className="fill-zinc-500 text-[10.5px] tabular-nums"
          >
            {formatTime(ms)}
          </text>
        ))}
        {paths.map(({ s, area }) => area && <path key={`${s.id}-area`} d={area} fill={`url(#${gradientId})`} />)}
        {paths.map(({ s, line }) => (
          <path
            key={s.id}
            d={line}
            fill="none"
            stroke={s.color}
            strokeWidth={s.area ? 2.25 : 1.5}
            strokeDasharray={s.dashed ? '4 3' : undefined}
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity={s.area ? 1 : 0.85}
          />
        ))}
        {activeTime !== undefined && active !== null && (
          <g>
            <line x1={x(activeTime)} x2={x(activeTime)} y1={PAD.top} y2={baseline} stroke="rgb(255 255 255 / 0.25)" />
            {series.map((s) => {
              const v = s.values[active];
              return v == null ? null : <circle key={s.id} cx={x(activeTime)} cy={y(v)} r={3.5} fill={s.color} stroke="#09090b" strokeWidth={1.5} />;
            })}
          </g>
        )}
      </svg>
      <ChartTooltip state={tip} width={width} />
    </div>
  );
}
