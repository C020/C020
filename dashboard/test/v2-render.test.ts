import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { BarChart } from '../src/components/charts/BarChart';
import { HourStrip, RankedBars, ShareBar } from '../src/components/charts/Distribution';
import { TimeSeriesChart } from '../src/components/charts/TimeSeriesChart';
import { langStore } from '../src/i18n/core';

afterEach(() => langStore.set('ar'));

describe('SVG charts render (SSR smoke test, both directions)', () => {
  for (const lang of ['ar', 'en'] as const) {
    it(`bar + time series + distributions in ${lang}`, () => {
      langStore.set(lang);
      const bar = renderToString(
        h(BarChart, {
          ariaLabel: 'Daily hours',
          formatValue: (v: number) => `${v}h`,
          data: [
            { key: 'a', label: 'Oct 1', value: 2, tooltip: 'x' },
            { key: 'b', label: 'Oct 2', value: 0, tooltip: 'y' },
          ],
        }),
      );
      expect(bar).toContain('<title');
      expect(bar).toContain('Daily hours');
      expect(bar).toContain('aria-label="Oct 1: 2h"');

      const series = renderToString(
        h(TimeSeriesChart, {
          times: [0, 60_000, 120_000],
          series: [{ id: 'total', label: 'Total', color: '#fff', values: [1, null, 3], area: true }],
          ariaLabel: 'Viewers',
          formatValue: String,
          formatTime: (ms: number) => `${ms / 60_000}m`,
          renderTooltip: () => null,
        }),
      );
      expect(series).toContain('Viewers');
      expect(series).toMatch(/<path d="M[^"]+"/);
      expect(series).not.toContain('NaN');

      const empty = renderToString(h(TimeSeriesChart, { times: [], series: [], ariaLabel: 'none', formatValue: String, formatTime: String, renderTooltip: () => null }));
      expect(empty).not.toContain('NaN');

      const strip = renderToString(h(HourStrip, { hours: [0, 3600], ariaLabel: 'Hours', formatHour: (n: number) => `${n}:00`, formatValue: (s: number) => `${s}s` }));
      expect(strip.match(/role="listitem"/g)).toHaveLength(24);
      expect(strip).toContain('1:00 • 3600s');

      const share = renderToString(h(ShareBar, { ariaLabel: 'Share', formatValue: String, items: [{ key: 'twitch', label: 'Twitch', value: 3, color: '#9146ff' }, { key: 'kick', label: 'Kick', value: 1, color: '#53fc18' }] }));
      expect(share).toContain('75%');
      expect(renderToString(h(RankedBars, { formatValue: String, items: [{ key: 'a', label: 'A', value: 0 }] }))).toContain('width:0%');
    });
  }
});
