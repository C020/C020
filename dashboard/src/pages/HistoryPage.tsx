import { ChevronLeft, ChevronRight, Clock, Crown, History, Medal, Radio, TrendingUp, Trophy, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useLeaderboard, useSessions } from '../api/queries';
import type { LeaderboardEntry } from '../api/types';
import { PageHeader } from '../components/PageHeader';
import { SessionCard } from '../components/SessionCard';
import { StreamerAvatar } from '../components/StreamerAvatar';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { Segmented } from '../components/ui/Segmented';
import { Skeleton } from '../components/ui/Skeleton';
import { StatCard } from '../components/ui/StatCard';
import { Tabs } from '../components/ui/Tabs';
import { useGuild } from '../hooks/useGuild';
import { cn } from '../lib/cn';
import { formatCompact, formatDurationShort, formatHours, formatNumber } from '../lib/format';
import { t } from '../i18n';

const PAGE_SIZE = 10;
type Tab = 'sessions' | 'leaderboard';

export default function HistoryPage() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'leaderboard' ? 'leaderboard' : 'sessions';
  const setTab = (next: Tab): void => {
    const p = new URLSearchParams(params);
    if (next === 'sessions') p.delete('tab');
    else p.set('tab', next);
    setParams(p, { replace: true });
  };

  return (
    <div className="space-y-6">
      <PageHeader title={t('nav.history')} icon={<History className="size-5" />} description={t('history.desc')} />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        items={[
          { value: 'sessions', label: t('history.sessions'), icon: <Radio className="size-4" /> },
          { value: 'leaderboard', label: t('history.leaderboard'), icon: <Trophy className="size-4" /> },
        ]}
      />
      {tab === 'sessions' ? <SessionsTab /> : <LeaderboardTab />}
    </div>
  );
}

function SessionsTab() {
  const { guildId } = useGuild();
  const [params, setParams] = useSearchParams();
  const page = Math.max(0, Number.parseInt(params.get('page') ?? '1', 10) - 1 || 0);
  const sessions = useSessions(guildId, page, PAGE_SIZE);
  const summary = useLeaderboard(guildId, 30);
  const totals = useMemo(() => {
    const rows = summary.data ?? [];
    return {
      sessions: rows.reduce((n, r) => n + r.sessions, 0),
      hours: rows.reduce((n, r) => n + r.seconds, 0) / 3600,
      peak: rows.reduce((m, r) => Math.max(m, r.peakViewers), 0),
      streamers: rows.filter((r) => r.sessions > 0).length,
    };
  }, [summary.data]);

  const total = sessions.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const goTo = (next: number): void => {
    const p = new URLSearchParams(params);
    if (next <= 0) p.delete('page');
    else p.set('page', String(next + 1));
    setParams(p);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard label={t('history.sessions30d')} value={formatNumber(totals.sessions)} icon={<Radio className="size-5" />} accent="rose" loading={summary.isPending} />
        <StatCard label={t('history.hours')} value={formatHours(totals.hours)} icon={<Clock className="size-5" />} accent="sky" loading={summary.isPending} />
        <StatCard label={t('session.peak')} value={formatCompact(totals.peak)} icon={<TrendingUp className="size-5" />} accent="amber" loading={summary.isPending} />
        <StatCard label={t('history.activeStreamers')} value={formatNumber(totals.streamers)} icon={<Users className="size-5" />} accent="emerald" loading={summary.isPending} />
      </div>

      {sessions.isPending ? (
        <div className="space-y-4">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-56 rounded-2xl" />
          ))}
        </div>
      ) : sessions.isError && !sessions.data ? (
        <Card>
          <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} retrying={sessions.isFetching} />
        </Card>
      ) : sessions.data.items.length === 0 ? (
        <Card>
          <EmptyState icon={<History className="size-6" />} title={page > 0 ? t('history.emptyPage') : t('history.emptyAll')} description={t('history.emptyDesc')} />
        </Card>
      ) : (
        <div className={cn('space-y-4 transition-opacity', sessions.isPlaceholderData && 'opacity-60')}>
          {sessions.data.items.map((s) => (
            <SessionCard key={s.id} session={s} />
          ))}
        </div>
      )}

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-3">
          <Button variant="secondary" size="sm" disabled={page === 0} onClick={() => goTo(page - 1)} icon={<ChevronRight className="size-4 ltr:rotate-180" />}>
            {t('history.newer')}
          </Button>
          <span className="text-[13px] tabular-nums text-zinc-400">
            {t('history.pageOf', { page: formatNumber(page + 1), pages: formatNumber(pages) })}
          </span>
          <Button variant="secondary" size="sm" disabled={page + 1 >= pages} onClick={() => goTo(page + 1)}>
            {t('history.older')}
            <ChevronLeft className="size-4 ltr:rotate-180" />
          </Button>
        </div>
      )}
    </div>
  );
}

function LeaderboardTab() {
  const { guildId } = useGuild();
  const [days, setDays] = useState(30);
  const board = useLeaderboard(guildId, days);
  const rows = useMemo(() => [...(board.data ?? [])].sort((a, b) => b.seconds - a.seconds), [board.data]);
  const maxSeconds = rows[0]?.seconds ?? 0;

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] px-5 py-4 sm:px-6">
        <div>
          <h2 className="font-semibold text-zinc-100">{t('history.lbTitle')}</h2>
          <p className="mt-0.5 text-xs text-zinc-500">{t('history.lbDesc')}</p>
        </div>
        <Segmented<number>
          size="sm"
          value={days}
          onChange={setDays}
          options={[
            { value: 7, label: t('history.days', { count: 7 }) },
            { value: 30, label: t('history.days', { count: 30 }) },
            { value: 90, label: t('history.days', { count: 90 }) },
          ]}
        />
      </div>
      {board.isPending ? (
        <div className="space-y-3 p-5">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-14 rounded-xl" />
          ))}
        </div>
      ) : board.isError && !board.data ? (
        <ErrorState error={board.error} onRetry={() => void board.refetch()} retrying={board.isFetching} />
      ) : rows.length === 0 ? (
        <EmptyState icon={<Trophy className="size-6" />} title={t('history.emptyPeriod')} />
      ) : (
        <ol className={cn('divide-y divide-white/[0.05] transition-opacity', board.isPlaceholderData && 'opacity-60')}>
          {rows.map((row, i) => (
            <LeaderboardRow key={row.streamer.id} row={row} rank={i + 1} share={maxSeconds > 0 ? row.seconds / maxSeconds : 0} />
          ))}
        </ol>
      )}
    </Card>
  );
}

function RankBadge({ rank }: { rank: number }) {
  if (rank === 1) return <Crown className="size-5 text-amber-300" aria-label={t('history.rank', { rank: 1 })} />;
  if (rank <= 3) return <Medal className={cn('size-5', rank === 2 ? 'text-zinc-300' : 'text-orange-400')} aria-label={t('history.rank', { rank })} />;
  return <span className="text-sm font-semibold tabular-nums text-zinc-500">{rank}</span>;
}

function LeaderboardRow({ row, rank, share }: { row: LeaderboardEntry; rank: number; share: number }) {
  return (
    <li className="flex items-center gap-3 px-5 py-3.5 sm:gap-4 sm:px-6">
      <div className="grid w-7 shrink-0 place-items-center">
        <RankBadge rank={rank} />
      </div>
      <StreamerAvatar name={row.streamer.displayName} avatarUrl={row.streamer.avatarUrl} discordUserId={row.streamer.discordUserId} size={38} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <p className="truncate text-sm font-medium text-zinc-100">{row.streamer.displayName}</p>
          <p className="shrink-0 text-sm font-semibold tabular-nums text-zinc-200">{formatDurationShort(row.seconds)}</p>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.05]">
          <div
            className={cn('h-full rounded-full', rank === 1 ? 'bg-gradient-to-l from-amber-300 to-amber-500' : 'bg-gradient-to-l from-violet-400 to-violet-600')}
            style={{ width: `${Math.max(3, share * 100)}%` }}
          />
        </div>
        <div className="mt-1.5 flex gap-3 text-[11.5px] text-zinc-500">
          <span>{t('history.sessionsCount', { count: row.sessions })}</span>
          <span>{t('live.peak', { n: formatCompact(row.peakViewers) })}</span>
        </div>
      </div>
    </li>
  );
}
