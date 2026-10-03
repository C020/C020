import { Activity, ArrowLeft, Clapperboard, Film, History, LayoutDashboard, Radio, RefreshCw, UserPlus, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useOverview } from '../api/queries';
import { AuditRow } from '../components/AuditRow';
import { ContentRow } from '../components/ContentRow';
import { DiagnosticsBanner } from '../components/DiagnosticsBanner';
import { LiveCard } from '../components/LiveCard';
import { PageHeader } from '../components/PageHeader';
import { SessionRow } from '../components/SessionCard';
import { Button, buttonClasses } from '../components/ui/Button';
import { Card, CardHeader } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { Skeleton, SkeletonRows } from '../components/ui/Skeleton';
import { StatCard } from '../components/ui/StatCard';
import { useGuild } from '../hooks/useGuild';
import { useSession } from '../hooks/useSession';
import { formatCompact, formatNumber } from '../lib/format';

export function OverviewPage() {
  const { guildId, guild, basePath, realtime } = useGuild();
  const me = useSession();
  const overview = useOverview(guildId, realtime === 'open');
  const data = overview.data;

  if (overview.isError && !data) {
    return (
      <>
        <PageHeader title="نظرة عامة" icon={<LayoutDashboard className="size-5" />} />
        <Card>
          <ErrorState error={overview.error} onRetry={() => void overview.refetch()} retrying={overview.isFetching} />
        </Card>
      </>
    );
  }

  const liveNow = data ? [...data.liveNow].sort((a, b) => (b.totalViewers ?? 0) - (a.totalViewers ?? 0)) : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="نظرة عامة"
        icon={<LayoutDashboard className="size-5" />}
        description={`كل اللي يصير في ${guild.name} لحظة بلحظة`}
        actions={
          <Button variant="ghost" size="sm" onClick={() => void overview.refetch()} loading={overview.isFetching && !overview.isPending} icon={<RefreshCw className="size-3.5" />}>
            تحديث
          </Button>
        }
      />

      {data && <DiagnosticsBanner diagnostics={data.diagnostics} basePath={basePath} inviteUrl={me.inviteUrl} onRetry={() => void overview.refetch()} />}

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard
          label="يبثون الحين"
          value={formatNumber(data?.counts.liveNow)}
          icon={<Radio className="size-5" />}
          accent="rose"
          loading={!data}
          hint={data && data.counts.liveNow > 0 ? `${formatCompact(liveNow.reduce((n, l) => n + (l.totalViewers ?? 0), 0))} مشاهد` : 'ما فيه أحد لايف'}
        />
        <StatCard label="الستريمرز" value={formatNumber(data?.counts.streamers)} icon={<Users className="size-5" />} loading={!data} hint={data && `${formatNumber(data.counts.accounts)} حساب مربوط`} />
        <StatCard label="بثوث آخر 7 أيام" value={formatNumber(data?.counts.sessionsLast7d)} icon={<History className="size-5" />} accent="sky" loading={!data} />
        <StatCard label="مقاطع آخر 7 أيام" value={formatNumber(data?.counts.contentLast7d)} icon={<Clapperboard className="size-5" />} accent="emerald" loading={!data} />
      </div>

      <section aria-labelledby="live-now-title">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="live-now-title" className="flex items-center gap-2 text-base font-semibold text-zinc-100">
            <span className="relative flex size-2.5">
              {liveNow.length > 0 && <span className="absolute inset-0 animate-live-ping rounded-full bg-rose-500/70" />}
              <span className={liveNow.length > 0 ? 'relative size-2.5 rounded-full bg-rose-500' : 'relative size-2.5 rounded-full bg-zinc-600'} />
            </span>
            يبثون الحين
          </h2>
          {liveNow.length > 0 && <span className="text-xs text-zinc-500">{liveNow.length} لايف</span>}
        </div>
        {!data ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-80 rounded-2xl" />
            ))}
          </div>
        ) : liveNow.length === 0 ? (
          <Card>
            <EmptyState
              compact
              icon={<Radio className="size-6" />}
              title="ما فيه أحد يبث الحين"
              description={
                data.counts.streamers === 0 ? 'أضف أول ستريمر عشان البوت يبدأ يراقب بثوثه.' : 'أول ما يبدأ أي ستريمر بث، بيطلع هنا مباشرة بدون ما تحدّث الصفحة.'
              }
              action={
                data.counts.streamers === 0 ? (
                  <Link to={`${basePath}/streamers?add=1`} className={buttonClasses('primary', 'sm')}>
                    <UserPlus className="size-4" />
                    إضافة ستريمر
                  </Link>
                ) : undefined
              }
            />
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {liveNow.map((item) => (
              <LiveCard key={item.sessionId} item={item} />
            ))}
          </div>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <FeedCard title="آخر البثوث" icon={<History className="size-4" />} to={`${basePath}/history`}>
          {!data ? (
            <SkeletonRows rows={4} />
          ) : data.recentSessions.length === 0 ? (
            <EmptyState compact icon={<History className="size-5" />} title="ما فيه بثوث مسجلة للحين" />
          ) : (
            <div className="divide-y divide-white/[0.05]">
              {data.recentSessions.map((s) => (
                <SessionRow key={s.id} session={s} />
              ))}
            </div>
          )}
        </FeedCard>

        <FeedCard title="آخر المقاطع" icon={<Film className="size-4" />}>
          {!data ? (
            <SkeletonRows rows={4} />
          ) : data.recentContent.length === 0 ? (
            <EmptyState compact icon={<Film className="size-5" />} title="ما نزل محتوى جديد للحين" description="أول ما ينزل فيديو أو كليب جديد بيطلع هنا." />
          ) : (
            <div className="-mx-2 space-y-0.5">
              {data.recentContent.map((c) => (
                <ContentRow key={c.id} item={c} />
              ))}
            </div>
          )}
        </FeedCard>

        <FeedCard title="آخر النشاط" icon={<Activity className="size-4" />} to={`${basePath}/activity`} className="lg:col-span-2 xl:col-span-1">
          {!data ? (
            <SkeletonRows rows={4} />
          ) : data.recentAudit.length === 0 ? (
            <EmptyState compact icon={<Activity className="size-5" />} title="ما فيه نشاط للحين" />
          ) : (
            <div className="divide-y divide-white/[0.05]">
              {data.recentAudit.slice(0, 8).map((entry) => (
                <AuditRow key={entry.id} entry={entry} currentUserId={me.user.id} />
              ))}
            </div>
          )}
        </FeedCard>
      </div>
    </div>
  );
}

function FeedCard({ title, icon, to, children, className }: { title: string; icon: ReactNode; to?: string; children: ReactNode; className?: string }) {
  return (
    <Card className={className}>
      <CardHeader
        title={title}
        icon={icon}
        actions={
          to && (
            <Link to={to} className="inline-flex items-center gap-1 text-xs text-zinc-400 transition-colors hover:text-zinc-200">
              عرض الكل
              <ArrowLeft className="size-3.5" />
            </Link>
          )
        }
      />
      <div className="px-5 pb-4 pt-2 sm:px-6">{children}</div>
    </Card>
  );
}
