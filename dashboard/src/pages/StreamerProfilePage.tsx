import { ArrowRight, BarChart3, Clapperboard, Clock, Eye, Gamepad2, Layers, Radio, Settings2, Sun, TrendingUp } from 'lucide-react';
import { useMemo } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { isApiError } from '../api/client';
import { useSettings, useStreamerStats } from '../api/queries';
import type { StatsRange, StreamerStatsDto } from '../api/types';
import { BarChart } from '../components/charts/BarChart';
import { ChartEmpty } from '../components/charts/ChartFrame';
import { HourStrip, RankedBars, ShareBar } from '../components/charts/Distribution';
import { PageHeader } from '../components/PageHeader';
import { SessionRow } from '../components/SessionCard';
import { StreamerAvatar } from '../components/StreamerAvatar';
import { buttonClasses } from '../components/ui/Button';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { Segmented } from '../components/ui/Segmented';
import { Skeleton } from '../components/ui/Skeleton';
import { StatCard } from '../components/ui/StatCard';
import { useGuild } from '../hooks/useGuild';
import { fillDaily, lastDateOf, parseRange, STATS_RANGES, todayIn } from '../lib/charts';
import { formatHourOfDay } from '../lib/features';
import { cn } from '../lib/cn';
import { formatCompact, formatDate, formatDurationShort, formatHours, formatNumber, formatShortDate } from '../lib/format';
import { PLATFORM_META } from '../lib/platforms';
import { t, useI18n } from '../i18n';

export default function StreamerProfilePage() {
  const { guildId, basePath } = useGuild();
  const params = useParams();
  const id = Number(params.streamerId);
  const [search, setSearch] = useSearchParams();
  const days = parseRange(search.get('days'));
  const stats = useStreamerStats(guildId, id, days);
  const valid = Number.isInteger(id) && id > 0;

  const setDays = (next: StatsRange): void => {
    const p = new URLSearchParams(search);
    if (next === 30) p.delete('days');
    else p.set('days', String(next));
    setSearch(p, { replace: true });
  };

  const actions = (
    <>
      <Segmented<StatsRange>
        size="sm"
        value={days}
        onChange={setDays}
        ariaLabel={t('profile.range')}
        options={STATS_RANGES.map((d) => ({ value: d, label: t('profile.days', { n: d }) }))}
      />
      {valid && (
        <Link to={`${basePath}/streamers/${id}`} className={buttonClasses('secondary', 'sm')}>
          <Settings2 className="size-3.5" />
          {t('profile.manage')}
        </Link>
      )}
      <Link to={`${basePath}/streamers`} className={buttonClasses('ghost', 'sm')}>
        <ArrowRight className="size-4 ltr:rotate-180" />
        {t('profile.back')}
      </Link>
    </>
  );

  if (!valid || (stats.isError && isApiError(stats.error) && stats.error.isNotFound)) {
    return (
      <div className="space-y-6">
        <PageHeader title={t('profile.title')} icon={<BarChart3 className="size-5" />} actions={actions} />
        <Card>
          <EmptyState icon={<BarChart3 className="size-6" />} title={t('profile.notFound')} description={t('profile.notFoundDesc')} />
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={stats.data ? stats.data.streamer.displayName : t('profile.title')}
        icon={
          stats.data ? (
            <StreamerAvatar name={stats.data.streamer.displayName} avatarUrl={stats.data.streamer.avatarUrl} discordUserId={stats.data.streamer.discordUserId} size={44} />
          ) : (
            <BarChart3 className="size-5" />
          )
        }
        description={t('profile.desc', { n: days })}
        actions={actions}
      />
      {stats.data ? (
        <div className={cn('transition-opacity', stats.isPlaceholderData && 'opacity-60')}>
          <ProfileBody stats={stats.data} />
        </div>
      ) : stats.isError ? (
        <Card>
          <ErrorState error={stats.error} onRetry={() => void stats.refetch()} retrying={stats.isFetching} />
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-24 rounded-2xl" />
            ))}
          </div>
          <Skeleton className="h-72 rounded-2xl" />
        </div>
      )}
    </div>
  );
}

function ProfileBody({ stats }: { stats: StreamerStatsDto }) {
  const { guildId } = useGuild();
  const { lang } = useI18n();
  const settings = useSettings(guildId);
  const timezone = settings.data?.features?.timezone;
  const daily = useMemo(() => fillDaily(stats.daily, stats.days, lastDateOf(stats.daily, todayIn(timezone))), [stats.daily, stats.days, timezone]);
  const totalPlatformSeconds = stats.platforms.reduce((n, p) => n + p.seconds, 0);
  const hasHours = stats.hours.some((h) => h > 0);
  const { totals } = stats;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard label={t('profile.kpi.hours')} value={formatHours(totals.seconds / 3600)} icon={<Clock className="size-5" />} accent="sky" />
        <StatCard label={t('profile.kpi.sessions')} value={formatNumber(totals.sessions)} icon={<Radio className="size-5" />} accent="rose" />
        <StatCard label={t('profile.kpi.peak')} value={formatCompact(totals.peakViewers)} icon={<TrendingUp className="size-5" />} accent="amber" />
        <StatCard label={t('profile.kpi.avg')} value={totals.avgViewers == null ? '—' : formatCompact(Math.round(totals.avgViewers))} icon={<Eye className="size-5" />} accent="violet" />
        <StatCard label={t('profile.kpi.content')} value={formatNumber(totals.contentPosts)} icon={<Clapperboard className="size-5" />} accent="emerald" />
      </div>

      <Card>
        <CardHeader icon={<BarChart3 className="size-[18px]" />} title={t('profile.daily')} description={t('profile.dailyDesc')} />
        <CardBody>
          {totals.seconds === 0 ? (
            <ChartEmpty height={200}>{t('profile.noStreams')}</ChartEmpty>
          ) : (
            <BarChart
              ariaLabel={t('profile.dailyAria', { n: stats.days })}
              formatValue={(v) => formatHours(v)}
              data={daily.map((d) => ({
                key: d.date,
                label: formatShortDate(`${d.date}T12:00:00Z`),
                value: d.seconds / 3600,
                tooltip: (
                  <div className="space-y-0.5">
                    <p className="font-medium text-zinc-100">{formatDate(`${d.date}T12:00:00Z`)}</p>
                    <p>{d.seconds > 0 ? formatDurationShort(d.seconds) : t('profile.noStreamDay')}</p>
                    {d.item && d.item.sessions > 0 && (
                      <p className="text-zinc-400">
                        {t('profile.daySessions', { count: d.item.sessions })} • {t('profile.dayPeak', { n: formatCompact(d.item.peakViewers) })}
                      </p>
                    )}
                  </div>
                ),
              }))}
            />
          )}
        </CardBody>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader icon={<Layers className="size-[18px]" />} title={t('profile.platforms')} description={t('profile.platformsDesc')} />
          <CardBody>
            {totalPlatformSeconds === 0 ? (
              <p className="text-[13px] text-zinc-500">{t('profile.noStreams')}</p>
            ) : (
              <ShareBar
                ariaLabel={t('profile.platforms')}
                formatValue={(v) => formatDurationShort(v)}
                items={stats.platforms.map((p) => ({
                  key: p.platform,
                  label: PLATFORM_META[p.platform].label,
                  value: p.seconds,
                  color: PLATFORM_META[p.platform].color,
                  detail: `${t('profile.daySessions', { count: p.sessions })} • ${t('profile.dayPeak', { n: formatCompact(p.peakViewers) })}`,
                }))}
              />
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader icon={<Gamepad2 className="size-[18px]" />} title={t('profile.categories')} description={t('profile.categoriesDesc')} />
          <CardBody>
            {stats.categories.length === 0 ? (
              <p className="text-[13px] text-zinc-500">{t('profile.noCategories')}</p>
            ) : (
              <RankedBars formatValue={(v) => formatDurationShort(v)} items={stats.categories.slice(0, 8).map((c, i) => ({ key: `${c.name}-${i}`, label: c.name, value: c.seconds }))} />
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader icon={<Sun className="size-[18px]" />} title={t('profile.hours')} description={timezone ? t('profile.hoursDescTz', { tz: timezone }) : t('profile.hoursDesc')} />
        <CardBody>
          {hasHours ? (
            <HourStrip hours={stats.hours} ariaLabel={t('profile.hours')} formatHour={(h) => formatHourOfDay(h, lang)} formatValue={(s) => formatDurationShort(s)} />
          ) : (
            <p className="text-[13px] text-zinc-500">{t('profile.noStreams')}</p>
          )}
        </CardBody>
      </Card>

      <RecentSessions stats={stats} />
    </div>
  );
}

function RecentSessions({ stats }: { stats: StreamerStatsDto }) {
  const { basePath } = useGuild();
  return (
    <Card>
      <CardHeader icon={<Radio className="size-[18px]" />} title={t('profile.recent')} />
      <CardBody className="pt-0">
        {stats.recentSessions.length === 0 ? (
          <p className="text-[13px] text-zinc-500">{t('profile.noStreams')}</p>
        ) : (
          <div className="divide-y divide-white/[0.05]">
            {stats.recentSessions.map((s) => (
              <SessionRow key={s.id} session={s} href={`${basePath}/sessions/${s.id}`} />
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
