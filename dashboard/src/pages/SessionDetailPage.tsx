import { ArrowRight, CalendarClock, Clock, ExternalLink, Eye, Gamepad2, LineChart, MessageSquare, PlayCircle, TrendingUp, UserRound } from 'lucide-react';
import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { isApiError } from '../api/client';
import { useSessionDetail } from '../api/queries';
import type { SessionDetailDto } from '../api/types';
import { ChartEmpty, ChartLegend } from '../components/charts/ChartFrame';
import { TimeSeriesChart, type TimeSeries } from '../components/charts/TimeSeriesChart';
import { PageHeader } from '../components/PageHeader';
import { PlatformBadge, PlatformIcon } from '../components/PlatformIcon';
import { StreamerAvatar } from '../components/StreamerAvatar';
import { Badge, LiveDot } from '../components/ui/Badge';
import { buttonClasses } from '../components/ui/Button';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { Skeleton } from '../components/ui/Skeleton';
import { StatCard } from '../components/ui/StatCard';
import { useGuild } from '../hooks/useGuild';
import { useNow } from '../hooks/useNow';
import { categorySpans, sessionEndMs, viewerSeries } from '../lib/charts';
import { formatCompact, formatDateTime, formatDurationLong, formatDurationShort, formatNumber, formatTime, secondsBetween } from '../lib/format';
import { PLATFORM_META } from '../lib/platforms';
import { t } from '../i18n';

const CATEGORY_COLORS = ['#8b5cf6', '#06b6d4', '#f59e0b', '#ec4899', '#10b981', '#6366f1', '#f97316'];

export default function SessionDetailPage() {
  const { guildId, basePath } = useGuild();
  const params = useParams();
  const id = Number(params.sessionId);
  const query = useSessionDetail(guildId, id);
  const valid = Number.isInteger(id) && id > 0;

  const back = (
    <Link to={`${basePath}/history`} className={buttonClasses('ghost', 'sm')}>
      <ArrowRight className="size-4 ltr:rotate-180" />
      {t('sessionDetail.back')}
    </Link>
  );

  if (!valid || (query.isError && isApiError(query.error) && query.error.isNotFound)) {
    return (
      <div className="space-y-6">
        <PageHeader title={t('sessionDetail.title')} icon={<LineChart className="size-5" />} actions={back} />
        <Card>
          <EmptyState icon={<LineChart className="size-6" />} title={t('sessionDetail.notFound')} description={t('sessionDetail.notFoundDesc')} />
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={query.data ? t('sessionDetail.titleOf', { name: query.data.streamer.displayName }) : t('sessionDetail.title')}
        icon={<LineChart className="size-5" />}
        description={query.data ? formatDateTime(query.data.startedAt) : undefined}
        actions={back}
      />
      {query.data ? (
        <SessionDetail session={query.data} />
      ) : query.isError ? (
        <Card>
          <ErrorState error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-24 rounded-2xl" />
            ))}
          </div>
          <Skeleton className="h-80 rounded-2xl" />
        </div>
      )}
    </div>
  );
}

function SessionDetail({ session }: { session: SessionDetailDto }) {
  const { basePath } = useGuild();
  const live = session.status === 'live';
  const now = useNow(live ? 15_000 : 60_000);
  const duration = live ? secondsBetween(session.startedAt, now) : session.durationSec;
  const series = useMemo(() => viewerSeries(session.samples), [session.samples]);
  const endMs = sessionEndMs(session, now);
  const spans = useMemo(() => categorySpans(session.samples, endMs), [session.samples, endMs]);
  const startMs = Date.parse(session.startedAt);

  const chartSeries: TimeSeries[] = useMemo(
    () => [
      { id: 'total', label: t('sessionDetail.total'), color: '#a78bfa', values: series.total, area: true },
      ...(series.platforms.length > 1
        ? series.platforms.map((p) => ({ id: p.platform, label: PLATFORM_META[p.platform].label, color: PLATFORM_META[p.platform].color, values: p.values, dashed: true }))
        : []),
    ],
    [series],
  );

  const spanColor = new Map<string, string>();
  for (const s of spans) if (!spanColor.has(s.name)) spanColor.set(s.name, CATEGORY_COLORS[spanColor.size % CATEGORY_COLORS.length]!);
  const timelineStart = Math.min(startMs, series.times[0] ?? startMs);
  const timelineLength = Math.max(1, endMs - timelineStart);

  return (
    <div className="space-y-5">
      <Card>
        <CardBody className="flex flex-wrap items-center gap-3">
          <StreamerAvatar name={session.streamer.displayName} avatarUrl={session.streamer.avatarUrl} discordUserId={session.streamer.discordUserId} live={live} size={48} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-semibold text-zinc-100">{session.streamer.displayName}</h2>
              {live ? (
                <Badge tone="live">
                  <LiveDot />
                  {t('session.liveNow')}
                </Badge>
              ) : (
                <Badge>{t('session.ended')}</Badge>
              )}
            </div>
            <p className="mt-1 flex items-center gap-1.5 text-xs text-zinc-500">
              <CalendarClock className="size-3.5" />
              {formatDateTime(session.startedAt)}
              {session.endedAt && ` → ${formatTime(session.endedAt)}`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {session.platforms.map((p) => (
              <PlatformBadge key={p} platform={p} />
            ))}
          </div>
          <div className="flex w-full flex-wrap gap-2 sm:w-auto">
            <Link to={`${basePath}/streamers/${session.streamer.id}/stats`} className={buttonClasses('secondary', 'sm')}>
              <UserRound className="size-3.5" />
              {t('sessionDetail.profile')}
            </Link>
            {session.messageUrl && (
              <a href={session.messageUrl} target="_blank" rel="noopener noreferrer" className={buttonClasses('ghost', 'sm')}>
                <MessageSquare className="size-3.5" />
                {t('session.discordMessage')}
                <ExternalLink className="size-3" />
              </a>
            )}
          </div>
          {session.titles.length > 0 && (
            <p className="w-full text-[13.5px] leading-relaxed text-zinc-300" dir="auto">
              {session.titles[session.titles.length - 1]}
            </p>
          )}
        </CardBody>
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={t('session.duration')} value={formatDurationShort(duration)} hint={formatDurationLong(duration)} icon={<Clock className="size-5" />} accent="sky" />
        <StatCard label={t('session.peak')} value={formatCompact(session.peakViewers)} icon={<TrendingUp className="size-5" />} accent="amber" />
        <StatCard label={t('session.avg')} value={session.avgViewers == null ? '—' : formatCompact(Math.round(session.avgViewers))} icon={<Eye className="size-5" />} accent="violet" />
        <StatCard label={t('session.categories')} value={formatNumber(session.categories.length)} icon={<Gamepad2 className="size-5" />} accent="emerald" />
      </div>

      <Card>
        <CardHeader
          icon={<Eye className="size-[18px]" />}
          title={t('sessionDetail.viewers')}
          description={t('sessionDetail.viewersDesc')}
          actions={chartSeries.length > 1 ? <ChartLegend items={chartSeries.map((s) => ({ label: s.label, color: s.color, dashed: s.dashed }))} /> : undefined}
        />
        <CardBody>
          {series.times.length < 2 ? (
            <ChartEmpty height={220}>{t('sessionDetail.noSamples')}</ChartEmpty>
          ) : (
            <TimeSeriesChart
              times={series.times}
              series={chartSeries}
              endMs={endMs}
              ariaLabel={t('sessionDetail.chartAria', { name: session.streamer.displayName, peak: formatNumber(series.max) })}
              formatValue={(v) => formatCompact(v)}
              formatTime={(ms) => formatTime(ms)}
              renderTooltip={(i) => (
                <div className="space-y-1">
                  <p className="font-medium text-zinc-100">
                    {formatTime(series.times[i])}
                    <span className="ms-2 text-zinc-500">+{formatDurationShort(((series.times[i] ?? startMs) - startMs) / 1000)}</span>
                  </p>
                  <p className="flex items-center gap-1.5">
                    <span className="size-2 rounded-full bg-violet-400" />
                    {t('sessionDetail.total')}: <span className="font-semibold tabular-nums">{formatNumber(series.total[i])}</span>
                  </p>
                  {series.platforms.length > 1 &&
                    series.platforms.map((p) => (
                      <p key={p.platform} className="flex items-center gap-1.5">
                        <PlatformIcon platform={p.platform} className="size-3" />
                        {PLATFORM_META[p.platform].label}: <span className="tabular-nums">{formatNumber(p.values[i])}</span>
                      </p>
                    ))}
                  {series.categories[i] && (
                    <p className="flex items-center gap-1.5 text-zinc-400" dir="auto">
                      <Gamepad2 className="size-3" />
                      {series.categories[i]}
                    </p>
                  )}
                </div>
              )}
            />
          )}
        </CardBody>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader icon={<Gamepad2 className="size-[18px]" />} title={t('sessionDetail.timeline')} description={t('sessionDetail.timelineDesc')} />
          <CardBody>
            {spans.length === 0 ? (
              session.categories.length > 0 ? (
                <ul className="flex flex-wrap gap-1.5">
                  {session.categories.map((c, i) => (
                    <li key={`${c.name}-${i}`} className="rounded-lg bg-white/[0.04] px-2 py-1 text-xs text-zinc-300 ring-1 ring-inset ring-white/[0.06]" dir="auto">
                      {c.name} {c.seconds > 0 && <span className="text-zinc-500">{formatDurationShort(c.seconds)}</span>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-zinc-500">{t('sessionDetail.noCategories')}</p>
              )
            ) : (
              <div className="space-y-3">
                <div className="relative h-6 overflow-hidden rounded-lg bg-white/[0.03]" role="img" aria-label={t('sessionDetail.timelineAria', { count: spans.length })}>
                  {spans.map((s, i) => (
                    <div
                      key={`${s.name}-${i}`}
                      title={`${s.name} • ${formatTime(s.start)}–${formatTime(s.end)}`}
                      className="absolute inset-y-0"
                      style={{
                        insetInlineStart: `${((s.start - timelineStart) / timelineLength) * 100}%`,
                        width: `${Math.max(0.5, ((s.end - s.start) / timelineLength) * 100)}%`,
                        backgroundColor: spanColor.get(s.name),
                      }}
                    />
                  ))}
                </div>
                <ol className="space-y-1.5">
                  {spans.map((s, i) => (
                    <li key={`${s.name}-${i}`} className="flex items-center gap-2 text-[13px]">
                      <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: spanColor.get(s.name) }} />
                      <span className="min-w-0 flex-1 truncate text-zinc-200" dir="auto">
                        {s.name}
                      </span>
                      <span className="text-xs tabular-nums text-zinc-500">
                        {formatTime(s.start)} – {formatTime(s.end)}
                      </span>
                      <span className="w-16 text-end text-xs tabular-nums text-zinc-400">{formatDurationShort((s.end - s.start) / 1000)}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader icon={<PlayCircle className="size-[18px]" />} title={t('sessionDetail.segments')} description={t('sessionDetail.segmentsDesc')} />
          <CardBody className="space-y-2">
            {session.segments.length === 0 && <p className="text-[13px] text-zinc-500">{t('sessionDetail.noSegments')}</p>}
            {session.segments.map((seg, i) => (
              <div key={`${seg.platform}-${seg.channelId}-${i}`} className="flex flex-wrap items-center gap-3 rounded-xl bg-white/[0.03] p-3 ring-1 ring-inset ring-white/[0.06]">
                <PlatformIcon platform={seg.platform} className="size-5" />
                <div className="min-w-0 flex-1">
                  <a href={seg.url} target="_blank" rel="noopener noreferrer" className="block truncate text-[13px] font-medium text-zinc-100 hover:underline" dir="auto">
                    {seg.displayName}
                  </a>
                  <p className="text-xs tabular-nums text-zinc-500">
                    {formatTime(seg.startedAt)} – {seg.endedAt ? formatTime(seg.endedAt) : t('session.liveNow')}
                    <span className="mx-1.5 text-zinc-700">•</span>
                    {formatDurationShort(((seg.endedAt ? Date.parse(seg.endedAt) : now) - Date.parse(seg.startedAt)) / 1000)}
                    <span className="mx-1.5 text-zinc-700">•</span>
                    {t('sessionDetail.segmentPeak', { n: formatCompact(seg.peakViewers) })}
                  </p>
                </div>
                {seg.vodUrl ? (
                  <a href={seg.vodUrl} target="_blank" rel="noopener noreferrer" className={buttonClasses('secondary', 'xs')}>
                    <PlayCircle className="size-3.5" />
                    {t('sessionDetail.vod')}
                  </a>
                ) : (
                  <span className="text-[11px] text-zinc-600">{t('sessionDetail.noVod')}</span>
                )}
              </div>
            ))}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
